
/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * STAR PHOTOMETRIST â€” The science Grade Measure
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Performs detailed morphological and photometric analysis on raw stamps.
 * 
 * METHODS:
 * 1. Background Sigma-Clipping
 * 2. Barycentric Centroiding (Flux-Weighted Center of Mass)
 * 3. 2nd Order Moments (Covariance Matrix) -> FWHM, Ellipticity, Theta
 * 4. Aperture Photometry (Sum within radius)
 */

import { StarMeasurement } from '../../types/Main_types';

export class StarPhotometrist {

    /**
     * Measure a star from a raw pixel stamp.
     * @param stamp Float32Array containing raw pixel data (assumed Row-Major)
     * @param width Width of the stamp
     * @param height Height of the stamp
     * @param gain Optional gain (e/ADU) to calculate error
     */
    public static measure(
        stamp: Float32Array,
        width: number,
        height: number,
        offsetX: number = 0,
        offsetY: number = 0,
        gain: number = 1.0
    ): StarMeasurement {
        // 1. Establish Background Level (Sigma Clipped)
        const { bg, sigma } = this.estimateBackground(stamp);
        
        let sumFlux = 0;
        let sumX = 0;
        let sumY = 0;
        
        // Use a threshold to exclude noise from moments
        const threshold = bg + 2.0 * sigma;
        const centerX = width / 2;
        const centerY = height / 2;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const val = stamp[idx];
                
                // Centroiding (Flux-Weighted Center of Mass)
                if (val > threshold) {
                    const flux = val - bg;
                    sumFlux += flux;
                    sumX += x * flux;
                    sumY += y * flux;
                }
            }
        }

        if (sumFlux <= 0) {
            // Failed measurement
            return {
                x: centerX + offsetX, 
                y: centerY + offsetY, 
                flux: 0, 
                fwhm: 0, 
                circularity: 0,
                theta: 0
            };
        }

        const lcx = sumX / sumFlux; // Local centroid X
        const lcy = sumY / sumFlux; // Local centroid Y

        // Second Pass: Moments relative to Centroid
        let sumX2 = 0;
        let sumY2 = 0;
        let sumXY = 0;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const val = stamp[idx];
                
                if (val > threshold) {
                    const flux = val - bg;
                    const dx = x - lcx;
                    const dy = y - lcy;
                    sumX2 += flux * dx * dx;
                    sumY2 += flux * dy * dy;
                    sumXY += flux * dx * dy;
                }
            }
        }

        const mxx = sumX2 / sumFlux;
        const myy = sumY2 / sumFlux;
        const mxy = sumXY / sumFlux;

        // FWHM & Ellipticity from Eigenvalues of Covariance Matrix
        const trace = mxx + myy;
        const det = mxx * myy - mxy * mxy;
        const root = Math.sqrt(Math.max(0, trace * trace - 4 * det)); 
        
        const l1 = (trace + root) / 2; // Major axis variance
        const l2 = (trace - root) / 2; // Minor axis variance
        
        const sigmaMajor = Math.sqrt(l1);
        const sigmaMinor = Math.sqrt(l2);
        
        const fwhm = 2.355 * sigmaMajor; 
        const circularity = sigmaMajor > 0 ? sigmaMinor / sigmaMajor : 0;
        
        // Theta calculation (coma rotation angle)
        let theta = 0.5 * Math.atan2(2 * mxy, mxx - myy); // Radians
        const thetaDeg = theta * (180 / Math.PI); // Degrees

        // Final Pass: Total Flux (Circular Aperture)
        // We capture the "wings" by summing within a radius based on FWHM
        const apertureRadius = Math.max(3, fwhm * 1.5); 
        const r2 = apertureRadius * apertureRadius;
        let totalFlux = 0;

        for (let y = 0; y < height; y++) {
            const dy = y - lcy;
            const dy2 = dy * dy;
            if (dy2 > r2) continue;

            for (let x = 0; x < width; x++) {
                const dx = x - lcx;
                const d2 = dx * dx + dy2;
                if (d2 <= r2) {
                    totalFlux += (stamp[y * width + x] - bg);
                }
            }
        }

        return {
            x: lcx + offsetX, // Map to Global Coordinates
            y: lcy + offsetY,
            flux: totalFlux, // Total Flux from Aperture
            fwhm: fwhm,
            circularity: circularity,
            theta: thetaDeg
        };
    }

    private static estimateBackground(data: Float32Array): { bg: number; sigma: number } {
        // Remove artificial memory limit. 
        // Use striding for large arrays to maintain performance.
        const stride = data.length > 10000 ? 4 : 1;
        const sampleSize = Math.floor(data.length / stride);
        const samples = new Float32Array(sampleSize);
        
        for (let i = 0, j = 0; i < data.length; i += stride, j++) {
            samples[j] = data[i];
        }

        const sorted = samples.slice().sort();
        const median = sorted[Math.floor(sorted.length / 2)];
        
        // MAD Calculation
        const absDevs = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
            absDevs[i] = Math.abs(samples[i] - median);
        }
        absDevs.sort();
        const mad = absDevs[Math.floor(absDevs.length / 2)];
        
        return { 
            bg: median, 
            sigma: 1.4826 * mad 
        };
    }
}

