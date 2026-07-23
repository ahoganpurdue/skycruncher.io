#!/usr/bin/env node
// tools/intake/alpaca/mock_seestar.mjs
// ─────────────────────────────────────────────────────────────────────────────
// A MINIMAL ASCOM Alpaca server that impersonates a ZWO Seestar well enough to
// drive alpaca_watcher.mjs + alpaca_probe.mjs end-to-end HEADLESSLY (no device).
// Speaks: management API (apiversions / description / configureddevices listing a
// Telescope + Camera), the Telescope capability getters, and the Camera imaging
// loop (connected / camerastate / imageready / startexposure / imagebytes /
// imagearray) + Camera capability getters.
//
// FRAME SOURCE: a deterministic synthetic star-field by default (fast, asset-free,
// used by the gated tests); `--fits <path>` serves a real FITS's pixels via
// imagebytes (e.g. public/demo/seestar_m66_sample.fit) for a realistic demo where
// the Solve Queue actually solves the frame.
//
// TEST HOOKS (importable): startMockSeestar(opts) → { url, port, stop, setOutage,
// setOffline, state }. setOutage(n) makes the next n device requests fail with 503
// (transient) so the watcher's resilience/retry path can be exercised deterministically.
//
// This is a TEST/DEV fixture, never a product surface. It does not implement the
// full Alpaca spec — only the endpoints the watcher/probe touch, plus the standard
// capability getters so the probe's verdict logic has something to enumerate.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { buildImageBytes, buildImageArrayJson, syntheticStarFrame, IMAGE_ELEMENT_TYPE } from './alpaca_image.mjs';

const UID_TELE = '9f1c2b30-seestar-tele-0001';
const UID_CAM = '9f1c2b30-seestar-cam0-0001';

// Static capability tables (the standard Alpaca getters the probe enumerates).
function telescopeProps(state) {
  return {
    connected: () => state.teleConnected,
    name: () => 'Seestar Telescope',
    description: () => 'ZWO Seestar S30 Pro (mock) — Telescope device',
    driverinfo: () => 'mock_seestar.mjs Alpaca fixture',
    driverversion: () => '0.1',
    interfaceversion: () => 3,
    supportedactions: () => [],
    canslew: () => true,
    canslewasync: () => true,
    cansettracking: () => true,
    canpulseguide: () => false,
    cansync: () => true,
    canpark: () => false,
    canunpark: () => false,
    canfindhome: () => false,
    alignmentmode: () => 0,           // altAz
    equatorialsystem: () => 2,        // J2000
    tracking: () => state.tracking,
    slewing: () => false,
    atpark: () => false,
    rightascension: () => state.ra,   // HOURS (ASCOM convention == our crval)
    declination: () => state.dec,     // deg
    altitude: () => state.alt,
    azimuth: () => state.az,
    siderealtime: () => 0,
  };
}

function cameraProps(state) {
  return {
    connected: () => state.camConnected,
    name: () => 'Seestar Camera',
    description: () => 'ZWO Seestar S30 Pro (mock) — telephoto Camera device',
    driverinfo: () => 'mock_seestar.mjs Alpaca fixture',
    driverversion: () => '0.1',
    interfaceversion: () => 3,
    supportedactions: () => [],
    camerastate: () => state.exposing ? 2 : 0,   // 0 idle, 2 exposing
    cameraxsize: () => state.W,
    cameraysize: () => state.H,
    imageready: () => imageReady(state),
    canabortexposure: () => true,
    canstopexposure: () => true,
    cansetccdtemperature: () => false,
    canfastreadout: () => false,
    exposuremin: () => 0.001,
    exposuremax: () => 3600,
    exposureresolution: () => 0.001,
    maxbinx: () => 1,
    maxbiny: () => 1,
    binx: () => 1,
    biny: () => 1,
    startx: () => 0,
    starty: () => 0,
    numx: () => state.W,
    numy: () => state.H,
    sensortype: () => (state.NP > 1 ? 2 : 0),     // 0 mono, 2 RGGB (best-effort)
    maxadu: () => 65535,
    gainmin: () => 0,
    gainmax: () => 300,
    gain: () => 80,
    pixelsizex: () => 2.9,
    pixelsizey: () => 2.9,
  };
}

function imageReady(state) {
  if (!state.exposing) return state.imageready;
  if (Date.now() >= state.exposureEndAt) { state.exposing = false; state.imageready = true; }
  return state.imageready;
}

function alpacaEnvelope(value, clientTxn, serverTxn) {
  return { Value: value, ClientTransactionID: clientTxn >>> 0, ServerTransactionID: serverTxn >>> 0, ErrorNumber: 0, ErrorMessage: '' };
}

/**
 * Start the mock server.
 * opts: { port?, host? ('127.0.0.1'), frame? ({planes,W,H,NP,elementType}),
 *         fitsPath?, ra?, dec?, includeTelescope? (default true) }
 * Returns { url, host, port, server, stop(), setOutage(n), setOffline(bool), state }.
 */
export function startMockSeestar(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const includeTelescope = opts.includeTelescope !== false;

  // Callers pass an already-decoded `frame` ({planes,W,H,NP,elementType}); the CLI
  // decodes a real FITS up front (loadFitsFrame). Default: synthetic star-field.
  const frame = opts.frame || syntheticStarFrame({ W: opts.W || 64, H: opts.H || 48, NP: opts.NP || 1 });

  const state = {
    teleConnected: false, camConnected: false, tracking: false,
    ra: opts.ra ?? 11.34122957103827, dec: opts.dec ?? 12.9,   // M66-ish default
    alt: 60, az: 120,
    W: frame.W, H: frame.H, NP: frame.NP,
    elementType: frame.elementType || 'UInt16',
    planes: frame.planes,
    exposing: false, imageready: false, exposureEndAt: 0,
    frameCounter: 0,            // per-exposure identity → ServerTransactionID of the frame
    serverTxn: 0,              // monotonic per-response ServerTransactionID
    outage: 0,                 // next N requests fail 503 (transient)
    offline: false,
    reqCount: 0,
  };
  const tele = telescopeProps(state);
  const cam = cameraProps(state);

  const server = http.createServer((req, res) => {
    state.reqCount++;
    // Device-vanish simulation: a transient 503 the watcher retries.
    if (state.offline || state.outage > 0) {
      if (state.outage > 0) state.outage--;
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('mock offline (simulated device vanish)');
      return;
    }
    let u; try { u = new URL(req.url, `http://${host}`); } catch { res.writeHead(400); res.end(); return; }
    const parts = u.pathname.split('/').filter(Boolean);   // e.g. api,v1,camera,0,imageready
    const q = u.searchParams;
    const clientTxn = Number(q.get('ClientTransactionID') || 0);
    const serverTxn = ++state.serverTxn;

    const sendJson = (obj, code = 200) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
    const sendValue = (v) => sendJson(alpacaEnvelope(v, clientTxn, serverTxn));

    // ── Management API ──────────────────────────────────────────────────────
    if (u.pathname === '/management/apiversions') return sendValue([1]);
    if (u.pathname === '/management/v1/description')
      return sendValue({ ServerName: 'Seestar (mock)', Manufacturer: 'ZWO', ManufacturerVersion: 'mock-1.2.0', Location: 'LAN' });
    if (u.pathname === '/management/v1/configureddevices') {
      const devs = [];
      if (includeTelescope) devs.push({ DeviceName: 'Seestar Telescope', DeviceType: 'Telescope', DeviceNumber: 0, UniqueID: UID_TELE });
      devs.push({ DeviceName: 'Seestar Camera', DeviceType: 'Camera', DeviceNumber: 0, UniqueID: UID_CAM });
      return sendValue(devs);
    }

    // ── Device API: /api/v1/<type>/<num>/<method> ───────────────────────────
    if (parts[0] === 'api' && parts[1] === 'v1' && parts.length >= 5) {
      const dtype = parts[2], dnum = parts[3], method = parts[4].toLowerCase();

      if (dtype === 'telescope' && dnum === '0') {
        if (req.method === 'PUT') return readBody(req, () => {
          if (method === 'connected') { /* body Connected=... */ readForm(req, (f) => { state.teleConnected = f.Connected === 'true'; }); return sendValue(null); }
          return sendValue(null);
        });
        const fn = tele[method];
        if (fn) return sendValue(fn());
        return sendJson({ Value: null, ClientTransactionID: clientTxn, ServerTransactionID: serverTxn, ErrorNumber: 1024, ErrorMessage: `NotImplemented: ${method}` });
      }

      if (dtype === 'camera' && dnum === '0') {
        if (req.method === 'PUT') {
          return readForm(req, (form) => {
            if (method === 'connected') { state.camConnected = form.Connected === 'true'; return sendValue(null); }
            if (method === 'startexposure') {
              const dur = Number(form.Duration || 0);
              state.exposing = true; state.imageready = false;
              state.exposureEndAt = Date.now() + Math.max(0, dur * 1000);
              state.frameCounter++;                        // new frame identity
              return sendValue(null);
            }
            if (['binx', 'biny', 'startx', 'starty', 'numx', 'numy', 'gain'].includes(method)) return sendValue(null);
            if (method === 'abortexposure' || method === 'stopexposure') { state.exposing = false; state.imageready = false; return sendValue(null); }
            return sendValue(null);
          });
        }
        // GET
        if (method === 'imagebytes') {
          if (!imageReady(state)) return sendJson({ Value: null, ErrorNumber: 1035, ErrorMessage: 'InvalidOperation: image not ready' });
          const buf = buildImageBytes({ planes: state.planes, W: state.W, H: state.H, elementType: state.elementType, serverTxnId: state.frameCounter, clientTxnId: clientTxn });
          res.writeHead(200, { 'Content-Type': 'application/imagebytes', 'Content-Length': buf.length });
          res.end(buf);
          return;
        }
        if (method === 'imagearray') {
          if (!imageReady(state)) return sendJson({ Value: null, ErrorNumber: 1035, ErrorMessage: 'InvalidOperation: image not ready' });
          const env = buildImageArrayJson({ planes: state.planes, W: state.W, H: state.H, elementType: state.elementType, serverTxnId: state.frameCounter, clientTxnId: clientTxn });
          return sendJson(env);
        }
        const fn = cam[method];
        if (fn) return sendValue(fn());
        return sendJson({ Value: null, ClientTransactionID: clientTxn, ServerTransactionID: serverTxn, ErrorNumber: 1024, ErrorMessage: `NotImplemented: ${method}` });
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`no mock route for ${u.pathname}`);
  });

  return new Promise((resolve) => {
    server.listen(opts.port || 0, host, () => {
      const port = server.address().port;
      resolve({
        url: `http://${host}:${port}`, host, port, server, state,
        stop: () => new Promise((r) => server.close(() => r())),
        setOutage: (n) => { state.outage = n; },
        setOffline: (b) => { state.offline = !!b; },
      });
    });
  });
}

function readBody(req, cb) { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => cb(b)); }
function readForm(req, cb) { readBody(req, (b) => { const f = {}; for (const [k, v] of new URLSearchParams(b)) f[k] = v; cb(f); }); }

// Load a real FITS's pixels for the --fits demo mode (uses the stack lane reader).
function loadFitsFrame(fitsPath, fitsMod) {
  const { openFits, readPlaneRaw } = fitsMod;
  const f = openFits(fitsPath);
  try {
    const planes = [];
    for (let p = 0; p < f.NP; p++) planes.push(readPlaneRaw(f, p));
    return { planes, W: f.W, H: f.H, NP: f.NP, elementType: f.BITPIX === -32 ? 'Single' : 'UInt16' };
  } finally { f.close(); }
}

// ── CLI ───────────────────────────────────────────────────────────────────
async function mainCli() {
  const argv = process.argv.slice(2);
  const args = { port: 32323, host: '127.0.0.1', fits: null, telescopeOnly: false, noTelescope: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--port') args.port = Number(argv[++i]);
    else if (t === '--host') args.host = argv[++i];
    else if (t === '--fits') args.fits = argv[++i];
    else if (t === '--no-telescope') args.noTelescope = true;
    else if (t === '-h' || t === '--help') { printHelp(); return; }
  }
  let frame = null;
  if (args.fits) {
    const fitsMod = await import('../../stack/fits_io.mjs');
    frame = loadFitsFrame(args.fits, fitsMod);
    console.log(`serving real FITS ${args.fits} → ${frame.W}x${frame.H}x${frame.NP} (${frame.elementType})`);
  }
  const m = await startMockSeestar({ port: args.port, host: args.host, frame, includeTelescope: !args.noTelescope });
  console.log(`mock Seestar (Alpaca) listening on ${m.url}`);
  console.log(`  management: ${m.url}/management/v1/configureddevices`);
  console.log(`  camera/0 frame: ${m.state.W}x${m.state.H}x${m.state.NP} (${m.state.elementType})${args.fits ? '' : ' [synthetic star-field]'}`);
  console.log('  Ctrl-C to stop.');
}
function printHelp() {
  console.log(`mock_seestar.mjs — minimal Alpaca server impersonating a Seestar (test/dev only)

  node tools/intake/alpaca/mock_seestar.mjs [--port 32323] [--host 127.0.0.1] [--fits <path>] [--no-telescope]

  --fits <path>     serve a real FITS's pixels (e.g. public/demo/seestar_m66_sample.fit) so the queue can actually solve
  --no-telescope    omit the Telescope device (simulates a Camera-only firmware — exercises the probe's verdict)`);
}

const isMain = (() => { try { return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href; } catch { return false; } })();
if (isMain) mainCli().catch((e) => { console.error('mock fatal:', e); process.exit(1); });
