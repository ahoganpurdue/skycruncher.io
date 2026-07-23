// Isolated vitest config for the iterative-BC lane's ONE live capture spec.
// Mirrors tools/api/api_harness.config.ts: reuses the app's real vite/vitest
// config (real compiled wasm, real atlas via the fs loader) but scopes include
// to *.iterbcspec.ts so the SACRED `npx vitest run` gate (which includes only
// src/engine/tests/**/*.test.ts) NEVER picks it up, and it is separate from the
// api harness set too.
//
//   npx vitest run -c tools/iterbc/iterbc.config.ts
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/iterbc/**/*.iterbcspec.ts'],
      // Full wizard run: 50MB FITS decode + wasm extraction + solve. Wall time
      // is LOAD-CONFOUNDED under a parallel build — generous ceiling.
      testTimeout: 600_000,
      hookTimeout: 600_000,
      fileParallelism: false,
    },
  }),
);

// TRAP (same as the api harness): mergeConfig CONCATENATES arrays, so an inline
// `setupFiles: []` keeps base's setup.ts (which vi.mocks wasm_compute). Override
// after the merge so this harness drives the REAL compiled wasm.
(merged as any).test.setupFiles = [];

export default merged;
