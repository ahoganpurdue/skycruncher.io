// Isolated vitest config for the tools/api `run.mjs` CLI projection wrapper.
//
//   (invoked by tools/api/run.mjs; not run directly)
//
// Mirrors tools/api/api_harness.config.ts + tools/validation/fits_binding.config.ts:
// the CLI drives the REAL narrow wizard solve (runWizardPipeline → the compiled
// wasm quad solver) headlessly, which the base wasm MOCK cannot run, so setupFiles
// is cleared AFTER the merge (mergeConfig CONCATENATES arrays — an inline
// `setupFiles: []` would silently keep base's setup.ts + its wasm mock; same trap
// the sibling configs document).
//
// DISTINCT include suffix — *.runspec.ts, collected by NEITHER the sacred
// `npx vitest run` gate (default include *.{test,spec}.ts) NOR the api-smoke gate
// (*.apispec.ts) NOR the CR2/FITS binding rails (*.uwspec.ts / *.fitspec.ts). So
// this spec never pollutes any standing gate's pass/skip count.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/api/**/*.runspec.ts'],
      // A full FITS wizard run (decode + wasm extraction + narrow solve + PSF
      // field) is minutes-scale headroom, seconds-scale typical.
      testTimeout: 360_000,
      hookTimeout: 300_000,
    },
  }),
);

// Clear the base wasm-mock setup so this harness drives the REAL compiled wasm.
(merged as any).test.setupFiles = [];

export default merged;
