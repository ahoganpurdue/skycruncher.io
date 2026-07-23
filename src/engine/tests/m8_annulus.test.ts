import { describe, it, expect, beforeEach } from 'vitest';
import { AnnulusMetrology } from '../pipeline/m8_photometry/AnnulusMetrology';
import { SignalPoint } from '../types/Main_types';
import { PhotometryManager } from '../pipeline/m8_photometry/photometry_manager';

// Canonical T6 sensor profile: 14-bit sensor, full range 0..16383 ADU, gain 0.5 e-/ADU
// star.flux=50000 ADU -> signal_e = 25000. sky=0.1*16383*0.5= ~819 e-. SNR >> 10.
const TEST_PROFILE = { gain_e_adu: 0.5, read_noise_e: 5.0, black_level: 0, white_level: 16383 };

// Deterministic PRNG — the original test used the un-seeded Math.random(), which made
// the noise irreproducible and forced a wide "> 0" acceptance window. Seeding lets us
// assert against the ANALYTIC sky background and noise.
function mulberry32(seed: number) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('M8 Annulus Metrology', () => {

    beforeEach(() => {
        PhotometryManager.setProfile(TEST_PROFILE);
    });

    it('recovers the analytic sky background (~819 e-) and injected noise (~47 e-)', () => {
        const w = 50, h = 50;
        const lum = new Float32Array(w * h);
        const cx = 25, cy = 25;

        // Background 0.1 (normalized) + uniform noise on [-0.01, +0.01], seeded.
        const rand = mulberry32(12345);
        for (let i = 0; i < lum.length; i++) {
            lum[i] = 0.1 + (rand() * 0.02 - 0.01);
        }

        const star: SignalPoint = {
            id: 1, x: cx, y: cy, rawX: cx, rawY: cy,
            // flux = integrated ADU in aperture. High value to ensure SNR > 10.
            flux: 50000, peak: 1.0, peak_value: 1.0,
            fwhm: 2.0, circularity: 1.0, ellipticity: 0, theta: 0, snr: 50
        } as any;

        const profile = AnnulusMetrology.calculateLocalNoise(star, lum, w, h);

        // Analytic sky background: 0.1 · (white_level-black_level) · gain
        //   = 0.1 · 16383 · 0.5 = 819.15 e-  (seeded sample lands at ~819.7).
        // A stub returning a constant skyBackground_e (e.g. 1) fails this band.
        expect(profile.skyBackground_e).toBeGreaterThan(805);
        expect(profile.skyBackground_e).toBeLessThan(834);
        // Analytic noise from a uniform[-0.01,0.01] amplitude:
        //   σ = (0.02/√12) · 16383 · 0.5 = 47.29 e-  (seeded sample ~48.3).
        // A stub returning skySigma_e ≈ 1e-9 fails this band.
        expect(profile.skySigma_e).toBeGreaterThan(40);
        expect(profile.skySigma_e).toBeLessThan(55);
        expect(profile.snr).toBeGreaterThan(10);
    });

    it('should return 0 SNR for no-signal inputs', () => {
        const w = 50, h = 50;
        const lum = new Float32Array(w * h).fill(0.1);
        const star: SignalPoint = {
            id: 2, x: 25, y: 25, rawX: 25, rawY: 25,
            flux: 0, peak: 0, peak_value: 0,
            fwhm: 2.0, circularity: 1.0, ellipticity: 0, theta: 0, snr: 0
        };

        const profile = AnnulusMetrology.calculateLocalNoise(star, lum, w, h);
        expect(profile.snr).toBe(0);
    });

});
