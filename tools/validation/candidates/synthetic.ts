// SYNTHETIC candidate — the harness self-test. A fake "solver" that reads the
// binding's env var and returns DETERMINISTIC mock outcomes + timings across two
// image types. Zero calibrated-path dependency: a full run → ledger → check →
// grade exercises every moving part (env-override A/B, delta, per-type + global
// verdict, median efficiency) with numbers we can assert exactly.
//
// Designed story:
//   FITS_SEESTAR → GRADUATE  (2 new verified locks ≥ K, 0 regressions, n=4 ≥ 3)
//   CR2_DSLR     → KEEP-EVAL (1 new lock < K, 0 regressions, n=4 ≥ 3)
//   GLOBAL       → KEEP-EVAL (not all types graduate; none blocked/insufficient)

import { extractSolverOutcome, computeSolverDelta } from '../domains.ts';
import type { Candidate, RunFn, RunInput, RunResult } from '../types.ts';

/** The env-var binding the mock solver reads — the exact A/B mechanism the real
 *  candidates use (envInt at a config site), here with no config site to touch. */
export const SYNTH_ENV = 'VALIDATION_SYNTH_MODE';

/** Mock solver: OFF (env≠'1') → the input's `off` arm, ON (env==='1') → `on`. */
export const syntheticRunFn: RunFn = (input: RunInput): RunResult => {
  const on = process.env[SYNTH_ENV] === '1';
  const arm = (on ? input.on : input.off) as RunResult;
  return arm;
};

/** Convenience builder for a mock arm. */
function arm(
  locked: boolean,
  opts: {
    sigma?: number;
    matched?: number;
    wall_ms: number;
    tool?: string;
    cost?: RunResult['cost'];
  },
): RunResult {
  return {
    locked,
    ra: locked ? 11.34 : null,
    dec: locked ? 13.0 : null,
    sigma: locked ? (opts.sigma ?? 5) : null,
    matched: opts.matched ?? 0,
    budget_ms: opts.wall_ms,
    wall_ms: opts.wall_ms,
    locking_tool: locked ? (opts.tool ?? 'quad_matcher') : 'none',
    cost: opts.cost ?? {},
  };
}

export const SYNTHETIC_INPUTS: RunInput[] = [
  // ── FITS_SEESTAR: quad_matcher regime, graduates ──
  {
    id: 'fits-1',
    image_type: 'FITS_SEESTAR',
    off: arm(false, { wall_ms: 380 }),
    on: arm(true, {
      sigma: 8.2,
      matched: 272,
      wall_ms: 400,
      tool: 'quad_matcher',
      cost: { centers_tried: 1, sweeps: 0, escalations: 0, catalog_pages: 2 },
    }),
  },
  {
    id: 'fits-2',
    image_type: 'FITS_SEESTAR',
    off: arm(false, { wall_ms: 360 }),
    on: arm(true, {
      sigma: 7.5,
      matched: 210,
      wall_ms: 420,
      tool: 'quad_matcher',
      cost: { centers_tried: 1, sweeps: 0, escalations: 0, catalog_pages: 2 },
    }),
  },
  {
    id: 'fits-3', // both arms lock → no improvement, but grades quad_matcher
    image_type: 'FITS_SEESTAR',
    off: arm(true, { sigma: 9.1, matched: 300, wall_ms: 300, tool: 'quad_matcher' }),
    on: arm(true, {
      sigma: 9.3,
      matched: 305,
      wall_ms: 460,
      tool: 'quad_matcher',
      cost: { centers_tried: 1, sweeps: 0, escalations: 0, catalog_pages: 3 },
    }),
  },
  {
    id: 'fits-4', // neither arm locks
    image_type: 'FITS_SEESTAR',
    off: arm(false, { wall_ms: 350 }),
    on: arm(false, { wall_ms: 500 }),
  },

  // ── CR2_DSLR: two tools lock (efficiency-tradeoff demo), stays KEEP-EVAL ──
  {
    id: 'cr2-1', // both lock via the expensive anchored sweep → no improvement
    image_type: 'CR2_DSLR',
    off: arm(true, { sigma: 5.0, matched: 38, wall_ms: 2500, tool: 'anchored_sweep' }),
    on: arm(true, {
      sigma: 5.2,
      matched: 40,
      wall_ms: 2600,
      tool: 'anchored_sweep',
      cost: { centers_tried: 12, sweeps: 1440, escalations: 3, catalog_pages: 8 },
    }),
  },
  {
    id: 'cr2-2', // both lock via the cheap deep-verify escalation → no improvement
    image_type: 'CR2_DSLR',
    off: arm(true, { sigma: 6.0, matched: 28, wall_ms: 820, tool: 'deep_verify_escalation' }),
    on: arm(true, {
      sigma: 6.1,
      matched: 30,
      wall_ms: 800,
      tool: 'deep_verify_escalation',
      cost: { centers_tried: 2, sweeps: 0, escalations: 5, catalog_pages: 4 },
    }),
  },
  {
    id: 'cr2-3', // ON gains a lock via anchored sweep → the single improvement
    image_type: 'CR2_DSLR',
    off: arm(false, { wall_ms: 2400 }),
    on: arm(true, {
      sigma: 4.9,
      matched: 22,
      wall_ms: 2400,
      tool: 'anchored_sweep',
      cost: { centers_tried: 10, sweeps: 1440, escalations: 2, catalog_pages: 8 },
    }),
  },
  {
    id: 'cr2-4', // neither arm locks
    image_type: 'CR2_DSLR',
    off: arm(false, { wall_ms: 2300 }),
    on: arm(false, { wall_ms: 3000 }),
  },
];

export const SYNTHETIC: Candidate = {
  id: 'synthetic_solver',
  description:
    'Harness self-test: a fake env-driven solver spanning FITS_SEESTAR + CR2_DSLR with deterministic mock outcomes/timings. No calibrated dependency.',
  domain: 'SOLVER',
  applicability: new Set(['FITS_SEESTAR', 'CR2_DSLR']),
  binding: {
    envVar: SYNTH_ENV,
    offValue: '0',
    onValue: '1',
    defaultByType: { FITS_SEESTAR: 'OFF', CR2_DSLR: 'OFF' },
  },
  extractOutcome: extractSolverOutcome,
  computeDelta: computeSolverDelta,
  policy: {
    nMin: { FITS_SEESTAR: 3, CR2_DSLR: 3 },
    nMinDefault: 3,
    k: 2,
  },
};
