#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/db/dedup_report.mjs — CONTENT-SHA DEDUP REPORT (TEST_SUITE_PLAN finding B8)
// ═══════════════════════════════════════════════════════════════════════════
// Scans a manifest.json (v1/v2 `frames[]`) OR a ledger.jsonl for frames that
// share a content sha256 — i.e. BYTE-IDENTICAL files enumerated under two paths
// — and restates the corpus stats on the deduplicated denominator. A single
// physical frame counted twice inflates both "unique frames" and "solved":
// collapsing duplicate shas is what makes a population count honest.
//
// REPORT-ONLY. This tool NEVER writes into the manifest/ledger it reads (the
// append-only law): it emits a NEW report to stdout and, with --out, to a NEW
// file. Duplicate rows are reported, never deleted.
//
// keep_policy = 'first-by-path' — among a duplicate group, the lexicographically
// first path is the KEPT representative, the rest are DROP candidates. This is a
// stable, source-independent rule; it happens to keep a canonical top-level
// frame over an `archive/…_DUPLICATE_…` copy (uppercase 'D' < lowercase 'a').
//
// sha source: the recorded per-frame `sha` field is authoritative for the scan
// (both the manifest and the ledger carry the runner's stream-sha). --verify
// re-hashes ONLY the files inside duplicate groups via the shared streaming sha
// helper (tools/testkit/lib/manifest.mjs → sha256Stream) to confirm the recorded
// shas — evidence ADDED, never a weaker check substituted (LAW 2).
//
// Usage:
//   node tools/db/dedup_report.mjs <manifest.json | ledger.jsonl> [--verify] [--out report.json]
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Stream } from '../testkit/lib/manifest.mjs';

export const DEDUP_REPORT_SCHEMA_VERSION = '1.0.0';

// ── extract { path, sha, outcome } rows from a manifest OR a ledger ────────────
// Returns { rows, source_kind, source_meta } — null-honest on missing fields.
export function loadFrames(absInput) {
  const raw = fs.readFileSync(absInput, 'utf8');
  const isJsonl = /\.jsonl$/i.test(absInput);
  let rows = [];
  let source_kind, source_meta = {};
  if (isJsonl) {
    source_kind = 'ledger.jsonl';
    rows = raw.trim().split(/\r?\n/).filter(Boolean).map((line, i) => {
      const o = JSON.parse(line);
      return normalizeRow(o, i);
    });
  } else {
    source_kind = 'manifest.json';
    const m = JSON.parse(raw);
    const arr = Array.isArray(m) ? m : (m.frames ?? m.entries ?? m.rows ?? m.results ?? null);
    if (!Array.isArray(arr)) throw new Error(`no frames[] array found in ${absInput}`);
    source_meta = { label: m.label ?? null, run: m.run ?? null, samples_root: m.samples_root ?? null, n_frames: m.n_frames ?? arr.length };
    rows = arr.map((o, i) => normalizeRow(o, i));
  }
  return { rows, source_kind, source_meta };
}

// path preference: rel (has subdir) > path > id; abs kept for optional --verify.
function normalizeRow(o, i) {
  const p = o.rel ?? o.path ?? o.id ?? `<row_${i}>`;
  return {
    path: String(p),
    sha: o.sha ?? o.frame_sha ?? null,
    outcome: o.outcome ?? null,
    abs: o.abs ?? null,
  };
}

// ── group by sha, isolate duplicate groups, apply keep-policy (PURE) ──────────
export function buildDedup(rows) {
  const bySha = new Map();
  let no_sha = 0;
  for (const r of rows) {
    if (!r.sha) { no_sha++; continue; }
    if (!bySha.has(r.sha)) bySha.set(r.sha, []);
    bySha.get(r.sha).push(r);
  }
  // duplicate groups = a sha carried by >1 path; emit sorted-by-path (keep = first)
  const duplicates = [];
  for (const [sha, group] of bySha) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const paths = sorted.map((r) => r.path);
    const outcomes = {};
    for (const r of sorted) { const k = r.outcome ?? 'null'; outcomes[k] = (outcomes[k] ?? 0) + 1; }
    duplicates.push({
      sha,
      count: sorted.length,
      paths,
      keep_policy: 'first-by-path',
      keep: paths[0],
      drop: paths.slice(1),
      outcomes,               // per-outcome tally within the group (honest: shows both solved)
      _rows: sorted,          // internal (for --verify); stripped from JSON output
    });
  }
  duplicates.sort((a, b) => (a.sha < b.sha ? -1 : 1));
  return { bySha, duplicates, no_sha };
}

// ── restate stats on the deduplicated denominator (PURE) ──────────────────────
// unique_frames = distinct shas. For each outcome, raw = rows with that outcome,
// unique = distinct shas among rows with that outcome (a sha counts once even if
// both physical copies share the outcome).
export function restate(rows, bySha, duplicates, no_sha) {
  const raw_frames = rows.length;
  const unique_frames = bySha.size + no_sha; // no-sha rows can't be collapsed → each stands alone
  const redundant_frames = raw_frames - unique_frames;
  // per-outcome raw vs unique
  const outcomeSet = new Set(rows.map((r) => r.outcome ?? 'null'));
  const outcomes = {};
  for (const oc of [...outcomeSet].sort()) {
    const matching = rows.filter((r) => (r.outcome ?? 'null') === oc);
    const raw = matching.length;
    const uniqueShas = new Set(matching.filter((r) => r.sha).map((r) => r.sha));
    const unshaCount = matching.filter((r) => !r.sha).length;
    outcomes[oc] = { raw, unique: uniqueShas.size + unshaCount };
  }
  return {
    raw_frames,
    unique_frames,
    redundant_frames,
    duplicate_groups: duplicates.length,
    rows_without_sha: no_sha,
    outcomes,
  };
}

// ── optional byte-identity re-verification of the duplicate groups ────────────
async function verifyGroups(duplicates, samplesRoot) {
  const results = [];
  for (const d of duplicates) {
    const perFile = [];
    let confirmed = true, verifiable = true;
    for (const r of d._rows) {
      let abs = r.abs;
      if (!abs && samplesRoot) abs = path.join(samplesRoot, r.path).replace(/\\/g, '/');
      if (!abs || !fs.existsSync(abs)) { perFile.push({ path: r.path, verify: 'file-unavailable' }); verifiable = false; continue; }
      const live = await sha256Stream(abs);
      const match = live === r.sha;
      if (!match) confirmed = false;
      perFile.push({ path: r.path, recorded_sha: r.sha, live_sha: live, match });
    }
    results.push({
      sha: d.sha,
      verifiable,
      byte_identical_confirmed: verifiable && confirmed,
      files: perFile,
    });
  }
  return results;
}

// strip internal _rows before serializing
function publicDup(d) { const { _rows, ...rest } = d; return rest; }

async function main() {
  const argv = process.argv.slice(2);
  const input = argv.find((a) => !a.startsWith('--'));
  const verify = argv.includes('--verify');
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;
  if (!input) {
    console.error('usage: node tools/db/dedup_report.mjs <manifest.json | ledger.jsonl> [--verify] [--out report.json]');
    process.exit(2);
  }
  const absInput = path.resolve(input);
  const { rows, source_kind, source_meta } = loadFrames(absInput);
  const { bySha, duplicates, no_sha } = buildDedup(rows);
  const stats = restate(rows, bySha, duplicates, no_sha);

  let verification = null;
  if (verify) verification = await verifyGroups(duplicates, source_meta.samples_root);

  const report = {
    schema: 'db.dedup_report',
    schema_version: DEDUP_REPORT_SCHEMA_VERSION,
    generated: new Date().toISOString(),
    source: { path: absInput, kind: source_kind, ...source_meta },
    stats,
    duplicates: duplicates.map(publicDup),
    verification,
  };

  // human summary (stdout)
  console.log(`dedup_report — ${source_kind}${source_meta.label ? ` [${source_meta.label}]` : ''}`);
  console.log(`  raw frames        : ${stats.raw_frames}`);
  console.log(`  unique frames     : ${stats.unique_frames}  (distinct sha256)`);
  console.log(`  redundant frames  : ${stats.redundant_frames}  across ${stats.duplicate_groups} duplicate group(s)`);
  if (stats.rows_without_sha) console.log(`  rows without sha  : ${stats.rows_without_sha}  (uncollapsible — counted as unique)`);
  console.log('  outcomes (raw → unique):');
  for (const [oc, v] of Object.entries(stats.outcomes)) {
    console.log(`    ${oc.padEnd(24)} ${String(v.raw).padStart(3)} → ${String(v.unique).padStart(3)}`);
  }
  if (duplicates.length) {
    console.log('  duplicate groups:');
    for (const d of duplicates) {
      console.log(`    sha ${d.sha.slice(0, 16)}…  x${d.count}  keep=${d.keep}`);
      for (const dp of d.drop) console.log(`        drop → ${dp}`);
    }
  } else {
    console.log('  duplicate groups: NONE — every frame sha is unique.');
  }
  if (verification) {
    console.log('  byte-identity re-verification (--verify):');
    for (const v of verification) {
      console.log(`    sha ${v.sha.slice(0, 16)}…  ${v.verifiable ? (v.byte_identical_confirmed ? 'CONFIRMED byte-identical' : 'MISMATCH — recorded sha != live sha') : 'NOT VERIFIABLE (file unavailable)'}`);
    }
  }

  if (outPath) {
    const absOut = path.resolve(outPath);
    fs.writeFileSync(absOut, JSON.stringify(report, null, 2));
    console.log(`  report written → ${absOut}`);
  }
  return report;
}

// run when invoked directly; export the pure guts for reuse/tests
const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) { main().catch((e) => { console.error(e); process.exit(1); }); }
