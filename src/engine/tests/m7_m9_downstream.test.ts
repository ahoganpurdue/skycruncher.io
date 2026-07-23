/**
 * Downstream (post-solve) audit regressions — M2 profiler / M7 astrometry / M9 packet.
 *
 * Guards the 2026-07 fixes:
 *  1. HardwareProfiler.generateReport receives REAL star measurements (was []),
 *     reads the fitted wcs.crpix (the old `wcs.CRPIX1` key never existed on any
 *     producer), filters planetary-verification sentinels, and no longer
 *     fabricates a -0.05 distortion coefficient.
 *  2. ResidualAnalyzer unit conventions (catalog.ra DEGREES, crval[0] HOURS,
 *     CD deg/px) — a perfect linear solution must analyze to ~0 RMS, and
 *     sentinel/planet matches must not poison the fit.
 *  3. OrchestratorSession.exportPacket emits the FITTED WCS (not a re-synthesized
 *     approximation), real per-star matched list, sentinel-filtered residual
 *     stats, and the ephemeris-handshake output actually lands in `planets`.
 */
import { describe, it, expect } from 'vitest';
import { HardwareProfiler } from '../pipeline/m2_hardware/hardware_profiler';
import { ResidualAnalyzer } from '../pipeline/m7_astrometry/residual_analyzer';
import { SkyTransform } from '../core/SkyTransform';
import type { MatchedStar, PlateSolution, SignalPacket, StarMeasurement, HardMetadata, SolarBody } from '../types/Main_types';

// ── helpers ──────────────────────────────────────────────────────────────

/** Linear test WCS: crval [10h, +20°], crpix [500,500], scale 3.6"/px, no rotation, negative parity. */
function makeWCS() {
    const s = 3.6 / 3600; // deg/px
    return {
        crpix: [500, 500] as [number, number],
        crval: [10, 20] as [number, number], // [HOURS, deg] — engine convention
        cd: [[-s, 0], [0, s]] as [[number, number], [number, number]]
    };
}

/** Project catalog RA/Dec (degrees) to pixel space through the test WCS (independent of the analyzer). */
function skyToPixel(raDeg: number, decDeg: number, wcs: ReturnType<typeof makeWCS>) {
    const { xi, eta } = SkyTransform.gnomonicProject(raDeg / 15, decDeg, wcs.crval[0], wcs.crval[1]);
    const det = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0];
    return {
        x: wcs.crpix[0] + (wcs.cd[1][1] * xi - wcs.cd[0][1] * eta) / det,
        y: wcs.crpix[1] + (-wcs.cd[1][0] * xi + wcs.cd[0][0] * eta) / det
    };
}

/** Build N perfectly-matched stars on a grid around the tangent point. */
function makePerfectMatches(wcs: ReturnType<typeof makeWCS>, n = 25, offsetPx = 0): MatchedStar[] {
    const matches: MatchedStar[] = [];
    const grid = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
        const gx = (i % grid) - grid / 2;
        const gy = Math.floor(i / grid) - grid / 2;
        const raDeg = wcs.crval[0] * 15 + gx * 0.05;
        const decDeg = wcs.crval[1] + gy * 0.05;
        const p = skyToPixel(raDeg, decDeg, wcs);
        matches.push({
            detected: {
                x: p.x + offsetPx, y: p.y, rawX: p.x + offsetPx, rawY: p.y,
                flux: 1000 - i * 10, fwhm: 2.5 + (i % 5) * 0.1,
                // Spectral peek payload (rides along on the real SignalPoint)
                ...( { peak_rgb: [0.9, 0.5, 0.3], measured_bv: 0.6, circularity: 0.9 } as any )
            },
            catalog: {
                ra: raDeg, dec: decDeg, mag: 8 + (i % 4) * 0.5, bv: 0.6,
                ra_hours: raDeg / 15, dec_degrees: decDeg,
                gaia_id: `gaia_${i}`
            },
            residual_arcsec: Math.abs(offsetPx) * 3.6
        });
    }
    return matches;
}

function makeSolution(matches: MatchedStar[]): PlateSolution {
    const wcs = makeWCS();
    return {
        ra: 150, dec: 20, ra_hours: 10, dec_degrees: 20,
        pixel_scale: 3.6, rotation: 0, rotation_deg: 0,
        fov_width_deg: 1, fov_height_deg: 1, parity: 1,
        spatial_hash: 'RA10.00_DEC20.0',
        confidence: 0.9, num_stars: matches.length,
        matched_stars: matches,
        wcs,
        diagnostics: { avg_fwhm: 1.1, stars_matched: matches.length, solve_time_ms: 1234 }
    };
}

const emptySignal: SignalPacket = {
    clean_stars: [], anomalies: [], background_level: 0.01, noise_floor: 0.002
};

const testMetadata = {
    width: 1000, height: 1000, pixel_pitch_um: 2.9, focal_length: 150
} as unknown as HardMetadata;

// ── M2: HardwareProfiler ─────────────────────────────────────────────────

describe('M2 HardwareProfiler.generateReport (post-solve inputs)', () => {
    it('produces finite distortion/vignette coefficients from real matched stars', () => {
        const matches = makePerfectMatches(makeWCS(), 30);
        const sol = makeSolution(matches);
        const report = HardwareProfiler.generateReport(sol, testMetadata, [], emptySignal);
        expect(Number.isFinite(report.distortion_profile.k1)).toBe(true);
        expect(Number.isFinite(report.distortion_profile.k2)).toBe(true);
        expect(Number.isFinite(report.vignette_v1 ?? 0)).toBe(true);
    });

    it('ignores planetary-verification sentinel residuals (9999 / planet_*)', () => {
        const matches = makePerfectMatches(makeWCS(), 30);
        // A strobe sentinel and a planet flag — must not poison the regression
        matches.push({
            ...matches[0],
            residual_arcsec: 9999
        });
        matches.push({
            ...matches[1],
            catalog: { ...matches[1].catalog, gaia_id: 'planet_jupiter' },
            residual_arcsec: 1005
        });
        const sol = makeSolution(matches);
        const report = HardwareProfiler.generateReport(sol, testMetadata, [], emptySignal);
        expect(Number.isFinite(report.distortion_profile.k1)).toBe(true);
        // Perfect field: distortion must be ~0, not blown up by the sentinel
        expect(Math.abs(report.distortion_profile.k1)).toBeLessThan(0.05);
    });

    it('no longer fabricates a -0.05 distortion when residuals are unavailable', () => {
        const sol = makeSolution([]); // no matched stars at all
        const manyStars: StarMeasurement[] = Array.from({ length: 20 }, (_, i) => ({
            x: i, y: i, flux: 100, fwhm: 2.5
        }));
        const report = HardwareProfiler.generateReport(sol, testMetadata, manyStars, emptySignal);
        expect(report.distortion_profile.k1).toBe(0); // honest absent, not -0.05
    });

    it('computes real sensor response from per-star flux measurements (was always Standard RGB)', () => {
        const matches = makePerfectMatches(makeWCS(), 30);
        const sol = makeSolution(matches);
        // Red-biased near-white stars (catalog_bv inside the 0.5-0.7 window)
        const stars: StarMeasurement[] = Array.from({ length: 15 }, (_, i) => ({
            x: i, y: i, flux: 1000, fwhm: 2.5,
            flux_r: 2.0, flux_g: 1.0, flux_b: 1.0,
            catalog_bv: 0.6
        }));
        const report = HardwareProfiler.generateReport(sol, testMetadata, stars, emptySignal);
        expect(report.sensor_response?.r_bias).toBeCloseTo(2.0, 5);
        expect(report.sensor_response?.g_bias).toBeCloseTo(1.0, 5);
        expect(report.detected_modifications).toContain('Astro-Modified Sensor (IR/UV Cut Removed)');
        expect(report.spectral_bias).toBe('Deep Red (H-alpha) enhanced');
    });
});

// ── M7: ResidualAnalyzer ─────────────────────────────────────────────────

describe('M7 ResidualAnalyzer (unit conventions + sentinel hygiene)', () => {
    it('projects a catalog star to the ANALYTIC pixel (breaks the mock self-reference)', () => {
        // The "~0 RMS" test below is self-referential (detected pixels are generated by
        // skyToPixel and re-projected by the analyzer through the same projection). This
        // pins ONE absolute pixel independently: with crval[10h,+20°], crpix[500,500],
        // scale 0.001°/px, negative parity (cd=[[-s,0],[0,s]]):
        //   • +0.05°E of tangent (150.05°,20°)  → (453.015, 500.007): x moves LEFT by
        //     ~47px (negative parity), y ~unchanged.
        //   • +0.05°N of tangent (150.00°,20.05°) → (500.000, 550.000): y moves +50px.
        // A y-flip, wrong parity, or wrong scale fails these.
        const wcs = makeWCS();
        const east = skyToPixel(150.05, 20.0, wcs);
        expect(east.x).toBeCloseTo(453.015, 2);
        expect(east.y).toBeCloseTo(500.007, 2); // ~unchanged in y (tiny second-order η term)
        const north = skyToPixel(150.0, 20.05, wcs);
        expect(north.x).toBeCloseTo(500.0, 2);
        expect(north.y).toBeCloseTo(550.0, 2);
    });

    it('a perfect linear solution analyzes to ~0 RMS with no distortion flag', () => {
        const sol = makeSolution(makePerfectMatches(makeWCS(), 25));
        const a = ResidualAnalyzer.analyze(sol);
        expect(a.rms_arcsec).toBeLessThan(0.05);
        expect(a.distortion_pattern_detected).toBe(false);
        expect(a.sip_coefficients).toBeUndefined();
    });

    it('sentinel/planet matches do not poison the analysis', () => {
        const matches = makePerfectMatches(makeWCS(), 25);
        matches.push({
            ...matches[0],
            detected: { ...matches[0].detected, x: matches[0].detected.x + 400 }, // wildly off
            catalog: { ...matches[0].catalog, gaia_id: 'planet_venus' },
            residual_arcsec: 9999
        });
        const a = ResidualAnalyzer.analyze(makeSolution(matches));
        expect(a.rms_arcsec).toBeLessThan(0.05);
    });

    it('reports a real systematic error vector for a uniformly shifted field', () => {
        const sol = makeSolution(makePerfectMatches(makeWCS(), 25, 2)); // +2px in x
        const a = ResidualAnalyzer.analyze(sol);
        expect(a.rms_arcsec).toBeGreaterThan(6); // ~2px * 3.6"/px
        expect(a.systematic_error_vector.x).toBeCloseTo(2, 1);
        expect(Math.abs(a.systematic_error_vector.y)).toBeLessThan(0.1);
    });
});

// ── M9: OrchestratorSession.exportPacket ─────────────────────────────────

describe('M9 wizard exportPacket (real-or-absent fields)', async () => {
    const { OrchestratorSession } = await import('../pipeline/orchestrator_session');

    function makeSession(sol: PlateSolution) {
        const session = new OrchestratorSession(new ArrayBuffer(16));
        (session as any).solution = sol;
        session.imageWidth = 1000;
        session.imageHeight = 1000;
        return session;
    }

    it('emits the FITTED WCS (crval hours -> CRVAL degrees, real CD matrix)', () => {
        const wcs = makeWCS();
        const session = makeSession(makeSolution(makePerfectMatches(wcs, 25)));
        const packet = session.exportPacket();
        expect(packet.wcs.SOURCE).toBe('FITTED');
        expect(packet.wcs.CRVAL1).toBeCloseTo(wcs.crval[0] * 15, 9);
        expect(packet.wcs.CRVAL2).toBeCloseTo(wcs.crval[1], 9);
        expect(packet.wcs.CRPIX1).toBe(wcs.crpix[0]);
        expect(packet.wcs.CD1_1).toBeCloseTo(wcs.cd[0][0], 12);
        expect(packet.wcs.CD2_2).toBeCloseTo(wcs.cd[1][1], 12);
    });

    it('falls back to a labeled synthesized WCS when no fitted matrix exists', () => {
        const sol = makeSolution([]);
        delete (sol as any).wcs;
        const packet = makeSession(sol).exportPacket();
        expect(packet.wcs.SOURCE).toBe('SYNTHESIZED');
        expect(packet.wcs.CRVAL1).toBeCloseTo(150, 9);
    });

    it('carries the real matched-star list and sentinel-filtered residual stats', () => {
        const matches = makePerfectMatches(makeWCS(), 20);
        matches.push({ ...matches[0], residual_arcsec: 9999 }); // sentinel
        const packet = makeSession(makeSolution(matches)).exportPacket();

        expect(packet.solution.stars_matched).toBe(21);          // full match count
        expect(packet.solution.matched_stars).toHaveLength(21);  // full provenance list
        expect(packet.solution.mean_residual_arcsec).toBeLessThan(1); // sentinel excluded from stats
        expect(packet.solution.mean_fwhm_px).toBeGreaterThan(2);      // REAL fwhm, not residual proxy
        expect(packet.solution.mean_fwhm_px).toBeLessThan(4);
        expect(packet.solution.spatial_hash).toBe('RA10.00_DEC20.0');
        expect(packet.solution.confidence).toBeCloseTo(0.9, 9);
        // Per-star science payload
        const star = packet.solution.matched_stars[0];
        expect(star.gaia_id).toBe('gaia_0');
        expect(star.peak_rgb).toEqual([0.9, 0.5, 0.3]);
        expect(star.residual_arcsec).toBeDefined();
    });

    it('lands the ephemeris-handshake output in session.planets and the packet', () => {
        const session = makeSession(makeSolution(makePerfectMatches(makeWCS(), 20)));
        const guests: SolarBody[] = [{
            id: 'jupiter', name: 'Jupiter', type: 'PLANET',
            ra: 10.01, dec: 20.1, mag: -2, radius_arcsec: 20
        }];
        const updated = (session as any).performEphemerisHandshake(session.solution, guests);
        expect(session.planets).toHaveLength(1);         // was NEVER populated before
        expect(session.planets[0].pixel_x).toBeDefined(); // projected through the solved WCS
        (session as any).solution = updated;
        const packet = session.exportPacket();
        expect(packet.planets).toHaveLength(1);
    });

    it('exposes honest provenance (warnings + timestamp trust)', () => {
        const session = makeSession(makeSolution([]));
        session.timestampTrusted = false;
        session.warnings.push('No capture timestamp in file metadata');
        const packet = session.exportPacket();
        expect(packet.timestamp_trusted).toBe(false);
        expect(packet.warnings).toHaveLength(1);
    });
});
