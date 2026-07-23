
/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * DIFFERENTIAL REFRACTION CORRECTOR â€” The Atmospheric Lens
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Corrects for the vertical shift of starlight caused by the atmosphere.
 * Stars appear higher than they actually are.
 * The effect increases significantly near the horizon.
 * 
 * Formula (Bennett 1982, delegated to OpticsManager.calculateAtmosphericRefraction):
 * R = 1 / tan(h_a + 7.31/(h_a + 4.4))  (arcminutes, apparent-altitude form)
 * NOT the Saemundsson true-altitude form 1.02*cot(h + 10.3/(h + 5.11)) that an
 * earlier version of this header quoted.
 *
 * We apply this shift in the direction of the Zenith.
 *
 * ⚠ STATUS: LIVE as an APPROXIMATE, clock+GPS-gated field-level PREDICTOR in
 * stages/psf_attribution.ts (differential stretch across the frame, reported
 * only). Never wired back into the solve — do not assume its correction is
 * applied to solved plate coordinates.
 */

import { OpticsManager } from '../../core/optics_manager';

export class DifferentialRefractionCorrector {

    /**
     * Calculates the refraction amount in arcseconds for a given apparent altitude.
     * @param altitudeDegrees Apparent altitude in degrees
     * @returns Refraction offset in arcseconds
     */
    public static computeRefractionOffset(altitudeDegrees: number): number {
        return OpticsManager.calculateAtmosphericRefraction(altitudeDegrees);
    }

    /**
     * Calculates the Differential Refraction between two altitudes.
     * Useful for correcting relative positions in a field.
     */
    public static computeDifferential(alt1: number, alt2: number): number {
        return this.computeRefractionOffset(alt1) - this.computeRefractionOffset(alt2);
    }
}

