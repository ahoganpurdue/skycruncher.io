// Isolated vitest config for the tools/atmosphere `fit_vertical` kernel.
//
//   (invoked by tools/atmosphere/fit_vertical.mjs; not run directly)
//
// Mirrors measure_sigma_star.config.ts: the CLI drives a REAL engine-backed fit
// (imports AtmosphericManager.computeAirMass + TimeService + the shared
// lib/star_table forcedMeasure kernel) that a plain .mjs cannot load (`@/` alias
// + TS). setupFiles is cleared AFTER the merge (mergeConfig CONCATENATES arrays —
// an inline `setupFiles: []` would silently keep base's setup.ts wasm mock). This
// kernel needs NO wasm (forcedMeasure + alt/az math + the LM/VarPro fit are pure
// TS), but the base setup is cleared for parity + speed.
//
// include is SCOPED to fit_vertical.runspec.ts specifically (NOT the broad
// **/*.runspec.ts) so this config never re-runs inc-1's heavy measurement kernel.
// Collected by NEITHER the sacred `npx vitest run` gate NOR api-smoke NOR the
// CR2/FITS rails — so this spec never pollutes any standing gate's pass/skip count.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/atmosphere/fit_vertical.runspec.ts'],
      testTimeout: 360_000,
      hookTimeout: 300_000,
    },
  }),
);

(merged as any).test.setupFiles = [];

export default merged;
