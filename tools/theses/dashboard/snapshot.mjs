#!/usr/bin/env node
// ============================================================================
// tools/theses/dashboard/snapshot.mjs — CSL thesis dashboard data snapshot
// ============================================================================
// Reads the CANONICAL hash-chained registry (test_results/theses/registry.jsonl)
// plus the banked drafts dir and emits the PINNED dashboard contract JSON at
// test_results/theses/dashboard/thesis_dashboard_data.json.
//
// CONTRACT + field provenance: tools/theses/dashboard/CONTRACT.md (pinned —
// the dashboard UI builds against exactly that shape; additive fields are
// documented there, pinned fields are never renamed).
//
// LAW 4 (reuse): folded thesis entries come from tools/theses/registry.mjs
// (the canonical reader — list()/get() already fold stamps/annotations and do
// live per-file integrity re-hash). The CHAIN pass below re-reads the raw
// registry.jsonl lines INDEPENDENTLY because chain verification is a
// first-class output that must be RECOMPUTED, never assumed — and the rolling
// head_hash fold needs the raw stored lines, which registry.mjs does not expose.
//
// LAW 3 (honest-or-absent): absent data = null (UI renders NOT RECORDED).
// Criteria verdicts / kill-clause firing are NOT structured registry fields —
// they are extracted from stamp evidence text by the STRICT rules documented
// in CONTRACT.md §Derivations; anything not confidently extractable is null.
// AI-RESEARCHER and HUMAN buckets are NEVER pooled in any aggregate.
//
// Read-only over its sources; writes ONLY test_results/theses/dashboard/.
// Zero third-party deps (node:fs/path/crypto/url).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { list as registryList, registryDir } from '../registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT_DIR = path.join(ROOT, 'test_results', 'theses', 'dashboard');
const OUT_FILE = path.join(OUT_DIR, 'thesis_dashboard_data.json');
const DRAFTS_DIR = path.join(ROOT, 'test_results', 'theses', 'drafts');
const SCHEMA_TS = path.join(ROOT, 'tools', 'theses', 'thesis_schema.ts');

function sha256Hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

// ---------------------------------------------------------------------------
// Schema version — single source is THESIS_SCHEMA_VERSION in thesis_schema.ts.
// The TS module is not importable from .mjs without a build step, so we regex
// the constant out of the canonical source text (same idiom the schema file
// itself documents for cross-language consumers). Null if unreadable — never
// a hardcoded copy.
// ---------------------------------------------------------------------------
function readSchemaVersion() {
    try {
        const txt = fs.readFileSync(SCHEMA_TS, 'utf8');
        const m = /export const THESIS_SCHEMA_VERSION\s*=\s*'([^']+)'/.exec(txt);
        return m ? m[1] : null;
    } catch { return null; }
}

// ---------------------------------------------------------------------------
// CHAIN — independent recomputation over the raw registry.jsonl lines.
//
// The registry chain is REGISTRATION-HASH-ANCHORED (not line-to-line): every
// stamp/annotate carries registration_sha256 + the thesis re-hash at stamp
// time + integrity_ok, and the frozen thesis file is re-hashable on disk.
// Checks per record (break_at = 1-based line of the FIRST failure):
//   R1 line parses as JSON with a known kind
//   R2 register: id not previously registered; on-disk thesis file exists and
//      sha256(file bytes) === record.sha256 (live frozen-content check)
//   R3 stamp/annotate: a prior register exists for the id;
//      registration_sha256 === that register's sha256;
//      integrity_ok is CONSISTENT: === (sha256 !== null && sha256 === registration_sha256)
//   R4 stamp: status ∈ {RUNNING, PASS, FAIL, PARTIAL}
// head_hash = rolling fold over the raw stored lines (exact bytes, trimmed of
// the line terminator): h_1 = sha256(line_1); h_i = sha256(h_{i-1} + "\n" + line_i).
// Recomputable by anyone from registry.jsonl alone.
// ---------------------------------------------------------------------------
const STAMP_STATUSES = ['RUNNING', 'PASS', 'FAIL', 'PARTIAL'];

function verifyChain() {
    const dir = registryDir();
    const fp = path.join(dir, 'registry.jsonl');
    let txt;
    try { txt = fs.readFileSync(fp, 'utf8'); } catch {
        return { verified: false, records: 0, head_hash: null, break_at: null, break_reason: 'registry.jsonl missing or unreadable' };
    }
    const lines = txt.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    let head = null;
    let breakAt = null;
    let breakReason = null;
    const registers = new Map(); // id -> register record

    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        head = head === null ? sha256Hex(lines[i]) : sha256Hex(head + '\n' + lines[i]);
        if (breakAt !== null) continue; // keep folding head over all lines, but first failure wins

        let rec;
        try { rec = JSON.parse(lines[i]); } catch {
            breakAt = lineNo; breakReason = 'unparseable JSON line'; continue;
        }
        if (rec.kind === 'register') {
            if (registers.has(rec.id)) { breakAt = lineNo; breakReason = `duplicate register for id ${rec.id}`; continue; }
            registers.set(rec.id, rec);
            let fileHash = null;
            try { fileHash = sha256Hex(fs.readFileSync(path.join(dir, rec.file))); } catch { /* missing */ }
            if (fileHash === null) { breakAt = lineNo; breakReason = `frozen thesis file ${rec.file} missing — cannot re-hash`; continue; }
            if (fileHash !== rec.sha256) { breakAt = lineNo; breakReason = `frozen thesis ${rec.file} MODIFIED after registration (re-hash ${fileHash.slice(0, 12)}… ≠ registered ${String(rec.sha256).slice(0, 12)}…)`; continue; }
        } else if (rec.kind === 'stamp' || rec.kind === 'annotate') {
            const reg = registers.get(rec.id);
            if (!reg) { breakAt = lineNo; breakReason = `${rec.kind} for unregistered id ${rec.id}`; continue; }
            if (rec.registration_sha256 !== reg.sha256) { breakAt = lineNo; breakReason = `${rec.kind} registration_sha256 does not chain to the register record for ${rec.id}`; continue; }
            const expectOk = rec.sha256 !== null && rec.sha256 !== undefined && rec.sha256 === rec.registration_sha256;
            if (rec.integrity_ok !== expectOk) { breakAt = lineNo; breakReason = `${rec.kind} integrity_ok inconsistent with its recorded hashes for ${rec.id}`; continue; }
            if (rec.kind === 'stamp' && !STAMP_STATUSES.includes(rec.status)) { breakAt = lineNo; breakReason = `stamp with illegal status "${rec.status}" for ${rec.id}`; continue; }
        } else {
            breakAt = lineNo; breakReason = `unknown record kind "${rec && rec.kind}"`; continue;
        }
    }
    return {
        verified: breakAt === null && lines.length > 0,
        records: lines.length,
        head_hash: head,
        break_at: breakAt,
        break_reason: breakReason, // additive field (null when verified)
    };
}

// ---------------------------------------------------------------------------
// Criteria-verdict extraction from terminal-stamp evidence TEXT.
// The registry has NO structured per-criterion verdicts; these rules are the
// documented, conservative extractor (CONTRACT.md §Derivations). Case-SENSITIVE
// on verdict tokens (the registry writes them uppercase). No match ⇒ null.
// Order: (1) adjacency  (2) slash-group NOT MEASURED  (3) PASSES:/FAIL-grounds spans.
// ---------------------------------------------------------------------------
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function extractCriterionVerdict(id, evidence) {
    if (!evidence) return null;
    const idRe = escapeRe(id);
    // (1) adjacency: "P1 FAIL (…", "P3 PASS byte-identical", "P4 literal-PASS", "P8 NOT MEASURED"
    const adj = new RegExp(`\\b${idRe}\\b(?:\\([^)]{0,12}\\))?[\\s:—–-]*((?:literal-)?PASS|FAIL|NOT[ -]MEASURED)\\b`);
    const mAdj = adj.exec(evidence);
    if (mAdj) return normalizeVerdictToken(mAdj[1]);
    // (2) slash groups: "P5/P8/L2 NOT MEASURED"
    const slash = new RegExp(`\\b${idRe}\\b(?:/[A-Z]?\\d+)*\\s+NOT[ -]MEASURED\\b`);
    if (slash.test(evidence)) return 'NOT-MEASURED';
    // Also match id appearing INSIDE a slash group: "P5/P8/L2 NOT MEASURED" for P8
    const inGroup = new RegExp(`\\b[A-Z]\\d+(?:/[A-Z]?\\d+)*/${idRe}(?:/[A-Z]?\\d+)*\\s+NOT[ -]MEASURED\\b`);
    if (inGroup.test(evidence)) return 'NOT-MEASURED';
    // (3) spans
    const inSpan = (spanText) => spanText !== null && new RegExp(`\\b${idRe}\\b`).test(spanText);
    if (inSpan(passSpan(evidence))) return 'PASS';
    if (inSpan(failSpan(evidence))) return 'FAIL';
    return null;
}
function normalizeVerdictToken(tok) {
    if (/NOT[ -]MEASURED/.test(tok)) return 'NOT-MEASURED';
    if (/PASS$/.test(tok)) return 'PASS';
    return 'FAIL';
}
/** "PASSES:" / "NON-KILL PASSES recorded:" … up to the next FAIL marker (or end). */
function passSpan(evidence) {
    const m = /(?:NON-KILL PASSES recorded:|PASSES:)/.exec(evidence);
    if (!m) return null;
    const rest = evidence.slice(m.index + m[0].length);
    const stop = /\bFAIL\b/.exec(rest);
    return stop ? rest.slice(0, stop.index) : rest;
}
/** "FAIL ground(s) (…):" / "FAIL/KILL ground:" … up to the first ". " (or end). */
function failSpan(evidence) {
    const m = /FAIL(?:\/KILL)?\s+grounds?[^:]{0,80}:/.exec(evidence);
    if (!m) return null;
    const rest = evidence.slice(m.index + m[0].length);
    const stop = rest.indexOf('. ');
    return stop === -1 ? rest : rest.slice(0, stop);
}

// ---------------------------------------------------------------------------
// Kill-clause detection from terminal-stamp evidence text (CONTRACT.md rules).
// true / false only on EXPLICIT registry wording; otherwise null (NOT RECORDED).
// ---------------------------------------------------------------------------
function detectKillClause(evidence) {
    if (!evidence) return null;
    if (/VERDICT=FAIL \(NOT kill/i.test(evidence)) return false;
    if (/VERDICT=FAIL \(KILL/.test(evidence)) return true;
    if (/FAIL(?:\/KILL)?\s+grounds?\s*\(kill[- ]clause\)/i.test(evidence)) return true;
    if (/kill[- ]clause member tripped/i.test(evidence)) return true;
    if (/\bindependent kills\b/.test(evidence)) return true;
    return null;
}

// ---------------------------------------------------------------------------
// verdict_summary — MECHANICAL excerpt of the terminal stamp's evidence text
// (never composed prose). Rules in CONTRACT.md. Null when no terminal stamp.
// ---------------------------------------------------------------------------
const SUMMARY_CAP = 300;
function cap(s) { return s.length > SUMMARY_CAP ? s.slice(0, SUMMARY_CAP) + '…' : s; }
function verdictSummary(status, evidence) {
    if (!evidence) return null;
    const v = evidence.indexOf('VERDICT=');
    if (v !== -1) {
        const rest = evidence.slice(v);
        const stop = rest.indexOf('. ');
        return cap(stop === -1 ? rest : rest.slice(0, stop));
    }
    const fs_ = failSpan(evidence);
    if (fs_ !== null) return cap(`${status} — ${fs_.trim()}`);
    return cap(`${status} — evidence: ${evidence}`);
}

// ---------------------------------------------------------------------------
// Artifact-path extraction: repo-relative path tokens cited in stamp evidence,
// plus the frozen thesis file itself. Mechanical regex, trailing punctuation
// stripped, first-seen order, deduped.
// ---------------------------------------------------------------------------
function extractArtifacts(entry) {
    const texts = entry.stamps.map((s) => s.evidence_pointer || '');
    const found = [`test_results/theses/${entry.file}`];
    const re = /(?:test_results|tools|docs|src)\/[A-Za-z0-9_\-./{},#]+/g;
    for (const t of texts) {
        for (const m of t.matchAll(re)) {
            const p = m[0].replace(/[.,;:)\]}]+$/, '');
            if (!found.includes(p)) found.push(p);
        }
    }
    return found;
}

// ---------------------------------------------------------------------------
// Status mapping (registry → contract enum):
//   PRE-REGISTERED → REGISTERED · RUNNING → RUNNING · PASS → PASS
//   FAIL → FAIL, or FAIL-KILL when kill detection is EXPLICITLY true
//   PARTIAL → PARTIAL (registry-legal but outside the pinned enum — passed
//   through VERBATIM and flagged in notes; none exist today)
// PARKED never occurs for registered theses (it is a drafts-dir status).
// ---------------------------------------------------------------------------
function mapStatus(regStatus, kill) {
    if (regStatus === 'PRE-REGISTERED') return 'REGISTERED';
    if (regStatus === 'FAIL' && kill === true) return 'FAIL-KILL';
    return regStatus;
}

function readJsonSafe(fp) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Build one contract thesis object from a folded registry entry.
// ---------------------------------------------------------------------------
function buildThesis(entry, notes) {
    const doc = readJsonSafe(path.join(registryDir(), entry.file)); // frozen, hash-verified by the chain pass
    if (doc === null) notes.push(`thesis ${entry.id}: frozen file ${entry.file} unreadable — file-sourced fields are null`);

    const terminal = [...entry.stamps].reverse().find((s) => ['PASS', 'FAIL', 'PARTIAL'].includes(s.status)) || null;
    const firstRunning = entry.stamps.find((s) => s.status === 'RUNNING') || null;
    const lastStamp = entry.stamps.length ? entry.stamps[entry.stamps.length - 1] : null;
    const evidence = terminal ? terminal.evidence_pointer : null;
    const kill = terminal ? detectKillClause(evidence) : null;

    // submitter_class: frozen-file field first (hash-anchored), else the
    // owner/orchestrator-authorized provenance ANNOTATION. Disagreement → annotation wins + note.
    const provAnn = entry.annotations.find((a) => a.annotation_type === 'provenance' && a.fields && a.fields.submitter_class);
    const fileClass = doc && typeof doc.submitter_class === 'string' ? doc.submitter_class : null;
    const annClass = provAnn ? provAnn.fields.submitter_class : null;
    let submitterClass = fileClass !== null ? fileClass : annClass;
    if (fileClass !== null && annClass !== null && fileClass !== annClass) {
        submitterClass = annClass;
        notes.push(`thesis ${entry.id}: submitter_class disagreement (file=${fileClass}, annotation=${annClass}) — annotation (authorized retro-stamp) wins`);
    }

    // Deviations: concatenation of every 'deviations' annotation's fields.deviations.
    // [] = zero deviation records appended (a fact, not missing data).
    const deviations = entry.annotations
        .filter((a) => a.annotation_type === 'deviations' && a.fields && Array.isArray(a.fields.deviations))
        .flatMap((a) => a.fields.deviations);

    // actual_wall_minutes: terminal_ts − first RUNNING ts (LEDGER stamp times —
    // batch-appended lifecycles legitimately read ~0.0; the registry records no
    // measured wall time). Null when either stamp is absent.
    let actualWall = null;
    if (firstRunning && terminal) {
        actualWall = Math.round(((Date.parse(terminal.at) - Date.parse(firstRunning.at)) / 60000) * 10) / 10;
    }

    const criteria = (doc && Array.isArray(doc.pass_criteria) ? doc.pass_criteria : []).map((c) => ({
        id: c.id,
        summary: typeof c.description === 'string' ? c.description : null,
        verdict: terminal ? extractCriterionVerdict(c.id, evidence) : null,
    }));

    return {
        id: entry.id,
        title: entry.title || (doc && doc.title) || null,
        submitter_class: submitterClass,
        status: mapStatus(entry.status, kill),
        registered_at: entry.ts,
        stamped_at: lastStamp ? lastStamp.at : null,
        time_budget: doc && doc.time_budget && typeof doc.time_budget === 'object'
            ? {
                est_wall_minutes: typeof doc.time_budget.est_wall_minutes === 'number' ? doc.time_budget.est_wall_minutes : null,
                lane: typeof doc.time_budget.lane === 'string' ? doc.time_budget.lane : null,
            }
            : null,
        actual_wall_minutes: actualWall,
        criteria,
        kill_clause_fired: kill,
        deviations,
        verdict_summary: terminal ? verdictSummary(terminal.status, evidence) : null,
        artifacts: extractArtifacts(entry),
        registry_hash: entry.sha256,
        // ---- additive fields (documented in CONTRACT.md, never renamed) ----
        schema_version: entry.schema_version,
        integrity_ok: entry.integrity ? entry.integrity.ok : null,
        history: [
            { kind: 'register', label: entry.status === 'PRE-REGISTERED' ? 'REGISTERED' : 'REGISTERED', at: entry.ts, by: null },
            ...entry.stamps.map((s) => ({ kind: 'stamp', label: s.status, at: s.at, by: s.by || null })),
            ...entry.annotations.map((a) => ({ kind: 'annotate', label: a.annotation_type, at: a.at, by: a.by || null })),
        ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    };
}

// ---------------------------------------------------------------------------
// Drafts: every *.json in test_results/theses/drafts/ whose id is NOT in the
// registry (a registered draft is a THESIS now). status = PARKED iff the draft
// file itself carries a machine-readable `_disposition`; else DRAFT. Doc-level
// dispositions in drafts/INDEX.md (HOLD/KILL rows) are NOT machine-readable —
// see CONTRACT.md honesty caveats.
// ---------------------------------------------------------------------------
function buildDrafts(registeredIds, notes) {
    let files = [];
    try { files = fs.readdirSync(DRAFTS_DIR).filter((f) => f.endsWith('.json')); } catch {
        notes.push('drafts dir missing — drafts list is empty');
        return [];
    }
    const out = [];
    for (const f of files.sort()) {
        const j = readJsonSafe(path.join(DRAFTS_DIR, f));
        if (j === null || typeof j.id !== 'string') { notes.push(`draft file ${f}: unreadable or id-less — skipped`); continue; }
        if (registeredIds.has(j.id)) continue; // registered ⇒ lives in theses[], not drafts[]
        const disposition = typeof j._disposition === 'string' ? j._disposition : null;
        out.push({
            id: j.id,
            title: typeof j.title === 'string' ? j.title : null,
            status: disposition !== null ? 'PARKED' : 'DRAFT',
            lane: j.time_budget && typeof j.time_budget.lane === 'string' ? j.time_budget.lane : null,
            est_wall_minutes: j.time_budget && typeof j.time_budget.est_wall_minutes === 'number' ? j.time_budget.est_wall_minutes : null,
            // ---- additive fields ----
            disposition,
            schema_version: typeof j.schema_version === 'string' ? j.schema_version : null,
            submitter_class: typeof j.submitter_class === 'string' ? j.submitter_class : null,
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Stats: strictly per-bucket, AI and HUMAN NEVER pooled (no combined totals
// anywhere in this file). A thesis with null submitter_class lands in an
// additive UNCLASSIFIED bucket rather than being silently assigned.
// lifecycles = theses with a terminal stamp (PASS/FAIL/PARTIAL).
// ---------------------------------------------------------------------------
function buildStats(theses) {
    const mk = () => ({ lifecycles: 0, pass: 0, fail: 0, fail_kill: 0, registered: 0, running: 0 });
    const buckets = { 'AI-RESEARCHER': mk(), 'HUMAN': mk() };
    for (const t of theses) {
        const key = t.submitter_class === 'AI-RESEARCHER' || t.submitter_class === 'HUMAN' ? t.submitter_class : 'UNCLASSIFIED';
        if (!buckets[key]) buckets[key] = mk();
        const b = buckets[key];
        b.registered += 1;
        if (t.status === 'RUNNING') b.running += 1;
        if (['PASS', 'FAIL', 'FAIL-KILL', 'PARTIAL'].includes(t.status)) b.lifecycles += 1;
        if (t.status === 'PASS') b.pass += 1;
        if (t.status === 'FAIL' || t.status === 'FAIL-KILL') b.fail += 1;
        if (t.status === 'FAIL-KILL') b.fail_kill += 1;
    }
    return { by_bucket: buckets };
}

// ---------------------------------------------------------------------------
// generateSnapshot() — the whole build. Exported for serve.mjs (regenerate on
// every /data request). writeToDisk=true also refreshes the on-disk artifact.
// ---------------------------------------------------------------------------
export function generateSnapshot({ writeToDisk = true } = {}) {
    const notes = [];
    const chain = verifyChain();
    if (chain.break_reason) notes.push(`CHAIN BREAK at record ${chain.break_at}: ${chain.break_reason}`);

    const entries = registryList(); // LAW 4: canonical folded reader
    const theses = entries.map((e) => buildThesis(e, notes));
    for (const t of theses) {
        if (t.status === 'PARTIAL') notes.push(`thesis ${t.id}: registry status PARTIAL passed through verbatim (outside the pinned enum)`);
        if (t.kill_clause_fired === null && (t.status === 'FAIL' || t.status === 'FAIL-KILL')) {
            notes.push(`thesis ${t.id}: kill-clause firing NOT RECORDED in registry stamp text (null, not false)`);
        }
    }
    const registeredIds = new Set(theses.map((t) => t.id));
    const drafts = buildDrafts(registeredIds, notes);

    const snapshot = {
        generated_at: new Date().toISOString(),
        schema_version: readSchemaVersion(),
        chain,
        theses,
        drafts,
        stats: buildStats(theses),
        // ---- additive fields ----
        source: {
            registry: 'test_results/theses/registry.jsonl',
            drafts_dir: 'test_results/theses/drafts',
            schema: 'tools/theses/thesis_schema.ts',
        },
        notes,
    };

    if (writeToDisk) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(OUT_FILE, JSON.stringify(snapshot, null, 2) + '\n');
    }
    return snapshot;
}

export { OUT_FILE };

// ---- CLI ------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const snap = generateSnapshot({ writeToDisk: true });
    const b = snap.stats.by_bucket;
    const bucketLine = Object.keys(b).map((k) => `${k}: ${b[k].lifecycles} lifecycles (${b[k].pass} PASS / ${b[k].fail} FAIL)`).join(' · ');
    console.log(`[snapshot] wrote ${path.relative(ROOT, OUT_FILE)}`);
    console.log(`[snapshot] chain: verified=${snap.chain.verified} records=${snap.chain.records} head=${snap.chain.head_hash ? snap.chain.head_hash.slice(0, 16) + '…' : 'null'} break_at=${snap.chain.break_at}`);
    console.log(`[snapshot] theses=${snap.theses.length} drafts=${snap.drafts.length} · ${bucketLine}`);
    if (snap.notes.length) console.log(`[snapshot] notes:\n  - ${snap.notes.join('\n  - ')}`);
    process.exitCode = snap.chain.verified ? 0 : 1;
}
