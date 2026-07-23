// ═══════════════════════════════════════════════════════════════════════════
// tools/sextant/fit_core.mjs — mount-geometry fitter kernel (pure JS)
// ═══════════════════════════════════════════════════════════════════════════
//
// Recover observer (latitude φ, longitude λ) from an alt-az-tracked session's
// field-rotation-vs-time history. Model per sub i:
//
//     rotation_i  =  s · q(φ, λ; RA, δ, t_i)  +  q0   (mod 360)
//
//   q  = parallactic angle (astro.mjs), the field-rotation angle an un-derotated
//        alt-az mount imprints; q0 = unknown constant camera-orientation offset;
//        s ∈ {+1,−1} = image/rotation PARITY (sign is convention-dependent —
//        CLAUDE.md law: derive from data, never assert → we fit BOTH and pick).
//
// Fit = VarPro (q0 profiled as a σ-weighted circular mean) + Levenberg–Marquardt
// over (φ, λ, q0) + Tukey-biweight IRLS (c = 4.685), same robust family as the
// tools/atmosphere fit_vertical kernel and the wasm refine_stars_lm lane.
//
// Identifiability (honest-or-absent): a short arc gives ~constant dq/dt → one rate
// constrains ONE combination of (φ, λ), not both. Separation needs CURVATURE in
// q(t) (richest near meridian transit). Every refusal names its failed predicate.
//
// Engineering thresholds below are INITIAL VALUES recorded in README.md for grading
// under Law 2 — flag-not-tune, changed only by adding evidence, never to pass.

import {
  DEG2RAD, RAD2DEG, jdFromMs, parallacticAngleDeg, computeAltAz, wrap180, wrap360,
} from './lib/astro.mjs';

export const PREDICATE_DEFAULTS = Object.freeze({
  MIN_N: 5,                 // minimum rotation measurements
  MIN_ARC_MIN: 20,          // minimum session span (minutes of wall time)
  MIN_HA_SPAN_DEG: 5,       // minimum hour-angle coverage (deg; 15°/hr ⇒ 20min≈5°)
  MIN_CURV_SNR: 3,          // curvature-of-q(t) RMS must exceed 3× the rotation noise
  MIN_PARITY_SEP: 1.0,      // losing parity must be ≥1σ-per-point worse (else s=±1 ambiguous)
  MAX_ALT_DEG: 85,          // target within 5° of zenith ⇒ parallactic angle singular (refuse)
  MAX_SIGMA_LAT_DEG: 20,    // covariance acceptance on latitude (city/region tier)
  MAX_SIGMA_LON_DEG: 20,    // covariance acceptance on longitude
  MAX_REDCHI2: 9,           // gross-misfit sanity ceiling (≈3σ on scaled residual)
  TUKEY_C: 4.685,
});

// ── tiny linear algebra (3×3 symmetric) ────────────────────────────────────
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = [
    m[0][0], m[0][1], m[0][2],
    m[1][0], m[1][1], m[1][2],
    m[2][0], m[2][1], m[2][2],
  ];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-300) return null;
  const id = 1 / det;
  return [
    [A * id, D * id, G * id],
    [B * id, E * id, H * id],
    [C * id, F * id, I * id],
  ];
}
function matVec3(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function median(arr) {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length, m = n >> 1;
  return n % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}
function madSigma(resid) {
  const med = median(resid);
  return 1.4826 * median(resid.map((r) => Math.abs(r - med)));
}

// σ-weighted circular mean of angles (deg) → the profiled q0.
function circularMeanDeg(angles, weights) {
  let sx = 0, sy = 0;
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i] * DEG2RAD, w = weights[i];
    sx += w * Math.cos(a); sy += w * Math.sin(a);
  }
  return Math.atan2(sy, sx) * RAD2DEG;
}

// ── model evaluation ────────────────────────────────────────────────────────
function computeQ(jds, target, phi, lambda) {
  const q = new Array(jds.length);
  for (let i = 0; i < jds.length; i++) {
    q[i] = parallacticAngleDeg(target.ra_hours, target.dec_deg, phi, lambda, jds[i]);
  }
  return q;
}

// Mean target altitude (deg) over the session at a candidate (φ, λ) — the horizon
// consistency signal that breaks the 2-fold alias.
function meanAlt(jds, target, phi, lambda) {
  let s = 0;
  for (let i = 0; i < jds.length; i++) s += computeAltAz(target.ra_hours, target.dec_deg, phi, lambda, jds[i]).altitude;
  return s / jds.length;
}
function maxAlt(jds, target, phi, lambda) {
  let m = -Infinity;
  for (let i = 0; i < jds.length; i++) m = Math.max(m, computeAltAz(target.ra_hours, target.dec_deg, phi, lambda, jds[i]).altitude);
  return m;
}

// Profile q0 (circular mean of y − s·q) and return residuals + q0.
function profile(jds, y, w, target, phi, lambda, s) {
  const q = computeQ(jds, target, phi, lambda);
  const a = new Array(jds.length);
  for (let i = 0; i < jds.length; i++) a[i] = wrap180(y[i] - s * q[i]);
  const q0 = circularMeanDeg(a, w);
  const r = new Array(jds.length);
  for (let i = 0; i < jds.length; i++) r[i] = wrap180(a[i] - q0);
  return { q, q0, r };
}

function weightedSSR(r, sigma) {
  let sse = 0;
  for (let i = 0; i < r.length; i++) { const u = r[i] / sigma[i]; sse += u * u; }
  return sse;
}

// ── one full fit for a fixed parity s ───────────────────────────────────────
function fitParity(jds, y, sigma, target, s, opts) {
  const n = jds.length;
  const w = sigma.map((sg) => 1 / (sg * sg));

  // 1) coarse grid init over (φ, λ) — global, avoids local minima
  let best = { cost: Infinity, phi: 0, lambda: 0 };
  const gridCosts = [];
  for (let phi = -85; phi <= 85; phi += 5) {
    for (let lambda = -180; lambda < 180; lambda += 5) {
      const { r } = profile(jds, y, w, target, phi, lambda, s);
      const cost = weightedSSR(r, sigma);
      gridCosts.push({ phi, lambda, cost });
      if (cost < best.cost) best = { cost, phi, lambda };
    }
  }

  // 2) Levenberg–Marquardt over θ = [φ, λ, q0] with Tukey IRLS
  const c = opts.TUKEY_C;
  const hphi = 1e-3, hlam = 1e-3; // finite-diff steps (deg)
  let phi = best.phi, lambda = best.lambda;
  let { q0 } = profile(jds, y, w, target, phi, lambda, s);
  let mu = 1e-3;

  const modelResid = (ph, la, q0v) => {
    const q = computeQ(jds, target, ph, la);
    const r = new Array(n), model = new Array(n);
    for (let i = 0; i < n; i++) {
      model[i] = wrap360(s * q[i] + q0v);
      r[i] = wrap180(y[i] - model[i]);
    }
    return { r, q };
  };
  const robustCost = (r) => {
    let cst = 0;
    for (let i = 0; i < n; i++) {
      const u = r[i] / sigma[i], au = Math.abs(u);
      // Tukey rho (up to scale): (c²/6)[1−(1−(u/c)²)³] for |u|<c else c²/6
      cst += au < c ? (c * c / 6) * (1 - Math.pow(1 - (u / c) * (u / c), 3)) : c * c / 6;
    }
    return cst;
  };

  let cur = modelResid(phi, lambda, q0);
  let curCost = robustCost(cur.r);

  for (let iter = 0; iter < 100; iter++) {
    // Tukey weights on standardized residuals
    const tw = new Array(n);
    for (let i = 0; i < n; i++) {
      const u = cur.r[i] / sigma[i], au = Math.abs(u);
      tw[i] = au < c ? Math.pow(1 - (u / c) * (u / c), 2) : 0;
    }
    // Jacobian of MODEL wrt (φ, λ, q0); central diff on φ,λ (wrap-safe)
    const qpP = computeQ(jds, target, phi + hphi, lambda);
    const qmP = computeQ(jds, target, phi - hphi, lambda);
    const qpL = computeQ(jds, target, phi, lambda + hlam);
    const qmL = computeQ(jds, target, phi, lambda - hlam);
    // JtWJ (3×3), JtWr (3)
    const JtWJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const JtWr = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const Wi = tw[i] / (sigma[i] * sigma[i]);
      const dphi = s * wrap180(qpP[i] - qmP[i]) / (2 * hphi);
      const dlam = s * wrap180(qpL[i] - qmL[i]) / (2 * hlam);
      const dq0 = 1;
      const J = [dphi, dlam, dq0];
      for (let a2 = 0; a2 < 3; a2++) {
        JtWr[a2] += Wi * J[a2] * cur.r[i];
        for (let b2 = 0; b2 < 3; b2++) JtWJ[a2][b2] += Wi * J[a2] * J[b2];
      }
    }
    // LM damped solve
    let stepTaken = false;
    for (let tries = 0; tries < 8; tries++) {
      const A = [
        [JtWJ[0][0] * (1 + mu), JtWJ[0][1], JtWJ[0][2]],
        [JtWJ[1][0], JtWJ[1][1] * (1 + mu), JtWJ[1][2]],
        [JtWJ[2][0], JtWJ[2][1], JtWJ[2][2] * (1 + mu)],
      ];
      const Ainv = inv3(A);
      if (!Ainv) { mu *= 10; continue; }
      const d = matVec3(Ainv, JtWr);
      const nphi = phi + d[0], nlam = lambda + d[1], nq0 = q0 + d[2];
      const trial = modelResid(nphi, nlam, nq0);
      const tCost = robustCost(trial.r);
      if (tCost < curCost && isFinite(tCost)) {
        phi = nphi; lambda = wrap180(nlam); q0 = wrap360(nq0);
        cur = modelResid(phi, lambda, q0); curCost = tCost;
        mu = Math.max(mu * 0.5, 1e-9); stepTaken = true;
        break;
      } else { mu *= 10; }
    }
    if (!stepTaken) break; // converged / stuck
  }

  // ── resolve the EXACT 2-fold alias (φ,λ) ↔ (−φ, λ+180) ────────────────────
  // The parallactic angle satisfies q(−φ, λ+180) = q(φ, λ) + 180° for all t (proof
  // in README) — the constant 180° is fully absorbed by q0, so rotation-vs-time
  // ALONE cannot tell the two observers apart (they give identical residuals). But
  // altitude flips sign under the same map: alt(−φ, λ+180) = −alt(φ, λ). The frames
  // EXIST ⇒ the target was above the horizon ⇒ the physical solution is the branch
  // that keeps it up. This horizon constraint breaks the degeneracy exactly. Without
  // it the fit is confidently wrong half the time (a silent false-confidence event).
  const meanAltHere = meanAlt(jds, target, phi, lambda);
  const aliasPhi = -phi, aliasLam = wrap180(lambda + 180);
  const meanAltAlias = meanAlt(jds, target, aliasPhi, aliasLam);
  const aliasResolved = meanAltAlias > meanAltHere;
  if (aliasResolved) {
    phi = aliasPhi; lambda = aliasLam; q0 = wrap360(q0 + s * 180);
    cur = modelResid(phi, lambda, q0); // residuals identical (model unchanged); now at physical point
  }
  const meanAltPhysical = Math.max(meanAltHere, meanAltAlias);
  const meanAltRejected = Math.min(meanAltHere, meanAltAlias);

  // Final weights + covariance at solution
  const tw = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = cur.r[i] / sigma[i], au = Math.abs(u);
    tw[i] = au < c ? Math.pow(1 - (u / c) * (u / c), 2) : 0;
  }
  const qpP = computeQ(jds, target, phi + hphi, lambda);
  const qmP = computeQ(jds, target, phi - hphi, lambda);
  const qpL = computeQ(jds, target, phi, lambda + hlam);
  const qmL = computeQ(jds, target, phi, lambda - hlam);
  const JtWJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let chi2 = 0, neff = 0;
  for (let i = 0; i < n; i++) {
    const Wi = tw[i] / (sigma[i] * sigma[i]);
    const dphi = s * wrap180(qpP[i] - qmP[i]) / (2 * hphi);
    const dlam = s * wrap180(qpL[i] - qmL[i]) / (2 * hlam);
    const J = [dphi, dlam, 1];
    for (let a2 = 0; a2 < 3; a2++) for (let b2 = 0; b2 < 3; b2++) JtWJ[a2][b2] += Wi * J[a2] * J[b2];
    chi2 += Wi * cur.r[i] * cur.r[i]; neff += tw[i];
  }
  const dof = Math.max(neff - 3, 1e-6);
  const redChi2 = chi2 / dof;
  const cov = inv3(JtWJ); // formal covariance (σ trusted). Scaling handled by caller.

  return {
    s, phi, lambda: wrap180(lambda), q0: wrap360(q0),
    residuals: cur.r, qModel: cur.q, robustCost: curCost, redChi2, cov,
    alias: { resolved: aliasResolved, mean_alt_physical_deg: meanAltPhysical, mean_alt_rejected_deg: meanAltRejected },
    grid: { best: { phi: best.phi, lambda: best.lambda }, costs: gridCosts },
  };
}

// curvature-of-q(t) RMS (deg): departure of the fitted q(t) from a straight line.
function curvatureRms(times, qModel) {
  const n = times.length;
  const t0 = times[0];
  const x = times.map((t) => (t - t0) / 60000); // minutes
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += qModel[i]; sxx += x[i] * x[i]; sxy += x[i] * qModel[i]; }
  const den = n * sxx - sx * sx;
  const B = Math.abs(den) < 1e-12 ? 0 : (n * sxy - sx * sy) / den;
  const A = (sy - B * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = qModel[i] - (A + B * x[i]); ss += d * d; }
  return Math.sqrt(ss / n);
}

/**
 * Fit observer (φ, λ) from a rotation-vs-time series.
 * @param {{series:Array<{t_utc:number|string, rotation_deg:number, sigma?:number}>,
 *          target:{ra_hours:number, dec_deg:number}, options?:object}} args
 */
export function fitMountGeometry({ series, target, options }) {
  const P = { ...PREDICATE_DEFAULTS, ...(options || {}) };
  const predicates = {};
  const fail = (name, detail) => ({
    status: 'NOT_MEASURED', failed_predicate: name, detail, predicates, target,
  });

  // normalize times → ms
  const norm = series.map((s) => ({
    t: typeof s.t_utc === 'number' ? s.t_utc : Date.parse(s.t_utc),
    rot: s.rotation_deg,
    sig: (s.sigma != null && s.sigma > 0) ? s.sigma : null,
  })).filter((s) => isFinite(s.t) && isFinite(s.rot)).sort((a, b) => a.t - b.t);

  const n = norm.length;
  predicates.n_points = { value: n, min: P.MIN_N, pass: n >= P.MIN_N };
  if (n < P.MIN_N) return fail('n_points', `only ${n} valid points (need ≥ ${P.MIN_N})`);

  const jds = norm.map((s) => jdFromMs(s.t));
  const times = norm.map((s) => s.t);
  const y = norm.map((s) => s.rot);

  // session arc predicate
  const arcMin = (times[n - 1] - times[0]) / 60000;
  // hour-angle coverage ≈ sidereal advance over the arc (15.0411°/hr)
  const haSpanDeg = arcMin / 60 * 15.041067;
  predicates.session_arc = {
    arc_min: arcMin, min_arc_min: P.MIN_ARC_MIN,
    ha_span_deg: haSpanDeg, min_ha_span_deg: P.MIN_HA_SPAN_DEG,
    pass: arcMin >= P.MIN_ARC_MIN && haSpanDeg >= P.MIN_HA_SPAN_DEG,
  };
  if (!predicates.session_arc.pass) {
    return fail('session_arc',
      `arc ${arcMin.toFixed(1)}min / HA ${haSpanDeg.toFixed(2)}° below floor `
      + `(${P.MIN_ARC_MIN}min / ${P.MIN_HA_SPAN_DEG}°) — near-constant dq/dt cannot separate φ from λ`);
  }

  // σ source: provided per-point, else data-scatter (nominal σ=1 → rescale by robust MAD)
  const hasSigma = norm.every((s) => s.sig != null);
  let sigma;
  let sigmaSource;
  if (hasSigma) { sigma = norm.map((s) => s.sig); sigmaSource = 'provided'; }
  else { sigma = new Array(n).fill(1); sigmaSource = 'data_scatter'; }

  // fit both parities (s=±1). The sign of field rotation is convention-dependent
  // (CLAUDE.md parity law) — never assert it; fit both, then let the DATA choose.
  let A = fitParity(jds, y, sigma, target, +1, P);
  let B = fitParity(jds, y, sigma, target, -1, P);
  let chosen = A.robustCost <= B.robustCost ? A : B;
  let other = chosen === A ? B : A;

  // data-scatter σ: rescale to the fitted residual MAD, refit once for calibrated errors
  if (sigmaSource === 'data_scatter') {
    const sigRob = Math.max(madSigma(chosen.residuals), 1e-4);
    sigma = new Array(n).fill(sigRob);
    A = fitParity(jds, y, sigma, target, +1, P);
    B = fitParity(jds, y, sigma, target, -1, P);
    chosen = A.robustCost <= B.robustCost ? A : B;
    other = chosen === A ? B : A;
  }

  // PARITY-SEPARATION predicate: at a (near-)meridian-symmetric arc the two mirror
  // hypotheses fit within noise (q(H) is odd in H → +q and −q indistinguishable with a
  // free q0), so the fitter would otherwise pick one arbitrarily and report a wrong
  // (φ,λ) reflection with tight covariance (a silent false-confidence event). Refuse
  // when the losing parity is not decisively worse than the winner.
  const rmsOf = (r) => Math.sqrt(r.reduce((a, x) => a + x * x, 0) / r.length);
  const rmsChosen = rmsOf(chosen.residuals);
  const rmsOther = rmsOf(other.residuals);
  const noiseFloor = median(sigma);
  const paritySepSigma = (rmsOther - rmsChosen) / Math.max(noiseFloor, 1e-6);
  predicates.parity = {
    rms_chosen_deg: rmsChosen, rms_other_deg: rmsOther, noise_deg: noiseFloor,
    separation_sigma: paritySepSigma, min_separation_sigma: P.MIN_PARITY_SEP,
    chosen_parity: chosen.s, pass: paritySepSigma >= P.MIN_PARITY_SEP,
  };

  // covariance scaling: trust σ if provided; else covariance already on data-scatter σ.
  const covScale = sigmaSource === 'provided' ? 1 : 1;
  const cov = chosen.cov;
  const sigmaFit = cov
    ? { phi: Math.sqrt(Math.max(0, cov[0][0]) * covScale), lambda: Math.sqrt(Math.max(0, cov[1][1]) * covScale) }
    : { phi: Infinity, lambda: Infinity };
  const rho = (cov && sigmaFit.phi > 0 && sigmaFit.lambda > 0)
    ? cov[0][1] / (Math.sqrt(cov[0][0]) * Math.sqrt(cov[1][1])) : 0;

  // covariance ellipse (2×2 (φ,λ) block eigendecomposition)
  const ellipse = cov ? ellipse2(cov[0][0], cov[0][1], cov[1][1]) : null;

  // curvature-SNR (identifiability) predicate
  const curvRms = curvatureRms(times, chosen.qModel);
  const noiseLevel = median(sigma);
  const curvSnr = curvRms / Math.max(noiseLevel, 1e-6);
  predicates.rate_curvature = {
    curvature_rms_deg: curvRms, noise_deg: noiseLevel, snr: curvSnr,
    min_snr: P.MIN_CURV_SNR, pass: curvSnr >= P.MIN_CURV_SNR,
  };

  // near-zenith predicate: the parallactic angle is SINGULAR at the zenith (a star
  // overhead has no defined position angle) — within a few degrees the finite-diff
  // Jacobian + covariance become unreliable and can report a spuriously tiny σ.
  const sessionMaxAlt = maxAlt(jds, target, chosen.phi, chosen.lambda);
  predicates.zenith_proximity = {
    max_alt_deg: sessionMaxAlt, max_alt_limit_deg: P.MAX_ALT_DEG,
    pass: sessionMaxAlt <= P.MAX_ALT_DEG,
  };

  // covariance-acceptance predicate
  predicates.covariance = {
    sigma_lat_deg: sigmaFit.phi, sigma_lon_deg: sigmaFit.lambda,
    max_sigma_lat_deg: P.MAX_SIGMA_LAT_DEG, max_sigma_lon_deg: P.MAX_SIGMA_LON_DEG,
    correlation: rho,
    pass: isFinite(sigmaFit.phi) && isFinite(sigmaFit.lambda)
      && sigmaFit.phi <= P.MAX_SIGMA_LAT_DEG && sigmaFit.lambda <= P.MAX_SIGMA_LON_DEG,
  };

  // sanity predicate
  const sane = Math.abs(chosen.phi) <= 90 && chosen.lambda > -180.0001 && chosen.lambda <= 180.0001
    && isFinite(chosen.redChi2) && chosen.redChi2 <= P.MAX_REDCHI2;
  predicates.sanity = {
    lat_in_range: Math.abs(chosen.phi) <= 90, red_chi2: chosen.redChi2,
    max_red_chi2: P.MAX_REDCHI2, pass: sane,
  };

  const diag = {
    parity: chosen.s, parity_separation_sigma: paritySepSigma, sigma_source: sigmaSource,
    n_points: n, arc_min: arcMin, ha_span_deg: haSpanDeg,
    q0_deg: chosen.q0, red_chi2: chosen.redChi2,
    alias_resolution: {
      resolved_by_horizon: chosen.alias.resolved,
      target_mean_alt_deg: chosen.alias.mean_alt_physical_deg,
      rejected_alias_mean_alt_deg: chosen.alias.mean_alt_rejected_deg,
      weak_disambiguation: chosen.alias.mean_alt_physical_deg < 5,
      note: '(−φ, λ+180°) alias yields an identical rotation curve; rejected because the target would be below the horizon there',
    },
    curvature_rms_deg: curvRms, curvature_snr: curvSnr,
    residual_rms_deg: Math.sqrt(chosen.residuals.reduce((a, r) => a + r * r, 0) / n),
    per_point: norm.map((s, i) => ({ t_utc: new Date(s.t).toISOString(), rotation_deg: s.rot, residual_deg: chosen.residuals[i] })),
    model_curve: sampleModel(times, jds, target, chosen),
  };

  const allPass = predicates.parity.pass && predicates.rate_curvature.pass
    && predicates.zenith_proximity.pass && predicates.covariance.pass && predicates.sanity.pass;
  const result = {
    fit: {
      lat_deg: chosen.phi, lon_deg: chosen.lambda,
      sigma_lat_deg: sigmaFit.phi, sigma_lon_deg: sigmaFit.lambda,
      correlation: rho, q0_deg: chosen.q0, parity: chosen.s,
      covariance_ellipse: ellipse,
    },
    predicates, diagnostics: diag, target,
  };
  if (!allPass) {
    const failed = !predicates.parity.pass ? 'parity'
      : !predicates.rate_curvature.pass ? 'rate_curvature'
        : !predicates.zenith_proximity.pass ? 'zenith_proximity'
          : !predicates.covariance.pass ? 'covariance' : 'sanity';
    return {
      status: 'NOT_MEASURED', failed_predicate: failed,
      detail: describeFailure(failed, predicates),
      // still surface the (elongated) covariance ellipse + the well-constrained direction
      ...result,
    };
  }
  return { status: 'MEASURED', ...result };
}

function describeFailure(failed, p) {
  if (failed === 'parity') {
    return `parity separation ${p.parity.separation_sigma.toFixed(2)}σ < ${p.parity.min_separation_sigma} `
      + `(the two mirror field-rotation hypotheses s=±1 fit within noise — a (near-)meridian-symmetric `
      + `arc cannot fix the rotation sign / (φ,λ) reflection; break it with an ASYMMETRIC arc through transit)`;
  }
  if (failed === 'zenith_proximity') {
    return `target reaches alt ${p.zenith_proximity.max_alt_deg.toFixed(1)}° > ${p.zenith_proximity.max_alt_limit_deg}° `
      + `— the parallactic angle is singular near the zenith; the fit's covariance is unreliable there`;
  }
  if (failed === 'rate_curvature') {
    return `curvature SNR ${p.rate_curvature.snr.toFixed(2)} < ${p.rate_curvature.min_snr} `
      + `(q(t) too linear over this arc — φ/λ degenerate; capture through meridian transit)`;
  }
  if (failed === 'covariance') {
    return `σ(lat)=${p.covariance.sigma_lat_deg.toFixed(2)}° σ(lon)=${p.covariance.sigma_lon_deg.toFixed(2)}° `
      + `exceed acceptance (${p.covariance.max_sigma_lat_deg}°/${p.covariance.max_sigma_lon_deg}°)`;
  }
  return `sanity failed: redχ²=${p.sanity.red_chi2.toFixed(2)} (max ${p.sanity.max_red_chi2}) `
    + `— rotation series inconsistent with a single alt-az parallactic model + noise`;
}

// 2×2 covariance ellipse (semi-axes in deg, orientation in deg)
function ellipse2(cxx, cxy, cyy) {
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy) * RAD2DEG;
  return {
    semi_major_deg: Math.sqrt(Math.max(0, l1)),
    semi_minor_deg: Math.sqrt(Math.max(0, l2)),
    // axis orientation in the (lat, lon) plane; angle of the major axis from the lat axis
    orientation_deg: theta,
  };
}

function sampleModel(times, jds, target, chosen) {
  // dense-ish model sampling for the chart (use the observed times)
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const q = parallacticAngleDeg(target.ra_hours, target.dec_deg, chosen.phi, chosen.lambda, jds[i]);
    out.push({ t_utc: new Date(times[i]).toISOString(), model_deg: wrap180(chosen.s * q + chosen.q0) });
  }
  return out;
}
