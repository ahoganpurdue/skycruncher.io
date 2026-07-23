// ═══════════════════════════════════════════════════════════════════════════
// tools/sextant/synth.mjs — truth-known q(t) series generator for validation
// ═══════════════════════════════════════════════════════════════════════════
//
// Generates a synthetic per-sub rotation-vs-time series from a KNOWN observer
// (φ, λ), target (RA, δ), camera offset q0, and parity s, with Gaussian rotation
// noise. Used by the synthetic recovery sweep (mount_rotation_fit.mjs --sweep) and
// the runspec assertions. Above-horizon sampling only (a real tracked session).

import { jdFromMs, parallacticAngleDeg, computeAltAz, wrap180 } from './lib/astro.mjs';

// deterministic RNG (mulberry32) + Box–Muller
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * @param {object} p
 * @param {number} p.phiTrue    latitude (deg)
 * @param {number} p.lambdaTrue longitude (deg, E+)
 * @param {number} p.q0True     camera orientation offset (deg)
 * @param {number} p.parity     +1 or −1
 * @param {{ra_hours:number, dec_deg:number}} p.target
 * @param {number} p.startUtcMs session start (epoch ms UTC)
 * @param {number} p.durationMin
 * @param {number} p.cadenceSec  per-sub cadence
 * @param {number} p.noiseDeg    per-sub rotation noise (1σ)
 * @param {number} [p.seed]
 * @param {number} [p.minAltDeg] horizon cut (default 15)
 * @param {boolean} [p.withSigma] attach per-point sigma (default true)
 */
export function generateSeries(p) {
  const rng = mulberry32(p.seed ?? 12345);
  const minAlt = p.minAltDeg ?? 15;
  const series = [];
  let belowHorizon = 0;
  for (let t = 0; t <= p.durationMin * 60; t += p.cadenceSec) {
    const ms = p.startUtcMs + t * 1000;
    const jd = jdFromMs(ms);
    const { altitude } = computeAltAz(p.target.ra_hours, p.target.dec_deg, p.phiTrue, p.lambdaTrue, jd);
    if (altitude < minAlt) { belowHorizon++; continue; }
    const q = parallacticAngleDeg(p.target.ra_hours, p.target.dec_deg, p.phiTrue, p.lambdaTrue, jd);
    const noise = gaussian(rng) * p.noiseDeg;
    const rot = wrap180(p.parity * q + p.q0True + noise);
    const pt = { t_utc: ms, rotation_deg: rot };
    if (p.withSigma !== false) pt.sigma = p.noiseDeg;
    series.push(pt);
  }
  return { series, belowHorizon, truth: { lat_deg: p.phiTrue, lon_deg: p.lambdaTrue, q0_deg: p.q0True, parity: p.parity } };
}

/**
 * Pick a session start (epoch ms) such that the target transits the meridian
 * (hour angle ≈ 0) at the session MIDPOINT — the maximum-curvature geometry.
 * Uses a coarse scan over one sidereal day for the given date + observer.
 */
export function startForTransitMidpoint({ target, phiTrue, lambdaTrue, dateUtcMs, durationMin }) {
  // hour angle H = LST − RA; want H≈0 at midpoint. Scan minute-by-minute over 24h.
  let bestMs = dateUtcMs, bestAbsAlt = -Infinity, bestHA = Infinity;
  for (let m = 0; m < 24 * 60; m++) {
    const mid = dateUtcMs + m * 60000;
    const jd = jdFromMs(mid);
    const q = parallacticAngleDeg(target.ra_hours, target.dec_deg, phiTrue, lambdaTrue, jd);
    void q;
    const { altitude } = computeAltAz(target.ra_hours, target.dec_deg, phiTrue, lambdaTrue, jd);
    // transit ⇒ maximum altitude; pick the highest-altitude instant (upper culmination)
    if (altitude > bestAbsAlt) { bestAbsAlt = altitude; bestMs = mid; bestHA = 0; }
  }
  void bestHA;
  return bestMs - (durationMin / 2) * 60000;
}
