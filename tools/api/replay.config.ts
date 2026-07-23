// Isolated vitest config for the seam-replay driver (SEAM_CONTRACT v1 §5).
//
//   (invoked by tools/testkit/lib/executors/stage_replay.mjs; not run directly)
//
// Mirrors tools/api/run.config.ts: the replay driver runs REAL engine stage
// functions (.ts, `@/` alias, and for psf_field the compiled wasm
// refine_stars_lm), which a plain .mjs cannot host — so the stage_replay
// executor spawns vitest against THIS config, threading the stage + capsule
// dirs via env vars (SEAM_REPLAY_STAGE / SEAM_REPLAY_INPUT_DIR /
// SEAM_REPLAY_OUT_DIR).
//
// DISTINCT include suffix — *.replayspec.ts, collected by NEITHER the sacred
// `npx vitest run` gate (*.{test,spec}.ts) NOR the api-smoke gate (*.apispec.ts)
// NOR run.mjs's *.runspec.ts NOR the CR2/FITS rails (*.uwspec.ts/*.fitspec.ts).
// This driver never pollutes any standing gate's pass/skip count.
import base from '../../vite.config';
import { mergeConfig, defineConfig } from 'vitest/config';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tools/api/**/*.replayspec.ts'],
      // One stage replay is seconds-scale typical; wasm boot + a large capsule
      // load (72MB extract-class buffers) gets minutes-scale headroom.
      testTimeout: 240_000,
      hookTimeout: 120_000,
    },
  }),
);

// TRAP (same as the sibling configs): vitest's mergeConfig CONCATENATES arrays,
// so an inline `setupFiles: []` above would silently KEEP the base config's
// setup.ts (and its wasm mock). Override explicitly after the merge — this
// driver needs the REAL compiled wasm (psf_field → refine_stars_lm).
(merged as any).test.setupFiles = [];

export default merged;
