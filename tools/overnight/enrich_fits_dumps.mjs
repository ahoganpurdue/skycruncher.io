// ═══════════════════════════════════════════════════════════════════════════
// FITS DUMP ENRICHMENT — thin wrapper over tools/overnight/dump_index.mjs.
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/overnight/enrich_fits_dumps.mjs [--manifest <path>] [--dry-run]
//
// WHEN YOU NEED THIS
//   The manifest regenerator (test_results/tmp_inventory.mjs) is now
//   SELF-SUFFICIENT: a bare regen already emits the FITS dump fields
//   (dump_available/dump_path/dump_source/dump_detections/pixel_scale) directly,
//   via the SAME shared fitsDumpFields() this script uses. So a fresh regen no
//   longer needs an enrich pass.
//
//   This wrapper stays useful for RE-STAMPING an EXISTING manifest in place
//   WITHOUT a full regen — e.g. after new fits_dets/ dumps land — since a full
//   regen re-reads every FITS header + every CR2's EXIF (heavy), whereas this
//   only touches the dump fields. It is FITS-only and honest-absent by
//   construction (both properties live in fitsDumpFields).
//
// The dump→field logic itself is NOT duplicated here — it lives ONCE in
// tools/overnight/dump_index.mjs. Both this script and the regenerator import it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitsDumpFields, isFitsRow } from './dump_index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry-run');
const MANIFEST = path.resolve(ROOT, argVal('--manifest', 'test_results/corpus_manifest.json'));

if (!fs.existsSync(MANIFEST)) { console.error(`manifest not found: ${MANIFEST}`); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

let enriched = 0, cleared = 0, skippedNonFits = 0, alreadyOk = 0;
for (const im of manifest.images) {
  if (!isFitsRow(im)) { skippedNonFits++; continue; }
  const fields = fitsDumpFields(im.path, ROOT);
  if (fields.dump_available) {
    const wasOk = im.dump_available === true && im.dump_path === fields.dump_path &&
                  im.dump_source === fields.dump_source && im.dump_detections === fields.dump_detections &&
                  (im.pixel_scale ?? null) === (fields.pixel_scale ?? null);
    Object.assign(im, fields);
    if (wasOk) alreadyOk++; else enriched++;
  } else {
    // FITS frame with no dump on disk → explicit honest-absent.
    if (im.dump_available !== false || im.dump_path != null) cleared++;
    im.dump_available = false;
    im.dump_path = null;
  }
}

const next = JSON.stringify(manifest, null, 2);
const prev = fs.readFileSync(MANIFEST, 'utf8');
const changed = prev !== next;
console.log(`FITS dump enrichment: ${enriched} newly-set, ${alreadyOk} already-current, ${cleared} cleared-to-absent, ${skippedNonFits} non-FITS untouched`);
if (DRY) { console.log('[--dry-run] no write.'); process.exit(0); }
if (!changed) { console.log('manifest byte-identical — no write.'); process.exit(0); }
fs.writeFileSync(MANIFEST, next, 'utf8');
console.log(`WROTE ${path.relative(ROOT, MANIFEST)}`);
