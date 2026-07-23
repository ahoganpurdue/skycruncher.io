// Isolated vitest config for the ★ capture-record headless lane.
//
//   npx vitest run -c tools/capture/capture.config.ts
//
// Mirrors tools/api/api_harness.config.ts (real compiled wasm, real atlas, no
// setup mock) but scopes to *.capspec.ts so neither the sacred `npx vitest run`
// gate NOR the 13-count API smoke picks it up. This lane runs one real headless
// wizard run and writes the per-stage capture record to test_results/runs/.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/capture/**/*.capspec.ts'],
            testTimeout: 300_000,
            hookTimeout: 300_000,
        },
    })
);

// mergeConfig CONCATENATES arrays — an inline `setupFiles: []` would KEEP the
// base setup.ts (which vi.mocks wasm). Override after merge to drive REAL wasm.
(merged as any).test.setupFiles = [];

export default merged;
