#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/analytics/residuals_test.mjs — node-runnable (underscore idiom; NOT
// vitest-collected). Run: node tools/analytics/residuals_test.mjs
//
// Exercises the edge-residual instrument on SYNTHETIC residual fields with known
// ground truth: a FLAT field (no radial structure) vs an INJECTED radial-growth
// field residual = a + b·radius_norm, so the recovered slope MUST equal b and
// the center→edge excess MUST be positive. Plus honest-absence rows, the
// per-bin floor, determinism, spec-driven thresholds, and rig/scale grouping.
// ═══════════════════════════════════════════════════════════════════════════

import assert from 'node:assert/strict';
import {
  DEFAULT_SPEC, resolveSpec, analyzeFrame, analyzeResiduals,
} from './residuals.mjs';

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, `${msg} (got ${a}, want ${b}±${eps})`); }

// ── synthetic frame builder ───────────────────────────────────────────────────
// Places a grid of stars across a WxH frame and sets each star's residual via
// residualFn(radius_norm), where radius_norm is computed EXACTLY as the core
// does (dist-from-center / half-diagonal). Returns a frame record shaped like a
// corpus frame (receipt.solution.matched_stars + dims + metadata).
function synthFrame({ id, grid = 14, width = 1000, height = 1000, pixel_scale = 2.0,
  rig = { camera_model: 'SynthCam', lens_model: 'SynthLens' }, residualFn }) {
  const cx = width / 2, cy = height / 2;
  const halfDiag = 0.5 * Math.hypot(width, height);
  const stars = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      // spread across [0,W]×[0,H] with a small inset so corners reach r≈1
      const x = (i + 0.5) / grid * width;
      const y = (j + 0.5) / grid * height;
      const r = Math.hypot(x - cx, y - cy) / halfDiag;
      stars.push({ x, y, residual_arcsec: residualFn(r), mag: 10, flux: 100, fwhm: 3 });
    }
  }
  return {
    key: `file:${id}`, id, sha: null, kind: 'solved',
    dims: { width, height },
    receipt: {
      metadata: { ...rig, pixel_scale, width, height },
      solution: { pixel_scale, matched_stars: stars },
    },
  };
}

const SPEC = resolveSpec();

// ── (1) FLAT field: no radial structure ───────────────────────────────────────
{
  const f = synthFrame({ id: 'flat', residualFn: () => 3.0 });
  const a = analyzeFrame(f, SPEC);
  ok(a.measured === true, 'flat: measured');
  near(a.slope_arcsec_per_radius, 0, 1e-9, 'flat: slope ~0');
  near(a.edge_excess_arcsec, 0, 1e-9, 'flat: edge_excess ~0');
  ok(a.distortion_signature.flagged === false, 'flat: NOT flagged');
  // constant y → r2 undefined (no y-variance) → honest null, not a fabricated 1
  ok(a.r2 === null, 'flat: r2 null (no residual variance)');
  // every profile bin has the same median (3.0)
  for (const p of a.profile) { if (p.median !== null) near(p.median, 3.0, 1e-9, 'flat: bin median 3.0'); }
}

// ── (2) INJECTED radial growth: residual = a + b·r ────────────────────────────
{
  const A = 1.0, B = 20.0;
  const f = synthFrame({ id: 'radial', residualFn: (r) => A + B * r });
  const a = analyzeFrame(f, SPEC);
  ok(a.measured === true, 'radial: measured');
  // exact linear law → slope recovers B, intercept recovers A, r2 == 1
  near(a.slope_arcsec_per_radius, B, 1e-6, 'radial: slope recovers B=20');
  near(a.intercept_arcsec, A, 1e-6, 'radial: intercept recovers A=1');
  near(a.r2, 1.0, 1e-9, 'radial: r2 == 1 for exact line');
  ok(a.edge_excess_arcsec > 2.0, 'radial: edge_excess positive & > threshold');
  ok(a.edge_median_arcsec > a.center_median_arcsec, 'radial: edge median > center median');
  ok(a.distortion_signature.flagged === true, 'radial: FLAGGED');
  // binned profile medians strictly increase with radius (monotone growth)
  const meds = a.profile.filter((p) => p.median !== null).map((p) => p.median);
  for (let i = 1; i < meds.length; i++) ok(meds[i] > meds[i - 1], 'radial: profile monotone up');
  // pixel twin: edge_excess_px == edge_excess_arcsec / pixel_scale
  near(a.edge_excess_px, a.edge_excess_arcsec / 2.0, 1e-9, 'radial: pixel twin = arcsec/scale');
  // slope in pixels == slope_arcsec / pixel_scale
  near(a.slope_px_per_radius, B / 2.0, 1e-6, 'radial: slope_px = slope_arcsec/scale');
}

// ── (3) threshold comes from the SPEC, never hardcoded ────────────────────────
{
  const f = synthFrame({ id: 'radial2', residualFn: (r) => 1 + 20 * r });
  // raise the slope threshold above the true slope → must NOT flag
  const strict = resolveSpec({ distortion_slope_threshold_arcsec_per_radius: 1000 });
  const a = analyzeFrame(f, strict);
  ok(a.distortion_signature.flagged === false, 'spec threshold: high slope threshold suppresses flag');
  ok(a.distortion_signature.thresholds.slope_arcsec_per_radius === 1000, 'spec threshold echoed in row');
  // and a permissive threshold flags a gentle slope the default would miss
  const gentle = synthFrame({ id: 'gentle', residualFn: (r) => 5 + 1.0 * r });
  const permissive = resolveSpec({ distortion_slope_threshold_arcsec_per_radius: 0.5, distortion_edge_excess_threshold_arcsec: 0.1 });
  ok(analyzeFrame(gentle, permissive).distortion_signature.flagged === true, 'spec threshold: permissive flags gentle slope');
  ok(analyzeFrame(gentle, SPEC).distortion_signature.flagged === false, 'default threshold: gentle slope not flagged');
}

// ── (4) honest absence: no matched_stars → NOT MEASURED ───────────────────────
{
  const noSolve = { key: 'file:ns', id: 'ns', sha: null, kind: 'no_solve', dims: null, receipt: null };
  const a = analyzeFrame(noSolve, SPEC);
  ok(a.measured === false, 'no_solve: NOT measured');
  ok(/^NOT MEASURED/.test(a.reason), 'no_solve: reason starts NOT MEASURED');
  ok(/no matched_stars/.test(a.reason), 'no_solve: reason names absent stars');
}

// ── (5) honest absence: dims missing → cannot normalize radius ────────────────
{
  const f = synthFrame({ id: 'nodims', residualFn: (r) => 1 + 20 * r });
  f.dims = null; // strip dims → core cannot compute radius_norm
  const a = analyzeFrame(f, SPEC);
  ok(a.measured === false, 'nodims: NOT measured');
  ok(/dims absent/.test(a.reason), 'nodims: reason names dims');
}

// ── (6) min_stars floor → NOT MEASURED with count in reason ───────────────────
{
  const f = synthFrame({ id: 'sparse', grid: 4, residualFn: (r) => 1 + 20 * r }); // 16 stars < 20
  const a = analyzeFrame(f, SPEC);
  ok(a.measured === false, 'sparse: NOT measured (below min_stars)');
  ok(/below|min_stars/.test(a.reason), 'sparse: reason names min_stars');
  ok(a.n_stars_used === 16, 'sparse: reports usable count 16');
}

// ── (7) per-bin floor → sparse bin gets null stats (not fabricated zero) ───────
{
  // dense center, exactly 2 stars in the far-edge region → outer bin below floor.
  const width = 1000, height = 1000, cx = 500, cy = 500;
  const halfDiag = 0.5 * Math.hypot(width, height);
  const stars = [];
  // 40 stars clustered near center (r ~0.0–0.35)
  for (let k = 0; k < 40; k++) {
    const ang = k * 0.618 * 2 * Math.PI;
    const rr = 0.02 + 0.33 * (k / 40);
    const d = rr * halfDiag;
    stars.push({ x: cx + d * Math.cos(ang), y: cy + d * Math.sin(ang), residual_arcsec: 2.0 });
  }
  // 2 stars far out (r ~0.95) → land in the last bin, below min_stars_per_bin(4)
  stars.push({ x: cx + 0.95 * halfDiag, y: cy, residual_arcsec: 50 });
  stars.push({ x: cx, y: cy + 0.95 * halfDiag, residual_arcsec: 50 });
  const f = { key: 'file:floor', id: 'floor', sha: null, kind: 'solved', dims: { width, height },
    receipt: { metadata: { camera_model: 'C', lens_model: 'L', pixel_scale: 2 }, solution: { pixel_scale: 2, matched_stars: stars } } };
  const a = analyzeFrame(f, SPEC);
  ok(a.measured === true, 'floor: measured (42 stars)');
  const last = a.profile[a.profile.length - 1];
  ok(last.n === 2, 'floor: outer bin has n=2');
  ok(last.median === null, 'floor: outer bin median NULL (below per-bin floor)');
  ok(a.profile.length === SPEC.radius_bins, 'floor: bin count == radius_bins');
}

// ── (8) corpus-level: ranking, grouping, determinism ──────────────────────────
{
  const frames = [
    synthFrame({ id: 'a_flat', residualFn: () => 3, rig: { camera_model: 'CamX', lens_model: 'LensX' }, pixel_scale: 2 }),
    synthFrame({ id: 'b_radial', residualFn: (r) => 1 + 20 * r, rig: { camera_model: 'CamX', lens_model: 'LensX' }, pixel_scale: 2 }),
    synthFrame({ id: 'c_radial_big', residualFn: (r) => 1 + 40 * r, rig: { camera_model: 'CamY', lens_model: 'LensY' }, pixel_scale: 0.7 }),
    { key: 'file:d_ns', id: 'd_ns', sha: null, kind: 'no_solve', dims: null, receipt: null },
  ];
  const d = analyzeResiduals(frames, SPEC);
  ok(d.summary.frames_total === 4, 'corpus: 4 frames total');
  ok(d.summary.frames_measured === 3, 'corpus: 3 measured');
  ok(d.summary.frames_not_measured === 1, 'corpus: 1 not measured');
  ok(d.summary.frames_flagged === 2, 'corpus: 2 flagged (both radial)');
  // refit ranking: bigger growth ranks first; flat frame absent (excess≈0, not >0)
  ok(d.refit_candidates.length === 2, 'corpus: 2 refit candidates (radials only)');
  ok(d.refit_candidates[0].id === 'c_radial_big', 'corpus: biggest growth ranked #1');
  ok(d.refit_candidates[0].rank === 1 && d.refit_candidates[1].rank === 2, 'corpus: ranks sequential');
  ok(d.refit_candidates[0].edge_excess_arcsec >= d.refit_candidates[1].edge_excess_arcsec, 'corpus: ranked by edge_excess desc');
  // per-rig grouping: two rigs, sorted
  ok(d.per_rig.length === 2, 'corpus: two rig groups');
  ok(d.per_rig[0].rig < d.per_rig[1].rig, 'corpus: rig groups sorted');
  const rigX = d.per_rig.find((g) => g.rig.includes('CamX'));
  ok(rigX.n_frames === 2 && rigX.n_flagged === 1, 'corpus: CamX has 2 frames, 1 flagged');
  // per-scale grouping ordered by bin index ascending
  for (let i = 1; i < d.per_scale.length; i++) ok(d.per_scale[i].bin_index > d.per_scale[i - 1].bin_index, 'corpus: scale bins ascending');
  // determinism: same input → byte-identical serialization
  ok(JSON.stringify(analyzeResiduals(frames, SPEC)) === JSON.stringify(d), 'corpus: deterministic');
}

// ── (9) resolveSpec validation & defaults ─────────────────────────────────────
{
  const d = resolveSpec();
  ok(d.radius_bins === DEFAULT_SPEC.radius_bins, 'spec: default radius_bins');
  // bad inputs fall back (honest, no silent NaN)
  const bad = resolveSpec({ radius_bins: -3, center_edge_split: 5, min_stars: 0, distortion_slope_threshold_arcsec_per_radius: 'x' });
  ok(bad.radius_bins === DEFAULT_SPEC.radius_bins, 'spec: bad radius_bins → default');
  ok(bad.center_edge_split === DEFAULT_SPEC.center_edge_split, 'spec: bad split → default');
  ok(bad.min_stars === DEFAULT_SPEC.min_stars, 'spec: bad min_stars → default');
  ok(bad.distortion_slope_threshold_arcsec_per_radius === DEFAULT_SPEC.distortion_slope_threshold_arcsec_per_radius, 'spec: bad slope thr → default');
  // scale bins get sorted ascending
  const sb = resolveSpec({ scale_bin_edges_arcsec_per_px: [4, 1, 8, 2] });
  ok(JSON.stringify(sb.scale_bin_edges_arcsec_per_px) === JSON.stringify([1, 2, 4, 8]), 'spec: scale bins sorted');
  // custom rig fields honored
  const rf = resolveSpec({ rig_key_fields: ['camera_model'] });
  ok(rf.rig_key_fields.length === 1 && rf.rig_key_fields[0] === 'camera_model', 'spec: custom rig fields');
}

// ── (10) rig_key_fields actually drives the rig label ─────────────────────────
{
  const f = synthFrame({ id: 'rigtest', residualFn: (r) => 1 + 20 * r, rig: { camera_model: 'CamZ', lens_model: 'LensZ' } });
  const a1 = analyzeFrame(f, resolveSpec({ rig_key_fields: ['camera_model'] }));
  ok(a1.rig === 'CamZ', 'rig: single-field label');
  const a2 = analyzeFrame(f, resolveSpec({ rig_key_fields: ['camera_model', 'lens_model'] }));
  ok(a2.rig === 'CamZ | LensZ', 'rig: joined label');
}

console.log(`residuals_test: ${passed} assertions passed`);
