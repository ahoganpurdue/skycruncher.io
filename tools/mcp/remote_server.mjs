#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// REMOTE MCP TRANSPORT — Streamable HTTP wrapper over the SAME tool registry
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/mcp/remote_server.mjs           (serves MCP over HTTP on localhost)
//
// PURPOSE
//   Make the local stdio MCP server (tools/mcp/server.mjs) reachable as a
//   claude.ai CUSTOM CONNECTOR. claude.ai speaks the MCP "Streamable HTTP"
//   transport (single endpoint, POST/GET/DELETE) and authenticates a custom
//   remote server via one of: OAuth 2.1 + DCR, a STATIC bearer/API-key header
//   (`static_headers`), or `none`.
//
// AUTH — TWO ACCEPTED CREDENTIALS (owner ruling D-mcp-access-trust-mode, 2026-07-16)
//   The origin sits behind a Cloudflare Access app (owner-only email policy,
//   Managed OAuth ON) at mcp.skycruncher.io. claude.ai authenticates to Access
//   over OAuth and forwards a `Cf-Access-Jwt-Assertion` header (RS256 JWT signed
//   by the team's Access keys) — it CANNOT send our static bearer. So a request
//   is authorized if EITHER:
//     (a) the STATIC bearer matches (retained as an ALTERNATE credential — the
//         path a local/CLI client or a curl probe uses), OR
//     (b) a Cloudflare Access JWT (header or `CF_Authorization` cookie) verifies
//         via tools/mcp/access_jwt.mjs (RS256 · iss · exp/nbf · email allowlist ·
//         pinned aud when known).
//   This "access" mode is the DEFAULT. Set REMOTE_MCP_AUTH=bearer to revert to
//   the BEARER-ONLY cold path (Access-JWT disabled — for local/tunnel-less runs).
//   (OAuth 2.1 DCR is the production upgrade; it needs a real authorization
//   server + the name-pivot domain — see docs/local/REMOTE_CONNECTOR_RUNBOOK.md.)
//
// DESIGN INVARIANTS
//   • ADDITIVE: imports server.mjs's registry/dispatch — ZERO duplicated tool
//     logic, ZERO changes to the stdio path or .mcp.json. The stdio server's
//     runtime is guarded behind IS_MAIN so importing it never touches stdin.
//   • ZERO new npm deps: node:http + node:crypto only (node_modules here is a
//     junction onto the owner's shared store — installing @modelcontextprotocol/sdk
//     would pollute it and need network; the HTTP contract is small enough to
//     hand-roll, exactly as the stdio server hand-rolls the stdio framing).
//   • LAW 6 (brand-neutral): every new env var / path / port is neutral
//     (REMOTE_MCP_*). No "skycruncher"/"skycruncher" literal in any new identifier.
//     The pre-existing serverInfo.name (skycruncher-solve) is reused unchanged —
//     it rides the future one-shot rename pass, never churned piecemeal.
//   • AUTH IS MANDATORY. There is NO unauthenticated endpoint. A request with
//     neither a valid bearer NOR a valid Access JWT is 401 before any dispatch —
//     including the liveness probe. Access-JWT verification FAILS CLOSED.
//   • RENDER LINKS. GET /renders/<basename>.png|html serves the mcp_renders/ dir
//     read-only so render_widget results can carry a user-clickable view_url (an
//     Access-gated HTTPS link the client shows when it buries MCP image content).
//     Auth MIRRORS the active MCP mode (access → bearer|Access-JWT; bearer cold
//     path → bearer|localhost). STRICT single-basename allow-list, containment-
//     checked, no directory listing, GET/HEAD only.
//   • REMOTE ALLOWLIST: remote exposure defaults to a READ+SOLVE subset. The
//     write-path tools (thesis_submit / thesis_stamp / draft_annotation) are
//     EXCLUDED by default and stay local until the owner opts in via config.
//   • SOLVE = HEAVY LANE. The CR2/FITS solve is load-sensitive; a remote-triggered
//     solve acquires the cross-session advisory lock (tools/ops/heavy_lane_lock.mjs)
//     and runs at concurrency 1, failing CLOSED with a polite busy error.
// ═══════════════════════════════════════════════════════════════════════════

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  TOOLS,
  callTool,
  listResources,
  readResource,
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
} from './server.mjs';
import { verifyAccessJwt, discoverAccessAud } from './access_jwt.mjs';
import { sanitizeRenderName, renderRouteAuthPlan } from './render_route.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HEAVY_LOCK = path.join(ROOT, 'tools', 'ops', 'heavy_lane_lock.mjs');
const TEST_RESULTS = path.join(ROOT, 'test_results');
const TOKEN_FILE = path.join(TEST_RESULTS, 'mcp_remote_token.txt'); // test_results/ is gitignored

// ─── stderr-only logging (never stdout — parity with the stdio server) ───────
function log(...a) { process.stderr.write('[mcp-remote] ' + a.join(' ') + '\n'); }

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG (all LAW-6-neutral env keys; safe defaults)
// ═══════════════════════════════════════════════════════════════════════════
const CFG = {
  host: process.env.REMOTE_MCP_HOST || '127.0.0.1',
  port: Number(process.env.REMOTE_MCP_PORT || 8848),
  path: process.env.REMOTE_MCP_PATH || '/mcp',
  // Default remote surface = READ + SOLVE. Write-path tools excluded by default.
  tools: (process.env.REMOTE_MCP_TOOLS
    || 'solve_fits,inspect_receipt,instrument_status,rig_profiles,list_widgets,render_widget,librarian_query')
    .split(',').map((s) => s.trim()).filter(Boolean),
  allowedOrigins: (process.env.REMOTE_MCP_ALLOWED_ORIGINS || 'https://claude.ai,https://claude.com')
    .split(',').map((s) => s.trim()).filter(Boolean),
  maxBodyBytes: Number(process.env.REMOTE_MCP_MAX_BODY_BYTES || 1_048_576), // 1 MiB
  rateMax: Number(process.env.REMOTE_MCP_RATE_MAX || 120),
  rateWindowMs: Number(process.env.REMOTE_MCP_RATE_WINDOW_MS || 60_000),
  requireSession: process.env.REMOTE_MCP_REQUIRE_SESSION !== '0', // spec: non-init needs Mcp-Session-Id
  sessionTtlMs: Number(process.env.REMOTE_MCP_SESSION_TTL_MS || 60 * 60_000), // 1 h idle
  laneAccount: process.env.REMOTE_MCP_LANE_ACCOUNT || 'acct-A',
  // Auth mode: 'access' (DEFAULT) accepts a valid static bearer OR a verified
  // Cloudflare Access JWT. 'bearer' = cold path, bearer-only (Access disabled).
  authMode: (process.env.REMOTE_MCP_AUTH || 'access').trim().toLowerCase() === 'bearer' ? 'bearer' : 'access',
};

// A tool is HEAVY (a solve lane) if it runs the real pipeline.
function isHeavyCall(name, args) {
  if (name === 'solve_fits') return true;
  if (name === 'render_widget' && args && typeof args.fits_path === 'string' && args.fits_path) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTH TOKEN — env > gitignored file > freshly generated (never hardcoded)
// ═══════════════════════════════════════════════════════════════════════════
function loadOrCreateToken() {
  const fromEnv = process.env.REMOTE_MCP_TOKEN && process.env.REMOTE_MCP_TOKEN.trim();
  if (fromEnv) return { token: fromEnv, source: 'env:REMOTE_MCP_TOKEN' };
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return { token: t, source: `file:${path.relative(ROOT, TOKEN_FILE)}` };
  } catch { /* absent — generate below */ }
  const t = crypto.randomBytes(32).toString('base64url'); // 256-bit
  fs.mkdirSync(TEST_RESULTS, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* best-effort on win */ }
  return { token: t, source: `generated → ${path.relative(ROOT, TOKEN_FILE)}` };
}
const { token: AUTH_TOKEN, source: TOKEN_SOURCE } = loadOrCreateToken();

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function bearerOk(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if (typeof h !== 'string') return false;
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return timingSafeEqual(m[1].trim(), AUTH_TOKEN);
}

// Cloudflare Access forwards the identity JWT in a header, or (browser flows) a
// CF_Authorization cookie. Node lowercases header names.
function accessTokenFromReq(req) {
  const h = req.headers['cf-access-jwt-assertion'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const cookie = req.headers['cookie'];
  if (typeof cookie === 'string') {
    const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    if (m) { try { return decodeURIComponent(m[1]).trim(); } catch { return m[1].trim(); } }
  }
  return null;
}

// Request is authorized if the static bearer matches (alternate credential) OR,
// in the default 'access' mode, a Cloudflare Access JWT verifies. Fails closed.
// Returns { ok, path } — path ∈ {'bearer','access'} for per-session logging.
async function authOk(req) {
  if (bearerOk(req)) return { ok: true, path: 'bearer' };
  if (CFG.authMode === 'bearer') return { ok: false };
  const token = accessTokenFromReq(req);
  if (!token) return { ok: false };
  const v = await verifyAccessJwt(token);
  return v.ok ? { ok: true, path: 'access', email: v.email } : { ok: false };
}

function isLocalhostReq(req) {
  const a = req.socket && req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// /renders auth mirrors the active MCP mode (pure decision in render_route.mjs).
// Computes the four booleans from the live request + CFG. FAILS CLOSED.
async function rendersAuthorized(req) {
  const bearerValid = bearerOk(req);
  let accessValid = false;
  if (!bearerValid && CFG.authMode === 'access') {
    const token = accessTokenFromReq(req);
    if (token) { const v = await verifyAccessJwt(token); accessValid = !!v.ok; }
  }
  return renderRouteAuthPlan({
    authMode: CFG.authMode, bearerValid, accessValid, isLocalhost: isLocalhostReq(req),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSIONS + RATE LIMIT (in-memory; fixed-window per session, per-IP pre-session)
// ═══════════════════════════════════════════════════════════════════════════
const sessions = new Map(); // sid -> { created, lastSeen, windowStart, count }
const ipWindows = new Map(); // ip  -> { windowStart, count }  (initialize / pre-session)

function newSession() {
  const sid = crypto.randomUUID();
  sessions.set(sid, { created: Date.now(), lastSeen: Date.now(), windowStart: Date.now(), count: 0 });
  return sid;
}
function sweepSessions() {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.lastSeen > CFG.sessionTtlMs) sessions.delete(sid);
}
// returns true if UNDER the limit (and increments), false if over
function rateOk(bucket) {
  const now = Date.now();
  if (now - bucket.windowStart >= CFG.rateWindowMs) { bucket.windowStart = now; bucket.count = 0; }
  bucket.count += 1;
  return bucket.count <= CFG.rateMax;
}

// ═══════════════════════════════════════════════════════════════════════════
// HEAVY-LANE LOCK — cross-session advisory lock around any real solve
// ═══════════════════════════════════════════════════════════════════════════
let heavyInFlight = false; // in-process concurrency=1 guard (fast path)
function lane(cmd, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HEAVY_LOCK, cmd, ...extra], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => resolve({ code: -1, stderr: 'spawn failed' }));
    child.on('close', (code) => resolve({ code, stderr: err }));
  });
}
async function acquireHeavy() {
  if (heavyInFlight) return { ok: false, reason: 'a remote solve is already running on this server (concurrency = 1)' };
  const res = await lane('acquire', [CFG.laneAccount, 'remote-solve']);
  if (res.code === 3) return { ok: false, reason: 'the shared heavy lane is busy (another session holds it) — the load-sensitive solve is serialized across accounts' };
  if (res.code !== 0) return { ok: false, reason: `could not acquire the heavy lane (lock exit ${res.code})` };
  heavyInFlight = true;
  return { ok: true };
}
async function releaseHeavy() {
  heavyInFlight = false;
  await lane('release', [CFG.laneAccount]);
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON-RPC DISPATCH — reuses the imported registry (no duplicated tool logic)
// ═══════════════════════════════════════════════════════════════════════════
const E_METHOD = -32601, E_PARAMS = -32602, E_INTERNAL = -32603;
const remoteTools = () => TOOLS.filter((t) => CFG.tools.includes(t.name));

function wrapToolResult(result) {
  if (result && result.__content) return { content: result.__content, isError: false };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false };
}

// Returns a JSON-RPC response object, or null for a notification (no reply).
async function dispatch(msg) {
  if (msg.id === undefined || msg.id === null) return null; // notification — no reply
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const rpcErr = (code, message, data) => ({ jsonrpc: '2.0', id, error: data !== undefined ? { code, message, data } : { code, message } });
  try {
    switch (method) {
      case 'initialize': {
        const clientProto = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
        return ok({ protocolVersion: clientProto, capabilities: { tools: {}, resources: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: remoteTools() });
      case 'resources/list': return ok({ resources: listResources() });
      case 'resources/read': {
        if (!params || typeof params.uri !== 'string') return rpcErr(E_PARAMS, 'resources/read requires { uri }');
        return ok(readResource(params.uri));
      }
      case 'tools/call': {
        if (!params || typeof params.name !== 'string') return rpcErr(E_PARAMS, 'tools/call requires { name, arguments }');
        const name = params.name;
        if (!CFG.tools.includes(name)) {
          // Honest refusal — the tool exists locally but is not on the remote allowlist.
          return ok({ content: [{ type: 'text', text: `ERROR: tool "${name}" is not exposed on the remote connector (read+solve allowlist only; write-path tools stay local). Allowed: ${CFG.tools.join(', ')}` }], isError: true });
        }
        const args = params.arguments || {};
        const heavy = isHeavyCall(name, args);
        if (heavy) {
          const lock = await acquireHeavy();
          if (!lock.ok) {
            // fail CLOSED with a polite busy error (NOT a 5xx — a valid tool result)
            return ok({ content: [{ type: 'text', text: `BUSY: ${lock.reason}. Please retry shortly.` }], isError: true });
          }
        }
        try {
          const result = await callTool(name, args, undefined); // no SSE progress in JSON mode
          return ok(wrapToolResult(result));
        } catch (e) {
          return ok({ content: [{ type: 'text', text: `ERROR: ${e && e.message ? e.message : String(e)}` }], isError: true });
        } finally {
          if (heavy) await releaseHeavy();
        }
      }
      default: return rpcErr(E_METHOD, `method not found: ${method}`);
    }
  } catch (e) {
    return rpcErr(E_INTERNAL, e && e.message ? e.message : String(e));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP layer — Streamable HTTP contract on a single endpoint
// ═══════════════════════════════════════════════════════════════════════════
function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, ...extraHeaders });
  res.end(body);
}
function corsHeaders(req) {
  const origin = req.headers['origin'];
  const allowOrigin = origin && (CFG.allowedOrigins.includes('*') || CFG.allowedOrigins.includes(origin)) ? origin : (CFG.allowedOrigins[0] || '*');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Accept',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  };
}
function originOk(req) {
  const origin = req.headers['origin'];
  if (!origin) return true; // server-side fetch (claude.ai egress) sends no Origin — allow
  if (CFG.allowedOrigins.includes('*')) return true;
  return CFG.allowedOrigins.includes(origin);
}
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(Object.assign(new Error('payload too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cors = corsHeaders(req);

  // CORS preflight — the ONLY unauthenticated response (carries no data).
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  // Everything else requires a valid credential. DNS-rebind guard on Origin first.
  if (!originOk(req)) { sendJson(res, 403, { error: 'origin not allowed' }, cors); return; }

  // ── /renders/<basename> — user-clickable render artifacts (auth mirrors the MCP
  //    mode; handled BEFORE the MCP auth gate so the bearer-mode localhost fallback
  //    can serve without a credential). GET/HEAD only, STRICT basename, never lists.
  if (url.pathname === '/renders' || url.pathname.startsWith('/renders/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...cors, 'Allow': 'GET' }); res.end(); return;
    }
    if (!(await rendersAuthorized(req))) {
      sendJson(res, 401, { error: 'unauthorized — render artifacts need the bearer, a valid Cloudflare Access assertion (access mode), or a localhost origin (bearer mode)' }, { ...cors, 'WWW-Authenticate': 'Bearer' });
      return;
    }
    const safe = sanitizeRenderName(url.pathname.slice('/renders/'.length));
    if (!safe) { sendJson(res, 404, { error: 'not found' }, cors); return; }
    let data;
    try { data = fs.readFileSync(safe.resolved); }
    catch { sendJson(res, 404, { error: 'not found' }, cors); return; }
    res.writeHead(200, {
      ...cors,
      'Content-Type': safe.mime,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(data);
    return;
  }

  const auth = await authOk(req);
  if (!auth.ok) {
    sendJson(res, 401, { error: 'unauthorized — provide Authorization: Bearer <token> or a valid Cloudflare Access assertion' }, { ...cors, 'WWW-Authenticate': 'Bearer' });
    return;
  }

  // Authenticated liveness probe (no tool surface, no solve).
  if (url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok', server: `${SERVER_NAME} v${SERVER_VERSION}`, transport: 'streamable-http', tools: CFG.tools.length }, cors);
    return;
  }

  if (url.pathname !== CFG.path) { sendJson(res, 404, { error: `not found (MCP endpoint is ${CFG.path})` }, cors); return; }

  sweepSessions();

  // GET = server-initiated SSE stream. We do not push server-initiated messages,
  // so decline per spec (client may still POST normally).
  if (req.method === 'GET') { res.writeHead(405, { ...cors, 'Allow': 'POST, DELETE' }); res.end(); return; }

  // DELETE = terminate session.
  if (req.method === 'DELETE') {
    const sid = req.headers['mcp-session-id'];
    if (typeof sid === 'string') sessions.delete(sid);
    res.writeHead(204, cors); res.end(); return;
  }

  if (req.method !== 'POST') { res.writeHead(405, { ...cors, 'Allow': 'POST, DELETE' }); res.end(); return; }

  // Read + parse the JSON-RPC body (size-capped).
  let raw;
  try { raw = await readBody(req, CFG.maxBodyBytes); }
  catch (e) {
    if (e && e.code === 413) { sendJson(res, 413, { error: `payload exceeds ${CFG.maxBodyBytes} bytes` }, cors); return; }
    sendJson(res, 400, { error: 'could not read request body' }, cors); return;
  }
  let payload;
  try { payload = JSON.parse(raw); }
  catch { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, cors); return; }

  const messages = Array.isArray(payload) ? payload : [payload];
  const isInitialize = messages.some((m) => m && m.method === 'initialize');

  // ─── session handling per the Streamable HTTP spec ─────────────────────────
  let sid = req.headers['mcp-session-id'];
  let bucket;
  if (isInitialize) {
    sid = newSession();
    bucket = sessions.get(sid);
    // Log the auth path this session came in on (never the token contents).
    log(`session ${sid.slice(0, 8)} auth=${auth.path}`);
  } else if (CFG.requireSession) {
    if (typeof sid !== 'string') { sendJson(res, 400, { error: 'missing Mcp-Session-Id (initialize first)' }, cors); return; }
    const s = sessions.get(sid);
    if (!s) { sendJson(res, 404, { error: 'unknown or expired session — re-initialize' }, cors); return; }
    s.lastSeen = Date.now();
    bucket = s;
  } else {
    bucket = (() => {
      const ip = req.socket.remoteAddress || 'unknown';
      let b = ipWindows.get(ip);
      if (!b) { b = { windowStart: Date.now(), count: 0 }; ipWindows.set(ip, b); }
      return b;
    })();
  }

  // ─── rate limit ────────────────────────────────────────────────────────────
  if (!rateOk(bucket)) {
    sendJson(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32000, message: `rate limit: max ${CFG.rateMax} requests / ${CFG.rateWindowMs} ms` } }, cors);
    return;
  }

  // ─── dispatch each message; collect responses (notifications produce none) ──
  const responses = [];
  for (const m of messages) {
    const r = await dispatch(m);
    if (r) responses.push(r);
  }

  const extra = { ...cors };
  if (isInitialize && sid) extra['Mcp-Session-Id'] = sid;

  // Notifications/responses only → 202 no body (per spec).
  if (responses.length === 0) { res.writeHead(202, extra); res.end(); return; }
  // We answer requests with a single application/json body (spec-compliant;
  // we do not open an SSE stream because no tool needs server→client streaming).
  sendJson(res, 200, Array.isArray(payload) ? responses : responses[0], extra);
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('handler crash:', e && e.message ? e.message : String(e));
    try { sendJson(res, 500, { error: 'internal error' }); } catch { /* already sent */ }
  });
});

server.listen(CFG.port, CFG.host, () => {
  log(`${SERVER_NAME} v${SERVER_VERSION} — streamable-HTTP remote MCP`);
  log(`  listening   http://${CFG.host}:${CFG.port}${CFG.path}`);
  log(`  renders     GET /renders/<name>.png|html (auth mirrors the MCP mode)`);
  if (CFG.authMode === 'bearer') {
    log(`  auth        Bearer ONLY (cold path, REMOTE_MCP_AUTH=bearer) · token source: ${TOKEN_SOURCE}`);
  } else {
    log(`  auth        Bearer OR Cloudflare Access JWT (default) · bearer source: ${TOKEN_SOURCE}`);
    // Best-effort AUD discovery — NEVER crashes; unpinned = honest warning, other checks enforced.
    discoverAccessAud().then((r) => {
      if (r.warning) log(`  access-aud  UNPINNED — ${r.warning}`);
      else log(`  access-aud  pinned (${r.source})`);
    });
  }
  log(`  remote tools ${CFG.tools.join(', ')}`);
  log(`  excluded    ${TOOLS.map((t) => t.name).filter((n) => !CFG.tools.includes(n)).join(', ') || '(none)'}`);
  log(`  limits      body<=${CFG.maxBodyBytes}B · rate ${CFG.rateMax}/${CFG.rateWindowMs}ms · solve concurrency=1 (heavy-lane locked)`);
  log(`  origins     ${CFG.allowedOrigins.join(', ')}`);
});

process.on('SIGINT', () => { log('shutting down'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
