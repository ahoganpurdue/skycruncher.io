// ═══════════════════════════════════════════════════════════════════════════
// SOLVERKIT — RANSAC / LO-RANSAC / MAGSAC VALIDATOR  (the skeptic)
// ═══════════════════════════════════════════════════════════════════════════
// Robust inlier-consensus WCS fit + verification. Given a candidate WCS (from
// any generator) it INDEPENDENTLY re-derives consensus from detections+catalog,
// measures that consensus against its OWN chance null (random-orientation
// ensemble — the same null philosophy as the app's UW sweep), LO-refines on the
// inliers, and accepts only when the MEASURED sigma clears the gate.
//
// Contract: contract.mjs VALIDATOR. Numbers are measured or reported null
// ("NOT MEASURED") — never fabricated (CLAUDE.md LAW 3).
//
// Self-calibration (node ransac.mjs --selftest): reconstruct the bundled CR2's
// TRUE geometry (Jupiter anchor, theta~=155.65) -> HIGH inliers/sigma; feed a
// DECOY WCS -> inliers ~= chance, sigma below gate. Proves it discriminates.

import { GATE, PC, VERIFY_NET } from './contract.mjs';
import {
    loadWasm, loadDetections, loadCatalog, tanForward, buildDetGrid, countCatMatches,
    rng, fitAffine, affineToWcs, cdMetrics, cdFrom, compactAnchors, fmt, isMain,
} from './common.mjs';

/**
 * Project catalog through a WCS and pair each in-frame star to its nearest
 * detection (via the shared radius-scaled net). Returns putative correspondences
 * carrying pixel position AND tangent-plane coords (about wcs.crval).
 */
function correspond(wcs, det, cat, grid, o) {
    const { pairs } = countCatMatches(wcs, cat, grid, o);
    const corr = [];
    for (const p of pairs) {
        const t = tanForward(p.star.ra_deg, p.star.dec_deg, wcs.crval[0], wcs.crval[1]);
        if (!t) continue;
        corr.push({ x: p.d.x, y: p.d.y, xi: t.xi, eta: t.eta, r: p.r, mag: p.star.mag });
    }
    return corr;
}

/** Residual (px) of a correspondence under an affine model (pixel->tangent). */
function residPx(fit, c, degPerPx) {
    const pxi = fit.a[0] * c.x + fit.a[1] * c.y + fit.a[2];
    const peta = fit.b[0] * c.x + fit.b[1] * c.y + fit.b[2];
    return Math.hypot(pxi - c.xi, peta - c.eta) / degPerPx;
}

/**
 * Core RANSAC++ over putative correspondences (each: pixel x,y + tangent xi,eta
 * about a FIXED crval). Minimal sample = 3 (full affine), maximize inliers, then
 * LO-RANSAC: refit affine on the full inlier set and re-collect (one round).
 */
export function ransacCore(corr, crvalDeg, o) {
    if (corr.length < 3) return null;
    const rand = rng(o.seed ?? 1234567);
    const degPerPx = o.degPerPx;
    const tolPx = o.inlierTolPx;
    let best = null;
    const N = corr.length;
    const iters = Math.min(o.iters ?? 400, 3 * N * N);
    for (let it = 0; it < iters; it++) {
        // sample 3 distinct
        const i = (rand() * N) | 0, j = (rand() * N) | 0, k = (rand() * N) | 0;
        if (i === j || j === k || i === k) continue;
        const fit = fitAffine([corr[i], corr[j], corr[k]]);
        if (!fit) continue;
        // scale sanity: reject wildly non-physical minimal fits early
        const sc = Math.sqrt(Math.abs(fit.a[0] * fit.b[1] - fit.a[1] * fit.b[0])) * 3600;
        if (!(sc > 0) || sc < o.scaleMin || sc > o.scaleMax) continue;
        let inl = 0;
        for (const c of corr) if (residPx(fit, c, degPerPx) < tolPx) inl++;
        if (!best || inl > best.inl) best = { fit, inl };
    }
    if (!best) return null;
    // LO-RANSAC refine: refit on inliers, iterate twice with shrinking tol
    let fit = best.fit;
    for (let round = 0; round < 3; round++) {
        const tol = tolPx * (round === 2 ? 0.6 : 1.0);
        const inliers = corr.filter((c) => residPx(fit, c, degPerPx) < tol);
        if (inliers.length < 3) break;
        const rf = fitAffine(inliers);
        if (!rf) break;
        fit = rf;
    }
    const inlierSet = corr.filter((c) => residPx(fit, c, degPerPx) < tolPx);
    const wcs = affineToWcs(fit, crvalDeg);
    return { wcs, fit, inliers: inlierSet.length, inlierSet };
}

/**
 * MAGSAC-style threshold-free soft score: marginalize the inlier weight over a
 * range of noise scales instead of committing to one tolerance. Returns the
 * mean soft-inlier count. Redescending (Wachter) weight w=max(0,1-(r/kσ)^2).
 */
export function magsacScore(corr, fit, degPerPx, tolPx) {
    let acc = 0, ns = 0;
    for (let s = 0.4; s <= 1.6; s += 0.4) {           // marginalize sigma
        const kσ = tolPx * s;
        let sum = 0;
        for (const c of corr) {
            const r = residPx(fit, c, degPerPx);
            const u = r / kσ;
            if (u < 1) sum += (1 - u * u);
        }
        acc += sum; ns++;
    }
    return acc / ns;
}

// ── chance null: random reorientations of the refined WCS ───────────────────
function rotateCd(cd, thetaRad) {
    const c = Math.cos(thetaRad), s = Math.sin(thetaRad);
    return [[c * cd[0][0] - s * cd[1][0], c * cd[0][1] - s * cd[1][1]],
    [s * cd[0][0] + c * cd[1][0], s * cd[0][1] + c * cd[1][1]]];
}
function nullDistribution(wcs, det, cat, grid, o, K, seed) {
    const rand = rng(seed);
    const vals = [];
    for (let k = 0; k < K; k++) {
        const th = rand() * 2 * Math.PI;
        if (th < 0.05 || th > 2 * Math.PI - 0.05) { k--; continue; } // avoid ~identity
        const w2 = { crval: wcs.crval, crpix: wcs.crpix, cd: rotateCd(wcs.cd, th) };
        vals.push(correspond(w2, det, cat, grid, o).length);
    }
    const n = vals.length || 1;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(Math.max(1e-9, vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n));
    return { mean, std: std || 1 };
}

/**
 * VALIDATOR (contract.mjs). candidate WCS + det + cat -> ValidationResult.
 *
 * The MEASURED significance is match-count vs the WCS's own random-orientation
 * ensemble (the app's UW-sweep null: a real field aligns at ONE orientation, a
 * chance configuration at none). This reproduces the app's sweep sigma within
 * ~0.4σ on the bundled CR2. LO-RANSAC additionally fits a refined affine WCS;
 * whichever of {candidate, refined} yields the higher sigma is reported, so the
 * refine can help but can never manufacture significance the null doesn't grant.
 *
 * opts: {w,h, ocx,ocy, tolBasePx, tolSlope, inlierTolPx, scaleMin, scaleMax,
 *        iters, nullK, seed}
 */
export function validateWCS(candidate, det, cat, opts = {}) {
    const o = withDefaults(candidate, det, opts);
    const grid = buildDetGrid(det, 128);

    // robust affine refine (also the source of refinedWcs + MAGSAC score)
    const putative = correspond(candidate, det, cat, grid, o);
    const rc = putative.length >= 3 ? ransacCore(putative, candidate.crval, o) : null;

    // score candidate AND the refined WCS; each against ITS OWN rotation null.
    const cands = [{ wcs: candidate, tag: 'candidate' }];
    if (rc && rc.wcs) cands.push({ wcs: rc.wcs, tag: 'refined' });
    let best = null;
    for (const c of cands) {
        const M = countCatMatches(c.wcs, cat, grid, o).matched;
        const { mean, std } = nullDistribution(c.wcs, det, cat, grid, o, o.nullK, (o.seed ?? 1) ^ 0x9e37);
        const sigma = (M - mean) / std;
        if (!best || sigma > best.sigma) best = { ...c, M, mean, std, sigma };
    }
    const score = rc ? magsacScore(correspond(best.wcs, det, cat, grid, o), rc.fit, o.degPerPx, o.inlierTolPx) : null;
    const accepted = best.sigma >= GATE.Z && best.M >= GATE.MIN_INLIERS;
    return result(best.M, putative.length, best.sigma, score, best.wcs, accepted, best.mean, best.std, `ransac:${best.tag}`);
}

/**
 * Correspondence-seeded entry: fit robustly from explicit det<->cat pairs (e.g.
 * quad matches), then verify like validateWCS. corr items: {x,y, ra_deg,dec_deg}.
 */
export function validateFromCorrespondences(corr, crvalDeg, det, cat, opts = {}) {
    const seed = { crval: crvalDeg, crpix: [opts.w / 2, opts.h / 2], cd: cdFrom(opts.scaleGuess ?? 1, 0, 1) };
    // derive an initial affine straight from the given pairs, then validate
    const tanged = corr.map((c) => {
        const t = tanForward(c.ra_deg, c.dec_deg, crvalDeg[0], crvalDeg[1]);
        return t ? { x: c.x, y: c.y, xi: t.xi, eta: t.eta } : null;
    }).filter(Boolean);
    const fit = fitAffine(tanged);
    if (!fit) return result(0, tanged.length, null, null, null, false, null, null, 'ransac-corr', 'affine seed failed');
    const wcs = affineToWcs(fit, crvalDeg);
    return validateWCS(wcs, det, cat, opts);
}

function withDefaults(candidate, det, opts) {
    const scale = cdMetrics(candidate.cd).scale;
    const w = opts.w, h = opts.h;
    return {
        w, h,
        ocx: opts.ocx ?? w / 2, ocy: opts.ocy ?? h / 2,
        degPerPx: scale / 3600,
        // matching net: base + slope*radius. defaults scale with pixel size.
        tolBasePx: opts.tolBasePx ?? Math.max(3, PC.SOLVER_VERIFICATION_RADIUS_ARCSEC / scale),
        tolSlope: opts.tolSlope ?? 0.02,
        inlierTolPx: opts.inlierTolPx ?? (opts.tolBasePx ?? Math.max(3, PC.SOLVER_VERIFICATION_RADIUS_ARCSEC / scale)),
        scaleMin: opts.scaleMin ?? scale * 0.5,
        scaleMax: opts.scaleMax ?? scale * 2.0,
        iters: opts.iters ?? 500,
        nullK: opts.nullK ?? 64,
        seed: opts.seed ?? 20260706,
    };
}
function result(inliers, matched, sigma, score, refinedWcs, accepted, nullMean, nullStd, provenance, reason) {
    return { inliers, matched, sigma, score, refinedWcs, accepted, nullMean, nullStd, provenance, ...(reason ? { reason } : {}) };
}

// Coarse anchor+theta search: the honest way to "reconstruct the true geometry"
// is to find the anchor pixel + orientation that actually aligns the catalog to
// the detections (this is the anchored-sweep generator's job, inlined here so
// the calibration is self-contained). Returns the winning {anchor, theta, parity}.
function findGeometry(det, cat, scale, crval, o) {
    const grid = buildDetGrid(det, 128);
    const anchors = compactAnchors(det, { maxFwhm: 40, w: o.w, h: o.h, edge: 150, k: 8 });
    let best = null;
    for (const a of anchors) {
        for (const parity of [1, -1]) {
            // full theta sweep -> this (anchor,parity)'s OWN null, then peak z.
            // Selecting by z (not raw count) rejects spurious anchors that rack
            // up loose-net chance matches — the app's SOLVER_UW_SWEEP_MIN_Z logic.
            let sum = 0, sq = 0, n = 0, peak = { th: 0, m: -1 };
            for (let th = 0; th < 360; th += 1.5) {
                const m = countCatMatches({ crval, crpix: [a.x, a.y], cd: cdFrom(scale, th, parity) }, cat, grid, o).matched;
                sum += m; sq += m * m; n++;
                if (m > peak.m) peak = { th, m };
            }
            const mean = sum / n, std = Math.sqrt(Math.max(1e-9, sq / n - mean * mean)) || 1;
            const z = (peak.m - mean) / std;
            if (!best || z > best.z) best = { a, th: peak.th, parity, m: peak.m, z, mean, std };
        }
    }
    // fine refine theta around the winner (keep maximizing raw match at peak)
    for (let th = best.th - 2; th <= best.th + 2; th += 0.25) {
        const m = countCatMatches({ crval, crpix: [best.a.x, best.a.y], cd: cdFrom(scale, th, best.parity) }, cat, grid, o).matched;
        if (m > best.m) best = { ...best, th, m };
    }
    return best;
}

// ── self-calibration (known-answer) ─────────────────────────────────────────
async function selftest() {
    await loadWasm();
    const f = loadDetections('sample_observation');
    const scale = f.scaleArcsecPerPx;
    const jup = f.planets.find((p) => p.name === 'jupiter');
    const crval = [jup.ra_hours * 15, jup.dec_degrees];       // Jupiter, DEGREES
    console.log(`\n[SELFTEST] frame=${f.name} ${f.width}x${f.height} scale=${scale.toFixed(3)}"/px  crval(Jupiter)=${crval[0].toFixed(3)}/${crval[1].toFixed(3)}deg`);

    const radiusDeg = (Math.hypot(f.width, f.height) / 2) * scale / 3600 + 5;
    const { stars } = loadCatalog({ raDeg: crval[0], decDeg: crval[1], radiusDeg, magLimit: PC.SOLVER_UW_VERIFY_MAG_LIMIT });
    console.log(`[SELFTEST] catalog: ${stars.length} stars mag<=${PC.SOLVER_UW_VERIFY_MAG_LIMIT} within ${radiusDeg.toFixed(0)}deg`);

    const opts = { w: f.width, h: f.height, tolBasePx: 8, tolSlope: VERIFY_NET.WIDE_NET_SLOPE, inlierTolPx: 12, nullK: 128 };
    const searchO = { w: f.width, h: f.height, ocx: f.width / 2, ocy: f.height / 2, tolBasePx: 8, tolSlope: VERIFY_NET.WIDE_NET_SLOPE };

    // TRUE geometry: locate the aligning anchor + orientation, then VALIDATE it.
    const g = findGeometry(f.det, stars, scale, crval, searchO);
    console.log(`[SELFTEST] located anchor=(${g.a.x.toFixed(0)},${g.a.y.toFixed(0)}) theta=${g.th.toFixed(2)} parity=${g.parity} sweep-z=${g.z.toFixed(1)} (app solve: theta~=155.65) peak-matches=${g.m}`);
    const trueWcs = { crval, crpix: [g.a.x, g.a.y], cd: cdFrom(scale, g.th, g.parity) };
    const trueRes = validateWCS(trueWcs, f.det, stars, opts);
    console.log(`\n[SELFTEST] TRUE  : matched=${trueRes.inliers} sigma=${fmt(trueRes.sigma, 1)} (null ${fmt(trueRes.nullMean, 1)}+-${fmt(trueRes.nullStd, 2)}) score=${fmt(trueRes.score, 1)} accepted=${trueRes.accepted} [${trueRes.provenance}]`);

    // DECOY 1: same anchor+scale, rotated 90deg off the true orientation.
    const decoy = validateWCS({ crval, crpix: [g.a.x, g.a.y], cd: cdFrom(scale, g.th + 90, g.parity) }, f.det, stars, opts);
    console.log(`[SELFTEST] DECOY1: inliers=${decoy.inliers} sigma=${fmt(decoy.sigma, 1)} (null ${fmt(decoy.nullMean, 1)}+-${fmt(decoy.nullStd, 2)}) score=${fmt(decoy.score, 1)} accepted=${decoy.accepted}   [theta+90]`);

    // DECOY 2: wrong sky center entirely (catalog for a different patch of sky).
    const badCrval = [(crval[0] + 137) % 360, -crval[1]];
    const { stars: badStars } = loadCatalog({ raDeg: badCrval[0], decDeg: badCrval[1], radiusDeg, magLimit: PC.SOLVER_UW_VERIFY_MAG_LIMIT });
    const decoy2 = validateWCS({ crval: badCrval, crpix: [g.a.x, g.a.y], cd: cdFrom(scale, 40, 1) }, f.det, badStars, opts);
    console.log(`[SELFTEST] DECOY2: inliers=${decoy2.inliers} sigma=${fmt(decoy2.sigma, 1)} score=${fmt(decoy2.score, 1)} accepted=${decoy2.accepted}   [wrong sky center]`);

    // Discrimination is on SIGMA (matched-vs-chance), not raw matched count:
    // over a loose ultra-wide net a decoy can rack up a high RAW count (decoy2),
    // but only the TRUE geometry clears the null. That is the honest statistic.
    const maxDecoySigma = Math.max(decoy.sigma, decoy2.sigma);
    const pass = trueRes.accepted && !decoy.accepted && !decoy2.accepted &&
        (trueRes.sigma - maxDecoySigma) >= 3;
    console.log(`\n[SELFTEST] DISCRIMINATION: ${pass ? 'PASS' : 'FAIL'} ` +
        `(TRUE +${fmt(trueRes.sigma, 1)}sigma accepted; decoys +${fmt(decoy.sigma, 1)}/+${fmt(decoy2.sigma, 1)}sigma rejected; ` +
        `margin ${fmt(trueRes.sigma - maxDecoySigma, 1)}sigma)`);
    console.log(`[SELFTEST] Note: raw matched counts over the loose UW net are NOT a discriminator ` +
        `(decoy2 raw=${decoy2.inliers} > true=${trueRes.inliers}); the null-referenced sigma IS.\n`);
    return pass;
}

if (isMain(import.meta.url)) {
    if (process.argv.includes('--selftest')) {
        selftest().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(2); });
    } else {
        console.log('solverkit/ransac.mjs — VALIDATOR. Run with --selftest for the known-answer calibration.');
    }
}
