// Isolated vitest config for the validation harness's FITS real-pipeline binding.
//
//   npx vitest run -c tools/validation/fits_binding.config.ts
//
// Mirrors tools/api/api_harness.config.ts (NOT cr2_binding.config.ts) because the
// FITS rail drives the REAL narrow wizard solve (runWizardPipeline → the compiled
// wasm quad solver), which the CR2 UW binding's wasm_compute MOCK cannot run. Two
// deliberate departures from cr2_binding.config.ts:
//   1. REAL wasm — setupFiles is cleared AFTER the merge (mergeConfig CONCATENATES
//      arrays, so an inline `setupFiles: []` would silently keep base's setup.ts +
//      its wasm mock — same trap api_harness.config.ts documents).
//   2. A DISTINCT include suffix — *.fitspec.ts, NOT *.uwspec.ts. cr2_binding.config
//      globs `tools/validation/**/*.uwspec.ts`; a FITS spec under that suffix would
//      be collected by the CR2 rail too and run under the wrong (mock) wasm config,
//      breaking it. *.fitspec.ts is collected by NEITHER the CR2 rail NOR the sacred
//      `npx vitest run` gate (whose default include is *.{test,spec}.ts).
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/validation/**/*.fitspec.ts'],
      // A full FITS wizard run (decode + wasm extraction + narrow solve + PSF field)
      // is minutes-scale headroom, seconds-scale typical — same envelope as the API harness.
      testTimeout: 360_000,
      hookTimeout: 300_000,
    },
  }),
);

// Clear the base wasm-mock setup so this harness drives the REAL compiled wasm.
(merged as any).test.setupFiles = [];

export default merged;
