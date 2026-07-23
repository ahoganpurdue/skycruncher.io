/**
 * ATMOSPHERIC PHYSICS â€” M4 Scientific Metrology
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * Role: Domain III [Signal State] â€” State: {GRADIENT_MODELED}
 * 
 * Implements detection and modeling of atmospheric optical effects:
 * - Rayleigh Scattering: Molecular scattering causing blue-sky gradients.
 * - Mie Scattering: Aerosol/dust scattering causing halos (haze).
 * 
 * Phases:
 * 1. Identification: Measure the vertical background gradient. REPORTED ONLY —
 *    it is recorded on each star (rayleigh_index) and returned as
 *    background_level_top/bottom; it does NOT adjust any detection threshold
 *    (verified: the sole consumers are signal_processor's rayleigh_index /
 *    background_level_* fields — no threshold reads it).
 * 2. Correction: Provide restitution factors for photometry (extinction correction).
 */

import { SignalPoint } from '../../types/Main_types';

export class AtmosphericPhysics {

    /**
     * VERTICAL BRIGHTNESS GRADIENT (Integrated Background Scan)
     * Measures a top-vs-bottom luminance gradient of the background.
     *
     * HONEST CAPTION: this is an UNATTRIBUTED vertical brightness gradient. It
     * is NOT evidence of Rayleigh scattering specifically — the same top/bottom
     * slope is produced by light pollution, an altitude gradient, or optical
     * vignetting. The legacy name is retained only to avoid rippling call sites;
     * do not present the result as a measured scattering mechanism.
     *
     * @phase Identification - Measures the vertical slope; REPORTED ONLY, never
     * wired into any detection threshold (it flows to rayleigh_index /
     * background_level_top/bottom, both display/receipt fields).
     */
    public static detectRayleighGradient(lum: Float32Array, w: number, h: number): { top: number, bottom: number } {
        // Robust sampling: Average top and bottom 5% of the frame
        const rowSample = Math.floor(h * 0.05);
        let topSum = 0;
        let bottomSum = 0;
        
        for (let y = 0; y < rowSample; y++) {
            for (let x = 0; x < w; x += 32) {
                topSum += lum[y * w + x];
                bottomSum += lum[(h - 1 - y) * w + x];
            }
        }
        
        const count = rowSample * (w / 32);
        return {
            top: topSum / count,
            bottom: bottomSum / count
        };
    }

    /**
     * MIE SCATTERING PROFILE (Haze Halos)
     * Analyzes the wings of point sources for Mie scattering halos.
     * 
     * @phase Correction - Quantifies halo intensity to subtract from star flux.
     */
    public static analyzeMieScattering(p: SignalPoint, lum: Float32Array, w: number, h: number, avgBackground: number): number {
        const coreRadius = p.fwhm * 1.5;
        const outerRadius = p.fwhm * 4.4; // Slightly wider for halos
        
        let coreFlux = 0, outerFlux = 0;
        let corePixels = 0, outerPixels = 0;
        
        const ix = Math.floor(p.x);
        const iy = Math.floor(p.y);
        const range = Math.ceil(outerRadius);

        for (let dy = -range; dy <= range; dy++) {
            for (let dx = -range; dx <= range; dx++) {
                const tx = ix + dx, ty = iy + dy;
                if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
                
                const d2 = dx*dx + dy*dy;
                const val = lum[ty * w + tx];
                
                if (d2 <= coreRadius * coreRadius) {
                    coreFlux += val; corePixels++;
                } else if (d2 <= outerRadius * outerRadius) {
                    outerFlux += val; outerPixels++;
                }
            }
        }
        
        const netCore = Math.max(0, coreFlux - (corePixels * avgBackground));
        const netOuter = Math.max(0, outerFlux - (outerPixels * avgBackground));

        if (netCore < 0.01) return 0; 
        return netOuter / (netCore + 1e-6);
    }
}
