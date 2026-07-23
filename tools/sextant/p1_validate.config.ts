// Isolated vitest config for the tools/sextant `p1_validate` kernel.
//
//   (invoked by tools/sextant/p1_validate.mjs; not run directly)
//
// Mirrors tools/atmosphere/measure_sigma_star.config.ts. The P1 composition kernel
// imports the engine's spherical-astronomy TS (TimeService / OpticsManager /
// AtmosphericManager) that a plain .mjs cannot resolve (`@/`-adjacent relative TS).
// The kernel needs NO wasm — the base setup.ts wasm mock is cleared AFTER the merge
// (mergeConfig CONCATENATES arrays, so an inline `setupFiles: []` would silently keep
// base's setup). DISTINCT suffix *.runspec.ts — collected by NEITHER the standing
// `npx vitest run` gate NOR api-smoke, so this spec never pollutes a gate pass/skip count.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/sextant/**/*.runspec.ts'],
      testTimeout: 120_000,
      hookTimeout: 60_000,
    },
  }),
);

// Clear the base wasm-mock setup (kernel is pure TS; no wasm boot needed).
(merged as any).test.setupFiles = [];

export default merged;
