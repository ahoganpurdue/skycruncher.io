// Isolated vitest config for the ultra-wide CR2 solve harness.
//
//   npx vitest run -c tools/dslr/uw_harness.config.ts
//
// Reuses the app's real vite/vitest config (same @/ alias, same wasm_compute
// mock via setup.ts — the ultra-wide path is pure TS and only needs the mock's
// gnomonic_project) but scopes the test include to *.uwspec.ts files. The suffix
// is deliberately NOT *.test.ts / *.spec.ts, so the SACRED `npx vitest run` gate
// (156 pass / 3 skip) never picks these up — this harness is opt-in only.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

export default mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/dslr/**/*.uwspec.ts'],
        },
    })
);
