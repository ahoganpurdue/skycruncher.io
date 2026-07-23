// ═══════════════════════════════════════════════════════════════════════════
// SYNTH LANE — POINTING & ATMOSPHERE HELPERS  (location + time + pointing → sky)
// ═══════════════════════════════════════════════════════════════════════════
// Standard spherical astronomy (Meeus, "Astronomical Algorithms"): JD → GMST →
// LST, horizontal↔equatorial, Kasten-Young airmass. These let a caller specify
// pointing as "look SW at 45° elevation from <lat,lon> at <utc>" and get the
// RA/Dec the frame centers on.
//
// ENGINE-PARITY SLOT (v1): the LIVE engine has the same transforms in
// TimeService (src/engine/core/TimeService, consumed by zenith.ts
// computeAltAz / computeRaDecFromAltAz). They are NOT imported here because no
// tsx/bundler is available to pull TS into a standalone .mjs (the same constraint
// cascade_math.ts documents for its capture_cascade.mjs mirror). The formulas
// below are standard Meeus and are the AUTHORITY for THIS tool's ground truth:
// the truth sidecar records the RA/Dec actually injected, so the closed loop is
// valid on internal consistency regardless of sub-arcsecond Meeus-vs-TimeService
// drift. A parity cross-check against TimeService is the named v1 hardening step
// (matters for sextant P1/P2, where a truth-known location frame must validate
// the ENGINE's alt-az — see README).

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Julian Date from a JS Date (UTC). */
export function toJulianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Greenwich Mean Sidereal Time in degrees (Meeus 12.4, IAU 1982). */
export function computeGMSTDeg(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  let gmst = 280.46061837
    + 360.98564736629 * (jd - 2451545.0)
    + 0.000387933 * T * T
    - (T * T * T) / 38710000.0;
  return ((gmst % 360) + 360) % 360;
}

/** Local Sidereal Time (deg) = GMST + east longitude. */
export function computeLSTDeg(gmstDeg, lonDeg) {
  return (((gmstDeg + lonDeg) % 360) + 360) % 360;
}

/**
 * Horizontal → Equatorial. Azimuth measured FROM NORTH, eastward
 * (0 = N, 90 = E) — the convention zenith.ts/TimeService document.
 * @returns { raDeg, decDeg }
 */
export function altAzToRaDec(altDeg, azDeg, latDeg, lonDeg, date) {
  const alt = altDeg * D2R, az = azDeg * D2R, lat = latDeg * D2R;
  const sinDec = Math.sin(lat) * Math.sin(alt) + Math.cos(lat) * Math.cos(alt) * Math.cos(az);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  // hour angle H (west positive)
  const sinH = -Math.sin(az) * Math.cos(alt) / Math.cos(dec);
  const cosH = (Math.sin(alt) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec));
  const H = Math.atan2(sinH, cosH) * R2D; // deg
  const lst = computeLSTDeg(computeGMSTDeg(toJulianDate(date)), lonDeg);
  const ra = (((lst - H) % 360) + 360) % 360;
  return { raDeg: ra, decDeg: dec * R2D };
}

/**
 * Equatorial → altitude (deg) for a given observer/time. Used for the airmass
 * gradient across a wide field (each star sits at a slightly different altitude).
 */
export function raDecToAltDeg(raDeg, decDeg, latDeg, lonDeg, date) {
  const lst = computeLSTDeg(computeGMSTDeg(toJulianDate(date)), lonDeg);
  const H = (lst - raDeg) * D2R;            // hour angle (rad)
  const lat = latDeg * D2R, dec = decDeg * D2R;
  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) * R2D;
}

/**
 * Kasten & Young (1989) airmass — accurate to the horizon (no sec(z)
 * singularity). altDeg ≤ 0 → Infinity (below horizon).
 */
export function airmassKastenYoung(altDeg) {
  if (altDeg <= 0) return Infinity;
  const a = altDeg;
  return 1 / (Math.sin(a * D2R) + 0.50572 * Math.pow(a + 6.07995, -1.6364));
}

export { D2R, R2D };
