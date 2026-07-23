// The candidate manifest. Every registered candidate + its per-image-type state
// (OFF / EVAL / ON) and latest verdict. If a ledger exists the verdict is
// computed mechanically from it; otherwise the candidate's HONEST declared seed
// verdict stands (descriptor-only candidates whose live A/B is orchestrator-owned).

import { Ledger, DEFAULT_LEDGER_DIR } from './ledger.ts';
import { check } from './policy.ts';
import { SYNTHETIC } from './candidates/synthetic.ts';
import { UW_ANCHOR_TOPN } from './candidates/uw_anchor_topN.ts';
import { DEEP_CONFIRM_SET } from './candidates/deep_confirm_set.ts';
import { FITS_SOLVE } from './candidates/fits_solve.ts';
import type { Candidate, ImageType, Verdict, BindingState } from './types.ts';

/** Every candidate the harness knows about. */
export const CANDIDATES: Candidate[] = [SYNTHETIC, UW_ANCHOR_TOPN, DEEP_CONFIRM_SET, FITS_SOLVE];

export function getCandidate(id: string): Candidate | undefined {
  return CANDIDATES.find((c) => c.id === id);
}

export interface TypeState {
  image_type: ImageType;
  applicable: boolean;
  state: BindingState; // OFF | EVAL | ON
  verdict: Verdict;
  n: number; // distinct inputs logged for this type
}

export interface CandidateSummary {
  id: string;
  domain: Candidate['domain'];
  description: string;
  applicability: ImageType[];
  perType: TypeState[];
  global: Verdict;
  ledger_inputs: number; // total distinct inputs logged
}

/**
 * Summarize a candidate's live state. Reads its ledger (if any) for verdicts;
 * falls back to the declared seed verdict for a descriptor with no evidence yet.
 */
export function summarize(candidate: Candidate, ledgerDir: string = DEFAULT_LEDGER_DIR): CandidateSummary {
  const ledger = new Ledger(candidate.id, ledgerDir);
  const trials = ledger.read();
  const hasEvidence = trials.length > 0;
  const report = hasEvidence ? check(candidate, trials) : null;

  const types = [...candidate.applicability];
  const perType: TypeState[] = types.map((type) => {
    const rows = trials.filter((t) => t.image_type === type);
    const n = new Set(rows.map((t) => t.input_id)).size;
    const shipped = candidate.binding.defaultByType[type] ?? 'OFF';

    // State: shipped ON ⇒ ON. Shipped OFF with logged trials ⇒ EVAL (collecting
    // evidence). Shipped OFF, no trials ⇒ OFF (inert).
    let state: BindingState;
    if (shipped === 'ON') state = 'ON';
    else state = n > 0 ? 'EVAL' : 'OFF';

    // Verdict: from the ledger if we have evidence, else the honest seed verdict.
    let verdict: Verdict;
    if (report) {
      verdict = report.perType.find((p) => p.image_type === type)?.verdict ?? 'INSUFFICIENT-DATA';
    } else {
      verdict = candidate.seedVerdicts?.[type] ?? 'INSUFFICIENT-DATA';
    }

    return { image_type: type, applicable: true, state, verdict, n };
  });

  // Global verdict: mechanical from the ledger, else the strictest seed verdict
  // consistent with the per-type seeds (KEEP-EVAL/INSUFFICIENT precedence).
  let global: Verdict;
  if (report) {
    global = report.global;
  } else {
    const seeds = perType.map((p) => p.verdict);
    if (seeds.some((v) => v === 'BLOCKED')) global = 'BLOCKED';
    else if (seeds.length > 0 && seeds.every((v) => v === 'GRADUATE')) global = 'GRADUATE';
    else if (seeds.some((v) => v === 'INSUFFICIENT-DATA')) global = 'INSUFFICIENT-DATA';
    else global = 'KEEP-EVAL';
  }

  return {
    id: candidate.id,
    domain: candidate.domain,
    description: candidate.description,
    applicability: types,
    perType,
    global,
    ledger_inputs: trials.length,
  };
}

/** Summarize every registered candidate. */
export function summarizeAll(ledgerDir: string = DEFAULT_LEDGER_DIR): CandidateSummary[] {
  return CANDIDATES.map((c) => summarize(c, ledgerDir));
}
