// The PURE verdict engine. No I/O, no clock, no randomness — a deterministic
// function of (candidate, trials). This is the mechanical arbiter that replaces
// judgment: promotion is decided by the logged ledger, never by a person.
//
// Per image_type T, over ≥ N_min(T) DISTINCT inputs of type T:
//   BLOCKED           if any blocking regression was observed        (regressions dominate)
//   N/A               if T is not in the candidate's applicability
//   INSUFFICIENT-DATA if n < N_min(T)
//   GRADUATE          if net_improvements ≥ K  AND  regressions == 0
//   KEEP-EVAL         otherwise (safe, enough data, not enough net gain)
// GLOBAL = the per-type criterion resolved across EVERY applicable type.

import type { Candidate, Trial, Verdict, ImageType } from './types.ts';

export interface TypeTally {
  image_type: ImageType;
  applicable: boolean;
  n: number; // distinct inputs of this type
  n_min: number; // required minimum
  improvements: number; // Σ delta.improvements.length
  regressions: number; // Σ delta.regressions.length (all)
  blocking_regressions: number; // Σ regressions that count as blocking
  verdict: Verdict;
}

export interface CheckReport {
  candidate_id: string;
  perType: TypeTally[];
  global: Verdict;
}

function isBlocking(candidate: Candidate, label: string): boolean {
  const allow = candidate.policy.blockingRegressions;
  // Empty/undefined allowlist ⇒ ANY regression blocks (spec default).
  return !allow || allow.length === 0 || allow.includes(label);
}

/** N_min for a type (explicit entry, else the policy default). */
export function nMinFor(candidate: Candidate, type: ImageType): number {
  return candidate.policy.nMin[type] ?? candidate.policy.nMinDefault;
}

/** Pure per-image-type tally + verdict. Trials should already be deduped. */
export function tallyForType(
  candidate: Candidate,
  trials: readonly Trial[],
  type: ImageType,
): TypeTally {
  const applicable = candidate.applicability.has(type);
  const rows = trials.filter((t) => t.image_type === type);
  const distinct = new Set(rows.map((t) => t.input_id));
  const n = distinct.size;
  const n_min = nMinFor(candidate, type);

  let improvements = 0;
  let regressions = 0;
  let blocking = 0;
  for (const t of rows) {
    improvements += t.delta.improvements.length;
    regressions += t.delta.regressions.length;
    for (const r of t.delta.regressions) if (isBlocking(candidate, r)) blocking += 1;
  }

  let verdict: Verdict;
  if (!applicable) verdict = 'N/A';
  else if (blocking > 0) verdict = 'BLOCKED'; // a regression is first-class net-harm
  else if (n < n_min) verdict = 'INSUFFICIENT-DATA';
  else if (improvements >= candidate.policy.k && regressions === 0) verdict = 'GRADUATE';
  else verdict = 'KEEP-EVAL';

  return {
    image_type: type,
    applicable,
    n,
    n_min,
    improvements,
    regressions,
    blocking_regressions: blocking,
    verdict,
  };
}

/**
 * GLOBAL verdict = per-type criterion resolved over EVERY applicable type.
 * Precedence (mechanical): any BLOCKED ⇒ BLOCKED; else all GRADUATE ⇒ GRADUATE;
 * else any INSUFFICIENT-DATA ⇒ INSUFFICIENT-DATA; else KEEP-EVAL. No applicable
 * type at all ⇒ N/A (degenerate).
 */
export function globalVerdict(candidate: Candidate, trials: readonly Trial[]): Verdict {
  const types = [...candidate.applicability];
  if (types.length === 0) return 'N/A';
  const verdicts = types.map((t) => tallyForType(candidate, trials, t).verdict);
  if (verdicts.some((v) => v === 'BLOCKED')) return 'BLOCKED';
  if (verdicts.every((v) => v === 'GRADUATE')) return 'GRADUATE';
  if (verdicts.some((v) => v === 'INSUFFICIENT-DATA')) return 'INSUFFICIENT-DATA';
  return 'KEEP-EVAL';
}

/**
 * Full check: a per-type tally for every KNOWN + applicable type present in the
 * trials, plus the global verdict. Includes N/A rows for applicable-set clarity.
 */
export function check(candidate: Candidate, trials: readonly Trial[]): CheckReport {
  // Union of: the candidate's applicable types + any type actually seen in trials.
  const types = new Set<ImageType>([...candidate.applicability]);
  for (const t of trials) types.add(t.image_type);
  const perType = [...types]
    .sort()
    .map((t) => tallyForType(candidate, trials, t));
  return { candidate_id: candidate.id, perType, global: globalVerdict(candidate, trials) };
}
