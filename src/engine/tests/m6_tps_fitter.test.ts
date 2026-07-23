// Unit tests for the thin-plate-spline distortion fitter
// (src/engine/pipeline/m6_plate_solve/tps_fitter.ts). Pure fit-core: SYNTHETIC
// matched pairs, no wasm/atlas/IO — deterministic proofs:
//   1. RECOVERY — a field warped by a KNOWN smooth displacement is recovered
//      sub-pixel at interior query points, and the fit RMS collapses vs raw.
//   2. λ SANITY — λ → large collapses the spline to its affine plane (weights→0).
//   3. COVERAGE GATE — too few control points OR lopsided azimuth ⇒ null
//      (honest-absent, not a laundered wild extrapolation).
//   4. SERIALIZATION — the tps block is plain number arrays, so it survives the
//      receipt replacer intact (the Float32Array-strip trap does NOT apply).

import { describe, it, expect } from 'vitest';
import { fitTps, evalField } from '../pipeline/m6_plate_solve/tps_fitter';
import { ResidualAnalyzer } from '../pipeline/m7_astrometry/residual_analyzer';
import { serializeReceipt } from '../pipeline/stages/receipt_serializer';
import type { PlateSolution } from '../types/Main_types';

// Representative narrow-field geometry.
const W = 1000, H = 800;
const CRPIX: [number, number] = [(W - 1) / 2, (H - 1) / 2];
const CRVAL: [number, number] = [10, 20];              // ra HOURS (=150°), dec deg
const SCALE_DEG = 0.001;                               // deg/px (≈3.6"/px)
const WCS = {
    crpix: CRPIX,
    crval: CRVAL,
    cd: [[SCALE_DEG, 0], [0, SCALE_DEG]] as [[number, number], [number, number]],
};
const PIXEL_SCALE = SCALE_DEG * 3600;                  // arcsec/px

// A smooth injected displacement field (u,v = pixel offset from crpix), the kind
// of low-order optical distortion a spline must reproduce. Radial-ish quadratic
// + a mild linear term + a cross term — no discontinuities.
const R = 500;
function warpDx(u: number, v: number): number { return 2.0 + 0.004 * u + 6 * (u * u + v * v) / (R * R); }
function warpDy(u: number, v: number): number { return -1.5 + 0.003 * v - 4 * (u * v) / (R * R); }

/**
 * Build a synthetic solved plate whose detected positions are the linear-WCS
 * projection of each catalog star PLUS the injected warp. Uses the SAME
 * projection the fitter uses (ResidualAnalyzer.skyToLinearPixel) so dx/dy recover
 * the injected warp exactly, independent of the projection internals.
 */
function makeSolution(opts: { raSpanDeg?: number; decSpanDeg?: number; raSteps?: number; decSteps?: number } = {}): PlateSolution {
    const ra0 = CRVAL[0] * 15;                          // 150°
    const dec0 = CRVAL[1];
    const raSpan = opts.raSpanDeg ?? 0.5, decSpan = opts.decSpanDeg ?? 0.38;
    const raSteps = opts.raSteps ?? 26, decSteps = opts.decSteps ?? 21;
    const matched_stars: any[] = [];
    for (let i = 0; i < raSteps; i++) {
        for (let j = 0; j < decSteps; j++) {
            const ra = ra0 - raSpan + (2 * raSpan) * (i / (raSteps - 1));
            const dec = dec0 - decSpan + (2 * decSpan) * (j / (decSteps - 1));
            const { x: expX, y: expY } = ResidualAnalyzer.skyToLinearPixel(ra, dec, WCS);
            if (expX < 20 || expX > W - 20 || expY < 20 || expY > H - 20) continue;
            const u = expX - CRPIX[0], v = expY - CRPIX[1];
            const dx = warpDx(u, v), dy = warpDy(u, v);
            matched_stars.push({
                detected: { x: expX + dx, y: expY + dy, flux: 1000, fwhm: 2 },
                catalog: { ra, dec, mag: 10, gaia_id: `G${i}_${j}` },
                residual_arcsec: Math.hypot(dx, dy) * PIXEL_SCALE,
            });
        }
    }
    return { wcs: WCS, matched_stars, pixel_scale: PIXEL_SCALE } as unknown as PlateSolution;
}

describe('M6 TPS fitter — synthetic-warp recovery', () => {
    it('recovers a known smooth warp sub-pixel at interior query points', () => {
        const sol = makeSolution();
        const tps = fitTps(sol);
        expect(tps, 'fitter should admit a well-covered dense field').toBeTruthy();
        if (!tps) return;

        const un = tps.control_points.map(p => p[0]);
        const vn = tps.control_points.map(p => p[1]);

        // Interior query points (well inside the control hull), compared against
        // the TRUE injected warp — the spline must interpolate sub-pixel.
        let maxErr = 0;
        for (const u of [-300, -150, 0, 150, 300]) {
            for (const v of [-240, 0, 240]) {
                const fx = evalField(u / tps.scale, v / tps.scale, un, vn, tps.weights_x, tps.affine.dx);
                const fy = evalField(u / tps.scale, v / tps.scale, un, vn, tps.weights_y, tps.affine.dy);
                maxErr = Math.max(maxErr, Math.abs(fx - warpDx(u, v)), Math.abs(fy - warpDy(u, v)));
            }
        }
        expect(maxErr).toBeLessThan(0.3); // px — sub-pixel interior recovery

        // The spline explains the field: post-fit RMS collapses vs raw.
        expect(tps.rms_after_arcsec).toBeLessThan(0.05 * tps.rms_before_arcsec);
        expect(tps.rms_before_arcsec).toBeGreaterThan(1.0); // the injected warp is real
    });
});

describe('M6 TPS fitter — λ regularization sanity', () => {
    it('λ → large collapses the spline to its affine plane (weights → 0)', () => {
        const sol = makeSolution();
        const stiff = fitTps(sol, 1e10);
        expect(stiff).toBeTruthy();
        if (!stiff) return;
        const maxW = Math.max(...stiff.weights_x.map(Math.abs), ...stiff.weights_y.map(Math.abs));
        expect(maxW).toBeLessThan(1e-4); // spline term crushed → affine-only

        // Evaluation ≈ the pure affine plane (spline contribution negligible).
        const un = stiff.control_points.map(p => p[0]);
        const vn = stiff.control_points.map(p => p[1]);
        const uq = 120 / stiff.scale, vq = -90 / stiff.scale;
        const full = evalField(uq, vq, un, vn, stiff.weights_x, stiff.affine.dx);
        const plane = stiff.affine.dx[0] + stiff.affine.dx[1] * uq + stiff.affine.dx[2] * vq;
        expect(Math.abs(full - plane)).toBeLessThan(1e-3);
    });
});

describe('M6 TPS fitter — coverage gate (honest-absent)', () => {
    it('refuses too few control points (< MIN_CONTROL)', () => {
        const sol = makeSolution({ raSteps: 4, decSteps: 4 }); // ~16 stars < 25
        expect(fitTps(sol)).toBeNull();
    });

    it('refuses a lopsided azimuth (control points in one octant)', () => {
        // A dense but angularly-narrow sliver: many points, but all in ~one octant.
        const sol = makeSolution();
        const s = sol as any;
        s.matched_stars = s.matched_stars.filter((m: any) => {
            const u = m.detected.x - CRPIX[0], v = m.detected.y - CRPIX[1];
            const a = Math.atan2(v, u);
            return a > 0.05 && a < 0.55; // a thin wedge in the first octant
        });
        expect(s.matched_stars.length).toBeGreaterThan(25); // enough count …
        expect(fitTps(sol)).toBeNull();                     // … but octant gate refuses
    });

    it('returns null when there is no WCS', () => {
        expect(fitTps({ matched_stars: [], pixel_scale: 1 } as unknown as PlateSolution)).toBeNull();
    });
});

describe('M6 TPS fitter — plain-array serialization survives the receipt replacer', () => {
    it('the tps block round-trips through serializeReceipt as real arrays', () => {
        const sol = makeSolution();
        const tps = fitTps(sol);
        expect(tps).toBeTruthy();
        const receipt = { solution: { astrometry: { rms_arcsec: 5, distortion_detected: true, tps } } };
        const round = JSON.parse(serializeReceipt(receipt));
        const t = round.solution.astrometry.tps;
        expect(Array.isArray(t.weights_x)).toBe(true);
        expect(Array.isArray(t.weights_y)).toBe(true);
        expect(Array.isArray(t.control_points)).toBe(true);
        expect(Array.isArray(t.control_points[0])).toBe(true);
        expect(Array.isArray(t.affine.dx)).toBe(true);
        expect(t.weights_x.length).toBe(tps!.control_count);
        expect(t.control_points.length).toBe(tps!.control_count);
        // Values preserved (not corrupted into an index-keyed object).
        expect(t.weights_x[0]).toBeCloseTo(tps!.weights_x[0], 10);
    });
});
