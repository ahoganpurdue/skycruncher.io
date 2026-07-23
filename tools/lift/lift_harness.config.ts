// Isolated vitest config for the tools/lift lane (nebulosity-lift eyes-on + A/B
// solve specs). Mirrors tools/api/run.config.ts: the specs drive the REAL engine
// decode + wizard solve (compiled wasm), which the base wasm MOCK cannot run, so
// setupFiles is cleared AFTER the merge (mergeConfig CONCATENATES arrays — an
// inline `setupFiles: []` would silently keep base's wasm mock).
//
// DISTINCT include suffix — *.liftspec.ts, collected by NEITHER the sacred
// `npx vitest run` gate (*.{test,spec}.ts) NOR the api-smoke gate (*.apispec.ts)
// NOR the CR2/FITS rails (*.uwspec.ts / *.fitspec.ts) NOR run.mjs (*.runspec.ts).
// So these specs never pollute any standing gate's pass/skip count.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/lift/**/*.liftspec.ts'],
      // A full wide-field RAF decode + blind solve is minutes-scale (the rawler
      // blind budget is 360s); the eyes-on decode-only is seconds-scale.
      testTimeout: 600_000,
      hookTimeout: 300_000,
    },
  }),
);

// Clear the base wasm-mock setup so this harness drives the REAL compiled wasm.
(merged as any).test.setupFiles = [];

export default merged;
