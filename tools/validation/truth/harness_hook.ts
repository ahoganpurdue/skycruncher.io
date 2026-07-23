// ═══════════════════════════════════════════════════════════════════════════
// HARNESS HOOK — feed truth into the SOLVER domain's new_false_positive path
// (spec: docs/VALIDATION_HARNESS.md · Enhancement 1, item 4)
// ═══════════════════════════════════════════════════════════════════════════
//
// The SOLVER delta already emits `new_false_positive` from `outcome.false_positive`
// (domains.ts) — but historically that flag could ONLY be set by an explicit
// oracle in a scenario test, never from a real solve, because there was no truth
// comparison. THIS closes that gap: given a verify-PASSING candidate's WCS and a
// resolved truth label, it decides whether the lock AGREES with truth and sets
// `false_positive` accordingly. The UNCHANGED extractSolverOutcome → computeSolverDelta
// then turns a disagreeing lock into a `new_false_positive` regression.
//
// ADDITIVE + BACKWARD-COMPATIBLE by construction: this is a NEW module. It does
// not modify domains.ts / types.ts (the running sweep imports those unchanged).
// Truth-absent is BYTE-IDENTICAL: NO_TRUTH ⇒ false_positive stays whatever it was
// (default false) ⇒ grading is unchanged. A frame that never locked is never a
// false positive (nothing to falsify).

import type { RunResult } from '../types.ts';
import type { TruthLabel, TruthTier, TruthTolerances, TruthVerdict } from './schema.ts';
import { tierOf } from './schema.ts';
import { compareToTruth, type ComparisonResult, type SolvedWcs } from './compare.ts';

/** Result of adjudicating a solver run against truth. */
export interface SolverTruthAdjudication {
  /** True ONLY when the run LOCKED and its WCS disagrees with a KNOWN truth. */
  false_positive: boolean;
  /** TRUE_POSITIVE (locked+agrees) · FALSE_POSITIVE (locked+disagrees) · NO_TRUTH. */
  verdict: TruthVerdict;
  /**
   * WHICH truth tier adjudicated this frame — GOLD (trusted science bar) vs COARSE
   * (goto pointing, honest lower tier). null ⇒ NO_TRUTH. Recorded so the ledger
   * NEVER conflates a coarse goto pass with a gold oracle pass.
   */
  tier: TruthTier | null;
  /** Full comparison detail (null when there was no lock or no truth). */
  comparison: ComparisonResult | null;
}

/**
 * Pull the solved geometry out of a distilled RunResult. Reads the fields the
 * CR2 binding (and any SOLVER binding) already emit — ra/dec are the verify-
 * passing center; scale/rotation/parity are used if present, else the axis is
 * skipped by the comparison. Defensive: any missing field just narrows the check.
 */
export function extractSolvedWcs(raw: RunResult): SolvedWcs {
  const prov = (raw.provenance ?? {}) as Record<string, unknown>;
  const scale =
    numOrNull(raw.pixel_scale_arcsec) ??
    numOrNull((raw as Record<string, unknown>).scale_arcsec_px) ??
    numOrNull(prov.scale_arcsec_px);
  return {
    ra_hours: numOrNull(raw.ra) ?? NaN,
    dec_degrees: numOrNull(raw.dec) ?? NaN,
    pixel_scale_arcsec: scale,
    rotation_deg: numOrNull(raw.rotation_deg),
    parity: raw.parity === 1 || raw.parity === -1 ? raw.parity : null,
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * COMPARABILITY GUARD — is a RunResult's recorded (ra,dec) the finalized FRAME
 * CENTER (so it may be compared against a frame-center truth label), or a VERIFY
 * ANCHOR center (a bright in-field star/planet the sweep locked onto)?
 *
 * A wide-field solve records the anchor, which can sit MANY degrees off the frame
 * center (e.g. the bundled CR2's winning anchor ≈ Jupiter, ~12° from its frame-
 * center truth). Comparing an anchor center to a frame-center truth is a category
 * error that would spuriously flag a CORRECT solve as a FALSE_POSITIVE. So a SOLVER
 * binding whose distilled center is the frame center sets
 * `provenance.recorded_center_is_frame = true`; absent/false ⇒ NOT comparable ⇒
 * honest-absent (the caller passes truth=null → no center-truth adjudication).
 *
 * HANDOFF GUARD (FITS solve-A/B rail): before setting this true, VERIFY the
 * recorded-lock center is genuinely the SAME quantity as the truth-label frame
 * center — same convention, same epoch/frame (apples-to-apples). Do not assume the
 * finalized CRVAL and the label center agree; confirm it, or an off-convention
 * center flips a good solve to a false FALSE_POSITIVE just like the anchor case.
 */
export function recordedCenterIsFrameCenter(raw: RunResult): boolean {
  const prov = (raw.provenance ?? {}) as Record<string, unknown>;
  return prov.recorded_center_is_frame === true;
}

/**
 * Adjudicate a distilled SOLVER RunResult against truth.
 *  - not locked            → false_positive=false, verdict NO_TRUTH-safe (no comparison).
 *  - locked, no truth      → NO_TRUTH, false_positive=false (byte-identical).
 *  - locked, truth agrees  → TRUE_POSITIVE, false_positive=false.
 *  - locked, truth disagrees → FALSE_POSITIVE, false_positive=TRUE.
 */
export function adjudicateSolverResult(
  raw: RunResult,
  truth: TruthLabel | null,
  override?: Partial<TruthTolerances>,
): SolverTruthAdjudication {
  const locked = raw.locked === true;
  if (!locked || !truth) {
    // tier records the truth's tier even when the run didn't lock (a KNOWN frame is
    // still tiered); null only when there is no truth at all.
    return { false_positive: false, verdict: 'NO_TRUTH', tier: truth ? tierOf(truth) : null, comparison: null };
  }
  const comparison = compareToTruth(extractSolvedWcs(raw), truth, override);
  return {
    false_positive: comparison.verdict === 'FALSE_POSITIVE',
    verdict: comparison.verdict,
    tier: tierOf(truth),
    comparison,
  };
}

/**
 * THE HOOK a SOLVER binding calls post-hoc (e.g. the CR2 binding, AFTER distill).
 * Returns a SHALLOW COPY of the raw result with `false_positive` set from the
 * truth verdict and a `truth` sidecar attached (verdict + comparison + label
 * frame_id/source) for the ledger/visual layer. The original is never mutated;
 * when truth is absent the copy is behaviorally identical to the input.
 */
export function applyTruthToRunResult(
  raw: RunResult,
  truth: TruthLabel | null,
  override?: Partial<TruthTolerances>,
): RunResult {
  const adj = adjudicateSolverResult(raw, truth, override);
  return {
    ...raw,
    // Only ESCALATE to true — never clear a flag a scenario oracle set on purpose.
    false_positive: raw.false_positive === true || adj.false_positive,
    truth: {
      verdict: adj.verdict,
      tier: adj.tier,
      frame_id: truth?.frame_id ?? null,
      source: truth?.source ?? null,
      comparison: adj.comparison,
    },
  };
}
