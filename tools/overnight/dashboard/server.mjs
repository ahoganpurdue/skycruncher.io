// ═══════════════════════════════════════════════════════════════════════════
// OVERNIGHT RIG — dashboard backend (bare node:http; ZERO npm deps)
// ═══════════════════════════════════════════════════════════════════════════
//
// A LOCAL run-control server. It builds NO pipeline logic — it only READS
// existing artifacts and SPAWNS the existing CLI driver (run_pipeline.mjs).
// It never reimplements solve/grade/truth logic (repo LAW 4).
//
//   • frame eligibility  → reuses computePlan/DEFAULT_CONFIG from rotation.mjs
//                          + buildDumpMap/resolveDump/buildTypeMap from
//                          run_pipeline.mjs (the SAME logic the driver uses).
//   • start/stop a run   → child_process.spawn of run_pipeline.mjs --force
//                          [--frames …]; a SINGLE active child at a time.
//   • live log           → SSE stream of the child's stdout+stderr lines.
//   • review             → serves last_run_report.json (honest-absent if none).
//
// Repo-path resolution mirrors run_pipeline.mjs's HERE/ROOT pattern.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_CONFIG, computePlan, frameIdOf } from '../rotation.mjs';
import { buildDumpMap, resolveDump, buildTypeMap } from '../run_pipeline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dashboard → overnight → tools → ROOT
const ROOT = path.resolve(HERE, '..', '..', '..');
const MANIFEST = path.join(ROOT, 'test_results', 'corpus_manifest.json');
const CHECKPOINT = path.join(ROOT, 'test_results', 'overnight', 'checkpoint.json');
const REPORT = path.join(ROOT, 'test_results', 'overnight', 'last_run_report.json');
const RUN_PIPELINE_REL = 'tools/overnight/run_pipeline.mjs';
const DIST = path.join(HERE, 'dist');

const PORT = Number(process.env.RIG_PORT) || 5599;

// ── single active run + live-log state ───────────────────────────────────────
let activeChild = null;               // the running run_pipeline.mjs child, or null
let runMeta = null;                   // { pid, startedAt, frames, force }
let runBuffer = [];                   // current/last run's emitted lines (for SSE replay)
let running = false;
const sseClients = new Set();         // active SSE `res` objects

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch { /* dropped */ } }
}
function broadcastDone(code) {
  const data = `event: done\ndata: ${JSON.stringify({ code })}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch { /* dropped */ } }
}

// Split streamed chunks into whole lines, buffering any partial trailing line.
function makeLineSplitter(onLine) {
  let acc = '';
  return (chunk) => {
    acc += chunk.toString('utf8');
    let nl;
    while ((nl = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, nl).replace(/\r$/, '');
      acc = acc.slice(nl + 1);
      onLine(line);
    }
  };
}

// ── /api/frames — the eligible + skipped frames (driver's own logic) ─────────
function loadManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; }
}
function computeFrames() {
  const manifest = loadManifest();
  if (!manifest) return null;
  const dumpMap = buildDumpMap(manifest);
  const typeMap = buildTypeMap(manifest);
  const hasDump = (id) => resolveDump(id, dumpMap) != null;
  // truth_label: does the manifest carry a ground_truth block for this frame?
  const truthMap = new Map();
  for (const im of manifest.images) {
    truthMap.set(frameIdOf(im.path).toLowerCase(), !!im.ground_truth);
  }
  // artifactsPresent is irrelevant to the frame LIST (it only affects toRun);
  // pass a constant so eligibility/skip reflect dump + MP ceiling only.
  const plan = computePlan({
    manifestImages: manifest.images, checkpoint: null, config: DEFAULT_CONFIG,
    hasDump, artifactsPresent: () => false, opts: {},
  });
  const truthOf = (id) => !!truthMap.get(id.toLowerCase());
  const eligible = plan.eligible.map((e) => ({
    id: e.id, image_type: e.image_type, megapixels: e.megapixels,
    eligible: true, skip_reason: null, truth_label: truthOf(e.id),
  }));
  const skipped = plan.skipped.map((s) => ({
    id: s.id, image_type: s.image_type, megapixels: s.megapixels,
    eligible: false, skip_reason: s.skip_reason, truth_label: truthOf(s.id),
  }));
  return { frames: [...eligible, ...skipped], config_hash: plan.hash };
}

// ── run lifecycle ────────────────────────────────────────────────────────────
function startRun({ frames, force }) {
  if (running || activeChild) return { error: 'busy' };
  const args = [path.join(ROOT, RUN_PIPELINE_REL), '--force'];
  // frames === null → run the whole rotation (omit --frames). A non-empty list
  // restricts the run. Frame ids may contain spaces but never commas, so the
  // driver's `--frames a,b,c` comma-split is safe.
  if (Array.isArray(frames) && frames.length) args.push('--frames', frames.join(','));

  runBuffer = [];
  running = true;
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env } });
  activeChild = child;
  runMeta = { pid: child.pid, startedAt: new Date().toISOString(), frames: frames ?? null, force: !!force };

  const push = (line) => { runBuffer.push(line); broadcast({ line }); };
  child.stdout.on('data', makeLineSplitter(push));
  child.stderr.on('data', makeLineSplitter(push));
  child.on('error', (err) => { push(`[dashboard] spawn error: ${err.message}`); });
  child.on('close', (code) => {
    push(`[dashboard] run_pipeline exited with code ${code}`);
    running = false;
    activeChild = null;
    broadcastDone(code);
  });
  return { running: true, pid: child.pid };
}
function stopRun() {
  if (activeChild) { try { activeChild.kill('SIGTERM'); } catch { /* already gone */ } }
  // run_pipeline is checkpointed/resumable, so SIGTERM is safe. The 'close'
  // handler flips `running` + emits the done event.
  return { running: false };
}
function readJsonFile(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ── static (built frontend) ──────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.map': 'application/json' };
function serveStatic(req, res) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta charset=utf-8><title>Overnight Rig</title>' +
      '<body style="font-family:system-ui;padding:2rem"><h1>Overnight Rig — API server</h1>' +
      '<p>The frontend is not built. In dev, open the Vite URL (it proxies <code>/api</code> here). ' +
      'Or run <code>vite build</code> in the dashboard dir to serve the built app from this port.</p>');
    return;
  }
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  let filePath = path.join(DIST, urlPath);
  if (!filePath.startsWith(DIST) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html'); // SPA fallback
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ── body reader ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ── router ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/api/frames' && req.method === 'GET') {
    const data = computeFrames();
    if (!data) return sendJson(res, 200, { frames: [], error: 'manifest-absent' });
    return sendJson(res, 200, data);
  }

  if (url === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    const r = startRun({ frames: body.frames ?? null, force: body.force });
    if (r.error === 'busy') return sendJson(res, 409, { error: 'a run is already active', running: true, pid: runMeta?.pid });
    return sendJson(res, 200, r);
  }

  if (url === '/api/stop' && req.method === 'POST') {
    return sendJson(res, 200, stopRun());
  }

  if (url === '/api/run/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      running, pid: runMeta?.pid, meta: runMeta,
      checkpoint: readJsonFile(CHECKPOINT),   // honest-absent → null
    });
  }

  if (url === '/api/run/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    // replay the current/last run's buffered lines on connect
    for (const line of runBuffer) res.write(`data: ${JSON.stringify({ line })}\n\n`);
    if (!running) res.write(`event: done\ndata: ${JSON.stringify({ code: null, replay: true })}\n\n`);
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
    return;
  }

  if (url === '/api/report' && req.method === 'GET') {
    const rep = readJsonFile(REPORT);
    if (!rep) return sendJson(res, 404, { error: 'no report yet', report: null });
    return sendJson(res, 200, rep);
  }

  if (url.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });

  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`[rig] server on http://localhost:${PORT}`);
  console.log(`[rig] ROOT = ${ROOT}`);
  console.log(`[rig] manifest ${fs.existsSync(MANIFEST) ? 'present' : 'ABSENT'}`);
});

// Only auto-listen when run directly (import for tests never starts a socket).
export { computeFrames, startRun, stopRun, ROOT };

// eslint-disable-next-line no-unused-expressions
void pathToFileURL; // (kept parallel with run_pipeline's url import; harmless)
