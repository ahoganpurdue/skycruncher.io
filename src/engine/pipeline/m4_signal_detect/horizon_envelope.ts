/**
 * DETECTION-ENVELOPE HORIZON (owner design, pre-MobileSAM concept):
 * the horizon is written in the negative space of the star detections —
 * walking left to right, the lowest sky detection in each column traces
 * the terrain silhouette, including structures that punch holes in the
 * star field (towers, ridgelines, trees). Works precisely where
 * intensity-based segmentation is blind: pitch-black foreground.
 *
 * Robustness: a raw "lowest detection" walk gets hijacked by foreground
 * LIGHTS (campfires, tower lamps — real detections below the true
 * horizon). Each envelope node therefore requires SKY SUPPORT: a minimum
 * number of detections in the band directly above it. Isolated foreground
 * detections have terrain above them (no detections) and are skipped.
 *
 * Pure and rendering-agnostic; consumed by the step-3 overlay and
 * (evidence-gated) by the topography culling path.
 */

export interface HorizonEnvelopePoint {
    /** Column-center x in image pixels. */
    x: number;
    /** Envelope y in image pixels (image convention: larger y = lower). */
    y: number;
    /** True when this column had a supported node (false = interpolated). */
    measured: boolean;
}

export interface HorizonEnvelope {
    points: HorizonEnvelopePoint[];
    /**
     * Fraction of columns with a measured (non-interpolated) node. Consumers
     * gate on this — a star field with no foreground yields envelopes hugging
     * the frame bottom with low coverage variance, not terrain evidence.
     */
    coverage: number;
    /** True when the envelope shows meaningful terrain (evidence gate). */
    hasTerrainEvidence: boolean;
}

export interface HorizonEnvelopeOptions {
    /** Number of columns. Default 96 (~54px per column on a 5.2k frame). */
    bins?: number;
    /** Minimum detections in the sky-support band above a node. Default 4. */
    minSupport?: number;
    /** Sky-support band height as a fraction of image height. Default 0.15. */
    supportBandFrac?: number;
    /** Median smoothing window (odd). Default 5. */
    smoothWindow?: number;
}

export function computeHorizonEnvelope(
    detections: ReadonlyArray<{ x: number; y: number }>,
    width: number,
    height: number,
    options: HorizonEnvelopeOptions = {}
): HorizonEnvelope {
    const bins = options.bins ?? 96;
    const minSupport = options.minSupport ?? 4;
    const bandH = Math.max(16, (options.supportBandFrac ?? 0.15) * height);
    const smoothWindow = options.smoothWindow ?? 5;

    const colW = width / bins;
    // Detections bucketed per column, plus neighbours for the support test
    // (the support window spans column +/- 1 so narrow columns are not starved).
    const cols: { x: number; y: number }[][] = Array.from({ length: bins }, () => []);
    for (const d of detections) {
        if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
        const c = Math.min(bins - 1, Math.max(0, Math.floor(d.x / colW)));
        cols[c].push(d);
    }

    const rawY = new Array<number>(bins).fill(NaN);
    for (let c = 0; c < bins; c++) {
        const neighbourhood = [
            ...(cols[c - 1] ?? []),
            ...cols[c],
            ...(cols[c + 1] ?? []),
        ];
        // Candidates: this column's detections, lowest (max y) first.
        const candidates = [...cols[c]].sort((a, b) => b.y - a.y);
        for (const cand of candidates) {
            let support = 0;
            for (const n of neighbourhood) {
                if (n === cand) continue;
                if (n.y < cand.y && n.y >= cand.y - bandH) support++;
                if (support >= minSupport) break;
            }
            if (support >= minSupport) { rawY[c] = cand.y; break; }
        }
    }

    // Interpolate empty columns from measured neighbours (frame edges clamp
    // to the nearest measured value); then median-smooth.
    const measured = rawY.map(Number.isFinite);
    const measuredIdx = rawY.map((y, i) => (Number.isFinite(y) ? i : -1)).filter(i => i >= 0);
    const coverage = measuredIdx.length / bins;
    const filled = [...rawY];
    if (measuredIdx.length >= 2) {
        for (let c = 0; c < bins; c++) {
            if (Number.isFinite(filled[c])) continue;
            let lo = -1, hi = -1;
            for (const i of measuredIdx) { if (i < c) lo = i; if (i > c) { hi = i; break; } }
            if (lo < 0) filled[c] = rawY[hi];
            else if (hi < 0) filled[c] = rawY[lo];
            else filled[c] = rawY[lo] + (rawY[hi] - rawY[lo]) * ((c - lo) / (hi - lo));
        }
    }
    const smoothed = [...filled];
    const half = Math.floor(smoothWindow / 2);
    for (let c = 0; c < bins; c++) {
        const win: number[] = [];
        for (let k = Math.max(0, c - half); k <= Math.min(bins - 1, c + half); k++) {
            if (Number.isFinite(filled[k])) win.push(filled[k]);
        }
        if (win.length) {
            win.sort((a, b) => a - b);
            smoothed[c] = win[Math.floor(win.length / 2)];
        }
    }

    const points: HorizonEnvelopePoint[] = smoothed.map((y, c) => ({
        x: (c + 0.5) * colW,
        y: Number.isFinite(y) ? y : height,
        measured: measured[c],
    }));

    // Evidence gate: real terrain leaves the region BELOW the envelope
    // nearly empty of detections, while a full-sky frame has uniform
    // density on both sides of any line the envelope settles on (a naive
    // "envelope above the frame bottom" gate false-positives there).
    // Terrain therefore requires strong density CONTRAST plus a
    // non-trivial below-region area.
    let nAbove = 0, nBelow = 0, areaAbove = 0, areaBelow = 0;
    for (let c = 0; c < bins; c++) {
        const yEnv = points[c].y;
        areaAbove += yEnv * colW;
        areaBelow += (height - yEnv) * colW;
        for (const d of cols[c]) {
            if (d.y < yEnv - 4) nAbove++;
            else if (d.y > yEnv + 4) nBelow++;
        }
    }
    const densityAbove = nAbove / Math.max(1, areaAbove);
    const densityBelow = nBelow / Math.max(1, areaBelow);
    // PROVENANCE (added 2026-07-10, owner-adjudicated FIX_WAVE #27):
    // The three thresholds below — coverage >= 0.4, areaBelow > 3% of the frame,
    // and densityBelow < 0.25 * densityAbove — are ENGINEERING JUDGMENT
    // (heuristic), chosen by design in the single introducing commit f17fa7e
    // ("owner design"). They are NOT derived from measured data: no measured
    // false-positive / false-negative rate for this gate exists yet (round-4
    // audit finding — "no measured FP/FN rate for the gate exists anywhere").
    // The tests in src/engine/tests/m4_horizon_envelope.test.ts pin BEHAVIOR
    // SNAPSHOTS of these values, not a derivation of them. Real provenance
    // graduates via the round-4 envelope truth-check (comparing the envelope
    // against solved-star altitudes) ONCE the additive receipt.envelope block
    // lands (owner midday ruling #3); until then the lane is input-gapped
    // (receipts carry no raw detections and no envelope, so the gate cannot be
    // graded). These values move ONLY via the flagged + graduation-harness
    // path, post-Monday — do not retune them here to make a frame pass.
    const hasTerrainEvidence =
        coverage >= 0.4 &&
        areaBelow > width * height * 0.03 &&
        densityBelow < densityAbove * 0.25;

    return { points, coverage, hasTerrainEvidence };
}
