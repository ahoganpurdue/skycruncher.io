/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CASCADE MATH — pure displacement-field evaluation over receipt coordinate
 * functions (COORDINATE ledger; RENDER-SIDE read only).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The 3D Flattening Cascade explorer visualises, per correction stage, the
 * displacement a stage's model applies to MATCHING coordinates on a reference
 * grid. This module is the single authoritative evaluator for those numbers;
 * it is pure (no React, no WebGL, no DOM) so the vitest gate can pin it exactly.
 *
 * TWO-LEDGER LAW: every function here reads a COORDINATE transform (a distortion
 * FUNCTION on sparse positions) and reports a per-node displacement magnitude in
 * PIXELS. Nothing here resamples an image, touches a pixel buffer, or mutates a
 * receipt — it is a read over already-fitted coordinate functions.
 *
 * NO DUPLICATED LOGIC (LAW 4): the TPS forward evaluator is IMPORTED from the
 * engine's shared `tps_eval` (the identical evaluator the fitter + ASDF writer
 * use — nothing drifts). Brown-Conrady is evaluated through the engine's
 * `makeBrownConradyDistortion`. Only the SIP polynomial sum is transcribed here
 * (the engine keeps its SIP forward inside the ASDF serializer's gwcs node); its
 * convention is pinned against hand-computed values in cascade_math.test.ts.
 *
 * The tools/widgets/capture_cascade.mjs harness carries a plain-JS MIRROR of
 * these formulas (no bundler/tsx is available to import TS into the standalone
 * HTML) — keep the two in sync; the unit test is the anchor for both.
 */

import { evalTpsField } from '../../../pipeline/m6_plate_solve/tps_eval';
import {
  makeBrownConradyDistortion,
  makeIdentityDistortion,
  type LensDistortionModel,
} from '../../../pipeline/m2_hardware/lens_distortion';

// ─── contracts ──────────────────────────────────────────────────────────────

/** A fitted SIP distortion (receipt.solution.astrometry.sip shape). */
export interface SipModel {
  /** a[p][q] = coefficient of u^p·v^q for the u-axis (u = x − crpix_x). */
  a: number[][];
  /** b[p][q] = coefficient of u^p·v^q for the v-axis (v = y − crpix_y). */
  b: number[][];
  a_order?: number;
  b_order?: number;
}

/** A fitted TPS distortion (receipt.solution.astrometry.tps shape). */
export interface TpsModel {
  /** Normalization scale — query/control coords are pixel-offset / scale. */
  scale: number;
  /** [crpix_x, crpix_y] pixel origin the offsets are taken from. */
  crpix: [number, number];
  /** Normalized control coordinates [[un,vn], …]. */
  control_points: number[][];
  weights_x: number[];
  weights_y: number[];
  /** Polynomial part: {dx:[a0,a1,a2], dy:[a0,a1,a2]}. */
  affine: { dx: [number, number, number]; dy: [number, number, number] };
}

/** A per-frame Brown-Conrady radial prior (nominal or measured). */
export interface BcModel {
  k1: number;
  k2: number;
  width: number;
  height: number;
}

/** A single evaluated displacement surface on an N×N reference grid. */
export interface DisplacementField {
  /** Grid resolution per axis. */
  n: number;
  /** Frame dimensions the grid spans, in pixels. */
  width: number;
  height: number;
  /**
   * Row-major dz[j*n + i] = displacement magnitude (px) at grid node
   * (i,j) → pixel ( i/(n-1)·(width-1), j/(n-1)·(height-1) ).
   */
  dz: Float32Array;
  /** max |displacement| over the grid, in pixels. */
  max: number;
  /** root-mean-square displacement over the grid, in pixels. */
  rms: number;
}

// ─── per-stage displacement evaluators (px) ───────────────────────────────────

/**
 * SIP displacement (px) at pixel (x,y). u = x − crpix_x, v = y − crpix_y.
 * du = Σ a[p][q] u^p v^q ; dv = Σ b[p][q] u^p v^q. The identity (u,v) is NOT
 * added — this is the pure distortion the SIP polynomial contributes (matches
 * the asdf_writer convention: coeff[p][q] indexes u^p v^q; the +u/+v identity is
 * folded in only when a gwcs node must map to u'/v' directly).
 */
export function sipDisplacement(
  x: number,
  y: number,
  a: number[][],
  b: number[][],
  crpixX: number,
  crpixY: number,
): [number, number] {
  const u = x - crpixX;
  const v = y - crpixY;
  return [polySum(a, u, v), polySum(b, u, v)];
}

/** Σ coeff[p][q] · u^p · v^q over a ragged coefficient matrix. */
function polySum(coeff: number[][], u: number, v: number): number {
  let s = 0;
  // Horner-free direct sum: powers are small (order ≤ ~4) so this is cheap and
  // matches the documented [p][q] = u^p v^q layout exactly.
  let up = 1;
  for (let p = 0; p < coeff.length; p++) {
    const row = coeff[p];
    if (Array.isArray(row)) {
      let vq = 1;
      for (let q = 0; q < row.length; q++) {
        const c = row[q];
        if (typeof c === 'number' && Number.isFinite(c)) s += c * up * vq;
        vq *= v;
      }
    }
    up *= u;
  }
  return s;
}

/**
 * TPS displacement (px) at pixel (x,y). Offsets are taken from tps.crpix and
 * normalized by tps.scale, then the shared engine evaluator is applied per axis
 * (weights_x/affine.dx → du, weights_y/affine.dy → dv). Identical wiring to the
 * ASDF writer's buildTpsCorrection lookup-table baker.
 */
export function tpsDisplacement(x: number, y: number, tps: TpsModel): [number, number] {
  const u = x - tps.crpix[0];
  const v = y - tps.crpix[1];
  const uN = u / tps.scale;
  const vN = v / tps.scale;
  const un = tps.control_points.map((p) => p[0]);
  const vn = tps.control_points.map((p) => p[1]);
  const du = evalTpsField(uN, vN, un, vn, tps.weights_x, tps.affine.dx);
  const dv = evalTpsField(uN, vN, un, vn, tps.weights_y, tps.affine.dy);
  return [du, dv];
}

/**
 * Brown-Conrady displacement (px) at pixel (x,y): the shift the native→corrected
 * (undistort) inverse applies. Evaluated through the engine's radial model so no
 * math is duplicated. k1=k2=0 ⇒ identity ⇒ zero everywhere.
 */
export function bcDisplacement(
  x: number,
  y: number,
  model: LensDistortionModel,
): [number, number] {
  const out: [number, number] = [0, 0];
  model.toCorrected(x, y, out);
  return [out[0] - x, out[1] - y];
}

/** Build the Brown-Conrady coordinate model for a BC stage (identity if flat). */
export function bcModelFor(bc: BcModel | null): LensDistortionModel {
  if (!bc || (bc.k1 === 0 && bc.k2 === 0)) {
    const w = bc?.width ?? 2;
    const h = bc?.height ?? 2;
    return makeIdentityDistortion(w, h);
  }
  return makeBrownConradyDistortion(bc.k1, bc.k2, bc.width, bc.height);
}

// ─── grid evaluation + stats ──────────────────────────────────────────────────

/**
 * Evaluate a displacement magnitude field over an N×N reference grid spanning
 * [0,width-1]×[0,height-1]. `displacementAt` returns the (du,dv) a stage applies
 * at a pixel; this reduces to |(du,dv)| per node and accumulates max/rms.
 */
export function evalField(
  n: number,
  width: number,
  height: number,
  displacementAt: (x: number, y: number) => [number, number],
): DisplacementField {
  const dz = new Float32Array(n * n);
  let max = 0;
  let sumSq = 0;
  for (let j = 0; j < n; j++) {
    const y = (j / (n - 1)) * (height - 1);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (width - 1);
      const [du, dv] = displacementAt(x, y);
      const mag = Math.hypot(du, dv);
      dz[j * n + i] = mag;
      if (mag > max) max = mag;
      sumSq += mag * mag;
    }
  }
  const rms = Math.sqrt(sumSq / (n * n));
  return { n, width, height, dz, max, rms };
}

/** A flat (all-zero) field of the given geometry — the Original/identity stage. */
export function zeroField(n: number, width: number, height: number): DisplacementField {
  return { n, width, height, dz: new Float32Array(n * n), max: 0, rms: 0 };
}

// ─── scalar-surface evaluation (LensProfile3D reuse) ──────────────────────────

/**
 * Sample an arbitrary scalar over an N×N grid (used by LensProfile3D for a PSF
 * FWHM / ellipticity / vignette surface). Same reduction shape as evalField but
 * the scalar is provided directly (already a measured quantity — never derived
 * here). Non-finite samples are left as 0 and excluded from max/rms so an absent
 * cell reads honestly as a hole, not a fabricated zero peak.
 */
export function evalScalarField(
  n: number,
  width: number,
  height: number,
  scalarAt: (x: number, y: number) => number | null,
): DisplacementField {
  const dz = new Float32Array(n * n);
  let max = 0;
  let sumSq = 0;
  let cnt = 0;
  for (let j = 0; j < n; j++) {
    const y = (j / (n - 1)) * (height - 1);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (width - 1);
      const s = scalarAt(x, y);
      const v = typeof s === 'number' && Number.isFinite(s) ? s : 0;
      dz[j * n + i] = v;
      if (v > max) max = v;
      if (s != null && Number.isFinite(s)) {
        sumSq += v * v;
        cnt++;
      }
    }
  }
  const rms = cnt > 0 ? Math.sqrt(sumSq / cnt) : 0;
  return { n, width, height, dz, max, rms };
}
