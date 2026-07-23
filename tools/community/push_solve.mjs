// push_solve.mjs — push ONE completed solve's artifacts to the community R2 store,
// content-addressed, with two-level dedup. Callable module + thin CLI.
// (No shebang on purpose — same reason as publish_dump.mjs / assemble_dossier.mjs:
//  vitest inlines project .mjs through esbuild.transform which does NOT strip `#!`;
//  V8 then rejects it at import. Invoke via `node tools/community/push_solve.mjs`.)
// ============================================================================
// CONTRACT. Sibling of tools/community/publish_dump.mjs — same "community-database"
// bucket, same auth (SigV4 via node:crypto, zero npm deps), same immutable
// Cache-Control + x-amz-meta-sha256 convention. This tool pushes a FINISHED solve
// (its receipt, plus optional extras like a render PNG) as the pipeline produces it,
// so completed solves flow to the community store from the Headless, Batch, and
// (future) Desktop lanes. Honest failures are welcome — an unsolved receipt still
// uploads and is recorded (solved:false); the point is a truthful census, not a
// trophy case.
//
// OBJECT KEY SCHEME (content-addressed, immutable):
//   solves/<frame_sha256_12>/<artifact_sha256>.<ext>
//   - frame_sha256_12 = first 12 hex of sha256(ORIGINAL frame bytes) — groups every
//     run of the same frame under one prefix.
//   - artifact_sha256 = full 64-hex sha256 of THAT object's bytes — the name IS the
//     content hash, so a byte-identical artifact always lands on the same key.
//   Per-object custom metadata:  sha256=<full artifact hash> (matches the dossier
//   convention), frame-sha=<full frame hash>, receipt-schema-version, solved
//   (true|false), engine-ref (git short sha). Cache-Control: immutable, 1y.
//
// PER-FRAME MANIFEST (the ONE mutable object, schema_version 1, additive-only per the
// DDIA day-one back/forward-compat ruling):
//   solves/<frame_sha256_12>/manifest.json
//   {
//     schema_version: 1,
//     frame_sha, frame_sha12,
//     quality_ordering: [<the v1 ordering, verbatim>],
//     runs:  [ { run_id, ts, engine_ref, receipt_schema_version, receipt_key,
//                artifacts:[{role,key,sha256,bytes,content_type}], quality:{...} } ],
//     best:  { run_id, receipt_key, quality },   // pointer only — never deletes runs
//     updated_at
//   }
//
// DEDUP LEVEL 1 (object): HEAD the content-addressed key BEFORE PUT; on hit skip &
//   count — objects are immutable and NEVER overwritten (the key already proves the
//   bytes match). LEVEL 2 (record, update-not-duplicate): a new push of the same
//   frame UPDATES the manifest's `best` pointer only when it STRICTLY improves the
//   documented v1 quality ordering below; otherwise the incumbent stands. Nothing is
//   ever deleted — superseded runs stay in `runs[]` as lineage. A re-push of an
//   IDENTICAL receipt (same run_id = receipt sha256) does not duplicate its run entry.
//
// V1 QUALITY ORDERING (strict, lexicographic; ties KEEP the incumbent):
//   1. solved                 (solved beats unsolved)
//   2. stars_matched          (more matched stars wins)
//   3. confirm_set_excess_z   (higher forced-photometry set-level excess-Z wins; a
//                              null/absent set statistic sorts as -Infinity)
//   4. product_count          (richer product set — psf_field, tps, spcc, … — wins)
//
// FLAG (v2): the manifest read-modify-write on R2 is LAST-WRITER-WINS. Correct only
//   under the single-writer (owner box) assumption that holds today. Concurrent
//   writers could lose a run entry. A v2 hardening = conditional PUT (If-Match on the
//   manifest ETag with retry) or a per-run append object + reduce-on-read.
//
// CREDENTIALS (S3-compatible; SigV4 via node:crypto — no new npm deps):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//   optional: R2_ENDPOINT, COMMUNITY_BUCKET (default "community-database").
//   R2_BUCKET is deliberately NOT honored (in this repo's env it names the public
//   STARPLATES catalog bucket — see publish_dump.mjs, 2026-07-09 incident).
//   Credentials ABSENT ⇒ honest silent NO-OP (exit 0). Publishing is a sync step,
//   never a build/solve dependency. There is intentionally no wrangler fallback
//   (HEAD-before-PUT immutability cannot be enforced through `wrangler r2 object put`).
//
// USAGE (CLI)
//   node tools/community/push_solve.mjs --receipt <receipt.json> \
//        (--frame <frame-file> | --frame-sha <64hex>) \
//        [--extra <path> ...] [--engine-ref <sha>] [--dry-run] \
//        [--env-file src/engine/ui/dashboard/.env.r2]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createHash, createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';

// ── pure hashing / typing helpers ───────────────────────────────────────────
export function sha256Hex(data) {
  return createHash('sha256').update(Buffer.isBuffer(data) ? data : Buffer.from(data)).digest('hex');
}
export function sha256File(p) { return sha256Hex(fs.readFileSync(p)); }

export function contentTypeForExt(ext) {
  switch (String(ext).toLowerCase().replace(/^\./, '')) {
    case 'json': return 'application/json';
    case 'jsonl': return 'application/x-ndjson';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'arrow': return 'application/vnd.apache.arrow.file';
    case 'fits': case 'fit': return 'application/fits';
    case 'asdf': return 'application/x-asdf';
    default: return 'application/octet-stream';
  }
}

// ── object / manifest key scheme (content-addressed) ────────────────────────
export const SOLVES_PREFIX = 'solves';
export function objectKey(frameSha12, artifactSha256, ext) {
  const e = String(ext).toLowerCase().replace(/^\./, '') || 'bin';
  return `${SOLVES_PREFIX}/${frameSha12}/${artifactSha256}.${e}`;
}
export function manifestKey(frameSha12) {
  return `${SOLVES_PREFIX}/${frameSha12}/manifest.json`;
}

// ── quality extraction (reads the receipt; never mutates it) ─────────────────
// Product blocks whose presence (non-null AND not self-flagged not_measured) counts
// toward richness. Sub-products (sip/tps) live under solution.astrometry; array
// blocks (planets/photometry/optics_hints) count only when non-empty.
function productPresent(v) {
  return v != null && !(typeof v === 'object' && !Array.isArray(v) && v.not_measured);
}
export function detectProducts(receipt) {
  const sol = receipt?.solution ?? null;
  const out = [];
  if (productPresent(receipt?.psf_field)) out.push('psf_field');
  if (productPresent(receipt?.psf_attribution)) out.push('psf_attribution');
  if (productPresent(receipt?.lens_distortion_measured)) out.push('lens_distortion_measured');
  if (productPresent(receipt?.deep_confirmed)) out.push('deep_confirmed');
  if (productPresent(receipt?.spcc)) out.push('spcc');
  const astro = sol?.astrometry ?? null;
  if (astro?.sip) out.push('sip');
  if (astro?.tps) out.push('tps');
  if (Array.isArray(receipt?.planets) && receipt.planets.length > 0) out.push('planets');
  if (Array.isArray(sol?.photometry) && sol.photometry.length > 0) out.push('photometry');
  if (Array.isArray(receipt?.optics_hints) && receipt.optics_hints.length > 0) out.push('optics_hints');
  return out.sort();
}

export function extractQuality(receipt) {
  const sol = receipt?.solution ?? null;
  const solved = !!(sol && typeof sol.ra_hours === 'number' && Number.isFinite(sol.ra_hours));
  const stars_matched = (sol && typeof sol.stars_matched === 'number') ? sol.stars_matched : 0;
  const confidence = (sol && typeof sol.confidence === 'number') ? sol.confidence : null;
  const cs = receipt?.confirm_status ?? null;
  const confirm_status = cs?.status ?? null;
  const confirm_set_excess_z = (cs && typeof cs.setExcessZ === 'number' && Number.isFinite(cs.setExcessZ))
    ? cs.setExcessZ : null;
  const products = detectProducts(receipt);
  return { solved, stars_matched, confidence, confirm_status, confirm_set_excess_z, products, product_count: products.length };
}

// ── v1 quality ordering (strict; ties keep incumbent) ────────────────────────
export const QUALITY_ORDERING = ['solved', 'stars_matched', 'confirm_set_excess_z', 'product_count'];

/** True IFF candidate `a` STRICTLY improves on incumbent `b` per QUALITY_ORDERING. */
export function isStrictlyBetter(a, b) {
  if (a.solved !== b.solved) return !!a.solved && !b.solved;
  if (a.stars_matched !== b.stars_matched) return a.stars_matched > b.stars_matched;
  const az = a.confirm_set_excess_z ?? -Infinity;
  const bz = b.confirm_set_excess_z ?? -Infinity;
  if (az !== bz) return az > bz;
  if (a.product_count !== b.product_count) return a.product_count > b.product_count;
  return false; // fully tied → keep the incumbent
}

// ── manifest merge (pure; time injectable for determinism) ───────────────────
export const MANIFEST_SCHEMA_VERSION = 1;

export function buildRunEntry({ receiptSha, receiptKey, receiptSchemaVersion, engineRef, quality, artifacts, ts }) {
  return {
    run_id: receiptSha,                       // content-addressed: identical receipt ⇒ same run
    ts,
    engine_ref: engineRef ?? null,
    receipt_schema_version: receiptSchemaVersion ?? null,
    receipt_key: receiptKey,
    artifacts,                                // [{ role, key, sha256, bytes, content_type }]
    quality,
  };
}

/**
 * Merge one run into the (possibly absent) prior manifest. Appends the run unless an
 * identical run_id already exists (record-level dedup), then recomputes `best` from
 * scratch over all runs so the result is deterministic and idempotent. `best` is a
 * pointer only — no run is ever removed.
 */
export function mergeManifest(existing, run, { frameSha, frameSha12, now }) {
  const compatible = existing && existing.schema_version === MANIFEST_SCHEMA_VERSION;
  const priorRuns = compatible && Array.isArray(existing.runs) ? existing.runs : [];
  const runs = priorRuns.slice();
  const already = runs.findIndex((r) => r.run_id === run.run_id) !== -1;
  if (!already) runs.push(run);

  let best = null;
  for (const r of runs) {
    if (best === null || isStrictlyBetter(r.quality, best.quality)) best = r;
  }
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    frame_sha: (compatible && existing.frame_sha) || frameSha,
    frame_sha12: (compatible && existing.frame_sha12) || frameSha12,
    quality_ordering: QUALITY_ORDERING,
    // Receipts carry Gaia-derived matched-star rows; public redistribution carries
    // the catalogue licence obligation (additive field, schema_version 1 unchanged).
    attribution: 'Contains data from ESA/Gaia/DPAC (CC BY-SA 3.0 IGO); solve products (c) their observers.',
    runs,
    best: best ? { run_id: best.run_id, receipt_key: best.receipt_key, quality: best.quality } : null,
    updated_at: now ?? new Date().toISOString(),
  };
  return { manifest, addedRun: !already, bestRunId: best ? best.run_id : null };
}

// ── SigV4 (S3-compatible, region "auto") — mirrored from starplates/publish_r2 ─
// publish_r2.mjs / publish_dump.mjs keep these module-private and run main() on
// import (CLI side-effects), so import-reuse is not clean; this is the sanctioned
// mirror (publish_dump + publish_app_release copy the same block).
function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
function hex(buf) { return Buffer.from(buf).toString('hex'); }

function signV4({ method, host, uri, headers, payloadHash, accessKey, secretKey }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto', service = 's3';
  const allHeaders = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(allHeaders).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names
    .map((h) => `${h}:${String(allHeaders[Object.keys(allHeaders).find((k) => k.toLowerCase() === h)]).trim()}\n`)
    .join('');
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

/** Community-bucket S3 env (COMMUNITY_BUCKET only — R2_BUCKET intentionally ignored). */
export function s3EnvCommunity() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKey || !secretKey) return null;
  const endpoint = (process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '');
  const bucket = process.env.COMMUNITY_BUCKET || 'community-database';
  return { endpoint, accessKey, secretKey, bucket };
}

/**
 * The injectable R2 client: { head, get, put } over content-addressed keys. Tests
 * pass a fake in-memory client with the same three methods, so no creds/network.
 */
export function makeR2Client(env) {
  async function s3Request(method, key, { body = null, headers = {} } = {}) {
    const u = new URL(`${env.endpoint}/${env.bucket}/${key}`);
    const payloadHash = body ? sha256Hex(body) : sha256Hex('');
    const signed = signV4({
      method, host: u.host, uri: u.pathname, // keys are [A-Za-z0-9./_-] — already canonical
      headers, payloadHash, accessKey: env.accessKey, secretKey: env.secretKey,
    });
    return fetch(u, { method, headers: signed, body: body ?? undefined });
  }
  return {
    async head(key) {
      const res = await s3Request('HEAD', key);
      return { status: res.status, sha256: res.headers.get('x-amz-meta-sha256') ?? null };
    },
    async get(key) {
      const res = await s3Request('GET', key);
      const bodyText = res.status === 200 ? await res.text() : null;
      return { status: res.status, body: bodyText };
    },
    async put(key, body, { contentType = 'application/octet-stream', cacheControl = 'no-cache', meta = {} } = {}) {
      const headers = { 'content-type': contentType, 'cache-control': cacheControl };
      for (const [k, v] of Object.entries(meta)) headers[`x-amz-meta-${k}`] = String(v);
      const res = await s3Request('PUT', key, { body, headers });
      return { ok: res.ok, status: res.status };
    },
  };
}

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/**
 * Core orchestration (client-injected). Uploads the receipt + extras content-addressed
 * (level-1 dedup: HEAD-before-PUT), then read-modify-writes the per-frame manifest
 * (level-2 dedup: update `best` only on strict improvement). Pure of any credential
 * scheme — the client is the only side-effecting dependency.
 */
export async function pushSolve({
  receiptBytes = null, receiptPath = null, frameSha, extras = [],
  engineRef = null, client, dryRun = false, log = () => {}, now = null,
}) {
  if (!receiptBytes) {
    if (!receiptPath) throw new Error('pushSolve: receiptBytes or receiptPath required');
    receiptBytes = fs.readFileSync(receiptPath);
  }
  receiptBytes = Buffer.isBuffer(receiptBytes) ? receiptBytes : Buffer.from(receiptBytes);
  if (!frameSha || !/^[0-9a-f]{64}$/i.test(frameSha)) {
    throw new Error('pushSolve: frameSha must be a 64-hex sha256 of the original frame bytes');
  }
  frameSha = frameSha.toLowerCase();
  const frameSha12 = frameSha.slice(0, 12);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const quality = extractQuality(receipt);
  const schemaVer = receipt?.version ?? null;

  // assemble the artifact set: receipt (mandatory, role 'receipt') + extras.
  const artifacts = [{
    role: 'receipt', bytes: receiptBytes, sha256: sha256Hex(receiptBytes),
    ext: 'json', content_type: 'application/json',
  }];
  for (const ex of extras) {
    const bytes = ex.bytes ? (Buffer.isBuffer(ex.bytes) ? ex.bytes : Buffer.from(ex.bytes)) : fs.readFileSync(ex.path);
    const ext = (ex.ext || path.extname(ex.path || '').replace(/^\./, '') || 'bin').toLowerCase();
    artifacts.push({
      role: ex.role || 'extra', bytes, sha256: sha256Hex(bytes),
      ext, content_type: ex.content_type || contentTypeForExt(ext),
    });
  }

  const commonMeta = {
    'frame-sha': frameSha,
    'receipt-schema-version': schemaVer == null ? '' : String(schemaVer),
    'solved': String(quality.solved),
    'engine-ref': engineRef == null ? '' : String(engineRef),
  };

  // ── LEVEL 1: content-addressed object dedup ────────────────────────────────
  const manifestArtifacts = [];
  let uploaded = 0, skipped = 0;
  for (const a of artifacts) {
    const key = objectKey(frameSha12, a.sha256, a.ext);
    manifestArtifacts.push({ role: a.role, key, sha256: a.sha256, bytes: a.bytes.length, content_type: a.content_type });
    if (dryRun) { log(`[push] would upload ${key} (${a.bytes.length} B, ${a.content_type})`); continue; }
    const head = await client.head(key);
    if (head.status === 200) { skipped++; log(`[push] skip (exists)  ${key}`); continue; }
    if (head.status !== 404) throw new Error(`HEAD ${key} failed: HTTP ${head.status}`);
    const put = await client.put(key, a.bytes, {
      contentType: a.content_type, cacheControl: IMMUTABLE_CACHE, meta: { sha256: a.sha256, ...commonMeta },
    });
    if (!put.ok) throw new Error(`PUT ${key} failed: HTTP ${put.status}`);
    uploaded++; log(`[push] uploaded       ${key} (${a.bytes.length} B)`);
  }

  const receiptKey = manifestArtifacts.find((a) => a.role === 'receipt').key;
  const ts = now ?? new Date().toISOString();
  const runEntry = buildRunEntry({
    receiptSha: sha256Hex(receiptBytes), receiptKey, receiptSchemaVersion: schemaVer,
    engineRef, quality, artifacts: manifestArtifacts, ts,
  });

  // ── LEVEL 2: per-frame manifest read-modify-write (last-writer-wins; see FLAG) ─
  const mKey = manifestKey(frameSha12);
  if (dryRun) {
    log(`[push] would update ${mKey} (run ${runEntry.run_id.slice(0, 12)}; best re-evaluated)`);
    return { dryRun: true, frameSha12, uploaded: 0, skipped: 0, artifacts: manifestArtifacts, runEntry, quality };
  }
  const got = await client.get(mKey);
  let existing = null;
  if (got.status === 200 && got.body) { try { existing = JSON.parse(got.body); } catch { existing = null; } }
  else if (got.status !== 404) throw new Error(`GET ${mKey} failed: HTTP ${got.status}`);

  const { manifest, addedRun, bestRunId } = mergeManifest(existing, runEntry, { frameSha, frameSha12, now: ts });
  const mBody = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const put = await client.put(mKey, mBody, {
    contentType: 'application/json', cacheControl: 'no-cache', meta: { sha256: sha256Hex(mBody) },
  });
  if (!put.ok) throw new Error(`PUT ${mKey} failed: HTTP ${put.status}`);
  const becameBest = bestRunId === runEntry.run_id;
  log(`[push] manifest      ${mKey}: runs=${manifest.runs.length}, best=${becameBest ? 'THIS run' : 'incumbent'}`);
  return { frameSha12, uploaded, skipped, artifacts: manifestArtifacts, runEntry, addedRun, becameBest, manifestRuns: manifest.runs.length, quality };
}

/** Best-effort engine ref (git short sha); null on failure — honest-or-absent. */
export function gitShortSha() {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

/**
 * Convenience wrapper the Headless/Batch/Desktop hooks call. Resolves the frame sha
 * (from frameBytes or an explicit frameSha), builds the real R2 client from
 * s3EnvCommunity() — creds absent ⇒ honest NO-OP (one log line, never throws for
 * missing creds) — and delegates to pushSolve. `clientOverride` lets tests inject.
 */
export async function pushSolveFromReceipt({
  receiptPath = null, receiptBytes = null, frameBytes = null, frameSha = null,
  extras = [], engineRef = undefined, dryRun = false, log = console.log, clientOverride = null, now = null,
}) {
  if (!frameSha && frameBytes) frameSha = sha256Hex(frameBytes);
  if (!frameSha) throw new Error('pushSolveFromReceipt: frameBytes or frameSha required');
  const client = clientOverride || (s3EnvCommunity() ? makeR2Client(s3EnvCommunity()) : null);
  if (!dryRun && !client) {
    log('[push] NO-OP: no R2 credentials in env (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY). Solve is unaffected.');
    return { noop: true };
  }
  const ref = engineRef === undefined ? gitShortSha() : engineRef;
  return pushSolve({ receiptPath, receiptBytes, frameSha, extras, engineRef: ref, client: client || undefined, dryRun, log, now });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function loadEnvFile(p) {
  if (!p || !fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

async function cliMain(argv) {
  const many = (name) => { const out = []; for (let i = 0; i < argv.length; i++) if (argv[i] === '--' + name) out.push(argv[i + 1]); return out; };
  const one = (name, def = null) => { const i = argv.indexOf('--' + name); if (i === -1) return def; const v = argv[i + 1]; return (v === undefined || v.startsWith('--')) ? true : v; };
  const dryRun = argv.includes('--dry-run');
  const receiptPath = one('receipt');
  if (!receiptPath || receiptPath === true) { console.error('push_solve: --receipt <path> is required.'); process.exit(1); }
  const framePath = one('frame');
  let frameSha = one('frame-sha');
  if ((!framePath || framePath === true) && (!frameSha || frameSha === true)) {
    console.error('push_solve: one of --frame <frame-file> or --frame-sha <64hex> is required.'); process.exit(1);
  }
  if (framePath && framePath !== true) frameSha = sha256File(framePath);
  const extras = many('extra').filter((p) => p && !p.startsWith('--')).map((p) => ({ path: p, role: 'extra' }));
  const engineRefArg = one('engine-ref');
  const engineRef = (engineRefArg && engineRefArg !== true) ? engineRefArg : gitShortSha();
  const envFileArg = one('env-file');
  if (!dryRun) loadEnvFile(path.resolve((envFileArg && envFileArg !== true) ? envFileArg : 'src/engine/ui/dashboard/.env.r2'));

  const res = await pushSolveFromReceipt({ receiptPath, frameSha, extras, engineRef, dryRun, log: console.log });
  if (res?.noop) {
    console.log('[push] To publish, set R2 creds (or source src/engine/ui/dashboard/.env.r2). Re-run with --dry-run to preview the plan offline.');
    return;
  }
  if (dryRun) { console.log('[push] DRY RUN — no network, no PUT.'); return; }
  console.log(`[push] done: ${res.uploaded} uploaded, ${res.skipped} skipped; frame ${res.frameSha12}, ${res.manifestRuns} run(s) in manifest, best=${res.becameBest ? 'THIS run' : 'incumbent'}.`);
}

// run main() only when invoked directly (never on vitest import — see header).
const invokedDirectly = (() => {
  try { return process.argv[1] && url.fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); } catch { return false; }
})();
if (invokedDirectly) cliMain(process.argv.slice(2)).catch((e) => { console.error('[push] FATAL:', e?.message ?? e); process.exit(1); });
