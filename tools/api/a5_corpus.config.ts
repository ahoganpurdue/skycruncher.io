// Isolated vitest config for the A5 GRADED CORPUS PASS (overnight 2026-07-10).
//
//   npx vitest run -c tools/api/a5_corpus.config.ts
//
// Mirrors tools/api/api_harness.config.ts EXACTLY (real compiled wasm, no mocks)
// but scopes include to the single A5 sweep spec. DISTINCT suffix *.corpspec.ts
// so it is collected by NEITHER the sacred `npx vitest run` gate NOR the
// api-smoke (*.apispec.ts) NOR the run.mjs CLI (*.runspec.ts) — this sweep
// never pollutes any standing gate's pass/skip count.
//
// Per-test timeout is generous: the biggest DSW master is 133MB (decode +
// wasm extraction + solve), and the sweep sleeps ≥5s between frames (owner:
// "not going for time records" / box-politeness under a possible merge battery).
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/api/**/*.corpspec.ts'],
            testTimeout: 600_000,
            hookTimeout: 600_000,
            // One frame at a time in one process (sequential sweep); no parallelism.
            fileParallelism: false,
        },
    }),
);

// TRAP (see api_harness.config.ts): mergeConfig CONCATENATES arrays, so an inline
// `setupFiles: []` would KEEP base's setup.ts + its wasm mock. Override after merge
// so this harness drives the REAL compiled wasm.
(merged as any).test.setupFiles = [];

export default merged;
