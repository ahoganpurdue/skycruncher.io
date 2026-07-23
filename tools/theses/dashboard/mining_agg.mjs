#!/usr/bin/env node
// ============================================================================
// tools/theses/dashboard/mining_agg.mjs — MINING-EXERCISE aggregator
// ============================================================================
// Owner directive 2026-07-17: "any test we run that adds value should also be
// represented by widget(s) in our dashboard." This reads the five 2026-07-17
// star-mining exercise artifacts from the rest-integration checkout (a
// separate git worktree/checkout on the same box — these are frozen one-shot
// research outputs, not something this repo's clone ships with) and emits a
// single compact, render-ready JSON the dashboard's Mining tab consumes.
//
// Every number in the output is READ from the source artifact at generation
// time — nothing here is a hand-typed constant. If an artifact is missing or
// fails to parse, its exercise block gets available:false + the error text;
// the tab renders an honest "ARTIFACT ABSENT" state for that widget only
// (LAW 3 — never a placeholder number, never let one missing exercise blank
// the other four).
//
// CLI: node tools/theses/dashboard/mining_agg.mjs
//        [--source DIR] [--out FILE] [--self-test] [--help]
//   Wiring: --out test_results/theses/dashboard/mining_dashboard_data.json
//   makes the summary available at /data/mining_dashboard_data.json via the
//   server's existing generic /data/<name>.json passthrough — NO serve.mjs
//   change/restart needed (same pattern as stage_timings_agg.mjs).
//
// This tool is READ-ONLY on the source artifacts and writes ONLY the summary
// it is told to (stdout by default, or --out FILE).
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(__dirname, '..', '..', '..');

// Frozen source location for the 2026-07-17 mining exercise run (a sibling
// checkout, not this repo — see module doc above). Overridable via --source
// for portability off this box.
const REST_CHECKOUT = process.env.SKYCRUNCHER_REST_CHECKOUT || path.resolve(DEFAULT_REPO, '..', 'rest-integration');
const DEFAULT_SOURCE = path.join(REST_CHECKOUT, 'test_results', 'mining_2026-07-17');

export const SCHEMA = 'mining-dashboard/1';

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const out = { source: DEFAULT_SOURCE, out: null, selfTest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') out.source = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function readJson(abs) {
  // Strips a leading UTF-8 BOM (agent_report_recovered.json carries one —
  // a transport artifact, not a schema feature) before parsing.
  let txt = fs.readFileSync(abs, 'utf8');
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  return JSON.parse(txt);
}

function tryReadJson(abs) {
  if (!fs.existsSync(abs)) return { ok: false, error: `not found: ${abs}` };
  try { return { ok: true, data: readJson(abs) }; }
  catch (err) { return { ok: false, error: `parse failed: ${String(err && err.message || err)}` }; }
}

const round = (x, d = 4) => (typeof x === 'number' && isFinite(x) ? Number(x.toFixed(d)) : (x ?? null));
const truncHash = (h) => (h == null ? null : String(h).length > 16 ? `${String(h).slice(0, 10)}…${String(h).slice(-6)}` : String(h));

// ---- exercise 1: radial flux-droop / vignette + k1 residual curves ---------
function extractRadialFlux(rel) {
  const abs = path.join(rel, 'radial_flux_residuals', 'result.json');
  const r = tryReadJson(abs);
  if (!r.ok) return { available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  try {
    const rigsByName = new Map(Object.values(j.rigs || {}).map((rg) => [rg.rig, rg]));
    const headline = (j.headline_comparison || []).map((h) => {
      const full = rigsByName.get(h.rig);
      const annuli = full && Array.isArray(full.annuli)
        ? full.annuli.map((a) => ({
            r_lo: a.r_lo, r_hi: a.r_hi, n_stars: a.n_stars,
            flux_ratio: round(a.flux_ratio, 4),
            radial_resid_px_med: round(a.radial_resid_px_med, 3),
          }))
        : [];
      const survivor = full && full.survivor_bias && full.survivor_bias.usable
        ? full.survivor_bias.overall_matched_fraction_by_annulus
        : null;
      return {
        rig: h.rig, camera_model: h.camera_model, source_format: h.source_format,
        n_frames_used: h.n_frames_used, n_matched: h.n_matched,
        median_residual_px: h.median_residual_px,
        vignette_class: h.vignette_class,
        flux_droop_pct_center_to_corner: h.flux_droop_pct_center_to_corner,
        flux_dmag: h.flux_dmag,
        monotonic_droop_fraction: h.monotonic_droop_fraction,
        k1_class: h.k1_class,
        k1_center_to_corner_delta_px: h.k1_center_to_corner_delta_px,
        k1_outer_tangential_px: h.k1_outer_tangential_px,
        survivor_note: h.survivor_note,
        annuli,
        survivor_matched_fraction_by_annulus: survivor,
      };
    });
    return {
      available: true, artifact_path: abs,
      generated_at: j.generated_at ?? null, run_date: j.run_date ?? null,
      n_rigs: j.n_rigs ?? null, n_matched_stars_total_scoped: j.n_matched_stars_total_scoped ?? null,
      params: j.params ?? null, method_summary: j.method_summary ?? null,
      headline,
    };
  } catch (err) {
    return { available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

// ---- exercise 2: unmatched-detection separability --------------------------
function extractUnmatchedSeparability(rel) {
  const abs = path.join(rel, 'unmatched_separability', 'result.json');
  const r = tryReadJson(abs);
  if (!r.ok) return { available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  try {
    const mie = j.axes && j.axes.mie_index ? j.axes.mie_index : null;
    const mieStats = mie && Array.isArray(mie.percentile_stats)
      ? Object.fromEntries(mie.percentile_stats.map((s) => [s.matched ? 'matched' : 'unmatched', s]))
      : null;
    // The quintile boundary the owner-quoted "~1.68" threshold refers to: the
    // pooled-population edge between quintile 2 and quintile 3 (read from the
    // quintile crosstab, never hand-typed).
    const q3 = mie && Array.isArray(mie.quintile_crosstab_raw)
      ? mie.quintile_crosstab_raw.find((q) => q.mie_quintile === 3)
      : null;
    return {
      available: true, artifact_path: abs,
      generated_at: j.generated_at ?? null,
      exercise: j.exercise ?? null,
      join_key_note: j.join_key_note ?? null,
      population: j.population ?? null,
      galactic_latitude_coverage: j.galactic_latitude_coverage ?? null,
      mie_index: mieStats ? {
        matched_p50: round(mieStats.matched?.p50, 3),
        unmatched_p50: round(mieStats.unmatched?.p50, 3),
        matched_p10: round(mieStats.matched?.p10, 3), matched_p90: round(mieStats.matched?.p90, 3),
        unmatched_p10: round(mieStats.unmatched?.p10, 3), unmatched_p90: round(mieStats.unmatched?.p90, 3),
        quintile2_3_boundary: q3 ? round(q3.mie_min, 4) : null,
        note: mie.note ?? null,
      } : null,
      separability_verdict: j.separability_verdict ?? null,
      recoverable_by_bucket: j.recoverable_vs_artifact_by_regime ? j.recoverable_vs_artifact_by_regime.by_bucket : null,
      not_measured: Array.isArray(j.not_measured) ? j.not_measured : [],
    };
  } catch (err) {
    return { available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

// ---- exercise 3: confirm-floor population classification -------------------
function extractConfirmFloor(rel) {
  const abs = path.join(rel, 'confirm_floor_population', 'result.json');
  const r = tryReadJson(abs);
  if (!r.ok) return { available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  try {
    const cc = j.cross_check_m66_frame || null;
    const headroom = j.deep_measure_catalog_tier_headroom || null;
    return {
      available: true, artifact_path: abs,
      generated_at: j.generated_at ?? null,
      exercise: j.exercise ?? null,
      population_census: j.population_census ?? null,
      regime_fractions: j.regime_fractions ?? null,
      cross_check: cc ? {
        receipt_sha256: truncHash(cc.receipt_sha256),
        identity_evidence: cc.identity_evidence ?? null,
        rig: cc.measured?.rig ?? null,
        confirm_status: cc.measured?.confirm_status ?? null,
        confirmed_floor_mag: cc.measured?.confirmed_floor_mag ?? null,
        catalog_limit_mag: cc.measured?.catalog_limit_mag ?? null,
        m_lim_fit: cc.measured?.m_lim_fit ?? null,
        r2: cc.measured?.r2 ?? null,
        reliable_fit: cc.measured?.reliable_fit ?? null,
        regime: cc.measured?.regime ?? null,
        thesis2_cited_confirmed_floor: cc.thesis2_cited_confirmed_floor ?? null,
      } : null,
      headroom: headroom ? {
        n_qualifying_frames: headroom.n_qualifying_frames ?? null,
        n_catalog_limited_total: headroom.n_catalog_limited_total ?? null,
        coverage_caveat: headroom.coverage_caveat ?? null,
        top_frames: Array.isArray(headroom.top_10_frames_by_headroom) ? headroom.top_10_frames_by_headroom.slice(0, 3) : [],
      } : null,
      not_measured: Array.isArray(j.not_measured) ? j.not_measured : [],
    };
  } catch (err) {
    return { available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

// ---- exercise 4: ephemeris anchor audit (+ recovered agent report) --------
function extractEphemeris(rel) {
  const abs = path.join(rel, 'ephemeris_anchor_audit', 'result.json');
  const recAbs = path.join(rel, 'ephemeris_anchor_audit', 'agent_report_recovered.json');
  const r = tryReadJson(abs);
  if (!r.ok) return { available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  const rr = tryReadJson(recAbs);
  try {
    const partB = j.partB_planet_events || {};
    let recovered_report;
    if (rr.ok) {
      const d = rr.data;
      recovered_report = {
        available: true, artifact_path: recAbs,
        // The recovered report's `findings` array is ABSENT (transport
        // failure at capture time) — we surface only what survived:
        // summary, tuning_recommendations, not_measured. Never invented.
        findings_note: 'findings array not present in the recovered report (lost to a transport failure at capture time) — rendering summary + tuning_recommendations + not_measured only',
        summary: typeof d.summary === 'string' ? d.summary : null,
        tuning_recommendations: Array.isArray(d.tuning_recommendations) ? d.tuning_recommendations : [],
        not_measured: Array.isArray(d.not_measured) ? d.not_measured : [],
      };
    } else {
      recovered_report = { available: false, artifact_path: recAbs, error: rr.error };
    }
    return {
      available: true, artifact_path: abs,
      generated_at: j.generated_at ?? null,
      exercise: j.exercise ?? null,
      wcs_dialect: j.wcs_dialect ?? null,
      trust_overall: j.partA_trust_population ? j.partA_trust_population.overall : null,
      trust_by_rig_class: j.partA_trust_population ? j.partA_trust_population.by_rig_class : null,
      partB: {
        solved_frames_considered_for_projection: partB.solved_frames_considered_for_projection ?? null,
        solved_frames_wcs_absent: partB.solved_frames_wcs_absent ?? null,
        in_fov_event_count: partB.in_fov_event_count ?? null,
      },
      ephemeris_provenance: j.ephemeris_provenance ?? null,
      verdict: j.verdict ?? null,
      recovered_report,
    };
  } catch (err) {
    return { available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

// ---- exercise 5: budget burn forensics on no-solves -------------------------
function extractBudgetBurn(rel) {
  const abs = path.join(rel, 'budget_burn_forensics', 'result.json');
  const r = tryReadJson(abs);
  if (!r.ok) return { available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  try {
    const rows = (j.burn_table_by_regime_outcome || []).map((row) => ({
      regime: row.regime, outcome: row.outcome, n: row.n,
      total_solve_time_ms_p50: row.total_solve_time_ms?.median_ms ?? null,
      uw_sweep_ms_p50: row.uw_sweep_ms?.median_ms ?? null,
      quad_wasm_ms_p50: row.quad_wasm_ms?.median_ms ?? null,
      uw_escalation_ms_p50: row.uw_escalation_ms?.median_ms ?? null,
      residual_ms_INFERRED_p50: row.residual_ms_INFERRED?.median_ms ?? null,
      budget_exhausted_rate: row.budget_exhausted_rate ?? null,
    }));
    return {
      available: true, artifact_path: abs,
      status: j.status ?? null, generated_at: j.generated_at ?? null,
      method_note: j.method_note ?? null,
      frames_total: j.population ? j.population.frames_total : null,
      burn_rows: rows,
      top_budget_sinks_on_no_solves: j.top_budget_sinks_on_no_solves ?? null,
      quad_gen_budget_recommendation: j.solver_quad_gen_budget_ms_recommendation ?? null,
      top_rejection_reasons: Array.isArray(j.top_rejection_reasons_no_solves) ? j.top_rejection_reasons_no_solves.slice(0, 6) : [],
      not_measured: Array.isArray(j.not_measured) ? j.not_measured : [],
    };
  } catch (err) {
    return { available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

// ---- exercise 6: cross-frame star pivot (relative-calibration noise floor) --
function extractStarPivot(rel) {
  const abs = path.join(rel, 'star_pivot', 'result.json');
  const r = tryReadJson(abs);
  if (!r.ok) return { available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  try {
    const mult = j.multiplicity || {};
    const dm = mult.distinct_measurements || {};
    const nf = j.noise_floor || {};
    const wr = nf.within_rig_sigma_mag_robust || {};
    const ar = nf.across_rig_sigma_mag_robust || {};
    const offset = nf.across_rig_offset_span_mag || {};
    return {
      available: true, artifact_path: abs,
      generated_at: j.generated_at ?? null, run_date: j.run_date ?? null,
      exercise: j.exercise ?? null, label: j.label ?? null,
      sigma_columns_note: j.method_summary ? j.method_summary.sigma_columns : null,
      multiplicity: {
        n_distinct_catalog_stars: mult.n_distinct_catalog_stars ?? null,
        stars_ge2: dm.stars_ge2 ?? null,
        stars_ge5: dm.stars_ge5 ?? null,
        stars_ge10: dm.stars_ge10 ?? null,
        stars_multi_rig: dm.stars_multi_rig ?? null,
        note: dm.note ?? null,
      },
      noise_floor: {
        within_rig: { n: wr.n ?? null, median: round(wr.median, 4), p90: round(wr.p90, 4) },
        across_rig: { n: ar.n ?? null, median: round(ar.median, 4), p90: round(ar.p90, 4) },
        across_rig_offset_span_median: round(offset.median, 4),
        by_rig: Array.isArray(nf.within_rig_sigma_by_rig) ? nf.within_rig_sigma_by_rig.map((rr2) => ({
          rig: rr2.rig, is_synthetic: !!rr2.is_synthetic, n_stars: rr2.n_stars,
          median_mag: round(rr2.within_rig_sigma_median_mag, 4),
          p90_mag: round(rr2.within_rig_sigma_p90_mag, 4),
        })) : [],
        synthetic_caveat: nf.synthetic_caveat ?? null,
        interpretation: nf.interpretation ?? null,
      },
    };
  } catch (err) {
    return { available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

// ---- exercise 7: error-budget ledger v0 (vintage-keyed same-frame deltas) --
function extractErrorLedger(rel) {
  const abs = path.join(rel, 'error_ledger', 'result.json');
  const r = tryReadJson(abs);
  if (!r.ok) return { available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  try {
    const sfmv = j.same_frame_multi_vintage || {};
    const changes = Array.isArray(sfmv.solve_status_changes) ? sfmv.solve_status_changes : [];
    // decoder-confounded (a rawler/CR2 decoder arm participates in the span) vs
    // pure-schema (FITS, no decoder arm involved) — split read straight off
    // each cluster's own decoder_arms list, not string-matched on filenames.
    const decoderConfounded = changes.filter((c) => Array.isArray(c.decoder_arms) && c.decoder_arms.length > 0);
    const pureSchema = changes.filter((c) => !Array.isArray(c.decoder_arms) || c.decoder_arms.length === 0);
    const ledgers = Array.isArray(j.ledgers) ? j.ledgers : [];
    const shrinkRow = (row) => ({
      schema_version: row.schema_version, config_hash: row.effective_config_hash ?? null,
      solved: !!row.solved,
      stars_matched: row.metrics ? row.metrics.stars_matched : null,
      positional_rms_arcsec: row.metrics ? row.metrics.positional_rms_arcsec : null,
      confidence: row.metrics ? row.metrics.confidence : null,
      dm_robust_sigma_mag: row.metrics ? row.metrics.dm_robust_sigma_mag : null,
    });
    const spotlight = (predicate) => {
      const l = ledgers.find(predicate);
      if (!l) return null;
      const ed = l.ledger && l.ledger.endpoint_delta;
      return {
        rig: l.rig,
        n_vintages: l.cluster_identity ? l.cluster_identity.n_vintages : null,
        input_basename_aliases: l.cluster_identity ? l.cluster_identity.input_basename_aliases : [],
        endpoint_delta: ed ? {
          from_vintage: ed.from_vintage, to_vintage: ed.to_vintage,
          stars_matched: ed.stars_matched, positional_rms_arcsec: ed.positional_rms_arcsec,
          confidence: ed.confidence, dm_robust_sigma_mag: ed.dm_robust_sigma_mag,
        } : null,
        flat: !!(ed && ed.stars_matched && ed.stars_matched.pct_change === 0
          && ed.positional_rms_arcsec && ed.positional_rms_arcsec.pct_change === 0
          && ed.confidence && ed.confidence.pct_change === 0),
        rows: (l.ledger && Array.isArray(l.ledger.rows)) ? l.ledger.rows.map(shrinkRow) : [],
      };
    };
    const aliasMatch = (re) => (l) => l.cluster_identity && Array.isArray(l.cluster_identity.input_basename_aliases)
      && l.cluster_identity.input_basename_aliases.some((a) => re.test(a));
    const shrinkChange = (c) => ({
      rig: c.rig, input_basenames: c.input_basenames, schema_versions: c.schema_versions,
      decoder_arms: c.decoder_arms, direction: c.direction,
      solved_vintages: c.solved_vintages, no_solve_vintages: c.no_solve_vintages,
    });
    return {
      available: true, artifact_path: abs,
      generated_at: j.generated_at ?? null, run_date: j.run_date ?? null,
      exercise: j.exercise ?? null, label: j.label ?? null,
      n_frame_clusters: sfmv.n_frame_clusters ?? null,
      n_clusters_ge2_receipts: sfmv.n_clusters_ge2_receipts ?? null,
      n_clusters_ge2_vintages: sfmv.n_clusters_ge2_vintages ?? null,
      n_clusters_with_solve_status_change: sfmv.n_clusters_with_solve_status_change ?? null,
      regressions: {
        total: changes.length,
        decoder_confounded_n: decoderConfounded.length,
        pure_schema_n: pureSchema.length,
        decoder_confounded: decoderConfounded.map(shrinkChange),
        pure_schema: pureSchema.map(shrinkChange),
      },
      spotlight: {
        m66: spotlight(aliasMatch(/M[\s_]?66/i)),
        m51: spotlight(aliasMatch(/M51/i)),
        cr2_pin: spotlight(aliasMatch(/control_cr2/i)),
      },
      n_ledgers: j.n_ledgers ?? ledgers.length ?? null,
      not_measured: Array.isArray(j.not_measured) ? j.not_measured : [],
    };
  } catch (err) {
    return { available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

// ---- exercise 8: m4 detection recall (miss-population mining, 2026-07-18) --
// Unlike exercises 1-7, this artifact lives IN THIS REPO (not the sibling
// rest-integration checkout) at test_results/m4_recall_2026-07-18/widget.json
// — a builder-produced, already render-ready shape (see that file's own
// generation). We still extract only the fields the widget needs (never a
// blind pass-through) and drop internal file:line "seam" references, which
// are implementation pointers, not owner-facing copy (dashboard copy rule:
// no internal file paths visible in the widget UI).
function extractM4Recall() {
  const abs = path.join(DEFAULT_REPO, 'test_results', 'm4_recall_2026-07-18', 'widget.json');
  const r = tryReadJson(abs);
  if (!r.ok) return { available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  try {
    const h = j.headline || {};
    const pf = h.pooled_fraction_do_not_quote || {};
    const recallByClass = Array.isArray(j.recall_by_class) ? j.recall_by_class.map((c) => ({
      frame: c.frame, rig: c.rig, class: c.class, catalog: c.catalog,
      in_frame: c.in_frame, overall_miss_rate_wide: round(c.overall_miss_rate_wide, 4),
      honest_recall_to_floor: c.honest_recall_to_floor, confidence: c.confidence,
    })) : [];
    const magM66 = j.recall_by_magnitude_M66 || {};
    const bins = Array.isArray(magM66.bins) ? magM66.bins.map((b) => ({
      mag: b.mag, n: b.n, recall_wide: round(b.recall_wide, 4), recall_tight: round(b.recall_tight, 4),
    })) : [];
    // top 3 levers, name + support tier only — the "seam" (code pointer) field
    // is intentionally dropped here (not owner-facing UI copy).
    const levers = Array.isArray(j.levers_ranked) ? j.levers_ranked.slice(0, 3).map((lv) => ({
      rank: lv.rank, lever: lv.lever, support: lv.support, gate: lv.gate ?? null,
    })) : [];
    return {
      available: true, artifact_path: abs,
      generated_at: j.generated_at ?? null,
      exercise: j.exercise ?? null,
      title: j.title ?? null,
      label: j.label ?? null,
      standing_claim: h.standing_claim ?? null,
      standing_claim_status: h.standing_claim_status ?? null,
      corrected_statement: h.corrected_statement ?? null,
      pooled_fraction_refuted: {
        value_wide: pf.value_wide ?? null,
        status: pf.status ?? null,
        reasons: Array.isArray(pf.reasons) ? pf.reasons : [],
      },
      recall_by_class: recallByClass,
      recall_by_magnitude_M66: {
        note: magM66.note ?? null,
        bins,
        faint_wide_floor_note: magM66.faint_wide_floor_note ?? null,
      },
      top_levers: levers,
      // Owner methodology-circularity correction (ADDENDUM.md, 2026-07-18):
      // one visible caveat line, verbatim intent, never dropped from the widget.
      methodology_caveat: 'Recall measured for round stars at model-predicted positions, inner field — corner regime pending.',
      not_measured: Array.isArray(j.not_measured) ? j.not_measured : [],
    };
  } catch (err) {
    return { available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

// ---- exercise 9: W5 proper-test adjudication (quad-gen graduation, 2026-07-18)
// Like exercise 8 (m4_recall), the source artifacts live IN THIS REPO at
// test_results/w5_proper_2026-07-18/ (banked frozen audit result.json +
// REPORT.md, plus odds_v2_probe.json — a timestamped signed-odds snapshot).
// The audit is a DRY-RUN over MID-RUN lanes: we carry that honesty label
// verbatim and never round the receipt-existence counts into "final" figures.
// V1 odds (clamped) come from the FROZEN proper quad-gen audit; V2 odds
// (signed) come from a live probe over the full-stack arms (different arm set,
// still filling) — the widget states both provenances rather than blending
// them. Every number is read from the source at snapshot-build time.
function w5Stat(s) {
  if (!s || typeof s !== 'object') return null;
  return { n: s.n ?? null, min: round(s.min, 3), q1: round(s.q1, 3), median: round(s.median, 3), q3: round(s.q3, 3), max: round(s.max, 3), mean: round(s.mean, 3) };
}
function extractW5Proper() {
  const abs = path.join(DEFAULT_REPO, 'test_results', 'w5_proper_2026-07-18', 'result.json');
  const v2abs = path.join(DEFAULT_REPO, 'test_results', 'w5_proper_2026-07-18', 'odds_v2_probe.json');
  const r = tryReadJson(abs);
  if (!r.ok) return { available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  const v2r = tryReadJson(v2abs);
  try {
    const sm = j.summary || {};
    const dry = sm.dry_run || {};
    const off = sm.off_baseline || {};
    const fpBar = sm.fp_bar || {};
    const gradBar = fpBar.graduation_bar || {};
    const rowsSrc = Array.isArray(j.rows) ? j.rows : [];
    // Per-frame compact rows (all 44 = 42 adjudicated + 2 corrupt-source).
    const rows = rowsSrc.map((x) => {
      const p = x.proper || {};
      const ta = p.top_anchored && typeof p.top_anchored === 'object' ? p.top_anchored : null;
      const oracle = x.corrupt ? 'corrupt-source'
        : (x.label && x.label.solved ? 'solved' : (x.label ? 'unsolved' : 'no-label'));
      const outcome = x.corrupt ? 'EXCLUDED-CORRUPT-SOURCE'
        : (p.verdict && p.verdict.reason ? p.verdict.reason : (p.present ? 'NO-VERDICT' : 'NO-RECEIPT'));
      return {
        base: x.base,
        class: x.class ?? null,
        arm: x.proper_arm ?? null,
        oracle,
        oracle_tp_class: x.label && x.label.tp_class ? x.label.tp_class : null,
        outcome,
        gap: (p.gap && (p.gap.gap || p.gap)) || (x.corrupt ? 'excluded' : null),
        gap_detail: p.gap && p.gap.detail ? p.gap.detail : null,
        anchored: ta ? ta.anchored : null,
        anchored_is_truth: ta ? !!ta.is_truth : null,
        top_odds_v1: p.deep_judge && typeof p.deep_judge.top_odds === 'number' ? round(p.deep_judge.top_odds, 2) : null,
        off_shipped: !!(x.off && x.off.shipped),
        off_verdict: x.off && x.off.adj ? x.off.adj.verdict : null,
      };
    });
    // Gap tally read from the rows (never hand-typed).
    const gapTally = {};
    for (const rr of rows) { const g = rr.gap || 'none'; gapTally[g] = (gapTally[g] || 0) + 1; }
    // Cocoon "true accepts blocked by legacy verifyWCS gate" = verify-blocked cocoon rows.
    const cocoonVerifyBlocked = rows.filter((rr) => rr.class === 'cocoon' && rr.gap === 'verify-blocked').length;
    const oc = sm.odds_calibration_overall || {};
    const v2 = v2r.ok ? v2r.data : null;
    return {
      available: true, artifact_path: abs,
      generated_at: sm.generated_at ?? null,
      mode: sm.mode ?? null,
      dry_run: {
        lanes_status: dry.lanes_status ?? null,
        off_receipts: dry.off_receipts ?? null,
        proper_uw_receipts: dry.proper_uw_receipts ?? null,
        proper_cocoon_receipts: dry.proper_cocoon_receipts ?? null,
        labels_solved: dry.labels_solved ?? null,
        labels_corrupt: Array.isArray(dry.labels_corrupt) ? dry.labels_corrupt : [],
      },
      headline: {
        cocoon_true_accepts_blocked: cocoonVerifyBlocked,
        proper_shipped: gradBar.proper_shipped ?? null,
        proper_shipped_fp: gradBar.proper_fp ?? null,
        graduation_pass: gradBar.PASS ?? null,
        off_receipts: off.n_receipts ?? null,
        off_baseline_tp: off.baseline_solves_tp ?? null,
        off_no_solve: off.no_solve ?? null,
        off_false_positives: off.false_positives ?? null,
        red_alert: fpBar.red_alert ?? null,
        fp_frame: Array.isArray(off.fp_frames) && off.fp_frames[0] ? {
          base: off.fp_frames[0].base, sep_deg: off.fp_frames[0].sep_deg,
          ra_h: off.fp_frames[0].ra_h, dec: off.fp_frames[0].dec, scale: off.fp_frames[0].scale,
        } : null,
      },
      odds_v1: {
        source: 'frozen proper quad-gen audit',
        metric: 'clamped odds',
        truth: w5Stat(oc.truth_pose_odds),
        false: w5Stat(oc.false_pose_odds),
        separable: false,
        read: 'the strongest FALSE pose out-odds the strongest TRUTH pose — an odds threshold alone cannot gate a quad-gen accept.',
      },
      odds_v2: v2 ? {
        available: true,
        source: 'live probe over full-stack arms',
        metric: 'signed oddsV2',
        generated_at: v2.generated_at ?? null,
        caveat: v2.provenance ? v2.provenance.source_state : null,
        distinct_from_frozen: v2.provenance ? v2.provenance.distinct_from_frozen_audit : null,
        coverage: v2.provenance ? v2.provenance.coverage : null,
        truth: v2.odds_v2_signed_probe ? w5Stat(v2.odds_v2_signed_probe.truth) : null,
        false: v2.odds_v2_signed_probe ? w5Stat(v2.odds_v2_signed_probe.false) : null,
        gap: v2.odds_v2_signed_probe && v2.odds_v2_signed_probe.gap ? round(v2.odds_v2_signed_probe.gap.gap, 2) : null,
        separable: v2.odds_v2_signed_probe ? v2.odds_v2_signed_probe.separable : null,
        clamped_probe: v2.odds_v1_clamped_probe ? {
          truth: w5Stat(v2.odds_v1_clamped_probe.truth),
          false: w5Stat(v2.odds_v1_clamped_probe.false),
          gap: v2.odds_v1_clamped_probe.gap ? round(v2.odds_v1_clamped_probe.gap.gap, 2) : null,
          separable: v2.odds_v1_clamped_probe.separable,
        } : null,
      } : { available: false, artifact_path: v2abs, error: v2r.error },
      gap_tally: gapTally,
      verdict_reason_by_arm: {
        proper_uw: sm.per_arm && sm.per_arm.proper_uw ? sm.per_arm.proper_uw.verdict_reason : null,
        proper_cocoon: sm.per_arm && sm.per_arm.proper_cocoon ? sm.per_arm.proper_cocoon.verdict_reason : null,
      },
      rows,
      per_frame_v2_note: 'Per-frame odds are V1 (clamped, frozen audit top_odds). Signed V2 is a distribution-level metric over a different arm set — see the odds-separation panel; per-frame V2 is NOT MEASURED for the proper arms.',
    };
  } catch (err) {
    return { available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

// ---- exercise 10: corpus-readiness scoreboard (the 10-20x gate, 2026-07-18) -
// Owner's corpus-gate program: a corpus-wide re-run is an OWNER CALL, unlocked
// only once we prove a >=10-20x throughput gain. This scoreboard reads one
// banked artifact PER accelerator factor (each in THIS repo's test_results, or
// on the D: test_artifacts root for the big index) and reports the MEASURED
// number for each — never a hand-typed figure. Every factor carries its own
// available flag: a missing/unmeasured factor renders ARTIFACT ABSENT for THAT
// row only (LAW 3) and is self-healing (a later re-gen picks the artifact up).
// The product line is COMPOSITION, not measurement, and is labelled as such:
// the factors overlap the same judge stage / one axis is absent, so end-to-end
// >=10-20x is NOT proven from banked data. The gate statement is carried
// verbatim: a corpus run stays an OWNER CALL until the end-to-end multiplier
// is proven.
function cgEarlyExit() {
  const abs = path.join(DEFAULT_REPO, 'test_results', 'earlyexit_desk_2026-07-18', 'earlyexit_desk.json');
  const r = tryReadJson(abs);
  const base = { key: 'early_exit', name: 'Early-exit (first-cluster judge gate)', status: 'LIVE' };
  if (!r.ok) return { ...base, available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  try {
    const bars = j.bars || (j.meta && j.meta.bars) || {};
    const A = (j.perBar && j.perBar.A) || {};
    const frames = Array.isArray(j.frames) ? j.frames : [];
    const coc = frames.filter((f) => f.arm === 'cocoon');
    const uw = frames.filter((f) => f.arm === 'uw');
    const cocA = coc.map((f) => f.perBar && f.perBar.A).filter(Boolean);
    const uwA = uw.map((f) => f.perBar && f.perBar.A).filter(Boolean);
    const nActuals = cocA.map((a) => a.nActual).filter((n) => typeof n === 'number');
    const cocMedianRatio = A.cocoon && A.cocoon.median != null ? A.cocoon.median : null;
    return {
      ...base,
      status_label: 'LIVE · bar 398.45 owner-confirmed',
      available: true, artifact_path: abs,
      bar_oddsV2: bars.A ?? null,
      measured: {
        cocoon_truth_frames: coc.length,
        fires_on_cocoon: cocA.filter((a) => a.fired).length,
        all_exit_index_0: cocA.length > 0 && cocA.every((a) => a.exitIdx === 0),
        clusters_judged_on_exit: 1,
        clusters_judged_range_full: nActuals.length ? [Math.min(...nActuals), Math.max(...nActuals)] : null,
        wrong_region_fires: A.correctness ? A.correctness.wrongRegionCount : null,
        gen_miss_frames_uw: uw.length,
        fires_on_gen_miss: uwA.filter((a) => a.fired).length,
        cocoon_judge_ratio_median: cocMedianRatio,
        cluster_reduction_x: cocMedianRatio ? round(1 / cocMedianRatio, 1) : null,
      },
      label: 'judge-stage cluster-count reduction on truth frames; wall-clock saving is judge-stage-scoped (INDICATIVE)',
      cite: 'test_results/earlyexit_desk_2026-07-18/earlyexit_desk.json',
    };
  } catch (err) {
    return { ...base, available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

function cgGpuNull() {
  const abs = path.join(DEFAULT_REPO, 'test_results', 'gpu_null_2026-07-18', 'null_bench.json');
  const r = tryReadJson(abs);
  const base = { key: 'gpu_judge', name: 'GPU judge + null model', status: 'LIVE' };
  if (!r.ok) return { ...base, available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  try {
    const cases = Array.isArray(j.cases) ? j.cases : [];
    const pick = (c) => c ? {
      nCatQ: c.nCatQ ?? null,
      cpu_ms: round(c.pureCpu_ms_median, 1),
      gpu_ms: round(c.gpuObsGpuNull_ms_median, 1),
      speedup_x: round(c.speedup_pureCpu_over_gpuNull, 2),
      verdict_identical: c.anchored_verdict_identical ?? null,
    } : null;
    const c126 = cases.find((c) => /126K/i.test(c.label || ''));
    const c10 = cases.find((c) => /10K/i.test(c.label || ''));
    return {
      ...base,
      status_label: 'LIVE',
      available: true, artifact_path: abs,
      substrate: j.substrate ?? null,
      measured: { band_126k: pick(c126), band_10k: pick(c10) },
      headline_speedup_x: c126 ? round(c126.speedup_pureCpu_over_gpuNull, 2) : null,
      label: 'Dawn substrate, INDICATIVE under load; decision-identity preserved (anchored verdict identical CPU↔GPU)',
      cite: 'test_results/gpu_null_2026-07-18/null_bench.json',
    };
  } catch (err) {
    return { ...base, available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

function cgParallel() {
  const abs = path.join(DEFAULT_REPO, 'test_results', 'parallel_runner_2026-07-18', 'scaling_proof.json');
  const r = tryReadJson(abs);
  const base = { key: 'frame_parallel', name: 'Frame parallelism (multi-frame overlap)', status: 'MERGED · tool-ready' };
  if (!r.ok) {
    // Honest absence: the scaling_proof artifact is not present on this box.
    // The lever is MERGED (tool-ready) but its speedup is NOT MEASURED here —
    // an idle-box re-measure lands the number and this row self-heals.
    return { ...base, available: false, artifact_path: abs, error: r.error,
      label: 'INDICATIVE — idle-box re-measure pending; scaling_proof.json not present on this box (row is NOT MEASURED until it lands)' };
  }
  const j = r.data;
  try {
    // Best-effort surface of a P=4 overlap speedup without assuming a schema:
    // check a few plausible keys, else carry null (honest) rather than guess.
    const p4 = j.p4_speedup ?? j.speedup_p4 ?? j.overlap_x_p4 ?? j.overlap_speedup ?? null;
    return {
      ...base,
      status_label: 'MERGED · tool-ready',
      available: true, artifact_path: abs,
      measured: {
        p4_overlap_x: typeof p4 === 'number' ? round(p4, 2) : null,
        cpu_load_pct: j.cpu_load_pct ?? j.system_busy_pct ?? null,
        raw_present: true,
      },
      label: 'INDICATIVE — idle-box re-measure pending (banked run was under CPU contention)',
      cite: 'test_results/parallel_runner_2026-07-18/scaling_proof.json',
    };
  } catch (err) {
    return { ...base, available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

function cgReseq() {
  const abs = path.join(DEFAULT_REPO, 'test_results', 'resequencing_package_2026-07-18', 'resequencing_package.json');
  const r = tryReadJson(abs);
  const base = { key: 'quad_first', name: 'Quad-first re-sequencing', status: 'DEFERRED' };
  if (!r.ok) return { ...base, available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  try {
    const rec = typeof j.recommendation === 'string' ? (j.recommendation.split('. ')[0] + '.') : null;
    const pinVerdict = j.cr2_pin_safety && typeof j.cr2_pin_safety.verdict === 'string' ? j.cr2_pin_safety.verdict : null;
    return {
      ...base,
      status_label: 'DEFERRED · net-negative on banked pop; pin-safety falsified',
      available: true, artifact_path: abs,
      measured: {
        frames_rung_solves: j.decision_math ? j.decision_math.frames_rung_SOLVES : null,
        recommendation: rec,
        cr2_pin_safety_falsified: pinVerdict ? /FALSIFIED/i.test(pinVerdict) : null,
      },
      label: 'DEFERRED — no throughput contribution to the gate; build behind a default-OFF flag for continued A/B only',
      cite: 'test_results/resequencing_package_2026-07-18/resequencing_package.json',
    };
  } catch (err) {
    return { ...base, available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

function cgMidIndex() {
  const abs = path.join('D:\\', 'AstroLogic', 'test_artifacts', 'quadidx_mid_2026-07-18', 'summary.json');
  const r = tryReadJson(abs);
  const base = { key: 'mid_index', name: 'Mid-tier quad index', status: 'BUILT · VALIDATED' };
  if (!r.ok) return { ...base, available: false, artifact_path: abs, error: r.error };
  const j = r.data;
  try {
    return {
      ...base,
      status_label: 'BUILT + VALIDATED · engine adoption owner-gated',
      available: true, artifact_path: abs,
      measured: {
        release: j.release ?? null,
        stars: j.stars ?? null,
        total_quads: j.total_quads ?? null,
        bands: Array.isArray(j.per_band) ? j.per_band.length : null,
        build_wall_s: j.wall_s ?? null,
        monolith_bytes: j.monolith ? j.monolith.bytes : null,
        aggregate_md5: truncHash(j.v2_aggregate_md5 ?? (j.monolith ? j.monolith.aggregate_md5 : null)),
      },
      label: 'coverage/latency enabler (no direct wall-clock multiplier); engine adoption = OWNER CALL',
      cite: 'D:/AstroLogic/test_artifacts/quadidx_mid_2026-07-18/summary.json',
    };
  } catch (err) {
    return { ...base, available: false, artifact_path: abs, error: `extraction failed: ${String(err && err.message || err)}` };
  }
}

function extractCorpusGate() {
  const early = cgEarlyExit();
  const gpu = cgGpuNull();
  const parallel = cgParallel();
  const reseq = cgReseq();
  const mid = cgMidIndex();
  const factors = [early, gpu, parallel, reseq, mid];
  // PROJECTED product — composition, NOT measurement. Only the two factors with
  // a measured stage-multiplier are composed, and both act on the SAME deep-
  // judge stage, so the product is stage-scoped (never an end-to-end figure).
  const ex = early.available && early.measured ? early.measured.cluster_reduction_x : null;
  const gx = gpu.available ? gpu.headline_speedup_x : null;
  const stageProduct = (typeof ex === 'number' && typeof gx === 'number') ? round(ex * gx, 0) : null;
  const projection = {
    label: 'PROJECTED',
    scope: 'deep-judge / scoring stage only — NOT end-to-end solve or corpus wall-clock',
    composed_from: [
      typeof ex === 'number' ? `early-exit cluster-count reduction ≈ ${ex}× (cocoon truth arm)` : 'early-exit — NOT MEASURED',
      typeof gx === 'number' ? `GPU judge per-cluster speedup ${gx}× (126K band)` : 'GPU judge — NOT MEASURED',
    ],
    stage_scoped_product_x: stageProduct,
    caveat: 'Composition, not measurement. The two composed factors overlap the SAME judge stage, so this is a stage-scoped projection — it is NOT an end-to-end solve/corpus speedup. Frame-parallelism (the true corpus-throughput axis) is NOT MEASURED on this box; the mid-tier index is a coverage enabler, not a multiplier.',
    end_to_end_10_20x_proven: false,
  };
  return {
    available: true,
    generated_at: new Date().toISOString(),
    title: 'Corpus-readiness scoreboard — the 10–20× gate',
    label: 'the owner gate: a corpus-wide re-run stays an OWNER CALL until an end-to-end ≥10–20× throughput gain is PROVEN',
    gate: { bar_low_x: 10, bar_high_x: 20, statement: 'corpus run = OWNER CALL at ≥10–20× proven.', end_to_end_proven: false },
    factors,
    projection,
  };
}

export function buildMiningSnapshot(sourceDir) {
  return {
    generated_at: new Date().toISOString(),
    schema: SCHEMA,
    source_root: sourceDir,
    exercises: {
      radial_flux_residuals: extractRadialFlux(sourceDir),
      unmatched_separability: extractUnmatchedSeparability(sourceDir),
      confirm_floor_population: extractConfirmFloor(sourceDir),
      ephemeris_anchor_audit: extractEphemeris(sourceDir),
      budget_burn_forensics: extractBudgetBurn(sourceDir),
      star_pivot: extractStarPivot(sourceDir),
      error_ledger: extractErrorLedger(sourceDir),
      m4_recall: extractM4Recall(),
      w5_proper: extractW5Proper(),
      corpus_gate: extractCorpusGate(),
    },
  };
}

function selfTest(sourceDir) {
  const snap = buildMiningSnapshot(sourceDir);
  const fails = [];
  const ex = snap.exercises;
  if (!ex.radial_flux_residuals.available) fails.push(`radial_flux_residuals unavailable: ${ex.radial_flux_residuals.error}`);
  else {
    const r60d = ex.radial_flux_residuals.headline.find((h) => /60D/i.test(h.rig));
    if (!r60d || Math.abs(r60d.flux_droop_pct_center_to_corner - 19.19) > 0.01) fails.push('60D flux droop mismatch (expected ~19.19)');
    const seestar = ex.radial_flux_residuals.headline.find((h) => /Seestar S30/i.test(h.rig));
    if (!seestar || Math.abs(seestar.flux_droop_pct_center_to_corner - 0.4) > 0.01) fails.push('SeeStar flux droop mismatch (expected ~0.4)');
  }
  if (!ex.unmatched_separability.available) fails.push(`unmatched_separability unavailable: ${ex.unmatched_separability.error}`);
  else {
    const m = ex.unmatched_separability.mie_index;
    if (!m || Math.abs(m.matched_p50 - 0.283) > 0.01 || Math.abs(m.unmatched_p50 - 6.239) > 0.01) fails.push('mie_index median mismatch (expected ~0.28 / ~6.24)');
  }
  if (!ex.confirm_floor_population.available) fails.push(`confirm_floor_population unavailable: ${ex.confirm_floor_population.error}`);
  else {
    const rf = ex.confirm_floor_population.regime_fractions;
    if (!rf || Math.abs(rf.fractions.CATALOG_LIMITED - 0.6) > 0.01) fails.push('confirm-floor CATALOG_LIMITED fraction mismatch (expected 0.6)');
  }
  if (!ex.ephemeris_anchor_audit.available) fails.push(`ephemeris_anchor_audit unavailable: ${ex.ephemeris_anchor_audit.error}`);
  else if (ex.ephemeris_anchor_audit.verdict?.engine_confirmed_in_fov_events !== 0) fails.push('ephemeris verdict engine_confirmed_in_fov_events expected 0');
  if (!ex.budget_burn_forensics.available) fails.push(`budget_burn_forensics unavailable: ${ex.budget_burn_forensics.error}`);
  else {
    const rec = ex.budget_burn_forensics.quad_gen_budget_recommendation;
    if (!rec || Math.abs(rec.p50_ms - 265350) > 1) fails.push('quad-gen budget p50 mismatch (expected 265350ms)');
  }
  if (!ex.star_pivot.available) fails.push(`star_pivot unavailable: ${ex.star_pivot.error}`);
  else {
    const m = ex.star_pivot.multiplicity;
    if (!m || m.stars_ge2 !== 5035 || m.stars_ge5 !== 1905 || m.stars_ge10 !== 1620 || m.stars_multi_rig !== 322) fails.push('star_pivot multiplicity mismatch (expected 5035/1905/1620/322)');
    const nfl = ex.star_pivot.noise_floor;
    if (!nfl || Math.abs(nfl.within_rig.median - 0.2192) > 0.001 || Math.abs(nfl.across_rig.median - 0.3559) > 0.001) fails.push('star_pivot noise-floor median mismatch (expected within 0.2192 / across 0.3559)');
  }
  if (!ex.error_ledger.available) fails.push(`error_ledger unavailable: ${ex.error_ledger.error}`);
  else {
    const rg = ex.error_ledger.regressions;
    if (!rg || rg.total !== 17 || rg.decoder_confounded_n !== 11 || rg.pure_schema_n !== 6) fails.push('error_ledger regression split mismatch (expected 17 total = 11 decoder-confounded + 6 pure-schema)');
    const m66 = ex.error_ledger.spotlight && ex.error_ledger.spotlight.m66;
    if (!m66 || !m66.endpoint_delta || m66.endpoint_delta.stars_matched.from !== 272 || m66.endpoint_delta.stars_matched.to !== 696) fails.push('error_ledger M66 spotlight mismatch (expected 272->696 matched)');
    const cr2 = ex.error_ledger.spotlight && ex.error_ledger.spotlight.cr2_pin;
    if (!cr2 || !cr2.flat) fails.push('error_ledger CR2-pin spotlight expected flat=true (LAW 1: measurement-layer-only vintages must not move the solve pin)');
  }
  if (!ex.m4_recall.available) fails.push(`m4_recall unavailable: ${ex.m4_recall.error}`);
  else {
    if (ex.m4_recall.standing_claim_status !== 'REFUTED_AS_WRITTEN') fails.push('m4_recall standing_claim_status expected REFUTED_AS_WRITTEN');
    const bins = ex.m4_recall.recall_by_magnitude_M66.bins;
    if (!bins || bins.length !== 8) fails.push('m4_recall recall_by_magnitude_M66 expected 8 bins');
    const b1315 = bins && bins.find((b) => b.mag === '14-15');
    if (!b1315 || Math.abs(b1315.recall_tight - 0.06) > 0.001) fails.push('m4_recall mag 14-15 recall_tight mismatch (expected 0.06)');
  }
  if (!ex.w5_proper.available) fails.push(`w5_proper unavailable: ${ex.w5_proper.error}`);
  else {
    const w = ex.w5_proper;
    if (w.rows.length !== 44) fails.push(`w5_proper expected 44 per-frame rows, got ${w.rows.length}`);
    if (w.headline.cocoon_true_accepts_blocked !== 6) fails.push(`w5_proper cocoon verify-blocked expected 6, got ${w.headline.cocoon_true_accepts_blocked}`);
    if (w.headline.proper_shipped_fp !== 0 || w.headline.graduation_pass !== true) fails.push('w5_proper graduation bar expected proper_fp=0 / PASS=true');
    if (w.headline.off_baseline_tp !== 0 || w.headline.off_receipts !== 36) fails.push('w5_proper OFF baseline expected 0 TP / 36 receipts');
    if (!w.headline.fp_frame || !/^L_0037/.test(w.headline.fp_frame.base) || w.headline.red_alert !== true) fails.push('w5_proper expected L_0037 OFF false-positive with red_alert=true');
    if (w.odds_v1.separable !== false) fails.push('w5_proper odds_v1 (clamped) expected separable=false');
    if (!w.odds_v2 || w.odds_v2.available !== true || w.odds_v2.separable !== true) fails.push('w5_proper odds_v2 (signed) snapshot expected available + separable=true');
    // corrupt-source labels carried honestly (2 truncated CR2 frames)
    if (w.dry_run.labels_corrupt.length !== 2) fails.push('w5_proper expected 2 corrupt-source labels');
  }
  if (!ex.corpus_gate || ex.corpus_gate.available !== true) fails.push('corpus_gate scoreboard expected available');
  else {
    const cg = ex.corpus_gate;
    const byKey = Object.fromEntries((cg.factors || []).map((f) => [f.key, f]));
    if ((cg.factors || []).length !== 5) fails.push(`corpus_gate expected 5 factors, got ${(cg.factors || []).length}`);
    const ee = byKey.early_exit;
    if (!ee || !ee.available) fails.push(`corpus_gate early_exit unavailable: ${ee && ee.error}`);
    else {
      if (ee.measured.fires_on_cocoon !== 25) fails.push(`corpus_gate early_exit fires_on_cocoon expected 25, got ${ee.measured.fires_on_cocoon}`);
      const rng = ee.measured.clusters_judged_range_full;
      if (!rng || rng[0] !== 18 || rng[1] !== 31) fails.push('corpus_gate early_exit cluster range expected [18,31]');
      if (ee.measured.fires_on_gen_miss !== 0) fails.push('corpus_gate early_exit expected 0 fires on generation-miss (uw) frames');
    }
    const gp = byKey.gpu_judge;
    if (!gp || !gp.available) fails.push(`corpus_gate gpu_judge unavailable: ${gp && gp.error}`);
    else if (Math.abs(gp.headline_speedup_x - 10.25) > 0.01) fails.push(`corpus_gate gpu_judge 126K speedup expected ~10.25, got ${gp.headline_speedup_x}`);
    const mi = byKey.mid_index;
    if (!mi) fails.push('corpus_gate mid_index factor missing');
    else if (mi.available && mi.measured.total_quads !== 4176849) fails.push(`corpus_gate mid_index total_quads expected 4176849, got ${mi.measured.total_quads}`);
    if (cg.projection.end_to_end_10_20x_proven !== false) fails.push('corpus_gate projection end_to_end_10_20x_proven must be false (composition, not measurement)');
    if (cg.gate.end_to_end_proven !== false) fails.push('corpus_gate gate.end_to_end_proven must be false until proven');
  }
  if (fails.length) {
    console.error('[mining_agg] SELF-TEST FAILED:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('[mining_agg] self-test PASSED (10/10 exercises available, spot-checked headline numbers match source artifacts)');
}

// ---- CLI ----------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node tools/theses/dashboard/mining_agg.mjs [--source DIR] [--out FILE] [--self-test]');
    process.exit(0);
  }
  if (args.selfTest) { selfTest(args.source); process.exit(0); }
  const snap = buildMiningSnapshot(args.source);
  const body = JSON.stringify(snap, null, 2);
  if (args.out) {
    const outAbs = path.isAbsolute(args.out) ? args.out : path.join(DEFAULT_REPO, args.out);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, body, 'utf8');
    console.log(`[mining_agg] wrote ${outAbs} (${body.length} bytes)`);
  } else {
    console.log(body);
  }
}
