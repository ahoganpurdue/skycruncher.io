// tools/priors/priors_core.nodetest.mjs
//
// Unit tests for the search-prior lane. Run explicitly (name is deliberately OUTSIDE
// vitest's default *.{test,spec}.* glob so it never pollutes the vitest gate):
//   node --test tools/priors/priors_core.nodetest.mjs
//
// Each prior is checked for present / absent / lying-input behaviour, plus the two
// named cases from the task (Carina-from-34N visibility mismatch, M31 filename).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  visibilityCut, nameHint, headerWcsRoute, scaleBand, regime, raSeasonWindow, queueScore, computePriors,
} from './priors_core.mjs';
import { parseName, resolveCatalogId } from './bright_objects.mjs';

// --- 1. visibility_cut -----------------------------------------------------
test('visibility_cut: absent latitude => null with basis', () => {
  const r = visibilityCut({ lat_deg: null, lat_source: 'absent' });
  assert.equal(r.value, null);
  assert.match(r.basis, /latitude absent/);
});

test('visibility_cut: present latitude, observable target', () => {
  const r = visibilityCut({ lat_deg: 34, lat_source: 'locale', target_dec_deg: 12.99, target_id: 'M66' });
  assert.equal(r.value.dec_floor_deg, -56);
  assert.equal(r.value.observable, true);
  assert.equal(r.value.provenance_mismatch, false);
});

test('visibility_cut: CARINA case — dec -60 from lat 34N flags provenance mismatch', () => {
  const carina = resolveCatalogId('NGC3372');
  assert.ok(carina.dec < -56, 'Carina must be below the 34N floor');
  const r = visibilityCut({ lat_deg: 34, lat_source: 'locale', target_dec_deg: carina.dec, target_id: 'NGC3372' });
  assert.equal(r.value.observable, false);
  assert.equal(r.value.provenance_mismatch, true);
  assert.match(r.value.note, /below the horizon floor/);
});

test('visibility_cut: circumpolar annotation for high-dec target', () => {
  const r = visibilityCut({ lat_deg: 46, lat_source: 'header', target_dec_deg: 69, target_id: 'M81' });
  assert.equal(r.value.observable, true);
  assert.match(r.value.note, /circumpolar/);
});

// --- 2. name_hint ----------------------------------------------------------
test('name_hint: M31 filename => Andromeda testimony (assumed:true)', () => {
  const r = nameHint({ path: 'rotating/Andromeda Galaxy M31 90s-431_ISO100.fit' });
  assert.equal(r.assumed, true);
  assert.equal(r.value.catalog_id, 'M31');
  assert.ok(Math.abs(r.value.ra_deg - 10.68) < 0.5);
  assert.ok(Math.abs(r.value.dec_deg - 41.27) < 0.5);
  assert.match(r.basis, /TESTIMONY/);
});

test('name_hint: dir-only object (cocoon lights) resolves from path', () => {
  const r = nameHint({ path: 'corpus/cocoon_60da/lights/L_0020_ISO800_240s__18C.CR2' });
  assert.equal(r.value.catalog_id, 'IC5146');
});

test('name_hint: blind DSLR frame => null (no false positive on IMG_/5DMkIII)', () => {
  assert.equal(nameHint({ path: 'challenge/DSLR Images - All Canon T6 Rokinon 14mm/IMG_1238.CR2' }).value, null);
  assert.equal(nameHint({ path: 'rotating/CSM30803_5DMkIII_iso6400_15s.CR2' }).value, null);
  assert.equal(nameHint({ path: 'sample_observation.cr2' }).value, null);
});

test('name_hint: normalised separators (cygnus_loop => Cygnus Loop)', () => {
  assert.equal(nameHint({ path: 'rotating/cygnus_loop_r0c0_6h.fit' }).value.catalog_id, 'NGC6960');
});

// --- 3. header_wcs_route ---------------------------------------------------
test('header_wcs_route: plausible header WCS => narrow_fast', () => {
  const r = headerWcsRoute({ fits_wcs: { present: true, ra_deg: 170.4, dec_deg: 12.8, scale_arcsec_px: 3.74 }, format: 'FITS' });
  assert.equal(r.value, 'narrow_fast');
});

test('header_wcs_route: absent header => blind', () => {
  assert.equal(headerWcsRoute({ format: 'CR2' }).value, 'blind');
  assert.equal(headerWcsRoute({ fits_wcs: { present: false }, format: 'FITS' }).value, 'blind');
});

test('header_wcs_route: implausible values => blind (lying header)', () => {
  const r = headerWcsRoute({ fits_wcs: { present: true, ra_deg: 999, dec_deg: 12.8 }, format: 'FITS' });
  assert.equal(r.value, 'blind');
});

// --- 4. scale_band ---------------------------------------------------------
test('scale_band: FL + pitch => bracket (never a point estimate)', () => {
  const r = scaleBand({ fl_mm: 160, fl_source: 'fits', pixel_pitch_um: 2.9, pitch_source: 'fits' });
  assert.ok(Math.abs(r.value.nominal_arcsec_px - 3.7386) < 0.01);
  assert.ok(r.value.low_arcsec_px < r.value.nominal_arcsec_px);
  assert.ok(r.value.high_arcsec_px > r.value.nominal_arcsec_px);
});

test('scale_band: absent optics => null', () => {
  assert.equal(scaleBand({ fl_mm: null, pixel_pitch_um: 4.29 }).value, null);
  assert.equal(scaleBand({ fl_mm: 14, pixel_pitch_um: null }).value, null);
});

test('scale_band: UNTRUSTED FL (lying-50mm trap) widens the band', () => {
  const trusted = scaleBand({ fl_mm: 50, pixel_pitch_um: 4.29, fl_trusted: true });
  const lying = scaleBand({ fl_mm: 50, pixel_pitch_um: 4.29, fl_trusted: false });
  assert.deepEqual(lying.value.band_multipliers, [0.25, 4.0]);
  assert.ok(lying.value.high_arcsec_px > trusted.value.high_arcsec_px);
  assert.match(lying.basis, /UNTRUSTED/);
});

// --- 5. regime -------------------------------------------------------------
test('regime: long sub => tracked_deep; nightscape; short_bright; planetary; unknown', () => {
  assert.equal(regime({ exposure_s: 240, iso: 800 }).value, 'tracked_deep');
  assert.equal(regime({ exposure_s: 15, iso: 6400, fl_mm: 14 }).value, 'nightscape');
  assert.equal(regime({ exposure_s: 1 }).value, 'short_bright');
  assert.equal(regime({ exposure_s: 0.01 }).value, 'planetary_lunar');
  assert.equal(regime({}).value, 'unknown');
});

test('regime: long-FL scope at short sub still tracked_deep; suggests bands', () => {
  const r = regime({ exposure_s: 20, fl_mm: 600 });
  assert.equal(r.value, 'tracked_deep');
  assert.ok(Array.isArray(r.suggested_bands) && r.suggested_bands.length > 0);
});

// --- 6. ra_season_window ---------------------------------------------------
test('ra_season_window: UNTRUSTED clock => null (phantom-anchor guard)', () => {
  const r = raSeasonWindow({ timestamp_iso: '2026-05-16T03:54:45', timestamp_trusted: false });
  assert.equal(r.value, null);
  assert.match(r.basis, /UNTRUSTED/);
});

test('ra_season_window: trusted time + lon => time-kind LST window', () => {
  const r = raSeasonWindow({ timestamp_iso: '2026-05-16T03:54:45', timestamp_trusted: true, lon_deg: -84.07 });
  assert.equal(r.value.kind, 'time');
  assert.ok(r.value.center_ra_deg >= 0 && r.value.center_ra_deg < 360);
  assert.equal(r.value.half_width_deg, 60);
});

test('ra_season_window: date-only => seasonal band', () => {
  const r = raSeasonWindow({ timestamp_iso: '2026-05-16', timestamp_trusted: true });
  assert.equal(r.value.kind, 'seasonal');
  assert.ok(r.value.center_ra_deg >= 0 && r.value.center_ra_deg < 360);
});

test('ra_season_window: absent timestamp => null', () => {
  assert.equal(raSeasonWindow({}).value, null);
});

// --- 7. queue_score --------------------------------------------------------
test('queue_score: header-WCS outranks name-hint outranks bare frame', () => {
  const withHeader = queueScore({ header_route: 'narrow_fast', has_name_hint: true, format: 'FITS' }).value;
  const nameOnly = queueScore({ header_route: 'blind', has_name_hint: true, format: 'FITS' }).value;
  const bare = queueScore({ header_route: 'blind', has_name_hint: false, format: 'CR2' }).value;
  assert.ok(withHeader > nameOnly, 'header WCS should win');
  assert.ok(nameOnly > bare, 'name hint should beat a bare frame');
});

test('queue_score: unobservable frame is penalised', () => {
  const ok = queueScore({ header_route: 'blind', has_name_hint: true, format: 'FITS', observable: true }).value;
  const bad = queueScore({ header_route: 'blind', has_name_hint: true, format: 'FITS', observable: false }).value;
  assert.ok(bad < ok);
});

// --- aggregate + provenance shape -----------------------------------------
test('computePriors: every emitted prior carries {value, basis}', () => {
  const out = computePriors({ path: 'rotating/Whirlpool Galaxy M51 300s-91.fit', format: 'FITS', exposure_s: 300 }, { lat_deg: 34, lat_source: 'locale' });
  for (const [k, p] of Object.entries(out.priors)) {
    assert.ok('value' in p, `${k} missing value`);
    assert.ok('basis' in p, `${k} missing basis`);
    assert.equal(typeof p.basis, 'string');
  }
  assert.equal(out.priors.name_hint.value.catalog_id, 'M51');
  assert.equal(out.priors.regime.value, 'tracked_deep');
});

test('computePriors: CARINA end-to-end from lat 34 flags visibility mismatch + queue penalty', () => {
  const out = computePriors({ path: 'rotating/carina60Da_180s_iso800_001.fit', format: 'FITS', exposure_s: 180 }, { lat_deg: 34, lat_source: 'locale' });
  assert.equal(out.priors.name_hint.value.catalog_id, 'NGC3372');
  assert.equal(out.priors.visibility_cut.value.provenance_mismatch, true);
  assert.ok(out.priors.queue_score.components.visibility_penalty < 0);
});

// --- parser sanity ---------------------------------------------------------
test('parseName: ambiguity surfaced when two ids present', () => {
  const r = parseName('rotating/Owl and Surfboard M97 M108_60s-329.fit');
  assert.ok(r.ambiguous && r.ambiguous.length >= 2);
});
