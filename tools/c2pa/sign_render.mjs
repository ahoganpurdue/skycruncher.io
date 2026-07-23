#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/c2pa/sign_render.mjs — embed a signed C2PA manifest into a render (DEV cert)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/c2pa/sign_render.mjs --asset <png> --manifest <definition.json> [--out <signed.png>]
//
// Takes a manifest definition (from manifest_from_receipt.mjs) + an asset, merges
// the DEV-cert signing block (es256, CAI test certs), and invokes c2patool to
// EMBED a hard-bound, signed manifest into the asset. Hard binding means the claim
// is hashed against the pixel bytes: any later edit invalidates the signature.
//
// ⚠ DEV-CERT: signed with the Content Authenticity Initiative's public test certs,
// which are NOT on any production trust list. Output is valid + fully parseable but
// its signer flags as untrusted. The production-cert story is a build-time decision
// (README §Production). Everything here is labeled DEV-CERT on purpose.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { requireC2paTool, DEV_SIGN_CERT, DEV_PRIVATE_KEY, DEV_SIGN_ALG } from './lib/env.mjs';

function parseArgs(argv) {
  const a = { asset: null, manifest: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--asset') a.asset = argv[++i];
    else if (t === '--manifest') a.manifest = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else { process.stderr.write(`[c2pa] unknown arg ${t}\n`); process.exit(1); }
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.asset || !a.manifest) {
    process.stderr.write('usage: node tools/c2pa/sign_render.mjs --asset <png> --manifest <definition.json> [--out <signed.png>]\n');
    process.exit(1);
  }
  const tool = requireC2paTool();
  const assetPath = path.resolve(a.asset);
  const defPath = path.resolve(a.manifest);
  if (!fs.existsSync(assetPath)) { process.stderr.write(`[c2pa] asset not found: ${assetPath}\n`); process.exit(1); }
  if (!fs.existsSync(DEV_SIGN_CERT) || !fs.existsSync(DEV_PRIVATE_KEY)) {
    process.stderr.write('[c2pa] DEV certs missing — run node tools/c2pa/fetch_c2patool.mjs\n'); process.exit(3);
  }
  const def = JSON.parse(fs.readFileSync(defPath, 'utf8'));

  // Merge the DEV signing block onto the semantic definition. Keep the definition
  // itself cert-free (it is the portable, testable artifact); signing config lives
  // only in this ephemeral signing manifest.
  const signingManifest = {
    ...def,
    alg: DEV_SIGN_ALG,
    private_key: DEV_PRIVATE_KEY,
    sign_cert: DEV_SIGN_CERT,
  };
  const tmp = path.join(os.tmpdir(), `skycruncher_c2pa_sign_${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(signingManifest));

  const outPath = a.out
    ? path.resolve(a.out)
    : assetPath.replace(/\.png$/i, '.signed.png');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // c2patool <asset> -m <manifest> -o <out> -f
  const res = spawnSync(tool, [assetPath, '-m', tmp, '-o', outPath, '-f'], { encoding: 'utf8' });
  try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  if (res.status !== 0) {
    process.stderr.write(`[c2pa] signing FAILED (exit ${res.status})\n${res.stdout || ''}${res.stderr || ''}\n`);
    process.exit(4);
  }
  process.stderr.write(`[c2pa] SIGNED (DEV-CERT) → ${outPath}\n`);
  process.stdout.write(JSON.stringify({ signed: outPath, signer: 'DEV-CERT es256 (CAI test)' }) + '\n');
}

main();
