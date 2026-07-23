// Isolated vitest config — Cocoon 11-sub dither/drizzle ACCEPTANCE (2026-07-12).
//   npx vitest run -c tools/stack/cocoon_drizzle.config.ts
// Mirrors cocoon_rawler_hint.config.ts (real compiled wasm, no mocks). Includes
// ONLY the acceptance spec — never collects the gate suites. The spec itself
// sets VITE_STACK_ENABLED=1 (the flag under test) before calling runBatch.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/stack/cocoon_drizzle.acceptspec.ts'],
            testTimeout: 3_600_000,
            hookTimeout: 3_600_000,
            fileParallelism: false,
        },
    }),
);

// TRAP (see api_harness.config.ts): mergeConfig CONCATENATES arrays, so an inline
// `setupFiles: []` would KEEP base's setup.ts + its wasm mock. Override after merge
// so this harness drives the REAL compiled wasm.
(merged as any).test.setupFiles = [];

export default merged;
