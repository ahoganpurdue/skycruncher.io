#!/usr/bin/env node
// drain_to_r2.mjs — incremental partition-APPEND drain for new solve receipts.
// ============================================================================
// GOAL (owner 2026-07-17): every NEW solve receipt lands in R2 automatically, in
// the SAME parquet format as the full ETL (frames/stars/detections/crashes),
// incrementally — NO full rebuild, NO rewrite of existing partitions, NO per-frame
// network coupling.
//
// MECHANISM: a local export manifest tracks which receipt_sha256 (and crash_sha256)
// are already in R2. Each run flattens ONLY the receipts not yet exported, writes
// them as NEW parquet files (batch-suffixed `data_<batchId>.parquet`) INSIDE the
// existing `schema_version=<v>/` partition dirs, and uploads only those new
// objects. DuckDB globs the whole prefix as one table, so new files = APPENDED
// rows with zero rewrite of `data_0.parquet` (verified: multi-file hive partitions
// read cleanly, no spurious `batch` column — that is why the batch id is a FILENAME
// suffix, not a `batch=<stamp>/` directory).
//
// IDEMPOTENCY: (1) manifest skip — receipts already exported are not re-drained;
// re-run with no new receipts = clean no-op. (2) batchId = content-hash of the new
// receipt/crash sha set, so a crashed run that uploaded but failed to persist the
// manifest re-produces the SAME file and the HEAD-before-PUT sha match skips it.
//
// BOOTSTRAP: on first run (manifest absent) or --reconcile, seed the manifest from
// R2's CURRENT contents (distinct receipt_sha256/crash_sha256 already present) so
// the ~200 receipts the full ETL already uploaded are NOT re-exported as duplicate
// batch files. R2 is the source of truth; the manifest is the fast local cache.
//
// The flatten (lib/flatten.mjs) and the SigV4 R2 client (lib/r2.mjs) are SHARED
// with etl_receipts.mjs / upload_r2.mjs — no duplicated logic (CLAUDE.md LAW 4).
// Credentials come from .env.r2 and their VALUES are never printed/logged/committed.
//
// USAGE: node drain_to_r2.mjs [--roots <p1,p2,...>] [--out-dir <d>] [--manifest <f>]
//                             [--bucket <b>] [--prefix <p>] [--env <f>]
//                             [--reconcile] [--no-bootstrap] [--dry-run]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  makeReceiptMeta, flattenReceipt, makeCrashMeta, flattenCrashRecord,
  FRAME_COLS, STAR_COLS, DETECTION_COLS, CRASH_COLS,
  QUAD_VERDICT_COLS, QUAD_CLUSTER_COLS, colSpec, sha256,
} from './lib/flatten.mjs';
import { s3Env, createS3Client, sha256Hex } from './lib/r2.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REST_CHECKOUT = process.env.SKYCRUNCHER_REST_CHECKOUT || path.resolve(REPO_ROOT, '..', 'rest-integration');

const argv = process.argv.slice(2);
function opt(name, def) { const i = argv.indexOf('--' + name); if (i === -1) return def; const v = argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; }
const OUT_DIR = path.resolve(opt('out-dir', process.env.RESULTS_ETL_OUT || 'D:/AstroLogic/test_artifacts/results_etl_2026-07-17'));
const MANIFEST = path.resolve(opt('manifest', path.join(OUT_DIR, 'exported.json')));
const BUCKET = String(opt('bucket', 'community-database'));
const PREFIX = String(opt('prefix', 'results/v0-testdev/')).replace(/^\/+/, '').replace(/\/*$/, '/');
const ENV_FILE = opt('env', path.join(REPO_ROOT, 'src/engine/ui/dashboard/.env.r2'));
const DRY_RUN = argv.includes('--dry-run');
const RECONCILE = argv.includes('--reconcile');
const NO_BOOTSTRAP = argv.includes('--no-bootstrap');
const CACHE_CONTROL = 'no-cache';

// Default receipt roots (parameterized). held149 is UNDER D_artifacts; listing it
// explicitly is harmless (sha dedup) and documents intent. --roots ADDS more.
const DEFAULT_ROOTS = [
  ['D_artifacts', 'D:/AstroLogic/test_artifacts'],
  ['Kmain', path.join(REPO_ROOT, 'test_results')],
  ['Krest', path.join(REST_CHECKOUT, 'test_results')],
  ['held149', 'D:/AstroLogic/test_artifacts/held149_levered_2026-07-17'],
];
function resolveRoots() {
  const roots = [...DEFAULT_ROOTS];
  const extra = opt('roots', null);
  if (typeof extra === 'string') {
    for (const r of extra.split(',').map((s) => s.trim()).filter(Boolean)) {
      const abs = path.resolve(r);
      if (!roots.some(([, p]) => path.resolve(p) === abs)) roots.push([path.basename(abs) || 'root', abs]);
    }
  }
  return roots;
}

function walk(dir, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.receipt.json')) out.receipts.push(p);
    else if (e.name.endsWith('.crash.json')) out.crashes.push(p);
  }
}

const pfwd = (s) => s.replace(/\\/g, '/');
const partDir = (v) => `schema_version=${v}`;

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; }
}
function writeManifestAtomic(m) {
  const tmp = MANIFEST + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, MANIFEST);
}

// Seed exported-sha sets from R2's current contents (authoritative). Never echoes creds.
async function bootstrapFromR2(env, exportedReceipts, exportedCrashes) {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run('INSTALL httpfs; LOAD httpfs;');
  await conn.run(`CREATE OR REPLACE SECRET r2 (TYPE s3, KEY_ID '${env.accessKey.replace(/'/g, "''")}', SECRET '${env.secretKey.replace(/'/g, "''")}', ENDPOINT '${env.endpointHost}', REGION 'auto', URL_STYLE 'path', USE_SSL true);`);
  const g = (t) => `s3://${BUCKET}/${PREFIX}${t}/**/*.parquet`;
  let nr = 0, nc = 0;
  try {
    const r = await (await conn.runAndReadAll(`SELECT DISTINCT receipt_sha256 FROM read_parquet('${g('frames')}', hive_partitioning=1) WHERE receipt_sha256 IS NOT NULL;`)).getRows();
    for (const [sha] of r) { if (sha && !exportedReceipts.has(sha)) { exportedReceipts.add(sha); nr++; } }
  } catch (e) { console.error(`[drain] bootstrap: no frames in R2 yet (${String(e.message || e).slice(0, 80)})`); }
  try {
    const c = await (await conn.runAndReadAll(`SELECT DISTINCT crash_sha256 FROM read_parquet('${g('crashes')}', hive_partitioning=1) WHERE crash_sha256 IS NOT NULL;`)).getRows();
    for (const [sha] of c) { if (sha && !exportedCrashes.has(sha)) { exportedCrashes.add(sha); nc++; } }
  } catch (e) { console.error(`[drain] bootstrap: no crashes in R2 yet (${String(e.message || e).slice(0, 80)})`); }
  await conn.closeSync?.();
  return { receipts: nr, crashes: nc };
}

// Write a group of rows to a single parquet file via DuckDB read_json -> COPY.
async function writeParquet(conn, rows, cols, outFile) {
  const tmp = outFile + '.jsonl';
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await conn.run(`CREATE OR REPLACE TABLE _drain AS SELECT * FROM read_json('${pfwd(tmp)}', format='newline_delimited', columns=${colSpec(cols)});`);
  await conn.run(`COPY _drain TO '${pfwd(outFile)}' (FORMAT parquet, COMPRESSION zstd);`);
  fs.rmSync(tmp, { force: true });
  return fs.statSync(outFile).size;
}

async function main() {
  const t0 = Date.now();
  const roots = resolveRoots();
  const env = s3Env(ENV_FILE);
  if (!env) { console.error('[drain] FATAL: no R2 credentials (env or .env.r2).'); process.exit(1); }
  const client = createS3Client({ env, bucket: BUCKET });

  // ---- exported-sha sets: manifest (fast) + R2 bootstrap (authoritative) ----
  const manifest = loadManifest() || { version: 1, bucket: BUCKET, prefix: PREFIX, receipts: {}, crashes: {}, batches: [], bootstrap: null };
  const exportedReceipts = new Set(Object.keys(manifest.receipts || {}));
  const exportedCrashes = new Set(Object.keys(manifest.crashes || {}));
  let bootstrapped = null;
  const needBootstrap = (!fs.existsSync(MANIFEST) || RECONCILE) && !NO_BOOTSTRAP;
  if (needBootstrap) {
    console.error('[drain] bootstrapping exported set from R2 current contents…');
    bootstrapped = await bootstrapFromR2(env, exportedReceipts, exportedCrashes);
    console.error(`[drain] bootstrap: +${bootstrapped.receipts} receipts, +${bootstrapped.crashes} crashes already in R2`);
  }

  // ---- discover + select NEW ------------------------------------------------
  const disc = { receipts: [], crashes: [] };
  const rootFor = new Map();
  for (const [name, root] of roots) {
    walk(root, disc);
    for (const f of disc.receipts) if (!rootFor.has(f)) rootFor.set(f, [name, root]);
    for (const f of disc.crashes) if (!rootFor.has(f)) rootFor.set(f, [name, root]);
  }

  const frameRows = [], starRows = [], detectionRows = [], crashRows = [];
  const quadVerdictRows = [], quadClusterRows = []; // ADDITIVE 2026-07-18 quad-gen drain
  const newReceiptShas = [], newCrashShas = [];
  const seenReceipt = new Set(), seenCrash = new Set();
  let parseErrs = 0, noQuadGenFrames = 0;

  // deterministic order: sort discovered files, dedup by content sha, skip exported
  for (const f of [...disc.receipts].sort()) {
    const [srcName, srcRoot] = rootFor.get(f);
    let buf, j;
    try { buf = fs.readFileSync(f); j = JSON.parse(buf); }
    catch (e) { parseErrs++; console.error(`[drain] PARSE_ERR ${f}: ${e.message}`); continue; }
    const shaHex = sha256(buf);
    if (exportedReceipts.has(shaHex) || seenReceipt.has(shaHex)) continue; // already in R2 or dup file this run
    seenReceipt.add(shaHex);
    const meta = makeReceiptMeta({ buf, j, srcName, srcRoot, filePath: f });
    const { row, quad } = flattenReceipt(j, meta, starRows, detectionRows, quadVerdictRows, quadClusterRows);
    if (!quad) noQuadGenFrames++; // absent quad_gen block => no quad row (honest absence, counted)
    frameRows.push(row);
    newReceiptShas.push(shaHex);
    exportedReceipts.add(shaHex); // keep the in-memory set complete for durable persistence
  }
  for (const f of [...disc.crashes].sort()) {
    const [srcName, srcRoot] = rootFor.get(f);
    let buf, j;
    try { buf = fs.readFileSync(f); j = JSON.parse(buf); }
    catch (e) { parseErrs++; console.error(`[drain] CRASH_PARSE_ERR ${f}: ${e.message}`); continue; }
    const shaHex = sha256(buf);
    if (exportedCrashes.has(shaHex) || seenCrash.has(shaHex)) continue;
    seenCrash.add(shaHex);
    const meta = makeCrashMeta({ buf, srcName, srcRoot, filePath: f });
    crashRows.push(flattenCrashRecord(j, meta));
    newCrashShas.push(shaHex);
    exportedCrashes.add(shaHex); // keep the in-memory set complete for durable persistence
  }

  // Persist the FULL known-exported set (loaded manifest + bootstrap + new) so a
  // later run WITHOUT a bootstrap still knows the bootstrapped receipts are already
  // in R2. (The original bug: only new shas were persisted, so the next run
  // re-exported every bootstrapped receipt as a duplicate batch.)
  function persistManifest(batchRecord) {
    const now = new Date().toISOString();
    const newRSet = new Set(newReceiptShas), newCSet = new Set(newCrashShas);
    for (const sha of exportedReceipts) if (!manifest.receipts[sha]) manifest.receipts[sha] = { b: newRSet.has(sha) ? (batchRecord ? batchRecord.batch_id : 'bootstrap') : 'r2-bootstrap', t: now };
    for (const sha of exportedCrashes) if (!manifest.crashes[sha]) manifest.crashes[sha] = { b: newCSet.has(sha) ? (batchRecord ? batchRecord.batch_id : 'bootstrap') : 'r2-bootstrap', t: now };
    if (bootstrapped) manifest.bootstrap = { ...bootstrapped, source: 'r2', at: now };
    if (batchRecord) manifest.batches.push(batchRecord);
    manifest.updated_at = now;
    if (!DRY_RUN) writeManifestAtomic(manifest);
  }

  const nNewReceipts = newReceiptShas.length, nNewCrashes = newCrashShas.length;
  console.error(`[drain] NEW: ${nNewReceipts} receipts (${frameRows.length} frames, ${starRows.length} stars, ${detectionRows.length} detections), ${nNewCrashes} crashes`);
  console.error(`[drain] quad_gen: ${quadVerdictRows.length} verdict rows, ${quadClusterRows.length} cluster rows | ${noQuadGenFrames} new receipts WITHOUT a quad_gen block (no row, honest absence)`);

  // ---- clean no-op ----------------------------------------------------------
  if (nNewReceipts === 0 && nNewCrashes === 0) {
    // still persist the (possibly newly-bootstrapped) exported set so it is durable
    persistManifest(null);
    const summary = { status: 'noop', new_receipts: 0, new_crashes: 0, uploaded: 0, objects_written: 0, bootstrapped, roots: roots.map(([n]) => n), manifest: MANIFEST, elapsed_s: (Date.now() - t0) / 1000 };
    console.log(JSON.stringify(summary)); // single line — downstream (harvest) parses the last stdout line
    return;
  }

  // ---- batchId = content-hash of the new sha set (crash-safe idempotency) ---
  const batchId = sha256Hex([...newReceiptShas].sort().join('\n') + ' ' + [...newCrashShas].sort().join('\n')).slice(0, 16);
  const stamp = new Date().toISOString();

  // ---- write NEW parquet batch files (grouped per table+partition) ----------
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  const written = []; // {table, key, local, bytes, sha256}

  async function emitPartitioned(table, rows, cols) {
    const byPart = new Map();
    for (const r of rows) { const v = r.schema_version ?? 'none'; (byPart.get(v) || byPart.set(v, []).get(v)).push(r); }
    for (const [v, group] of [...byPart.entries()].sort()) {
      const outFile = path.join(OUT_DIR, table, partDir(v), `data_${batchId}.parquet`);
      const bytes = await writeParquet(conn, group, cols, outFile);
      const body = fs.readFileSync(outFile);
      written.push({ table, local: outFile, key: PREFIX + pfwd(path.relative(OUT_DIR, outFile)), bytes, sha256: sha256Hex(body) });
    }
  }
  async function emitFlat(table, rows, cols) {
    if (!rows.length) return;
    const outFile = path.join(OUT_DIR, table, `data_${batchId}.parquet`);
    const bytes = await writeParquet(conn, rows, cols, outFile);
    const body = fs.readFileSync(outFile);
    written.push({ table, local: outFile, key: PREFIX + pfwd(path.relative(OUT_DIR, outFile)), bytes, sha256: sha256Hex(body) });
  }

  if (frameRows.length) await emitPartitioned('frames', frameRows, FRAME_COLS);
  if (starRows.length) await emitPartitioned('stars', starRows, STAR_COLS);
  if (detectionRows.length) await emitPartitioned('detections', detectionRows, DETECTION_COLS);
  if (quadVerdictRows.length) await emitPartitioned('quad_verdicts', quadVerdictRows, QUAD_VERDICT_COLS);
  if (quadClusterRows.length) await emitPartitioned('quad_clusters', quadClusterRows, QUAD_CLUSTER_COLS);
  if (crashRows.length) await emitFlat('crashes', crashRows, CRASH_COLS);
  await conn.closeSync?.();

  // ---- upload ONLY the new batch objects (HEAD-before-PUT idempotent) --------
  let uploaded = 0, skipped = 0;
  for (const o of written) {
    const head = await client.requestRetry('HEAD', o.key);
    if (head.status === 200 && head.headers.get('x-amz-meta-sha256') === o.sha256) { console.log(`[drain] skip (sha match)   ${o.key}`); skipped++; continue; }
    if (DRY_RUN) { console.log(`[drain] would upload   ${o.key} (${o.bytes} B)`); uploaded++; continue; }
    const body = fs.readFileSync(o.local);
    const res = await client.requestRetry('PUT', o.key, { body, headers: { 'content-type': 'application/vnd.apache.parquet', 'cache-control': CACHE_CONTROL, 'x-amz-meta-sha256': o.sha256 } });
    if (!res.ok) throw new Error(`PUT ${o.key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log(`[drain] uploaded   ${o.key} (${o.bytes} B)`);
    uploaded++;
  }

  // ---- update manifest (after successful upload) ----------------------------
  persistManifest({
    batch_id: batchId, at: stamp, roots: roots.map(([n]) => n),
    new_receipts: nNewReceipts, new_crashes: nNewCrashes,
    rows: { frames: frameRows.length, stars: starRows.length, detections: detectionRows.length, crashes: crashRows.length, quad_verdicts: quadVerdictRows.length, quad_clusters: quadClusterRows.length },
    objects: written.map((o) => ({ key: o.key, bytes: o.bytes, sha256: o.sha256 })),
    dry_run: DRY_RUN || undefined,
  });

  const summary = {
    status: DRY_RUN ? 'dry_run' : 'ok',
    batch_id: batchId,
    new_receipts: nNewReceipts, new_crashes: nNewCrashes,
    rows: { frames: frameRows.length, stars: starRows.length, detections: detectionRows.length, crashes: crashRows.length, quad_verdicts: quadVerdictRows.length, quad_clusters: quadClusterRows.length },
    quad_gen: { verdict_rows: quadVerdictRows.length, cluster_rows: quadClusterRows.length, receipts_without_quad_gen: noQuadGenFrames },
    objects_written: written.length, uploaded, skipped,
    bytes: written.reduce((s, o) => s + o.bytes, 0),
    bootstrapped, roots: roots.map(([n]) => n),
    manifest: MANIFEST, elapsed_s: (Date.now() - t0) / 1000,
  };
  console.log(JSON.stringify(summary)); // single line — downstream (harvest) parses the last stdout line
}

main().catch((e) => { console.error('[drain] FATAL:', e.stack || e.message || e); process.exit(1); });
