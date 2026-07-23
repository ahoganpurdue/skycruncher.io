// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — expanded-coverage distortion refit (the mustache hunt)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/psf/refit_distortion.mjs
//        --file <frame.cr2|.fit>            the solved frame
//        --astrometry <cubic_only.json>     current astrometry (WCS + model)
//        [--cache <decode_cache.bin>]       PSF2 decode cache (fast re-runs)
//        [--out <astrometry_refit.json>]    updated astrometry JSON
//        [--report <refit_report.json>]     full diagnostics
//        [--mag-limit 8.5]
//
// WHY: the receipt's 55 solver-verified pairs reach only r = 0.574 of the
// half-diagonal AND cluster azimuthally (the Milky-Way half of the sky; the
// foreground half of a nightscape NEVER has stars). A cubic-only radial fit
// from such a sample cannot represent a mustache (sign-flip) profile and
// confounds radial terms with decentering. This tool expands coverage the
// same way the forced tier found its 1,568 CATALOG_FORCED stars: project
// the atlas through the solved WCS, measure a CENTROID near each predicted
// position, and weight each pair by its measured significance.
//
// PAIRING (documented anti-self-deception measures):
//   - At 63"/px this frame holds ~10^5 local maxima; a naive nearest-peak
//     search inside a +-25 px box pairs mostly by CHANCE (~2.4 expected
//     accidental peaks per box). Candidates are therefore restricted by a
//     magnitude-matched BRIGHTNESS-RANK tier: a catalog star of magnitude m
//     may only pair with peaks ranked <= 3*N_cat(<=m) + 500 by brightness.
//   - Each pair carries an explicit false-match probability
//         pFalse = 1 - exp(-rho_tier * pi * rSearch^2)
//     and enters the fit with weight w = (1 - pFalse) / sigma_centroid^2
//     (sigma_centroid ~ FWHM / (2.355 * SNR_peak) + systematic floor).
//     Chance pairs scatter symmetrically about the model prediction, so
//     they ATTENUATE (never invent) distortion signal; the weighting and
//     the reported pFalse distribution keep that dilution visible.
//   - Structured-background guard: candidate peaks whose local ring MAD
//     exceeds 4x the frame pixel noise (terrain texture, foliage) are
//     refused — same law as the render stage and forced tier.
//   - Search boxes center on the CURRENT distortion model's prediction and
//     the pairing/fit loop iterates 3 times so a real large-radius shift is
//     followed rather than clipped; pairs landing within 1.5 px of the box
//     edge are counted and reported (edge pile-up = censored coverage).
//
// MODEL (all terms LINEAR in parameters; 2 equations per pair):
//   normalized frame coords x' = (x-cx)/hd, y' = (y-cy)/hd, r^2 = x'^2+y'^2;
//   observed displacement d = (detected - TAN-projected)/hd.
//     WCS-residual absorbers (imperfect linear solution, NOT lens terms):
//       t_x, t_y : translation (crpix error)     (1,0) / (0,1)
//       rot      : field rotation                (-y', x')
//       a        : radial scale                  (x', y')
//     Lens terms:
//       k1,k2,k3 : Brown-Conrady radial          (x' r^2n, y' r^2n)
//       p1,p2    : Brown-Conrady decentering     (r^2+2x'^2, 2x'y') and
//                                                (2x'y',  r^2+2y'^2)
//   Weighted least squares on 2N equations, covariance = (X^T W X)^-1
//   inflated by reduced chi^2; two 3-sigma reclips on |2D residual|.
//
// COVERAGE DISCIPLINE (same honesty rules as solution_to_astrometry):
//   k2 (r^5) : only when rMax >= 0.8 AND >= 30 pairs beyond r = 0.6
//   k3 (r^7) : only when rMax >= 0.95 AND >= 25 pairs beyond r = 0.85
//   p1/p2    : only when >= 5 of 8 octants hold >= 15 pairs; otherwise the
//              fit stays radial-only and the output carries an EXPLICIT
//              decentering-confound warning — a lopsided sample cannot
//              separate decentering from radial terms, and pretending
//              otherwise would launder a nightscape's structural coverage
//              hole (foreground never has stars) into fake lens physics.
//   Consumers speak k1/k2 only (corrections.mjs makeBrownConrady): k3/p1/p2
//   are measured for the RECORD and never exported into the applied model.
//
// MULTI-FRAME POOLING (structural conclusion): one nightscape cannot fully
// characterize a lens — different framings fill different octants. The
// output tags every fit input with frame identity so pairs can later be
// pooled per body+lens into a persistent lens-library profile.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeCR2, terminateDecodeWorkers, detectPattern, demosaicBilinear, splitRGB } from './decode_cr2.mjs';
import { decodeFITS } from './decode_fits.mjs';
import { findMaxima, buildNeighborIndex, measureStar, medianOf } from './psf.mjs';
import { robustStats } from './imaging.mjs';
import { skyToPixel } from './solution_to_astrometry.mjs';
import { loadAtlasRegion } from './forced_detect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

// ── generic weighted linear LS with covariance (k <= 9 here) ────────────────

function invertSmall(A) {
    const k = A.length;
    const M = A.map((row, i) => {
        const r = new Float64Array(2 * k);
        r.set(row); r[k + i] = 1;
        return r;
    });
    for (let col = 0; col < k; col++) {
        let piv = col;
        for (let r = col + 1; r < k; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        if (Math.abs(M[piv][col]) < 1e-18) return null;
        [M[col], M[piv]] = [M[piv], M[col]];
        const d = M[col][col];
        for (let c = 0; c < 2 * k; c++) M[col][c] /= d;
        for (let r = 0; r < k; r++) {
            if (r === col) continue;
            const f = M[r][col];
            for (let c = 0; c < 2 * k; c++) M[r][c] -= f * M[col][c];
        }
    }
    return M.map((row) => Array.from(row.slice(k)));
}

/**
 * Weighted LS over rows [{basis: Float64Array(k), obs, w}] (each PAIR
 * contributes two rows — x and y equations sharing the pair weight).
 * Returns { coef, cov, coefSigma, corr } or null.
 */
function solveWeighted(rows, k) {
    const A = Array.from({ length: k }, () => new Float64Array(k));
    const b = new Float64Array(k);
    let m = 0, sw = 0;
    for (const row of rows) {
        if (!(row.w > 0)) continue;
        for (let i = 0; i < k; i++) {
            b[i] += row.w * row.obs * row.basis[i];
            for (let j = 0; j < k; j++) A[i][j] += row.w * row.basis[i] * row.basis[j];
        }
        m++; sw += row.w;
    }
    if (m < 2 * k) return null;
    const Ainv = invertSmall(A);
    if (!Ainv) return null;
    const coef = Ainv.map((r) => r.reduce((s, v, j) => s + v * b[j], 0));
    let chi2 = 0;
    for (const row of rows) {
        if (!(row.w > 0)) continue;
        let pred = 0;
        for (let i = 0; i < k; i++) pred += coef[i] * row.basis[i];
        chi2 += row.w * (row.obs - pred) ** 2;
    }
    // weights are inverse variances in the SAME (normalized) units as obs,
    // so reduced chi^2 is the standard chi2/(m-k); inflation > 1 honestly
    // widens the errors when the actual scatter exceeds the claimed sigmas
    // (mismatched pairs, unmodeled field structure)
    const chi2red = m > k ? chi2 / (m - k) : 1;
    const infl = Math.max(1, chi2red);
    const cov = Ainv.map((r) => r.map((v) => v * infl));
    const coefSigma = cov.map((r, i) => Math.sqrt(Math.max(0, r[i])));
    const corr = cov.map((r, i) => r.map((v, j) => +(v / Math.max(1e-30, coefSigma[i] * coefSigma[j])).toFixed(3)));
    return { coef, cov, coefSigma, corr, chi2red };
}

// ── model term construction ─────────────────────────────────────────────────

/**
 * Basis vectors for one pair at normalized (x', y').
 * terms: array of names in order, from:
 *   tx ty rot a k1 k2 k3 p1 p2
 * Returns { bx: Float64Array, by: Float64Array }.
 */
function pairBasis(xn, yn, terms) {
    const r2 = xn * xn + yn * yn;
    const bx = new Float64Array(terms.length);
    const by = new Float64Array(terms.length);
    terms.forEach((t, i) => {
        switch (t) {
            case 'tx': bx[i] = 1; by[i] = 0; break;
            case 'ty': bx[i] = 0; by[i] = 1; break;
            case 'rot': bx[i] = -yn; by[i] = xn; break;
            case 'a': bx[i] = xn; by[i] = yn; break;
            case 'k1': bx[i] = xn * r2; by[i] = yn * r2; break;
            case 'k2': bx[i] = xn * r2 * r2; by[i] = yn * r2 * r2; break;
            case 'k3': bx[i] = xn * r2 * r2 * r2; by[i] = yn * r2 * r2 * r2; break;
            case 'p1': bx[i] = r2 + 2 * xn * xn; by[i] = 2 * xn * yn; break;
            case 'p2': bx[i] = 2 * xn * yn; by[i] = r2 + 2 * yn * yn; break;
            default: throw new Error(`unknown term ${t}`);
        }
    });
    return { bx, by };
}

/** Robust (2 reclip rounds on |2D residual|) weighted fit of the term set. */
function fitModel(pairs, terms) {
    const k = terms.length;
    let use = pairs.map(() => true);
    let result = null;
    for (let pass = 0; pass < 3; pass++) {
        const rows = [];
        pairs.forEach((p, i) => {
            if (!use[i]) return;
            const { bx, by } = pairBasis(p.xn, p.yn, terms);
            rows.push({ basis: bx, obs: p.dx, w: p.w });
            rows.push({ basis: by, obs: p.dy, w: p.w });
        });
        const sol = solveWeighted(rows, k);
        if (!sol) return null;
        // residuals per pair
        let ssw = 0, sw = 0, nUsed = 0;
        const resMag = pairs.map((p) => {
            const { bx, by } = pairBasis(p.xn, p.yn, terms);
            let px = 0, py = 0;
            for (let i = 0; i < k; i++) { px += sol.coef[i] * bx[i]; py += sol.coef[i] * by[i]; }
            return Math.hypot(p.dx - px, p.dy - py);
        });
        pairs.forEach((p, i) => {
            if (use[i]) { ssw += p.w * resMag[i] * resMag[i]; sw += p.w; nUsed++; }
        });
        const rms = Math.sqrt(ssw / Math.max(1e-12, sw));
        result = { ...sol, terms, rms2D: rms, nUsed, resMag };
        if (pass < 2) {
            const next = pairs.map((p, i) => resMag[i] <= 3 * rms);
            if (next.filter(Boolean).length >= 2 * k) use = next;
        }
    }
    result.used = use;
    return result;
}

// ── image helpers ────────────────────────────────────────────────────────────

function pixelNoiseSigma(L, maxN = 200000) {
    const step = Math.max(1, Math.floor(L.length / maxN));
    const d = [];
    for (let i = 0; i + 1 < L.length; i += step) d.push(Math.abs(L[i + 1] - L[i]));
    d.sort((a, b) => a - b);
    return Math.max(1e-8, 1.4826 * d[d.length >> 1] / Math.SQRT2);
}

function ringStats(L, w, h, px, py) {
    const vals = [];
    for (let r = 10; r <= 14; r += 2) {
        for (let t = -r; t <= r; t += 2) {
            const pts = [[px + t, py - r], [px + t, py + r], [px - r, py + t], [px + r, py + t]];
            for (const [X, Y] of pts) {
                if (X >= 0 && Y >= 0 && X < w && Y < h) vals.push(L[Y * w + X]);
            }
        }
    }
    vals.sort((a, b) => a - b);
    const med = vals[vals.length >> 1];
    const dev = vals.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    return { med, mad: 1.4826 * dev[dev.length >> 1] };
}

/** Flux-weighted centroid in a (2R+1)^2 cutout above bg + 1.5 sigma. */
function fluxCentroid(L, w, h, px, py, bg, sigma, R = 8) {
    let sw = 0, sx = 0, sy = 0;
    for (let dy = -R; dy <= R; dy++) {
        const Y = py + dy;
        if (Y < 1 || Y >= h - 1) continue;
        for (let dx = -R; dx <= R; dx++) {
            const X = px + dx;
            if (X < 1 || X >= w - 1) continue;
            const t = L[Y * w + X] - bg;
            if (t > 1.5 * sigma) { sw += t; sx += t * X; sy += t * Y; }
        }
    }
    if (sw <= 0) return null;
    return { x: sx / sw, y: sy / sw };
}

// ── coverage diagnostics ─────────────────────────────────────────────────────

function radiusHistogram(rs, binW = 0.1) {
    const hist = {};
    for (const r of rs) {
        const b = (Math.floor(r / binW) * binW).toFixed(1);
        hist[b] = (hist[b] || 0) + 1;
    }
    return hist;
}

/** Octant counts about the frame center (image convention, y-down). */
function octantCounts(xy, cx, cy) {
    const counts = new Array(8).fill(0);
    for (const [x, y] of xy) {
        let a = Math.atan2(y - cy, x - cx); // y-down image space
        if (a < 0) a += 2 * Math.PI;
        counts[Math.min(7, Math.floor(a / (Math.PI / 4)))]++;
    }
    return counts;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    const FILE = path.resolve(argVal('--file', 'public/demo/sample_observation.cr2'));
    const ASTRO = argVal('--astrometry', null);
    const CACHE = argVal('--cache', null);
    const OUT = argVal('--out', null);
    const REPORT = argVal('--report', null);
    const MAG_LIMIT = parseFloat(argVal('--mag-limit', '8.5'));
    if (!ASTRO) { console.error('need --astrometry <current astrometry JSON>'); return 1; }

    const astro = JSON.parse(fs.readFileSync(ASTRO, 'utf8'));
    const wcs = astro.wcs;
    const [w0, h0] = astro.provenance?.image_dims ?? [null, null];

    // ── decode (PSF2 cache preferred) ──
    console.log('== decode ==');
    let w, h, rgb16;
    if (CACHE && fs.existsSync(CACHE)) {
        const buf = fs.readFileSync(CACHE);
        if (buf.readUInt32LE(0) === 0x50534632) {
            w = buf.readUInt32LE(4); h = buf.readUInt32LE(8);
            rgb16 = new Uint16Array(buf.buffer.slice(12), 0, w * h * 3);
            console.log(`  cache hit ${w}x${h}`);
        }
    }
    if (!rgb16) {
        const dec = /\.(fits?|fts)$/i.test(FILE) ? decodeFITS(FILE) : await decodeCR2(FILE);
        ({ w, h, rgb16 } = dec);
        console.log(`  decoded ${w}x${h}`);
    }
    if (w0 && (w0 !== w || h0 !== h)) console.warn(`  WARNING: astrometry dims ${w0}x${h0} != frame ${w}x${h}`);

    // luminance (centroids need no vignette/flatten — both are locally smooth
    // relative to a 17 px cutout; local ring bg handles them)
    const layout = detectPattern(rgb16, w, h);
    const chans = layout.oneHot ? demosaicBilinear(rgb16, w, h, layout.pat) : splitRGB(rgb16, w, h);
    const L = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) L[i] = 0.2126 * chans[0][i] + 0.7152 * chans[1][i] + 0.0722 * chans[2][i];
    const { med: ped } = robustStats(L);
    const sigmaPix = pixelNoiseSigma(L);
    console.log(`  pedestal ${ped.toFixed(5)}, pixel sigma ${sigmaPix.toExponential(3)}`);

    // ── peaks (brightest-first; rank = brightness order) ──
    const peaks = findMaxima(L, w, h, ped + 4 * sigmaPix, 120000, 8);
    console.log(`  ${peaks.length} local maxima @4sigma (brightness-ranked)`);
    const peakIdx = buildNeighborIndex(peaks, 32);
    // FWHM estimate from the brightest isolated peaks
    const fwhmSamples = [];
    for (const p of peaks.slice(0, 400)) {
        const m = measureStar(L, w, h, p.x, p.y, sigmaPix, 9);
        if (m && m.fwhmMaj > 1.5 && m.fwhmMaj < 20) fwhmSamples.push(m.fwhmMaj);
        if (fwhmSamples.length >= 120) break;
    }
    const fwhm = medianOf(fwhmSamples) ?? 10;
    console.log(`  FWHM estimate ${fwhm.toFixed(2)} px (${fwhmSamples.length} bright peaks)`);

    // ── catalog ──
    const cx = (w - 1) / 2, cy = (h - 1) / 2, hd = Math.hypot(cx, cy);
    const scaleDeg = Math.sqrt(Math.abs(wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0]));
    const radiusDeg = hd * scaleDeg + 0.5;
    const { stars, sectorsLoaded } = loadAtlasRegion({
        root: ROOT,
        raDeg: wcs.crval[0], decDeg: wcs.crval[1], radiusDeg, magLimit: MAG_LIMIT,
    });
    // rectilinear projections (linear WCS ONLY — the fit re-derives all
    // nonlinearity, plus absorbers for the WCS's own translation/rotation)
    const proj = [];
    for (const s of stars) {
        const p = skyToPixel(s.ra_deg, s.dec_deg, wcs);
        if (!p) continue;
        // generous margin: distorted position may be well inside even when the
        // rectilinear one is slightly out
        if (p.x < -80 || p.y < -80 || p.x >= w + 80 || p.y >= h + 80) continue;
        proj.push({ ...s, xu: p.x, yu: p.y, ru: Math.hypot(p.x - cx, p.y - cy) / hd });
    }
    proj.sort((a, b) => a.mag - b.mag);
    // brightness-rank tier caps: N_cat(<= mag of star)
    const rankCap = proj.map((_, i) => 3 * (i + 1) + 500);
    // blend guard: drop stars with a similar-brightness neighbor within 3 px
    const tooClose = new Set();
    for (let i = 0; i < proj.length; i++) {
        for (let j = i + 1; j < proj.length; j++) {
            if (Math.abs(proj[i].xu - proj[j].xu) > 3) continue;
            if (Math.hypot(proj[i].xu - proj[j].xu, proj[i].yu - proj[j].yu) < 3) tooClose.add(j);
        }
    }
    console.log(`  catalog: ${stars.length} stars (mag<=${MAG_LIMIT}, sectors [${sectorsLoaded.join(',')}]), ${proj.length} projected near frame, ${tooClose.size} blend-dropped`);

    // current model for search centering (updated every iteration)
    let model = {
        tx: 0, ty: 0, rot: 0, a: 0,
        k1: astro.distortion?.k1 ?? 0, k2: astro.distortion?.k2 ?? 0, k3: 0,
        p1: 0, p2: 0,
    };
    const predictNative = (xu, yu) => {
        const xn = (xu - cx) / hd, yn = (yu - cy) / hd;
        const r2 = xn * xn + yn * yn;
        const radial = model.a + model.k1 * r2 + model.k2 * r2 * r2 + model.k3 * r2 * r2 * r2;
        const dx = model.tx - model.rot * yn + xn * radial + model.p1 * (r2 + 2 * xn * xn) + 2 * model.p2 * xn * yn;
        const dy = model.ty + model.rot * xn + yn * radial + model.p2 * (r2 + 2 * yn * yn) + 2 * model.p1 * xn * yn;
        return { x: xu + dx * hd, y: yu + dy * hd };
    };

    // ── iterative pairing + fit ──
    let pairs = [], fit = null, terms = null, edgePileup = 0, structuredRefusals = 0;
    for (let iter = 0; iter < 3; iter++) {
        pairs = []; edgePileup = 0; structuredRefusals = 0;
        const claimed = new Map(); // peak index -> pair candidate (brightest mag wins)
        for (let i = 0; i < proj.length; i++) {
            if (tooClose.has(i)) continue;
            const s = proj[i];
            const pred = predictNative(s.xu, s.yu);
            if (pred.x < 12 || pred.y < 12 || pred.x >= w - 12 || pred.y >= h - 12) continue;
            const rS = Math.min(55, 15 + 35 * s.ru ** 3);
            // candidate peaks within rS, brightness rank capped for this mag
            const { map, cellSize, points } = peakIdx;
            const gx = pred.x / cellSize | 0, gy = pred.y / cellSize | 0;
            const reach = Math.ceil(rS / cellSize);
            let best = -1, bestV = -Infinity;
            for (let dy = -reach; dy <= reach; dy++) {
                for (let dx = -reach; dx <= reach; dx++) {
                    const arr = map.get((gx + dx) * 100000 + (gy + dy));
                    if (!arr) continue;
                    for (const pi of arr) {
                        if (pi > rankCap[i]) continue; // brightness-tier guard
                        const pk = points[pi];
                        const d2 = (pk.x - pred.x) ** 2 + (pk.y - pred.y) ** 2;
                        if (d2 > rS * rS) continue;
                        if (pk.v > bestV) { bestV = pk.v; best = pi; }
                    }
                }
            }
            if (best < 0) continue;
            const pk = peaks[best];
            const ring = ringStats(L, w, h, pk.x, pk.y);
            const snrPeak = (pk.v - ring.med) / sigmaPix;
            if (snrPeak < 3.5) continue;
            if (ring.mad > 4 * sigmaPix) { structuredRefusals++; continue; } // structured bg
            const cen = fluxCentroid(L, w, h, pk.x, pk.y, ring.med, sigmaPix, 8);
            if (!cen) continue;
            const distFromPred = Math.hypot(cen.x - pred.x, cen.y - pred.y);
            if (distFromPred > rS - 1.5) edgePileup++;
            // false-match probability for THIS star's tier and search area
            const rho = Math.min(rankCap[i], peaks.length) / (w * h);
            const pFalse = 1 - Math.exp(-rho * Math.PI * rS * rS);
            if (pFalse > 0.85) continue;
            const sigCent = Math.min(8, Math.max(0.15, fwhm / (2.355 * snrPeak))) + 0.4;
            const sigCentNorm = sigCent / hd; // weights must share the obs units (normalized)
            const cand = {
                mag: s.mag, gaia_id: s.gaia_id, ru: s.ru,
                xu: s.xu, yu: s.yu, xd: cen.x, yd: cen.y,
                xn: (s.xu - cx) / hd, yn: (s.yu - cy) / hd,
                dx: (cen.x - s.xu) / hd, dy: (cen.y - s.yu) / hd,
                snr: snrPeak, sigCent, pFalse,
                w: (1 - pFalse) / (sigCentNorm * sigCentNorm),
            };
            const prev = claimed.get(best);
            if (!prev || cand.mag < prev.mag) claimed.set(best, cand);
        }
        pairs = [...claimed.values()];

        // ── coverage gates (recomputed each iteration on the actual sample) ──
        const rsAll = pairs.map((p) => p.ru);
        const rMax = rsAll.length ? Math.max(...rsAll) : 0;
        const nBeyond06 = rsAll.filter((r) => r > 0.6).length;
        const nBeyond085 = rsAll.filter((r) => r > 0.85).length;
        const oct = octantCounts(pairs.map((p) => [p.xd, p.yd]), cx, cy);
        const octOccupied = oct.filter((c) => c >= 15).length;
        terms = ['tx', 'ty', 'rot', 'a', 'k1'];
        if (rMax >= 0.8 && nBeyond06 >= 30) terms.push('k2');
        if (rMax >= 0.95 && nBeyond085 >= 25) terms.push('k3');
        const tangentialAllowed = octOccupied >= 5;
        if (tangentialAllowed) terms.push('p1', 'p2');

        fit = fitModel(pairs, terms);
        if (!fit) { console.error('fit degenerate'); return 1; }
        terms.forEach((t, i) => { model[t] = fit.coef[i]; });
        for (const t of Object.keys(model)) if (!terms.includes(t)) model[t] = 0;
        console.log(`  iter ${iter + 1}: ${pairs.length} pairs (rMax ${rMax.toFixed(3)}, octants>=15: ${octOccupied}/8), terms [${terms.join(',')}], 2D rms ${(fit.rms2D * hd).toFixed(2)} px, edge pile-up ${edgePileup}, structured refusals ${structuredRefusals}`);
    }

    // ── final diagnostics ──
    console.log('\n== fit result ==');
    const named = {};
    terms.forEach((t, i) => { named[t] = { value: fit.coef[i], sigma: fit.coefSigma[i] }; });
    for (const t of terms) {
        console.log(`  ${t.padEnd(3)} = ${named[t].value.toExponential(4)} +- ${named[t].sigma.toExponential(2)}  (${(Math.abs(named[t].value) / Math.max(1e-30, named[t].sigma)).toFixed(1)} sigma)`);
    }

    // residual decomposition on used pairs: radial vs tangential (px)
    let radSS = 0, tanSS = 0, nRes = 0;
    const usedPairs = pairs.filter((_, i) => fit.used[i]);
    for (const p of usedPairs) {
        const { bx, by } = pairBasis(p.xn, p.yn, terms);
        let px = 0, py = 0;
        for (let i = 0; i < terms.length; i++) { px += fit.coef[i] * bx[i]; py += fit.coef[i] * by[i]; }
        const rx = (p.dx - px) * hd, ry = (p.dy - py) * hd;
        const rr = Math.hypot(p.xn, p.yn);
        if (rr > 1e-6) {
            const ux = p.xn / rr, uy = p.yn / rr;
            const rad = rx * ux + ry * uy;
            const tan = -rx * uy + ry * ux;
            radSS += rad * rad; tanSS += tan * tan; nRes++;
        }
    }
    const radialResRms = Math.sqrt(radSS / Math.max(1, nRes));
    const tangentialResRms = Math.sqrt(tanSS / Math.max(1, nRes));

    // rms of the EXPANDED sample under the OLD cubic-only model (fair baseline:
    // same pairs, old model + freshly fitted absorbers tx/ty/rot/a only)
    const oldK1 = astro.distortion?.k1 ?? 0, oldK2 = astro.distortion?.k2 ?? 0;
    const baselinePairs = pairs.map((p) => ({
        ...p,
        dx: p.dx - p.xn * (oldK1 * (p.xn ** 2 + p.yn ** 2) + oldK2 * (p.xn ** 2 + p.yn ** 2) ** 2),
        dy: p.dy - p.yn * (oldK1 * (p.xn ** 2 + p.yn ** 2) + oldK2 * (p.xn ** 2 + p.yn ** 2) ** 2),
    }));
    const baseFit = fitModel(baselinePairs, ['tx', 'ty', 'rot', 'a']);

    // ── mustache verdict ──
    const k1 = named.k1?.value ?? 0, k2 = named.k2?.value ?? 0, k3v = named.k3?.value ?? 0;
    const rsUsed = usedPairs.map((p) => p.ru);
    const rMaxUsed = rsUsed.length ? Math.max(...rsUsed) : 0;
    let mustache = null;
    if (!named.k2) {
        mustache = { verdict: 'UNDETERMINED', reason: 'quintic term not fitted (coverage gate) — a sign flip cannot be measured with a cubic-only profile' };
    } else {
        // D(r) = k1 r^2 + k2 r^4 (+ k3 r^6): root inside sampled coverage?
        const D = (r) => k1 * r * r + k2 * r ** 4 + k3v * r ** 6;
        let flipR = null;
        for (let r = 0.15; r < rMaxUsed - 1e-6; r += 0.005) {
            if (D(r) === 0 || (D(r) < 0) !== (D(r + 0.005) < 0)) { flipR = r + 0.0025; break; }
        }
        if (flipR == null) {
            mustache = { verdict: 'NO SIGN FLIP MEASURED', reason: `fitted profile keeps one sign over sampled r in [0, ${rMaxUsed.toFixed(3)}]` };
        } else {
            // significance: |D| at the extremes of the sampled range vs propagated sigma
            const sigD = (r) => {
                const g = [r * r, r ** 4, r ** 6].slice(0, named.k3 ? 3 : 2);
                const idx = [terms.indexOf('k1'), terms.indexOf('k2'), terms.indexOf('k3')].filter((i) => i >= 0);
                let v = 0;
                for (let i = 0; i < idx.length; i++) for (let j = 0; j < idx.length; j++) v += g[i] * g[j] * fit.cov[idx[i]][idx[j]];
                return Math.sqrt(Math.max(0, v));
            };
            const rIn = Math.max(0.15, flipR / 2), rOut = rMaxUsed;
            const zIn = Math.abs(D(rIn)) / Math.max(1e-30, sigD(rIn));
            const zOut = Math.abs(D(rOut)) / Math.max(1e-30, sigD(rOut));
            const significant = zIn >= 2 && zOut >= 2;
            mustache = {
                verdict: significant ? 'MUSTACHE MEASURED' : 'SIGN FLIP PRESENT BUT NOT SIGNIFICANT',
                sign_flip_r: +flipR.toFixed(3),
                inner_lobe_sigma: +zIn.toFixed(1),
                outer_lobe_sigma: +zOut.toFixed(1),
                note: 'both lobes must clear 2 sigma for a mustache claim',
            };
        }
    }

    // ── coverage maps (expanded set + the original receipt pairs) ──
    const octExpanded = octantCounts(usedPairs.map((p) => [p.xd, p.yd]), cx, cy);
    const octOriginal = astro.distortion?.controlPoints
        ? octantCounts(astro.distortion.controlPoints.map((c) => [c.x + c.dx, c.y + c.dy]), cx, cy)
        : null;
    const octLabels = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']; // image y-down: 0 rad = +x (E), angles increase downward (S at pi/2)
    console.log('\n== coverage ==');
    console.log(`  radius histogram (expanded): ${JSON.stringify(radiusHistogram(rsUsed))}`);
    console.log(`  octants expanded: ${octExpanded.map((c, i) => `${octLabels[i]}=${c}`).join(' ')}`);
    if (octOriginal) console.log(`  octants original-55: ${octOriginal.map((c, i) => `${octLabels[i]}=${c}`).join(' ')}`);
    console.log(`  radial residual rms ${radialResRms.toFixed(2)} px, tangential ${tangentialResRms.toFixed(2)} px`);
    console.log(`\n== mustache verdict: ${mustache.verdict} ==`);
    if (mustache.sign_flip_r) console.log(`  sign flip at r=${mustache.sign_flip_r} (inner ${mustache.inner_lobe_sigma} sigma, outer ${mustache.outer_lobe_sigma} sigma)`);
    else console.log(`  ${mustache.reason}`);

    const tangentialFitted = terms.includes('p1');
    const octOccupiedFinal = octExpanded.filter((c) => c >= 15).length;
    const decentering_confound = tangentialFitted
        ? null
        : `azimuthal coverage too lopsided for a joint radial+decentering fit (${octOccupiedFinal}/8 octants hold >=15 pairs) — the reported k1/k2 may absorb decentering; nightscape foreground structurally never has stars, so this hole cannot be filled from this frame`;

    // decentering contamination check on the ORIGINAL cubic k1
    const kIdx = terms.indexOf('k1');
    const pIdx = terms.indexOf('p1');
    let originalK1Skepticism;
    if (tangentialFitted && kIdx >= 0 && pIdx >= 0) {
        originalK1Skepticism = `joint fit separates them: k1 = ${k1.toExponential(3)} +- ${named.k1.sigma.toExponential(2)} with corr(k1,p1) = ${fit.corr[kIdx][pIdx]}, corr(k1,p2) = ${fit.corr[kIdx][terms.indexOf('p2')]}`;
    } else {
        originalK1Skepticism = 'decentering could NOT be separated (coverage) — the original cubic k1=+0.036 and this refit k1 both remain radial projections of a possibly-decentered field; treat magnitudes as upper-bound-honest, signs as tentative';
    }

    // ── output astrometry JSON (consumer speaks k1/k2 only) ──
    const outDoc = {
        ...astro,
        distortion: {
            model: 'brown-conrady',
            k1: +k1.toFixed(5),
            k2: named.k2 ? +k2.toFixed(5) : 0,
            controlPoints: usedPairs.map((p) => ({
                x: +p.xu.toFixed(2), y: +p.yu.toFixed(2),
                dx: +((p.xd - p.xu)).toFixed(2), dy: +((p.yd - p.yu)).toFixed(2),
            })),
            frame_identity: {
                note: 'controlPoints/fit pairs all come from THIS single frame — multi-frame pooling (per body+lens lens-library profile) requires tagging pairs per frame; different framings fill different octants',
                file: path.relative(process.cwd(), FILE),
                wcs_crval: wcs.crval,
                generated: new Date().toISOString(),
            },
            cubic_only_baseline: astro.distortion,
            fit: {
                tool: 'tools/psf/refit_distortion.mjs',
                n_pairs: pairs.length,
                n_used_after_reclip: fit.nUsed,
                terms,
                coefficients: Object.fromEntries(terms.map((t, i) => [t, { value: +fit.coef[i].toExponential(5), sigma: +fit.coefSigma[i].toExponential(3) }])),
                correlation_matrix: fit.corr,
                wcs_absorbers_note: 'tx/ty/rot/a absorb the linear WCS residual (crpix/rotation/scale error) and are NOT lens terms; they are never exported',
                weighting: 'w = (1 - pFalse) / sigma_centroid^2; sigma_centroid = FWHM/(2.355*SNR_peak) + 0.4 px floor; pFalse = 1 - exp(-rho_tier * pi * rSearch^2) from magnitude-matched brightness-rank tiers',
                rms_2d_px: +(fit.rms2D * hd).toFixed(3),
                radial_residual_rms_px: +radialResRms.toFixed(3),
                tangential_residual_rms_px: +tangentialResRms.toFixed(3),
                // aliases matching the solution_to_astrometry fit-block names so
                // downstream posRms readers (forced tier) work with either tool
                radial_rms_after_px: +radialResRms.toFixed(3),
                tangential_rms_px: +tangentialResRms.toFixed(3),
                tangential_note: tangentialFitted
                    ? 'decentering p1/p2 fitted jointly (measured for the record; NOT exported — consumer contract is radial k1/k2; residual tangential structure is the TPS/controlPoints motivation)'
                    : 'tangential residual unmodeled — TPS/controlPoints motivation',
                p1_p2_attribution: tangentialFitted
                    ? 'the p1/p2-shaped field may be true lens decentering OR differential atmospheric refraction (horizon-pointing frame: refraction grows nonlinearly toward low altitude, producing a smooth one-sided field compression these terms partially absorb) OR residual TAN-mapping mismatch; single-frame data cannot separate these — another pooling motivation'
                    : null,
                baseline_cubic_rms_2d_px: baseFit ? +(baseFit.rms2D * hd).toFixed(3) : null,
                baseline_note: 'baseline = SAME expanded pairs under the old cubic-only k1/k2 with freshly fitted tx/ty/rot/a absorbers (apples-to-apples)',
                r_max_sampled: +rMaxUsed.toFixed(3),
                radius_histogram: radiusHistogram(rsUsed),
                octant_counts_expanded: octExpanded,
                octant_counts_original_receipt_pairs: octOriginal,
                octant_labels: octLabels,
                decentering_confound_warning: decentering_confound,
                original_cubic_k1_skepticism: originalK1Skepticism,
                mustache: mustache,
                edge_pileup_pairs: edgePileup,
                structured_background_refusals: structuredRefusals,
                multi_frame_pooling: 'single-frame nightscape coverage cannot fully characterize this lens (foreground half never has stars); correct instrument = pooled pairs across every solved frame from the same body+lens — frame_identity above makes pooled fits possible later',
            },
        },
    };
    if (OUT) {
        fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(outDoc, null, 2));
        console.log(`\nwritten: ${OUT}`);
    }
    if (REPORT) {
        fs.mkdirSync(path.dirname(path.resolve(REPORT)), { recursive: true });
        fs.writeFileSync(REPORT, JSON.stringify({
            ...outDoc.distortion.fit,
            pairs_sample: usedPairs.slice(0, 400).map((p) => ({
                mag: p.mag, gaia_id: p.gaia_id, ru: +p.ru.toFixed(3),
                snr: +p.snr.toFixed(1), pFalse: +p.pFalse.toFixed(3),
                dx_px: +((p.xd - p.xu)).toFixed(2), dy_px: +((p.yd - p.yu)).toFixed(2),
            })),
        }, null, 2));
        console.log(`report: ${REPORT}`);
    }
    return 0;
}

const code = await main().catch((e) => { console.error('FATAL:', e); return 1; });
terminateDecodeWorkers();
setTimeout(() => process.exit(code), 250);
