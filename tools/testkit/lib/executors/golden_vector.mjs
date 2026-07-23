#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/executors/golden_vector.mjs — the LAW-7 layout-contract lane
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN §6. Wraps tools/contracts/check_layout_contracts.mjs --json
// (the LAW-7 golden-vector battery) and deposits its counts into the unified
// store instead of leaving them asserts/stdout-only. The battery's own exit code
// is nonzero iff a STRUCTURAL/ARITHMETIC check FAILS or a real-artifact
// conformance probe did not conform; NOT MEASURED is honest absence and never
// fails (golden vectors land at decoder cutover #14).
//
//   node tools/contracts/check_layout_contracts.mjs --json
//
// The expected counts are CITED FROM docs/GATES.md at runtime (parsed, never
// hand-copied), per the standing gate: "0 real failures, no PASS regression, no
// boundary disappears." Outcome: failCount>0 → 'fail' (RED); failCount==0 but a
// PASS regression or a vanished boundary vs GATES.md → 'drift' (RED); otherwise
// 'pass'. A missing/unparseable GATES row degrades the expected side to null
// (honest) and the verdict falls back to failCount==0 alone.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { runToCompletion } from '../child.mjs';
import { depositRow, tail } from './common.mjs';

export const NAME = 'golden_vector';
export const iterates = 'singleton';
export const CHILD_TIMEOUT_MS = 120_000;   // the battery is fast (<5 s typical)

// Parse the GATES.md "Layout contracts (LAW 7)" row for the standing counts.
// Returns { pass, nm, fail, boundaries } or null when the row is absent/unparseable.
export function parseGatesLayout(gatesPath) {
  let text;
  try { text = fs.readFileSync(gatesPath, 'utf8'); } catch { return null; }
  const row = text.split(/\r?\n/).find((l) => /Layout contracts/i.test(l));
  if (!row) return null;
  const m = /\*\*(\d+)\*\*\s*PASS\s*·\s*\*\*(\d+)\*\*\s*NOT MEASURED\s*·\s*\*\*(\d+)\*\*\s*FAIL\s*across\s*\*\*(\d+)\*\*\s*boundaries/i.exec(row);
  if (!m) return null;
  return { pass: +m[1], nm: +m[2], fail: +m[3], boundaries: +m[4] };
}

// Count PASS / FAIL / NOT MEASURED across the battery's global + per-boundary checks.
export function countChecks(report) {
  const all = [
    ...(report.globalChecks ?? []),
    ...((report.boundaries ?? []).flatMap((b) => b.checks ?? [])),
  ];
  const by = (s) => all.filter((c) => c.status === s).length;
  return {
    pass: by('PASS'),
    fail: report.failCount ?? by('FAIL'),
    nm: by('NOT MEASURED'),
    boundaries: (report.boundaries ?? []).length,
  };
}

export async function run(scenario, env, paths, deps = {}) {
  const runChild = deps.runToCompletion ?? runToCompletion;
  const tool = deps.tool ?? path.join('tools', 'contracts', 'check_layout_contracts.mjs');

  const childSpec = {
    command: deps.command ?? process.execPath,
    args: deps.args ?? [tool, '--json'],
    cwd: env.root,
    env: { ...process.env, ...(deps.childEnv ?? {}) },
    timeoutMs: deps.timeoutMs ?? CHILD_TIMEOUT_MS,
  };
  const res = await runChild(childSpec, deps.childOpts);

  let report = null, parseError = null;
  try { report = JSON.parse(res.stdout); } catch (e) { parseError = String(e && e.message || e); }

  const expected = parseGatesLayout(path.join(env.root, 'docs', 'GATES.md'));
  let outcome, red, observed = null;
  if (res.timedOut) { outcome = 'honest_timeout'; red = true; }
  else if (!report) { outcome = 'error_bad_output'; red = true; }
  else {
    observed = countChecks(report);
    if (observed.fail > 0) { outcome = 'fail'; red = true; }
    else if (expected && (observed.pass < expected.pass || observed.boundaries < expected.boundaries)) {
      outcome = 'drift'; red = true;   // PASS regression or a vanished boundary — a real red vs the standing gate
    } else { outcome = 'pass'; red = false; }
  }

  const envelope = depositRow(paths, {
    frameSha: null,
    outcome,
    fields: {
      executor: NAME, scenario_id: scenario?.id ?? 'layout_contracts',
      verdict: outcome,
      surface_version: report?.surfaceVersion ?? null,
      observed, expected,
      counts_source: expected ? 'docs/GATES.md (parsed at runtime)' : 'GATES.md row absent — expected=null (honest)',
      child_exit: res.code, child_signal: res.signal, timed_out: res.timedOut,
      child_pid: res.pid, kill_method: res.killResult?.method ?? null,
      wall_ms: res.durationMs, child_error: res.error ?? parseError ?? null,
      output_tail: red ? tail(res.stdout + '\n' + res.stderr) : null,
    },
  });

  const oc = observed ? `${observed.pass}P·${observed.nm}NM·${observed.fail}F/${observed.boundaries}b` : '(no report)';
  return { envelope, red, outcome, summary: `golden_vector → ${outcome} ${oc}` };
}
