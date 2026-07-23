#!/usr/bin/env node
// tools/seestar/ctl.mjs
// Control CLI for a ZWO Seestar (S30 Pro) over the native JSON-RPC surface (TCP 4700),
// with Alpaca REST where it serves. Read our banked research before extending — see README.md.
//
// VERBS:
//   status                          get_device_state + get_view_state (VERBATIM)
//   goto   --ra <hours> --dec <deg> [--name N]   iscope_start_view (goto + on-device center/solve)
//   solar  --filter-confirmed       goto the Sun via current ephemeris (RAW slew, no solve)
//   expose --secs <n> [--gain g]    set exposure + start on-device stack ("enhance")
//   stop                            iscope_stop_view (stop current view/exposure)
//   pull                            list eMMC frames + download newest -> D:\AstroLogic\intake\seestar_live_2026-07-17\
//
// COMMON FLAGS:  --host <ip>  (skip discovery)   --dry-run  (print the RPC, send nothing)
//                --lat <deg> --lon <deg>  (east-positive; enables Sun altitude info + horizon warn)
//
// ================= SAFETY RAILS (non-negotiable, enforced in code) =================
//  (a) FILTER-CONFIRM GATE — any goto within 15deg of the Sun REFUSES unless --filter-confirmed.
//  (b) SINGLE-CONTROLLER  — the phone app MUST NOT drive the scope while this CLI does (state desync).
//      A banner prints on every run.
//  (c) NO alt/az forcing  — we only ever send RA/Dec targets; firmware owns alt/az limits.
// ===================================================================================

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  PORTS, SUN_AVOID_DEG, tcpProbe, mapLimit, subnetHosts,
  alpacaDiscover, alpacaApi, alpacaValue, httpRequest, nativeRpc,
  sunRaDec, angularSepDeg, equatorialToAltAz, altAzToEquatorial, fmtRaHours, fmtDecDeg,
  isTransientError, retryWithBackoff, slewWatchdog, resolveSite, siteTrustedForVerdicts,
  pickCachedSite, planResume,
} from './lib.mjs';
import { writeFitsPlanar } from '../stack/fits_io.mjs';

const PULL_DEST = 'D:\\AstroLogic\\intake\\seestar_live_2026-07-17'; // NEVER K: (thin virtual disk)
const SWEEP_DEST = PULL_DEST + '\\sweep01';
const TELE_CAM = 0; // TELEPHOTO camera ONLY — camera/1 (wide, unfiltered) is NEVER touched.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sequence-resume checkpoints live in the repo (gitignored test_results/), NOT on
// D: with the frames — they are small progress sidecars, resolved cwd-independently.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKPOINT_DIR = path.join(REPO_ROOT, 'test_results', 'seestar');
const checkpointPath = (id) => path.join(CHECKPOINT_DIR, `${id}.checkpoint.json`);
function loadCheckpoint(id) {
  try { return JSON.parse(fs.readFileSync(checkpointPath(id), 'utf8')); } catch { return null; }
}
function saveCheckpoint(id, cp) {                 // atomic-ish: write tmp then rename.
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const p = checkpointPath(id), tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cp, null, 2));
  fs.renameSync(tmp, p);
}
const errStr = (e) => (e == null ? '' : typeof e === 'string' ? e : (e.error || e.code || e.message || String(e)));

// --- Per-device last-known site cache (rider #3, owner-amended). A serial->entry
// map; entries are MEASURED device-GPS responses only ({device_serial,lat,lon,fix_iso,
// source}). Keyed by device serial so it never crosses devices. Used ONLY as the
// hint-tier fallback below live device-gps; verdict consumers gate via siteTrustedForVerdicts.
const SITE_CACHE_PATH = path.join(CHECKPOINT_DIR, 'site_cache.json');
function loadSiteCache() { try { return JSON.parse(fs.readFileSync(SITE_CACHE_PATH, 'utf8')); } catch { return {}; } }
function saveSiteCache(map) {
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const tmp = SITE_CACHE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, SITE_CACHE_PATH);
}
function writeCachedSite(serial, lat, lon) {
  if (!serial || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const map = loadSiteCache();
  const entry = { device_serial: serial, lat, lon, fix_iso: new Date().toISOString(), source: 'device-gps' };
  map[serial] = entry;
  try { saveSiteCache(map); } catch (e) { console.error('site-cache save warn:', String(e.message || e)); }
  return entry;
}
function readCachedSite(serial) { return pickCachedSite(loadSiteCache(), serial); }

// Stable device identity for cache keying: the telescope's ASCOM UniqueID from the
// Alpaca management API. Null when unreadable (=> no caching, never a fabricated key).
async function deviceSerial(ip, args) {
  const r = await httpRequest(ip, args.alpacaPort, 'GET', '/management/v1/configureddevices', null, 2500);
  const list = r.json && (r.json.Value || r.json);
  if (!Array.isArray(list)) return null;
  const tele = list.find((d) => String(d.DeviceType || '').toLowerCase() === 'telescope') || list[0];
  const uid = tele && (tele.UniqueID || tele.UniqueId);
  return uid ? String(uid) : null;
}

// FETCH-ON-CONNECT: right after a successful telescope connect, read live device GPS
// and refresh this serial's last-known cache. Returns the live fix or null (GPS
// unreadable => no cache write, honest absence downstream).
async function refreshSiteCacheOnConnect(ip, args) {
  try {
    const la = alpacaValue(await alpacaApi(ip, args.alpacaPort, 'GET', 'telescope', 0, 'sitelatitude'));
    const lo = alpacaValue(await alpacaApi(ip, args.alpacaPort, 'GET', 'telescope', 0, 'sitelongitude'));
    if ('value' in la && 'value' in lo && Number.isFinite(la.value) && Number.isFinite(lo.value)) {
      const serial = await deviceSerial(ip, args).catch(() => null);
      const entry = writeCachedSite(serial, la.value, lo.value);
      if (entry) console.error(`(device GPS fix cached for serial ${serial.slice(0, 8)}… @ ${entry.fix_iso})`);
      return { lat: la.value, lon: lo.value };
    }
  } catch { /* GPS unreadable at connect — no cache update */ }
  return null;
}

function parseArgs(argv) {
  const a = { verb: argv[2] || 'help', host: null, ra: null, dec: null, secs: null, gain: null,
    name: null, lat: null, lon: null, dryRun: false, filterConfirmed: false, timeout: 200,
    transport: 'auto', alpacaPort: PORTS.ALPACA_REST_S30PRO,
    retries: 4, retryBaseMs: 500, slewTimeout: 120000, resume: false, sweepId: 'sweep01' };
  for (let i = 3; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case '--host': a.host = argv[++i]; break;
      case '--ra': a.ra = Number(argv[++i]); break;
      case '--dec': a.dec = Number(argv[++i]); break;
      case '--secs': a.secs = Number(argv[++i]); break;
      case '--gain': a.gain = Number(argv[++i]); break;
      case '--name': a.name = argv[++i]; break;
      case '--lat': a.lat = Number(argv[++i]); break;
      case '--lon': a.lon = Number(argv[++i]); break;
      case '--timeout': a.timeout = Number(argv[++i]); break;
      case '--transport': a.transport = String(argv[++i]).toLowerCase(); break;
      case '--alpaca-port': a.alpacaPort = Number(argv[++i]); break;
      case '--retries': a.retries = Number(argv[++i]); break;
      case '--retry-base-ms': a.retryBaseMs = Number(argv[++i]); break;
      case '--slew-timeout': a.slewTimeout = Number(argv[++i]); break;
      case '--sweep-id': a.sweepId = String(argv[++i]); break;
      case '--resume': a.resume = true; break;
      case '--dry-run': a.dryRun = true; break;
      case '--filter-confirmed': a.filterConfirmed = true; break;
      case '-h': case '--help': a.verb = 'help'; break;
      default: console.error(`unknown arg: ${t}`); process.exit(2);
    }
  }
  if (!['auto', 'alpaca', 'native'].includes(a.transport)) { console.error(`--transport must be auto|alpaca|native`); process.exit(2); }
  return a;
}

function banner() {
  console.error('┌─ SINGLE-CONTROLLER WARNING ─────────────────────────────────────────┐');
  console.error('│ Do NOT run the Seestar phone app while this CLI controls the scope.  │');
  console.error('│ Native TCP 4700 is single-owner; concurrent control desyncs state.  │');
  console.error('└─────────────────────────────────────────────────────────────────────┘');
}

// Resolve a device IP: explicit --host, else Alpaca discovery, else a quick /24 probe (4700 OR Alpaca REST).
async function resolveHost(args) {
  if (args.host) return args.host;
  const hits = await alpacaDiscover(1200);
  if (hits.length) { console.error(`(discovered ${hits[0].address} via Alpaca)`); return hits[0].address; }
  const os = await import('node:os');
  const ifs = os.networkInterfaces();
  let base = null;
  for (const n of Object.values(ifs)) for (const a of n || [])
    if (a.family === 'IPv4' && !a.internal && a.address.startsWith('192.168.')) base = a.address.split('.').slice(0, 3).join('.');
  if (!base) return null;
  const hosts = subnetHosts(base);
  const found = await mapLimit(hosts, 48, async (ip) => {
    if ((await tcpProbe(ip, args.alpacaPort, args.timeout)) === 'open') return ip;
    if ((await tcpProbe(ip, PORTS.NATIVE_RPC, args.timeout)) === 'open') return ip;
    return null;
  });
  const hit = found.find(Boolean);
  if (hit) console.error(`(discovered ${hit} via /24 scan)`);
  return hit || null;
}

async function needHost(args) {
  const ip = await resolveHost(args);
  if (!ip) {
    console.error('No Seestar found. Pass --host <ip>, or confirm the scope is in station mode on this /24.');
    process.exit(1);
  }
  return ip;
}

// Choose the transport for this run. auto = Alpaca REST if the management API answers, else native 4700.
async function pickTransport(ip, args) {
  if (args.transport === 'alpaca') return 'alpaca';
  if (args.transport === 'native') return 'native';
  const r = await httpRequest(ip, args.alpacaPort, 'GET', '/management/apiversions', null, 1800);
  const ok = r.json && (Array.isArray(r.json.Value) || Array.isArray(r.json));
  console.error(`(transport auto -> ${ok ? `alpaca :${args.alpacaPort}` : 'native :4700'})`);
  return ok ? 'alpaca' : 'native';
}

function print(obj) { console.log(JSON.stringify(obj, null, 2)); }

// Send (or, in dry-run, just show) a native RPC.
async function send(ip, method, params, args) {
  if (args.dryRun) {
    console.log(`DRY-RUN — would send to ${ip}:4700 :`);
    print({ method, params });
    return { dryRun: true };
  }
  const resp = await nativeRpc(ip, method, params, { timeoutMs: 8000 });
  return resp.result ?? resp;
}

// ---- verbs -----------------------------------------------------------------

// One Alpaca GET, presented as value-or-error.
async function agGet(ip, port, dtype, dnum, method) {
  const a = alpacaValue(await alpacaApi(ip, port, 'GET', dtype, dnum, method));
  return 'value' in a ? a.value : { error: a.error };
}

// Retry policy for sequence-critical transport calls (rider #1: survive a dropped
// WiFi blip mid-sweep). Only TRANSIENT errors retry; device-level ASCOM errors
// (#1031 etc.) surface immediately. LOUD stderr on every backoff.
function retryOpts(args) {
  return {
    retries: args.retries, baseMs: args.retryBaseMs, factor: 2, maxMs: 8000,
    isRetryable: (r) => r != null && r.error != null && isTransientError(r.error),
    onRetry: (n, delay, e) => console.error(`  [retry ${n}/${args.retries}] transient transport error (${errStr(e)}); backoff ${delay}ms ...`),
  };
}
// Retrying Alpaca GET -> value | {error}.
async function agGetR(ip, args, dtype, dnum, method) {
  const a = alpacaValue(await retryWithBackoff(
    () => alpacaApi(ip, args.alpacaPort, 'GET', dtype, dnum, method),
    { ...retryOpts(args), isRetryable: (r) => { const v = alpacaValue(r); return v.error != null && isTransientError(v.error); } }));
  return 'value' in a ? a.value : { error: a.error };
}
// Retrying Alpaca PUT -> {value} | {error}.
async function apiPutR(ip, args, dtype, dnum, method, params) {
  return alpacaValue(await retryWithBackoff(
    () => alpacaApi(ip, args.alpacaPort, 'PUT', dtype, dnum, method, params),
    { ...retryOpts(args), isRetryable: (r) => { const v = alpacaValue(r); return v.error != null && isTransientError(v.error); } }));
}

async function alpacaStatus(ip, args) {
  const port = args.alpacaPort;
  const mgmt = await httpRequest(ip, port, 'GET', '/management/v1/description', null, 2000);
  console.log(`# Alpaca :${port} management/description`);
  print(mgmt.json ?? { error: mgmt.error });
  const tele = {};
  for (const m of ['connected', 'tracking', 'slewing', 'atpark', 'rightascension', 'declination', 'altitude', 'azimuth'])
    tele[m] = await agGet(ip, port, 'telescope', 0, m);
  console.log('# telescope/0'); print(tele);
  console.log('# filterwheel/0'); print({ position: await agGet(ip, port, 'filterwheel', 0, 'position') });
  // camerastate errors 1031 (NotConnected) until camera connected — reported honestly, not hidden.
  console.log('# camera/0'); print({ camerastate: await agGet(ip, port, 'camera', 0, 'camerastate') });
}

async function nativeStatus(ip, args) {
  console.log(`# get_device_state @ ${ip} (native 4700)`);
  try { print(await send(ip, 'get_device_state', undefined, args)); }
  catch (e) { console.log('get_device_state ERROR:', String(e.message || e)); }
  console.log(`# get_view_state @ ${ip} (native 4700)`);
  try { print(await send(ip, 'get_view_state', undefined, args)); }
  catch (e) { console.log('get_view_state ERROR:', String(e.message || e)); }
}

async function vStatus(args) {
  const ip = await needHost(args);
  const t = await pickTransport(ip, args);
  if (t === 'alpaca') await alpacaStatus(ip, args);
  else await nativeStatus(ip, args);
}

// connect / disconnect — Alpaca only (native 4700 has no explicit connect; the app holds that session).
async function vConnect(args, connect) {
  const ip = await needHost(args);
  const port = args.alpacaPort;
  if (args.dryRun) { console.log(`DRY-RUN — PUT telescope/0/connected Connected=${connect}`); return; }
  const r = alpacaValue(await alpacaApi(ip, port, 'PUT', 'telescope', 0, 'connected', { Connected: connect }));
  if (r.error) { console.error(`${connect ? 'connect' : 'disconnect'} FAILED: ${r.error}`); process.exit(1); }
  console.log(`telescope/0 ${connect ? 'connected' : 'disconnected'} OK`);
  if (connect) await refreshSiteCacheOnConnect(ip, args);   // fetch-on-connect: refresh last-known site
}

// Shared sun-avoidance check. Returns true if it's safe to proceed.
function sunGate(raHours, decDeg, args, label) {
  const sun = sunRaDec(new Date());
  const sep = angularSepDeg(raHours, decDeg, sun.raHours, sun.decDeg);
  console.error(`Sun now: RA ${fmtRaHours(sun.raHours)} Dec ${fmtDecDeg(sun.decDeg)}  |  ${label} is ${sep.toFixed(2)}deg from the Sun.`);
  if (sep < SUN_AVOID_DEG && !args.filterConfirmed) {
    console.error('');
    console.error('╔═══════════════════════════════════════════════════════════════════════╗');
    console.error(`║ REFUSED: target is ${sep.toFixed(1)}deg from the Sun (< ${SUN_AVOID_DEG}deg avoidance radius).      ║`);
    console.error('║ Pointing here risks the optics/sensor WITHOUT a solar filter.          ║');
    console.error('║ Re-run with --filter-confirmed ONLY if a certified solar filter is on. ║');
    console.error('╚═══════════════════════════════════════════════════════════════════════╝');
    process.exit(3);
  }
  if (sep < SUN_AVOID_DEG) {
    console.error(`--filter-confirmed passed: proceeding within ${SUN_AVOID_DEG}deg of the Sun. TRUST THAT A SOLAR FILTER IS FITTED.`);
  }
  return true;
}

// Alpaca goto: standard ASCOM connected->tracking->slewtocoordinatesasync, sync fallback on NotImplemented.
// RA in HOURS, Dec in deg (ASCOM convention — same as our internal crval units; NO conversion).
async function alpacaGoto(ip, args, raH, decDeg) {
  const port = args.alpacaPort;
  const put = (m, p) => alpacaApi(ip, port, 'PUT', 'telescope', 0, m, p);
  if (args.dryRun) {
    console.log('DRY-RUN — Alpaca goto sequence (send nothing):');
    print([
      'GET  telescope/0/connected',
      'PUT  telescope/0/connected  Connected=true   (only if currently false)',
      'PUT  telescope/0/tracking   Tracking=true    (only if currently false)',
      `PUT  telescope/0/slewtocoordinatesasync  RightAscension=${raH}  Declination=${decDeg}`,
      '  fallback on #1024 NotImplemented: PUT telescope/0/slewtocoordinates (blocking)',
    ]);
    return;
  }
  if ((await agGet(ip, port, 'telescope', 0, 'connected')) === false) {
    console.log('connecting telescope/0 ...');
    const c = alpacaValue(await put('connected', { Connected: true }));
    if (c.error) throw new Error('connect failed: ' + c.error);
    await refreshSiteCacheOnConnect(ip, args);   // fetch-on-connect: refresh last-known site
  }
  if ((await agGet(ip, port, 'telescope', 0, 'tracking')) === false) {
    const t = alpacaValue(await put('tracking', { Tracking: true }));
    if (t.error) console.error('tracking-enable warn: ' + t.error);
  }
  console.log(`slewtocoordinatesasync RA=${raH}h Dec=${decDeg}deg`);
  let v = alpacaValue(await put('slewtocoordinatesasync', { RightAscension: raH, Declination: decDeg }));
  if (v.error && /#1024|NotImplemented/i.test(v.error)) {
    console.error('async slew not implemented -> slewtocoordinates (blocking)');
    v = alpacaValue(await put('slewtocoordinates', { RightAscension: raH, Declination: decDeg }));
  }
  if (v.error) { console.error('slew FAILED: ' + v.error); process.exit(1); }
  console.log('slew command accepted (async — poll `status` until slewing=false).');
}

// Native goto: iscope_start_view (goto + on-device center/plate-solve). solve=false path uses scope_goto.
async function nativeGoto(ip, args, raH, decDeg, { solve } = { solve: true }) {
  if (solve) {
    const params = { mode: 'star', target_ra_dec: [raH, decDeg], target_name: args.name || 'ctl-goto', lp_filter: false };
    console.log('native iscope_start_view (goto + on-device center/plate-solve)');
    print(await send(ip, 'iscope_start_view', params, args));
  } else {
    console.log('native scope_goto (raw RA/Dec, no plate-solve)');
    print(await send(ip, 'scope_goto', [raH, decDeg], args));
  }
}

async function vGoto(args) {
  if (!Number.isFinite(args.ra) || !Number.isFinite(args.dec)) {
    console.error('goto requires --ra <hours> --dec <deg>'); process.exit(2);
  }
  sunGate(args.ra, args.dec, args, 'target');   // SHARED gate — applies to every transport.
  const ip = await needHost(args);
  const t = await pickTransport(ip, args);
  console.log(`goto ${fmtRaHours(args.ra)} ${fmtDecDeg(args.dec)} via ${t}`);
  if (t === 'alpaca') await alpacaGoto(ip, args, args.ra, args.dec);
  else await nativeGoto(ip, args, args.ra, args.dec, { solve: true });
}

async function vSolar(args) {
  const sun = sunRaDec(new Date());
  console.log(`Sun ephemeris (now): RA ${fmtRaHours(sun.raHours)}  Dec ${fmtDecDeg(sun.decDeg)}`);
  if (Number.isFinite(args.lat) && Number.isFinite(args.lon)) {
    const aa = equatorialToAltAz(sun.raHours, sun.decDeg, args.lat, args.lon, new Date());
    console.log(`Sun local alt/az @ (${args.lat},${args.lon}): alt ${aa.altDeg.toFixed(1)}deg  az ${aa.azDeg.toFixed(1)}deg`);
    if (aa.altDeg < 0) console.error('WARNING: Sun is below the horizon at this site/time — solar goto is pointless now.');
  }
  sunGate(sun.raHours, sun.decDeg, args, 'the Sun');  // SHARED gate — 0deg from Sun, always needs --filter-confirmed.
  const ip = await needHost(args);
  const t = await pickTransport(ip, args);
  console.log(`slewing to Sun via ${t} (raw slew, no plate-solve — Sun can't be solved)`);
  if (t === 'alpaca') await alpacaGoto(ip, args, sun.raHours, sun.decDeg);
  else await nativeGoto(ip, args, sun.raHours, sun.decDeg, { solve: false });
}

async function vStop(args) {
  const ip = await needHost(args);
  const t = await pickTransport(ip, args);
  if (t === 'alpaca') {
    if (args.dryRun) { console.log('DRY-RUN — PUT telescope/0/abortslew'); return; }
    console.log('abortslew (Alpaca)');
    const r = alpacaValue(await alpacaApi(ip, args.alpacaPort, 'PUT', 'telescope', 0, 'abortslew', {}));
    if (r.error) { console.error('abortslew FAILED: ' + r.error); process.exit(1); }
    console.log('abortslew OK');
  } else {
    console.log('stop current view/exposure (native iscope_stop_view)');
    print(await send(ip, 'iscope_stop_view', undefined, args));
  }
}

// Download one HTTP :80 file to dest. Never touches K:.
function httpDownload(ip, remotePath, destFile) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: ip, port: PORTS.HTTP_DOWNLOAD, path: remotePath, timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${remotePath}`)); }
      const out = fs.createWriteStream(destFile);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(destFile)));
      out.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
    req.on('error', reject);
  });
}

async function vPull(args) {
  const ip = await needHost(args);
  if (!fs.existsSync('D:\\')) {
    console.error('D: drive not present — pull writes ONLY to D:\\AstroLogic\\intake (never K:, a thin virtual disk). Aborting.');
    process.exit(1);
  }
  fs.mkdirSync(PULL_DEST, { recursive: true });
  console.log(`pull dest: ${PULL_DEST}`);

  // Try known-plausible native listing methods (S30 Pro method coverage is fw-dependent — report what answers).
  let list = null, listedVia = null;
  for (const method of ['get_img_name_list', 'get_file_list', 'list_files']) {
    try {
      const r = await nativeRpc(ip, method, undefined, { timeoutMs: 6000 });
      list = r.result ?? r; listedVia = method; break;
    } catch { /* try next */ }
  }
  if (!list) {
    console.error('No native listing method answered. RELIABLE Windows path: SMB folder copy —');
    console.error(`  robocopy \\\\${ip}\\<share> "${PULL_DEST}" /E   (share name confirmed on the box; e.g. "EMMC Images")`);
    console.error('  (frames are FITS on the eMMC; SMB :445 was open in the probe.)');
    process.exit(1);
  }
  console.log(`# listing via ${listedVia} — VERBATIM:`);
  print(list);
  // Downloading needs the device-specific HTTP path convention (unconfirmed on S30 Pro).
  // Best-effort: if the listing yields file names, attempt HTTP :80 GET for the newest.
  const names = Array.isArray(list) ? list : (list.files || list.list || []);
  if (names.length) {
    const newest = names[names.length - 1];
    const remote = '/' + String(newest).replace(/^\/+/, '');
    const dest = path.join(PULL_DEST, path.basename(String(newest)));
    console.log(`attempting HTTP :80 download of newest -> ${dest}`);
    try { await httpDownload(ip, remote, dest); console.log('downloaded:', dest); }
    catch (e) { console.error('HTTP download failed:', String(e.message || e), '\n  fall back to SMB robocopy (above).'); }
  } else {
    console.log('listing returned no file names; use SMB robocopy for the folder pull (above).');
  }
}

// ================= Alpaca camera capture + sweep (telephoto camera/0 ONLY) =================

// Resolve the observer site with EXPLICIT-CONFIG-WINS precedence (rider #3, owner-amended):
//   --lat/--lon (config)  >  live device GPS  >  device-gps-cached (last-known for THIS
//   serial)  >  absent. Never throws, never fabricates a default, never a coordinate
//   literal. Records honest provenance (SITESRC/SITEFIX cards, manifest.site.source).
//   A live fix opportunistically refreshes the serial's cache.
async function getSite(ip, args) {
  // Config always wins — short-circuit without touching the device.
  if (Number.isFinite(args.lat) && Number.isFinite(args.lon))
    return resolveSite({ configLat: args.lat, configLon: args.lon });
  let deviceLat, deviceLon;
  try {
    const la = alpacaValue(await alpacaApi(ip, args.alpacaPort, 'GET', 'telescope', 0, 'sitelatitude'));
    const lo = alpacaValue(await alpacaApi(ip, args.alpacaPort, 'GET', 'telescope', 0, 'sitelongitude'));
    if ('value' in la) deviceLat = la.value;
    if ('value' in lo) deviceLon = lo.value;
  } catch { /* device unreadable — fall through to cache, then absent */ }
  const serial = await deviceSerial(ip, args).catch(() => null);
  if (Number.isFinite(deviceLat) && Number.isFinite(deviceLon)) {
    writeCachedSite(serial, deviceLat, deviceLon);   // refresh last-known for this serial
    return resolveSite({ deviceLat, deviceLon });
  }
  const c = readCachedSite(serial);                  // serial-keyed; mismatch => null => absent
  return resolveSite({ cachedLat: c && c.lat, cachedLon: c && c.lon, cachedFixIso: c && c.fix_iso });
}

async function readTelescope(ip, args) {
  const g = (m) => agGetR(ip, args, 'telescope', 0, m);   // retry transient blips
  return { ra: await g('rightascension'), dec: await g('declination'), alt: await g('altitude'),
    az: await g('azimuth'), slewing: await g('slewing'), connected: await g('connected'), tracking: await g('tracking') };
}

const isAscomErr = (e) => typeof e === 'string' && /^#\d+/.test(e);

// async slew (sync fallback on #1024), with transient-transport retry. Returns {accepted, error, mode}.
async function slewTo(ip, args, raH, decDeg) {
  const put = async (m) => apiPutR(ip, args, 'telescope', 0, m, { RightAscension: raH, Declination: decDeg });
  let r = await put('slewtocoordinatesasync');
  if (r.error && /#1024|NotImplemented/i.test(r.error)) {
    r = await put('slewtocoordinates');
    return { accepted: !r.error, error: r.error || null, mode: 'sync' };
  }
  return { accepted: !r.error, error: r.error || null, mode: 'async' };
}

async function abortSlew(ip, args) {
  try { await alpacaApi(ip, args.alpacaPort, 'PUT', 'telescope', 0, 'abortslew', {}); } catch { /* best effort */ }
}

// ---- Alpaca ImageBytes (binary) + imagearray (JSON) decoding ----
const AB_TYPE = { 0: 'Unknown', 1: 'Int16', 2: 'Int32', 3: 'Double', 4: 'Single', 5: 'UInt64', 6: 'Byte', 7: 'Int64', 8: 'UInt16' };
const elSize = (t) => (t === 6 ? 1 : (t === 1 || t === 8) ? 2 : (t === 2 || t === 4) ? 4 : 8);
function readEl(dv, off, t) {
  switch (t) {
    case 1: return dv.getInt16(off, true);
    case 2: return dv.getInt32(off, true);
    case 3: return dv.getFloat64(off, true);
    case 4: return dv.getFloat32(off, true);
    case 5: return Number(dv.getBigUint64(off, true));
    case 6: return dv.getUint8(off);
    case 7: return Number(dv.getBigInt64(off, true));
    case 8: return dv.getUint16(off, true);
    default: throw new Error(`unsupported element type ${t}`);
  }
}

// ASCOM serialization: value[x][y(][c]] with x outer. FITS wants index y*W+x (x fastest) -> transpose.
function parseImageBytes(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const errorNumber = dv.getInt32(4, true);
  if (errorNumber !== 0) throw new Error(`imagebytes ErrorNumber ${errorNumber}`);
  const dataStart = dv.getInt32(16, true);
  const tType = dv.getInt32(24, true);
  const rank = dv.getInt32(28, true);
  const W = dv.getInt32(32, true), H = dv.getInt32(36, true), d3 = dv.getInt32(40, true);
  const NP = rank === 3 ? d3 : 1;
  const sz = elSize(tType);
  const planes = Array.from({ length: NP }, () => new Float32Array(W * H));
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++)
      for (let c = 0; c < NP; c++)
        planes[c][y * W + x] = readEl(dv, dataStart + (((x * H) + y) * NP + c) * sz, tType);
  return { planes, W, H, NP, elementType: AB_TYPE[tType] || String(tType) };
}

function parseImageArray(json) {
  const rank = json.Rank, val = json.Value, W = val.length;
  if (rank === 2) {
    const H = val[0].length, plane = new Float32Array(W * H);
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) plane[y * W + x] = val[x][y];
    return { planes: [plane], W, H, NP: 1, elementType: AB_TYPE[json.Type] || 'imagearray' };
  }
  const H = val[0].length, NP = val[0][0].length;
  const planes = Array.from({ length: NP }, () => new Float32Array(W * H));
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let c = 0; c < NP; c++) planes[c][y * W + x] = val[x][y][c];
  return { planes, W, H, NP, elementType: AB_TYPE[json.Type] || 'imagearray' };
}

function httpGetBinary(ip, port, pth, headers, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path: pth, timeout: timeoutMs, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, contentType: res.headers['content-type'] || '', buf: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
  });
}

// Full single-frame capture from camera/0 (telephoto). Connects camera, exposes, fetches, returns planes.
async function alpacaCapture(ip, args, exposureS) {
  const port = args.alpacaPort;
  const gv = async (m) => { const a = alpacaValue(await alpacaApi(ip, port, 'GET', 'camera', TELE_CAM, m)); return 'value' in a ? a.value : { error: a.error }; };
  const pv = async (m, p) => alpacaValue(await alpacaApi(ip, port, 'PUT', 'camera', TELE_CAM, m, p));
  if ((await gv('connected')) === false) { const c = await pv('connected', { Connected: true }); if (c.error) throw new Error('camera connect: ' + c.error); }
  // Full-frame, bin 1 (best-effort — some are read-only/auto).
  const xs = await gv('cameraxsize'), ys = await gv('cameraysize');
  for (const [m, p] of [['binx', { BinX: 1 }], ['biny', { BinY: 1 }], ['startx', { StartX: 0 }], ['starty', { StartY: 0 }],
    ...(Number.isFinite(xs) ? [['numx', { NumX: xs }]] : []), ...(Number.isFinite(ys) ? [['numy', { NumY: ys }]] : [])]) {
    const r = await pv(m, p); if (r.error && !isAscomErr(r.error)) throw new Error(`set ${m}: ${r.error}`);
  }
  const se = await pv('startexposure', { Duration: exposureS, Light: true });
  if (se.error) throw new Error('startexposure: ' + se.error);
  const deadline = Date.now() + exposureS * 1000 + 25000;
  let ready = false;
  while (Date.now() < deadline) { if ((await gv('imageready')) === true) { ready = true; break; } await sleep(400); }
  if (!ready) throw new Error('imageready timeout');
  // Prefer binary imagebytes; fall back to imagearray JSON.
  const qs = new URLSearchParams({ ClientID: '42', ClientTransactionID: String(Date.now() % 1e6) }).toString();
  const bin = await httpGetBinary(ip, port, `/api/v1/camera/${TELE_CAM}/imagebytes?${qs}`, { Accept: 'application/imagebytes' });
  if (bin.ok && bin.buf && bin.buf.length > 44 && !/json/i.test(bin.contentType)) {
    try { return parseImageBytes(bin.buf); } catch (e) { console.error('imagebytes parse failed, falling back to imagearray:', String(e.message || e)); }
  }
  const arr = await alpacaApi(ip, port, 'GET', 'camera', TELE_CAM, 'imagearray', {}, 180000);
  if (arr.error || arr.ErrorNumber) throw new Error('imagearray: ' + (arr.error || `#${arr.ErrorNumber} ${arr.ErrorMessage}`));
  return parseImageArray(arr);
}

function frameCards({ dateObs, site, cmd, achieved, exposureS, elementType }) {
  const c = [['DATE-OBS', dateObs, 'UTC exposure start']];
  // Honest-or-absent site (rider #3): emit SITELAT/SITELONG ONLY when finite;
  // always record provenance. No fabricated 0,0 when the site is absent.
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  if (site && finite(site.lat)) c.push(['SITELAT', site.lat, 'observer latitude deg']);
  if (site && finite(site.lon)) c.push(['SITELONG', site.lon, 'observer longitude deg E-positive']);
  c.push(['SITESRC', (site && site.source) || 'absent', 'site provenance config|device-gps|device-gps-cached|absent']);
  if (site && site.fix_iso) c.push(['SITEFIX', site.fix_iso, 'cached GPS fix time (stale-site warning)']);
  c.push(
    ['EXPTIME', exposureS, 'seconds'],
    ['INSTRUME', 'Seestar S30 Pro tele', 'camera/0 telephoto'],
    ['TELESCOP', 'ZWO Seestar S30 Pro'],
    ['FILTER', 'SOLAR', 'solar filter fitted (sweep01)'],
  );
  if (cmd) c.push(['CMD_ALT', cmd.alt, 'commanded alt deg'], ['CMD_AZ', cmd.az, 'commanded az deg'],
    ['CMD_RA', cmd.raHours, 'commanded RA hours'], ['CMD_DEC', cmd.decDeg, 'commanded Dec deg']);
  if (achieved) c.push(['OBJCTRA', num(achieved.ra), 'achieved RA hours'], ['OBJCTDEC', num(achieved.dec), 'achieved Dec deg'],
    ['ALT_OBS', num(achieved.alt), 'achieved alt deg'], ['AZ_OBS', num(achieved.az), 'achieved az deg']);
  if (elementType) c.push(['ELEMTYPE', elementType, 'alpaca image element type']);
  return c;
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Frame statistics for the sun-in-FOV check: max/median/mean, saturated fraction, brightest-blob centroid.
function frameStats(cap) {
  const { planes, W, H, NP, elementType } = cap;
  const n = W * H;
  const lum = new Float32Array(n);
  for (let c = 0; c < NP; c++) { const pl = planes[c]; for (let i = 0; i < n; i++) lum[i] += pl[i]; }
  let max = -Infinity, sum = 0;
  for (let i = 0; i < n; i++) { const v = lum[i]; if (v > max) max = v; sum += v; }
  const mean = sum / n;
  const step = Math.max(1, Math.floor(n / 200000));
  const samp = [];
  for (let i = 0; i < n; i += step) samp.push(lum[i]);
  samp.sort((a, b) => a - b);
  const median = samp[Math.floor(samp.length / 2)];
  const ceilPer = elementType === 'UInt16' ? 65535 : elementType === 'Int16' ? 32767 : elementType === 'Byte' ? 255 : null;
  const satLevel = ceilPer != null ? ceilPer * NP * 0.98 : max * 0.98;
  const thr = 0.8 * max;
  let satCount = 0, brightCount = 0, sx = 0, sy = 0, sw = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = lum[y * W + x];
    if (v >= satLevel) satCount++;
    if (v >= thr) { brightCount++; sx += x * v; sy += y * v; sw += v; }
  }
  const cx = sw > 0 ? sx / sw : NaN, cy = sw > 0 ? sy / sw : NaN;
  const satFrac = satCount / n, brightFrac = brightCount / n;
  const contrast = max / (median > 0 ? median : 1);
  let verdict;
  if (satFrac > 0.0003 || (contrast > 20 && brightFrac < 0.05 && brightFrac > 0))
    verdict = `LIKELY SUN IN FOV (concentrated bright/saturated blob, ${contrast.toFixed(0)}x contrast)`;
  else if (contrast < 3) verdict = `LIKELY MISS (uniform dark field, ${contrast.toFixed(1)}x contrast)`;
  else verdict = `AMBIGUOUS (${contrast.toFixed(1)}x contrast, bright frac ${(brightFrac * 100).toFixed(2)}%)`;
  return { max, median, mean, satLevel, satFrac, brightFrac, cx, cy, contrast, verdict };
}

// One frame at the CURRENT pointing -> sun_test_001.fits + stats. Zero slew.
async function captureSunTest(ip, args, site) {
  const exposureS = Number.isFinite(args.secs) ? args.secs : 0.5;
  const tele = await readTelescope(ip, args);
  const dateObs = new Date().toISOString();
  const cap = await alpacaCapture(ip, args, exposureS);
  fs.mkdirSync(PULL_DEST, { recursive: true });
  const out = path.join(PULL_DEST, 'sun_test_001.fits');
  writeFitsPlanar(out, cap.planes, cap.W, cap.H, frameCards({
    dateObs, site,   // honest-or-absent: frameCards omits site cards when absent, records SITESRC.
    achieved: { ra: tele.ra, dec: tele.dec, alt: tele.alt, az: tele.az }, exposureS, elementType: cap.elementType,
  }));
  const st = frameStats(cap);
  console.log(`SUN TEST @ current pointing RA${fmt3(tele.ra)}h Dec${fmt2(tele.dec)} alt${fmt1(tele.alt)} az${fmt1(tele.az)} tracking=${tele.tracking}`);
  console.log(`  frame ${cap.W}x${cap.H}x${cap.NP} (${cap.elementType}) exp ${exposureS}s -> ${out}`);
  console.log(`  max=${st.max}  median=${st.median}  mean=${st.mean.toFixed(1)}  contrast=${st.contrast.toFixed(1)}x`);
  console.log(`  saturated(>=${st.satLevel.toFixed(0)})=${(st.satFrac * 100).toFixed(4)}%  bright(>=0.8max)=${(st.brightFrac * 100).toFixed(4)}%`);
  console.log(`  brightest-blob centroid x=${fmt1(st.cx)} y=${fmt1(st.cy)} of ${cap.W}x${cap.H}`);
  console.log(`  VERDICT: ${st.verdict}`);
  return { out, st, tele, cap };
}

async function vSunTest(args) {
  const ip = await needHost(args);
  const t = await pickTransport(ip, args);
  if (t !== 'alpaca') { console.error('suntest requires the Alpaca transport'); process.exit(2); }
  const camConn = alpacaValue(await alpacaApi(ip, args.alpacaPort, 'PUT', 'camera', TELE_CAM, 'connected', { Connected: true }));
  if (camConn.error) { console.error('camera/0 connect FAILED: ' + camConn.error); process.exit(1); }
  const site = await getSite(ip, args);   // {source: config|device-gps|absent} — never throws, never fabricates
  await captureSunTest(ip, args, site);
}

async function vExpose(args) {
  if (!Number.isFinite(args.secs)) { console.error('expose requires --secs <n>'); process.exit(2); }
  const ip = await needHost(args);
  const t = await pickTransport(ip, args);
  if (t !== 'alpaca') {
    // native path (legacy): set exposure + start on-device stack.
    if (args.gain != null) { console.log(`set gain=${args.gain}`); try { print(await send(ip, 'set_control_value', ['Gain', args.gain], args)); } catch (e) { console.log('gain warn:', String(e.message || e)); } }
    console.log(`set exposure=${args.secs}s`);
    try { print(await send(ip, 'set_control_value', ['Exposure', Math.round(args.secs * 1000)], args)); } catch (e) { console.log('exposure warn:', String(e.message || e)); }
    console.log('start on-device stack (iscope_start_stack)');
    print(await send(ip, 'iscope_start_stack', { restart: true }, args));
    return;
  }
  if (args.dryRun) { console.log(`DRY-RUN — Alpaca expose ${args.secs}s on camera/${TELE_CAM}: connect->startexposure Light=true->poll imageready->imagebytes->FITS`); return; }
  const site = await getSite(ip, args);
  const tele = await readTelescope(ip, args);
  const dateObs = new Date().toISOString();
  const cap = await alpacaCapture(ip, args, args.secs);
  fs.mkdirSync(PULL_DEST, { recursive: true });
  const out = path.join(PULL_DEST, `expose_${dateObs.replace(/[:.]/g, '-')}.fits`);
  writeFitsPlanar(out, cap.planes, cap.W, cap.H,
    frameCards({ dateObs, site, achieved: { ra: tele.ra, dec: tele.dec, alt: tele.alt, az: tele.az }, exposureS: args.secs, elementType: cap.elementType }));
  console.log(`captured ${cap.W}x${cap.H}x${cap.NP} (${cap.elementType}) -> ${out}`);
}

// 8 compass azimuths x alt{0,30,60} + zenith = 25 pointings.
function sweepPointings() {
  const AZ = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]];
  const pts = [];
  for (const [azName, az] of AZ) for (const alt of [0, 30, 60]) pts.push({ azName, az, alt, zenith: false });
  pts.push({ azName: 'ZENITH', az: 0, alt: 90, zenith: true });
  return pts;
}

async function vSweep(args) {
  const ip = await needHost(args);
  const t = await pickTransport(ip, args);
  if (t !== 'alpaca') { console.error('sweep requires the Alpaca transport (--transport alpaca)'); process.exit(2); }
  const port = args.alpacaPort;
  const site = await getSite(ip, args);
  const exposureS = Number.isFinite(args.secs) ? args.secs : 0.5;
  const pts = sweepPointings();
  console.log(`SWEEP: ${pts.length} pointings, exposure ${exposureS}s, camera/${TELE_CAM} (telephoto) ONLY`);
  console.log(`site: lat ${site.lat} lon ${site.lon} (${site.source})   filter-confirmed=${args.filterConfirmed}`);

  // Honest-or-absent (rider #3): the sweep's alt/az->equatorial math REQUIRES a real
  // site. Refuse rather than fabricate one — never substitute a coordinate literal.
  if (site.source === 'absent') {
    console.error('SWEEP REFUSED: no observer site (device GPS unreadable/uncached and no --lat/--lon).');
    console.error('  A compass sweep needs a real site for alt/az->RA/Dec. Refusing to fabricate one.');
    process.exit(2);
  }
  // Cached tier is HINT-grade only: fine for slew planning (this sweep's use), but the
  // frames are stamped SITESRC=device-gps-cached so downstream verdict consumers refuse
  // it (siteTrustedForVerdicts=false). LOUD so the operator knows the site may be stale.
  if (!siteTrustedForVerdicts(site)) {
    console.error(`WARNING: site is CACHED (last device GPS fix ${site.fix_iso}). Slew planning OK; ` +
      `alt/az annotations are stamped NOT verdict-grade. Pass --lat/--lon or reconnect for a live fix.`);
  }

  if (args.dryRun) {
    console.log('DRY-RUN — plan (no slew, no expose):');
    const now = new Date();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const eq = altAzToEquatorial(p.alt, p.az, site.lat, site.lon, now);
      const sun = sunRaDec(now);
      const sep = angularSepDeg(eq.raHours, eq.decDeg, sun.raHours, sun.decDeg);
      const gate = sep < SUN_AVOID_DEG ? (args.filterConfirmed ? `SUN ${sep.toFixed(1)}deg (filter-confirmed OK)` : `WOULD-SKIP ${sep.toFixed(1)}deg<${SUN_AVOID_DEG}`) : `${sep.toFixed(1)}deg`;
      console.log(`  [${String(i + 1).padStart(2)}/25] ${p.azName}/alt${p.alt}  RA ${eq.raHours.toFixed(3)}h Dec ${eq.decDeg.toFixed(2)}  sun ${gate}`);
    }
    return;
  }

  // Ensure telescope connected + tracking; connect camera/0.
  if ((await agGet(ip, port, 'telescope', 0, 'connected')) === false) { const r = alpacaValue(await alpacaApi(ip, port, 'PUT', 'telescope', 0, 'connected', { Connected: true })); if (r.error) { console.error('telescope connect failed: ' + r.error); process.exit(1); } await refreshSiteCacheOnConnect(ip, args); }
  if ((await agGet(ip, port, 'telescope', 0, 'tracking')) === false) { const r = alpacaValue(await alpacaApi(ip, port, 'PUT', 'telescope', 0, 'tracking', { Tracking: true })); if (r.error) console.error('tracking-enable warn: ' + r.error); }
  const camConn = alpacaValue(await alpacaApi(ip, port, 'PUT', 'camera', TELE_CAM, 'connected', { Connected: true }));
  if (camConn.error) { console.error('camera/0 connect FAILED: ' + camConn.error + ' — aborting'); process.exit(1); }
  console.log('telescope + camera/0 (telephoto) connected, tracking on.');

  fs.mkdirSync(SWEEP_DEST, { recursive: true });
  const manifest = { device: ip, alpacaPort: port, camera: 'telephoto camera/0', site, exposure_s: exposureS,
    filter_confirmed: args.filterConfirmed, started_utc: new Date().toISOString(),
    observations: {
      az_offset: { value: '~8-10deg CLOCKWISE (az+) of true Sun during solar tracking', tag: 'OBSERVED (owner eyeball, +/-1-2deg)' },
      hypothesis: { text: 'Pasadena magnetic declination ~+11E; if the mount zeroes az on its magnetometer without declination correction, expected error ~11deg clockwise -- consistent with the observation. Subtract a constant az offset from commanded-vs-achieved to see residual pointing error.', tag: 'INFERRED (orchestrator)' },
    },
    frames: [], refusals: [] };

  // --- Sequence resume (rider #1): progress checkpoint sidecar under test_results/seestar/.
  // A dropped WiFi / aborted run can `--resume`; only points with a TERMINAL status are
  // skipped (ABORT re-runs). The checkpoint is keyed on device+exposure+site+count so a
  // different sweep never resumes onto a stale one.
  const round6 = (v) => (typeof v === 'number' ? +v.toFixed(6) : v);
  const paramsKey = JSON.stringify({ device: ip, exposure_s: exposureS,
    filter_confirmed: args.filterConfirmed, lat: round6(site.lat), lon: round6(site.lon), n: pts.length });
  const existing = args.resume ? loadCheckpoint(args.sweepId) : null;
  const plan = args.resume ? planResume(pts.length, existing, paramsKey)
    : { toRun: pts.map((_, i) => i), skipped: [], resumed: false };
  const checkpoint = { sweep_id: args.sweepId, device: ip, params_key: paramsKey, points_total: pts.length,
    completed: plan.resumed && existing ? existing.completed : {}, updated_utc: new Date().toISOString() };
  if (plan.resumed) {
    console.log(`RESUME: ${plan.skipped.length} pointing(s) already complete in checkpoint '${args.sweepId}', running ${plan.toRun.length} remaining.`);
    for (const i of plan.skipped) if (checkpoint.completed[i]) manifest.frames.push(checkpoint.completed[i]);
  } else if (args.resume) {
    console.log(`--resume requested but no matching checkpoint '${args.sweepId}' — running fresh.`);
  }
  console.log(`checkpoint: ${checkpointPath(args.sweepId)}`);
  const recordDone = (i, rec) => {                 // persist a TERMINAL point immediately.
    checkpoint.completed[i] = rec;
    checkpoint.updated_utc = new Date().toISOString();
    try { saveCheckpoint(args.sweepId, checkpoint); } catch (e) { console.error('checkpoint save warn:', String(e.message || e)); }
  };
  const t0 = Date.now();
  let frameCount = 0;

  // Sun-test frame at the CURRENT pointing (owner-ruled: take it, then sweep regardless of hit/miss).
  try {
    const stest = await captureSunTest(ip, args, site);
    manifest.sun_test = { file: 'sun_test_001.fits', max: stest.st.max, median: stest.st.median,
      contrast: +stest.st.contrast.toFixed(2), sat_frac: stest.st.satFrac, bright_frac: stest.st.brightFrac,
      centroid: { x: num(stest.st.cx), y: num(stest.st.cy) }, verdict: stest.st.verdict,
      pointing: { ra_h: stest.tele.ra, dec: stest.tele.dec, alt: stest.tele.alt, az: stest.tele.az } };
  } catch (e) { console.error('sun-test capture failed (continuing to sweep):', String(e.message || e)); manifest.sun_test = { error: String(e.message || e) }; }

  for (const i of plan.toRun) {
    const p = pts[i];
    const now = new Date();
    const eq = altAzToEquatorial(p.alt, p.az, site.lat, site.lon, now);
    const sun = sunRaDec(now);
    const sep = +angularSepDeg(eq.raHours, eq.decDeg, sun.raHours, sun.decDeg).toFixed(2);
    const rec = { index: i, label: `${p.azName}/alt${p.alt}`, cmd_az: p.az, cmd_alt: p.alt,
      cmd_ra_h: +eq.raHours.toFixed(6), cmd_dec: +eq.decDeg.toFixed(5), sun_sep_deg: sep, t_utc: now.toISOString() };
    const tag = `[${String(i + 1).padStart(2)}/25] ${rec.label}`;

    // SHARED sun gate (same 15deg rule as goto/solar).
    if (sep < SUN_AVOID_DEG && !args.filterConfirmed) {
      rec.status = 'SKIPPED_SUN_GATE';
      console.log(`${tag}: SKIP — ${sep}deg from Sun, no --filter-confirmed`);
      manifest.frames.push(rec); manifest.refusals.push({ label: rec.label, reason: `sun ${sep}deg, no filter-confirm` });
      recordDone(i, rec); continue;
    }
    if (sep < SUN_AVOID_DEG) console.log(`${tag}: within ${SUN_AVOID_DEG}deg of Sun (${sep}deg) — filter-confirmed, proceeding`);

    const slew = await slewTo(ip, args, eq.raHours, eq.decDeg);
    rec.slew_mode = slew.mode;
    if (!slew.accepted) {
      if (isAscomErr(slew.error)) {                       // mount-level refusal (e.g. alt-0 below limit): record + continue.
        rec.status = 'SLEW_REFUSED'; rec.slew_error = slew.error;
        console.log(`${tag}: SLEW REFUSED (verbatim): ${slew.error}`);
        manifest.frames.push(rec); manifest.refusals.push({ label: rec.label, error: slew.error });
        recordDone(i, rec); continue;
      }
      console.error(`${tag}: UNEXPECTED slew failure: ${slew.error} — ABORTING SWEEP`);
      await abortSlew(ip, args);
      rec.status = 'ABORT'; rec.slew_error = slew.error; manifest.frames.push(rec);
      manifest.aborted = true; manifest.abort_reason = `slew transport failure @ ${rec.label}: ${slew.error}`;
      break;                                               // non-terminal: --resume re-runs this point
    }

    // SLEW WATCHDOG (rider #2): poll `slewing` until settled or timeout. On timeout we
    // abort + fail the step HONESTLY — never fabricate a settled state (LAW 3).
    const wd = await slewWatchdog(() => agGetR(ip, args, 'telescope', 0, 'slewing'),
      { timeoutMs: args.slewTimeout, pollMs: 500 });
    rec.settled = wd.settled;
    rec.slew_watchdog = { reason: wd.reason, elapsed_ms: wd.elapsedMs, polls: wd.polls };
    if (!wd.settled) {
      console.error('');
      console.error('╔═══ SLEW WATCHDOG ═══════════════════════════════════════════════════════╗');
      console.error(`║ ${tag}: mount did NOT settle within ${args.slewTimeout}ms (reason=${wd.reason}).`);
      console.error('║ Aborting this slew, SKIPPING capture — no fabricated "settled" frame.    ║');
      console.error('╚═════════════════════════════════════════════════════════════════════════╝');
      await abortSlew(ip, args);
      rec.status = 'SLEW_TIMEOUT';
      manifest.frames.push(rec); manifest.refusals.push({ label: rec.label, reason: `slew watchdog ${wd.reason} after ${wd.elapsedMs}ms` });
      recordDone(i, rec); continue;
    }
    await sleep(3000); // settle
    const tele = await readTelescope(ip, args);
    rec.achieved = { ra_h: tele.ra, dec: tele.dec, alt: tele.alt, az: tele.az, slewing: tele.slewing };

    let cap;
    try { cap = await alpacaCapture(ip, args, exposureS); }
    catch (e) {
      rec.status = 'EXPOSE_ERROR'; rec.expose_error = String(e.message || e);
      console.log(`${tag}: slew OK (alt ${fmt1(tele.alt)}) but EXPOSE FAILED: ${rec.expose_error}`);
      manifest.frames.push(rec); manifest.refusals.push({ label: rec.label, error: rec.expose_error });
      recordDone(i, rec); continue;
    }
    const fname = `f${String(i).padStart(2, '0')}_${p.azName}_alt${p.alt}.fits`;
    const dateObs = new Date().toISOString();
    writeFitsPlanar(path.join(SWEEP_DEST, fname), cap.planes, cap.W, cap.H,
      frameCards({ dateObs, site, cmd: { alt: p.alt, az: p.az, raHours: eq.raHours, decDeg: eq.decDeg },
        achieved: { ra: tele.ra, dec: tele.dec, alt: tele.alt, az: tele.az }, exposureS, elementType: cap.elementType }));
    rec.status = 'OK'; rec.file = fname; rec.image = { W: cap.W, H: cap.H, NP: cap.NP, elementType: cap.elementType }; rec.t_expose_utc = dateObs;
    frameCount++;
    console.log(`${tag}: cmd az${p.az}/alt${p.alt} RA${eq.raHours.toFixed(3)}h Dec${eq.decDeg.toFixed(2)} -> achieved RA${fmt3(tele.ra)}h Dec${fmt2(tele.dec)} alt${fmt1(tele.alt)} az${fmt1(tele.az)} | ${cap.W}x${cap.H}x${cap.NP} ${cap.elementType} -> ${fname}`);
    manifest.frames.push(rec); recordDone(i, rec);
  }

  manifest.ended_utc = new Date().toISOString();
  manifest.wall_clock_s = Math.round((Date.now() - t0) / 1000);
  manifest.frame_count = frameCount;
  const mpath = path.join(SWEEP_DEST, 'manifest.json');
  fs.writeFileSync(mpath, JSON.stringify(manifest, null, 2));
  console.log(`\nSWEEP DONE: ${frameCount} frames, ${manifest.refusals.length} refusals/skips, ${manifest.wall_clock_s}s${manifest.aborted ? ' (ABORTED: ' + manifest.abort_reason + ')' : ''}`);
  console.log(`manifest: ${mpath}`);
}
const fmt1 = (v) => (typeof v === 'number' ? v.toFixed(1) : '?');
const fmt2 = (v) => (typeof v === 'number' ? v.toFixed(2) : '?');
const fmt3 = (v) => (typeof v === 'number' ? v.toFixed(3) : '?');

function help() {
  console.log(`Seestar control CLI (Alpaca-first REST + native 4700 JSON-RPC fallback)

  node tools/seestar/ctl.mjs <verb> [flags]

VERBS
  status                              device state (Alpaca telescope/filterwheel/camera props, or native)
  connect | disconnect                telescope/0 connected on/off (Alpaca)
  goto   --ra <h> --dec <deg> [--name N]   slew (+ solve on native)
  solar  --filter-confirmed [--lat --lon]  slew to the Sun (ephemeris; REFUSES w/o filter-confirm)
  expose --secs <n> [--gain g]        Alpaca: capture 1 frame -> FITS in ${PULL_DEST}; native: start stack
  suntest [--secs n]                  1 frame at current pointing -> sun_test_001.fits + stats (sun-in-FOV check)
  sweep  --filter-confirmed [--secs n] [--resume]  25-pointing compass grid (8 az x alt{0,30,60} + zenith) -> ${SWEEP_DEST}
  stop                                abortslew (Alpaca) / iscope_stop_view (native)
  pull                                list eMMC frames + download newest -> ${PULL_DEST} (native)

FLAGS
  --transport auto|alpaca|native  (default auto: Alpaca REST if it answers, else native 4700)
  --alpaca-port <n>  (default ${PORTS.ALPACA_REST_S30PRO})   --host <ip>  skip discovery
  --dry-run  print the request, send nothing   --lat/--lon  site (east-pos lon)   --timeout <ms>

RELIABILITY (sweep sequence)
  --retries <n>        transient-transport retries per call (default 4; dropped-WiFi backoff)
  --retry-base-ms <n>  backoff base ms, x2 each retry, capped 8000 (default 500)
  --slew-timeout <ms>  slew watchdog: abort+fail a slew that never settles (default 120000)
  --resume [--sweep-id <id>]  resume an interrupted sweep from its checkpoint
                       (test_results/seestar/<id>.checkpoint.json; default id 'sweep01')

SITE (rider #3): --lat/--lon (config) > live device GPS > device-gps-cached (last-known
  for this serial) > absent. Explicit config always wins. Cached feeds slew planning only;
  frames record SITESRC/SITEFIX provenance and are NOT verdict-grade unless config/live GPS.

SAFETY: goto/solar within ${SUN_AVOID_DEG}deg of the Sun REFUSES unless --filter-confirmed (gate is
        transport-agnostic). Never run the phone app concurrently (single-controller). RA/Dec only.`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.verb === 'help') { help(); return; }
  banner();
  const verbs = {
    status: vStatus, goto: vGoto, solar: vSolar, expose: vExpose, stop: vStop, pull: vPull,
    sweep: vSweep, suntest: vSunTest,
    connect: (a) => vConnect(a, true), disconnect: (a) => vConnect(a, false),
  };
  const fn = verbs[args.verb];
  if (!fn) { console.error(`unknown verb: ${args.verb}`); help(); process.exit(2); }
  await fn(args);
}

main().catch((e) => { console.error('ctl fatal:', e); process.exit(1); });
