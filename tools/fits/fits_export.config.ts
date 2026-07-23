// Isolated vitest config for the FITS conformance-fixture generator
// (tools/fits/build_conformance_fixtures.runspec.ts).
//
// Mirrors tools/api/run.config.ts: the runspec drives the REAL engine
// (SkyTransform → compiled wasm inverse-gnomonic) to produce the engine-forward
// truth, which the base wasm MOCK cannot compute — so setupFiles is cleared AFTER
// the merge (mergeConfig CONCATENATES arrays; an inline `setupFiles: []` would
// silently keep base's wasm mock, the trap the sibling configs document).
//
// DISTINCT *.runspec.ts include collected by NEITHER the sacred `npx vitest run`
// gate NOR the api-smoke / binding rails — never pollutes a standing gate count.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/fits/**/*.runspec.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  }),
);

// Clear the base wasm-mock setup so this harness drives the REAL compiled wasm.
(merged as any).test.setupFiles = [];

export default merged;
