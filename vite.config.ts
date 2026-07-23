import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
      react(),
      wasm(),
      topLevelAwait(),
      tailwindcss()
  ],
  resolve: {
    alias: {
      '@': '/src'
    }
  },
  optimizeDeps: {
    exclude: ['libraw-wasm', 'wasm_compute']
  },
  server: {
    port: 3005,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    watch: {
      // Never let chokidar descend into agent worktrees (.claude/worktrees/*
      // junction node_modules + the 338MB atlas + Sample Files — 200k+ files)
      // — traversal spins the dev server at 100% CPU and HTTP is never
      // serviced (measured 2026-07-09: LISTENING, all requests time out).
      // FUNCTION form on purpose: the glob '**/.claude/**' does NOT match the
      // bare `.claude` directory itself, so chokidar still descends into it
      // (verified by bisection: glob form wedged, watch:null served).
      // Mirrors the vitest '**/.claude/**' exclude below.
      // F6 (STARPLATES_SPEC): Rust target/ (~31k files) and gitignored
      // test_results/ (~10.6k once a starplates release is built) starve the
      // watcher the same way (measured 2026-07-09: '/' unserved at 480s).
      // Segment-exact match so paths merely containing the words don't hit.
      ignored: [(p: string) => {
        if (p.includes('.claude')) return true
        const segs = p.split(/[\\/]/)
        // 'Sample Files' is a junction to D:\AstroLogic\SampleFiles (28GB+, growing
        // with each intake set) — the watcher must never traverse through it.
        return segs.includes('target') || segs.includes('test_results') || segs.includes('Sample Files')
      }],
    }
  },
  build: {
    minify: 'esbuild',
    sourcemap: true
  },
  test: {
    environment: 'node',
    setupFiles: ['src/engine/tests/setup.ts'],
    globals: true,
    // Never sweep agent worktrees (each is a full checkout under .claude/) into
    // the test run — they duplicate every *.test.ts and blow the 156/3 gate.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  }
})

