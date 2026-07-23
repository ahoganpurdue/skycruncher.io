// ═══════════════════════════════════════════════════════════════════════════
// tools/sextant — standing gate for the mount-geometry fitter (vertical #4)
// ═══════════════════════════════════════════════════════════════════════════
// Two jobs:
//  (A) ENGINE CROSS-CHECK — pins lib/astro.mjs to the engine's TimeService as the
//      GMST/alt-az source of truth (the "reuse TimeService" mandate, honored as
//      validation not blind duplication — CLAUDE.md Law 4). Any drift fails here.
//  (B) FITTER INVARIANTS — synthetic recovery, the three named refusal predicates,
//      the exact 2-fold alias identity, and THE honesty invariant: across a seeded
//      sweep, no MEASURED fix is ever wrong by more than its own covariance
//      (zero silent false-confidence — the instrument never lies).
//
// Pure-JS kernel (no wasm/atlas), so this is cheap enough to live in the sacred
// `npx vitest run` gate rather than an isolated config.
import { describe, it, expect } from 'vitest';
import { TimeService } from '@/engine/core/TimeService';
import {
  getGMST_Deg, getLMST_Deg, computeAltAz as astroAltAz,
  parallacticAngleDeg, fieldRotationRateDegPerSec, jdFromMs, wrap180,
} from './lib/astro.mjs';
import { fitMountGeometry, PREDICATE_DEFAULTS } from './fit_core.mjs';
import { generateSeries, startForTransitMidpoint } from './synth.mjs';

const base = Date.UTC(2024, 2, 21, 0, 0, 0);

describe('astro primitives cross-check vs engine TimeService', () => {
  const samples = [
    { ms: Date.UTC(2000, 0, 1, 0, 0, 0), ra: 6, dec: 20, lat: 40, lon: -75 },
    { ms: Date.UTC(2024, 5, 15, 7, 30, 0), ra: 18, dec: 60, lat: 65, lon: 10 },
    { ms: Date.UTC(2011, 10, 3, 21, 12, 0), ra: 3, dec: -25, lat: 34, lon: -118 },
  ];
  it('GMST/LMST match TimeService to < 1e-9 deg', () => {
    for (const s of samples) {
      const jd = jdFromMs(s.ms);
      expect(Math.abs(getGMST_Deg(jd) - TimeService.getGMST_Deg(jd))).toBeLessThan(1e-9);
      expect(Math.abs(getLMST_Deg(jd, s.lon) - TimeService.getLMST_Deg(jd, s.lon))).toBeLessThan(1e-9);
    }
  });
  it('alt/az match TimeService to < 1e-9 deg', () => {
    for (const s of samples) {
      const jd = jdFromMs(s.ms);
      const a = astroAltAz(s.ra, s.dec, s.lat, s.lon, jd);
      const b = TimeService.computeAltAz(s.ra, s.dec, s.lat, s.lon, jd);
      expect(Math.abs(a.altitude - b.altitude)).toBeLessThan(1e-9);
      expect(Math.abs(a.azimuth - b.azimuth)).toBeLessThan(1e-9);
    }
  });
  it('parallactic-angle d/dt matches the field-rotation-rate formula in MAGNITUDE (sign is convention-dependent)', () => {
    for (const s of samples) {
      const jd0 = jdFromMs(s.ms), jd1 = jdFromMs(s.ms + 1000);
      const num = wrap180(parallacticAngleDeg(s.ra, s.dec, s.lat, s.lon, jd1)
        - parallacticAngleDeg(s.ra, s.dec, s.lat, s.lon, jd0)); // deg per second
      const formula = fieldRotationRateDegPerSec(s.ra, s.dec, s.lat, s.lon, jd0);
      expect(Math.abs(Math.abs(num) - Math.abs(formula))).toBeLessThan(1e-4);
    }
  });
});

describe('exact 2-fold alias identity (φ,λ) ↔ (−φ, λ+180)', () => {
  it('q shifts by exactly 180° and altitude flips sign', () => {
    const jd = jdFromMs(Date.UTC(2024, 2, 21, 6, 12, 0));
    const q = parallacticAngleDeg(8, 30, 40, -71, jd);
    const qA = parallacticAngleDeg(8, 30, -40, wrap180(-71 + 180), jd);
    expect(Math.abs(wrap180(qA - q) - 180)).toBeLessThan(1e-6);
    const a = astroAltAz(8, 30, 40, -71, jd).altitude;
    const aA = astroAltAz(8, 30, -40, wrap180(-71 + 180), jd).altitude;
    expect(Math.abs(a + aA)).toBeLessThan(1e-6);
  });
});

describe('fitter — recovery in favorable geometry', () => {
  it('recovers (lat,lon) within its own covariance on an asymmetric meridian crossing', () => {
    const target = { ra_hours: 8, dec_deg: 30 };
    const lat = 41, lon = -72, parity = -1;
    const sym = startForTransitMidpoint({ target, phiTrue: lat, lambdaTrue: lon, dateUtcMs: base, durationMin: 180 });
    const start = sym + 90 * 60000 - 0.75 * 180 * 60000; // asymmetric crossing
    const gen = generateSeries({ phiTrue: lat, lambdaTrue: lon, q0True: 20, parity, target, startUtcMs: start, durationMin: 180, cadenceSec: 60, noiseDeg: 0.05, seed: 5 });
    const r = fitMountGeometry({ series: gen.series, target });
    expect(r.status).toBe('MEASURED');
    expect(r.fit.parity).toBe(parity);
    expect(Math.abs(r.fit.lat_deg - lat)).toBeLessThan(5 * r.fit.sigma_lat_deg + 0.2);
    expect(Math.abs(r.fit.lon_deg - lon)).toBeLessThan(5 * r.fit.sigma_lon_deg + 0.2);
  });
});

describe('fitter — the three named refusal predicates fire correctly', () => {
  const target = { ra_hours: 8, dec_deg: 30 };
  const lat = 40, lon = -71, parity = -1;
  const sym = startForTransitMidpoint({ target, phiTrue: lat, lambdaTrue: lon, dateUtcMs: base, durationMin: 180 });

  it('short arc → session_arc', () => {
    const start = sym - 2 * 3600 * 1000;
    const gen = generateSeries({ phiTrue: lat, lambdaTrue: lon, q0True: 10, parity, target, startUtcMs: start, durationMin: 10, cadenceSec: 30, noiseDeg: 0.05, seed: 1 });
    const r = fitMountGeometry({ series: gen.series, target });
    expect(r.status).toBe('NOT_MEASURED');
    expect(r.failed_predicate).toBe('session_arc');
  });
  it('symmetric low-transit → parity ambiguity (s=±1 fit within noise)', () => {
    // lat 60 / dec −10: a symmetric arc through a LOW transit (max alt ≈20°) leaves the
    // rotation curve near-symmetric under s→−s → the mirror hypotheses fit within noise.
    const tp = { ra_hours: 8, dec_deg: -10 };
    const latP = 60;
    const symP = startForTransitMidpoint({ target: tp, phiTrue: latP, lambdaTrue: lon, dateUtcMs: base, durationMin: 120 });
    const gen = generateSeries({ phiTrue: latP, lambdaTrue: lon, q0True: 15, parity, target: tp, startUtcMs: symP, durationMin: 120, cadenceSec: 60, noiseDeg: 0.03, seed: 4 });
    const r = fitMountGeometry({ series: gen.series, target: tp });
    expect(r.status).toBe('NOT_MEASURED');
    expect(r.failed_predicate).toBe('parity');
    expect(r.predicates.zenith_proximity.pass).toBe(true); // not a zenith artifact
  });
  it('near-zenith transit → zenith_proximity', () => {
    const tz = { ra_hours: 8, dec_deg: 60 };
    const latZ = 64; // |dec−lat| = 4 ⇒ transit alt ≈ 86° (> 85° singular guard)
    const symZ = startForTransitMidpoint({ target: tz, phiTrue: latZ, lambdaTrue: lon, dateUtcMs: base, durationMin: 180 });
    const start = symZ + 90 * 60000 - 0.85 * 180 * 60000; // strongly asymmetric (parity determined)
    const gen = generateSeries({ phiTrue: latZ, lambdaTrue: lon, q0True: 10, parity, target: tz, startUtcMs: start, durationMin: 180, cadenceSec: 60, noiseDeg: 0.02, seed: 8 });
    const r = fitMountGeometry({ series: gen.series, target: tz });
    expect(r.status).toBe('NOT_MEASURED');
    expect(r.failed_predicate).toBe('zenith_proximity');
  });
  it('exposes engineering thresholds for grading (flag-not-tune)', () => {
    expect(PREDICATE_DEFAULTS.MIN_ARC_MIN).toBeGreaterThan(0);
    expect(PREDICATE_DEFAULTS.MIN_PARITY_SEP).toBeGreaterThan(0);
    expect(PREDICATE_DEFAULTS.MAX_ALT_DEG).toBeLessThanOrEqual(90);
  });
});

describe('HONESTY INVARIANT — no MEASURED fix is ever wrong beyond its covariance', () => {
  // 18 seeded series+fits in one test: ~2.4s isolated, but full-parallel CPU
  // contention can blow vitest's 5s default (observed 2026-07-16). Timeout is
  // headroom only — assertions and sweep coverage are untouched.
  it('zero silent false-confidence across a seeded geometry/noise sweep', { timeout: 30_000 }, () => {
    const lats = [0, 38, 62];
    const decs = [-15, 25, 55];
    const noises = [0.02, 0.1];
    const lon = -68, parity = -1;
    let measured = 0, falseConfident = 0;
    let seed = 500;
    for (const lat of lats) for (const dec of decs) for (const noise of noises) {
      const target = { ra_hours: 8, dec_deg: dec };
      const sym = startForTransitMidpoint({ target, phiTrue: lat, lambdaTrue: lon, dateUtcMs: base, durationMin: 180 });
      const start = sym + 90 * 60000 - 0.75 * 180 * 60000; // asymmetric crossing
      const gen = generateSeries({ phiTrue: lat, lambdaTrue: lon, q0True: 30, parity, target, startUtcMs: start, durationMin: 180, cadenceSec: 90, noiseDeg: noise, seed: seed++ });
      if (gen.series.length < PREDICATE_DEFAULTS.MIN_N) continue;
      const r = fitMountGeometry({ series: gen.series, target });
      if (r.status !== 'MEASURED') continue;
      measured++;
      const latOff = Math.abs(r.fit.lat_deg - lat);
      const lonOff = Math.abs(wrap180(r.fit.lon_deg - lon));
      // error must sit within ~4σ of the reported covariance (+ small absolute floor)
      if (latOff > 4 * r.fit.sigma_lat_deg + 0.1 || lonOff > 4 * r.fit.sigma_lon_deg + 0.1) falseConfident++;
    }
    expect(measured).toBeGreaterThan(3);          // the sweep did produce fixes
    expect(falseConfident).toBe(0);               // and none of them lied
  });
});
