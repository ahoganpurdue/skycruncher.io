// ═══════════════════════════════════════════════════════════════════════════
// ITERATIVE-BC lane — pure coordinate math (COORDINATE ledger)
// ═══════════════════════════════════════════════════════════════════════════
// Incubator lane for the ROADMAP-DRAFT iterative Brown-Conrady loop
// (docs/02-specs/ITERATIVE_BC_SPEC.md). This module carries ONLY pure, side
// effect-free coordinate functions used by the loop's target-enumeration step.
//
// DELIBERATE DRY: the Brown-Conrady model is imported from the shared incubator
// original `tools/psf/corrections.mjs::makeBrownConrady` (which the engine
// module `src/engine/pipeline/m2_hardware/lens_distortion.ts` ports verbatim).
// We do NOT re-implement it here — single source of truth for the k1/k2 radial
// model (r normalized to the half-diagonal, optical center = frame center).
//
// The linear TAN (gnomonic) sky->pixel projector below reproduces the engine's
// forced-harvest projector `m6_plate_solve/deep_verify.ts::projectCatalogToPixels`
// (linear gnomonic, no SIP) to the receipt's own convention: on the banked M66
// receipt the frame-center matched star reprojects to 0.01 px, and the engine's
// own forced-recovered stars (bc_rematch.recovered_stars, which carry both sky
// and native pixel) reproject to within the forced aperture (2.4-7.6 px, vs a
// ~23 px wide search tolerance). The residual is the un-applied SIP higher-order
// term that the engine's forced leg ALSO omits — absorbed by the aperture, never
// silently corrected here (honest-or-absent).

import { makeBrownConrady, makeIdentityCoordFn } from '../psf/corrections.mjs';

export { makeBrownConrady, makeIdentityCoordFn };

const D2R = Math.PI / 180;

/**
 * Build a linear TAN (gnomonic) sky->pixel projector from a FITS-style WCS
 * header (CRVALn in DEGREES, CRPIXn, CDi_j in deg/px). Convention matches the
 * engine's fitted-WCS receipt block ("engine pixel convention, 0-based, y-down"):
 * pixel = CD^-1 . (xi, eta) + CRPIX, with the intermediate world coords (xi, eta)
 * in DEGREES. Verified against the M66 receipt (center matched star 0.01 px).
 *
 * @param {object} w - WCS with CRVAL1/2, CRPIX1/2, CD1_1/CD1_2/CD2_1/CD2_2.
 * @returns {(raDeg:number, decDeg:number) => [number, number]}
 */
export function makeTanProjector(w) {
  const det = w.CD1_1 * w.CD2_2 - w.CD1_2 * w.CD2_1;
  if (!(Math.abs(det) > 0)) throw new Error('makeTanProjector: singular CD matrix');
  const iCD = [
    [w.CD2_2 / det, -w.CD1_2 / det],
    [-w.CD2_1 / det, w.CD1_1 / det],
  ];
  const ra0 = w.CRVAL1 * D2R;
  const dec0 = w.CRVAL2 * D2R;
  const sinDec0 = Math.sin(dec0);
  const cosDec0 = Math.cos(dec0);
  return function project(raDeg, decDeg) {
    const a = raDeg * D2R;
    const d = decDeg * D2R;
    const cosc = sinDec0 * Math.sin(d) + cosDec0 * Math.cos(d) * Math.cos(a - ra0);
    const xi = (Math.cos(d) * Math.sin(a - ra0)) / cosc / D2R;
    const eta = (cosDec0 * Math.sin(d) - sinDec0 * Math.cos(d) * Math.cos(a - ra0)) / cosc / D2R;
    const x = iCD[0][0] * xi + iCD[0][1] * eta + w.CRPIX1;
    const y = iCD[1][0] * xi + iCD[1][1] * eta + w.CRPIX2;
    return [x, y];
  };
}

/** Normalized radius r ∈ [0, ~1] of a pixel from frame center, in half-diagonal units. */
export function normRadius(x, y, w, h) {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const hd = Math.hypot(cx, cy);
  return Math.hypot(x - cx, y - cy) / hd;
}

/** Standard radial bin edges for coverage histograms (10 bins over [0,1], plus overflow). */
export const RADIAL_BINS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

/** Assign an r_norm to a labeled radial bin string, e.g. "0.6-0.7" or ">=1.0". */
export function radialBinLabel(r) {
  if (r >= 1.0) return '>=1.0';
  for (let i = RADIAL_BINS.length - 1; i >= 1; i--) {
    if (r >= RADIAL_BINS[i - 1]) return `${RADIAL_BINS[i - 1].toFixed(1)}-${RADIAL_BINS[i].toFixed(1)}`;
  }
  return '0.0-0.1';
}

/** Build an empty radial-coverage histogram (all bins present, count 0). */
export function emptyRadialHistogram() {
  const h = {};
  for (let i = 1; i < RADIAL_BINS.length; i++) {
    h[`${RADIAL_BINS[i - 1].toFixed(1)}-${RADIAL_BINS[i].toFixed(1)}`] = 0;
  }
  h['>=1.0'] = 0;
  return h;
}

/**
 * Deduplicate catalog-cone rows by a key (default star_id), keeping the FIRST
 * occurrence. The banked miss_population cone carries overlapping magnitude-depth
 * slices (e.g. M66 G<17 ⊂ G<19.5), so a raw row count double-counts stars — the
 * same defect the m4-recall report flagged. Deterministic (input order preserved).
 */
export function dedupByKey(rows, key = 'star_id') {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = r[key] == null ? `__null_${out.length}` : String(r[key]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** Round to a fixed number of decimals for byte-stable JSON emission. */
export function r6(v) {
  if (v == null || !Number.isFinite(v)) return v;
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Deterministic, stable JSON stringify: object keys are emitted in the order they
 * were inserted (V8 preserves insertion order for string keys), arrays as-is.
 * Callers build objects in a fixed key order and sort arrays deterministically,
 * so JSON.stringify with a fixed indent is byte-stable across runs. Provided as a
 * named helper so the intent (byte-stability) is explicit at call sites.
 */
export function stableStringify(obj) {
  return JSON.stringify(obj, null, 2);
}
