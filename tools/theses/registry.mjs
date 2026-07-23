// ═══════════════════════════════════════════════════════════════════════════
// tools/theses/registry.mjs — append-only CSL thesis registry (pre-registration
// integrity ledger)
// ═══════════════════════════════════════════════════════════════════════════
//
// An append-only JSONL log at test_results/theses/registry.jsonl. Three record
// kinds share the file:
//   • register  — mints a thesis entry, content-hashes its JSON at registration
//   • stamp     — an append-only status transition (RUNNING/PASS/FAIL/PARTIAL)
//                 that CHAINS to the registration hash so a post-registration
//                 edit of the frozen thesis is DETECTABLE (integrity_ok=false).
//   • annotate  — (schema 0.2.0, additive) append-only METADATA about a frozen
//                 thesis (e.g. a post-hoc submitter_class provenance stamp).
//                 Chains to the registration hash exactly like a stamp; never
//                 touches the thesis file or its status.
//
// A stamp/annotation NEVER edits a prior line — the log is the audit trail.
// list()/get() FOLD the log into the entry view {id, title, file, sha256,
// schema_version, status, stamps[], annotations[], ts}: `status` = the latest
// stamp's status (or the registration status when unstamped), `stamps[]` =
// every stamp, `annotations[]` = every annotation for that id.
//
// The thesis JSON is written into the SAME directory as registry.jsonl and
// referenced by basename, so {registry.jsonl, <id>.json} move together as a
// self-contained, re-hashable unit.
//
// ZERO third-party deps (node:crypto/fs/path/url only). Writes ONLY under the
// registry dir (default test_results/theses/, override via THESIS_REGISTRY_DIR
// or an explicit { dir }). Honest-or-absent: an absent log reads as no entries.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/** Resolve the registry directory: explicit opt > env > default test_results/theses. */
export function registryDir(opts) {
    if (opts && typeof opts.dir === 'string' && opts.dir.length) return path.resolve(opts.dir);
    if (process.env.THESIS_REGISTRY_DIR && process.env.THESIS_REGISTRY_DIR.length) return path.resolve(process.env.THESIS_REGISTRY_DIR);
    return path.join(ROOT, 'test_results', 'theses');
}
function registryPath(opts) { return path.join(registryDir(opts), 'registry.jsonl'); }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function nowIso() { return new Date().toISOString(); }

/** Read all log lines (chronological). Missing file → []. */
function readLog(opts) {
    const fp = registryPath(opts);
    let txt;
    try { txt = fs.readFileSync(fp, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of txt.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); } catch { /* skip a corrupt line rather than crash the ledger */ }
    }
    return out;
}

function appendLog(record, opts) {
    const dir = registryDir(opts);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(registryPath(opts), JSON.stringify(record) + '\n');
}

/** Re-hash a thesis file (basename resolved against the registry dir). */
function rehashFile(fileBasename, opts) {
    const abs = path.join(registryDir(opts), fileBasename);
    try { return sha256(fs.readFileSync(abs)); } catch { return null; }
}

const STAMP_STATUSES = ['RUNNING', 'PASS', 'FAIL', 'PARTIAL'];

/**
 * Register a thesis (mint entry #N). Serializes the thesis JSON into the
 * registry dir, content-hashes the written bytes, and appends a `register`
 * record. Refuses a duplicate id (append-only ⇒ ids are never re-minted).
 *
 * @param {object} thesis  the validated thesis object (lint it FIRST).
 * @param {{dir?:string, status?:string}} [opts]  status overrides the doc's
 *        registration status (default: thesis.status || 'PRE-REGISTERED').
 * @returns folded entry { id, title, file, sha256, schema_version, status, stamps:[], ts }
 */
export function register(thesis, opts = {}) {
    if (!thesis || typeof thesis !== 'object' || typeof thesis.id !== 'string' || thesis.id.trim().length === 0) {
        throw new Error('register: thesis.id is required');
    }
    const id = thesis.id.trim();
    const existing = readLog(opts).find((r) => r.kind === 'register' && r.id === id);
    if (existing) throw new Error(`register: id "${id}" is already registered (append-only — ids are never re-minted; use stamp to transition status)`);

    const dir = registryDir(opts);
    fs.mkdirSync(dir, { recursive: true });
    const fileBasename = `${id}.json`;
    const bytes = Buffer.from(JSON.stringify(thesis, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, fileBasename), bytes);
    const hash = sha256(bytes);

    const status = (opts.status && typeof opts.status === 'string') ? opts.status : (thesis.status || 'PRE-REGISTERED');
    const record = {
        kind: 'register',
        id,
        title: typeof thesis.title === 'string' ? thesis.title : '',
        file: fileBasename,
        sha256: hash,
        schema_version: typeof thesis.schema_version === 'string' ? thesis.schema_version : 'UNKNOWN',
        status,
        ts: nowIso(),
    };
    appendLog(record, opts);
    return get(id, opts);
}

/**
 * Append a status stamp (RUNNING/PASS/FAIL/PARTIAL only — a stamp can NEVER set
 * PRE-REGISTERED, and can never be applied to an unregistered id). Chains to the
 * registration hash: re-hashes the on-disk thesis and records integrity_ok so a
 * post-registration edit surfaces in the chain.
 *
 * @param {{id:string, status:string, by?:string, evidence_pointer?:string}} params
 * @param {{dir?:string}} [opts]
 * @returns the updated folded entry.
 */
export function stamp(params, opts = {}) {
    const { id, status } = params || {};
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error('stamp: id is required');
    if (!STAMP_STATUSES.includes(status)) {
        throw new Error(`stamp: status must be one of ${STAMP_STATUSES.join('/')} (PRE-REGISTERED is a registration-only status and cannot be re-stamped)`);
    }
    const reg = readLog(opts).find((r) => r.kind === 'register' && r.id === id);
    if (!reg) throw new Error(`stamp: id "${id}" is not registered (register it first)`);

    const currentHash = rehashFile(reg.file, opts);
    const integrity_ok = currentHash !== null && currentHash === reg.sha256;
    const record = {
        kind: 'stamp',
        id,
        status,
        by: typeof params.by === 'string' && params.by.length ? params.by : 'unknown',
        evidence_pointer: typeof params.evidence_pointer === 'string' ? params.evidence_pointer : '',
        sha256: currentHash,               // the thesis hash AT STAMP TIME
        registration_sha256: reg.sha256,   // what it was at registration
        integrity_ok,                      // false ⇒ the frozen thesis was edited after registration
        ts: nowIso(),
    };
    appendLog(record, opts);
    return get(id, opts);
}

/**
 * Append an ANNOTATION to a registered thesis (schema 0.2.0, ADDITIVE record
 * kind). An annotation is append-only metadata ABOUT a frozen thesis — it NEVER
 * edits a prior record and NEVER touches the frozen thesis file or its status.
 * Like a stamp, it CHAINS to the registration hash: it re-hashes the on-disk
 * thesis and records integrity_ok, so the annotation carries the same
 * frozen-content audit continuation the stamp chain does.
 *
 * The founding use (owner-authorized 2026-07-10): retro-stamp the founding
 * AI-bucket thesis with { annotation_type:'provenance', fields:{submitter_class:
 * 'AI-RESEARCHER'}, authorized_by:'owner' } — a provenance classification that
 * post-dates a thesis registered before schema 0.2.0 existed.
 *
 * @param {{id:string, annotation_type:string, fields?:object, note?:string,
 *          by?:string, authorized_by?:string}} params
 * @param {{dir?:string}} [opts]
 * @returns the updated folded entry (now carrying annotations[]).
 */
export function annotate(params, opts = {}) {
    const { id, annotation_type } = params || {};
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error('annotate: id is required');
    if (typeof annotation_type !== 'string' || annotation_type.trim().length === 0) {
        throw new Error('annotate: annotation_type is required (e.g. "provenance")');
    }
    const reg = readLog(opts).find((r) => r.kind === 'register' && r.id === id);
    if (!reg) throw new Error(`annotate: id "${id}" is not registered (register it first)`);

    const currentHash = rehashFile(reg.file, opts);
    const integrity_ok = currentHash !== null && currentHash === reg.sha256;
    const record = {
        kind: 'annotate',
        id,
        annotation_type: annotation_type.trim(),
        fields: (params.fields && typeof params.fields === 'object' && !Array.isArray(params.fields)) ? params.fields : {},
        note: typeof params.note === 'string' ? params.note : '',
        by: typeof params.by === 'string' && params.by.length ? params.by : 'unknown',
        authorized_by: typeof params.authorized_by === 'string' ? params.authorized_by : '',
        sha256: currentHash,               // the thesis hash AT ANNOTATE TIME
        registration_sha256: reg.sha256,   // what it was at registration
        integrity_ok,                      // false ⇒ the frozen thesis was edited after registration
        ts: nowIso(),
    };
    appendLog(record, opts);
    return get(id, opts);
}

/** Fold the log for one id into the entry view (+ live integrity re-check). Null if unregistered. */
export function get(id, opts = {}) {
    const log = readLog(opts);
    const reg = log.find((r) => r.kind === 'register' && r.id === id);
    if (!reg) return null;
    const stamps = log.filter((r) => r.kind === 'stamp' && r.id === id)
        .map((s) => ({ status: s.status, by: s.by, at: s.ts, evidence_pointer: s.evidence_pointer, integrity_ok: s.integrity_ok, sha256: s.sha256 }));
    const annotations = log.filter((r) => r.kind === 'annotate' && r.id === id)
        .map((a) => ({ annotation_type: a.annotation_type, fields: a.fields, note: a.note, by: a.by, authorized_by: a.authorized_by, at: a.ts, integrity_ok: a.integrity_ok, sha256: a.sha256 }));
    const currentStatus = stamps.length ? stamps[stamps.length - 1].status : reg.status;
    const currentHash = rehashFile(reg.file, opts);
    return {
        id: reg.id,
        title: reg.title,
        file: reg.file,
        sha256: reg.sha256,
        schema_version: reg.schema_version,
        status: currentStatus,
        stamps,
        annotations,
        ts: reg.ts,
        // live integrity: does the on-disk thesis still hash to the registration hash?
        integrity: {
            registration_sha256: reg.sha256,
            current_sha256: currentHash,
            ok: currentHash !== null && currentHash === reg.sha256,
            note: currentHash === null ? 'thesis file missing — cannot verify' : (currentHash === reg.sha256 ? 'unmodified since registration' : 'MODIFIED after registration (frozen-content violation)'),
        },
    };
}

/** Fold the whole log into the array of entry views (registration order). */
export function list(opts = {}) {
    const log = readLog(opts);
    return log.filter((r) => r.kind === 'register').map((r) => get(r.id, opts));
}
