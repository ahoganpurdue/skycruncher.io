// One-shot vitest config for the color-drift per-star extractor.
//   node tools/color/color_drift_quiver.mjs   (drives BOTH arms serially)
// Mirrors spcc_cr2_approx.config.ts: real compiled wasm (base setup.ts mock
// dropped), scoped include so this NEVER enters the sacred `npx vitest run`
// gate nor the *.apispec.ts api-smoke count. Measurement only, not a gate.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/color/color_drift_extract.labspec.ts'],
            testTimeout: 900_000,
            hookTimeout: 900_000,
        },
    })
);
(merged as any).test.setupFiles = [];

export default merged;
