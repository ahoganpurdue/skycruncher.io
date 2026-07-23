#!/usr/bin/env node
// tools/ops/r2_upload_tree.mjs
// Generic directory -> R2 backup uploader (S3 SigV4, zero deps).
// Unlike tools/starplates/publish_r2.mjs this is NOT release-scoped: it mirrors
// an arbitrary local tree under a key prefix. Idempotent: HEAD-before-PUT with
// x-amz-meta-sha256 comparison; existing+matching objects are skipped, existing
// +mismatched objects are reported as CONFLICT and never overwritten.
//
// Usage:
//   node tools/ops/r2_upload_tree.mjs --dir <localDir> --prefix <keyPrefix> \
//        [--bucket starplates] [--env <path to .env.r2>] [--dry-run]
//
// Creds: R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (env or --env file).

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createHash, createHmac } from 'node:crypto';

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const DIR = path.resolve(String(arg('dir', '')));
const PREFIX = String(arg('prefix', '')).replace(/^\/+|\/+$/g, '');
const BUCKET = String(arg('bucket', 'starplates'));
const ENV_FILE = arg('env', null);
const DRY_RUN = argv.includes('--dry-run');
if (!DIR || !fs.existsSync(DIR) || !PREFIX) {
  console.error('Usage: r2_upload_tree.mjs --dir <localDir> --prefix <keyPrefix> [--bucket b] [--env .env.r2] [--dry-run]');
  process.exit(1);
}

if (ENV_FILE && fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}
const accountId = process.env.R2_ACCOUNT_ID;
const accessKey = process.env.R2_ACCESS_KEY_ID;
const secretKey = process.env.R2_SECRET_ACCESS_KEY;
if (!accountId || !accessKey || !secretKey) {
  console.error('[r2] missing creds: need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  process.exit(1);
}
const endpoint = (process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '');

function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
function hex(buf) { return Buffer.from(buf).toString('hex'); }
function sha256Hex(data) { return createHash('sha256').update(data).digest('hex'); }

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(p).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function signV4({ method, host, uri, headers, payloadHash }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto', service = 's3';
  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${String(all[Object.keys(all).find((k) => k.toLowerCase() === h)]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, uri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  let key = hmac(`AWS4${secretKey}`, dateStamp);
  key = hmac(key, region); key = hmac(key, service); key = hmac(key, 'aws4_request');
  const signature = hex(hmac(key, stringToSign));
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

// Raw https request; body may be null or a file path (streamed with content-length).
function request(method, key, { filePath = null, payloadHash, extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${endpoint}/${BUCKET}/${key}`);
    const headers = signV4({ method, host: url.host, uri: url.pathname, headers: extraHeaders, payloadHash });
    const req = https.request({ method, hostname: url.hostname, path: url.pathname, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 2048) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(15 * 60 * 1000, () => req.destroy(new Error('timeout')));
    if (filePath) fs.createReadStream(filePath).pipe(req); else req.end();
  });
}

async function retry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fn();
      if (res.status === 429 || res.status >= 500) lastErr = new Error(`${label}: HTTP ${res.status} (transient)`);
      else return res;
    } catch (e) { lastErr = e; }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw lastErr;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const MIME = { '.json': 'application/json', '.md': 'text/markdown', '.csv': 'text/csv', '.gz': 'application/gzip', '.log': 'text/plain', '.dat': 'application/octet-stream' };

async function main() {
  const files = walk(DIR).sort();
  const t0 = Date.now();
  let uploaded = 0, skipped = 0, conflicts = 0, bytesUp = 0;
  console.log(`[r2] ${files.length} files under ${DIR} -> s3://${BUCKET}/${PREFIX}/ ${DRY_RUN ? '(DRY RUN)' : ''}`);
  for (const f of files) {
    const rel = path.relative(DIR, f).split(path.sep).join('/');
    const key = `${PREFIX}/${rel}`;
    const size = fs.statSync(f).size;
    const sha = await sha256File(f);
    const head = await retry(() => request('HEAD', key, { payloadHash: sha256Hex('') }), `HEAD ${key}`);
    if (head.status === 200) {
      if (head.headers['x-amz-meta-sha256'] === sha) { console.log(`[r2] skip (exists, sha match)  ${key}`); skipped++; continue; }
      console.error(`[r2] CONFLICT (exists, sha MISMATCH — not overwriting)  ${key}`); conflicts++; continue;
    }
    if (head.status !== 404) { console.error(`[r2] HEAD ${key}: HTTP ${head.status} ${head.body.slice(0, 160)}`); conflicts++; continue; }
    if (DRY_RUN) { console.log(`[r2] would upload  ${key} (${size} B)`); continue; }
    const contentType = MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';
    const put = await retry(() => request('PUT', key, {
      filePath: f, payloadHash: sha,
      extraHeaders: { 'content-length': String(size), 'content-type': contentType, 'x-amz-meta-sha256': sha },
    }), `PUT ${key}`);
    if (put.status !== 200) { console.error(`[r2] PUT ${key}: HTTP ${put.status} ${put.body.slice(0, 160)}`); conflicts++; continue; }
    uploaded++; bytesUp += size;
    console.log(`[r2] uploaded  ${key}  (${(size / 1048576).toFixed(1)} MB; total ${(bytesUp / 1073741824).toFixed(2)} GB, ${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  }
  console.log(JSON.stringify({ ok: conflicts === 0, uploaded, skipped, conflicts, gb: +(bytesUp / 1073741824).toFixed(2), minutes: +((Date.now() - t0) / 60000).toFixed(1) }));
  process.exit(conflicts === 0 ? 0 : 2);
}

main().catch((e) => { console.error('[r2] fatal:', e.message); process.exit(1); });
