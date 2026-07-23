// tools/telemetry/greenfield/flatten_receipt.mjs
//
// SINGLE SOURCE OF TRUTH for the greenfield SolveReceipt -> flat analytical row
// mapping (CLAUDE.md LAW 4: no code in two places). Imported by
// ../receipts_to_parquet.mjs (ingest) and ../query_telemetry.mjs (schema echo).
//
// Tier: TEST/DEV. Schema NOT locked (owner standing rule: schemas unlocked until
// ratified). Every column is either MEASURED from a receipt field or honest-NULL.
// Nothing is fabricated (CLAUDE.md LAW 3, "honest-or-absent").
//
// Convention mirrored from tools/results/README.md (the ruled DuckDB-over-R2
// results surface): receipt_sha256 = sha256(file bytes) = PK/dedup key; star-schema
// with a wide per-solve table + a long per-band table; hive partition by the
// receipt's version dimension (here: solver_core_version).
//
// Greenfield SolveReceipt shape = bare { decision, decision_digest, telemetry }.
// Verified against real receipts under
//   D:/AstroLogic/test_artifacts/greenfield_solver/{m6,m6_ab,m6_bandmajor}/receipts/
// git_commit f1d6ce20 / solver_core_version 0.1.0 / index g15u.

import crypto from 'node:crypto';

export const TELEMETRY_SCHEMA_DRAFT_VERSION = '0.0.1-draft';
export const N_BANDS_NOMINAL = 15; // index bands_present (0..14) for the g15u release

// ---------- helpers ----------------------------------------------------------

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Stable stringify (sorted keys) so a config digest is order-invariant.
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function digestOf(obj) {
  if (obj == null) return null;
  return sha256Hex(Buffer.from(stableStringify(obj)));
}

// Great-circle separation between two (ra_deg, dec_deg) points, degrees.
// UNITS: inputs DEGREES. Greenfield receipt crval.ra is DEGREES (verified vs
// label ra_center_deg) -- NOT the legacy engine's internal HOURS convention.
export function angularSepDeg(ra1, dec1, ra2, dec2) {
  if ([ra1, dec1, ra2, dec2].some((v) => v == null || !Number.isFinite(v))) return null;
  const d2r = Math.PI / 180;
  const a1 = ra1 * d2r, d1 = dec1 * d2r, a2 = ra2 * d2r, d2 = dec2 * d2r;
  const sinDdec = Math.sin((d2 - d1) / 2);
  const sinDra = Math.sin((a2 - a1) / 2);
  const h = sinDdec * sinDdec + Math.cos(d1) * Math.cos(d2) * sinDra * sinDra;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / d2r;
}

// Label field-name tolerance (observed variants across oracle vs legacy labels):
//   RA center : ra_center_deg (all)
//   Dec       : dec_degrees (oracle) | dec_deg (legacy beach)
//   Scale     : pixel_scale_arcsec (oracle/M66) | scale_arcsec_px (legacy beach)
export function readLabel(label) {
  if (!label || typeof label !== 'object') return null;
  const pick = (...ks) => { for (const k of ks) if (label[k] != null && Number.isFinite(label[k])) return label[k]; return null; };
  return {
    ra_center_deg: pick('ra_center_deg'),
    dec_degrees: pick('dec_degrees', 'dec_deg'),
    pixel_scale_arcsec: pick('pixel_scale_arcsec', 'scale_arcsec_px'),
    parity: label.parity ?? null,
    rotation_deg: pick('rotation_deg'),
    log_odds: pick('log_odds'),
    matches: pick('matches'),
    source: label.source ?? label.oracle ?? null,
  };
}

// unix:1784610601 -> { unix, iso }
function parseStartedUtc(s) {
  if (typeof s !== 'string') return { unix: null, iso: null };
  const m = /unix:(\d+)/.exec(s);
  if (!m) return { unix: null, iso: null };
  const unix = Number(m[1]);
  return { unix, iso: new Date(unix * 1000).toISOString() };
}

const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);

// Per-band map { "0": {...}, ... } -> dense array [0..n-1] of one metric.
function bandArray(mapObj, key, n = N_BANDS_NOMINAL) {
  const out = [];
  for (let b = 0; b < n; b++) {
    const cell = mapObj && mapObj[String(b)];
    out.push(cell && cell[key] != null ? Number(cell[key]) : null);
  }
  return out;
}
function bandScalarArray(mapObj, n = N_BANDS_NOMINAL) {
  const out = [];
  for (let b = 0; b < n; b++) {
    const v = mapObj && mapObj[String(b)];
    out.push(v != null ? Number(v) : null);
  }
  return out;
}

// ---------- the SOLVE row (one per receipt) ----------------------------------
//
// ctx = { arm, frame_id_config, truth_class, label, solve_width, solve_height,
//         receipt_path, receipt_basename, receipt_bytes, receipt_sha256,
//         compare_cfg }  (compare_cfg carries center_bar_deg / scale_band_pct)

export function flattenSolve(receipt, ctx) {
  const d = receipt.decision || {};
  const rc = d.resolved_config || {};
  const ev = rc.evidence || {};
  const se = rc.search || {};
  const ex = rc.execution || {};
  const build = d.build || {};
  const idx = d.index || {};
  const res = d.result || {};
  const solved = res.solved || null;
  const prep = d.prep || {};
  const sr = d.search || {};
  const perBand = sr.per_band || {};
  const cgr = sr.cheap_gate_rejects || {};
  const tel = receipt.telemetry || {};
  const stage = tel.stage_ms || {};
  const cache = tel.cache_state || {};

  const state = res.state ?? null;
  const isSolved = state === 'Solved';

  // arm signature
  const policyRaw = cache.hit_order_policy || '';
  const hitOrderTag = policyRaw.startsWith('band-major') ? 'band-major'
    : policyRaw.startsWith('quadgen-canonical') ? 'quadgen-canonical' : (policyRaw ? 'other' : null);

  const started = parseStartedUtc(tel.started_utc);

  // per-band totals (search census, whole-run)
  const totProbes = sum(Object.values(perBand).map((c) => c.probes));
  const totRawHits = sum(Object.values(perBand).map((c) => c.raw_hits));
  const totProposals = sum(Object.values(perBand).map((c) => c.proposals));
  const totVerified = sum(Object.values(perBand).map((c) => c.verified));
  const totBailed = sum(Object.values(perBand).map((c) => c.bailed));
  const totDetQuads = sum(Object.values(perBand).map((c) => c.det_quads));

  // truth-stratum join
  const lab = readLabel(ctx.label);
  const hasLabel = !!lab && lab.ra_center_deg != null;
  const isNegative = ctx.truth_class === 'negative';
  const isPinAnchor = ctx.truth_class === 'legacy_sacred';

  const fv = solved && solved.final_verify ? solved.final_verify : {};
  const crval = solved && solved.wcs ? solved.wcs.crval : null;
  const crpix = solved && solved.wcs ? solved.wcs.crpix : null;
  const cd = solved && solved.wcs ? solved.wcs.cd : null;

  // derived truth metrics (Solved + labeled)
  let scaleResidualPct = null, scaleRatio = null, centerOffsetDeg = null;
  let poseWithinCenterBar = null, scaleWithinBand = null, parityMatch = null;
  if (isSolved && hasLabel) {
    if (crval) centerOffsetDeg = angularSepDeg(crval.ra, crval.dec, lab.ra_center_deg, lab.dec_degrees);
    if (lab.pixel_scale_arcsec && solved.scale_arcsec_px != null) {
      scaleRatio = solved.scale_arcsec_px / lab.pixel_scale_arcsec;
      scaleResidualPct = (scaleRatio - 1) * 100;
    }
    const centerBar = ctx.compare_cfg?.center_bar_deg ?? 0.5;
    const scaleBandPct = ctx.compare_cfg?.scale_band_pct ?? 2;
    poseWithinCenterBar = centerOffsetDeg != null ? centerOffsetDeg <= centerBar : null;
    scaleWithinBand = scaleResidualPct != null ? Math.abs(scaleResidualPct) <= scaleBandPct : null;
    if (lab.parity != null && solved.parity_sign != null) parityMatch = lab.parity === solved.parity_sign;
  }

  // truth_verdict (documented rule; parity NOT asserted -> informational only)
  let truthVerdict;
  if (isNegative) {
    truthVerdict = isSolved ? 'FALSE_POSITIVE' : 'TRUE_NEGATIVE';
  } else if (!isSolved) {
    truthVerdict = 'REFUSAL';
  } else if (!hasLabel) {
    truthVerdict = 'SOLVED_UNLABELED';
  } else if (poseWithinCenterBar === false) {
    truthVerdict = 'GEOM_MISMATCH';
  } else if (scaleWithinBand === false) {
    truthVerdict = 'POSE_OK_SCALE_OFF';
  } else if (poseWithinCenterBar) {
    truthVerdict = 'TRUE_POSITIVE';
  } else {
    truthVerdict = 'SOLVED_UNCHECKED';
  }

  return {
    // ---- identity / provenance ----
    receipt_sha256: ctx.receipt_sha256,        // PK
    arm: ctx.arm,                               // m6 | m6_ab | m6_bandmajor
    frame_id_config: ctx.frame_id_config,       // compare_config frame id (disambiguates *_capability)
    receipt_variant: ctx.receipt_basename.includes('.capability.') ? 'capability' : 'standard',
    receipt_path: ctx.receipt_path,
    receipt_basename: ctx.receipt_basename,
    receipt_bytes: ctx.receipt_bytes,
    decision_digest: receipt.decision_digest ?? null,
    frame_id: d.frame_id ?? null,               // engine frame id, e.g. CSM30799.CR2
    input_digest: d.input_digest ?? null,       // engine-stamped frame identity
    classification: d.classification ?? null,

    // ---- build / index provenance ----
    solver_core_version: build.solver_core_version ?? null,   // PARTITION KEY
    quad_coder_version: build.quad_coder_version ?? null,
    verify_policy_version: build.verify_policy_version ?? null,
    git_commit: build.git_commit ?? null,
    build_profile: build.profile ?? null,
    build_opt_level: build.opt_level ?? null,
    build_target: build.target ?? null,
    index_release_id: idx.release_id ?? null,
    index_format_version: idx.format_version ?? null,
    index_aggregate_md5: idx.aggregate_md5 ?? null,
    index_verify_mode: idx.verify_mode ?? null,
    index_bands_present: idx.bands_present ?? null,
    index_total_quads: idx.total_quads ?? null,
    index_total_stars: idx.total_stars ?? null,

    // ---- arm signature (drift levers) ----
    hit_order_policy_tag: hitOrderTag,
    band_major: se.band_major ?? false,
    abort_on_accept: se.abort_on_accept ?? null,
    resolved_config_digest: digestOf(rc),       // exact-config drift key
    cfg_code_tol: se.code_tol ?? null,
    cfg_scale_lo_asec: se.scale_lo_asec ?? null,
    cfg_scale_hi_asec: se.scale_hi_asec ?? null,
    cfg_budget_ms: se.budget_ms ?? null,
    cfg_verify_ref_cap: se.verify_ref_cap ?? null,
    cfg_verify_test_cap: se.verify_test_cap ?? null,
    cfg_dedup_ring: se.dedup_ring ?? null,
    cfg_min_probes_per_band: se.min_probes_per_band ?? null,
    cfg_interior_cap: se.interior_cap ?? null,
    cfg_band_slack: se.band_slack ?? null,
    cfg_peak_arm_weight: se.peak_arm_weight ?? null,
    cfg_rung_ladder_json: se.rung_ladder ? JSON.stringify(se.rung_ladder) : null,
    cfg_uniformize_grid_json: se.uniformize_grid ? JSON.stringify(se.uniformize_grid) : null,
    cfg_verify_pix_sigma: ev.verify_pix_sigma ?? null,
    cfg_distractor: ev.distractor ?? null,
    cfg_max_match_sigma: ev.max_match_sigma ?? null,
    cfg_log_accept: ev.log_accept ?? null,
    cfg_log_bail: ev.log_bail ?? null,
    cfg_do_gamma: ev.do_gamma ?? null,
    cfg_do_ror: ev.do_ror ?? null,
    cfg_refine_min_matches: ev.refine_min_matches ?? null,
    exec_threads: ex.threads ?? null,
    exec_release_verify: ex.release_verify ?? null,

    // ---- terminal state ----
    state,
    solved: isSolved,
    search_truncated: res.search_truncated ?? null,

    // ---- pose (Solved only; else null) ----
    crval_ra_deg: crval ? crval.ra : null,      // UNITS: DEGREES (greenfield native)
    crval_dec_deg: crval ? crval.dec : null,
    crpix_x: crpix ? crpix.x : null,
    crpix_y: crpix ? crpix.y : null,
    cd_json: cd ? JSON.stringify(cd) : null,
    scale_arcsec_px: solved ? (solved.scale_arcsec_px ?? null) : null,
    parity_sign: solved ? (solved.parity_sign ?? null) : null,   // ±1, sign NOT asserted
    accept_band: solved ? (solved.band ?? null) : null,
    accept_rung: solved ? (solved.rung ?? null) : null,
    hypothesis_seq: solved ? (solved.hypothesis_seq ?? null) : null,

    // ---- verify evidence (Solved only) ----
    log_odds: isSolved ? (fv.log_odds ?? null) : null,
    final_odds: isSolved ? (fv.final_odds ?? null) : null,
    best_worst: isSolved ? (fv.best_worst ?? null) : null,
    besti: isSolved ? (fv.besti ?? null) : null,
    n_matched: isSolved ? (fv.n_matched ?? null) : null,
    n_distractor: isSolved ? (fv.n_distractor ?? null) : null,
    n_conflict: isSolved ? (fv.n_conflict ?? null) : null,
    n_test: isSolved ? (fv.n_test ?? null) : null,
    n_ref: isSolved ? (fv.n_ref ?? null) : null,
    eff_area: isSolved ? (fv.eff_area ?? null) : null,
    verify_bailed_at: isSolved ? (fv.bailed_at ?? null) : null,
    verify_stopped_at: isSolved ? (fv.stopped_at ?? null) : null,
    n_matches_persisted: solved && Array.isArray(solved.matches) ? solved.matches.length : null,

    // ---- prep / detection pool ----
    prep_raw: prep.raw ?? null,
    prep_valid: prep.valid ?? null,
    prep_deduped: prep.deduped ?? null,
    prep_pool: prep.pool ?? null,
    prep_peak_arm_promoted: prep.peak_arm_promoted ?? null,

    // ---- search census totals ----
    total_det_quads: totDetQuads,
    total_probes: totProbes,
    total_raw_hits: totRawHits,
    total_proposals: totProposals,
    total_verified: totVerified,
    total_bailed: totBailed,
    dedup_ring_skips: sr.dedup_ring_skips ?? null,
    fine_band_concentration_warn: sr.fine_band_concentration_warn ?? null,
    cgr_abscale_window: cgr.abscale_window ?? null,
    cgr_abscale_degenerate: cgr.abscale_degenerate ?? null,
    cgr_fov: cgr.fov ?? null,
    cgr_ring_identity: cgr.ring_identity ?? null,
    cgr_ring_pose: cgr.ring_pose ?? null,
    cgr_rot_resid: cgr.rot_resid ?? null,
    cgr_fit_degenerate: cgr.fit_degenerate ?? null,

    // ---- walls / telemetry ----
    runtime: tel.runtime ?? null,
    started_utc_raw: tel.started_utc ?? null,
    started_unix: started.unix,
    started_iso: started.iso,
    wall_ms: tel.wall_ms ?? null,
    search_wall_ms: stage.search ?? null,
    prep_ms: stage.prep ?? null,
    index_parse_ms: stage.index_parse ?? null,
    index_verify_ms: stage.index_verify ?? null,
    prefix_tables_ms: stage.prefix_tables ?? null,
    star_grid_ms: stage.star_grid ?? null,
    prefetch_ms: tel.prefetch_ms ?? null,
    threads_used: tel.threads_used ?? null,
    timer_calls: tel.timer_calls ?? null,
    index_prefetch: cache.index_prefetch ?? null,
    skipped_hits: cache.skipped_hits != null ? Number(cache.skipped_hits) : null,

    // ---- abort / consensus (freeze-confirm chain) ----
    n_freeze_events: Array.isArray(tel.freeze_events) ? tel.freeze_events.length : null,
    freeze_outcome_first: Array.isArray(tel.freeze_events) && tel.freeze_events[0] ? tel.freeze_events[0].outcome : null,
    confirmed_freeze_elapsed_ms: tel.confirmed_freeze_elapsed_ms ?? null,
    post_chain_confirmed_elapsed_ms: tel.post_chain_confirmed_elapsed_ms ?? null,
    search_aborted_on_accept: tel.search_aborted_on_accept ?? null,   // band-major arm
    abort_elapsed_ms: tel.abort_elapsed_ms ?? null,                    // band-major arm

    // ---- per-band arrays (LIST columns) ----
    // Array choice justified in R2_TELEMETRY_SCHEMA_DRAFT.md: native LIST in both
    // NDJSON->DuckDB and parquet; band count is data-driven (index.bands_present)
    // so fixed b0..b14 columns would be schema-fragile. The long companion table
    // solve_bands (below) carries the exploded grain for GROUP BY band.
    band_det_quads: bandArray(perBand, 'det_quads'),
    band_probes: bandArray(perBand, 'probes'),
    band_raw_hits: bandArray(perBand, 'raw_hits'),
    band_proposals: bandArray(perBand, 'proposals'),
    band_verified: bandArray(perBand, 'verified'),
    band_bailed: bandArray(perBand, 'bailed'),
    band_probe_wall_ms: bandScalarArray(tel.per_band_probe_wall_ms),
    band_verify_wall_ms: bandScalarArray(tel.per_band_verify_wall_ms),

    // ---- truth stratum ----
    truth_class: ctx.truth_class ?? null,
    truth_stratum: ctx.truth_class ?? null,     // alias for stratified group-bys
    is_pin_anchor: isPinAnchor,                 // legacy_sacred = the anchored ~1%
    is_negative: isNegative,
    has_label: hasLabel,
    solve_width: ctx.solve_width ?? null,
    solve_height: ctx.solve_height ?? null,
    label_ra_center_deg: lab ? lab.ra_center_deg : null,
    label_dec_degrees: lab ? lab.dec_degrees : null,
    label_pixel_scale_arcsec: lab ? lab.pixel_scale_arcsec : null,
    label_parity: lab ? lab.parity : null,
    label_rotation_deg: lab ? lab.rotation_deg : null,
    label_log_odds: lab ? lab.log_odds : null,
    label_matches: lab ? lab.matches : null,
    label_source: lab ? lab.source : null,

    // ---- derived truth metrics ----
    scale_residual_pct: scaleResidualPct,
    scale_ratio: scaleRatio,
    center_offset_deg: centerOffsetDeg,
    pose_within_center_bar: poseWithinCenterBar,
    scale_within_band: scaleWithinBand,
    parity_match: parityMatch,                  // informational (sign not asserted)
    truth_verdict: truthVerdict,
  };
}

// ---------- the BAND rows (long: one per receipt x band) ---------------------

export function flattenBands(receipt, ctx) {
  const d = receipt.decision || {};
  const res = d.result || {};
  const solved = res.solved || null;
  const perBand = (d.search && d.search.per_band) || {};
  const tel = receipt.telemetry || {};
  const probeWall = tel.per_band_probe_wall_ms || {};
  const verifyWall = tel.per_band_verify_wall_ms || {};
  const atAccept = tel.at_accept_per_band || {};
  const acceptBand = solved ? (solved.band ?? null) : null;
  const nBands = d.index?.bands_present ?? N_BANDS_NOMINAL;

  const rows = [];
  for (let b = 0; b < nBands; b++) {
    const c = perBand[String(b)] || {};
    const aa = atAccept ? atAccept[String(b)] : null;
    rows.push({
      receipt_sha256: ctx.receipt_sha256,       // FK -> solves
      arm: ctx.arm,
      frame_id_config: ctx.frame_id_config,
      solver_core_version: d.build?.solver_core_version ?? null,  // partition key
      truth_class: ctx.truth_class ?? null,
      state: res.state ?? null,
      band: b,
      is_accept_band: acceptBand != null ? b === acceptBand : null,
      det_quads: c.det_quads ?? null,
      probes: c.probes ?? null,
      raw_hits: c.raw_hits ?? null,
      proposals: c.proposals ?? null,
      verified: c.verified ?? null,
      bailed: c.bailed ?? null,
      probe_wall_ms: probeWall[String(b)] ?? null,
      verify_wall_ms: verifyWall[String(b)] ?? null,
      at_accept_det_quads: aa ? (aa.det_quads ?? null) : null,
      at_accept_probes: aa ? (aa.probes ?? null) : null,
      at_accept_raw_hits: aa ? (aa.raw_hits ?? null) : null,
      at_accept_proposals: aa ? (aa.proposals ?? null) : null,
      at_accept_verified: aa ? (aa.verified ?? null) : null,
      at_accept_bailed: aa ? (aa.bailed ?? null) : null,
    });
  }
  return rows;
}

// CSV column subset (scalars only; arrays/JSON dropped for eyeballing).
export const CSV_COLUMNS = [
  'arm', 'frame_id_config', 'receipt_variant', 'truth_class', 'is_pin_anchor',
  'state', 'solved', 'truth_verdict', 'accept_band', 'accept_rung',
  'log_odds', 'n_matched', 'n_conflict', 'scale_arcsec_px', 'parity_sign',
  'crval_ra_deg', 'crval_dec_deg', 'center_offset_deg', 'scale_residual_pct',
  'pose_within_center_bar', 'scale_within_band',
  'wall_ms', 'search_wall_ms', 'prep_pool', 'total_probes',
  'hit_order_policy_tag', 'band_major', 'search_aborted_on_accept', 'abort_elapsed_ms',
  'confirmed_freeze_elapsed_ms', 'solver_core_version', 'git_commit', 'resolved_config_digest',
];
