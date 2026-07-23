#!/usr/bin/env node
// verify_d_litter.mjs — prove every *.receipt.json under D:/AstroLogic/test_artifacts
// has its content receipt_sha256 present in R2's frames table (owner 2026-07-18
// "D drive littered with no-solve receipts -> push to R2"). Read-only; no upload.
// Creds from .env.r2 via lib/r2.mjs (never printed). Placed in the lane so the
// lane-local @duckdb/node-api resolves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { s3Env, sha256Hex } from './lib/r2.mjs';
import { sha256 } from './lib/flatten.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const ROOT = 'D:/AstroLogic/test_artifacts';
const BUCKET = 'community-database';
const PREFIX = 'results/v0-testdev/';
const ENV_FILE = path.join(REPO_ROOT, 'src/engine/ui/dashboard/.env.r2');

function walk(dir, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.receipt.json')) out.push(p);
  }
}

async function main() {
  const files = []; walk(ROOT, files);
  // distinct content shas across the D: litter, remember one sample path per sha
  const shaToPath = new Map();
  for (const f of files.sort()) { const sha = sha256(fs.readFileSync(f)); if (!shaToPath.has(sha)) shaToPath.set(sha, path.relative(ROOT, f).replace(/\\/g, '/')); }
  const dShas = [...shaToPath.keys()];
  console.log(`[verify] D: litter: ${files.length} receipt files, ${dShas.length} DISTINCT content shas`);

  const env = s3Env(ENV_FILE);
  if (!env) { console.error('[verify] FATAL: no R2 creds'); process.exit(1); }
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run('INSTALL httpfs; LOAD httpfs;');
  await conn.run(`CREATE OR REPLACE SECRET r2 (TYPE s3, KEY_ID '${env.accessKey.replace(/'/g, "''")}', SECRET '${env.secretKey.replace(/'/g, "''")}', ENDPOINT '${env.endpointHost}', REGION 'auto', URL_STYLE 'path', USE_SSL true);`);
  const framesGlob = `s3://${BUCKET}/${PREFIX}frames/**/*.parquet`;

  // R2 distinct receipt_sha256
  const r2Rows = await (await conn.runAndReadAll(`SELECT DISTINCT receipt_sha256 FROM read_parquet('${framesGlob}', hive_partitioning=1) WHERE receipt_sha256 IS NOT NULL;`)).getRows();
  const r2Set = new Set(r2Rows.map((r) => r[0]));
  console.log(`[verify] R2 frames: ${r2Set.size} DISTINCT receipt_sha256 (all roots)`);

  const missing = dShas.filter((s) => !r2Set.has(s));
  console.log(`[verify] D: shas present in R2: ${dShas.length - missing.length}/${dShas.length}  | MISSING: ${missing.length}`);
  for (const s of missing.slice(0, 20)) console.log(`  MISSING sha ${s.slice(0, 16)}  ${shaToPath.get(s)}`);

  // spot-check 3 round-trips: pull the frame row back from R2
  const sample = dShas.slice(0, 3);
  console.log('[verify] spot-check 3 round-trips (from R2):');
  for (const s of sample) {
    const rr = await (await conn.runAndReadAll(`SELECT receipt_path, receipt_kind, solved, failure_reason, source_root FROM read_parquet('${framesGlob}', hive_partitioning=1) WHERE receipt_sha256='${s}' LIMIT 1;`)).getRows();
    if (!rr.length) { console.log(`  sha ${s.slice(0, 16)} -> NOT FOUND in R2`); continue; }
    const [rp, kind, solved, freason, sroot] = rr[0];
    console.log(`  sha ${s.slice(0, 16)} -> R2[${sroot}] path=${rp} kind=${kind} solved=${solved} fail=${freason ?? '-'}  | D:path=${shaToPath.get(s)}`);
  }

  await conn.closeSync?.();
  const ok = missing.length === 0;
  console.log(JSON.stringify({ status: ok ? 'VERIFIED' : 'GAP', d_files: files.length, d_distinct_shas: dShas.length, r2_distinct_shas: r2Set.size, present: dShas.length - missing.length, missing: missing.length }));
  process.exit(ok ? 0 : 2);
}
main().catch((e) => { console.error('[verify] FATAL:', e.stack || e.message || e); process.exit(1); });
