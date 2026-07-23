// [Module: community] Receipt privacy scrub — pure function, no I/O, no deps.
//
// Ruled defaults (owner GO, RECEIPT_UPLOAD_CHANNEL_SPEC_2026-07-23 + task rulings):
//   - GPS fuzz IS the location model: round gps_lat/gps_lon to a 1-degree grid
//     (Math.round -> integer degrees, ~111 km cell); drop altitude entirely.
//   - Keep the FULL timestamp (time-series photometry needs it; residual
//     sky-derived localization is inherently ~degree-coarse, consistent w/ the grid).
//   - Strip source_provenance (whole block -> null), user_annotations free-text
//     (location_text + any prose field), and any hardware serial/fingerprint identifier.
//   - The contribution CORE passes through UNTOUCHED: matched_stars, photometry
//     (incl. per-star `.provenance` MATCHED/CATALOG_FORCED — a MEASUREMENT field,
//     NOT the source_provenance privacy block; scrub keys on EXACT paths, never
//     substring, precisely so the science survives), psf_field, wcs,
//     pipeline_provenance, schema version.
//
// Contract: scrubReceipt(receipt) -> { scrubbed, report }
//   scrubbed : deep clone, privacy-degraded. Input is never mutated.
//   report   : { schema, removed[], fuzzed[], notes[] } — a LOCAL audit of every
//              field removed or fuzzed. The report is NEVER uploaded; only `scrubbed`.
//
// Idempotent by construction: scrubReceipt(scrubReceipt(x).scrubbed).scrubbed
// deep-equals scrubReceipt(x).scrubbed (integers round to themselves, nulled
// blocks stay null, stripped suffixes have nothing left to strip).

export const SCRUB_REPORT_SCHEMA = 'community-scrub/1';

// Round to integer degrees. JS Math.round is round-half-toward-+Infinity, so
// negatives round predictably: Math.round(-0.5) === -0, Math.round(-84.5) === -84,
// Math.round(-84.068) === -84, Math.round(46.2184) === 46. We normalize -0 -> 0
// so JSON is stable (JSON.stringify(-0) === "0" anyway, but be explicit).
export function roundDeg(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x; // absent/non-finite passes through
  const r = Math.round(x);
  return r === 0 ? 0 : r;
}

// A fingerprint suffix is a trailing "_<6+ hex>" appended to camera/lens model
// strings (e.g. "S30 Pro_7181871e" -> device-unique token). Strip the token,
// keep the human-readable model base for the science (rig class).
const FP_SUFFIX = /_[0-9a-f]{6,}$/i;

// Explicit serial/fingerprint key names to null within metadata/hardware blocks.
const SERIAL_KEY = /^(fingerprint_id|serial|serial_number|serial_no|device_id|body_serial|camera_serial|uuid)$/i;

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

export function scrubReceipt(receipt) {
  if (!isObj(receipt)) {
    throw new TypeError('scrubReceipt: expected a receipt object');
  }
  // Deep clone — never mutate the caller's object.
  const scrubbed = structuredClone(receipt);
  const removed = [];
  const fuzzed = [];
  const notes = [];

  // ── 1. GPS fuzz (metadata.gps_lat / gps_lon -> integer degrees; drop altitude) ──
  const md = scrubbed.metadata;
  if (isObj(md)) {
    for (const key of ['gps_lat', 'gps_lon']) {
      const v = md[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        const to = roundDeg(v);
        if (to !== v) {
          fuzzed.push({ field: `metadata.${key}`, from: v, to, rule: '1-degree grid (Math.round, round-half-toward-+Inf)' });
        } else {
          notes.push(`metadata.${key} already at integer-degree grid (${v})`);
        }
        md[key] = to;
      }
      // null/undefined/non-finite -> honest-or-absent passthrough (nothing to fuzz)
    }
    // altitude dropped entirely, whatever spelling
    for (const altKey of ['gps_alt', 'gps_altitude', 'altitude', 'gps_elevation']) {
      if (altKey in md && md[altKey] != null) {
        removed.push({ field: `metadata.${altKey}`, reason: 'altitude dropped (location fuzz)' });
      }
      if (altKey in md) delete md[altKey];
    }

    // ── 4a. Fingerprint suffix on model strings (keep base, drop device token) ──
    for (const key of ['camera_model', 'lens_model']) {
      const v = md[key];
      if (typeof v === 'string' && FP_SUFFIX.test(v)) {
        const to = v.replace(FP_SUFFIX, '');
        fuzzed.push({ field: `metadata.${key}`, from: v, to, rule: 'stripped trailing fingerprint suffix' });
        md[key] = to;
      }
    }
    // ── 4b. Explicit serial/fingerprint keys inside metadata ──
    for (const k of Object.keys(md)) {
      if (SERIAL_KEY.test(k) && md[k] != null) {
        removed.push({ field: `metadata.${k}`, reason: 'hardware serial/fingerprint identifier' });
        md[k] = null;
      }
    }
    // ── 3b. metadata.source_provenance (whole block -> null) ──
    if ('source_provenance' in md && md.source_provenance != null) {
      removed.push({ field: 'metadata.source_provenance', reason: 'personal storage identifiers (uri/origin/paths)' });
    }
    if ('source_provenance' in md) md.source_provenance = null;
  }

  // ── 3a. top-level source_provenance (whole block -> null) ──
  if ('source_provenance' in scrubbed && scrubbed.source_provenance != null) {
    removed.push({ field: 'source_provenance', reason: 'personal storage identifiers (uri/origin/fetched_at/intake_sha256)' });
  }
  if ('source_provenance' in scrubbed) scrubbed.source_provenance = null;

  // ── 2. user_annotations — ALL fields are free-text prose (location_text,
  //       description, rig_notes, session_issues). Null the whole block. ──
  if ('user_annotations' in scrubbed && scrubbed.user_annotations != null) {
    const ua = scrubbed.user_annotations;
    const fields = isObj(ua) ? Object.keys(ua) : ['<value>'];
    removed.push({ field: 'user_annotations', reason: `free-text (${fields.join(', ')}) — may carry home address / names`, dropped_fields: fields });
    scrubbed.user_annotations = null;
  }

  // ── 4c. Explicit serial/fingerprint keys inside the hardware block ──
  const hw = scrubbed.hardware;
  if (isObj(hw)) {
    for (const k of Object.keys(hw)) {
      if (SERIAL_KEY.test(k) && hw[k] != null) {
        removed.push({ field: `hardware.${k}`, reason: 'hardware serial/fingerprint identifier' });
        hw[k] = null;
      }
    }
  }

  return {
    scrubbed,
    report: {
      schema: SCRUB_REPORT_SCHEMA,
      removed,
      fuzzed,
      notes,
      clean: removed.length === 0 && fuzzed.length === 0,
    },
  };
}

export default scrubReceipt;
