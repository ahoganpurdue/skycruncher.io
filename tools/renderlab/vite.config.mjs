// renderlab vite config — scoped to tools/renderlab ONLY (LAW 4 incubator:
// nothing in src/ imports this lab; this config never touches the app's vite setup).
//
// Data serving: the page fetches /t0/allsky.arrow at runtime. We resolve the
// blob directory in order:
//   1. tools/renderlab/data/            — owner-provided copy/symlink of a
//      starplate release folder (see README "Data" section)
//   2. src-tauri/resources/starplates/starplates-2026.07-gdr3/
//      — the bundled T0 seed committed to the repo (works out of the box)
// Whichever wins becomes vite's publicDir, so /t0/allsky.arrow (and
// /manifest.json) are served from its root. publicDir is chosen at server
// start — restart the dev server after creating tools/renderlab/data/.
//
// Port: 3007 strict. NEVER 3005 — that is the owner's protected instance.

import { defineConfig } from 'vite';
import { existsSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const localData = path.join(here, 'data');
const seededRelease = path.join(
  repoRoot, 'src-tauri', 'resources', 'starplates', 'starplates-2026.07-gdr3',
);

const publicDir = existsSync(path.join(localData, 't0', 'allsky.arrow'))
  ? localData
  : seededRelease;

// CASCADE receipt: the demo fetches /receipt.json. When the starplate blob is
// absent, publicDir stays on the seeded release and an owner-provided
// data/receipt.json would be unreachable — so a tiny middleware serves it
// directly. Existence is checked PER REQUEST: dropping the file in needs a
// page reload, not a server restart. No file => 404 => the demo renders its
// honest-absent state (LAW 3). Never bundle or synthesize a receipt.
const receiptFile = path.join(localData, 'receipt.json');
const receiptPlugin = {
  name: 'renderlab-receipt',
  configureServer(server) {
    server.middlewares.use('/receipt.json', (req, res, next) => {
      if (!existsSync(receiptFile)) { next(); return; }
      res.setHeader('Content-Type', 'application/json');
      createReadStream(receiptFile).pipe(res);
    });
  },
};

export default defineConfig({
  // root is tools/renderlab (passed on the CLI); publicDir may live outside it.
  publicDir,
  plugins: [receiptPlugin],
  // Keep vite's dep-optimizer cache out of the lab folder (no node_modules here;
  // apache-arrow resolves from the repo root's node_modules).
  cacheDir: path.join(repoRoot, 'node_modules', '.vite-renderlab'),
  server: {
    port: 3007,
    strictPort: true,
    fs: {
      // Allow imports (apache-arrow) from the repo root's node_modules.
      allow: [repoRoot],
    },
  },
  optimizeDeps: {
    include: ['apache-arrow'],
  },
});
