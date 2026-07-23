#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/executors/common.mjs — shared executor plumbing
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN §6. Every executor is (row, env, paths) → an outcome record and
// deposits EXACTLY one self-describing row through tools/db/deposit.mjs
// (depositResult; run_label REQUIRED — an unlabeled benchmark number is not
// interpretable). This module holds the pieces every executor reuses so no
// executor re-implements the deposit envelope or the box-identity read.
//
// The executor contract (all five honor it):
//   • deterministic given the same inputs,
//   • deposits via depositResult (never writes the store by hand),
//   • never swallows a nonzero child exit (a child failure is a MEASURED red),
//   • kills its own children by exact pid (via lib/child.mjs → env.killProcessTree),
//   • reports MEASURED outcomes only (honest-or-absent — no fabricated numbers).
//
// An executor RETURNS { envelope, red, outcome, summary } and run.mjs sums `red`
// for the suite exit code. `red` = a genuine failure (crash / gate break / count
// drift), NEVER an honest no-solve or honest timeout on the solve lane (those are
// valid measured outcomes, per the population taxonomy: 40 solved / 35 no_solve /
// 7 honest_timeout are ALL expected).
// ═══════════════════════════════════════════════════════════════════════════

import { hostBox } from '../env.mjs';
import { depositResult } from '../../../db/deposit.mjs';

// Box identity for the deposited row (null-honest shard_count = 1 on one box).
export function boxIdentity(paths = {}) {
  return { host: hostBox().box, shard_count: paths.shardCount ?? 1 };
}

// Deposit one envelope row for an executor. Thin wrapper over depositResult that
// pins the required run_label + box + run_id from the run context (paths). The
// lane-specific payload is spread additively via `fields`.
export function depositRow(paths, {
  frameSha = null, frameShaMode, receipt = null, receiptPath = null,
  outcome = 'unknown', decoderArm, fields = {},
}) {
  if (!paths || typeof paths.label !== 'string' || !paths.label) {
    throw new Error('executor deposit: paths.label (run_label) is REQUIRED — refusing to deposit an unlabeled row');
  }
  return depositResult({
    ledgerPath: paths.ledgerPath,
    runLabel: paths.label,
    runId: paths.runId ?? null,
    root: paths.root,
    frameSha, frameShaMode,
    receipt, receiptPath,
    outcome,
    decoderArm,
    box: boxIdentity(paths),
    fields,
  });
}

// Resolve the executable + args for the vitest-hosted lanes. Injectable so the
// unit tests point the SAME real spawn path at a trivial `node -e` child.
export function nodeBin(deps = {}) { return deps.command ?? process.execPath; }

// A tail of captured child output for red diagnosis (never the whole 28k-line log).
export function tail(s, n = 1600) {
  if (!s) return '';
  const str = String(s);
  return str.length > n ? '…' + str.slice(-n) : str;
}
