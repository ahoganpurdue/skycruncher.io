/**
 * SENSOR CALIBRATION MANAGER
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * Centralized registry for per-frame sensor physics and spectral profiles.
 * Extracts "Sensor Black" baseline from RAW margins and "Sky Profile" from
 * Rayleigh gradients.
 */
import { PhotometryManager } from '../pipeline/m8_photometry/photometry_manager';

export interface SpectralProfile {
    r: number;
    g: number;
    b: number;
    magnitude: number;
}

export class SensorCalibrationManager {
    private static blackLevel: number = 0;
    private static blackStdDev: number = 0;
    private static skyProfile: SpectralProfile | null = null;
    
    // Future Expansion: Calibration Frame Buffers
    private static masterDark: Float32Array | null = null;
    private static masterFlat: Float32Array | null = null;
    
    /**
     * UPLOAD MASTER DARK (Dummy Hook)
     * Future functionality to subtract thermal/fixed-pattern noise.
     */
    public static setMasterDark(data: Float32Array) {
        this.masterDark = data;
        console.log(`[SensorCalibration] Master Dark uploaded (${data.length} pixels).`);
    }

    /**
     * UPLOAD MASTER FLAT (Dummy Hook)
     * Future functionality to correct dust motes and vignetting via division.
     */
    public static setMasterFlat(data: Float32Array) {
        this.masterFlat = data;
        console.log(`[SensorCalibration] Master Flat uploaded (${data.length} pixels).`);
    }

    public static getMasterDark(): Float32Array | null { return this.masterDark; }
    public static getMasterFlat(): Float32Array | null { return this.masterFlat; }
    
    /**
     * INGEST CALIBRATION STRIP
     * Computes the absolute noise floor from optical black pixels.
     */
    public static setCalibrationStrip(strip: Uint16Array) {
        if (strip.length === 0) return;
        
        let sum = 0;
        for (let i = 0; i < strip.length; i++) sum += strip[i];
        this.blackLevel = sum / strip.length;
        
        let sqSum = 0;
        for (let i = 0; i < strip.length; i++) {
            const diff = strip[i] - this.blackLevel;
            sqSum += diff * diff;
        }
        this.blackStdDev = Math.sqrt(sqSum / strip.length);
        
        console.log(`[SensorCalibration] Black Level: ${this.blackLevel.toFixed(2)}, Noise (Ïƒ): ${this.blackStdDev.toFixed(2)}`);
        
        // [SYNC] Proactively update the Photometry profile with the forensic black level
        // This ensures subsequent demosaic/binning steps use the correct sensor baseline.
        PhotometryManager.setProfile({ black_level: this.blackLevel });
    }

    /**
     * ESTABLISH SKY PROFILE
     * Stores the spectral signature of the Rayleigh sky for color-distanced masking.
     */
    public static setSkyProfile(r: number, g: number, b: number) {
        const mag = Math.sqrt(r*r + g*g + b*b) + 1e-6;
        this.skyProfile = { r: r/mag, g: g/mag, b: b/mag, magnitude: mag };
    }

    public static getBlackLevel(): number { return this.blackLevel; }
    public static getBlackStdDev(): number { return this.blackStdDev; }
    public static getSkyProfile(): SpectralProfile | null { return this.skyProfile; }

    /**
     * SPECTRAL DISTANCE
     * Measures how "Sky-like" or "Black-like" a pixel is.
     * Higher value = closer to Sky Profile.
     */
    public static getSkyLikelihood(r: number, g: number, b: number): number {
        if (!this.skyProfile) return 0.5; // Neutral if no profile set
        
        const mag = Math.sqrt(r*r + g*g + b*b) + 1e-6;
        const nr = r/mag, ng = g/mag, nb = b/mag;
        
        const dist = Math.sqrt(
            Math.pow(nr - this.skyProfile.r, 2) +
            Math.pow(ng - this.skyProfile.g, 2) +
            Math.pow(nb - this.skyProfile.b, 2)
        );
        
        // Return inverse distance (1.0 = perfect match, 0.0 = opposite)
        return Math.max(0, 1.0 - dist);
    }
}
