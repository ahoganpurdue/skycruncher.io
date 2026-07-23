/**
 * Step-6 instrument charts — chart math, quiver model, and fit diagnostics.
 *
 * Guards the "nerd data" UI wave (2026-07):
 *  1. chart_math primitives (ticks, coefficient formatting, model curves,
 *     labeled quiver magnification) are honest and stable.
 *  2. buildQuiverModel projects catalog matches through the SAME linear-WCS
 *     convention as ResidualAnalyzer, filters sentinels, and reports real
 *     RMS/median statistics.
 *  3. HardwareProfiler now emits fit_stats (inlier count, r_ref, model RMS,
 *     OLS standard errors) — measured uncertainty, not decoration.
 */
import { describe, it, expect } from 'vitest';
import { niceTicks, fmtCoef, distortionShiftPx, vignetteGainAt, quiverMagnification } from '../ui/calibration/chart_math';
import { buildQuiverModel } from '../ui/calibration/quiver_model';
import { HardwareProfiler } from '../pipeline/m2_hardware/hardware_profiler';
import { SkyTransform } from '../core/SkyTransform';
import type { MatchedStar, PlateSolution, SignalPacket, HardMetadata } from '../types/Main_types';

// ── helpers (same conventions as m7_m9_downstream.test.ts) ────────────────

function makeWCS() {
    const s = 3.6 / 3600; // deg/px
    return {
        crpix: [500, 500] as [number, number],
        crval: [10, 20] as [number, number], // [HOURS, deg]
        cd: [[-s, 0], [0, s]] as [[number, number], [number, number]]
    };
}

function skyToPixel(raDeg: number, decDeg: number, wcs: ReturnType<typeof makeWCS>) {
    const { xi, eta } = SkyTransform.gnomonicProject(raDeg / 15, decDeg, wcs.crval[0], wcs.crval[1]);
    const det = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0];
    return {
        x: wcs.crpix[0] + (wcs.cd[1][1] * xi - wcs.cd[0][1] * eta) / det,
        y: wcs.crpix[1] + (-wcs.cd[1][0] * xi + wcs.cd[0][0] * eta) / det
    };
}

function makeMatches(wcs: ReturnType<typeof makeWCS>, n = 25, offsetPx = 0): MatchedStar[] {
    const matches: MatchedStar[] = [];
    const grid = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
        const gx = (i % grid) - grid / 2;
        const gy = Math.floor(i / grid) - grid / 2;
        const raDeg = wcs.crval[0] * 15 + gx * 0.05;
        const decDeg = wcs.crval[1] + gy * 0.05;
        const p = skyToPixel(raDeg, decDeg, wcs);
        matches.push({
            detected: { x: p.x + offsetPx, y: p.y, rawX: p.x + offsetPx, rawY: p.y, flux: 1000 - i, fwhm: 2.5 } as any,
            catalog: { ra: raDeg, dec: decDeg, mag: 9, bv: 0.6, ra_hours: raDeg / 15, dec_degrees: decDeg, gaia_id: `g${i}` } as any,
            residual_arcsec: Math.abs(offsetPx) * 3.6
        });
    }
    return matches;
}

function makeSolution(matches: MatchedStar[]): PlateSolution {
    return {
        ra: 150, dec: 20, ra_hours: 10, dec_degrees: 20,
        pixel_scale: 3.6, rotation: 0, fov_width_deg: 1, fov_height_deg: 1,
        parity: 1, spatial_hash: 'x', confidence: 0.9,
        num_stars: matches.length, matched_stars: matches, wcs: makeWCS()
    } as PlateSolution;
}

// ── chart math ────────────────────────────────────────────────────────────

describe('step-6 chart math', () => {
    it('niceTicks covers the range with round steps and includes a clean zero', () => {
        const t = niceTicks(-3.2, 7.9, 5);
        expect(t[0]).toBeGreaterThanOrEqual(-3.2);
        expect(t[t.length - 1]).toBeLessThanOrEqual(7.9 + 1e-9);
        expect(t).toContain(0);
        // steps are uniform
        const step = t[1] - t[0];
        for (let i = 2; i < t.length; i++) expect(t[i] - t[i - 1]).toBeCloseTo(step, 9);
    });

    it('niceTicks survives degenerate input', () => {
        expect(niceTicks(5, 5).length).toBeGreaterThan(0);
        expect(niceTicks(NaN, 1)).toEqual([0]);
    });

    it('fmtCoef is honest about absence and picks sane notation', () => {
        expect(fmtCoef(null)).toBe('—');
        expect(fmtCoef(undefined)).toBe('—');
        expect(fmtCoef(NaN)).toBe('—');
        expect(fmtCoef(0)).toBe('0');
        expect(fmtCoef(0.01234)).toBe('0.0123');
        expect(fmtCoef(1.2e-5)).toMatch(/e-5$/);
    });

    it('distortion shift is zero on-axis and scales with r_ref', () => {
        expect(distortionShiftPx(0, -0.1, 0.02, 0, 2000)).toBe(0);
        const at1 = distortionShiftPx(1, -0.1, 0.02, 0, 2000);
        expect(at1).toBeCloseTo((-0.1 + 0.02) * 2000, 6);
        expect(distortionShiftPx(1, -0.1, 0.02, 0, 1000)).toBeCloseTo(at1 / 2, 6);
    });

    it('vignette gain matches the fitted model I(r) = 1 + v1 r²', () => {
        expect(vignetteGainAt(0, -0.3)).toBe(1);
        expect(vignetteGainAt(1, -0.3)).toBeCloseTo(0.7, 9);
    });

    it('quiver magnification is a labeled {1,2,5}×10ⁿ value, never inflating beyond target', () => {
        expect(quiverMagnification(0, 30)).toBe(1);      // no residual: true scale
        expect(quiverMagnification(40, 30)).toBe(1);     // already visible: true scale
        expect(quiverMagnification(0.5, 24)).toBe(20);   // ideal 48 -> snap DOWN to 20
        expect(quiverMagnification(0.001, 30)).toBe(500); // clamp
    });
});

// ── quiver model ──────────────────────────────────────────────────────────

describe('step-6 residual quiver model', () => {
    it('projects a catalog star to the ANALYTIC pixel (independent of the quiver fit)', () => {
        // Same linear WCS as the quiver source. Pin one absolute pixel so "near-zero
        // vectors" isn't purely self-referential: +0.05°E → (453.015, 500.007),
        // +0.05°N → (500.000, 550.000). Catches a y-flip / wrong-parity / wrong-scale.
        const wcs = makeWCS();
        const east = skyToPixel(150.05, 20.0, wcs);
        expect(east.x).toBeCloseTo(453.015, 2);
        expect(east.y).toBeCloseTo(500.007, 2); // ~unchanged in y (tiny second-order η term)
        const north = skyToPixel(150.0, 20.05, wcs);
        expect(north.x).toBeCloseTo(500.0, 2);
        expect(north.y).toBeCloseTo(550.0, 2);
    });

    it('a perfect linear field yields near-zero vectors at true scale', () => {
        const model = buildQuiverModel(makeSolution(makeMatches(makeWCS(), 25, 0)));
        expect(model).not.toBeNull();
        expect(model!.arrows).toHaveLength(25);
        expect(model!.rmsPx).toBeLessThan(0.01);
    });

    it('a uniformly shifted field measures the shift', () => {
        const model = buildQuiverModel(makeSolution(makeMatches(makeWCS(), 25, 2)));
        expect(model).not.toBeNull();
        expect(model!.medianPx).toBeCloseTo(2, 1);
        expect(model!.rmsPx).toBeCloseTo(2, 1);
        // every arrow points +x (observed right of projected)
        for (const a of model!.arrows) expect(a.dx).toBeCloseTo(2, 1);
    });

    it('refuses to render below 15 matches and filters sentinels/planets', () => {
        expect(buildQuiverModel(makeSolution(makeMatches(makeWCS(), 10)))).toBeNull();

        const matches = makeMatches(makeWCS(), 20);
        matches.push({ ...matches[0], residual_arcsec: 9999 });
        matches.push({
            ...matches[1],
            catalog: { ...matches[1].catalog, gaia_id: 'planet_mars' },
            residual_arcsec: 1005
        });
        const model = buildQuiverModel(makeSolution(matches));
        expect(model!.arrows).toHaveLength(20); // sentinels excluded
    });

    it('returns null without a fitted WCS', () => {
        const sol = makeSolution(makeMatches(makeWCS(), 25));
        delete (sol as any).wcs;
        expect(buildQuiverModel(sol)).toBeNull();
    });
});

// ── profiler fit diagnostics ──────────────────────────────────────────────

describe('M2 HardwareProfiler fit_stats (measured uncertainty)', () => {
    const emptySignal: SignalPacket = {
        clean_stars: [], anomalies: [], background_level: 0.01, noise_floor: 0.002
    };
    const meta = { width: 1000, height: 1000, pixel_pitch_um: 2.9, focal_length: 150 } as unknown as HardMetadata;

    it('emits fit_stats with real counts, normalization radius and finite SEs', () => {
        const report = HardwareProfiler.generateReport(makeSolution(makeMatches(makeWCS(), 30)), meta, [], emptySignal);
        const fs = report.fit_stats;
        expect(fs).toBeDefined();
        expect(fs!.n_matches).toBe(30);
        expect(fs!.n_inliers).toBeGreaterThanOrEqual(10);
        expect(fs!.r_ref_px).toBeGreaterThan(0);
        expect(Number.isFinite(fs!.rms_error_px)).toBe(true);
        // Perfect field: the radial model residual must be ~0 px. The old
        // calculateRMSE evaluated the polynomial on UN-normalized pixel radii
        // and produced ~1e22 px the moment the number was displayed.
        expect(fs!.rms_error_px).toBeLessThan(1);
        if (fs!.k1_se != null) expect(fs!.k1_se).toBeGreaterThanOrEqual(0);
        if (fs!.v1_se != null) expect(fs!.v1_se).toBeGreaterThanOrEqual(0);
    });

    it('omits fit_stats entirely when the fit cannot run (honest-or-absent)', () => {
        const report = HardwareProfiler.generateReport(makeSolution(makeMatches(makeWCS(), 5)), meta, [], emptySignal);
        expect(report.fit_stats).toBeUndefined();
        expect(report.distortion_profile.k1).toBe(0);
    });
});
