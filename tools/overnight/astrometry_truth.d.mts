// Type declarations for the PURE, side-effect-free exports of astrometry_truth.mjs
// (the module's `main()` is import.meta-guarded, so importing it in a .ts unit
// test runs no CLI). Keeps the tsc gate clean when the overnight test imports the
// scale-hint helper; hand-written to mirror the runtime exports 1:1 (the .mjs
// stays the single source of behavior — same pattern as rotation.d.mts).

/** A bounded scale search prior expanded from a known pixel scale. */
export interface ScaleHintBand {
  units: 'arcsecperpix';
  low: number;
  high: number;
  pixel_scale: number;
  tol: number;
}

/**
 * Expand a known pixel scale (arcsec/px) into a ±tol [low, high] band for use as
 * a solve-field search PRIOR. Returns null for a missing/invalid/non-positive
 * pixel scale (caller falls back to a BLIND solve). Default tol = 0.25.
 */
export function scaleHintBand(pixelScale: number | string | null | undefined, tol?: number): ScaleHintBand | null;

/** Parsed solve-field `.wcs` header (degrees + CD matrix). Throws if unusable. */
export function parseWcsFile(wcsPath: string): {
  crval1_deg: number;
  crval2_deg: number;
  cd: [number, number, number, number];
};
