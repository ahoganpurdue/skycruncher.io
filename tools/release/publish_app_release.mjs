#!/usr/bin/env node
// publish_app_release.mjs — publish a desktop release (NSIS installer + sig +
// latest.json) to the R2 `app-releases` bucket for the Tauri v2 updater.
// ============================================================================
// Mirrors the starplates immutable-release + one-mutable-index pattern
// (tools/starplates/publish_r2.mjs §7). The SigV4 signer block is COPIED from
// that tool (publish_r2.mjs:108-158) so there are no new deps (node:crypto).
//
// LAYOUT (bucket = app-releases):
//   releases/<version>/SkyCruncher_<version>_x64-setup.exe       immutable, max-age=31536000
//   releases/<version>/SkyCruncher_<version>_x64-setup.exe.sig   immutable
//   latest.json                                                 MUTABLE, no-cache (updater endpoint)
//
// CREDENTIALS (S3-compatible; loaded from --env-file, default the dashboard
//   .env.r2). NEVER printed. Vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
//   R2_SECRET_ACCESS_KEY, optional R2_ENDPOINT.
//
// USAGE
//   node tools/release/publish_app_release.mjs \
//        --version 1.0.1 --setup <path-to-setup.exe> --sig <path-to-.sig> \
//        [--latest <path-to-latest.json>] [--create-bucket] [--dry-run]
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
const VERSION = opt('version', null);
const SETUP = opt('setup', null);
const SIG = opt('sig', null);
const LATEST = opt('latest', null);
const CREATE_BUCKET = argv.includes('--create-bucket');
const DRY_RUN = argv.includes('--dry-run');
const BUCKET = process.env.R2_BUCKET_APP_RELEASES || 'app-releases';
const ENV_FILE = opt('env-file', 'src/engine/ui/dashboard/.env.r2');

// ---- load .env.r2 into process.env (values never printed) -------------------
function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadEnvFile(path.resolve(ENV_FILE));

// ---- SigV4 (S3-compatible, region "auto") — copied from publish_r2.mjs:108-158
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

// Generic request against an arbitrary bucket-scoped path (uri = /<bucket>[/<key>]).
async function s3Request(env, method, uriPath, { body = null, headers = {} } = {}) {
  const url = new URL(`${env.endpoint}${uriPath}`);
  const payloadHash = body ? sha256Hex(body) : sha256Hex('');
  const signed = signV4({
    method, host: url.host, uri: url.pathname, headers, payloadHash,
    accessKey: env.accessKey, secretKey: env.secretKey,
  });
  return fetch(url, { method, headers: signed, body: body ?? undefined });
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

async function createBucket(env) {
  const res = await s3Request(env, 'PUT', `/${BUCKET}`);
  if (res.ok) { console.log(`[r2] bucket ${BUCKET} created`); return; }
  const txt = await res.text();
  // R2 returns BucketAlreadyOwnedByYou / 409 when it already exists — idempotent OK.
  if (res.status === 409 || /BucketAlreadyOwned|BucketAlreadyExists/.test(txt)) {
    console.log(`[r2] bucket ${BUCKET} already exists (ok)`);
    return;
  }
  throw new Error(`CreateBucket ${BUCKET} failed: HTTP ${res.status} ${txt.slice(0, 200)}`);
}

async function putObject(env, key, localPath, contentType, cacheControl) {
  const body = fs.readFileSync(localPath);
  const sha = sha256Hex(body);
  if (DRY_RUN) { console.log(`[r2] would PUT ${key} (${body.length} B, sha ${sha.slice(0, 12)}…)`); return; }
  const res = await s3Request(env, 'PUT', `/${BUCKET}/${key}`, {
    body,
    headers: { 'content-type': contentType, 'cache-control': cacheControl, 'x-amz-meta-sha256': sha },
  });
  if (!res.ok) throw new Error(`PUT ${key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  console.log(`[r2] PUT ${key} (${body.length} B)`);
}

async function main() {
  const env = s3Env();
  if (!env) {
    console.error('[r2] NO CREDENTIALS: R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY not set (checked env + ' + ENV_FILE + ').');
    process.exit(2);
  }
  if (CREATE_BUCKET) await createBucket(env);

  if (VERSION && SETUP) {
    if (!fs.existsSync(SETUP)) throw new Error(`--setup not found: ${SETUP}`);
    const setupName = path.basename(SETUP);
    await putObject(env, `releases/${VERSION}/${setupName}`, SETUP, 'application/vnd.microsoft.portable-executable', IMMUTABLE);
    if (SIG) {
      if (!fs.existsSync(SIG)) throw new Error(`--sig not found: ${SIG}`);
      await putObject(env, `releases/${VERSION}/${path.basename(SIG)}`, SIG, 'text/plain', IMMUTABLE);
    }
  }
  if (LATEST) {
    if (!fs.existsSync(LATEST)) throw new Error(`--latest not found: ${LATEST}`);
    await putObject(env, 'latest.json', LATEST, 'application/json', 'no-cache');
  }
  console.log('[r2] done.');
}

main().catch((e) => { console.error('[r2] FATAL:', e.message ?? e); process.exit(1); });
