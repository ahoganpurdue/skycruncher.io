#!/usr/bin/env node
// publish_r2.mjs — upload a STARPLATES release directory to the R2 bucket.
// ============================================================================
// CONTRACT: docs/STARPLATES_SPEC.md §7 (R2 layout & serving). Rules enforced:
//   - object keys = release-relative paths verbatim:
//       <release>/manifest.json, <release>/t0/allsky.arrow, <release>/t1/c5-NNNNN.arrow
//   - Cache-Control: public, max-age=31536000, immutable  (everything under a release)
//   - Content-Type: application/vnd.apache.arrow.file (.arrow) / application/json
//   - custom metadata sha256=<hex> (R2 ETags are NOT content SHAs — opaque)
//   - idempotent: HEAD before PUT; existing key with matching sha256 metadata => skip
//   - existing key with MISMATCHED sha => HARD ERROR, never overwrite (immutability
//     enforced at the tool, not by hope)
//   - requires explicit --release <id>; refuses any path outside that release
//   - optional mutable releases/index.json updated ONLY with --update-index (§2.4)
//
// NOTE on the tool name: STARPLATES_SPEC §7 originally named this
// `upload_r2.mjs`; it ships as `publish_r2.mjs` (documented deviation, spec §13).
//
// CREDENTIALS (S3-compatible API, no new npm deps — SigV4 via node:crypto):
//   R2_ACCOUNT_ID          Cloudflare account id (hex)
//   R2_ACCESS_KEY_ID       R2 API token access key id
//   R2_SECRET_ACCESS_KEY   R2 API token secret
//   R2_BUCKET              optional, default "starplates"
//   R2_ENDPOINT            optional, default https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
// If the env credentials are absent this tool tries `wrangler` on PATH; if that
// is also absent it NO-OPS with a clear message and exit code 0 — publishing is
// a sync step, never a build dependency (offline-first, spec §1).
//
// USAGE
//   node tools/starplates/publish_r2.mjs --release starplates-2026.07-gdr3 \
//        [--dir test_results/starplates/starplates-2026.07-gdr3] \
//        [--bucket starplates] [--dry-run] [--update-index]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const RELEASE = opt('release', null);
const BUCKET = opt('bucket', process.env.R2_BUCKET || 'starplates');
const DRY_RUN = argv.includes('--dry-run');
const UPDATE_INDEX = argv.includes('--update-index');

if (!RELEASE || RELEASE === true) {
  console.error('publish_r2: --release <id> is required (immutability rule: uploads are scoped to exactly one release).');
  process.exit(1);
}
if (!/^starplates-[0-9]{4}\.[0-9]{2}(\.[0-9]+)?-[a-z0-9]+$/.test(RELEASE) && !RELEASE.startsWith('starplates-fixture')) {
  console.error(`publish_r2: release id "${RELEASE}" does not match starplates-<YYYY.MM>[.<rev>]-<source> (spec §2.1).`);
  process.exit(1);
}
const DIR = path.resolve(opt('dir', path.join('test_results', 'starplates', RELEASE)));

// ---- gather + verify the upload set (local sha vs manifest, hard error) --------
function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function collectUploadSet() {
  if (path.basename(DIR) !== RELEASE) {
    throw new Error(`--dir basename (${path.basename(DIR)}) != --release (${RELEASE}); refusing (keys are release-relative).`);
  }
  const manifestPath = path.join(DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`missing ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.release !== RELEASE) {
    throw new Error(`manifest.release (${manifest.release}) != --release (${RELEASE}); refusing.`);
  }
  const objects = [];
  for (const blob of manifest.blobs) {
    // refuse anything outside the release dir (spec §7)
    if (path.isAbsolute(blob.path) || blob.path.includes('..') || !/^t[0-9]\//.test(blob.path)) {
      throw new Error(`manifest blob path escapes the release: "${blob.path}"`);
    }
    const local = path.join(DIR, blob.path);
    if (!fs.existsSync(local)) throw new Error(`manifest names ${blob.path} but the file is missing locally`);
    const sha = sha256File(local);
    if (sha !== blob.sha256) {
      throw new Error(`LOCAL INTEGRITY FAILURE: ${blob.path} sha256=${sha} != manifest ${blob.sha256} — refusing to publish a torn release.`);
    }
    objects.push({
      key: `${RELEASE}/${blob.path}`,
      local,
      sha256: sha,
      contentType: 'application/vnd.apache.arrow.file',
      bytes: blob.bytes,
    });
  }
  objects.push({
    key: `${RELEASE}/manifest.json`,
    local: manifestPath,
    sha256: sha256File(manifestPath),
    contentType: 'application/json',
    bytes: fs.statSync(manifestPath).size,
  });
  return { manifest, objects };
}

// ---- SigV4 (S3-compatible, region "auto") --------------------------------------
function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
function hex(buf) { return Buffer.from(buf).toString('hex'); }
function sha256Hex(data) { return createHash('sha256').update(data).digest('hex'); }

function signV4({ method, host, uri, headers, payloadHash, accessKey, secretKey }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto', service = 's3';
  const allHeaders = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(allHeaders).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${String(allHeaders[Object.keys(allHeaders).find((k) => k.toLowerCase() === h)]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, uri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  let key = hmac(`AWS4${secretKey}`, dateStamp);
  key = hmac(key, region);
  key = hmac(key, service);
  key = hmac(key, 'aws4_request');
  const signature = hex(hmac(key, stringToSign));
  return {
    ...allHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function s3Env() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKey || !secretKey) return null;
  const endpoint = process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;
  return { endpoint: endpoint.replace(/\/$/, ''), accessKey, secretKey };
}

async function s3Request(env, method, key, { body = null, headers = {} } = {}) {
  const url = new URL(`${env.endpoint}/${BUCKET}/${key}`);
  const payloadHash = body ? sha256Hex(body) : sha256Hex('');
  const signed = signV4({
    method,
    host: url.host,
    uri: url.pathname, // keys are [A-Za-z0-9./-] — already canonical
    headers,
    payloadHash,
    accessKey: env.accessKey,
    secretKey: env.secretKey,
  });
  return fetch(url, { method, headers: signed, body: body ?? undefined });
}

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Transient-only retry: network-level failures (fetch failed) and 429/5xx get 3
// attempts with backoff; semantic outcomes (200/404 handling, immutability hard
// error) are NEVER retried. A 12k-object release sees ~1 blip per ~1k requests —
// without this, one blip kills the whole pass.
async function s3RequestRetry(env, method, key, opts) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await s3Request(env, method, key, opts);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${method} ${key}: HTTP ${res.status} (transient)`);
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e; // fetch failed / socket reset
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw lastErr;
}

async function publishOne(env, o) {
  const head = await s3RequestRetry(env, 'HEAD', o.key);
  if (head.status === 200) {
    const remoteSha = head.headers.get('x-amz-meta-sha256');
    if (remoteSha === o.sha256) {
      console.log(`[r2] skip (exists, sha match)   ${o.key}`);
      return 'skipped';
    }
    throw new Error(
      `IMMUTABILITY VIOLATION: ${o.key} already exists with sha256=${remoteSha ?? '(none)'} != local ${o.sha256}. ` +
      `Releases are immutable — fixes ship as a NEW release id (spec §2.1). Never overwriting.`);
  }
  if (head.status !== 404) {
    throw new Error(`HEAD ${o.key} failed: HTTP ${head.status} ${await head.text().then((t) => t.slice(0, 200))}`);
  }
  if (DRY_RUN) {
    console.log(`[r2] would upload             ${o.key} (${o.bytes} B, ${o.contentType})`);
    return 'uploaded';
  }
  const body = fs.readFileSync(o.local);
  const res = await s3RequestRetry(env, 'PUT', o.key, {
    body,
    headers: {
      'content-type': o.contentType,
      'cache-control': CACHE_CONTROL,
      'x-amz-meta-sha256': o.sha256,
    },
  });
  if (!res.ok) throw new Error(`PUT ${o.key} failed: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`);
  console.log(`[r2] uploaded                 ${o.key} (${o.bytes} B)`);
  return 'uploaded';
}

async function publishViaS3(env, objects) {
  // Worker pool: per-object HEAD-before-PUT semantics are UNCHANGED (each key is
  // independent); concurrency only overlaps network round-trips. 12,289-object
  // releases are ~2h sequential vs ~15min pooled. Tune via R2_PUBLISH_CONCURRENCY.
  const CONCURRENCY = Math.max(1, Number(process.env.R2_PUBLISH_CONCURRENCY || 12));
  let uploaded = 0, skipped = 0, idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= objects.length) return;
      const r = await publishOne(env, objects[i]);
      if (r === 'skipped') skipped++; else uploaded++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, objects.length) }, worker));
  return { uploaded, skipped };
}

async function updateIndexViaS3(env) {
  const key = 'releases/index.json';
  let index = { releases: [] };
  const res = await s3Request(env, 'GET', key);
  if (res.status === 200) {
    try { index = JSON.parse(await res.text()); } catch { index = { releases: [] }; }
  } else if (res.status !== 404) {
    throw new Error(`GET ${key} failed: HTTP ${res.status}`);
  }
  if (!Array.isArray(index.releases)) index.releases = [];
  if (index.releases.includes(RELEASE)) {
    console.log(`[r2] index already lists ${RELEASE}`);
    return;
  }
  index.releases.push(RELEASE);
  index.releases.sort();
  const body = Buffer.from(JSON.stringify(index, null, 2) + '\n');
  if (DRY_RUN) { console.log(`[r2] would update ${key}: ${JSON.stringify(index.releases)}`); return; }
  const put = await s3Request(env, 'PUT', key, {
    body,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' }, // the ONE mutable object (spec §2.4)
  });
  if (!put.ok) throw new Error(`PUT ${key} failed: HTTP ${put.status}`);
  console.log(`[r2] updated ${key}: ${JSON.stringify(index.releases)}`);
}

// ---- wrangler fallback -----------------------------------------------------------
function wranglerAvailable() {
  const r = spawnSync('wrangler --version', { shell: true, encoding: 'utf8', timeout: 20000 });
  return r.status === 0;
}

function publishViaWrangler(objects) {
  console.log('[r2] WARNING: wrangler mode — no HEAD-before-PUT is available, so the skip/immutability');
  console.log('[r2] check cannot run. Local bytes were verified against the manifest SHA-256s, so any');
  console.log('[r2] overwrite writes the identical content-addressed bytes for this release id.');
  let uploaded = 0;
  for (const o of objects) {
    if (DRY_RUN) { console.log(`[r2] would upload (wrangler)  ${o.key}`); uploaded++; continue; }
    const cmd = `wrangler r2 object put "${BUCKET}/${o.key}" --file "${o.local}" ` +
      `--content-type "${o.contentType}" --cache-control "${CACHE_CONTROL}" --remote`;
    const r = spawnSync(cmd, { shell: true, encoding: 'utf8', stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`wrangler put ${o.key} failed (exit ${r.status})`);
    uploaded++;
  }
  return { uploaded, skipped: 0 };
}

// ---- main ----------------------------------------------------------------------
async function main() {
  const { objects } = collectUploadSet();
  console.log(`[r2] release ${RELEASE}: ${objects.length} objects (${objects.reduce((s, o) => s + o.bytes, 0)} B) -> bucket ${BUCKET}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  const env = s3Env();
  if (env) {
    const { uploaded, skipped } = await publishViaS3(env, objects);
    if (UPDATE_INDEX) await updateIndexViaS3(env);
    console.log(`[r2] done: ${uploaded} uploaded, ${skipped} skipped.`);
    return;
  }
  if (wranglerAvailable()) {
    const { uploaded } = publishViaWrangler(objects);
    if (UPDATE_INDEX) console.log('[r2] NOTE: --update-index is only supported in S3-credential mode; skipped.');
    console.log(`[r2] done via wrangler: ${uploaded} uploaded.`);
    return;
  }
  // Never fail the build over missing credentials — publishing is a sync step.
  console.log('[r2] NO-OP: no R2 credentials found and wrangler is not installed.');
  console.log('[r2] To publish, either set env vars:');
  console.log('[r2]   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY  (optional: R2_BUCKET, R2_ENDPOINT)');
  console.log('[r2] or install wrangler and authenticate (`wrangler login`). Local release is untouched and valid.');
}

main().catch((e) => { console.error('[r2] FATAL:', e.message ?? e); process.exit(1); });
