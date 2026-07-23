// WIRING_SPEC R3 — toNative re-projection round-trip proof.
//
// The R3 wire (solver_entry.ts) un-skips forced photometry under an active
// lens-distortion prior by re-projecting predicted catalog/probe positions from
// the solve's UN-DISTORTED matching space back into NATIVE pixel space through
// makeBrownConradyDistortion.toNative — the SAME forward model the BC-rematch
// pass uses (lens_distortion_rematch.ts:104). This proves the transform pair the
// wire depends on is a consistent inverse: undistort (toCorrected) → re-distort
// (toNative) recovers the original native pixel to sub-nano-pixel precision, and
// the mapping is a genuine (non-trivial) displacement, not an accidental no-op.
//
// Pure coordinate-ledger primitives (no wasm/IO). The end-to-end un-skip (forced
// photometry RUNS, confirm_status computes) is exercised through the real
// pipeline separately.

import { describe, it, expect } from 'vitest';
import { makeBrownConradyDistortion } from '../pipeline/m2_hardware/lens_distortion';

// Full-frame DSLR geometry (close to the gauntlet CR2 / Fuji XF23 dims).
const W = 5202;
const H = 3465;

// Realistic synthetic priors: the Fuji XF23 LENS_DB half-diagonal coefficients
// (the live X-Trans campaign prior) and the ROKINON_14 "mustache" barrel.
const CASES: Array<{ name: string; k1: number; k2: number }> = [
  { name: 'XF23 (k1=-0.0420, k2=+0.0375)', k1: -0.0420, k2: 0.0375 },
  { name: 'ROKINON_14 mustache (k1=-0.12, k2=0.05)', k1: -0.12, k2: 0.05 },
  { name: 'mild pincushion (k1=+0.08, k2=-0.03)', k1: 0.08, k2: -0.03 },
];

describe('WIRING_SPEC R3 — undistort→toNative round-trip is a consistent inverse', () => {
  for (const c of CASES) {
    it(`recovers native pixels to <=1e-9 px across the frame: ${c.name}`, () => {
      const m = makeBrownConradyDistortion(c.k1, c.k2, W, H);
      const u: [number, number] = [0, 0];
      const back: [number, number] = [0, 0];
      let maxRoundTrip = 0;
      let maxDisplacement = 0;
      // Sample a dense grid of NATIVE pixel positions (where star light lands),
      // undistort to matching space, then re-project via toNative — the exact
      // composition the R3 wire relies on when it re-projects catalog probes.
      for (let gx = 0; gx <= 20; gx++) {
        for (let gy = 0; gy <= 20; gy++) {
          const nx = (gx / 20) * (W - 1);
          const ny = (gy / 20) * (H - 1);
          m.toCorrected(nx, ny, u);       // native -> undistorted (matching space)
          m.toNative(u[0], u[1], back);    // undistorted -> native (the R3 re-projection)
          const rt = Math.hypot(back[0] - nx, back[1] - ny);
          const disp = Math.hypot(u[0] - nx, u[1] - ny); // how far the lens moved it
          if (rt > maxRoundTrip) maxRoundTrip = rt;
          if (disp > maxDisplacement) maxDisplacement = disp;
        }
      }
      // The re-projection recovers every native pixel to sub-nano-pixel precision.
      expect(maxRoundTrip).toBeLessThanOrEqual(1e-9);
      // ...and the transform is a REAL displacement (>10 px at the edges), so the
      // round-trip proves an inverse, not a trivial identity.
      expect(maxDisplacement).toBeGreaterThan(10);
    });
  }

  it('re-projects a probe LIST element-wise via toNative, preserving extra fields', () => {
    // Mirrors reprojectProbesToNative's contract (spread-through of mag/gaia_id).
    const m = makeBrownConradyDistortion(-0.0420, 0.0375, W, H);
    const probes = [
      { x: 100, y: 120, mag: 8.1, gaia_id: 'g1' },
      { x: W - 200, y: H - 150, mag: 9.4, gaia_id: 'g2' },
      { x: (W - 1) / 2, y: (H - 1) / 2, mag: 6.0, gaia_id: 'center' },
    ];
    const t: [number, number] = [0, 0];
    const reproj = probes.map((p) => {
      m.toNative(p.x, p.y, t);
      return { ...p, x: t[0], y: t[1] };
    });
    // Extra fields survive; count preserved (1:1).
    expect(reproj).toHaveLength(probes.length);
    expect(reproj[0].mag).toBe(8.1);
    expect(reproj[0].gaia_id).toBe('g1');
    // The frame CENTER is the distortion fixed point — toNative leaves it put.
    expect(reproj[2].x).toBeCloseTo((W - 1) / 2, 9);
    expect(reproj[2].y).toBeCloseTo((H - 1) / 2, 9);
    // An off-center probe genuinely moves under the prior.
    expect(Math.hypot(reproj[0].x - probes[0].x, reproj[0].y - probes[0].y)).toBeGreaterThan(1);
  });
});
