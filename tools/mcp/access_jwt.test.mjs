// Tests for the zero-dep Cloudflare Access JWT verifier.
// Follows the tools/mcp vitest pattern (instrument_manifest.test.mjs). Offline:
// a self-generated RSA keypair + an injected mock JWKS â€” no network, no secrets.
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { verifyAccessJwt, _resetJwksCache } from './access_jwt.mjs';

const TEAM = 'https://odd-rain-31f1.cloudflareaccess.com';
const AUD = 'test-app-aud-0123456789abcdef';
const EMAILS = ['owner@example.com'];
const NOW = 1_800_000_000; // fixed unix seconds so exp/nbf are deterministic

// One RSA keypair for the whole suite.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'kid-primary';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

// A second (attacker) key with the SAME advertised kid â†’ signature must fail.
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function signJwt(payload, { key = privateKey, kid = KID, alg = 'RS256' } = {}) {
  const header = b64url({ alg, kid, typ: 'JWT' });
  const body = b64url(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), key).toString('base64url');
  return `${header}.${body}.${sig}`;
}

const goodPayload = (over = {}) => ({
  iss: TEAM,
  aud: [AUD],
  email: 'owner@example.com',
  exp: NOW + 3600,
  nbf: NOW - 60,
  iat: NOW,
  ...over,
});

// Mock JWKS fetcher â€” records call count so refetch behaviour is observable.
function mockFetcher(keys) {
  const fn = async () => { fn.calls++; return { keys }; };
  fn.calls = 0;
  return fn;
}

const baseOpts = (fetchJwks, over = {}) => ({
  fetchJwks, teamDomain: TEAM, emails: EMAILS, aud: AUD, now: NOW, ...over,
});

describe('verifyAccessJwt â€” Cloudflare Access identity JWT', () => {
  beforeEach(() => _resetJwksCache());

  it('accepts a valid, correctly-signed token', async () => {
    const t = signJwt(goodPayload());
    const r = await verifyAccessJwt(t, baseOpts(mockFetcher([jwk])));
    expect(r.ok).toBe(true);
    expect(r.email).toBe('owner@example.com');
  });

  it('rejects a bad signature (payload tampered after signing)', async () => {
    const t = signJwt(goodPayload());
    const [h, , s] = t.split('.');
    const forged = `${h}.${b64url(goodPayload({ email: 'attacker@evil.com' }))}.${s}`;
    const r = await verifyAccessJwt(forged, baseOpts(mockFetcher([jwk])));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/signature/i);
  });

  it('rejects a token signed by a different key sharing the kid', async () => {
    const t = signJwt(goodPayload(), { key: other.privateKey });
    const r = await verifyAccessJwt(t, baseOpts(mockFetcher([jwk])));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/signature/i);
  });

  it('rejects an expired token (beyond skew)', async () => {
    const t = signJwt(goodPayload({ exp: NOW - 120 }));
    const r = await verifyAccessJwt(t, baseOpts(mockFetcher([jwk])));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired/i);
  });

  it('rejects a not-yet-valid token (nbf beyond skew)', async () => {
    const t = signJwt(goodPayload({ nbf: NOW + 120 }));
    const r = await verifyAccessJwt(t, baseOpts(mockFetcher([jwk])));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not yet valid/i);
  });

  it('rejects a wrong-email token', async () => {
    const t = signJwt(goodPayload({ email: 'someone-else@gmail.com' }));
    const r = await verifyAccessJwt(t, baseOpts(mockFetcher([jwk])));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/allowlist/i);
  });

  it('rejects a wrong-issuer token', async () => {
    const t = signJwt(goodPayload({ iss: 'https://evil.cloudflareaccess.com' }));
    const r = await verifyAccessJwt(t, baseOpts(mockFetcher([jwk])));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/issuer/i);
  });

  it('rejects a wrong-aud token when the AUD is pinned', async () => {
    const t = signJwt(goodPayload({ aud: ['some-other-app'] }));
    const r = await verifyAccessJwt(t, baseOpts(mockFetcher([jwk])));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/audience/i);
  });

  it('skips the aud check when AUD is unpinned (null)', async () => {
    const t = signJwt(goodPayload({ aud: ['whatever'] }));
    const r = await verifyAccessJwt(t, baseOpts(mockFetcher([jwk]), { aud: null }));
    expect(r.ok).toBe(true);
  });

  it('rejects a missing / empty / malformed token (missing header)', async () => {
    const f = mockFetcher([jwk]);
    for (const bad of [undefined, null, '', 'not-a-jwt', 'a.b', 'a.b.c.d']) {
      const r = await verifyAccessJwt(bad, baseOpts(f));
      expect(r.ok).toBe(false);
    }
  });

  it('rejects an unsupported alg (alg=none / HS256 downgrade)', async () => {
    const header = b64url({ alg: 'none', kid: KID, typ: 'JWT' });
    const body = b64url(goodPayload());
    const t = `${header}.${body}.`;
    const r = await verifyAccessJwt(t, baseOpts(mockFetcher([jwk])));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/alg|signature/i);
  });

  it('refetches JWKS exactly once on an unknown kid, then fails closed', async () => {
    const t = signJwt(goodPayload(), { kid: 'rotated-kid' });
    const f = mockFetcher([jwk]); // never contains 'rotated-kid'
    const r = await verifyAccessJwt(t, baseOpts(f));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown signing key/i);
    expect(f.calls).toBe(2); // initial + one forced refetch, no more
  });

  it('accepts after a key rotation surfaces on the forced refetch', async () => {
    const newKid = 'kid-rotated';
    const rotatedJwk = { ...jwk, kid: newKid };
    const t = signJwt(goodPayload(), { kid: newKid });
    let call = 0;
    const fetcher = async () => { call++; return { keys: call === 1 ? [jwk] : [rotatedJwk] }; };
    const r = await verifyAccessJwt(t, baseOpts(fetcher));
    expect(r.ok).toBe(true);
    expect(call).toBe(2);
  });
});
