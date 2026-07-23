// ═══════════════════════════════════════════════════════════════════════════
// tools/c2pa/manifest_from_receipt.mjs — receipt → C2PA manifest definition
// ═══════════════════════════════════════════════════════════════════════════
//
// THE INTELLECTUAL CORE of the c2pa lane: map an SkyCruncher receipt onto a C2PA
// manifest definition (the JSON c2patool signs into an asset). Pure + testable —
// no binary, no certs, no I/O in buildManifestDefinition(). The signer
// (sign_render.mjs) adds the DEV-cert signing block and invokes c2patool.
//
//   node tools/c2pa/manifest_from_receipt.mjs <receipt.json> \
//        [--asset-title "…"] [--asset-kind render|science] \
//        [--render-params '<json>'] [--out <manifest.json>]
//
// What we emit:
//   • claim_generator = "SkyCruncher/<receipt.version>"
//   • c2pa.actions    = standard { action: "c2pa.created", softwareAgent } — the
//                       one thing C2PA expresses natively.
//   • org.skycruncher.receipt   — the solve, bound to the exact receipt by sha256.
//   • org.skycruncher.epistemic — the M/V/A typing seed (the vocabulary C2PA lacks).
//
// NAMESPACE NOTE: docs/PROVENANCE_HANDOFF_DESIGN.md drafts these under
// `com.skycruncher.*`; this incubator uses `org.skycruncher.*` per its task spec.
// Field *vocabulary* (MEASURED/VERIFIED_PRESERVING/AESTHETIC, crval-style keys,
// receipt_sha256/seal-hash intent) is aligned to that draft. The prefix must be
// frozen once (design-doc open-question §8.3) before production.
//
// HONEST-OR-ABSENT: a receipt field that is missing, null, or self-flagged
// not_measured is NEVER fabricated into an assertion. A measured-claim family is
// listed under epistemic.measured ONLY when it is genuinely present and measured.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MANIFEST_MAP_SCHEMA_VERSION = '1.0.0';

// IPTC digital-source-type: this asset is computed/visualized from a real capture.
const DIGITAL_SOURCE_TYPE =
  'http://cv.iptc.org/newscodes/digitalsourcetype/computationalCapture';

/** sha256 hex of the exact receipt bytes (Buffer or string). Binds manifest↔receipt. */
export function receiptSha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Set key only when v is neither undefined nor null. Honest-or-absent primitive. */
function setIfPresent(obj, key, v) {
  if (v !== undefined && v !== null) obj[key] = v;
  return obj;
}

// ── Measured-claim families ────────────────────────────────────────────────
// Each entry: is this family genuinely MEASURED in this receipt? A family that is
// present-but-flagged not_measured returns false (it stays out of epistemic.measured).
const MEASURED_FAMILIES = {
  wcs: (r) => !!(r.wcs && r.wcs.CTYPE1),
  sip: (r) => !!r?.solution?.astrometry?.sip,
  tps: (r) => !!r?.solution?.astrometry?.tps,
  lens_distortion_measured: (r) =>
    !!r.lens_distortion_measured && r.lens_distortion_measured.not_measured !== true,
  psf_field: (r) => !!r.psf_field && r.psf_field.not_measured !== true,
  psf_attribution: (r) => !!r.psf_attribution && r.psf_attribution.not_measured !== true,
  // measured-BC densification is ALWAYS-RECORD (observational) once attempted,
  // independent of whether the corrected geometry was applied.
  bc_rematch: (r) => !!r?.solution?.bc_rematch && r.solution.bc_rematch.attempted === true,
  deep_confirmed: (r) => !!r.deep_confirmed,
  spcc: (r) => !!r.spcc,
};

/** Ordered list of families genuinely measured in this receipt. */
export function measuredFamilies(receipt) {
  return Object.keys(MEASURED_FAMILIES).filter((k) => {
    try { return MEASURED_FAMILIES[k](receipt); } catch { return false; }
  });
}

// ── org.skycruncher.receipt ─────────────────────────────────────────────────
function buildReceiptAssertion(receipt, receipt_sha256) {
  const sol = receipt.solution || {};
  const solve = {};
  setIfPresent(solve, 'ra_hours', sol.ra_hours);
  setIfPresent(solve, 'dec_degrees', sol.dec_degrees);
  setIfPresent(solve, 'scale_arcsec_px', sol.pixel_scale);
  setIfPresent(solve, 'matched', sol.stars_matched);
  setIfPresent(solve, 'confidence', sol.confidence);

  const provenance = {};
  // deep_confirmed: the forced-photometry SET-gate conclusion (the meaningful bit).
  setIfPresent(provenance, 'deep_confirmed', receipt?.deep_confirmed?.setGatePassed);
  // bc_rematch presence + whether the corrected geometry was actually applied.
  if (sol.bc_rematch) {
    provenance.bc_rematch_present = true;
    setIfPresent(provenance, 'bc_rematch_applied', sol.bc_rematch.applied);
  }
  provenance.sip_present = !!sol?.astrometry?.sip;
  provenance.tps_present = !!sol?.astrometry?.tps;
  provenance.lens_distortion_measured_present =
    !!receipt.lens_distortion_measured && receipt.lens_distortion_measured.not_measured !== true;

  const data = {
    schema_version: MANIFEST_MAP_SCHEMA_VERSION,
    receipt_sha256,
    solve,
    provenance,
  };
  setIfPresent(data, 'receipt_schema_version', receipt.version);
  return { label: 'org.skycruncher.receipt', data };
}

// ── org.skycruncher.epistemic (the M/V/A typing seed) ───────────────────────
function buildEpistemicAssertion(receipt, { assetKind, renderParams }) {
  // visual = VERIFIED-PRESERVING / render pixel-ops recorded for this asset.
  // Honest-or-absent: [] means none recorded, even for a render (the render here
  // is a pure visualization of measured coordinates — no science-altering op).
  const visual = [];
  if (assetKind === 'render' && renderParams && typeof renderParams === 'object') {
    for (const [name, params] of Object.entries(renderParams)) {
      visual.push({ name, epistemic_type: 'VERIFIED_PRESERVING', params });
    }
  }
  return {
    label: 'org.skycruncher.epistemic',
    data: {
      schema_version: MANIFEST_MAP_SCHEMA_VERSION,
      vocabulary: 'MEASURED | VERIFIED_PRESERVING | AESTHETIC (docs/PROVENANCE_HANDOFF_DESIGN.md §2)',
      asset_kind: assetKind, // 'render' (visualization) | 'science' (the measured FITS/export)
      measured: measuredFamilies(receipt),
      visual,     // V-layer pixel ops with preservation intent; empty ⇒ none recorded
      aesthetic: [], // A-layer ops (ML/aesthetic) — none in the deterministic core
    },
  };
}

/**
 * Pure mapping: receipt object → C2PA manifest definition (no signing block).
 * @param {object} receipt              parsed receipt JSON
 * @param {object} opts
 * @param {string} opts.assetTitle
 * @param {string} opts.receiptSha256   sha256 hex of the on-disk receipt bytes
 * @param {'render'|'science'} [opts.assetKind='render']
 * @param {object|null} [opts.renderParams=null]
 */
export function buildManifestDefinition(receipt, opts = {}) {
  const {
    assetTitle = 'SkyCruncher observation',
    receiptSha256: sha,
    assetKind = 'render',
    renderParams = null,
  } = opts;
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error('buildManifestDefinition: receiptSha256 (64-hex) is required');
  }
  const claimGenerator = `SkyCruncher/${receipt.version || 'unknown'}`;
  return {
    claim_generator: claimGenerator,
    title: assetTitle,
    assertions: [
      {
        label: 'c2pa.actions',
        data: {
          actions: [
            {
              action: 'c2pa.created',
              softwareAgent: claimGenerator,
              digitalSourceType: DIGITAL_SOURCE_TYPE,
            },
          ],
        },
      },
      buildReceiptAssertion(receipt, sha),
      buildEpistemicAssertion(receipt, { assetKind, renderParams }),
    ],
  };
}

// ── CLI shim ────────────────────────────────────────────────────────────────
function isMain() {
  return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '');
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const opts = { assetKind: 'render', renderParams: null, out: null, assetTitle: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--asset-title') opts.assetTitle = argv[++i];
    else if (t === '--asset-kind') opts.assetKind = argv[++i];
    else if (t === '--render-params') opts.renderParams = JSON.parse(argv[++i]);
    else if (t === '--out') opts.out = argv[++i];
    else if (t.startsWith('--')) { process.stderr.write(`[c2pa] unknown flag ${t}\n`); process.exit(1); }
    else rest.push(t);
  }
  const receiptArg = rest[0];
  if (!receiptArg) {
    process.stderr.write('usage: node tools/c2pa/manifest_from_receipt.mjs <receipt.json> [--asset-title …] [--asset-kind render|science] [--render-params <json>] [--out <manifest.json>]\n');
    process.exit(1);
  }
  const receiptPath = path.resolve(receiptArg);
  const bytes = fs.readFileSync(receiptPath);
  const receipt = JSON.parse(bytes.toString('utf8'));
  const sha = receiptSha256(bytes);
  const title = opts.assetTitle || path.basename(receiptPath).replace(/\.receipt\.json$/i, '');
  const def = buildManifestDefinition(receipt, {
    assetTitle: title, receiptSha256: sha, assetKind: opts.assetKind, renderParams: opts.renderParams,
  });
  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.resolve('test_results', 'c2pa', `${title}.manifest.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(def, null, 2));
  process.stderr.write(`[c2pa] receipt_sha256 = ${sha}\n[c2pa] manifest definition → ${outPath}\n`);
  process.stdout.write(JSON.stringify({ manifest: outPath, receipt_sha256: sha, measured: def.assertions[2].data.measured }) + '\n');
}
