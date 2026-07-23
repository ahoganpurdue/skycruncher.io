import { describe, it, expect } from 'vitest';
import { SENSOR_DB, findSensorByCamera, getGainForSetting } from '../pipeline/m2_hardware/sensor_db';
import { computePixelScale } from '../pipeline/m2_hardware/hardware_adapter';

describe('M2 SeeStar S30 Pro (IMX585) device profile', () => {

    it('resolves the IMX585 profile from the FITS CREATOR string', () => {
        const profile = findSensorByCamera('ZWO Seestar S30 Pro');
        expect(profile).not.toBeNull();
        expect(profile!.sensor_model).toBe('Sony IMX585');
        expect(profile!.pixel_size_um).toBe(2.9);
        expect(profile!.bayer_pattern).toBe('GRBG');
        expect(profile!.resolution).toEqual({ width: 3840, height: 2160 });
    });

    it('resolves the IMX585 profile from the FITS INSTRUME string', () => {
        const profile = findSensorByCamera('imx585');
        expect(profile).not.toBeNull();
        expect(profile!.sensor_model).toBe('Sony IMX585');
    });

    it('converts ZWO gain setting 200 to ~0.0406 e-/16-bit-ADU', () => {
        const profile = SENSOR_DB['IMX585'];
        const gain = getGainForSetting(profile, 200);
        expect(gain).not.toBeNull();
        // 0.65 e-/ADU native (12-bit) / 2^4 bit expansion = 0.040625
        expect(Math.abs(gain! - 0.0406)).toBeLessThan(0.002);
    });

    it('interpolates between calibration points and clamps at the endpoints', () => {
        const profile = SENSOR_DB['IMX585'];
        // Setting 150 is halfway between 100 (2.0 native) and 200 (0.65 native)
        expect(getGainForSetting(profile, 150)).toBeCloseTo(1.325 / 16, 6);
        // Clamped to the curve endpoints
        expect(getGainForSetting(profile, -50)).toBeCloseTo(6.55 / 16, 6);
        expect(getGainForSetting(profile, 900)).toBeCloseTo(0.31 / 16, 6);
    });

    it('returns null for profiles without a gain curve', () => {
        expect(getGainForSetting(SENSOR_DB['IMX571'], 200)).toBeNull();
    });

    it('computes the SeeStar pixel scale from FL=160mm and 2.9um pixels', () => {
        const scale = computePixelScale(160, 2.9);
        expect(Math.abs(scale - 3.7386)).toBeLessThan(0.001);
    });
});
