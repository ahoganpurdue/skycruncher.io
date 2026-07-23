// Frozen tests for the signed-diverging RENDER-plane renderer (row-545 item 3).
// Proves the one thing the STF cannot do: preserve the SIGN of a detail layer so
// over-subtraction is visible instead of clamped to black.
import { describe, it, expect } from 'vitest';
import {
    robustSymmetricScale,
    signedDivergingRgba,
    subtractionDamageRgba,
    medianOf,
} from './signed_render.mjs';

const px = (rgba, i) => ({ r: rgba[i * 4], g: rgba[i * 4 + 1], b: rgba[i * 4 + 2], a: rgba[i * 4 + 3] });

describe('signed_render — robustSymmetricScale', () => {
    it('is the pct-th percentile of |v − center| over finite entries', () => {
        const a = new Float32Array([-10, -1, 0, 1, 2, 3, 100]);
        // |v|: [10,1,0,1,2,3,100] sorted [0,1,1,2,3,10,100]; pct=0.5 → idx floor(7*0.5)=3 → 2
        expect(robustSymmetricScale(a, 0.5)).toBe(2);
        // center shifts the reference point
        expect(robustSymmetricScale(new Float32Array([4, 5, 6]), 0.5, 5)).toBe(1);
    });
    it('returns 0 when there is no finite signal (honest, not NaN)', () => {
        expect(robustSymmetricScale(new Float32Array([NaN, Infinity]), 0.9)).toBe(0);
    });
});

describe('signed_render — signedDivergingRgba (black style)', () => {
    const mono = new Float32Array([-1, 0, 1]);
    const { rgba, scale } = signedDivergingRgba(mono, 3, 1, { scale: 1 });

    it('honors an explicit scale', () => { expect(scale).toBe(1); });

    it('maps negative → blue-dominant, positive → red-dominant, zero → dark', () => {
        const neg = px(rgba, 0), zero = px(rgba, 1), pos = px(rgba, 2);
        expect(neg.b).toBeGreaterThan(neg.r);   // −1 renders blue
        expect(pos.r).toBeGreaterThan(pos.b);   // +1 renders red
        expect(zero.r).toBeLessThan(30);        // 0 stays dark (NOT clamped-black-invisible: lit only by sign)
        expect(zero.b).toBeLessThan(45);
        expect(zero.a).toBe(255);
    });

    it('intensity is monotone in magnitude (brighter hue = larger |value|)', () => {
        const r = signedDivergingRgba(new Float32Array([0.25, 1, -0.25, -1]), 4, 1, { scale: 1 });
        expect(px(r.rgba, 1).r).toBeGreaterThan(px(r.rgba, 0).r); // +1 redder than +0.25
        expect(px(r.rgba, 3).b).toBeGreaterThan(px(r.rgba, 2).b); // −1 bluer than −0.25
    });

    it('robust-normalizes to the pct percentile when no scale is given', () => {
        const big = new Float32Array([0, 0, 0, 5]);
        const r = signedDivergingRgba(big, 4, 1, { pct: 0.5 });
        expect(r.scale).toBeGreaterThan(0); // finite, derived from |v| percentile
    });
});

describe('signed_render — white style centers on white', () => {
    it('zero → white, extremes → saturated blue/red', () => {
        const { rgba } = signedDivergingRgba(new Float32Array([-1, 0, 1]), 3, 1, { scale: 1, style: 'white' });
        const zero = px(rgba, 1);
        expect(zero.r).toBe(255); expect(zero.g).toBe(255); expect(zero.b).toBe(255);
        expect(px(rgba, 0).b).toBe(255); // −1 → blue
        expect(px(rgba, 2).r).toBe(255); // +1 → red
    });
});

describe('signed_render — subtractionDamageRgba centers on the background pedestal', () => {
    it('pixels below the pedestal (craters) render blue, above render red', () => {
        // a "subtracted" frame sitting near pedestal 10, with one crater and one peak
        const sub = new Float32Array([10, 10, 10, 4, 16]);
        const { rgba, pedestal, scale } = subtractionDamageRgba(sub, 5, 1);
        expect(pedestal).toBe(10);          // background median
        expect(scale).toBeGreaterThan(0);
        expect(px(rgba, 3).b).toBeGreaterThan(px(rgba, 3).r); // crater (4 < 10) → blue
        expect(px(rgba, 4).r).toBeGreaterThan(px(rgba, 4).b); // peak (16 > 10) → red
    });
    it('medianOf is an honest background estimate', () => {
        expect(medianOf(new Float32Array([1, 2, 3, 4, 100]))).toBe(3);
    });
});
