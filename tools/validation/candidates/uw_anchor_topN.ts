// SEED CANDIDATE (descriptor only) — top-N ultra-wide anchor candidates.
//
// The live A/B is ORCHESTRATOR-OWNED (calibrated path): running the real gauntlet
// with SOLVER_UW_ANCHOR_CANDIDATES flipped 1↔3 is done separately, after the
// sun-veto work. This file registers the candidate's metadata, binding spec,
// applicability, policy and its HONEST current seed verdict so the registry and
// the future runner have a first-class descriptor. It wires NO live run.
//
// Config site: src/engine/pipeline/constants/pipeline_config.ts
//   SOLVER_UW_ANCHOR_CANDIDATES (default 3; set 1 for the exact pre-§2a
//   single-argmax, byte-identical behavior). FOV-gated → narrow FITS never
//   reaches it, hence applicability {CR2_DSLR} only (N/A on FITS).

import { extractSolverOutcome, computeSolverDelta } from '../domains.ts';
import type { Candidate } from '../types.ts';

export const UW_ANCHOR_TOPN: Candidate = {
  id: 'uw_anchor_topN',
  description:
    'Ultra-wide anchored sweep tries the top-N flux-ranked detections as alternative anchor hypotheses (SOLVER_UW_ANCHOR_CANDIDATES). Guards anchor-misidentification; risks budget dilution.',
  domain: 'SOLVER',
  // UW/FOV-gated: engages only on DSLR ultra-wide blind solves.
  applicability: new Set(['CR2_DSLR']),
  binding: {
    envVar: 'SOLVER_UW_ANCHOR_CANDIDATES',
    offValue: '1', // exact single-argmax (pre-§2a, byte-identical)
    onValue: '3', // top-3 anchor hypotheses
    defaultByType: { CR2_DSLR: 'OFF' }, // ships OFF (config default 1) pending evidence — under-eval per this harness
  },
  extractOutcome: extractSolverOutcome,
  computeDelta: computeSolverDelta,
  policy: {
    // ≥20 distinct CR2 inputs; ≥3 net new verified locks; ZERO regressions.
    // lost_lock is a first-class BLOCKER — the budget-dilution guard the raw
    // default-3 lacked.
    nMin: { CR2_DSLR: 20 },
    nMinDefault: 20,
    k: 3,
    blockingRegressions: ['lost_lock', 'new_false_positive'],
  },
  // Honest current state: the 0/6 gauntlet A/B already measured — no new locks,
  // no regressions → not enough evidence to graduate, but safe.
  seedVerdicts: { CR2_DSLR: 'KEEP-EVAL' },
};
