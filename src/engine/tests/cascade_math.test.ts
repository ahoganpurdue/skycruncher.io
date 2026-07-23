/**
 * CASCADE MATH — unit tests for the pure displacement-field evaluators + the
 * receipt→stage selector (the render-side coordinate math behind the 3D
 * Flattening Cascade widget). Pins the SIP/TPS/BC conventions against hand-
 * computed values and the honest NOT-MEASURED paths. No React / WebGL here.
 *
 * (Lives under src/engine/tests/ — the only path the vitest node-suite include
 * glob picks up; the widget source lives under ui/widgets/cascade/.)
 */

import { describe, it, expect } from 'vitest';
import {
  sipDisplacement,
  tpsDisplacement,
  bcDisplacement,
  bcModelFor,
  evalField,
  evalScalarField,
  zeroField,
  type TpsModel,
} from '../ui/widgets/cascade/cascade_math';
import { selectCascade, buildStageField } from '../ui/widgets/cascade/cascade_data';

describe('sipDisplacement — polynomial convention a[p][q]=u^p v^q', () => {
  it('evaluates a known 2×2 coefficient matrix (identity NOT folded in)', () => {
    // a = 0.1·u + 0.5·v ; b = 0. crpix at origin. (x,y)=(10,4) → u=10,v=4.
    const a = [[0, 0.5], [0.1, 0]];
    const b = [[0, 0], [0, 0]];
    const [du, dv] = sipDisplacement(10, 4, a, b, 0, 0);
    expect(du).toBeCloseTo(0.1 * 10 + 0.5 * 4, 12); // = 3
    expect(dv).toBe(0);
  });

  it('honors crpix offset', () => {
    const a = [[0, 0], [1, 0]]; // du = u = x - crpix_x
    const b = [[0, 0], [0, 0]];
    const [du] = sipDisplacement(100, 0, a, b, 40, 0);
    expect(du).toBeCloseTo(60, 12);
  });

  it('full 2×2 cross term: 1 + 2v + 3u + 4uv at (u,v)=(5,7) = 170', () => {
    const a = [[1, 2], [3, 4]];
    const [du] = sipDisplacement(5, 7, a, [[0, 0], [0, 0]], 0, 0);
    expect(du).toBeCloseTo(170, 10);
  });
});

describe('tpsDisplacement — normalized affine + shared evalTpsField', () => {
  it('affine-only field reduces to a0 + a1·uN + a2·vN', () => {
    const tps: TpsModel = {
      scale: 2,
      crpix: [0, 0],
      control_points: [],
      weights_x: [],
      weights_y: [],
      affine: { dx: [1, 2, 3], dy: [0, 0, 0] },
    };
    // (x,y)=(4,6) → u=4,v=6 → uN=2,vN=3 → du = 1 + 2·2 + 3·3 = 14
    const [du, dv] = tpsDisplacement(4, 6, tps);
    expect(du).toBeCloseTo(14, 10);
    expect(dv).toBe(0);
  });
});

describe('bcDisplacement — Brown-Conrady radial (engine model)', () => {
  it('k1=k2=0 ⇒ identity ⇒ zero displacement everywhere', () => {
    const model = bcModelFor({ k1: 0, k2: 0, width: 101, height: 101 });
    expect(bcDisplacement(0, 0, model)).toEqual([0, 0]);
    const [du, dv] = bcDisplacement(90, 12, model);
    expect(Math.hypot(du, dv)).toBeCloseTo(0, 12);
  });

  it('barrel prior fixes the optical center and displaces off-axis points', () => {
    const model = bcModelFor({ k1: -0.1, k2: 0, width: 101, height: 101 });
    const cx = 50, cy = 50;
    // center is fixed by radial symmetry
    const [cdu, cdv] = bcDisplacement(cx, cy, model);
    expect(Math.hypot(cdu, cdv)).toBeCloseTo(0, 9);
    // a corner moves
    const [du, dv] = bcDisplacement(0, 0, model);
    expect(Math.hypot(du, dv)).toBeGreaterThan(0.1);
  });
});

describe('evalField — grid reduction + stats', () => {
  it('constant displacement (3,4) ⇒ magnitude 5 everywhere; max=rms=5', () => {
    const f = evalField(8, 100, 100, () => [3, 4]);
    expect(f.n).toBe(8);
    expect(f.dz.length).toBe(64);
    expect(f.max).toBeCloseTo(5, 12);
    expect(f.rms).toBeCloseTo(5, 12);
  });

  it('zeroField is flat', () => {
    const f = zeroField(6, 10, 10);
    expect(f.max).toBe(0);
    expect(f.rms).toBe(0);
    expect([...f.dz].every((v) => v === 0)).toBe(true);
  });
});

describe('evalScalarField — absent cells are honest holes, excluded from rms', () => {
  it('a null sample writes 0 and is excluded from the rms mean', () => {
    let i = 0;
    const f = evalScalarField(2, 4, 4, () => (i++ === 0 ? null : 2));
    // 4 nodes: first null(→0, excluded), rest = 2. rms over present (3 twos) = 2.
    expect(f.max).toBeCloseTo(2, 12);
    expect(f.rms).toBeCloseTo(2, 12);
    expect(f.dz[0]).toBe(0);
  });
});

describe('selectCascade — honest presence / absence over a synthetic receipt', () => {
  const receipt = {
    metadata: { width: 200, height: 100 },
    wcs: { CRPIX1: 100, CRPIX2: 50 },
    solution: {
      astrometry: {
        sip: { a_order: 2, b_order: 2, a: [[0, 0], [0.001, 0]], b: [[0, 0], [0, 0]] },
        // no tps
      },
      // no lens_distortion_measured
    },
  };

  it('returns Original+SIP present, BC stages + TPS absent (NOT MEASURED)', () => {
    const c = selectCascade(receipt as any);
    expect(c).not.toBeNull();
    const byId = Object.fromEntries(c!.stages.map((s) => [s.id, s]));
    expect(byId.original.present).toBe(true);
    expect(byId.nominal_bc.present).toBe(false);
    expect(byId.measured_bc.present).toBe(false);
    expect(byId.sip.present).toBe(true);
    expect(byId.tps.present).toBe(false);
    // absent stages carry a reason, never a fabricated model
    expect(byId.tps.absentReason.length).toBeGreaterThan(0);
    expect(byId.nominal_bc.tps).toBeUndefined();
  });

  it('returns null when there is no frame geometry', () => {
    expect(selectCascade({ solution: {} } as any)).toBeNull();
    expect(selectCascade(null)).toBeNull();
  });

  it('buildStageField: present SIP stage has nonzero displacement; absent TPS is flat zero', () => {
    const c = selectCascade(receipt as any)!;
    const sip = c.stages.find((s) => s.id === 'sip')!;
    const tps = c.stages.find((s) => s.id === 'tps')!;
    const sipField = buildStageField(sip, 16, c);
    const tpsField = buildStageField(tps, 16, c);
    expect(sipField.max).toBeGreaterThan(0);
    expect(tpsField.max).toBe(0); // absent ⇒ zeroField, never a fake surface
  });
});
