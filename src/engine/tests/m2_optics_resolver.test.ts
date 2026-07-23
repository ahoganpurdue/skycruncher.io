import { describe, it, expect } from 'vitest';
import { computeScaleFromOptics, resolveOpticsFromExif } from '../pipeline/m2_hardware/optics_resolver';
import { HardMetadata } from '../types/schema';

/** Minimal valid HardMetadata with test overrides. */
function makeHard(overrides: Partial<HardMetadata>): HardMetadata {
    return {
        camera_model: '',
        lens_model: '',
        focal_length: 0,
        aperture: 0,
        iso_gain: 0,
        exposure_time: 0,
        timestamp: '2019-06-03T06:44:07Z',
        gps_lat: 0,
        gps_lon: 0,
        ...overrides
    };
}

describe('M2 optics resolver (B2: EXIF-derived pixel scale)', () => {

    it('computes the Canon 4.3um @ 50mm scale (206.265 * pitch / FL)', () => {
        // 206.265 * 4.3 / 50 = 17.7388 "/px
        const scale = computeScaleFromOptics(50, 4.3);
        expect(Math.abs(scale - 17.74)).toBeLessThan(0.01);
    });

    it('matches the fits_decoder computePixelScale formula (SeeStar 160mm / 2.9um)', () => {
        // Reference value asserted in m2_seestar_profile.test.ts: 3.7386 "/px
        const scale = computeScaleFromOptics(160, 2.9);
        expect(Math.abs(scale - 3.7386)).toBeLessThan(0.001);
    });

    it('resolves a Canon EOS Rebel T6 at 50mm from the sensor DB', () => {
        const resolved = resolveOpticsFromExif(makeHard({
            camera_model: 'Canon EOS Rebel T6',
            lens_model: 'Canon EF 50mm f/1.8 STM', // real lens: no dummy-50mm override
            focal_length: 50
        }));
        expect(resolved).not.toBeNull();
        expect(resolved!.source).toBe('EXIF_SENSOR_DB');
        expect(resolved!.pixel_pitch_um).toBeCloseTo(4.30, 2);
        expect(Math.abs(resolved!.pixel_scale - 17.74)).toBeLessThan(0.01);
    });

    it('returns null when the focal length is missing or non-positive', () => {
        expect(resolveOpticsFromExif(makeHard({
            camera_model: 'Canon EOS Rebel T6',
            focal_length: 0
        }))).toBeNull();
        expect(resolveOpticsFromExif(makeHard({
            camera_model: 'Canon EOS Rebel T6',
            focal_length: undefined as unknown as number
        }))).toBeNull();
    });

    it('returns null for a camera with no sensor profile', () => {
        expect(resolveOpticsFromExif(makeHard({
            camera_model: 'Kodak DC290 Zoom',
            lens_model: 'Fixed',
            focal_length: 38
        }))).toBeNull();
    });

    it('returns null for an empty camera model (would substring-match every profile)', () => {
        expect(resolveOpticsFromExif(makeHard({
            camera_model: '   ',
            lens_model: 'Some Lens',
            focal_length: 50
        }))).toBeNull();
    });

    it('resolves the SeeStar S30 Pro to its 2.9um IMX585 pitch', () => {
        const resolved = resolveOpticsFromExif(makeHard({
            camera_model: 'ZWO Seestar S30 Pro',
            lens_model: 'Seestar',
            focal_length: 160
        }));
        expect(resolved).not.toBeNull();
        expect(resolved!.pixel_pitch_um).toBeCloseTo(2.9, 3);
        expect(Math.abs(resolved!.pixel_scale - 3.7386)).toBeLessThan(0.001);
    });

    it('routes the dummy-50mm manual-lens pattern through the 14mm override', () => {
        // The bundled sample_observation.cr2 ground truth: Rebel T6, FL "50mm",
        // NO lens model, f/0 — OpticsManager treats this as a manual 14mm lens.
        const resolved = resolveOpticsFromExif(makeHard({
            camera_model: 'Canon EOS Rebel T6',
            lens_model: '',
            focal_length: 50
        }));
        expect(resolved).not.toBeNull();
        // 206.265 * 4.3 / 14 = 63.35 "/px (ultra-wide), NOT 17.74
        expect(Math.abs(resolved!.pixel_scale - 63.35)).toBeLessThan(0.01);
    });
});
