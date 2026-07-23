// tools/seestar/lib.mjs
// Shared helpers for the Seestar control lane (probe.mjs + ctl.mjs).
// ZERO new deps: built-in net / dgram / http / fs only. Node >=18.
//
// Sources (our banked research, read FIRST — see README.md citations):
//   - test_results/demo_2026-07-24/SEESTAR_CONTROL_API.md   (native 4700 JSON-RPC method vocab; Alpaca native since fw alpaca_v1.1.2-1)
//   - test_results/seestar_alpaca_research_2026-07-17/NOTES.md (ports table; S30 Pro Alpaca REST :32323, 48/52 GET methods; RA/Dec goto only, alt/az NOT exposed)
//
// PORT MAP (device-native, no bridge):
//   4700  raw-TCP JSON-RPC   control + file listing (newline-framed, incrementing id)
//   32227 UDP                ASCOM Alpaca discovery broadcast ("alpacadiscovery1")
//   4720  UDP                native discovery (format undocumented; best-effort only)
//   80    HTTP               single-file download
//   445   SMB                folder download / delete
//   32323 HTTP (Alpaca REST) S30 Pro native Alpaca surface (per indi-seestar; fw-dependent)
//
// SAFETY: this lib carries the sun-ephemeris + angular-separation math that ctl.mjs's
// FILTER-CONFIRM gate depends on. Do not weaken angularSepDeg / sunRaDec without re-checking ctl.mjs.

import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';

export const PORTS = {
  NATIVE_RPC: 4700,
  ALPACA_DISCOVERY_UDP: 32227,
  NATIVE_DISCOVERY_UDP: 4720,
  HTTP_DOWNLOAD: 80,
  SMB: 445,
  ALPACA_REST_S30PRO: 32323,
};

// Ports we TCP-probe on every candidate host during a subnet scan.
export const SCAN_PORTS = [PORTS.NATIVE_RPC, PORTS.HTTP_DOWNLOAD, PORTS.SMB, PORTS.ALPACA_REST_S30PRO];

// Sun-avoidance angular radius (deg). goto within this of the Sun REFUSES unless --filter-confirmed.
export const SUN_AVOID_DEG = 15;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ---------------------------------------------------------------------------
// TCP connect-probe. Resolves 'open' | 'closed' | 'timeout'. Never throws.
// ---------------------------------------------------------------------------
export function tcpProbe(ip, port, timeoutMs = 200) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (state) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(state);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish('open'));
    sock.once('timeout', () => finish('timeout'));
    sock.once('error', (err) => finish(err.code === 'ECONNREFUSED' ? 'closed' : 'timeout'));
    sock.connect(port, ip);
  });
}

// Run an async fn over `items` with bounded concurrency (polite subnet scan).
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// Enumerate host IPs for a /24 (x.y.z.1 .. x.y.z.254).
export function subnetHosts(base24) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(base24) || /^(\d+)\.(\d+)\.(\d+)$/.exec(base24);
  if (!m) throw new Error(`bad /24 base: ${base24}`);
  const prefix = `${m[1]}.${m[2]}.${m[3]}`;
  const hosts = [];
  for (let h = 1; h <= 254; h++) hosts.push(`${prefix}.${h}`);
  return hosts;
}

// ---------------------------------------------------------------------------
// ASCOM Alpaca UDP discovery. Broadcasts "alpacadiscovery1" to :32227.
// Devices reply with JSON {"AlpacaPort": <int>}. Returns [{address, alpacaPort}].
// ---------------------------------------------------------------------------
export function alpacaDiscover(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      try { sock.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    sock.on('error', () => finish());
    sock.on('message', (msg, rinfo) => {
      let port = null;
      try { port = JSON.parse(msg.toString('utf8')).AlpacaPort; } catch { /* not alpaca */ }
      if (port) found.set(rinfo.address, { address: rinfo.address, alpacaPort: port });
    });
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* ignore */ }
      const payload = Buffer.from('alpacadiscovery1');
      // Broadcast + the .68 broadcast address explicitly for reliability.
      for (const dst of ['255.255.255.255']) {
        try { sock.send(payload, PORTS.ALPACA_DISCOVERY_UDP, dst); } catch { /* ignore */ }
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

// GET a JSON body from an Alpaca management/REST endpoint. Never throws; returns {ok,status,json,error}.
export function alpacaGet(ip, port, path, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* non-json */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, body });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
  });
}

// ---------------------------------------------------------------------------
// Generic HTTP request (GET/PUT). Never throws; returns {ok,status,json,body,error}.
// ---------------------------------------------------------------------------
export function httpRequest(ip, port, method, path, body, timeoutMs = 5000, headers = {}) {
  return new Promise((resolve) => {
    const opts = { host: ip, port, path, method, timeout: timeoutMs, headers: { ...headers } };
    if (body != null) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* non-json */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, body: b });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    if (body != null) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// ASCOM Alpaca REST call. GET reads a property; PUT invokes a method.
//   path = /api/v1/<deviceType>/<deviceNumber>/<apiMethod>
// ASCOM param names are PascalCase (RightAscension/Declination/Connected/Tracking);
// booleans go over the wire lowercase. RA is in HOURS (matches our crval convention), Dec in deg.
// Returns the Alpaca envelope {Value, ErrorNumber, ErrorMessage, ...} or {error} on transport fail.
// ---------------------------------------------------------------------------
let __alpacaTxn = 0;
const ALPACA_CLIENT_ID = 42;
function encodeParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) out[k] = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  return out;
}
export async function alpacaApi(ip, port, httpMethod, deviceType, deviceNumber, apiMethod, params = {}, timeoutMs = 6000) {
  const path = `/api/v1/${deviceType}/${deviceNumber}/${apiMethod}`;
  const common = { ClientID: String(ALPACA_CLIENT_ID), ClientTransactionID: String(++__alpacaTxn) };
  const all = { ...common, ...encodeParams(params) };
  if (httpMethod === 'GET') {
    const qs = new URLSearchParams(all).toString();
    const r = await httpRequest(ip, port, 'GET', `${path}?${qs}`, null, timeoutMs);
    return r.json ?? { error: r.error || `HTTP ${r.status}`, raw: r.body };
  }
  const b = new URLSearchParams(all).toString();
  const r = await httpRequest(ip, port, 'PUT', path, b, timeoutMs, { 'Content-Type': 'application/x-www-form-urlencoded' });
  return r.json ?? { error: r.error || `HTTP ${r.status}`, raw: r.body };
}

// Normalize an Alpaca envelope to {value} on success or {error} on failure.
export function alpacaValue(resp) {
  if (resp == null) return { error: 'no response' };
  if (resp.error) return { error: resp.error };
  if (typeof resp.ErrorNumber === 'number' && resp.ErrorNumber !== 0) {
    return { error: `#${resp.ErrorNumber} ${resp.ErrorMessage || ''}`.trim() };
  }
  return { value: resp.Value };
}

// ---------------------------------------------------------------------------
// Native JSON-RPC over raw TCP 4700.
// Wire: JSON.stringify({id, method, params}) + "\r\n". Device replies newline-framed;
// unsolicited "Event" messages interleave — we resolve on the first line whose .id === ours.
// ---------------------------------------------------------------------------
let __rpcId = 100;
export function nativeRpc(ip, method, params, { port = PORTS.NATIVE_RPC, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++__rpcId;
    const sock = new net.Socket();
    let buf = '';
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      sock.destroy();
      err ? reject(err) : resolve(val);
    };
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => finish(new Error(`RPC timeout after ${timeoutMs}ms (method=${method})`)));
    sock.once('error', (e) => finish(e));
    sock.once('connect', () => {
      const msg = { id, method };
      if (params !== undefined) msg.params = params;
      sock.write(JSON.stringify(msg) + '\r\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.id === id) {
          if (obj.error || (typeof obj.code === 'number' && obj.code !== 0)) {
            finish(new Error(`RPC error (${method}): ${JSON.stringify(obj.error ?? obj)}`));
          } else {
            finish(null, obj);
          }
          return;
        }
        // else: unsolicited Event / other id — ignore, keep reading.
      }
    });
    sock.connect(port, ip);
  });
}

// ---------------------------------------------------------------------------
// Low-precision Sun apparent RA/Dec (USNO/Meeus almanac form; ~0.01deg, 1950-2050).
// Returns { raHours, decDeg }. Geocentric apparent — ample for a 15deg safety gate
// and for pointing a smart scope (firmware converts RA/Dec->alt/az from its own site+time).
// ---------------------------------------------------------------------------
export function sunRaDec(date = new Date()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;                       // days from J2000.0
  const L = norm360(280.460 + 0.9856474 * n);     // mean longitude
  const g = norm360(357.528 + 0.9856003 * n) * D2R; // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R; // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * D2R;      // obliquity
  let ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * R2D;
  ra = norm360(ra);
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) * R2D;
  return { raHours: ra / 15, decDeg: dec };
}

// Angular separation (deg) between two equatorial points. RA in HOURS, Dec in deg.
export function angularSepDeg(ra1h, dec1, ra2h, dec2) {
  const a1 = ra1h * 15 * D2R, d1 = dec1 * D2R;
  const a2 = ra2h * 15 * D2R, d2 = dec2 * D2R;
  let c = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2);
  c = Math.max(-1, Math.min(1, c));
  return Math.acos(c) * R2D;
}

function norm360(x) { return ((x % 360) + 360) % 360; }

// ===========================================================================
// RELIABILITY HELPERS (pure, dependency-injected -> unit-testable offline).
// Consumed by ctl.mjs for the reconnect/resume + slew-watchdog riders.
// ===========================================================================

const _defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transport error codes we treat as TRANSIENT (worth a retry): dropped WiFi,
// refused/reset connections, socket timeouts, transient name-resolution, and
// retry-worthy HTTP status codes. Device-level ASCOM errors (#1031 etc.) and
// hard HTTP 4xx are NOT transient — they must surface, never retry-mask a bug.
const TRANSIENT_CODES = [
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETDOWN', 'EAI_AGAIN', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'timeout',
];
const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);

// Classify an error (string code | Error | {error|code|message}) as transient.
export function isTransientError(err) {
  if (err == null) return false;
  const s = typeof err === 'string' ? err : (err.code || err.error || err.message || String(err));
  if (!s) return false;
  const str = String(s);
  for (const c of TRANSIENT_CODES) if (str.includes(c)) return true;
  const m = /HTTP\s+(\d{3})/.exec(str);
  if (m && TRANSIENT_HTTP.has(Number(m[1]))) return true;
  return false;
}

// Default retry predicate for the lane's two error conventions:
//  - helpers that THROW (nativeRpc): decide on the thrown error.
//  - helpers that RETURN {error} (httpRequest/alpacaApi): decide on result.error.
export function defaultRetryable(result, error) {
  if (error != null) return isTransientError(error);
  if (result && result.error != null) return isTransientError(result.error);
  return false;
}

// Bounded retry-with-exponential-backoff. `fn(attempt)` may throw OR return an
// {error}-bearing result; retries only while `isRetryable` says so, capped at
// `retries`. On exhaustion returns the last error-result (or rethrows the last
// thrown error). `sleep`/`onRetry` are injectable for deterministic tests.
export async function retryWithBackoff(fn, opts = {}) {
  const {
    retries = 4, baseMs = 500, factor = 2, maxMs = 8000,
    isRetryable = defaultRetryable, sleep = _defaultSleep, onRetry = null,
  } = opts;
  let attempt = 0;
  for (;;) {
    let result, error = null;
    try { result = await fn(attempt); }
    catch (e) { error = e; }
    if (!isRetryable(result, error)) {
      if (error) throw error;
      return result;
    }
    if (attempt >= retries) {          // exhausted — surface the failure honestly.
      if (error) throw error;
      return result;
    }
    const delay = Math.min(maxMs, Math.round(baseMs * Math.pow(factor, attempt)));
    if (onRetry) onRetry(attempt + 1, delay, error ?? result);
    await sleep(delay);
    attempt++;
  }
}

// Slew watchdog. Polls `pollFn()` (-> false=settled | true=slewing | {error})
// until settled or `timeoutMs` elapses. NEVER fabricates a settled state on
// timeout (LAW 3) — returns {settled:false, reason:'timeout'} so the caller can
// abort + fail the step honestly. `now`/`sleep` injectable for tests.
export async function slewWatchdog(pollFn, opts = {}) {
  const { timeoutMs = 120000, pollMs = 500, sleep = _defaultSleep, now = Date.now } = opts;
  const t0 = now();
  let polls = 0, pollErrors = 0, lastState;
  for (;;) {
    let state;
    try { state = await pollFn(polls); }
    catch (e) { state = { error: e.code || e.message || String(e) }; }
    polls++;
    lastState = state;
    if (state === false) return { settled: true, reason: 'settled', elapsedMs: now() - t0, polls };
    if (state && typeof state === 'object' && state.error != null) pollErrors++;
    if (now() - t0 >= timeoutMs) {
      return { settled: false, reason: 'timeout', elapsedMs: now() - t0, polls, pollErrors, lastState };
    }
    await sleep(pollMs);
  }
}

// Resolve the observer site with an explicit precedence (rider #3, owner-amended):
//   explicit config (--lat/--lon)  >  device GPS (live fix)  >  device-gps-cached
//   (last-known for THIS device serial, carries fix_iso age)  >  absent.
// Honest-or-absent: returns source ∈ {config|device-gps|device-gps-cached|absent},
// never a silent fabricated default and never a coordinate literal. Callers record
// `source` (+ fix_iso when cached) in the manifest / FITS provenance.
export function resolveSite({ configLat, configLon, deviceLat, deviceLon, cachedLat, cachedLon, cachedFixIso } = {}) {
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  if (fin(configLat) && fin(configLon)) return { lat: configLat, lon: configLon, source: 'config' };
  if (fin(deviceLat) && fin(deviceLon)) return { lat: deviceLat, lon: deviceLon, source: 'device-gps' };
  if (fin(cachedLat) && fin(cachedLon)) return { lat: cachedLat, lon: cachedLon, source: 'device-gps-cached', fix_iso: cachedFixIso ?? null };
  return { lat: null, lon: null, source: 'absent' };
}

// The honesty boundary (owner ruling, parallel to the trusted-clock gate): a site
// may feed VERDICT-bearing products (ephemeris/guest-list gating, alt/az science
// annotations) ONLY when it is explicit config or a LIVE device-gps fix. A CACHED
// fix (or absent) may feed HINT/SEARCH-shaped consumers (slew planning, center
// hints, horizon estimates) but NEVER a verdict. Encoded once so callers can't fork.
export const VERDICT_TRUSTED_SITE_SOURCES = new Set(['config', 'device-gps']);
export function siteTrustedForVerdicts(site) {
  return !!site && VERDICT_TRUSTED_SITE_SOURCES.has(site.source);
}

// Select the cached site for a specific device serial from a serial->entry map.
// Returns {lat,lon,fix_iso} ONLY when the serial matches AND coords are finite.
// A DIFFERENT serial (device identity changed) yields null -> cache ignored ->
// resolveSite falls through to absent. Cache is device-keyed, never global.
export function pickCachedSite(cacheMap, serial) {
  if (!serial || !cacheMap || typeof cacheMap !== 'object') return null;
  const e = cacheMap[serial];
  if (!e) return null;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!fin(e.lat) || !fin(e.lon)) return null;
  return { lat: e.lat, lon: e.lon, fix_iso: e.fix_iso ?? null };
}

// Sweep-point statuses that count as DONE for resume (terminal — recorded &
// won't be retried). ABORT is deliberately excluded: an aborted sweep resumes
// from the aborting point.
export const TERMINAL_SWEEP_STATUS = new Set([
  'OK', 'SLEW_REFUSED', 'SKIPPED_SUN_GATE', 'EXPOSE_ERROR', 'SLEW_TIMEOUT',
]);

// Plan a resumed sweep from a checkpoint. Only honors the checkpoint when its
// `params_key` matches (same device/exposure/site/point-count) — otherwise it's
// a different sweep and every point runs fresh.
export function planResume(pointCount, checkpoint, paramsKey) {
  const done = new Set();
  if (checkpoint && checkpoint.params_key === paramsKey && checkpoint.completed) {
    for (const k of Object.keys(checkpoint.completed)) {
      const idx = Number(k);
      const st = checkpoint.completed[k] && checkpoint.completed[k].status;
      if (Number.isInteger(idx) && TERMINAL_SWEEP_STATUS.has(st)) done.add(idx);
    }
  }
  const toRun = [], skipped = [];
  for (let i = 0; i < pointCount; i++) (done.has(i) ? skipped : toRun).push(i);
  return { toRun, skipped, resumed: skipped.length > 0 };
}

// Alt/Az (deg; az N=0 through E=90, astronomical) -> equatorial (RA hours, Dec deg) for a site.
// lonDeg east-positive. Inverse of equatorialToAltAz — used to command a compass-grid slew.
export function altAzToEquatorial(altDeg, azDeg, latDeg, lonDeg, date = new Date()) {
  const alt = altDeg * D2R, az = azDeg * D2R, lat = latDeg * D2R;
  const sinDec = Math.sin(alt) * Math.sin(lat) + Math.cos(alt) * Math.cos(lat) * Math.cos(az);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const cosH = (Math.sin(alt) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec));
  const sinH = -Math.sin(az) * Math.cos(alt) / Math.cos(dec);
  const H = Math.atan2(sinH, cosH); // hour angle, rad
  const jd = date.getTime() / 86400000 + 2440587.5;
  const dd = jd - 2451545.0;
  const gmst = norm360(280.46061837 + 360.98564736629 * dd);
  const lst = norm360(gmst + lonDeg);
  const ra = norm360(lst - H * R2D);
  return { raHours: ra / 15, decDeg: dec * R2D };
}

// Equatorial (RA hours, Dec deg) -> local Alt/Az (deg) for a site. lonDeg east-positive.
// Informational only (e.g. "is the Sun above the horizon"); the scope firmware owns the real slew.
export function equatorialToAltAz(raHours, decDeg, latDeg, lonDeg, date = new Date()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const dd = jd - 2451545.0;
  const gmst = norm360(280.46061837 + 360.98564736629 * dd); // deg
  const lst = norm360(gmst + lonDeg);                         // deg
  const H = ((lst - raHours * 15) * D2R);                     // hour angle, rad
  const dec = decDeg * D2R, lat = latDeg * D2R;
  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const az = Math.atan2(-Math.sin(H) * Math.cos(dec),
    Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(H));
  return { altDeg: alt * R2D, azDeg: norm360(az * R2D) };
}

// Pretty RA hours -> "HHhMMmSSs"; Dec deg -> "+DDdMMmSSs".
export function fmtRaHours(h) {
  const H = Math.floor(h), m = (h - H) * 60, M = Math.floor(m), S = Math.round((m - M) * 60);
  return `${String(H).padStart(2, '0')}h${String(M).padStart(2, '0')}m${String(S).padStart(2, '0')}s`;
}
export function fmtDecDeg(d) {
  const sign = d < 0 ? '-' : '+';
  const a = Math.abs(d), D = Math.floor(a), m = (a - D) * 60, M = Math.floor(m), S = Math.round((m - M) * 60);
  return `${sign}${String(D).padStart(2, '0')}d${String(M).padStart(2, '0')}m${String(S).padStart(2, '0')}s`;
}
