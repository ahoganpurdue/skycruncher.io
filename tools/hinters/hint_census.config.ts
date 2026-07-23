// Isolated vitest config for the HINT CENSUS (tools/hinters lane, LAW 4).
//
//   npx vitest run -c tools/hinters/hint_census.config.ts
//
// Why vitest (not plain `node`): the census imports the REAL engine graph
// (OrchestratorSession → wasm → atlas, m1 metadata_reaper, the optics ladder).
// That graph uses `@/` path aliases + transitive `.ts` imports, which only the
// vite/vitest resolver + esbuild transform can load. Plain `node` type-stripping
// handles only zero-import leaf `.ts` modules (see tools/contracts note), so the
// engine-driving census MUST run under this harness — exactly like the Toolchest
// api_harness.config.ts and a5_corpus.config.ts it mirrors. The PURE scorer
// (hint_vs_truth.mjs) has no engine imports and runs under plain `node`.
//
// Mirrors api_harness.config.ts:
//   - include scoped to the census .mjs ONLY (the default `npx vitest run` gate
//     globs `**/*.{test,spec}.…` — `hint_census.mjs` carries neither infix, so
//     the SACRED unit-test gate never sweeps it up), and
//   - NO setup files: the sacred suite's setup vi.mocks wasm_compute; this
//     harness drives the REAL compiled wasm (same reason api_harness does).
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/hinters/hint_census.mjs'],
            // step1 CR2 decode (libraw) + optional semi-blind step2/step3 (wasm
            // detection + Tri-Lock) over several frames is minutes-scale headroom.
            testTimeout: 600_000,
            hookTimeout: 600_000,
        },
    })
);

// TRAP (mirrors api_harness.config.ts): vitest's mergeConfig CONCATENATES
// arrays, so an inline `setupFiles: []` would KEEP the base setup.ts (+ its wasm
// mock). Override explicitly AFTER the merge so the REAL wasm loads.
(merged as any).test.setupFiles = [];

export default merged;
