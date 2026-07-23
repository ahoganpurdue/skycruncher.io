import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    extends: 'vite.config.ts',
    test: {
      name: 'node-suite',
      environment: 'node',
      setupFiles: ['src/engine/tests/setup.ts'],
      include: ['src/engine/tests/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/ephemeris.test.ts'],
    }
  },
  {
    extends: 'vite.config.ts',
    test: {
      name: 'browser-wasm-suite',
      include: ['**/ephemeris.test.ts'],
      browser: {
        enabled: true,
        name: 'chromium',
        provider: 'playwright',
        headless: true,
      }
    }
  }
])
