// Isolated vitest config for the one-shot widget review gallery generator.
//
//   (invoked by tools/widgets/build_gallery.mjs; not run directly)
//
// Mirrors tools/api/run.config.ts: a plain .mjs cannot resolve the engine's `@/`
// alias nor transpile the widget .tsx components, so the gallery is rendered
// under vitest (which carries vite's React plugin + alias) via a distinct
// *.galleryspec.ts suffix collected by NEITHER the sacred `npx vitest run` gate
// (default *.{test,spec}.ts) NOR any api/binding rail — so it never pollutes a
// standing gate's pass/skip count.
//
// The gallery only React-SSRs pure widget components (react-dom/server, node
// env, no DOM, no wasm), so the base wasm-mock setup is cleared for a clean run.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
    base,
    defineConfig({
        test: {
            include: ['tools/widgets/**/*.galleryspec.ts'],
            testTimeout: 120_000,
            hookTimeout: 60_000,
        },
    }),
);

// Clear base setup (wasm mock / globals) — the gallery renders pure components only.
(merged as any).test.setupFiles = [];

export default merged;
