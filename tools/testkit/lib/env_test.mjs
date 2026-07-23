#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/env_test.mjs — self-test for env.mjs (Linux-ready resolution)
// ═══════════════════════════════════════════════════════════════════════════
// Plain-assert, vitest-free, node-runnable (`_test.mjs` underscore). Synthetic
// env/platform overrides — no real filesystem or platform coupling.
//   node tools/testkit/lib/env_test.mjs
// Covers: resolveEnv drive-literal-free on Linux + env overrides win · the
// "no drive literal outside env.mjs" exit criterion (greps the sibling sources) ·
// killProcessTree platform branches (injected kill) · loadProbe (injected
// spawnSync, posix loadavg path) · splitLines · assertLabel / forbidColdPath /
// spawnDetachOpts guards.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveEnv, killProcessTree, spawnDetachOpts, loadProbe, splitLines,
  forbidColdPath, assertLabel, VALID_LABELS, WINDOWS_DEFAULTS,
} from './env.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function throws(fn, msg) { let t = false; try { fn(); } catch { t = true; } ok(t, msg); }

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ── (1) resolveEnv: Linux resolution is drive-literal-free ───────────────────
{
  const linux = resolveEnv({ platform: 'linux', env: {}, root: '/srv/astro' });
  const slash = (s) => String(s).replace(/\\/g, '/');   // path.join uses the HOST separator; compare separator-agnostically
  eq(linux.isLinux, true, 'linux platform detected');
  eq(slash(linux.samples), '/srv/astro/Sample Files', 'linux samples default = ROOT/Sample Files (no drive literal)');
  eq(slash(linux.artifactRoot), '/srv/astro/test_artifacts', 'linux artifact root = ROOT/test_artifacts');
  ok(!/[A-Z]:/.test(JSON.stringify(linux)), 'no Windows drive literal anywhere in resolved linux env');

  const win = resolveEnv({ platform: 'win32', env: {}, root: 'C:/repo' });
  ok(win.samples.startsWith(WINDOWS_DEFAULTS.HEAVY_ROOT), 'windows samples default under the heavy-root constant');
  eq(win.artifactRoot, `${WINDOWS_DEFAULTS.HEAVY_ROOT}/test_artifacts`, 'windows artifact root = heavy-root/test_artifacts');

  // env overrides beat platform defaults, on any platform
  const ov = resolveEnv({ platform: 'linux', root: '/r', env: { TESTKIT_SAMPLES: '/mnt/frames', TESTKIT_ARTIFACT_ROOT: '/mnt/art', TESTKIT_CLOUD: '1' } });
  eq(ov.samples, '/mnt/frames', 'TESTKIT_SAMPLES override wins');
  eq(ov.artifactRoot, '/mnt/art', 'TESTKIT_ARTIFACT_ROOT override wins');
  eq(ov.cloud, true, 'TESTKIT_CLOUD=1 → cloud mode');
  // wasm pkg dirs are ROOT-relative (image builder stages them as COPIES)
  ok(ov.wasmComputePkg.includes('wasm_compute') && ov.wasmDecodePkg.includes('wasm_decode'), 'both wasm pkg dirs surfaced');
}

// ── (2) exit criterion as code: no drive literal outside env.mjs ─────────────
{
  const siblings = ['manifest.mjs', 'env.mjs'];   // lib/
  const upstream = ['run.mjs', 'validate_population.mjs']; // testkit/
  const suites = fs.readdirSync(path.join(DIR, '..', 'suites')).filter((f) => f.endsWith('.suite.json'));
  const driveRe = /[A-Za-z]:[\/\\]/;              // D:/… or K:\… anywhere (prod code + shipped config)
  let offenders = [];
  for (const f of siblings) { const src = fs.readFileSync(path.join(DIR, f), 'utf8'); if (f !== 'env.mjs' && driveRe.test(src)) offenders.push('lib/' + f); }
  for (const f of upstream) { const src = fs.readFileSync(path.join(DIR, '..', f), 'utf8'); if (driveRe.test(src)) offenders.push(f); }
  for (const f of suites) { const src = fs.readFileSync(path.join(DIR, '..', 'suites', f), 'utf8'); if (driveRe.test(src)) offenders.push('suites/' + f); }
  eq(offenders, [], 'zero drive literals outside env.mjs — prod modules + shipped suites (Stage-12 grep exit criterion, as code)');
}

// ── (3) killProcessTree: platform branches ───────────────────────────────────
{
  eq(killProcessTree(null).method, 'noop', 'null pid → noop');
  // posix: group kill succeeds → method group
  const grp = killProcessTree(1234, { platform: 'linux', kill: (pid) => { if (pid > 0) throw new Error('should try group first'); } });
  eq(grp.method, 'group', 'posix group kill (negative pid) attempted first');
  // posix: group kill throws, single succeeds → method single
  const single = killProcessTree(1234, { platform: 'linux', kill: (pid) => { if (pid < 0) throw new Error('no group'); } });
  eq(single.method, 'single', 'posix falls back to single-pid kill');
  eq(spawnDetachOpts({ platform: 'linux' }).detached, true, 'posix spawn opts detached (group-kill reachable)');
  eq(spawnDetachOpts({ platform: 'win32' }).detached, undefined, 'windows spawn opts not detached (taskkill /T walks tree)');
}

// ── (4) loadProbe: posix loadavg path with injected spawnSync ────────────────
{
  const fakePs = () => ({ stdout: 'node\nbash\nnode\n/usr/bin/node\nchrome\n' });
  const p = loadProbe({ platform: 'linux', spawnSync: fakePs });
  eq(p.platform, 'linux', 'loadProbe platform');
  ok(Array.isArray(p.loadavg) && p.loadavg.length === 3, 'loadProbe returns [1m,5m,15m] loadavg');
  ok(typeof p.mem_used_pct === 'number', 'loadProbe mem_used_pct numeric');
  eq(p.node_proc_count, 3, 'loadProbe counts node procs from ps (node, node, /usr/bin/node)');
}

// ── (5) splitLines robustness (\r\n vs \n) ───────────────────────────────────
{
  eq(splitLines('a\r\nb\nc'), ['a', 'b', 'c'], 'splitLines handles mixed CRLF/LF');
  eq(splitLines(''), [''], 'splitLines empty string');
  eq(splitLines(null), [], 'splitLines null → empty array');
}

// ── (6) label + cloud guards ─────────────────────────────────────────────────
{
  eq(assertLabel('QUIET-BASELINE', resolveEnv({ platform: 'win32', env: {} })), 'QUIET-BASELINE', 'valid label passes');
  throws(() => assertLabel(null, resolveEnv({ env: {} })), 'missing label → throws (annex: run without --label exits non-zero)');
  throws(() => assertLabel('WHATEVER', resolveEnv({ env: {} })), 'invalid label → throws');
  const cloud = resolveEnv({ platform: 'linux', env: { TESTKIT_CLOUD: '1' }, root: '/r' });
  throws(() => assertLabel('QUIET-BASELINE', cloud), 'cloud shard must be THROUGHPUT, not QUIET-BASELINE');
  eq(assertLabel('THROUGHPUT', cloud), 'THROUGHPUT', 'cloud shard accepts THROUGHPUT');
  ok(VALID_LABELS.includes('THROUGHPUT') && VALID_LABELS.includes('QUIET-BASELINE'), 'VALID_LABELS complete');
  // cold path forbidden in cloud
  const coldCloud = resolveEnv({ platform: 'linux', env: { TESTKIT_CLOUD: '1', VITE_DECODER_RAWLER: '0' }, root: '/r' });
  throws(() => forbidColdPath(coldCloud), 'cloud + libraw cold path → throws (rawler-only on Linux)');
  const warmCloud = resolveEnv({ platform: 'linux', env: { TESTKIT_CLOUD: '1' }, root: '/r' });
  forbidColdPath(warmCloud); ok(true, 'cloud + rawler (default) → allowed');
}

console.log(`\nenv self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
