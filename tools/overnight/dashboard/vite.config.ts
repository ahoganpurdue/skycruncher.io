import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone Vite app for the Overnight Rig dashboard. Rooted at THIS dir so it
// is fully isolated from the sacred wizard app (its own index.html + src/). The
// dev server proxies /api → the bare node:http backend (server.mjs on :5599).
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 5598,
    proxy: {
      '/api': {
        target: 'http://localhost:5599',
        changeOrigin: true,
        ws: false,
        // SSE (/api/run/stream) needs an un-buffered proxy; the default http
        // proxy streams fine — just don't set a response timeout.
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
