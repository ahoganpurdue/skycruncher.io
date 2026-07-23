#!/usr/bin/env node
// ============================================================================
// tools/theses/dashboard/serve.mjs — CSL thesis dashboard server (READ-ONLY)
// ============================================================================
// Zero-dependency static server for the 5-tab dashboard:
//   • serves tools/theses/dashboard/ui/  (the design lane's front-end)
//   • serves curated narrative-doc snapshots (built by publish_docs.mjs) as
//     raw text at /docs/<slug>.md, with the manifest at /data/docs_manifest.json
//     (both read-only, DOCS_DIR-scoped, same traversal guards as /data)
//   • serves EVERY *.json under test_results/theses/dashboard/ at
//     /data/<name>.json (read-only passthrough), with two REGENERATING routes:
//       /data/thesis_dashboard_data.json — rebuilt from the registry on EVERY
//         request via snapshot.mjs (registry is small; fresh beats stale)
//       /data/token_tracker_data.json — if tools/theses/dashboard/
//         telemetry_adapter.mjs exists (built by the telemetry lane — this
//         server only imports it, never owns it), its exported snapshot() is
//         called per request; on ANY adapter failure we fall back to the
//         static file; if that is absent too → 404 (UI renders the honest
//         missing-state). The adapter can never crash the server.
//
// READ-ONLY by construction for the DATA + UI planes: GET/HEAD only there.
// EXACTLY ONE write endpoint exists — POST /api/respond — which APPENDS a single
// owner-response line to test_results/theses/dashboard/owner_responses.jsonl.
// A response line may OPTIONALLY carry `child_id` (sub-tier scoping under a
// decision that has `children[]`); absent = parent-scoped, the prior shape.
// It is append-only (no update/delete of any kind), token-gated
// (X-Dashboard-Token must match the local .dashboard_token — a home-LAN
// convenience gate, NOT security-grade auth), and cannot mutate anything else.
// Every other non-GET/HEAD request → 405. No remote calls.
//
// Flags:  --port <n>   default 4321
//         --host <ip>  default 127.0.0.1  (0.0.0.0 = LAN mode — other machines
//                       on the owner's network reach it at http://<LAN-IP>:<port>/)
// Prints localhost + LAN IPv4 + hostname URLs on start.
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateSnapshot } from './snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const UI_DIR = path.join(HERE, 'ui');
const DATA_DIR = path.join(ROOT, 'test_results', 'theses', 'dashboard');
const ANALYTICS_DIR = path.join(ROOT, 'test_results', 'analytics');  // Database tab: publish_analytics.mjs results (read-only passthrough)
const DOCS_DIR = path.join(DATA_DIR, 'docs');                    // curated narrative-doc snapshots (built by publish_docs.mjs)
const ADAPTER_PATH = path.join(HERE, 'telemetry_adapter.mjs'); // owned by the telemetry lane — import-only
const TOKEN_PATH = path.join(DATA_DIR, '.dashboard_token');       // home-LAN write gate (gitignored)
const RESPONSES_PATH = path.join(DATA_DIR, 'owner_responses.jsonl'); // append-only owner-response ledger
const RESPONSE_ACKS_PATH = path.join(DATA_DIR, 'response_acks.jsonl'); // append-only ingestion-ack ledger (orchestrator appends directly; NO write endpoint)

// ---- Morning Review aggregate — source files (all reads guarded; any absent → honest NOT AVAILABLE) ----
const REVIEW_MARKS_PATH   = path.join(DATA_DIR, 'review_marks.jsonl');          // append-only "reviewed up to here" ledger (this tab's write path)
const OWNER_DECISIONS_PATH = path.join(DATA_DIR, 'owner_decisions.json');       // editorial docket (orchestrator-owned)
const WORK_ITEMS_PATH = path.join(DATA_DIR, 'work_items.json');      // roadmap editorial ledger (may be absent → honest empty state)
const PREFLIGHT_PATH = path.join(DATA_DIR, 'preflight_manifests.jsonl'); // append-only roadmap pre-flight manifests
const REGISTRY_PATH   = path.join(ROOT, 'test_results', 'theses', 'registry.jsonl'); // hash-chained thesis registry (register/stamp/annotate lines)
const AGENT_RUNS_PATH = path.join(ROOT, 'test_results', 'agent_runs.jsonl');    // SubagentStop completion log (lanes done + last-observed background tasks)
const GATES_PATH      = path.join(ROOT, 'docs', 'GATES.md');                    // canonical regression numbers (AT LAST BATTERY — never re-measured here)
const PACKET_PATH     = path.join(DATA_DIR, 'morning_packet.json');             // optional editorial "needs you today" packet
const WAITING_ON_PATH = path.join(DATA_DIR, 'waiting_on.jsonl');                // append-only launch/complete wait-ledger (.claude/hooks/waiting_on.mjs)

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, def) {
    const i = argv.indexOf('--' + name);
    if (i === -1) return def;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
}
const PORT = Number(opt('port', 4321));
const HOST = String(opt('host', '127.0.0.1'));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`[serve] invalid --port ${opt('port', 4321)}`);
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
    '.map': 'application/json',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store', // always-fresh dashboard; no stale caches
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

// ---- /data handlers ---------------------------------------------------------
function serveThesisSnapshot(res) {
    try {
        const snap = generateSnapshot({ writeToDisk: true }); // regenerated from the registry EVERY request
        sendJson(res, 200, snap);
    } catch (err) {
        // Honest failure: the generator broke — say so, never serve a stale file silently as if fresh.
        sendJson(res, 500, { error: 'snapshot generation failed', detail: String(err && err.message || err) });
    }
}

async function serveTokenTracker(res) {
    // 1) Telemetry adapter (parallel lane's file) — import + call, fully guarded.
    if (fs.existsSync(ADAPTER_PATH)) {
        try {
            const mod = await import(pathToFileURL(ADAPTER_PATH).href);
            if (typeof mod.snapshot === 'function') {
                const data = await mod.snapshot(); // may regenerate token_tracker_data.json itself
                if (data !== undefined && data !== null) { sendJson(res, 200, data); return; }
            }
        } catch (err) {
            console.error(`[serve] telemetry_adapter failed (falling back to static file): ${String(err && err.message || err)}`);
        }
    }
    // 2) Static fallback.
    const fp = path.join(DATA_DIR, 'token_tracker_data.json');
    if (fs.existsSync(fp)) { serveStaticFile(res, fp); return; }
    // 3) Honest absence.
    sendJson(res, 404, { error: 'token_tracker_data.json not available', detail: 'no telemetry adapter and no static file — NOT RECORDED' });
}

function serveStaticFile(res, abs) {
    let body;
    try { body = fs.readFileSync(abs); } catch { sendJson(res, 404, { error: 'not found' }); return; }
    send(res, 200, body, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
}

/** GET /data/owner_responses.json — parse the append-only JSONL into an array.
 *  Absent file → [] (honest: no responses yet). Corrupt/tampered lines are
 *  skipped, never fabricated. This is the ONLY view the UI overlays. */
function serveOwnerResponses(res) {
    try {
        if (!fs.existsSync(RESPONSES_PATH)) { sendJson(res, 200, []); return; }
        const txt = fs.readFileSync(RESPONSES_PATH, 'utf8');
        const out = [];
        for (const line of txt.split(/\r?\n/)) {
            const s = line.trim();
            if (!s) continue;
            try { out.push(JSON.parse(s)); } catch { /* skip a corrupt/tampered line — never invent one */ }
        }
        sendJson(res, 200, out);
    } catch (err) {
        sendJson(res, 500, { error: 'could not read owner_responses', detail: String(err && err.message || err) });
    }
}

/** GET /data/response_acks.json — parse the append-only ingestion-ack JSONL into
 *  an array. Absent file → [] (honest: nothing ingested yet — graceful-empty, a
 *  200 so the client never falls back to a fixture). The orchestrator APPENDS to
 *  this file directly (marking owner responses ingested); there is no write
 *  endpoint. Each line: {response_ts, decision_id, acked_at, by}. Corrupt lines
 *  are skipped, never fabricated. */
function serveResponseAcks(res) {
    try {
        if (!fs.existsSync(RESPONSE_ACKS_PATH)) { sendJson(res, 200, []); return; }
        const txt = fs.readFileSync(RESPONSE_ACKS_PATH, 'utf8');
        const out = [];
        for (const line of txt.split(/\r?\n/)) {
            const s = line.trim();
            if (!s) continue;
            try { out.push(JSON.parse(s)); } catch { /* skip a corrupt/tampered line — never invent one */ }
        }
        sendJson(res, 200, out);
    } catch (err) {
        sendJson(res, 500, { error: 'could not read response_acks', detail: String(err && err.message || err) });
    }
}

// ---- owner-response write endpoint (the ONE append-only exception) ----------
const RESP_ACTIONS = new Set(['approve', 'overturn', 'answer', 'park', 'proxy']); // 'proxy' = kick out-of-domain decision to the owner-proxy (note-less, like approve/park)
const MAX_BODY = 64 * 1024;   // reject oversized bodies outright
const MAX_NOTE = 8000;        // a ruling note, not a document

let DASHBOARD_TOKEN = null;

/** Load .dashboard_token, generating (0600-ish) on first start if absent.
 *  Returns {token, generated} for the startup print. */
function ensureToken() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(TOKEN_PATH)) {
        const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
        if (existing) { DASHBOARD_TOKEN = existing; return { token: existing, generated: false }; }
    }
    const tok = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_PATH, tok + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(TOKEN_PATH, 0o600); } catch { /* best-effort on non-POSIX FS */ }
    DASHBOARD_TOKEN = tok;
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

/** POST /api/respond — token-gated, append-only. Token is checked BEFORE the
 *  body, so a tokenless request is 401 regardless of payload validity. */
async function handleRespond(req, res) {
    const provided = req.headers['x-dashboard-token'];
    if (!DASHBOARD_TOKEN || typeof provided !== 'string' || provided !== DASHBOARD_TOKEN) {
        sendJson(res, 401, { error: 'missing or invalid X-Dashboard-Token' });
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

    const decision_id = body.decision_id;
    const action = body.action;
    const note = (body.note === undefined || body.note === null) ? '' : body.note;
    // Optional sub-tier scoping: a decision may carry `children[]`; a child-scoped
    // response reuses the parent's decision_id and additionally carries child_id.
    // ABSENT (undefined/null) → parent-scoped, exactly the prior record shape.
    const child_id = (body.child_id === undefined || body.child_id === null) ? undefined : body.child_id;

    if (typeof decision_id !== 'string' || decision_id.trim() === '' || decision_id.length > 256) {
        sendJson(res, 400, { error: 'decision_id must be a non-empty string (≤256 chars)' }); return;
    }
    if (typeof action !== 'string' || !RESP_ACTIONS.has(action)) {
        sendJson(res, 400, { error: `action must be one of ${[...RESP_ACTIONS].join('|')}` }); return;
    }
    if (typeof note !== 'string' || note.length > MAX_NOTE) {
        sendJson(res, 400, { error: `note must be a string ≤${MAX_NOTE} chars` }); return;
    }
    if ((action === 'overturn' || action === 'answer') && note.trim() === '') {
        sendJson(res, 400, { error: `action '${action}' requires a non-empty note` }); return;
    }
    if (child_id !== undefined && (typeof child_id !== 'string' || child_id.trim() === '' || child_id.length > 256)) {
        sendJson(res, 400, { error: 'child_id, when present, must be a non-empty string (≤256 chars)' }); return;
    }

    const record = { decision_id, action, note, ts: new Date().toISOString(), via: 'dashboard', ...(child_id !== undefined ? { child_id } : {}) };
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.appendFileSync(RESPONSES_PATH, JSON.stringify(record) + '\n', { encoding: 'utf8' });
    } catch (err) {
        sendJson(res, 500, { error: 'append failed', detail: String(err && err.message || err) }); return;
    }
    sendJson(res, 200, { ok: true, appended: record });
}

/** GET /data/work_items.json — the roadmap editorial ledger. Present → serve
 *  it verbatim (bare array or {items} object). ABSENT → graceful 200 empty
 *  state {generated_at:null, published:false, items:[]}; the UI renders an
 *  explicit "LEDGER NOT PUBLISHED" panel rather than a stale draft as-if-live
 *  (and, being 200, never trips the client's fixture-fallback into showing the
 *  bundled draft on a live server). Mirrors the theses/tokens degrade pattern. */
function serveWorkItems(res) {
    if (fs.existsSync(WORK_ITEMS_PATH)) { serveStaticFile(res, WORK_ITEMS_PATH); return; }
    sendJson(res, 200, { generated_at: null, published: false, items: [] });
}

/** POST /api/preflight — token-gated, append-only. Records a roadmap pre-flight
 *  manifest (checked work items + their dependency-tree classification) to
 *  preflight_manifests.jsonl. NO execution routing: this only records the
 *  orchestrator's queue; nothing here runs anything. Same append-only, no
 *  update/delete discipline as /api/respond. */
async function handlePreflight(req, res) {
    const provided = req.headers['x-dashboard-token'];
    if (!DASHBOARD_TOKEN || typeof provided !== 'string' || provided !== DASHBOARD_TOKEN) {
        sendJson(res, 401, { error: 'missing or invalid X-Dashboard-Token' });
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
    if (!Array.isArray(body.selections)) {
        sendJson(res, 400, { error: 'body.selections must be an array' }); return;
    }
    if (body.selections.length === 0 || body.selections.length > 1000) {
        sendJson(res, 400, { error: 'body.selections must have 1..1000 entries' }); return;
    }
    for (const s of body.selections) {
        if (s === null || typeof s !== 'object' || Array.isArray(s) || typeof s.item_id !== 'string' || s.item_id.trim() === '') {
            sendJson(res, 400, { error: 'each selection must be an object with a non-empty string item_id' }); return;
        }
    }

    const record = { kind: 'roadmap-preflight', selections: body.selections, client_emitted_at: (typeof body.client_emitted_at === 'string' ? body.client_emitted_at : null), ts: new Date().toISOString(), via: 'dashboard' };
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.appendFileSync(PREFLIGHT_PATH, JSON.stringify(record) + '\n', { encoding: 'utf8' });
    } catch (err) {
        sendJson(res, 500, { error: 'append failed', detail: String(err && err.message || err) }); return;
    }
    sendJson(res, 200, { ok: true, appended_count: body.selections.length, ts: record.ts });
}

// ============================================================================
// Morning Review — a boot surface for BOTH owner and orchestrator, answering
// "what happened since I last looked, and what needs me now". EXPOSED at
// GET /api/morning (the orchestrator boots from this exact query) AND consumed
// by the #morning UI tab (its live feed is /api/morning).
//
// Every input is read fresh + fully guarded; a missing file is an honest
// NOT AVAILABLE, never a fabricated value (LAW 3). Deltas are computed against
// the LAST review mark (review_marks.jsonl), never wall-clock — so "since you
// last looked" is anchored to an explicit event, not a guess.
//
// SHAPE (schema "morning-review/1"):
// {
//   generated_at, endpoint, schema,
//   last_review:  { ts, by, note, via } | null,   // newest review_marks line
//   review_count: <int>,                           // total marks on the ledger
//   since:        <iso used as the delta cutoff> | null,
//   thesis_stamps:{ available, since, stamps:[ {id,title,status,ts,by,evidence_pointer} ], note },
//   decisions:    { available, new_since_review:[…], answered_since_review:[…],
//                   ingestion_pending:[…], counts:{open,answer_pending,blocked} },
//   lanes:        { completed_available, recent_completed:[ {ts,agent_type,model,duration_s,turns,tokens} ],
//                   in_flight:{ available, observed_at, tasks:[…], note } },
//   gates:        { available, source, at_last_battery, regenerated_at, regenerated_by, rows:[ {gate,command,expected} ] },
//   packet:       { curated, generated_at, source, items:[ {rank,title,why,action,refs} ] }
// }
// NOTE on lanes.in_flight: there is NO live wait-state capture anywhere in the
// system. What we surface is the `background_tasks` snapshot embedded in the
// MOST RECENT agent_runs line — a real, point-in-time observation, explicitly
// labelled stale/last-observed. If that field is absent → available:false.
// ============================================================================

function readJsonlLines(fp, limit) {
    // returns { ok, lines:[parsedObj…] } — newest last; skips corrupt lines, never invents.
    if (!fs.existsSync(fp)) return { ok: false, lines: [] };
    let txt;
    try { txt = fs.readFileSync(fp, 'utf8'); } catch { return { ok: false, lines: [] }; }
    const all = [];
    for (const line of txt.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        try { all.push(JSON.parse(s)); } catch { /* skip corrupt/tampered line */ }
    }
    return { ok: true, lines: limit != null ? all.slice(-limit) : all };
}

/** Parse the machine-generated AUTO block of docs/GATES.md. Handles the escaped
 *  pipe inside `npx tsc --noEmit \| wc -l`. Returns null if the file is absent. */
function parseGates(text) {
    const out = { rows: [], regenerated_at: null, regenerated_by: null };
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith('|')) {
            const cells = line.replace(/\\\|/g, '@@PIPE@@').split('|')
                .map((c) => c.trim().replace(/@@PIPE@@/g, '|'));
            const inner = cells.slice(1, cells[cells.length - 1] === '' ? -1 : undefined);
            const gate = inner[0];
            if (gate === 'TypeScript' || gate === 'Unit tests') {
                out.rows.push({
                    gate,
                    command: String(inner[1] || '').replace(/`/g, ''),
                    expected: String(inner[2] || '').replace(/\*/g, ''),
                });
            }
            continue;
        }
        // greedy + line-anchored: the "by …" value itself contains underscores
        // (tools/gates/check_gates.mjs), so match through to the CLOSING italic _.
        const rm = line.match(/_Last regenerated:\s*(\S+)\s+by\s+(.+)_\s*$/);
        if (rm) { out.regenerated_at = rm[1]; out.regenerated_by = rm[2].trim(); }
    }
    return out;
}

function buildMorningAggregate() {
    const nowIso = new Date().toISOString();

    // ── last review mark (the delta anchor) ───────────────────────────────
    const marks = readJsonlLines(REVIEW_MARKS_PATH);
    const lastMark = marks.lines.length ? marks.lines[marks.lines.length - 1] : null;
    const last_review = lastMark
        ? { ts: lastMark.ts ?? null, by: lastMark.by ?? null, note: lastMark.note ?? null, via: lastMark.via ?? null }
        : null;
    const since = last_review && last_review.ts ? last_review.ts : null;
    const after = (ts) => (since == null ? false : String(ts ?? '') > since);

    // ── thesis verdict stamps since the last review ───────────────────────
    const reg = readJsonlLines(REGISTRY_PATH);
    let thesis_stamps;
    if (!reg.ok) {
        thesis_stamps = { available: false, since, stamps: [], note: 'thesis registry not present — NOT AVAILABLE' };
    } else {
        const titleById = new Map();
        for (const r of reg.lines) if (r && r.kind === 'register' && r.id) titleById.set(r.id, r.title || null);
        const allStamps = reg.lines
            .filter((r) => r && r.kind === 'stamp')
            .map((r) => ({
                id: r.id ?? null, title: titleById.get(r.id) ?? null, status: r.status ?? null,
                ts: r.ts ?? null, by: r.by ?? null, evidence_pointer: r.evidence_pointer ?? null,
                integrity_ok: r.integrity_ok ?? null,
            }));
        if (since == null) {
            thesis_stamps = {
                available: true, since: null, stamps: allStamps.slice(-8).reverse(),
                note: 'no review marker yet — showing the 8 most recent verdict stamps (mark reviewed to anchor future deltas)',
            };
        } else {
            const delta = allStamps.filter((s) => after(s.ts)).reverse();
            thesis_stamps = {
                available: true, since, stamps: delta,
                note: delta.length ? null : 'no new verdict stamps since your last review',
            };
        }
    }

    // ── decisions docket delta ─────────────────────────────────────────────
    let decisions;
    if (!fs.existsSync(OWNER_DECISIONS_PATH)) {
        decisions = { available: false, new_since_review: [], answered_since_review: [], ingestion_pending: [], counts: { open: 0, answer_pending: 0, blocked: 0 } };
    } else {
        let dj = null;
        try { dj = JSON.parse(fs.readFileSync(OWNER_DECISIONS_PATH, 'utf8')); } catch { dj = null; }
        const list = dj && Array.isArray(dj.decisions) ? dj.decisions : [];
        const titleByDec = new Map();
        const stateByDec = new Map();
        for (const d of list) { if (d && d.id) { titleByDec.set(d.id, d.title || null); stateByDec.set(d.id, d.state || null); } }
        const counts = { open: 0, answer_pending: 0, blocked: 0 };
        for (const d of list) {
            if (d.state === 'OPEN') counts.open++;
            else if (d.state === 'ANSWER-PENDING') counts.answer_pending++;
            else if (d.state === 'BLOCKED') counts.blocked++;
        }
        const resp = readJsonlLines(RESPONSES_PATH).lines.filter((r) => r && typeof r.decision_id === 'string');
        const new_since_review = (since == null ? [] : list.filter((d) => after(d.asked_on)))
            .map((d) => ({ id: d.id, title: d.title ?? null, category: d.category ?? null, state: d.state ?? null, asked_on: d.asked_on ?? null }));
        const answered_since_review = (since == null ? [] : resp.filter((r) => after(r.ts)))
            .map((r) => ({ decision_id: r.decision_id, title: titleByDec.get(r.decision_id) ?? null, action: r.action ?? null, ts: r.ts ?? null, note: r.note ?? null }));
        // "ingestion pending": a response exists on the ledger but the decision is
        // still present on the docket in a non-resolved state (OPEN/ANSWER-PENDING/
        // BLOCKED). Honest heuristic — the schema carries no explicit "ingested" flag.
        const latestByDec = new Map();
        for (const r of resp) latestByDec.set(r.decision_id, r); // append order → last wins
        const ingestion_pending = [];
        for (const [decId, r] of latestByDec) {
            const st = stateByDec.get(decId);
            if (st === 'OPEN' || st === 'ANSWER-PENDING' || st === 'BLOCKED') {
                ingestion_pending.push({ decision_id: decId, title: titleByDec.get(decId) ?? null, action: r.action ?? null, ts: r.ts ?? null, state: st });
            }
        }
        decisions = { available: true, new_since_review, answered_since_review, ingestion_pending, counts };
    }

    // ── lanes: completed (agent_runs tail) + last-observed in-flight snapshot ──
    const runs = readJsonlLines(AGENT_RUNS_PATH, 400);
    let lanes;
    if (!runs.ok) {
        lanes = { completed_available: false, recent_completed: [], in_flight: { available: false, observed_at: null, tasks: [], note: 'agent_runs.jsonl not present — NOT AVAILABLE' } };
    } else {
        const recent_completed = runs.lines.slice(-12).reverse().map((r) => {
            const t = r.tokens && typeof r.tokens === 'object' ? r.tokens : null;
            const total = t ? ['input', 'output', 'cache_read', 'cache_creation'].reduce((a, k) => a + (Number(t[k]) || 0), 0) : null;
            return {
                ts: r.ts ?? null, agent_type: r.agent_type ?? null, model: r.model ?? null,
                duration_s: r.duration_s ?? null, turns: r.turns ?? null,
                tokens: t ? { ...t, total } : null,
            };
        });
        const lastRun = runs.lines[runs.lines.length - 1];
        const bt = lastRun && Array.isArray(lastRun.background_tasks) ? lastRun.background_tasks : null;
        const running = bt ? bt.filter((x) => x && x.status === 'running')
            .map((x) => ({ id: x.id ?? null, type: x.type ?? null, status: x.status ?? null, description: x.description ?? null })) : [];
        lanes = {
            completed_available: true,
            recent_completed,
            in_flight: bt
                ? { available: true, observed_at: lastRun.ts ?? null, tasks: running,
                    note: 'last-observed snapshot from the most recent completion event — NOT a live feed, may be stale (no live wait-state capture exists)' }
                : { available: false, observed_at: null, tasks: [],
                    note: 'no background-task snapshot on the latest run — in-flight state NOT AVAILABLE' },
        };
    }

    // ── gates (from docs/GATES.md — never re-measured live) ────────────────
    let gates;
    if (!fs.existsSync(GATES_PATH)) {
        gates = { available: false, source: 'docs/GATES.md', at_last_battery: true, regenerated_at: null, regenerated_by: null, rows: [] };
    } else {
        let g = null;
        try { g = parseGates(fs.readFileSync(GATES_PATH, 'utf8')); } catch { g = null; }
        gates = g
            ? { available: g.rows.length > 0, source: 'docs/GATES.md', at_last_battery: true, regenerated_at: g.regenerated_at, regenerated_by: g.regenerated_by, rows: g.rows }
            : { available: false, source: 'docs/GATES.md', at_last_battery: true, regenerated_at: null, regenerated_by: null, rows: [] };
    }

    // ── editorial "needs you today" packet (optional) ──────────────────────
    let packet;
    if (!fs.existsSync(PACKET_PATH)) {
        packet = { curated: false, generated_at: null, source: 'morning_packet.json', items: [] };
    } else {
        let pj = null;
        try { pj = JSON.parse(fs.readFileSync(PACKET_PATH, 'utf8')); } catch { pj = null; }
        const items = pj && Array.isArray(pj.items) ? pj.items : [];
        packet = { curated: items.length > 0, generated_at: pj && pj.generated_at ? pj.generated_at : null, source: 'morning_packet.json', items };
    }

    return {
        generated_at: nowIso, endpoint: '/api/morning', schema: 'morning-review/1',
        last_review, review_count: marks.lines.length, since,
        thesis_stamps, decisions, lanes, gates, packet,
    };
}

/** GET /api/morning — the dual-consumer aggregate (read-only, no token). */
function serveMorning(res) {
    try { sendJson(res, 200, buildMorningAggregate()); }
    catch (err) { sendJson(res, 500, { error: 'morning aggregate failed', detail: String(err && err.message || err) }); }
}

// ============================================================================
// Live ops — /data/live_ops.json (read-only, no token). The single honest
// "running now" signal the dashboard can build.
//
// SOURCE: waiting_on.jsonl — an append-only launch/complete ledger written by
// .claude/hooks/waiting_on.mjs (PostToolUse Agent|Task → "launch"; SubagentStop
// → "complete"). We match launch↔complete by agent_id: a launch with NO matching
// complete is treated as ACTIVE.
//
// HONEST SEMANTICS (LAW 3 — no fabricated liveness):
//  · This is NOT a process-liveness probe. It is ledger arithmetic. An agent that
//    crashed without emitting SubagentStop stays "active" here forever, so any
//    active entry older than STALE_MIN minutes is FLAGGED stale (possibly already
//    finished/dead, just uncaptured) — never silently trusted.
//  · A launch whose agent_id could not be parsed by the hook cannot be matched to
//    a completion; those are counted separately as `untracked_launches`, never
//    guessed to be running.
//  · `last_observed` mirrors the morning aggregate: the background_tasks snapshot
//    embedded in the most recent agent_runs completion — a real point-in-time
//    observation, explicitly labelled stale.
// ============================================================================
function buildLiveOps() {
    const nowMs = Date.now();
    const STALE_MIN = 30;
    const wl = readJsonlLines(WAITING_ON_PATH);
    if (!wl.ok) {
        return { generated_at: new Date().toISOString(), endpoint: '/data/live_ops.json', schema: 'live-ops/1',
            available: false, source: 'waiting_on.jsonl', note: 'waiting_on.jsonl not present — live ops NOT AVAILABLE',
            active: [], active_count: 0, stale_count: 0, untracked_launches: 0, recent_completions: [], last_observed: { available: false } };
    }
    // completes: set of agent_ids that have a completion line.
    const completed = new Set();
    for (const r of wl.lines) if (r && r.kind === 'complete' && r.agent_id) completed.add(r.agent_id);
    // launches, deduped by agent_id (keep the LATEST launch line per id).
    const launchById = new Map();
    let untracked = 0;
    for (const r of wl.lines) {
        if (!r || r.kind !== 'launch') continue;
        if (!r.agent_id) { untracked++; continue; } // hook could not parse an id → cannot be tracked
        launchById.set(r.agent_id, r);
    }
    const active = [];
    for (const [aid, r] of launchById) {
        if (completed.has(aid)) continue; // has a completion → not active
        const launchedMs = Date.parse(r.ts || '');
        const ageMin = Number.isFinite(launchedMs) ? Math.round((nowMs - launchedMs) / 60000) : null;
        active.push({
            agent_id: aid,
            subagent_type: r.subagent_type ?? null,
            model: r.model ?? null,
            desc: r.desc ?? null,
            launched_at: r.ts ?? null,
            age_min: ageMin,
            stale: ageMin != null && ageMin > STALE_MIN,
            session_id: r.session_id ?? null,
        });
    }
    active.sort((a, b) => String(b.launched_at ?? '').localeCompare(String(a.launched_at ?? '')));
    const stale_count = active.filter((a) => a.stale).length;

    const recent_completions = wl.lines.filter((r) => r && r.kind === 'complete')
        .slice(-10).reverse()
        .map((r) => ({ agent_id: r.agent_id ?? null, at: r.ts ?? null, duration_s: r.duration_s ?? null }));

    // last-observed background-task snapshot from the newest agent_runs line (same
    // source the morning aggregate uses; explicitly stale, never a live feed).
    let last_observed;
    const runs = readJsonlLines(AGENT_RUNS_PATH, 50);
    if (!runs.ok || !runs.lines.length) {
        last_observed = { available: false, note: 'agent_runs.jsonl absent — no last-observed snapshot' };
    } else {
        const lastRun = runs.lines[runs.lines.length - 1];
        const bt = lastRun && Array.isArray(lastRun.background_tasks) ? lastRun.background_tasks : null;
        last_observed = bt
            ? { available: true, observed_at: lastRun.ts ?? null,
                tasks: bt.filter((x) => x && x.status === 'running').map((x) => ({ id: x.id ?? null, type: x.type ?? null, description: x.description ?? null })),
                note: 'snapshot from the most recent completion event — NOT a live feed, may be stale' }
            : { available: false, note: 'no background_tasks on the latest run' };
    }

    return {
        generated_at: new Date().toISOString(), endpoint: '/data/live_ops.json', schema: 'live-ops/1',
        available: true, source: 'waiting_on.jsonl (launch − complete, matched by agent_id)',
        stale_threshold_min: STALE_MIN,
        semantics: 'ledger arithmetic, NOT a process-liveness probe: an agent that never emitted SubagentStop stays active until an entry ages past the stale threshold',
        active, active_count: active.length, stale_count, untracked_launches: untracked,
        recent_completions, last_observed,
    };
}

/** GET /data/live_ops.json — the wait-graph derived live-ops view (read-only). */
function serveLiveOps(res) {
    try { sendJson(res, 200, buildLiveOps()); }
    catch (err) { sendJson(res, 500, { error: 'live-ops build failed', detail: String(err && err.message || err) }); }
}

/** POST /api/review-mark — token-gated, append-only. Records "reviewed up to
 *  here" so future deltas anchor to this instant. Same shape-discipline as
 *  owner_responses: token checked BEFORE the body; note/by optional + bounded. */
async function handleReviewMark(req, res) {
    const provided = req.headers['x-dashboard-token'];
    if (!DASHBOARD_TOKEN || typeof provided !== 'string' || provided !== DASHBOARD_TOKEN) {
        sendJson(res, 401, { error: 'missing or invalid X-Dashboard-Token' });
        return;
    }
    let raw;
    try { raw = await readBody(req, MAX_BODY); }
    catch (err) { sendJson(res, 400, { error: 'unreadable body', detail: String(err && err.message || err) }); return; }
    let body;
    try { body = raw.trim() === '' ? {} : JSON.parse(raw); }
    catch { sendJson(res, 400, { error: 'body is not valid JSON' }); return; }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'body must be a JSON object' }); return;
    }
    const by = (body.by === undefined || body.by === null) ? '' : body.by;
    const note = (body.note === undefined || body.note === null) ? '' : body.note;
    if (typeof by !== 'string' || by.length > 256) { sendJson(res, 400, { error: 'by must be a string (≤256 chars)' }); return; }
    if (typeof note !== 'string' || note.length > MAX_NOTE) { sendJson(res, 400, { error: `note must be a string ≤${MAX_NOTE} chars` }); return; }

    const record = { by, note, ts: new Date().toISOString(), via: 'dashboard' };
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.appendFileSync(REVIEW_MARKS_PATH, JSON.stringify(record) + '\n', { encoding: 'utf8' });
    } catch (err) {
        sendJson(res, 500, { error: 'append failed', detail: String(err && err.message || err) }); return;
    }
    sendJson(res, 200, { ok: true, appended: record });
}

// ---- server -----------------------------------------------------------------
const server = http.createServer((req, res) => {
    (async () => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const p = decodeURIComponent(url.pathname);

        // ---- append-only, token-gated write endpoints ----
        if (req.method === 'POST') {
            if (p === '/api/respond') { await handleRespond(req, res); return; }
            if (p === '/api/review-mark') { await handleReviewMark(req, res); return; } // Morning Review "mark reviewed" (append-only)
            if (p === '/api/preflight') { await handlePreflight(req, res); return; }
            sendJson(res, 404, { error: 'no such write endpoint (only POST /api/respond, /api/review-mark, /api/preflight exist)' });
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(res, 405, 'read-only server — GET/HEAD, plus append-only POST /api/respond or /api/review-mark\n');
            return;
        }

        // ---- GET /api/morning — dual-consumer aggregate (owner tab + orchestrator boot) ----
        if (p === '/api/morning') { serveMorning(res); return; }

        // ---- /docs/<slug>.md — curated narrative-doc snapshots (read-only) ----
        // Raw text passthrough from DOCS_DIR ONLY. The slug guard forbids '/'
        // and '.' sequences outright (no traversal can name a file), and
        // safeJoin is the belt-and-suspenders second gate.
        if (p.startsWith('/docs/')) {
            const name = p.slice('/docs/'.length);
            if (!/^[A-Za-z0-9._-]+\.md$/.test(name)) { sendJson(res, 404, { error: 'not found' }); return; }
            const abs = safeJoin(DOCS_DIR, name);
            if (abs === null || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
                sendJson(res, 404, { error: `no such doc: ${name}` }); return;
            }
            serveStaticFile(res, abs); // .md → text/plain; the UI renders markdown client-side
            return;
        }

        // ---- /data/analytics/<name>.json — the Database tab's analytics plane ----
        // Read-only passthrough from test_results/analytics/ (publish_analytics.mjs
        // output): database_summary.json (the tab feed), index.json (roll-call), and
        // each module's raw result for "view source" traceability. Honest 404 when a
        // result is absent — the tab renders its own "ANALYTICS NOT YET GENERATED"
        // empty state, never a fabricated number.
        if (p.startsWith('/data/analytics/')) {
            const name = p.slice('/data/analytics/'.length);
            if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) { sendJson(res, 404, { error: 'not found' }); return; }
            const abs = safeJoin(ANALYTICS_DIR, name);
            if (abs === null || !fs.existsSync(abs)) {
                sendJson(res, 404, { error: `no such analytics result: ${name}`, detail: 'run node tools/analytics/publish_analytics.mjs to generate it' });
                return;
            }
            serveStaticFile(res, abs);
            return;
        }

        // ---- /data/<name>.json — the data plane ----
        if (p.startsWith('/data/')) {
            const name = p.slice('/data/'.length);
            if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) { sendJson(res, 404, { error: 'not found' }); return; }
            if (name === 'thesis_dashboard_data.json') { serveThesisSnapshot(res); return; }
            if (name === 'token_tracker_data.json') { await serveTokenTracker(res); return; }
            if (name === 'owner_responses.json') { serveOwnerResponses(res); return; }
            if (name === 'response_acks.json') { serveResponseAcks(res); return; }
            if (name === 'work_items.json') { serveWorkItems(res); return; }
            if (name === 'live_ops.json') { serveLiveOps(res); return; } // derived wait-graph (waiting_on.jsonl) — read-only
            if (name === 'docs_manifest.json') {
                // lives under DOCS_DIR (not DATA_DIR); honest 404 if publish_docs.mjs has not run yet
                const mp = path.join(DOCS_DIR, 'docs_manifest.json');
                if (!fs.existsSync(mp)) { sendJson(res, 404, { error: 'docs_manifest.json not built yet — run tools/theses/dashboard/publish_docs.mjs' }); return; }
                serveStaticFile(res, mp); return;
            }
            const abs = safeJoin(DATA_DIR, name);
            if (abs === null || !fs.existsSync(abs)) { sendJson(res, 404, { error: `no such data file: ${name}` }); return; }
            serveStaticFile(res, abs); // read-only passthrough (owner-decisions / flow-stub / any lane's JSON)
            return;
        }

        // ---- static ui/ ----
        if (!fs.existsSync(UI_DIR)) {
            send(res, 503, 'dashboard ui/ not built yet (design lane in flight) — data plane is live at /data/thesis_dashboard_data.json\n');
            return;
        }
        const rel = p === '/' ? 'index.html' : p;
        const abs = safeJoin(UI_DIR, rel);
        if (abs === null) { send(res, 404, 'not found\n'); return; }
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) { serveStaticFile(res, abs); return; }
        // SPA-style fallback: unknown extension-less routes get index.html (tab routing)
        if (!path.extname(rel) && fs.existsSync(path.join(UI_DIR, 'index.html'))) {
            serveStaticFile(res, path.join(UI_DIR, 'index.html'));
            return;
        }
        send(res, 404, 'not found\n');
    })().catch((err) => {
        // Last-ditch guard: nothing (adapter included) may crash the server.
        try { sendJson(res, 500, { error: 'internal error', detail: String(err && err.message || err) }); } catch { /* socket gone */ }
    });
});

let TOKEN_INFO;
try { TOKEN_INFO = ensureToken(); }
catch (err) { console.error(`[serve] FATAL: could not establish write-token: ${err.message}`); process.exit(1); }

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
    console.log('[serve] CSL thesis dashboard (read-only) up:');
    for (const u of urls) console.log('  ' + u);
    console.log(`[serve] data plane: /data/thesis_dashboard_data.json (regenerates per request)`);
    console.log(`[serve]             /data/token_tracker_data.json (adapter if present, else static, else 404)`);
    console.log(`[serve]             /data/owner_responses.json (parsed from owner_responses.jsonl; [] if none)`);
    console.log(`[serve]             /data/response_acks.json (parsed from response_acks.jsonl; [] if none — orchestrator appends, no write endpoint)`);
    console.log(`[serve]             /data/live_ops.json (derived running-now from waiting_on.jsonl launch−complete; honest ledger arithmetic, not a liveness probe)`);
    console.log(`[serve]             /data/docs_manifest.json (curated narrative-doc manifest; 404 until publish_docs.mjs runs)`);
    console.log(`[serve]             /data/<any>.json passthrough from test_results/theses/dashboard/`);
    console.log(`[serve] docs plane: /docs/<slug>.md raw-text passthrough from test_results/theses/dashboard/docs/ (read-only)`);
    console.log(`[serve] morning:    GET /api/morning → dual-consumer aggregate (owner #morning tab + orchestrator boot; read-only, no token)`);
    console.log(`[serve] write plane: POST /api/respond → APPENDS to owner_responses.jsonl (append-only, no update/delete)`);
    console.log(`[serve]             /data/work_items.json (roadmap ledger; 200 {published:false} until work_items.json is written)`);
    console.log(`[serve]              POST /api/review-mark → APPENDS to review_marks.jsonl (Morning Review delta anchor; append-only)`);
    console.log(`[serve]              POST /api/preflight → APPENDS to preflight_manifests.jsonl (append-only; records only, no execution)`);
    console.log(`[serve] write-token (X-Dashboard-Token) ${TOKEN_INFO.generated ? 'NEWLY GENERATED' : 'loaded from .dashboard_token'}: ${TOKEN_INFO.token}`);
    console.log(`[serve]   → paste this once into the dashboard's token box. Home-LAN convenience gate — NOT security-grade auth.`);
    console.log(`[serve]   → token file: ${TOKEN_PATH}`);
});
server.on('error', (err) => {
    console.error(`[serve] listen failed on ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
});
