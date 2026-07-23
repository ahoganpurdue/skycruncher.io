// Isolated vitest config for the ENH-2 gauntlet forced-photometry escalation
// experiment. Includes ONLY gauntlet_escalation.uwspec.ts so it does NOT collect
// the concurrent agent's cr2_binding.uwspec.ts (mid-finalize) nor the SACRED
// `npx vitest run` gate. Reuses the app's real vite/vitest config (same @/ alias,
// same wasm_compute mock via setup.ts — the UW path only needs gnomonic_project).
//
//   SOLVER_UW_ANCHOR_CANDIDATES=3 LUM_DIR=<...> OUTDIR=<...> \
//     npx vitest run -c tools/validation/gauntlet_escalation.config.ts
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/validation/gauntlet_escalation.uwspec.ts'],
      testTimeout: 360_000,
      hookTimeout: 60_000,
    },
  }),
);
