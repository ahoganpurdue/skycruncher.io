// lib/flatten.mjs — shared receipt/crash flattener for the results ETL lane.
// ============================================================================
// SINGLE SOURCE OF TRUTH for the receipt-field -> parquet-column flatten. Imported
// by BOTH the full ETL (etl_receipts.mjs) and the incremental drain
// (drain_to_r2.mjs) so the flatten logic lives in exactly ONE place (CLAUDE.md
// LAW 4 — no code in two places). The column mapping is documented in README.md.
//
// EVIDENCE-ONLY (LAW 3): every column is either MEASURED from a receipt field or
// honest-NULL. Nothing is fabricated.
//
// UNIT TRAPS carried through verbatim (CLAUDE.md):
//   - frames.ra_hours          = solution.ra_hours   -> HOURS (internal convention)
//   - frames.crval1_deg        = wcs.CRVAL1          -> DEGREES (FITS boundary)
//   - frames.pixel_scale_arcsec_px = solution.pixel_scale -> arcsec/px
//   - stars.ra_deg/dec_deg     = matched_stars ra_deg/dec_deg -> DEGREES
//   - parity stored as text; sign NOT asserted.
// ============================================================================

import path from 'node:path';
import { createHash } from 'node:crypto';

// ---- coercion helpers (honest-or-absent) -----------------------------------
export function num(v) { if (v === null || v === undefined) return null; const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : null; }
export function int(v) { const n = num(v); return n === null ? null : Math.trunc(n); }
export function bool(v) { if (v === true || v === false) return v; if (v === undefined || v === null) return null; return null; }
export function str(v) { if (v === null || v === undefined) return null; if (typeof v === 'string') return v; if (typeof v === 'number' || typeof v === 'boolean') return String(v); return null; }
export function jstr(v) { if (v === null || v === undefined) return null; try { return JSON.stringify(v); } catch { return null; } }
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

export function classifyKind(j) {
  if (j.__fixture !== undefined) return 'render_fixture';
  if (j.NO_OP_REASON !== undefined || j.RENDER_APPLY_SIP_flag !== undefined) return 'render_wiring';
  if (j.ledger !== undefined && j.legs !== undefined && j.solution === undefined) return 'calibration';
  if (j.kind !== undefined && typeof j.kind === 'string') return j.kind; // 'no_solve' etc.
  if (j.failure) return 'no_solve';
  if (j.solution !== undefined) return 'solve';
  return 'unknown';
}

// derive the input basename from the receipt filename (strip known suffixes)
export function inputBasename(receiptBase) {
  return receiptBase
    .replace(/\.receipt\.json$/i, '')
    .replace(/\.(blind|baseline|native)$/i, '');
}

// ---- frame-row flatten -----------------------------------------------------
export function flattenFrame(j, meta) {
  const sol = j.solution || {};
  const wcs = j.wcs || {};
  const cs = j.confirm_status || {};
  const dc = j.deep_confirmed || {};
  const md = j.metadata || {};
  const repro = j.reproducibility || {};
  const pipe = j.pipeline_provenance || {};
  const hw = j.hardware || {};
  const fail = j.failure || {};
  const rwSolve = j.solve || {}; // render_wiring receipts carry a `solve` block

  // Sky-condition block: `signal` on solve receipts (full detector output), or the
  // `detection` SUMMARY block on no-solve receipts (background_level/noise_floor/
  // culling_tally only — clean_stars/anomalies there are COUNTS, not arrays).
  const cb = j.signal || j.detection || {};
  const mw = cb.milky_way; // array of {x,y,brilliance} hotspots (present flag = length>0)
  const mwPresent = Array.isArray(mw) ? mw.length > 0 : null;
  const mwN = Array.isArray(mw) ? mw.length : null;
  const bgTop = num(cb.background_level_top);
  const bgBot = num(cb.background_level_bottom);
  const cfa = cb.cfa_verdict; // object {klass,supported,phaseSpread…} or undefined

  const solved = Number.isFinite(num(sol.ra_hours)) && meta.kind !== 'no_solve';

  // config_overrides: present flag + stable hash
  const co = j.config_overrides;
  const coPresent = co !== null && co !== undefined && !(typeof co === 'object' && Object.keys(co).length === 0);
  const coHash = coPresent ? sha256(Buffer.from(stableStringify(co))) : null;

  // frame identity: prefer receipt-stamped frame_sha256, else path+size surrogate
  let frame_sha256 = str(j.frame_sha256);
  let identity_basis = frame_sha256 ? 'receipt_stamped' : 'path+size';
  let frame_identity_fallback = frame_sha256 ? null : `${meta.receipt_path}|${meta.receipt_bytes}`;

  return {
    receipt_sha256: meta.receipt_sha256,
    schema_version: meta.schema_version,
    receipt_kind: meta.kind,
    source_root: meta.source_root,
    receipt_path: meta.receipt_path,
    receipt_basename: meta.receipt_basename,
    receipt_bytes: meta.receipt_bytes,
    input_basename: inputBasename(meta.receipt_basename),
    frame_sha256,
    identity_basis,
    frame_identity_fallback,
    engine_version: str(repro.engine_version),
    engine_build_identity: jstr(repro.build_identity),
    effective_config_hash: str(repro.effective_config_hash),
    solved,
    solved_via: str((j.solve_provenance || {}).solved_via),
    source_format: str(j.source_format) || str(md.source_format),
    decoder_arm: str(pipe.decoder_arm) || str(repro.decoder_arm),
    atlas_id: str(pipe.atlas_id),
    // --- solve scalars (UNIT TRAPS documented above) ---
    ra_hours: num(sol.ra_hours) ?? num(rwSolve.ra_hours),
    dec_degrees: num(sol.dec_degrees) ?? num(rwSolve.dec_degrees),
    pixel_scale_arcsec_px: num(sol.pixel_scale) ?? num(rwSolve.pixel_scale),
    roll_degrees: num(sol.roll_degrees),
    parity: str(sol.parity),
    confidence: num(sol.confidence) ?? num(rwSolve.confidence),
    stars_matched: int(sol.stars_matched) ?? int(rwSolve.stars_matched),
    fov_width_deg: num(sol.fov_width_deg),
    fov_height_deg: num(sol.fov_height_deg),
    mean_fwhm_px: num(sol.mean_fwhm_px),
    mean_residual_arcsec: num(sol.mean_residual_arcsec),
    solve_time_ms: num(sol.solve_time_ms),
    crval1_deg: num(wcs.CRVAL1),
    crval2_deg: num(wcs.CRVAL2),
    // --- confirm summary ---
    confirm_status: str(cs.status) ?? str(rwSolve.confirm_status),
    confirm_set_excess_z: num(cs.setExcessZ) ?? num(rwSolve.setExcessZ),
    confirm_n_targets: int(cs.nTargets),
    confirm_confirmed: int(cs.confirmed),
    confirm_set_gate_z: num(cs.setGateZ),
    deep_examined: int(dc.examined),
    deep_confirmed_n: int(dc.confirmed),
    deep_set_excess_z: num(dc.setExcessZ),
    deep_set_gate_passed: bool(dc.setGatePassed),
    // --- metadata / rig ---
    camera_model: str(md.camera_model),
    lens_model: str(md.lens_model),
    focal_length: num(md.focal_length),
    iso_gain: num(md.iso_gain),
    exposure_time: num(md.exposure_time),
    pixel_scale_meta: num(md.pixel_scale),
    image_width: int(md.width) ?? int(j.image_width),
    image_height: int(md.height) ?? int(j.image_height),
    gps_lat: num(md.gps_lat),
    gps_lon: num(md.gps_lon),
    obs_timestamp: str(md.timestamp),
    rig: str(md.camera_model) ?? str(hw.inferred_lens) ?? str(j.rig),
    inferred_lens: str(hw.inferred_lens),
    // --- flags / provenance ---
    experimental: (bool(j.experimental) ?? false) || meta.kind === 'render_fixture',
    config_overrides_present: coPresent,
    config_overrides_sha256: coHash,
    failure_stage: str(fail.stage_of_death) ?? str(fail.stage_reached),
    failure_reason: str(fail.reason),
    run_timestamp: str(j.export_date) ?? str(j.produced_at),
    // --- per-star row counts (filled by caller) ---
    n_matched_stars_rows: 0,
    n_photometry_rows: 0,
    n_confirmed_rows: 0,
    duplicate_path_count: 1,
    // --- frame sky-condition context (ADDITIVE 2026-07-17; the detections tier
    //     correlates raw detections against these per-frame conditions) ----------
    background_level: num(cb.background_level),
    noise_floor: num(cb.noise_floor),
    background_level_top: bgTop,                 // signal-only; null on no-solve/detection block
    background_level_bottom: bgBot,              // signal-only; the LP vertical gradient endpoints
    background_gradient: (bgTop !== null && bgBot !== null) ? (bgTop - bgBot) : null, // top-bottom (MEASURED-derived)
    culling_tally_json: jstr(cb.culling_tally),  // full cull budget by reason (superset of persisted anomalies[])
    cfa_verdict_json: jstr(cfa),                 // {klass,supported,phaseSpread…}; 35 receipts, else null
    cfa_klass: str(cfa && typeof cfa === 'object' ? cfa.klass : null), // e.g. 'mono' — sensor-issue signal
    milky_way_present: mwPresent,                // BOOLEAN present flag (null when not measured)
    milky_way_n_hotspots: mwN,                   // # detected milky-way hotspots
    grid_w: int(cb.grid_w),                      // detector background grid; signal-only
    grid_h: int(cb.grid_h),
    cell_size: num(cb.cell_size),
    n_clean_detections: 0,   // filled by caller — # kept (clean_star) detection rows
    n_anomaly_detections: 0, // filled by caller — # rejected (anomaly) detection rows
  };
}

// ---- star-row flatten (union of matched|photometry|confirmed) --------------
function emptyStar(meta, role, idx) {
  return {
    receipt_sha256: meta.receipt_sha256,
    schema_version: meta.schema_version,
    frame_sha256: meta.frame_sha256_for_stars,
    star_role: role,
    star_index: idx,
    catalog_id: null, name: null, ra_deg: null, dec_deg: null,
    x_px: null, y_px: null, flux: null, flux_err: null, fwhm_px: null,
    mag_catalog: null, mag_measured: null, mag_instrumental: null,
    cat_band: null, bv: null, measured_bv: null, snr: null,
    calibrated_mag_err: null, calibrated_status: null, provenance: null,
    residual_arcsec: null, dx_px: null, dy_px: null, dra_arcsec: null, ddec_arcsec: null,
    airmass: null, alt_deg: null, confidence: null, sigma_e: null,
    detected_native: null, peak_rgb_json: null, tests_json: null,
  };
}

export function flattenStars(j, meta, out) {
  const sol = j.solution || {};
  let nMatched = 0, nPhot = 0, nConf = 0;
  // matched stars
  const ms = Array.isArray(sol.matched_stars) ? sol.matched_stars : [];
  for (let i = 0; i < ms.length; i++) {
    const s = ms[i]; const r = emptyStar(meta, 'matched', i);
    r.catalog_id = str(s.gaia_id); r.name = str(s.name);
    r.ra_deg = num(s.ra_deg); r.dec_deg = num(s.dec_deg);
    r.x_px = num(s.x); r.y_px = num(s.y); r.flux = num(s.flux); r.fwhm_px = num(s.fwhm);
    r.mag_catalog = num(s.mag); r.cat_band = str(s.cat_band); r.bv = num(s.bv); r.measured_bv = num(s.measured_bv);
    r.residual_arcsec = num(s.residual_arcsec); r.dx_px = num(s.dx_px); r.dy_px = num(s.dy_px);
    r.dra_arcsec = num(s.dRA_arcsec); r.ddec_arcsec = num(s.dDec_arcsec);
    r.detected_native = bool(s.detected_native); r.peak_rgb_json = jstr(s.peak_rgb);
    out.push(r); nMatched++;
  }
  // photometry stars (SPCC calibrated per-star products)
  const ph = (sol.photometry && Array.isArray(sol.photometry.stars)) ? sol.photometry.stars : [];
  for (let i = 0; i < ph.length; i++) {
    const s = ph[i]; const r = emptyStar(meta, 'photometry', i);
    r.catalog_id = str(s.gaia_id); r.x_px = num(s.x); r.y_px = num(s.y);
    r.flux = num(s.flux); r.flux_err = num(s.flux_err);
    r.mag_catalog = num(s.cat_mag); r.mag_measured = num(s.calibrated_mag); r.mag_instrumental = num(s.m_inst);
    r.cat_band = str(s.cat_band); r.bv = num(s.cat_bp_rp); r.measured_bv = num(s.measured_bv);
    r.snr = num(s.snr); r.calibrated_mag_err = num(s.calibrated_mag_err); r.calibrated_status = str(s.calibrated_status);
    r.provenance = str(s.provenance); r.airmass = num(s.airmass); r.alt_deg = num(s.alt_deg);
    out.push(r); nPhot++;
  }
  // deep-confirmed (forced-photometry) stars
  const dc = j.deep_confirmed || {};
  const conf = Array.isArray(dc.confirmed_stars) ? dc.confirmed_stars : [];
  for (let i = 0; i < conf.length; i++) {
    const s = conf[i]; const r = emptyStar(meta, 'confirmed', i);
    r.catalog_id = str(s.gaia_id); r.x_px = num(s.x); r.y_px = num(s.y);
    r.flux = num(s.flux); r.mag_measured = num(s.mag); r.snr = num(s.snr);
    r.confidence = num(s.confidence); r.sigma_e = num(s.sigma_e); r.tests_json = jstr(s.tests);
    out.push(r); nConf++;
  }
  return { nMatched, nPhot, nConf };
}

// ---- detection-row flatten (raw pre-match detections) ----------------------
// One row per clean_star (KEPT) and per anomaly (REJECTED). The analytical core is
// `matched`: a kept detection is matched=true iff a solution.matched_stars entry
// sits within DETECTION_MATCH_TOL_PX of its (x,y). MEASURED NN distance across a
// 6-frame/6-rig sample was <0.1px (matched_stars carry the exact detection
// centroid), so a 1.0px tolerance is a ~10x safety margin. Unmatched-kept
// detections = the candidate light-pollution / nebulosity / noise / transient
// population the owner wants to study. Anomalies are always matched=false.
export const DETECTION_MATCH_TOL_PX = 1.0;

// spatial hash of matched-star positions -> O(1) within-tolerance test
export function buildMatcher(matchedStars, tol) {
  const cell = Math.max(1, tol);
  const grid = new Map();
  let count = 0;
  for (const m of matchedStars) {
    const mx = num(m.x), my = num(m.y);
    if (mx === null || my === null) continue;
    const k = Math.floor(mx / cell) + ',' + Math.floor(my / cell);
    let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); }
    arr.push([mx, my]); count++;
  }
  const tol2 = tol * tol;
  return {
    count,
    isMatched(x, y) {
      if (x === null || y === null) return false;
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get((cx + dx) + ',' + (cy + dy));
        if (!arr) continue;
        for (const [mx, my] of arr) { const ex = mx - x, ey = my - y; if (ex * ex + ey * ey <= tol2) return true; }
      }
      return false;
    },
  };
}

export function flattenDetections(j, meta, out) {
  const sig = j.signal || {};
  const sol = j.solution || {};
  const clean = Array.isArray(sig.clean_stars) ? sig.clean_stars : [];
  const anom = Array.isArray(sig.anomalies) ? sig.anomalies : [];
  const matched = Array.isArray(sol.matched_stars) ? sol.matched_stars : [];
  const matcher = buildMatcher(matched, DETECTION_MATCH_TOL_PX);
  let nClean = 0, nAnom = 0, nMatched = 0;
  const emit = (s, idx, kept) => {
    const x = num(s.x), y = num(s.y);
    const isM = kept ? matcher.isMatched(x, y) : false;
    if (isM) nMatched++;
    out.push({
      receipt_sha256: meta.receipt_sha256,
      schema_version: meta.schema_version,
      frame_sha256: meta.frame_sha256_for_stars,
      detection_index: idx,          // position within its role array
      detection_id: str(s.id),       // receipt-native detection id
      x, y,
      raw_x: num(s.rawX), raw_y: num(s.rawY),
      flux: num(s.flux), peak: num(s.peak), peak_value: num(s.peak_value),
      fwhm: num(s.fwhm), snr: num(s.snr), sharpness: num(s.sharpness),
      circularity: num(s.circularity), ellipticity: num(s.ellipticity), theta: num(s.theta),
      moment_fwhm_px: num(s.moment_fwhm_px), moment_ellipticity: num(s.moment_ellipticity),
      measured_bv: num(s.measured_bv), mie_index: num(s.mie_index), rayleigh_index: num(s.rayleigh_index),
      peak_rgb_json: jstr(s.peak_rgb),
      kept,                                              // true=clean_stars, false=anomalies
      culling_reason: kept ? null : str(s.culling_reason), // WHY culled (anomalies only)
      matched: isM,                                      // within 1px of a catalog-matched star
    });
  };
  for (let i = 0; i < clean.length; i++) { emit(clean[i], i, true); nClean++; }
  for (let i = 0; i < anom.length; i++) { emit(anom[i], i, false); nAnom++; }
  return { nClean, nAnom, nMatched };
}

// ---- quad-gen flatten (frame-level verdict + per-cluster rows) -------------
// The [QUAD-GEN · schema 2.29.0] receipt block (package.ts buildQuadGenBlock) is the
// LEVER-2 blind generate→judge rung's forensics SUMMARY. Two grains:
//   quad_verdicts — one row per receipt that CARRIES a quad_gen block (verdict +
//                   W4 acceptance + index + budget, plus config/arm provenance).
//   quad_clusters — one row per JUDGED cluster (FULL capture mode only); the day's
//                   most valuable per-cluster odds evidence for bar-recalibration.
// Absent quad_gen block => returns null => NO verdict row, NO cluster rows (honest
// absence, logged as a count by the caller). SLIM capture mode (clusters[] absent)
// => a verdict row with n_clusters=0 and zero cluster rows.
//
// UNIT TRAPS carried through verbatim:
//   - clusters.foot_ra_deg / crval_ra_deg     -> DEGREES (quad-gen works in deg-space)
//   - acceptance.verify.ra_hours              -> HOURS (internal solution convention)
//   - parity stored as INTEGER (raw ±1); sign NOT asserted/interpreted.
//   - scale = arcsec/px.
// The odds/oddsV2/oddsV3 shadows are ABSENT (never null) in the receipt when their
// SOLVER_QUAD_GEN_ODDS* flags are off -> honest-NULL columns here.
export function flattenQuadGen(j, meta, frameRow, clusterOut) {
  const qg = j.quad_gen;
  if (!qg || typeof qg !== 'object') return null; // no block => no verdict row
  const v = qg.verdict || {};
  const acc = (qg.acceptance !== null && qg.acceptance !== undefined) ? qg.acceptance : null;
  const idx = qg.index || {};
  const bud = qg.budget || {};
  const hf = v.hintFallthrough || null;
  const accVerify = (acc && acc.verify) ? acc.verify : {};
  const accSanity = (acc && acc.sanity) ? acc.sanity : {};
  const clusters = Array.isArray(qg.clusters) ? qg.clusters : [];

  const verdictRow = {
    receipt_sha256: meta.receipt_sha256,
    schema_version: meta.schema_version,
    frame_sha256: meta.frame_sha256_for_stars,
    source_root: meta.source_root,
    receipt_path: meta.receipt_path,       // carries the A/B arm dir (e.g. arm_fullstack_uw/…)
    receipt_basename: meta.receipt_basename,
    input_basename: inputBasename(meta.receipt_basename),
    // --- config / arm provenance where recorded (reused from the frame flatten) ---
    decoder_arm: frameRow.decoder_arm,
    atlas_id: frameRow.atlas_id,
    rig: frameRow.rig,
    effective_config_hash: frameRow.effective_config_hash,
    config_overrides_present: frameRow.config_overrides_present,
    config_overrides_sha256: frameRow.config_overrides_sha256,
    solved: frameRow.solved,
    solved_via: frameRow.solved_via,
    // --- quad-gen provenance ---
    qg_pass: str(qg.pass),                  // 'hint' | 'full'
    qg_capture_mode: str(qg.capture && qg.capture.mode), // 'full' | 'slim'
    // --- verdict ---
    verdict_accept: bool(v.accept),         // SHADOW verdict (W4-apply lives in acceptance)
    verdict_reason: str(v.reason),
    verdict_mode: str(v.mode),
    verdict_top_anchored: int(v.top_anchored),
    verdict_second_anchored: int(v.second_anchored),
    verdict_margin: num(v.margin),
    verdict_k: int(v.K),
    verdict_m: int(v.M),
    verdict_unopposed_floor: int(v.unopposed_floor),
    verdict_n_distinct: int(v.n_distinct),
    hint_fallthrough_reason: str(hf && hf.reason),
    hint_fallthrough_top_anchored: int(hf && hf.top_anchored),
    // --- W4 acceptance (null under shadow-only => acceptance_present=false) ---
    acceptance_present: acc !== null,
    acceptance_attempted: bool(acc && acc.attempted),
    acceptance_accepted: bool(acc && acc.accepted),
    acceptance_reason: str(acc && acc.reason),
    acceptance_arbiter: str(acc && acc.arbiter),
    acceptance_verify_matched: int(accVerify.matched),
    acceptance_verify_confidence: num(accVerify.confidence),
    acceptance_verify_ra_hours: num(accVerify.ra_hours),   // UNIT: HOURS
    acceptance_verify_dec_degrees: num(accVerify.dec_degrees),
    acceptance_verify_pixel_scale: num(accVerify.pixel_scale),
    acceptance_sanity_ok: bool(accSanity.ok),
    acceptance_sanity_fail: str(accSanity.fail),
    acceptance_sanity_scale: num(accSanity.scale),
    acceptance_sanity_foot_drift_deg: num(accSanity.footDriftDeg),
    // --- index provenance + budget ---
    index_release: str(idx.release),
    index_bands: int(idx.bands),
    index_stars: int(idx.stars),
    index_quads: int(idx.quads),
    budget_spent_ms: num(bud.spent_ms),
    budget_limit_ms: num(bud.limit_ms),
    budget_truncated: bool(bud.truncated),
    n_clusters: clusters.length,
  };

  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i] || {};
    const pose = (c.pose !== null && c.pose !== undefined) ? c.pose : null;
    const crval = (pose && Array.isArray(pose.crval)) ? pose.crval : [];
    const crpix = (pose && Array.isArray(pose.crpix)) ? pose.crpix : [];
    clusterOut.push({
      receipt_sha256: meta.receipt_sha256,
      schema_version: meta.schema_version,
      frame_sha256: meta.frame_sha256_for_stars,
      source_root: meta.source_root,
      receipt_path: meta.receipt_path,     // arm-dir provenance
      input_basename: inputBasename(meta.receipt_basename),
      decoder_arm: frameRow.decoder_arm,
      effective_config_hash: frameRow.effective_config_hash,
      rig: frameRow.rig,
      // denormalized frame-verdict context (per-cluster filtering without a join)
      qg_pass: str(qg.pass),
      verdict_accept: bool(v.accept),
      verdict_reason: str(v.reason),
      cluster_index: i,                    // position within clusters[]
      foot_ra_deg: num(c.foot_ra_deg),     // UNIT: DEGREES
      foot_dec_deg: num(c.foot_dec_deg),   // UNIT: DEGREES
      parity: int(c.parity),               // raw ±1; sign NOT asserted
      scale: num(c.scale),                 // arcsec/px
      votes: int(c.votes),
      anchored: int(c.anchored),
      pose_present: pose !== null,
      crval_ra_deg: num(crval[0]),         // UNIT: DEGREES
      crval_dec_deg: num(crval[1]),
      crpix_x: num(crpix[0]),
      crpix_y: num(crpix[1]),
      cd_json: jstr(pose ? pose.cd : null),
      odds: num(c.odds),                   // SOLVER_QUAD_GEN_ODDS shadow (null when flag off)
      odds_v2: num(c.oddsV2),              // SIGNED V2 shadow
      odds_v3: num(c.oddsV3),              // a.net-COMPLETE V3 shadow (conditional => null)
    });
  }

  return { verdictRow, nClusters: clusters.length };
}

// ---- crash-row flatten -----------------------------------------------------
export function firstErrorLine(tail) {
  if (typeof tail !== 'string') return null;
  // strip ANSI, find first line mentioning error/Error/FATAL/failed
  const clean = tail.replace(/\[[0-9;]*m/g, '');
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /error|fatal|failed|exception|refus/i.test(l));
  return (hit || lines[0] || null)?.slice(0, 500) ?? null;
}

export function flattenCrashRecord(j, meta) {
  return {
    crash_sha256: meta.crash_sha256,
    source_root: meta.source_root,
    crash_path: meta.crash_path,
    crash_basename: meta.crash_basename,
    kind: str(j.kind),
    schema: str(j.schema),
    input: str(j.input),
    receipt_expected: str(j.receipt_expected),
    status: int(j.status),
    signal: str(j.signal),
    error_code: str(j.error_code),
    timed_out: bool(j.timed_out),
    stderr_first_error: firstErrorLine(j.stderr_tail),
    stderr_tail_full: (str(j.stderr_tail) || '').replace(/\[[0-9;]*m/g, '').slice(0, 4000) || null,
    timestamp: str(j.timestamp),
  };
}

// ---- meta builders + one-shot convenience wrappers -------------------------
// Build the per-receipt meta object (identical computation the full ETL used
// inline — extracting it here keeps ETL + drain in lockstep).
export function makeReceiptMeta({ buf, j, srcName, srcRoot, filePath }) {
  return {
    receipt_sha256: sha256(buf),
    source_root: srcName,
    receipt_path: path.relative(srcRoot, filePath).replace(/\\/g, '/'),
    receipt_basename: path.basename(filePath),
    receipt_bytes: buf.length,
    schema_version: (typeof j.version === 'string' && j.version) ? j.version : (j.version ? jstr(j.version) : 'none'),
    kind: classifyKind(j),
  };
}

export function makeCrashMeta({ buf, srcName, srcRoot, filePath }) {
  return {
    crash_sha256: sha256(buf),
    source_root: srcName,
    crash_path: path.relative(srcRoot, filePath).replace(/\\/g, '/'),
    crash_basename: path.basename(filePath),
  };
}

// Flatten one receipt into { row, nStars, nDetections } and push its star +
// detection rows onto the provided arrays. Mirrors the ETL main per-receipt block
// EXACTLY (byte-identical output guarantee).
export function flattenReceipt(j, meta, starRows, detectionRows, quadVerdictRows, quadClusterRows) {
  const row = flattenFrame(j, meta);
  meta.frame_sha256_for_stars = row.frame_sha256; // denormalize onto star + detection rows
  const s = flattenStars(j, meta, starRows);
  row.n_matched_stars_rows = s.nMatched; row.n_photometry_rows = s.nPhot; row.n_confirmed_rows = s.nConf;
  const d = flattenDetections(j, meta, detectionRows);
  row.n_clean_detections = d.nClean; row.n_anomaly_detections = d.nAnom;
  // quad-gen drain (ADDITIVE 2026-07-18): frame-level verdict + per-cluster odds rows.
  // Absent quad_gen block => null => no rows (honest absence). Arrays are optional so
  // any caller that does not want quad tables can omit them (backward-compatible).
  let quad = null;
  if (quadVerdictRows !== undefined || quadClusterRows !== undefined) {
    quad = flattenQuadGen(j, meta, row, quadClusterRows || []);
    if (quad && quadVerdictRows) quadVerdictRows.push(quad.verdictRow);
  }
  return { row, stars: s, detections: d, quad };
}

// ---- explicit DuckDB column typing (shared by ETL + drain) -----------------
export const FRAME_COLS = {
  receipt_sha256: 'VARCHAR', schema_version: 'VARCHAR', receipt_kind: 'VARCHAR', source_root: 'VARCHAR',
  receipt_path: 'VARCHAR', receipt_basename: 'VARCHAR', receipt_bytes: 'BIGINT', input_basename: 'VARCHAR',
  frame_sha256: 'VARCHAR', identity_basis: 'VARCHAR', frame_identity_fallback: 'VARCHAR',
  engine_version: 'VARCHAR', engine_build_identity: 'VARCHAR', effective_config_hash: 'VARCHAR',
  solved: 'BOOLEAN', solved_via: 'VARCHAR', source_format: 'VARCHAR', decoder_arm: 'VARCHAR', atlas_id: 'VARCHAR',
  ra_hours: 'DOUBLE', dec_degrees: 'DOUBLE', pixel_scale_arcsec_px: 'DOUBLE', roll_degrees: 'DOUBLE',
  parity: 'VARCHAR', confidence: 'DOUBLE', stars_matched: 'INTEGER', fov_width_deg: 'DOUBLE', fov_height_deg: 'DOUBLE',
  mean_fwhm_px: 'DOUBLE', mean_residual_arcsec: 'DOUBLE', solve_time_ms: 'DOUBLE', crval1_deg: 'DOUBLE', crval2_deg: 'DOUBLE',
  confirm_status: 'VARCHAR', confirm_set_excess_z: 'DOUBLE', confirm_n_targets: 'INTEGER', confirm_confirmed: 'INTEGER',
  confirm_set_gate_z: 'DOUBLE', deep_examined: 'INTEGER', deep_confirmed_n: 'INTEGER', deep_set_excess_z: 'DOUBLE',
  deep_set_gate_passed: 'BOOLEAN', camera_model: 'VARCHAR', lens_model: 'VARCHAR', focal_length: 'DOUBLE',
  iso_gain: 'DOUBLE', exposure_time: 'DOUBLE', pixel_scale_meta: 'DOUBLE', image_width: 'INTEGER', image_height: 'INTEGER',
  gps_lat: 'DOUBLE', gps_lon: 'DOUBLE', obs_timestamp: 'VARCHAR', rig: 'VARCHAR', inferred_lens: 'VARCHAR',
  experimental: 'BOOLEAN', config_overrides_present: 'BOOLEAN', config_overrides_sha256: 'VARCHAR',
  failure_stage: 'VARCHAR', failure_reason: 'VARCHAR', run_timestamp: 'VARCHAR',
  n_matched_stars_rows: 'INTEGER', n_photometry_rows: 'INTEGER', n_confirmed_rows: 'INTEGER', duplicate_path_count: 'INTEGER',
  // --- additive 2026-07-17 sky-condition columns ---
  background_level: 'DOUBLE', noise_floor: 'DOUBLE', background_level_top: 'DOUBLE', background_level_bottom: 'DOUBLE',
  background_gradient: 'DOUBLE', culling_tally_json: 'VARCHAR', cfa_verdict_json: 'VARCHAR', cfa_klass: 'VARCHAR',
  milky_way_present: 'BOOLEAN', milky_way_n_hotspots: 'INTEGER', grid_w: 'INTEGER', grid_h: 'INTEGER', cell_size: 'DOUBLE',
  n_clean_detections: 'INTEGER', n_anomaly_detections: 'INTEGER',
};
export const DETECTION_COLS = {
  receipt_sha256: 'VARCHAR', schema_version: 'VARCHAR', frame_sha256: 'VARCHAR',
  detection_index: 'INTEGER', detection_id: 'VARCHAR', x: 'DOUBLE', y: 'DOUBLE', raw_x: 'DOUBLE', raw_y: 'DOUBLE',
  flux: 'DOUBLE', peak: 'DOUBLE', peak_value: 'DOUBLE', fwhm: 'DOUBLE', snr: 'DOUBLE', sharpness: 'DOUBLE',
  circularity: 'DOUBLE', ellipticity: 'DOUBLE', theta: 'DOUBLE', moment_fwhm_px: 'DOUBLE', moment_ellipticity: 'DOUBLE',
  measured_bv: 'DOUBLE', mie_index: 'DOUBLE', rayleigh_index: 'DOUBLE', peak_rgb_json: 'VARCHAR',
  kept: 'BOOLEAN', culling_reason: 'VARCHAR', matched: 'BOOLEAN',
};
export const STAR_COLS = {
  receipt_sha256: 'VARCHAR', schema_version: 'VARCHAR', frame_sha256: 'VARCHAR', star_role: 'VARCHAR', star_index: 'INTEGER',
  catalog_id: 'VARCHAR', name: 'VARCHAR', ra_deg: 'DOUBLE', dec_deg: 'DOUBLE', x_px: 'DOUBLE', y_px: 'DOUBLE',
  flux: 'DOUBLE', flux_err: 'DOUBLE', fwhm_px: 'DOUBLE', mag_catalog: 'DOUBLE', mag_measured: 'DOUBLE', mag_instrumental: 'DOUBLE',
  cat_band: 'VARCHAR', bv: 'DOUBLE', measured_bv: 'DOUBLE', snr: 'DOUBLE', calibrated_mag_err: 'DOUBLE',
  calibrated_status: 'VARCHAR', provenance: 'VARCHAR', residual_arcsec: 'DOUBLE', dx_px: 'DOUBLE', dy_px: 'DOUBLE',
  dra_arcsec: 'DOUBLE', ddec_arcsec: 'DOUBLE', airmass: 'DOUBLE', alt_deg: 'DOUBLE', confidence: 'DOUBLE', sigma_e: 'DOUBLE',
  detected_native: 'BOOLEAN', peak_rgb_json: 'VARCHAR', tests_json: 'VARCHAR',
};
export const CRASH_COLS = {
  crash_sha256: 'VARCHAR', source_root: 'VARCHAR', crash_path: 'VARCHAR', crash_basename: 'VARCHAR', kind: 'VARCHAR',
  schema: 'VARCHAR', input: 'VARCHAR', receipt_expected: 'VARCHAR', status: 'INTEGER', signal: 'VARCHAR',
  error_code: 'VARCHAR', timed_out: 'BOOLEAN', stderr_first_error: 'VARCHAR', stderr_tail_full: 'VARCHAR', timestamp: 'VARCHAR',
};
// --- quad-gen tables (ADDITIVE 2026-07-18; v0-testdev, additive-friendly) ---
export const QUAD_VERDICT_COLS = {
  receipt_sha256: 'VARCHAR', schema_version: 'VARCHAR', frame_sha256: 'VARCHAR',
  source_root: 'VARCHAR', receipt_path: 'VARCHAR', receipt_basename: 'VARCHAR', input_basename: 'VARCHAR',
  decoder_arm: 'VARCHAR', atlas_id: 'VARCHAR', rig: 'VARCHAR', effective_config_hash: 'VARCHAR',
  config_overrides_present: 'BOOLEAN', config_overrides_sha256: 'VARCHAR', solved: 'BOOLEAN', solved_via: 'VARCHAR',
  qg_pass: 'VARCHAR', qg_capture_mode: 'VARCHAR',
  verdict_accept: 'BOOLEAN', verdict_reason: 'VARCHAR', verdict_mode: 'VARCHAR',
  verdict_top_anchored: 'INTEGER', verdict_second_anchored: 'INTEGER', verdict_margin: 'DOUBLE',
  verdict_k: 'INTEGER', verdict_m: 'INTEGER', verdict_unopposed_floor: 'INTEGER', verdict_n_distinct: 'INTEGER',
  hint_fallthrough_reason: 'VARCHAR', hint_fallthrough_top_anchored: 'INTEGER',
  acceptance_present: 'BOOLEAN', acceptance_attempted: 'BOOLEAN', acceptance_accepted: 'BOOLEAN',
  acceptance_reason: 'VARCHAR', acceptance_arbiter: 'VARCHAR',
  acceptance_verify_matched: 'INTEGER', acceptance_verify_confidence: 'DOUBLE',
  acceptance_verify_ra_hours: 'DOUBLE', acceptance_verify_dec_degrees: 'DOUBLE', acceptance_verify_pixel_scale: 'DOUBLE',
  acceptance_sanity_ok: 'BOOLEAN', acceptance_sanity_fail: 'VARCHAR', acceptance_sanity_scale: 'DOUBLE',
  acceptance_sanity_foot_drift_deg: 'DOUBLE',
  index_release: 'VARCHAR', index_bands: 'INTEGER', index_stars: 'INTEGER', index_quads: 'INTEGER',
  budget_spent_ms: 'DOUBLE', budget_limit_ms: 'DOUBLE', budget_truncated: 'BOOLEAN', n_clusters: 'INTEGER',
};
export const QUAD_CLUSTER_COLS = {
  receipt_sha256: 'VARCHAR', schema_version: 'VARCHAR', frame_sha256: 'VARCHAR',
  source_root: 'VARCHAR', receipt_path: 'VARCHAR', input_basename: 'VARCHAR',
  decoder_arm: 'VARCHAR', effective_config_hash: 'VARCHAR', rig: 'VARCHAR',
  qg_pass: 'VARCHAR', verdict_accept: 'BOOLEAN', verdict_reason: 'VARCHAR',
  cluster_index: 'INTEGER', foot_ra_deg: 'DOUBLE', foot_dec_deg: 'DOUBLE', parity: 'INTEGER', scale: 'DOUBLE',
  votes: 'INTEGER', anchored: 'INTEGER', pose_present: 'BOOLEAN',
  crval_ra_deg: 'DOUBLE', crval_dec_deg: 'DOUBLE', crpix_x: 'DOUBLE', crpix_y: 'DOUBLE', cd_json: 'VARCHAR',
  odds: 'DOUBLE', odds_v2: 'DOUBLE', odds_v3: 'DOUBLE',
};
export const colSpec = (cols) => '{' + Object.entries(cols).map(([k, t]) => `'${k}': '${t}'`).join(', ') + '}';
