// Isolated vitest config for the starplates §9.3 benchmark runspec.
//
//   (invoked by tools/repro/starplates_bench.mjs; not run directly)
//
// Mirrors tools/api/run.config.ts (the NEXT_MOVES §11a idiom): a plain .mjs
// cannot import the engine (`@/` alias + wasm boot exist only under the
// vite/vitest runtime), so the launcher spawns THIS config. The *.runspec.ts
// suffix keeps the benchmark out of every standing gate (sacred vitest run,
// api-smoke, uw/fits rails).
//
// pool: forks + --expose-gc so the benchmark can stabilize the heap between
// lanes and report allocation deltas honestly (global.gc available).
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/repro/**/*.runspec.ts'],
      // First run scans the 345 MB Gaia CSV once (cached thereafter).
      testTimeout: 600_000,
      hookTimeout: 600_000,
      pool: 'forks',
      // Vitest 4: pool options are top-level (poolOptions was removed).
      execArgv: ['--expose-gc'],
    },
  }),
);

// Clear the base wasm-mock setup so this harness drives the REAL compiled wasm
// (mergeConfig CONCATENATES arrays — same trap the sibling configs document).
(merged as any).test.setupFiles = [];

export default merged;
