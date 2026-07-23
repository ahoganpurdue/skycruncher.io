#!/usr/bin/env node
// upload_atlas_r2.mjs — publish the browser-lane deep-catalog ATLAS to R2.
// ============================================================================
// WHY: makes "quads and stars are all hosted on R2" true for the legacy/browser
// solve lane. The g15u quad index (starplates-2026.07-quadidx-g15u/) already
// hosts the greenfield stars.arrow + quad bands; this tool hosts the numeric
// sector atlas that star_catalog_adapter loads (public/atlas/sectors/).
//
// LAYOUT (mirrors the local sectors dir under a NEW release prefix):
//   <bucket>/<prefix>/level_3_sector_<0..35>.json    role: sector-json-live
//   <bucket>/<prefix>/level_3_sector_<0..35>.arrow   role: sector-arrow-twin
//   <bucket>/<prefix>/manifest.json                  aggregate (list+sizes+sha256)
//
// The legacy named HYG-source files (sector_RA*_DEC*.json) are DELIBERATELY
// excluded by the default --include: their stars are already merged into the
// numeric level_3_sector_*.json set (tools/atlas/README.md) and hosting them as
// "the atlas" would be misleading. Pass --include to override.
//
// CREDENTIALS: uses `wrangler` on PATH (OAuth login). No S3 keys required; no
// custom object metadata is set (wrangler put has no metadata flag) — every
// sha256 lives in the aggregate manifest instead.
//
// USAGE
//   node tools/setup/upload_atlas_r2.mjs \
//     --dir "<abs>/public/atlas/sectors" \
//     --prefix atlas-2026.07-hybrid/sectors \
//     --release atlas-2026.07-hybrid \
//     --public-base https://pub-<hash>.r2.dev \
//     [--bucket starplates] [--include "level_3_sector_*.json,level_3_sector_*.arrow"]
//     [--manifest-out <path>] [--manifest-key atlas-2026.07-hybrid/manifest.json]
//     [--dry-run] [--skip-existing]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const DIR = opt('dir', null);
const PREFIX = String(opt('prefix', 'atlas-2026.07-hybrid/sectors')).replace(/\/$/, '');
const RELEASE = String(opt('release', 'atlas-2026.07-hybrid'));
const BUCKET = String(opt('bucket', 'starplates'));
const PUBLIC_BASE = opt('public-base', null);
const DRY_RUN = argv.includes('--dry-run');
const SKIP_EXISTING = argv.includes('--skip-existing');
const MANIFEST_KEY = String(opt('manifest-key', `${RELEASE}/manifest.json`));
const MANIFEST_OUT = opt('manifest-out', null);
const INCLUDE = String(opt('include', 'level_3_sector_*.json,level_3_sector_*.arrow'))
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!DIR || DIR === true) { console.error('upload_atlas_r2: --dir <abs sectors dir> required'); process.exit(1); }
const ABS_DIR = path.resolve(DIR);
if (!fs.existsSync(ABS_DIR) || !fs.statSync(ABS_DIR).isDirectory()) {
  console.error(`upload_atlas_r2: --dir ${ABS_DIR} is not a directory`); process.exit(1);
}

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
function globToRe(g) { return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); }
const INCLUDE_RE = INCLUDE.map(globToRe);
function included(name) { return INCLUDE_RE.some((re) => re.test(name)); }
function contentTypeFor(name) {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.arrow')) return 'application/vnd.apache.arrow.file';
  return 'application/octet-stream';
}
function roleFor(name) {
  if (name.endsWith('.json')) return 'sector-json-live';
  if (name.endsWith('.arrow')) return 'sector-arrow-twin';
  return 'other';
}
function sha256File(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function headContentLength(url) {
  // resumable check via the public base (HEAD). Returns bytes or null.
  const r = spawnSync('curl', ['-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
    '-w', '%{http_code} %header{content-length}', '-I', url], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return null;
  const [code, clen] = String(r.stdout).trim().split(/\s+/);
  return code === '200' ? Number(clen) : null;
}

// wrangler is invoked via `npx` (it lives in the npx cache, not local node_modules).
// Override with WRANGLER_CMD if a direct binary path is preferable.
const WRANGLER = process.env.WRANGLER_CMD || 'npx wrangler';
function wranglerPut(key, file, contentType) {
  const cmd = `${WRANGLER} r2 object put "${BUCKET}/${key}" --file "${file}" ` +
    `--content-type "${contentType}" --cache-control "${CACHE_CONTROL}" --remote`;
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) throw new Error(`wrangler put ${key} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(-300)}`);
}

function main() {
  const names = fs.readdirSync(ABS_DIR).filter((n) => {
    const p = path.join(ABS_DIR, n);
    return fs.statSync(p).isFile() && included(n);
  }).sort();
  if (!names.length) { console.error(`upload_atlas_r2: no files matched ${JSON.stringify(INCLUDE)} in ${ABS_DIR}`); process.exit(1); }

  const files = [];
  let totalBytes = 0, uploaded = 0, skipped = 0;
  console.log(`[atlas] ${names.length} files -> ${BUCKET}/${PREFIX}/  (release ${RELEASE})${DRY_RUN ? ' [DRY RUN]' : ''}`);
  for (const name of names) {
    const local = path.join(ABS_DIR, name);
    const bytes = fs.statSync(local).size;
    const sha256 = sha256File(local);
    const key = `${PREFIX}/${name}`;
    const ct = contentTypeFor(name);
    files.push({ key: name, r2_key: key, bytes, sha256, content_type: ct, role: roleFor(name) });
    totalBytes += bytes;

    if (SKIP_EXISTING && PUBLIC_BASE) {
      const clen = headContentLength(`${String(PUBLIC_BASE).replace(/\/$/, '')}/${key}`);
      if (clen === bytes) { console.log(`[atlas] skip (exists, size match) ${key}`); skipped++; continue; }
    }
    if (DRY_RUN) { console.log(`[atlas] would upload ${key} (${bytes} B, ${ct})`); continue; }
    wranglerPut(key, local, ct);
    console.log(`[atlas] uploaded ${key} (${bytes} B)`);
    uploaded++;
  }

  const manifest = {
    schema: 'skycruncher.r2.atlas-aggregate/1',
    release: RELEASE,
    base_prefix: PREFIX,
    bucket: BUCKET,
    generated_at_utc: new Date().toISOString(),
    source_dir: ABS_DIR.replace(/\\/g, '/'),
    note: 'Browser-lane deep-catalog atlas. role=sector-json-live is the set star_catalog_adapter loads; ' +
      'role=sector-arrow-twin is the dormant Arrow data-plane twin. Legacy named HYG-source files ' +
      '(sector_RA*_DEC*.json) are excluded — already merged into the numeric level_3 set.',
    total_files: files.length,
    total_bytes: totalBytes,
    files,
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  if (MANIFEST_OUT) { fs.writeFileSync(MANIFEST_OUT, manifestJson); console.log(`[atlas] wrote manifest -> ${MANIFEST_OUT}`); }

  if (!DRY_RUN) {
    const tmp = path.join(process.env.TEMP || process.env.TMPDIR || '.', `atlas_manifest_${Date.now()}.json`);
    fs.writeFileSync(tmp, manifestJson);
    wranglerPut(MANIFEST_KEY, tmp, 'application/json');
    fs.unlinkSync(tmp);
    console.log(`[atlas] uploaded manifest -> ${BUCKET}/${MANIFEST_KEY}`);
  } else {
    console.log(`[atlas] would upload manifest -> ${BUCKET}/${MANIFEST_KEY} (${manifest.total_files} files, ${manifest.total_bytes} B)`);
  }
  console.log(`[atlas] done: ${uploaded} uploaded, ${skipped} skipped, ${manifest.total_bytes} bytes total.`);
}

main();
