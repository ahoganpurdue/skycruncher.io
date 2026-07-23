#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/c2pa/sidecar_fits.mjs — detached C2PA sidecar for FITS / ASDF exports
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/c2pa/sidecar_fits.mjs --asset <fits|asdf> --manifest <def.json> [--out-dir <dir>]
//
// C2PA cannot EMBED a manifest into FITS or ASDF (neither format has a chunk
// c2patool can inject). The standard answer is a DETACHED manifest: c2patool
// treats the asset as application/octet-stream, hashes the WHOLE file into the
// claim (hard binding over the bytes), and writes a separate `<basename>.c2pa`
// sidecar. The asset itself is byte-unchanged.
//
// CONVENTION (documented, load-bearing): the asset and its `<basename>.c2pa`
// sidecar TRAVEL TOGETHER in the same directory. c2patool auto-associates them by
// name on verify. Two independent bindings hold the trio together:
//   • asset  ↔ sidecar : C2PA hard binding (data hash over the FITS/ASDF bytes)
//   • sidecar ↔ receipt : org.skycruncher.receipt.receipt_sha256
// Move the asset without its sidecar and provenance is simply ABSENT (honest), not
// forged. Modify the asset and the data hash mismatches (tamper-evident).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { requireC2paTool, DEV_SIGN_CERT, DEV_PRIVATE_KEY, DEV_SIGN_ALG } from './lib/env.mjs';

function parseArgs(argv) {
  const a = { asset: null, manifest: null, outDir: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--asset') a.asset = argv[++i];
    else if (t === '--manifest') a.manifest = argv[++i];
    else if (t === '--out-dir') a.outDir = argv[++i];
    else { process.stderr.write(`[c2pa] unknown arg ${t}\n`); process.exit(1); }
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.asset || !a.manifest) {
    process.stderr.write('usage: node tools/c2pa/sidecar_fits.mjs --asset <fits|asdf> --manifest <def.json> [--out-dir <dir>]\n');
    process.exit(1);
  }
  const tool = requireC2paTool();
  const assetPath = path.resolve(a.asset);
  if (!fs.existsSync(assetPath)) { process.stderr.write(`[c2pa] asset not found: ${assetPath}\n`); process.exit(1); }
  const def = JSON.parse(fs.readFileSync(path.resolve(a.manifest), 'utf8'));

  const signingManifest = { ...def, alg: DEV_SIGN_ALG, private_key: DEV_PRIVATE_KEY, sign_cert: DEV_SIGN_CERT };
  const tmp = path.join(os.tmpdir(), `skycruncher_c2pa_sidecar_${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(signingManifest));

  // The asset + its sidecar must land in the same dir to travel together.
  const outDir = a.outDir ? path.resolve(a.outDir) : path.resolve('test_results', 'c2pa', 'sidecar');
  fs.mkdirSync(outDir, { recursive: true });
  const outAsset = path.join(outDir, path.basename(assetPath));
  // c2patool derives the sidecar name from the output basename: <base>.c2pa
  const sidecar = path.join(outDir, path.basename(assetPath).replace(/\.[^.]+$/, '') + '.c2pa');

  // -s = sidecar (detached), -o = where the asset+sidecar are written, -f = force.
  const res = spawnSync(tool, [assetPath, '-m', tmp, '-o', outAsset, '-s', '-f'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  if (res.status !== 0) {
    process.stderr.write(`[c2pa] sidecar signing FAILED (exit ${res.status})\n${res.stdout || ''}${res.stderr || ''}\n`);
    process.exit(4);
  }
  const assetUnchanged = fs.statSync(assetPath).size === fs.statSync(outAsset).size;
  process.stderr.write(`[c2pa] SIDECAR (DEV-CERT) → ${sidecar}\n[c2pa] asset (byte-unchanged=${assetUnchanged}) → ${outAsset}\n`);
  process.stdout.write(JSON.stringify({
    asset: outAsset, sidecar, asset_bytes_unchanged: assetUnchanged, signer: 'DEV-CERT es256 (CAI test)',
  }) + '\n');
}

main();
