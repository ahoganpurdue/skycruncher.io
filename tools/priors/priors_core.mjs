// tools/priors/priors_core.mjs
//
// Deterministic search-prior computers (TASK #20 incubator). PURE functions — no
// file IO, no decodes, no solves. Each prior returns { value, basis } with honest
// nulls when its input is absent. The solver wiring is a later, separately-gated
// change; this lane only *computes* the priors so they can be unit-tested and
// validated offline.
//
// Two-ledger note: everything here is COORDINATE-side reasoning about where to
// point the search (dec floors, RA windows, catalog bands). It never touches pixels.
//
// Provenance convention: every emitted prior is `{ value, basis }` (plus prior-
// specific extras). `basis` is a human-readable string that always states WHERE the
// input came from. Absent input => the whole prior is `null` (honest-or-absent).

import { parseName } from './bright_objects.mjs';

const ARCSEC_PER_RAD = 206264.806247;

// ---------------------------------------------------------------------------
// 1. visibility_cut  — hard dec floor from observer latitude, plus circumpolar
//    / seasonal annotation, and a provenance-mismatch flag when a named target
//    can never rise from the assumed latitude (the Carina-from-34N case).
// ---------------------------------------------------------------------------
export function visibilityCut({ lat_deg, lat_source, target_dec_deg, target_id } = {}) {
  if (lat_deg == null || !Number.isFinite(lat_deg)) {
    return { value: null, basis: `latitude absent (${lat_source || 'none'}) — no visibility floor` };
  }
  // An object culminates at altitude 90 - |lat - dec|. It rises at all iff its
  // max altitude > 0, i.e. dec > lat - 90 (northern) or dec < lat + 90 (southern).
  const decFloor = lat_deg - 90;   // dec below this never rises (N hemisphere sense)
  const decCeil = lat_deg + 90;    // dec above this never rises (S hemisphere sense)
  // Circumpolar (never sets): |dec| > 90 - |lat|, same sign as latitude.
  const circumpolarMag = 90 - Math.abs(lat_deg);
  const circumpolarDec = lat_deg >= 0 ? circumpolarMag : -circumpolarMag;

  const value = {
    dec_floor_deg: round4(decFloor),
    dec_ceil_deg: round4(decCeil),
    circumpolar_dec_deg: round4(circumpolarDec),
    circumpolar_sense: lat_deg >= 0 ? `dec > ${round4(circumpolarDec)} never sets` : `dec < ${round4(circumpolarDec)} never sets`,
    target_dec_deg: target_dec_deg == null ? null : round4(target_dec_deg),
    observable: null,
    max_altitude_deg: null,
    note: null,
    provenance_mismatch: false,
  };
  let basis = `latitude ${round4(lat_deg)}° (${lat_source || 'unknown source'}); floor dec=${round4(decFloor)}°`;

  if (target_dec_deg != null && Number.isFinite(target_dec_deg)) {
    const maxAlt = 90 - Math.abs(lat_deg - target_dec_deg);
    value.max_altitude_deg = round4(maxAlt);
    value.observable = maxAlt > 0;
    const isCircumpolar = lat_deg >= 0 ? target_dec_deg > circumpolarDec : target_dec_deg < circumpolarDec;
    if (!value.observable) {
      value.provenance_mismatch = true;
      value.note = `target ${target_id || ''} dec=${round4(target_dec_deg)}° is below the horizon floor (${round4(decFloor)}°) for the assumed latitude — the frame was almost certainly shot from a different site than the ${lat_source || 'assumed'} latitude source (name is testimony only)`.trim();
    } else if (isCircumpolar) {
      value.note = `target circumpolar — available all night, RA window unconstrained`;
    } else {
      value.note = `target rises; peak altitude ${round4(maxAlt)}°`;
    }
  }
  return { value, basis };
}

// ---------------------------------------------------------------------------
// 2. name_hint  — catalog-name parse from filename/dir. TESTIMONY (assumed:true).
// ---------------------------------------------------------------------------
export function nameHint({ path, filename } = {}) {
  const hit = parseName(path || filename || '');
  if (!hit) return { value: null, assumed: true, basis: 'no catalog token in filename/path' };
  return {
    value: {
      catalog_id: hit.catalog_id,
      name: hit.name,
      ra_deg: hit.ra_deg,
      dec_deg: hit.dec_deg,
      ambiguous: hit.ambiguous,
    },
    assumed: true,
    basis: `filename token ${hit.matched}${hit.ambiguous ? ` (ambiguous: ${hit.ambiguous.join(',')})` : ''} — TESTIMONY, not a measurement`,
  };
}

// ---------------------------------------------------------------------------
// 3. header_wcs_route  — FITS header RA/Dec/scale present & plausible => fast path.
// ---------------------------------------------------------------------------
export function headerWcsRoute({ fits_wcs, format } = {}) {
  if (!fits_wcs || fits_wcs.present !== true) {
    return { value: 'blind', basis: `no header WCS (${format || 'unknown format'}) — blind solve` };
  }
  const { ra_deg, dec_deg, scale_arcsec_px } = fits_wcs;
  const raOk = Number.isFinite(ra_deg) && ra_deg >= 0 && ra_deg <= 360;
  const decOk = Number.isFinite(dec_deg) && dec_deg >= -90 && dec_deg <= 90;
  const scaleOk = scale_arcsec_px == null || (Number.isFinite(scale_arcsec_px) && scale_arcsec_px > 0 && scale_arcsec_px < 3600);
  if (raOk && decOk && scaleOk) {
    return {
      value: 'narrow_fast',
      basis: `header RA=${round4(ra_deg)}° Dec=${round4(dec_deg)}°${scale_arcsec_px != null ? ` scale=${round4(scale_arcsec_px)}"/px` : ''} present & plausible`,
    };
  }
  return { value: 'blind', basis: `header WCS present but implausible (ra=${ra_deg}, dec=${dec_deg}, scale=${scale_arcsec_px}) — falling back to blind` };
}

// ---------------------------------------------------------------------------
// 4. scale_band  — EXIF/header FL + pixel pitch => arcsec/px BRACKET (never a
//    point estimate; guards the lying-50mm-EXIF trap by reporting a [0.5x,2x] band).
// ---------------------------------------------------------------------------
export function scaleBand({ fl_mm, fl_source, pixel_pitch_um, pitch_source, fl_trusted } = {}) {
  if (fl_mm == null || !Number.isFinite(fl_mm) || fl_mm <= 0 ||
      pixel_pitch_um == null || !Number.isFinite(pixel_pitch_um) || pixel_pitch_um <= 0) {
    return { value: null, basis: `insufficient optics (fl=${fl_mm ?? 'absent'}mm, pitch=${pixel_pitch_um ?? 'absent'}µm)` };
  }
  const nominal = ARCSEC_PER_RAD * (pixel_pitch_um / 1000) / fl_mm; // pitch µm->mm
  // Wider band when the focal length is untrusted (the 50-vs-14mm lying-EXIF trap).
  const [loMul, hiMul] = fl_trusted === false ? [0.25, 4.0] : [0.5, 2.0];
  return {
    value: {
      nominal_arcsec_px: round4(nominal),
      low_arcsec_px: round4(nominal * loMul),
      high_arcsec_px: round4(nominal * hiMul),
      band_multipliers: [loMul, hiMul],
    },
    basis: `206265·(pitch ${pixel_pitch_um}µm [${pitch_source || '?'}])/(fl ${fl_mm}mm [${fl_source || '?'}])` +
      (fl_trusted === false ? ' — FL UNTRUSTED, band widened' : ''),
  };
}

// ---------------------------------------------------------------------------
// 5. regime  — exposure x ISO => acquisition regime + suggested catalog mag band
//    order (which of the 4-band index to load first). Heuristic hint only.
// ---------------------------------------------------------------------------
const BAND_ORDER = {
  tracked_deep:    ['b1', 'b2', 'b0_bright', 'b3_faint'],
  nightscape:      ['b0_bright', 'b1'],
  short_bright:    ['b0_bright'],
  planetary_lunar: ['b0_bright'],
  unknown:         ['b0_bright', 'b1'],
};
export function regime({ exposure_s, iso, fl_mm } = {}) {
  const hasExp = exposure_s != null && Number.isFinite(exposure_s);
  const hasIso = iso != null && Number.isFinite(iso);
  if (!hasExp && !hasIso) {
    return { value: 'unknown', suggested_bands: BAND_ORDER.unknown, basis: 'no exposure/ISO — regime unknown' };
  }
  let cls;
  if (hasExp && exposure_s <= 0.05) cls = 'planetary_lunar';
  else if (hasExp && exposure_s <= 2) cls = 'short_bright';
  else if (hasExp && exposure_s <= 30) {
    // wide, short-ish sub => nightscape; but a long-FL telescope at <=30s is still deep
    cls = (fl_mm != null && fl_mm >= 200) ? 'tracked_deep' : 'nightscape';
  } else if (hasExp && exposure_s > 30) cls = 'tracked_deep';
  else cls = 'unknown'; // ISO known but no exposure
  return {
    value: cls,
    suggested_bands: BAND_ORDER[cls],
    basis: `${hasExp ? `exposure ${exposure_s}s` : 'exposure absent'}${hasIso ? `, ISO ${iso}` : ''}${fl_mm != null ? `, FL ${fl_mm}mm` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// 6. ra_season_window  — trusted timestamp (+ longitude) => RA window well-placed
//    that night. Date-only => seasonal RA band. UNTRUSTED clock => null.
// ---------------------------------------------------------------------------
export function raSeasonWindow({ timestamp_iso, timestamp_trusted, lon_deg } = {}) {
  if (!timestamp_iso) return { value: null, basis: 'no timestamp' };
  if (timestamp_trusted === false) {
    return { value: null, basis: 'UNTRUSTED clock (timestampTrusted=false) — no RA window (bogus clock => phantom anchors)' };
  }
  const d = new Date(timestamp_iso);
  if (isNaN(d.getTime())) return { value: null, basis: `unparseable timestamp "${timestamp_iso}"` };

  const raSunDeg = solarRaDeg(d);
  const hasTime = /\d{2}:\d{2}/.test(timestamp_iso) && !/T00:00:00(\.0+)?Z?$/.test(timestamp_iso);

  if (lon_deg != null && Number.isFinite(lon_deg) && hasTime) {
    // What is transiting AT capture: LST = GMST + longitude.
    const lst = norm360(gmstDeg(d) + lon_deg);
    return {
      value: { kind: 'time', center_ra_deg: round4(lst), ra_low_deg: round4(norm360(lst - 60)), ra_high_deg: round4(norm360(lst + 60)), half_width_deg: 60 },
      basis: `LST ${round4(lst)}° at ${timestamp_iso} (lon ${round4(lon_deg)}°); RA on/near meridian ±4h`,
    };
  }
  // Seasonal: RA on the meridian at local midnight ≈ RA_sun + 180°.
  const meridianMidnight = norm360(raSunDeg + 180);
  return {
    value: { kind: 'seasonal', center_ra_deg: round4(meridianMidnight), ra_low_deg: round4(norm360(meridianMidnight - 75)), ra_high_deg: round4(norm360(meridianMidnight + 75)), half_width_deg: 75 },
    basis: `date ${timestamp_iso.slice(0, 10)}: RA_sun≈${round4(raSunDeg)}°, midnight-meridian RA≈${round4(meridianMidnight)}° ±5h (no exact time/lon)`,
  };
}

// ---------------------------------------------------------------------------
// 7. queue_score  — cross-frame triage: header-WCS > name-hint > star-count > else.
//    Higher => solve first. Impossible-visibility frames are deprioritised.
// ---------------------------------------------------------------------------
export function queueScore({ header_route, has_name_hint, star_count, format, observable } = {}) {
  const comps = {};
  let s = 0;
  if (header_route === 'narrow_fast') { comps.header_wcs = 0.50; s += 0.50; }
  if (has_name_hint) { comps.name_hint = 0.30; s += 0.30; }
  if (star_count != null && Number.isFinite(star_count) && star_count > 0) {
    const c = Math.min(star_count / 500, 1) * 0.15; comps.star_count = round4(c); s += c;
  }
  if (format === 'FITS') { comps.format_fits = 0.05; s += 0.05; } // FITS more likely to carry WCS
  if (observable === false) { comps.visibility_penalty = -0.40; s -= 0.40; } // can't rise from assumed site
  s = Math.max(0, Math.min(1, s));
  return { value: round4(s), components: comps, basis: `header=${header_route || 'blind'}, name_hint=${!!has_name_hint}, stars=${star_count ?? 'n/a'}, fmt=${format || '?'}${observable === false ? ', UNOBSERVABLE' : ''}` };
}

// ---------------------------------------------------------------------------
// Aggregate: compute all priors for one frame descriptor + optional context.
// ---------------------------------------------------------------------------
export function computePriors(descriptor = {}, context = {}) {
  const path = descriptor.path || descriptor.abs || descriptor.rel || descriptor.filename || '';
  const format = descriptor.format || null;

  const nh = nameHint({ path, filename: descriptor.filename });
  const targetDec = nh.value ? nh.value.dec_deg : (descriptor.fits_wcs && descriptor.fits_wcs.present ? descriptor.fits_wcs.dec_deg : null);
  const targetId = nh.value ? nh.value.catalog_id : null;

  // latitude resolution ladder: explicit descriptor GPS > header site > context (--lat / history / locale)
  let lat = null, latSource = null, lon = null;
  if (descriptor.gps && Number.isFinite(descriptor.gps.lat)) { lat = descriptor.gps.lat; lon = descriptor.gps.lon ?? null; latSource = 'gps'; }
  else if (Number.isFinite(descriptor.site_lat)) { lat = descriptor.site_lat; lon = descriptor.site_lon ?? null; latSource = 'header'; }
  else if (context.lat_deg != null && Number.isFinite(context.lat_deg)) { lat = context.lat_deg; lon = context.lon_deg ?? null; latSource = context.lat_source || 'context'; }
  if (lon == null && Number.isFinite(descriptor.site_lon)) lon = descriptor.site_lon;

  const vis = visibilityCut({ lat_deg: lat, lat_source: latSource, target_dec_deg: targetDec, target_id: targetId });
  const route = headerWcsRoute({ fits_wcs: descriptor.fits_wcs, format });
  const sb = scaleBand({ fl_mm: descriptor.fl_mm, fl_source: descriptor.fl_source, pixel_pitch_um: descriptor.pixel_pitch_um, pitch_source: descriptor.pitch_source, fl_trusted: descriptor.fl_trusted });
  const rg = regime({ exposure_s: descriptor.exposure_s, iso: descriptor.iso, fl_mm: descriptor.fl_mm });
  const rw = raSeasonWindow({ timestamp_iso: descriptor.timestamp_iso, timestamp_trusted: descriptor.timestamp_trusted, lon_deg: lon });
  const qs = queueScore({ header_route: route.value, has_name_hint: !!nh.value, star_count: descriptor.star_count, format, observable: vis.value ? vis.value.observable : null });

  return {
    frame: { path, filename: descriptor.filename || basename(path), format },
    priors: {
      visibility_cut: vis,
      name_hint: nh,
      header_wcs_route: route,
      scale_band: sb,
      regime: rg,
      ra_season_window: rw,
      queue_score: qs,
    },
  };
}

// --- helpers ---------------------------------------------------------------
function round4(x) { return x == null || !Number.isFinite(x) ? x : Math.round(x * 1e4) / 1e4; }
function norm360(x) { let v = x % 360; if (v < 0) v += 360; return v; }
function basename(p) { return String(p).split(/[\\/]/).pop() || ''; }

/** Days since J2000.0 (2000-01-01 12:00 TT), good enough for a coarse RA prior. */
function daysSinceJ2000(date) { return (date.getTime() - Date.UTC(2000, 0, 1, 12, 0, 0)) / 86400000; }

/** Apparent solar RA in degrees (low-precision almanac formula, ~<0.1° for priors). */
export function solarRaDeg(date) {
  const n = daysSinceJ2000(date);
  const L = norm360(280.460 + 0.9856474 * n);              // mean longitude
  const g = deg2rad(norm360(357.528 + 0.9856003 * n));     // mean anomaly
  const lambda = deg2rad(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)); // ecliptic long
  const eps = deg2rad(23.439);                             // obliquity
  let ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  return norm360(rad2deg(ra));
}

/** Greenwich Mean Sidereal Time in degrees. */
export function gmstDeg(date) {
  const n = daysSinceJ2000(date);
  return norm360(280.46061837 + 360.98564736629 * n);
}

function deg2rad(d) { return (d * Math.PI) / 180; }
function rad2deg(r) { return (r * 180) / Math.PI; }
