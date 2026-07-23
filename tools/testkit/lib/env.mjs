#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/env.mjs — environment / platform resolution, BORN LINUX-READY
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN.md §5 Stage 12 + §6 "what breaks on Linux" annex. This module
// is THE ONLY place a Windows drive literal (`D:` / `K:`) may appear — every
// other testkit file resolves paths through resolveEnv(). The Stage-12 exit
// criterion is: `grep 'D:'/'K:' outside env.mjs → nothing`.
//
// Windows behavior stays byte-identical to tools/corpus/population_timing_run.mjs
// (the proven runner): the only visible delta is that the drive literals move
// behind env vars with documented Windows defaults. Linux support is additive —
// the same code path, with POSIX branches for kill / cpu-load / proc-count and
// no drive literals in the resolved values.
//
// EXPORTS:
//   resolveEnv(overrides?)   → resolved path/platform record (all roots)
//   killProcessTree(pid,o?)  → taskkill (win) | process.kill(-pid) group-kill (posix)
//   spawnDetachOpts(o?)      → child_process opts so posix group-kill works (detached)
//   loadProbe(o?)            → { mem_*, cpu_load_pct, node_proc_count, loadavg } — os.loadavg + win fallback
//   hostBox()                → { box, platform, arch, cpu_count }
//   splitLines(text)         → \r\n / \n robust line split (ledger/log-tail parsing)
//   forbidColdPath(env)      → throws in cloud mode if the libraw cold path is requested
//   assertLabel(label,env)   → LAW-3/annex: label required; cloud shards must be THROUGHPUT
//   WINDOWS_DEFAULTS, WORKTREE_IMAGE_RULE, VALID_LABELS  (documented constants)
// ═══════════════════════════════════════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── the ONE allowed home for a Windows drive literal ─────────────────────────
// Storage law (CLAUDE.md, owner 2026-07-10): K: is a thin VHD on a near-full C:;
// heavy artifacts live on D:. The repo root itself is derived from this module's
// location (below) so it carries NO drive literal — portable to any checkout /VM.
export const WINDOWS_DEFAULTS = Object.freeze({
  // Canonical heavy-storage root on Windows dev boxes. Samples + big test
  // artifacts default under here; overridable by env on any platform.
  HEAVY_ROOT: 'D:/AstroLogic',
});

// The worktree/VM image rule that bit three agents (CLAUDE.md infra traps): the
// two gitignored wasm pkgs must be COPIED, never junctioned, onto an isolated
// checkout or cloud shard — a junction crossing a VHD/worktree boundary silently
// breaks decode + emits phantom TS2307s. env.mjs only documents the rule (image
// build enforces it); it surfaces the resolved pkg dirs so an image builder can
// stage them as real dirs.
export const WORKTREE_IMAGE_RULE =
  'COPY (never junction) BOTH wasm_compute/pkg AND wasm_decode/pkg onto an isolated ' +
  'worktree or cloud VM image; junction node_modules + public/atlas/sectors + Sample Files.';

export const VALID_LABELS = Object.freeze(['QUIET-BASELINE', 'THROUGHPUT']);

// ── repo root: derived from module path, drive-literal-free ───────────────────
// env.mjs lives at <ROOT>/tools/testkit/lib/env.mjs → up 4 → <ROOT>.
function deriveRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));   // .../tools/testkit/lib
  return path.resolve(here, '..', '..', '..');                 // .../<ROOT>
}

/**
 * Resolve every path + platform fact the testkit needs. Pure w.r.t. its inputs:
 * reads process.env by default but every value is overridable, so tests inject a
 * synthetic environment with zero filesystem or platform coupling.
 *
 * @param {object} [overrides]
 * @param {NodeJS.ProcessEnv} [overrides.env]        source env (default process.env)
 * @param {string}  [overrides.platform]             'win32' | 'linux' | 'darwin' (default process.platform)
 * @param {string}  [overrides.root]                 repo root (default derived from module path)
 * @param {boolean} [overrides.cloud]                cloud-burst (Linux VM) mode; default from TESTKIT_CLOUD
 */
export function resolveEnv(overrides = {}) {
  const env = overrides.env ?? process.env;
  const platform = overrides.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const isLinux = platform === 'linux';
  const root = overrides.root ?? env.TESTKIT_ROOT ?? deriveRoot();
  const cloud = overrides.cloud ?? (env.TESTKIT_CLOUD === '1' || env.TESTKIT_CLOUD === 'true');

  const heavy = WINDOWS_DEFAULTS.HEAVY_ROOT;                   // drive literal — this file only
  // Samples + heavy artifacts: env first, then a Windows heavy-root default, then
  // a ROOT-relative fallback (the "Sample Files" repo junction / repo test_artifacts)
  // which is drive-literal-free and works unchanged on Linux.
  const samples = env.TESTKIT_SAMPLES
    ?? (isWindows ? `${heavy}/SampleFiles` : path.join(root, 'Sample Files'));
  const artifactRoot = env.TESTKIT_ARTIFACT_ROOT
    ?? (isWindows ? `${heavy}/test_artifacts` : path.join(root, 'test_artifacts'));

  return {
    platform, isWindows, isLinux, cloud,
    root,
    samples,
    artifactRoot,
    // ROOT-relative, portable on every platform:
    atlasRoot: env.TESTKIT_ATLAS ?? path.join(root, 'public', 'atlas', 'sectors'),
    wasmComputePkg: path.join(root, 'src', 'engine', 'wasm_compute', 'pkg'),
    wasmDecodePkg: path.join(root, 'src', 'engine', 'wasm_decode', 'pkg'),
    testResults: path.join(root, 'test_results'),
    nodeModules: path.join(root, 'node_modules'),
    // decoder arm the run is pinned to. Cloud mode forbids the libraw cold path
    // (native binding + local-only Vite worker shim don't exist headless on Linux).
    decoderColdPath: env.VITE_DECODER_RAWLER === '0',
  };
}

// ── process-group kill: platform-branched ─────────────────────────────────────
// Windows has no process groups the way POSIX does; taskkill /T walks the child
// tree. On POSIX we kill the negative pid (the group) — which REQUIRES the child
// to have been spawned detached (see spawnDetachOpts). Falls back to a plain
// single-pid kill if the group kill throws (child not a group leader).
export function killProcessTree(pid, overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  if (pid == null) return { killed: false, method: 'noop', reason: 'null pid' };
  if (platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
      return { killed: true, method: 'taskkill' };
    } catch (e) { return { killed: false, method: 'taskkill', reason: String(e && e.message) }; }
  }
  // POSIX: try the process group first (negative pid), then the bare pid.
  const killer = overrides.kill ?? process.kill.bind(process);   // injectable for tests
  try { killer(-pid, 'SIGKILL'); return { killed: true, method: 'group' }; }
  catch {
    try { killer(pid, 'SIGKILL'); return { killed: true, method: 'single' }; }
    catch (e) { return { killed: false, method: 'single', reason: String(e && e.message) }; }
  }
}

// child_process spawn opts so the POSIX group-kill above can reach the whole
// subtree. On Windows `detached` is a no-op for taskkill /T; harmless to set.
export function spawnDetachOpts(overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  return platform === 'win32' ? {} : { detached: true };
}

// ── box-load probe: os.loadavg (POSIX) with a Windows fallback ────────────────
// os.loadavg() returns [0,0,0] on Windows (Node has no Windows load average), so
// there we fall back to the PowerShell CPU-load query the proven runner uses.
export function loadProbe(overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  const runner = overrides.spawnSync ?? spawnSync;              // injectable for tests
  const total = os.totalmem(), free = os.freemem();
  const loadavg = os.loadavg();                                // [1m,5m,15m]; zeros on Windows
  let cpuLoadPct = null, nodeProcs = null;

  if (platform === 'win32') {
    try {
      const r = runner('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      nodeProcs = ((r.stdout || '').match(/"node\.exe"/g) || []).length;
    } catch {}
    try {
      const r = runner('powershell', ['-NoProfile', '-Command',
        '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'],
        { encoding: 'utf8' });
      const v = parseFloat((r.stdout || '').trim()); if (!Number.isNaN(v)) cpuLoadPct = v;
    } catch {}
  } else {
    // POSIX: load average as a fraction of core count → percent; node-proc count via ps.
    const cores = os.cpus()?.length || 1;
    if (Number.isFinite(loadavg[0])) cpuLoadPct = +(100 * loadavg[0] / cores).toFixed(1);
    try {
      const r = runner('ps', ['-e', '-o', 'comm='], { encoding: 'utf8' });
      nodeProcs = ((r.stdout || '').split(/\r?\n/).filter((l) => /(^|\/)node$/.test(l.trim()))).length;
    } catch {}
  }
  return {
    platform,
    mem_total_gb: +(total / 1e9).toFixed(2),
    mem_free_gb: +(free / 1e9).toFixed(2),
    mem_used_pct: +(100 * (1 - free / total)).toFixed(1),
    cpu_load_pct: cpuLoadPct,
    node_proc_count: nodeProcs,
    loadavg: loadavg.map((x) => +x.toFixed(2)),
  };
}

export function hostBox() {
  return { box: os.hostname(), platform: process.platform, arch: process.arch, cpu_count: os.cpus()?.length ?? null };
}

// Line-ending robust split (annex: \r\n vs \n in ledger/log-tail parsing).
export function splitLines(text) {
  if (text == null) return [];
  return String(text).split(/\r?\n/);
}

// ── cloud-mode guards (§6 annex exit criteria) ───────────────────────────────
// The libraw cold path can't run headless on Linux; a cloud run must refuse it
// rather than silently produce a guessed decoder_arm.
export function forbidColdPath(resolved) {
  if (resolved.cloud && resolved.decoderColdPath) {
    throw new Error(
      'cloud mode forbids the libraw cold path (VITE_DECODER_RAWLER=0): the native ' +
      'binding + local-only Vite worker shim do not exist headless on Linux. ' +
      'Cloud suites are rawler-only.');
  }
}

// label is REQUIRED (annex: a run without --label exits non-zero); packed-VM
// cloud shards must be THROUGHPUT (never mislabeled QUIET-BASELINE).
export function assertLabel(label, resolved) {
  if (!label) throw new Error('a run requires an explicit --label (QUIET-BASELINE | THROUGHPUT); none supplied');
  if (!VALID_LABELS.includes(label)) throw new Error(`invalid label "${label}"; expected one of ${VALID_LABELS.join(' | ')}`);
  if (resolved && resolved.cloud && label !== 'THROUGHPUT') {
    throw new Error(`cloud/packed-VM shard must be labeled THROUGHPUT, got "${label}" (concurrent shards share a box)`);
  }
  return label;
}
