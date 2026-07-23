import { describe, it, expect } from 'vitest';
import { SensorCalibrationManager } from '../core/SensorCalibrationManager';
import { PhotometryManager } from '../pipeline/m8_photometry/photometry_manager';

describe('M2 Calibration Synchronization', () => {

    it('should proactively update PhotometryManager when a calibration strip is set', () => {
        // 1. Initial State
        const initialBlack = 8192;
        PhotometryManager.setProfile({ black_level: initialBlack });
        expect(PhotometryManager.getProfile().black_level).toBe(initialBlack);

        // 2. Simulate Forensic Ingestion (e.g. 2048 for Canon)
        const forensicBlack = 2048;
        const strip = new Uint16Array(100).fill(forensicBlack);
        
        SensorCalibrationManager.setCalibrationStrip(strip);

        // 3. Verify Synchronization
        const profile = PhotometryManager.getProfile();
        expect(profile.black_level).toBe(forensicBlack);
        expect(SensorCalibrationManager.getBlackLevel()).toBe(forensicBlack);
    });
});
