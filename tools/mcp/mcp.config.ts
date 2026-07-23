// Isolated vitest config for the tools/mcp helper spec (rig_profiles pooling +
// widget inventory + single-widget SSR). Invoked by tools/mcp/server.mjs, not run
// directly.
//
// Mirrors tools/api/run.config.ts + tools/widgets/gallery.config.ts: a plain .mjs
// cannot resolve the engine `@/` alias nor transpile the widget .tsx, so the
// server spawns vitest against a *.mcpspec.ts spec (env-switched op). The DISTINCT
// suffix is collected by NEITHER the sacred `npx vitest run` gate (default
// *.{test,spec}.ts) NOR the api-smoke / binding rails — exactly as *.runspec.ts /
// *.galleryspec.ts are — so it never pollutes a standing gate's pass/skip count.
//
// The helper only React-SSRs pure widget components + reads JSON deposits (node
// env, no DOM, no wasm), so the base wasm-mock setup is cleared for a clean run.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/mcp/**/*.mcpspec.ts'],
      testTimeout: 120_000,
      hookTimeout: 60_000,
    },
  }),
);

// Clear base setup (wasm mock / globals) — the helper renders pure components +
// reads JSON only.
(merged as any).test.setupFiles = [];

export default merged;
