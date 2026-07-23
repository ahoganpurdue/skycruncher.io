// Isolated vitest config for the FDR-shadow capture battery (measurement-only,
// task 2026-07-12 fdr-shadow evidence). Mirrors tools/api/api_harness.config.ts
// EXACTLY (real compiled wasm, no wasm mock) but scopes the include to a bespoke
// *.capturespec.ts suffix so NEITHER the sacred `npx vitest run` gate NOR the
// api-smoke `*.apispec.ts` gate ever picks this up. Runs the REAL wizard pipeline
// in Node; the CONFIRM_FDR_SHADOW env flag is read at the confirm seam.
//
//   CONFIRM_FDR_SHADOW=1 npx vitest run -c tools/confirm/fdr_capture.config.ts
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/confirm/**/*.capturespec.ts'],
            testTimeout: 480_000,
            hookTimeout: 480_000,
            fileParallelism: false,
        },
    })
);

// TRAP (same as the api harness): mergeConfig CONCATENATES arrays, so both
// setupFiles (base's wasm-mock setup) and include must be overridden AFTER the
// merge — an inline value is silently kept alongside the base value otherwise.
(merged as any).test.setupFiles = [];
(merged as any).test.include = ['tools/confirm/**/*.capturespec.ts'];

export default merged;
