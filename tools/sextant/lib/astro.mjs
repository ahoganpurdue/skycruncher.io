// ═══════════════════════════════════════════════════════════════════════════
// tools/sextant/lib/astro.mjs — sidereal-time + horizontal-transform + parallactic
// ═══════════════════════════════════════════════════════════════════════════
//
// The SINGLE copy of the astronomical primitives the sextant mount-geometry
// fitter needs. A plain .mjs cannot import the engine's TS `@/` modules (alias +
// TS compilation — same limitation the tools/atmosphere lane documents), so these
// are re-implemented here and PINNED to the engine as source-of-truth by the
// standing cross-check in mount_rotation_fit.runspec.ts, which imports
// src/engine/core/TimeService.ts and asserts every function below matches it to
// < 1e-9 (deg or rad). Any drift fails that test — this is the "reuse TimeService"
// mandate honored as validation, not blind duplication (CLAUDE.md Law 4).
//
//   getGMST_Deg / getLMST_Deg  <=  TimeService.getGMST_Deg / getLMST_Deg (IAU 1982)
//   computeAltAz               <=  TimeService.computeAltAz
//   parallacticAngleDeg        =   NEW (atan2 form; derivation in README.md), whose
//                                  numeric d/dt is cross-checked against the
//                                  independent field-rotation-rate formula
//                                  ω·cos(φ)·cos(Az)/cos(alt) (MAGNITUDE match; the
//                                  SIGN is convention-dependent → fit parity, never assert).

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

// Earth sidereal rotation rate — rate of change of hour angle for a fixed star.
// (used only for the rate cross-check + curvature diagnostics, never asserted into a fit)
export const OMEGA_SIDEREAL_RAD_S = 7.292115855e-5;

/** JS epoch-ms (UTC) → Julian Date. Mirrors TimeService.toJulianDate. */
export function jdFromMs(ms) {
  return ms / 86400000 + 2440587.5;
}

/** Greenwich Mean Sidereal Time in degrees (IAU 1982). Mirrors TimeService.getGMST_Deg. */
export function getGMST_Deg(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
    + 0.000387933 * T * T - (T * T * T) / 38710000;
  return ((gmst % 360) + 360) % 360;
}

/** Local Mean Sidereal Time in degrees. East longitude positive. Mirrors TimeService.getLMST_Deg. */
export function getLMST_Deg(jd, lonDeg) {
  return ((getGMST_Deg(jd) + (lonDeg % 360) + 360) % 360);
}

/**
 * Local hour angle in radians: H = LST − RA. East longitude positive; RA in HOURS
 * (repo convention — CLAUDE.md UNIT/FORMAT TRAP). Returned wrapped to (−π, π].
 */
export function hourAngleRad(raHours, lonDeg, jd) {
  const lmstRad = getLMST_Deg(jd, lonDeg) * DEG2RAD;
  const raRad = raHours * 15 * DEG2RAD;
  let H = lmstRad - raRad;
  H = Math.atan2(Math.sin(H), Math.cos(H)); // wrap to (−π, π]
  return H;
}

/** RA/Dec → Alt/Az (degrees). Mirrors TimeService.computeAltAz exactly (az from N, +E). */
export function computeAltAz(raHours, decDeg, latDeg, lonDeg, jd) {
  const lmstRad = getLMST_Deg(jd, lonDeg) * DEG2RAD;
  const decRad = decDeg * DEG2RAD;
  const latRad = latDeg * DEG2RAD;
  const raRad = raHours * 15 * DEG2RAD;
  const ha = lmstRad - raRad;
  const sinAlt = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(ha);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAz = (Math.sin(decRad) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * Math.cos(alt));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (Math.sin(ha) > 0) az = 2 * Math.PI - az;
  return { altitude: alt * RAD2DEG, azimuth: az * RAD2DEG };
}

/**
 * Parallactic angle q in DEGREES, wrapped to (−180, 180].
 *   q = atan2( sin H, tan(φ)·cos(δ) − sin(δ)·cos(H) ),  H = LST(λ,t) − RA
 * atan2 form (not raw atan) fixes the quadrant; dividing the standard
 * atan2(cosφ·sinH, sinφ·cosδ − cosφ·sinδ·cosH) by cosφ is sign-safe because
 * cosφ > 0 for |φ| < 90° (poles excluded). See README derivation.
 */
export function parallacticAngleDeg(raHours, decDeg, latDeg, lonDeg, jd) {
  const decRad = decDeg * DEG2RAD;
  const latRad = latDeg * DEG2RAD;
  const H = hourAngleRad(raHours, lonDeg, jd);
  const q = Math.atan2(
    Math.sin(H),
    Math.tan(latRad) * Math.cos(decRad) - Math.sin(decRad) * Math.cos(H),
  );
  return q * RAD2DEG;
}

/**
 * Independent field-rotation rate (deg per second): ω·cos(φ)·cos(Az)/cos(alt).
 * Used ONLY for the physics cross-check + curvature diagnostics. Its SIGN is
 * convention-dependent (azimuth origin / image parity) — the fitter never trusts
 * the sign; it fits parity s = ±1. Magnitude is validated against d/dt of q.
 */
export function fieldRotationRateDegPerSec(raHours, decDeg, latDeg, lonDeg, jd) {
  const { altitude, azimuth } = computeAltAz(raHours, decDeg, latDeg, lonDeg, jd);
  const rate = OMEGA_SIDEREAL_RAD_S * Math.cos(latDeg * DEG2RAD)
    * Math.cos(azimuth * DEG2RAD) / Math.cos(altitude * DEG2RAD);
  return rate * RAD2DEG;
}

/** Wrap an angle (deg) to (−180, 180]. */
export function wrap180(a) {
  let x = ((a + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

/** Wrap an angle (deg) to [0, 360). */
export function wrap360(a) {
  return ((a % 360) + 360) % 360;
}
