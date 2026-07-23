#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/db/backfill_envelope.mjs — retrofit an EXISTING ledger into the DB feed
// contract (deposit.mjs envelope). Reads a ledger JSONL + its receipts dir and
// EMITS an envelope-conformant JSONL ALONGSIDE — never mutating the original
// (append-only law). Provenance (atlas_id, receipt_schema_version, decoder_arm,
// intake_sha256, solver_version) is READ from receipts where present, and is
// null-honest everywhere it is not recorded (LAW 3 — never guessed).
//
// solver_version note: an old run's actual solver version was never recorded in
// its ledger or receipts, so backfilled rows carry solver_version:null — NOT the
// current git HEAD. Claiming today's HEAD for a past run would be inventing
// provenance. Live deposits (deposit.mjs, git-HEAD-at-runtime) record it going
// forward.
//
// Usage:
//   node tools/db/backfill_envelope.mjs \
//     --ledger  <path/to/ledger_resolved.jsonl> \
//     --receipts <dir with *.receipt.json> \
//     [--manifest <path/to/manifest.json>]   (for run_label + box identity) \
//     [--run-label <LABEL>]                  (overrides manifest.label) \
//     [--out <path>]                         (default <ledger_dir>/ledger_envelope.jsonl)
//
// Prints a JSON coverage summary: how many rows got FULL envelopes (receipt-
// backed provenance) vs PARTIAL (ledger-only, provenance null-honest).
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnvelope, receiptSolverVersion } from './deposit.mjs';

// ── locate a row's receipt on disk (basename join; id fallback) ───────────────
function findReceipt(row, receiptsDir) {
  const cands = [];
  if (typeof row.receipt === 'string' && /\.json$/i.test(row.receipt)) {
    cands.push(path.join(receiptsDir, path.basename(row.receipt)));
    if (path.isAbsolute(row.receipt)) cands.push(row.receipt);
  }
  if (row.id) cands.push(path.join(receiptsDir, `${row.id}.receipt.json`));
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}

// ── core: read ledger + receipts → write envelope JSONL → return stats ────────
// Pure of process.exit; safe to import from the self-test.
export function backfillLedger({ ledger, receiptsDir, manifest = null, out, runLabel = null }) {
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const man = manifest && fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null;
  const label = runLabel || man?.label;
  if (!label) {
    throw new Error('backfill: run_label unresolved — pass --run-label or a --manifest carrying `label` (§5 Stage 10 label contract; deposit refuses unlabeled rows)');
  }
  const box = man ? { host: man.box ?? null, shard_count: 1, run_generated: man.generated ?? null } : null;
  const ts = new Date().toISOString();

  const stats = {
    ledger, receipts_dir: receiptsDir, out, run_label: label,
    rows: rows.length,
    full_envelope: 0,          // receipt-backed: atlas_id AND receipt_schema_version resolved
    partial_envelope: 0,       // ledger-only: those provenance fields null-honest
    receipt_read_ok: 0,
    receipt_read_error: 0,
    receipt_absent: 0,
    frame_sha_present: 0,
    atlas_id_present: 0,
    schema_version_present: 0,
    decoder_arm_present: 0,
    solver_version_present: 0, // expected 0 on legacy corpora — not recorded
    outcomes: {},
  };

  const lines = [];
  for (const row of rows) {
    let receipt = null, readState = 'absent';
    const rp = findReceipt(row, receiptsDir);
    if (rp) {
      try { receipt = JSON.parse(fs.readFileSync(rp, 'utf8')); readState = 'ok'; }
      catch { receipt = null; readState = 'error'; }
    }
    if (readState === 'ok') stats.receipt_read_ok++;
    else if (readState === 'error') stats.receipt_read_error++;
    else stats.receipt_absent++;

    const env = buildEnvelope({
      runLabel: label,
      runId: row.run_id ?? null,
      frameSha: (typeof row.sha === 'string' && row.sha) ? row.sha : null,
      frameShaMode: (typeof row.sha === 'string' && row.sha) ? 'content_sha256' : null,
      receipt,
      receiptPath: (typeof row.receipt === 'string') ? row.receipt : null,
      outcome: row.resolved_outcome ?? row.outcome ?? 'unknown',
      // honest: recover solver_version from the receipt only (null on legacy) —
      // NEVER the current git HEAD (that would misattribute the past run).
      solverVersion: receiptSolverVersion(receipt),
      decoderArm: row.decoder_arm ?? null,          // ledger fallback (used only when no receipt)
      box,
      ts,
      fields: { ...row, backfilled: true, backfill_source: path.basename(ledger) },
    });
    lines.push(JSON.stringify(env));

    // coverage tally
    stats.outcomes[env.outcome] = (stats.outcomes[env.outcome] || 0) + 1;
    if (env.frame_sha != null) stats.frame_sha_present++;
    if (env.atlas_id != null) stats.atlas_id_present++;
    if (env.receipt_schema_version != null) stats.schema_version_present++;
    if (env.decoder_arm != null) stats.decoder_arm_present++;
    if (env.solver_version != null) stats.solver_version_present++;
    if (env.atlas_id != null && env.receipt_schema_version != null) stats.full_envelope++;
    else stats.partial_envelope++;
  }

  // write the derived envelope JSONL ALONGSIDE — never the original ledger.
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''));
  return stats;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { ledger: null, receipts: null, manifest: null, out: null, runLabel: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ledger') o.ledger = argv[++i];
    else if (a === '--receipts') o.receipts = argv[++i];
    else if (a === '--manifest') o.manifest = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--run-label') o.runLabel = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return { o };
}

function main(argv) {
  const { o, error } = parseArgs(argv);
  const usage = 'Usage: node tools/db/backfill_envelope.mjs --ledger <jsonl> --receipts <dir> [--manifest <json>] [--run-label <LABEL>] [--out <jsonl>]';
  if (error) { console.error(`backfill: ${error}\n${usage}`); return 2; }
  if (o.help || !o.ledger || !o.receipts) {
    if (o.help) { console.log(usage); return 0; }
    console.error(`backfill: --ledger and --receipts are required\n${usage}`); return 2;
  }
  if (!fs.existsSync(o.ledger)) { console.error(`backfill: ledger not found: ${o.ledger}`); return 2; }
  const out = o.out || path.join(path.dirname(o.ledger), 'ledger_envelope.jsonl');
  let stats;
  try {
    stats = backfillLedger({ ledger: o.ledger, receiptsDir: o.receipts, manifest: o.manifest, out, runLabel: o.runLabel });
  } catch (e) { console.error(`backfill: ${e.message}`); return 1; }
  console.log(JSON.stringify(stats, null, 2));
  console.log(`\n[backfill] ${stats.rows} rows → ${stats.full_envelope} FULL (receipt-backed) / ${stats.partial_envelope} PARTIAL (ledger-only, provenance null-honest)`);
  console.log(`[backfill] frame_sha ${stats.frame_sha_present}/${stats.rows} · atlas_id ${stats.atlas_id_present}/${stats.rows} · schema_version ${stats.schema_version_present}/${stats.rows} · decoder_arm ${stats.decoder_arm_present}/${stats.rows} · solver_version ${stats.solver_version_present}/${stats.rows} (legacy: not recorded)`);
  console.log(`[backfill] wrote ${out} (original ledger untouched)`);
  return 0;
}

const invokedDirect = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
  catch { return true; }
})();
if (invokedDirect) process.exit(main(process.argv.slice(2)));

export { parseArgs, findReceipt };
