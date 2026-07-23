#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// STARPLATES BENCH LAUNCHER — docs/STARPLATES_SPEC.md §9.3
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/repro/starplates_bench.mjs
//
// A plain .mjs cannot import the engine (`@/` alias + wasm boot exist only
// under the vite/vitest runtime — NEXT_MOVES §11a mechanism finding), so this
// thin launcher spawns the real benchmark runspec under vitest with its own
// isolated config (tools/repro/starplates_bench.config.ts; *.runspec.ts is
// collected by NO standing gate). Results: table on stdout +
// test_results/starplates_bench.json.
//
// First run scans gaia_vanguard_dr3.csv once (~1 min) and caches the field to
// test_results/starplates_bench_field.json.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

const res = spawnSync(process.execPath, [VITEST_BIN, 'run', '-c', 'tools/repro/starplates_bench.config.ts'], {
  cwd: ROOT, stdio: 'inherit', timeout: 900_000,
});
process.exit(res.status ?? 1);
