// Unit tests for the Validation & Graduation Harness (tools/validation/).
// SYNTHETIC only — ZERO calibrated-path dependency (spec §Acceptance gates).
// Covers: all five verdicts incl. per-type-vs-global + N/A, delta computation,
// median efficiency aggregation, ledger round-trip, and the end-to-end
// synthetic run → ledger → check → grade proof.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ledger } from '../../../tools/validation/ledger.ts';
import { run, runOne } from '../../../tools/validation/runner.ts';
import { check, tallyForType, globalVerdict } from '../../../tools/validation/policy.ts';
import { gradeTools } from '../../../tools/validation/grade.ts';
import { median, costScalar } from '../../../tools/validation/stats.ts';
import {
  computeSolverDelta,
  makeConfirmationDelta,
  type SolverOutcome,
  type ConfirmationOutcome,
} from '../../../tools/validation/domains.ts';
import {
  SYNTHETIC,
  SYNTHETIC_INPUTS,
  syntheticRunFn,
  SYNTH_ENV,
} from '../../../tools/validation/candidates/synthetic.ts';
import type { Candidate, Trial, Efficiency } from '../../../tools/validation/types.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────
let TMP: string;
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'valh-'));
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const EFF: Efficiency = {
  baseline_ms: 100,
  candidate_ms: 120,
  cost: { centers_tried: 1, sweeps: 0, escalations: 0, catalog_pages: 1 },
  locking_tool: 'none',
};

/** Build a trial whose delta has `imp` improvements and `reg` regressions. */
function mkTrial(
  input_id: string,
  image_type: string,
  imp: string[],
  reg: string[],
): Trial {
  return {
    candidate_id: 'test',
    input_id,
    image_type,
    baseline: {},
    candidate: {},
    delta: { improvements: imp, regressions: reg },
    efficiency: EFF,
    ts: 0,
  };
}

/** Minimal policy candidate: applicable to two types, N_min 3, K 2, any-regression-blocks. */
const POLICY_CAND: Candidate = {
  id: 'test',
  description: 'policy fixture',
  domain: 'SOLVER',
  applicability: new Set(['FITS_SEESTAR', 'CR2_DSLR']),
  binding: { envVar: 'X', offValue: '0', onValue: '1', defaultByType: {} },
  extractOutcome: () => ({}),
  computeDelta: () => ({ improvements: [], regressions: [] }),
  policy: { nMin: { FITS_SEESTAR: 3, CR2_DSLR: 3 }, nMinDefault: 3, k: 2 },
};

// ── Ledger round-trip ────────────────────────────────────────────────────────
describe('ledger round-trip', () => {
  it('appends and reads JSONL, dedups by input_id (last-write-wins), has()', () => {
    const led = new Ledger('rt', TMP);
    led.append(mkTrial('a', 'FITS_SEESTAR', ['new_verified_lock'], []));
    led.append(mkTrial('b', 'FITS_SEESTAR', [], []));
    led.append(mkTrial('a', 'FITS_SEESTAR', [], ['lost_lock'])); // re-log 'a'

    expect(led.readRaw()).toHaveLength(3); // append-only history preserved
    const deduped = led.read();
    expect(deduped).toHaveLength(2); // one per distinct input_id
    const a = deduped.find((t) => t.input_id === 'a')!;
    expect(a.delta.regressions).toEqual(['lost_lock']); // last write wins
    expect(led.has('a')).toBe(true);
    expect(led.has('zzz')).toBe(false);
  });

  it('reads an empty/absent ledger as []', () => {
    expect(new Ledger('does-not-exist', TMP).read()).toEqual([]);
  });
});

// ── Delta computation ────────────────────────────────────────────────────────
describe('delta computation', () => {
  const locked = (extra: Partial<SolverOutcome> = {}): SolverOutcome => ({
    locked: true,
    ra: 1,
    dec: 2,
    sigma: 8,
    matched: 100,
    budget_ms: 500,
    ...extra,
  });
  const unlocked = (): SolverOutcome => ({
    locked: false,
    ra: null,
    dec: null,
    sigma: null,
    matched: 0,
    budget_ms: 500,
  });

  it('SOLVER: new_verified_lock when candidate locks where baseline did not', () => {
    expect(computeSolverDelta(unlocked(), locked())).toEqual({
      improvements: ['new_verified_lock'],
      regressions: [],
    });
  });
  it('SOLVER: lost_lock when baseline locked but candidate did not (budget dilution)', () => {
    expect(computeSolverDelta(locked(), unlocked())).toEqual({
      improvements: [],
      regressions: ['lost_lock'],
    });
  });
  it('SOLVER: new_false_positive from an oracle flag never counts as an improvement', () => {
    const d = computeSolverDelta(unlocked(), locked({ false_positive: true }));
    expect(d.improvements).toEqual([]);
    expect(d.regressions).toEqual(['new_false_positive']);
  });
  it('SOLVER: no change when both arms lock', () => {
    expect(computeSolverDelta(locked(), locked())).toEqual({ improvements: [], regressions: [] });
  });

  it('CONFIRMATION: new_confirmed_frame when true≥gate and no wrong crosses gate', () => {
    const delta = makeConfirmationDelta(15);
    const base: ConfirmationOutcome = { confirmed_n: 0, true_excess_z: 2, max_wrong_excess_z: 1 };
    const cand: ConfirmationOutcome = { confirmed_n: 5, true_excess_z: 22, max_wrong_excess_z: 4 };
    expect(delta(base, cand)).toEqual({ improvements: ['new_confirmed_frame'], regressions: [] });
  });
  it('CONFIRMATION: false_confirm when any wrong hypothesis crosses the gate', () => {
    const delta = makeConfirmationDelta(15);
    const base: ConfirmationOutcome = { confirmed_n: 0, true_excess_z: 0, max_wrong_excess_z: 0 };
    const cand: ConfirmationOutcome = { confirmed_n: 3, true_excess_z: 30, max_wrong_excess_z: 18 };
    expect(delta(base, cand).regressions).toEqual(['false_confirm']);
  });
});

// ── Policy: all five verdicts + per-type vs global + N/A ──────────────────────
describe('policy verdicts (all five + per-type vs global + N/A)', () => {
  it('GRADUATE: ≥N_min inputs, net improvements ≥ K, zero regressions', () => {
    const trials = [
      mkTrial('1', 'FITS_SEESTAR', ['new_verified_lock'], []),
      mkTrial('2', 'FITS_SEESTAR', ['new_verified_lock'], []),
      mkTrial('3', 'FITS_SEESTAR', [], []),
    ];
    expect(tallyForType(POLICY_CAND, trials, 'FITS_SEESTAR').verdict).toBe('GRADUATE');
  });

  it('KEEP-EVAL: enough data, no regressions, but net improvements < K', () => {
    const trials = [
      mkTrial('1', 'FITS_SEESTAR', ['new_verified_lock'], []),
      mkTrial('2', 'FITS_SEESTAR', [], []),
      mkTrial('3', 'FITS_SEESTAR', [], []),
    ];
    expect(tallyForType(POLICY_CAND, trials, 'FITS_SEESTAR').verdict).toBe('KEEP-EVAL');
  });

  it('BLOCKED: any regression dominates (even below N_min)', () => {
    const trials = [mkTrial('1', 'FITS_SEESTAR', ['new_verified_lock'], ['lost_lock'])];
    expect(tallyForType(POLICY_CAND, trials, 'FITS_SEESTAR').verdict).toBe('BLOCKED');
  });

  it('INSUFFICIENT-DATA: < N_min distinct inputs, no regressions', () => {
    const trials = [
      mkTrial('1', 'FITS_SEESTAR', ['new_verified_lock'], []),
      mkTrial('2', 'FITS_SEESTAR', ['new_verified_lock'], []),
    ];
    expect(tallyForType(POLICY_CAND, trials, 'FITS_SEESTAR').verdict).toBe('INSUFFICIENT-DATA');
  });

  it('INSUFFICIENT-DATA does not count re-logged duplicate inputs toward N_min', () => {
    const trials = [
      mkTrial('1', 'FITS_SEESTAR', ['new_verified_lock'], []),
      mkTrial('1', 'FITS_SEESTAR', ['new_verified_lock'], []), // same input_id — should be deduped upstream
    ];
    // policy filters distinct input_ids itself
    expect(tallyForType(POLICY_CAND, trials, 'FITS_SEESTAR').n).toBe(1);
  });

  it('N/A: an image_type outside applicability is not a null', () => {
    const na = { ...POLICY_CAND, applicability: new Set(['CR2_DSLR']) } as Candidate;
    expect(tallyForType(na, [], 'FITS_SEESTAR').verdict).toBe('N/A');
    expect(tallyForType(na, [], 'FITS_SEESTAR').applicable).toBe(false);
  });

  it('per-type vs GLOBAL: one type GRADUATE, another KEEP-EVAL → global KEEP-EVAL', () => {
    const trials = [
      // FITS graduates
      mkTrial('f1', 'FITS_SEESTAR', ['new_verified_lock'], []),
      mkTrial('f2', 'FITS_SEESTAR', ['new_verified_lock'], []),
      mkTrial('f3', 'FITS_SEESTAR', [], []),
      // CR2 keep-eval
      mkTrial('c1', 'CR2_DSLR', ['new_verified_lock'], []),
      mkTrial('c2', 'CR2_DSLR', [], []),
      mkTrial('c3', 'CR2_DSLR', [], []),
    ];
    expect(tallyForType(POLICY_CAND, trials, 'FITS_SEESTAR').verdict).toBe('GRADUATE');
    expect(tallyForType(POLICY_CAND, trials, 'CR2_DSLR').verdict).toBe('KEEP-EVAL');
    expect(globalVerdict(POLICY_CAND, trials)).toBe('KEEP-EVAL'); // not all types graduated
  });

  it('GLOBAL GRADUATE only when every applicable type graduates', () => {
    const trials = [
      mkTrial('f1', 'FITS_SEESTAR', ['new_verified_lock'], []),
      mkTrial('f2', 'FITS_SEESTAR', ['new_verified_lock'], []),
      mkTrial('f3', 'FITS_SEESTAR', [], []),
      mkTrial('c1', 'CR2_DSLR', ['new_verified_lock'], []),
      mkTrial('c2', 'CR2_DSLR', ['new_verified_lock'], []),
      mkTrial('c3', 'CR2_DSLR', [], []),
    ];
    expect(globalVerdict(POLICY_CAND, trials)).toBe('GRADUATE');
  });

  it('GLOBAL BLOCKED when any type has a regression', () => {
    const trials = [
      mkTrial('f1', 'FITS_SEESTAR', ['new_verified_lock'], []),
      mkTrial('c1', 'CR2_DSLR', [], ['lost_lock']),
    ];
    expect(globalVerdict(POLICY_CAND, trials)).toBe('BLOCKED');
  });

  it('blockingRegressions allowlist: a non-listed regression does not BLOCK', () => {
    const lenient = {
      ...POLICY_CAND,
      policy: { ...POLICY_CAND.policy, blockingRegressions: ['new_false_positive'] },
    } as Candidate;
    // 'lost_lock' present but not in the allowlist → still counts as a regression
    // (so not GRADUATE) but does NOT force BLOCKED.
    const trials = [
      mkTrial('1', 'FITS_SEESTAR', ['new_verified_lock'], ['lost_lock']),
      mkTrial('2', 'FITS_SEESTAR', ['new_verified_lock'], []),
      mkTrial('3', 'FITS_SEESTAR', [], []),
    ];
    expect(tallyForType(lenient, trials, 'FITS_SEESTAR').verdict).toBe('KEEP-EVAL');
  });
});

// ── Median efficiency aggregation ─────────────────────────────────────────────
describe('median efficiency aggregation', () => {
  it('median() is deterministic and honest-or-absent on empty', () => {
    expect(median([460, 400, 420])).toBe(420); // odd
    expect(median([400, 420])).toBe(410); // even
    expect(median([])).toBeNull(); // NOT MEASURED, never a fabricated 0
  });
  it('costScalar sums the four proxies', () => {
    expect(costScalar({ centers_tried: 10, sweeps: 1440, escalations: 2, catalog_pages: 8 })).toBe(1460);
    expect(costScalar(undefined)).toBe(0);
  });
});

// ── End-to-end synthetic proof ────────────────────────────────────────────────
describe('SYNTHETIC end-to-end: run → ledger → check → grade', () => {
  let ledger: Ledger;
  let tick = 1000;
  const clock = () => tick++;

  beforeAll(async () => {
    ledger = new Ledger(SYNTHETIC.id, TMP);
    // env is unset before the run — assert the binding restores it after.
    delete process.env[SYNTH_ENV];
    await run(SYNTHETIC, SYNTHETIC_INPUTS, syntheticRunFn, { ledger, clock });
  });

  it('flips the env binding per-arm and RESTORES it afterward (byte-identical when unset)', () => {
    expect(process.env[SYNTH_ENV]).toBeUndefined();
  });

  it('runOne drives OFF then ON via the env binding (proves the A/B mechanism)', async () => {
    const input = SYNTHETIC_INPUTS.find((i) => i.id === 'fits-1')!;
    const trial = await runOne(SYNTHETIC, input, syntheticRunFn, clock);
    expect((trial.baseline as SolverOutcome).locked).toBe(false); // OFF arm
    expect((trial.candidate as SolverOutcome).locked).toBe(true); // ON arm
    expect(trial.delta.improvements).toEqual(['new_verified_lock']);
  });

  it('logs a trial per distinct input', () => {
    expect(ledger.read()).toHaveLength(SYNTHETIC_INPUTS.length);
  });

  it('per-type + global verdicts: FITS GRADUATE, CR2 KEEP-EVAL, GLOBAL KEEP-EVAL', () => {
    const report = check(SYNTHETIC, ledger.read());
    const fits = report.perType.find((p) => p.image_type === 'FITS_SEESTAR')!;
    const cr2 = report.perType.find((p) => p.image_type === 'CR2_DSLR')!;
    expect(fits.verdict).toBe('GRADUATE');
    expect(fits.improvements).toBe(2);
    expect(fits.regressions).toBe(0);
    expect(cr2.verdict).toBe('KEEP-EVAL');
    expect(cr2.improvements).toBe(1);
    expect(report.global).toBe('KEEP-EVAL');
  });

  it('is idempotent: a re-run skips already-logged inputs (append-only, no double count)', async () => {
    const summary = await run(SYNTHETIC, SYNTHETIC_INPUTS, syntheticRunFn, { ledger, clock });
    expect(summary.ran).toHaveLength(0);
    expect(summary.skipped).toHaveLength(SYNTHETIC_INPUTS.length);
    expect(ledger.read()).toHaveLength(SYNTHETIC_INPUTS.length);
  });

  it('grade_tools: per-(tool,image_type) medians + the effectiveness×efficiency tradeoff', () => {
    const { rows } = gradeTools(ledger.read());
    const quad = rows.find((r) => r.tool === 'quad_matcher' && r.image_type === 'FITS_SEESTAR')!;
    const anchor = rows.find((r) => r.tool === 'anchored_sweep' && r.image_type === 'CR2_DSLR')!;
    const deep = rows.find((r) => r.tool === 'deep_verify_escalation' && r.image_type === 'CR2_DSLR')!;

    // FITS quad_matcher: locks 3 of 4 → median ms 420, median σ 8.2, median cost 3.
    expect(quad.lock_rate).toBeCloseTo(0.75, 6);
    expect(quad.median_ms).toBe(420);
    expect(quad.median_sigma).toBe(8.2);
    expect(quad.median_cost).toBe(3);

    // CR2 anchored_sweep: locks 2 of 4 → median ms 2500.
    expect(anchor.lock_rate).toBeCloseTo(0.5, 6);
    expect(anchor.median_ms).toBe(2500);

    // CR2 deep_verify: locks 1 of 4 (lower effectiveness) but far cheaper/faster,
    // so its combined grade OUTSCORES the anchored sweep — the sequencing signal.
    expect(deep.lock_rate).toBeCloseTo(0.25, 6);
    expect(deep.median_ms).toBe(800);
    expect(deep.grade_score).toBeGreaterThan(anchor.grade_score);
    expect(deep.efficiency).toBeGreaterThan(anchor.efficiency);
  });

  it('grade_tools can scope to one image_type', () => {
    const { rows } = gradeTools(ledger.read(), 'FITS_SEESTAR');
    expect(rows.every((r) => r.image_type === 'FITS_SEESTAR')).toBe(true);
    expect(rows.some((r) => r.tool === 'quad_matcher')).toBe(true);
  });
});
