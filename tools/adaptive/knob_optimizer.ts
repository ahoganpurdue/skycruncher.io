/**
 * ═══════════════════════════════════════════════════════════════════════════
 * KNOB OPTIMIZER — per-image detection-knob search against ground truth (SANDBOX)
 * ═══════════════════════════════════════════════════════════════════════════
 * On a SOLVED image, search the detection knobs (via the adaptive detect_harness)
 * to maximise an objective (F1 by default) against catalog-projected truth, and
 * report the achievable TP/FP frontier vs the current baseline knobs.
 *
 * DISCIPLINE (measurement sandbox, not a gate): this tunes DETECTION knobs
 * against ground truth = ADDING EVIDENCE. It never touches the verify/accept
 * gate and never writes a live constant. Output is a RECOMMENDER artifact
 * (optimal knobs + conditions), never auto-applied (ML=hint-recommender-only).
 *
 * LABEL NOISE is real and reported: catalog completeness, limiting magnitude,
 * proper motion, and edge distortion all inject error into truth. The flux→mag
 * zeropoint used to classify unmatched detections is itself fit from the matched
 * pairs (APPROXIMATE). Small-N caveats belong in every conclusion drawn here.
 *
 * PHYSICS-ANCHORED SEARCH (owner's PSF prior): the FWHM-floor grid is bounded by
 * the predicted real-star size — a floor at/above the real PSF cuts real stars,
 * so the grid runs from the sampling floor up to just below predictedFwhm; and
 * the sharpness/ellipticity grids centre on physically-plausible values. In the
 * UNDERSAMPLED regime the shape knobs have little to bound (stars ≈ junk in
 * size), which the SEPARATING-POWER measurement below quantifies.
 */

import { runDetection, baselineKnobs, type KnobConfig, type Detection } from './detect_harness';
import type { GroundTruth } from './ground_truth';

export interface MatchScore {
    matchRadiusPx: number;
    tp: number;              // detections matched 1:1 to a real catalog star
    confidentFP: number;     // unmatched detections brighter than limitingMag
    ambiguousFP: number;     // unmatched detections fainter than limitingMag (unlabelable)
    expectedTruth: number;   // in-frame catalog stars brighter than limitingMag
    detectedTruth: number;   // of expectedTruth, how many were detected
    precision: number;       // tp / (tp + confidentFP)
    recall: number;          // detectedTruth / expectedTruth
    f1: number;
    zeropoint: number | null;// flux→mag ZP fit from matched pairs (null if too few)
    nDetections: number;
}

/** Greedy 1:1 nearest-neighbour match of detections to truth within radius. */
function matchOneToOne(dets: Detection[], truth: GroundTruth['stars'], radiusPx: number): { pairs: { di: number; ti: number; d: number }[]; matchedDet: boolean[]; matchedTruth: boolean[] } {
    const cand: { di: number; ti: number; d: number }[] = [];
    const r2 = radiusPx * radiusPx;
    // spatial bucket the truth for O(n) neighbour lookups
    const cell = Math.max(1, radiusPx);
    const grid = new Map<string, number[]>();
    truth.forEach((t, ti) => {
        const gx = Math.floor(t.x / cell), gy = Math.floor(t.y / cell);
        const k = `${gx}_${gy}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(ti);
    });
    dets.forEach((d, di) => {
        const gx = Math.floor(d.x / cell), gy = Math.floor(d.y / cell);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const arr = grid.get(`${gx + dx}_${gy + dy}`);
            if (!arr) continue;
            for (const ti of arr) {
                const ddx = d.x - truth[ti].x, ddy = d.y - truth[ti].y;
                const dd = ddx * ddx + ddy * ddy;
                if (dd <= r2) cand.push({ di, ti, d: Math.sqrt(dd) });
            }
        }
    });
    cand.sort((a, b) => a.d - b.d);
    const matchedDet = new Array(dets.length).fill(false);
    const matchedTruth = new Array(truth.length).fill(false);
    const pairs: { di: number; ti: number; d: number }[] = [];
    for (const c of cand) {
        if (matchedDet[c.di] || matchedTruth[c.ti]) continue;
        matchedDet[c.di] = true; matchedTruth[c.ti] = true;
        pairs.push(c);
    }
    return { pairs, matchedDet, matchedTruth };
}

/** Score a detection list against ground truth. Honest limiting-mag handling. */
export function scoreDetections(dets: Detection[], truth: GroundTruth, matchRadiusPx: number): MatchScore {
    const { pairs, matchedDet, matchedTruth } = matchOneToOne(dets, truth.stars, matchRadiusPx);
    const lim = truth.limitingMag;

    // flux→mag zeropoint from matched pairs that have a catalog mag: mag = ZP - 2.5·log10(flux)
    const zpSamples: number[] = [];
    for (const p of pairs) {
        const m = truth.stars[p.ti].mag;
        const f = dets[p.di].flux;
        if (m != null && f > 0) zpSamples.push(m + 2.5 * Math.log10(f));
    }
    zpSamples.sort((a, b) => a - b);
    const zeropoint = zpSamples.length >= 10 ? zpSamples[zpSamples.length >> 1] : null;
    const estMag = (flux: number) => (zeropoint != null && flux > 0 ? zeropoint - 2.5 * Math.log10(flux) : null);

    const tp = pairs.length;
    let confidentFP = 0, ambiguousFP = 0;
    dets.forEach((d, di) => {
        if (matchedDet[di]) return;
        const em = estMag(d.flux);
        if (lim != null && em != null && em <= lim) confidentFP++;
        else ambiguousFP++;
    });

    // recall is truth-anchored on the expected (bright-enough) catalog stars
    let expectedTruth = 0, detectedTruth = 0;
    truth.stars.forEach((t, ti) => {
        if (lim != null && t.mag != null && t.mag > lim) return; // fainter than completeness → not expected
        expectedTruth++;
        if (matchedTruth[ti]) detectedTruth++;
    });

    const precision = tp + confidentFP > 0 ? tp / (tp + confidentFP) : 0;
    const recall = expectedTruth > 0 ? detectedTruth / expectedTruth : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    return {
        matchRadiusPx, tp, confidentFP, ambiguousFP,
        expectedTruth, detectedTruth,
        precision: +precision.toFixed(4), recall: +recall.toFixed(4), f1: +f1.toFixed(4),
        zeropoint: zeropoint != null ? +zeropoint.toFixed(3) : null,
        nDetections: dets.length,
    };
}

export type Objective = (s: MatchScore) => number;
export const F1_OBJECTIVE: Objective = (s) => s.f1;

export interface EvalResult { knobs: KnobConfig; score: MatchScore; ms: number; }

/** One detection+score evaluation at a knob setting. */
export function evaluate(lum: Float32Array, w: number, h: number, knobs: KnobConfig, truth: GroundTruth, matchRadiusPx: number): EvalResult {
    const run = runDetection(lum, w, h, knobs);
    const score = scoreDetections(run.detections, truth, matchRadiusPx);
    return { knobs, score, ms: run.ms };
}

// ── physics-anchored knob grids ──────────────────────────────────────────────

export interface SearchGrids {
    fwhmFloorPx: number[];
    sharpnessMax: number[];
    ellipticityMax: number[];
    deepSigma: number[];
}

/**
 * Build the physics-anchored search grids. `predictedFwhmPx` bounds the FWHM
 * floor (never search a floor ≥ the real PSF — it would cut real stars);
 * `samplingFloor` bounds it below. The shape grids stay coarse+deterministic.
 */
export function buildGrids(predictedFwhmPx: number | null, measuredMedianFwhmPx: number | null, samplingFloor = 2.0): SearchGrids {
    // Upper bound for the fwhm floor = just under the real star size. The
    // PHYSICS core is a LOWER BOUND (it omits optics/tracking/stacking and
    // assumes a nominal seeing), so when the EMPIRICAL median FWHM is larger it
    // is the truth — take the max, or the floor grid caps too low to separate
    // junk from real stars on real (physics-underestimated) frames.
    const realFwhm = Math.max(predictedFwhmPx ?? 0, measuredMedianFwhmPx ?? 0) || 3.0;
    const top = Math.max(samplingFloor + 0.5, realFwhm * 0.9);
    const fwhmFloorPx = [0]; // 0 = disabled (baseline reference always present)
    for (let v = samplingFloor * 0.5; v <= top + 1e-6; v += Math.max(0.25, (top - samplingFloor * 0.5) / 6)) fwhmFloorPx.push(+v.toFixed(2));
    return {
        fwhmFloorPx: Array.from(new Set(fwhmFloorPx)),
        // sharpness (peak/flux): 1 = single-pixel spike; real PSFs ≪ 1. Search a
        // ladder from tight to disabled.
        sharpnessMax: [0.3, 0.5, 0.7, 0.9, 1.1, Infinity],
        // ellipticity: round stars low; streaks/clusters high.
        ellipticityMax: [0.3, 0.5, 0.7, 0.85, 1.0],
        // deep detection sigma (faint-end aggressiveness).
        deepSigma: [0.5, 1.0, 1.5, 2.0, 3.0],
    };
}

/**
 * Deterministic coordinate-descent optimiser: start at baseline, sweep one knob
 * at a time over its physics-anchored grid, keep the best, repeat until no knob
 * improves the objective. Seedless, order-fixed ⇒ reproducible.
 */
export function optimizeKnobs(args: {
    lum: Float32Array; width: number; height: number;
    truth: GroundTruth; matchRadiusPx: number;
    focalLengthMm?: number;
    grids: SearchGrids;
    objective?: Objective;
    maxRounds?: number;
}): { baseline: EvalResult; best: EvalResult; evaluations: number; history: { knob: string; value: number; obj: number }[] } {
    const { lum, width, height, truth, matchRadiusPx, grids } = args;
    const objective = args.objective ?? F1_OBJECTIVE;
    const maxRounds = args.maxRounds ?? 3;

    const base = baselineKnobs(args.focalLengthMm);
    const baseline = evaluate(lum, width, height, base, truth, matchRadiusPx);
    let bestKnobs: KnobConfig = { ...base };
    let bestObj = objective(baseline.score);
    let bestEval = baseline;
    let evaluations = 1;
    const history: { knob: string; value: number; obj: number }[] = [];

    const axes: { name: keyof KnobConfig; values: number[] }[] = [
        { name: 'fwhmFloorPx', values: grids.fwhmFloorPx },
        { name: 'sharpnessMax', values: grids.sharpnessMax },
        { name: 'ellipticityMax', values: grids.ellipticityMax },
        { name: 'deepSigma', values: grids.deepSigma },
    ];

    for (let round = 0; round < maxRounds; round++) {
        let improvedThisRound = false;
        for (const axis of axes) {
            let axisBestVal = bestKnobs[axis.name];
            let axisBestObj = bestObj;
            let axisBestEval = bestEval;
            for (const v of axis.values) {
                if (v === bestKnobs[axis.name]) continue;
                const trial: KnobConfig = { ...bestKnobs, [axis.name]: v };
                const ev = evaluate(lum, width, height, trial, truth, matchRadiusPx);
                evaluations++;
                const o = objective(ev.score);
                if (o > axisBestObj + 1e-9) { axisBestObj = o; axisBestVal = v; axisBestEval = ev; }
            }
            if (axisBestObj > bestObj + 1e-9) {
                bestKnobs = { ...bestKnobs, [axis.name]: axisBestVal };
                bestObj = axisBestObj; bestEval = axisBestEval;
                improvedThisRound = true;
                history.push({ knob: axis.name, value: axisBestVal as number, obj: +bestObj.toFixed(4) });
            }
        }
        if (!improvedThisRound) break;
    }
    return { baseline, best: bestEval, evaluations, history };
}

// ── separating power (THE headline instrument) ───────────────────────────────

export interface SeparatingPower {
    knob: keyof KnobConfig;
    values: number[];
    f1ByValue: number[];
    precByValue: number[];
    recByValue: number[];
    /** the "no cut" reference (knob at its disabling value). */
    noCutF1: number;
    noCutPrecision: number;
    noCutRecall: number;
    /**
     * SEPARATING POWER = the precision gain the knob can deliver WITHOUT
     * sacrificing recall (max precision over sweep values whose recall stays
     * within `recallTol` of the no-cut recall, minus the no-cut precision).
     * ~0 ⇒ the knob cannot separate stars from junk here (every junk-removing
     * setting also removes real stars — the UNDERSAMPLED signature); large ⇒
     * the knob cleanly removes junk while keeping stars (OVERSAMPLED).
     */
    power: number;
    /** F1 improvement upside (max F1 over sweep − no-cut F1) — softer proxy. */
    f1UpsidePower: number;
    bestValue: number;
    recallTol: number;
}

/** The value that DISABLES a cut knob (its inert/no-op setting). */
function disablingValue(knob: keyof KnobConfig): number {
    if (knob === 'fwhmFloorPx') return 0;
    if (knob === 'sharpnessMax') return Infinity;
    if (knob === 'ellipticityMax') return 1;
    return NaN; // non-cut knob
}

/**
 * Measure a single shape cut knob's SEPARATING POWER: sweep it with all other
 * knobs at baseline, and report how much PRECISION it can buy while holding
 * RECALL (relative to the no-cut reference). This is the instrument that tests
 * the regime thesis — undersampled frames should show ~zero power (junk removal
 * costs stars), oversampled frames real power (junk removal is free of stars).
 */
export function measureSeparatingPower(args: {
    lum: Float32Array; width: number; height: number;
    truth: GroundTruth; matchRadiusPx: number; focalLengthMm?: number;
    knob: keyof KnobConfig; values: number[]; recallTol?: number;
    /** Isolate the SHAPE cut from the hot-pixel pre-pass (default true): the
     *  hotpix masker independently removes single-spike junk BEFORE the shape
     *  cut sees it, so measuring a shape cut's intrinsic discriminability
     *  requires disabling it — otherwise a frame the masker already cleaned
     *  shows spurious zero power. Reported honestly in the artifact. */
    isolateHotpix?: boolean;
}): SeparatingPower {
    const isolateHotpix = args.isolateHotpix ?? true;
    const base = { ...baselineKnobs(args.focalLengthMm), ...(isolateHotpix ? { hotpixMinDensityPerMP: Number.POSITIVE_INFINITY } : {}) };
    const recallTol = args.recallTol ?? 0.03;
    const disVal = disablingValue(args.knob);

    const f1ByValue: number[] = [], precByValue: number[] = [], recByValue: number[] = [];
    const scores: MatchScore[] = [];
    // evaluate the no-cut reference first (append disabling value if absent)
    const sweep = args.values.includes(disVal) || Number.isNaN(disVal) ? [...args.values] : [disVal, ...args.values];
    for (const v of sweep) {
        const ev = evaluate(args.lum, args.width, args.height, { ...base, [args.knob]: v }, args.truth, args.matchRadiusPx);
        scores.push(ev.score);
        f1ByValue.push(ev.score.f1); precByValue.push(ev.score.precision); recByValue.push(ev.score.recall);
    }
    const refIdx = Number.isNaN(disVal) ? 0 : sweep.findIndex(v => v === disVal);
    const noCut = scores[refIdx >= 0 ? refIdx : 0];

    // precision achievable while recall stays within tol of no-cut recall
    let bestPrec = noCut.precision, bestValue = sweep[refIdx >= 0 ? refIdx : 0];
    scores.forEach((s, i) => {
        if (s.recall >= noCut.recall - recallTol && s.precision > bestPrec) { bestPrec = s.precision; bestValue = sweep[i]; }
    });
    const power = +Math.max(0, bestPrec - noCut.precision).toFixed(4);
    const f1UpsidePower = +Math.max(0, Math.max(...f1ByValue) - noCut.f1).toFixed(4);

    return {
        knob: args.knob, values: sweep, f1ByValue, precByValue, recByValue,
        noCutF1: noCut.f1, noCutPrecision: noCut.precision, noCutRecall: noCut.recall,
        power, f1UpsidePower, bestValue: bestValue as number, recallTol,
    };
}
