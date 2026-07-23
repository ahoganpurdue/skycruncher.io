// One-shot vitest config for the SPCC-approx CR2 incubator measurement.
//   node tools/color/spcc_cr2_approx.mjs   (drives BOTH arms serially)
// Mirrors spcc_gains_n5.config.ts: real compiled wasm (base setup.ts mock
// dropped), scoped include so this NEVER enters the sacred `npx vitest run`
// gate nor the *.apispec.ts api-smoke count. Measurement only, not a gate.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/color/spcc_cr2_approx.labspec.ts'],
            testTimeout: 900_000,
            hookTimeout: 900_000,
        },
    })
);
(merged as any).test.setupFiles = [];

export default merged;
