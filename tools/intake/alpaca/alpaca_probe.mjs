#!/usr/bin/env node
// tools/intake/alpaca/alpaca_probe.mjs
// ─────────────────────────────────────────────────────────────────────────────
// ONE-SHOT ALPACA CAPABILITIES PROBE. Point it at a live Seestar (Station mode)
// the instant it powers on and it answers the one question that decides the whole
// control-wave design: does this firmware expose the TELESCOPE (goto/slew) surface,
// or only the CAMERA? Native Alpaca goto → native control wave; Camera-only →
// seestar_alp-bridge control wave.
//
// READ-ONLY. Pure GETs: enumerates the management API's configured devices and, for
// each, dumps its interface surface (common ASCOM getters + Telescope/Camera
// capability getters: canslew/cansettracking/canpulseguide, camerastate/exposure
// limits/…). Never connects, never slews, never exposes. Every endpoint is recorded
// value-or-error (honest-or-absent — a #1031 NotConnected is reported, not hidden).
//
// Writes a JSON capabilities report and prints a plain-language verdict.
// Reuses the vetted Alpaca client (tools/seestar/lib.mjs).
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpRequest, alpacaApi, alpacaValue, alpacaDiscover } from '../../seestar/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

// Standard getters, by scope. Each is a pure GET; value-or-error is recorded.
const COMMON_GETTERS = ['connected', 'name', 'description', 'driverinfo', 'driverversion', 'interfaceversion', 'supportedactions'];
const TELESCOPE_GETTERS = [
  'canslew', 'canslewasync', 'cansettracking', 'canpulseguide', 'cansync', 'canpark', 'canunpark', 'canfindhome',
  'alignmentmode', 'equatorialsystem', 'tracking', 'slewing', 'atpark',
  'rightascension', 'declination', 'altitude', 'azimuth', 'siderealtime',
];
const CAMERA_GETTERS = [
  'camerastate', 'cameraxsize', 'cameraysize', 'imageready', 'canabortexposure', 'canstopexposure',
  'cansetccdtemperature', 'canfastreadout', 'exposuremin', 'exposuremax', 'exposureresolution',
  'maxbinx', 'maxbiny', 'sensortype', 'maxadu', 'gainmin', 'gainmax', 'gain', 'pixelsizex', 'pixelsizey',
];
const FILTERWHEEL_GETTERS = ['names', 'position', 'focusoffsets'];
const FOCUSER_GETTERS = ['position', 'maxstep', 'maxincrement', 'absolute', 'stepsize', 'ismoving'];

const GETTERS_BY_TYPE = {
  telescope: TELESCOPE_GETTERS, camera: CAMERA_GETTERS,
  filterwheel: FILTERWHEEL_GETTERS, focuser: FOCUSER_GETTERS,
};

// One GET → { value } | { error } (honest; no retry — a probe is a single shot).
async function get(host, port, dtype, dnum, method) {
  const v = alpacaValue(await alpacaApi(host, port, 'GET', dtype, dnum, method));
  return 'value' in v ? { value: v.value } : { error: v.error };
}

async function dumpDevice(host, port, dev) {
  const dtype = String(dev.DeviceType || '').toLowerCase();
  const dnum = dev.DeviceNumber ?? 0;
  const out = {
    device_type: dev.DeviceType, device_number: dnum, name: dev.DeviceName, unique_id: dev.UniqueID,
    common: {}, capabilities: {},
  };
  for (const m of COMMON_GETTERS) out.common[m] = await get(host, port, dtype, dnum, m);
  for (const m of (GETTERS_BY_TYPE[dtype] || [])) out.capabilities[m] = await get(host, port, dtype, dnum, m);
  return out;
}

/**
 * Probe an Alpaca host. Returns the full capabilities report object (also the
 * shape written to disk). Never throws on transport failure — an unreachable host
 * yields a report with management errors and an honest verdict.
 */
export async function probeHost({ host, port = 32323, discover = false, log = console } = {}) {
  const report = {
    schema: 'skycruncher.alpaca.capabilities/1',
    probed_at: new Date().toISOString(), host, alpaca_port: port,
    discovery: null, management: {}, devices: [], verdict: null,
  };

  if (discover) {
    const hits = await alpacaDiscover(1500);
    report.discovery = hits;
    if (!host && hits.length) { report.host = host = hits[0].address; report.alpaca_port = port = hits[0].alpacaPort || port; log.error?.(`(discovered ${host}:${port} via Alpaca UDP)`); }
  }
  if (!host) { report.verdict = { reachable: false, reason: 'no host (pass --host or --discover with a device present)' }; return report; }

  const av = await httpRequest(host, port, 'GET', '/management/apiversions', null, 2500);
  report.management.apiversions = av.json ?? { error: av.error || `HTTP ${av.status}` };
  const desc = await httpRequest(host, port, 'GET', '/management/v1/description', null, 2500);
  report.management.description = desc.json ?? { error: desc.error || `HTTP ${desc.status}` };
  const cd = await httpRequest(host, port, 'GET', '/management/v1/configureddevices', null, 2500);
  const devList = cd.json && (cd.json.Value || cd.json);
  report.management.configureddevices = Array.isArray(devList) ? devList : (cd.json ?? { error: cd.error || `HTTP ${cd.status}` });

  if (!Array.isArray(devList)) {
    report.verdict = { reachable: false, reason: `management API did not list devices (${cd.error || 'HTTP ' + cd.status})` };
    return report;
  }
  for (const dev of devList) report.devices.push(await dumpDevice(host, port, dev));

  // ── Verdict — the decision the whole control wave hinges on. ────────────────
  const types = devList.map((d) => String(d.DeviceType || '').toLowerCase());
  const hasTelescope = types.includes('telescope');
  const hasCamera = types.includes('camera');
  const teleDump = report.devices.find((d) => String(d.device_type).toLowerCase() === 'telescope');
  const canSlew = teleDump && teleDump.capabilities.canslew && teleDump.capabilities.canslew.value === true;
  report.verdict = {
    reachable: true,
    has_telescope: hasTelescope, has_camera: hasCamera,
    telescope_can_slew: !!canSlew,
    control_surface: hasTelescope
      ? (canSlew ? 'NATIVE_GOTO' : 'TELESCOPE_PRESENT_SLEW_UNCONFIRMED')
      : (hasCamera ? 'CAMERA_ONLY' : 'UNKNOWN'),
    recommendation: hasTelescope
      ? (canSlew ? 'Telescope device exposes goto/slew → control wave = NATIVE Alpaca (goto/capture/dither directly).'
                 : 'Telescope device present but canslew not TRUE (device may need connect first) → re-probe after connect; likely native.')
      : (hasCamera ? 'No Telescope device — CAMERA ONLY. Control wave needs the seestar_alp bridge (native 4700 goto) for pointing; the watcher still ingests frames.'
                   : 'No Telescope or Camera device listed — not a recognizable Seestar Alpaca surface.'),
  };
  return report;
}

function printSummary(report, log = console) {
  const v = report.verdict || {};
  log.log(`\n=== Alpaca capabilities probe — ${report.host || '(no host)'}:${report.alpaca_port} ===`);
  if (!v.reachable) { log.log(`  UNREACHABLE: ${v.reason}`); return; }
  const devs = report.management.configureddevices;
  log.log(`  devices: ${Array.isArray(devs) ? devs.map((d) => `${d.DeviceType}/${d.DeviceNumber}`).join(', ') : '(none)'}`);
  log.log(`  control surface: ${v.control_surface}`);
  log.log(`  → ${v.recommendation}`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { host: null, port: 32323, discover: false, out: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--host') a.host = argv[++i];
    else if (t === '--alpaca-port' || t === '--port') a.port = Number(argv[++i]);
    else if (t === '--discover') a.discover = true;
    else if (t === '--out') a.out = argv[++i];
    else if (t === '-h' || t === '--help') a.help = true;
    else { console.error(`unknown arg: ${t}`); process.exit(2); }
  }
  return a;
}

async function mainCli() {
  const a = parseArgs(process.argv);
  if (a.help) {
    console.log(`alpaca_probe.mjs — one-shot Alpaca capabilities probe (read-only)

  node tools/intake/alpaca/alpaca_probe.mjs --host <ip> [--alpaca-port 32323] [--out report.json]
  node tools/intake/alpaca/alpaca_probe.mjs --discover        # find via UDP :32227, then probe

Enumerates configured devices + each device's capability getters; prints whether the
firmware exposes the Telescope (goto) surface or only the Camera. Never connects/slews.`);
    return;
  }
  const report = await probeHost({ host: a.host, port: a.port, discover: a.discover });
  const outPath = a.out || path.join(REPO_ROOT, 'test_results', 'seestar', `alpaca_capabilities_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  printSummary(report);
  console.log(`\n  full report → ${outPath}`);
}

const isMain = (() => { try { return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href; } catch { return false; } })();
if (isMain) mainCli().catch((e) => { console.error('probe fatal:', e); process.exit(1); });

export { printSummary };
