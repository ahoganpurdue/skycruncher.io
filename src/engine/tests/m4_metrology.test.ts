import { describe, it, expect } from 'vitest';
import { AtmosphericPhysics } from '../pipeline/m4_signal_detect/AtmosphericPhysics';
import { TerrestrialEnvironment } from '../pipeline/m4_signal_detect/TerrestrialEnvironment';
import { SignalPoint } from '../types/Main_types';

describe('M4 Atmospheric Metrology', () => {
    
    it('should detect a Rayleigh scattering gradient profile', () => {
        const w = 128, h = 128;
        const lum = new Float32Array(w * h).fill(0.1);
        // Create a fake gradient (bright bottom, dark top)
        for(let y=0; y<h; y++) {
            for(let x=0; x<w; x++) {
                lum[y * w + x] = (y / h) * 0.5;
            }
        }

        const profile = AtmosphericPhysics.detectRayleighGradient(lum, w, h);
        expect(profile.top).toBeLessThan(profile.bottom);
        expect(profile.top).toBeCloseTo(0.0125, 2); // Average of top 5%
        expect(profile.bottom).toBeCloseTo(0.4875, 2); // Average of bottom 5%
    });

    it('should identify Mie scattering halos around stars', () => {
        const w = 100, h = 100;
        const lum = new Float32Array(w * h).fill(0.01);
        const cx = 50, cy = 50;
        
        // Inject a "hazy" star (Mie scattering)
        // Point source
        lum[cy * w + cx] = 1.0;
        // Wide halo
        for(let dy=-10; dy<=10; dy++) {
            for(let dx=-10; dx<=10; dx++) {
                const tx = cx + dx, ty = cy + dy;
                if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
                const d2 = dx*dx + dy*dy;
                if (d2 > 4 && d2 < 100) {
                    lum[ty * w + tx] += 0.2;
                }
            }
        }

        const star: SignalPoint = {
            id: 1, x: cx, y: cy, rawX: cx, rawY: cy,
            flux: 10, peak: 1.0, peak_value: 1.0,
            fwhm: 2.0, circularity: 1.0, ellipticity: 0, theta: 0, snr: 50
        };

        const mieIndex = AtmosphericPhysics.analyzeMieScattering(star, lum, w, h, 0.01);
        // Hazy star should have high index
        expect(mieIndex).toBeGreaterThan(0.5);
    });

    it('should identify clean stars with low Mie index', () => {
        const w = 100, h = 100;
        const lum = new Float32Array(w * h).fill(0.01);
        const cx = 50, cy = 50;
        
        // Inject a "clean" star
        lum[cy * w + cx] = 1.0;
        lum[(cy+1)*w + (cx)] = 0.5;
        lum[(cy-1)*w + (cx)] = 0.5;

        const star: SignalPoint = {
            id: 2, x: cx, y: cy, rawX: cx, rawY: cy,
            flux: 2.0, peak: 1.0, peak_value: 1.0,
            fwhm: 1.5, circularity: 1.0, ellipticity: 0, theta: 0, snr: 100
        };

        const mieIndex = AtmosphericPhysics.analyzeMieScattering(star, lum, w, h, 0.01);
        // Clean star should have low index
        expect(mieIndex).toBeLessThan(0.2);
    });

    it('should identify light pollution regions', () => {
        const w = 100, h = 100;
        const lum = new Float32Array(w * h).fill(0.05);
        const lp = TerrestrialEnvironment.profileLightPollution(lum, w, h);
        expect(lp).toBeCloseTo(0.05, 3);
    });
});
