// cascade.mjs — DEMO 3 data: evaluate the four distortion-model stages of a
// REAL pipeline receipt into |displacement(x, y)| px height fields.
//
// COORDINATE ledger, display-only (LAW 3): every formula below is a verbatim
// port of the engine's own evaluation code — cited per stage — and this module
// NEVER solves, refits, or synthesizes coefficients. A stage whose inputs are
// absent from the receipt returns { status: 'absent', reason } and the UI
// renders an explicit NOT MEASURED tile; it is never faked.
//
// Ported eval conventions (single sources of truth, keep in sync by hand):
//   NOMINAL BC  — src/engine/pipeline/m2_hardware/hardware_profiler.ts
//                 (calculateRMSE / generateReport center choice) and the
//                 render-side src/engine/ui/calibration/chart_math.ts
//                 ::distortionShiftPx — shift = (k1 rn² + k2 rn⁴ + k3 rn⁶)·r,
//                 rn = r / fit_stats.r_ref_px, center = fitted WCS CRPIX.
//   MEASURED BC — tools/psf/refit_distortion.mjs ::pairBasis / predictNative
//                 lens terms ONLY (k1,k2,k3 radial + p1,p2 decentering);
//                 tx/ty/rot/a are WCS-residual absorbers, NOT lens terms, and
//                 are never part of the exported model. r normalized to the
//                 half-diagonal, center = frame center (corrections.mjs
//                 convention). Presence gate mirrors
//                 src/engine/pipeline/export/asdf_writer.ts::buildLensDistortion.
//   SIP         — src/engine/pipeline/m7_astrometry/residual_analyzer.ts:
//                 the fit models pixel displacement dx,dy as polynomials in
//                 u = x − CRPIX1, v = y − CRPIX2 with terms 2 <= p+q <= order;
//                 displacement(x,y) = (sum A[p][q] u^p v^q, sum B[p][q] u^p v^q).
//   TPS         — src/engine/pipeline/shaders/unified_calibration.wgsl
//                 ::u_tps / evaluate_tps — affine part minus identity plus
//                 Σ wᵢ·U(rᵢ), U(r) = r²·ln(r), per axis.

const STAGE_KEYS = ['nominal_bc', 'measured_bc', 'sip', 'tps'];

/** Fetch the first reachable receipt JSON. Throws with the full failure list. */
export async function loadReceipt(urls) {
  const failures = [];
  for (const url of urls) {
    let res;
    const t0 = performance.now();
    try {
      res = await fetch(url);
    } catch (err) {
      failures.push(`${url}: fetch failed (${err.message})`);
      continue;
    }
    if (!res.ok) {
      failures.push(`${url}: HTTP ${res.status}`);
      continue;
    }
    let receipt;
    try {
      receipt = await res.json();
    } catch (err) {
      failures.push(`${url}: not JSON (${err.message})`);
      continue;
    }
    return { receipt, url, fetchMs: performance.now() - t0 };
  }
  throw new Error(
    `no receipt reachable — tried:\n  ${failures.join('\n  ')}\n` +
    'See tools/renderlab/README.md ("DEMO 3 data") for how to provide one.',
  );
}

/* ── per-stage evaluators (each returns f(x,y) → |displacement| px, or an
      absent record with the concrete reason) ─────────────────────────────── */

const absent = (key, label, reason) => ({ key, label, status: 'absent', reason });

function nominalStage(receipt, W, H) {
  const key = STAGE_KEYS[0];
  const label = 'NOMINAL BC';
  const prof = receipt?.hardware?.distortion_profile;
  const fit = receipt?.hardware?.fit_stats;
  if (!prof) return absent(key, label, 'hardware.distortion_profile absent from receipt');
  // Measurement gate mirrors ForensicCalibrationStep.tsx:
  //   distortionMeasured = !!fit && fit.n_matches >= 10 && fit.r_ref_px > 0
  if (!(fit && fit.n_matches >= 10 && fit.r_ref_px > 0)) {
    return absent(key, label,
      'fit_stats gate failed (needs n_matches >= 10 and r_ref_px > 0) — the profile numbers would be the honest-zero fallback, not a measurement');
  }
  const k1 = prof.k1 ?? 0;
  const k2 = prof.k2 ?? 0;
  const k3 = prof.k3 ?? 0;
  const rRef = fit.r_ref_px;
  // Center: fitted WCS CRPIX preferred, frame center fallback — the same
  // ladder hardware_profiler.ts::generateReport uses to build the radii.
  const wcs = receipt?.wcs;
  const cx = Number.isFinite(wcs?.CRPIX1) ? wcs.CRPIX1 : W / 2;
  const cy = Number.isFinite(wcs?.CRPIX2) ? wcs.CRPIX2 : H / 2;
  const cornerR = Math.max(
    Math.hypot(cx, cy), Math.hypot(W - cx, cy),
    Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy),
  );
  const notes = [];
  if (cornerR > rRef * 1.02) {
    notes.push(`r > r_ref (${rRef.toFixed(0)} px) extrapolates beyond fit coverage`);
  }
  if ((prof.p1 ?? 0) !== 0 || (prof.p2 ?? 0) !== 0) {
    notes.push('p1/p2 present but not applied — the engine nominal eval is radial-only');
  }
  return {
    key, label, status: 'measured',
    note: notes.join(' · ') || null,
    // chart_math.ts::distortionShiftPx with rn = r/r_ref: displacement is
    // radial, magnitude |(k1 rn² + k2 rn⁴ + k3 rn⁶) · r|.
    f: (x, y) => {
      const r = Math.hypot(x - cx, y - cy);
      const rn2 = (r / rRef) * (r / rRef);
      return Math.abs((k1 * rn2 + k2 * rn2 * rn2 + k3 * rn2 * rn2 * rn2) * r);
    },
  };
}

function measuredStage(receipt, W, H) {
  const key = STAGE_KEYS[1];
  const label = 'MEASURED BC';
  // Resolution order + measured===true gate: asdf_writer.ts::buildLensDistortion.
  const meas = receipt?.solution?.lens_distortion_measured
    ?? receipt?.lens_distortion_measured;
  if (!meas || meas.measured !== true) {
    return absent(key, label,
      'lens_distortion_measured absent — no producer emits per-copy measured Brown-Conrady yet (asdf_writer honest-absent gate)');
  }
  const co = meas.coefficients ?? {};
  // refit_distortion.mjs writes coefficients as { term: { value, sigma } };
  // accept plain numbers too. Coefficients are READ, never invented.
  const cv = (c) => {
    const v = (c && typeof c === 'object') ? c.value : c;
    return Number.isFinite(v) ? v : 0;
  };
  const k1 = cv(co.k1), k2 = cv(co.k2), k3 = cv(co.k3);
  const p1 = cv(co.p1), p2 = cv(co.p2);
  if (![co.k1, co.k2, co.k3, co.p1, co.p2].some((c) => c !== undefined)) {
    return absent(key, label, 'lens_distortion_measured.coefficients carries no k/p terms');
  }
  // Frame-center + half-diagonal normalization: corrections.mjs / refit
  // convention (cx=(w-1)/2). half_diag_px from the block when carried.
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  const hd = (Number.isFinite(meas.half_diag_px) && meas.half_diag_px > 0)
    ? meas.half_diag_px
    : Math.hypot(cx, cy);
  return {
    key, label, status: 'measured',
    note: Number.isFinite(meas.half_diag_px) ? null : 'half_diag_px absent — using hypot(cx, cy)',
    // refit_distortion.mjs::predictNative lens terms (pairBasis rows k1..p2):
    //   dx = xn·radial + p1·(r² + 2xn²) + 2·p2·xn·yn
    //   dy = yn·radial + p2·(r² + 2yn²) + 2·p1·xn·yn
    f: (x, y) => {
      const xn = (x - cx) / hd;
      const yn = (y - cy) / hd;
      const r2 = xn * xn + yn * yn;
      const radial = k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
      const dx = xn * radial + p1 * (r2 + 2 * xn * xn) + 2 * p2 * xn * yn;
      const dy = yn * radial + p2 * (r2 + 2 * yn * yn) + 2 * p1 * xn * yn;
      return Math.hypot(dx, dy) * hd;
    },
  };
}

/** Full-matrix SIP polynomial eval — zero entries contribute nothing, so this
 *  is exactly the fitted 2 ≤ p+q ≤ order model from performSIPFit. */
function sipPolyEval(m, u, v) {
  let s = 0;
  for (let p = 0; p < m.length; p++) {
    const row = m[p];
    if (!row) continue;
    for (let q = 0; q < row.length; q++) {
      const c = row[q];
      if (!c) continue;
      s += c * Math.pow(u, p) * Math.pow(v, q); // Math.pow: solveLeastSquares term construction
    }
  }
  return s;
}

function sipStage(receipt) {
  const key = STAGE_KEYS[2];
  const label = 'SIP';
  const sip = receipt?.solution?.astrometry?.sip;
  if (!sip || !Array.isArray(sip.a) || !Array.isArray(sip.b)) {
    return absent(key, label,
      'solution.astrometry.sip absent — residual_analyzer fits SIP only when rms > 1.2 arcsec and > 20 sentinel-filtered matches');
  }
  // The SIP fit is expanded about the fitted WCS CRPIX (residual_analyzer.ts:
  // u = detected.x − crpix[0], v = detected.y − crpix[1]). Never guess a center.
  const wcs = receipt?.wcs;
  const cr1 = wcs?.CRPIX1;
  const cr2 = wcs?.CRPIX2;
  if (!Number.isFinite(cr1) || !Number.isFinite(cr2)) {
    return absent(key, label, 'wcs.CRPIX absent — SIP is expanded about CRPIX and the lab never guesses a center');
  }
  return {
    key, label, status: 'measured',
    note: `order ${sip.a_order ?? '?'}/${sip.b_order ?? '?'} about CRPIX (${cr1}, ${cr2})`,
    f: (x, y) => {
      const u = x - cr1;
      const v = y - cr2;
      return Math.hypot(sipPolyEval(sip.a, u, v), sipPolyEval(sip.b, u, v));
    },
  };
}

function tpsStage(receipt) {
  const key = STAGE_KEYS[3];
  const label = 'TPS';
  const tps = receipt?.solution?.astrometry?.tps;
  if (!tps) {
    return absent(key, label,
      'solution.astrometry.tps absent — the manifest schema declares TPS slots (calibration_manifest.tps_weights) but no receipt producer emits a TPS block today');
  }
  // Field names per the unified_calibration.wgsl CalibrationCoeffs struct
  // (accept them with or without the tps_ prefix). Shape mismatches are
  // reported, not repaired.
  const pick = (name) => tps[name] ?? tps[`tps_${name}`];
  const ax = pick('affine_x');
  const ay = pick('affine_y');
  const anx = pick('anchors_x');
  const any_ = pick('anchors_y');
  const wx = pick('weights_x');
  const wy = pick('weights_y');
  const n = Array.isArray(anx) ? anx.length : 0;
  const shapeOk =
    Array.isArray(ax) && ax.length >= 3 &&
    Array.isArray(ay) && ay.length >= 3 &&
    n > 0 &&
    Array.isArray(any_) && any_.length === n &&
    Array.isArray(wx) && wx.length === n &&
    Array.isArray(wy) && wy.length === n;
  if (!shapeOk) {
    return absent(key, label,
      'tps block present but its shape does not match the unified_calibration.wgsl CalibrationCoeffs contract (anchors_x/y + weights_x/y + affine_x/y[3])');
  }
  // unified_calibration.wgsl::u_tps — U(0) = 0 by definition.
  const U = (r) => (r === 0 ? 0 : r * r * Math.log(r));
  return {
    key, label, status: 'measured',
    note: `${n} anchors`,
    // evaluate_tps per axis: affine minus identity, plus the RBF sum.
    f: (x, y) => {
      let dx = ax[0] + ax[1] * x + ax[2] * y - x;
      let dy = ay[0] + ay[1] * x + ay[2] * y - y;
      for (let i = 0; i < n; i++) {
        const r = Math.hypot(x - anx[i], y - any_[i]);
        const u = U(r);
        dx += wx[i] * u;
        dy += wy[i] * u;
      }
      return Math.hypot(dx, dy);
    },
  };
}

/* ── grid sampling ──────────────────────────────────────────────────────── */

function sampleField(f, W, H, n) {
  const heights = new Float32Array(n * n);
  let peak = 0;
  let peakX = 0;
  let peakY = 0;
  let nonFinite = 0;
  for (let iy = 0; iy < n; iy++) {
    const y = (iy * (H - 1)) / (n - 1);
    for (let ix = 0; ix < n; ix++) {
      const x = (ix * (W - 1)) / (n - 1);
      let d = f(x, y);
      if (!Number.isFinite(d)) { d = 0; nonFinite++; }
      heights[iy * n + ix] = d;
      if (d > peak) { peak = d; peakX = x; peakY = y; }
    }
  }
  // HONEST PER-STAGE SCALE: each stage is normalized to its OWN peak, and the
  // peak px value is annotated in the UI. A zero-peak field stays flat zeros.
  if (peak > 0) {
    for (let i = 0; i < heights.length; i++) heights[i] /= peak;
  }
  return { heights, peakPx: peak, peakAt: [peakX, peakY], nonFinite };
}

/**
 * Evaluate all four cascade stages on an n×n grid over the receipt's frame.
 * Returns { frame:{W,H}, gridN, evalMs, stages:[4] } or { error } when the
 * receipt cannot even establish the pixel grid.
 */
export function evaluateStages(receipt, gridN) {
  const W = receipt?.metadata?.width;
  const H = receipt?.metadata?.height;
  if (!(Number.isFinite(W) && W > 1 && Number.isFinite(H) && H > 1)) {
    return { error: 'receipt.metadata.width/height absent — cannot lay out the pixel grid' };
  }
  const t0 = performance.now();
  const defs = [
    nominalStage(receipt, W, H),
    measuredStage(receipt, W, H),
    sipStage(receipt),
    tpsStage(receipt),
  ];
  const stages = defs.map((d) => {
    if (d.status !== 'measured') return d;
    const { f, ...rest } = d;
    const s = sampleField(f, W, H, gridN);
    if (s.nonFinite > 0) {
      rest.note = `${rest.note ? rest.note + ' · ' : ''}${s.nonFinite} non-finite samples zeroed`;
    }
    return { ...rest, heights: s.heights, peakPx: s.peakPx, peakAt: s.peakAt };
  });
  return { frame: { W, H }, gridN, evalMs: performance.now() - t0, stages };
}
