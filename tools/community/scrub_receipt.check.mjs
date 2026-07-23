// [Module: community] Unit tests for scrub_receipt.mjs — run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubReceipt, roundDeg } from './scrub_receipt.mjs';

// ── GPS fuzz math, incl. negatives / the -0.5 edge ──
test('roundDeg: 1-degree grid, negatives round half-toward-+Inf', () => {
  assert.equal(roundDeg(46.2184), 46);
  assert.equal(roundDeg(-84.068), -84);
  assert.equal(roundDeg(-84.5), -84);        // half toward +Inf
  assert.equal(roundDeg(-84.51), -85);
  assert.equal(roundDeg(0.4), 0);
  assert.equal(Object.is(roundDeg(-0.5), 0), true); // -0.5 -> -0 normalized to +0
  assert.equal(roundDeg(0.5), 1);            // half toward +Inf
  assert.equal(roundDeg(179.9), 180);
});

test('roundDeg: absent / non-finite passes through', () => {
  assert.equal(roundDeg(null), null);
  assert.equal(roundDeg(undefined), undefined);
  assert.ok(Number.isNaN(roundDeg(NaN)));
});

test('scrub: real GPS fuzzed to integer grid; altitude dropped', () => {
  const r = { metadata: { gps_lat: 46.2183990478516, gps_lon: -84.068000793457, gps_alt: 187.4, timestamp: '2026-05-16T03:54:45.084Z' } };
  const { scrubbed, report } = scrubReceipt(r);
  assert.equal(scrubbed.metadata.gps_lat, 46);
  assert.equal(scrubbed.metadata.gps_lon, -84);
  assert.equal('gps_alt' in scrubbed.metadata, false);
  // full timestamp KEPT (ruling: time-series photometry needs it)
  assert.equal(scrubbed.metadata.timestamp, '2026-05-16T03:54:45.084Z');
  assert.equal(report.fuzzed.length, 2);
  assert.ok(report.removed.some(x => x.field === 'metadata.gps_alt'));
});

test('scrub: null GPS passes through untouched', () => {
  const r = { metadata: { gps_lat: null, gps_lon: null, timestamp: '2026-05-16T03:54:45.084Z' } };
  const { scrubbed, report } = scrubReceipt(r);
  assert.equal(scrubbed.metadata.gps_lat, null);
  assert.equal(scrubbed.metadata.gps_lon, null);
  assert.equal(report.fuzzed.length, 0);
});

test('scrub: source_provenance stripped at both top-level and metadata', () => {
  const r = {
    source_provenance: { uri: 'gdrive://folder/abc123', origin: 'GoogleDrive', fetched_at: 'x', intake_sha256: 'y' },
    metadata: { source_provenance: { uri: 'C:/Users/adam/photos/x.cr2' } },
  };
  const { scrubbed, report } = scrubReceipt(r);
  assert.equal(scrubbed.source_provenance, null);
  assert.equal(scrubbed.metadata.source_provenance, null);
  assert.equal(report.removed.filter(x => x.field.includes('source_provenance')).length, 2);
});

test('scrub: user_annotations (all prose) nulled', () => {
  const r = { user_annotations: { location_text: '123 Home St', description: 'my backyard', rig_notes: 'x', session_issues: 'y' } };
  const { scrubbed, report } = scrubReceipt(r);
  assert.equal(scrubbed.user_annotations, null);
  const rec = report.removed.find(x => x.field === 'user_annotations');
  assert.ok(rec && rec.dropped_fields.includes('location_text'));
});

test('scrub: fingerprint suffix stripped from model, base kept', () => {
  const r = { metadata: { camera_model: 'ZWO Seestar S30 Pro', lens_model: 'S30 Pro_7181871e' } };
  const { scrubbed, report } = scrubReceipt(r);
  assert.equal(scrubbed.metadata.lens_model, 'S30 Pro');
  assert.equal(scrubbed.metadata.camera_model, 'ZWO Seestar S30 Pro'); // no suffix -> untouched
  assert.ok(report.fuzzed.some(x => x.field === 'metadata.lens_model'));
});

test('scrub: explicit serial/fingerprint keys nulled in metadata & hardware', () => {
  const r = { metadata: { fingerprint_id: 'abcd1234', serial_number: 'SN-999' }, hardware: { body_serial: 'XYZ', inferred_lens: '162mm' } };
  const { scrubbed } = scrubReceipt(r);
  assert.equal(scrubbed.metadata.fingerprint_id, null);
  assert.equal(scrubbed.metadata.serial_number, null);
  assert.equal(scrubbed.hardware.body_serial, null);
  assert.equal(scrubbed.hardware.inferred_lens, '162mm'); // science kept
});

// ── THE SCIENCE-SURVIVAL TRAP: per-star `.provenance` is a measurement field ──
test('scrub: per-star photometry .provenance survives (not the privacy block)', () => {
  const r = {
    metadata: { gps_lat: 46.21, gps_lon: -84.06 },
    solution: { photometry: { provenance_counts: { matched: 272 }, stars: [{ provenance: 'MATCHED', flux: 1.2 }, { provenance: 'CATALOG_FORCED', flux: 0.3 }] } },
  };
  const { scrubbed } = scrubReceipt(r);
  assert.equal(scrubbed.solution.photometry.stars[0].provenance, 'MATCHED');
  assert.equal(scrubbed.solution.photometry.stars[1].provenance, 'CATALOG_FORCED');
  assert.equal(scrubbed.solution.photometry.provenance_counts.matched, 272);
  assert.equal(scrubbed.solution.photometry.stars[0].flux, 1.2);
});

test('scrub: does not mutate the input object', () => {
  const r = { metadata: { gps_lat: 46.2184, gps_lon: -84.068 }, source_provenance: { uri: 'x' } };
  const before = JSON.stringify(r);
  scrubReceipt(r);
  assert.equal(JSON.stringify(r), before);
});

// ── IDEMPOTENCY: scrub(scrub(x)) deep-equals scrub(x) ──
test('scrub: idempotent — scrub(scrub(x)) === scrub(x)', () => {
  const r = {
    version: '2.20.0',
    metadata: { gps_lat: 46.2183990478516, gps_lon: -84.068000793457, gps_alt: 187, lens_model: 'S30 Pro_7181871e', fingerprint_id: 'ff00ff00', timestamp: '2026-05-16T03:54:45.084Z' },
    source_provenance: { uri: 'gdrive://x' },
    user_annotations: { location_text: 'home' },
    solution: { photometry: { stars: [{ provenance: 'MATCHED' }] } },
  };
  const once = scrubReceipt(r).scrubbed;
  const twice = scrubReceipt(once).scrubbed;
  assert.deepEqual(twice, once);
});

test('scrub: throws on non-object input', () => {
  assert.throws(() => scrubReceipt(null), TypeError);
  assert.throws(() => scrubReceipt('nope'), TypeError);
});
