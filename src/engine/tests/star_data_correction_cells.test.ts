/**
 * STAR-DATA CORRECTION CELLS ②–⑥ (LAW-1 PSF-measurement layer).
 * Unit coverage for the pure math + the injected/flag-gated applications. The
 * load-bearing invariant across every cell: DEFAULT-OFF / no-map ⇒ inert (raw
 * measurement untouched) ⇒ both pinned reference solves byte-identical.
 * (Cell ① lives in m1_black_level_cell1.test.ts.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    fitVignettePerBand, fitVignetteLuma, gainAt, transmissionAt, serializeVignetteMap,
} from '../pipeline/m10_psf/vignette_map';
import {
    airRefractivity, chromaticDispersionArcsec, cdToJacobianArcsec, deprojectShapeByJacobian,
    type Cd2x2,
} from '../pipeline/m10_psf/psf_physics';
import { characterizePsfField } from '../pipeline/m10_psf/psf_field';
import { forcedMeasure } from '../pipeline/m6_plate_solve/deep_verify';
import { computeSpccCalibration } from '../pipeline/m8_photometry/spcc_calibrator';
import { runPsfAttribution, type PsfAttributionInput } from '../pipeline/stages/psf_attribution';
import { makeBrownConradyDistortion } from '../pipeline/m2_hardware/lens_distortion';
import type { PsfFieldReport } from '../pipeline/m10_psf/psf_field';
import type { PlateSolution } from '../types/Main_types';
import type { HardMetadata } from '../types/schema';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

// ── synthetic vignetted RGB frame: value = base · 1/(1 + A2·r²), per-band A2 ──
function vignettedRgb(w: number, h: number, a2: { r: number; g: number; b: number }, base = 1000): Float32Array {
    const cx = (w - 1) / 2, cy = (h - 1) / 2, hd2 = cx * cx + cy * cy;
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const r2 = ((x - cx) ** 2 + (y - cy) ** 2) / hd2;
        const i = (y * w + x) * 3;
        out[i] = base / (1 + a2.r * r2);
        out[i + 1] = base / (1 + a2.g * r2);
        out[i + 2] = base / (1 + a2.b * r2);
    }
    return out;
}

// ══════════════ CELL ② — per-band vignette map ══════════════
describe('CELL ② — fitVignettePerBand recovers a CHROMATIC falloff', () => {
    const w = 96, h = 96;
    const rgb = vignettedRgb(w, h, { r: 0.48, g: 0.32, b: 0.16 });
    const map = fitVignettePerBand(rgb, w, h);

    it('recovers per-band a2 in the right order (R falls off more than B)', () => {
        expect(map.r.a2).toBeGreaterThan(map.b.a2);       // chromatic: NOT a single gain
        expect(map.r.a2).toBeGreaterThanOrEqual(0.32);    // near the injected 0.48 (grid step .08)
        expect(map.b.a2).toBeLessThanOrEqual(0.32);       // near the injected 0.16
    });

    it('correction flattens the corner/center ratio toward 1', () => {
        // before: corners are dimmer (<1); after correction: ≈1
        expect(map.r.cornerCenterRatioBefore).toBeLessThan(0.95);
        expect(Math.abs(map.r.cornerCenterRatioAfter - 1)).toBeLessThan(
            Math.abs(map.r.cornerCenterRatioBefore - 1));
    });

    it('gainAt: 1 at center, >1 at the corner; transmission is its reciprocal', () => {
        expect(gainAt(map, map.center.cx, map.center.cy, 'r')).toBeCloseTo(1, 6);
        const gCorner = gainAt(map, 0, 0, 'r');
        expect(gCorner).toBeGreaterThan(1);
        expect(transmissionAt(map, 0, 0, 'r')).toBeCloseTo(1 / gCorner, 9);
    });

    it('serializeVignetteMap is APPROXIMATE-tiered + per-band; null-safe', () => {
        const s = serializeVignetteMap(map) as any;
        expect(s.tier).toBe('APPROXIMATE');
        expect(s.r.a2).toBe(map.r.a2);
        expect(serializeVignetteMap(null)).toBeNull();
    });

    it('fitVignetteLuma sets R=G=B=luma (no color info from a single channel)', () => {
        const lum = new Float32Array(w * h);
        const rgb2 = vignettedRgb(w, h, { r: 0.4, g: 0.4, b: 0.4 });
        for (let i = 0; i < w * h; i++) lum[i] = (rgb2[i * 3] + rgb2[i * 3 + 1] + rgb2[i * 3 + 2]) / 3;
        const lmap = fitVignetteLuma(lum, w, h);
        expect(lmap.r).toEqual(lmap.luma);
        expect(lmap.b).toEqual(lmap.luma);
    });
});

// ══════════════ CELL ② — psf_field.amp application (injected map) ══════════════
describe('CELL ② — characterizePsfField divides amp by transmission when a map is injected', () => {
    const w = 64, h = 64;
    // a REAL vignette falloff in the sky (so the fit finds a2>0) + a corner star.
    const cx = (w - 1) / 2, cy = (h - 1) / 2, hd2 = cx * cx + cy * cy;
    const lum = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const r2 = ((x - cx) ** 2 + (y - cy) ** 2) / hd2;
        lum[y * w + x] = 200 / (1 + 0.4 * r2);   // dimmer toward the corners
    }
    const sx = 12, sy = 12; // near a corner (high vignette gain there)
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        lum[(sy + dy) * w + (sx + dx)] += 400 * Math.exp(-(dx * dx + dy * dy) / 2);
    }
    const map = fitVignetteLuma(lum, w, h);

    it('no map ⇒ amp untouched (byte-identical), no corrected fields', () => {
        const r = characterizePsfField({ lum, width: w, height: h, stars: [{ x: sx, y: sy }] });
        expect(r.fits.length).toBeGreaterThan(0);
        expect(r.fits[0].vignetteGain).toBeUndefined();
        expect(r.fits[0].ampVignetteCorrected).toBeUndefined();
    });

    it('map ⇒ ampVignetteCorrected = amp · gain (raw amp preserved)', () => {
        const r = characterizePsfField({ lum, width: w, height: h, stars: [{ x: sx, y: sy }], vignette: map });
        const f = r.fits[0];
        expect(f.vignetteGain).toBeGreaterThan(1);   // corner star ⇒ gain > 1
        // corrected = amp · gain at the fit position (unrounded gain, as the code does)
        expect(f.ampVignetteCorrected).toBeCloseTo(f.amp * gainAt(map, f.x, f.y, 'luma'), 6);
        expect(f.amp).toBeGreaterThan(0);            // raw amp untouched
    });
});

// ══════════════ CELL ② — forcedMeasure application (injected map) ══════════════
describe('CELL ② — forcedMeasure adds flux_vignette_corrected only when a map is supplied', () => {
    const w = 48, h = 48;
    const L = new Float32Array(w * h).fill(5);
    const px = 8, py = 8;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) L[(py + dy) * w + (px + dx)] += 200;
    const map = fitVignetteLuma(L, w, h);

    it('no map ⇒ result has NO flux_vignette_corrected key (byte-identical)', () => {
        const { results } = forcedMeasure({ L, w, h, positions: [{ x: px, y: py }], fwhmPx: 3, snrThreshold: 0 });
        expect(results.length).toBe(1);
        expect('flux_vignette_corrected' in results[0]).toBe(false);
    });

    it('map ⇒ flux_vignette_corrected = flux · gain, raw flux + accept unchanged', () => {
        const bare = forcedMeasure({ L, w, h, positions: [{ x: px, y: py }], fwhmPx: 3, snrThreshold: 0 });
        const withMap = forcedMeasure({ L, w, h, positions: [{ x: px, y: py }], fwhmPx: 3, snrThreshold: 0, vignette: map });
        expect(withMap.results[0].flux).toBe(bare.results[0].flux); // raw flux identical
        const g = gainAt(map, px, py, 'luma');
        expect(withMap.results[0].flux_vignette_corrected).toBeCloseTo(bare.results[0].flux * g, 6);
    });
});

// ══════════════ CELLS ②③ — SPCC flag-gated blocks (default OFF ⇒ null) ══════════════
describe('CELLS ②③ — SPCC correction provenance is null by default, populated under flags', () => {
    const frame = { data: new Float32Array(32 * 32 * 3).fill(100), width: 32, height: 32 };
    const map = fitVignettePerBand(vignettedRgb(32, 32, { r: 0.4, g: 0.3, b: 0.2 }), 32, 32);

    it('flags OFF (default): vignette + extinction blocks are null', () => {
        const cal = computeSpccCalibration([], frame, null, 1, map, 2.0);
        expect(cal.vignette).toBeNull();      // flag OFF ⇒ map ignored
        expect(cal.extinction).toBeNull();
    });

    it('flags ON (env): vignette + extinction blocks populate with honest provenance', async () => {
        vi.stubEnv('PSF_FLUX_VIGNETTE_CORRECT', '1');
        vi.stubEnv('PSF_FLUX_EXTINCTION_CORRECT', '1');
        vi.resetModules();
        const { computeSpccCalibration: fn } = await import('../pipeline/m8_photometry/spcc_calibrator');
        const { fitVignettePerBand: fit } = await import('../pipeline/m10_psf/vignette_map');
        const m = fit(vignettedRgb(32, 32, { r: 0.4, g: 0.3, b: 0.2 }), 32, 32);
        const cal = fn([], frame, null, 1, m as any, 2.0);
        expect((cal.vignette as any)?.tier).toBe('APPROXIMATE');
        expect(cal.extinction).toMatchObject({ k: 0.15, k_source: 'DEFAULT', airmass: 2.0, applied: true });
    });
});

// ══════════════ CELL ⑤ — chromatic dispersion physics ══════════════
describe('CELL ⑤ — atmospheric dispersion (chromatic refraction)', () => {
    it('air refractivity: blue refracts more than red; ~2.8e-4 at 0.55µm', () => {
        expect(airRefractivity(0.47)).toBeGreaterThan(airRefractivity(0.62));
        expect(airRefractivity(0.55)).toBeCloseTo(2.78e-4, 5);
    });
    it('dispersion is ~0 at zenith, grows toward the horizon, ~sub-arcsec at 45°', () => {
        expect(chromaticDispersionArcsec(90)).toBeLessThan(0.01); // ~0 at zenith (clamped alt)
        const d45 = chromaticDispersionArcsec(45);
        const d30 = chromaticDispersionArcsec(30);
        expect(d45).toBeGreaterThan(0);
        expect(d30).toBeGreaterThan(d45);          // lower altitude ⇒ more dispersion
        expect(d45).toBeGreaterThan(0.2);
        expect(d45).toBeLessThan(1.5);
    });
});

// ══════════════ CELL ⑥ — local-Jacobian shape de-projection physics ══════════════
describe('CELL ⑥ — deprojectShapeByJacobian (pixel shape → sky angle)', () => {
    it('isotropic J scales FWHM and keeps a round PSF round', () => {
        const sky = deprojectShapeByJacobian(3, 3, 0, [[2, 0], [0, 2]]);
        expect(sky.fwhmMajArcsec).toBeCloseTo(6, 6);   // 3px × 2 arcsec/px
        expect(sky.fwhmMinArcsec).toBeCloseTo(6, 6);
        expect(sky.ellipticity).toBeCloseTo(0, 6);
    });
    it('anisotropic J elongates a round PSF along the stretched axis', () => {
        const sky = deprojectShapeByJacobian(3, 3, 0, [[2, 0], [0, 1]]);
        expect(sky.fwhmMajArcsec).toBeCloseTo(6, 4);
        expect(sky.fwhmMinArcsec).toBeCloseTo(3, 4);
        expect(sky.ellipticity).toBeCloseTo(0.5, 4);
    });
    it('cdToJacobianArcsec converts deg/px CD to arcsec/px (×3600)', () => {
        const cd: Cd2x2 = [[-2 / 3600, 0], [0, 2 / 3600]];
        expect(cdToJacobianArcsec(cd)).toEqual([[-2, 0], [0, 2]]);
    });
});

// ── shared attribution builders (mirrors m10_psf_attribution.test.ts) ──
function makeRegions() {
    return Array.from({ length: 9 }, () => ({ n: 5, fwhmMedianPx: 3, ellipticityMedian: 0.1, orientationMedianDeg: 0 }));
}
function makePsfField(fits: any[]): PsfFieldReport {
    return {
        ledger: 'PIXEL', grid: 'SCIENCE_NATIVE', width: 1000, height: 800,
        method: 'WASM_LM_GAUSSIAN', stampSize: 17, nInput: 100, nFit: fits.length || 80, nLm: 80, nMoment: 0,
        rejected: {}, fwhmMedianMajPx: 3.0, fwhmMedianMinPx: 3.0, ellipticityMedian: 0.0,
        orientationMedianDeg: 0, regions: makeRegions() as any, fits, approximate: [], timings: {},
    } as PsfFieldReport;
}
function makeSolution(): PlateSolution {
    const s = 2.0 / 3600;
    return {
        ra: 260, dec: 20, ra_hours: 17.3333, dec_degrees: 20, pixel_scale: 2.0,
        rotation: 0, rotation_deg: 0, fov_width_deg: 1, fov_height_deg: 0.8, parity: 1,
        spatial_hash: 'x', confidence: 0.9, num_stars: 80,
        wcs: { crpix: [500, 400], crval: [17.3333, 20], cd: [[-s, 0], [0, s]] },
    } as PlateSolution;
}
function makeMeta(over?: Partial<HardMetadata>): HardMetadata {
    return {
        camera_model: 'Canon EOS 5D Mark III', lens_model: 'EF24mm', focal_length: 24,
        aperture: 2.8, iso_gain: 1600, exposure_time: 15, pixel_pitch_um: 6.25,
        timestamp: '2026-05-16T06:00:00Z', gps_lat: 34, gps_lon: -118,
        timestamp_source: 'EXIF', gps_source: 'EXIF', ...over,
    } as HardMetadata;
}
function baseInput(over?: Partial<PsfAttributionInput>): PsfAttributionInput {
    return {
        psfField: makePsfField([]), solution: makeSolution(), metadata: makeMeta(),
        imageWidth: 1000, imageHeight: 800, timestampTrusted: true, ...over,
    };
}

// ══════════════ CELL ⑤ — wired into psf_attribution.refraction ══════════════
describe('CELL ⑤ — refraction.chromaticDispersion (additive, gated on geometry)', () => {
    it('populated when observing geometry resolves (GPS + trusted clock)', () => {
        const a = runPsfAttribution(baseInput());
        const cd = a.refraction.chromaticDispersion;
        expect(cd).not.toBeNull();
        expect(cd!.tier).toBe('APPROXIMATE');
        expect(cd!.magnitudeArcsec).toBeGreaterThan(0);
        expect(cd!.lambdaBlueUm).toBeLessThan(cd!.lambdaRedUm);
    });
    it('null when the clock is untrusted (refraction gated OFF) — never mutates measured', () => {
        const a = runPsfAttribution(baseInput({ timestampTrusted: false }));
        expect(a.refraction.chromaticDispersion == null).toBe(true);
        expect(a.measured.majFwhmPx).toBe(3.0); // measurement untouched
    });
});

// ══════════════ CELL ④ — undistorted centroids (additive) ══════════════
describe('CELL ④ — centroids records native + undistorted when a model is injected', () => {
    const fits = [
        { x: 500, y: 400, amp: 1, sigmaMajPx: 1, sigmaMinPx: 1, fwhmMajPx: 3, fwhmMinPx: 3, ellipticity: 0, orientationDeg: 0, source: 'lm' as const },
        { x: 900, y: 750, amp: 1, sigmaMajPx: 1, sigmaMinPx: 1, fwhmMajPx: 3, fwhmMinPx: 3, ellipticity: 0, orientationDeg: 0, source: 'lm' as const },
    ];

    it('injected model ⇒ INJECTED_SOLVE provenance; off-center centroid moves, near-center barely', () => {
        const model = makeBrownConradyDistortion(0.12, 0.02, 1000, 800);
        const a = runPsfAttribution(baseInput({ psfField: makePsfField(fits), distortionModel: model }));
        expect(a.centroids).not.toBeNull();
        expect(a.centroids!.modelProvenance).toBe('INJECTED_SOLVE');
        const [center, corner] = a.centroids!.stars;
        // center of frame (~499.5,399.5) barely shifts
        expect(Math.hypot(center.xUndist! - center.xNative, center.yUndist! - center.yNative)).toBeLessThan(1);
        // an off-center star shifts measurably under the k1=0.12 distortion
        expect(Math.hypot(corner.xUndist! - corner.xNative, corner.yUndist! - corner.yNative)).toBeGreaterThan(1);
    });

    it('no resolvable model (placeholder lens, no injection) ⇒ native only, honest provenance', () => {
        const a = runPsfAttribution(baseInput({
            psfField: makePsfField(fits),
            metadata: makeMeta({ lens_model: 'Unknown Lens' }),
        }));
        expect(a.centroids!.stars[0].xUndist).toBeNull();
        expect(['NONE', 'SIP_PRESENT_UNAPPLIED']).toContain(a.centroids!.modelProvenance);
    });
});

// ══════════════ CELL ⑥ — sky_deprojected (flag-gated, additive) ══════════════
describe('CELL ⑥ — sky_deprojected null by default, populated under PSF_JACOBIAN_DEPROJECT', () => {
    it('flag OFF (default): skyDeprojected is null (byte-identical)', () => {
        const a = runPsfAttribution(baseInput());
        expect(a.skyDeprojected).toBeNull();
    });
    it('flag ON: reports sky FWHM alongside raw px (isotropic CD ⇒ arcsec = px·scale)', async () => {
        vi.stubEnv('PSF_JACOBIAN_DEPROJECT', '1');
        vi.resetModules();
        const { runPsfAttribution: fn } = await import('../pipeline/stages/psf_attribution');
        const s = 2.0 / 3600;
        const sol = { ...makeSolution(), wcs: { crpix: [500, 400], crval: [17.3333, 20], cd: [[-s, 0], [0, s]] } } as PlateSolution;
        const a = fn({ psfField: makePsfField([]), solution: sol, metadata: makeMeta(), imageWidth: 1000, imageHeight: 800, timestampTrusted: true });
        expect(a.skyDeprojected).not.toBeNull();
        expect(a.skyDeprojected!.fwhmMajPx).toBe(3.0);                 // raw px alongside
        expect(a.skyDeprojected!.fwhmMajArcsec).toBeCloseTo(6.0, 2);   // 3px × 2 arcsec/px (isotropic)
        expect(['WCS_CD', 'SYNTHESIZED_CD']).toContain(a.skyDeprojected!.jacobianSource);
    });
});
