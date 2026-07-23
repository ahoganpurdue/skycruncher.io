#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/c2pa/tamper_check.mjs — reproducible negative control for the binding
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/c2pa/tamper_check.mjs <signed.png> [--receipt <receipt.json>]
//
// Copies a signed PNG, flips ONE byte inside its image data (IDAT chunk — the
// region the C2PA hard-binding hashes; the caBX manifest chunk is excluded, so a
// flip there would NOT prove pixel tamper), then re-verifies. Asserts the verdict
// flips VALID → INVALID with an assertion.dataHash.mismatch. Exit 0 iff the
// negative control behaves (tamper detected); non-zero if a tampered asset would
// have passed — which would be a real integrity regression.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** First IDAT chunk's data byte-range in a PNG buffer. */
function firstIdatRange(buf) {
  let off = 8; // PNG signature
  while (off < buf.length - 8) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('latin1');
    const dataStart = off + 8;
    if (type === 'IDAT') return { start: dataStart, end: dataStart + len };
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return null;
}

function verify(asset, receipt) {
  const args = [path.join(HERE, 'verify.mjs'), asset];
  if (receipt) args.push('--receipt', receipt);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function main() {
  const argv = process.argv.slice(2);
  let signed = null, receipt = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--receipt') receipt = path.resolve(argv[++i]);
    else if (!argv[i].startsWith('--')) signed = path.resolve(argv[i]);
  }
  if (!signed || !fs.existsSync(signed)) {
    process.stderr.write('usage: node tools/c2pa/tamper_check.mjs <signed.png> [--receipt <receipt.json>]\n');
    process.exit(1);
  }

  // Baseline: the signed asset must verify VALID first (else the control is moot).
  const before = verify(signed, receipt);
  if (before.status !== 0) {
    process.stderr.write(`[c2pa] baseline signed asset did NOT verify (exit ${before.status}); aborting control\n${before.stdout}`);
    process.exit(2);
  }

  const buf = fs.readFileSync(signed);
  const idat = firstIdatRange(buf);
  if (!idat) { process.stderr.write('[c2pa] no IDAT chunk found — not a PNG?\n'); process.exit(2); }
  const flipAt = Math.floor((idat.start + idat.end) / 2);
  const original = buf[flipAt];
  buf[flipAt] = original ^ 0xff;
  const tampered = signed.replace(/\.png$/i, '.tampered.png');
  fs.writeFileSync(tampered, buf);

  const after = verify(tampered, receipt);
  const afterJson = (() => { try { return JSON.parse(after.stdout); } catch { return {}; } })();
  const detected = after.status === 5 && afterJson.valid === false &&
    (afterJson.failing_codes || []).some((c) => /dataHash\.mismatch/.test(c.code));

  process.stdout.write(JSON.stringify({
    signed, tampered, flipped_byte_offset: flipAt,
    idat_range: [idat.start, idat.end],
    baseline_valid: true,
    tampered_valid: afterJson.valid ?? null,
    failing_codes: afterJson.failing_codes || [],
    tamper_detected: detected,
  }, null, 2) + '\n');

  if (detected) {
    process.stderr.write('[c2pa] NEGATIVE CONTROL PASS: valid→invalid, tamper detected (dataHash.mismatch)\n');
    process.exit(0);
  }
  process.stderr.write('[c2pa] NEGATIVE CONTROL FAIL: a tampered asset was NOT rejected — integrity regression!\n');
  process.exit(1);
}

main();
