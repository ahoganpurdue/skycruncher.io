// ═══════════════════════════════════════════════════════════════════════════
// OVERNIGHT RIG — desktop app launcher
// ═══════════════════════════════════════════════════════════════════════════
// Double-clicked via "Overnight Rig.bat". It: (1) builds the UI, (2) starts the
// server that serves it on one port, (3) opens your default browser. Close the
// console window to stop the rig (the server dies with it).
//
//   node tools/overnight/dashboard/rig_app.mjs
//
// Unlike `npm run rig` (dev server + hot reload for editing), this serves the
// BUILT app on a single port — the "click-to-open" experience.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const PORT = process.env.RIG_PORT || '5599';
const DIST_INDEX = path.join(HERE, 'dist', 'index.html');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const url = `http://localhost:${PORT}`;

// 1. Build the UI fresh (so QC always sees the latest). If the build fails but a
//    previous build exists, warn and serve the stale one rather than dying.
console.log('[rig] building UI…');
const build = spawnSync(process.execPath, [VITE, 'build', '-c', 'tools/overnight/dashboard/vite.config.ts'],
  { cwd: ROOT, stdio: 'inherit' });
if (build.status !== 0) {
  if (fs.existsSync(DIST_INDEX)) {
    console.warn('[rig] ⚠ build failed — serving the previous build. Fix the errors above and relaunch for the latest.');
  } else {
    console.error('[rig] ✗ build failed and no previous build exists — cannot start. See errors above.');
    process.exit(1);
  }
}

// 2. Start the server (serves dist/ on PORT).
console.log('[rig] starting server…');
const server = spawn(process.execPath, [path.join(HERE, 'server.mjs')],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, RIG_PORT: PORT } });

// 3. Wait until it's listening, then open the browser.
(async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${url}/api/run/status`); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 300));
  }
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  console.log(`\n[rig] ✓ Overnight Rig is open at ${url}`);
  console.log('[rig]   Close this window to stop the rig.\n');
})();

server.on('close', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => { try { server.kill(); } catch { /* gone */ } process.exit(0); });
