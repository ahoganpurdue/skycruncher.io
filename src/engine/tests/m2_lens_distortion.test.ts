// Unit tests for the lens-prior distortion coordinate functions
// (src/engine/pipeline/m2_hardware/lens_distortion.ts) — NEXT_MOVES §8.
//
// CORE CORRECTNESS PROOF (Increment 1): a synthetic barrel-warped star field
// generated with the ROKINON_14_MUSTACHE coefficients (k1=-0.12, k2=0.05) is
// recovered to rectilinear positions by the inverse Brown-Conrady undistortion
// within sub-pixel tolerance — while the warp itself is hundreds of pixels at
// the corner (so the recovery is a real proof, not a trivial pass).
//
// These are pure coordinate-ledger primitives (no wasm/IO), tested directly and
// deterministically. The end-to-end solve improvement (sweep-peak σ with vs
// without the prior) is measured through the real solver_entry path separately.

import { describe, it, expect } from 'vitest';
import {
  makeBrownConradyDistortion,
  makeIdentityDistortion,
  interpolateDistortion,
} from '../pipeline/m2_hardware/lens_distortion';
import { LENS_DB } from '../pipeline/m2_hardware/lens_profiles';

const ROKINON_14 = LENS_DB.ROKINON_14_MUSTACHE.distortion[14];

// A representative full-frame DSLR geometry (close to the gauntlet CR2 dims).
const W = 5202;
const H = 3465;
const K1 = -0.12; // ROKINON_14 "mustache" barrel
const K2 = 0.05;

describe('makeBrownConradyDistortion — inverse recovers a barrel-warped field', () => {
  const m = makeBrownConradyDistortion(K1, K2, W, H);

  it('recovers rectilinear positions from forward-distorted ones (sub-pixel)', () => {
    // Sample a grid of TRUE (rectilinear / corrected) star positions, push them
    // through the forward lens model (toNative = what the barrel lens produces),
    // then undistort (toCorrected) and confirm we land back on the true grid.
    let maxErr = 0;
    let maxWarp = 0;
    const out: [number, number] = [0, 0];
    const back: [number, number] = [0, 0];
    for (let gx = 0; gx <= 10; gx++) {
      for (let gy = 0; gy <= 10; gy++) {
        const trueX = (gx / 10) * (W - 1);
        const trueY = (gy / 10) * (H - 1);
        m.toNative(trueX, trueY, out); // simulate the lens: corrected -> native
        m.toCorrected(out[0], out[1], back); // undistort: native -> corrected
        const err = Math.hypot(back[0] - trueX, back[1] - trueY);
        const warp = Math.hypot(out[0] - trueX, out[1] - trueY);
        if (err > maxErr) maxErr = err;
        if (warp > maxWarp) maxWarp = warp;
      }
    }
    // The distortion is severe (barrel pulls the corners inward by >100 px)...
    expect(maxWarp).toBeGreaterThan(100);
    // ...yet the inverse recovers every point to well under a pixel.
    expect(maxErr).toBeLessThan(0.05);
  });

  it('is exact at the optical center (r=0 fixed point)', () => {
    const out: [number, number] = [0, 0];
    m.toCorrected(m.cx, m.cy, out);
    expect(out[0]).toBeCloseTo(m.cx, 9);
    expect(out[1]).toBeCloseTo(m.cy, 9);
    m.toNative(m.cx, m.cy, out);
    expect(out[0]).toBeCloseTo(m.cx, 9);
    expect(out[1]).toBeCloseTo(m.cy, 9);
  });

  it('round-trips both directions to sub-pixel (native->corrected->native)', () => {
    const a: [number, number] = [0, 0];
    const b: [number, number] = [0, 0];
    // A far-corner point where the distortion is largest.
    m.toCorrected(W - 1, H - 1, a);
    m.toNative(a[0], a[1], b);
    expect(b[0]).toBeCloseTo(W - 1, 2);
    expect(b[1]).toBeCloseTo(H - 1, 2);
  });

  it('barrel (k1<0) pulls a corner star inward toward center', () => {
    const out: [number, number] = [0, 0];
    // Distorted corner is closer to center than the true corner (r_d < r_u).
    m.toNative(W - 1, H - 1, out);
    const rTrue = Math.hypot(W - 1 - m.cx, H - 1 - m.cy);
    const rDist = Math.hypot(out[0] - m.cx, out[1] - m.cy);
    expect(rDist).toBeLessThan(rTrue);
    // shiftAt(1) at the corner reports the same magnitude, hundreds of px.
    expect(m.shiftAt(1)).toBeGreaterThan(100);
  });
});

describe('makeIdentityDistortion — true no-op', () => {
  const id = makeIdentityDistortion(W, H);
  it('leaves any point unchanged in both directions', () => {
    const out: [number, number] = [0, 0];
    for (const [x, y] of [[0, 0], [W - 1, H - 1], [1234.5, 678.9], [m2cx(W), m2cy(H)]]) {
      id.toCorrected(x, y, out);
      expect(out[0]).toBe(x);
      expect(out[1]).toBe(y);
      id.toNative(x, y, out);
      expect(out[0]).toBe(x);
      expect(out[1]).toBe(y);
    }
    expect(id.shiftAt(1)).toBe(0);
    expect(id.k1).toBe(0);
    expect(id.k2).toBe(0);
  });
});

describe('interpolateDistortion — mirrors interpolateVignette shape', () => {
  it('returns the exact ROKINON_14 coeffs at focal 14', () => {
    const d = interpolateDistortion(LENS_DB.ROKINON_14_MUSTACHE, 14);
    expect(d.k1).toBeCloseTo(ROKINON_14.k1, 12);
    expect(d.k2).toBeCloseTo(ROKINON_14.k2, 12);
    expect(d.p1).toBe(0);
    expect(d.p2).toBe(0);
  });

  it('linearly blends a zoom lens between sampled focal lengths', () => {
    // CANON_RF_15_35: 15mm k1=-0.035, 20mm k1=-0.018. Midpoint 17.5mm.
    const d = interpolateDistortion(LENS_DB.CANON_RF_15_35, 17.5);
    expect(d.k1).toBeCloseTo((-0.035 + -0.018) / 2, 6);
    expect(d.k2).toBeCloseTo((0.008 + 0.003) / 2, 6);
  });

  it('clamps below the shortest and above the longest sampled focal', () => {
    const lo = interpolateDistortion(LENS_DB.CANON_RF_15_35, 10);
    expect(lo.k1).toBeCloseTo(-0.035, 12); // clamps to 15mm entry
    const hi = interpolateDistortion(LENS_DB.CANON_RF_15_35, 60);
    expect(hi.k1).toBeCloseTo(0.001, 12); // clamps to 35mm entry
  });

  it('does NOT mutate LENS_DB.focal_lengths order (defensive vs interpolateVignette)', () => {
    const before = [...LENS_DB.CANON_RF_15_35.focal_lengths];
    interpolateDistortion(LENS_DB.CANON_RF_15_35, 33); // would sort-in-place if buggy
    expect(LENS_DB.CANON_RF_15_35.focal_lengths).toEqual(before);
  });
});

// tiny helpers to reference the frame center in the identity test
function m2cx(w: number): number {
  return (w - 1) / 2;
}
function m2cy(h: number): number {
  return (h - 1) / 2;
}
