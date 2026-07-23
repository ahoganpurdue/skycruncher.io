/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * COLOR INDEX CALCULATOR â€” Photometric Analysis
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * THE COncePT:
 * The Color Index (B-V) is the astronomer's way of measuring a star's
 * color as a single number. It's defined as:
 *
 *   B-V = magnitude_B - magnitude_V
 *
 * Where:
 *   B = brightness through a blue filter (~440nm)
 *   V = brightness through a visual (green) filter (~550nm)
 *
 * A negative B-V means the star is BLUE (hot: O, B stars)
 * B-V â‰ˆ 0 means WHITE (A stars, like Vega)
 * A positive B-V means RED (cool: K, M stars)
 *
 * We approximate B-V from camera RGB by converting to a consistent
 * color space and comparing blue/green channel ratios.
 */

import { srgbToXYZ, xyzToOklab } from '../../core/colormath';
import type { XYZColor, OklabColor } from '../../core/colormath';
import { STANDARD_STARS, findNearestStar, type StandardStar } from '../m6_plate_solve/standard_stars';

// â”€â”€â”€ TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ColorIndexResult {
  /** Estimated BP-RP color index */
  BP_RP: number;
  /** Estimated effective temperature (Kelvin) from BP-RP */
  estimated_temperature_K: number;
  /** Spectral type estimate (e.g. "G2") */
  estimated_spectral_type: string;
}

export interface ComparisonResult {
  /** Observed BP-RP */
  observed_BP_RP: number;
  /** Expected BP-RP from catalog */
  expected_BP_RP: number;
  /** difference (observed - expected) */
  delta_BP_RP: number;
  /** Perceptual color difference (Î”Eâ‚€â‚€ in Oklab) */
  delta_E: number;
  /** Standard deviations from expected */
  sigma: number;
  /** reference star used */
  reference_star: StandardStar;
}

// â”€â”€â”€ B-V ESTIMATION FROM RGB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Estimate B-V color index from an sRGB pixel.
 *
 * This is an APPROXIMATION. True B-V requires actual B and V filter
 * photometry, but camera RGB channels overlap significantly with
 * Johnson B and V bands.
 *
 * Method: Convert to XYZ â†’ extract blue-to-green ratio â†’ calibrate.
 * The calibration is anchored to Vega (B-V = 0.00) and Betelgeuse (B-V = +1.85).
 *
 * @param rgb - Zenith-corrected, hardware-normalized sRGB values
 * @returns ColorIndexResult with estimated B-V, temperature, and spectral type
 */
export function computeColorIndex(
  rgb: { r: number; g: number; b: number }
): ColorIndexResult {
  const xyz = srgbToXYZ(rgb.r, rgb.g, rgb.b);

  // BP-RP correlates strongly with the ratio of blue-to-red flux
  // In XYZ: Z is blue-weighted, X is red-weighted
  const blueRatio = xyz.Z / (xyz.X + 0.001);  // Avoid division by zero

  // Empirical calibration mapping roughly to expected Gaia BP-RP:
  const BP_RP = -1.65 * Math.log(blueRatio + 0.01) + 0.15;

  // BP-RP â†’ Temperature (Proxy mapping into Ballesteros 2012 formula)
  const estimated_temperature_K = bpRpToTemperature(BP_RP);

  // Temperature â†’ Spectral type (rough binning)
  const estimated_spectral_type = temperatureToSpectralType(estimated_temperature_K);

  return { BP_RP, estimated_temperature_K, estimated_spectral_type };
}

/**
 * Convert BP-RP color index to effective temperature.
 * Converts into proxy BV then uses the Ballesteros (2012) formula:
 *   T = 4600 Ã— (1/(0.92Ã—proxyBv + 1.7) + 1/(0.92Ã—proxyBv + 0.62))
 */
export function bpRpToTemperature(bpRp: number): number {
  const proxyBv = 0.85 * bpRp;
  return 4600 * (1.0 / (0.92 * proxyBv + 1.7) + 1.0 / (0.92 * proxyBv + 0.62));
}

/**
 * Map temperature to Morgan-Keenan spectral type (rough).
 */
export function temperatureToSpectralType(tempK: number): string {
  if (tempK > 30000) return 'O';
  if (tempK > 10000) return 'B';
  if (tempK > 7500)  return 'A';
  if (tempK > 6000)  return 'F';
  if (tempK > 5200)  return 'G';
  if (tempK > 3700)  return 'K';
  return 'M';
}

// â”€â”€â”€ COMPARISON TO STANDARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Compare an observed star's color to its expected catalog value.
 *
 * This is where we detect anomalies. If the observed B-V differs
 * significantly from the expected value, either:
 * (a) Our calibration is off (instrument error), or
 * (b) The star has genuinely changed (nova, variable star, etc.)
 *
 * @param observedRGB - Zenith-corrected, normalized sRGB
 * @param expectedStar - Standard star from catalog
 * @param measurementUncertainty - Expected Â±error in B-V units (default 0.05)
 */
export function compareToStandard(
  observedRGB: { r: number; g: number; b: number },
  expectedStar: StandardStar,
  measurementUncertainty: number = 0.05
): ComparisonResult {
  const observed = computeColorIndex(observedRGB);

  const delta_BP_RP = observed.BP_RP - expectedStar.color_index_BV;
  const sigma = Math.abs(delta_BP_RP) / measurementUncertainty;

  // Compute perceptual Î”E in Oklab
  const observedXYZ = srgbToXYZ(observedRGB.r, observedRGB.g, observedRGB.b);
  const observedLab = xyzToOklab(observedXYZ.X, observedXYZ.Y, observedXYZ.Z);

  // Expected star color from Planckian
  const expectedXY = expectedStar.expected_xy;
  // Rough XYZ from xy (assume Y=1)
  const expectedXYZ: XYZColor = {
    X: expectedXY.x / expectedXY.y,
    Y: 1.0,
    Z: (1 - expectedXY.x - expectedXY.y) / expectedXY.y,
  };
  const expectedLab = xyzToOklab(expectedXYZ.X, expectedXYZ.Y, expectedXYZ.Z);

  const dL = observedLab.L - expectedLab.L;
  const da = observedLab.a - expectedLab.a;
  const db = observedLab.b - expectedLab.b;
  const delta_E = Math.sqrt(dL * dL + da * da + db * db);

  return {
    observed_BP_RP: observed.BP_RP,
    expected_BP_RP: expectedStar.color_index_BV,
    delta_BP_RP: delta_BP_RP,
    delta_E,
    sigma,
    reference_star: expectedStar,
  };
}

/**
 * Auto-compare a star at given coordinates to the nearest standard star.
 */
export function autoCompare(
  observedRGB: { r: number; g: number; b: number },
  raHours: number,
  decDegrees: number
): ComparisonResult {
  const nearest = findNearestStar(raHours, decDegrees);
  return compareToStandard(observedRGB, nearest);
}

