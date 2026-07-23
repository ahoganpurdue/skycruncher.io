// Isolated vitest config for the decoder-rail A/B pipeline arms (rail #14).
//
//   (invoked by tools/rawlab/ab_live.mjs; not a standing gate)
//
// Mirrors tools/api/api_harness.config.ts / tools/api/run.config.ts: drives the
// REAL wizard pipeline headlessly (real compiled wasm), so setupFiles is cleared
// AFTER the merge (mergeConfig CONCATENATES arrays — an inline `setupFiles: []`
// would silently keep base's setup.ts and its wasm mock; the documented trap).
//
// DISTINCT include suffix — *.labspec.ts — collected by NO standing gate:
// not the sacred `npx vitest run` (default *.{test,spec}.ts — 'labspec' has no
// dot before 'spec'), not api-smoke (*.apispec.ts), not the CR2/FITS rails
// (*.uwspec.ts / *.fitspec.ts), not the CLI (*.runspec.ts). The flag-ON arm
// runs ONLY through ab_live.mjs — never in gates (mission rule).
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/rawlab/**/*.labspec.ts'],
            // A CR2 wizard run on the rawler arm decodes 18.8MP and may explode
            // detections (thresholds are libraw-calibrated) — give it headroom.
            testTimeout: 900_000,
            hookTimeout: 300_000,
        },
    }),
);

// Clear the base wasm-mock setup so this harness drives the REAL compiled wasm.
(merged as any).test.setupFiles = [];

export default merged;
