#!/usr/bin/env node
// etl_receipts.mjs — flatten banked solve/crash receipts into partitioned parquet.
// ============================================================================
// FIRST (full) data load of the ruled DuckDB-over-R2 results architecture (owner
// 2026-07-16). TEST/DEV tier — the schema is NOT locked; column choices here are
// a v0 proposal, not doctrine.
//
// The receipt-field -> column FLATTEN lives in lib/flatten.mjs (single source of
// truth, shared with the incremental drain_to_r2.mjs — CLAUDE.md LAW 4). This
// file owns only discovery, dedup, and the JSONL->parquet DuckDB build.
//
// FOUR tables (parquet, hive-partitioned by schema_version = receipt `version`):
//   frames      — one row per DISTINCT receipt (dedup on receipt_sha256).
//   stars       — one row per catalog-grade per-star product (matched|photometry|confirmed).
//   detections  — one row per raw pre-match detection (clean_stars kept + anomalies rejected).
//   crashes     — one row per *.crash.json forensics record.
//
// Reads only emitted receipts; never loads a corpus binary. Big receipts (up to
// ~150MB) parse under a bumped heap (npm run etl => --max-old-space-size=8192).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  sha256, makeReceiptMeta, flattenReceipt, makeCrashMeta, flattenCrashRecord,
  DETECTION_MATCH_TOL_PX, FRAME_COLS, STAR_COLS, DETECTION_COLS, CRASH_COLS,
  QUAD_VERDICT_COLS, QUAD_CLUSTER_COLS, colSpec,
} from './lib/flatten.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REST_CHECKOUT = process.env.SKYCRUNCHER_REST_CHECKOUT || path.resolve(REPO_ROOT, '..', 'rest-integration');

const ROOTS = [
  ['D_artifacts', 'D:/AstroLogic/test_artifacts'],
  ['Kmain', path.join(REPO_ROOT, 'test_results')],
  ['Krest', path.join(REST_CHECKOUT, 'test_results')],
];
const OUT_DIR = process.env.RESULTS_ETL_OUT || 'D:/AstroLogic/test_artifacts/results_etl_2026-07-17';

// ---- discovery -------------------------------------------------------------
function walk(dir, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.receipt.json')) out.receipts.push(p);
    else if (e.name.endsWith('.crash.json')) out.crashes.push(p);
  }
}

// ---- main ------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  const disc = { receipts: [], crashes: [] };
  const rootFor = new Map();
  for (const [name, root] of ROOTS) {
    const before = disc.receipts.length + disc.crashes.length;
    walk(root, disc);
    for (let i = 0; i < disc.receipts.length; i++) if (!rootFor.has(disc.receipts[i])) rootFor.set(disc.receipts[i], [name, root]);
    for (let i = 0; i < disc.crashes.length; i++) if (!rootFor.has(disc.crashes[i])) rootFor.set(disc.crashes[i], [name, root]);
    console.error(`[etl] ${name}: +${disc.receipts.length + disc.crashes.length - before} files`);
  }
  console.error(`[etl] discovered ${disc.receipts.length} receipts, ${disc.crashes.length} crashes`);

  const frames = new Map(); // receipt_sha256 -> frame row (dedup)
  const starRows = [];
  const detectionRows = [];
  const quadVerdictRows = [];   // one row per distinct receipt carrying a quad_gen block
  const quadClusterRows = [];   // one row per judged cluster (FULL capture mode)
  let parseErrs = 0, stampedFrames = 0, fallbackFrames = 0, noQuadGenFrames = 0;

  for (const f of disc.receipts) {
    const [srcName, srcRoot] = rootFor.get(f);
    let buf, j;
    try { buf = fs.readFileSync(f); j = JSON.parse(buf); }
    catch (e) { parseErrs++; console.error(`[etl] PARSE_ERR ${f}: ${e.message}`); continue; }
    const meta = makeReceiptMeta({ buf, j, srcName, srcRoot, filePath: f });
    if (frames.has(meta.receipt_sha256)) {
      frames.get(meta.receipt_sha256).duplicate_path_count++;
      continue; // exact re-run / duplicate file — collapse to one distinct receipt
    }
    const { row, quad } = flattenReceipt(j, meta, starRows, detectionRows, quadVerdictRows, quadClusterRows);
    if (row.identity_basis === 'receipt_stamped') stampedFrames++; else fallbackFrames++;
    if (!quad) noQuadGenFrames++; // absent quad_gen block => no quad row (honest absence, counted)
    frames.set(meta.receipt_sha256, row);
  }

  // crashes
  const crashRows = [];
  const crashSeen = new Set();
  for (const f of disc.crashes) {
    const [srcName, srcRoot] = rootFor.get(f);
    let buf, j;
    try { buf = fs.readFileSync(f); j = JSON.parse(buf); }
    catch (e) { parseErrs++; console.error(`[etl] CRASH_PARSE_ERR ${f}: ${e.message}`); continue; }
    const meta = makeCrashMeta({ buf, srcName, srcRoot, filePath: f });
    if (crashSeen.has(meta.crash_sha256)) continue; crashSeen.add(meta.crash_sha256);
    crashRows.push(flattenCrashRecord(j, meta));
  }

  const frameRows = [...frames.values()];
  console.error(`[etl] distinct receipts: ${frameRows.length} (parse errs ${parseErrs})`);
  console.error(`[etl] frame identity: ${stampedFrames} receipt_stamped, ${fallbackFrames} path+size fallback`);
  console.error(`[etl] star rows: ${starRows.length} | detection rows: ${detectionRows.length} | crash rows: ${crashRows.length}`);
  console.error(`[etl] quad_gen: ${quadVerdictRows.length} verdict rows, ${quadClusterRows.length} cluster rows | ${noQuadGenFrames} distinct receipts WITHOUT a quad_gen block (no row, honest absence)`);

  // ---- write JSONL intermediates ------------------------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const framesJsonl = path.join(OUT_DIR, 'frames.jsonl');
  const starsJsonl = path.join(OUT_DIR, 'stars.jsonl');
  const detectionsJsonl = path.join(OUT_DIR, 'detections.jsonl');
  const crashesJsonl = path.join(OUT_DIR, 'crashes.jsonl');
  const quadVerdictsJsonl = path.join(OUT_DIR, 'quad_verdicts.jsonl');
  const quadClustersJsonl = path.join(OUT_DIR, 'quad_clusters.jsonl');
  fs.writeFileSync(framesJsonl, frameRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(starsJsonl, starRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(detectionsJsonl, detectionRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(crashesJsonl, crashRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(quadVerdictsJsonl, quadVerdictRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(quadClustersJsonl, quadClusterRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.error(`[etl] wrote JSONL intermediates to ${OUT_DIR}`);

  // ---- DuckDB: load JSONL -> parquet (hive-partitioned by schema_version) --
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  const p = (s) => s.replace(/\\/g, '/');
  async function build(table, jsonl, cols, outSub, partition) {
    await conn.run(`CREATE TABLE ${table} AS SELECT * FROM read_json('${p(jsonl)}', format='newline_delimited', columns=${colSpec(cols)});`);
    const cnt = (await (await conn.runAndReadAll(`SELECT count(*) c FROM ${table};`)).getRows())[0][0];
    fs.rmSync(path.join(OUT_DIR, outSub), { recursive: true, force: true });
    if (partition) {
      // hive-partitioned directory: <outSub>/schema_version=X/data_0.parquet
      const outPath = p(path.join(OUT_DIR, outSub));
      await conn.run(`COPY ${table} TO '${outPath}' (FORMAT parquet, PARTITION_BY (${partition}), OVERWRITE_OR_IGNORE, COMPRESSION zstd);`);
    } else {
      // no partition column: a bare COPY-to-path writes a single extension-less
      // file, which the '<table>/**/*.parquet' read glob would miss — so target a
      // named .parquet file inside a same-named directory instead.
      fs.mkdirSync(path.join(OUT_DIR, outSub), { recursive: true });
      const outPath = p(path.join(OUT_DIR, outSub, `${outSub}.parquet`));
      await conn.run(`COPY ${table} TO '${outPath}' (FORMAT parquet, COMPRESSION zstd);`);
    }
    return { table, rows: Number(cnt), outPath: path.join(OUT_DIR, outSub) };
  }
  const rF = await build('frames', framesJsonl, FRAME_COLS, 'frames', 'schema_version');
  const rS = await build('stars', starsJsonl, STAR_COLS, 'stars', 'schema_version');
  const rD = await build('detections', detectionsJsonl, DETECTION_COLS, 'detections', 'schema_version');
  const rC = await build('crashes', crashesJsonl, CRASH_COLS, 'crashes', null);
  const rQV = await build('quad_verdicts', quadVerdictsJsonl, QUAD_VERDICT_COLS, 'quad_verdicts', 'schema_version');
  const rQC = await build('quad_clusters', quadClustersJsonl, QUAD_CLUSTER_COLS, 'quad_clusters', 'schema_version');

  // parquet byte totals
  function dirBytes(d) { let t = 0; const w = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const pp = path.join(x, e.name); if (e.isDirectory()) w(pp); else t += fs.statSync(pp).size; } }; try { w(d); } catch {} return t; }
  const bytesF = dirBytes(path.join(OUT_DIR, 'frames'));
  const bytesS = dirBytes(path.join(OUT_DIR, 'stars'));
  const bytesD = dirBytes(path.join(OUT_DIR, 'detections'));
  const bytesC = dirBytes(path.join(OUT_DIR, 'crashes'));
  const bytesQV = dirBytes(path.join(OUT_DIR, 'quad_verdicts'));
  const bytesQC = dirBytes(path.join(OUT_DIR, 'quad_clusters'));

  // detection-tier splits (local, for the return + a cross-check against R2 verify)
  let detKept = 0, detAnom = 0, detMatched = 0;
  const cullingReasonCounts = {};
  for (const d of detectionRows) {
    if (d.kept) { detKept++; if (d.matched) detMatched++; }
    else { detAnom++; if (d.culling_reason) cullingReasonCounts[d.culling_reason] = (cullingReasonCounts[d.culling_reason] || 0) + 1; }
  }
  const cullingReasonTop = Object.fromEntries(Object.entries(cullingReasonCounts).sort((a, b) => b[1] - a[1]));

  const summary = {
    frames_rows: rF.rows, stars_rows: rS.rows, detections_rows: rD.rows, crashes_rows: rC.rows,
    quad_verdicts_rows: rQV.rows, quad_clusters_rows: rQC.rows,
    distinct_receipts: frameRows.length, discovered_receipts: disc.receipts.length,
    parse_errors: parseErrs, stamped_frames: stampedFrames, fallback_frames: fallbackFrames,
    detections: {
      total: detectionRows.length, kept: detKept, anomaly: detAnom,
      matched_kept: detMatched, unmatched_kept: detKept - detMatched,
      match_tol_px: DETECTION_MATCH_TOL_PX, culling_reason_counts: cullingReasonTop,
      receipts_with_detection_arrays: frameRows.filter((r) => (r.n_clean_detections + r.n_anomaly_detections) > 0).length,
    },
    quad_gen: {
      verdict_rows: quadVerdictRows.length, cluster_rows: quadClusterRows.length,
      receipts_without_quad_gen: noQuadGenFrames,
      receipts_with_odds: new Set(quadClusterRows.filter((c) => c.odds !== null).map((c) => c.receipt_sha256)).size,
    },
    parquet_bytes: {
      frames: bytesF, stars: bytesS, detections: bytesD, crashes: bytesC,
      quad_verdicts: bytesQV, quad_clusters: bytesQC,
      total: bytesF + bytesS + bytesD + bytesC + bytesQV + bytesQC,
    },
    out_dir: OUT_DIR, elapsed_s: (Date.now() - t0) / 1000,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'etl_summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await conn.closeSync?.();
}

main().catch((e) => { console.error('[etl] FATAL:', e.stack || e.message || e); process.exit(1); });
