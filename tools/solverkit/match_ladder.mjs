// ═══════════════════════════════════════════════════════════════════════════
// SOLVERKIT — MATCH LADDER (the "where does pre-lock matching die" instrument)
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN.md §5 Stage 4 (the a1 bottleneck). A frame that FAILS to solve
// is walked through four progressively-more-specific matching rungs — each run
// under GENUINE injected truth (no oracle, no solve-success feedback) — so the
// output names the EXACT rung where matching dies and with what numeric margin,
// per frame. The aggregate then ROUTES the downstream lever (Stage 5 builds only
// the lever the ladder names).
//
// RUNGS (spec-authoritative — docs/TEST_SUITE_PLAN.md:324-333):
//   A  detection ↔ catalog correspondence under the injected true WCS — sweep
//      τ∈{1,2,4,8}px, report recall_A / precision_A (discriminates bad centroids
//      / noise-maxima from real stars — the D19 risk).                    (:325-326)
//   B  catalog-projection correctness — project under BOTH +1 and −1 parity and
//      take the orientation with more coincidences (the mirrored-sky trap, "do
//      not assert sign"); verify Gaia(deg)/HYG(hours) hybrid-row discrimination
//      isn't corrupting positions.                                        (:327-329)
//   C  quad formation & hash survival — count TRUE quads that survive the
//      geometric tolerance AND land in the catalog quad's hash bin (the PDGP
//      crux; barrel distortion on 14 mm frames drifts true quads out of bin).(:330-332)
//   D  verify bar — feed true correspondences into verifyWCS, read σ (UW best
//      ~+1.2σ vs the +5σ gate).                                           (:333)
//
// DEATH ATTRIBUTION walks A→B→C→D (the spec order) and names the FIRST rung whose
// metric is UNHEALTHY = "where matching dies". A rung whose PRECONDITION is unmet
// (e.g. the catalog does not project into frame ⇒ Rung A has no denominator) is
// reported NOT_MEASURED (honest absence, LAW 3) and skipped for attribution — the
// next rung catches the real cause (a non-projecting catalog trips Rung B). All
// four rungs' full metrics are emitted regardless, so the routing is transparent.
//
// CONTRACT (CLAUDE.md LAW 4, incubator): consumes the SAME solverkit primitives
// the frozen tests use — quad/band-hash geometry (band_hash.mjs), the RANSAC
// validator (ransac.mjs), the projection/atlas plumbing (common.mjs) and the
// tools-lane gate (contract.mjs) — all READ-ONLY, no constant is redefined here.
// Truth labels are harness-side (manifest `true_wcs`/`true_center`), never baked
// into the solver. Zero src/ edits; deterministic (the only randomness — Rung D's
// chance-null ensemble — is seeded through contract-default seeds).
//
//   node tools/solverkit/match_ladder.mjs --manifest <json> [--frame <name>]
//        --out <dir> [--seed <int>]
//
// Two ledgers (LAW 1): everything here is COORDINATE math — catalog positions,
// WCS, tangent-plane quads. No pixel buffer is touched; detections arrive as
// {x,y,flux,fwhm} centroids only.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { GATE, VERIFY_NET } from './contract.mjs';
import {
    projectStars, tanForward, buildDetGrid, nearestDet,
    loadCatalog, loadDetections, loadFitsDetections, loadCr2Detections,
    terminateRawDecodeWorkers, RAW_EXT_RE, isMain, fmt,
} from './common.mjs';
import { quadCode, bucketKey, neighbourKeys } from './band_hash.mjs';
import { validateWCS } from './ransac.mjs';

export const LADDER_VERSION = 'match_ladder/1.0.0';
export const TAU_PX = Object.freeze([1, 2, 4, 8]);   // Rung-A tolerance sweep (spec :325)
export const RUNG_ORDER = Object.freeze(['A', 'B', 'C', 'D']);

// Instrument thresholds (tools-lane diagnostic knobs — NOT calibrated engine
// gates; GATE.Z / GATE.MIN_INLIERS are imported READ-ONLY from contract.mjs and
// used verbatim for Rung D). Overridable per-run via manifest `defaults`.
export const LADDER_DEFAULTS = Object.freeze({
    magLimit: 11,            // catalog depth for real-frame loadCatalog (ignored for inline catalogs)
    // Rung A
    minCatInFrame: 8,        // below this the recall denominator is meaningless ⇒ Rung A NOT_MEASURED
    recallPass: 0.30,        // recall_A at the loosest τ must clear this to be healthy
    precisionPass: 0.10,     // precision_A at the loosest τ (low ⇒ detections are noise maxima)
    // Rung B
    minParityCoincidence: 8, // the winning parity must reach this coincidence count
    minParityMargin: 3,      // winner − loser coincidence margin for a DECISIVE sign call
    // Rung C
    quadTopN: 12,            // form C(topN,4) quads from the brightest true correspondences
    minTrueQuadPairs: 4,     // fewer matched pairs than this ⇒ Rung C NOT_MEASURED
    hashNbins: 16,           // band-hash quantisation (matches build_band_index default nbins=16)
    codeTol: 0.10,           // L∞ tolerance on the 4-D quad code (geometric survival leg)
    survivalPass: 0.30,      // fraction of true quads that must survive the hash to be healthy
    minSurviving: 3,         // absolute floor of surviving quads
    // Rung D (verify) — net mirrors the engine UW verify net (contract VERIFY_NET)
    verifyTolBasePx: 8,
    verifyInlierTolPx: 12,
    verifyNullK: 128,
    // shared
    seed: 20260706,          // Rung-D chance-null seed (byte-reproducible)
    projMargin: 8,           // px margin for "in-frame"
});

// ── small deterministic helpers ─────────────────────────────────────────────
const round = (x, n = 6) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(n));
const combinations4 = (n) => {                              // index 4-combos of [0..n)
    const out = [];
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++)
        for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) out.push([a, b, c, d]);
    return out;
};

/** Mirror a CD matrix (parity flip): negate the 2nd column ⇒ determinant sign
 *  flips ⇒ the projected sky handedness flips. Probes the mirrored-sky trap. */
export function flipParityCd(cd) {
    return [[cd[0][0], -cd[0][1]], [cd[1][0], -cd[1][1]]];
}

/** Greedy nearest det per projected catalog star (one det per star, deduped) —
 *  the same pairing rule as common.countCatMatches. Returns matched count + pairs. */
function matchPairs(det, projCat, tau) {
    const grid = buildDetGrid(det, 128);
    const used = new Set();
    const pairs = [];
    for (const s of projCat) {
        const hit = nearestDet(grid, s.x, s.y, tau);
        if (!hit) continue;
        const key = ((hit.d.x * 131071) | 0) ^ ((hit.d.y * 8191) | 0);
        if (used.has(key)) continue;
        used.add(key);
        pairs.push({ d: hit.d, star: s, r: hit.r });
    }
    return { matched: pairs.length, pairs };
}

/** Fraction of detections that fall within τ of SOME in-frame catalog star
 *  (precision — low ⇒ the detection list is dominated by noise maxima). */
function detPrecision(det, projCat, tau) {
    if (det.length === 0 || projCat.length === 0) return 0;
    const catGrid = buildDetGrid(projCat, 128);
    let hitN = 0;
    for (const d of det) if (nearestDet(catGrid, d.x, d.y, tau)) hitN++;
    return hitN / det.length;
}

const inFrame = (cat, wcs, w, h, margin) => projectStars({ stars: cat, wcs, w, h, margin });

// ═══════════════════════════════════════════════════════════════════════════
// RUNG A — detection ↔ catalog correspondence under injected true WCS
// ═══════════════════════════════════════════════════════════════════════════
export function rungA(det, cat, trueWcs, w, h, cfg) {
    const proj = inFrame(cat, trueWcs, w, h, cfg.projMargin);
    const catInFrame = proj.length;
    if (catInFrame < cfg.minCatInFrame) {
        return { name: 'A', status: 'NOT_MEASURED', healthy: null,
            reason: `only ${catInFrame} catalog stars project in-frame (< ${cfg.minCatInFrame}) — no recall denominator`,
            metrics: { catInFrame, nDet: det.length, recall: {}, precision: {} } };
    }
    const recall = {}, precision = {};
    for (const tau of TAU_PX) {
        recall[tau] = round(matchPairs(det, proj, tau).matched / catInFrame);
        precision[tau] = round(detPrecision(det, proj, tau));
    }
    const tauMax = TAU_PX[TAU_PX.length - 1];
    const rc = recall[tauMax], pr = precision[tauMax];
    const healthy = rc >= cfg.recallPass && pr >= cfg.precisionPass;
    // margin = signed distance of the binding metric below its pass line (<0 fails)
    const recMargin = rc - cfg.recallPass, precMargin = pr - cfg.precisionPass;
    const margin = round(Math.min(recMargin, precMargin));
    return { name: 'A', status: 'MEASURED', healthy, margin,
        binding: recMargin <= precMargin ? 'recall' : 'precision',
        metrics: { catInFrame, nDet: det.length, recall, precision,
            recallAtMaxTau: rc, precisionAtMaxTau: pr } };
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNG B — catalog projection correctness (parity + hybrid-row integrity)
// ═══════════════════════════════════════════════════════════════════════════
export function rungB(det, cat, trueWcs, w, h, cfg) {
    // (1) structural catalog integrity — the Gaia(deg)/HYG(hours) hybrid-row trap.
    //     A hard fail = coords out of range. A soft WARNING = a bimodal RA scale
    //     (some rows ≤24, some >24) that can signal undiscriminated hours-vs-deg
    //     rows (also legitimately occurs for a field straddling RA≈0/24h — hence
    //     WARNING, reported honestly, not an automatic kill).
    let outOfRange = 0, raLo = 0, raHi = 0;
    for (const s of cat) {
        const ra = s.ra_deg, dec = s.dec_deg;
        if (!(ra >= 0 && ra < 360) || !(dec >= -90 && dec <= 90)) outOfRange++;
        if (Number.isFinite(ra)) { if (ra <= 24) raLo++; else raHi++; }
    }
    const bimodalRa = raLo > 0 && raHi > 0 && Math.min(raLo, raHi) / cat.length >= 0.05;

    // (2) parity determination — project under both handedness, take the winner.
    const projPlus = inFrame(cat, trueWcs, w, h, cfg.projMargin);
    const wcsFlip = { crval: trueWcs.crval, crpix: trueWcs.crpix, cd: flipParityCd(trueWcs.cd) };
    const projMinus = inFrame(cat, wcsFlip, w, h, cfg.projMargin);
    const coincPlus = matchPairs(det, projPlus, TAU_PX[2]).matched;   // τ=4px
    const coincMinus = matchPairs(det, projMinus, TAU_PX[2]).matched;
    const winner = coincPlus >= coincMinus ? '+1' : '-1';
    const coincWin = Math.max(coincPlus, coincMinus);
    const coincLose = Math.min(coincPlus, coincMinus);
    const parityMargin = coincWin - coincLose;

    if (Math.max(projPlus.length, projMinus.length) < cfg.minCatInFrame && outOfRange === 0) {
        return { name: 'B', status: 'NOT_MEASURED', healthy: null,
            reason: `catalog projects < ${cfg.minCatInFrame} stars in-frame under either parity`,
            metrics: { outOfRange, bimodalRa, coincPlus, coincMinus, winner, parityMargin,
                catInFramePlus: projPlus.length, catInFrameMinus: projMinus.length } };
    }
    const decisiveParity = coincWin >= cfg.minParityCoincidence && parityMargin >= cfg.minParityMargin;
    const healthy = outOfRange === 0 && decisiveParity;
    // margin: coords-out-of-range dominates; else parity coincidence headroom
    const margin = outOfRange > 0
        ? round(-outOfRange)
        : round(Math.min(coincWin - cfg.minParityCoincidence, parityMargin - cfg.minParityMargin));
    return { name: 'B', status: 'MEASURED', healthy, margin,
        warnings: bimodalRa ? ['bimodal_ra_scale (possible undiscriminated hybrid rows OR an RA≈0/24h field — inspect)'] : [],
        metrics: { outOfRange, bimodalRa, raLo, raHi, coincPlus, coincMinus, winner, parityMargin,
            decisiveParity, catInFramePlus: projPlus.length, catInFrameMinus: projMinus.length } };
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNG C — quad formation & hash survival (uses band_hash geometry directly)
// ═══════════════════════════════════════════════════════════════════════════
export function rungC(det, cat, trueWcs, w, h, cfg) {
    // TRUE correspondences at the LOOSEST τ so distortion doesn't rob us of pairs;
    // Rung C then asks whether those SAME stars' quad CODES survive the hash.
    const proj = inFrame(cat, trueWcs, w, h, cfg.projMargin);
    const { pairs } = matchPairs(det, proj, TAU_PX[TAU_PX.length - 1]);
    if (pairs.length < cfg.minTrueQuadPairs) {
        return { name: 'C', status: 'NOT_MEASURED', healthy: null,
            reason: `only ${pairs.length} true correspondences (< ${cfg.minTrueQuadPairs}) — cannot form quads`,
            metrics: { truePairs: pairs.length, quadsFormed: 0, quadsSurviving: 0, survivalFrac: null } };
    }
    // brightest-first, deterministic; break flux ties by pixel position
    const top = [...pairs]
        .sort((a, b) => (b.d.flux - a.d.flux) || (a.d.x - b.d.x) || (a.d.y - b.d.y))
        .slice(0, cfg.quadTopN);
    const [cra, cdec] = trueWcs.crval;
    const detPt = top.map((p, i) => ({ x: p.d.x, y: p.d.y, id: i }));
    const catPt = top.map((p, i) => {                          // tangent plane about true center
        const t = tanForward(p.star.ra_deg, p.star.dec_deg, cra, cdec);
        return t ? { x: t.xi, y: t.eta, id: i } : null;
    });
    let formed = 0, surviving = 0;
    for (const [a, b, c, d] of combinations4(top.length)) {
        const cp = [catPt[a], catPt[b], catPt[c], catPt[d]];
        if (cp.some((p) => !p)) continue;
        const dCode = quadCode([detPt[a], detPt[b], detPt[c], detPt[d]]);
        const cCode = quadCode(cp);
        if (!dCode || !cCode) continue;
        formed++;
        const sameBin = neighbourKeys(cCode.code, cfg.hashNbins).includes(bucketKey(dCode.code, cfg.hashNbins));
        let l = 0;
        for (let k = 0; k < 4; k++) l = Math.max(l, Math.abs(dCode.code[k] - cCode.code[k]));
        if (sameBin && l <= cfg.codeTol) surviving++;
    }
    if (formed === 0) {
        return { name: 'C', status: 'NOT_MEASURED', healthy: null,
            reason: 'no non-degenerate quads formed from the true correspondences',
            metrics: { truePairs: pairs.length, quadsFormed: 0, quadsSurviving: 0, survivalFrac: null } };
    }
    const survivalFrac = surviving / formed;
    const healthy = survivalFrac >= cfg.survivalPass && surviving >= cfg.minSurviving;
    const margin = round(Math.min(survivalFrac - cfg.survivalPass,
        (surviving - cfg.minSurviving) / Math.max(1, formed)));
    return { name: 'C', status: 'MEASURED', healthy, margin,
        metrics: { truePairs: pairs.length, quadsFormed: formed, quadsSurviving: surviving,
            survivalFrac: round(survivalFrac) } };
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNG D — verify bar (feed the true WCS into the RANSAC validator, read σ)
// ═══════════════════════════════════════════════════════════════════════════
export function rungD(det, cat, trueWcs, w, h, cfg) {
    const proj = inFrame(cat, trueWcs, w, h, cfg.projMargin);
    if (proj.length < GATE.MIN_INLIERS) {
        return { name: 'D', status: 'NOT_MEASURED', healthy: null,
            reason: `only ${proj.length} catalog stars in-frame (< GATE.MIN_INLIERS ${GATE.MIN_INLIERS})`,
            metrics: { sigma: null, matched: 0, nullMean: null, nullStd: null, accepted: false } };
    }
    const v = validateWCS(trueWcs, det, cat, {
        w, h,
        tolBasePx: cfg.verifyTolBasePx,
        tolSlope: VERIFY_NET.WIDE_NET_SLOPE,
        inlierTolPx: cfg.verifyInlierTolPx,
        nullK: cfg.verifyNullK,
        seed: cfg.seed,
    });
    const healthy = v.sigma != null && v.sigma >= GATE.Z && v.matched >= GATE.MIN_INLIERS;
    const margin = v.sigma == null ? null : round(v.sigma - GATE.Z);
    return { name: 'D', status: 'MEASURED', healthy, margin,
        metrics: { sigma: round(v.sigma, 4), matched: v.matched, inliers: v.inliers,
            nullMean: round(v.nullMean, 4), nullStd: round(v.nullStd, 4),
            accepted: v.accepted, provenance: v.provenance,
            gateZ: GATE.Z, gateMinInliers: GATE.MIN_INLIERS } };
}

// ═══════════════════════════════════════════════════════════════════════════
// FRAME INPUT RESOLUTION — inline (synthetic / unit-test) OR loaded (box-lane)
// ═══════════════════════════════════════════════════════════════════════════
/** Build a solverkit WCS from an entry's truth spec: either a full `true_wcs`
 *  {crval,crpix,cd} or an injected `true_center`+scale/rot/parity (PDGP style). */
export function resolveTrueWcs(entry, w, h) {
    if (entry.true_wcs) return entry.true_wcs;
    if (entry.true_center) {
        const c = entry.true_center;
        const raDeg = c.raDeg ?? (c.ra_hours != null ? c.ra_hours * 15 : c.ra_deg);
        const decDeg = c.decDeg ?? c.dec_deg ?? c.dec_degrees;
        const scale = entry.true_scale_arcsec;
        if (scale == null) throw new Error(`frame ${entry.frame}: true_center given but true_scale_arcsec missing`);
        const rot = (entry.true_rot_deg ?? 0) * Math.PI / 180;
        const parity = entry.true_parity ?? 1;
        const dpp = scale / 3600;
        const cd = [[dpp * Math.cos(rot), dpp * Math.sin(rot)],
        [-dpp * parity * Math.sin(rot), dpp * parity * Math.cos(rot)]];
        return { crval: [raDeg, decDeg], crpix: [w / 2, h / 2], cd };
    }
    throw new Error(`frame ${entry.frame}: no truth (need true_wcs or true_center+true_scale_arcsec)`);
}

/** Resolve detections + catalog for one manifest entry. Inline arrays win (the
 *  hermetic unit-test / synthetic path); otherwise load from the atlas + capture
 *  dumps (the box-lane path). Missing external data is an honest ABSENCE, never a
 *  throw — the frame records `data_absent` and is skipped. */
export function resolveInputs(entry, cfg) {
    let det = entry.dets ?? null;
    let w = entry.width, h = entry.height;
    if (!det) {
        const src = entry.frame;
        const f = (/\.(fit|fits)$/i.test(src) || RAW_EXT_RE.test(src))
            ? null                          // FITS/RAW need async decode — handled in runManifest
            : loadDetections(src);
        if (f) { det = f.det; w = w ?? f.width; h = h ?? f.height; }
    }
    let cat = entry.catalog ?? null;
    const trueWcs = det && w && h ? resolveTrueWcs(entry, w, h) : null;
    if (!cat && trueWcs) {
        const { stars } = loadCatalog({
            raDeg: trueWcs.crval[0], decDeg: trueWcs.crval[1],
            radiusDeg: entry.radiusDeg ?? 6, magLimit: entry.magLimit ?? cfg.magLimit,
        });
        cat = stars;
    }
    return { det, cat, w, h, trueWcs };
}

// ═══════════════════════════════════════════════════════════════════════════
// LADDER — run all four rungs on one frame, attribute the death rung
// ═══════════════════════════════════════════════════════════════════════════
export function runLadder({ det, cat, trueWcs, w, h }, cfg, meta = {}) {
    const rungs = {
        A: rungA(det, cat, trueWcs, w, h, cfg),
        B: rungB(det, cat, trueWcs, w, h, cfg),
        C: rungC(det, cat, trueWcs, w, h, cfg),
        D: rungD(det, cat, trueWcs, w, h, cfg),
    };
    // walk A→B→C→D: first UNHEALTHY rung is where matching dies; NOT_MEASURED is
    // skipped (its precondition failed — a downstream rung names the real cause).
    const walk = [];
    let diedAt = null;
    for (const r of RUNG_ORDER) {
        const rr = rungs[r];
        walk.push({ rung: r, status: rr.status, healthy: rr.healthy, margin: rr.margin ?? null });
        if (diedAt == null && rr.status === 'MEASURED' && rr.healthy === false) diedAt = r;
    }
    const anyMeasured = RUNG_ORDER.some((r) => rungs[r].status === 'MEASURED');
    let verdict, margin;
    if (!anyMeasured) { verdict = 'INSUFFICIENT_DATA'; margin = null; }
    else if (diedAt == null) { verdict = 'HEALTHY_LADDER'; margin = null; }   // matcher fine given truth
    else { verdict = diedAt; margin = rungs[diedAt].margin; }

    return {
        frame: meta.frame ?? null,
        label: meta.label ?? null,
        is_control: !!meta.is_control,
        width: w, height: h,
        n_det: det.length, n_cat: cat.length,
        rung_reached: diedAt ?? 'D',   // the deepest rung the frame got through the walk to
        verdict_class: verdict,
        margin,
        walk,
        rungs,
    };
}

// ── routing verdict per class (what Stage-5 lever the ladder names) ──────────
const ROUTE = Object.freeze({
    A: 'detection-recall lever (Stage 5): raise the count of REAL stars reaching the matcher without importing noise maxima (truth-labelled recall, not solve-success).',
    B: 'catalog-projection fix (upstream): hybrid-row Gaia(deg)/HYG(hours) discrimination and/or parity/sign handling — matching cannot begin on a mis-projected catalog.',
    C: 'quad-hash / distortion lever: true quads present but their geometric hash code drifts out of bin (barrel distortion on wide frames) — distortion-aware quad formation or a pre-warp before hashing.',
    D: 'verify-bar / depth lever: the field is too shallow/sparse to reach +5σ even with true correspondences — darks+stacking or a deeper detection pass, NOT a matcher change.',
    HEALTHY_LADDER: 'matcher is NOT the bottleneck for these frames given truth — the failure is upstream in search-center/pointing selection (the rung the ladder deliberately bypasses).',
    INSUFFICIENT_DATA: 'no rung could be measured (missing detections/catalog/truth) — data-provisioning problem, not a solver verdict.',
});

export function aggregate(records, cfg) {
    const counts = {};
    const marginsByClass = {};
    for (const r of records) {
        counts[r.verdict_class] = (counts[r.verdict_class] ?? 0) + 1;
        if (['A', 'B', 'C', 'D'].includes(r.verdict_class) && r.margin != null) {
            (marginsByClass[r.verdict_class] ??= []).push(r.margin);
        }
    }
    const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
    const failClasses = ['A', 'B', 'C', 'D'].filter((c) => counts[c]);
    // dominant failing rung = most frames; tie broken by spec order A<B<C<D
    let routedClass = null, best = -1;
    for (const c of ['A', 'B', 'C', 'D']) {
        if ((counts[c] ?? 0) > best) { best = counts[c] ?? 0; if (counts[c]) routedClass = c; }
    }
    const control = records.find((r) => r.is_control) ?? null;
    return {
        ladder_version: LADDER_VERSION,
        n_frames: records.length,
        counts,
        median_margin_by_class: Object.fromEntries(failClasses.map((c) => [c, median(marginsByClass[c])])),
        control_frame: control ? { frame: control.frame, verdict_class: control.verdict_class } : null,
        routed_class: routedClass,
        routed_verdict: routedClass
            ? `Dominant pre-lock death at Rung ${routedClass} (${counts[routedClass]}/${records.length} frames). ${ROUTE[routedClass]}`
            : `No pre-lock rung failed across ${records.length} frame(s). ${ROUTE.HEALTHY_LADDER}`,
        config: cfg,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// DRIVER — run the manifest, write per-frame JSON + aggregate, print a table
// ═══════════════════════════════════════════════════════════════════════════
export async function runManifest(manifest, cfg, { frameFilter = null } = {}) {
    const records = [];
    let usedRawDecode = false;
    // `entry` is REASSIGNED below when a FITS/RAW frame's detections are decoded
    // on demand — it must be `let`, not the `const` of a for-of binding (the old
    // `const entry` threw "Assignment to constant variable", which silently sank
    // every non-inline FITS/RAW frame into an ERROR record; worked around until
    // now by baking inline dets into the manifest).
    for (let entry of manifest.frames) {
        if (frameFilter && entry.frame !== frameFilter) continue;
        const meta = { frame: entry.frame, label: entry.label ?? manifest.label ?? null, is_control: !!entry.is_control };
        try {
            const src = entry.frame ?? '';
            // async detection decode (box-lane) when no inline dets:
            //   .fit/.fits → loadFitsDetections;  CR2/RAW → loadCr2Detections.
            // Both feed the SAME extractDetectionsFromPlanes rung (common.mjs) —
            // only the decode differs, so the ladder compares arms like with like.
            if (!entry.dets && /\.(fit|fits)$/i.test(src)) {
                const f = await loadFitsDetections(entry.frame);
                entry = { ...entry, dets: f.det, width: entry.width ?? f.width, height: entry.height ?? f.height };
            } else if (!entry.dets && RAW_EXT_RE.test(src)) {
                const f = await loadCr2Detections(entry.frame);
                usedRawDecode = true;
                entry = { ...entry, dets: f.det, width: entry.width ?? f.width, height: entry.height ?? f.height, _cfa: f.cfa };
            }
            const inputs = resolveInputs(entry, cfg);
            if (!inputs.det || !inputs.cat || !inputs.trueWcs || !inputs.w || !inputs.h) {
                records.push({ ...meta, verdict_class: 'DATA_ABSENT',
                    reason: 'missing detections, catalog, truth, or frame dims (external data not present)' });
                continue;
            }
            const rec = runLadder(inputs, cfg, meta);
            if (entry._cfa) rec.cfa = entry._cfa;   // decode provenance for RAW frames
            records.push(rec);
        } catch (e) {
            records.push({ ...meta, verdict_class: 'ERROR', reason: String(e && e.message || e) });
        }
    }
    if (usedRawDecode) await terminateRawDecodeWorkers();   // let the Node process exit cleanly
    return { records, summary: aggregate(records.filter((r) => r.verdict_class !== 'DATA_ABSENT' && r.verdict_class !== 'ERROR'), cfg) };
}

function writeOut(outDir, records, summary) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const r of records) {
        const safe = String(r.frame ?? 'frame').replace(/[^\w.-]/g, '_');
        fs.writeFileSync(path.join(outDir, `${safe}.ladder.json`), JSON.stringify(r, null, 2));
    }
    fs.writeFileSync(path.join(outDir, 'ladder_summary.json'), JSON.stringify(summary, null, 2));
}

function printTable(records, summary) {
    const cell = (r) => {
        if (r.verdict_class === 'DATA_ABSENT' || r.verdict_class === 'ERROR') return r.verdict_class;
        const m = r.margin == null ? '' : ` (m=${fmt(r.margin, 3)})`;
        return `${r.verdict_class}${m}`;
    };
    console.log('\n┌─ match_ladder ' + '─'.repeat(58));
    console.log(`│ ${LADDER_VERSION}  frames=${records.length}`);
    console.log('├' + '─'.repeat(72));
    for (const r of records) {
        const A = r.rungs?.A, B = r.rungs?.B, C = r.rungs?.C, D = r.rungs?.D;
        const st = (x) => (!x ? ' · ' : x.status === 'NOT_MEASURED' ? ' ? ' : x.healthy ? ' ✓ ' : ' ✗ ');
        console.log(`│ ${String(r.frame ?? '?').padEnd(26).slice(0, 26)} `
            + `A${st(A)}B${st(B)}C${st(C)}D${st(D)}  → ${cell(r)}`);
    }
    console.log('└' + '─'.repeat(72));
    console.log(`\nROUTED VERDICT: ${summary.routed_verdict}`);
    console.log(`counts: ${JSON.stringify(summary.counts)}`);
}

async function main() {
    const args = process.argv.slice(2);
    const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
    const manifestPath = val('--manifest');
    const outDir = val('--out');
    const frameFilter = val('--frame');
    const seedArg = val('--seed');
    if (!manifestPath || !outDir) {
        console.error('usage: node match_ladder.mjs --manifest <json> [--frame <name>] --out <dir> [--seed <int>]');
        process.exit(2);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const cfg = { ...LADDER_DEFAULTS, ...(manifest.defaults ?? {}) };
    if (seedArg != null) cfg.seed = +seedArg;
    const { records, summary } = await runManifest(manifest, cfg, { frameFilter });
    writeOut(outDir, records, summary);
    printTable(records, summary);
    console.log(`\nwrote ${records.length} per-frame record(s) + ladder_summary.json → ${outDir}`);
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(e); process.exit(2); });
