// lib/r2.mjs — shared R2 (S3-compatible) SigV4 client for the results lane.
// ============================================================================
// The SigV4 signing + credential loading was LIFTED from
// tools/starplates/publish_r2.mjs (zero-dep, node:crypto). Extracted here so the
// full-tree uploader (upload_r2.mjs) and the incremental drain (drain_to_r2.mjs)
// share ONE signing implementation (CLAUDE.md LAW 4).
//
// CREDENTIALS: read from src/engine/ui/dashboard/.env.r2 (gitignored). Values are
// NEVER printed, logged, or written to any artifact by this module. Callers must
// keep them out of logs/manifests too (only keys/bytes/sha256 are safe to record).
// ============================================================================

import fs from 'node:fs';
import { createHash, createHmac } from 'node:crypto';

// ---- credential loading (values never leave process memory) -----------------
export function loadEnvFile(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (let line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

// Resolve R2 credentials (env vars override .env.r2). Returns null if incomplete.
export function s3Env(envFile) {
  const file = loadEnvFile(envFile);
  const accountId = process.env.R2_ACCOUNT_ID || file.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID || file.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY || file.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKey || !secretKey) return null;
  const endpoint = (process.env.R2_ENDPOINT || file.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '');
  const endpointHost = endpoint.replace(/^https?:\/\//, '');
  return { accountId, endpoint, endpointHost, accessKey, secretKey };
}

// ---- SigV4 (lifted from tools/starplates/publish_r2.mjs) --------------------
function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
function hex(buf) { return Buffer.from(buf).toString('hex'); }
export function sha256Hex(data) { return createHash('sha256').update(data).digest('hex'); }

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
  key = hmac(key, region); key = hmac(key, service); key = hmac(key, 'aws4_request');
  const signature = hex(hmac(key, stringToSign));
  return { ...allHeaders, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

function encodeKey(key) { return key.split('/').map((seg) => encodeURIComponent(seg)).join('/'); }

// Create a bucket-scoped S3 client with SigV4 signing + 429/5xx retry.
export function createS3Client({ env, bucket }) {
  async function request(method, key, { body = null, headers = {} } = {}) {
    const url = new URL(`${env.endpoint}/${bucket}/${encodeKey(key)}`);
    const payloadHash = body ? sha256Hex(body) : sha256Hex('');
    const signed = signV4({ method, host: url.host, uri: url.pathname, headers, payloadHash, accessKey: env.accessKey, secretKey: env.secretKey });
    return fetch(url, { method, headers: signed, body: body ?? undefined });
  }
  async function requestRetry(method, key, opts) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await request(method, key, opts);
        if (res.status === 429 || res.status >= 500) lastErr = new Error(`${method} ${key}: HTTP ${res.status}`);
        else return res;
      } catch (e) { lastErr = e; }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    throw lastErr;
  }
  return { bucket, request, requestRetry };
}
