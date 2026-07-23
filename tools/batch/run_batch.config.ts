// Isolated vitest config for the tools/batch `run_batch.mjs` CLI engine.
//
//   (invoked by tools/batch/run_batch.mjs; not run directly)
//
// Mirrors tools/api/run.config.ts: the CLI drives the REAL narrow wizard solve
// (runWizardPipeline → the compiled wasm quad solver) headlessly over N files in
// ONE process, which the base wasm MOCK cannot run, so setupFiles is cleared
// AFTER the merge (mergeConfig CONCATENATES arrays — an inline `setupFiles: []`
// would silently keep base's setup.ts + its wasm mock; same trap the sibling
// api/validation configs document).
//
// DISTINCT include suffix — *.runspec.ts, collected by NEITHER the sacred
// `npx vitest run` gate (default include *.{test,spec}.ts) NOR the api-smoke gate
// (*.apispec.ts) NOR the CR2/FITS binding rails. So this spec never pollutes any
// standing gate's pass/skip count.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/batch/**/*.runspec.ts'],
            // A full batch of FITS wizard runs (decode + wasm extraction + narrow
            // solve + PSF field, ×N) is minutes-scale; give generous headroom.
            testTimeout: 1_800_000,
            hookTimeout: 300_000,
        },
    }),
);

// Clear the base wasm-mock setup so this harness drives the REAL compiled wasm.
(merged as any).test.setupFiles = [];

export default merged;
