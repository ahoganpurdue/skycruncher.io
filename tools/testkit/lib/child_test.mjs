#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/child_test.mjs — self-test for the child-process primitives
// ═══════════════════════════════════════════════════════════════════════════
// Plain-assert, vitest-free, node-runnable (`_test.mjs` underscore so the vitest
// default include never sweeps it). Spawns REAL trivial `node -e` children — the
// exact "mocked child" the executors drive — and asserts the load-bearing
// discipline: exit-code propagation, stdout capture, and (the leaked-process
// killer) EXACT-PID cleanup on the timeout path.
//   node tools/testkit/lib/child_test.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { runToCompletion, startProcess, pidAlive } from './child.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(Object.is(a, b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── (1) clean exit: code 0 propagates, child is dead afterwards, no kill needed ─
{
  const res = await runToCompletion({ command: NODE, args: ['-e', 'process.exit(0)'], timeoutMs: 10_000 });
  eq(res.code, 0, 'clean child → exit code 0 propagated');
  eq(res.timedOut, false, 'clean child not flagged timed out');
  ok(!pidAlive(res.pid), 'clean child pid is dead after return');
  eq(res.killResult.method, 'not-needed', 'clean child never force-killed (pid-reuse safety)');
}

// ── (2) exit-code propagation: a nonzero child surfaces its code (never swallowed) ─
{
  const res = await runToCompletion({ command: NODE, args: ['-e', 'process.exit(3)'], timeoutMs: 10_000 });
  eq(res.code, 3, 'nonzero child → exit code 3 propagated (not swallowed)');
  eq(res.timedOut, false, 'nonzero child not a timeout');
  ok(!pidAlive(res.pid), 'nonzero child pid dead after return');
}

// ── (3) stdout capture (small-output lanes: golden_vector JSON / api summary) ───
{
  const res = await runToCompletion({ command: NODE, args: ['-e', 'console.log("PING-42")'], timeoutMs: 10_000 });
  eq(res.code, 0, 'echo child exit 0');
  ok(/PING-42/.test(res.stdout), 'stdout captured from a piped child');
}

// ── (4) THE LEAKED-PROCESS KILLER: a runaway child is killed by exact pid on
//        timeout, and is provably dead when runToCompletion returns ─────────────
{
  const t0 = Date.now();
  const res = await runToCompletion({ command: NODE, args: ['-e', 'setInterval(()=>{}, 1000)'], timeoutMs: 600 });
  eq(res.timedOut, true, 'runaway child flagged timed out');
  ok(res.code == null, 'timed-out child reports null exit code (killed, not self-exited)');
  ok(res.killResult && res.killResult.killed !== false, 'timeout path issued a tree kill');
  ok(!pidAlive(res.pid), 'runaway child pid is DEAD after return (exact-pid cleanup)');
  ok(Date.now() - t0 < 30_000, 'timeout path returns promptly (did not hang on the runaway)');
}

// ── (5) startProcess.kill() is idempotent + reaps by exact pid ─────────────────
{
  const proc = startProcess({ command: NODE, args: ['-e', 'setInterval(()=>{}, 1000)'] });
  ok(Number.isInteger(proc.pid) && proc.pid > 0, 'startProcess exposes a real pid');
  const k1 = proc.kill();
  const k2 = proc.kill();
  ok(k1 === k2, 'kill() is idempotent (same result object on repeat)');
  await proc.done.catch(() => { });
  await sleep(50);
  ok(!pidAlive(proc.pid), 'killed process is dead');
}

// ── (6) null pid → noop (defensive) ────────────────────────────────────────────
{
  eq(pidAlive(null), false, 'pidAlive(null) = false');
  eq(pidAlive(-1), false, 'pidAlive(-1) = false');
}

console.log(`\nchild self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
