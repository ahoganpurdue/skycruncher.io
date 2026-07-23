// Unit tests for the Validation & Graduation Harness GROUND-TRUTH layer
// (tools/validation/truth/ — Enhancement 1). Pure, ZERO calibrated-path
// dependency. Covers: TRUE/FALSE/NO_TRUTH verdicts, parity/rotation edges,
// astrometry.net forward-compat ingestion, the loader resolution order
// (labels / injected-FITS / bundled / honest-absent), and the harness hook
// feeding new_false_positive through the UNCHANGED SOLVER delta.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  compareToTruth,
  angularSeparationDeg,
  rotationErrorDeg,
  circularDiffDeg,
  type SolvedWcs,
} from '../../../tools/validation/truth/compare.ts';
import {
  fromAstrometryNetWcs,
  fromAstrometryNetCalibration,
  DEFAULT_TOLERANCES,
  type TruthLabel,
} from '../../../tools/validation/truth/schema.ts';
import {
  resolveTruth,
  resolveTruthFromLabels,
  loadLabelsFile,
  BUNDLED_KNOWN,
  type FitsDeriver,
} from '../../../tools/validation/truth/loader.ts';
import {
  adjudicateSolverResult,
  applyTruthToRunResult,
  extractSolvedWcs,
  recordedCenterIsFrameCenter,
} from '../../../tools/validation/truth/harness_hook.ts';
import {
  extractSolverOutcome,
  computeSolverDelta,
} from '../../../tools/validation/domains.ts';
import type { RunResult } from '../../../tools/validation/types.ts';

// ── fixtures ──────────────────────────────────────────────────────────────────
const CR2_TRUTH: TruthLabel = {
  frame_id: 'sample_observation',
  source: 'bundled_known',
  ra_hours: 17.5858,
  dec_degrees: -33.83,
  pixel_scale_arcsec: 63.211,
  rotation_deg: 155.65,
  parity: 1,
  provenance_note: 'test',
};

// SeeStar M66 seed truth (header-derived).
const M66_TRUTH: TruthLabel = {
  frame_id: 'm66',
  source: 'fits_header',
  ra_hours: 11.3616668701172,
  dec_degrees: 12.8419437408447,
  pixel_scale_arcsec: 3.73854960875,
  provenance_note: 'nominal-FL scale',
};

describe('truth · angular separation', () => {
  it('is ~0 for identical points', () => {
    expect(angularSeparationDeg(17.5858, -33.83, 17.5858, -33.83)).toBeCloseTo(0, 9);
  });
  it('1h RA at the equator ≈ 15°', () => {
    expect(angularSeparationDeg(0, 0, 1, 0)).toBeCloseTo(15, 6);
  });
  it('shrinks with cos(dec) — 1h RA at dec 60° ≈ 7.5°', () => {
    // small-angle-ish: separation ≈ 15° · cos(60°) = 7.5°
    expect(angularSeparationDeg(0, 60, 1, 60)).toBeGreaterThan(7);
    expect(angularSeparationDeg(0, 60, 1, 60)).toBeLessThan(7.6);
  });
});

describe('truth · compareToTruth verdicts', () => {
  it('solved ≈ truth → TRUE_POSITIVE', () => {
    const solved: SolvedWcs = {
      ra_hours: 17.5858,
      dec_degrees: -33.83,
      pixel_scale_arcsec: 63.211,
      rotation_deg: 155.65,
      parity: 1,
    };
    const r = compareToTruth(solved, CR2_TRUTH);
    expect(r.verdict).toBe('TRUE_POSITIVE');
    expect(r.reasons).toEqual([]);
    expect(r.center_sep_deg).toBeCloseTo(0, 6);
  });

  it('real M66 seed: solved center 0.3° off + 1.6% scale still TRUE_POSITIVE within default tol', () => {
    // solved RA = 11.341253h (sacred SeeStar e2e); same dec; solved scale 3.6776.
    const solved: SolvedWcs = {
      ra_hours: 11.341253475172621,
      dec_degrees: 12.8419437408447,
      pixel_scale_arcsec: 3.6776147325019153,
    };
    const r = compareToTruth(solved, M66_TRUTH);
    expect(r.verdict).toBe('TRUE_POSITIVE');
    expect(r.center_sep_deg!).toBeLessThan(0.5);
    expect(r.scale_err_frac!).toBeLessThan(0.05);
    expect(r.scale_err_frac!).toBeGreaterThan(0.01); // the honest nominal-FL gap
  });

  it('solved center far off → FALSE_POSITIVE (center)', () => {
    const solved: SolvedWcs = { ra_hours: 5.0, dec_degrees: 20.0, pixel_scale_arcsec: 63.211 };
    const r = compareToTruth(solved, CR2_TRUTH);
    expect(r.verdict).toBe('FALSE_POSITIVE');
    expect(r.reasons.join(' ')).toMatch(/center/);
  });

  it('solved scale wrong → FALSE_POSITIVE (scale)', () => {
    const solved: SolvedWcs = { ra_hours: 17.5858, dec_degrees: -33.83, pixel_scale_arcsec: 40.0 };
    const r = compareToTruth(solved, CR2_TRUTH);
    expect(r.verdict).toBe('FALSE_POSITIVE');
    expect(r.reasons.join(' ')).toMatch(/scale/);
  });

  it('no label → NO_TRUTH (honest-absent, never a guessed verdict)', () => {
    const solved: SolvedWcs = { ra_hours: 17.5858, dec_degrees: -33.83 };
    const r = compareToTruth(solved, null);
    expect(r.verdict).toBe('NO_TRUTH');
    expect(r.center_sep_deg).toBeNull();
    expect(r.reasons).toEqual([]);
  });

  it('absent scale on the solved side → scale axis SKIPPED, not failed', () => {
    const solved: SolvedWcs = { ra_hours: 17.5858, dec_degrees: -33.83 }; // no scale
    const r = compareToTruth(solved, CR2_TRUTH);
    expect(r.scale_err_frac).toBeNull();
    expect(r.verdict).toBe('TRUE_POSITIVE');
  });

  it('per-label tolerance override tightens the gate', () => {
    const solved: SolvedWcs = { ra_hours: 17.5858, dec_degrees: -33.83, pixel_scale_arcsec: 63.9 };
    // 1.1% scale error — passes default 5%, fails a tightened 0.5%.
    expect(compareToTruth(solved, CR2_TRUTH).verdict).toBe('TRUE_POSITIVE');
    const tightened: TruthLabel = { ...CR2_TRUTH, tolerances: { scale_frac: 0.005 } };
    expect(compareToTruth(solved, tightened).verdict).toBe('FALSE_POSITIVE');
  });
});

describe('truth · rotation + parity edge cases', () => {
  it('circularDiff wraps across 360', () => {
    expect(circularDiffDeg(359, 1)).toBeCloseTo(2, 9);
    expect(circularDiffDeg(10, 350)).toBeCloseTo(20, 9);
  });

  it('matching parity compares rotation directly', () => {
    expect(rotationErrorDeg(155.65, 155.65, 1, 1)).toBeCloseTo(0, 9);
    expect(rotationErrorDeg(160, 150, 1, 1)).toBeCloseTo(10, 9);
  });

  it('opposite parity compares against the mirrored (−θ) truth', () => {
    // truth rot 30°, mirrored → −30° ≡ 330°. A solved 330° with flipped parity matches.
    expect(rotationErrorDeg(330, 30, -1, 1)).toBeCloseTo(0, 9);
    // same numbers but matching parity would be a 60° (330 vs 30) error.
    expect(rotationErrorDeg(330, 30, 1, 1)).toBeCloseTo(60, 9);
  });

  it('unknown parity → lenient MIN(direct, mirrored) (never assert sign)', () => {
    // direct 60°, mirrored 0° → min 0.
    expect(rotationErrorDeg(330, 30, null, undefined)).toBeCloseTo(0, 9);
  });

  it('absent rotation → axis skipped (null)', () => {
    expect(rotationErrorDeg(null, 30, 1, 1)).toBeNull();
    expect(rotationErrorDeg(30, undefined, 1, 1)).toBeNull();
  });

  it('a genuine rotation mismatch (matched parity) → FALSE_POSITIVE', () => {
    const solved: SolvedWcs = { ra_hours: 17.5858, dec_degrees: -33.83, rotation_deg: 90, parity: 1 };
    const r = compareToTruth(solved, CR2_TRUTH);
    expect(r.verdict).toBe('FALSE_POSITIVE');
    expect(r.reasons.join(' ')).toMatch(/rotation/);
  });
});

describe('truth · astrometry.net forward-compat ingestion', () => {
  it('CD-matrix .wcs maps to hours/deg/scale/rotation/parity', () => {
    // Build a CD for scale 63.211"/px, north-up-ish. 63.211"/px = 0.017558625°/px.
    const s = 63.211 / 3600;
    // parity "positive" ⇒ det(CD) < 0 ⇒ RA axis flipped: CD1_1 = −s.
    const wcs = {
      crval1_deg: 17.5858 * 15, // 263.787°
      crval2_deg: -33.83,
      cd: [-s, 0, 0, s] as [number, number, number, number],
    };
    const label = fromAstrometryNetWcs(wcs, 'anet_frame');
    expect(label.source).toBe('astrometry_net');
    expect(label.ra_hours).toBeCloseTo(17.5858, 6);
    expect(label.dec_degrees).toBeCloseTo(-33.83, 6);
    expect(label.pixel_scale_arcsec!).toBeCloseTo(63.211, 3);
    expect(label.parity).toBe(1); // det < 0
    expect(typeof label.rotation_deg).toBe('number');
  });

  it('API calibration blob maps cleanly (pixscale/orientation/parity)', () => {
    const cal = { ra: 263.787, dec: -33.83, pixscale: 63.211, orientation: 155.65, parity: 1.0 };
    const label = fromAstrometryNetCalibration(cal, 'anet_frame');
    expect(label.ra_hours).toBeCloseTo(17.5858, 5);
    expect(label.dec_degrees).toBeCloseTo(-33.83, 6);
    expect(label.pixel_scale_arcsec).toBe(63.211);
    expect(label.rotation_deg).toBe(155.65);
    expect(label.parity).toBe(1);
  });

  it('an astrometry.net label then grades a solved WCS end-to-end', () => {
    const cal = { ra: 263.787, dec: -33.83, pixscale: 63.211, orientation: 155.65, parity: 1.0 };
    const label = fromAstrometryNetCalibration(cal, 'anet_frame');
    const solved: SolvedWcs = { ra_hours: 17.5858, dec_degrees: -33.83, pixel_scale_arcsec: 63.2, rotation_deg: 155.7, parity: 1 };
    expect(compareToTruth(solved, label).verdict).toBe('TRUE_POSITIVE');
  });
});

describe('truth · loader resolution order + honest-absent', () => {
  it('resolveTruthFromLabels: explicit → bundled → null', () => {
    expect(resolveTruthFromLabels('sample_observation', [])!.source).toBe('bundled_known');
    expect(resolveTruthFromLabels('sample_observation', [], { allowBundled: false })).toBeNull();
    expect(resolveTruthFromLabels('nope', [])).toBeNull();
    const explicit: TruthLabel = { ...CR2_TRUTH, provenance_note: 'override' };
    expect(resolveTruthFromLabels('sample_observation', [explicit])!.provenance_note).toBe('override');
  });

  it('bundled CR2 table carries the pinned answer', () => {
    const b = BUNDLED_KNOWN['sample_observation'];
    expect(b.ra_hours).toBeCloseTo(17.5858, 6);
    expect(b.dec_degrees).toBeCloseTo(-33.83, 6);
    expect(b.pixel_scale_arcsec).toBeCloseTo(63.211, 6);
  });

  it('async resolveTruth: in-memory > file, then injected FITS, then bundled', async () => {
    // in-memory beats everything
    const mem: TruthLabel = { ...M66_TRUTH, frame_id: 'x', provenance_note: 'mem' };
    expect((await resolveTruth('x', { labels: [mem] }))!.provenance_note).toBe('mem');

    // injected FITS deriver (no real file I/O) resolves option (b)
    const stub: FitsDeriver = async (_p, id) => ({ ...M66_TRUTH, frame_id: id, provenance_note: 'from-fits' });
    const viaFits = await resolveTruth('framez', { fitsPath: '/whatever.fit', fitsDeriver: stub });
    expect(viaFits!.provenance_note).toBe('from-fits');

    // bundled fallback
    expect((await resolveTruth('sample_observation'))!.source).toBe('bundled_known');

    // honest-absent
    expect(await resolveTruth('unknown_frame', { allowBundled: true })).toBeNull();
  });

  it('loadLabelsFile round-trips a written labels file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truth-labels-'));
    const file = path.join(dir, 'labels.json');
    fs.writeFileSync(file, JSON.stringify({ labels: [M66_TRUTH] }), 'utf8');
    const loaded = loadLabelsFile(file);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].frame_id).toBe('m66');
    // bare-array form also parses
    fs.writeFileSync(file, JSON.stringify([M66_TRUTH]), 'utf8');
    expect(loadLabelsFile(file)).toHaveLength(1);
    expect(loadLabelsFile(path.join(dir, 'absent.json'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the committed seed labels.json resolves both real frames', () => {
    const seed = path.resolve(__dirname, '../../../tools/validation/truth/labels.json');
    const labels = loadLabelsFile(seed);
    const m66 = labels.find((l) => l.frame_id.includes('M 66'));
    const cr2 = labels.find((l) => l.frame_id === 'sample_observation');
    expect(m66).toBeTruthy();
    expect(m66!.source).toBe('fits_header');
    expect(m66!.ra_hours).toBeCloseTo(11.36166687, 5);
    expect(cr2).toBeTruthy();
    expect(cr2!.pixel_scale_arcsec).toBeCloseTo(63.211, 6);
  });
});

describe('truth · harness hook → new_false_positive through the UNCHANGED delta', () => {
  function lockedRaw(overrides: Partial<RunResult> = {}): RunResult {
    return {
      wall_ms: 100,
      locked: true,
      ra: 17.5858,
      dec: -33.83,
      pixel_scale_arcsec: 63.211,
      matched: 55,
      budget_ms: 100,
      ...overrides,
    };
  }

  it('extractSolvedWcs reads center + scale from a distilled result (incl. provenance sidecar)', () => {
    const raw = lockedRaw({ pixel_scale_arcsec: undefined, provenance: { scale_arcsec_px: 63.5 } } as Partial<RunResult>);
    const s = extractSolvedWcs(raw);
    expect(s.ra_hours).toBeCloseTo(17.5858, 6);
    expect(s.pixel_scale_arcsec).toBeCloseTo(63.5, 6);
  });

  it('locked + agreeing truth → TRUE_POSITIVE, false_positive stays false', () => {
    const adj = adjudicateSolverResult(lockedRaw(), CR2_TRUTH);
    expect(adj.verdict).toBe('TRUE_POSITIVE');
    expect(adj.false_positive).toBe(false);
  });

  it('locked + DISAGREEING truth → FALSE_POSITIVE → computeSolverDelta emits new_false_positive', () => {
    const raw = lockedRaw({ ra: 5.0, dec: 10.0 }); // wrong lock, far from truth
    const applied = applyTruthToRunResult(raw, CR2_TRUTH);
    expect(applied.false_positive).toBe(true);
    expect((applied.truth as { verdict: string }).verdict).toBe('FALSE_POSITIVE');

    // Feed through the UNCHANGED SOLVER domain: baseline didn't lock, candidate
    // "locked" but is a false positive → regression new_false_positive, and NOT
    // counted as an improvement.
    const baseline = extractSolverOutcome({ wall_ms: 1, locked: false });
    const candidate = extractSolverOutcome(applied);
    const delta = computeSolverDelta(baseline, candidate);
    expect(delta.regressions).toContain('new_false_positive');
    expect(delta.improvements).not.toContain('new_verified_lock');
  });

  it('NO_TRUTH is BYTE-IDENTICAL: false_positive unchanged, delta unaffected', () => {
    const raw = lockedRaw();
    const applied = applyTruthToRunResult(raw, null);
    expect(applied.false_positive).toBe(false);
    expect((applied.truth as { verdict: string }).verdict).toBe('NO_TRUTH');

    const baseline = extractSolverOutcome({ wall_ms: 1, locked: false });
    const withTruth = computeSolverDelta(baseline, extractSolverOutcome(applied));
    const without = computeSolverDelta(baseline, extractSolverOutcome(raw));
    expect(withTruth).toEqual(without); // grading is identical when truth is absent
    expect(withTruth.improvements).toContain('new_verified_lock'); // an honest lock still counts
  });

  it('not locked → never a false positive (nothing to falsify)', () => {
    const raw = lockedRaw({ locked: false, ra: 5.0, dec: 10.0 });
    const adj = adjudicateSolverResult(raw, CR2_TRUTH);
    expect(adj.false_positive).toBe(false);
    expect(adj.comparison).toBeNull();
  });

  it('never CLEARS an oracle-set flag (only escalates to true)', () => {
    const raw = lockedRaw({ false_positive: true } as Partial<RunResult>);
    const applied = applyTruthToRunResult(raw, CR2_TRUTH); // truth would say TRUE_POSITIVE
    expect(applied.false_positive).toBe(true); // preserved
  });

  it('default tolerances are the documented values', () => {
    expect(DEFAULT_TOLERANCES).toEqual({ center_deg: 1.0, scale_frac: 0.05, rotation_deg: 5.0 });
  });
});

// ── The GRADUATION-MERGE wiring (run_cr2_sweep.ts:merge) — truth-adjudicated ──
// Proves the seam the CR2/FITS sweep composes: adjudicate an arm against truth
// ONLY when the recorded center is the frame center (else honest-absent), then
// grade through the UNCHANGED SOLVER delta. A truth-disagreeing FRAME-CENTER lock
// becomes new_false_positive; an anchor-center lock (this CR2 harness) is never
// falsely flagged; NO_TRUTH is byte-identical.
describe('truth · graduation merge wiring (truth-adjudicated ledger)', () => {
  // EXACT composition of run_cr2_sweep.ts:adjudicateArm — apply a frame's truth
  // only when the recorded (ra,dec) is the finalized frame center.
  function adjudicateArm(raw: RunResult, truth: TruthLabel | null): RunResult {
    return applyTruthToRunResult(raw, recordedCenterIsFrameCenter(raw) ? truth : null);
  }
  function frameCenterRaw(overrides: Partial<RunResult> = {}): RunResult {
    return {
      wall_ms: 100, locked: true, ra: 17.5858, dec: -33.83, pixel_scale_arcsec: 63.211,
      matched: 55, budget_ms: 100, provenance: { recorded_center_is_frame: true },
      ...overrides,
    };
  }
  const noLock = extractSolverOutcome({ wall_ms: 1, locked: false });

  it('recordedCenterIsFrameCenter reads the binding flag (default false = honest-absent)', () => {
    expect(recordedCenterIsFrameCenter({ wall_ms: 1, locked: true })).toBe(false);
    expect(recordedCenterIsFrameCenter({ wall_ms: 1, locked: true, provenance: { recorded_center_is_frame: false } } as RunResult)).toBe(false);
    expect(recordedCenterIsFrameCenter({ wall_ms: 1, locked: true, provenance: { recorded_center_is_frame: true } } as RunResult)).toBe(true);
  });

  it('frame-center DISAGREEING lock → new_false_positive regression (blocks graduation)', () => {
    const on = frameCenterRaw({ ra: 5.0, dec: 10.0 }); // wrong lock, far from truth
    const cand = extractSolverOutcome(adjudicateArm(on, CR2_TRUTH));
    expect(cand.false_positive).toBe(true);
    const delta = computeSolverDelta(noLock, cand);
    expect(delta.regressions).toContain('new_false_positive');
    expect(delta.improvements).not.toContain('new_verified_lock');
  });

  it('frame-center AGREEING lock → no false positive (an honest lock still counts)', () => {
    const on = frameCenterRaw(); // solved ≈ truth
    const cand = extractSolverOutcome(adjudicateArm(on, CR2_TRUTH));
    const delta = computeSolverDelta(noLock, cand);
    expect(cand.false_positive).toBe(false);
    expect(delta.regressions).not.toContain('new_false_positive');
    expect(delta.improvements).toContain('new_verified_lock');
  });

  it('ANCHOR-center DISAGREEING lock → honest-absent guard, NEVER a false positive', () => {
    // The CR2 anchored-sweep case: recorded center = the verify anchor (≈12° off
    // the frame-center truth), so it must NOT be flagged despite disagreeing with
    // a frame-center label (comparing an anchor to a frame center is invalid).
    const on = frameCenterRaw({ ra: 17.264, dec: -22.5, provenance: { recorded_center_is_frame: false } } as Partial<RunResult>);
    const cand = extractSolverOutcome(adjudicateArm(on, CR2_TRUTH));
    expect(cand.false_positive).toBe(false);
    expect(computeSolverDelta(noLock, cand).regressions).not.toContain('new_false_positive');
  });

  it('NO_TRUTH frame → no adjudication (byte-identical grading)', () => {
    const on = frameCenterRaw({ ra: 5.0, dec: 10.0 }); // even a "wrong" position
    const withTruth = computeSolverDelta(noLock, extractSolverOutcome(adjudicateArm(on, null)));
    const without = computeSolverDelta(noLock, extractSolverOutcome(on));
    expect(withTruth).toEqual(without);
    expect(withTruth.regressions).not.toContain('new_false_positive');
  });

  it('resolveTruth → adjudicate end-to-end: a labels.json-style label flags a disagreeing frame-center lock', async () => {
    const labels: TruthLabel[] = [{ ...CR2_TRUTH, frame_id: 'frameX' }];
    const truth = await resolveTruth('frameX', { labels });
    const on = frameCenterRaw({ ra: 5.0, dec: 10.0 });
    const cand = extractSolverOutcome(adjudicateArm(on, truth));
    expect(computeSolverDelta(noLock, cand).regressions).toContain('new_false_positive');
  });
});
