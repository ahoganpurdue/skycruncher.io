// ═══════════════════════════════════════════════════════════════════════════
// Standing tests for the Sextant P1 validation composition (tools/sextant lane).
// Collected by the node-suite (`src/engine/tests/**`) so they ride the standing
// `npx vitest run` gate. The composition LOGIC lives in the incubator lane
// (tools/sextant/lib/p1_sextant.ts) per Law 4; this file is a test-only src/ add —
// zero production/receipt change.
//
// Coverage: (1) formula-independent closed-form KATs (meridian transit, zenith
// round-trip identity), (2) published-value Bennett refraction, (3) a KAT on the
// banked SeeStar M66 receipt inputs, (4) the LOAD-BEARING refusal paths (untrusted
// clock, no claim) and the below-horizon REFUTATION, (5) honest error propagation.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  validateClaimedLocation,
  locationToZenith,
  zenithToLocation,
  fieldAltAz,
  bennettRefractionArcsec,
  parallacticAngleDeg,
  gmstDeg,
  P1_CONSTANTS,
  type SolvedWcs,
  type ClaimedLocation,
  type TimeContext,
} from '../../../tools/sextant/lib/p1_sextant';

const D2R = Math.PI / 180;
const clamp = (x: number) => Math.max(-1, Math.min(1, x));

// ── fully independent reference implementations (no import from the module) ──

/** Independent IAU-1982 GMST (degrees) — fresh transcription, for a wiring KAT. */
function indepGmstDeg(jd: number): number {
  const T = (jd - 2451545.0) / 36525.0;
  let g = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000;
  return ((g % 360) + 360) % 360;
}

/** Independent Meeus RA/Dec→Alt/Az (degrees), East-positive lon, Az from N through E. */
function indepAltAz(raH: number, decD: number, latD: number, lonD: number, jd: number) {
  const lstDeg = ((indepGmstDeg(jd) + lonD) % 360 + 360) % 360;
  const ha = (lstDeg - raH * 15) * D2R;
  const dec = decD * D2R;
  const lat = latD * D2R;
  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const altDeg = Math.asin(clamp(sinAlt)) / D2R;
  const cosAz = (Math.sin(dec) - Math.sin(lat) * sinAlt) / (Math.cos(lat) * Math.cos(altDeg * D2R));
  let azDeg = Math.acos(clamp(cosAz)) / D2R;
  if (Math.sin(ha) > 0) azDeg = 360 - azDeg;
  return { altitudeDeg: altDeg, azimuthDeg: azDeg };
}

// ── banked SeeStar M66 receipt (source of realistic KAT inputs) ──
// test_results/e2e/seestar_2026-07-06T01-23-17-128Z/summary.json
const SEESTAR = {
  raHours: 11.34126667182423,      // solution.ra_hours
  decDeg: 13.04816011106046,       // solution.dec_degrees
  rollDeg: 179.3894499784982,      // solution.rotation
  jd: 2461176.6630218057,          // finalSession.computed_jd
  latDeg: 46.2183990478516,        // finalSession.metadata.gps_lat (FITS)
  lonDeg: -84.068000793457,        // finalSession.metadata.gps_lon (FITS)
};

describe('sextant P1 — composition primitives (formula-independent KATs)', () => {
  it('GMST delegates to the IAU-1982 formula (wiring KAT, degrees not radians)', () => {
    for (const jd of [SEESTAR.jd, 2451545.0, 2458637.780636574]) {
      expect(gmstDeg(jd)).toBeCloseTo(indepGmstDeg(jd), 9);
    }
  });

  it('zenith map is an EXACT algebraic inverse; zenith Dec === latitude', () => {
    const cases = [
      { lat: 46.2, lon: -84.07, jd: SEESTAR.jd },
      { lat: -33.9, lon: 151.2, jd: 2458637.78 },
      { lat: 0, lon: 0, jd: 2451545.0 },
    ];
    for (const c of cases) {
      const z = locationToZenith(c.lat, c.lon, c.jd);
      expect(z.decDeg).toBe(c.lat); // zenith declination IS the latitude, exactly
      const back = zenithToLocation(z.raHours, z.decDeg, c.jd);
      expect(back.latDeg).toBeCloseTo(c.lat, 10);
      // longitude wraps to (−180,180]; compare on the circle
      const dLon = ((back.lonDeg - c.lon + 540) % 360) - 180;
      expect(dLon).toBeCloseTo(0, 9);
    }
  });

  it('meridian transit matches the textbook closed form alt = 90 − |lat − dec|, az ∈ {0,180}', () => {
    const jd = SEESTAR.jd;
    const lat = 46.2, lon = -84.07;
    // place a star on the local meridian (HA = 0 ⇒ RA = LST)
    const lstDeg = ((indepGmstDeg(jd) + lon) % 360 + 360) % 360;
    const raH = lstDeg / 15;
    for (const dec of [13.0, 60.0, -10.0]) {
      const { altitudeDeg, azimuthDeg } = fieldAltAz(raH, dec, lat, lon, jd);
      expect(altitudeDeg).toBeCloseTo(90 - Math.abs(lat - dec), 6);
      // dec < lat ⇒ transits due South (az 180); dec > lat ⇒ due North (az 0/360)
      const expectedAz = dec < lat ? 180 : 0;
      const dAz = Math.min(Math.abs(azimuthDeg - expectedAz), Math.abs(azimuthDeg - 360 - expectedAz));
      expect(dAz).toBeLessThan(1e-4);
      // parallactic angle on the meridian is exactly 0 (dec<lat) or 180 (dec>lat)
      const q = parallacticAngleDeg(raH, dec, lat, lon, jd);
      const expectedQ = dec < lat ? 0 : 180;
      expect(Math.abs(((q - expectedQ + 540) % 360) - 180)).toBeCloseTo(0, 6);
    }
  });

  it('Bennett refraction matches published values (apparent altitude form)', () => {
    // Bennett 1982 @ standard P/T: ~5.3′ at 10°, ~1′ at 45°, ~0 at the zenith.
    expect(bennettRefractionArcsec(10)).toBeGreaterThan(300); // ≈ 323″
    expect(bennettRefractionArcsec(10)).toBeLessThan(340);
    expect(bennettRefractionArcsec(45)).toBeGreaterThan(55);  // ≈ 60″
    expect(bennettRefractionArcsec(45)).toBeLessThan(62);
    expect(Math.abs(bennettRefractionArcsec(90))).toBeLessThan(2); // ≈ 0
  });
});

describe('sextant P1 — validateClaimedLocation on the banked SeeStar M66 receipt', () => {
  const wcs: SolvedWcs = { raHours: SEESTAR.raHours, decDeg: SEESTAR.decDeg, rollDeg: SEESTAR.rollDeg };
  const claimed: ClaimedLocation = { latDeg: SEESTAR.latDeg, lonDeg: SEESTAR.lonDeg, source: 'FITS' };
  const time: TimeContext = { jd: SEESTAR.jd, timestampTrusted: true, timeSigmaSec: 1, isoUtc: 'FITS DATE-OBS' };

  it('VALIDATES the FITS GPS; boresight altitude reproduces an independent Meeus transform', () => {
    const r = validateClaimedLocation(wcs, claimed, time);
    expect(r.status).toBe('VALIDATED');
    expect(r.predicate).toBeNull();
    expect(r.ledger).toBe('COORDINATE');

    const ref = indepAltAz(SEESTAR.raHours, SEESTAR.decDeg, SEESTAR.latDeg, SEESTAR.lonDeg, SEESTAR.jd);
    expect(r.boresight_altaz.label).toBe('MEASURED');
    expect(r.boresight_altaz.value!.altitudeDeg).toBeCloseTo(ref.altitudeDeg, 6);
    expect(r.boresight_altaz.value!.azimuthDeg).toBeCloseTo(ref.azimuthDeg, 6);

    // independent physical bound: Dec+13 from lat+46.2 cannot exceed transit alt
    const transitMax = 90 - Math.abs(SEESTAR.latDeg - SEESTAR.decDeg);
    expect(r.boresight_altaz.value!.altitudeDeg).toBeGreaterThan(0);
    expect(r.boresight_altaz.value!.altitudeDeg).toBeLessThanOrEqual(transitMax + 1e-9);
    expect(r.consistency.above_horizon).toBe(true);
  });

  it('emits airmass/refraction as APPROXIMATE and the zenith map as MEASURED', () => {
    const r = validateClaimedLocation(wcs, claimed, time);
    expect(r.airmass.label).toBe('APPROXIMATE');
    expect(r.airmass.value!).toBeGreaterThanOrEqual(1);
    expect(r.refraction_arcsec.label).toBe('APPROXIMATE');
    expect(r.true_altitude_deg.value!).toBeLessThan(r.boresight_altaz.value!.altitudeDeg); // refraction lifts image up
    // zenith of the claimed observer: Dec === lat, RA === LST
    expect(r.zenith_celestial.label).toBe('MEASURED');
    expect(r.zenith_celestial.value!.decDeg).toBe(SEESTAR.latDeg);
    expect(r.zenith_celestial.value!.raHours).toBeCloseTo(((gmstDeg(SEESTAR.jd) + SEESTAR.lonDeg) % 360 + 360) % 360 / 15, 9);
  });

  it('derived_location is NOT_MEASURED (no up-reference) and the attestation is coordinate-free', () => {
    const r = validateClaimedLocation(wcs, claimed, time);
    // P1 validates, it does not derive — deriving is P2.
    expect(r.derived_location.label).toBe('NOT_MEASURED');
    expect(r.derived_location.note).toBe('no_up_reference');
    // privacy: the attestation must be expressible with zero coordinates. Test for a
    // recognizable coordinate leak (≥3 decimals / full precision) rather than a short
    // prefix — the boresight→zenith angle (~46.26°) legitimately shares a 2-digit
    // prefix with the latitude, and that geometry value is NOT a coordinate.
    expect(r.attestation).not.toContain(SEESTAR.latDeg.toFixed(3));    // '46.218'
    expect(r.attestation).not.toContain(SEESTAR.lonDeg.toFixed(3));    // '-84.068'
    expect(r.attestation).not.toContain(String(SEESTAR.latDeg));       // full precision
    expect(r.attestation).not.toContain(String(SEESTAR.lonDeg));
    expect(r.attestation).toContain('NO coordinates');
  });

  it('honest error propagation: longitude σ from time σ (exact), latitude σ NOT_MEASURED', () => {
    const r = validateClaimedLocation({ ...wcs, centerSigmaDeg: 0.02 }, claimed, time);
    // the longitude problem: σ_lon = (dLon/dt)·σ_t = sidereal rate × 1s
    expect(r.error_propagation.longitude_sigma_deg.label).toBe('MEASURED');
    expect(r.error_propagation.longitude_sigma_deg.value!).toBeCloseTo(P1_CONSTANTS.SIDEREAL_DEG_PER_SEC * 1, 12);
    // latitude of a DERIVED fix needs the up-reference P1 lacks
    expect(r.error_propagation.latitude_sigma_deg.label).toBe('NOT_MEASURED');
    // altitude σ from the supplied WCS-center σ
    expect(r.error_propagation.altitude_sigma_deg.label).toBe('APPROXIMATE');
    expect(r.error_propagation.altitude_sigma_deg.value!).toBeGreaterThan(0);
  });
});

describe('sextant P1 — refusal + refutation paths (LOAD-BEARING, no wrong position)', () => {
  const wcs: SolvedWcs = { raHours: SEESTAR.raHours, decDeg: SEESTAR.decDeg };
  const claimed: ClaimedLocation = { latDeg: SEESTAR.latDeg, lonDeg: SEESTAR.lonDeg, source: 'FITS' };

  it('REFUSES on an untrusted clock and emits NO location or geometry', () => {
    const r = validateClaimedLocation(wcs, claimed, { jd: SEESTAR.jd, timestampTrusted: false });
    expect(r.status).toBe('REFUSED');
    expect(r.predicate).toBe('timestamp_untrusted');
    expect(r.claimed_location).toBeNull();       // no position echoed
    expect(r.boresight_altaz.value).toBeNull();  // nothing time-derived leaks
    expect(r.zenith_celestial.value).toBeNull();
    expect(r.derived_location.label).toBe('NOT_MEASURED');
  });

  it('REFUSES when no location is claimed (the CR2 gps_source=DEFAULT case)', () => {
    const r = validateClaimedLocation(wcs, null, { jd: 2458637.780636574, timestampTrusted: true });
    expect(r.status).toBe('REFUSED');
    expect(r.predicate).toBe('no_claimed_location');
    expect(r.claimed_location).toBeNull();
    expect(r.derived_location.label).toBe('NOT_MEASURED'); // deriving is P2
  });

  it('REFUTES an impossible claim (solved field below the horizon at the claimed location)', () => {
    // Dec +13 can never rise above the horizon from latitude −80° (max alt = 90−93 = −3°).
    const deepSouth: ClaimedLocation = { latDeg: -80, lonDeg: 0, source: 'test' };
    const r = validateClaimedLocation(wcs, deepSouth, { jd: SEESTAR.jd, timestampTrusted: true });
    expect(r.status).toBe('REFUTED');
    expect(r.predicate).toBe('field_below_horizon_at_claimed_location');
    expect(r.consistency.above_horizon).toBe(false);
    expect(r.boresight_altaz.value!.altitudeDeg).toBeLessThan(0);
  });
});
