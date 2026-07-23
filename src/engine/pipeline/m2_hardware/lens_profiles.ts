/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * LENS PROFILES â€” Vignetting + Distortion Correction Data
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * Each lens introduces two kinds of optical artifacts:
 *
 * 1. VIGNETTING (Light Falloff):
 *    Corners of the image are dimmer than the center.
 *    Modeled as: I(r) = 1 + kâ‚rÂ² + kâ‚‚râ´ + kâ‚ƒrâ¶
 *    where r is the normalized distance from center (0 = center, 1 = corner).
 *
 * 2. DISTORTION (Geometric Warp):
 *    Barrel (wide-angle) or pincushion (telephoto) distortion.
 *    Modeled with Brown-Conrady coefficients:
 *    x' = x(1 + kâ‚rÂ² + kâ‚‚râ´) + 2pâ‚xy + pâ‚‚(rÂ² + 2xÂ²)
 *    y' = y(1 + kâ‚rÂ² + kâ‚‚râ´) + pâ‚(rÂ² + 2yÂ²) + 2pâ‚‚xy
 *
 * These profiles are keyed by focal length because zoom lenses have
 * dramatically different characteristics at different focal lengths.
 */

// â”€â”€â”€ TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import { matchLens, type LensRegistryEntry } from './identifier_matcher';

export interface VignetteCoeffs {
  /** Quadratic falloff (most significant) */
  k1: number;
  /** Quartic falloff */
  k2: number;
  /** Sextic falloff (usually small) */
  k3: number;
}

export interface DistortionCoeffs {
  /** Radial distortion coefficient 1 (barrel < 0, pincushion > 0) */
  k1: number;
  /** Radial distortion coefficient 2 */
  k2: number;
  /** Radial distortion coefficient 3 (optional, defaults to 0) */
  k3?: number;
  /** Tangential distortion 1 (decentering) */
  p1: number;
  /** Tangential distortion 2 (decentering) */
  p2: number;
}

export interface LensProfile {
  /** Lens model name */
  model: string;
  /** Manufacturer */
  manufacturer: string;
  /** Supported focal lengths (fixed lens: 1 value, zoom: array of sampled values) */
  focal_lengths: number[];
  /** Vignetting coefficients keyed by focal length (mm) */
  vignette: Record<number, VignetteCoeffs>;
  /** Distortion coefficients keyed by focal length (mm) */
  distortion: Record<number, DistortionCoeffs>;
  /** Image circle diameter in mm (full-frame = ~43.3mm) */
  image_circle_mm: number;
  /** Maximum aperture at each focal length */
  max_aperture: Record<number, number>;
}

// â”€â”€â”€ LENS DATABASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const LENS_DB: Record<string, LensProfile> = {

  // â”€â”€ Canon RF 15-35mm f/2.8L IS USM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Ultra wide-angle zoom. Significant barrel distortion at 15mm,
  // moderate vignetting wide open.
  'CANON_RF_15_35': {
    model: 'RF 15-35mm f/2.8L IS USM',
    manufacturer: 'Canon',
    focal_lengths: [15, 20, 24, 28, 35],
    image_circle_mm: 43.3,
    max_aperture: { 15: 2.8, 20: 2.8, 24: 2.8, 28: 2.8, 35: 2.8 },
    vignette: {
      15: { k1: -0.45, k2:  0.25, k3: -0.08 },
      20: { k1: -0.35, k2:  0.18, k3: -0.05 },
      24: { k1: -0.28, k2:  0.12, k3: -0.03 },
      28: { k1: -0.22, k2:  0.08, k3: -0.02 },
      35: { k1: -0.18, k2:  0.05, k3: -0.01 },
    },
    distortion: {
      15: { k1: -0.035, k2:  0.008, p1: 0.0001, p2: 0.0002 },
      20: { k1: -0.018, k2:  0.003, p1: 0.0001, p2: 0.0001 },
      24: { k1: -0.008, k2:  0.001, p1: 0.0000, p2: 0.0001 },
      28: { k1: -0.003, k2:  0.000, p1: 0.0000, p2: 0.0000 },
      35: { k1:  0.001, k2:  0.000, p1: 0.0000, p2: 0.0000 },
    },
  },

  // â”€â”€ Sigma 14mm f/1.8 DG HSM Art â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Popular astro lens. Very fast, significant coma in corners wide open.
  'SIGMA_14_ART': {
    model: '14mm f/1.8 DG HSM Art',
    manufacturer: 'Sigma',
    focal_lengths: [14],
    image_circle_mm: 43.3,
    max_aperture: { 14: 1.8 },
    vignette: {
      14: { k1: -0.55, k2: 0.35, k3: -0.10 },
    },
    distortion: {
      14: { k1: -0.042, k2: 0.012, p1: 0.0002, p2: 0.0001 },
    },
  },

  // â”€â”€ Rokinon 14mm f/2.8 ED AS IF UMC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The "Mustache" Ultra-Wide. Famous for heavy, complex distortion.
  'ROKINON_14_MUSTACHE': {
    model: '14mm f/2.8 ED AS IF UMC',
    manufacturer: 'Rokinon / Samyang',
    focal_lengths: [14],
    image_circle_mm: 43.3,
    max_aperture: { 14: 2.8 },
    vignette: {
      14: { k1: -0.58, k2: 0.38, k3: -0.12 },
    },
    distortion: {
      14: { k1: -0.12, k2: 0.05, p1: 0, p2: 0 },
    },
  },

  // â”€â”€ Rokinon/Samyang 135mm f/2 ED UMC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Budget astro telephoto. Sharp center, noticeable vignetting at f/2.
  'ROKINON_135': {
    model: '135mm f/2 ED UMC',
    manufacturer: 'Rokinon / Samyang',
    focal_lengths: [135],
    image_circle_mm: 43.3,
    max_aperture: { 135: 2.0 },
    vignette: {
      135: { k1: -0.30, k2: 0.10, k3: -0.02 },
    },
    distortion: {
      135: { k1: 0.002, k2: 0.000, p1: 0.0000, p2: 0.0000 },
    },
  },

  // -- Fujinon XF 23mm f/2 R WR (Fujifilm X mount, APS-C prime) --------------
  // NOMINAL distortion prior added for the 2026-07-13 Fuji (X-Trans contrib) solve
  // campaign. APPROXIMATE by design (per the module doc + honest-or-absent):
  // superseded by a per-frame LM/SIP refit from real matched pairs (M7).
  //
  // SOURCE (public, LGPL): lensfun database data/db/mil-fujifilm.xml, entry
  //   <model>XF23mmF2 R WR</model> (calibrated on Fujifilm X-T10 / X-T2).
  //   https://github.com/lensfun/lensfun/blob/master/data/db/mil-fujifilm.xml
  //   lensfun ptlens model:  r_d = r_u * (a*r_u^3 + b*r_u^2 + c*r_u + (1-a-b-c))
  //   a=0.0289722  b=-0.0763625  c=0.0493558   (r_u = CORRECTED radius,
  //   r_d = distorted/native radius — SAME direction as makeBrownConradyDistortion).
  //
  // CONVENTION CONVERSION (the tangent-point/frame-center k1 trap; WHITEPAPER
  //   k1-audit history). lensfun normalizes r to HALF the SHORTER side (largest
  //   inscribed circle = 1.0); OUR engine normalizes r to the HALF-DIAGONAL
  //   (lens_distortion.ts). For the native 3:2 Fuji frame the ratio is
  //     gamma = half_short / half_diag = 1/sqrt((3/2)^2 + 1) = 0.55470,
  //   so r_ours = gamma * r_lensfun. The distortion FACTOR f = r_d/r_u is a pure
  //   ratio (normalization-independent), hence f_ours(r_ours) == f_lensfun(r_lensfun).
  //   Two STRUCTURAL mismatches make the fit APPROXIMATE (our model is EVEN-only,
  //   f = 1 + k1*r^2 + k2*r^4): (1) lensfun's dominant c*r_u factor term is a
  //   QUADRATIC displacement that our cubic-lowest displacement cannot reproduce;
  //   (2) lensfun anchors f=1 at r=1 (edge) whereas ours anchors f=1 at center.
  //   Overall radial scale is DEGENERATE with the plate scale a blind solve fits,
  //   so we least-squares-fit the differential SHAPE (a free scale offset is
  //   discarded) over the real rectangular frame (area-weighted). Result:
  //     k1 = -0.0420, k2 = +0.0375  (half-diagonal norm),
  //   RMS residual 2.2 px, max 17.7 px at the extreme corner on a 7728x5152
  //   frame. The lens is a MILD mustache (<= 0.86% peak distortion); the residual
  //   is the corner swing the even-only model cannot follow. Barrel-signed after
  //   scale removal (consistent with the ROKINON_14 nominal convention). p1=p2=0
  //   (radial-only port, per lens_distortion.ts). Reproducible derivation:
  //   tools/psf/fuji_xf23_ptlens_to_bc.mjs (raw fit -0.042036 / 0.037462).
  //
  // APPLICATION: engine AUTO-ON when a trusted, non-placeholder EXIF LensModel
  //   'XF23mmF2 R WR' resolves (exifr may not surface it from a RAF headless, so
  //   the campaign injects the identity via headless_driver overrides.lens_model
  //   -> EXIF_TRUSTED branch). COORDINATE ledger, MATCHING coords only; native
  //   photometry coords are never touched.
  'FUJINON_XF23_F2': {
    model: 'XF23mmF2 R WR',
    manufacturer: 'Fujifilm',
    focal_lengths: [23],
    image_circle_mm: 28.3, // APS-C X mount (43.27mm FF diagonal / 1.529 crop factor)
    max_aperture: { 23: 2.0 },
    vignette: {
      // APPROXIMATE, PIXEL-ledger, NOT solve-relevant. lensfun 'pa' vignetting at
      // f/2 wide-open (the astro case), I(r) = 1 + k1*r^2 + k2*r^4 + k3*r^6,
      // r half-diagonal-normalized per the lensfun vignetting convention. Verify
      // this normalization before any photometric (flat-field) use.
      23: { k1: -1.6352, k2: 1.3547, k3: -0.5138 },
    },
    distortion: {
      // See the conversion note above. lensfun ptlens (a,b,c) at half-short-side
      // norm -> even-only Brown-Conrady (k1,k2) at half-diagonal norm, shape fit.
      23: { k1: -0.0420, k2: 0.0375, p1: 0, p2: 0 },
    },
  },

  // â”€â”€ Generic Telescope (Newtonian Reflector) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Reflectors have no chromatic aberration but have coma.
  // Vignetting depends on secondary mirror obstruction.
  'TELESCOPE_NEWT': {
    model: 'Generic Newtonian Reflector',
    manufacturer: 'Various',
    focal_lengths: [750, 1000, 1200],
    image_circle_mm: 28.0,  // Typical for 2" focuser
    max_aperture: { 750: 3.75, 1000: 5.0, 1200: 6.0 },  // f/ratio
    vignette: {
      750:  { k1: -0.15, k2: 0.05, k3: -0.01 },
      1000: { k1: -0.12, k2: 0.03, k3: -0.01 },
      1200: { k1: -0.10, k2: 0.02, k3: 0.00 },
    },
    distortion: {
      750:  { k1: 0.000, k2: 0.000, p1: 0.0000, p2: 0.0000 },
      1000: { k1: 0.000, k2: 0.000, p1: 0.0000, p2: 0.0000 },
      1200: { k1: 0.000, k2: 0.000, p1: 0.0000, p2: 0.0000 },
    },
  },

  // â”€â”€ Generic Refractor (APO Triplet) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'TELESCOPE_APO': {
    model: 'Generic APO Refractor',
    manufacturer: 'Various',
    focal_lengths: [360, 480, 714],
    image_circle_mm: 44.0,
    max_aperture: { 360: 4.5, 480: 6.0, 714: 7.0 },
    vignette: {
      360: { k1: -0.08, k2: 0.02, k3: 0.00 },
      480: { k1: -0.06, k2: 0.01, k3: 0.00 },
      714: { k1: -0.04, k2: 0.01, k3: 0.00 },
    },
    distortion: {
      360: { k1: -0.001, k2: 0.000, p1: 0.0000, p2: 0.0000 },
      480: { k1:  0.000, k2: 0.000, p1: 0.0000, p2: 0.0000 },
      714: { k1:  0.001, k2: 0.000, p1: 0.0000, p2: 0.0000 },
    },
  },
};

// â”€â”€â”€ HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Find a lens profile by model name via the canonical lens matcher.
 *
 * The old body was a bidirectional `.includes()`, first-match-wins loop — the
 * HIGH live bug (flag #1): a bare `'14mm'` deterministically returned
 * `SIGMA_14_ART` (k1 −0.042) because Sigma iterates before
 * `ROKINON_14_MUSTACHE` (k1 −0.12), and `'35mm'` matched `'135mm'` by substring.
 * That wrong prior fed inverse Brown-Conrady on matching coords.
 *
 * Now: exact full-model → brand+focal agreement → honest null. A bare focal is
 * NEVER identity (siblings share it), so `'14mm'` → null (Sigma/Rokinon tie) and
 * `'35mm'` → null. Brand aliases honored (Samyang → Rokinon).
 */
export function findLensByModel(model: string): LensProfile | null {
  return matchLens({ model }, lensRegistry());
}

/** LENS_DB → registry view for the shared lens matcher. */
function lensRegistry(): LensRegistryEntry<LensProfile>[] {
  return Object.values(LENS_DB).map((profile) => ({
    entry: profile,
    model: profile.model,
    manufacturer: profile.manufacturer,
    focalLengths: profile.focal_lengths,
  }));
}

/**
 * Get interpolated vignetting coefficients for a focal length
 * that may fall between sampled values.
 */
export function interpolateVignette(
  profile: LensProfile,
  focalLength: number
): VignetteCoeffs {
  // Sort a COPY — `profile` is a live reference into the shared exported
  // LENS_DB (findLensByModel returns it uncopied), so an in-place sort would
  // mutate global state. Mirrors interpolateDistortion (lens_distortion.ts).
  const fls = [...profile.focal_lengths].sort((a, b) => a - b);

  // Exact match
  if (profile.vignette[focalLength]) return profile.vignette[focalLength];

  // Clamp to bounds
  if (focalLength <= fls[0]) return profile.vignette[fls[0]];
  if (focalLength >= fls[fls.length - 1]) return profile.vignette[fls[fls.length - 1]];

  // Linear interpolation between two nearest sampled focal lengths
  for (let i = 0; i < fls.length - 1; i++) {
    if (focalLength >= fls[i] && focalLength <= fls[i + 1]) {
      const t = (focalLength - fls[i]) / (fls[i + 1] - fls[i]);
      const a = profile.vignette[fls[i]];
      const b = profile.vignette[fls[i + 1]];
      return {
        k1: a.k1 + t * (b.k1 - a.k1),
        k2: a.k2 + t * (b.k2 - a.k2),
        k3: a.k3 + t * (b.k3 - a.k3),
      };
    }
  }

  return profile.vignette[fls[0]]; // Fallback
}

/**
 * Compute vignetting correction factor at a normalized radius (0-1).
 * Returns a multiplicative correction: multiply pixel value by this.
 */
export function vignetteCorrection(coeffs: VignetteCoeffs, r: number): number {
  const r2 = r * r;
  const r4 = r2 * r2;
  const r6 = r4 * r2;
  const falloff = 1.0 + coeffs.k1 * r2 + coeffs.k2 * r4 + coeffs.k3 * r6;
  // Invert: if falloff = 0.8 (20% dimmer), correction = 1/0.8 = 1.25
  return falloff > 0.01 ? 1.0 / falloff : 1.0;
}

