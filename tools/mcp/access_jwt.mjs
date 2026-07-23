// ═══════════════════════════════════════════════════════════════════════════
// CLOUDFLARE ACCESS JWT VERIFIER — zero-dep (node:crypto + node:https only)
// ═══════════════════════════════════════════════════════════════════════════
//
// PURPOSE
//   Validate the `Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie)
//   that Cloudflare Access stamps onto every request it proxies through to the
//   remote MCP origin. claude.ai authenticates to the Access app over OAuth and
//   CANNOT forward our static bearer, so the Access identity JWT is the credential
//   that survives the hop. Owner ruling D-mcp-access-trust-mode (2026-07-16):
//   validate the Access JWT, keep the static bearer as an ALTERNATE credential.
//
// CONTRACT (owner-ruled)
//   • RS256 signature verified against the team's JWKS
//     (`<TEAM_DOMAIN>/cdn-cgi/access/certs`), keys cached in memory 1 h; on an
//     unknown `kid`, ONE forced refetch, then fail closed.
//   • `iss` === TEAM_DOMAIN, `exp`/`nbf` honoured with a 60 s clock skew.
//   • `email` claim ∈ allowlist, case-insensitive. The allowlist is env-driven
//     (REMOTE_MCP_ACCESS_EMAILS, else ACCESS_JWT_ALLOWLIST; comma-separated).
//     No email is hardcoded: when NEITHER env var is set the allowlist is EMPTY
//     and every token FAILS CLOSED ('email not in allowlist') — honest-fail when
//     unconfigured, never a baked-in owner identity.
//   • `aud` must contain the pinned Access app AUD *when one is known*: env
//     REMOTE_MCP_ACCESS_AUD if set, else best-effort startup discovery. If the
//     AUD is unknown, that single check is skipped (logged once at boot) and
//     every OTHER check is still enforced — we never crash on discovery failure.
//   • FAIL CLOSED on every malformed / ambiguous / unexpected input.
//
// ZERO npm deps by design (parity with remote_server.mjs). The JWKS fetcher is
// injectable so tests run offline with a self-generated keypair.
// ═══════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import https from 'node:https';

const DEFAULT_TEAM_DOMAIN = 'https://odd-rain-31f1.cloudflareaccess.com';
const DEFAULT_RESOURCE_META =
  'https://mcp.skycruncher.io/.well-known/cloudflare-access-protected-resource/';

const JWKS_TTL_MS = 60 * 60 * 1000; // cache JWKS 1 hour
const SKEW_S = 60;                  // ±60 s clock skew on exp/nbf
const MAX_JWKS_BYTES = 1_048_576;   // 1 MiB ceiling on the certs document
const MAX_TOKEN_BYTES = 16 * 1024;  // sane ceiling; real Access JWTs are ~1-2 KiB

// ─── config resolvers (env-driven, LAW-6-neutral keys) ───────────────────────
function stripTrailingSlash(s) { return String(s || '').replace(/\/+$/, ''); }

export function teamDomain() {
  return stripTrailingSlash(process.env.REMOTE_MCP_ACCESS_TEAM || DEFAULT_TEAM_DOMAIN);
}
export function allowedEmails() {
  // Env-driven, no hardcoded identity. Unset => empty list => fail closed.
  const raw = process.env.REMOTE_MCP_ACCESS_EMAILS
    || process.env.ACCESS_JWT_ALLOWLIST
    || '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// ─── pinned AUD state (env wins; discovery may fill it at boot) ───────────────
let PINNED_AUD = process.env.REMOTE_MCP_ACCESS_AUD
  ? process.env.REMOTE_MCP_ACCESS_AUD.trim()
  : null;
let AUD_SOURCE = PINNED_AUD ? 'env:REMOTE_MCP_ACCESS_AUD' : 'unset';

export function pinnedAud() { return PINNED_AUD; }
export function pinnedAudSource() { return AUD_SOURCE; }

// ─── default HTTPS JSON GET (zero-dep; node:https) ───────────────────────────
function httpsGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = https.get(url, { timeout: timeoutMs }, onResponse); }
    catch (e) { reject(e); return; }
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
    function onResponse(res) {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`GET ${url} → HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
        if (data.length > MAX_JWKS_BYTES) { req.destroy(); reject(new Error('response too large')); }
      });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      res.on('error', reject);
    }
  });
}

// ─── JWKS cache (in-memory, per team domain) ─────────────────────────────────
let jwksCache = { keys: null, fetchedAt: 0, domain: null };

async function getJwks(fetcher, domain, forceRefresh) {
  const now = Date.now();
  const fresh = jwksCache.keys
    && jwksCache.domain === domain
    && (now - jwksCache.fetchedAt) < JWKS_TTL_MS;
  if (fresh && !forceRefresh) return jwksCache.keys;
  const url = `${domain}/cdn-cgi/access/certs`;
  const body = await fetcher(url);
  const keys = body && Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { keys, fetchedAt: now, domain };
  return keys;
}

// Test / operational hook: drop the cache so the next verify refetches.
export function _resetJwksCache() { jwksCache = { keys: null, fetchedAt: 0, domain: null }; }

// ─── base64url helpers (fail closed on malformed input) ──────────────────────
function b64urlToBuf(seg) { return Buffer.from(String(seg), 'base64url'); }
function b64urlToJson(seg) { return JSON.parse(b64urlToBuf(seg).toString('utf8')); }

function fail(reason) { return { ok: false, reason }; }

// ═══════════════════════════════════════════════════════════════════════════
// verifyAccessJwt(token, opts?) -> { ok, email?, reason? }
//   Pure aside from the module-level JWKS cache. opts is fully injectable:
//     { fetchJwks, teamDomain, emails, aud, now }   (now = unix seconds)
//   `aud`: pass a string to pin, `null` to skip; omit → current module PINNED_AUD.
// FAIL CLOSED everywhere: any throw / malformed / ambiguous input → { ok:false }.
// ═══════════════════════════════════════════════════════════════════════════
export async function verifyAccessJwt(token, opts = {}) {
  try {
    const domain = stripTrailingSlash(opts.teamDomain || teamDomain());
    const emails = (opts.emails || allowedEmails()).map((e) => String(e).toLowerCase());
    const aud = opts.aud !== undefined ? opts.aud : PINNED_AUD; // null/'' → skip
    const now = typeof opts.now === 'number' ? opts.now : Math.floor(Date.now() / 1000);
    const fetcher = opts.fetchJwks || httpsGetJson;

    if (typeof token !== 'string' || !token) return fail('no token');
    if (token.length > MAX_TOKEN_BYTES) return fail('token too large');

    const parts = token.split('.');
    if (parts.length !== 3) return fail('malformed jwt (expected 3 segments)');
    const [h64, p64, s64] = parts;

    let header, payload, sig;
    try { header = b64urlToJson(h64); } catch { return fail('unparseable header'); }
    try { payload = b64urlToJson(p64); } catch { return fail('unparseable payload'); }
    try { sig = b64urlToBuf(s64); } catch { return fail('unparseable signature'); }
    if (!header || typeof header !== 'object') return fail('bad header');
    if (!payload || typeof payload !== 'object') return fail('bad payload');
    if (!sig || sig.length === 0) return fail('empty signature');

    if (header.alg !== 'RS256') return fail(`unsupported alg (${header.alg}); only RS256`);
    if (typeof header.kid !== 'string' || !header.kid) return fail('missing kid');

    // Resolve the signing key; on unknown kid, ONE forced refetch, then fail closed.
    let keys = await getJwks(fetcher, domain, false);
    let jwk = Array.isArray(keys) ? keys.find((k) => k && k.kid === header.kid) : null;
    if (!jwk) {
      keys = await getJwks(fetcher, domain, true);
      jwk = Array.isArray(keys) ? keys.find((k) => k && k.kid === header.kid) : null;
    }
    if (!jwk) return fail('unknown signing key (kid not in JWKS)');
    if (jwk.kty !== 'RSA') return fail('signing key is not RSA');

    let pub;
    try { pub = crypto.createPublicKey({ key: jwk, format: 'jwk' }); }
    catch { return fail('could not import signing key'); }

    // RS256 = RSASSA-PKCS1-v1_5 over SHA-256 of `header.payload` (default PKCS1 padding).
    const signingInput = Buffer.from(`${h64}.${p64}`);
    let verified = false;
    try { verified = crypto.verify('RSA-SHA256', signingInput, pub, sig); }
    catch { return fail('signature verification threw'); }
    if (!verified) return fail('bad signature');

    // Claims — every one enforced; fail closed on the first miss.
    const iss = stripTrailingSlash(typeof payload.iss === 'string' ? payload.iss : '');
    if (iss !== domain) return fail('issuer mismatch');

    if (typeof payload.exp !== 'number') return fail('missing exp');
    if (now > payload.exp + SKEW_S) return fail('token expired');
    if (typeof payload.nbf === 'number' && now < payload.nbf - SKEW_S) return fail('token not yet valid');

    if (aud) {
      const auds = Array.isArray(payload.aud)
        ? payload.aud
        : (payload.aud != null ? [payload.aud] : []);
      if (!auds.includes(aud)) return fail('audience mismatch');
    }

    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (!email) return fail('missing email claim');
    if (!emails.includes(email)) return fail('email not in allowlist');

    return { ok: true, email };
  } catch {
    // Any unexpected throw → deny. Never leak internals; never crash the caller.
    return fail('verification error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// discoverAccessAud(opts?) -> { aud, source, warning? }   (NEVER throws)
//   Called once at server boot. env REMOTE_MCP_ACCESS_AUD wins; otherwise a
//   best-effort read of the protected-resource metadata. Failure → unpinned +
//   an honest one-line warning (the caller logs it); other checks stay enforced.
// ═══════════════════════════════════════════════════════════════════════════
function extractAud(doc) {
  if (!doc || typeof doc !== 'object') return null;
  // The AUD may surface under a few plausible keys depending on metadata shape.
  for (const key of ['aud', 'audience', 'access_aud', 'application_audience']) {
    const v = doc[key];
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0]) return v[0];
  }
  return null;
}

export async function discoverAccessAud(opts = {}) {
  if (PINNED_AUD) return { aud: PINNED_AUD, source: AUD_SOURCE };
  const fetcher = opts.fetch || httpsGetJson;
  const url = opts.url || process.env.REMOTE_MCP_ACCESS_RESOURCE || DEFAULT_RESOURCE_META;
  try {
    const doc = await fetcher(url);
    const aud = extractAud(doc);
    if (aud) { PINNED_AUD = aud; AUD_SOURCE = 'discovery'; return { aud, source: 'discovery' }; }
    return {
      aud: null,
      source: 'unpinned',
      warning: 'Cloudflare Access AUD not found in resource metadata — aud claim UNPINNED (all other checks still enforced)',
    };
  } catch (e) {
    return {
      aud: null,
      source: 'unpinned',
      warning: `Cloudflare Access AUD discovery failed (${(e && e.message) || 'unknown'}) — aud claim UNPINNED (all other checks still enforced)`,
    };
  }
}
