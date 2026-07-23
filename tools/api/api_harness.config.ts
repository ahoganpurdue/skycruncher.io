// Isolated vitest config for the Toolchest API headless harness (I2.1).
//
//   npx vitest run -c tools/api/api_harness.config.ts
//
// Reuses the app's real vite/vitest config (same @/ alias, same plugins) but:
//   - scopes the include to *.apispec.ts (suffix deliberately NOT *.test.ts /
//     *.spec.ts so the SACRED `npx vitest run` gate never picks these up —
//     proven pattern: tools/dslr *.uwspec.ts), and
//   - runs with NO setup files: the sacred suite's setup
//     (src/engine/tests/setup.ts) vi.mocks wasm_compute with a pure-JS
//     stand-in; this harness exists to drive the REAL compiled wasm.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/api/**/*.apispec.ts'],
            // A full wizard run (50MB FITS decode + wasm extraction + solve)
            // is minutes-scale headroom, seconds-scale typical.
            // 480s ceiling: the rawler-arm blind budget is 360s (OWNER RULING
            // 2026-07-12, D-uw-rawler-budget-360) and the harness must never kill
            // a solve the engine still owns — blind-capable specs (confirm_calibration,
            // payoff_deepstack) legitimately grind the full budget on honest-failure
            // frames. Companion bump to the e2e step ceilings @8e67eb8.
            testTimeout: 480_000,
            hookTimeout: 480_000,
            // The blind CR2 solve runs on a 90s wall-clock budget
            // (solver_entry blindBudgetMs) — parallel spec files starve it and
            // produce false no-locks (three separate incidents 2026-07-11).
            // The full harness runs its spec FILES serially; single-spec runs
            // are unaffected.
            fileParallelism: false,
        },
    })
);

// TRAP (why this line exists): vitest's mergeConfig CONCATENATES arrays, so an
// inline `setupFiles: []` above would silently KEEP the base config's
// setup.ts (and its wasm mock). Override explicitly after the merge.
(merged as any).test.setupFiles = [];

export default merged;
