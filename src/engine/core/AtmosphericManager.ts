import { UnitConverter } from './UnitConverter';
import { TimeService } from './TimeService';

/**
 * ATMOSPHERIC MANAGER â€” The "Physical Reality" of the Sky
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Centralizes all logic related to how Earth's atmosphere affects light.
 * - Air Mass (Kasten & Young model)
 * - Rayleigh Scattering / Extinction
 * - Zenith Correction (linear flux restoration)
 * - Cronos Check (Time/Horizon validation)
 */
export class AtmosphericManager {
    
    // Sea-level Rayleigh optical depth at zenith per channel (Allen's, 4th ed.)
    private static readonly TAU_ZENITH_R = 0.044;  // ~620nm
    private static readonly TAU_ZENITH_G = 0.098;  // ~530nm
    private static readonly TAU_ZENITH_B = 0.235;  // ~450nm

    /**
     * Calculate atmospheric Air Mass from altitude angle (Kasten & Young, 1989).
     * Accurate down to the horizon.
     */
    public static computeAirMass(altitudeDeg: number): number {
        if (altitudeDeg <= 0) return 40; // Object below horizon, cap at max
        if (altitudeDeg >= 90) return 1.0;

        const a = altitudeDeg;
        const rad = UnitConverter.degToRad(a);
        return 1.0 / (Math.sin(rad) + 0.50572 * Math.pow(6.07995 + a, -1.6364));
    }

    /**
     * Compute per-channel extinction in magnitudes (Î”m = Ï„ Ã— X).
     */
    public static rayleighExtinction(airMass: number) {
        return {
            r: this.TAU_ZENITH_R * airMass,
            g: this.TAU_ZENITH_G * airMass,
            b: this.TAU_ZENITH_B * airMass,
        };
    }

    /**
     * Boost linear RGB components to undo atmospheric extinction.
     * observed_linear * 10^(0.4 * Î”m)
     */
    public static getZenithMultipliers(airMass: number) {
        const ext = this.rayleighExtinction(airMass);
        return {
            r: Math.pow(10, 0.4 * ext.r),
            g: Math.pow(10, 0.4 * ext.g),
            b: Math.pow(10, 0.4 * ext.b)
        };
    }

    /**
     * "Cronos Check"
     * Validate that the observation geometry matches the claimed time and location.
     */
    public static validateObservationTime(
        raCenter: number, 
        decCenter: number, 
        lat: number, 
        lon: number, 
        date: Date | string
    ) {
        const timestamp = date instanceof Date ? date : new Date(date);
        const year = timestamp.getUTCFullYear();
        
        // 1. Junk Data Detect (Common uninitialized RTC values)
        if (year < 1985 || (year === 2020 && timestamp.getUTCMonth() === 0 && timestamp.getUTCDate() === 1)) {
            return { valid: false, reason: 'SUSPICIOUS_DATE' };
        }

        const jd = TimeService.toJulianDate(timestamp);
        const horiz = TimeService.computeAltAz(raCenter, decCenter, lat, lon, jd);

        // 2. Horizon Check
        if (horiz.altitude < -2.0) {
            return { valid: false, reason: 'TARGET_BELOW_HORIZON', altitude: horiz.altitude };
        }

        return { valid: true };
    }
}

