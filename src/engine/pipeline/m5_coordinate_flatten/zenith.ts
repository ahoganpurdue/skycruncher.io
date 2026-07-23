/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * ZENITH NORMALIZER â€” Atmospheric Correction Pipeline
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * THE PROBLEM:
 * A star's true color is modified by the atmosphere before it reaches
 * the camera sensor. Blue light scatters more than red (Rayleigh),
 * and the total extinction depends on how much atmosphere the light
 * passes through (Air Mass).
 *
 * THE SOLUTION:
 * 1. Calculate where the star was in the sky (Alt/Az from RA/Dec + GPS + time)
 * 2. Calculate how much atmosphere it passed through (Air Mass)
 * 3. Calculate per-channel extinction (Rayleigh scattering coefficients)
 * 4. Multiply each channel to "undo" the atmosphere
 *
 * After zenith correction, the pixel data represents "Top of Atmosphere"
 * color â€” what the star ACTUALLY looks like from space.
 *
 * referenceS:
 * - Kasten & Young (1989) for air mass formula
 * - Rayleigh scattering: k âˆ 1/Î»â´
 * - Meeus, "Astronomical Algorithms" for coordinate transforms
 */

import { TimeService } from '../../core/TimeService';
import { UnitConverter } from '../../core/UnitConverter';
import { ScaleManager } from '../m2_hardware/scale_manager';

import { AtmosphericManager } from '../../core/AtmosphericManager';

// Constants moved to AtmosphericManager

// â”€â”€â”€ TEMPORAL ENGINE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Convert UNIX timestamp to Julian Years since J2000.0.
 * Used for proper motion calculation.
 */
export function unixToJulianYears(timestamp: string): number {
  const jd = TimeService.toJulianDate(timestamp);
  return TimeService.toJulianYears(jd);
}

/**
 * Apply proper motion to a star's J2000 coordinates.
 * 
 * @param ra  - RA in hours (J2000)
 * @param dec - Dec in degrees (J2000)
 * @param pmra - Proper motion in RA (mas/year) * cos(delta)
 * @param pmdec - Proper motion in Dec (mas/year)
 * @param deltaT - Years since J2000
 */
export function applyProperMotion(
  ra: number, dec: number, 
  pmra: number, pmdec: number, 
  deltaT: number
): { ra: number; dec: number } {
  return TimeService.applyProperMotion(ra, dec, pmra, pmdec, deltaT);
}

/**
 * Precess J2000 coordinates to the Equinox of Date (IAU 2006).
 * Uses Lieske (1979) / Meeus Ch. 21 approximation.
 */
export function precessJ2000ToDate(
  ra: number, dec: number, 
  timestamp: string
): { ra: number; dec: number } {
  const jd = TimeService.toJulianDate(timestamp);
  return TimeService.precessJ2000ToDate(ra, dec, jd);
}

/**
 * Compute apparent star position at a specific epoch (J2000 base).
 */
export function starPositionAtEpoch(
  raJ2000: number, decJ2000: number,
  pmra: number, pmdec: number,
  timestamp: string
): { ra: number; dec: number } {
  const dt = unixToJulianYears(timestamp);
  const pmApplied = TimeService.applyProperMotion(raJ2000, decJ2000, pmra, pmdec, dt);
  const jd = TimeService.toJulianDate(timestamp);
  return TimeService.precessJ2000ToDate(pmApplied.ra, pmApplied.dec, jd);
}

// Low-precision Sun position logic now handled by EphemerisEngine or AtmosphericManager

// â”€â”€â”€ CRONOS CHECK (Time Validation) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export enum TimeValidationStatus {
  VALID = 'VALID',
  SUSPICIOUS_DAYLIGHT = 'SUSPICIOUS_DAYLIGHT',
  IMPOSSIBLE_BELOW_HORIZON = 'IMPOSSIBLE_BELOW_HORIZON',
  JUNK_DATE_DETECTED = 'JUNK_DATE_DETECTED'
}

export type TimeValidationResult = {
  status: TimeValidationStatus;
  sun_altitude?: number;
  target_altitude?: number;
  message: string;
};

/**
 * Validate that the claimed observation time matches the physics of the sky.
 * "Cronos Check"
 */
export function validateObservationTime(
  plateCenterRa: number,
  plateCenterDec: number,
  lat: number,
  lon: number,
  timestamp: string
): TimeValidationResult {
  const result = AtmosphericManager.validateObservationTime(plateCenterRa / 15, plateCenterDec, lat, lon, timestamp);
  
  if (!result.valid) {
    return {
      status: result.reason === 'SUSPICIOUS_DATE' ? TimeValidationStatus.JUNK_DATE_DETECTED : TimeValidationStatus.IMPOSSIBLE_BELOW_HORIZON,
      message: result.reason || 'Invalid observation time',
      target_altitude: result.altitude
    };
  }

  return { status: TimeValidationStatus.VALID, message: 'Time/Location logic valid.' };
}

// â”€â”€â”€ COORDINATE TRANSFORMS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Convert a UTC timestamp to Julian Date.
 */
export function toJulianDate(timestamp: string): number {
  return TimeService.toJulianDate(timestamp);
}

/**
 * Compute Greenwich Mean Sidereal Time (GMST) from Julian Date.
 */
export function computeGMST(jd: number): number {
  const gmst = TimeService.getGMST_Deg(jd);
  return gmst;
}

/**
 * Compute Local Sidereal Time from GMST and observer longitude.
 */
export function computeLST(gmst: number, lonDeg: number): number {
  // computeLST in TimeService takes jd, but we have gmst already in some callers.
  // Actually, computeLST in zenith.ts was (gmst + lonDeg).
  return ((gmst + lonDeg) % 360 + 360) % 360;
}

/**
 * Convert equatorial coordinates (RA/Dec) to horizontal (Alt/Az)
 * for a given observer position and time.
 *
 * This is the core astronomical coordinate transform.
 * It answers: "Given my location and the current time, where in
 * my sky is this star?"
 *
 * @param raHours  - Right Ascension in decimal hours (0-24)
 * @param decDeg   - Declination in degrees (-90 to +90)
 * @param latDeg   - Observer latitude in degrees
 * @param lonDeg   - Observer longitude in degrees
 * @param timestamp - ISO 8601 UTC timestamp
 * @returns { altitude, azimuth } in degrees
 */
export function computeAltAz(
  raHours: number,
  decDeg: number,
  latDeg: number,
  lonDeg: number,
  timestamp: string
): { altitude: number; azimuth: number } {
  const jd = TimeService.toJulianDate(timestamp);
  return TimeService.computeAltAz(raHours, decDeg, latDeg, lonDeg, jd);
}

/**
 * Compute Equatorial coordinates (RA/Dec) from Horizontal (Alt/Az).
 * This is the INVERSE of computeAltAz.
 * 
 * Used for "Cardinal Direction" hints (e.g., "I was looking South-West").
 * 
 * @param altitudeDeg - Altitude in degrees (0 = Horizon, 90 = Zenith)
 * @param azimuthDeg - Azimuth in degrees (0 = North, 90 = East)
 * @param latDeg - Observer latitude
 * @param lonDeg - Observer longitude
 * @param timestamp - ISO string of observation time
 */
export function computeRaDecFromAltAz(
  altitudeDeg: number,
  azimuthDeg: number,
  latDeg: number,
  lonDeg: number,
  timestamp: string
): { ra: number; dec: number } {
  const jd = TimeService.toJulianDate(timestamp);
  const sol = TimeService.horizontalToEquatorial(
    altitudeDeg, azimuthDeg, latDeg, lonDeg, jd);
  return { ra: sol.ra, dec: sol.dec };
}



// â”€â”€â”€ AIR MASS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Calculate atmospheric Air Mass from altitude angle.
 *
 * Air Mass tells you how many "atmospheres" the light passes through.
 * At zenith (directly overhead), X = 1.0.
 * At 30Â° altitude, X â‰ˆ 2.0.
 * At the horizon, X â‰ˆ 38 (using Kasten-Young, avoids sec(z) singularity).
 *
 * Uses the Kasten & Young (1989) formula which is accurate
 * down to the horizon (unlike the simple sec(z) formula).
 *
 * @param altitudeDeg - Altitude above horizon in degrees
 * @returns Air mass factor (â‰¥ 1.0)
 */
export function computeAirMass(altitudeDeg: number): number {
  return AtmosphericManager.computeAirMass(altitudeDeg);
}

// â”€â”€â”€ RAYLEIGH SCATTERING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Compute Rayleigh scattering extinction coefficients per RGB channel.
 *
 * Rayleigh scattering causes blue light to scatter ~5.7Ã— more than red.
 * This is why:
 * - The sky is blue (scattered blue photons)
 * - Sunsets are red (blue removed by long path through atmosphere)
 * - Stars near the horizon appear redder than they actually are
 *
 * The extinction (in magnitudes) for each channel is: Î”m = Ï„ Ã— X
 * where Ï„ is the zenith optical depth and X is the air mass.
 *
 * @param airMass - Atmospheric path length factor
 * @returns Per-channel extinction in magnitudes { r, g, b }
 */
export function rayleighExtinction(airMass: number) {
  return AtmosphericManager.rayleighExtinction(airMass);
}

export function rayleighCoefficient(airMass: number): number {
  return AtmosphericManager.rayleighExtinction(airMass).b;
}
