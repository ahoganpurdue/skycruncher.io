#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/child.mjs — child-process primitives with EXACT-PID cleanup
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN §5 Stage 13 / §6 executors. Every testkit executor drives a
// heavy child (vitest solve, vite+Playwright e2e, the layout battery); this is
// the ONE place that owns the "spawn → wait-with-budget → GUARANTEE the child
// tree is killed by its EXACT pid on EVERY exit path" discipline. It is the
// leaked-vite-incident killer (2026-07-09 box overload): a runner that times
// out, errors, or throws mid-parse still has its whole process tree reaped by
// pid before the executor returns.
//
// Kill mechanics are delegated to env.mjs (killProcessTree: taskkill /T on
// Windows, process-group SIGKILL on POSIX) + spawnDetachOpts (detached on POSIX
// so the group kill can reach the subtree). This module never re-implements a
// kill; it only sequences one.
//
// EXPORTS:
//   startProcess(spec, opts?)      → handle { pid, done, kill(), stdout, stderr, settled }
//                                    low-level: spawn + track; caller MUST kill().
//   runToCompletion(spec, opts?)   → MEASURED result; spawn+wait+guaranteed kill.
//   pidAlive(pid)                  → existence probe (process.kill(pid,0); EPERM=alive)
//
// spec:  { command, args?, cwd?, env?, shell?, timeoutMs?, logFile?, captureBytes? }
// opts:  { spawn?, killProcessTree?, platform? }  — all injectable for hermetic tests
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { killProcessTree as realKillTree, spawnDetachOpts } from './env.mjs';

const DEFAULT_CAPTURE_BYTES = 512 * 1024;   // cap in-memory stdout/stderr (blind logs are huge)

// Existence probe. Mirrors tools/ops/heavy_lane_lock.mjs — signal 0 never kills;
// EPERM means the pid exists but is owned by someone else (still "alive").
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ── startProcess: spawn a child, track its pid, expose an idempotent kill() ────
// stdout/stderr are streamed to spec.logFile when given (bounded memory — the
// population lesson: never buffer 28k-line blind logs), otherwise captured into
// capped in-memory buffers for the small-output lanes (golden_vector JSON,
// api_smoke summary). The returned kill() is idempotent and reaps the WHOLE tree
// by the child's exact pid.
export function startProcess(spec, opts = {}) {
  const spawnImpl = opts.spawn ?? realSpawn;
  const killTree = opts.killProcessTree ?? realKillTree;
  const platform = opts.platform ?? process.platform;
  const capBytes = spec.captureBytes ?? DEFAULT_CAPTURE_BYTES;

  let fd = null, stdio;
  if (spec.logFile) {
    fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
    fd = fs.openSync(spec.logFile, 'a');
    stdio = ['ignore', fd, fd];
  } else {
    stdio = ['ignore', 'pipe', 'pipe'];
  }

  const child = spawnImpl(spec.command, spec.args ?? [], {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    shell: !!spec.shell,
    stdio,
    ...spawnDetachOpts({ platform }),
  });

  const pid = child.pid;
  let out = '', err = '', outLen = 0, errLen = 0;
  if (!fd) {
    if (child.stdout) child.stdout.on('data', (d) => { if (outLen < capBytes) { out += d.toString(); outLen += d.length; } });
    if (child.stderr) child.stderr.on('data', (d) => { if (errLen < capBytes) { err += d.toString(); errLen += d.length; } });
  }

  let settled = false;
  let exitInfo = null;
  // Resolve on 'close' (all stdio drained), NOT 'exit' — 'exit' can fire before a
  // fast child's piped stdout is fully captured (that race truncated the golden
  // battery's JSON). 'exit' only RECORDS the code/signal; 'close' resolves; 'error'
  // (spawn failure) resolves immediately.
  const done = new Promise((res) => {
    child.on('exit', (code, signal) => { if (!exitInfo) exitInfo = { code, signal, error: null }; });
    child.on('close', (code, signal) => {
      if (!exitInfo) exitInfo = { code, signal, error: null };
      settled = true; res(exitInfo);
    });
    child.on('error', (e) => { exitInfo = { code: -1, signal: null, error: String((e && e.message) || e) }; settled = true; res(exitInfo); });
  });
  done.finally(() => { if (fd != null) { try { fs.closeSync(fd); } catch { /* already closed */ } fd = null; } });

  let killResult = null;
  const kill = () => {
    if (pid == null) return { killed: false, method: 'noop', reason: 'null pid' };
    if (killResult) return killResult;                       // idempotent — one kill per handle
    killResult = killTree(pid, { platform });
    return killResult;
  };

  return {
    pid, child, done, kill,
    get settled() { return settled; },
    get exitInfo() { return exitInfo; },
    get stdout() { return out; },
    get stderr() { return err; },
  };
}

// ── runToCompletion: spawn + wait under a wall budget; GUARANTEED tree kill ────
// Returns a MEASURED result. On timeout the child tree is killed by exact pid and
// we AWAIT its actual exit (so the caller never returns while a child lingers). A
// cleanly-exited child is NEVER re-killed (pid-reuse safety). This is the sole
// primitive the non-concurrent executors (solve_to_receipt, api_smoke,
// golden_vector, and the e2e runner leg) use.
export async function runToCompletion(spec, opts = {}) {
  const t0 = Date.now();
  const timeoutMs = spec.timeoutMs ?? opts.timeoutMs ?? 0;
  const proc = startProcess(spec, opts);

  let timedOut = false;
  let killResult = { killed: false, method: 'not-needed' };
  let timer = null;
  try {
    const waiters = [proc.done.then(() => ({ kind: 'exit' }))];
    if (timeoutMs > 0) {
      waiters.push(new Promise((res) => {
        timer = setTimeout(() => { timedOut = true; res({ kind: 'timeout' }); }, timeoutMs);
        if (timer.unref) timer.unref();
      }));
    }
    const first = await Promise.race(waiters);
    if (first.kind === 'timeout') {
      killResult = proc.kill();                              // budget exceeded → reap the tree by exact pid
      await proc.done.catch(() => { });                      // and wait for it to actually die
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (!proc.settled) killResult = proc.kill();             // stray/error path — never leak a child
  }

  const info = proc.exitInfo ?? { code: null, signal: null, error: null };
  return {
    pid: proc.pid,
    code: timedOut ? null : (info.code ?? null),
    signal: info.signal ?? null,
    timedOut,
    error: info.error ?? null,
    killResult,
    stdout: proc.stdout,
    stderr: proc.stderr,
    durationMs: Date.now() - t0,
  };
}
