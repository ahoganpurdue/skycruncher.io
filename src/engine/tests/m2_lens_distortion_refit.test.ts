// Unit tests for the MEASURED per-capture Brown-Conrady refit fit-core
// (src/engine/pipeline/m2_hardware/lens_distortion_refit.ts) — NEXT_MOVES §8
// deferred "per-copy refit from real matched pairs", now ported into the engine.
//
// These exercise the PURE fit core (`fitBrownConrady`) with SYNTHETIC pairs, so
// there is no wasm/atlas/IO dependency and the proofs are deterministic:
//   1. RECOVERY — a field warped by a KNOWN k1/k2 is recovered to those exact
//      coefficients (and the fit RMS collapses vs the lens-free baseline).
//   2. COVERAGE GATE — a central-only sample REFUSES the quintic k2 term
//      (honest-absent, not a laundered guess).
//   3. HONEST-ABSENT — too few pairs → `not_measured` set, coefficients null.
// The adapter (projection from a real solve via the wasm gnomonic path) and the
// end-to-end edge-star densification are measured through the real CR2 A/B.

import { describe, it, expect } from 'vitest';
import { fitBrownConrady, type DistortionPair } from '../pipeline/m2_hardware/lens_distortion_refit';
import { makeBrownConradyDistortion } from '../pipeline/m2_hardware/lens_distortion';

// Representative full-frame DSLR geometry (close to the bundled CR2 dims).
const W = 5202;
const H = 3465;
const CX = (W - 1) / 2;
const CY = (H - 1) / 2;
const HD = Math.hypot(CX, CY);
const INV_HD = 1 / HD;

/**
 * Build synthetic Brown-Conrady pairs: lay undistorted catalog positions on a
 * grid, warp each to its "detected" native position with a KNOWN forward model
 * (the verified lens_distortion.toNative), then form the normalized displacement
 * pairs the fitter consumes. `region` clips the grid to test coverage gating.
 */
function syntheticPairs(
    k1: number,
    k2: number,
    opts: { stepX?: number; stepY?: number; maxRadiusFrac?: number } = {},
): DistortionPair[] {
    const stepX = opts.stepX ?? 190;
    const stepY = opts.stepY ?? 150;
    const maxR = opts.maxRadiusFrac ?? Infinity;
    const warp = makeBrownConradyDistortion(k1, k2, W, H);
    const out: [number, number] = [0, 0];
    const pairs: DistortionPair[] = [];
    for (let uy = 80; uy < H - 80; uy += stepY) {
        for (let ux = 80; ux < W - 80; ux += stepX) {
            const xn = (ux - CX) * INV_HD;
            const yn = (uy - CY) * INV_HD;
            const ru = Math.hypot(xn, yn);
            if (ru > maxR) continue;
            warp.toNative(ux, uy, out); // detected (native/distorted)
            pairs.push({
                xn, yn,
                dx: (out[0] - ux) * INV_HD,
                dy: (out[1] - uy) * INV_HD,
                ru,
                w: 1,
            });
        }
    }
    return pairs;
}

describe('fitBrownConrady — recovers a KNOWN synthetic distortion', () => {
    it('recovers k1/k2 to high precision and collapses the fit RMS vs baseline', () => {
        const K1 = -0.12; // ROKINON_14 "mustache" barrel
        const K2 = 0.05;
        const pairs = syntheticPairs(K1, K2);
        expect(pairs.length).toBeGreaterThan(200); // dense, full-frame coverage

        const r = fitBrownConrady(pairs, [CX, CY], HD);
        expect(r.provenance).toBe('MEASURED');
        expect(r.not_measured).toBeUndefined();
        expect(r.terms).toContain('k1');
        expect(r.terms).toContain('k2'); // full corner coverage admits the quintic
        expect(r.coverage_refused.k2).toBe(false);

        // Coefficients recovered (noise-free → tight tolerance).
        expect(r.k1).toBeCloseTo(K1, 3);
        expect(r.k2).not.toBeNull();
        expect(r.k2!).toBeCloseTo(K2, 3);

        // The whole point: the lens terms explain the warp — fit RMS collapses to
        // ~0 while the lens-free baseline (absorbers only) is left with the full
        // (hundreds-of-px at the corner) distortion signal.
        expect(r.rms_2d_px).toBeLessThan(0.05);
        expect(r.baseline_rms_2d_px).not.toBeNull();
        expect(r.baseline_rms_2d_px!).toBeGreaterThan(20);
        expect(r.baseline_rms_2d_px!).toBeGreaterThan(r.rms_2d_px * 100);
    });

    it('reports ~zero coefficients for an undistorted (identity) field', () => {
        const pairs = syntheticPairs(0, 0);
        const r = fitBrownConrady(pairs, [CX, CY], HD);
        expect(r.not_measured).toBeUndefined();
        expect(Math.abs(r.k1)).toBeLessThan(1e-4);
        expect(Math.abs(r.k2 ?? 0)).toBeLessThan(1e-4);
        expect(r.rms_2d_px).toBeLessThan(0.05);
    });
});

describe('fitBrownConrady — coverage discipline (honest-absent, not laundered)', () => {
    it('REFUSES the quintic k2 term when the sample is central-only', () => {
        // Clip to the inner half-radius: rMax < 0.8 → k2 gate must refuse.
        const pairs = syntheticPairs(-0.12, 0.05, { stepX: 90, stepY: 80, maxRadiusFrac: 0.5 });
        expect(pairs.length).toBeGreaterThan(50);
        const rMax = Math.max(...pairs.map(p => p.ru));
        expect(rMax).toBeLessThan(0.8);

        const r = fitBrownConrady(pairs, [CX, CY], HD);
        expect(r.terms).toContain('k1');
        expect(r.terms).not.toContain('k2');
        expect(r.coverage_refused.k2).toBe(true);
        expect(r.k2).toBeNull();              // NOT fabricated
        expect(r.mustache.verdict).toBe('UNDETERMINED'); // no sign-flip claim without k2
    });

    it('sets not_measured (honest-absent) with too few pairs to fit even k1', () => {
        const few = syntheticPairs(-0.12, 0.05).slice(0, 6); // < MIN_PAIRS (10)
        const r = fitBrownConrady(few, [CX, CY], HD);
        expect(r.provenance).toBe('MEASURED');
        expect(r.not_measured).toBeTruthy();
        expect(r.not_measured).toMatch(/insufficient matched pairs/i);
        expect(r.k2).toBeNull();
        expect(r.terms).toEqual([]);
    });
});
