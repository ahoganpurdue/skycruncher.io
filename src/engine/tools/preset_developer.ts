/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * LIGHTROOM PRESET DEVELOPER â€” Reverse-Engineer Edit Recipes
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * THE COncePT:
 * User uploads their RAW photo AND their final edited photo.
 * We analyze both, compute the delta (what changed), and generate
 * an importable Lightroom preset (.xmp) that reproduces the edit.
 *
 * HOW IT WORKS:
 * 1. Extract metadata from both images (EXIF: WB, exposure, etc.)
 * 2. Compute luminance histograms for both â†’ derive exposure/contrast
 * 3. Compare white balance settings â†’ derive temperature/tint shifts
 * 4. Per-channel histogram analysis â†’ derive tone curve
 * 5. Sample color patches â†’ derive HSL adjustments
 * 6. Package everything into an EditRecipe â†’ generate .xmp
 */

import {
  type EditRecipe,
  type ToneCurvePoint,
  type HSLChannel,
  createDefaultRecipe,
  generateXMP,
} from './preset_schema';

// â”€â”€â”€ TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ImageAnalysis {
  /** Per-channel histograms (0-255, 256 bins each) */
  histogram: {
    r: number[];
    g: number[];
    b: number[];
    luminance: number[];
  };
  /** Average color (sRGB 0-255) */
  average_color: { r: number; g: number; b: number };
  /** White balance from EXIF (Kelvin) */
  white_balance_K: number;
  /** Tint from EXIF */
  tint: number;
  /** Exposure value from EXIF */
  exposure_ev: number;
  /** ISO from EXIF */
  iso: number;
}

export interface PresetResult {
  recipe: EditRecipe;
  xmp: string;
  confidence: number;
  analysis_notes: string[];
}

// â”€â”€â”€ IMAGE ANALYSIS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Compute a histogram from RGBA image data.
 */
export function computeHistogram(
  imageData: Uint8ClampedArray,
  width: number,
  height: number
): ImageAnalysis['histogram'] {
  const r = new Array(256).fill(0);
  const g = new Array(256).fill(0);
  const b = new Array(256).fill(0);
  const lum = new Array(256).fill(0);

  const pixelCount = width * height;
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const rv = imageData[idx];
    const gv = imageData[idx + 1];
    const bv = imageData[idx + 2];
    r[rv]++;
    g[gv]++;
    b[bv]++;
    // ITU-R BT.709 luminance
    const l = Math.round(0.2126 * rv + 0.7152 * gv + 0.0722 * bv);
    lum[Math.min(255, l)]++;
  }

  return { r, g, b, luminance: lum };
}

/**
 * Compute the average color of an image.
 */
export function computeAverageColor(
  imageData: Uint8ClampedArray,
  width: number,
  height: number
): { r: number; g: number; b: number } {
  let rSum = 0, gSum = 0, bSum = 0;
  const pixelCount = width * height;

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    rSum += imageData[idx];
    gSum += imageData[idx + 1];
    bSum += imageData[idx + 2];
  }

  return {
    r: Math.round(rSum / pixelCount),
    g: Math.round(gSum / pixelCount),
    b: Math.round(bSum / pixelCount),
  };
}

// â”€â”€â”€ DELTA COMPUTATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Compute exposure delta from histogram shift.
 *
 * Measures how much the luminance histogram moved between RAW and final.
 * A rightward shift = positive exposure compensation.
 */
export function computeExposureDelta(
  rawHist: number[],
  finalHist: number[]
): { exposure: number; contrast: number; highlights: number; shadows: number } {
  const rawMean = histogramMean(rawHist);
  const finalMean = histogramMean(finalHist);

  // Exposure: shift in mean luminance, scaled to EV
  // ~18 luminance levels â‰ˆ 1 EV
  const exposure = (finalMean - rawMean) / 18.0;

  // Contrast: change in standard deviation
  const rawStd = histogramStd(rawHist, rawMean);
  const finalStd = histogramStd(finalHist, finalMean);
  const contrast = ((finalStd / (rawStd + 0.01)) - 1.0) * 100;

  // Highlights: change in upper quarter (192-255)
  const rawHighMean = histogramRangeMean(rawHist, 192, 255);
  const finalHighMean = histogramRangeMean(finalHist, 192, 255);
  const highlights = (finalHighMean - rawHighMean) / 1.28; // Scale to -100..+100

  // Shadows: change in lower quarter (0-64)
  const rawLowMean = histogramRangeMean(rawHist, 0, 64);
  const finalLowMean = histogramRangeMean(finalHist, 0, 64);
  const shadows = (finalLowMean - rawLowMean) / 0.64;

  return {
    exposure: clamp(exposure, -5, 5),
    contrast: clamp(contrast, -100, 100),
    highlights: clamp(highlights, -100, 100),
    shadows: clamp(shadows, -100, 100),
  };
}

/**
 * Compute white balance delta between RAW and final.
 */
export function computeWhitebalanceDelta(
  rawWB_K: number,
  finalWB_K: number,
  rawTint: number,
  finalTint: number
): { temperature: number; tint: number } {
  return {
    temperature: finalWB_K || rawWB_K,  // Use final if available
    tint: finalTint - rawTint,
  };
}

/**
 * Compute a tone curve by comparing per-bin luminance mapping.
 *
 * For each input bin (RAW), find the corresponding output bin (final).
 * This creates a transfer function that can be expressed as a tone curve.
 */
export function computeToneCurve(
  rawHist: number[],
  finalHist: number[]
): ToneCurvePoint[] {
  // Build cumulative distribution functions (CDFs)
  const rawCDF = buildCDF(rawHist);
  const finalCDF = buildCDF(finalHist);

  // Map: for each input percentile, find the output value
  const points: ToneCurvePoint[] = [];
  const samplePoints = [0, 16, 32, 64, 96, 128, 160, 192, 224, 255];

  for (const x of samplePoints) {
    // Find the percentile of this value in the RAW histogram
    const percentile = rawCDF[x];
    // Find which value in the final histogram has the same percentile
    let y = x;
    for (let j = 0; j < 256; j++) {
      if (finalCDF[j] >= percentile) {
        y = j;
        break;
      }
    }
    points.push({ x, y });
  }

  // Simplify: remove points that are close to the identity line
  return simplifyToneCurve(points);
}

/**
 * Compute HSL color grading adjustments by sampling color patches.
 */
export function computeColorGrading(
  rawAvg: { r: number; g: number; b: number },
  finalAvg: { r: number; g: number; b: number }
): EditRecipe['hsl'] {
  // Compute the overall color shift
  const dr = finalAvg.r - rawAvg.r;
  const dg = finalAvg.g - rawAvg.g;
  const db = finalAvg.b - rawAvg.b;

  // Map RGB shifts to approximate HSL channel adjustments
  // This is a simplified model â€” full implementation would sample
  // specific hue ranges independently
  const defaultHSL: HSLChannel = { hue: 0, saturation: 0, luminance: 0 };

  return {
    red:     { hue: clamp(dr * 0.3, -30, 30),  saturation: clamp(dr * 0.5, -50, 50),  luminance: clamp(dr * 0.2, -30, 30) },
    orange:  { hue: clamp((dr + dg) * 0.15, -30, 30), saturation: clamp((dr + dg) * 0.25, -50, 50), luminance: 0 },
    yellow:  { hue: clamp(dg * 0.3, -30, 30),  saturation: clamp(dg * 0.5, -50, 50),  luminance: clamp(dg * 0.2, -30, 30) },
    green:   { hue: clamp(dg * 0.3, -30, 30),  saturation: clamp(dg * 0.4, -50, 50),  luminance: clamp(dg * 0.15, -30, 30) },
    aqua:    { hue: clamp((dg + db) * 0.15, -30, 30), saturation: clamp((dg + db) * 0.25, -50, 50), luminance: 0 },
    blue:    { hue: clamp(db * 0.3, -30, 30),  saturation: clamp(db * 0.5, -50, 50),  luminance: clamp(db * 0.2, -30, 30) },
    purple:  { hue: clamp((dr + db) * 0.15, -30, 30), saturation: clamp((dr + db) * 0.25, -50, 50), luminance: 0 },
    magenta: { ...defaultHSL },
  };
}

// â”€â”€â”€ MAIN PIPELINE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Analyze a RAW+Final image pair and generate a Lightroom preset.
 *
 * @param rawPixels - Raw image pixel data (RGBA)
 * @param finalPixels - Final edited image pixel data (RGBA)
 * @param width - Image width (must match for both)
 * @param height - Image height (must match for both)
 * @param rawWB_K - White balance of RAW (from EXIF)
 * @param finalWB_K - White balance of final (from EXIF, if available)
 * @param presetName - Name for the generated preset
 */
export function analyzeEditDelta(
  rawPixels: Uint8ClampedArray,
  finalPixels: Uint8ClampedArray,
  width: number,
  height: number,
  rawWB_K: number = 5500,
  finalWB_K: number = 0,
  rawTint: number = 0,
  finalTint: number = 0,
  presetName: string = 'SKYCRUNCHER Preset'
): PresetResult {
  const notes: string[] = [];

  // 1. Compute histograms
  const rawHist = computeHistogram(rawPixels, width, height);
  const finalHist = computeHistogram(finalPixels, width, height);

  // 2. Exposure & contrast
  const expDelta = computeExposureDelta(rawHist.luminance, finalHist.luminance);
  notes.push(`Exposure shift: ${expDelta.exposure > 0 ? '+' : ''}${expDelta.exposure.toFixed(2)} EV`);

  // 3. White balance
  const wbDelta = computeWhitebalanceDelta(rawWB_K, finalWB_K, rawTint, finalTint);

  // 4. Tone curve
  const toneCurve = computeToneCurve(rawHist.luminance, finalHist.luminance);
  notes.push(`Tone curve: ${toneCurve.length} control points`);

  // 5. Color grading (HSL)
  const rawAvg = computeAverageColor(rawPixels, width, height);
  const finalAvg = computeAverageColor(finalPixels, width, height);
  const hsl = computeColorGrading(rawAvg, finalAvg);

  // 6. Estimate noise reduction (higher ISO â†’ more NR likely applied)
  const estimatedNR = Math.min(50, Math.max(0, (rawHist.luminance[0] - finalHist.luminance[0]) / 100));

  // 7. Assemble recipe
  const recipe = createDefaultRecipe(presetName);
  recipe.exposure = expDelta.exposure;
  recipe.contrast = expDelta.contrast;
  recipe.highlights = expDelta.highlights;
  recipe.shadows = expDelta.shadows;
  recipe.temperature = wbDelta.temperature;
  recipe.tint = wbDelta.tint;
  recipe.tone_curve = toneCurve;
  recipe.hsl = hsl;
  recipe.noise_reduction_luminance = estimatedNR;

  // 8. Generate XMP
  const xmp = generateXMP(recipe);

  // 9. confidence score based on histogram quality
  const histogramCoverage = rawHist.luminance.filter(v => v > 0).length / 256;
  const confidence = Math.min(0.95, histogramCoverage * 0.8 + 0.15);

  notes.push(`confidence: ${(confidence * 100).toFixed(0)}%`);

  return { recipe, xmp, confidence, analysis_notes: notes };
}

// â”€â”€â”€ UTILITY FUNCTIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function histogramMean(hist: number[]): number {
  let sum = 0, count = 0;
  for (let i = 0; i < 256; i++) {
    sum += i * hist[i];
    count += hist[i];
  }
  return count > 0 ? sum / count : 128;
}

function histogramStd(hist: number[], mean: number): number {
  let sum = 0, count = 0;
  for (let i = 0; i < 256; i++) {
    sum += hist[i] * (i - mean) * (i - mean);
    count += hist[i];
  }
  return count > 0 ? Math.sqrt(sum / count) : 1;
}

function histogramRangeMean(hist: number[], lo: number, hi: number): number {
  let sum = 0, count = 0;
  for (let i = lo; i <= hi; i++) {
    sum += i * hist[i];
    count += hist[i];
  }
  return count > 0 ? sum / count : (lo + hi) / 2;
}

function buildCDF(hist: number[]): number[] {
  const cdf = new Array(256);
  const total = hist.reduce((a, b) => a + b, 0);
  let running = 0;
  for (let i = 0; i < 256; i++) {
    running += hist[i];
    cdf[i] = total > 0 ? running / total : i / 255;
  }
  return cdf;
}

function simplifyToneCurve(points: ToneCurvePoint[]): ToneCurvePoint[] {
  // Keep endpoints + points that deviate from identity by > 3 levels
  return points.filter(p =>
    p.x === 0 || p.x === 255 || Math.abs(p.y - p.x) > 3
  );
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

