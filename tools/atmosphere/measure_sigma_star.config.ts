// Isolated vitest config for the tools/atmosphere `measure_sigma_star` kernel.
//
//   (invoked by tools/atmosphere/measure_sigma_star.mjs; not run directly)
//
// Mirrors tools/api/run.config.ts: the CLI drives a REAL engine forced-photometry
// measurement (imports deep_verify.forcedMeasure + AtmosphericManager/TimeService
// directly) that a plain .mjs cannot load (`@/` alias + TS). setupFiles is cleared
// AFTER the merge (mergeConfig CONCATENATES arrays — an inline `setupFiles: []` would
// silently keep base's setup.ts wasm mock). This kernel needs NO wasm (forcedMeasure
// and the alt/az math are pure TS), but the base setup is cleared for parity + speed.
//
// DISTINCT include suffix — *.runspec.ts (same as tools/api). Collected by NEITHER the
// sacred `npx vitest run` gate NOR api-smoke NOR the CR2/FITS binding rails — so this
// spec never pollutes any standing gate's pass/skip count.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/atmosphere/**/*.runspec.ts'],
      testTimeout: 360_000,
      hookTimeout: 300_000,
    },
  }),
);

// Clear the base wasm-mock setup (kernel is pure TS; no wasm boot needed).
(merged as any).test.setupFiles = [];

export default merged;
