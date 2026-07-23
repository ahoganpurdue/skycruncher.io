#!/usr/bin/env node
// ============================================================================
// tools/ops/account_pools.mjs — dual-account pool VISIBILITY (schema + writer/reader)
// ============================================================================
// Owner ruling (dual-account pilot, PILOT_RUNBOOK.md "After a PASS"): shared
// token-pool VISIBILITY + semantic ACCEPT/DEFER/RECOMMEND handoffs between the
// two account orchestrators — ALL INFORMATION, NO AUTOMATION. Nothing in this
// file (or anywhere) routes work based on these numbers; orchestrators read
// the surface and decide.
//
// DATA FILES (both under test_results/theses/dashboard/ — gitignored, local,
// served read-only by the dashboard's generic /data/<name>.json passthrough;
// no server changes needed):
//
//   account_pools.json         — current observed pool state, schema "account-pools/1":
//     {
//       schema: "account-pools/1",
//       generated_at: ISO,
//       accounts: {
//         "<id e.g. A|B>": {
//           label:  string|null,   // e.g. the account email — persists across records
//           role:   string|null,   // e.g. "Opus orchestrator (Ultracode)" — persists
//           five_hour: { utilization_pct: number|null, resets_at: ISO|null },
//           seven_day: { utilization_pct: number|null, resets_at: ISO|null },
//           observed_at: ISO|null, // when the human/orchestrator READ these numbers
//           source: string|null,   // where they came from: "manual /status read",
//                                  // "statusline rate_limits", …
//           note: string           // free-text context
//         }, …
//       }
//     }
//     HONESTY: every number is an OBSERVATION (a /status read or the statusline
//     rate_limits feed), recorded verbatim. A `record` REPLACES the account's
//     metric block wholesale — any metric not passed on that record becomes
//     null (NOT MEASURED) rather than silently carrying a stale value forward
//     from an earlier observation epoch. label/role/note persist.
//
//   pool_handoffs.jsonl        — APPEND-ONLY handoff ledger (source of truth).
//     One JSON object per line:
//       { ts: ISO, action: "ACCEPT"|"DEFER"|"RECOMMEND", item: string,
//         reason: string, from_account: string, to_account: string|null, by: string }
//     Semantics (information, not automation):
//       ACCEPT    — this account takes the named work item.
//       DEFER     — this account parks it (pool headroom / not its lane).
//       RECOMMEND — suggest the other account takes it.
//
//   pool_handoffs.json         — DERIVED read view for the dashboard, schema
//     "pool-handoffs/1": { schema, generated_at, total, handoffs:[newest-first,
//     capped at 50] }. Regenerated from the JSONL after every append; the JSONL
//     is never rewritten.
//
// CLI:
//   node tools/ops/account_pools.mjs report
//   node tools/ops/account_pools.mjs record --account A --source "manual /status read" \
//        [--label x] [--role x] [--five-hour-pct 42] [--five-hour-resets ISO] \
//        [--seven-day-pct 63] [--seven-day-resets ISO] [--note x]
//   node tools/ops/account_pools.mjs handoff --action RECOMMEND --item "..." \
//        [--reason "..."] [--from A] [--to B] [--by "orchestrator-A"]
//
// Never-fatal readers: absent/corrupt file → {ok:false, reason} (the dashboard
// panel renders NOT MEASURED). Writers validate strictly — bad input is refused,
// never half-written. Writes are tmp+rename.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DATA_DIR = path.join(ROOT, 'test_results', 'theses', 'dashboard');
export const POOLS_PATH = path.join(DATA_DIR, 'account_pools.json');
export const HANDOFFS_JSONL_PATH = path.join(DATA_DIR, 'pool_handoffs.jsonl');
export const HANDOFFS_VIEW_PATH = path.join(DATA_DIR, 'pool_handoffs.json');

export const POOLS_SCHEMA = 'account-pools/1';
export const HANDOFFS_SCHEMA = 'pool-handoffs/1';
export const HANDOFF_ACTIONS = ['ACCEPT', 'DEFER', 'RECOMMEND'];
const HANDOFF_VIEW_CAP = 50;

// ---- shared helpers ---------------------------------------------------------

function writeAtomic(fp, text) {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, fp);
}

function isIso(s) {
    return typeof s === 'string' && Number.isFinite(Date.parse(s));
}

// ---- readers (never-fatal) ---------------------------------------------------

/** Read account_pools.json → {ok:true, data} | {ok:false, reason}. Never throws. */
export function readPools() {
    try {
        if (!fs.existsSync(POOLS_PATH)) return { ok: false, reason: `absent: ${POOLS_PATH}` };
        const data = JSON.parse(fs.readFileSync(POOLS_PATH, 'utf8'));
        if (!data || typeof data !== 'object' || data.schema !== POOLS_SCHEMA || typeof data.accounts !== 'object') {
            return { ok: false, reason: `unexpected shape/schema (want ${POOLS_SCHEMA})` };
        }
        return { ok: true, data };
    } catch (err) {
        return { ok: false, reason: String(err && err.message || err) };
    }
}

/** Read the append-only handoff ledger → {ok, lines:[…]} — skips corrupt lines, never invents. */
export function readHandoffs() {
    try {
        if (!fs.existsSync(HANDOFFS_JSONL_PATH)) return { ok: false, lines: [], reason: `absent: ${HANDOFFS_JSONL_PATH}` };
        const lines = [];
        for (const line of fs.readFileSync(HANDOFFS_JSONL_PATH, 'utf8').split(/\r?\n/)) {
            const s = line.trim();
            if (!s) continue;
            try { lines.push(JSON.parse(s)); } catch { /* skip corrupt line — never invent */ }
        }
        return { ok: true, lines };
    } catch (err) {
        return { ok: false, lines: [], reason: String(err && err.message || err) };
    }
}

// ---- writers (strict) ---------------------------------------------------------

function numOrNull(v, name) {
    if (v === undefined || v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${name} must be a number in 0..100 (got: ${v})`);
    return n;
}

function isoOrNull(v, name) {
    if (v === undefined || v === null) return null;
    if (!isIso(v)) throw new Error(`${name} must be an ISO-8601 timestamp (got: ${v})`);
    return v;
}

/** Upsert one account's OBSERVED pool state. Metric block is replaced wholesale
 *  (unpassed metric → null = NOT MEASURED for this observation epoch);
 *  label/role/note persist unless re-given. Returns the written document. */
export function recordObservation(opts) {
    const id = String(opts.account || '').trim();
    if (!id) throw new Error('record: --account is required (e.g. A or B)');
    const source = String(opts.source || '').trim();
    if (!source) throw new Error('record: --source is required (e.g. "manual /status read" or "statusline rate_limits")');

    const prior = readPools();
    const doc = prior.ok ? prior.data : { schema: POOLS_SCHEMA, generated_at: null, accounts: {} };
    const prev = (doc.accounts && doc.accounts[id]) || {};

    doc.accounts[id] = {
        label: opts.label !== undefined ? String(opts.label) : (prev.label ?? null),
        role: opts.role !== undefined ? String(opts.role) : (prev.role ?? null),
        five_hour: {
            utilization_pct: numOrNull(opts.fiveHourPct, '--five-hour-pct'),
            resets_at: isoOrNull(opts.fiveHourResets, '--five-hour-resets'),
        },
        seven_day: {
            utilization_pct: numOrNull(opts.sevenDayPct, '--seven-day-pct'),
            resets_at: isoOrNull(opts.sevenDayResets, '--seven-day-resets'),
        },
        observed_at: new Date().toISOString(),
        source,
        note: opts.note !== undefined ? String(opts.note) : (prev.note ?? ''),
    };
    doc.schema = POOLS_SCHEMA;
    doc.generated_at = new Date().toISOString();
    writeAtomic(POOLS_PATH, JSON.stringify(doc, null, 2) + '\n');
    return doc;
}

/** Append one handoff line (append-only), then regenerate the derived view. */
export function recordHandoff(opts) {
    const action = String(opts.action || '').trim().toUpperCase();
    if (!HANDOFF_ACTIONS.includes(action)) throw new Error(`handoff: --action must be one of ${HANDOFF_ACTIONS.join('|')}`);
    const item = String(opts.item || '').trim();
    if (!item) throw new Error('handoff: --item is required (name the work item)');

    const record = {
        ts: new Date().toISOString(),
        action,
        item,
        reason: opts.reason !== undefined ? String(opts.reason) : '',
        from_account: opts.from !== undefined ? String(opts.from) : null,
        to_account: opts.to !== undefined ? String(opts.to) : null,
        by: opts.by !== undefined ? String(opts.by) : null,
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(HANDOFFS_JSONL_PATH, JSON.stringify(record) + '\n', 'utf8');
    regenerateHandoffView();
    return record;
}

/** Rebuild pool_handoffs.json (derived, capped, newest-first) from the JSONL. */
export function regenerateHandoffView() {
    const led = readHandoffs();
    const view = {
        schema: HANDOFFS_SCHEMA,
        generated_at: new Date().toISOString(),
        total: led.lines.length,
        handoffs: led.lines.slice(-HANDOFF_VIEW_CAP).reverse(),
    };
    writeAtomic(HANDOFFS_VIEW_PATH, JSON.stringify(view, null, 2) + '\n');
    return view;
}

// ---- CLI ----------------------------------------------------------------------

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
        out[key] = next; i++;
    }
    return out;
}

function printReport() {
    const pools = readPools();
    if (!pools.ok) {
        console.log(`[account_pools] NOT MEASURED — ${pools.reason}`);
    } else {
        console.log(`[account_pools] ${POOLS_PATH}`);
        console.log(`  generated_at: ${pools.data.generated_at}`);
        for (const [id, a] of Object.entries(pools.data.accounts)) {
            const f = a.five_hour || {}, s = a.seven_day || {};
            const pct = (v) => (v == null ? 'NOT MEASURED' : `${v}%`);
            console.log(`  [${id}] ${a.label ?? '(no label)'} — ${a.role ?? '(no role)'}`);
            console.log(`      5h: ${pct(f.utilization_pct)} (resets ${f.resets_at ?? 'NOT MEASURED'})`);
            console.log(`      7d: ${pct(s.utilization_pct)} (resets ${s.resets_at ?? 'NOT MEASURED'})`);
            console.log(`      observed ${a.observed_at ?? 'never'} via ${a.source ?? '?'}${a.note ? ` — ${a.note}` : ''}`);
        }
    }
    const led = readHandoffs();
    if (!led.ok) { console.log(`[handoffs] none recorded — ${led.reason}`); return; }
    console.log(`[handoffs] ${led.lines.length} total (newest last 5):`);
    for (const h of led.lines.slice(-5)) {
        console.log(`  ${h.ts}  ${h.action}  ${h.item}${h.from_account ? `  (${h.from_account}→${h.to_account ?? '?'})` : ''}${h.reason ? ` — ${h.reason}` : ''}`);
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const [cmd, ...rest] = process.argv.slice(2);
    const opts = parseArgs(rest);
    try {
        if (cmd === 'report' || cmd === undefined) {
            printReport();
        } else if (cmd === 'record') {
            const doc = recordObservation(opts);
            console.log(`[account_pools] recorded observation for account ${opts.account} → ${POOLS_PATH}`);
            console.log(JSON.stringify(doc.accounts[String(opts.account)], null, 2));
        } else if (cmd === 'handoff') {
            const rec = recordHandoff(opts);
            console.log(`[account_pools] appended handoff → ${HANDOFFS_JSONL_PATH} (+ derived view)`);
            console.log(JSON.stringify(rec));
        } else {
            console.error(`usage: account_pools.mjs report | record --account <id> --source <s> [...] | handoff --action ACCEPT|DEFER|RECOMMEND --item <s> [...]`);
            process.exit(2);
        }
    } catch (err) {
        console.error(`[account_pools] REFUSED: ${err.message}`);
        process.exit(1);
    }
}
