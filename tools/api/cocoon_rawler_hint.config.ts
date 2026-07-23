// Isolated vitest config — cocoon rawler-ON confirmation (2026-07-11).
//   VITE_DECODER_RAWLER=1 npx vitest run -c tools/api/cocoon_rawler_hint.config.ts
// Mirrors a5_corpus.config.ts (real compiled wasm, no mocks) but includes ONLY
// the single cocoon confirmation spec — never collects the a5 sweep or any gate.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/api/cocoon_rawler_hint.corpspec.ts'],
            // 11-frame HINTED-COCOON sweep runs in one it(); infra margin so a single
            // slow decode/solve never truncates the sweep (per-frame appends survive
            // regardless). Not a solver param — pure test-harness timeout.
            testTimeout: 1_800_000,
            hookTimeout: 1_800_000,
            fileParallelism: false,
        },
    }),
);

// TRAP (see api_harness.config.ts): mergeConfig CONCATENATES arrays, so an inline
// `setupFiles: []` would KEEP base's setup.ts + its wasm mock. Override after merge
// so this harness drives the REAL compiled wasm.
(merged as any).test.setupFiles = [];

export default merged;
