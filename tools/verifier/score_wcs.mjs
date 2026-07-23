// ═══════════════════════════════════════════════════════════════════════════
// GEOMETRIC VERIFIER — WCS SCORER (tools-lane incubator, LAW 4)
// ═══════════════════════════════════════════════════════════════════════════
// Scores a candidate WCS by GEOMETRIC agreement between frame detections and
// catalog stars projected through that WCS — quad-code matches gated on a
// near-identity implied transform — against a scrambled-position null on the
// SAME frame (same discipline as the photometric null).
//
// Built as the answer to three falsifications (night 2026-07-12→13, banked in
// test_results/night_run_2026-07-13/MORNING_REPORT.md + BATCH_TABLE.json
// campaign_findings + superpixel/truth_test/truth_test_findings.json):
//   (i)   completeness-cap raising floods the chance denominator
//         -> pools here are BRIGHTNESS-CAPPED (top-N det, top-M cat): the
//            score cannot be moved by total detection count.
//   (ii)  tightening the proximity net = FP-acceptance hazard
//         -> no proximity net at all; agreement = 4-point shape identity
//            (code match) x near-identity transform. Chance must fake four
//            correlated positions AND the transform, not one radius.
//   (iii) proximity z saturates ~+4.2σ even at exact truth
//         -> the scrambled null for gated quads is near-zero, so the score
//            (anchored stars / passing quads above null) GROWS with genuine
//            structure instead of saturating.
// Capacity (truth_test_findings.json smoking gun — fine stage starved at
// 50 catalog + 12-14 det vs 162,900 in-frame): defaults N=150 det / M=300 cat,
// ~10-20x the starved engine caps; eval_xt measures score-vs-N explicitly.
//
// WCS convention here = solverkit convention: crval [RA_DEG, DEC_DEG],
// crpix 0-based, cd 2x2 deg/px (image-space y-down; parity NOT asserted —
// UNIT/FORMAT TRAPS, CLAUDE.md). Normalizers from the banked artifact
// dialects live in this file; engine-internal RA-hours is converted AT the
// boundary, never carried.

import { projectStars, rng } from '../solverkit/common.mjs';
import { buildQuadCodes, hashCodes, matchAndGate, summarizeMatches } from './quad_codes.mjs';

const D2R = Math.PI / 180;

// ── a-priori defaults (DECLARED before first gauntlet run; LAW 2: never tuned
//    post-hoc to make truth pass — changes require new evidence, not reruns) ──
export const DEFAULTS = {
    detPool: 150,        // brightest-N detections (vs engine's starved 12-14)
    catPool: 300,        // brightest-M in-frame catalog (vs engine's starved 50)
    magLimit: 8,         // catalog load depth before brightest-M cap
    sepMinFrac: 0.05,    // quad AB baseline, fraction of frame diagonal
    sepMaxFrac: 0.30,    //   (local quads: similarity model holds; gnomonic
    //                        curvature is shared by both pools by construction)
    capInterior: 6,      // brightest interior stars per AB circle
    codeTol: 0.015,      // 4D code-space match tolerance
    maxLogScale: Math.log(1.06),  // implied-transform gates: 6% scale,
    maxRotDeg: 3,        //   3 deg rotation,
    maxTransPx: 12,      //   12 px centroid translation (banked BC harvest:
    //                        pre-fit residuals ~1.46 px rms at the solve plane
    //                        -> distortion headroom ~8x, not a proximity knob)
    nullReps: 12,        // scrambled-position null repetitions (24 at truth)
    seed: 0xC0FFEE,
};

/** Inverse gnomonic: tangent-plane (xi,eta) in DEGREES about (ra0,dec0) DEG -> ra/dec DEG. */
export function tanInverse(xiDeg, etaDeg, ra0Deg, dec0Deg) {
    const xi = xiDeg * D2R, eta = etaDeg * D2R, a0 = ra0Deg * D2R, d0 = dec0Deg * D2R;
    const D = Math.cos(d0) - eta * Math.sin(d0);
    const ra = a0 + Math.atan2(xi, D);
    const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, D));
    return { raDeg: ((ra / D2R) % 360 + 360) % 360, decDeg: dec / D2R };
}

/** pixel (0-based) -> sky through a solverkit-convention WCS. */
export function pix2sky(wcs, x, y) {
    const dx = x - wcs.crpix[0], dy = y - wcs.crpix[1];
    const xi = wcs.cd[0][0] * dx + wcs.cd[0][1] * dy;
    const eta = wcs.cd[1][0] * dx + wcs.cd[1][1] * dy;
    return tanInverse(xi, eta, wcs.crval[0], wcs.crval[1]);
}

/** Footprint center + capture radius (deg) for catalog loading. */
export function footprint(wcs, w, h) {
    const c = pix2sky(wcs, w / 2, h / 2);
    const det = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0];
    const scaleDegPx = Math.sqrt(Math.abs(det));
    const radiusDeg = scaleDegPx * Math.hypot(w, h) / 2 + 2;
    return { raDeg: c.raDeg, decDeg: c.decDeg, radiusDeg, scaleArcsecPx: scaleDegPx * 3600 };
}

// ── WCS normalizers (artifact dialects -> solverkit convention) ─────────────
/** controls/wcs_####.json: crval_deg (DEGREES), crpix1based, cd flat-4 deg/px. */
export function wcsFromControl(j) {
    return {
        crval: [j.crval_deg[0], j.crval_deg[1]],
        crpix: [j.crpix1based[0] - 1, j.crpix1based[1] - 1],
        cd: [[j.cd[0], j.cd[1]], [j.cd[2], j.cd[3]]],
    };
}
/** engine candidate JSON: crval_hours_ra (HOURS — engine-internal law), crpix0, cd 2x2. */
export function wcsFromEngineCand(c) {
    return {
        crval: [c.crval_hours_ra * 15, c.crval_dec],
        crpix: [c.crpix0[0], c.crpix0[1]],
        cd: [[c.cd[0][0], c.cd[0][1]], [c.cd[1][0], c.cd[1][1]]],
    };
}
/** [SWEEP-PEAK-WCS] solve-log line -> WCS + meta (null if not a peak line). */
export function wcsFromSweepLogLine(line) {
    const m = line.match(/\[SWEEP-PEAK-WCS rank=(\d+)\].*?crval=\[RA ([\d.]+)h, Dec (-?[\d.]+)deg\] crpix=\[([\d.]+), ([\d.]+)\] cd_degpx=\[\[(-?[\d.eE+-]+), (-?[\d.eE+-]+)\], \[(-?[\d.eE+-]+), (-?[\d.eE+-]+)\]\] parity=(-?1) theta=(-?[\d.]+)deg/);
    if (!m) return null;
    return {
        rank: +m[1], parity: +m[10], thetaDeg: +m[11],
        wcs: {
            crval: [+m[2] * 15, +m[3]],
            crpix: [+m[4], +m[5]],
            cd: [[+m[6], +m[7]], [+m[8], +m[9]]],
        },
    };
}

/** Deterministic perturbations of a WCS (decoy factory for the gauntlet). */
export function perturbWcs(wcs, { rotDeg = 0, scaleF = 1, parityFlip = false, dRaDeg = 0, dDecDeg = 0 } = {}) {
    let [[a, b], [c, d]] = wcs.cd;
    if (parityFlip) { b = -b; d = -d; }                    // mirror pixel-y column
    const t = rotDeg * D2R, ct = Math.cos(t), st = Math.sin(t);
    // rotate the sky orientation: cd' = R(theta) · cd, then scale
    const cd = [
        [(ct * a - st * c) * scaleF, (ct * b - st * d) * scaleF],
        [(st * a + ct * c) * scaleF, (st * b + ct * d) * scaleF],
    ];
    return { crval: [wcs.crval[0] + dRaDeg, wcs.crval[1] + dDecDeg], crpix: [...wcs.crpix], cd };
}

// ── the scorer ──────────────────────────────────────────────────────────────
/**
 * Score a candidate WCS on a frame.
 * @param frame {det:[{x,y,flux}], width, height}   det flux-sorted descending
 * @param wcs   solverkit-convention WCS
 * @param catStars [{ra_deg, dec_deg, mag}] covering the candidate footprint
 * @param opts  overrides of DEFAULTS; opts.nullReps for null count
 * @returns measured scores + null stats + timing (all numbers measured)
 */
export function scoreWcs(frame, wcs, catStars, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const t0 = performance.now();
    const W = frame.width, H = frame.height;
    const diag = Math.hypot(W, H);
    const qopts = { sepMin: o.sepMinFrac * diag, sepMax: o.sepMaxFrac * diag, capInterior: o.capInterior };
    const gates = { maxLogScale: o.maxLogScale, maxRotDeg: o.maxRotDeg, maxTransPx: o.maxTransPx };

    // catalog pool: project through candidate WCS, keep in-frame, brightest M
    const proj = projectStars({ stars: catStars, wcs, w: W, h: H, margin: 2 });
    proj.sort((p, q) => p.mag - q.mag);
    const catPts = proj.slice(0, o.catPool).map((s) => ({ x: s.x, y: s.y, w: -s.mag }));
    const inFrameCat = proj.length;

    // detection pool: brightest N
    const detPts = frame.det.slice(0, o.detPool).map((d) => ({ x: d.x, y: d.y, w: d.flux }));

    if (catPts.length < 8 || detPts.length < 8) {
        return {
            starved: true, inFrameCat, catPool: catPts.length, detPool: detPts.length,
            anchored: 0, passQuads: 0, rawMatches: 0,
            null: { reps: 0, mean: null, sd: null, max: null }, z: null, wallMs: performance.now() - t0,
        };
    }

    const catCodes = buildQuadCodes(catPts, qopts);
    const catHash = hashCodes(catCodes, o.codeTol);
    const detCodes = buildQuadCodes(detPts, qopts);
    const obs = summarizeMatches(matchAndGate(detCodes, detPts, catHash, catPts, gates));

    // scrambled-position null: same pool SIZE, positions uniform in frame,
    // SAME catalog codes, SAME gates (photometric-null discipline)
    const rand = rng(o.seed);
    const nullAnchored = [], nullQuads = [];
    for (let r = 0; r < o.nullReps; r++) {
        const scr = detPts.map((d) => ({ x: rand() * W, y: rand() * H, w: d.w }));
        const sc = buildQuadCodes(scr, qopts);
        const s = summarizeMatches(matchAndGate(sc, scr, catHash, catPts, gates));
        nullAnchored.push(s.anchored); nullQuads.push(s.passQuads);
    }
    const mean = avg(nullAnchored), sd = std(nullAnchored, mean);
    const qMean = avg(nullQuads), qSd = std(nullQuads, qMean);
    // z vs scrambled null; sd floor 1.0 (integer counts; a zero-variance null
    // must not manufacture infinite z — Poisson-1 floor, honest and stated)
    const z = (obs.anchored - mean) / Math.max(sd, 1);
    return {
        starved: false, inFrameCat,
        catPool: catPts.length, detPool: detPts.length,
        catCodes: catCodes.count, detCodes: detCodes.count,
        anchored: obs.anchored, passQuads: obs.passQuads, rawMatches: obs.rawMatches,
        null: {
            reps: o.nullReps,
            mean: round(mean), sd: round(sd), max: Math.max(...nullAnchored),
            quadsMean: round(qMean), quadsSd: round(qSd), quadsMax: Math.max(...nullQuads),
        },
        z: round(z),
        wallMs: Math.round(performance.now() - t0),
    };
}

const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
const round = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);
