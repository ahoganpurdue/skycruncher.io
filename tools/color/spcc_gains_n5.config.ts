// One-shot vitest config for the SPCC channel-gains N=5 calibration sweep.
//   npx vitest run -c tools/color/spcc_gains_n5.config.ts
//
// Mirrors tools/api/api_harness.config.ts (real compiled wasm, NO setup mock),
// but scopes include to *.sweepspec.ts so this NEVER enters the sacred
// `npx vitest run` gate NOR the *.apispec.ts api-smoke count. Measurement only.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/color/**/*.sweepspec.ts'],
            testTimeout: 600_000,
            hookTimeout: 600_000,
        },
    })
);
// Same mergeConfig array-concat trap as the api harness: drop the base setup.ts
// (its wasm mock) so the sweep drives the REAL wasm.
(merged as any).test.setupFiles = [];

export default merged;
