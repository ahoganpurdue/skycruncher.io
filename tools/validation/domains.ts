// Domain outcome shapes + delta models (seed set; extensible). A candidate's
// extractOutcome/computeDelta are usually one of these off-the-shelf pairs.
//
// TRUSTED-ARBITER RULE (spec §Domains): `locked` ≡ *passed the calibrated
// verifyWCS chain*, NOT "the lever fired." The calibrated gate is the sole
// arbiter → no external ground truth needed. `new_false_positive` is only ever
// set from an explicit oracle flag on the outcome (scenario tests), NEVER
// fabricated from a lever firing.

import type { Delta, RunResult } from './types.ts';

// ─── SOLVER domain ───────────────────────────────────────────────────────────
export interface SolverOutcome {
  locked: boolean; // passed verifyWCS
  ra: number | null;
  dec: number | null;
  sigma: number | null; // verification σ
  matched: number;
  budget_ms: number;
  /** Oracle-only: candidate locked but the lock is WRONG. Never set by the solver. */
  false_positive?: boolean;
}

export function extractSolverOutcome(r: RunResult): SolverOutcome {
  return {
    locked: r.locked === true,
    ra: typeof r.ra === 'number' ? r.ra : null,
    dec: typeof r.dec === 'number' ? r.dec : null,
    sigma: typeof r.sigma === 'number' ? r.sigma : null,
    matched: typeof r.matched === 'number' ? r.matched : 0,
    budget_ms: typeof r.budget_ms === 'number' ? r.budget_ms : r.wall_ms,
    false_positive: r.false_positive === true,
  };
}

/**
 * SOLVER delta. improvement `new_verified_lock` (candidate locked where baseline
 * didn't); regressions `lost_lock` (baseline locked, candidate didn't — the
 * budget-dilution case) and `new_false_positive` (oracle-flagged wrong lock).
 */
export function computeSolverDelta(baseline: SolverOutcome, candidate: SolverOutcome): Delta {
  const improvements: string[] = [];
  const regressions: string[] = [];
  if (candidate.locked && !baseline.locked && !candidate.false_positive) {
    improvements.push('new_verified_lock');
  }
  if (baseline.locked && !candidate.locked) regressions.push('lost_lock');
  if (candidate.false_positive) regressions.push('new_false_positive');
  return { improvements, regressions };
}

// ─── CONFIRMATION domain (deep_confirm SET gate) ──────────────────────────────
export interface ConfirmationOutcome {
  confirmed_n: number;
  true_excess_z: number;
  max_wrong_excess_z: number;
}

export function extractConfirmationOutcome(r: RunResult): ConfirmationOutcome {
  return {
    confirmed_n: typeof r.confirmed_n === 'number' ? r.confirmed_n : 0,
    true_excess_z: typeof r.true_excess_z === 'number' ? r.true_excess_z : 0,
    max_wrong_excess_z: typeof r.max_wrong_excess_z === 'number' ? r.max_wrong_excess_z : 0,
  };
}

/**
 * CONFIRMATION delta at a SET gate. improvement `new_confirmed_frame` (a frame
 * with true_excess_z ≥ gate AND max_wrong_excess_z < gate that baseline missed);
 * regression `false_confirm` (any max_wrong_excess_z ≥ gate).
 */
export function makeConfirmationDelta(gate: number) {
  return (baseline: ConfirmationOutcome, candidate: ConfirmationOutcome): Delta => {
    const improvements: string[] = [];
    const regressions: string[] = [];
    const candTrue = candidate.true_excess_z >= gate && candidate.max_wrong_excess_z < gate;
    const baseTrue = baseline.true_excess_z >= gate && baseline.max_wrong_excess_z < gate;
    if (candTrue && !baseTrue) improvements.push('new_confirmed_frame');
    if (candidate.max_wrong_excess_z >= gate) regressions.push('false_confirm');
    return { improvements, regressions };
  };
}
