#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/executors/solve_to_receipt.mjs — the REAL wizard solve lane
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN §6. Drives the REAL calibrated wizard pipeline per frame,
// PROCESS-PER-FRAME, exactly as tools/corpus/population_timing_run.mjs proved:
// a fresh `node vitest.mjs run -c tools/api/run.config.ts` against the
// established solve_to_receipt.runspec.ts, with the FITS/CR2 path + receipt path
// threaded through env. (runWizardPipeline can only run under the vitest harness
// — it resolves the engine `@/` alias and boots the compiled wasm; a plain .mjs
// cannot.) The receipt is written by the runspec to API_RUN_RECEIPT_OUT and read
// back here. This is the single place the real pipeline is driven from testkit —
// it RETIRES run_corpus.mjs's duplicate solve loop (LAW 4, no code in two places).
//
// Outcome taxonomy — BYTE-for-BYTE the population runner's (LAW 4, no divergence):
//   honest_timeout   the child exceeded its budget → killed by exact pid (not red)
//   solved           receipt.solution != null                              (not red)
//   honest_failure   receipt present, solution === null (a valid no-solve)  (not red)
//   error_bad_receipt receipt present but unparseable                       (RED)
//   error_no_receipt  no receipt, child exit 0                              (RED)
//   error            no receipt, child exit != 0                            (RED)
//   skipped_*        stack/skip-lane frames (correlated-set / oversize)     (not red)
// RED = infrastructure failure, NEVER an honest no-solve/timeout.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { runToCompletion } from '../child.mjs';
import { depositRow } from './common.mjs';

export const NAME = 'solve_to_receipt';
export const iterates = 'frames';

// The manifest's timeout_ms is the SOLVE wall budget (evidence-derived per frame).
// The child also pays vitest boot + wasm init + decode on top — add a fixed margin
// so a legitimate solve at its budget is never clipped by boot overhead. Recorded
// separately (solve_budget_ms vs child_timeout_ms) so the row stays honest.
export const SOLVE_BOOT_MARGIN_MS = 150_000;
const DEFAULT_SOLVE_BUDGET_MS = 300_000;        // fallback if a row carries no budget

function vitestArgs(env) {
  const vitest = path.join(env.root, 'node_modules', 'vitest', 'vitest.mjs');
  return [vitest, 'run', '-c', 'tools/api/run.config.ts'];
}

function skipOutcome(frame) {
  if (frame.disposition === 'skipped_too_large') return 'skipped_too_large';
  if (frame.disposition === 'skipped_correlated_set') return 'skipped_correlated_set';
  return `skipped_${frame.disposition ?? frame.lane}`;
}

export async function run(frame, env, paths, deps = {}) {
  // ── stack/skip-lane frames: deposit an honest disposition row, no solve ──────
  if (frame.lane !== 'solve') {
    const outcome = skipOutcome(frame);
    const envelope = depositRow(paths, {
      frameSha: frame.sha ?? null,
      outcome,
      decoderArm: frame.format === 'CR2' ? 'rawler' : null,
      fields: {
        executor: NAME, frame_id: frame.id, rel: frame.rel, format: frame.format,
        lane: frame.lane, disposition: frame.disposition, set_id: frame.set_id ?? null,
        reason: frame.reason ?? null, size_bytes: frame.size_bytes ?? null,
      },
    });
    return { envelope, red: false, outcome, summary: `${frame.id} ${outcome}` };
  }

  const runChild = deps.runToCompletion ?? runToCompletion;
  const receiptsDir = paths.receiptsDir;
  const logsDir = paths.logsDir ?? receiptsDir;
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const receiptOut = path.join(receiptsDir, `${frame.id}.receipt.json`);
  const timingOut = path.join(logsDir, `${frame.id}.timing.jsonl`);
  const logOut = path.join(logsDir, `${frame.id}.log`);
  try { if (fs.existsSync(receiptOut)) fs.rmSync(receiptOut); } catch { /* fresh run */ }
  try { if (fs.existsSync(timingOut)) fs.rmSync(timingOut); } catch { /* fresh run */ }

  const solveBudget = Number.isFinite(frame.timeout_ms) ? frame.timeout_ms : DEFAULT_SOLVE_BUDGET_MS;
  const childTimeout = solveBudget + SOLVE_BOOT_MARGIN_MS;

  const spec = {
    command: deps.command ?? process.execPath,
    args: deps.args ?? vitestArgs(env),
    cwd: env.root,
    env: {
      ...process.env,
      ...(deps.childEnv ?? {}),
      API_RUN_FITS: frame.abs,
      API_RUN_RECEIPT_OUT: receiptOut,
      SKYCRUNCHER_PERF_TIMINGS_PATH: timingOut,
    },
    logFile: logOut,
    timeoutMs: childTimeout,
  };
  const res = await runChild(spec, deps.childOpts);

  // ── outcome mapping (mirrors population_timing_run.mjs runFrame) ─────────────
  let outcome, receipt = null, red = false;
  if (res.timedOut) {
    outcome = 'honest_timeout';
  } else if (fs.existsSync(receiptOut)) {
    try { receipt = JSON.parse(fs.readFileSync(receiptOut, 'utf8')); } catch { receipt = null; }
    if (!receipt) { outcome = 'error_bad_receipt'; red = true; }
    else outcome = receipt.solution != null ? 'solved' : 'honest_failure';
  } else {
    outcome = res.code === 0 ? 'error_no_receipt' : 'error';
    red = true;
  }

  // best-effort per-frame timing sidecar (never fatal)
  let timing = null;
  try {
    if (fs.existsSync(timingOut)) {
      const lines = fs.readFileSync(timingOut, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      if (lines.length) timing = JSON.parse(lines[lines.length - 1]);
    }
  } catch { /* honest-absent */ }

  const s = receipt?.solution ?? null;
  const envelope = depositRow(paths, {
    frameSha: frame.sha ?? null,
    receipt, receiptPath: receiptOut, outcome,
    decoderArm: timing?.decoder_arm ?? (frame.format === 'CR2' ? 'rawler' : null),
    fields: {
      executor: NAME, frame_id: frame.id, rel: frame.rel, format: frame.format,
      lane: frame.lane, set_id: frame.set_id ?? null, disposition: frame.disposition ?? null,
      size_bytes: frame.size_bytes ?? null,
      solve_budget_ms: solveBudget, child_timeout_ms: childTimeout,
      wall_ms: res.durationMs, child_exit: res.code, child_signal: res.signal,
      timed_out: res.timedOut, child_pid: res.pid, kill_method: res.killResult?.method ?? null,
      child_error: res.error ?? null,
      ra_hours: s?.ra_hours ?? null, dec_degrees: s?.dec_degrees ?? null,
      pixel_scale: s?.pixel_scale ?? null, stars_matched: s?.stars_matched ?? null,
      confidence: s?.confidence ?? null,
      confirm_status: receipt?.confirm_status?.status ?? null,
      total_ms: timing?.total_ms ?? null, n_stages: timing?.n_stages ?? null,
      log: path.relative(env.root, logOut).replace(/\\/g, '/'),
    },
  });

  return {
    envelope, red, outcome,
    summary: `${frame.format} ${frame.id} → ${outcome} matched=${s?.stars_matched ?? '-'} wall=${(res.durationMs / 1000).toFixed(1)}s`,
  };
}
