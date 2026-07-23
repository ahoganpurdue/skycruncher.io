// Isolated vitest config for the recal per-detection DUMP producer (rail #14).
//
//   (invoked by tools/recal/dump_detections.mjs; NOT a standing gate)
//
// Mirrors tools/rawlab/ab_pipeline.config.ts: drives the REAL wizard pipeline
// headlessly (real compiled wasm), so setupFiles is cleared AFTER the merge
// (mergeConfig CONCATENATES arrays — an inline `setupFiles: []` would silently
// keep base's setup.ts and its wasm mock; the documented trap).
//
// DISTINCT include suffix — *.labspec.ts — collected by NO standing gate: not the
// sacred `npx vitest run` (default *.{test,spec}.ts), not api-smoke (*.apispec.ts),
// not the CR2/FITS rails (*.uwspec.ts / *.fitspec.ts). The rawler-arm dump runs
// ONLY through dump_detections.mjs — never in a gate (flag never leaks).
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/recal/**/*.labspec.ts'],
            // A full-frame RAW decode + m4 detection on the artifact-free rawler
            // grid may surface many detections — give it headroom.
            testTimeout: 900_000,
            hookTimeout: 300_000,
        },
    }),
);

// Clear the base wasm-mock setup so this harness drives the REAL compiled wasm.
(merged as any).test.setupFiles = [];

export default merged;
