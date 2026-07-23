import { describe, it, expect } from 'vitest';
import {
    vignetteGain,
    applyVignetteGainToLum,
    fitVignetteFromDetectionLum,
    subtractBackgroundSurface,
} from '../pipeline/m4_signal_detect/detection_flatten';
import { densityCapCount } from '../pipeline/m4_signal_detect/detection_guard';
import { BackgroundSurfaceModeler } from '../pipeline/m4_signal_detect/TerrestrialEnvironment';
import { PIPELINE_CONSTANTS } from '../pipeline/constants/pipeline_config';

/**
 * M4 detection-plane flattening — pure-helper contracts for the four
 * default-OFF levers (detection_flatten.ts + detection_guard.densityCapCount +
 * BackgroundSurfaceModeler.coeffs()). These lock the byte-identical-OFF story
 * (flags default off) and the frame-measured vignette fit.
 */

describe('M4 detection-plane flattening helpers', () => {
    describe('vignetteGain', () => {
        it('is 1 at center (r²=0) and monotonically boosts with radius', () => {
            const g = vignetteGain(0.6, 0.3);
            expect(g(0)).toBe(1);
            expect(g(1)).toBeCloseTo(1.9, 10); // 1 + 0.6 + 0.3
            expect(g(0.5)).toBeGreaterThan(g(0));
            expect(g(1)).toBeGreaterThan(g(0.5));
        });
    });

    describe('applyVignetteGainToLum', () => {
        it('returns a NEW buffer, leaves center ~unchanged, boosts corners', () => {
            const w = 41, h = 41; // odd → exact center pixel at (20,20)
            const lum = new Float32Array(w * h).fill(0.5);
            const out = applyVignetteGainToLum(lum, w, h, 0.6, 0.3);
            expect(out).not.toBe(lum);                 // new buffer
            expect(lum.every(v => v === 0.5)).toBe(true); // input untouched (invariant #1)
            const center = out[20 * w + 20];
            const corner = out[0];
            expect(center).toBeCloseTo(0.5, 6);        // r²=0 ⇒ gain 1
            expect(corner).toBeCloseTo(0.5 * 1.9, 5);  // r²=1 ⇒ gain 1.9
            expect(corner).toBeGreaterThan(center);
        });
    });

    describe('fitVignetteFromDetectionLum', () => {
        it('recovers a radial falloff from the frame sky and flattens the corner/center ratio', () => {
            const w = 240, h = 160;
            const lum = new Float32Array(w * h);
            const cx = (w - 1) / 2, cy = (h - 1) / 2;
            const hd2 = cx * cx + cy * cy;
            const A2 = 0.6, A4 = 0.3; // true vignette
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const r2 = ((x - cx) ** 2 + (y - cy) ** 2) / hd2;
                    const bg = 0.5 + 0.04 * (x / w);       // mild LP gradient (linear plane)
                    lum[y * w + x] = bg / (1 + A2 * r2 + A4 * r2 * r2); // observed = sky / gain
                }
            }
            const fit = fitVignetteFromDetectionLum(lum, w, h);
            expect(fit).not.toBeNull();
            expect(fit!.a2).toBeGreaterThan(0);            // detected real falloff
            expect(fit!.cornerCenterRatioBefore).toBeLessThan(0.7); // corners much dimmer
            // Correction pulls the corner/center ratio toward 1 (flatter).
            expect(fit!.cornerCenterRatioAfter).toBeGreaterThan(fit!.cornerCenterRatioBefore);
            expect(fit!.cornerCenterRatioAfter).toBeGreaterThan(0.85);
            expect(fit!.cornerCenterRatioAfter).toBeLessThan(1.15);
            expect(Number.isFinite(fit!.fitRms)).toBe(true);
            expect(fit!.cells).toBeGreaterThan(100);
        });

        it('returns null (honest-or-absent) when the frame is too small to fit', () => {
            expect(fitVignetteFromDetectionLum(new Float32Array(8 * 8).fill(0.5), 8, 8)).toBeNull();
        });
    });

    describe('subtractBackgroundSurface', () => {
        it('subtracts the evaluated surface into a NEW buffer without touching the input', () => {
            const w = 4, h = 3;
            const lum = new Float32Array(w * h).fill(1.0);
            const evaluate = (x: number, y: number) => 0.1 * x + 0.2 * y;
            const out = subtractBackgroundSurface(lum, w, h, evaluate);
            expect(out).not.toBe(lum);
            expect(lum.every(v => v === 1.0)).toBe(true); // input untouched
            expect(out[0]).toBeCloseTo(1.0, 6);           // (0,0) — Float32 precision
            expect(out[2 * w + 3]).toBeCloseTo(1.0 - (0.3 + 0.4), 6); // (3,2) — Float32 precision
        });
    });

    describe('BackgroundSurfaceModeler.coeffs()', () => {
        it('is all-zero before a fit and finite/consistent with evaluate after', () => {
            const m = new BackgroundSurfaceModeler();
            const c0 = m.coeffs();
            expect(Object.values(c0).every(v => v === 0)).toBe(true);
            expect(m.evaluate(10, 20)).toBe(0);

            // Fit a known tilted plane z = 0.001·x + 0.002·y over a dense sky.
            const w = 200, h = 120;
            const lum = new Float32Array(w * h);
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) lum[y * w + x] = 0.001 * x + 0.002 * y;
            const horizon = new Array(160).fill(0).map((_, i) => ({ x: i * (w / 160), y: h }));
            m.fitSurface(lum, w, h, horizon, []);
            const c1 = m.coeffs();
            expect(Object.values(c1).every(v => Number.isFinite(v))).toBe(true);
            // coeffs() and evaluate() describe the same model.
            const x = 40, y = 30;
            const viaCoeffs = c1.a * x * x + c1.b * y * y + c1.c * x * y + c1.d * x + c1.e * y + c1.f;
            expect(viaCoeffs).toBeCloseTo(m.evaluate(x, y), 9);
            // Recovered plane is APPROXIMATE (the 6x6 normal-equation solve on a
            // large-coordinate quadratic basis is mildly ill-conditioned).
            expect(m.evaluate(x, y)).toBeCloseTo(0.001 * x + 0.002 * y, 2);
        });
    });

    describe('densityCapCount', () => {
        it('is the density-threshold × megapixels boundary (single source of truth), ≥1', () => {
            const w = 2596, h = 1731; // Carina binned
            const mp = (w * h) / 1e6;
            const expected = Math.floor(PIPELINE_CONSTANTS.DETECT_MAX_CANDIDATE_DENSITY_PER_MP * mp);
            expect(densityCapCount(w, h)).toBe(expected);
            expect(densityCapCount(1, 1)).toBeGreaterThanOrEqual(1);
        });
    });

    // These mirror the signal_processor.analyzeWithMasking wiring (the WASM blob
    // extractor can't run in vitest — see m4_horizon_cull_bridge.test.ts — so the
    // flag paths' novel LOGIC is exercised here; e2e proves OFF byte-identity).
    describe('item 2 wiring composition (fit → apply flattens the detection copy)', () => {
        it('applying the fitted gain pulls the corner sky up toward the center level', () => {
            const w = 201, h = 141; // odd ⇒ exact integer center pixel at (100,70)
            const lum = new Float32Array(w * h);
            const cx = (w - 1) / 2, cy = (h - 1) / 2, hd2 = cx * cx + cy * cy;
            const A2 = 0.7, A4 = 0.2;
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                    const r2 = ((x - cx) ** 2 + (y - cy) ** 2) / hd2;
                    lum[y * w + x] = 0.5 / (1 + A2 * r2 + A4 * r2 * r2);
                }
            const fit = fitVignetteFromDetectionLum(lum, w, h)!;
            const corrected = applyVignetteGainToLum(lum, w, h, fit.a2, fit.a4);
            const cornerBefore = lum[0], cornerAfter = corrected[0];
            const center = corrected[cy * w + cx]; // r²≈0 ⇒ unchanged
            expect(cornerAfter).toBeGreaterThan(cornerBefore); // corner boosted
            expect(cornerAfter).toBeGreaterThan(0.42);         // toward 0.5 center
            expect(center).toBeCloseTo(lum[cy * w + cx], 5);   // center untouched
        });
    });

    describe('item 1 wiring composition (fitSurface → subtract flattens the deep buffer)', () => {
        it('subtracting the fitted surface drives the background near zero while preserving bright peaks', () => {
            const w = 220, h = 140;
            const lum = new Float32Array(w * h);
            for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) lum[y * w + x] = 0.2 + 0.0008 * x + 0.0011 * y; // tilted bg
            // a few bright "stars" well above the plane
            const stars = [[50, 40], [120, 90], [180, 30]];
            for (const [sx, sy] of stars) lum[sy * w + sx] = 0.95;

            const m = new BackgroundSurfaceModeler();
            const horizon = new Array(160).fill(0).map((_, i) => ({ x: i * (w / 160), y: h }));
            m.fitSurface(lum, w, h, horizon, []);
            const flat = subtractBackgroundSurface(lum, w, h, (x, y) => m.evaluate(x, y));

            // Background residual centres near zero (was ~0.2–0.4 before).
            const bgResidual = flat[70 * w + 30];
            expect(Math.abs(bgResidual)).toBeLessThan(0.02);
            // Bright peaks survive as strong positive residuals.
            expect(flat[40 * w + 50]).toBeGreaterThan(0.5);
            // Input science buffer is never mutated (invariant #2).
            expect(lum[40 * w + 50]).toBeCloseTo(0.95, 6);
        });
    });

    describe('flags default OFF (byte-identical-OFF contract)', () => {
        it('all four detection-flatten levers are the legacy default when the env is unset', () => {
            expect(PIPELINE_CONSTANTS.DETECT_APPLY_BG_SURFACE).toBe(false);
            expect(PIPELINE_CONSTANTS.DETECT_APPLY_VIGNETTE_GAIN).toBe(false);
            expect(PIPELINE_CONSTANTS.DETECT_DENSITY_GUARD_MODE).toBe(0); // 0 = legacy throw
            expect(PIPELINE_CONSTANTS.DETECT_MW_REAL_HORIZON).toBe(false);
        });
    });
});
