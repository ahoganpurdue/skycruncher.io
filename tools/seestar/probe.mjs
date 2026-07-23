#!/usr/bin/env node
// tools/seestar/probe.mjs
// LAN discovery for a ZWO Seestar (S30 Pro target). Polite, read-only, no slew.
//   1. ASCOM Alpaca UDP discovery broadcast (:32227)  -> device IP + Alpaca port
//   2. TCP connect-probe for 4700/80/445/32323 across the local /24
//   3. If Alpaca reachable: pull the management API description
//   4. If native 4700 open: one read-only get_device_state (verbatim)
//
// Usage:
//   node tools/seestar/probe.mjs                 # scan the box's own /24
//   node tools/seestar/probe.mjs --subnet 192.168.68   # explicit /24 base
//   node tools/seestar/probe.mjs --host 192.168.68.42  # probe one known IP (skip scan)
//   node tools/seestar/probe.mjs --timeout 250         # per-port connect timeout ms
//
// EXIT 0 always for a clean run (device or not); EXIT 2 only on a usage/arg error.

import os from 'node:os';
import {
  PORTS, SCAN_PORTS, tcpProbe, mapLimit, subnetHosts,
  alpacaDiscover, alpacaGet, nativeRpc,
} from './lib.mjs';

function parseArgs(argv) {
  const a = { subnet: null, host: null, timeout: 200, concurrency: 48 };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--subnet') a.subnet = argv[++i];
    else if (t === '--host') a.host = argv[++i];
    else if (t === '--timeout') a.timeout = Number(argv[++i]);
    else if (t === '--concurrency') a.concurrency = Number(argv[++i]);
    else if (t === '-h' || t === '--help') a.help = true;
    else { console.error(`unknown arg: ${t}`); process.exit(2); }
  }
  return a;
}

function ownSubnet24() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const addr of ifs[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal && addr.address.startsWith('192.168.')) {
        const p = addr.address.split('.');
        return `${p[0]}.${p[1]}.${p[2]}`;
      }
    }
  }
  // Fallback: first non-internal IPv4 /24.
  for (const name of Object.keys(ifs)) {
    for (const addr of ifs[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const p = addr.address.split('.');
        return `${p[0]}.${p[1]}.${p[2]}`;
      }
    }
  }
  return null;
}

const portName = (p) => (Object.entries(PORTS).find(([, v]) => v === p) || ['?', p])[0];

async function inspectDevice(ip, openPorts, timeoutMs) {
  const report = { ip, openPorts, alpaca: null, deviceState: null };

  // Alpaca management description (native REST surface).
  const alpacaPort = report.alpacaPortHint || PORTS.ALPACA_REST_S30PRO;
  if (openPorts.includes(PORTS.ALPACA_REST_S30PRO) || report.alpacaPortHint) {
    const desc = await alpacaGet(ip, alpacaPort, '/management/v1/description', Math.max(1500, timeoutMs * 6));
    const devs = await alpacaGet(ip, alpacaPort, '/management/v1/configureddevices', Math.max(1500, timeoutMs * 6));
    report.alpaca = { port: alpacaPort, description: desc.json ?? desc.error ?? desc.body, configuredDevices: devs.json ?? devs.error };
  }

  // Native 4700 read-only status.
  if (openPorts.includes(PORTS.NATIVE_RPC)) {
    try {
      const resp = await nativeRpc(ip, 'get_device_state', undefined, { timeoutMs: Math.max(3000, timeoutMs * 12) });
      report.deviceState = resp.result ?? resp;
    } catch (e) {
      report.deviceState = { error: String(e.message || e) };
    }
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('probe.mjs — Seestar LAN discovery. Flags: --subnet <x.y.z> --host <ip> --timeout <ms> --concurrency <n>');
    return;
  }

  console.log('=== Seestar LAN probe ===');
  console.log(`time: ${new Date().toISOString()}`);

  // Step 1: Alpaca UDP discovery (fast, non-intrusive).
  process.stdout.write('Alpaca UDP discovery (:32227) ... ');
  const alpacaHits = await alpacaDiscover(1200);
  console.log(alpacaHits.length ? `${alpacaHits.length} response(s)` : 'no response');
  for (const h of alpacaHits) console.log(`  -> ${h.address}  AlpacaPort=${h.alpacaPort}`);

  // Candidate hosts: explicit --host, else Alpaca hits, else full /24 TCP scan.
  let candidates;
  let scanned = false;
  if (args.host) {
    candidates = [args.host];
  } else if (alpacaHits.length) {
    candidates = alpacaHits.map((h) => h.address);
  } else {
    const base = args.subnet || ownSubnet24();
    if (!base) { console.log('no local /24 found; pass --subnet or --host'); return; }
    console.log(`TCP connect-scan ${base}.1-254 on ports [${SCAN_PORTS.map(portName).join(', ')}] (timeout ${args.timeout}ms, conc ${args.concurrency}) ...`);
    candidates = subnetHosts(base);
    scanned = true;
  }

  // Step 2: TCP connect-probe each candidate.
  const results = await mapLimit(candidates, args.concurrency, async (ip) => {
    const states = await mapLimit(SCAN_PORTS, SCAN_PORTS.length, async (port) => ({
      port, state: await tcpProbe(ip, port, args.timeout),
    }));
    const open = states.filter((s) => s.state === 'open').map((s) => s.port);
    return { ip, open };
  });

  // A host looks like a Seestar if 4700 (native RPC) OR the Alpaca REST port is open.
  const devices = results.filter((r) => r.open.includes(PORTS.NATIVE_RPC) || r.open.includes(PORTS.ALPACA_REST_S30PRO));
  // Merge Alpaca-discovery port hints.
  for (const d of devices) {
    const hit = alpacaHits.find((h) => h.address === d.ip);
    if (hit) d.alpacaPortHint = hit.alpacaPort;
  }

  if (scanned) {
    const anyOpen = results.filter((r) => r.open.length);
    console.log(`scan complete: ${results.length} hosts probed, ${anyOpen.length} with any open probe-port.`);
  }

  if (!devices.length) {
    console.log('\nNo Seestar found on this LAN (no host with 4700 or Alpaca REST open).');
    console.log('If the scope is on: confirm station mode (joined home WiFi, same /24) and retry, or pass --host <ip>.');
    return;
  }

  console.log(`\n=== ${devices.length} candidate device(s) ===`);
  for (const d of devices) {
    console.log(`\nDEVICE ${d.ip}`);
    console.log(`  open ports: ${d.open.map((p) => `${p}(${portName(p)})`).join(', ')}`);
    const rep = await inspectDevice(d.ip, d.open, args.timeout);
    if (d.alpacaPortHint) { rep.alpacaPortHint = d.alpacaPortHint; }
    if (rep.alpaca) {
      console.log(`  Alpaca management (:${rep.alpaca.port}):`);
      console.log('    description:      ' + JSON.stringify(rep.alpaca.description));
      console.log('    configuredDevices: ' + JSON.stringify(rep.alpaca.configuredDevices));
    }
    if (rep.deviceState) {
      console.log('  native get_device_state (4700) — VERBATIM:');
      console.log(indent(JSON.stringify(rep.deviceState, null, 2), 4));
    }
  }
  console.log('\nReady. Next: node tools/seestar/ctl.mjs status --host <ip>');
}

function indent(s, n) { const pad = ' '.repeat(n); return s.split('\n').map((l) => pad + l).join('\n'); }

main().catch((e) => { console.error('probe fatal:', e); process.exit(1); });
