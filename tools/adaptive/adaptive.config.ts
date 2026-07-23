// Isolated vitest config for the regime-adaptive detector SANDBOX (tools/adaptive).
//
//   npx vitest run -c tools/adaptive/adaptive.config.ts
//
// Same pattern as tools/api/api_harness.config.ts: reuse the app's real
// vite/vitest config (same @/ alias + plugins) but scope the include to a
// bespoke suffix (*.adaptivespec.ts) so the SACRED `npx vitest run` gate never
// picks these up, and run with NO setup files (the sacred setup mocks
// wasm_compute; this sandbox drives the REAL compiled wasm).
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/adaptive/**/*.adaptivespec.ts'],
            // A full wizard solve (large FITS decode + wasm + solve) is
            // minutes-scale; the knob sweeps that follow are seconds-scale.
            testTimeout: 900_000,
            hookTimeout: 900_000,
        },
    })
);

// mergeConfig CONCATENATES arrays, so setupFiles must be cleared AFTER merge
// (same trap the api harness documents) — otherwise the base wasm mock loads.
(merged as any).test.setupFiles = [];

export default merged;
