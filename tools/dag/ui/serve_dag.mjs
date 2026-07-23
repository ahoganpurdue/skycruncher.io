#!/usr/bin/env node
// ============================================================================
// tools/dag/ui/serve_dag.mjs — interactive DAG collaboration-space server.
// House pattern: tools/theses/dashboard/serve.mjs (zero-dependency node:http,
// read-only data plane, EXACTLY ONE append-only token-gated write endpoint).
//
// Serves:
//   /                      → tools/dag/ui/ static page (this lane's front-end)
//   /data/dag_base.json    → tools/dag/dag_base.json  (extractor core, READ-ONLY
//                            to this lane — served verbatim, never regenerated here)
//   /data/enrichment.json  → tools/dag/enrich/enrichment.json (sibling lane's
//                            output). ABSENT → honest 404 with a repo-relative
//                            detail; with --fixture, the dev fixture is served
//                            INSTEAD (it self-declares {"fixture": true} and the
//                            UI renders a loud FIXTURE banner — never confusable)
//   /data/annotations.json → parsed view of test_results/dag_annotations/
//                            annotations.jsonl (absent → [], honest empty)
//   POST /api/annotate     → APPENDS one annotation line (comment | question |
//                            drawn-edge) to annotations.jsonl. Token-gated via
//                            X-Dag-Token matching test_results/dag_annotations/
//                            .dag_token (gitignored; RELOADED from the file if it
//                            already exists — never regenerated over a live one).
//                            Annotations are PRIVATE-BY-DEFAULT owner-voice:
//                            every appended record carries private:true.
//
// PUBLIC-LATER HYGIENE: no absolute path, drive letter, or box name appears in
// any HTTP response body. Filesystem locations print to the LOCAL console only.
//
// Flags:  --port <n>    default env DAG_UI_PORT or 4322
//         --host <ip>   default 127.0.0.1 (0.0.0.0 = LAN mode)
//         --fixture     serve the dev fixture when real enrichment is absent
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const UI_DIR = HERE;
const BASE_PATH = path.join(ROOT, 'tools', 'dag', 'dag_base.json');
const ENRICH_PATH = path.join(ROOT, 'tools', 'dag', 'enrich', 'enrichment.json');
// Curated step map (task #11): the COMMITTED, judgment-derived artifact rendered
// by the dual step views. READ-ONLY to this server (this lane never mutates it) —
// served verbatim, exactly like dag_base.json.
const STEPS_MAP_PATH = path.join(ROOT, 'tools', 'dag', 'steps', 'steps_map.json');
const FIXTURE_PATH = path.join(HERE, 'fixtures', 'enrichment.fixture.json');
const ANNOT_DIR = path.join(ROOT, 'test_results', 'dag_annotations');
const ANNOT_PATH = path.join(ANNOT_DIR, 'annotations.jsonl');
const TOKEN_PATH = path.join(ANNOT_DIR, '.dag_token');
// Clockdrive overlay (theses + proposals) — ported by a sibling lane into
// test_results/dag_clockdrive/. READ-ONLY to this server; merged at request time.
const CLOCKDRIVE_DIR = path.join(ROOT, 'test_results', 'dag_clockdrive');
const CLOCKDRIVE_THESES_PATH = path.join(CLOCKDRIVE_DIR, 'port_theses.json');
const CLOCKDRIVE_PROPOSALS_PATH = path.join(CLOCKDRIVE_DIR, 'port_proposals.json');

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const PORT = Number(opt('port', process.env.DAG_UI_PORT || 4322));
const HOST = String(opt('host', '127.0.0.1'));
const USE_FIXTURE = opt('fixture', false) === true;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[dag-ui] invalid --port ${opt('port', process.env.DAG_UI_PORT || 4322)}`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
function sendJson(res, status, obj) { send(res, status, JSON.stringify(obj, null, 2), MIME['.json']); }

/** Resolve a requested path INSIDE baseDir; null on traversal/escape. */
function safeJoin(baseDir, reqPath) {
  const clean = path.normalize(reqPath).replace(/^([/\\])+/, '');
  const abs = path.resolve(baseDir, clean);
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) return null;
  return abs;
}

function serveStaticFile(res, abs) {
  let body;
  try { body = fs.readFileSync(abs); } catch { sendJson(res, 404, { error: 'not found' }); return; }
  send(res, 200, body, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
}

// ---- data plane ---------------------------------------------------------------
function serveBase(res) {
  if (!fs.existsSync(BASE_PATH)) {
    // repo-relative detail only (public-later hygiene)
    sendJson(res, 404, { error: 'dag_base.json not found', detail: 'run: node tools/dag/extract_dag.mjs' });
    return;
  }
  serveStaticFile(res, BASE_PATH);
}

/** GET /data/steps_map.json — the committed curated step map, served verbatim.
 *  Absent → honest 404 with a repo-relative detail (public-later hygiene). */
function serveSteps(res) {
  if (!fs.existsSync(STEPS_MAP_PATH)) {
    sendJson(res, 404, { error: 'steps_map.json not found', detail: 'tools/dag/steps/steps_map.json is absent in this checkout — the curated step views render an honest empty state.' });
    return;
  }
  serveStaticFile(res, STEPS_MAP_PATH);
}

function serveEnrichment(res) {
  if (fs.existsSync(ENRICH_PATH)) { serveStaticFile(res, ENRICH_PATH); return; }
  if (USE_FIXTURE && fs.existsSync(FIXTURE_PATH)) { serveStaticFile(res, FIXTURE_PATH); return; }
  sendJson(res, 404, {
    error: 'enrichment not yet generated',
    detail: 'tools/dag/enrich/enrichment.json is absent — the enrichment lane has not produced output in this checkout. The UI renders base-only (all edges EXTRACTED). Start the server with --fixture to develop against the labeled dev fixture.',
  });
}

/** Parsed view of the append-only annotations ledger. Absent → [] (honest empty);
 *  corrupt lines are skipped, never fabricated. */
function serveAnnotations(res) {
  try {
    if (!fs.existsSync(ANNOT_PATH)) { sendJson(res, 200, []); return; }
    const txt = fs.readFileSync(ANNOT_PATH, 'utf8');
    const out = [];
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { /* skip corrupt/tampered line — never invent one */ }
    }
    sendJson(res, 200, out);
  } catch (err) {
    sendJson(res, 500, { error: 'could not read annotations', detail: String(err && err.message || err) });
  }
}

/** Read one ported clockdrive file → its entries array. Absent → [] (honest empty).
 *  The porter files are objects {schema_version, kind, entries:[…]}; a bare array is
 *  also accepted. Corrupt/unreadable → [] with a LOCAL-console warning (never a 500,
 *  never fabricated rows). No absolute path is ever emitted in a response body. */
function readClockdriveEntries(abs, label) {
  try {
    if (!fs.existsSync(abs)) return [];
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) return raw.entries;
    return [];
  } catch (err) {
    console.warn(`[dag-ui] clockdrive ${label} unreadable/corrupt — serving [] for it: ${err && err.message || err}`);
    return [];
  }
}

/** GET /data/clockdrive.json — merge the two ported files at request time:
 *  {theses:[…], proposals:[…]}. Either file absent ⇒ its list is []; both absent ⇒
 *  {theses:[],proposals:[]} (honest-empty, never an error). Served verbatim — the
 *  entries are already repo-relative (public-later hygiene: this server emits no
 *  absolute path, drive letter, or box name). */
function serveClockdrive(res) {
  sendJson(res, 200, {
    theses: readClockdriveEntries(CLOCKDRIVE_THESES_PATH, 'theses'),
    proposals: readClockdriveEntries(CLOCKDRIVE_PROPOSALS_PATH, 'proposals'),
  });
}

// ---- annotation write endpoint (the ONE append-only exception) -------------------
const ANNOT_KINDS = new Set(['comment', 'question', 'drawn-edge']);
const MAX_BODY = 64 * 1024;
const MAX_TEXT = 8000;

let DAG_TOKEN = null;

/** Load .dag_token, generating on first start if absent. RELOADS an existing
 *  token rather than regenerating (the owner's browser may already hold it). */
function ensureToken() {
  fs.mkdirSync(ANNOT_DIR, { recursive: true });
  if (fs.existsSync(TOKEN_PATH)) {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing) { DAG_TOKEN = existing; return { token: existing, generated: false }; }
  }
  const tok = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_PATH, tok + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch { /* best-effort on non-POSIX FS */ }
  DAG_TOKEN = tok;
  return { token: tok, generated: true };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Validate the annotation target: {node:"id"} XOR {edge:{from,to,type?}}. */
function validTarget(t) {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return false;
  const hasNode = typeof t.node === 'string' && t.node.trim() !== '' && t.node.length <= 512;
  const hasEdge = t.edge !== null && typeof t.edge === 'object' && !Array.isArray(t.edge)
    && typeof t.edge.from === 'string' && t.edge.from.trim() !== '' && t.edge.from.length <= 512
    && typeof t.edge.to === 'string' && t.edge.to.trim() !== '' && t.edge.to.length <= 512
    && (t.edge.type === undefined || (typeof t.edge.type === 'string' && t.edge.type.length <= 128));
  return (hasNode ? 1 : 0) + (hasEdge ? 1 : 0) === 1;
}

/** POST /api/annotate — token-gated, append-only. Token checked BEFORE the body. */
async function handleAnnotate(req, res) {
  const provided = req.headers['x-dag-token'];
  if (!DAG_TOKEN || typeof provided !== 'string' || provided !== DAG_TOKEN) {
    sendJson(res, 401, { error: 'missing or invalid X-Dag-Token' });
    return;
  }
  let raw;
  try { raw = await readBody(req, MAX_BODY); }
  catch (err) { sendJson(res, 400, { error: 'unreadable body', detail: String(err && err.message || err) }); return; }

  let body;
  try { body = JSON.parse(raw); }
  catch { sendJson(res, 400, { error: 'body is not valid JSON' }); return; }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'body must be a JSON object' }); return;
  }

  const kind = body.kind;
  const text = body.text;
  const author = (body.author === undefined || body.author === null) ? 'owner' : body.author;
  if (typeof kind !== 'string' || !ANNOT_KINDS.has(kind)) {
    sendJson(res, 400, { error: `kind must be one of ${[...ANNOT_KINDS].join('|')}` }); return;
  }
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT) {
    sendJson(res, 400, { error: `text must be a non-empty string ≤${MAX_TEXT} chars` }); return;
  }
  if (typeof author !== 'string' || author.length > 256) {
    sendJson(res, 400, { error: 'author must be a string (≤256 chars)' }); return;
  }
  if (!validTarget(body.target)) {
    sendJson(res, 400, { error: 'target must be exactly one of {node:"<id>"} or {edge:{from,to,type?}}' }); return;
  }
  if (kind === 'drawn-edge' && !body.target.edge) {
    sendJson(res, 400, { error: 'a drawn-edge annotation must target an edge' }); return;
  }

  const record = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    author,
    target: body.target.node ? { node: body.target.node } : { edge: { from: body.target.edge.from, to: body.target.edge.to, ...(body.target.edge.type ? { type: body.target.edge.type } : {}) } },
    kind,
    text,
    private: true, // owner-voice, private-by-default — always stamped, never client-controlled
  };
  try {
    fs.mkdirSync(ANNOT_DIR, { recursive: true });
    fs.appendFileSync(ANNOT_PATH, JSON.stringify(record) + '\n', { encoding: 'utf8' });
  } catch (err) {
    sendJson(res, 500, { error: 'append failed', detail: String(err && err.message || err) }); return;
  }
  sendJson(res, 200, { ok: true, appended: record });
}

// ---- server ------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  (async () => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = decodeURIComponent(url.pathname);

    if (req.method === 'POST') {
      if (p === '/api/annotate') { await handleAnnotate(req, res); return; }
      sendJson(res, 404, { error: 'no such write endpoint (only POST /api/annotate exists)' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'read-only server — GET/HEAD, plus append-only POST /api/annotate\n');
      return;
    }

    if (p === '/data/dag_base.json') { serveBase(res); return; }
    if (p === '/data/steps_map.json') { serveSteps(res); return; }
    if (p === '/data/enrichment.json') { serveEnrichment(res); return; }
    if (p === '/data/annotations.json') { serveAnnotations(res); return; }
    if (p === '/data/clockdrive.json') { serveClockdrive(res); return; }
    if (p.startsWith('/data/')) { sendJson(res, 404, { error: 'no such data route' }); return; }

    // static ui/ (this directory) — fixtures/ is reachable ONLY via the --fixture
    // enrichment route above, never as a static file (belt: explicit block)
    if (p.startsWith('/fixtures/')) { sendJson(res, 404, { error: 'fixtures are not served statically' }); return; }
    const rel = p === '/' ? 'index.html' : p;
    const abs = safeJoin(UI_DIR, rel);
    if (abs === null) { send(res, 404, 'not found\n'); return; }
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) { serveStaticFile(res, abs); return; }
    if (!path.extname(rel) && fs.existsSync(path.join(UI_DIR, 'index.html'))) {
      serveStaticFile(res, path.join(UI_DIR, 'index.html'));
      return;
    }
    send(res, 404, 'not found\n');
  })().catch((err) => {
    try { sendJson(res, 500, { error: 'internal error', detail: String(err && err.message || err) }); } catch { /* socket gone */ }
  });
});

let TOKEN_INFO;
try { TOKEN_INFO = ensureToken(); }
catch (err) { console.error(`[dag-ui] FATAL: could not establish write-token: ${err.message}`); process.exit(1); }

server.listen(PORT, HOST, () => {
  const urls = [`http://localhost:${PORT}/`];
  if (HOST === '0.0.0.0') {
    for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}/  (LAN via ${ifname})`);
      }
    }
    urls.push(`http://${os.hostname()}:${PORT}/  (hostname — if LAN DNS/mDNS resolves it)`);
  } else {
    urls.push(`(bound to ${HOST} — rerun with --host 0.0.0.0 for LAN mode)`);
  }
  console.log('[dag-ui] DAG collaboration space up:');
  for (const u of urls) console.log('  ' + u);
  console.log(`[dag-ui] data plane: /data/dag_base.json (verbatim tools/dag/dag_base.json — extractor core, read-only)`);
  console.log(`[dag-ui]             /data/steps_map.json (${fs.existsSync(STEPS_MAP_PATH) ? 'verbatim tools/dag/steps/steps_map.json — curated step map, read-only' : 'absent → honest 404; step views render empty'})`);
  console.log(`[dag-ui]             /data/enrichment.json (${fs.existsSync(ENRICH_PATH) ? 'REAL enrichment present' : USE_FIXTURE ? 'ABSENT → serving labeled DEV FIXTURE (--fixture)' : 'absent → honest 404; UI renders base-only'})`);
  console.log(`[dag-ui]             /data/annotations.json (parsed from annotations.jsonl; [] if none)`);
  {
    const th = fs.existsSync(CLOCKDRIVE_THESES_PATH), pr = fs.existsSync(CLOCKDRIVE_PROPOSALS_PATH);
    console.log(`[dag-ui]             /data/clockdrive.json (theses ${th ? 'present' : 'absent→[]'} · proposals ${pr ? 'present' : 'absent→[]'})`);
  }
  console.log(`[dag-ui] write plane: POST /api/annotate → APPENDS to annotations.jsonl (append-only; comment|question|drawn-edge; private-by-default)`);
  console.log(`[dag-ui] write-token (X-Dag-Token) ${TOKEN_INFO.generated ? 'NEWLY GENERATED' : 'loaded from .dag_token'}: ${TOKEN_INFO.token}`);
  console.log(`[dag-ui]   → paste once into the page's token box. Home-LAN convenience gate — NOT security-grade auth.`);
  console.log(`[dag-ui]   → token file: ${TOKEN_PATH}`);
});
server.on('error', (err) => {
  console.error(`[dag-ui] listen failed on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});
