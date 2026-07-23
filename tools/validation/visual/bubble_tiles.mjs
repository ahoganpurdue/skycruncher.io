// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION VISUAL · shared "bubble-tile" tagged-PNG renderer
// ═══════════════════════════════════════════════════════════════════════════
// The dense, modern dashboard overlay burned onto a stretched astrophoto — a
// per-frame visual dossier of EVERY test we run on the frame. Shared by the two
// headless render lanes (LAW 4 — no primitives living in two places):
//   • tools/validation/visual/contact_sheet.mjs  (CR2 A/B-arm lane)
//   • tools/overnight/fits_contact_sheet.mjs       (FITS truth+render lane)
//
// TWO-LEDGER LAW: RENDER-LAYER only. Rounded translucent chips, colour-coded by
// status, clustered on a translucent right rail + a top-left header so the sky
// stays visible THROUGH and AROUND them. Every value is burned display text —
// nothing here is fed back into any measurement, WCS, or calibrated gate.
//
// HONEST-OR-ABSENT: a test that did not run gets NO tile. `buildGroups` skips a
// null/absent field and drops any group that ends up empty — never a placeholder
// number, never a fabricated "0".
// ═══════════════════════════════════════════════════════════════════════════

import { PNG } from 'pngjs';

// ── status palette (semantic, not value-polarity) ────────────────────────────
export const PASS = [64, 214, 122];   // pass / confirmed / locked / TRUE_POSITIVE / TRACKED
export const WARN = [240, 190, 72];   // flagged / approximate / present-defect / indeterminate
export const FAIL = [242, 92, 92];    // fail / NO_SOLVE / FALSE_POSITIVE / no-lock
export const ABSENT = [122, 130, 146]; // grey — measured-absent (kept only for headers; absent tiles are dropped)
export const INFO = [86, 200, 232];   // neutral data accent (cyan)
export const TEXT = [232, 236, 244];  // bright value text
export const DIM = [150, 160, 176];   // dim label text
export const SHADOW = [4, 5, 9];      // text/panel shadow

const PANEL_FILL = [11, 13, 20];      // right-rail / header panel base
const TILE_FILL = [20, 23, 34];       // per-chip base
const STROKE = [70, 78, 96];          // hairline chip stroke

export function statusColor(s) {
  if (s === 'pass') return PASS;
  if (s === 'warn') return WARN;
  if (s === 'fail') return FAIL;
  if (s === 'info') return INFO;
  return ABSENT;
}

// ── 5×7 bitmap font (uppercase + digits + symbols, incl. units " and °) ───────
export const FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '%': ['11001', '11010', '00100', '01000', '01011', '10011', '00011'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  ',': ['00000', '00000', '00000', '00000', '01100', '01100', '11000'],
  '*': ['00000', '10101', '01110', '11111', '01110', '10101', '00000'],
  '·': ['00000', '00000', '00000', '01100', '01100', '00000', '00000'],
  '"': ['01010', '01010', '01010', '00000', '00000', '00000', '00000'],
  '°': ['01100', '10010', '10010', '01100', '00000', '00000', '00000'],
  '~': ['00000', '00000', '01001', '10110', '00000', '00000', '00000'],
  '>': ['01000', '00100', '00010', '00001', '00010', '00100', '01000'],
  '<': ['00010', '00100', '01000', '10000', '01000', '00100', '00010'],
  '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
};

// ── RGBA framebuffer (top-left origin; canvas is opaque, draws are source-over) ─
export function makeCanvas(w, h) { return { w, h, px: new Uint8ClampedArray(w * h * 4) }; }

/** Source-over blend of (r,g,b,a∈0..1) onto an opaque canvas. */
export function blend(c, x, y, r, g, b, a = 1) {
  x |= 0; y |= 0;
  if (a <= 0 || x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  if (a > 1) a = 1;
  const i = (y * c.w + x) * 4;
  c.px[i] = c.px[i] * (1 - a) + r * a;
  c.px[i + 1] = c.px[i + 1] * (1 - a) + g * a;
  c.px[i + 2] = c.px[i + 2] * (1 - a) + b * a;
  c.px[i + 3] = 255;
}
// legacy 0..255 alias so the driver detection-ring / bar code stays intact
export function setPx(c, x, y, r, g, b, a = 255) { blend(c, x, y, r, g, b, a / 255); }
export function fillRect(c, x0, y0, w, h, r, g, b, a = 255) {
  const x1 = x0 + w, y1 = y0 + h;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) blend(c, x, y, r, g, b, a / 255);
}

// ── rounded-rect fill + hairline stroke + soft drop shadow ───────────────────
function cornerInside(dx, dy, rad) { return dx * dx + dy * dy <= rad * rad; }

export function fillRoundRect(c, x, y, w, h, rad, col, a = 1) {
  rad = Math.max(0, Math.min(rad, Math.floor(Math.min(w, h) / 2)));
  const x1 = x + w, y1 = y + h;
  for (let py = y; py < y1; py++) {
    for (let px = x; px < x1; px++) {
      // corner masking (quarter circles)
      if (px < x + rad && py < y + rad) { if (!cornerInside(px - (x + rad), py - (y + rad), rad)) continue; }
      else if (px >= x1 - rad && py < y + rad) { if (!cornerInside(px - (x1 - rad - 1), py - (y + rad), rad)) continue; }
      else if (px < x + rad && py >= y1 - rad) { if (!cornerInside(px - (x + rad), py - (y1 - rad - 1), rad)) continue; }
      else if (px >= x1 - rad && py >= y1 - rad) { if (!cornerInside(px - (x1 - rad - 1), py - (y1 - rad - 1), rad)) continue; }
      blend(c, px, py, col[0], col[1], col[2], a);
    }
  }
}

/** 1px inner stroke following the rounded outline (approx — edge band). */
export function strokeRoundRect(c, x, y, w, h, rad, col, a = 1) {
  rad = Math.max(0, Math.min(rad, Math.floor(Math.min(w, h) / 2)));
  const x1 = x + w, y1 = y + h;
  const onEdge = (px, py) => {
    const nearX = px <= x || px >= x1 - 1;
    const nearY = py <= y || py >= y1 - 1;
    if (px < x + rad && py < y + rad) { const d = Math.hypot(px - (x + rad), py - (y + rad)); return d >= rad - 1.2 && d <= rad + 0.2; }
    if (px >= x1 - rad && py < y + rad) { const d = Math.hypot(px - (x1 - rad - 1), py - (y + rad)); return d >= rad - 1.2 && d <= rad + 0.2; }
    if (px < x + rad && py >= y1 - rad) { const d = Math.hypot(px - (x + rad), py - (y1 - rad - 1)); return d >= rad - 1.2 && d <= rad + 0.2; }
    if (px >= x1 - rad && py >= y1 - rad) { const d = Math.hypot(px - (x1 - rad - 1), py - (y1 - rad - 1)); return d >= rad - 1.2 && d <= rad + 0.2; }
    return nearX || nearY;
  };
  for (let py = y; py < y1; py++) for (let px = x; px < x1; px++) if (onEdge(px, py)) blend(c, px, py, col[0], col[1], col[2], a);
}

/** Feathered drop shadow: a few growing translucent rounded rects behind the tile. */
export function dropShadow(c, x, y, w, h, rad, a = 0.34) {
  for (let k = 3; k >= 1; k--) {
    fillRoundRect(c, x - k + 1, y + k, w + 2 * k, h + 2 * k, rad + k, SHADOW, a / (k + 1));
  }
}

// ── text (1-bit glyphs; optional soft shadow for legibility over stars) ───────
export function drawChar(c, ch, x, y, s, col, a = 1) {
  const g = FONT[ch] || FONT['?'];
  for (let ry = 0; ry < 7; ry++) {
    const row = g[ry];
    for (let rx = 0; rx < 5; rx++) if (row[rx] === '1') {
      for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) blend(c, x + rx * s + xx, y + ry * s + yy, col[0], col[1], col[2], a);
    }
  }
}
export function textWidth(str, s) { return str.length * 6 * s; }
export function drawText(c, str, x, y, s, col, a = 1, shadow = true) {
  str = String(str).toUpperCase();
  if (shadow) { let cx = x + Math.max(1, Math.round(s / 2)); const sy = y + Math.max(1, Math.round(s / 2)); for (const ch of str) { drawChar(c, ch, cx, sy, s, SHADOW, 0.6 * a); cx += 6 * s; } }
  let cx = x;
  for (const ch of str) { drawChar(c, ch, cx, y, s, col, a); cx += 6 * s; }
  return cx;
}

// ── detection ring (midpoint circle) — kept for the driver overlays ──────────
export function drawRing(c, cx, cy, rad, col, a = 1) {
  cx = Math.round(cx); cy = Math.round(cy);
  let x = rad, y = 0, err = 1 - rad;
  while (x >= y) {
    for (const [px, py] of [[cx + x, cy + y], [cx + y, cy + x], [cx - y, cy + x], [cx - x, cy + y],
    [cx - x, cy - y], [cx - y, cy - x], [cx + y, cy - x], [cx + x, cy - y]]) blend(c, px, py, col[0], col[1], col[2], a);
    y++;
    if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TILE MODEL — honest-or-absent extraction of every test into display groups
// ═══════════════════════════════════════════════════════════════════════════
// Each `tile` = { label, value, status }. Each `group` = { title, color, tiles }.
// A field that is null/undefined/absent produces NO tile; an empty group is
// dropped. Nothing is invented.

const has = (v) => v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && !Number.isFinite(v));
const num = (v, d = 2) => (has(v) ? Number(v).toFixed(d) : null);

function tile(label, value, status = 'info') { return has(value) ? { label, value: String(value), status } : null; }
function pushTiles(arr, ...ts) { for (const t of ts) if (t) arr.push(t); }

/**
 * Build the ordered, honest-or-absent group list from the receipt-shaped sources.
 * @param {object} input
 *   input.solution        receipt.solution (ra_hours, dec_degrees, pixel_scale,
 *                         stars_matched|matched, confidence, roll_degrees, parity,
 *                         deep_confirmed, locked, locking_tool, best_peak_z)
 *   input.truth           { verdict, comparison:{center_sep_deg,scale_err_frac,rotation_err_deg}, oracle_delta_deg }
 *   input.psf_field       receipt.psf_field (serialized block)
 *   input.psf_attribution receipt.psf_attribution (serialized block)
 *   input.wcs             receipt.wcs + optional astrometry (sip fitted + residual rms)
 *   input.astrometry      solution.astrometry (sip_order, residual rms)
 *   input.detection       { count, culled }
 *   input.metadata        rig/camera, exposure, focal, timestamp trust, gps
 */
export function buildGroups(input = {}) {
  const groups = [];
  const g = (title, color, tiles) => { const t = tiles.filter(Boolean); if (t.length) groups.push({ title, color, tiles: t }); };

  // ── SOLVE ──────────────────────────────────────────────────────────────────
  const sol = input.solution;
  if (sol) {
    const raH = sol.ra_hours ?? sol.ra;
    const decD = sol.dec_degrees ?? sol.dec;
    const scale = sol.pixel_scale ?? sol.pixel_scale_arcsec ?? sol.scale;
    const matched = sol.stars_matched ?? sol.matched;
    const conf = sol.confidence ?? sol.sigma;
    const roll = sol.roll_degrees ?? sol.rotation_deg ?? sol.roll;
    const parity = sol.parity;
    const locked = sol.locked;
    const solveTiles = [];
    if (locked === false) solveTiles.push({ label: 'PLATE SOLVE', value: 'NO-LOCK', status: 'fail' });
    else if (locked === true || has(raH)) solveTiles.push({ label: 'PLATE SOLVE', value: 'LOCKED', status: 'pass' });
    pushTiles(solveTiles,
      has(raH) ? tile('RA', num(raH, 4) + 'H', 'info') : null,
      has(decD) ? tile('DEC', num(decD, 3) + '°', 'info') : null,
      has(scale) ? tile('SCALE', num(scale, 3) + '"/PX', 'info') : null,
      has(matched) ? tile('MATCHED', String(matched), matched > 0 ? 'pass' : 'warn') : null,
      has(conf) ? tile('CONFIDENCE', num(conf, 3), conf >= 0.5 ? 'pass' : 'warn') : null,
      (has(roll) || has(parity)) ? tile('ROLL/PARITY', (has(roll) ? num(roll, 1) + '°' : '?') + (has(parity) ? ' P' + (parity > 0 ? '+1' : '-1') : ''), 'info') : null,
      has(sol.locking_tool) && sol.locking_tool !== 'none' ? tile('SOLVER', sol.locking_tool, 'info') : null,
      has(sol.best_peak_z) ? tile('PEAK Z', num(sol.best_peak_z, 2) + ' SD', 'info') : null,
      sol.deep_confirmed != null ? tile('DEEP CONFIRM', sol.deep_confirmed ? 'CONFIRMED' : 'UNCONFIRMED', sol.deep_confirmed ? 'pass' : 'warn') : null,
    );
    g('SOLVE', INFO, solveTiles);
  }

  // ── TRUTH (oracle adjudication) ─────────────────────────────────────────────
  const truth = input.truth;
  if (truth && has(truth.verdict)) {
    const v = truth.verdict;
    const vs = (v === 'TRUE_POSITIVE' || v === 'SOLVED' || v === 'SOLVED_NO_CROSSCHECK') ? 'pass'
      : (v === 'FALSE_POSITIVE' || v === 'NO_SOLVE') ? 'fail'
        : (v === 'NO_TRUTH') ? 'absent' : 'warn';
    const cmp = truth.comparison || {};
    const dsep = truth.oracle_delta_deg ?? cmp.center_sep_deg;
    g('TRUTH', vs === 'pass' ? PASS : vs === 'fail' ? FAIL : ABSENT, [
      tile('VERDICT', v.replace(/_/g, ' '), vs),
      has(dsep) ? tile('ORACLE SEP', num(dsep, 4) + '°', dsep <= 1 ? 'pass' : 'warn') : null,
      has(cmp.scale_err_frac) ? tile('SCALE ERR', num(cmp.scale_err_frac * 100, 2) + '%', 'info') : null,
      has(cmp.rotation_err_deg) ? tile('ROT ERR', num(cmp.rotation_err_deg, 2) + '°', 'info') : null,
    ]);
  }

  // ── PSF FIELD (per-star LM map) ─────────────────────────────────────────────
  const pf = input.psf_field;
  if (pf && pf.method !== 'NOT_MEASURED' && (has(pf.fwhm_median_maj_px) || has(pf.ellipticity_median))) {
    g('PSF FIELD', INFO, [
      has(pf.fwhm_median_maj_px) ? tile('FWHM MED', num(pf.fwhm_median_maj_px, 2) + 'PX', 'info') : null,
      has(pf.ellipticity_median) ? tile('ELLIPTICITY', num(pf.ellipticity_median, 3), pf.ellipticity_median < 0.2 ? 'pass' : 'warn') : null,
      has(pf.orientation_median_deg) ? tile('PA', num(pf.orientation_median_deg, 1) + '°', 'info') : null,
      has(pf.method) ? tile('METHOD', pf.method.replace(/_/g, ' '), 'info') : null,
      has(pf.n_fit) ? tile('STARS FIT', String(pf.n_fit), 'info') : null,
    ]);
  }

  // ── PSF ATTRIBUTION (drift / tracking / diffraction / seeing / coma) ─────────
  const pa = input.psf_attribution;
  if (pa) {
    const drift = pa.drift || {};
    const trk = pa.tracking || {};
    const diff = pa.diffraction || {};
    const see = pa.seeing || {};
    const coma = pa.coma || {};
    const driftPresent = drift.presence === 'CONFIRMED_PRESENT';
    const trackTiles = [];
    if (has(trk.inference) && trk.inference !== 'NOT_MEASURED') {
      const ti = trk.inference;
      trackTiles.push(tile('TRACKING', ti, ti === 'TRACKED' ? 'pass' : ti === 'UNTRACKED' ? 'warn' : 'info'));
    }
    if (has(drift.calculatedPx)) {
      const dstat = driftPresent ? 'warn' : (drift.presence === 'NOT_CONFIRMED' ? 'pass' : 'info');
      const dsuffix = driftPresent ? ' CONFIRMED' : drift.presence === 'NOT_CONFIRMED' ? ' NOT-CONF' : '';
      trackTiles.push(tile('SIDEREAL DRIFT', num(drift.calculatedPx, 1) + 'PX' + dsuffix, dstat));
    }
    const floorG = diff.floorArcsec && has(diff.floorArcsec.g) ? diff.floorArcsec.g : null;
    if (has(floorG)) trackTiles.push(tile('DIFFRACTION', num(floorG, 2) + '" FLOOR', 'info'));
    if (has(see.arcsec)) trackTiles.push(tile('SEEING', num(see.arcsec, 2) + '" APPROX', 'warn'));
    if (coma.tier === 'FITTED' && coma.fit && coma.fit.patternConsistent != null) {
      trackTiles.push(tile('COMA', coma.fit.patternConsistent ? 'PATTERN OK' : 'INCONSISTENT', coma.fit.patternConsistent ? 'pass' : 'warn'));
    } else if (coma.tier === 'FITTED') {
      trackTiles.push(tile('COMA', 'FITTED', 'info'));
    }
    g('PSF ATTRIBUTION', INFO, trackTiles);
  }

  // ── DISTORTION (SIP + residual) ─────────────────────────────────────────────
  const astro = input.astrometry;
  if (astro) {
    const sipFitted = astro.sip_fitted ?? astro.sipFitted ?? (has(astro.sip_order) && astro.sip_order > 0);
    const rms = astro.residual_rms_arcsec ?? astro.residualRmsArcsec ?? astro.rms_arcsec;
    g('DISTORTION', INFO, [
      sipFitted != null ? tile('SIP FIT', sipFitted ? 'FITTED' + (has(astro.sip_order) ? ' O' + astro.sip_order : '') : 'LINEAR', sipFitted ? 'pass' : 'absent') : null,
      has(rms) ? tile('RESIDUAL RMS', num(rms, 3) + '"', rms < 1 ? 'pass' : 'warn') : null,
    ]);
  }

  // ── ATMOSPHERIC ─────────────────────────────────────────────────────────────
  const atmSee = pa && pa.seeing ? pa.seeing : null;
  if (atmSee && (has(atmSee.airmass) || has(atmSee.arcsec))) {
    const diff = pa.diffraction || {};
    g('ATMOSPHERIC', WARN, [
      has(atmSee.airmass) ? tile('AIRMASS', num(atmSee.airmass, 3), 'info') : null,
      has(diff.rayleighArcsecG) ? tile('RAYLEIGH', num(diff.rayleighArcsecG, 2) + '" APPROX', 'warn') : null,
    ]);
  }

  // ── DETECTION ───────────────────────────────────────────────────────────────
  const det = input.detection;
  if (det && has(det.count)) {
    g('DETECTION', INFO, [
      tile('STARS', String(det.count), det.count > 0 ? 'pass' : 'warn'),
      has(det.culled) ? tile('CULLED', String(det.culled), 'info') : null,
    ]);
  }

  // ── METADATA (rig / exposure / optics / clock / GPS) ─────────────────────────
  const md = input.metadata;
  if (md) {
    const clockUntrusted = md.timestamp_trusted === false || md.timestamp_source === 'DEFAULT';
    const clockTrusted = md.timestamp_trusted === true || (has(md.timestamp_source) && md.timestamp_source !== 'DEFAULT');
    const gpsAbsent = md.gps_source === 'DEFAULT' || md.gps === null;
    const gpsPresent = md.gps_source && md.gps_source !== 'DEFAULT';
    g('METADATA', ABSENT, [
      has(md.rig) ? tile('RIG', md.rig, 'info') : (has(md.camera) ? tile('RIG', md.camera, 'info') : null),
      has(md.exposure_time) ? tile('EXPOSURE', num(md.exposure_time, md.exposure_time < 10 ? 1 : 0) + 'S', 'info') : null,
      has(md.focal_length) ? tile('FOCAL', num(md.focal_length, 0) + 'MM', 'info') : null,
      (clockTrusted || clockUntrusted) ? tile('CLOCK', clockTrusted ? 'TRUSTED' : 'UNTRUSTED', clockTrusted ? 'pass' : 'warn') : null,
      (gpsPresent || gpsAbsent) ? tile('GPS', gpsPresent ? 'PRESENT' : 'ABSENT', gpsPresent ? 'pass' : 'absent') : null,
    ]);
  }

  return groups;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT + COMPOSITE — a translucent right rail of grouped chips + a header pill
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Percentile-asinh stretch of a luminance plane → 8-bit grayscale. RENDER-LAYER
 * display transform (labeled, reversible) — the ONE stretch shared by both lanes.
 */
export function stretch(lum, { asinh = 14, lo = 0.30, hi = 0.9985 } = {}) {
  const s = Float32Array.from(lum).sort();
  const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
  const L = at(lo), H = at(hi);
  const span = H - L > 1e-9 ? H - L : 1;
  const denom = Math.asinh(asinh);
  const out = new Uint8ClampedArray(lum.length);
  for (let i = 0; i < lum.length; i++) {
    let t = (lum[i] - L) / span; if (t < 0) t = 0; else if (t > 1) t = 1;
    out[i] = 255 * (Math.asinh(t * asinh) / denom);
  }
  return out;
}

/** Grayscale plane (Uint8) → opaque RGBA canvas. */
export function grayToCanvas(gray, w, h) {
  const c = makeCanvas(w, h);
  for (let i = 0; i < gray.length; i++) { const v = gray[i]; c.px[i * 4] = v; c.px[i * 4 + 1] = v; c.px[i * 4 + 2] = v; c.px[i * 4 + 3] = 255; }
  return c;
}

/** Draw the top-left header pill: frame · type · rig + a big status chip. */
function drawHeader(c, header, scale) {
  const s = scale;
  const pad = 7 * s;
  const line1 = `${header.frame || ''}`;
  const sub = [header.imageType, header.rig].filter(Boolean).join(' · ');
  const statusText = header.statusText || '';
  const w1 = textWidth(line1, s);
  const w2 = textWidth(sub, Math.max(1, s - 1));
  const wS = statusText ? textWidth(statusText, s) + 8 * s : 0;
  const innerW = Math.max(w1, w2, wS);
  const boxW = innerW + pad * 2;
  const lh = 8 * s;
  const boxH = pad * 2 + lh + (sub ? 6 * (s - 1 > 0 ? s - 1 : 1) + 4 : 0) + (statusText ? lh + 4 : 0);
  const x = Math.round(6 * s), y = Math.round(6 * s), rad = 5 * s;
  dropShadow(c, x, y, boxW, boxH, rad);
  fillRoundRect(c, x, y, boxW, boxH, rad, PANEL_FILL, 0.62);
  strokeRoundRect(c, x, y, boxW, boxH, rad, STROKE, 0.5);
  let cy = y + pad;
  drawText(c, line1, x + pad, cy, s, TEXT);
  cy += lh + 3;
  if (sub) { drawText(c, sub, x + pad, cy, Math.max(1, s - 1), INFO); cy += 6 * Math.max(1, s - 1) + 5; }
  if (statusText) {
    const col = header.statusColor || PASS;
    const chW = textWidth(statusText, s) + 6 * s;
    fillRoundRect(c, x + pad, cy, chW, lh + 2, (lh + 2) / 2, col, 0.9);
    drawText(c, statusText, x + pad + 3 * s, cy + 1, s, [12, 14, 20], 1, false);
  }
  return { x, y, boxW, boxH };
}

/** One chip: status accent bar + dim label + bright value, on a translucent rounded fill. */
function drawChip(c, x, y, w, h, t, s) {
  const rad = Math.max(4, Math.round(h * 0.22));
  fillRoundRect(c, x, y, w, h, rad, TILE_FILL, 0.7);
  strokeRoundRect(c, x, y, w, h, rad, STROKE, 0.4);
  const col = statusColor(t.status);
  // left accent bar
  fillRoundRect(c, x + 2, y + 3, Math.max(3, s), h - 6, 2, col, 0.95);
  const tx = x + 4 + Math.max(3, s) + 3 * s;
  const ls = Math.max(1, s - 1);
  drawText(c, t.label, tx, y + 4, ls, DIM, 1, false);
  // value — colour the value by status so pass/warn/fail read at a glance
  const vcol = t.status === 'absent' ? DIM : t.status === 'info' ? TEXT : col;
  let val = t.value;
  const maxChars = Math.floor((w - (tx - x) - 4) / (6 * s));
  if (val.length > maxChars && maxChars > 1) val = val.slice(0, maxChars - 1) + '.';
  drawText(c, val, tx, y + 4 + 6 * ls + 3, s, vcol, 1, false);
  return h;
}

/**
 * Composite the full dossier: image + right rail of grouped chips + header.
 * `header` = { frame, imageType, rig, statusText, statusColor }.
 * `groups` = buildGroups(...) output. Returns the RGBA canvas.
 */
export function composite(c, { header = {}, groups = [] }) {
  const W = c.w, H = c.h;
  // scale unit from the image size (crisp, dashboard-like at any resolution)
  const s = W >= 2000 ? 3 : W >= 1100 ? 2 : 2;
  const chipS = s;                     // value font scale in chips
  // right rail geometry — translucent, clamped so the sky stays visible left/around
  const railW = Math.round(Math.min(Math.max(W * 0.30, 300), 560));
  const railX = W - railW;
  const gutter = 8 * s;
  const innerX = railX + gutter;
  const innerW = railW - gutter * 2;
  const colGap = 6 * s;
  const colW = Math.floor((innerW - colGap) / 2);
  const chipH = 7 * chipS + 12;        // label + value + padding
  const chipVGap = 5 * s;
  const groupTitleH = 6 * s + 6;
  const groupGap = 8 * s;

  // rail backdrop (very translucent — stars read through it)
  dropShadow(c, railX, 0, railW, H, 0);
  fillRect(c, railX, 0, railW, H, PANEL_FILL[0], PANEL_FILL[1], PANEL_FILL[2], 128);
  // a hairline accent down the rail's leading edge
  fillRect(c, railX, 0, Math.max(2, s), H, INFO[0], INFO[1], INFO[2], 90);

  let y = 8 * s;
  for (const grp of groups) {
    // group title + divider
    if (y + groupTitleH + chipH > H) break;   // never overflow the frame
    drawText(c, grp.title, innerX, y, s, grp.color || INFO, 1, false);
    const tw = textWidth(grp.title, s);
    fillRect(c, innerX + tw + 6, y + 3 * s, Math.max(0, innerW - tw - 6), Math.max(1, s - 1), (grp.color || INFO)[0], (grp.color || INFO)[1], (grp.color || INFO)[2], 70);
    y += groupTitleH;
    // chips flow in a 2-column grid
    let col = 0;
    for (const t of grp.tiles) {
      if (y + chipH > H) break;
      const cx = innerX + col * (colW + colGap);
      drawChip(c, cx, y, colW, chipH, t, chipS);
      col++;
      if (col >= 2) { col = 0; y += chipH + chipVGap; }
    }
    if (col === 1) y += chipH + chipVGap;    // close a half-filled row
    y += groupGap;
  }

  // header last so it sits on top-left, clear of the rail
  drawHeader(c, header, s);
  return c;
}

// ── PNG encode (deflate 9 to hold the ≤5MB budget with headroom) ─────────────
export function encodePng(c) {
  const png = new PNG({ width: c.w, height: c.h, deflateLevel: 9, filterType: -1 });
  png.data = Buffer.from(c.px.buffer, c.px.byteOffset, c.px.byteLength);
  return PNG.sync.write(png);
}
