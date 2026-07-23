// Isolated vitest config for tools/xtrans/*.liftspec.ts (forced-photometry CONTROL
// at a known WCS — instrument validation). Mirrors tools/lift/lift_harness.config.ts:
// the spec drives the REAL compiled wasm + fs-backed atlas, so setupFiles is cleared
// AFTER the merge (mergeConfig CONCATENATES arrays). DISTINCT include suffix so this
// never pollutes any standing gate.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/xtrans/**/*.liftspec.ts'],
      testTimeout: 600_000,
      hookTimeout: 300_000,
    },
  }),
);
(merged as any).test.setupFiles = [];
export default merged;
