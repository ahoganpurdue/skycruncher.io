// Unit tests for the render-layer SIP undistort warp
// (ImageProcessor.applySipUndistort — src/engine/core/ImageProcessor.ts).
//
// This closes the previously-open render loop: SIP was fit + stored + badged
// but APPLIED TO NOTHING. The warp is PIXEL-ledger, render-only, the ONE warp
// per LAW 1. Two invariants proven here:
//   1. PROVABLE NO-OP when no SIP is present — the SAME array reference is
//      returned untouched (honest-or-absent; SeeStar has no SIP → byte-identical
//      render regardless of the RENDER_APPLY_SIP flag).
//   2. MEASURABLE, PREDICTABLE warp when a SIP is present — a constant-shift
//      polynomial samples the source at a known offset (exercises the exact
//      bilinear sampling path a real 2nd-order SIP polynomial uses).

import { describe, it, expect } from 'vitest';
import { ImageProcessor } from '../core/ImageProcessor';

// Interleaved RGB (w*h*3) horizontal ramp: value(x,y) = x on all 3 channels.
function makeRamp(w: number, h: number): Float32Array {
    const buf = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = (y * w + x) * 3;
            buf[idx] = x; buf[idx + 1] = x; buf[idx + 2] = x;
        }
    }
    return buf;
}

describe('ImageProcessor.applySipUndistort (render-layer SIP, LAW-1 single warp)', () => {
    const w = 8, h = 4;

    it('is a PROVABLE no-op when SIP is null — same reference, untouched', () => {
        const input = makeRamp(w, h);
        const out = ImageProcessor.applySipUndistort(input, w, h, null, 0, 0, 1);
        expect(out).toBe(input); // identical reference: no allocation, no resample
    });

    it('is a no-op when SIP is undefined', () => {
        const input = makeRamp(w, h);
        const out = ImageProcessor.applySipUndistort(input, w, h, undefined, 0, 0, 1);
        expect(out).toBe(input);
    });

    it('is a no-op when the SIP object lacks a/b matrices', () => {
        const input = makeRamp(w, h);
        // @ts-expect-error deliberately malformed SIP → must degrade to identity
        const out = ImageProcessor.applySipUndistort(input, w, h, {}, 0, 0, 1);
        expect(out).toBe(input);
    });

    it('applies a MEASURABLE, predictable warp when a SIP is present', () => {
        const input = makeRamp(w, h);
        // Constant +2px x-displacement: dx = A(u,v) = 2, dy = 0. Undistort samples
        // the source at (x+2, y). On a ramp (value=x) the output value becomes
        // clamp(x+2, 0, w-1). Integer offset → bilinear is exact.
        const sip = { a: [[2]], b: [[0]] };
        const out = ImageProcessor.applySipUndistort(input, w, h, sip, 0, 0, 1);

        // A fresh array was allocated (not the input reference).
        expect(out).not.toBe(input);

        // Interior pixel x=3 → sampled from source x=5 → value 5 (was 3).
        const px = (y: number, x: number) => out[(y * w + x) * 3];
        expect(px(1, 3)).toBeCloseTo(5, 6);
        expect(px(1, 3)).not.toBeCloseTo(3, 6); // genuinely moved

        // Right edge clamps (x+2 beyond w-1 → w-1 = 7).
        expect(px(2, 6)).toBeCloseTo(7, 6);
        expect(px(2, 7)).toBeCloseTo(7, 6);

        // The buffer as a whole differs from the input.
        let differs = false;
        for (let i = 0; i < input.length; i++) {
            if (Math.abs(out[i] - input[i]) > 1e-9) { differs = true; break; }
        }
        expect(differs).toBe(true);
    });

    it('honors coordScale: solve-space displacement maps to scaled buffer pixels', () => {
        const input = makeRamp(w, h);
        // Same constant solve-space displacement (2), but the buffer is 2× the
        // solve resolution (coordScale=2) → buffer displacement = 2*2 = 4px.
        const sip = { a: [[2]], b: [[0]] };
        const out = ImageProcessor.applySipUndistort(input, w, h, sip, 0, 0, 2);
        const px = (y: number, x: number) => out[(y * w + x) * 3];
        // x=1 → sampled from x + 2*2 = 5 → value 5.
        expect(px(1, 1)).toBeCloseTo(5, 6);
    });
});

// ── FAST-PATH NUMERICAL EQUIVALENCE (Math.pow → per-pixel power tables) ────────
// The 2026-07-10 perf change replaced the transcendental `Math.pow(u,p)` /
// `Math.pow(v,q)` term evaluation with per-pixel power tables built by repeated
// multiplication (kills the ~2.35 s @ 9.8 MP render-lane stall the color audit
// measured — `git show 0afe8c9`). Repeated multiplication is epsilon-equal, not
// bit-equal, to Math.pow for non-integer bases; these tests bound that error at
// two levels: (1) the pure poly evaluator at Float64 precision, and (2) the real
// ImageProcessor.applySipUndistort output vs a full Math.pow reference warp.
describe('applySipUndistort — power-table poly ≡ Math.pow reference', () => {
    const w = 64, h = 48;
    const s = 0.667; // CR2-preview-like coordScale (solve px → preview px)
    const crpixX = w / 2, crpixY = h / 2;

    // Realistic deg-3 SIP: every (p,q) in the triangle is exercised, coefficients
    // small enough that the net displacement stays sub-pixel (source in-bounds).
    const sip = {
        a: [[0, 1e-6, 2e-9, 1e-12], [3e-6, 1e-9, 2e-12], [4e-9, 5e-12], [6e-12]],
        b: [[0, 2e-6, 1e-9, 3e-12], [1e-6, 3e-9, 1e-12], [2e-9, 4e-12], [5e-12]],
    };

    // REFERENCE poly — verbatim the pre-2026-07-10 Math.pow arithmetic.
    const polyRef = (coeff: number[][], u: number, v: number): number => {
        let acc = 0;
        for (let p = 0; p < coeff.length; p++) {
            const row = coeff[p]; if (!row) continue;
            const up = Math.pow(u, p);
            for (let q = 0; q < row.length; q++) {
                const c = row[q]; if (c) acc += c * up * Math.pow(v, q);
            }
        }
        return acc;
    };

    // FAST poly — verbatim the shipped per-pixel power-table arithmetic
    // (src/engine/core/ImageProcessor.ts). Standalone copy: production's poly is
    // a private closure; test (2) below anchors this copy to the real code path.
    const polyFast = (coeff: number[][], u: number, v: number): number => {
        let degV = 0;
        for (const r of coeff) if (r && r.length > degV) degV = r.length;
        const upow = new Float64Array(Math.max(1, coeff.length));
        const vpow = new Float64Array(Math.max(1, degV));
        upow[0] = 1; for (let p = 1; p < upow.length; p++) upow[p] = upow[p - 1] * u;
        vpow[0] = 1; for (let q = 1; q < vpow.length; q++) vpow[q] = vpow[q - 1] * v;
        let acc = 0;
        for (let p = 0; p < coeff.length; p++) {
            const row = coeff[p]; if (!row) continue;
            const up = upow[p];
            for (let q = 0; q < row.length; q++) { const c = row[q]; if (c) acc += c * up * vpow[q]; }
        }
        return acc;
    };

    // (1) Pure evaluator equivalence at FULL Float64 precision (no Float32 store
    // to mask it). Non-integer (u,v) — where Math.pow and repeated multiplication
    // actually diverge in the last ulps — over the plate's real coordinate range.
    it('poly evaluator: power-table ≡ Math.pow to <1e-12 relative (Float64)', () => {
        let maxRel = 0, checked = 0, diverged = 0;
        for (let vi = -35.5; vi <= 35.5; vi += 1.37) {
            for (let ui = -48.5; ui <= 48.5; ui += 1.37) {
                const us = ui / s, vs = vi / s; // fractional → Math.pow ≠ repeated mult
                for (const coeff of [sip.a, sip.b]) {
                    const ref = polyRef(coeff, us, vs);
                    const fast = polyFast(coeff, us, vs);
                    if (ref !== fast) diverged++;                 // proves it's NOT trivially bit-equal
                    if (ref !== 0) maxRel = Math.max(maxRel, Math.abs(fast - ref) / Math.abs(ref));
                    checked++;
                }
            }
        }
        expect(checked).toBeGreaterThan(2000);
        expect(diverged).toBeGreaterThan(0);   // last-ulp divergence genuinely occurs
        expect(maxRel).toBeLessThan(1e-12);     // …but is bounded well under 1e-12 relative
    });

    // (2) The REAL production warp vs a full Math.pow reference warp (identical
    // bilinear + Float32 store). The poly delta (~1e-16 rel) is far below the
    // Float32 ULP, so the rendered pixels round identically — the production fast
    // path produces byte-identical preview output to the Math.pow evaluator.
    function referenceWarp(f: Float32Array): Float32Array {
        const out = new Float32Array(w * h * 3);
        for (let yo = 0; yo < h; yo++) for (let xo = 0; xo < w; xo++) {
            const us = (xo - crpixX) / s, vs = (yo - crpixY) / s;
            const srcX = xo + s * polyRef(sip.a, us, vs), srcY = yo + s * polyRef(sip.b, us, vs);
            const dIdx = (yo * w + xo) * 3;
            const x0 = Math.floor(srcX), y0 = Math.floor(srcY);
            const fx = srcX - x0, fy = srcY - y0;
            const cx0 = Math.min(Math.max(x0, 0), w - 1), cx1 = Math.min(Math.max(x0 + 1, 0), w - 1);
            const cy0 = Math.min(Math.max(y0, 0), h - 1), cy1 = Math.min(Math.max(y0 + 1, 0), h - 1);
            for (let c = 0; c < 3; c++) {
                const p00 = f[(cy0 * w + cx0) * 3 + c] || 0, p10 = f[(cy0 * w + cx1) * 3 + c] || 0;
                const p01 = f[(cy1 * w + cx0) * 3 + c] || 0, p11 = f[(cy1 * w + cx1) * 3 + c] || 0;
                const top = p00 + (p10 - p00) * fx, bot = p01 + (p11 - p01) * fx;
                out[dIdx + c] = top + (bot - top) * fy;
            }
        }
        return out;
    }

    it('production warp output is byte-identical to a Math.pow reference warp', () => {
        // Realistic source (sparse bright stars on a low sky) — the render buffer's
        // actual character, and enough gradient to expose any real divergence.
        const input = new Float32Array(w * h * 3);
        let seed = 7 >>> 0; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
        for (let i = 0; i < w * h; i++) { const n = 0.007 + rnd() * 0.004; input[i * 3] = n; input[i * 3 + 1] = n + 0.001; input[i * 3 + 2] = n + 0.002; }
        for (let k = 0; k < (w * h) / 40; k++) { const px = Math.floor(rnd() * w * h); const pk = 0.3 + rnd() * 0.6; input[px * 3] = pk; input[px * 3 + 1] = pk; input[px * 3 + 2] = pk; }

        const out = ImageProcessor.applySipUndistort(input, w, h, sip, crpixX, crpixY, s);
        const ref = referenceWarp(input);
        let maxAbs = 0, differsFromInput = false;
        for (let i = 0; i < out.length; i++) {
            maxAbs = Math.max(maxAbs, Math.abs(out[i] - ref[i]));
            if (Math.abs(out[i] - input[i]) > 1e-6) differsFromInput = true;
        }
        expect(differsFromInput).toBe(true); // the SIP genuinely warps (not a no-op)
        expect(maxAbs).toBe(0);              // rendered pixels are byte-identical to Math.pow
    });
});
