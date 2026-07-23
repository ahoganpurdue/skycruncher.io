// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION HARNESS · Phase-2 · Diagnostic-visual generator (contact sheet)
// ═══════════════════════════════════════════════════════════════════════════
// One annotated "tagged PNG" per tested CR2 frame / arm so the owner can VISUALLY
// see what processed well and which tools fired per image type. Reads the
// existing on-disk sweep artifacts (READ-ONLY) + decodes each unique frame
// ONCE, then renders both A/B arms from the cached pixels.
//
// The overlay is the shared DENSE "bubble-tile" dashboard (tools/validation/
// visual/bubble_tiles.mjs) — rounded, translucent, colour-coded chips clustered
// on a right rail + a header pill, honest-or-absent (a test that did not run
// gets NO tile). CR2 arm outcomes carry solve/lock + detection; PSF/attribution/
// distortion blocks are absent for the CR2 lane and simply render no tile.
//
// TWO-LEDGER LAW: this is a RENDER-LAYER artifact only. The stretch/overlay/
// chips are display transforms burned into a PNG for human eyes — labeled,
// reversible, and NEVER fed back into any measurement. Nothing here touches
// WCS, matched_stars, detections, or a calibrated gate.
//
// Inputs (all present on disk now — no merge/sweep-completion needed):
//   - test_results/validation/_cr2_raw/anchor1/<frame>.json  (baseline OFF)
//   - test_results/validation/_cr2_raw/anchor3/<frame>.json  (candidate ON)
//   - test_results/cr2_dets/<frame>.app.json                 (detections)
//   - test_results/corpus_manifest.json                      (source paths + rig)
// Decode: CR2 -> tools/psf/decode_cr2.mjs ; FITS -> tools/stack/fits_io.mjs
// Output: test_results/validation/visuals/<frame>__<arm>.png (~1600px)
//
// Usage:
//   node tools/validation/visual/contact_sheet.mjs            # priority-first, all
//   node tools/validation/visual/contact_sheet.mjs IMG_1653   # a subset
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INFO, PASS, FAIL,
  stretch, grayToCanvas, drawRing, drawText, buildGroups, composite, encodePng,
} from './bubble_tiles.mjs';

const START = Math.floor(Date.now() / 1000);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RAW_DIR = path.join(ROOT, 'test_results', 'validation', '_cr2_raw');
const DET_DIR = path.join(ROOT, 'test_results', 'cr2_dets');
const OUT_DIR = path.join(ROOT, 'test_results', 'validation', 'visuals');
const MANIFEST = path.join(ROOT, 'test_results', 'corpus_manifest.json');

const TARGET_W = 1600;      // downscale long edge target (high-res tagged image)
const MAX_DET_MARKERS = 600; // brightest-N detection rings (readability)

// Owner-priority frames (interesting ones first so browsing can start early).
const PRIORITY = ['IMG_1653', 'CSM30803_5DMkIII_iso6400_15s', 'IMG_1241', 'IMG_1410', 'IMG_1414'];

// ── source-path + rig resolution via manifest (dump_file paths are stale) ─────
function buildPathMap() {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const paths = new Map(), rigs = new Map();
  for (const im of m.images) {
    const base = path.basename(im.path).replace(/\.[^.]+$/, '');
    paths.set(base.toLowerCase(), path.join(ROOT, im.path));
    rigs.set(base.toLowerCase(), im.camera ?? im.cohort ?? null);
  }
  return { paths, rigs };
}
function resolveSource(frame, provenance, pathMap) {
  let p = pathMap.get(frame.toLowerCase());
  if (p && fs.existsSync(p)) return p;
  const stem = frame.replace(/_iso\d+.*$/i, '');
  p = pathMap.get(stem.toLowerCase());
  if (p && fs.existsSync(p)) return p;
  if (provenance?.dump_file) {
    const cand = [
      path.join(ROOT, provenance.dump_file),
      path.join(ROOT, provenance.dump_file.replace(/[\\/]corpus[\\/]/, '/challenge/')),
    ];
    for (const cc of cand) if (fs.existsSync(cc)) return cc;
  }
  return null;
}
function rigOf(frame, rigs) {
  return rigs.get(frame.toLowerCase()) ?? rigs.get(frame.replace(/_iso\d+.*$/i, '').toLowerCase()) ?? null;
}

// ── decode + downscale to a luminance plane (memory-light accumulation) ──────
async function decodeToLuma(srcPath) {
  const ext = path.extname(srcPath).toLowerCase();
  if (ext === '.cr2' || ext === '.crw') {
    const { decodeCR2, terminateDecodeWorkers } = await import(pathToFileUrl(path.join(ROOT, 'tools', 'psf', 'decode_cr2.mjs')));
    try {
      const { w, h, rgb16 } = await decodeCR2(srcPath);
      const f = Math.max(1, Math.round(Math.max(w, h) / TARGET_W));
      const outW = Math.floor(w / f), outH = Math.floor(h / f);
      const acc = new Float64Array(outW * outH), cnt = new Uint32Array(outW * outH);
      for (let y = 0; y < h; y++) {
        const oy = Math.floor(y / f); if (oy >= outH) continue;
        const rowBase = y * w;
        for (let x = 0; x < w; x++) {
          const ox = Math.floor(x / f); if (ox >= outW) continue;
          const i = (rowBase + x) * 3;
          const v = rgb16[i] + rgb16[i + 1] + rgb16[i + 2]; // dominant-channel sum ~= photosite
          const oi = oy * outW + ox; acc[oi] += v; cnt[oi]++;
        }
      }
      const lum = new Float32Array(outW * outH);
      for (let i = 0; i < lum.length; i++) lum[i] = cnt[i] ? acc[i] / cnt[i] : 0;
      return { lum, outW, outH, f, srcW: w, srcH: h };
    } finally { try { terminateDecodeWorkers(); } catch { /* noop */ } }
  }
  if (ext === '.fits' || ext === '.fit') {
    const { openFits, readLuminanceNormalized } = await import(pathToFileUrl(path.join(ROOT, 'tools', 'stack', 'fits_io.mjs')));
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
  throw new Error(`unsupported source ext: ${ext}`);
}

function pathToFileUrl(p) { return 'file://' + p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:'); }

// ── CR2 arm outcome → receipt-shaped sources (honest-or-absent) ──────────────
function cr2Sources(o, dets, rig) {
  const prov = o.provenance || {};
  return {
    solution: {
      locked: o.locked,
      ra_hours: o.ra ?? null,
      dec_degrees: o.dec ?? null,
      pixel_scale_arcsec: o.pixel_scale_arcsec ?? null,
      stars_matched: o.matched ?? null,
      confidence: o.sigma ?? o.confidence ?? null,
      roll_degrees: o.rotation_deg ?? null,
      parity: o.parity ?? null,
      locking_tool: o.locking_tool ?? null,
      best_peak_z: prov.best_peak_z ?? null,
    },
    // CR2 anchor sweep records the ANCHOR-star center, not a truth-adjudicated
    // frame center — truth is honest-absent for this lane (never fabricated).
    psf_attribution: prov.psf_attribution ?? null,
    detection: { count: dets.length },
    metadata: rig ? { rig } : null,
  };
}

// ── render one arm ───────────────────────────────────────────────────────────
function render(gray, outW, outH, dets, f, o, armStr, rig, outPath) {
  const c = grayToCanvas(gray, outW, outH);
  const marks = [...dets].sort((a, b) => (b.flux || 0) - (a.flux || 0)).slice(0, MAX_DET_MARKERS);
  for (const d of marks) drawRing(c, d.x / f, d.y / f, 3, INFO, 0.85);
  drawText(c, marks.length + '/' + dets.length + ' DETS', 6, outH - 24, 2, INFO, 1, false);
  const groups = buildGroups(cr2Sources(o, dets, rig));
  composite(c, {
    header: {
      frame: o.frame, imageType: o.image_type, rig,
      statusText: (o.locked ? 'LOCKED' : 'NO-LOCK') + ' · ARM ' + armStr,
      statusColor: o.locked ? PASS : FAIL,
    },
    groups,
  });
  fs.writeFileSync(outPath, encodePng(c));
  return fs.statSync(outPath).size;
}

// ── driver ───────────────────────────────────────────────────────────────────
function loadOutcome(arm, frame) {
  const p = path.join(RAW_DIR, arm, frame + '.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
function loadDets(frame) {
  for (const cand of [frame, frame.replace(/_iso\d+.*$/i, '')]) {
    const p = path.join(DET_DIR, cand + '.app.json');
    if (fs.existsSync(p)) {
      try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(d.detections) ? d.detections : []; }
      catch { return []; }
    }
  }
  return [];
}
function sameOutcome(a, b) {
  return a.locked === b.locked && a.matched === b.matched &&
    a.provenance?.best_peak_z === b.provenance?.best_peak_z &&
    a.locking_tool === b.locking_tool;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { paths: pathMap, rigs: rigMap } = buildPathMap();
  const argv = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const all = fs.readdirSync(path.join(RAW_DIR, 'anchor1')).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  const ordered = [...PRIORITY.filter(f => all.includes(f)), ...all.filter(f => !PRIORITY.includes(f))];
  const frames = argv.length ? ordered.filter(f => argv.some(a => f.toLowerCase().includes(a.toLowerCase()))) : ordered;

  const written = [], skipped = [];
  for (const frame of frames) {
    const off = loadOutcome('anchor1', frame), on = loadOutcome('anchor3', frame);
    if (!off || !on) { skipped.push({ frame, reason: 'missing anchor outcome json' }); console.log(`SKIP ${frame}: missing outcome`); continue; }
    const src = resolveSource(frame, off.provenance, pathMap);
    if (!src) { skipped.push({ frame, reason: `source frame not found on disk (dump_file=${off.provenance?.dump_file})` }); console.log(`SKIP ${frame}: no source file`); continue; }

    let dec;
    try { dec = await decodeToLuma(src); }
    catch (e) { skipped.push({ frame, reason: `decode failed: ${e.message}` }); console.log(`SKIP ${frame}: decode ${e.message}`); continue; }

    const dets = loadDets(frame);
    const gray = stretch(dec.lum);
    const rig = rigOf(frame, rigMap);
    const same = sameOutcome(off, on);

    try {
      if (same) {
        const outPath = path.join(OUT_DIR, `${frame}__BOTH.png`);
        const bytes = render(gray, dec.outW, dec.outH, dets, dec.f, off, 'OFF=ON', rig, outPath);
        written.push({ frame, arm: 'BOTH', path: outPath, kb: Math.round(bytes / 1024), locked: off.locked });
        console.log(`WROTE ${path.basename(outPath)} (${(bytes / 1e6).toFixed(2)}MB) ${dec.srcW}x${dec.srcH}->${dec.outW}x${dec.outH} ${off.locked ? 'LOCK' : 'no-lock'}`);
      } else {
        for (const [armStr, o] of [['OFF', off], ['ON', on]]) {
          const outPath = path.join(OUT_DIR, `${frame}__${armStr}.png`);
          const bytes = render(gray, dec.outW, dec.outH, dets, dec.f, o, armStr, rig, outPath);
          written.push({ frame, arm: armStr, path: outPath, kb: Math.round(bytes / 1024), locked: o.locked });
          console.log(`WROTE ${path.basename(outPath)} (${(bytes / 1e6).toFixed(2)}MB) ${o.locked ? 'LOCK' : 'no-lock'}`);
        }
      }
    } catch (e) { skipped.push({ frame, reason: `render/encode failed: ${e.message}` }); console.log(`SKIP ${frame}: render ${e.message}`); }
  }

  const elapsed = Math.floor(Date.now() / 1000) - START;
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ elapsed_s: elapsed, written_count: written.length, skipped_count: skipped.length, out_dir: OUT_DIR, written, skipped }, null, 1));
  console.log('DONE');
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL', e); process.exit(1); });
