// ═══════════════════════════════════════════════════════════════════════════
// OVERNIGHT RIG — launcher (no `concurrently` dep; bare child_process)
// ═══════════════════════════════════════════════════════════════════════════
// Starts BOTH: the bare node:http backend (server.mjs :5599) and the Vite dev
// server (which serves the React app + proxies /api → the backend). Prints the
// URL to open. Ctrl-C tears both down.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const isWin = process.platform === 'win32';

function launch(label, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: opts.cwd ?? HERE, stdio: 'inherit', shell: opts.shell ?? false, env: process.env });
  child.on('exit', (code) => {
    console.log(`[rig] ${label} exited (${code}) — shutting down.`);
    shutdown();
  });
  return child;
}

const children = [];
function shutdown() {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[rig] starting backend (server.mjs :5599) + Vite dev server…');

// backend
children.push(launch('server', process.execPath, [path.join(HERE, 'server.mjs')], { cwd: ROOT }));

// vite dev server — resolve the local vite binary; shell:true on Windows for .cmd
const viteBin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite');
children.push(launch('vite', viteBin, ['--config', path.join(HERE, 'vite.config.ts')], { cwd: HERE, shell: isWin }));

console.log('\n[rig] ─────────────────────────────────────────────');
console.log('[rig]  Open:  http://localhost:5598');
console.log('[rig]  API :  http://localhost:5599  (proxied via /api)');
console.log('[rig] ─────────────────────────────────────────────\n');
