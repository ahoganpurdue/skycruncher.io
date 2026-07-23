/**
 * SYNTHETIC DARK PRODUCER — cross-frame per-native-pixel FPN model + validation
 * metrics (src/engine/pipeline/m8_photometry/synth_dark.ts). Unit coverage for
 * the PURE pieces the thin recon driver (tools/calib/synth_dark.mjs) is now a
 * driver over:
 *   • isSynthDarkProducerEnabled() — call-time env read, DEFAULT OFF (CELL① style).
 *   • combineNativeMedian() — the FPN producer (per-index cross-frame median).
 *   • medianSorted / madSigma / sampleStride / percentileStrided — robust stats.
 *   • pearsonBiasSubtracted / hotPixelRecallPrecision / residualSigmaRatio /
 *     starSuppressionFraction — the four validation metrics.
 *   • evaluateSynthDark() — the single call the driver uses.
 *
 * This seam is a DEFAULT-OFF producer with NO hot-path consumer, so the pipeline
 * is byte-identical either way; these tests pin the producer math, not a solve.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    isSynthDarkProducerEnabled,
    combineNativeMedian,
    medianSorted,
    madSigma,
    sampleStride,
    sampleStrideF64,
    percentileStrided,
    pearsonBiasSubtracted,
    hotPixelRecallPrecision,
    residualSigmaRatio,
    starSuppressionFraction,
    evaluateSynthDark,
} from '../pipeline/m8_photometry/synth_dark';

afterEach(() => { vi.unstubAllEnvs(); });

describe('isSynthDarkProducerEnabled — call-time flag read, DEFAULT OFF', () => {
    it('is FALSE by default (unset env — producer seam inert by construction)', () => {
        expect(isSynthDarkProducerEnabled()).toBe(false);
    });
    it("is TRUE only for the explicit opt-in values '1' and 'true'", () => {
        vi.stubEnv('VITE_SYNTH_DARK_PRODUCER', '1');
        expect(isSynthDarkProducerEnabled()).toBe(true);
        vi.stubEnv('VITE_SYNTH_DARK_PRODUCER', 'true');
        expect(isSynthDarkProducerEnabled()).toBe(true);
        vi.stubEnv('VITE_SYNTH_DARK_PRODUCER', '0');
        expect(isSynthDarkProducerEnabled()).toBe(false);
        vi.stubEnv('VITE_SYNTH_DARK_PRODUCER', 'false');
        expect(isSynthDarkProducerEnabled()).toBe(false);
        vi.stubEnv('VITE_SYNTH_DARK_PRODUCER', 'yes');
        expect(isSynthDarkProducerEnabled()).toBe(false);
    });
});

describe('combineNativeMedian — the FPN producer (per-index cross-frame median)', () => {
    const f = (...v: number[]) => Float32Array.from(v);

    it('odd N ⇒ the exact middle value per pixel', () => {
        const out = combineNativeMedian([f(1, 2, 3), f(10, 20, 30), f(100, 200, 300)]);
        expect(Array.from(out)).toEqual([10, 20, 30]);
    });

    it('even N ⇒ the average of the two middles (driver parity)', () => {
        const out = combineNativeMedian([f(1, 2, 3), f(10, 20, 30)]);
        expect(Array.from(out)).toEqual([5.5, 11, 16.5]);
    });

    it('N=1 is a fresh copy (no cross-frame structure to reject) — a HONEST no-op', () => {
        const src = f(7, 8, 9);
        const out = combineNativeMedian([src]);
        expect(Array.from(out)).toEqual([7, 8, 9]);
        out[0] = 999;
        expect(src[0]).toBe(7); // independent buffer
    });

    it('N=0 ⇒ empty plane', () => {
        expect(combineNativeMedian([]).length).toBe(0);
    });

    it('rejects a MOVING sky spike while keeping the pixel-locked FPN base', () => {
        // base FPN = 10 everywhere; each frame has a 1000-ADU "sky" spike at a
        // DIFFERENT single pixel. The cross-frame median rejects the moving spike.
        const base = [10, 10, 10, 10];
        const mk = (spikeAt: number) => Float32Array.from(base.map((b, i) => (i === spikeAt ? 1000 : b)));
        const out = combineNativeMedian([mk(0), mk(1), mk(2)]);
        expect(Array.from(out)).toEqual([10, 10, 10, 10]); // FPN preserved, sky gone
    });
});

describe('robust stats — driver-parity ports', () => {
    it('medianSorted returns the upper-middle after an ascending sort', () => {
        expect(medianSorted([3, 1, 2])).toBe(2);
        expect(medianSorted([2, 4, 1, 3])).toBe(3); // v[4>>1]=v[2] of [1,2,3,4]
        expect(Number.isNaN(medianSorted([]))).toBe(true);
    });

    it('madSigma = 1.4826 × median|x−med|', () => {
        // [1,2,3,4,5] med 3 ⇒ dev [2,1,0,1,2] sorted [0,1,1,2,2], dev[2]=1
        expect(madSigma([1, 2, 3, 4, 5], 3)).toBeCloseTo(1.4826, 10);
        expect(madSigma([], 0)).toBe(0);
    });

    it('sampleStride / sampleStrideF64 pick finite elements at the stride', () => {
        expect(sampleStride([0, 9, 2, 9, 4], 2)).toEqual([0, 2, 4]); // idx 0,2,4
        expect(sampleStride([0, 9, NaN, 9, 4], 2)).toEqual([0, 4]);  // NaN at 2 skipped
        expect(Array.from(sampleStrideF64([5, 9, 6, 9, 7], 2))).toEqual([5, 6, 7]);
    });

    it('percentileStrided ranks a stride-31 subsample', () => {
        // length 93 ⇒ subsample idx 0,31,62. Put 5,1,9 there.
        const a = new Float32Array(93);
        a[0] = 5; a[31] = 1; a[62] = 9;
        expect(percentileStrided(a, 0.5)).toBe(5);    // sorted [1,5,9], s[floor(3·0.5)]=s[1]=5
        expect(percentileStrided(a, 0.999)).toBe(9);  // s[floor(3·0.999)]=s[2]=9
    });
});

describe('pearsonBiasSubtracted — offset/scale-invariant correlation', () => {
    const ramp = (n: number, fn: (i: number) => number) =>
        Float32Array.from({ length: n }, (_, i) => fn(i));

    it('identical maps ⇒ r = 1', () => {
        const s = ramp(200, i => i);
        expect(pearsonBiasSubtracted(s, s).r).toBeCloseTo(1, 10);
    });

    it('is invariant to a positive affine transform of one map (r stays 1)', () => {
        const s = ramp(200, i => i);
        const r = ramp(200, i => 2 * i + 5);
        expect(pearsonBiasSubtracted(s, r).r).toBeCloseTo(1, 10);
    });

    it('anti-correlated maps ⇒ r = −1', () => {
        const s = ramp(200, i => i);
        const r = ramp(200, i => 199 - i);
        expect(pearsonBiasSubtracted(s, r).r).toBeCloseTo(-1, 10);
    });
});

describe('hotPixelRecallPrecision — rank-based top-tail agreement', () => {
    it('identical maps ⇒ recall = precision = 1 (same threshold, same hot set)', () => {
        const a = Float32Array.from({ length: 300 }, (_, i) => i);
        const r = hotPixelRecallPrecision(a, a);
        expect(r.recall).toBe(1);
        expect(r.precision).toBe(1);
        expect(r.truePositive).toBe(r.realHotCount);
    });
});

describe('residualSigmaRatio — held-out residual spread synth/real', () => {
    it('a tighter synth residual ⇒ ratio < 1 (computed exactly on the subsample)', () => {
        // length 200 ⇒ stride-97 subsample idx 0,97,194 (i%3 = 0,1,2).
        // resSynth = i%3 → subsample [0,1,2]; resReal = 10·(i%3) → [0,10,20].
        const holdout = Float32Array.from({ length: 200 }, () => 1000);
        const synth = Float32Array.from({ length: 200 }, (_, i) => 1000 - (i % 3));
        const real = Float32Array.from({ length: 200 }, (_, i) => 1000 - 10 * (i % 3));
        const res = residualSigmaRatio(holdout, synth, real, 1);
        expect(res.sigmaResidualSynth).toBeCloseTo(1.4826, 6);   // MAD of [0,1,2] about 1
        expect(res.sigmaResidualReal).toBeCloseTo(14.826, 4);    // MAD of [0,10,20] about 10
        expect(res.ratioSynthOverReal).toBeCloseTo(0.1, 6);
    });
});

describe('starSuppressionFraction — bright-tail excess of synth vs real', () => {
    const real = Float32Array.from({ length: 300 }, (_, i) => i);

    it('synth == real ⇒ no contamination', () => {
        const r = starSuppressionFraction(real, real, 147, 147, 1, 1);
        expect(r.contaminatedPixels).toBe(0);
        expect(r.contaminatedFraction).toBe(0);
    });

    it('a single huge synth excess ⇒ exactly one contaminated pixel', () => {
        const synth = Float32Array.from(real);
        synth[5] += 10000;
        const r = starSuppressionFraction(synth, real, 147, 147, 1, 1);
        expect(r.contaminatedPixels).toBe(1);
        expect(r.contaminatedFraction).toBeCloseTo(1 / 300, 10);
    });
});

describe('evaluateSynthDark — the single call the thin driver uses', () => {
    const synth = Float32Array.from({ length: 200 }, (_, i) => i);
    const real = Float32Array.from({ length: 200 }, (_, i) => i);

    it('residual is null when no held-out light is supplied', () => {
        const m = evaluateSynthDark(synth, real, null, 1);
        expect(m.residual).toBeNull();
        expect(m.pearson.r).toBeCloseTo(1, 10);
        expect(m.hotpixel.recall).toBe(1);
        expect(m.starSuppression.contaminatedPixels).toBe(0);
    });

    it('residual is populated when a held-out light is supplied', () => {
        const holdout = Float32Array.from({ length: 200 }, () => 1000);
        const m = evaluateSynthDark(synth, real, holdout, 1);
        expect(m.residual).not.toBeNull();
        expect(m.residual!.ratioSynthOverReal).toBeGreaterThanOrEqual(0);
    });
});
