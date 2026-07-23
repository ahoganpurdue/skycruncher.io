// ═══════════════════════════════════════════════════════════════════════════
// SEED / REGENERATE the truth labels file (tools/validation/truth/labels.json)
// (spec: docs/VALIDATION_HARNESS.md · Enhancement 1, item 2 · TWO-TIER truth)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/validation/truth/seed_labels.mjs            # write labels.json
//   node tools/validation/truth/seed_labels.mjs --print    # print, do not write
//
// TWO TIERS (see TruthTier in schema.ts), kept DISTINCT so a verdict never conflates
// a coarse goto pass with a gold oracle pass:
//   • GOLD anchors (pinned, durable): the bundled CR2 (brute-forced answer) and the
//     SeeStar M66 goto — GOLD because it is cross-checked against an astrometry.net
//     blind solve (agrees 0.079°; MEMORY astrometry-truth-oracle-state). These carry
//     precise, repo-pinned values so a clone (no local frames) keeps the answers.
//   • COARSE goto frames (enumerated from test_results/corpus_manifest.json): every
//     row whose ground_truth.source is FITS_RA_DEC (mount goto pointing) or FITS_CRVAL
//     (stacking-software WCS) with a real (non 0/0) center. The VALUES come straight
//     from the manifest, so labels.json stays durable in a clone with NO local FITS.
//     FITS_RA_DEC ⇒ COARSE, loosened center tol (goto is good to ~1°); FITS_CRVAL ⇒
//     COARSE with a tighter center tol (a real WCS, near-gold but still not an
//     independent blind solve). Scale is the nominal-FL header value = APPROXIMATE.
//
// The sweep's adjudicateArm resolves by frame_id via labels.json with ZERO sweep-code
// change. LAW 2: this ADDS coarse evidence at its own honest tier; the GOLD bar is
// untouched. A frame with neither gold nor coarse truth stays NO_TRUTH.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_KNOWN } from './loader.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(HERE, 'labels.json');
const MANIFEST = path.join(REPO_ROOT, 'test_results', 'corpus_manifest.json');

// Deterministic stamp — re-running the seed produces a byte-identical labels.json.
const GENERATED_AT = '2026-07-07T00:00:00.000Z';

/** Frame id = the source FITS basename minus extension (matches run_fits_sweep frameIdOfFits). */
function frameIdOfFits(p) {
  return path.basename(p).replace(/\.(fit|fits|fts)$/i, '');
}

// ── GOLD anchors (pinned, durable, sample-file-independent) ──────────────────────
// SeeStar M66: the goto OBJECT-RA/DEC pointing, PROMOTED to GOLD because it is
// independently cross-checked by an astrometry.net blind solve (agrees to 0.079°;
// MEMORY astrometry-truth-oracle-state). Values are the repo-pinned precise ones
// (derived from the local FITS via nominal-FL scale; committed here so a clone keeps
// them). source stays 'fits_header' (where the numbers came from); tier GOLD (trust).
const M66_FRAME_ID = 'DSO_Stacked_738_M 66_60.0s_20260516_064736';
const GOLD_ANCHORS = [
  {
    frame_id: M66_FRAME_ID,
    source: 'fits_header',
    tier: 'GOLD',
    ra_hours: 11.36166687011720,
    dec_degrees: 12.8419437408447,
    pixel_scale_arcsec: 3.7385496087500,
    provenance_note:
      'SeeStar M66 stack (imx585, FOCALLEN=160mm). center = OBJECT RA/DEC from FITS header (goto pointing, degrees->hours); scale = nominal 206.265*XPIXSZ(2.9um)/FOCALLEN(160mm) = APPROXIMATE (no CD/CDELT in header). TIER = GOLD: the goto is INDEPENDENTLY corroborated by an astrometry.net blind solve (agrees 0.079deg; MEMORY astrometry-truth-oracle-state) - unlike the uncorroborated COARSE goto frames.',
    generated_at: GENERATED_AT,
  },
];

// ── COARSE goto/CRVAL frames (from the corpus manifest) ──────────────────────────
const GOLD_FRAME_IDS = new Set([M66_FRAME_ID]);

/** Build a COARSE TruthLabel from a manifest image row (or null if not seedable). */
function coarseLabelFromManifestRow(im) {
  const gt = im.ground_truth;
  if (!gt) return null;
  if (gt.source !== 'FITS_RA_DEC' && gt.source !== 'FITS_CRVAL') return null;
  const raH = Number(gt.ra_h);
  const decD = Number(gt.dec);
  // honest-or-absent: a 0/0 placeholder (rejmap artifacts) is NOT a real pointing.
  if (!Number.isFinite(raH) || !Number.isFinite(decD) || (raH === 0 && decD === 0)) return null;

  const frame_id = frameIdOfFits(im.path);
  if (GOLD_FRAME_IDS.has(frame_id)) return null; // the M66 anchor is pinned GOLD above

  const scale = Number(im.header_scale_arcsec_px);
  const pixel_scale_arcsec = Number.isFinite(scale) && scale > 0 ? scale : null;
  const isCrval = gt.source === 'FITS_CRVAL';
  // FITS_CRVAL is a real stacking-software WCS ⇒ tighter center (1.0deg); FITS_RA_DEC
  // is a raw mount goto ⇒ loosened center (2.0deg, the COARSE_TOLERANCES base).
  const tolerances = isCrval ? { center_deg: 1.0, scale_frac: 0.05 } : { center_deg: 2.0, scale_frac: 0.05 };
  const kind = isCrval ? 'stacking-software CRVAL WCS' : 'mount goto (OBJECT RA/DEC)';
  const tolNote = isCrval
    ? `tight center tol ${tolerances.center_deg}deg (a real WCS, near-gold)`
    : `loosened center tol ${tolerances.center_deg}deg (~1deg goto error)`;
  const scaleNote = pixel_scale_arcsec == null
    ? 'no header scale (center-only truth)'
    : `nominal-FL header scale ${pixel_scale_arcsec}"/px = APPROXIMATE`;
  return {
    frame_id,
    source: 'fits_header',
    tier: 'COARSE',
    ra_hours: raH,
    dec_degrees: decD,
    pixel_scale_arcsec,
    provenance_note:
      `corpus_manifest.json ground_truth (${gt.source}${gt.object ? `, ${gt.object}` : ''}): center = ${kind}; scale = ${scaleNote}. TIER = COARSE (uncorroborated capture-header truth, ${tolNote}) - NOT the trusted gold bar.`,
    generated_at: GENERATED_AT,
    tolerances,
  };
}

function enumerateCoarseLabels() {
  if (!fs.existsSync(MANIFEST)) {
    console.warn(`[seed] SKIP coarse frames — manifest absent (local-only): ${path.relative(REPO_ROOT, MANIFEST)}`);
    return [];
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const byFrame = new Map(); // dedupe by frame_id (last write wins — e.g. the "(1)" copy)
  for (const im of manifest.images ?? []) {
    const label = coarseLabelFromManifestRow(im);
    if (label) byFrame.set(label.frame_id, label);
  }
  return [...byFrame.values()].sort((a, b) => a.frame_id.localeCompare(b.frame_id));
}

// ── assemble: GOLD anchors + COARSE goto frames + bundled_known CR2 ──────────────
const labels = [];

for (const g of GOLD_ANCHORS) {
  labels.push(g);
  console.log(`[seed] GOLD  ${g.frame_id}: RA=${g.ra_hours}h Dec=${g.dec_degrees} scale=${g.pixel_scale_arcsec}"/px`);
}

const coarse = enumerateCoarseLabels();
for (const c of coarse) {
  labels.push(c);
  console.log(`[seed] COARSE ${c.frame_id}: RA=${c.ra_hours}h Dec=${c.dec_degrees} scale=${c.pixel_scale_arcsec ?? 'null'}"/px center_tol=${c.tolerances.center_deg}deg`);
}

// Bundled-known CR2 (durable, sample-file-independent) — GOLD by source default.
for (const key of Object.keys(BUNDLED_KNOWN)) {
  const l = { ...BUNDLED_KNOWN[key], generated_at: BUNDLED_KNOWN[key].generated_at ?? GENERATED_AT };
  labels.push(l);
  console.log(`[seed] GOLD  ${l.frame_id} (bundled_known): RA=${l.ra_hours}h Dec=${l.dec_degrees} scale=${l.pixel_scale_arcsec}"/px`);
}

const doc = {
  schema: 'validation-truth/1',
  _note: 'Ground-truth labels for the validation harness (Enh1, TWO-TIER). TRACKED (underlying sample files + corpus_manifest.json are gitignored/local, so a clone keeps the answers, not the frames). GOLD = independent/corroborated truth; COARSE = uncorroborated capture-header goto (loosened tol, honest lower tier). Regenerate: node tools/validation/truth/seed_labels.mjs',
  labels,
};
const json = JSON.stringify(doc, null, 2) + '\n';

if (process.argv.includes('--print')) {
  process.stdout.write(json);
} else {
  fs.writeFileSync(OUT, json, 'utf8');
  const gold = labels.filter((l) => (l.tier ?? (l.source === 'bundled_known' ? 'GOLD' : 'COARSE')) === 'GOLD').length;
  console.log(`[seed] wrote ${labels.length} labels (${gold} GOLD, ${labels.length - gold} COARSE) -> ${path.relative(REPO_ROOT, OUT)}`);
}
