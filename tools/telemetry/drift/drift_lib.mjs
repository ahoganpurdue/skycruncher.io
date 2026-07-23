// tools/telemetry/drift/drift_lib.mjs
//
// R2 DRIFT INSTRUMENT v0 -- shared library (SINGLE SOURCE OF TRUTH; CLAUDE.md LAW 4).
// Imported by ./drift.mjs (the CLI). Pure node builtins, zero deps.
//
// PURPOSE (owner GO 2026-07-21): the owner descoped bit-identical solver pins to
// serious-regression tripwires on the premise that R2 population telemetry becomes
// the systemic-drift instrument of record. This is v0 of that instrument.
//
// WHAT IT DOES (and does NOT):
//   - Ingests the banked greenfield SolveReceipt POPULATION (already flattened to a
//     normalized row table by the untracked ETL tools/telemetry/receipts_to_parquet.mjs,
//     which emits telemetry_db/solves.ndjson). A thin raw-receipt fallback is provided.
//   - Builds BASELINE distributions stratified by rig / arm / truth-class / field-class,
//     reporting median / IQR / p10 / p90 per stratum + an outcome mix.
//   - Compares a NEW batch of receipts against a baseline with ROBUST effect sizes
//     (median shift in baseline-IQR units + Cliff's delta) and outcome-mix deltas
//     (total-variation distance), and checks each batch receipt's DECISION CORE
//     against the truth-anchored pin for that frame.
//
// TIER: TEST/DEV. The R2 row schema is NOT locked (owner queue item) -- every schema
// caveat is surfaced, nothing is fabricated (CLAUDE.md LAW 3, "honest-or-absent").
//
// *** NO CALIBRATED CONSTANTS ***
// v0 reports MAGNITUDES and flags CANDIDATES only. The provisional triage markers in
// PROVISIONAL_TRIAGE_MARKERS below are NOT calibrated alert thresholds -- real alert
// thresholds are an OWNER ruling (see README). They exist only to sort a drift report
// so a human/dashboard sees the largest movers first. Cliff's-delta descriptor bands
// (Romano 2006) are conventional LITERATURE labels, printed for interpretation, never
// used as a pass/fail gate. There is no significance test anywhere (no p-values): all
// figures are effect-size magnitudes over the observed population.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DRIFT_INSTRUMENT_VERSION = '0.0.1-v0';
export const DEFAULT_DB = 'D:/AstroLogic/test_artifacts/greenfield_solver/telemetry_db';
export const DEFAULT_PINS = 'D:/AstroLogic/test_artifacts/greenfield_solver/PINNED_REFERENCE_SOLVES.json';

// PROVISIONAL triage markers -- NOT calibrated alert thresholds (owner ruling pending).
// Purpose: sort a drift report by magnitude so the largest movers surface first.
export const PROVISIONAL_TRIAGE_MARKERS = Object.freeze({
  _disclaimer: 'PROVISIONAL triage markers for report sorting ONLY. NOT calibrated alert thresholds. Owner sets real thresholds later. A numeric candidate requires BOTH the IQR-units AND the Cliff\'s-delta magnitude to exceed their marker (concordance) -- see numericDrift().',
  numeric_iqr_units_abs: 1.0,   // |median-shift / baseline-IQR| leg of the concordance rule
  numeric_cliffs_abs: 0.474,    // |Cliff's delta| leg (Romano "large" band) of the concordance rule
  outcome_tvd: 0.25,            // total-variation distance at/above which an outcome-mix is flagged a candidate
  min_batch_n_for_numeric: 5,   // power floor: below this batch-N, numeric drift is reported but marked LOW_POWER, never a candidate
});

// Numeric metrics tracked for drift. Each is MEASURED from a receipt (or honest-null).
export const NUMERIC_METRICS = Object.freeze([
  'wall_ms',            // total wall (ms)
  'search_wall_ms',     // search-stage wall (ms)
  'accept_band',        // accepted band index (solved only)
  'n_matched',          // verify matched-star count (solved only)
  'log_odds',           // final-verify log-odds (solved only)
  'scale_arcsec_px',    // recovered plate scale (solved only)
  'center_offset_deg',  // pose vs label great-circle offset (solved+labeled)
  'scale_residual_pct', // scale vs label residual % (solved+labeled)
  'total_probes',       // whole-run search probe census
]);

// Categorical outcome dimensions tracked for mix-drift.
export const OUTCOME_DIMS = Object.freeze(['solved_flag', 'state', 'truth_verdict']);

// Stratification dimensions. 'ALL' = pooled. Every other dim is a receipt column
// (rig_class / field_class are DERIVED below; the rest are native flatten columns).
export const STRATUM_DIMS = Object.freeze(['ALL', 'arm', 'truth_class', 'rig_class', 'field_class', 'git_commit_short']);

// ---------- robust statistics (no significance tests) ------------------------

export function quantile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

export function robustStats(nums) {
  const vals = nums.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const n = vals.length;
  if (n === 0) return { n: 0, median: null, q25: null, q75: null, iqr: null, p10: null, p90: null, min: null, max: null };
  const q25 = quantile(vals, 25), q75 = quantile(vals, 75);
  return {
    n,
    median: quantile(vals, 50),
    q25, q75,
    iqr: q75 - q25,
    p10: quantile(vals, 10),
    p90: quantile(vals, 90),
    min: vals[0],
    max: vals[n - 1],
  };
}

// Cliff's delta: P(a>b) - P(a<b) over all cross-pairs. Range [-1,1]. Robust, ties-safe,
// NO significance -- it is an EFFECT SIZE, not a test statistic. O(n*m); fine for N<~1e3.
export function cliffsDelta(a, b) {
  const A = a.filter((v) => v != null && Number.isFinite(v));
  const B = b.filter((v) => v != null && Number.isFinite(v));
  if (!A.length || !B.length) return null;
  let gt = 0, lt = 0;
  for (const x of A) for (const y of B) { if (x > y) gt++; else if (x < y) lt++; }
  return (gt - lt) / (A.length * B.length);
}

// Conventional descriptor band for |Cliff's delta| (Romano et al. 2006). LITERATURE
// LABEL for human interpretation only -- NEVER a pass/fail gate.
export function cliffsBand(delta) {
  if (delta == null) return null;
  const d = Math.abs(delta);
  if (d < 0.147) return 'negligible';
  if (d < 0.330) return 'small';
  if (d < 0.474) return 'medium';
  return 'large';
}

const round = (x, dp) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);
export const r2 = (x) => round(x, 2);
export const r3 = (x) => round(x, 3);

export function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ---------- population ingest -------------------------------------------------

function rigClass(row) {
  if (row.truth_class === 'negative') return 'negative';
  const fid = row.frame_id || '';
  const ext = fid.includes('.') ? fid.split('.').pop().toLowerCase() : '';
  if (ext === 'cr2') return 'canon_cr2';
  if (ext === 'raf') return 'fuji_raf';
  if (ext === 'fit' || ext === 'fits') return 'scope_fits';
  return 'unknown';
}

// field_class from recovered plate scale (solved only). Refusals -> 'unsolved' (a
// field-class needs a solve). Buckets chosen for READABILITY, not calibration --
// they only group rows for reporting and never gate anything.
function fieldClass(row) {
  const s = row.scale_arcsec_px;
  if (s == null || !Number.isFinite(s)) return 'unsolved';
  if (s >= 40) return 'ultrawide';
  if (s >= 10) return 'wide';
  if (s >= 2) return 'mid';
  return 'narrow';
}

// Derive the columns the drift instrument needs on top of the flatten row.
function enrich(row) {
  return {
    ...row,
    rig_class: rigClass(row),
    field_class: fieldClass(row),
    git_commit_short: (row.git_commit || 'none').slice(0, 8),
    solved_flag: row.solved === true ? 'solved' : 'not_solved',
  };
}

// Load the normalized population. Primary source: the ETL-emitted telemetry_db NDJSON
// (tools/telemetry/receipts_to_parquet.mjs is the upstream producer -- read, do not own).
// Fallback: walk raw receipt JSONs with a MINIMAL drift projection (a small subset of
// the full ETL, NOT a duplicate of it) when the telemetry_db is absent.
export function loadPopulation({ db = DEFAULT_DB, receiptsDir = null } = {}) {
  const ndjson = path.join(db, 'solves.ndjson');
  if (fs.existsSync(ndjson)) {
    const rows = fs.readFileSync(ndjson, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { rows: rows.map(enrich), source: 'telemetry_db', source_path: ndjson, n: rows.length };
  }
  if (receiptsDir && fs.existsSync(receiptsDir)) {
    const rows = projectRawReceipts(receiptsDir);
    return { rows: rows.map(enrich), source: 'raw_receipts_minimal_projection', source_path: receiptsDir, n: rows.length };
  }
  return { rows: [], source: 'none', source_path: ndjson, n: 0, error: `no telemetry_db at ${ndjson} and no --receipts fallback dir` };
}

// Minimal raw-receipt -> drift-row projection (fallback ONLY). Extracts the handful of
// fields the drift queries consume. This is NOT the full 150-column ETL flatten; it is a
// deliberately small independent projection so the instrument runs even without the
// (untracked) ETL present. Fields mirror flatten_receipt.mjs names for schema continuity.
function projectRawReceipts(dir) {
  const out = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const d = receipt.decision || {};
    const res = d.result || {};
    const solved = res.solved || null;
    const fv = solved && solved.final_verify ? solved.final_verify : {};
    const tel = receipt.telemetry || {};
    const stage = tel.stage_ms || {};
    const crval = solved && solved.wcs ? solved.wcs.crval : null;
    out.push({
      receipt_basename: f,
      frame_id: d.frame_id ?? null,
      frame_id_config: (d.frame_id || f).replace(/\.[^.]+$/, ''),
      receipt_variant: f.includes('.capability.') ? 'capability' : 'standard',
      arm: null, truth_class: null,
      solver_core_version: d.build?.solver_core_version ?? null,
      git_commit: d.build?.git_commit ?? null,
      index_aggregate_md5: d.index?.aggregate_md5 ?? null,
      state: res.state ?? null,
      solved: res.state === 'Solved',
      wall_ms: tel.wall_ms ?? null,
      search_wall_ms: stage.search ?? null,
      accept_band: solved ? (solved.band ?? null) : null,
      n_matched: solved ? (fv.n_matched ?? null) : null,
      log_odds: solved ? (fv.log_odds ?? null) : null,
      scale_arcsec_px: solved ? (solved.scale_arcsec_px ?? null) : null,
      parity_sign: solved ? (solved.parity_sign ?? null) : null,
      crval_ra_deg: crval ? crval.ra : null,
      crval_dec_deg: crval ? crval.dec : null,
      center_offset_deg: null, scale_residual_pct: null,
      total_probes: null,
      truth_verdict: null, is_pin_anchor: null,
    });
  }
  return out;
}

// ---------- outcome mix + baseline builder -----------------------------------

export function outcomeMix(rows, dim) {
  const counts = {};
  for (const r of rows) { const k = String(r[dim]); counts[k] = (counts[k] || 0) + 1; }
  const n = rows.length;
  const frac = {};
  for (const k of Object.keys(counts)) frac[k] = n ? counts[k] / n : 0;
  return { n, counts, frac };
}

function metricStatsForStratum(rows) {
  const m = {};
  for (const metric of NUMERIC_METRICS) m[metric] = robustStats(rows.map((r) => r[metric]));
  return m;
}

// Group rows by a stratum dimension. 'ALL' -> single group.
export function groupByDim(rows, dim) {
  if (dim === 'ALL') return new Map([['ALL', rows]]);
  const m = new Map();
  for (const r of rows) { const k = String(r[dim] ?? 'null'); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}

export function buildBaseline(rows, { dims = STRATUM_DIMS, label = 'population_baseline', pinsPath = DEFAULT_PINS } = {}) {
  const provenance = {
    solver_core_versions: [...new Set(rows.map((r) => r.solver_core_version))].filter(Boolean),
    git_commits: [...new Set(rows.map((r) => r.git_commit))].filter(Boolean),
    index_aggregate_md5s: [...new Set(rows.map((r) => r.index_aggregate_md5))].filter(Boolean),
    arms: [...new Set(rows.map((r) => r.arm))].filter(Boolean),
  };
  const strata = {};
  for (const dim of dims) {
    strata[dim] = {};
    for (const [val, grp] of groupByDim(rows, dim)) {
      strata[dim][val] = {
        n: grp.length,
        outcome_mix: Object.fromEntries(OUTCOME_DIMS.map((od) => [od, outcomeMix(grp, od)])),
        metrics: metricStatsForStratum(grp),
      };
    }
  }
  const pins = loadPins(pinsPath);
  return {
    drift_instrument_version: DRIFT_INSTRUMENT_VERSION,
    tier: 'TEST/DEV (R2 row schema NOT locked -- owner queue item)',
    label,
    generated_at: new Date().toISOString(),
    population_n: rows.length,
    provenance,
    stratum_dims: dims,
    numeric_metrics: NUMERIC_METRICS,
    outcome_dims: OUTCOME_DIMS,
    truth_anchored_pin_stratum: pins ? { source: pinsPath, n_pins: pins.pins.length, authorized: pins.authorized } : null,
    strata,
  };
}

// ---------- pin (truth-anchored) divergence ----------------------------------

export function loadPins(pinsPath = DEFAULT_PINS) {
  if (!fs.existsSync(pinsPath)) return null;
  try { return JSON.parse(fs.readFileSync(pinsPath, 'utf8')); } catch { return null; }
}

const FLOAT_EPS = 1e-6; // float-equality epsilon (NOT a calibrated tolerance -- exact-match test)

// Compare one batch receipt's DECISION CORE against the truth-anchored pin for its frame.
// Pin core fields: state, scale, parity, band, ra_deg, dec_deg. Divergence is REPORTED as
// a magnitude; only an exact-vs-float-eps mismatch is called divergent (no calibrated bar).
export function pinDivergence(row, pin) {
  const fields = [];
  const cmp = (name, got, want, kind) => {
    if (want == null || got == null) { fields.push({ field: name, batch: got, pin: want, status: 'unavailable' }); return; }
    if (kind === 'exact') {
      fields.push({ field: name, batch: got, pin: want, status: got === want ? 'match' : 'DIVERGE' });
    } else {
      const delta = got - want;
      fields.push({ field: name, batch: got, pin: want, delta: r3(delta), status: Math.abs(delta) <= FLOAT_EPS ? 'match' : 'DIVERGE' });
    }
  };
  const pinSolved = String(pin.state).toLowerCase() === 'solved';
  cmp('state', row.state, pinSolved ? 'Solved' : pin.state, 'exact');
  cmp('parity_sign', row.parity_sign, pin.parity ?? null, 'exact');
  cmp('accept_band', row.accept_band, pin.band ?? null, 'exact');
  cmp('scale_arcsec_px', row.scale_arcsec_px, pin.scale ?? null, 'num');
  cmp('crval_ra_deg', row.crval_ra_deg, pin.ra_deg ?? null, 'num');
  cmp('crval_dec_deg', row.crval_dec_deg, pin.dec_deg ?? null, 'num');
  const diverged = fields.filter((f) => f.status === 'DIVERGE');
  return {
    diverged_fields: diverged.map((f) => f.field),
    n_diverged: diverged.length,
    status: diverged.length === 0 ? 'PIN_MATCH' : (diverged.some((f) => f.field === 'state') ? 'STATE_FLIP' : 'CORE_DIVERGENCE'),
    fields,
  };
}

// Match batch rows to pins by (frame_id_config [+ _capability variant]) and check cores.
//
// REFERENCE-CORE SEPARATION (measured 2026-07-21): the pins were rebaselined from the
// reference arm (band_major=FALSE; band_order/abort are decision-INERT, so BOTH the m6
// and m6_ab arms reproduce the pin core -- 38/38 exact). The band-major arm
// (band_major=TRUE) is a DIFFERENT hit-order algorithm and legitimately diverges from
// the reference pins (6/9 diverge). So a divergence is only a DRIFT signal when the
// receipt itself is a reference-core (band_major=false) run; a band-major divergence is
// EXPECTED cross-arm behaviour, reported as informational and NOT counted as drift.
export function checkPins(batchRows, pinsObj) {
  if (!pinsObj) return { available: false, reason: 'no pins file', checks: [] };
  const byId = new Map(pinsObj.pins.map((p) => [p.id, p]));
  const checks = [];
  for (const row of batchRows) {
    const key = row.frame_id_config + (row.receipt_variant === 'capability' ? '_capability' : '');
    const pin = byId.get(key) || byId.get(row.frame_id_config);
    const isReferenceCore = row.band_major === false; // null/true (band-major) are not reference cores
    if (!pin) { checks.push({ frame: key, arm: row.arm, is_reference_core: isReferenceCore, status: 'NO_PIN' }); continue; }
    const dv = pinDivergence(row, pin);
    checks.push({ frame: pin.id, arm: row.arm, band_major: row.band_major ?? null, is_reference_core: isReferenceCore, receipt_variant: row.receipt_variant, tier: pin.tier ?? null, ...dv });
  }
  const isDiv = (c) => c.status === 'CORE_DIVERGENCE' || c.status === 'STATE_FLIP';
  const divergedReference = checks.filter((c) => isDiv(c) && c.is_reference_core);
  const divergedCrossArm = checks.filter((c) => isDiv(c) && !c.is_reference_core);
  return {
    available: true,
    n_checked: checks.filter((c) => c.status !== 'NO_PIN').length,
    n_no_pin: checks.filter((c) => c.status === 'NO_PIN').length,
    n_pin_match: checks.filter((c) => c.status === 'PIN_MATCH').length,
    // DRIFT-RELEVANT count = reference-core divergences only:
    n_diverged: divergedReference.length,
    n_diverged_reference: divergedReference.length,
    n_diverged_cross_arm_expected: divergedCrossArm.length,
    diverged: divergedReference,
    cross_arm_expected: divergedCrossArm,
    checks,
  };
}

// ---------- drift comparison: NEW batch vs baseline --------------------------

// Compute per-metric drift for one stratum group (baseline stats already computed;
// batch raw values supplied so Cliff's delta can use both raw samples).
function numericDrift(metric, baseStats, baseVals, batchVals) {
  const batchStats = robustStats(batchVals);
  if (baseStats.n === 0 || batchStats.n === 0) {
    return { metric, base_n: baseStats.n, batch_n: batchStats.n, insufficient: true };
  }
  const medianShift = batchStats.median - baseStats.median;
  const iqrUnits = baseStats.iqr > 0 ? medianShift / baseStats.iqr : null;
  const cliffs = cliffsDelta(batchVals, baseVals);
  const lowPower = batchStats.n < PROVISIONAL_TRIAGE_MARKERS.min_batch_n_for_numeric;
  // CONCORDANCE RULE (v0 design, not calibration): a candidate requires BOTH robust
  // measures to agree. median-shift/IQR is fooled by MULTIMODAL strata (e.g. mixed-rig
  // scale that clusters at 63/53/35"/px -- the median jumps a gap between modes for a
  // huge IQR-units figure while the rank overlap barely moves); Cliff's delta is fooled
  // by tiny-N chance. Requiring both to exceed their markers kills the multimodal-IQR
  // artifact and most small-N Cliff's noise. Both magnitudes are ALWAYS reported so a
  // human sees a single-measure mover even when it is not auto-flagged.
  const iqrExceeds = iqrUnits != null && Math.abs(iqrUnits) >= PROVISIONAL_TRIAGE_MARKERS.numeric_iqr_units_abs;
  const cliffsExceeds = cliffs != null && Math.abs(cliffs) >= PROVISIONAL_TRIAGE_MARKERS.numeric_cliffs_abs;
  const candidate = !lowPower && iqrExceeds && cliffsExceeds;
  return {
    metric,
    base_n: baseStats.n, batch_n: batchStats.n,
    base_median: r3(baseStats.median), batch_median: r3(batchStats.median),
    base_iqr: r3(baseStats.iqr),
    median_shift: r3(medianShift),
    median_shift_iqr_units: iqrUnits == null ? null : r3(iqrUnits),
    cliffs_delta: cliffs == null ? null : r3(cliffs),
    cliffs_band: cliffsBand(cliffs),
    low_power: lowPower,
    provisional_candidate: candidate,
    single_measure_mover: !candidate && !lowPower && (iqrExceeds || cliffsExceeds), // one measure fires, the other does not -> multimodal/noisy stratum flag
    iqr_degenerate: baseStats.iqr === 0 || baseStats.iqr == null,
  };
}

// Outcome-mix drift for one stratum group: TVD + per-category fractional deltas.
// NOTE on multi-category TVD: the expected TVD between two samples of the SAME
// distribution is > 0 and grows with category count / shrinks with N. So a binary
// outcome (solved_flag) has a clean null, while a 6-way outcome (truth_verdict) has a
// positive null FLOOR at small N. v0 tracks `n_categories` and only auto-flags the
// BINARY solved_flag outcome; multi-category TVD is reported informationally.
function outcomeDrift(outcomeDim, baseGrp, batchGrp) {
  const base = outcomeMix(baseGrp, outcomeDim);
  const batch = outcomeMix(batchGrp, outcomeDim);
  const cats = [...new Set([...Object.keys(base.frac), ...Object.keys(batch.frac)])];
  let tvd = 0;
  const deltas = {};
  for (const c of cats) {
    const bf = base.frac[c] || 0, nf = batch.frac[c] || 0;
    deltas[c] = { base_frac: r3(bf), batch_frac: r3(nf), delta: r3(nf - bf), base_count: base.counts[c] || 0, batch_count: batch.counts[c] || 0 };
    tvd += Math.abs(nf - bf);
  }
  tvd *= 0.5;
  // POWERED outcome = solved_flag ONLY (the intrinsic solve/refuse binary). `state` and
  // `truth_verdict` are informational: `state` duplicates solved_flag, and `truth_verdict`
  // is a 6-way outcome with a positive TVD null floor at N=47 (it can also collapse to 2
  // categories inside a sub-stratum and masquerade as binary -- keying on the outcome DIM,
  // not the observed category count, avoids that trap).
  const isPoweredOutcome = outcomeDim === 'solved_flag';
  const lowPower = batch.n < PROVISIONAL_TRIAGE_MARKERS.min_batch_n_for_numeric;
  return {
    outcome_dim: outcomeDim, base_n: base.n, batch_n: batch.n,
    n_categories: cats.length,
    tvd: r3(tvd),
    low_power: lowPower,
    provisional_candidate: isPoweredOutcome && !lowPower && tvd >= PROVISIONAL_TRIAGE_MARKERS.outcome_tvd,
    multi_category_informational: !isPoweredOutcome,
    per_category: deltas,
  };
}

// Full comparison. baselineRows are the baseline population sample; batchRows the new
// batch. Both are enriched rows. Stratified by every dim; pooled ('ALL') always present.
export function compareBatch(baselineRows, batchRows, { dims = STRATUM_DIMS, pinsObj = null } = {}) {
  const numeric = {};   // dim -> stratumValue -> [metric drift...]
  const outcomes = {};  // dim -> stratumValue -> [outcome drift...]
  for (const dim of dims) {
    numeric[dim] = {};
    outcomes[dim] = {};
    const baseGroups = groupByDim(baselineRows, dim);
    const batchGroups = groupByDim(batchRows, dim);
    // only report strata present in the batch (drift is about the new batch)
    for (const [val, batchGrp] of batchGroups) {
      const baseGrp = baseGroups.get(val) || [];
      // numeric
      const metricRows = [];
      for (const metric of NUMERIC_METRICS) {
        const baseVals = baseGrp.map((r) => r[metric]).filter((v) => v != null && Number.isFinite(v));
        const batchVals = batchGrp.map((r) => r[metric]).filter((v) => v != null && Number.isFinite(v));
        metricRows.push(numericDrift(metric, robustStats(baseVals), baseVals, batchVals));
      }
      numeric[dim][val] = metricRows;
      // outcomes
      outcomes[dim][val] = OUTCOME_DIMS.map((od) => outcomeDrift(od, baseGrp, batchGrp));
    }
  }
  const pinCheck = checkPins(batchRows, pinsObj);

  // roll-up of candidate flags. Note: the stratification dim is `stratum_dim`; the
  // outcome-mix dim is `outcome_dim` (kept distinct to avoid the earlier name collision).
  const numericCandidates = [];
  for (const dim of dims) for (const val of Object.keys(numeric[dim])) {
    for (const mr of numeric[dim][val]) if (mr.provisional_candidate) numericCandidates.push({ stratum_dim: dim, stratum: val, ...mr });
  }
  const outcomeCandidates = [];        // powered (binary solved_flag) auto-flags
  const outcomeInformational = [];     // multi-category TVD movers (informational, not auto-flagged)
  for (const dim of dims) for (const val of Object.keys(outcomes[dim])) {
    for (const od of outcomes[dim][val]) {
      if (od.provisional_candidate) outcomeCandidates.push({ stratum_dim: dim, stratum: val, ...od });
      else if (od.multi_category_informational && !od.low_power && od.tvd >= PROVISIONAL_TRIAGE_MARKERS.outcome_tvd) {
        outcomeInformational.push({ stratum_dim: dim, stratum: val, ...od });
      }
    }
  }
  numericCandidates.sort((a, b) => Math.abs((b.median_shift_iqr_units || 0)) - Math.abs((a.median_shift_iqr_units || 0)));
  outcomeCandidates.sort((a, b) => (b.tvd || 0) - (a.tvd || 0));
  outcomeInformational.sort((a, b) => (b.tvd || 0) - (a.tvd || 0));

  return {
    baseline_n: baselineRows.length,
    batch_n: batchRows.length,
    numeric_drift: numeric,
    outcome_drift: outcomes,
    pin_divergence: pinCheck,
    candidates: {
      _disclaimer: PROVISIONAL_TRIAGE_MARKERS._disclaimer,
      markers: { numeric_iqr_units_abs: PROVISIONAL_TRIAGE_MARKERS.numeric_iqr_units_abs, numeric_cliffs_abs: PROVISIONAL_TRIAGE_MARKERS.numeric_cliffs_abs, outcome_tvd: PROVISIONAL_TRIAGE_MARKERS.outcome_tvd },
      n_numeric_candidates: numericCandidates.length,
      n_outcome_candidates: outcomeCandidates.length,                 // binary/powered only
      n_outcome_informational: outcomeInformational.length,           // multi-category TVD movers
      n_pin_divergences: pinCheck.available ? pinCheck.n_diverged : null, // reference-core only
      n_pin_cross_arm_expected: pinCheck.available ? pinCheck.n_diverged_cross_arm_expected : null,
      numeric_top: numericCandidates.slice(0, 20),
      outcome_top: outcomeCandidates.slice(0, 20),
      outcome_informational_top: outcomeInformational.slice(0, 20),
    },
  };
}

// Deterministic seeded split (mulberry32) so the self-test is reproducible.
export function seededShuffle(arr, seed = 42) {
  let s = seed >>> 0;
  const rand = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Stratified 50/50 split by a dimension (default arm) so both halves share composition
// -> a genuine NULL for the self-test (no false-alarm calibration).
export function stratifiedHalfSplit(rows, dim = 'arm', seed = 42) {
  const groups = groupByDim(rows, dim);
  const A = [], B = [];
  for (const [, grp] of groups) {
    const sh = seededShuffle(grp, seed);
    sh.forEach((r, i) => (i % 2 === 0 ? A : B).push(r));
  }
  return { A, B };
}
