// SEED CANDIDATE (descriptor only) — deep-confirm SET-level gate.
//
// The live A/B is ORCHESTRATOR-OWNED (calibrated path): the real M66-clean /
// M51-collapse sweeps + any config-site env binding land separately. This file
// registers the descriptor + its HONEST seed verdict; it wires NO live run.
//
// Config site (orchestrator-owned to wire): forced_confirm.ts set-level
// family-wise gate (SOLVER_CONFIRM_SET_EXCESS_Z=15, N=1-calibrated — SeeStar
// only). The candidate is "run set-level forced-confirmation" ON vs OFF; here
// the binding names a plausible toggle, not yet a real config read.

import { extractConfirmationOutcome, makeConfirmationDelta } from '../domains.ts';
import type { Candidate } from '../types.ts';

/** The N=1-calibrated SeeStar set-level excess-z gate. */
export const DEEP_CONFIRM_SET_GATE = 15;

export const DEEP_CONFIRM_SET: Candidate = {
  id: 'deep_confirm_set',
  description:
    'Set-level forced-photometry confirmation gate (family-wise, excess-z ≥ 15). Session-path + science-buffer; N=1-calibrated on SeeStar — not yet a trusted science product.',
  domain: 'CONFIRMATION',
  applicability: new Set(['FITS_SEESTAR']),
  binding: {
    envVar: 'SOLVER_DEEP_CONFIRM_SET',
    offValue: '0',
    onValue: '1',
    defaultByType: { FITS_SEESTAR: 'OFF' },
  },
  extractOutcome: extractConfirmationOutcome,
  computeDelta: makeConfirmationDelta(DEEP_CONFIRM_SET_GATE),
  policy: {
    // ≥1 star-rich, DIFFERENT-target frame reaching true_excess_z ≥ gate with
    // no wrong-hypothesis crossing it; any false_confirm BLOCKS.
    // NOTE (deferred — graduation-threshold overhaul, owner 2026-07-07): k=1 is
    // too weak (one clean frame like M66 would GRADUATE since M51 collapses →
    // net_improvements=1). Revisit ALL thresholds — set them HIGH — once the
    // autonomous overnight-verification pipeline is collecting deterministic data.
    nMin: { FITS_SEESTAR: 1 },
    nMinDefault: 1,
    k: 1,
    blockingRegressions: ['false_confirm'],
  },
  // Honest current state: M66-clean / M51-collapse only — one clean frame is not
  // yet ≥ N_min of DISTINCT targets to trust the gate as a science product.
  seedVerdicts: { FITS_SEESTAR: 'INSUFFICIENT-DATA' },
};
