/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * PHOTOMETRY MANAGER â€” Sensor Physics & Signal Analysis
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Centralized service for precise photometric calculations, sensor noise 
 * modeling (Poisson + Gaussian), and instrumental magnitude normalization.
 */

export interface SensorProfile {
    make?: string;
    model?: string;
    gain_e_adu: number;
    read_noise_e: number;
    black_level: number;
    white_level: number;
    bit_depth: number;
    pixel_size_um: number;
}

export class PhotometryManager {
    /** 
     * Default profile based on standard APS-C CMOS (e.g. Canon T6)
     * Values for ISO 800 - 1600 typical range.
     */
    private static currentProfile: SensorProfile = {
        make: 'Generic',
        model: 'APS-C CMOS',
        gain_e_adu: 0.5,      // ~0.5 electrons per ADU at ISO 1600
        read_noise_e: 2.5,   // ~2.5e- RMS read noise
        black_level: 8192,   // [FIX] 16-bit expanded (14-bit 2048 * 4)
        white_level: 61440,  // [FIX] 16-bit expanded (14-bit 15360 * 4)
        bit_depth: 16,
        pixel_size_um: 4.3
    };

    /**
     * Map ISO to Gain (e-/ADU) for common Canon sensors.
     * This is a simplified linear-reciprocal model.
     */
    public static getGainForISO(iso: number): number {
        if (iso <= 0) return 0.5; // Fallback
        // Example for Canon T6: ISO 100 ~ 8.0, ISO 1600 ~ 0.5
        return 8.0 / (iso / 100);
    }

    /**
     * Set the active sensor profile from metadata.
     */
    public static setProfile(profile: Partial<SensorProfile>) {
        this.currentProfile = { ...this.currentProfile, ...profile };
    }

    public static getProfile(): SensorProfile {
        return this.currentProfile;
    }

    // â”€â”€â”€ SIGNAL PROCESSING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Convert raw ADU to normalized Float (0.0 - 1.0).
     * Handles bit-depth expansion (e.g. 14-bit to 16-bit space).
     */
    public static aduToNormalized(adu: number): number {
        // Bit depth normalization: (adu - black) / (white - black)
        const range = this.currentProfile.white_level - this.currentProfile.black_level;
        const val = (adu - this.currentProfile.black_level) / range;
        return Math.max(0, Math.min(1.0, val));
    }

    /**
     * Calculate Signal-to-Noise Ratio (SNR) using the simplified CCD equation.
     * SNR = Signal_e / sqrt(Signal_e + Background_e + ReadNoise^2)
     * 
     * @param signalNorm - Integrated flux above background (normalized 0-1)
     * @param bgNorm - Local background level (normalized 0-1 per pixel)
     * @param areaPixels - Integration area (N pixels)
     */
    public static calculateSNR(signalNorm: number, bgNorm: number, areaPixels: number): number {
        const gain = this.currentProfile.gain_e_adu;
        const rn2 = this.currentProfile.read_noise_e ** 2;
        const range = this.currentProfile.white_level - this.currentProfile.black_level;

        // Convert normalized (0-1) back to ADUs for physical modeling
        const signalADU = signalNorm * range;
        const bgADU = bgNorm * range;

        const signal_e = signalADU * gain;
        const bg_e = bgADU * gain * areaPixels;
        // Total noise = Poisson noise from signal + Poisson noise from background + Read Noise
        const total_noise_e = Math.sqrt(Math.max(0, signal_e + bg_e + (rn2 * areaPixels)));

        if (total_noise_e === 0) return 0;
        return signal_e / total_noise_e;
    }

    /**
     * Determine the recommended detection threshold (sigma) based on noise floor.
     * Higher read noise or thermal background requires a stricter threshold.
     */
    public static getRecommendedThreshold(bgADU: number, areaPixels: number): number {
        // Simple scaling: if noise is high, push from 3 to 5 sigma
        const profile = this.currentProfile;
        const noise_e = Math.sqrt((bgADU * profile.gain_e_adu) + profile.read_noise_e ** 2);
        
        if (noise_e > 20) return 6.5; // Very noisy
        if (noise_e > 10) return 5.0; // High noise
        return 3.5; // Clean signal
    }

    // â”€â”€â”€ PHOTOMETRY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Calculate instrumental magnitude.
     * m = -2.5 * log10(Flux_e / Exposure) + ZeroPoint
     */
    public static calculateInstrumentalMagnitude(
        signalNorm: number, 
        exposureTime: number = 1.0,
        aperture: number = 1.0
    ): number {
        const profile = this.currentProfile;
        const range = profile.white_level - profile.black_level;
        
        // Convert normalized (0-1) back to ADUs
        const signalADU = signalNorm * range;
        const signal_e = signalADU * profile.gain_e_adu;
        
        if (signal_e <= 0) return 20; // Limit for faint/invalid

        // Normalize signal by exposure. Aperture is currently unused but kept for parity.
        const rate = signal_e / (exposureTime || 1);
        return -2.5 * Math.log10(rate);
    }

    /**
     * CHARACTERIZE INSTRUMENTAL NOISE (Dormant Hook)
     * Performs annulus analysis for high-precision photometric error estimation.
     */
    public static characterizeInstrumentalNoise(
        star: any, 
        lum: Float32Array, 
        w: number, 
        h: number
    ) {
        // Initial setup: This function is currently dormant to allow for 
        // testing in parallel with existing SNR logic.
        // const profile = AnnulusMetrology.calculateLocalNoise(star, lum, w, h);
        // return profile;
        return null; 
    }
}

