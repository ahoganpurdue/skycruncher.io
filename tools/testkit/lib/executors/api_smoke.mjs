#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/executors/api_smoke.mjs — the headless apispec gate lane
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN §6. Wraps the Toolchest api-smoke harness: runs ONE named
// .apispec.ts SOLO under tools/api/api_harness.config.ts (the canonical CR2-solo
// form — CLAUDE.md GATES: "serial since @a6c7ffe; CR2 solo = canonical"; the blind
// CR2 solve runs on a 90 s wall budget that parallel spec files starve). The spec
// itself asserts the SACRED numbers byte-identically (toBe / IEEE ===); this
// executor's job is to run it, read the child's verdict, and deposit a sha-keyed
// row instead of leaving the result asserts-only on stdout.
//
//   node node_modules/vitest/vitest.mjs run -c tools/api/api_harness.config.ts <spec>
//
// Outcome: child exit 0 → 'pass' (every pin held); exit != 0 → 'fail' (a pin
// broke — RED, a real regression, NEVER weakened); timeout → 'honest_timeout'
// (RED for a gate); spawn error → 'error' (RED). The vitest "Tests" summary is
// parsed for the pins-checked count (tests = spec `it` blocks, each holding many
// `expect` pins — reported as evidence, not a claim of per-pin granularity).
// ═══════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import { runToCompletion } from '../child.mjs';
import { depositRow, tail } from './common.mjs';

export const NAME = 'api_smoke';
export const iterates = 'specs';

export const DEFAULT_CONFIG = 'tools/api/api_harness.config.ts';
export const DEFAULT_SPEC = 'tools/api/solve_cr2.apispec.ts';   // canonical CR2-solo
// api_harness.config.ts sets testTimeout 300_000; give the child vitest boot +
// decode headroom on top so a slow-but-honest solve is never clipped as a timeout.
export const CHILD_TIMEOUT_MS = 420_000;

function vitestArgs(env, config, spec) {
  const vitest = path.join(env.root, 'node_modules', 'vitest', 'vitest.mjs');
  return [vitest, 'run', '-c', config, spec];
}

// Parse vitest's "Tests  N passed | M failed (T)" summary line. Honest-absent:
// null when the reporter line is not found (never fabricated).
export function parseVitestSummary(stdout) {
  const text = String(stdout ?? '');
  const line = text.split(/\r?\n/).reverse().find((l) => /^\s*Tests\s+/.test(l));
  if (!line) return { tests_passed: null, tests_failed: null };
  const passed = /(\d+)\s+passed/.exec(line);
  const failed = /(\d+)\s+failed/.exec(line);
  return {
    tests_passed: passed ? +passed[1] : (failed ? 0 : null),
    tests_failed: failed ? +failed[1] : 0,
  };
}

export async function run(scenario, env, paths, deps = {}) {
  const runChild = deps.runToCompletion ?? runToCompletion;
  const config = scenario.config ?? DEFAULT_CONFIG;
  const spec = scenario.spec ?? DEFAULT_SPEC;

  const childSpec = {
    command: deps.command ?? process.execPath,
    args: deps.args ?? vitestArgs(env, config, spec),
    cwd: env.root,
    env: { ...process.env, ...(deps.childEnv ?? {}) },
    timeoutMs: deps.timeoutMs ?? CHILD_TIMEOUT_MS,
    // captured (small): the api-smoke summary is a few KB, not a blind log.
  };
  const res = await runChild(childSpec, deps.childOpts);

  const summaryLine = parseVitestSummary(res.stdout);
  let outcome, red;
  if (res.timedOut) { outcome = 'honest_timeout'; red = true; }
  else if (res.code === 0) { outcome = 'pass'; red = false; }
  else if (res.code == null && res.error) { outcome = 'error'; red = true; }
  else { outcome = 'fail'; red = true; }

  const envelope = depositRow(paths, {
    frameSha: scenario.frameSha ?? null,
    outcome,
    fields: {
      executor: NAME, scenario_id: scenario.id ?? spec, spec, config,
      verdict: outcome,
      pins_checked: summaryLine.tests_passed,          // spec `it` blocks that held (each = many expect pins)
      tests_failed: summaryLine.tests_failed,
      child_exit: res.code, child_signal: res.signal, timed_out: res.timedOut,
      child_pid: res.pid, kill_method: res.killResult?.method ?? null,
      wall_ms: res.durationMs, child_error: res.error ?? null,
      output_tail: red ? tail(res.stdout + '\n' + res.stderr) : null,
    },
  });

  return {
    envelope, red, outcome,
    summary: `api_smoke ${spec} → ${outcome} (pins_checked=${summaryLine.tests_passed ?? '-'}) wall=${(res.durationMs / 1000).toFixed(1)}s`,
  };
}
