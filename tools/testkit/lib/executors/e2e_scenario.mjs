#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/executors/e2e_scenario.mjs — the browser e2e gate lane
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN §6. Wraps the SeeStar/CR2 wizard runners (tools/e2e/run_wizard_*.mjs)
// and OWNS the whole Vite dance internally, ending the manual port/prewarm/env
// juggling: it allocates a FRESH port, spawns Vite on it, curl-prewarms
// /src/main.tsx (cold start > 30 s), runs the runner against the warm server, and
// — the point of this executor — GUARANTEES both children (Vite AND the runner
// tree) are killed by their EXACT pids on EVERY exit path. That is what kills the
// leaked-vite incident class (2026-07-09 box overload from leaked agent servers).
//
// The runner script itself asserts the pinned reference solve byte-identically
// (its internal `assert`s); this executor additionally records the observed
// solve numbers and cross-checks them against the pins, then deposits a
// sha-keyed row (frame_sha = the streamed content sha of the bundled sample).
//
// Outcome: runner exit 0 + pins match → 'pass'; runner exit != 0 → 'fail' (RED —
// a byte-identity break the runner caught); pins observed ≠ pinned → 'pin_mismatch'
// (RED tripwire — should be unreachable if the runner passed); timeout →
// 'honest_timeout' (RED); missing summary → 'error_no_summary' (RED).
//
// NOTE: this executor NEVER touches the shared prewarmed Vite (3199) or the
// owner's reserved ports — it always mints its own fresh port and reaps it, so a
// worktree run serves ITS checkout (the worktree-e2e-vite-trap), never main's.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startProcess, runToCompletion } from '../child.mjs';
import { sha256Stream } from '../manifest.mjs';
import { depositRow } from './common.mjs';

export const NAME = 'e2e_scenario';
export const iterates = 'scenarios';

// Pinned reference solves (docs/GATES.md · CLAUDE.md PINNED REFERENCE SOLVES).
// Exact IEEE constants — the runner asserts these; we record + cross-check them.
export const PINS = {
  cr2: {
    runner: 'run_wizard_cr2.mjs',
    sample: 'public/demo/sample_observation.cr2',
    blindOutcome: 'solved',
    ra_hours: 17.595604137818327,
    pixel_scale: 63.439401949684004,
    matched: 79,
    confidence: 0.6785197423205406,
    budgetMs: 18 * 60 * 1000,     // runner hard-kills at 15 min; safety net above it
  },
  seestar: {
    runner: 'run_wizard_seestar.mjs',
    sample: 'Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit',
    ra_hours: 11.341253475172621,
    pixel_scale: 3.6776147325019153,
    matched: 272,
    confidence: 0.8310893541573466,
    budgetMs: 12 * 60 * 1000,
  },
};

// ── fresh free port: bind :0, read the OS-assigned port, release it ───────────
export function allocPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function probe(url, ms = 2000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

// curl prewarm: wait for Vite to answer, then force the dep-optimize by hitting
// /src/main.tsx (cold start can exceed Playwright's default goto budget).
async function defaultPrewarm(port) {
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 90; i++) { if (await probe(base, 1000)) { up = true; break; } await new Promise((r) => setTimeout(r, 1000)); }
  if (up) await fetch(`${base}/src/main.tsx`).catch(() => { });
  return up;
}

function defaultViteSpec(port, env, paths) {
  return {
    command: 'npx',
    args: ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    cwd: env.root, shell: true,
    logFile: path.join(paths.logsDir, `vite_${port}.log`),
  };
}

function defaultRunnerSpec(scenario, port, env, paths, budgetMs) {
  return {
    command: process.execPath,
    args: [path.join('tools', 'e2e', PINS[scenario].runner)],
    cwd: env.root,
    env: { ...process.env, E2E_PORT: String(port) },
    logFile: path.join(paths.logsDir, `runner_${scenario}_${port}.log`),
    timeoutMs: budgetMs,
  };
}

// Locate + read the runner's summary.json. Primary: parse the runner log for the
// "artifacts: <dir>" breadcrumb (lib.mjs finish()). Fallback: newest
// test_results/e2e/<scenario>_* dir with mtime >= run start.
function defaultReadSummary(scenario, env, t0, runnerLogPath) {
  const e2eRoot = path.join(env.root, 'test_results', 'e2e');
  let dir = null;
  try {
    const log = fs.readFileSync(runnerLogPath, 'utf8');
    const m = /artifacts:\s*(.+?)\s*$/m.exec(log);
    if (m) dir = m[1].trim();
  } catch { /* fall through to scan */ }
  if (!dir || !fs.existsSync(path.join(dir, 'summary.json'))) {
    try {
      const cands = fs.readdirSync(e2eRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith(`${scenario}_`))
        .map((e) => { const p = path.join(e2eRoot, e.name); return { p, m: fs.statSync(p).mtimeMs }; })
        .filter((c) => c.m >= t0 - 5000)
        .sort((a, b) => b.m - a.m);
      if (cands.length) dir = cands[0].p;
    } catch { /* no e2e dir */ }
  }
  if (!dir) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); }
  catch { return null; }
}

// Cross-check the observed solve against the pins (exact ===). Returns the
// per-field checks + the observed/expected records for the deposited row.
export function comparePins(scenario, summary) {
  const pin = PINS[scenario];
  const sol = summary && summary.finalSession && summary.finalSession.solution ? summary.finalSession.solution : null;
  const observed = {
    blindOutcome: summary?.blindOutcome ?? null,
    ra_hours: sol?.ra_hours ?? null,
    pixel_scale: sol?.pixel_scale ?? null,
    matched: sol?.matched ?? null,
    confidence: sol?.confidence ?? null,
    runner_pass: summary?.pass ?? null,
  };
  const checks = {};
  if (pin.blindOutcome != null) checks.blindOutcome = observed.blindOutcome === pin.blindOutcome;
  checks.ra_hours = observed.ra_hours === pin.ra_hours;
  checks.pixel_scale = observed.pixel_scale === pin.pixel_scale;
  checks.matched = observed.matched === pin.matched;
  checks.confidence = observed.confidence === pin.confidence;
  const match = Object.values(checks).every(Boolean);
  const { runner, sample, budgetMs, ...expected } = pin;
  return { match, checks, observed, expected };
}

export async function run(scenario, env, paths, deps = {}) {
  const name = scenario.scenario ?? scenario.id ?? scenario;
  if (!PINS[name]) throw new Error(`e2e_scenario: unknown scenario "${name}" (known: ${Object.keys(PINS).join(', ')})`);
  const pin = PINS[name];
  const t0 = Date.now();
  fs.mkdirSync(paths.logsDir, { recursive: true });

  const start = deps.startProcess ?? startProcess;
  const runChild = deps.runToCompletion ?? runToCompletion;
  const prewarm = deps.prewarm ?? defaultPrewarm;
  const readSummary = deps.readSummary ?? defaultReadSummary;
  const alloc = deps.allocPort ?? allocPort;
  const shaSample = deps.shaSample ?? (async (abs) => { try { return await sha256Stream(abs); } catch { return null; } });

  const port = await alloc();
  const viteSpec = (deps.buildViteSpec ?? defaultViteSpec)(port, env, paths);
  const runnerSpec = (deps.buildRunnerSpec ?? defaultRunnerSpec)(name, port, env, paths, pin.budgetMs);

  // best-effort content sha of the bundled sample → sha-keyed row (null-honest)
  const sampleAbs = path.join(env.root, pin.sample);
  const frameSha = fs.existsSync(sampleAbs) ? await shaSample(sampleAbs) : null;

  let res = null, viteUp = null, summary = null;
  const vite = start(viteSpec, deps.childOpts);        // executor-OWNED Vite — reaped in finally, ALL paths
  try {
    viteUp = await prewarm(port);
    res = await runChild(runnerSpec, deps.childOpts);   // runner tree reaped by runToCompletion on all paths
    summary = readSummary(name, env, t0, runnerSpec.logFile);
  } finally {
    vite.kill();                                        // killProcessTree(vitePid) — exact pid, EVERY path
  }

  // ── outcome classification ──────────────────────────────────────────────────
  const cmp = comparePins(name, summary);
  let outcome, red;
  if (res.timedOut) { outcome = 'honest_timeout'; red = true; }
  else if (res.code !== 0) { outcome = 'fail'; red = true; }        // runner's own byte-identity assert broke
  else if (!summary) { outcome = 'error_no_summary'; red = true; }
  else if (!cmp.match) { outcome = 'pin_mismatch'; red = true; }    // tripwire — unreachable if the runner passed
  else { outcome = 'pass'; red = false; }

  const envelope = depositRow(paths, {
    frameSha, frameShaMode: frameSha ? 'content_sha256' : undefined,
    receiptPath: null, outcome,
    fields: {
      executor: NAME, scenario: name, runner: pin.runner, port,
      verdict: outcome, pins_match: cmp.match, pin_checks: cmp.checks,
      observed: cmp.observed, expected: cmp.expected,
      vite_up: viteUp, vite_pid: vite.pid, vite_kill: vite.kill()?.method ?? null,
      runner_exit: res.code, runner_signal: res.signal, timed_out: res.timedOut,
      runner_pid: res.pid, runner_kill_method: res.killResult?.method ?? null,
      wall_ms: res.durationMs, runner_error: res.error ?? null,
      summary_present: summary != null,
    },
  });

  return {
    envelope, red, outcome,
    summary: `e2e ${name} → ${outcome} (pins_match=${cmp.match}) wall=${(res.durationMs / 1000).toFixed(1)}s`,
  };
}
