/**
 * ANNULUS METROLOGY â€” M8 Scientific Photometry
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * Role: Domain III [Signal State] â€” State: {INSTRUMENTAL_NOISE_CHARACTERIZED}
 * 
 * Implements Annulus Analysis (Aperture Photometry) to characterize 
 * instrumental noise and local background levels.
 * 
 * Framework:
 * 1. Aperture (Radius r1): Contains the star signal.
 * 2. Dead Zone (r1 to r2): Buffer to avoid star wings bleeding into sky.
 * 3. Annulus (r2 to r3): Ring containing "pure sky" for background sampling.
 */

import { SignalPoint } from '../../types/Main_types';
import { PhotometryManager } from './photometry_manager';

export interface NoiseProfile {
    skyBackground_e: number;    // Average background in electrons
    skySigma_e: number;         // Standard deviation of background in electrons
    totalError_e: number;       // Combined photometric error (sigma_total)
    snr: number;                // Scientifically derived SNR
}

export class AnnulusMetrology {

    /**
     * CALCULATE LOCAL NOISE
     * Perfroms an annulus sampling around a point source to estimate noise floor.
     * 
     * @param star The detected signal point
     * @param lum Normalized luminance buffer (0.0 - 1.0)
     * @param w Image width
     * @param h Image height
     */
    public static calculateLocalNoise(
        star: SignalPoint, 
        lum: Float32Array, 
        w: number, 
        h: number,
        r1: number = 3.5,  // Aperture radius
        r2: number = 5.0,  // Inner annulus radius (buffer)
        r3: number = 8.0   // Outer annulus radius
    ): NoiseProfile {
        const profile = PhotometryManager.getProfile();
        const gain = profile.gain_e_adu;
        const rn2 = profile.read_noise_e ** 2;
        const range = profile.white_level - profile.black_level;

        let skySum_e = 0;
        let skySqSum_e = 0;
        let n_sky = 0;

        const startX = Math.floor(star.x - r3);
        const endX = Math.ceil(star.x + r3);
        const startY = Math.floor(star.y - r3);
        const endY = Math.ceil(star.y + r3);

        // 1. Sample the Annulus (Pure Sky)
        for (let y = startY; y <= endY; y++) {
            if (y < 0 || y >= h) continue;
            for (let x = startX; x <= endX; x++) {
                if (x < 0 || x >= w) continue;

                const dx = x - star.x;
                const dy = y - star.y;
                const dist2 = dx * dx + dy * dy;

                // If pixel is inside the annulus (r2 to r3)
                if (dist2 >= r2 * r2 && dist2 <= r3 * r3) {
                    const val_e = lum[y * w + x] * range * gain;
                    skySum_e += val_e;
                    skySqSum_e += val_e * val_e;
                    n_sky++;
                }
            }
        }

        if (n_sky === 0) return { skyBackground_e: 0, skySigma_e: 0, totalError_e: 0, snr: 0 };

        const skyMean_e = skySum_e / n_sky;
        const skyVariance_e = (skySqSum_e / n_sky) - (skyMean_e * skyMean_e);
        const skySigma_e = Math.sqrt(Math.max(0, skyVariance_e));

        // 2. Calculate Total Photometric Error using the CCD Equation
        // Signal is the integrated flux in the aperture (Area A)
        const n_pix = Math.PI * r1 * r1;
        const signal_e = star.flux * gain; // Assumes star.flux is already integrated ADUs

        // Total Noise Equation: 
        // sigma = sqrt( Signal + n_pix*(1 + n_pix/n_sky) * (Sky + RN^2) )
        // Note: We use dark current = 0 until dark frames are implemented.
        const skyAndReadNoise = skyMean_e + rn2;
        const backgroundComponent = n_pix * (1 + n_pix / n_sky) * skyAndReadNoise;
        const totalError_e = Math.sqrt(Math.max(0, signal_e + backgroundComponent));

        const snr = totalError_e > 0 ? (signal_e / totalError_e) : 0;

        return {
            skyBackground_e: skyMean_e,
            skySigma_e,
            totalError_e,
            snr
        };
    }
}
