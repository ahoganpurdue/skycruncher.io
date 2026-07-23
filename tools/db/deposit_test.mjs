#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/db/deposit_test.mjs — self-test for the DB feed contract (deposit.mjs +
// backfill_envelope.mjs). Plain-assert, vitest-free, node-runnable (tools-lane
// idiom: receipt_diff_test.mjs / gdp_test.mjs). Named `*_test.mjs` (underscore)
// NOT `*.test.mjs` DELIBERATELY — the dot form is swept by vitest and would break
// the `npx vitest run` gate. Run standalone:  node tools/db/deposit_test.mjs
//
// Covers: envelope shape · required-label enforcement · additive tolerance
// (unknown fields pass through, tolerant reader) · null-honesty (receipt-absent →
// provenance null; solver_version never invented) · authoritative decoder_arm
// (receipt-null honored over a wrong ledger guess) · composite identity/dedupe ·
// append-only deposit · backfill on synthetic fixtures + original-untouched.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROW_SCHEMA_VERSION, IDENTITY_FIELDS,
  buildEnvelope, depositResult, identityOf, readEnvelope, gitHeadShort,
} from './deposit.mjs';
import { backfillLedger } from './backfill_envelope.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function throws(fn, msg) { let t = false; try { fn(); } catch { t = true; } ok(t, msg); }

// receipt fixtures mirror stages/package.ts buildReceipt shape.
function fitsReceipt(over = {}) {
  return {
    version: '2.13.0',
    solution: { ra_hours: 0.5, dec_degrees: 41.2, pixel_scale: 3.6, confidence: 0.83, stars_matched: 272 },
    source_provenance: null,
    pipeline_provenance: { decoder_arm: null, atlas_id: 'atlas_fits_abc', atlas_version_source: 'binary_layouts#atlas_rows' },
    solve_provenance: { solved_via: 'assisted:metadata' },
    ...over,
  };
}
function cr2Receipt(over = {}) {
  return {
    version: '2.13.0',
    solution: { ra_hours: 17.6, dec_degrees: -33.1, pixel_scale: 63.4, confidence: 0.68, stars_matched: 79 },
    source_provenance: null,
    pipeline_provenance: { decoder_arm: 'rawler', atlas_id: 'atlas_cr2_xyz', atlas_version_source: 'binary_layouts#atlas_rows' },
    solve_provenance: { solved_via: 'blind' },
    ...over,
  };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deposit_test_'));
try {
  // ───────────────────────────────────────────────────────────────────────
  // (1) Envelope shape — CR2 solved, receipt-backed provenance
  // ───────────────────────────────────────────────────────────────────────
  const e1 = buildEnvelope({
    runLabel: 'QUIET-BASELINE', runId: 'session_1', frameSha: 'a'.repeat(64),
    receipt: cr2Receipt(), receiptPath: 'receipts/x.receipt.json', outcome: 'solved',
    solverVersion: 'deadbee', box: { host: 'AdamDesktop', shard_count: 1 },
    fields: { ra_hours: 17.6, stars_matched: 79 },
  });
  eq(e1.row_schema, ROW_SCHEMA_VERSION, 'row_schema is 1.0.0');
  eq(e1.run_label, 'QUIET-BASELINE', 'run_label carried');
  eq(e1.frame_sha, 'a'.repeat(64), 'frame_sha carried');
  eq(e1.frame_sha_mode, 'content_sha256', 'frame_sha_mode content_sha256 when frameSha given');
  eq(e1.receipt_schema_version, '2.13.0', 'schema_version READ from receipt.version');
  eq(e1.atlas_id, 'atlas_cr2_xyz', 'atlas_id READ from receipt.pipeline_provenance');
  eq(e1.decoder_arm, 'rawler', 'decoder_arm READ authoritative from receipt (rawler)');
  eq(e1.solver_version, 'deadbee', 'solver_version explicit override honored');
  eq(e1.outcome, 'solved', 'outcome carried');
  eq(e1.receipt_path, 'receipts/x.receipt.json', 'receipt_path carried');
  eq(e1.ra_hours, 17.6, 'lane field ra_hours spread additively');
  eq(e1.stars_matched, 79, 'lane field stars_matched spread additively');
  ok(typeof e1.deposit_identity === 'string' && e1.deposit_identity.includes('rawler'), 'deposit_identity is a composite string');
  eq(e1.deposit_identity, `${'a'.repeat(64)}|deadbee|rawler|atlas_cr2_xyz|2.13.0`, 'deposit_identity tuple order = IDENTITY_FIELDS');
  eq(IDENTITY_FIELDS.length, 5, 'identity tuple has 5 fields');

  // ───────────────────────────────────────────────────────────────────────
  // (2) Authoritative decoder_arm — FITS receipt says null; a WRONG ledger
  //     guess must NOT override it (the b2 honesty point).
  // ───────────────────────────────────────────────────────────────────────
  const e2 = buildEnvelope({
    runLabel: 'QUIET-BASELINE', receipt: fitsReceipt(), outcome: 'solved',
    decoderArm: 'rawler',   // a WRONG format-guess from the ledger
    solverVersion: null,
  });
  eq(e2.decoder_arm, null, 'FITS receipt decoder_arm:null WINS over a wrong ledger guess (authoritative)');
  eq(e2.atlas_id, 'atlas_fits_abc', 'FITS atlas_id READ from receipt');

  // no-receipt: the ledger fallback is used (only place a guess is allowed).
  const e2b = buildEnvelope({ runLabel: 'RERUN', receipt: null, decoderArm: 'rawler', outcome: 'solved', solverVersion: null });
  eq(e2b.decoder_arm, 'rawler', 'no receipt → ledger decoder_arm fallback used');
  eq(e2b.atlas_id, null, 'no receipt → atlas_id null-honest');
  eq(e2b.receipt_schema_version, null, 'no receipt → schema_version null-honest');

  // ───────────────────────────────────────────────────────────────────────
  // (3) Required-label enforcement (§5 Stage 10 label contract)
  // ───────────────────────────────────────────────────────────────────────
  throws(() => buildEnvelope({ receipt: null, outcome: 'solved' }), 'buildEnvelope throws with no run_label');
  throws(() => buildEnvelope({ runLabel: '', outcome: 'solved' }), 'buildEnvelope throws with empty run_label');
  throws(() => buildEnvelope({ runLabel: '   ', outcome: 'solved' }), 'buildEnvelope throws with whitespace run_label');
  throws(() => depositResult({ runLabel: 'QUIET-BASELINE' }), 'depositResult throws with no ledgerPath');

  // ───────────────────────────────────────────────────────────────────────
  // (4) Null-honesty — absent provenance is null, solver_version never invented
  // ───────────────────────────────────────────────────────────────────────
  const e4 = buildEnvelope({ runLabel: 'SHADOW', receipt: null, outcome: 'no_solve', solverVersion: null });
  eq(e4.frame_sha, null, 'no frameSha → null');
  eq(e4.frame_sha_mode, 'absent', 'no frameSha → mode absent (honest, never silent)');
  eq(e4.solver_version, null, 'explicit null solver_version stays null (not invented)');
  eq(e4.atlas_id, null, 'atlas_id null when absent');
  // intake_sha256 preference when no explicit frameSha
  const e4b = buildEnvelope({ runLabel: 'RERUN', receipt: fitsReceipt({ source_provenance: { intake_sha256: 'f'.repeat(64) } }), outcome: 'solved', solverVersion: null });
  eq(e4b.frame_sha, 'f'.repeat(64), 'receipt intake_sha256 used as frame_sha when none given');
  eq(e4b.frame_sha_mode, 'intake_sha256', 'frame_sha_mode intake_sha256 when sourced from receipt');
  // solver_version READ path (undefined ctx) — reads git HEAD of this repo; string-or-null, never throws.
  const e4c = buildEnvelope({ runLabel: 'QUIET-BASELINE', receipt: null, outcome: 'solved' });
  ok(e4c.solver_version === null || (typeof e4c.solver_version === 'string' && e4c.solver_version.length > 0), 'undefined solverVersion → git HEAD read (string) or null, never fabricated');
  ok(gitHeadShort('/no/such/repo/dir/xyz') === null, 'gitHeadShort on a non-repo dir → null (honest)');

  // ───────────────────────────────────────────────────────────────────────
  // (5) Additive tolerance — unknown/future fields pass through; tolerant reader
  // ───────────────────────────────────────────────────────────────────────
  const e5 = buildEnvelope({ runLabel: 'THROUGHPUT', receipt: cr2Receipt(), outcome: 'solved', solverVersion: 'v1',
    fields: { future_unknown_block: { deep: [1, 2, 3] }, wall_ms: 1234 } });
  eq(e5.future_unknown_block.deep[1], 2, 'unknown future field passes through untouched (producer additive)');
  eq(e5.wall_ms, 1234, 'lane wall_ms passes through');
  // a lane field that collides with a contract key must NOT override the contract
  const e5c = buildEnvelope({ runLabel: 'THROUGHPUT', receipt: null, outcome: 'solved', solverVersion: 'v1',
    fields: { outcome: 'LIAR', row_schema: '9.9.9', decoder_arm: 'LIAR' } });
  eq(e5c.outcome, 'solved', 'contract outcome authoritative over a colliding lane field');
  eq(e5c.row_schema, ROW_SCHEMA_VERSION, 'contract row_schema authoritative over a colliding lane field');
  // tolerant reader: a row with an unknown key still yields the full canonical view
  const futureRow = { ...e5, brand_new_v2_field: 'hello' };
  const view = readEnvelope(futureRow);
  eq(view.row_schema, ROW_SCHEMA_VERSION, 'readEnvelope returns row_schema, ignoring unknown keys');
  eq(view.atlas_id, 'atlas_cr2_xyz', 'readEnvelope returns atlas_id');
  ok(!('brand_new_v2_field' in view), 'readEnvelope ignores unknown future field (forward-compat)');
  // a v-old row missing a later contract key reads that key as honest-absent null
  const oldRow = { row_schema: '1.0.0', run_label: 'X', frame_sha: null };
  eq(readEnvelope(oldRow).atlas_id, null, 'readEnvelope treats a missing contract key as honest-absent null');

  // ───────────────────────────────────────────────────────────────────────
  // (6) Composite identity / dedupe — same sha + new solver_version = new row
  // ───────────────────────────────────────────────────────────────────────
  const base = { frame_sha: 's', solver_version: 'v1', decoder_arm: 'rawler', atlas_id: 'a', receipt_schema_version: '2.13.0' };
  const same = { ...base };
  const newVer = { ...base, solver_version: 'v2' };
  eq(identityOf(base), identityOf(same), 'identical tuple → identical identity (idempotent no-dup)');
  ok(identityOf(base) !== identityOf(newVer), 'same sha + new solver_version → DIFFERENT identity (new retained row)');
  eq(identityOf({ frame_sha: null }), '∅|∅|∅|∅|∅', 'identity renders nulls as ∅ deterministically');

  // ───────────────────────────────────────────────────────────────────────
  // (7) depositResult append — JSONL, append-only
  // ───────────────────────────────────────────────────────────────────────
  const dled = path.join(TMP, 'sub', 'deposit.jsonl');   // nested dir → auto-mkdir
  const d1 = depositResult({ ledgerPath: dled, runLabel: 'QUIET-BASELINE', frameSha: 'a', receipt: cr2Receipt(), outcome: 'solved', solverVersion: 'v1', fields: { seq: 1 } });
  depositResult({ ledgerPath: dled, runLabel: 'QUIET-BASELINE', frameSha: 'b', receipt: fitsReceipt(), outcome: 'solved', solverVersion: 'v1', fields: { seq: 2 } });
  const dlines = fs.readFileSync(dled, 'utf8').trim().split('\n');
  eq(dlines.length, 2, 'depositResult appended 2 rows (append-only)');
  eq(JSON.parse(dlines[0]).seq, 1, 'first deposit retained after the second (append-only)');
  eq(JSON.parse(dlines[0]).deposit_identity, d1.deposit_identity, 'returned envelope matches the written row');

  // ───────────────────────────────────────────────────────────────────────
  // (8) Backfill on synthetic fixtures — full vs partial coverage; original untouched
  // ───────────────────────────────────────────────────────────────────────
  const runDir = path.join(TMP, 'run'); const recDir = path.join(runDir, 'receipts');
  fs.mkdirSync(recDir, { recursive: true });
  // solved row WITH a receipt on disk → FULL envelope
  fs.writeFileSync(path.join(recDir, 'frameA.fit.receipt.json'), JSON.stringify(fitsReceipt()));
  // a corrupt receipt to exercise the read-error path (still emits a partial row)
  fs.writeFileSync(path.join(recDir, 'frameC.CR2.receipt.json'), '{ not valid json ');
  const ledgerRows = [
    { id: 'frameA.fit', sha: '1'.repeat(64), decoder_arm: null, outcome: 'solved', resolved_outcome: 'solved', run_id: 'session_1', receipt: 'receipts/frameA.fit.receipt.json' },
    { id: 'frameB.CR2', sha: '2'.repeat(64), decoder_arm: 'rawler', outcome: 'error', resolved_outcome: 'no_solve', run_id: null, receipt: 'ABSENT — guard-throw' },
    { id: 'frameC.CR2', sha: '3'.repeat(64), decoder_arm: 'rawler', outcome: 'solved', resolved_outcome: 'solved', run_id: 'session_2', receipt: 'receipts/frameC.CR2.receipt.json' },
  ];
  const ledgerPath = path.join(runDir, 'ledger_resolved.jsonl');
  fs.writeFileSync(ledgerPath, ledgerRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const manifestPath = path.join(runDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ label: 'QUIET-BASELINE', box: 'AdamDesktop', generated: '2026-07-11T00:00:00Z' }));
  const ledgerBytesBefore = fs.readFileSync(ledgerPath);

  const outPath = path.join(runDir, 'ledger_envelope.jsonl');
  const stats = backfillLedger({ ledger: ledgerPath, receiptsDir: recDir, manifest: manifestPath, out: outPath });

  eq(stats.rows, 3, 'backfill processed all rows');
  eq(stats.full_envelope, 1, 'exactly 1 FULL envelope (frameA — receipt readable)');
  eq(stats.partial_envelope, 2, '2 PARTIAL envelopes (frameB absent, frameC corrupt)');
  eq(stats.frame_sha_present, 3, 'frame_sha present on all rows (ledger sha)');
  eq(stats.atlas_id_present, 1, 'atlas_id only for the receipt-backed row');
  eq(stats.schema_version_present, 1, 'schema_version only for the receipt-backed row');
  eq(stats.solver_version_present, 0, 'solver_version 0/3 — legacy corpus never recorded it (honest null, not git HEAD)');
  eq(stats.receipt_read_ok, 1, '1 receipt read ok');
  eq(stats.receipt_read_error, 1, '1 corrupt receipt counted as read_error');
  eq(stats.receipt_absent, 1, '1 receipt absent');
  const outRows = fs.readFileSync(outPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq(outRows.length, 3, 'backfill emitted 3 envelope rows');
  eq(outRows[0].atlas_id, 'atlas_fits_abc', 'frameA envelope has atlas_id from receipt');
  eq(outRows[0].decoder_arm, null, 'frameA decoder_arm authoritative null (FITS receipt) over ledger null');
  eq(outRows[0].frame_sha_mode, 'content_sha256', 'backfill frame_sha_mode content_sha256 (ledger stream-sha)');
  eq(outRows[1].atlas_id, null, 'frameB (no receipt) atlas_id null-honest');
  eq(outRows[1].decoder_arm, 'rawler', 'frameB (no receipt) decoder_arm from ledger fallback');
  eq(outRows[1].outcome, 'no_solve', 'frameB outcome uses resolved_outcome');
  eq(outRows[1].backfilled, true, 'backfilled marker present');
  eq(outRows[2].atlas_id, null, 'frameC (corrupt receipt) atlas_id null-honest');
  eq(outRows[2].run_id, 'session_2', 'frameC run_id carried');
  // append-only: the ORIGINAL ledger was never mutated
  ok(Buffer.compare(ledgerBytesBefore, fs.readFileSync(ledgerPath)) === 0, 'original ledger byte-identical after backfill (never mutated)');

  // backfill refuses without a resolvable label
  fs.writeFileSync(path.join(runDir, 'manifest_nolabel.json'), JSON.stringify({ box: 'X' }));
  throws(() => backfillLedger({ ledger: ledgerPath, receiptsDir: recDir, manifest: path.join(runDir, 'manifest_nolabel.json'), out: path.join(TMP, 'nope.jsonl') }), 'backfill throws when no run_label resolvable');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\ndeposit self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
