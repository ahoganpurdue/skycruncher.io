// ═══════════════════════════════════════════════════════════════════════════
// tools/sextant/lib/p1_sextant.ts — P1 VALIDATION SEXTANT (pure composition)
// ═══════════════════════════════════════════════════════════════════════════
//
// Spec: docs/ATMOSPHERE_SEXTANT_SPEC.md (sextant P1, referenced at inc-2 "the fit
// VALIDATES the claimed location = sextant P1" and inc-11 "P1 = GPS validation at
// continental scale — catching lied EXIF GPS; P2 = derivation follows").
// Design: memory sextant-geolocation-design — "P1 = validation sextant; P2 =
// derivation".
//
// WHAT P1 IS (owner-scoped): PURE COMPOSITION of already-measured quantities —
//   (solved WCS RA/Dec, from the plate solve) + (trusted UTC) + (a CLAIMED observer
//   lat/lon) → the field's Alt/Az + parallactic angle + Bennett refraction, and a
//   VALIDATION verdict on the claimed location, with honest error propagation.
// A TRUE CALCULATION — spherical astronomy (Meeus/IAU), immutable, no ML, no fit.
//
// WHAT P1 IS NOT: it does NOT *derive* a novel location. Deriving location from a
// single plate needs an independent "up"/zenith reference (horizon / gravity-EXIF /
// atmospheric gradient) that P1 does not measure — that is P2 and the inc-8/9/10
// atmospheric verticals. Here `derived_location` is always NOT_MEASURED with the
// predicate `no_up_reference`. NO NEW PHYSICS, NO NEW MEASUREMENT CLAIMS.
//
// LEDGER: COORDINATE only (alt/az/zenith/airmass math). Zero pixels touched.
// UNIT TRAP: RA is HOURS internally (degrees only at a FITS boundary). Longitude is
//   East-positive degrees. This module never touches the FITS-file boundary.
// HONEST-OR-ABSENT (Law 3): every output carries MEASURED | APPROXIMATE | NOT_MEASURED.
// TIME GATE: timestampTrusted gates EVERYTHING time-derived — a bogus clock rotates
//   the entire alt-az frame, so an untrusted clock yields an honest REFUSED, never a
//   (wrong) position. This mirrors the ingest unset-clock forensics + the phantom-
//   planetary-anchor trap.
//
// Reuses the engine's spherical-astronomy primitives verbatim (Law 4 — no duplicate
// math): TimeService (GMST/LMST/computeAltAz), OpticsManager.calculateAtmospheric-
// Refraction (Bennett 1982), AtmosphericManager.computeAirMass (Kasten–Young).

import { TimeService } from '../../../src/engine/core/TimeService';
import { OpticsManager } from '../../../src/engine/core/optics_manager';
import { AtmosphericManager } from '../../../src/engine/core/AtmosphericManager';

// ─── honest-or-absent envelope ───────────────────────────────────────────────
export type Label = 'MEASURED' | 'APPROXIMATE' | 'NOT_MEASURED';
export interface Labeled<T> {
  value: T | null;
  label: Label;
  /** on NOT_MEASURED: the failed predicate; else a provenance note. */
  note?: string;
}
const measured = <T>(value: T, note?: string): Labeled<T> => ({ value, label: 'MEASURED', note });
const approx = <T>(value: T, note?: string): Labeled<T> => ({ value, label: 'APPROXIMATE', note });
const notMeasured = <T>(predicate: string): Labeled<T> => ({ value: null, label: 'NOT_MEASURED', note: predicate });

// ─── inputs ──────────────────────────────────────────────────────────────────
export interface SolvedWcs {
  /** frame-center Right Ascension, HOURS (internal unit convention). */
  raHours: number;
  /** frame-center Declination, degrees. */
  decDeg: number;
  /** camera rotation about the boresight (from the CD matrix), degrees, relative to
   *  celestial North. Optional — feeds only the roll-vs-parallactic DIAGNOSTIC. */
  rollDeg?: number;
  /** 1σ uncertainty on the WCS center position, degrees. Optional — when supplied it
   *  propagates into the boresight-altitude σ; absent ⇒ altitude σ NOT_MEASURED. */
  centerSigmaDeg?: number;
}

export interface ClaimedLocation {
  latDeg: number;
  /** East-positive degrees. */
  lonDeg: number;
  /** provenance of the claim: 'FITS' | 'EXIF' | 'DEFAULT' | 'user' … (for the log). */
  source?: string;
}

export interface TimeContext {
  /** Julian Date (UTC) of the observation. */
  jd: number;
  /** ingest unset-clock-forensics verdict. Gates ALL time-derived output. */
  timestampTrusted: boolean;
  /** 1σ time uncertainty, seconds. Optional — propagates into longitude σ (the
   *  "longitude problem"); absent ⇒ longitude σ NOT_MEASURED. */
  timeSigmaSec?: number;
  isoUtc?: string;
}

// ─── initial engineering values (Law 2 — flag, don't tune) ────────────────────
export const P1_CONSTANTS = {
  /** sidereal rotation of the Earth (deg per second of UT) — the exact kinematic
   *  constant behind "longitude = time". 360° / 86164.0905 s (mean sidereal day). */
  SIDEREAL_DEG_PER_SEC: 360 / 86164.0905,
  /** numeric-Jacobian step for the altitude-σ propagation, degrees on the WCS center. */
  JACOBIAN_STEP_DEG: 1e-4,
} as const;

// ─── pure composition primitives (spherical astronomy, reused from the engine) ──

/** Greenwich Mean Sidereal Time, degrees (IAU 1982, via TimeService). */
export function gmstDeg(jd: number): number {
  return TimeService.getGMST_Deg(jd);
}

/** Local Mean Sidereal Time, degrees, at East-positive longitude. */
export function lmstDeg(jd: number, lonDeg: number): number {
  return ((gmstDeg(jd) + lonDeg) % 360 + 360) % 360;
}

/** Wrap an angle to (−180, +180]. */
export function wrap180(deg: number): number {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * FORWARD sextant map: the celestial coordinates of an observer's zenith.
 * A star exactly at the zenith has Dec = observer latitude and RA = LST.
 * Pure spherical astronomy — exact.
 */
export function locationToZenith(latDeg: number, lonDeg: number, jd: number): { raHours: number; decDeg: number } {
  return { raHours: lmstDeg(jd, lonDeg) / 15, decDeg: latDeg };
}

/**
 * INVERSE sextant map (the classic sextant fix core, the map P2 inverts against a
 * measured zenith): observer location implied by a zenith celestial direction.
 *   latitude  = zenith Declination
 *   longitude = zenith RA (deg) − GMST (deg)   [the longitude problem: needs UTC]
 * Exact inverse of locationToZenith.
 */
export function zenithToLocation(zenithRaHours: number, zenithDecDeg: number, jd: number): { latDeg: number; lonDeg: number } {
  return { latDeg: zenithDecDeg, lonDeg: wrap180(zenithRaHours * 15 - gmstDeg(jd)) };
}

/** Boresight (or any RA/Dec) Alt/Az for a claimed observer + time (Meeus, via engine). */
export function fieldAltAz(raHours: number, decDeg: number, latDeg: number, lonDeg: number, jd: number): { altitudeDeg: number; azimuthDeg: number } {
  const r = TimeService.computeAltAz(raHours, decDeg, latDeg, lonDeg, jd);
  return { altitudeDeg: r.altitude, azimuthDeg: r.azimuth };
}

/** Bennett (1982) refraction at APPARENT altitude, arcseconds (standard P/T). */
export function bennettRefractionArcsec(apparentAltDeg: number): number {
  return OpticsManager.calculateAtmosphericRefraction(apparentAltDeg);
}

/** True altitude below the apparent (refraction lifts the image up), degrees. */
export function trueAltitudeDeg(apparentAltDeg: number): number {
  return apparentAltDeg - bennettRefractionArcsec(apparentAltDeg) / 3600;
}

/** Kasten–Young airmass at an altitude (via engine AtmosphericManager). */
export function airmass(altitudeDeg: number): number {
  return AtmosphericManager.computeAirMass(altitudeDeg);
}

/**
 * Parallactic angle at the boresight (degrees): the angle, at the object, between the
 * direction to the celestial pole and the direction to the zenith. For an alt-az mount
 * (frame "up" ≈ gravity) it predicts the observed roll up to an instrument constant;
 * for an EQ mount it is decoupled. REPORTED as a diagnostic only.
 *   q = atan2( sin H, tan φ cos δ − sin δ cos H )
 */
export function parallacticAngleDeg(raHours: number, decDeg: number, latDeg: number, lonDeg: number, jd: number): number {
  const D2R = Math.PI / 180;
  const haDeg = wrap180(lmstDeg(jd, lonDeg) - raHours * 15);
  const H = haDeg * D2R;
  const dec = decDeg * D2R;
  const lat = latDeg * D2R;
  const q = Math.atan2(Math.sin(H), Math.tan(lat) * Math.cos(dec) - Math.sin(dec) * Math.cos(H));
  return q / D2R;
}

// ─── the P1 product ────────────────────────────────────────────────────────────
export type P1Status =
  | 'VALIDATED'   // claimed location is geometrically admissible for the solved field + time
  | 'REFUTED'     // claimed location is physically impossible (field below the horizon) — the lied-GPS catch
  | 'REFUSED';    // a precondition failed (untrusted clock / no claim) — NO position emitted

export interface P1Result {
  status: P1Status;
  /** named failed predicate on REFUSED/REFUTED (honest-or-absent). */
  predicate: string | null;
  ledger: 'COORDINATE';
  mode: 'VALIDATE';
  // ── composition outputs (each honest-labeled) ──
  boresight_altaz: Labeled<{ altitudeDeg: number; azimuthDeg: number }>;
  true_altitude_deg: Labeled<number>;
  refraction_arcsec: Labeled<number>;
  airmass: Labeled<number>;
  parallactic_angle_deg: Labeled<number>;
  /** the zenith direction implied BY the claimed location (forward map). */
  zenith_celestial: Labeled<{ raHours: number; decDeg: number }>;
  // ── location slots ──
  /** the claim under test (echoed; never fabricated). */
  claimed_location: { latDeg: number; lonDeg: number; source: string | null } | null;
  /** the P2 product — a novel derived fix. Always NOT_MEASURED in P1 (no up-reference). */
  derived_location: Labeled<{ latDeg: number; lonDeg: number }>;
  consistency: {
    above_horizon: boolean | null;
    /** angular separation boresight→zenith = 90° − altitude. */
    boresight_to_zenith_deg: Labeled<number>;
    /** observed roll − parallactic angle. APPROXIMATE: needs a known mount/up convention. */
    roll_vs_parallactic_deg: Labeled<number>;
  };
  error_propagation: {
    /** exact kinematic constant: longitude error per second of clock error. */
    sidereal_deg_per_sec: number;
    /** σ_lon from the supplied time σ (the longitude problem). */
    longitude_sigma_deg: Labeled<number>;
    /** σ_lat of a DERIVED fix = up-reference σ ⇒ NOT_MEASURED in P1. */
    latitude_sigma_deg: Labeled<number>;
    /** σ of the boresight altitude from the WCS-center σ (numeric Jacobian). */
    altitude_sigma_deg: Labeled<number>;
  };
  /** coordinate-FREE attestation (privacy design): expressible with zero lat/lon. */
  attestation: string;
}

function baseResult(): P1Result {
  return {
    status: 'REFUSED',
    predicate: null,
    ledger: 'COORDINATE',
    mode: 'VALIDATE',
    boresight_altaz: notMeasured('not_computed'),
    true_altitude_deg: notMeasured('not_computed'),
    refraction_arcsec: notMeasured('not_computed'),
    airmass: notMeasured('not_computed'),
    parallactic_angle_deg: notMeasured('not_computed'),
    zenith_celestial: notMeasured('not_computed'),
    claimed_location: null,
    derived_location: notMeasured('no_up_reference'),
    consistency: {
      above_horizon: null,
      boresight_to_zenith_deg: notMeasured('not_computed'),
      roll_vs_parallactic_deg: notMeasured('not_computed'),
    },
    error_propagation: {
      sidereal_deg_per_sec: P1_CONSTANTS.SIDEREAL_DEG_PER_SEC,
      longitude_sigma_deg: notMeasured('no_time_sigma_supplied'),
      latitude_sigma_deg: notMeasured('no_up_reference'),
      altitude_sigma_deg: notMeasured('no_wcs_center_sigma_supplied'),
    },
    attestation: '',
  };
}

/**
 * P1 VALIDATION SEXTANT — the entry point. Pure composition; deterministic.
 *
 * Refuses (no position emitted) when a precondition fails:
 *   - untrusted clock            → REFUSED / timestamp_untrusted  (LOAD-BEARING gate)
 *   - no claimed location        → REFUSED / no_claimed_location   (P1 validates; deriving is P2)
 * Refutes when the claim is impossible:
 *   - field below the horizon    → REFUTED / field_below_horizon_at_claimed_location
 * Otherwise VALIDATED, with the full composition + a coordinate-free attestation.
 */
export function validateClaimedLocation(wcs: SolvedWcs, claimed: ClaimedLocation | null, time: TimeContext): P1Result {
  const out = baseResult();

  // ── HARD GATE: trusted clock. A wrong clock rotates the whole alt-az frame. ──
  if (!time.timestampTrusted) {
    out.status = 'REFUSED';
    out.predicate = 'timestamp_untrusted';
    out.attestation = 'REFUSED: observation clock is not trusted — the alt-az frame is unanchored; no location claim can be validated (a bogus clock yields a wrong position, so we refuse).';
    return out;
  }

  // ── P1 validates a CLAIM; it does not derive. No claim ⇒ honest refusal. ──
  if (!claimed || !Number.isFinite(claimed.latDeg) || !Number.isFinite(claimed.lonDeg)) {
    out.status = 'REFUSED';
    out.predicate = 'no_claimed_location';
    // With no claim there is nothing to validate. Deriving a fix needs an up-reference
    // P1 does not measure.
    out.attestation = 'REFUSED: no observer location was claimed (e.g. GPS absent/DEFAULT). P1 VALIDATES a claimed location; DERIVING one from a single plate requires an independent up/zenith reference (horizon / gravity / atmospheric gradient) that P1 does not measure — that is P2.';
    return out;
  }

  out.claimed_location = { latDeg: claimed.latDeg, lonDeg: claimed.lonDeg, source: claimed.source ?? null };

  // ── composition (all time-derived, hence gated above) ──
  const { altitudeDeg, azimuthDeg } = fieldAltAz(wcs.raHours, wcs.decDeg, claimed.latDeg, claimed.lonDeg, time.jd);
  const zc = locationToZenith(claimed.latDeg, claimed.lonDeg, time.jd);

  out.boresight_altaz = measured({ altitudeDeg, azimuthDeg }, 'from solved WCS + claimed loc + trusted UTC (Meeus)');
  out.zenith_celestial = measured(zc, 'RA=LST, Dec=lat (exact)');

  const aboveHorizon = altitudeDeg > 0;
  out.consistency.above_horizon = aboveHorizon;

  // ── REFUTED: the claim puts the solved field below the horizon = impossible. ──
  if (!aboveHorizon) {
    out.status = 'REFUTED';
    out.predicate = 'field_below_horizon_at_claimed_location';
    out.consistency.boresight_to_zenith_deg = measured(90 - altitudeDeg, 'field is below the horizon');
    out.attestation = `REFUTED: at the claimed location and trusted time the solved field sits ${(-altitudeDeg).toFixed(2)}° BELOW the horizon — physically impossible. The claimed location is inconsistent with the plate (candidate lied/incorrect GPS).`;
    return out;
  }

  // ── VALIDATED ──
  out.status = 'VALIDATED';
  out.predicate = null;

  const refr = bennettRefractionArcsec(altitudeDeg);
  out.refraction_arcsec = approx(refr, 'Bennett 1982, standard P=1010hPa/T=10°C (OpticsManager)');
  out.true_altitude_deg = approx(altitudeDeg - refr / 3600, 'apparent − Bennett refraction');
  out.airmass = approx(airmass(altitudeDeg), 'Kasten–Young 1989 (AtmosphericManager)');
  out.parallactic_angle_deg = measured(parallacticAngleDeg(wcs.raHours, wcs.decDeg, claimed.latDeg, claimed.lonDeg, time.jd), 'atan2 form');
  out.consistency.boresight_to_zenith_deg = measured(90 - altitudeDeg, '90° − apparent altitude');

  // roll-vs-parallactic DIAGNOSTIC — reported only, needs a known mount/up convention.
  if (typeof wcs.rollDeg === 'number' && Number.isFinite(wcs.rollDeg)) {
    const diff = wrap180(wcs.rollDeg - out.parallactic_angle_deg.value!);
    out.consistency.roll_vs_parallactic_deg = approx(diff, 'raw roll − parallactic; interpretable only with a known mount/up convention (alt-az: ≈ instrument constant; EQ: decoupled) — DIAGNOSTIC, never gated');
  } else {
    out.consistency.roll_vs_parallactic_deg = notMeasured('no_roll_in_wcs');
  }

  // ── honest error propagation ──
  // longitude ← time (the longitude problem): exact kinematics.
  if (typeof time.timeSigmaSec === 'number' && Number.isFinite(time.timeSigmaSec)) {
    out.error_propagation.longitude_sigma_deg = measured(
      P1_CONSTANTS.SIDEREAL_DEG_PER_SEC * time.timeSigmaSec,
      'σ_lon = (dLon/dt) · σ_t, exact sidereal kinematics',
    );
  }
  // latitude of a DERIVED fix = up-reference σ ⇒ NOT_MEASURED in P1 (kept from base).
  // altitude σ ← WCS-center σ, numeric Jacobian on (RA,Dec).
  if (typeof wcs.centerSigmaDeg === 'number' && Number.isFinite(wcs.centerSigmaDeg) && wcs.centerSigmaDeg > 0) {
    const h = P1_CONSTANTS.JACOBIAN_STEP_DEG;
    const stepH = h / 15; // RA step in hours matching h degrees
    const aRa = fieldAltAz(wcs.raHours + stepH, wcs.decDeg, claimed.latDeg, claimed.lonDeg, time.jd).altitudeDeg;
    const aDec = fieldAltAz(wcs.raHours, wcs.decDeg + h, claimed.latDeg, claimed.lonDeg, time.jd).altitudeDeg;
    const dAlt_dRa = (aRa - altitudeDeg) / h;
    const dAlt_dDec = (aDec - altitudeDeg) / h;
    // isotropic center σ on both axes (conservative): σ_alt = |∇alt| · σ_center
    const grad = Math.hypot(dAlt_dRa, dAlt_dDec);
    out.error_propagation.altitude_sigma_deg = approx(grad * wcs.centerSigmaDeg, 'σ_alt = |∇_pos alt| · σ_center (numeric Jacobian)');
  }

  // coordinate-FREE attestation (privacy design: attest epistemic status, not lat/lon).
  out.attestation =
    `VALIDATED: the claimed location is consistent with the solved field at the trusted time — ` +
    `the field stands ${altitudeDeg.toFixed(2)}° above the horizon (airmass ${out.airmass.value!.toFixed(3)}, ` +
    `Bennett refraction ${refr.toFixed(1)}″), ${(90 - altitudeDeg).toFixed(2)}° from the observer's zenith. ` +
    `This attestation carries NO coordinates. NOTE: single-frame P1 confirms admissibility, it does not ` +
    `independently DERIVE the location (that is P2 / the atmospheric verticals — derived_location = NOT MEASURED).`;

  return out;
}
