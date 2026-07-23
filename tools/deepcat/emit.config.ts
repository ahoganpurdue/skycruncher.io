// Isolated vitest config for the deepcat receipt emitter (emit_geometry_receipts.runspec.ts).
// Mirrors tools/api/run.config.ts: drives the REAL compiled-wasm wizard solve, which
// the base wasm MOCK cannot run, so setupFiles is cleared AFTER the merge (mergeConfig
// CONCATENATES arrays — an inline `setupFiles: []` would keep base's wasm mock).
//
// DISTINCT include (*.runspec.ts under tools/deepcat) — collected by NEITHER the
// sacred `npx vitest run` gate NOR the api-smoke gate, so it never pollutes a count.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/deepcat/**/*.runspec.ts'],
            testTimeout: 360_000,
            hookTimeout: 300_000,
        },
    }),
);

(merged as any).test.setupFiles = [];

export default merged;
