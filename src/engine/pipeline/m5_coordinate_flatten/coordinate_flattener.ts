/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * IMAGE FLATTENER â€” Vignetting & Distortion Correction
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * THE PROBLEM:
 * Every lens/telescope introduces optical artifacts:
 *
 * 1. VIGNETTING: Corners are dimmer than the center because the light
 *    cone is partially blocked by the lens barrel at wide angles.
 *    This makes stars near the edge APPEAR fainter than they are.
 *
 * 2. DISTORTION: Wide-angle lenses bend straight lines into curves
 *    (barrel distortion). Telephoto lenses do the opposite (pincushion).
 *    This shifts star POSITIONS from their true sky coordinates.
 *
 * THE SOLUTION:
 * - For vignetting: compute a radial brightness map and divide.
 * - For distortion: compute a pixel displacement map and remap.
 *
 * Both can use either:
 * (a) Theoretical models from lens_profiles.ts (coefficient-based)
 * (b) Empirical data from user-provided flat frames (data-driven)
 */

import {
  interpolateVignette,
  vignetteCorrection,
  type VignetteCoeffs,
  type DistortionCoeffs,
  type LensProfile,
} from '../m2_hardware/lens_profiles';
import { OpticsManager, VignetteProfile, DistortionProfile } from '../../core/optics_manager';
import { StatisticsProvider } from '../../core/StatisticsProvider';

// â”€â”€â”€ TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** A computed correction map for an image at a specific resolution. */
export interface CorrectionMap {
  width: number;
  height: number;
  /** Per-pixel multiplicative vignetting correction (1.0 = no correction needed) */
  vignette: Float32Array;
  /** Per-pixel X displacement for distortion correction */
  distortionDx: Float32Array | null;
  /** Per-pixel Y displacement for distortion correction */
  distortionDy: Float32Array | null;
}

// â”€â”€â”€ VIGNETTE MAP GENERATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Generate a per-pixel vignetting correction map.
 *
 * Each pixel gets a multiplicative factor: corrected = original Ã— map[i].
 * Center pixels â‰ˆ 1.0, corner pixels > 1.0 (boosted to compensate for falloff).
 *
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param coeffs - Polynomial vignetting coefficients
 * @returns Float32Array of correction factors (length = width Ã— height)
 */
export function computeVignetteMap(
  width: number,
  height: number,
  coeffs: VignetteCoeffs
): Float32Array {
  const map = new Float32Array(width * height);
  const profile: VignetteProfile = {
    coeffs: [1.0, coeffs.k1, coeffs.k2, coeffs.k3] // Polynomial: 1 + k1*r^2 + k2*r^4 + k3*r^6
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      map[y * width + x] = OpticsManager.getVignetteCorrection(x, y, width, height, profile);
    }
  }

  return map;
}

/**
 * Generate a vignetting map from a lens profile at a specific focal length.
 * Interpolates coefficients if the exact focal length isn't in the database.
 */
export function computeVignetteMapFromProfile(
  width: number,
  height: number,
  profile: LensProfile,
  focalLength: number
): Float32Array {
  const coeffs = interpolateVignette(profile, focalLength);
  return computeVignetteMap(width, height, coeffs);
}

// â”€â”€â”€ DISTORTION MAP GENERATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Generate a per-pixel distortion correction displacement map.
 *
 * Uses the Brown-Conrady model:
 *   x' = x(1 + kâ‚rÂ² + kâ‚‚râ´ + kâ‚ƒrâ¶) + 2pâ‚xy + pâ‚‚(rÂ² + 2xÂ²)
 *   y' = y(1 + kâ‚rÂ² + kâ‚‚râ´ + kâ‚ƒrâ¶) + pâ‚(rÂ² + 2yÂ²) + 2pâ‚‚xy
 *
 * The displacement (dx, dy) tells you: "to find the undistorted pixel
 * that maps to this distorted location, look at (x + dx, y + dy)."
 *
 * @param width - Image width
 * @param height - Image height
 * @param coeffs - Brown-Conrady distortion coefficients
 * @returns { dx, dy } Float32Arrays of pixel displacements
 */
export function computeDistortionMap(
  width: number,
  height: number,
  coeffs: DistortionCoeffs
): { dx: Float32Array; dy: Float32Array } {
  const dxMap = new Float32Array(width * height);
  const dyMap = new Float32Array(width * height);
  const distProfile: DistortionProfile = {
    k1: coeffs.k1,
    k2: coeffs.k2,
    k3: coeffs.k3 || 0,
    p1: coeffs.p1,
    p2: coeffs.p2
  };

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      // OpticsManager.applyDistortion computes Distorted (srcX, srcY) from Undistorted (px, py)
      const src = OpticsManager.applyDistortion(px, py, width, height, distProfile);
      
      const idx = py * width + px;
      dxMap[idx] = src.x - px;
      dyMap[idx] = src.y - py;
    }
  }

  return { dx: dxMap, dy: dyMap };
}

// â”€â”€â”€ FULL CORRECTION MAP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Generate a complete correction map (vignetting + distortion).
 */
export function computeCorrectionMap(
  width: number,
  height: number,
  profile: LensProfile,
  focalLength: number
): CorrectionMap {
  const coeffs = interpolateVignette(profile, focalLength);
  const vignette = computeVignetteMap(width, height, coeffs);

  // Find distortion coefficients for this focal length
  const fls = profile.focal_lengths.sort((a, b) => a - b);
  let distCoeffs: DistortionCoeffs | null = null;

  if (profile.distortion[focalLength]) {
    distCoeffs = profile.distortion[focalLength];
  } else if (focalLength <= fls[0]) {
    distCoeffs = profile.distortion[fls[0]];
  } else if (focalLength >= fls[fls.length - 1]) {
    distCoeffs = profile.distortion[fls[fls.length - 1]];
  } else {
    // Use nearest
    let nearestFL = fls[0];
    let nearestDist = Math.abs(focalLength - fls[0]);
    for (const fl of fls) {
      const d = Math.abs(focalLength - fl);
      if (d < nearestDist) { nearestDist = d; nearestFL = fl; }
    }
    distCoeffs = profile.distortion[nearestFL];
  }

  let distortionDx: Float32Array | null = null;
  let distortionDy: Float32Array | null = null;

  if (distCoeffs && (
      Math.abs(distCoeffs.k1) > 0.0001 || 
      Math.abs(distCoeffs.k2) > 0.0001 || 
      (distCoeffs.k3 && Math.abs(distCoeffs.k3) > 0.0001)
  )) {
    const dist = computeDistortionMap(width, height, distCoeffs);
    distortionDx = dist.dx;
    distortionDy = dist.dy;
  }

  return { width, height, vignette, distortionDx, distortionDy };
}

// â”€â”€â”€ APPLY CORRECTIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Apply vignetting correction to RGBA image data (in-place).
 *
 * @param imageData - Raw pixel data (RGBA, 4 bytes per pixel)
 * @param vignetteMap - Per-pixel correction factors
 */
export function applyVignetteCorrection(
  imageData: Uint8ClampedArray,
  vignetteMap: Float32Array
): void {
  const pixelCount = vignetteMap.length;

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const correction = vignetteMap[i];
    imageData[idx]     = Math.min(255, Math.round(imageData[idx]     * correction)); // R
    imageData[idx + 1] = Math.min(255, Math.round(imageData[idx + 1] * correction)); // G
    imageData[idx + 2] = Math.min(255, Math.round(imageData[idx + 2] * correction)); // B
    // Alpha (idx + 3) stays unchanged
  }
}

/**
 * Apply distortion correction to RGBA image data.
 * Returns a NEW corrected buffer (non-destructive).
 *
 * Uses bilinear interpolation to remap pixels.
 */
export function applyDistortionCorrection(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  dxMap: Float32Array,
  dyMap: Float32Array
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(imageData.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const srcX = x + dxMap[idx];
      const srcY = y + dyMap[idx];

      // Bilinear interpolation
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const fx = srcX - x0;
      const fy = srcY - y0;

      if (x0 >= 0 && x1 < width && y0 >= 0 && y1 < height) {
        const i00 = (y0 * width + x0) * 4;
        const i10 = (y0 * width + x1) * 4;
        const i01 = (y1 * width + x0) * 4;
        const i11 = (y1 * width + x1) * 4;
        const out = idx * 4;

        for (let c = 0; c < 4; c++) {
          const v = (1 - fx) * (1 - fy) * imageData[i00 + c]
                  + fx       * (1 - fy) * imageData[i10 + c]
                  + (1 - fx) * fy       * imageData[i01 + c]
                  + fx       * fy       * imageData[i11 + c];
          output[out + c] = Math.round(v);
        }
      }
    }
  }

  return output;
}

// â”€â”€â”€ EMPIRICAL FLAT FIELD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Estimate a vignetting correction map from user-provided flat frames.
 *
 * Flat frames are photos of a uniformly illuminated surface (e.g., a
 * white T-shirt over the telescope). Any brightness variation in the
 * flat is caused by the optics, not the scene.
 *
 * Method: median-combine multiple flats â†’ normalize to center brightness
 * â†’ invert to get correction map.
 *
 * @param flatFrames - Array of flat frame pixel data (RGBA)
 * @param width - Image width
 * @param height - Image height
 * @returns Per-pixel correction factors
 */
export function estimateVignetteFromFlats(
  flatFrames: Uint8ClampedArray[],
  width: number,
  height: number
): Float32Array {
  const pixelCount = width * height;
  const correctionMap = new Float32Array(pixelCount);

  // For each pixel position, compute median luminance across all flats
  for (let i = 0; i < pixelCount; i++) {
    const values: number[] = [];
    for (const frame of flatFrames) {
      const idx = i * 4;
      // luminance approximation
      const lum = 0.2126 * frame[idx] + 0.7152 * frame[idx + 1] + 0.0722 * frame[idx + 2];
      values.push(lum);
    }
    values.sort((a, b) => a - b);
    correctionMap[i] = values[Math.floor(values.length / 2)]; // Median
  }

  // Normalize: center pixel value becomes 1.0, everything else is relative
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const r = 10;
  
  // Extract box for center value
  const centerBox: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const idx = (cy + dy) * width + (cx + dx);
      if (idx >= 0 && idx < pixelCount) centerBox.push(correctionMap[idx]);
    }
  }
  
  const stats = StatisticsProvider.calculateStats(new Float32Array(centerBox));
  const centerValue = stats.median || 1.0;

  // Invert: if pixel is at 80% of center brightness, correction = 1/0.8 = 1.25
  for (let i = 0; i < pixelCount; i++) {
    const normalized = correctionMap[i] / centerValue;
    correctionMap[i] = normalized > 0.01 ? 1.0 / normalized : 1.0;
  }

  return correctionMap;
}

