#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/db/deposit.mjs — the DATABASE FEED CONTRACT (TEST_SUITE_PLAN §4-b7 / §5
// Stage 10). One shared depositResult() helper every test lane imports so that
// every deposited row is SELF-DESCRIBING: interpretable without the session that
// produced it. "Everything feeds the database; a row must stand on its own."
// ═══════════════════════════════════════════════════════════════════════════
//
// THE CONTRACT ENVELOPE (row_schema '1.0.0'). Every row a lane deposits carries
// these canonical keys, then spreads its lane-specific payload additively:
//
//   row_schema             — '1.0.0' (this module's ROW_SCHEMA_VERSION)
//   run_id                 — the lane's run/session id (null-honest)
//   run_label              — REQUIRED: QUIET-BASELINE | THROUGHPUT | SHADOW |
//                            RERUN | … — deposit THROWS without one so a
//                            contended-box THROUGHPUT number can never be quoted
//                            as a QUIET-BASELINE latency (§5 Stage 10 label law).
//   ts                     — ISO-8601 deposit time (of THIS row)
//   frame_sha              — frame content identity (null-honest)
//   frame_sha_mode         — where frame_sha came from: 'content_sha256'
//                            (runner stream-sha) | 'intake_sha256' (receipt
//                            source_provenance) | 'absent' (null) — never silent.
//   solver_version         — git HEAD short sha READ AT RUNTIME (never hardcoded)
//                            for live deposits; null-honest when unknown (e.g.
//                            backfilling an old ledger that never recorded it).
//   receipt_schema_version — READ from the receipt's `version` (or an explicit
//                            override, e.g. RECEIPT_SCHEMA_VERSION); null-honest.
//   atlas_id               — READ from receipt.pipeline_provenance.atlas_id;
//                            null-honest when no receipt / no atlas.
//   decoder_arm            — READ from receipt.pipeline_provenance.decoder_arm
//                            when a receipt is present (AUTHORITATIVE — honors the
//                            2.13.0 FITS→null contract); falls back to the lane's
//                            value only when no receipt is available.
//   deposit_identity       — the composite dedupe tuple as a stable string
//                            (frame_sha | solver_version | decoder_arm | atlas_id
//                            | receipt_schema_version). Same tuple = idempotent;
//                            same frame_sha + new solver_version = a NEW row (the
//                            store is append-only — old rows are retained).
//   outcome                — the lane outcome string (solved | no_solve | … )
//   receipt_path           — path to the honest-absent-or-present receipt
//   box                    — { host, shard_count } run/box identity (null-honest)
//   …lane fields           — the lane's own row, spread additively.
//
// ADDITIVE-ONLY DISCIPLINE (DDIA day-one obligation — back/forward compatible):
//   * Consumers MUST tolerate unknown fields (a v1.0.0 reader ignores keys a
//     later producer adds). readEnvelope() below is that tolerant reader.
//   * Producers NEVER rename or remove a contract key. New information is a NEW
//     additive field. A missing block is read as honest-absent `null`, never
//     fabricated (LAW 3).
//   * row_schema bumps are additive + enumerated; old rows stay valid forever.
//
// HONEST-OR-ABSENT (LAW 3): every provenance value here is READ or `null`.
//   Nothing is guessed. In particular solver_version is read from git at runtime
//   for a live run and is `null` (not the current HEAD) when reconstructing an
//   old row whose actual solver version was never recorded — claiming the current
//   HEAD for an old run would be inventing provenance.
//
// ─── THE IMPORT SEAM (how the day lane wires existing lanes; do NOT edit the
//     population runner while its re-run is in flight — this is documentation of
//     the one-line seam, to be applied by the day lane) ───────────────────────
//
//   population_timing_run.mjs (runFrame / runResume, at the two
//   `fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n')` sites):
//
//     import { depositResult } from '../db/deposit.mjs';
//     // …after building `rec` and (for solved) parsing the receipt `r`:
//     depositResult({
//       ledgerPath: ENVELOPE_LEDGER,          // a NEW file, e.g. ledger_envelope.jsonl — never the raw ledger
//       runLabel:   manifest.label,           // 'QUIET-BASELINE' — REQUIRED
//       runId:      rec.run_id,
//       frameSha:   frame.sha,                // runner stream-sha → mode 'content_sha256'
//       receipt:    r ?? null,                // parsed receipt object (or null on no-lock)
//       receiptPath: rec.receipt,
//       outcome:    rec.outcome,
//       box:        { host: manifest.box, shard_count: 1 },
//       fields:     rec,                       // the existing ledger row, spread additively
//     });
//     // solver_version is READ from git HEAD (root defaults to process.cwd()).
//
//   api harness / e2e / testkit lanes call the identical helper with their own
//   `fields`; the envelope keys stay authoritative regardless of lane shape.
//
// Usage (self-describing feed for any lane): `import { depositResult } from
//   'tools/db/deposit.mjs'`. Zero dependencies; ESM; Windows/Linux clean.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ROW_SCHEMA_VERSION = '1.0.0';

// The composite dedupe tuple, in fixed order. A change to this order/set is a
// row_schema bump (never a silent change) — the day-lane's dedupe keys off it.
export const IDENTITY_FIELDS = [
  'frame_sha', 'solver_version', 'decoder_arm', 'atlas_id', 'receipt_schema_version',
];

// The canonical (contract) keys, in emit order. Lane fields spread BEFORE these,
// so the contract values are always authoritative even if a lane row reuses a name.
const ENVELOPE_KEYS = [
  'row_schema', 'run_id', 'run_label', 'ts',
  'frame_sha', 'frame_sha_mode',
  'solver_version', 'receipt_schema_version', 'atlas_id', 'decoder_arm',
  'deposit_identity', 'outcome', 'receipt_path', 'box',
];

// ── git HEAD short sha, READ at runtime, cached per root ──────────────────────
// Never hardcoded. `null` (honest) when git is unavailable or the dir is not a
// repo — a null solver_version is truthful; a fabricated sha is not.
const _gitCache = new Map();
export function gitHeadShort(root = process.cwd()) {
  const key = path.resolve(root);
  if (_gitCache.has(key)) return _gitCache.get(key);
  let sha = null;
  try {
    sha = execFileSync('git', ['-C', key, 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { sha = null; }
  _gitCache.set(key, sha);
  return sha;
}

// ── receipt provenance readers (READ, never guess) ────────────────────────────
function receiptSchemaVersion(receipt) {
  return receipt && typeof receipt.version === 'string' ? receipt.version : null;
}
function receiptAtlasId(receipt) {
  const pp = receipt && receipt.pipeline_provenance;
  return pp && typeof pp === 'object' && typeof pp.atlas_id === 'string' ? pp.atlas_id : null;
}
// Present iff the receipt actually carries the field — so a receipt that
// legitimately says decoder_arm:null (FITS, 2.13.0 contract) is honored, and is
// distinguished from "no receipt at all".
function receiptDecoderArm(receipt) {
  const pp = receipt && receipt.pipeline_provenance;
  if (pp && typeof pp === 'object' && 'decoder_arm' in pp) {
    return { present: true, value: pp.decoder_arm ?? null };
  }
  return { present: false, value: null };
}
// A receipt only records a solver version if a future producer adds one; today
// none do, so this is null for every current receipt (honest).
function receiptSolverVersion(receipt) {
  const pp = receipt && receipt.pipeline_provenance;
  const sp = receipt && receipt.solve_provenance;
  const v = (pp && typeof pp === 'object' && pp.solver_version)
    || (sp && typeof sp === 'object' && sp.solver_version) || null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function receiptIntakeSha(receipt) {
  const sp = receipt && receipt.source_provenance;
  const s = sp && typeof sp === 'object' ? sp.intake_sha256 : null;
  return typeof s === 'string' && s.trim() ? s.trim() : null;
}
export { receiptSolverVersion, receiptIntakeSha };

// ── build the envelope (pure, except the runtime git read on live deposits) ───
//
// ctx:
//   runLabel       REQUIRED non-empty string (else throws)
//   outcome        outcome string (default 'unknown')
//   runId          run/session id | null
//   frameSha       content sha | null            (overridden by receipt intake_sha256 if that is present and no frameSha given)
//   frameShaMode   optional explicit mode; else inferred
//   receipt        parsed receipt object | null (READ for schema/atlas/decoder/intake-sha/solver)
//   receiptPath    string | null
//   solverVersion  undefined → READ git HEAD(root) at runtime (LIVE);
//                  explicit string/null → used as-is (backfill passes recovered-or-null)
//   decoderArm     lane fallback used ONLY when no receipt is provided
//   atlasId        explicit override (rare); else read from receipt
//   receiptSchemaVersion  explicit override (e.g. RECEIPT_SCHEMA_VERSION); else read from receipt
//   root           dir to read git HEAD from (default process.cwd())
//   box            { host, shard_count } | null
//   ts             ISO string (default now)
//   fields         lane-specific object, spread additively
export function buildEnvelope(ctx = {}) {
  if (typeof ctx.runLabel !== 'string' || !ctx.runLabel.trim()) {
    throw new Error(
      'deposit: run_label is REQUIRED (QUIET-BASELINE | THROUGHPUT | SHADOW | RERUN | …). ' +
      'Refusing to deposit an unlabeled row — an unlabeled benchmark number is not interpretable (§5 Stage 10 label contract).',
    );
  }
  const receipt = ctx.receipt ?? null;

  // frame_sha + honest mode. A receipt intake_sha256 (content-addressed by the
  // intake ledger) is preferred when present and no explicit frameSha was given.
  let frame_sha = ctx.frameSha ?? null;
  let frame_sha_mode = ctx.frameShaMode ?? null;
  if (frame_sha == null) {
    const intake = receiptIntakeSha(receipt);
    if (intake) { frame_sha = intake; frame_sha_mode = frame_sha_mode ?? 'intake_sha256'; }
  } else if (frame_sha_mode == null) {
    frame_sha_mode = 'content_sha256';
  }
  if (frame_sha == null) frame_sha_mode = 'absent';

  // solver_version: undefined ctx → READ git HEAD (live); explicit → as-is.
  const solver_version = (ctx.solverVersion === undefined)
    ? gitHeadShort(ctx.root)
    : (ctx.solverVersion ?? null);

  // receipt-authoritative reads (honor a receipt's legitimate null).
  const receipt_schema_version = (ctx.receiptSchemaVersion !== undefined && ctx.receiptSchemaVersion !== null)
    ? ctx.receiptSchemaVersion
    : receiptSchemaVersion(receipt);
  const atlas_id = (ctx.atlasId !== undefined && ctx.atlasId !== null)
    ? ctx.atlasId
    : receiptAtlasId(receipt);
  const dec = receiptDecoderArm(receipt);
  const decoder_arm = dec.present ? dec.value : (ctx.decoderArm ?? null);

  const canonical = {
    row_schema: ROW_SCHEMA_VERSION,
    run_id: ctx.runId ?? null,
    run_label: ctx.runLabel.trim(),
    ts: ctx.ts ?? new Date().toISOString(),
    frame_sha,
    frame_sha_mode,
    solver_version,
    receipt_schema_version,
    atlas_id,
    decoder_arm,
    deposit_identity: null,          // filled below once fields settle
    outcome: ctx.outcome ?? 'unknown',
    receipt_path: ctx.receiptPath ?? null,
    box: ctx.box ?? null,
  };
  canonical.deposit_identity = identityOf(canonical);

  // lane fields FIRST, contract keys OVERLAY — contract stays authoritative.
  const laneFields = (ctx.fields && typeof ctx.fields === 'object' && !Array.isArray(ctx.fields)) ? ctx.fields : {};
  return { ...laneFields, ...canonical };
}

// composite dedupe identity string, in fixed IDENTITY_FIELDS order (∅ for null).
export function identityOf(env) {
  return IDENTITY_FIELDS.map((k) => {
    const v = env[k];
    return (v === null || v === undefined) ? '∅' : String(v);
  }).join('|');
}

// forward-compatible reader: return the canonical view, tolerating (ignoring)
// any unknown/future fields. Missing contract keys read as honest-absent null.
export function readEnvelope(row) {
  const view = {};
  for (const k of ENVELOPE_KEYS) view[k] = (k in row) ? row[k] : null;
  return view;
}

// ── deposit: build + append one JSONL row (append-only). Returns the envelope ──
export function depositResult(ctx = {}) {
  if (typeof ctx.ledgerPath !== 'string' || !ctx.ledgerPath) {
    throw new Error('deposit: ledgerPath (target JSONL) is required');
  }
  const env = buildEnvelope(ctx);
  fs.mkdirSync(path.dirname(path.resolve(ctx.ledgerPath)), { recursive: true });
  fs.appendFileSync(ctx.ledgerPath, JSON.stringify(env) + '\n');
  return env;
}
