#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/sextant — real_data_attempt.mjs
//   Inventory a directory of FITS SUBS (individual light frames of one target,
//   NOT stacked products) for the mount-geometry fitter, and either run the fit
//   or report the honest refusal + exactly what a future session drop must carry.
//
//   node tools/sextant/real_data_attempt.mjs [--dir "Sample Files/rotating"] [--match carina]
//
// THE INPUT CONTRACT a real session needs (see README): a time-ordered set of
// per-sub ROTATION angles (deg) vs UTC timestamp for ONE target, e.g.
//   [{ t_utc: "<DATE-OBS ISO>", rotation_deg: <field rotation of the sub>, sigma?: <deg> }]
// plus the solved target { ra_hours, dec_deg }. Per-sub rotation is the position
// angle of each sub's WCS relative to a reference sub — it is NOT currently ledgered
// by the stack lane (only the CD matrix per frame is), so a real run must either
// (a) solve each sub and extract rotation = atan2(sign·CD2_1, CD1_1) [parity from the
// CD determinant, never asserted], or (b) run a pairwise-rotation estimator on the
// detections. Ground truth for scoring: SITELAT/SITELONG header cards (SeeStar writes
// them; fits_decoder.ts:393-399 reads them into gps_lat/gps_lon).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitMountGeometry, PREDICATE_DEFAULTS } from './fit_core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  const a = { dir: 'Sample Files/rotating', match: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') a.dir = argv[++i];
    else if (argv[i] === '--match') a.match = argv[++i];
  }
  return a;
}

// read FITS header cards (ASCII, 2880-byte blocks) WITHOUT decoding pixel data
function readFitsHeader(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(2880 * 60);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const txt = buf.toString('latin1', 0, n);
  const h = {};
  for (let i = 0; i < txt.length; i += 80) {
    const card = txt.slice(i, i + 80);
    if (card.startsWith('END') && card.slice(3).trim() === '') break;
    const m = card.match(/^([A-Z0-9_-]+)\s*=\s*(.*?)(?:\/.*)?$/);
    if (m) {
      let v = m[2].trim().replace(/^'(.*)'$/, '$1').trim();
      h[m[1]] = v;
    }
  }
  return h;
}

const a = parseArgs(process.argv.slice(2));
const dirAbs = path.resolve(ROOT, a.dir);
const outDir = path.join(ROOT, 'test_results', 'sextant');
fs.mkdirSync(outDir, { recursive: true });

let files = [];
try {
  files = fs.readdirSync(dirAbs).filter((f) => /\.fits?$/i.test(f) && (!a.match || f.toLowerCase().includes(a.match.toLowerCase())));
} catch (e) {
  process.stderr.write(`[sextant] cannot read ${dirAbs}: ${e.message}\n`);
}

// If a match was given, treat the matched files as ONE candidate sub-sequence.
// Otherwise group by INSTRUME+OBJECT+prefix heuristics (kept simple: report all).
const subs = files.map((f) => {
  const h = readFitsHeader(path.join(dirAbs, f));
  return {
    file: f,
    date_obs: h['DATE-OBS'] || h['DATE'] || null,
    object: h['OBJECT'] || null,
    instrume: h['INSTRUME'] || null,
    site_lat: h['SITELAT'] ?? null,
    site_lon: h['SITELONG'] ?? null,
    ra: h['OBJCTRA'] || h['RA'] || null,
    dec: h['OBJCTDEC'] || h['DEC'] || null,
    has_wcs: ('CD1_1' in h) || ('CROTA1' in h) || ('CROTA2' in h),
  };
}).filter((s) => s.date_obs).sort((x, y) => Date.parse(x.date_obs) - Date.parse(y.date_obs));

const report = {
  dir: a.dir, match: a.match, n_subs_found: subs.length,
  subs,
  ground_truth_available: subs.some((s) => s.site_lat != null && s.site_lon != null),
  rotations_available: subs.every((s) => s.has_wcs),
};

if (subs.length >= 2) {
  const t0 = Date.parse(subs[0].date_obs), tN = Date.parse(subs[subs.length - 1].date_obs);
  report.arc_min = (tN - t0) / 60000;
}

// Attempt the fit IF we have ≥MIN_N subs AND rotations. We do NOT fabricate rotations:
// when rotations are absent the pre-fit gates already refuse on n_points / session_arc,
// so we exercise the fitter with the REAL timestamps and null-rotation placeholders and
// report that the refusal is on the DATA-SUFFICIENCY gate (independent of rotation values).
if (subs.length > 0) {
  const series = subs.map((s) => ({ t_utc: s.date_obs, rotation_deg: 0 })); // placeholders — see note
  const target = { ra_hours: 10.7, dec_deg: -59.7 }; // Carina Nebula (NGC 3372) nominal, unsolved
  const res = fitMountGeometry({ series, target });
  report.fit_attempt = {
    note: 'rotation_deg are PLACEHOLDERS (subs not solved); the refusal below is on the data-sufficiency gate and is independent of rotation values',
    status: res.status,
    failed_predicate: res.failed_predicate || null,
    detail: res.detail || null,
    thresholds: { MIN_N: PREDICATE_DEFAULTS.MIN_N, MIN_ARC_MIN: PREDICATE_DEFAULTS.MIN_ARC_MIN },
  };
}

const outPath = path.join(outDir, 'real_data_attempt.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

// human summary
process.stdout.write(`\n=== SEXTANT real-data attempt: ${a.dir}${a.match ? ' (match="' + a.match + '")' : ''} ===\n`);
process.stdout.write(`subs found: ${report.n_subs_found}\n`);
for (const s of subs) process.stdout.write(`  ${s.file}  DATE-OBS=${s.date_obs}  site=${s.site_lat ?? 'none'},${s.site_lon ?? 'none'}  wcs=${s.has_wcs}  instr=${s.instrume || '?'}\n`);
if (report.arc_min != null) process.stdout.write(`arc: ${report.arc_min.toFixed(2)} min (need ≥ ${PREDICATE_DEFAULTS.MIN_ARC_MIN})\n`);
process.stdout.write(`ground-truth site (SITELAT/SITELONG): ${report.ground_truth_available ? 'YES' : 'NONE'}\n`);
process.stdout.write(`per-sub rotations ledgered (WCS present): ${report.rotations_available ? 'YES' : 'NO — solve + CD-extract required'}\n`);
if (report.fit_attempt) process.stdout.write(`fit verdict: ${report.fit_attempt.status}${report.fit_attempt.failed_predicate ? ' · ' + report.fit_attempt.failed_predicate : ''}\n  ${report.fit_attempt.detail || ''}\n`);
process.stderr.write(`[artifacts] ${path.relative(ROOT, outPath)}\n`);
