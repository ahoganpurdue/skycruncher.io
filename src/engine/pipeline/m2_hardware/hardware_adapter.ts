/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * HARDWARE HANDSHAKE â€” Device Normalization Pipeline
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * THE PROBLEM:
 * A Canon DSLR and a ZWO astro-cam disagree on what "Red" looks like
 * because they have different sensors with different Quantum Efficiency
 * curves and different Bayer filter dyes.
 *
 * THE SOLUTION:
 * 1. Look up the sensor profile from the camera model
 * 2. Apply the sensor's 3Ã—3 color correction matrix to normalize RGB â†’ XYZ
 * 3. If a filter is used, divide by the filter's transmission curve
 * 4. Compute the pixel scale (arcsec/pixel) for plate solving
 * 5. Compute the optical train "fingerprint" for error tracking
 *
 * After hardware normalization, all cameras agree on what "Red" means.
 */

import { srgbToXYZ, xyzToSRGB } from '../../core/colormath';
import type { sRGBColor } from '../../core/colormath';
import { findSensorByCamera, type SensorProfile } from './sensor_db';
import { getFilterProfile, computeFilterInverse } from './filter_profiles';
import { FilterType } from '../../types/schema';

// â”€â”€â”€ SENSOR CORRECTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Apply the sensor's color correction matrix.
 *
 * The color matrix transforms raw sensor RGB into CIE XYZ.
 * This compensates for the sensor's non-ideal spectral response.
 *
 * Pipeline: sRGB â†’ linear â†’ matrix multiply â†’ XYZ â†’ back to sRGB
 *
 * @param rgb - Input sRGB values (0-255)
 * @param profile - Sensor profile with color correction matrix
 * @returns Corrected sRGB values
 */
export function applySensorCorrection(
  rgb: { r: number; g: number; b: number },
  profile: SensorProfile
): sRGBColor {
  // Convert to XYZ first
  const xyz = srgbToXYZ(rgb.r, rgb.g, rgb.b);

  // Apply the sensor's color correction matrix (3Ã—3)
  const m = profile.color_matrix;
  const corrected = {
    X: m[0][0] * xyz.X + m[0][1] * xyz.Y + m[0][2] * xyz.Z,
    Y: m[1][0] * xyz.X + m[1][1] * xyz.Y + m[1][2] * xyz.Z,
    Z: m[2][0] * xyz.X + m[2][1] * xyz.Y + m[2][2] * xyz.Z,
  };

  return xyzToSRGB(corrected.X, corrected.Y, corrected.Z);
}


// â”€â”€â”€ FILTER COMPENSATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Remove the spectral bias introduced by an optical filter.
 *
 * If a CLS filter blocks 90% of green light (Na line),
 * we multiply the green channel by 1/0.9 to recover it.
 *
 * @param rgb - Input sRGB values (0-255)
 * @param filterType - Filter type from user metadata
 * @returns Filter-compensated sRGB values
 */
export function applyFilterCompensation(
  rgb: { r: number; g: number; b: number },
  filterType: FilterType
): sRGBColor {
  if (filterType === FilterType.NONE) {
    return { r: rgb.r, g: rgb.g, b: rgb.b };
  }

  const profile = getFilterProfile(filterType);
  const inverse = computeFilterInverse(profile);

  return {
    r: Math.min(255, Math.round(rgb.r * inverse.r)),
    g: Math.min(255, Math.round(rgb.g * inverse.g)),
    b: Math.min(255, Math.round(rgb.b * inverse.b)),
  };
}

// â”€â”€â”€ PIXEL SCALE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Compute the pixel scale in arcseconds per pixel.
 *
 * This tells you the angular size of one pixel on the sky.
 * Critical for plate solving and for comparing star sizes.
 *
 * Formula: pixelScale = 206265 Ã— (pixelSize_mm / focalLength_mm)
 *
 * The constant 206265 = number of arcseconds in one radian.
 *
 * @param focalLengthMm - Telescope/lens focal length in mm
 * @param pixelSizeUm - Sensor pixel size in micrometers
 * @returns Arcseconds per pixel
 */
export function computePixelScale(
  focalLengthMm: number,
  pixelSizeUm: number
): number {
  const pixelSizeMm = pixelSizeUm / 1000.0;
  return 206265.0 * pixelSizeMm / focalLengthMm;
}


// â”€â”€â”€ FINGERPRINT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Compute a hash fingerprint for the optical train's systematic error pattern.
 *
 * The "Lie Detector" â€” identifies sensor artifacts (hot pixels, column defects,
 * amp glow) that are unique to each optical train (camera + lens + filter combo).
 *
 * Two observations from the same optical train will have the same fingerprint,
 * allowing us to distinguish instrument error from real astronomical signals.
 *
 * @param cameraModel - Camera model string
 * @param lensModel - Lens model string
 * @param filterType - Filter type
 * @param sensorSerial - Sensor serial number (if available)
 * @returns Hex fingerprint string
 */
export function computeFingerprint(
  cameraModel: string,
  lensModel: string,
  filterType: FilterType,
  sensorSerial: string = 'UNKNOWN'
): string {
  // Simple deterministic hash of the optical train configuration
  const input = `${cameraModel}|${lensModel}|${filterType}|${sensorSerial}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `FP_${Math.abs(hash).toString(16).toUpperCase().padStart(8, '0')}`;
}

