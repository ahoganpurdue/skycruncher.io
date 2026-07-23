/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * CALIBRATION TARGETS â€” THE "FIXED STARS" OF THE SkyCruncher UNIVERSE
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * PURPOSE:
 * This file is the **Control Group** for the SkyCruncher.
 * Every value here is an absolute, scientifically invariant anchor point
 * defined in CIE XYZ â€” the parent coordinate system of all color spaces.
 *
 * By plotting these exact points in all 6 viewports simultaneously, you
 * unlock a powerful visual debugger:
 *
 * 1. GRID DISTORTION CHECK:
 *    In CIE 1931, the distance between PRIMARY_GREEN and D65 is huge.
 *    In Oklab, that distance shrinks significantly.
 *    â†’ Visual proof that Oklab is "better" for uniform blending.
 *
 * 2. THE "MESH" VISUALIZATION:
 *    Connect these dots with lines to form a "Calibration Mesh."
 *    As you switch adapters, watch the mesh warp. This is the most
 *    effective way to understand the topology of a color space.
 *
 * 3. correspondence ANALYSIS:
 *    If DARK_SKIN looks green in any viewport, the math is broken.
 *    If SKY_BLUE doesn't separate from FOLIAGE, the space isn't useful
 *    for perceptual work.
 *
 * USAGE:
 *    import { ANCHORS, PLANCKIAN_CHECKPOINTS } from './data/calibration_targets';
 *    const xyz = ANCHORS.D65;
 *    const canvasPoint = adapter.xyYToPoint(xyzToXyY(xyz), center, size);
 */

import { XYZColor } from '../engine/core/colormath';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 1. THE ANCHORS (Scientifically Invariant)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const ANCHORS: Record<string, XYZColor & { label: string; category: string }> = {

  // â”€â”€ BOUNDARY CORNERS (sRGB Triangle Vertices) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // These define the absolute limits of what a standard monitor can display.
  // Source: IEC 61966-2-1 (sRGB specification)

  PRIMARY_RED: {
    label: 'sRGB Red',
    category: 'boundary',
    X: 0.4124, Y: 0.2126, Z: 0.0193
  },
  PRIMARY_GREEN: {
    label: 'sRGB Green',
    category: 'boundary',
    X: 0.3576, Y: 0.7152, Z: 0.1192
  },
  PRIMARY_BLUE: {
    label: 'sRGB Blue',
    category: 'boundary',
    X: 0.1805, Y: 0.0722, Z: 0.9505
  },

  // â”€â”€ WHITE POINTS (The "North Stars") â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // reference illuminants. Every conversion chains through one of these.

  D65: {
    label: 'D65 (Daylight)',
    category: 'whitepoint',
    X: 0.9505, Y: 1.0000, Z: 1.0888
  },
  D50: {
    label: 'D50 (Horizon / Print)',
    category: 'whitepoint',
    X: 0.9642, Y: 1.0000, Z: 0.8251
  },

  // â”€â”€ MACBETH CRITICAL TONES (Perceptual Debugging) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Hand-picked from the X-Rite ColorChecker Classic.
  // These are the colors that break first when math goes wrong.
  //
  // RULE: If DARK_SKIN looks green in any viewport, your math is broken.

  DARK_SKIN: {
    label: 'Dark Skin',
    category: 'macbeth',
    X: 0.1100, Y: 0.1000, Z: 0.0800
  },
  LIGHT_SKIN: {
    label: 'Light Skin',
    category: 'macbeth',
    X: 0.3800, Y: 0.3500, Z: 0.2500
  },
  SKY_BLUE: {
    label: 'Blue Sky',
    category: 'macbeth',
    X: 0.1900, Y: 0.2000, Z: 0.3500
  },
  FOLIAGE: {
    label: 'Foliage',
    category: 'macbeth',
    X: 0.1300, Y: 0.1700, Z: 0.1000
  },
};


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 2. PLANCKIAN CHECKPOINTS (Temperature Anchors)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Known-good CIE 1931 xy values at specific CCT points.
// Source: CIE 15:2004 polynomial approximation, cross-checked
// against Wyszecki & Stiles Table 1(3.11).
//
// These form the "spine" of the Planckian Locus verification.

export const PLANCKIAN_CHECKPOINTS: Array<{
  T: number;          // Correlated Color Temperature (Kelvin)
  x: number;          // CIE 1931 x chromaticity
  y: number;          // CIE 1931 y chromaticity
  label: string;      // Human-readable reference
}> = [
  { T: 1800,  x: 0.5405, y: 0.4066, label: 'Candlelight' },
  { T: 2700,  x: 0.4578, y: 0.4101, label: 'Warm White (Incandescent)' },
  { T: 3000,  x: 0.4369, y: 0.4041, label: 'Halogen' },
  { T: 4000,  x: 0.3804, y: 0.3768, label: 'Neutral (Fluorescent)' },
  { T: 5000,  x: 0.3451, y: 0.3516, label: 'Horizon Daylight' },
  { T: 5500,  x: 0.3346, y: 0.3451, label: 'Mid-Morning Sun' },
  { T: 6500,  x: 0.3127, y: 0.3290, label: 'D65 (Noon Daylight)' },
  { T: 7500,  x: 0.2990, y: 0.3149, label: 'Overcast Sky' },
  { T: 10000, x: 0.2807, y: 0.2884, label: 'Blue Sky' },
  { T: 15000, x: 0.2709, y: 0.2733, label: 'Clear North Sky' },
  { T: 20000, x: 0.2670, y: 0.2666, label: 'Deep Blue Sky' },
  { T: 25000, x: 0.2651, y: 0.2630, label: 'Extreme Blue' },
];


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 3. MESH CONNECTIONS (Calibration Wireframe)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Defines which anchor points to connect with lines
// to form the "Calibration Mesh" visualization.

export const MESH_EDGES: Array<[string, string]> = [
  // The sRGB Triangle
  ['PRIMARY_RED', 'PRIMARY_GREEN'],
  ['PRIMARY_GREEN', 'PRIMARY_BLUE'],
  ['PRIMARY_BLUE', 'PRIMARY_RED'],

  // White Point Rays (Spokes from center)
  ['D65', 'PRIMARY_RED'],
  ['D65', 'PRIMARY_GREEN'],
  ['D65', 'PRIMARY_BLUE'],

  // Macbeth Critical Tone Links
  ['D65', 'DARK_SKIN'],
  ['D65', 'LIGHT_SKIN'],
  ['D65', 'SKY_BLUE'],
  ['D65', 'FOLIAGE'],

  // Perceptual Discrimination Pairs
  // (How well does the space separate these?)
  ['DARK_SKIN', 'LIGHT_SKIN'],
  ['SKY_BLUE', 'FOLIAGE'],
];


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 4. HELPER: XYZ â†’ xyY for Adapter Mapping
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function xyzToXyY(xyz: XYZColor): { x: number; y: number; Y: number } {
  const sum = xyz.X + xyz.Y + xyz.Z;
  if (sum === 0) return { x: 0.3127, y: 0.3290, Y: 0 }; // D65 fallback
  return {
    x: xyz.X / sum,
    y: xyz.Y / sum,
    Y: xyz.Y
  };
}

