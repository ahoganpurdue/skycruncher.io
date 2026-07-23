// ═══════════════════════════════════════════════════════════════════════════
// SHARED DUMP-INDEX RESOLUTION for the overnight corpus manifest.
// ═══════════════════════════════════════════════════════════════════════════
//
// SINGLE SOURCE OF TRUTH for the FITS detection-dump → manifest-field mapping.
// Both the manifest regenerator (test_results/tmp_inventory.mjs) and the thin
// enrich wrapper (tools/overnight/enrich_fits_dumps.mjs) import THIS — so the
// logic lives in ONE place (no incubator-sin duplication).
//
// WHY THESE FIELDS ARE LOAD-BEARING (the contract)
//   The overnight driver (tools/overnight/run_pipeline.mjs) resolves each FITS
//   frame's detection dump THROUGH the manifest:
//     • buildDumpMap  reads im.dump_available / im.dump_path  → FITS rail eligibility
//     • buildScaleMap reads im.pixel_scale                    → astrometry truth-stage
//                                                               scale prior
//   A manifest WITHOUT these fields marks every FITS frame "no-dump" and the
//   driver SILENTLY SKIPS the FITS solve-vs-truth (graduation) rail. CR2 frames
//   survive via the driver's legacy cr2_dets/<id>.app.json fallback; FITS has NO
//   such fallback, so these fields are the ONLY thing keeping the FITS half alive.
//
// ID / FILENAME SUBTLETY (the crux)
//   dump_fits_frame.mjs SANITIZES the output basename:
//     basename(file) → strip ext → replace([^A-Za-z0-9._-]+ , '_')
//   so "Andromeda Galaxy M31 90s-431_ISO100.fit" → fits_dets/
//   "Andromeda_Galaxy_M31_90s-431_ISO100.json". The manifest path keeps spaces,
//   so the manifest id and the on-disk dump filename are NOT identical. We
//   reproduce the tool's exact sanitization to find the matching dump, and write
//   dump_path pointing at that sanitized on-disk name (the driver reads dump_path
//   VERBATIM — it never reconstructs the filename from the id).
//
// HONEST-OR-ABSENT
//   A FITS frame WITHOUT a dump on disk → { dump_available:false, dump_path:null }
//   (never a fabricated path). pixel_scale comes from the dump's own
//   scaleArcsecPerPx (header optics); null ⇒ the truth solve runs BLIND, which is
//   byte-identical to absence.

import fs from 'node:fs';
import path from 'node:path';

export const FITS_DETS_REL = 'test_results/fits_dets';

// EXACT mirror of dump_fits_frame.mjs's output-basename derivation.
export function dumpStemOf(imgPath) {
  const base = String(imgPath).split(/[\\/]/).pop() ?? String(imgPath);
  return base.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_');
}

export function isFitsRow(im) {
  return im?.container === 'FITS' || /\.fits?$/i.test(im?.path ?? '');
}

// Resolve the FITS detection-dump manifest fields for one image path.
// Returns the exact key/order the driver + enrich expect:
//   present → { dump_available:true, dump_path, dump_source, dump_detections[, pixel_scale] }
//   absent  → { dump_available:false, dump_path:null }
// `root` is the repo root (dump_path is written repo-relative).
export function fitsDumpFields(imgPath, root) {
  const stem = dumpStemOf(imgPath);
  const dumpAbs = path.join(root, FITS_DETS_REL, `${stem}.json`);
  if (!fs.existsSync(dumpAbs)) {
    return { dump_available: false, dump_path: null };
  }
  const relPath = `${FITS_DETS_REL}/${stem}.json`;
  let detN = null, src = 'fits-extract', pxScale = null;
  try {
    const d = JSON.parse(fs.readFileSync(dumpAbs, 'utf8'));
    detN = Array.isArray(d.detections) ? d.detections.length : (d.detection?.kept ?? null);
    src = d.source ?? 'fits-extract';
    const s = Number(d.scaleArcsecPerPx);
    pxScale = Number.isFinite(s) && s > 0 ? s : null; // header optics; null ⇒ blind (honest-absent)
  } catch { /* a corrupt dump still counts as present — keep defaults */ }
  const fields = { dump_available: true, dump_path: relPath, dump_source: src, dump_detections: detN };
  if (pxScale != null) fields.pixel_scale = pxScale; // restore the truth-stage scale prior
  return fields;
}
