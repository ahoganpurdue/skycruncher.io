/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SYNTHETIC DARK / BIAS PRODUCER — cross-frame per-native-pixel FPN model
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL (native sensor grid; no coordinate math lives here).
 *
 * WHAT IT PRODUCES: a synthetic bias/dark frame estimate from N same-camera
 * LIGHT frames. The sky (dithered/rotated between subs) sits at a DIFFERENT
 * sensor pixel per frame → the per-native-pixel cross-frame median rejects it.
 * FPN + dark current + hot pixels + amp glow are PIXEL-LOCKED to the sensor →
 * survive as the estimate. "Register the sky OUT" = reject the moving sky via
 * the median; keep the sensor-fixed pattern.
 *
 * TWO-LEDGER LAW (owner): a dark lives in the PIXEL ledger on the NATIVE grid.
 * We therefore DO NOT register-to-sky or resample — aligning the sky would MOVE
 * the sensor pattern and destroy exactly what we want to keep. No WCS, no warp,
 * no calibrated constant is authored in this module.
 *
 * LAW 2 (no calibration decision baked in): this producer emits a MEASURED
 * estimate + diagnostic metrics. It applies NOTHING and moves no threshold. The
 * research success/kill BARS live in the tools-lane driver (presentation), never
 * as gate constants here.
 *
 * LAW 7 (Memory Boundary Layout): NONE of the enumerated binary boundaries are
 * touched. This module consumes ALREADY-DECODED native gray Float32 planes and
 * returns a same-shape Float32 plane — no decode stride/indexing/units change,
 * so no `src/engine/contracts/binary_layouts.ts` entry moves.
 *
 * INCUBATOR PORT (LAW 4): the authoritative math for the synthetic-dark FPN
 * combine + its validation metrics now lives HERE, once. The recon driver
 * `tools/calib/synth_dark.mjs` is a THIN CLI over this module (decode + IO +
 * verdict presentation) — Node type-strips the `.ts` import at call time. This
 * replaces the over-claiming `BackgroundExtractionEngine` shell (dummy dark/flat
 * hooks, zero live callers) that formerly sat in this directory.
 *
 * SEAM STATUS (honest-or-absent): this is a PRODUCER seam behind a DEFAULT-OFF
 * flag. It is NOT wired into any hot-path consumer — nothing in the default
 * pipeline calls it, so the pipeline is byte-identical whether the flag is on or
 * off. Default APPLICATION of a synthetic dark to the science frames is a future
 * owner rebaseline-bundle decision (the CELL① precedent, rawler_decoder.ts row
 * 546): the switch exists so that wiring, when it lands, is one flag flip and a
 * documented rebaseline — never a silent default.
 */

// ─── flag ──────────────────────────────────────────────────────────────────

/**
 * DEFAULT-OFF synthetic-dark PRODUCER flag, read at CALL time (never cached at
 * module load, so an A/B harness can toggle per-run). Browser: vite env
 * exposure (`import.meta.env`). Node: `process.env` fallback. Mirrors the CELL①
 * `isDecodeApplyBlackLevelEnabled` precedent exactly.
 *
 * OFF (the default) ⇒ no consumer exists and the pipeline is byte-identical.
 * ON is meaningful only once a consumer is wired behind it (future rebaseline
 * bundle); today it is the explicit opt-in switch for that future application.
 * Any read error → false (the honest default arm produces/consumes nothing).
 */
export function isSynthDarkProducerEnabled(): boolean {
    try {
        const env = (import.meta as { env?: Record<string, string | undefined> }).env;
        let v = env?.VITE_SYNTH_DARK_PRODUCER;
        if (v === undefined && typeof process !== 'undefined') {
            v = process.env?.VITE_SYNTH_DARK_PRODUCER;
        }
        return v === '1' || v === 'true';
    } catch {
        return false;
    }
}

// ─── the producer: cross-frame per-native-pixel median FPN estimate ──────────

/**
 * THE FPN PRODUCER — per-index cross-frame median over N same-shape native gray
 * planes. Odd N → the exact middle; even N → the average of the two middles
 * (matches the recon driver's `tiledMedian` inner combine byte-for-byte, so the
 * CLI can call this per streamed disk band and reproduce its result unchanged).
 *
 * Pure + allocation-bounded (one length-N scratch column). Returns an empty
 * plane when given no frames, and a fresh copy when given exactly one (honest
 * no-op: a single frame has no cross-frame structure to reject).
 *
 * @param planes N Float32 planes, each length = npix (native sensor pixels).
 *               Every plane MUST share the same length; the caller enforces dims.
 */
export function combineNativeMedian(planes: readonly Float32Array[]): Float32Array {
    const nF = planes.length;
    if (nF === 0) return new Float32Array(0);
    const npix = planes[0].length;
    if (nF === 1) return new Float32Array(planes[0]);
    const out = new Float32Array(npix);
    const col = new Float64Array(nF);
    const half = nF >> 1;
    const odd = (nF & 1) === 1;
    for (let p = 0; p < npix; p++) {
        for (let fi = 0; fi < nF; fi++) col[fi] = planes[fi][p];
        col.sort();
        out[p] = odd ? col[half] : 0.5 * (col[half - 1] + col[half]);
    }
    return out;
}

// ─── pure statistics (exact ports of the recon driver's robust helpers) ──────

/** Lower-median of the middle element after an ascending sort (driver parity). */
export function medianSorted(a: ArrayLike<number>): number {
    const v = Float64Array.from(a as ArrayLike<number>).sort();
    return v.length ? v[v.length >> 1] : NaN;
}

/** MAD → sigma (1.4826 × median|x−med|); 0 on an empty input (driver parity). */
export function madSigma(arr: ArrayLike<number>, med: number): number {
    const n = (arr as ArrayLike<number>).length;
    const dev = new Float64Array(n);
    for (let i = 0; i < n; i++) dev[i] = Math.abs(arr[i] - med);
    dev.sort();
    return 1.4826 * (dev[n >> 1] || 0);
}

/** Finite-only strided subsample as a plain array (driver `sample`). */
export function sampleStride(arr: ArrayLike<number>, stride: number): number[] {
    const o: number[] = [];
    for (let i = 0; i < arr.length; i += stride) if (Number.isFinite(arr[i])) o.push(arr[i]);
    return o;
}

/** Finite-only strided subsample as a Float64Array (driver `sampleArr`). */
export function sampleStrideF64(arr: ArrayLike<number>, stride: number): Float64Array {
    return Float64Array.from(sampleStride(arr, stride));
}

/** Rank percentile over a stride-31 finite subsample (driver `percentile`). */
export function percentileStrided(arr: ArrayLike<number>, p: number): number {
    const s = sampleStrideF64(arr, 31).sort();
    return s[Math.floor(s.length * p)] ?? Infinity;
}

// ─── validation metrics (the driver's four checks, single-sourced) ───────────

export interface PearsonResult {
    /** Bias-subtracted Pearson r of synth vs real (exposure/scale/offset robust). */
    r: number;
    /** Spatial-median pedestals subtracted (reused by star-suppression). */
    medSynth: number;
    medReal: number;
}

/**
 * METRIC 1 — per-pixel Pearson r on the bias-subtracted pattern. Pearson r is
 * invariant to per-map linear scale + offset, so exposure/bias mismatch does not
 * bias it; each map's spatial median (stride-97 subsample) is still subtracted
 * explicitly. Exact port of the driver's metric 1.
 */
export function pearsonBiasSubtracted(
    synth: Float32Array, real: Float32Array, stride = 97,
): PearsonResult {
    const medSynth = medianSorted(sampleStride(synth, stride));
    const medReal = medianSorted(sampleStride(real, stride));
    const npix = Math.min(synth.length, real.length);
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
    for (let i = 0; i < npix; i++) {
        const a = synth[i] - medSynth, b = real[i] - medReal;
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b; n++;
    }
    const cov = sxy / n - (sx / n) * (sy / n);
    const vx = sxx / n - (sx / n) ** 2, vy = syy / n - (sy / n) ** 2;
    return { r: cov / Math.sqrt(vx * vy), medSynth, medReal };
}

export interface HotPixelResult {
    percentile: number;
    realHotCount: number;
    synthHotCount: number;
    truePositive: number;
    recall: number;
    precision: number;
}

/**
 * METRIC 2 — hot-pixel recall/precision on rank-based top-tail sets (default top
 * 0.1%). Rank-based ⇒ absolute level/exposure does not matter. Truth = real
 * master, test = synth. Exact port of the driver's metric 2.
 */
export function hotPixelRecallPrecision(
    synth: Float32Array, real: Float32Array, pctl = 0.999,
): HotPixelResult {
    const npix = Math.min(synth.length, real.length);
    const realThr = percentileStrided(real, pctl);
    const synthThr = percentileStrided(synth, pctl);
    const realHot = new Set<number>();
    const synthHot = new Set<number>();
    for (let i = 0; i < npix; i++) {
        if (real[i] >= realThr) realHot.add(i);
        if (synth[i] >= synthThr) synthHot.add(i);
    }
    let tp = 0;
    for (const i of synthHot) if (realHot.has(i)) tp++;
    return {
        percentile: pctl,
        realHotCount: realHot.size,
        synthHotCount: synthHot.size,
        truePositive: tp,
        precision: synthHot.size ? tp / synthHot.size : 0,
        recall: realHot.size ? tp / realHot.size : 0,
    };
}

export interface ResidualResult {
    sigmaResidualSynth: number;
    sigmaResidualReal: number;
    ratioSynthOverReal: number;
}

/**
 * METRIC 3 — held-out light residual sigma ratio. Subtract the synth dark vs the
 * (exposure-scaled) real master from a held-out light; compare background
 * residual sigma. Exposure-sensitive (the driver down-weights it when exposure
 * classes mismatch). `realScale` scales the real master to the light exposure
 * (1 when exposure-matched). Exact port of the driver's metric 3.
 */
export function residualSigmaRatio(
    holdout: Float32Array, synth: Float32Array, real: Float32Array,
    realScale: number, stride = 97,
): ResidualResult {
    const npix = Math.min(holdout.length, synth.length, real.length);
    const resSynth = new Float64Array(npix);
    const resReal = new Float64Array(npix);
    for (let i = 0; i < npix; i++) {
        resSynth[i] = holdout[i] - synth[i];
        resReal[i] = holdout[i] - real[i] * realScale;
    }
    const mS = medianSorted(sampleStride(resSynth, stride));
    const mR = medianSorted(sampleStride(resReal, stride));
    const sigSynth = madSigma(sampleStrideF64(resSynth, stride), mS);
    const sigReal = madSigma(sampleStrideF64(resReal, stride), mR);
    return {
        sigmaResidualSynth: sigSynth,
        sigmaResidualReal: sigReal,
        ratioSynthOverReal: sigSynth / sigReal,
    };
}

export interface StarSuppressionResult {
    kSigma: number;
    contaminatedPixels: number;
    contaminatedFraction: number;
}

/**
 * STAR-SUPPRESSION contamination — fraction of synth-dark pixels whose
 * (bias-subtracted, exposure-normalized) value exceeds the real master by
 * > k·sigma_real: residual sky/star flux that failed to decorrelate. On a bright
 * nebula target this is the top kill-risk metric. Exact port of the driver.
 *
 * `medSynth`/`medReal` are the spatial-median pedestals (from {@link
 * pearsonBiasSubtracted}); `normScale` maps the real master to the light
 * exposure level. Self-contained otherwise (computes sigma_real internally over
 * the same stride-97 subsample the driver uses).
 */
export function starSuppressionFraction(
    synth: Float32Array, real: Float32Array,
    medSynth: number, medReal: number, normScale: number, k = 5, stride = 97,
): StarSuppressionResult {
    const npix = Math.min(synth.length, real.length);
    const realSig = madSigma(sampleStrideF64(real, stride), medReal);
    let contaminated = 0;
    for (let i = 0; i < npix; i++) {
        const s = synth[i] - medSynth;
        const r = (real[i] - medReal) * normScale;
        if (s - r > k * realSig * normScale) contaminated++;
    }
    return {
        kSigma: k,
        contaminatedPixels: contaminated,
        contaminatedFraction: npix ? contaminated / npix : 0,
    };
}

export interface SynthDarkMetrics {
    pearson: PearsonResult;
    hotpixel: HotPixelResult;
    /** null when no held-out light was supplied. */
    residual: ResidualResult | null;
    starSuppression: StarSuppressionResult;
}

/**
 * Evaluate the full validation battery for a synthetic dark against a real
 * master. Single call the thin CLI uses in place of its inlined metric code —
 * every number reproduces the recon driver exactly.
 *
 * @param synth     the synthetic dark (from {@link combineNativeMedian} of lights)
 * @param real      the real master dark (median of dedicated dark frames)
 * @param holdout   a held-out light for the residual test, or null to skip it
 * @param realScale exposure scale applied to the real master (light/dark ratio,
 *                  or 1 when exposure-matched)
 */
export function evaluateSynthDark(
    synth: Float32Array, real: Float32Array,
    holdout: Float32Array | null, realScale: number,
): SynthDarkMetrics {
    const pearson = pearsonBiasSubtracted(synth, real);
    const hotpixel = hotPixelRecallPrecision(synth, real);
    const residual = holdout ? residualSigmaRatio(holdout, synth, real, realScale) : null;
    const starSuppression = starSuppressionFraction(
        synth, real, pearson.medSynth, pearson.medReal, realScale,
    );
    return { pearson, hotpixel, residual, starSuppression };
}
