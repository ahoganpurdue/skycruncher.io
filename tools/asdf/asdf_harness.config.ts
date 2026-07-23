// Isolated vitest config for the ASDF real-pipeline export lane.
//
//   npx vitest run -c tools/asdf/asdf_harness.config.ts
//
// Mirrors tools/api/api_harness.config.ts: reuses the app's real vite/vitest
// config (same @/ alias + wasm plugins) but scopes to *.asdfspec.ts (a suffix
// the SACRED `npx vitest run` gate does NOT match — same proven trick as
// *.apispec.ts / *.uwspec.ts) and drops the setup mock so the REAL compiled
// wasm runs (needed to produce a byte-identical M66 receipt + science frame).
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/asdf/**/*.asdfspec.ts'],
            testTimeout: 300_000,
            hookTimeout: 300_000,
        },
    })
);

// Same mergeConfig array-concat trap as the api harness: override AFTER the
// merge so the base setup.ts (which vi.mocks wasm) is truly dropped.
(merged as any).test.setupFiles = [];

export default merged;
