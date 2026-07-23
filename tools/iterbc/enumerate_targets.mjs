#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ITERATIVE-BC lane — LEG 1: banked-data-first forced-harvest target enumeration
// ═══════════════════════════════════════════════════════════════════════════
// Proves the loop's per-iteration bookkeeping DETERMINISTICALLY, with zero live
// compute and zero engine edits. Given a banked receipt (WCS + measured
// Brown-Conrady map) and a banked catalog cone (linear-projected pixel positions
// + matched flags), it enumerates the forced-harvest target list the loop would
// generate at a given BC anchor, and reports radial coverage — the corner
// instrument's book (ADDENDUM 2026-07-18: forced harvest through the CURRENT
// distortion fit generates corner truth the recall report could not).
//
// The loop's target-enumeration STEP (spec step 4, the early forced positional
// harvest) is a pure function of (catalog cone, current BC map). This proves it:
//  - re-run byte-stable (verify_deterministic.mjs md5-diffs two runs);
//  - two REAL BC anchors (nominal/identity k1=k2=0, and the receipt's measured
//    BC) bracket what a live iteration's refit moves — no fabricated per-iter k1.
//
// USAGE:
//   node tools/iterbc/enumerate_targets.mjs \
//     [--receipt <path to receipt.json>] [--catalog <miss_population.json>] \
//     [--frame M66] [--out <ledger.json>]
// Defaults point at the main-checkout banked artifacts (absolute), so the lane
// runs unchanged from a worktree.

import fs from 'fs';
import path from 'path';
import {
  makeBrownConrady, makeTanProjector, normRadius,
  radialBinLabel, emptyRadialHistogram, r6, stableStringify, dedupByKey,
} from './bc_math.mjs';

const MAIN = 'K:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY';
const DEFAULTS = {
  receipt: `${MAIN}/test_results/deep_cones/m66.receipt.json`,
  catalog: `${MAIN}/test_results/m4_recall_2026-07-18/miss_population.json`,
  frame: 'M66',
  out: `${MAIN}/test_results/iterbc_2026-07-21/m66_targets_ledger.json`,
};

function parseArgs(argv) {
  const a = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--receipt') a.receipt = argv[++i];
    else if (k === '--catalog') a.catalog = argv[++i];
    else if (k === '--frame') a.frame = argv[++i];
    else if (k === '--out') a.out = argv[++i];
  }
  return a;
}

/** Strip catalog-prefix so receipt "Gaia_123"/"HYG_45" joins miss_population "123". */
function bareId(id) {
  if (id == null) return null;
  return String(id).replace(/^(Gaia_|HYG_)/, '');
}

function frameDims(receipt) {
  const m = receipt.metadata || {};
  const s = receipt.scales || {};
  const w = m.width ?? s.sensor_width ?? s.preview_width;
  const h = m.height ?? s.sensor_height ?? s.preview_height;
  if (!(w > 0 && h > 0)) throw new Error('frameDims: could not resolve frame dimensions from receipt');
  return { w, h };
}

/**
 * Enumerate forced-harvest targets for the unmatched catalog stars at ONE BC
 * anchor. `bc` is a Brown-Conrady model (or identity for the nominal anchor).
 * Each cone star's linear pred (from the catalog cone) is mapped through
 * bc.toNative -> the native pixel where the star appears (the forced-measure
 * position). Returns a deterministic, id-sorted list + coverage histogram.
 */
function enumerateAnchor(cone, bc, W, H) {
  const out = [0, 0];
  const targets = [];
  const coverage = emptyRadialHistogram();
  let inBounds = 0;
  let maxShift = 0;
  let sumShift = 0;
  for (const s of cone) {
    // Harvest addresses the UNMATCHED cone. `miss_population.matched` is the
    // report's authoritative per-catalog-star match determination (catalog star
    // vs the solve's matched detections). Receipt gaia_id join is NOT usable —
    // 19-digit Gaia source IDs exceed JS safe-int range and lose precision
    // differently in each artifact, so we trust the cone's own flag.
    if (s.matched === true) continue;
    const lx = s.pred_x;
    const ly = s.pred_y;
    if (!Number.isFinite(lx) || !Number.isFinite(ly)) continue;
    bc.toNative(lx, ly, out);
    const bx = out[0];
    const by = out[1];
    const shift = Math.hypot(bx - lx, by - ly);
    const rn = normRadius(bx, by, W, H);
    const inb = bx >= 0 && bx < W && by >= 0 && by < H;
    if (inb) {
      inBounds++;
      coverage[radialBinLabel(rn)]++;
      if (shift > maxShift) maxShift = shift;
      sumShift += shift;
    }
    targets.push({
      star_id: bareId(s.star_id),
      cat_mag: r6(s.cat_mag),
      r_norm: r6(rn),
      linear_x: r6(lx),
      linear_y: r6(ly),
      bc_x: r6(bx),
      bc_y: r6(by),
      bc_shift_px: r6(shift),
      in_bounds: inb,
      already_detected: s.detected === true,
      forced_recovered: s.forced_recovered === true,
    });
  }
  // Deterministic order: by star_id (string), nulls last, then by linear_x/linear_y.
  targets.sort((a, b) => {
    const ai = a.star_id == null ? 1 : 0;
    const bi = b.star_id == null ? 1 : 0;
    if (ai !== bi) return ai - bi;
    if (a.star_id !== b.star_id) return (a.star_id ?? '') < (b.star_id ?? '') ? -1 : 1;
    if (a.linear_x !== b.linear_x) return a.linear_x - b.linear_x;
    return a.linear_y - b.linear_y;
  });
  return {
    harvest_targets: targets.length,
    in_bounds: inBounds,
    max_bc_shift_px: r6(maxShift),
    mean_bc_shift_px: inBounds ? r6(sumShift / inBounds) : 0,
    radial_coverage: coverage,
    targets,
  };
}

/** Validation: my TAN projector vs the engine's own numbers (convention anchor). */
function validate(receipt, project, W, H) {
  const ms = receipt.solution.matched_stars || [];
  let rms = 0;
  let n = 0;
  let centerRes = null;
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  const hd = Math.hypot(cx, cy);
  let bestR = Infinity;
  for (const s of ms) {
    if (s.ra_deg == null || s.dec_deg == null) continue;
    const [px, py] = project(s.ra_deg, s.dec_deg);
    const d = Math.hypot(px - s.x, py - s.y);
    rms += d * d;
    n++;
    const rn = Math.hypot(s.x - cx, s.y - cy) / hd;
    if (rn < bestR) { bestR = rn; centerRes = r6(d); }
  }
  const rec = (receipt.solution.bc_rematch && receipt.solution.bc_rematch.recovered_stars) || [];
  const recoveredCheck = rec.map((s) => {
    const [px, py] = project(s.ra_hours * 15, s.dec_degrees);
    return {
      id: s.gaia_id,
      engine_x: r6(s.x), engine_y: r6(s.y),
      proj_x: r6(px), proj_y: r6(py),
      dist_px: r6(Math.hypot(px - s.x, py - s.y)),
      snr: r6(s.snr),
    };
  });
  return {
    matched_projection_center_residual_px: centerRes,
    matched_projection_rms_px: n ? r6(Math.sqrt(rms / n)) : null,
    matched_n: n,
    note: 'RMS carries the un-applied forward-SIP term (linear TAN only); the engine forced-harvest projector is likewise linear + aperture tolerance — the residual is absorbed by the forced aperture, never silently corrected.',
    forced_recovered_check: recoveredCheck,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const receipt = JSON.parse(fs.readFileSync(args.receipt, 'utf8'));
  const catalogAll = JSON.parse(fs.readFileSync(args.catalog, 'utf8'));
  const coneRaw = (Array.isArray(catalogAll) ? catalogAll : []).filter((r) => r.frame_id === args.frame);
  const cone = dedupByKey(coneRaw, 'star_id'); // collapse overlapping depth slices
  if (cone.length === 0) throw new Error(`no catalog cone rows for frame=${args.frame} in ${args.catalog}`);

  const { w: W, h: H } = frameDims(receipt);
  const ld = receipt.lens_distortion_measured || {};
  const k1 = ld.k1 ?? 0;
  const k2 = ld.k2 ?? 0;
  const project = makeTanProjector(receipt.wcs);

  const nominal = makeBrownConrady(0, 0, W, H); // identity anchor
  const measured = makeBrownConrady(k1, k2, W, H);

  const matched = cone.filter((r) => r.matched === true).length;
  const unmatched = cone.length - matched;
  const receiptMatched = (receipt.solution.matched_stars || []).length;

  const anchorNominal = enumerateAnchor(cone, nominal, W, H);
  const anchorMeasured = enumerateAnchor(cone, measured, W, H);

  // Per-radial-bin BC shift (corner instrument signal): does the shift grow outward?
  const shiftByBin = {};
  for (const t of anchorMeasured.targets) {
    if (!t.in_bounds) continue;
    const bin = radialBinLabel(t.r_norm);
    if (!shiftByBin[bin]) shiftByBin[bin] = { n: 0, sum: 0, max: 0 };
    shiftByBin[bin].n++;
    shiftByBin[bin].sum += t.bc_shift_px;
    if (t.bc_shift_px > shiftByBin[bin].max) shiftByBin[bin].max = t.bc_shift_px;
  }
  const bcShiftByRadialBin = {};
  for (const bin of Object.keys(emptyRadialHistogram())) {
    const b = shiftByBin[bin];
    bcShiftByRadialBin[bin] = b ? { n: b.n, mean_shift_px: r6(b.sum / b.n), max_shift_px: r6(b.max) } : { n: 0, mean_shift_px: 0, max_shift_px: 0 };
  }

  const ledger = {
    schema: 'iterbc.targets.v0',
    generated_by: 'tools/iterbc/enumerate_targets.mjs',
    frame: args.frame,
    inputs: {
      receipt: path.basename(args.receipt),
      catalog: path.basename(args.catalog),
    },
    frame_dims: { w: W, h: H },
    bc_map: { model: 'brown-conrady', k1: r6(k1), k2: r6(k2), cx: r6((W - 1) / 2), cy: r6((H - 1) / 2), halfDiagPx: r6(Math.hypot((W - 1) / 2, (H - 1) / 2)) },
    catalog_total: cone.length,
    catalog_rows_raw: coneRaw.length,
    dedup_note: `deduped by star_id (${coneRaw.length} raw rows -> ${cone.length} unique; miss_population carries overlapping G<17 ⊂ G<19.5 depth slices)`,
    matched,
    unmatched,
    matched_source: 'miss_population.matched (report authoritative catalog-vs-solve match flag); receipt gaia_id join is precision-unsafe',
    receipt_matched_stars: receiptMatched,
    anchors: {
      nominal: {
        harvest_targets: anchorNominal.harvest_targets,
        in_bounds: anchorNominal.in_bounds,
        max_bc_shift_px: anchorNominal.max_bc_shift_px,
        mean_bc_shift_px: anchorNominal.mean_bc_shift_px,
        radial_coverage: anchorNominal.radial_coverage,
      },
      measured_bc: {
        harvest_targets: anchorMeasured.harvest_targets,
        in_bounds: anchorMeasured.in_bounds,
        max_bc_shift_px: anchorMeasured.max_bc_shift_px,
        mean_bc_shift_px: anchorMeasured.mean_bc_shift_px,
        radial_coverage: anchorMeasured.radial_coverage,
      },
    },
    bc_shift_by_radial_bin: bcShiftByRadialBin,
    validation: {
      convention: validate(receipt, project, W, H),
    },
    // Full target list at the measured-BC anchor (the loop's actual harvest list).
    targets: anchorMeasured.targets,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, stableStringify(ledger));
  // Terse stdout summary (numbers only; no fabricated values).
  const v = ledger.validation.convention;
  console.log(`[iterbc/enumerate] frame=${args.frame} dims=${W}x${H} k1=${k1} k2=${k2}`);
  console.log(`  catalog=${cone.length} matched=${matched} unmatched=${unmatched}`);
  console.log(`  harvest targets (measured BC): ${anchorMeasured.harvest_targets} (in-bounds ${anchorMeasured.in_bounds}), max shift ${anchorMeasured.max_bc_shift_px}px mean ${anchorMeasured.mean_bc_shift_px}px`);
  console.log(`  convention: center residual ${v.matched_projection_center_residual_px}px, matched RMS ${v.matched_projection_rms_px}px (n=${v.matched_n}); recovered-star reproj dists ${v.forced_recovered_check.map((r) => r.dist_px).join('/')}px`);
  console.log(`  ledger -> ${args.out}`);
  return ledger;
}

main();
