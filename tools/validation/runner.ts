// The Runner: for each input, run the pipeline BOTH ways — baseline (OFF) then
// candidate (ON) — by flipping the env-var binding around the run function
// (never mutating source; reversible; parallel-safe). Extracts a domain outcome
// + efficiency from each arm, computes the delta, appends a trial. Idempotent,
// keyed by input_id.

import { Ledger } from './ledger.ts';
import { fullCost } from './stats.ts';
import type {
  Candidate,
  RunFn,
  RunInput,
  RunResult,
  Trial,
  Efficiency,
} from './types.ts';

export interface RunOptions {
  /** Re-run inputs already in the ledger (default: skip → true idempotency). */
  force?: boolean;
  /** Ledger to append to (default: the candidate's gitignored JSONL). */
  ledger?: Ledger;
  /**
   * Timestamp source for the `ts` DATA field. Default Date.now. Injectable so
   * tests are fully reproducible — `ts` is DATA, never control flow.
   */
  clock?: () => number;
}

export interface RunSummary {
  candidate_id: string;
  ran: string[]; // input_ids newly appended
  skipped: string[]; // input_ids already present (idempotent no-op)
  trials: Trial[]; // the appended trials (for in-process assertions)
}

/** Set an env var and return a restore fn (undefined ⇒ delete on restore). */
function withEnv(name: string, value: string): () => void {
  const prev = process.env[name];
  process.env[name] = value;
  return () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
}

function toEfficiency(baseline: RunResult, candidate: RunResult): Efficiency {
  return {
    baseline_ms: baseline.wall_ms,
    candidate_ms: candidate.wall_ms,
    cost: fullCost(candidate.cost),
    locking_tool: candidate.locking_tool ?? 'none',
  };
}

/**
 * Run one input through both arms and produce a trial (no ledger side-effects).
 * Exposed for unit tests; `run()` wraps this with idempotency + persistence.
 */
export async function runOne(
  candidate: Candidate,
  input: RunInput,
  runFn: RunFn,
  clock: () => number = Date.now,
): Promise<Trial> {
  const { envVar, offValue, onValue } = candidate.binding;

  const restoreOff = withEnv(envVar, offValue);
  let baselineResult: RunResult;
  try {
    baselineResult = await runFn(input);
  } finally {
    restoreOff();
  }

  const restoreOn = withEnv(envVar, onValue);
  let candidateResult: RunResult;
  try {
    candidateResult = await runFn(input);
  } finally {
    restoreOn();
  }

  const baseline = candidate.extractOutcome(baselineResult);
  const cand = candidate.extractOutcome(candidateResult);
  const delta = candidate.computeDelta(baseline, cand);

  return {
    candidate_id: candidate.id,
    input_id: input.id,
    image_type: input.image_type,
    baseline,
    candidate: cand,
    delta,
    efficiency: toEfficiency(baselineResult, candidateResult),
    ts: clock(),
  };
}

/** Run a whole input set, appending to the ledger (idempotent by input_id). */
export async function run(
  candidate: Candidate,
  inputs: readonly RunInput[],
  runFn: RunFn,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const ledger = opts.ledger ?? new Ledger(candidate.id);
  const clock = opts.clock ?? Date.now;
  const summary: RunSummary = {
    candidate_id: candidate.id,
    ran: [],
    skipped: [],
    trials: [],
  };

  for (const input of inputs) {
    if (!opts.force && ledger.has(input.id)) {
      summary.skipped.push(input.id);
      continue;
    }
    const trial = await runOne(candidate, input, runFn, clock);
    ledger.append(trial);
    summary.ran.push(input.id);
    summary.trials.push(trial);
  }
  return summary;
}
