#!/usr/bin/env node
// split_for_r2.mjs — deterministically split an oversized object into R2-uploadable
// parts + a self-describing chunk manifest (schema skycruncher.r2.chunked-object/1).
// ============================================================================
// WHY: wrangler's `r2 object put` has a ~300 MiB single-object cap. Objects above
// it (e.g. band_0.arrow at 503 MB) are stored as ordered <=part-mib slices plus a
// <target>.parts.json that a fetcher uses to reassemble + verify. See
// docs/R2_STARDATA_LAYOUT.md §1a for the fetcher contract.
//
// USAGE
//   node tools/setup/split_for_r2.mjs --file <big.arrow> --out <dir> \
//     [--part-mib 250] [--target-name band_0.arrow] [--base-prefix <release-prefix>]
//
// Output in <dir>: <target>.part00, <target>.part01, …, <target>.parts.json
// Deterministic: identical input bytes -> identical parts + hashes.
// Upload the parts + the .parts.json to <base-prefix>/ with wrangler.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const FILE = opt('file', null);
const OUT = opt('out', null);
const PART_MIB = Number(opt('part-mib', 250));
if (!FILE || FILE === true || !OUT || OUT === true) {
  console.error('split_for_r2: --file <path> and --out <dir> are required'); process.exit(1);
}
const ABS_FILE = path.resolve(FILE);
const TARGET = String(opt('target-name', path.basename(ABS_FILE)));
const BASE_PREFIX = opt('base-prefix', null);
const PART_SIZE = PART_MIB * 1024 * 1024;
if (!Number.isFinite(PART_SIZE) || PART_SIZE <= 0 || PART_SIZE > 300 * 1024 * 1024) {
  console.error('split_for_r2: --part-mib must be in (0, 300] to stay under wrangler cap'); process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const total = fs.statSync(ABS_FILE).size;
const fd = fs.openSync(ABS_FILE, 'r');
const wholeHash = createHash('sha256');
const parts = [];
const buf = Buffer.allocUnsafe(1 << 20); // 1 MiB read buffer
let order = 0, offset = 0;
while (offset < total) {
  const partBytes = Math.min(PART_SIZE, total - offset);
  const suffix = String(order).padStart(2, '0');
  const partName = `${TARGET}.part${suffix}`;
  const partPath = path.join(OUT, partName);
  const wfd = fs.openSync(partPath, 'w');
  const partHash = createHash('sha256');
  let written = 0;
  while (written < partBytes) {
    const toRead = Math.min(buf.length, partBytes - written);
    const n = fs.readSync(fd, buf, 0, toRead, offset + written);
    if (n <= 0) break;
    const slice = buf.subarray(0, n);
    fs.writeSync(wfd, slice);
    partHash.update(slice);
    wholeHash.update(slice);
    written += n;
  }
  fs.closeSync(wfd);
  parts.push({ order, key: BASE_PREFIX ? partName : partName, bytes: written, sha256: partHash.digest('hex') });
  console.log(`[split] ${partName}  ${written} B  ${parts[order].sha256}`);
  offset += partBytes;
  order++;
}
fs.closeSync(fd);

const manifest = {
  schema: 'skycruncher.r2.chunked-object/1',
  target: TARGET,
  ...(BASE_PREFIX ? { base_prefix: String(BASE_PREFIX) } : {}),
  reason: `${TARGET} (${total} B) exceeds wrangler's ~300 MiB single-object PUT cap; stored as ordered parts.`,
  whole: { bytes: total, sha256: wholeHash.digest('hex') },
  reassembly: 'GET each part key (relative to base_prefix) in ascending order, concatenate the raw bytes, verify sha256(result) == whole.sha256, then treat the result as target.',
  part_size_bytes: PART_SIZE,
  parts,
};
const manPath = path.join(OUT, `${TARGET}.parts.json`);
fs.writeFileSync(manPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`[split] whole ${total} B  sha256 ${manifest.whole.sha256}`);
console.log(`[split] wrote ${manPath}  (${parts.length} parts)`);
