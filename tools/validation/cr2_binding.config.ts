// Isolated vitest config for the validation harness's CR2 real-pipeline binding.
//
//   npx vitest run -c tools/validation/cr2_binding.config.ts
//
// Reuses the app's real vite/vitest config (same @/ alias, same wasm_compute
// mock via setup.ts — the ultra-wide path is pure TS and only needs the mock's
// gnomonic_project), scoped to *.uwspec.ts under tools/validation/ ONLY (so it
// does not pick up tools/dslr's uwspecs). The *.uwspec.ts suffix keeps the
// SACRED `npx vitest run` gate from ever collecting this heavy opt-in harness.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/validation/**/*.uwspec.ts'],
      // Each frame's solve runs the real anchored sweep; give the suite headroom.
      testTimeout: 360_000,
      hookTimeout: 60_000,
    },
  }),
);
