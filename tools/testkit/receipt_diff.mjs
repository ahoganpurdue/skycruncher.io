#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/receipt_diff.mjs — receipt-set replay diff (first brick of the
// receipt-corpus-replay battery, TEST_SUITE_PLAN.md §6: "run tests on the data
// directly").
// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE: compare two receipt SETS (a baseline dir vs a candidate dir), key
// receipts by frame identity, and report — machine-readably — whether the
// candidate moved relative to baseline. This is the primitive that lets a solver
// change be gated on "replay the corpus, nothing moved" instead of a full unit
// battery.
//
// KEYING (frame identity):
//   Primary   — the frame CONTENT sha at `source_provenance.intake_sha256`
//               (SourceProvenance, src/engine/pipeline/m1_ingestion/
//               source_provenance.ts:50; surfaced at receipt top-level
//               `source_provenance`, stages/package.ts:435). This is the sha the
//               intake ledger keys a frame's bytes by.
//   Fallback  — the receipt FILENAME with a trailing `.receipt.json` / `.json`
//               stripped. HONEST FALLBACK: `intake_sha256` is null for every
//               frame that did not come through the intake fetcher (all bundled /
//               local frames — e.g. the entire population_run_2026-07-11 corpus),
//               so filename is the stable on-disk frame identity in that case.
//               Baseline & candidate are the SAME corpus run through two code
//               versions, so a given frame produces the SAME key on both sides
//               (source_provenance is a function of the input bytes, not the
//               solve). The key MODE is reported per frame — never silent.
//
// RECEIPT KINDS (both supported): a SOLVED receipt has a non-null `solution`
//   object; a NO-SOLVE ("failure") receipt has `solution: null`. There is no
//   separate builder — stages/package.ts:273 `buildReceipt` emits `solution:
//   sol ? {…} : null` (package.ts:312) for both. Kind flip:
//     no_solve → solved = RECOVERY (improvement, non-failing)
//     solved → no_solve = REGRESSION (failure)
//
// TOLERANCE: `--allow <path,…>` is the ONLY tolerance mechanism. Listed field
//   paths (and their subtrees) are excluded from FAILING the diff, but are still
//   reported (allowed:true) — never silently dropped. Everything else is EXACT:
//   floats compare by IEEE bit identity (Object.is), NO epsilon, NO fuzzy match.
//
// EXIT: 0 = all byte-identical, or diffs only in --allow paths, or RECOVERY only
//       1 = any FIELD_DIFF (disallowed) or REGRESSION
//       2 = usage / IO error (bad args, missing dir, unparseable receipt,
//           ambiguous key collision)
//
// Usage:
//   node tools/testkit/receipt_diff.mjs --baseline <dir> --candidate <dir> \
//        [--json out.json] [--allow field.path,other.path]
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_FIELD = 'source_provenance.intake_sha256';
const ABSENT = '<absent>';          // presence-diff sentinel (rendered value)
const VAL_CAP = 80;                 // per-value render cap (chars), compact output
const DIFF_CAP = 200;               // per-frame diff cap (deterministic, honest)

// ── CLI parse ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const opts = { baseline: null, candidate: null, json: null, allow: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--baseline') opts.baseline = argv[++i];
        else if (a === '--candidate') opts.candidate = argv[++i];
        else if (a === '--json') opts.json = argv[++i];
        else if (a === '--allow') {
            const v = argv[++i];
            if (v) for (const p of v.split(',')) { const t = p.trim(); if (t) opts.allow.push(t); }
        } else if (a === '--help' || a === '-h') opts.help = true;
        else return { error: `unknown argument: ${a}` };
    }
    // dedupe + sort allow for deterministic output
    opts.allow = [...new Set(opts.allow)].sort();
    return { opts };
}

// ── frame keying ─────────────────────────────────────────────────────────────
function shaOf(receipt) {
    const sp = receipt && receipt.source_provenance;
    const s = sp && typeof sp === 'object' ? sp.intake_sha256 : null;
    return (typeof s === 'string' && s.trim()) ? s.trim() : null;
}
function frameIdFromFilename(file) {
    return file.replace(/\.receipt\.json$/i, '').replace(/\.json$/i, '');
}
function keyFor(receipt, file) {
    const sha = shaOf(receipt);
    return sha
        ? { key: `sha:${sha}`, mode: 'sha' }
        : { key: `file:${frameIdFromFilename(file)}`, mode: 'filename' };
}

// ── receipt kind (solved vs no_solve) ────────────────────────────────────────
function kindOf(receipt) {
    const sol = receipt && receipt.solution;
    return (sol && typeof sol === 'object') ? 'solved' : 'no_solve';
}

// ── value rendering (compact, honest) ────────────────────────────────────────
function renderVal(v) {
    if (v === undefined) return ABSENT;
    if (v === null) return null;
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return v;               // exact scalar
    if (t === 'string') return v.length > VAL_CAP ? v.slice(0, VAL_CAP) + '…' : v;
    // object / array — compact JSON, capped
    let s;
    try { s = JSON.stringify(v); } catch { s = String(v); }
    return s.length > VAL_CAP ? s.slice(0, VAL_CAP) + '…' : s;
}

// ── deep diff (exact; Object.is = IEEE bit identity, no epsilon) ──────────────
// Pushes a leaf {path, baseline, candidate} for every position where the two
// parsed values differ. Arrays/objects are walked by index/key; a key/index
// present on one side only is a presence leaf (value ↔ <absent>).
function diffValues(a, b, p, out) {
    if (Object.is(a, b)) return;
    const aArr = Array.isArray(a), bArr = Array.isArray(b);
    const aObj = a !== null && typeof a === 'object' && !aArr;
    const bObj = b !== null && typeof b === 'object' && !bArr;
    if (aArr && bArr) {
        const n = Math.max(a.length, b.length);
        for (let i = 0; i < n; i++) {
            const cp = `${p}[${i}]`;
            if (i >= a.length) out.push({ path: cp, baseline: ABSENT, candidate: renderVal(b[i]) });
            else if (i >= b.length) out.push({ path: cp, baseline: renderVal(a[i]), candidate: ABSENT });
            else diffValues(a[i], b[i], cp, out);
        }
        return;
    }
    if (aObj && bObj) {
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
        for (const k of keys) {
            const cp = p ? `${p}.${k}` : k;
            const aHas = Object.prototype.hasOwnProperty.call(a, k);
            const bHas = Object.prototype.hasOwnProperty.call(b, k);
            if (!aHas) out.push({ path: cp, baseline: ABSENT, candidate: renderVal(b[k]) });
            else if (!bHas) out.push({ path: cp, baseline: renderVal(a[k]), candidate: ABSENT });
            else diffValues(a[k], b[k], cp, out);
        }
        return;
    }
    // type mismatch or differing scalar → leaf
    out.push({ path: p, baseline: renderVal(a), candidate: renderVal(b) });
}

// ── allow matching: an allow entry matches a diff path if the path IS the entry
//    or is a descendant of it (entry + "." or entry + "["), so naming a subtree
//    root tolerates the whole subtree, naming a leaf tolerates just that leaf. ──
function isAllowed(diffPath, allow) {
    for (const entry of allow) {
        if (diffPath === entry) return true;
        if (diffPath.startsWith(entry + '.') || diffPath.startsWith(entry + '[')) return true;
    }
    return false;
}

// ── directory load ───────────────────────────────────────────────────────────
function loadDir(dir, label) {
    let stat;
    try { stat = fs.statSync(dir); } catch { throw new IoError(`${label} directory not found: ${dir}`); }
    if (!stat.isDirectory()) throw new IoError(`${label} is not a directory: ${dir}`);
    const files = fs.readdirSync(dir).filter(f => /\.json$/i.test(f)).sort();
    const byKey = new Map();
    for (const f of files) {
        const full = path.join(dir, f);
        let text, receipt;
        try { text = fs.readFileSync(full, 'utf8'); } catch (e) { throw new IoError(`cannot read ${label} receipt ${f}: ${e.message}`); }
        try { receipt = JSON.parse(text); } catch (e) { throw new IoError(`cannot parse ${label} receipt ${f}: ${e.message}`); }
        const { key, mode } = keyFor(receipt, f);
        if (byKey.has(key)) throw new IoError(`ambiguous key collision in ${label}: "${key}" from both ${byKey.get(key).file} and ${f}`);
        byKey.set(key, { file: f, text, receipt, mode });
    }
    return byKey;
}
class IoError extends Error {}

// ── core comparison ──────────────────────────────────────────────────────────
function compareSets(baseMap, candMap, allow) {
    const keys = [...new Set([...baseMap.keys(), ...candMap.keys()])].sort();
    const frames = [];
    for (const key of keys) {
        const b = baseMap.get(key);
        const c = candMap.get(key);
        if (b && !c) { frames.push({ key, key_mode: b.mode, verdict: 'BASELINE_ONLY', subtype: null, fails: false, baseline_file: b.file, candidate_file: null, diffs: [] }); continue; }
        if (!b && c) { frames.push({ key, key_mode: c.mode, verdict: 'CANDIDATE_ONLY', subtype: null, fails: false, baseline_file: null, candidate_file: c.file, diffs: [] }); continue; }
        // present on both
        const key_mode = b.mode === c.mode ? b.mode : `${b.mode}/${c.mode}`;
        if (b.text === c.text) { frames.push({ key, key_mode, verdict: 'BYTE_IDENTICAL', subtype: null, fails: false, baseline_file: b.file, candidate_file: c.file, diffs: [] }); continue; }
        // bytes differ — kind flip takes precedence
        const bk = kindOf(b.receipt), ck = kindOf(c.receipt);
        if (bk !== ck) {
            const subtype = (bk === 'no_solve' && ck === 'solved') ? 'RECOVERY'
                : (bk === 'solved' && ck === 'no_solve') ? 'REGRESSION'
                : null; // both non-solved variants can't differ; defensive
            frames.push({ key, key_mode, verdict: 'KIND_CHANGED', subtype, fails: subtype === 'REGRESSION', baseline_kind: bk, candidate_kind: ck, baseline_file: b.file, candidate_file: c.file, diffs: [] });
            continue;
        }
        // same kind, bytes differ → field diff
        const all = [];
        diffValues(b.receipt, c.receipt, '', all);
        // deterministic order already (sorted keys / index order); tag + cap
        const total = all.length;
        const capped = all.slice(0, DIFF_CAP).map(d => ({ ...d, allowed: isAllowed(d.path, allow) }));
        const disallowed = capped.filter(d => !d.allowed).length
            // if capped, disallowed count from the full set (still exact for the cap head)
            + (total > DIFF_CAP ? all.slice(DIFF_CAP).filter(d => !isAllowed(d.path, allow)).length : 0);
        frames.push({
            key, key_mode, verdict: 'FIELD_DIFF', subtype: null,
            fails: disallowed > 0,
            baseline_file: b.file, candidate_file: c.file,
            diff_count: total, disallowed_count: disallowed,
            diffs_truncated: total > DIFF_CAP,
            diffs: capped,
        });
    }
    return frames;
}

function tally(frames) {
    const t = { compared: 0, byte_identical: 0, field_diff: 0, field_diff_allowed_only: 0, recovery: 0, regression: 0, baseline_only: 0, candidate_only: 0 };
    for (const f of frames) {
        if (f.verdict === 'BASELINE_ONLY') { t.baseline_only++; continue; }
        if (f.verdict === 'CANDIDATE_ONLY') { t.candidate_only++; continue; }
        t.compared++; // present on both sides
        if (f.verdict === 'BYTE_IDENTICAL') t.byte_identical++;
        else if (f.verdict === 'KIND_CHANGED') { if (f.subtype === 'RECOVERY') t.recovery++; else if (f.subtype === 'REGRESSION') t.regression++; }
        else if (f.verdict === 'FIELD_DIFF') { if (f.fails) t.field_diff++; else t.field_diff_allowed_only++; }
    }
    return t;
}

function summaryLine(t) {
    const parts = [`${t.byte_identical} byte-identical`];
    if (t.field_diff_allowed_only) parts.push(`${t.field_diff_allowed_only} allowed-only`);
    if (t.recovery) parts.push(`${t.recovery} RECOVERY`);
    if (t.field_diff) parts.push(`${t.field_diff} field-diff`);
    parts.push(`${t.regression} regressions`);
    let s = `${t.compared} compared: ${parts.join(', ')}`;
    if (t.baseline_only || t.candidate_only) s += ` · set mismatch: ${t.baseline_only} baseline-only, ${t.candidate_only} candidate-only`;
    return s;
}

// ── report ───────────────────────────────────────────────────────────────────
function printReport(opts, baseMap, candMap, frames, t) {
    console.log(`receipt_diff — baseline: ${opts.baseline} (${baseMap.size})  candidate: ${opts.candidate} (${candMap.size})`);
    console.log(`key field: ${SHA_FIELD} (fallback: filename)`);
    console.log(`allow: ${opts.allow.length ? '[' + opts.allow.join(', ') + ']' : '(none)'}`);
    for (const f of frames) {
        if (f.verdict === 'BYTE_IDENTICAL') continue; // counted, not listed
        let line = `  ${f.verdict}${f.subtype ? ' ' + f.subtype : ''}  ${f.key} [${f.key_mode}]`;
        if (f.verdict === 'FIELD_DIFF') {
            line += `  (${f.disallowed_count} disallowed / ${f.diff_count} paths${f.diffs_truncated ? `, shown ${f.diffs.length}` : ''})${f.fails ? '' : ' — allowed-only'}`;
            console.log(line);
            for (const d of f.diffs) console.log(`      ${d.allowed ? '·' : '✗'} ${d.path}: ${JSON.stringify(d.baseline)} → ${JSON.stringify(d.candidate)}`);
        } else if (f.verdict === 'KIND_CHANGED') {
            console.log(line + `  (${f.baseline_kind} → ${f.candidate_kind})`);
        } else {
            console.log(line);
        }
    }
    console.log(`\nSUMMARY: ${summaryLine(t)}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
function main(argv) {
    const { opts, error } = parseArgs(argv);
    if (error) { console.error(`receipt_diff: ${error}`); return 2; }
    if (opts.help || !opts.baseline || !opts.candidate) {
        const msg = 'Usage: node tools/testkit/receipt_diff.mjs --baseline <dir> --candidate <dir> [--json out.json] [--allow field.path,...]';
        if (opts.help) { console.log(msg); return 0; }
        console.error(`receipt_diff: --baseline and --candidate are required\n${msg}`);
        return 2;
    }
    let baseMap, candMap;
    try {
        baseMap = loadDir(opts.baseline, 'baseline');
        candMap = loadDir(opts.candidate, 'candidate');
    } catch (e) {
        if (e instanceof IoError) { console.error(`receipt_diff: ${e.message}`); return 2; }
        throw e;
    }
    const frames = compareSets(baseMap, candMap, opts.allow);
    const t = tally(frames);
    const anyFail = frames.some(f => f.fails);
    const exit_code = anyFail ? 1 : 0;
    const report = {
        tool: 'receipt_diff',
        baseline_dir: opts.baseline,
        candidate_dir: opts.candidate,
        sha_field: SHA_FIELD,
        allow: opts.allow,
        counts: t,
        verdict: anyFail ? 'FAIL' : 'PASS',
        exit_code,
        summary: summaryLine(t),
        frames,
    };
    if (opts.json) {
        try {
            fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
            fs.writeFileSync(opts.json, JSON.stringify(report, null, 2));
        } catch (e) { console.error(`receipt_diff: cannot write --json ${opts.json}: ${e.message}`); return 2; }
    }
    printReport(opts, baseMap, candMap, frames, t);
    console.log(`VERDICT: ${report.verdict} (exit ${exit_code})`);
    return exit_code;
}

// Run as CLI when executed directly (not when imported by the self-test).
// fileURLToPath decodes %20/drive-letter correctly on Windows (a raw URL
// pathname compare does not — spaces stay %20-encoded).
const invokedDirect = (() => {
    try {
        return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
    } catch { return true; }
})();
if (invokedDirect) process.exit(main(process.argv.slice(2)));

export { parseArgs, keyFor, kindOf, diffValues, isAllowed, compareSets, tally, summaryLine, main, SHA_FIELD };
