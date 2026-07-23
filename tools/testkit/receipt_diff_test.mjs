#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/receipt_diff_test.mjs — self-test for receipt_diff.mjs
// ═══════════════════════════════════════════════════════════════════════════
// Plain-assert, vitest-free, node-runnable (tools-lane idiom: gdp_test.mjs /
// mf_test.mjs / selftest_geometry.mjs). Named `*_test.mjs` (underscore) NOT
// `*.test.mjs` (dot) DELIBERATELY — the dot form is swept by vitest 4
// (passWithNoTests:false) and would break the `npx vitest run` gate. This form
// runs standalone:  node tools/testkit/receipt_diff_test.mjs
//
// Hermetic: every run uses a throwaway temp dir, torn down at the end. It spawns
// the REAL CLI (child_process) so the exit-code contract is exercised end to end,
// and also unit-checks pure exports. Covers every verdict class incl. the
// RECOVERY / REGRESSION naming and both keying modes (sha + filename fallback).
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { diffValues, isAllowed, kindOf, keyFor, SHA_FIELD } from './receipt_diff.mjs';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'receipt_diff.mjs');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// ── fixture builders (shapes mirror stages/package.ts buildReceipt output) ────
function solved(over = {}) {
    return { version: '2.13.0', metadata: { camera_model: 'X' }, solution: { ra_hours: 1.5, dec_degrees: 2.5, pixel_scale: 3.6776, confidence: 0.831, stars_matched: 272 }, source_provenance: null, export_date: '2026-07-11T00:00:00.000Z', ...over };
}
function noSolve(over = {}) {
    return { version: '2.13.0', metadata: { camera_model: 'X' }, solution: null, source_provenance: null, export_date: '2026-07-11T00:00:00.000Z', ...over };
}
function writeReceipt(dir, name, obj) { fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2)); }

// ── CLI runner: returns { status, stdout, report } ───────────────────────────
function runCli(args) {
    try {
        const stdout = execFileSync('node', [TOOL, ...args], { encoding: 'utf8' });
        return { status: 0, stdout };
    } catch (e) {
        return { status: e.status ?? -1, stdout: (e.stdout || '') + (e.stderr || '') };
    }
}
function runAndRead(baseline, candidate, extra = []) {
    const jsonOut = path.join(TMP, `out_${Math.random().toString(36).slice(2)}.json`);
    const r = runCli(['--baseline', baseline, '--candidate', candidate, '--json', jsonOut, ...extra]);
    let report = null;
    if (fs.existsSync(jsonOut)) report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    return { ...r, report };
}
function verdictOf(report, key) { return report.frames.find(f => f.key === key); }

// ── temp workspace ────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt_diff_test_'));
try {
    // ───────────────────────────────────────────────────────────────────────
    // (1) Pure-export unit checks
    // ───────────────────────────────────────────────────────────────────────
    eq(SHA_FIELD, 'source_provenance.intake_sha256', 'SHA_FIELD constant');
    eq(kindOf(solved()), 'solved', 'kindOf solved');
    eq(kindOf(noSolve()), 'no_solve', 'kindOf no_solve');
    eq(kindOf({}), 'no_solve', 'kindOf missing solution → no_solve');
    // keying: sha when present, filename otherwise
    eq(keyFor(solved(), 'a.receipt.json').mode, 'filename', 'keyFor null sha → filename mode');
    eq(keyFor(solved(), 'a.receipt.json').key, 'file:a', 'keyFor strips .receipt.json');
    eq(keyFor(solved({ source_provenance: { intake_sha256: 'deadbeef' } }), 'a.receipt.json').mode, 'sha', 'keyFor sha present → sha mode');
    eq(keyFor(solved({ source_provenance: { intake_sha256: 'deadbeef' } }), 'z.json').key, 'sha:deadbeef', 'keyFor uses sha value');
    // exact float diff: 3.6776 vs 3.6777 differ; identical values do not
    {
        const d1 = []; diffValues({ x: 3.6776 }, { x: 3.6776 }, '', d1); eq(d1.length, 0, 'diffValues equal floats → no diff');
        const d2 = []; diffValues({ x: 3.6776 }, { x: 3.6777 }, '', d2); eq(d2.length, 1, 'diffValues differing floats → 1 diff'); eq(d2[0].path, 'x', 'diff path');
        const d3 = []; diffValues({ a: [1, 2] }, { a: [1, 2, 3] }, '', d3); eq(d3.length, 1, 'array length diff → presence leaf'); eq(d3[0].path, 'a[2]', 'array presence path');
        const d4 = []; diffValues({ a: 1 }, { b: 1 }, '', d4); eq(d4.length, 2, 'key present-on-one-side → two presence leaves');
    }
    // allow subtree matching
    ok(isAllowed('export_date', ['export_date']), 'isAllowed exact leaf');
    ok(isAllowed('pipeline_provenance.atlas_id', ['pipeline_provenance']), 'isAllowed subtree root tolerates descendant');
    ok(isAllowed('solution.matched[3].x', ['solution.matched']), 'isAllowed subtree with array index');
    ok(!isAllowed('solution.ra_hours', ['export_date']), 'isAllowed unrelated path not tolerated');

    // ───────────────────────────────────────────────────────────────────────
    // (2) End-to-end CLI: every verdict class, filename keying (sha null)
    // ───────────────────────────────────────────────────────────────────────
    const base = path.join(TMP, 'baseline'); const cand = path.join(TMP, 'candidate');
    fs.mkdirSync(base); fs.mkdirSync(cand);

    // BYTE_IDENTICAL — same bytes both sides
    writeReceipt(base, 'identical.receipt.json', solved());
    writeReceipt(cand, 'identical.receipt.json', solved());
    // FIELD_DIFF (failing) — solution field moved (not allowed)
    writeReceipt(base, 'moved.receipt.json', solved());
    writeReceipt(cand, 'moved.receipt.json', solved({ solution: { ra_hours: 1.5, dec_degrees: 2.5, pixel_scale: 3.7000, confidence: 0.831, stars_matched: 272 } }));
    // FIELD_DIFF allowed-only — only export_date changed (in --allow)
    writeReceipt(base, 'allowed.receipt.json', solved({ export_date: '2026-07-11T00:00:00.000Z' }));
    writeReceipt(cand, 'allowed.receipt.json', solved({ export_date: '2026-07-12T09:09:09.000Z' }));
    // KIND_CHANGED RECOVERY — no_solve → solved
    writeReceipt(base, 'recovered.receipt.json', noSolve());
    writeReceipt(cand, 'recovered.receipt.json', solved());
    // KIND_CHANGED REGRESSION — solved → no_solve
    writeReceipt(base, 'regressed.receipt.json', solved());
    writeReceipt(cand, 'regressed.receipt.json', noSolve());
    // BASELINE_ONLY
    writeReceipt(base, 'onlybase.receipt.json', solved());
    // CANDIDATE_ONLY
    writeReceipt(cand, 'onlycand.receipt.json', solved());

    // Run WITH --allow export_date → the regression makes it fail (exit 1)
    const R = runAndRead(base, cand, ['--allow', 'export_date']);
    eq(R.status, 1, 'CLI exit 1 when a REGRESSION is present');
    ok(R.report, 'CLI wrote --json report');
    eq(verdictOf(R.report, 'file:identical').verdict, 'BYTE_IDENTICAL', 'identical → BYTE_IDENTICAL');
    eq(verdictOf(R.report, 'file:moved').verdict, 'FIELD_DIFF', 'moved → FIELD_DIFF');
    eq(verdictOf(R.report, 'file:moved').fails, true, 'moved FIELD_DIFF fails');
    ok(verdictOf(R.report, 'file:moved').diffs.some(d => d.path === 'solution.pixel_scale' && !d.allowed), 'moved reports solution.pixel_scale as disallowed diff');
    eq(verdictOf(R.report, 'file:allowed').verdict, 'FIELD_DIFF', 'allowed → FIELD_DIFF');
    eq(verdictOf(R.report, 'file:allowed').fails, false, 'allowed-only FIELD_DIFF does not fail');
    ok(verdictOf(R.report, 'file:allowed').diffs.every(d => d.allowed), 'allowed frame: every diff tagged allowed');
    eq(verdictOf(R.report, 'file:recovered').verdict, 'KIND_CHANGED', 'recovered → KIND_CHANGED');
    eq(verdictOf(R.report, 'file:recovered').subtype, 'RECOVERY', 'recovered subtype RECOVERY');
    eq(verdictOf(R.report, 'file:recovered').fails, false, 'RECOVERY does not fail');
    eq(verdictOf(R.report, 'file:regressed').verdict, 'KIND_CHANGED', 'regressed → KIND_CHANGED');
    eq(verdictOf(R.report, 'file:regressed').subtype, 'REGRESSION', 'regressed subtype REGRESSION');
    eq(verdictOf(R.report, 'file:regressed').fails, true, 'REGRESSION fails');
    eq(verdictOf(R.report, 'file:onlybase').verdict, 'BASELINE_ONLY', 'onlybase → BASELINE_ONLY');
    eq(verdictOf(R.report, 'file:onlycand').verdict, 'CANDIDATE_ONLY', 'onlycand → CANDIDATE_ONLY');
    // counts + summary
    eq(R.report.counts.byte_identical, 1, 'count byte_identical');
    eq(R.report.counts.recovery, 1, 'count recovery');
    eq(R.report.counts.regression, 1, 'count regression');
    eq(R.report.counts.field_diff, 1, 'count failing field_diff');
    eq(R.report.counts.field_diff_allowed_only, 1, 'count allowed-only field_diff');
    eq(R.report.counts.baseline_only, 1, 'count baseline_only');
    eq(R.report.counts.candidate_only, 1, 'count candidate_only');
    eq(R.report.allow[0], 'export_date', 'allow list echoed in report');
    ok(/regressions/.test(R.report.summary), 'summary one-liner mentions regressions');

    // ───────────────────────────────────────────────────────────────────────
    // (3) All-pass path: exit 0 when only byte-identical + allowed-only + recovery
    // ───────────────────────────────────────────────────────────────────────
    const b2 = path.join(TMP, 'b2'); const c2 = path.join(TMP, 'c2');
    fs.mkdirSync(b2); fs.mkdirSync(c2);
    writeReceipt(b2, 'a.receipt.json', solved());
    writeReceipt(c2, 'a.receipt.json', solved());
    writeReceipt(b2, 'b.receipt.json', solved({ export_date: 'A' }));
    writeReceipt(c2, 'b.receipt.json', solved({ export_date: 'B' }));
    writeReceipt(b2, 'c.receipt.json', noSolve());
    writeReceipt(c2, 'c.receipt.json', solved()); // RECOVERY
    const P = runAndRead(b2, c2, ['--allow', 'export_date']);
    eq(P.status, 0, 'CLI exit 0 when no failing diff/regression (byte-id + allowed-only + RECOVERY)');
    eq(P.report.verdict, 'PASS', 'report verdict PASS');
    // WITHOUT --allow, the export_date change now fails → exit 1
    const P2 = runAndRead(b2, c2, []);
    eq(P2.status, 1, 'CLI exit 1 when the tolerated field is NOT in --allow (no silent tolerance)');

    // ───────────────────────────────────────────────────────────────────────
    // (4) sha keying: different filenames, same intake_sha256 → matched by sha
    // ───────────────────────────────────────────────────────────────────────
    const b3 = path.join(TMP, 'b3'); const c3 = path.join(TMP, 'c3');
    fs.mkdirSync(b3); fs.mkdirSync(c3);
    const shaRec = solved({ source_provenance: { origin: null, uri: null, fetched_at: null, intake_sha256: 'a'.repeat(64) } });
    writeReceipt(b3, 'baseline_name.receipt.json', shaRec);
    writeReceipt(c3, 'totally_different_name.receipt.json', shaRec);
    const S = runAndRead(b3, c3, []);
    eq(S.status, 0, 'sha-keyed identical frame → exit 0');
    const shaFrame = verdictOf(S.report, `sha:${'a'.repeat(64)}`);
    ok(shaFrame, 'frame keyed under sha:<64hex>');
    eq(shaFrame.key_mode, 'sha', 'sha key_mode reported');
    eq(shaFrame.verdict, 'BYTE_IDENTICAL', 'sha-keyed same content → BYTE_IDENTICAL despite different filenames');

    // ───────────────────────────────────────────────────────────────────────
    // (5) Exit-2 IO/usage paths
    // ───────────────────────────────────────────────────────────────────────
    eq(runCli(['--baseline', base]).status, 2, 'missing --candidate → exit 2');
    eq(runCli(['--baseline', base, '--candidate', path.join(TMP, 'does_not_exist')]).status, 2, 'missing candidate dir → exit 2');
    // unparseable receipt → exit 2
    const b4 = path.join(TMP, 'b4'); const c4 = path.join(TMP, 'c4');
    fs.mkdirSync(b4); fs.mkdirSync(c4);
    writeReceipt(c4, 'ok.receipt.json', solved());
    fs.writeFileSync(path.join(b4, 'corrupt.receipt.json'), '{ not valid json ');
    eq(runCli(['--baseline', b4, '--candidate', c4]).status, 2, 'unparseable receipt → exit 2');
    // ambiguous sha collision within one dir → exit 2
    const b5 = path.join(TMP, 'b5'); const c5 = path.join(TMP, 'c5');
    fs.mkdirSync(b5); fs.mkdirSync(c5);
    writeReceipt(b5, 'one.receipt.json', shaRec);
    writeReceipt(b5, 'two.receipt.json', shaRec); // same sha, two files
    writeReceipt(c5, 'one.receipt.json', shaRec);
    eq(runCli(['--baseline', b5, '--candidate', c5]).status, 2, 'duplicate sha key within a dir → exit 2');
} finally {
    fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nreceipt_diff self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
