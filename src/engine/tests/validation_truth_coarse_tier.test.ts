// SELF-ADVERSARIAL tests for the TWO-TIER truth wiring (tools/validation/truth/ —
// FITS header/goto surfaced as a COARSE adjudication tier, DISTINCT from GOLD).
// Pure, ZERO calibrated-path dependency. These tests TRY TO BREAK the wiring:
//   (a) the ~10 goto frames now resolve a COARSE truth label from the committed labels.json;
//   (b) a solve AGREEING with the goto center (within coarse tol) passes; a DISAGREEING
//       one (beyond coarse tol) → new_false_positive through the UNCHANGED delta;
//   (c) the COARSE tier is RECORDED and NOT conflated with GOLD (M66 stays GOLD, a goto
//       frame is COARSE; the adjudication sidecar carries the tier);
//   (d) the coarse tolerance is NOT a rubber-stamp (a clearly-wrong lock still FAILS);
//   (e) NO_TRUTH frames are unaffected (honest-absent, byte-identical grading).

import { describe, it, expect } from 'vitest';
import path from 'node:path';

import {
  compareToTruth,
  resolveTolerances,
  type SolvedWcs,
} from '../../../tools/validation/truth/compare.ts';
import {
  tierOf,
  baseTolerancesForTier,
  DEFAULT_TOLERANCES,
  COARSE_TOLERANCES,
  type TruthLabel,
} from '../../../tools/validation/truth/schema.ts';
import {
  loadLabelsFile,
  resolveTruth,
} from '../../../tools/validation/truth/loader.ts';
import {
  adjudicateSolverResult,
  applyTruthToRunResult,
} from '../../../tools/validation/truth/harness_hook.ts';
import { extractSolverOutcome, computeSolverDelta } from '../../../tools/validation/domains.ts';
import type { RunResult } from '../../../tools/validation/types.ts';

const LABELS = path.resolve(__dirname, '../../../tools/validation/truth/labels.json');
const M66_GOLD_ID = 'DSO_Stacked_738_M 66_60.0s_20260516_064736';
// A real COARSE goto frame from the manifest (FITS_RA_DEC, center tol loosened to 2°).
const GOTO_ID = 'M50_2X_Best20h_Zcom';
const GOTO_RA_H = 13.5189;
const GOTO_DEC = 47.065;
const GOTO_SCALE = 1.196;

const noLock = extractSolverOutcome({ wall_ms: 1, locked: false });
function frameCenterRaw(overrides: Partial<RunResult> = {}): RunResult {
  return {
    wall_ms: 100, locked: true, ra: GOTO_RA_H, dec: GOTO_DEC, pixel_scale_arcsec: GOTO_SCALE,
    matched: 40, budget_ms: 100, provenance: { recorded_center_is_frame: true },
    ...overrides,
  };
}

// ── schema-level tier vocabulary ────────────────────────────────────────────────
describe('two-tier truth · tier derivation + base tolerances', () => {
  it('tierOf: bundled_known/astrometry_net ⇒ GOLD by source; fits_header ⇒ COARSE by default', () => {
    expect(tierOf({ source: 'bundled_known' } as TruthLabel)).toBe('GOLD');
    expect(tierOf({ source: 'astrometry_net' } as TruthLabel)).toBe('GOLD');
    expect(tierOf({ source: 'fits_header' } as TruthLabel)).toBe('COARSE');
  });

  it('an explicit tier OVERRIDES the source default (a cross-checked goto → GOLD)', () => {
    expect(tierOf({ source: 'fits_header', tier: 'GOLD' } as TruthLabel)).toBe('GOLD');
    expect(tierOf({ source: 'bundled_known', tier: 'COARSE' } as TruthLabel)).toBe('COARSE');
  });

  it('COARSE loosens the center window (2.0°) vs the tight GOLD default (1.0°)', () => {
    expect(baseTolerancesForTier('GOLD')).toEqual(DEFAULT_TOLERANCES);
    expect(baseTolerancesForTier('COARSE')).toEqual(COARSE_TOLERANCES);
    expect(COARSE_TOLERANCES.center_deg).toBeGreaterThan(DEFAULT_TOLERANCES.center_deg);
    expect(COARSE_TOLERANCES.center_deg).toBeLessThan(5); // still ≪ a gross-mislock offset
  });

  it('resolveTolerances applies the tier base, then the label override wins', () => {
    // A COARSE label with no override gets the 2° base.
    expect(resolveTolerances({ source: 'fits_header' } as TruthLabel).center_deg).toBe(2.0);
    // A GOLD label gets the tight 1° base.
    expect(resolveTolerances({ source: 'bundled_known' } as TruthLabel).center_deg).toBe(1.0);
    // A per-label override still wins over the tier base.
    expect(
      resolveTolerances({ source: 'fits_header', tolerances: { center_deg: 1.0 } } as TruthLabel).center_deg,
    ).toBe(1.0);
  });
});

// ── (a) the goto frames now resolve a COARSE label ──────────────────────────────
describe('(a) goto frames now resolve a COARSE truth label', () => {
  const labels = loadLabelsFile(LABELS);

  it('the committed labels.json surfaces ≥10 COARSE goto frames (previously NO_TRUTH)', () => {
    const coarse = labels.filter((l) => tierOf(l) === 'COARSE');
    expect(coarse.length).toBeGreaterThanOrEqual(10);
    // every COARSE label is a capture-header source and carries a loosened/explicit center tol
    for (const l of coarse) {
      expect(l.source).toBe('fits_header');
      expect(l.tier).toBe('COARSE');
      expect(l.tolerances?.center_deg).toBeGreaterThanOrEqual(1.0);
    }
  });

  it('resolveTruth surfaces the goto frame at its BEST tier (GOLD since the 2026-07-09 nova harvest) while its COARSE label persists', async () => {
    // This frame was goto-COARSE-only until the nova cloud push promoted it to
    // GOLD — resolveTruth must pick the better tier (that is the point of the
    // ladder), and the additive corpus must still carry the COARSE goto label.
    const t = await resolveTruth(GOTO_ID, { labelsFile: LABELS });
    expect(t).toBeTruthy();
    expect(t!.frame_id).toBe(GOTO_ID);
    expect(tierOf(t!)).toBe('GOLD');
    // nova-measured center sits within the goto label's loosened 2° tolerance.
    expect(Math.abs(t!.ra_hours - GOTO_RA_H)).toBeLessThan(0.15);
    const coarseStill = loadLabelsFile(LABELS).filter(
      (l) => l.frame_id === GOTO_ID && tierOf(l) === 'COARSE');
    expect(coarseStill.length).toBeGreaterThanOrEqual(1);
  });
});

// ── (b) agreeing goto passes; disagreeing → new_false_positive ──────────────────
describe('(b) a goto-agreeing solve passes; a goto-disagreeing solve regresses', () => {
  const goto = loadLabelsFile(LABELS).find((l) => l.frame_id === GOTO_ID)!;

  it('a solve 1.5° off (INSIDE coarse 2°, but OUTSIDE the tight gold 1°) → TRUE_POSITIVE at COARSE', () => {
    const solved: SolvedWcs = { ra_hours: GOTO_RA_H, dec_degrees: GOTO_DEC + 1.5, pixel_scale_arcsec: GOTO_SCALE };
    const r = compareToTruth(solved, goto);
    expect(r.center_sep_deg!).toBeGreaterThan(1.0);
    expect(r.center_sep_deg!).toBeLessThan(2.0);
    expect(r.verdict).toBe('TRUE_POSITIVE'); // passes BECAUSE the tier loosened the window
    // the loosening is load-bearing: the SAME solve at the tight gold 1° tol would FAIL.
    expect(compareToTruth(solved, goto, { center_deg: 1.0 }).verdict).toBe('FALSE_POSITIVE');
  });

  it('a solve 3° off (BEYOND coarse 2°) → FALSE_POSITIVE → new_false_positive through the UNCHANGED delta', () => {
    const wrong = frameCenterRaw({ dec: GOTO_DEC + 3.0 });
    const adj = applyTruthToRunResult(wrong, goto);
    expect((adj.truth as { verdict: string }).verdict).toBe('FALSE_POSITIVE');
    expect(adj.false_positive).toBe(true);
    const delta = computeSolverDelta(noLock, extractSolverOutcome(adj));
    expect(delta.regressions).toContain('new_false_positive');
    expect(delta.improvements).not.toContain('new_verified_lock');
  });

  it('an exactly-on-goto solve → TRUE_POSITIVE, an honest lock still counts', () => {
    const on = frameCenterRaw();
    const adj = applyTruthToRunResult(on, goto);
    expect((adj.truth as { verdict: string }).verdict).toBe('TRUE_POSITIVE');
    expect(adj.false_positive).toBe(false);
    const delta = computeSolverDelta(noLock, extractSolverOutcome(adj));
    expect(delta.improvements).toContain('new_verified_lock');
    expect(delta.regressions).not.toContain('new_false_positive');
  });
});

// ── (c) tier recorded, COARSE never conflated with GOLD ─────────────────────────
describe('(c) the tier is RECORDED and NEVER conflated (M66 GOLD, goto COARSE)', () => {
  const labels = loadLabelsFile(LABELS);
  const m66 = labels.find((l) => l.frame_id === M66_GOLD_ID)!;
  const goto = labels.find((l) => l.frame_id === GOTO_ID)!;

  it('M66 stays GOLD (source fits_header, tier promoted GOLD by oracle cross-check); the goto is COARSE', () => {
    expect(m66.source).toBe('fits_header'); // provenance of the numbers is unchanged
    expect(m66.tier).toBe('GOLD');
    expect(tierOf(m66)).toBe('GOLD');
    expect(tierOf(goto)).toBe('COARSE');
    expect(tierOf(m66)).not.toBe(tierOf(goto));
  });

  it('the adjudication sidecar records the tier that adjudicated the frame', () => {
    // GOLD frame → sidecar tier GOLD
    const goldAdj = adjudicateSolverResult(
      { wall_ms: 1, locked: true, ra: m66.ra_hours, dec: m66.dec_degrees, pixel_scale_arcsec: m66.pixel_scale_arcsec ?? undefined } as RunResult,
      m66,
    );
    expect(goldAdj.tier).toBe('GOLD');
    expect(goldAdj.verdict).toBe('TRUE_POSITIVE');

    // COARSE goto frame → sidecar tier COARSE (a coarse pass is NOT labeled gold)
    const coarseAdj = adjudicateSolverResult(frameCenterRaw(), goto);
    expect(coarseAdj.tier).toBe('COARSE');
    expect(coarseAdj.verdict).toBe('TRUE_POSITIVE');

    // applyTruthToRunResult carries the tier onto the RunResult sidecar for the ledger
    const applied = applyTruthToRunResult(frameCenterRaw(), goto);
    expect((applied.truth as { tier: string }).tier).toBe('COARSE');
    expect((applied.truth as { tier: string }).tier).not.toBe('GOLD');
  });

  it('M66 GOLD still grades at the TIGHT window — its real fitted center (0.36°) passes, a 1.5°-off lock does NOT', () => {
    // real sacred M66 solve (frame center) — 0.36° off the goto label, inside gold 1°.
    const realM66: SolvedWcs = { ra_hours: 11.341253475172621, dec_degrees: 13.048392248246461, pixel_scale_arcsec: 3.6776147325019153 };
    expect(compareToTruth(realM66, m66).verdict).toBe('TRUE_POSITIVE');
    // a 1.5°-off lock that would pass a COARSE frame is REJECTED on the GOLD frame:
    const offGold: SolvedWcs = { ra_hours: m66.ra_hours, dec_degrees: m66.dec_degrees + 1.5, pixel_scale_arcsec: m66.pixel_scale_arcsec ?? undefined };
    expect(compareToTruth(offGold, m66).verdict).toBe('FALSE_POSITIVE');
  });
});

// ── (d) the coarse tolerance is NOT a rubber-stamp ──────────────────────────────
describe('(d) COARSE is not a rubber-stamp — a clearly-wrong lock still fails', () => {
  const goto = loadLabelsFile(LABELS).find((l) => l.frame_id === GOTO_ID)!;

  it('a lock 8° off-center → FALSE_POSITIVE even at the loosened coarse window', () => {
    const badFar = compareToTruth({ ra_hours: GOTO_RA_H, dec_degrees: GOTO_DEC + 8.0, pixel_scale_arcsec: GOTO_SCALE }, goto);
    expect(badFar.verdict).toBe('FALSE_POSITIVE');
    expect(badFar.reasons.join(' ')).toMatch(/center/);
  });

  it('a wrong-scale lock (2× the header scale) → FALSE_POSITIVE (scale axis)', () => {
    const badScale = compareToTruth({ ra_hours: GOTO_RA_H, dec_degrees: GOTO_DEC, pixel_scale_arcsec: GOTO_SCALE * 2 }, goto);
    expect(badScale.verdict).toBe('FALSE_POSITIVE');
    expect(badScale.reasons.join(' ')).toMatch(/scale/);
  });

  it('a grossly-wrong sky position (different object) → FALSE_POSITIVE new_false_positive', () => {
    const wrong = frameCenterRaw({ ra: 5.0, dec: -10.0 });
    const delta = computeSolverDelta(noLock, extractSolverOutcome(applyTruthToRunResult(wrong, goto)));
    expect(delta.regressions).toContain('new_false_positive');
  });
});

// ── (e) NO_TRUTH frames unaffected ──────────────────────────────────────────────
describe('(e) NO_TRUTH frames are unaffected (honest-absent, byte-identical grading)', () => {
  it('an unlabeled frame resolves to null → NO_TRUTH, tier null, byte-identical delta', async () => {
    const t = await resolveTruth('a_frame_with_no_label_at_all', { labelsFile: LABELS });
    expect(t).toBeNull();
    const raw = frameCenterRaw({ ra: 5.0, dec: 10.0 }); // even a "wrong" position
    const adj = applyTruthToRunResult(raw, t); // t === null
    expect((adj.truth as { verdict: string }).verdict).toBe('NO_TRUTH');
    expect((adj.truth as { tier: string | null }).tier).toBeNull();
    expect(adj.false_positive).toBe(false);
    const withTruth = computeSolverDelta(noLock, extractSolverOutcome(adj));
    const without = computeSolverDelta(noLock, extractSolverOutcome(raw));
    expect(withTruth).toEqual(without);
    expect(withTruth.regressions).not.toContain('new_false_positive');
  });
});
