/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * UNIT CONVERTER â€” Astronomical & Mathematical Tools
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Centralized utility for converting between RA (Hours), Degrees, Arcseconds,
 * and Radians. Eliminates magic numbers (15, 3600, PI/180) from the pipeline.
 */

export class UnitConverter {
    // â”€â”€â”€ CONSTANTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    
    public static readonly DEG2RAD = Math.PI / 180;
    public static readonly RAD2DEG = 180 / Math.PI;
    public static readonly RAD2ARCSEC = 206264.806;
    public static readonly ARCSEC_PER_RAD = 206264.806;
    
    /** 1 Hour of RA = 15 Degrees */
    public static readonly H2DEG = 15;
    public static readonly DEG2H = 1 / 15;
    
    /** 1 Degree = 3600 Arcseconds */
    public static readonly DEG2ARCSEC = 3600;
    public static readonly ARCSEC2DEG = 1 / 3600;

    // â”€â”€â”€ METHODS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /** Convert RA in Hours (0-24) to Degrees (0-360) */
    public static hoursToDeg(hours: number): number {
        return hours * this.H2DEG;
    }

    /** Convert Degrees (0-360) to RA in Hours (0-24) */
    public static degToHours(deg: number): number {
        // Standard astronomical wrap for RA
        return ((deg * this.DEG2H) % 24 + 24) % 24;
    }

    /** Convert Degrees to Radians */
    public static degToRad(deg: number): number {
        return deg * this.DEG2RAD;
    }

    /** Convert Radians to Degrees */
    public static radToDeg(rad: number): number {
        return rad * this.RAD2DEG;
    }

    /** Kilometers to Astronomical Units */
    public static kmToAu(km: number): number {
        return km / 149597870.7;
    }


    /** Convert RA Hours to Radians */
    public static hoursToRad(hours: number): number {
        return this.degToRad(this.hoursToDeg(hours));
    }

    /** Convert Radians to RA Hours */
    public static radToHours(rad: number): number {
        return this.degToHours(this.radToDeg(rad));
    }

    /** Convert Arcseconds to Degrees */
    public static arcsecToDeg(arcsec: number): number {
        return arcsec * this.ARCSEC2DEG;
    }

    /** Convert Degrees to Arcseconds */
    public static degToArcsec(deg: number): number {
        return deg * this.DEG2ARCSEC;
    }

    /** 
     * Calculate Angular Scale in arcsec/pixel.
     * @param fovDeg Total Field of View in degrees
     * @param pixels Total Pixels in that axis
     */
    public static calculatePixelScale(fovDeg: number, pixels: number): number {
        if (pixels <= 0) return 0;
        return (fovDeg * this.DEG2ARCSEC) / pixels;
    }
}

