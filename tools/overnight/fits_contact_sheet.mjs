// ═══════════════════════════════════════════════════════════════════════════
// OVERNIGHT PIPELINE — FITS contact-sheet renderer (the truth-only render lane)
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY this exists (and is NOT contact_sheet.mjs):
//   tools/validation/visual/contact_sheet.mjs is the CR2 A/B-arm visualiser: it
//   is DRIVEN by test_results/validation/_cr2_raw/anchor{1,3}/<frame>.json (the
//   OFF/ON solve arms) — it enumerates frames from that directory and SKIPs any
//   frame lacking both arm outcomes. A FITS frame has NO CR2 A/B binding (its
//   solve stage is n/a by design), so contact_sheet can never see it, and
//   fabricating arm JSONs to feed it would CORRUPT the uw_anchor_topN graduation
//   ledger (run_cr2_sweep --merge-only appends every anchor-dir frame to it as
//   CR2_DSLR). So the overnight driver renders FITS here instead — a self-
//   contained, RENDER-LAYER-only tagged PNG for the truth+render FITS cohort.
//
// Both lanes share the DENSE "bubble-tile" dashboard overlay (tools/validation/
// visual/bubble_tiles.mjs) so the two visual lanes read identically. The FITS
// lane is RICHER than CR2: the fits solve arm raw (_fits_raw/arm{0,1}/<id>.json)
// carries provenance.psf_attribution (drift / tracking / diffraction / seeing /
// coma) + rig, so those tiles render here when present — honest-or-absent.
//
// TWO-LEDGER LAW: display transforms only (asinh stretch, detection overlay,
// bubble-tile chips burned into a PNG for human eyes). Reuses the CANONICAL FITS
// decode (tools/stack/fits_io.mjs — LAW 4, no decode in two places); only the
// display stretch/overlay is local (also shared). Touches NO WCS / matched_stars
// / calibrated gate, and writes NOTHING into _cr2_raw or any ledger.
//
// Inputs (all read-only):
//   - the source FITS + its detection dump (via corpus_manifest.json:
//     path + dump_path, pointing at test_results/fits_dets/*.json)
//   - the FITS solve arm raw (test_results/validation/_fits_raw/arm{0,1}/<id>.json)
//     for solve scalars + psf_attribution + rig (optional — honest-absent)
// Output: test_results/validation/visuals/<frame>__FITS.png  (~1600px long edge)
//
// Usage:
//   node tools/overnight/fits_contact_sheet.mjs "<frameId>" [--truth VERDICT] [--truth-ms N]
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { frameIdOf } from './rotation.mjs';
import {
  INFO, PASS, FAIL, WARN, ABSENT,
  stretch, grayToCanvas, drawRing, drawText, buildGroups, composite, encodePng,
} from '../validation/visual/bubble_tiles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MANIFEST = path.join(ROOT, 'test_results', 'corpus_manifest.json');
const OUT_DIR = path.join(ROOT, 'test_results', 'validation', 'visuals');
const FITS_RAW_DIR = path.join(ROOT, 'test_results', 'validation', '_fits_raw');

const TARGET_W = 1600;        // downscale long edge target (high-res tagged image)
const MAX_DET_MARKERS = 600;  // brightest-N detection rings (readability)

// ── decode + downscale to a luminance plane (canonical fits_io read) ─────────
async function decodeFitsToLuma(srcPath) {
  const { openFits, readLuminanceNormalized } = await import(pathToFileURL(path.join(ROOT, 'tools', 'stack', 'fits_io.mjs')));
  const fobj = openFits(srcPath);
  try {
    const { W: w, H: h } = fobj;
    const { lum: full } = readLuminanceNormalized(fobj);
    const f = Math.max(1, Math.round(Math.max(w, h) / TARGET_W));
    const outW = Math.floor(w / f), outH = Math.floor(h / f);
    const acc = new Float64Array(outW * outH), cnt = new Uint32Array(outW * outH);
    for (let y = 0; y < h; y++) {
      const oy = Math.floor(y / f); if (oy >= outH) continue;
      for (let x = 0; x < w; x++) {
        const ox = Math.floor(x / f); if (ox >= outW) continue;
        const oi = oy * outW + ox; acc[oi] += full[y * w + x]; cnt[oi]++;
      }
    }
    const lum = new Float32Array(outW * outH);
    for (let i = 0; i < lum.length; i++) lum[i] = cnt[i] ? acc[i] / cnt[i] : 0;
    return { lum, outW, outH, f, srcW: w, srcH: h };
  } finally { fobj.close(); }
}

// ── truth-verdict → header colour (honest-or-absent) ─────────────────────────
function verdictColour(v) {
  if (!v || v === 'NO_TRUTH') return ABSENT;
  if (v === 'TRUE_POSITIVE' || v === 'SOLVED_NO_CROSSCHECK' || v === 'SOLVED') return PASS;
  if (v === 'FALSE_POSITIVE' || v === 'NO_SOLVE') return FAIL;
  return WARN; // anything unexpected → labelled, never silently green
}

// ── manifest resolution (source + dump + rig via the same manifest) ──────────
function resolveFrame(frameId) {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  for (const im of m.images) if (frameIdOf(im.path) === frameId) return im;
  return null;
}
function loadDets(im) {
  if (!im.dump_path) return [];
  const p = path.join(ROOT, im.dump_path);
  if (!fs.existsSync(p)) return [];
  try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(d.detections) ? d.detections : []; }
  catch { return []; }
}
// The fits solve arm raw carries solve scalars + psf_attribution + rig. arm0 is
// authoritative (arm1 is the identity seam); either is fine, honest-absent if none.
function loadFitsArm(frameId) {
  for (const arm of ['arm0', 'arm1']) {
    const p = path.join(FITS_RAW_DIR, arm, `${frameId}.json`);
    if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* honest-absent */ } }
  }
  return null;
}

// ── FITS sources → receipt-shaped input (honest-or-absent) ───────────────────
function fitsSources({ im, arm, dets, verdict, rig }) {
  const prov = arm?.provenance || {};
  const solution = arm ? {
    locked: arm.locked,
    ra_hours: arm.ra ?? null,
    dec_degrees: arm.dec ?? null,
    pixel_scale_arcsec: arm.pixel_scale_arcsec ?? null,
    stars_matched: arm.matched ?? null,
    confidence: arm.sigma ?? null,
    roll_degrees: arm.rotation_deg ?? null,
    parity: arm.parity ?? null,
    locking_tool: arm.locking_tool ?? null,
  } : null;
  return {
    solution,
    truth: verdict ? { verdict } : null,
    psf_attribution: prov.psf_attribution ?? null,
    detection: { count: dets.length },
    metadata: {
      rig: rig ?? prov.rig?.instrume ?? null,
      focal_length: prov.rig?.focal_mm ?? im.focal_length ?? null,
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  const flags = new Set([]);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { const k = t.slice(2); if (flags.has(k)) a[k] = true; else a[k] = argv[++i]; }
    else a._.push(t);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const frameId = a._[0];
  if (!frameId) { console.error('usage: node tools/overnight/fits_contact_sheet.mjs "<frameId>" [--truth VERDICT] [--truth-ms N]'); process.exit(1); }

  const im = resolveFrame(frameId);
  if (!im) { console.error(`SKIP ${frameId}: not found in manifest`); process.exit(2); }
  const src = path.join(ROOT, im.path);
  if (!fs.existsSync(src)) { console.error(`SKIP ${frameId}: source not on disk (${im.path})`); process.exit(2); }
  const ext = path.extname(src).toLowerCase();
  if (ext !== '.fit' && ext !== '.fits') { console.error(`SKIP ${frameId}: not a FITS source (${ext}) — use contact_sheet.mjs for CR2`); process.exit(2); }

  let dec;
  try { dec = await decodeFitsToLuma(src); }
  catch (e) { console.error(`SKIP ${frameId}: decode failed: ${e.message}`); process.exit(2); }

  const dets = loadDets(im);
  const arm = loadFitsArm(frameId);
  const verdict = a.truth ?? arm?.truth?.verdict ?? null;
  const object = im.ground_truth?.object ?? im.truth_ref ?? null;
  const rig = im.camera ?? im.cohort ?? im.image_type ?? null;

  const gray = stretch(dec.lum);
  const c = grayToCanvas(gray, dec.outW, dec.outH);
  const marks = [...dets].sort((x, y) => (y.flux || 0) - (x.flux || 0)).slice(0, MAX_DET_MARKERS);
  for (const d of marks) drawRing(c, d.x / dec.f, d.y / dec.f, 3, INFO, 0.85);
  drawText(c, marks.length + '/' + dets.length + ' DETS', 6, dec.outH - 24, 2, INFO, 1, false);

  const groups = buildGroups(fitsSources({ im, arm, dets, verdict, rig }));
  composite(c, {
    header: {
      frame: object ? `${frameId} · ${object}` : frameId,
      imageType: im.image_type ?? 'FITS',
      rig,
      statusText: 'TRUTH ' + (verdict || 'NO_TRUTH'),
      statusColor: verdictColour(verdict),
    },
    groups,
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${frameId}__FITS.png`);
  fs.writeFileSync(outPath, encodePng(c));
  const bytes = fs.statSync(outPath).size;
  console.log(`WROTE ${path.basename(outPath)} (${(bytes / 1e6).toFixed(2)}MB) ${dec.srcW}x${dec.srcH}->${dec.outW}x${dec.outH} dets=${dets.length}`);
  console.log(JSON.stringify({ frame: frameId, png: outPath, dets: dets.length, verdict, tiles: groups.reduce((n, g) => n + g.tiles.length, 0) }));
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e?.stack || String(e)); process.exit(1); });
