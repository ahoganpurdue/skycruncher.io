#!/usr/bin/env node
// upload_r2.mjs — publish the results-ETL parquet tree to R2.
// ============================================================================
// TARGET: bucket `community-database` (owner-approved, NON-public), key prefix
// `results/v0-testdev/` — the first data load of the DuckDB-over-R2 results
// surface (TEST/DEV tier, schema NOT locked).
//
// The SigV4 S3 signing + HEAD-before-PUT idempotency pattern is LIFTED from
// tools/starplates/publish_r2.mjs (zero-dep, node:crypto) — attribution kept.
// Differences vs starplates: this data is MUTABLE TEST/DEV, so a HEAD sha
// MISMATCH is an overwrite (logged), not a hard immutability error; Cache-Control
// is no-cache; content-type is parquet.
//
// CREDENTIALS: read from src/engine/ui/dashboard/.env.r2 (gitignored). Values are
// NEVER printed, logged, or written to any artifact. Only object keys/bytes/sha
// are logged.
//
// USAGE: node upload_r2.mjs [--dir <etl-out>] [--prefix results/v0-testdev/] [--dry-run]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { s3Env, createS3Client, sha256Hex } from './lib/r2.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const argv = process.argv.slice(2);
function opt(name, def) { const i = argv.indexOf('--' + name); if (i === -1) return def; const v = argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; }
const DIR = path.resolve(opt('dir', 'D:/AstroLogic/test_artifacts/results_etl_2026-07-17'));
const PREFIX = String(opt('prefix', 'results/v0-testdev/')).replace(/^\/+/, '').replace(/\/*$/, '/');
const BUCKET = String(opt('bucket', 'community-database'));
const DRY_RUN = argv.includes('--dry-run');
const ENV_FILE = opt('env', path.join(REPO_ROOT, 'src/engine/ui/dashboard/.env.r2'));

// SigV4 signing, credential loading, and the bucket-scoped client all live in
// lib/r2.mjs (shared with drain_to_r2.mjs). Credential VALUES never leave memory.

// ---- gather upload set ------------------------------------------------------
function walk(dir, out) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } }
function collect() {
  const objects = [];
  for (const sub of ['frames', 'stars', 'detections', 'crashes']) {
    const d = path.join(DIR, sub);
    if (!fs.existsSync(d)) continue;
    const files = []; walk(d, files);
    for (const f of files) {
      const rel = path.relative(DIR, f).replace(/\\/g, '/');
      const body = fs.readFileSync(f);
      objects.push({
        key: PREFIX + rel,
        local: f,
        sha256: sha256Hex(body),
        bytes: body.length,
        contentType: f.endsWith('.parquet') ? 'application/vnd.apache.parquet' : 'application/octet-stream',
      });
    }
  }
  return objects;
}

const CACHE_CONTROL = 'no-cache'; // TEST/DEV mutable tier

async function uploadOne(client, o) {
  const head = await client.requestRetry('HEAD', o.key);
  if (head.status === 200 && head.headers.get('x-amz-meta-sha256') === o.sha256) {
    console.log(`[r2] skip (sha match)   ${o.key}`);
    return 'skipped';
  }
  const overwrite = head.status === 200;
  if (DRY_RUN) { console.log(`[r2] would ${overwrite ? 'OVERWRITE' : 'upload'}   ${o.key} (${o.bytes} B)`); return overwrite ? 'overwritten' : 'uploaded'; }
  const body = fs.readFileSync(o.local);
  const res = await client.requestRetry('PUT', o.key, { body, headers: { 'content-type': o.contentType, 'cache-control': CACHE_CONTROL, 'x-amz-meta-sha256': o.sha256 } });
  if (!res.ok) throw new Error(`PUT ${o.key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  console.log(`[r2] ${overwrite ? 'overwrote' : 'uploaded'}   ${o.key} (${o.bytes} B)`);
  return overwrite ? 'overwritten' : 'uploaded';
}

async function main() {
  const objects = collect();
  const totalBytes = objects.reduce((s, o) => s + o.bytes, 0);
  console.log(`[r2] ${objects.length} objects (${totalBytes} B) -> ${BUCKET}/${PREFIX}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  const env = s3Env(ENV_FILE);
  if (!env) { console.error('[r2] FATAL: no R2 credentials (env or .env.r2).'); process.exit(1); }
  const client = createS3Client({ env, bucket: BUCKET });
  const CONCURRENCY = Math.max(1, Number(process.env.R2_PUBLISH_CONCURRENCY || 8));
  let uploaded = 0, overwritten = 0, skipped = 0, idx = 0;
  async function worker() { for (;;) { const i = idx++; if (i >= objects.length) return; const r = await uploadOne(client, objects[i]); if (r === 'skipped') skipped++; else if (r === 'overwritten') overwritten++; else uploaded++; } }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, objects.length) }, worker));
  // local manifest (keys/bytes/sha only — no credentials)
  const manifest = { bucket: BUCKET, prefix: PREFIX, uploaded, overwritten, skipped, object_count: objects.length, total_bytes: totalBytes, objects: objects.map((o) => ({ key: o.key, bytes: o.bytes, sha256: o.sha256 })), at: new Date().toISOString() };
  fs.writeFileSync(path.join(DIR, 'upload_manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[r2] done: ${uploaded} uploaded, ${overwritten} overwritten, ${skipped} skipped -> ${objects.length} objects total`);
  console.log(JSON.stringify({ object_count: objects.length, total_bytes: totalBytes, uploaded, overwritten, skipped }));
}

main().catch((e) => { console.error('[r2] FATAL:', e.message ?? e); process.exit(1); });
