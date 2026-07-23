// [Module: community] SkyCruncher receipt-intake Worker (TEST/DEV tier).
//
// The ONLY writer in front of the skycruncher-intake R2 bucket. Anonymous +
// per-IP quota; no tokens, no Turnstile yet (ruled). R2/KV are native bindings
// — NEVER credentials in code.
//
// POST /v1/receipts  — accept a SCRUBBED solve receipt (the payload IS the
//   receipt JSON). Cheapest-reject-first:
//     size cap        -> 413
//     content-type    -> 415 (JSON only)
//     per-IP quota     -> 429 (Retry-After)
//     JSON parse       -> 400
//     schema version   -> 422  ({error, field:"version"})  present + 2.x
//     PRIVACY RE-SCAN  -> 422  ({error, field})  defense-in-depth: the edge
//                          never trusts the client scrub (raw gps beyond
//                          integer-degree, altitude, source_provenance,
//                          user_annotations prose/location_text).
//   Accepted -> idempotent PUT  intake/<version>/<sha256-of-payload>.json
//     new digest      -> 201 {deduped:false, key, sha256}
//     existing digest -> 200 {deduped:true,  key, sha256}
//
// GET /v1/health -> 200 {status, version, bucket_bound, kv_bound}.

const SERVICE_VERSION = '0.1.0-testdev';
const SCHEMA_MAJOR_OK = /^2\./; // RECEIPT_SCHEMA_VERSION must be present and 2.x

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(extraHeaders || {}) },
  });
}

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Privacy re-scan at the edge. Returns the first offending field name, or null. ──
// Mirrors tools/community/scrub_receipt.mjs reject list; keys on EXACT paths so
// the science (per-star photometry `.provenance`, matched_stars, wcs) is never
// touched. The edge never trusts a stale/absent client scrub.
function privacyOffender(receipt) {
  const md = receipt.metadata;
  if (isObj(md)) {
    for (const key of ['gps_lat', 'gps_lon']) {
      const v = md[key];
      if (typeof v === 'number' && Number.isFinite(v) && v !== Math.round(v)) {
        return `metadata.${key}`; // raw decimal beyond integer-degree grid
      }
    }
    for (const altKey of ['gps_alt', 'gps_altitude', 'altitude', 'gps_elevation']) {
      if (altKey in md && md[altKey] != null) return `metadata.${altKey}`; // altitude must be dropped
    }
    if ('source_provenance' in md && md.source_provenance != null) return 'metadata.source_provenance';
  }
  if ('source_provenance' in receipt && receipt.source_provenance != null) return 'source_provenance';
  const ua = receipt.user_annotations;
  if (ua != null) {
    if (isObj(ua)) {
      // location_text first (named in the ruling), then any remaining prose field.
      if (ua.location_text != null) return 'user_annotations.location_text';
      for (const k of Object.keys(ua)) {
        if (ua[k] != null && ua[k] !== '') return `user_annotations.${k}`;
      }
    } else {
      return 'user_annotations';
    }
  }
  return null;
}

// ── Per-IP quota via KV (eventually-consistent; abuse floor, not billing). ──
async function checkAndBumpQuota(env, ip) {
  const perHour = parseInt(env.QUOTA_PER_HOUR || '60', 10);
  const perDay = parseInt(env.QUOTA_PER_DAY || '500', 10);
  const now = new Date();
  const hKey = `q:h:${ip}:${now.toISOString().slice(0, 13)}`; // YYYY-MM-DDTHH
  const dKey = `q:d:${ip}:${now.toISOString().slice(0, 10)}`; // YYYY-MM-DD
  const [hRaw, dRaw] = await Promise.all([env.QUOTA.get(hKey), env.QUOTA.get(dKey)]);
  const hCount = parseInt(hRaw || '0', 10);
  const dCount = parseInt(dRaw || '0', 10);
  if (hCount >= perHour) return { ok: false, retryAfter: 3600, scope: 'hour', limit: perHour };
  if (dCount >= perDay) return { ok: false, retryAfter: 86400, scope: 'day', limit: perDay };
  await Promise.all([
    env.QUOTA.put(hKey, String(hCount + 1), { expirationTtl: 3700 }),
    env.QUOTA.put(dKey, String(dCount + 1), { expirationTtl: 90000 }),
  ]);
  return { ok: true };
}

async function handleReceipts(request, env) {
  const MAX_BYTES = parseInt(env.MAX_BYTES || '2097152', 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // 1. Size cap (from header, cheapest reject) — 413.
  const cl = request.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_BYTES) {
    return json({ error: 'payload too large', max_bytes: MAX_BYTES }, 413);
  }

  // 2. Content-Type: JSON only — 415.
  const ct = request.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('application/json')) {
    return json({ error: 'unsupported media type; JSON only', got: ct || null }, 415);
  }

  // 3. Read body & re-check actual byte length (Content-Length can lie) — 413.
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return json({ error: 'payload too large', max_bytes: MAX_BYTES, got_bytes: buf.byteLength }, 413);
  }

  // 4. Per-IP quota — 429.
  const q = await checkAndBumpQuota(env, ip);
  if (!q.ok) {
    return json(
      { error: 'rate limit exceeded', scope: q.scope, limit: q.limit },
      429,
      { 'Retry-After': String(q.retryAfter) },
    );
  }

  // 5. JSON parse — 400.
  let receipt;
  try {
    receipt = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  if (!isObj(receipt)) return json({ error: 'body must be a JSON object' }, 400);

  // 6. Schema version present + 2.x — 422.
  const version = receipt.version;
  if (typeof version !== 'string' || !SCHEMA_MAJOR_OK.test(version)) {
    return json({ error: 'unsupported or missing RECEIPT_SCHEMA_VERSION; expected 2.x', field: 'version', got: version ?? null }, 422);
  }

  // 7. Privacy re-scan at the edge — 422 naming the offending field.
  const offender = privacyOffender(receipt);
  if (offender) {
    return json({ error: 'privacy re-scan rejected payload; field still present unscrubbed', field: offender }, 422);
  }

  // 8. Idempotent PUT: intake/<version>/<sha256-of-payload>.json
  const sha = await sha256Hex(buf);
  const key = `intake/${version}/${sha}.json`;
  const existing = await env.INTAKE.head(key);
  if (existing) {
    return json({ deduped: true, key, sha256: sha }, 200);
  }
  await env.INTAKE.put(key, buf, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { schema_version: version, client_ip: ip, received_at: new Date().toISOString() },
  });
  return json({ deduped: false, key, sha256: sha }, 201);
}

async function handleHealth(env) {
  let bucketReachable = false;
  try {
    // A head() on a non-existent key still proves the binding round-trips.
    await env.INTAKE.head('__health_probe__');
    bucketReachable = true;
  } catch {
    bucketReachable = false;
  }
  return json({
    status: 'ok',
    service: 'skycruncher-ingest',
    version: SERVICE_VERSION,
    schema_versions_accepted: '2.x',
    bucket_bound: !!env.INTAKE,
    bucket_reachable: bucketReachable,
    kv_bound: !!env.QUOTA,
  }, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === 'POST' && pathname === '/v1/receipts') {
      return handleReceipts(request, env);
    }
    if (request.method === 'GET' && pathname === '/v1/health') {
      return handleHealth(env);
    }
    if (pathname === '/v1/receipts' || pathname === '/v1/health') {
      return json({ error: 'method not allowed' }, 405, { Allow: pathname === '/v1/receipts' ? 'POST' : 'GET' });
    }
    return json({ error: 'not found', routes: ['POST /v1/receipts', 'GET /v1/health'] }, 404);
  },
};
