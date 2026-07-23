// publish_dump.mjs — upload ONE per-frame processed-dump dossier to the R2 bucket.
// (No shebang on purpose: vitest inlines project .mjs through esbuild.transform,
// which does not strip shebangs — V8 rejects `#!` at import. The build_release.mjs
// suite was dark for exactly this. Invoke via `node tools/community/publish_dump.mjs`.)
// ============================================================================
// CONTRACT: docs/COMMUNITY_DATABASE_SPEC.md §3 (R2 layout & upload rules). This is
// the processed-data ("community-database") sibling of tools/starplates/publish_r2.mjs
// and reuses its exact primitives: SigV4 (node:crypto), HEAD-before-PUT, sha256
// custom-metadata, immutable Cache-Control, mismatch = hard-error. Zero npm deps.
//
// Rules enforced:
//   - manifest-driven: reads <dir>/manifest.json (schema "community-dump/1"); every
//     uploaded object is named there with its sha256 + byte size.
//   - object keys = dumps/<capture_date>/<frame_id>/<artifact-path> (verbatim); the
//     manifest itself lands at dumps/<capture_date>/<frame_id>/manifest.json.
//   - append-only immutability: HEAD before PUT; existing key with matching sha256
//     metadata => skip; existing key with MISMATCHED sha => HARD ERROR, never
//     overwrite (dossiers are content-addressed; a fix ships as a NEW capture/frame).
//   - refuses any artifact path that escapes the dossier dir (absolute / ".." /
//     resolves outside <dir>).
//   - Cache-Control: public, max-age=31536000, immutable  (dumps are immutable).
//   - custom metadata sha256=<hex> (R2 ETags are NOT content SHAs — opaque).
//   - optional mutable dumps/index.json updated ONLY with --update-index (§3.3).
//   - --dry-run is FULLY OFFLINE: it verifies the manifest + local sha256s and prints
//     the would-upload plan WITHOUT any network call (no HEAD, no PUT, no creds read).
//     This is a deliberate strengthening vs the starplates tool (whose dry-run still
//     issues HEADs) — real credentials exist on this box, so dry-run must never touch
//     the wire.
//
// CREDENTIALS (S3-compatible API, no new npm deps — SigV4 via node:crypto):
//   R2_ACCOUNT_ID          Cloudflare account id (hex)
//   R2_ACCESS_KEY_ID       R2 API token access key id
//   R2_SECRET_ACCESS_KEY   R2 API token secret
//   R2_BUCKET / COMMUNITY_BUCKET   optional, default "community-database"
//   R2_ENDPOINT            optional, default https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
// (this repo keeps account-scoped creds for this bucket in
//  src/engine/ui/dashboard/.env.r2 — referenced by PATH only; this tool reads only
//  process.env, never that file.)
// If the env credentials are absent this tool NO-OPS with a clear message and exit
// code 0 — publishing is a sync step, never a build dependency (offline-first). There
// is intentionally NO wrangler fallback: HEAD-before-PUT immutability cannot be
// enforced through `wrangler r2 object put`, and an immutable archive must not lose it.
//
// USAGE
//   node tools/community/publish_dump.mjs --dir <dossier-dir> [--bucket community-database] [--dry-run] [--update-index]
//   (--dir may also be passed positionally: node ... publish_dump.mjs <dossier-dir>)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const DRY_RUN = argv.includes('--dry-run');
const UPDATE_INDEX = argv.includes('--update-index');
// COMMUNITY_BUCKET only — R2_BUCKET deliberately NOT honored here: in this repo's env
// it names the STARPLATES catalog bucket, and honoring it once routed a dossier into
// the public catalog bucket (2026-07-09 incident; objects deleted, precedence fixed).
const BUCKET = opt('bucket', process.env.COMMUNITY_BUCKET || 'community-database');
// --dir <dossier> (or the first bare positional arg)
const positional = argv.filter((a) => !a.startsWith('--'));
const dirArg = opt('dir', null);
const DIR_RAW = (dirArg && dirArg !== true) ? dirArg : positional[0];
if (!DIR_RAW) {
  console.error('publish_dump: a dossier dir is required (--dir <dossier> or a positional path).');
  process.exit(1);
}
const DIR = path.resolve(DIR_RAW);

// ---- key-segment sanitizers (path-safe, brand-neutral) ----------------------
const DUMPS_PREFIX = 'dumps';
function safeDate(s) {
  const v = String(s);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) throw new Error(`capture_date "${v}" must be YYYY-MM-DD (partition key).`);
  return v;
}
function safeFrameId(s) {
  const v = String(s);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) throw new Error(`frame_id "${v}" is not a safe key segment ([A-Za-z0-9._-]).`);
  return v;
}

// ---- content-type by declared kind / extension ------------------------------
function contentTypeFor(artifact) {
  if (artifact.content_type && typeof artifact.content_type === 'string') return artifact.content_type;
  const ext = path.extname(artifact.path).toLowerCase();
  switch (ext) {
    case '.json': return 'application/json';
    case '.jsonl': return 'application/x-ndjson';
    case '.png': return 'image/png';
    case '.arrow': return 'application/vnd.apache.arrow.file';
    case '.fits': case '.fit': return 'application/fits';
    case '.asdf': return 'application/x-asdf';
    default: return 'application/octet-stream';
  }
}

// ---- gather + verify the upload set (local sha vs manifest, hard error) ------
function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function collectUploadSet() {
  const manifestPath = path.join(DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`missing ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'community-dump/1') {
    throw new Error(`manifest.schema (${manifest.schema}) != "community-dump/1"; refusing.`);
  }
  const captureDate = safeDate(manifest.capture_date);
  const frameId = safeFrameId(manifest.frame_id);
  const prefix = `${DUMPS_PREFIX}/${captureDate}/${frameId}`;
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('manifest.artifacts must be a non-empty array.');
  }
  const objects = [];
  for (const art of manifest.artifacts) {
    const rel = String(art.path ?? '');
    // refuse anything that escapes the dossier dir (spec §3.2)
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      throw new Error(`artifact path escapes the dossier: "${rel}"`);
    }
    const local = path.join(DIR, rel);
    const resolved = path.resolve(local);
    if (resolved !== DIR && !resolved.startsWith(DIR + path.sep)) {
      throw new Error(`artifact path resolves outside the dossier: "${rel}"`);
    }
    if (!fs.existsSync(local)) throw new Error(`manifest names ${rel} but the file is missing locally`);
    const sha = sha256File(local);
    if (art.sha256 && sha !== art.sha256) {
      throw new Error(`LOCAL INTEGRITY FAILURE: ${rel} sha256=${sha} != manifest ${art.sha256} — refusing to publish a torn dossier.`);
    }
    objects.push({
      key: `${prefix}/${rel.split(path.sep).join('/')}`,
      local,
      sha256: sha,
      contentType: contentTypeFor(art),
      bytes: fs.statSync(local).size,
    });
  }
  // the manifest itself is the last object (its sha256 chains the dossier — spec §4)
  objects.push({
    key: `${prefix}/manifest.json`,
    local: manifestPath,
    sha256: sha256File(manifestPath),
    contentType: 'application/json',
    bytes: fs.statSync(manifestPath).size,
  });
  return { manifest, prefix, dossierId: `${captureDate}/${frameId}`, objects };
}

// ---- SigV4 (S3-compatible, region "auto") — verbatim from starplates/publish_r2 --
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
    uri: url.pathname, // keys are [A-Za-z0-9./_-] — already canonical
    headers,
    payloadHash,
    accessKey: env.accessKey,
    secretKey: env.secretKey,
  });
  return fetch(url, { method, headers: signed, body: body ?? undefined });
}

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

async function publishViaS3(env, objects) {
  let uploaded = 0, skipped = 0;
  for (const o of objects) {
    const head = await s3Request(env, 'HEAD', o.key);
    if (head.status === 200) {
      const remoteSha = head.headers.get('x-amz-meta-sha256');
      if (remoteSha === o.sha256) {
        skipped++;
        console.log(`[dump] skip (exists, sha match)   ${o.key}`);
        continue;
      }
      throw new Error(
        `IMMUTABILITY VIOLATION: ${o.key} already exists with sha256=${remoteSha ?? '(none)'} != local ${o.sha256}. ` +
        `Dossiers are append-only — a re-processed frame ships under a NEW capture_date/frame_id. Never overwriting.`);
    }
    if (head.status !== 404) {
      throw new Error(`HEAD ${o.key} failed: HTTP ${head.status} ${await head.text().then((t) => t.slice(0, 200))}`);
    }
    const body = fs.readFileSync(o.local);
    const res = await s3Request(env, 'PUT', o.key, {
      body,
      headers: {
        'content-type': o.contentType,
        'cache-control': CACHE_CONTROL,
        'x-amz-meta-sha256': o.sha256,
      },
    });
    if (!res.ok) throw new Error(`PUT ${o.key} failed: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`);
    uploaded++;
    console.log(`[dump] uploaded                 ${o.key} (${o.bytes} B)`);
  }
  return { uploaded, skipped };
}

async function updateIndexViaS3(env, dossierId) {
  const key = `${DUMPS_PREFIX}/index.json`;
  let index = { dossiers: [] };
  const res = await s3Request(env, 'GET', key);
  if (res.status === 200) {
    try { index = JSON.parse(await res.text()); } catch { index = { dossiers: [] }; }
  } else if (res.status !== 404) {
    throw new Error(`GET ${key} failed: HTTP ${res.status}`);
  }
  if (!Array.isArray(index.dossiers)) index.dossiers = [];
  if (index.dossiers.includes(dossierId)) {
    console.log(`[dump] index already lists ${dossierId}`);
    return;
  }
  index.dossiers.push(dossierId);
  index.dossiers.sort();
  const body = Buffer.from(JSON.stringify(index, null, 2) + '\n');
  const put = await s3Request(env, 'PUT', key, {
    body,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' }, // the ONE mutable object (spec §3.3)
  });
  if (!put.ok) throw new Error(`PUT ${key} failed: HTTP ${put.status}`);
  console.log(`[dump] updated ${key}: +${dossierId}`);
}

// ---- main ----------------------------------------------------------------------
async function main() {
  const { prefix, dossierId, objects } = collectUploadSet();
  const totalBytes = objects.reduce((s, o) => s + o.bytes, 0);
  console.log(`[dump] dossier ${dossierId}: ${objects.length} objects (${totalBytes} B) -> bucket ${BUCKET}/${prefix}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  // DRY RUN is fully offline: print the plan, never touch the wire (no HEAD, no PUT,
  // no credentials read). Guarantees --dry-run can never mutate the bucket.
  if (DRY_RUN) {
    for (const o of objects) {
      console.log(`[dump] would upload             ${o.key} (${o.bytes} B, ${o.contentType})`);
    }
    if (UPDATE_INDEX) console.log(`[dump] would update ${DUMPS_PREFIX}/index.json: +${dossierId}`);
    console.log('[dump] DRY RUN — no network, no PUT. Local dossier verified against manifest sha256s.');
    return;
  }

  const env = s3Env();
  if (env) {
    const { uploaded, skipped } = await publishViaS3(env, objects);
    if (UPDATE_INDEX) await updateIndexViaS3(env, dossierId);
    console.log(`[dump] done: ${uploaded} uploaded, ${skipped} skipped.`);
    return;
  }
  // Never fail the build over missing credentials — publishing is a sync step.
  console.log('[dump] NO-OP: no R2 credentials found in the environment.');
  console.log('[dump] To publish, set env vars (or source src/engine/ui/dashboard/.env.r2 into the environment):');
  console.log('[dump]   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY  (optional: R2_BUCKET/COMMUNITY_BUCKET, R2_ENDPOINT)');
  console.log('[dump] Local dossier is untouched and valid. (Re-run with --dry-run to see the upload plan offline.)');
}

main().catch((e) => { console.error('[dump] FATAL:', e.message ?? e); process.exit(1); });
