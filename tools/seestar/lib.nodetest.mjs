// tools/seestar/lib.nodetest.mjs
// Offline unit tests for the reliability-rider helpers in lib.mjs.
// Zero deps: built-in node:test + node:assert. Name is deliberately OUTSIDE vitest's
// default *.{test,spec}.* glob (a node:test file fails vitest collection — same
// convention as tools/priors/priors_core.nodetest.mjs).
// Run: node --test tools/seestar/lib.nodetest.mjs
// NO device required — the transport is injected/mocked throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransientError, defaultRetryable, retryWithBackoff,
  slewWatchdog, resolveSite, siteTrustedForVerdicts, pickCachedSite, planResume, TERMINAL_SWEEP_STATUS,
} from './lib.mjs';

// --------------------------------------------------------------------------
// isTransientError — dropped-WiFi codes retry, device/4xx errors do NOT.
// --------------------------------------------------------------------------
test('isTransientError: transport codes are transient', () => {
  for (const c of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'timeout'])
    assert.equal(isTransientError(c), true, c);
  assert.equal(isTransientError('HTTP 503'), true);
  assert.equal(isTransientError('HTTP 429'), true);
  assert.equal(isTransientError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientError(new Error('socket ETIMEDOUT')), true);
});

test('isTransientError: device/4xx errors are NOT transient', () => {
  assert.equal(isTransientError('#1031 NotConnected'), false);   // ASCOM device error
  assert.equal(isTransientError('HTTP 404'), false);
  assert.equal(isTransientError('HTTP 400'), false);
  assert.equal(isTransientError(null), false);
  assert.equal(isTransientError(''), false);
  assert.equal(isTransientError(undefined), false);
});

test('defaultRetryable: honors both thrown and returned-error conventions', () => {
  assert.equal(defaultRetryable(undefined, new Error('ECONNRESET')), true);
  assert.equal(defaultRetryable({ error: 'ETIMEDOUT' }, null), true);
  assert.equal(defaultRetryable({ error: '#1031 NotConnected' }, null), false);
  assert.equal(defaultRetryable({ Value: 3 }, null), false);   // success result
});

// --------------------------------------------------------------------------
// retryWithBackoff — bounded retries, exponential backoff, honest exhaustion.
// --------------------------------------------------------------------------
test('retryWithBackoff: recovers after N transient failures', async () => {
  const sleeps = [], retried = [];
  let calls = 0;
  const r = await retryWithBackoff(() => {
    calls++;
    if (calls <= 2) return { error: 'ECONNRESET' };
    return { ok: true, Value: 42 };
  }, { baseMs: 100, factor: 2, sleep: async (ms) => sleeps.push(ms), onRetry: (n, d) => retried.push([n, d]) });
  assert.deepEqual(r, { ok: true, Value: 42 });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [100, 200]);            // exponential: base, base*factor
  assert.deepEqual(retried, [[1, 100], [2, 200]]);
});

test('retryWithBackoff: non-transient result returns immediately (no retry)', async () => {
  let calls = 0;
  const r = await retryWithBackoff(() => { calls++; return { error: '#1031 NotConnected' }; },
    { sleep: async () => { throw new Error('should not sleep'); } });
  assert.equal(calls, 1);
  assert.equal(r.error, '#1031 NotConnected');
});

test('retryWithBackoff: exhaustion returns the last error-result', async () => {
  let calls = 0;
  const r = await retryWithBackoff(() => { calls++; return { error: 'ETIMEDOUT' }; },
    { retries: 3, sleep: async () => {} });
  assert.equal(calls, 4);                          // initial + 3 retries
  assert.equal(r.error, 'ETIMEDOUT');
});

test('retryWithBackoff: thrown transient error retries then rethrows', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(() => { calls++; throw new Error('ECONNREFUSED'); },
      { retries: 2, sleep: async () => {} }),
    /ECONNREFUSED/);
  assert.equal(calls, 3);
});

test('retryWithBackoff: maxMs caps the backoff delay', async () => {
  const sleeps = [];
  await retryWithBackoff(() => ({ error: 'ECONNRESET' }),
    { retries: 5, baseMs: 1000, factor: 10, maxMs: 3000, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, [1000, 3000, 3000, 3000, 3000]); // capped at maxMs
});

// --------------------------------------------------------------------------
// slewWatchdog — settles, times out honestly, tolerates transient poll errors.
// --------------------------------------------------------------------------
test('slewWatchdog: returns settled when mount stops slewing', async () => {
  const states = [true, true, false];
  const r = await slewWatchdog(() => states.shift(), { pollMs: 500, timeoutMs: 60000, sleep: async () => {} });
  assert.equal(r.settled, true);
  assert.equal(r.reason, 'settled');
  assert.equal(r.polls, 3);
});

test('slewWatchdog: times out honestly (never fabricates settled)', async () => {
  let t = 0;
  const r = await slewWatchdog(() => true, {                 // never settles
    pollMs: 500, timeoutMs: 2000, now: () => t, sleep: async (ms) => { t += ms; },
  });
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'timeout');
  assert.ok(r.elapsedMs >= 2000);
});

test('slewWatchdog: tolerates transient poll errors then settles', async () => {
  const states = [{ error: 'ECONNRESET' }, { error: 'timeout' }, false];
  const r = await slewWatchdog(() => states.shift(), { pollMs: 10, timeoutMs: 60000, sleep: async () => {} });
  assert.equal(r.settled, true);
  assert.equal(r.polls, 3);
});

test('slewWatchdog: a thrown poll error does not crash the watchdog', async () => {
  let n = 0;
  const r = await slewWatchdog(() => { n++; if (n < 2) throw new Error('ECONNRESET'); return false; },
    { pollMs: 5, timeoutMs: 60000, sleep: async () => {} });
  assert.equal(r.settled, true);
});

// --------------------------------------------------------------------------
// resolveSite — explicit config wins, device GPS default, honest absent.
// --------------------------------------------------------------------------
test('resolveSite: explicit config wins over device GPS', () => {
  const r = resolveSite({ configLat: 40.5, configLon: -75.1, deviceLat: 34.17, deviceLon: -118.13 });
  assert.deepEqual(r, { lat: 40.5, lon: -75.1, source: 'config' });
});

test('resolveSite: device GPS is the default when no config', () => {
  const r = resolveSite({ configLat: null, configLon: null, deviceLat: 34.1725, deviceLon: -118.1317 });
  assert.deepEqual(r, { lat: 34.1725, lon: -118.1317, source: 'device-gps' });
});

test('resolveSite: absent when neither available (no silent default)', () => {
  assert.deepEqual(resolveSite({}), { lat: null, lon: null, source: 'absent' });
  assert.deepEqual(resolveSite({ configLat: 40.5, deviceLat: NaN }),   // partial config falls through
    { lat: null, lon: null, source: 'absent' });
});

test('resolveSite: cached device fix is the 3rd rung, below live device-gps', () => {
  // Pasadena numbers here SIMULATE a device response (test-only, allowed) — not a spec value.
  const live = resolveSite({ deviceLat: 34.1725, deviceLon: -118.1317, cachedLat: 10, cachedLon: 20 });
  assert.equal(live.source, 'device-gps');           // live beats cache
  const cached = resolveSite({ cachedLat: 34.1725, cachedLon: -118.1317, cachedFixIso: '2026-07-17T00:00:00Z' });
  assert.deepEqual(cached, { lat: 34.1725, lon: -118.1317, source: 'device-gps-cached', fix_iso: '2026-07-17T00:00:00Z' });
  const cfg = resolveSite({ configLat: 40.5, configLon: -75.1, cachedLat: 34.1725, cachedLon: -118.1317 });
  assert.equal(cfg.source, 'config');                // config still wins over cache
});

test('siteTrustedForVerdicts: only config & live device-gps clear the verdict bar', () => {
  assert.equal(siteTrustedForVerdicts({ source: 'config' }), true);
  assert.equal(siteTrustedForVerdicts({ source: 'device-gps' }), true);
  assert.equal(siteTrustedForVerdicts({ source: 'device-gps-cached' }), false);  // hint-tier only
  assert.equal(siteTrustedForVerdicts({ source: 'absent' }), false);
  assert.equal(siteTrustedForVerdicts(null), false);
});

test('pickCachedSite: serial-keyed; mismatch => ignored => resolveSite absent', () => {
  // Pasadena numbers SIMULATE a banked device fix (test-only, allowed).
  const map = { 'SERIAL-A': { device_serial: 'SERIAL-A', lat: 34.1725, lon: -118.1317, fix_iso: 'T', source: 'device-gps' } };
  assert.deepEqual(pickCachedSite(map, 'SERIAL-A'), { lat: 34.1725, lon: -118.1317, fix_iso: 'T' });
  assert.equal(pickCachedSite(map, 'SERIAL-B'), null);   // device identity changed -> ignore
  assert.equal(pickCachedSite(map, null), null);
  assert.equal(pickCachedSite({}, 'SERIAL-A'), null);
  const c = pickCachedSite(map, 'SERIAL-B');             // mismatch -> no substitution
  assert.equal(resolveSite({ cachedLat: c && c.lat, cachedLon: c && c.lon }).source, 'absent');
});

// --------------------------------------------------------------------------
// planResume — terminal points skipped, ABORT re-runs, param-key gating.
// --------------------------------------------------------------------------
test('planResume: terminal points are skipped, ABORT re-runs', () => {
  const cp = {
    params_key: 'K',
    completed: {
      0: { status: 'OK' }, 1: { status: 'SKIPPED_SUN_GATE' },
      2: { status: 'SLEW_TIMEOUT' }, 3: { status: 'ABORT' },
    },
  };
  const r = planResume(6, cp, 'K');
  assert.deepEqual(r.skipped, [0, 1, 2]);        // 3=ABORT excluded
  assert.deepEqual(r.toRun, [3, 4, 5]);
  assert.equal(r.resumed, true);
});

test('planResume: param-key mismatch runs everything fresh', () => {
  const cp = { params_key: 'OLD', completed: { 0: { status: 'OK' } } };
  const r = planResume(3, cp, 'NEW');
  assert.deepEqual(r.toRun, [0, 1, 2]);
  assert.equal(r.resumed, false);
});

test('planResume: no checkpoint runs everything', () => {
  const r = planResume(4, null, 'K');
  assert.deepEqual(r.toRun, [0, 1, 2, 3]);
  assert.equal(r.resumed, false);
});

test('TERMINAL_SWEEP_STATUS: ABORT is not terminal', () => {
  assert.equal(TERMINAL_SWEEP_STATUS.has('OK'), true);
  assert.equal(TERMINAL_SWEEP_STATUS.has('ABORT'), false);
});
