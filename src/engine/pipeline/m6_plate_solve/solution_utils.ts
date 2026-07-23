import { PlateSolution, WCSTransform } from '../../types/Main_types';
import { SkyTransform } from '../../core/SkyTransform';
import { buildSpatialHash } from '../../types/schema';

/**
 * Generate a spatial hash from a plate solution.
 */
export function plateSolutionToSpatialHash(solution: PlateSolution): string {
    return buildSpatialHash(solution.ra_hours, solution.dec_degrees);
}

/**
 * Apply a plate solution's WCS to convert pixel â†’ sky for any point.
 */
export function pixelToSkyCoords(
    x: number, y: number, solution: PlateSolution
): { ra_hours: number; dec_degrees: number } {
    return SkyTransform.pixelToSky(x, y, solution.wcs);
}

/**
 * Convert a PlateSolution to a standard WCS format for interoperability.
 * Specifically converts RA from Hours to Degrees.
 */
export function toStandardWCS(solution: PlateSolution) {
    if (!solution.wcs) return null;
    return {
        ...solution.wcs,
        crval: [
            solution.wcs.crval[0] * 15, // Convert RA Hours -> Degrees
            solution.wcs.crval[1]
        ]
    };
}
