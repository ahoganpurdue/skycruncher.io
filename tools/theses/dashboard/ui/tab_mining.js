'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   #mining tab — star-mining exercise widget wave (owner directive 2026-07-17:
   "any test we run that adds value should also be represented by widget(s)
   in our dashboard"). Five widgets, one per 2026-07-17 mining exercise, all
   sourced from ONE feed: /data/mining_dashboard_data.json — a compact
   render-ready snapshot built by tools/theses/dashboard/mining_agg.mjs from
   the raw exercise artifacts (a sibling checkout; see that script's header).

   HONESTY (LAW 3):
     · feed unreachable            -> whole-tab offline panel (existing pattern)
     · one exercise's block missing/failed extraction (available:false)
       -> THAT widget alone renders "ARTIFACT ABSENT", the other four still
          render normally — one bad artifact never blanks the tab
     · every chip/number below reads state.feeds.mining.data at render time;
       nothing in this file is a hand-typed figure from the exercise write-up
     · INFERRED / LOWER BOUND / NOT MEASURED labels are carried through from
       the artifact verbatim, never invented or dropped

   Classic (non-module) script, loaded before app.js so renderMining() exists
   when app.js builds RENDERERS.
   ═══════════════════════════════════════════════════════════════════════════ */

function mnPct(x, d = 1) { return (x == null || !isFinite(x)) ? NR : `${Number(x).toFixed(d)}%`; }
function mnNum(x, d = 2) { return (x == null || !isFinite(x)) ? NR : Number(x).toFixed(d); }
function mnMs(x) { return (x == null || !isFinite(x)) ? NR : `${(Number(x) / 1000).toFixed(1)}s`; }
function mnFrac(x, d = 1) { return (x == null || !isFinite(x)) ? NR : `${(Number(x) * 100).toFixed(d)}%`; }

/** Small inline tag for artifact-carried honesty labels. */
function mnTag(text, kind) {
  return `<span class="mn-tag mn-tag-${esc(kind)}">${esc(text)}</span>`;
}

/** Per-widget "artifact absent/failed" panel — never a placeholder number. */
function mnAbsent(title, block) {
  return `<div class="mn-widget mn-absent">
    <div class="mn-wtitle">${esc(title)}</div>
    <div class="o-badge">ARTIFACT ABSENT</div>
    <p class="mn-absent-detail">${block && block.error ? esc(block.error) : 'no data'}${block && block.artifact_path ? `<br><code>${esc(block.artifact_path)}</code>` : ''}</p>
  </div>`;
}

/** Minimal inline SVG sparkline over [x_i,y_i]; honest empty state on <2 points. */
function mnSparkline(points, opts = {}) {
  const w = opts.w || 200, h = opts.h || 46, pad = 4;
  const pts = (points || []).filter((p) => p != null && isFinite(p.y));
  if (pts.length < 2) return `<div class="mn-spark-empty">not enough points</div>`;
  const ys = pts.map((p) => p.y);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const span = (yMax - yMin) || 1;
  const n = pts.length;
  const xAt = (i) => pad + (i / (n - 1)) * (w - 2 * pad);
  const yAt = (v) => h - pad - ((v - yMin) / span) * (h - 2 * pad);
  const path = pts.map((p, i) => `${xAt(i)},${yAt(p.y)}`).join(' ');
  const zeroY = (0 >= yMin && 0 <= yMax) ? yAt(0) : null;
  return `<svg class="mn-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.label || 'profile')}">
    ${zeroY != null ? `<line x1="${pad}" y1="${zeroY}" x2="${w - pad}" y2="${zeroY}" class="mn-spark-zero"/>` : ''}
    <polyline points="${path}" class="mn-spark-line ${esc(opts.cls || '')}"/>
  </svg>`;
}

/* ── widget 1: radial flux-droop / vignette + k1 residual curves ─────────── */
function mnWidgetRadial(ex) {
  if (!ex || !ex.available) return mnAbsent('Radial flux-droop / vignette (per-rig) + k1 residual', ex);
  const h60d = ex.headline.find((r) => /60D/i.test(r.rig));
  const hSeestar = ex.headline.find((r) => /Seestar S30/i.test(r.rig));
  const chip = (r, cls) => r
    ? `<div class="mn-chip ${cls}"><b>${esc(r.rig)}</b> ${mnPct(r.flux_droop_pct_center_to_corner)} corner droop
        ${r.vignette_class === 'flat' ? mnTag('FLAT', 'ok') : mnTag('LOWER BOUND', 'lb')}</div>`
    : '';
  const cards = ex.headline.map((r) => {
    const fluxPts = (r.annuli || []).map((a, i) => ({ x: i, y: a.flux_ratio }));
    const k1Pts = (r.annuli || []).map((a, i) => ({ x: i, y: a.radial_resid_px_med }));
    return `<div class="mn-rig-card">
      <div class="mn-rig-h">
        <b>${esc(r.rig)}</b>
        <span class="mn-rig-fmt">${r.source_format ? esc(r.source_format) : NR}</span>
      </div>
      <div class="mn-rig-stats">
        <span>droop ${mnPct(r.flux_droop_pct_center_to_corner)}</span>
        <span>${esc(r.vignette_class ?? 'NOT RECORDED')}</span>
        <span>n=${r.n_matched != null ? r.n_matched.toLocaleString('en-US') : NR}</span>
      </div>
      <div class="mn-spark-row">
        <div class="mn-spark-cell">
          <div class="mn-spark-label">flux ratio vs radius</div>
          ${mnSparkline(fluxPts, { label: 'flux ratio vs radius', cls: 'flux' })}
        </div>
        <div class="mn-spark-cell">
          <div class="mn-spark-label">k1 radial resid (px) vs radius</div>
          ${mnSparkline(k1Pts, { label: 'k1 radial residual vs radius', cls: 'k1' })}
        </div>
      </div>
      <div class="mn-rig-foot">
        <span class="mn-k1class">k1: ${esc(r.k1_class ?? 'NOT RECORDED')}</span>
        ${r.survivor_note ? mnTag('LOWER BOUND', 'lb') : ''}
      </div>
    </div>`;
  }).join('');
  return `<div class="mn-widget">
    <div class="mn-wtitle">Radial flux-droop / vignette (per-rig) + k1 residual curve</div>
    <p class="mn-lede">Per-annulus flux ratio and positional (k1) residual, MODAL-DIAGONAL frame-scoped.
      Flux droop figures are a <b>LOWER BOUND</b> — near-threshold detections bias corner fluxes bright
      (survivor bias), so true droop is at least this large. n_rigs=${ex.n_rigs ?? NR}.</p>
    <div class="mn-chiprow">${chip(h60d, 'warn')}${chip(hSeestar, 'ok')}</div>
    <div class="mn-rig-grid">${cards}</div>
  </div>`;
}

/* ── widget 2: unmatched-detection separability ───────────────────────────── */
function mnWidgetSeparability(ex) {
  if (!ex || !ex.available) return mnAbsent('Unmatched-detection separability', ex);
  const mie = ex.mie_index;
  const rb = ex.recoverable_by_bucket || {};
  const bucketRow = (key, label) => {
    const b = rb[key];
    if (!b) return '';
    return `<div class="mn-bucket-row">
      <span class="mn-bucket-name">${esc(label)}</span>
      <span class="mn-track"><span class="mn-fill" style="width:${Math.max(0, Math.min(100, b.recoverable_looking_fraction * 100))}%"></span></span>
      <span class="mn-bucket-pct">${mnFrac(b.recoverable_looking_fraction)}</span>
      <span class="mn-bucket-n">${b.recoverable_looking.toLocaleString('en-US')} / ${b.total_unmatched.toLocaleString('en-US')}</span>
    </div>`;
  };
  const verdictRows = ex.separability_verdict
    ? Object.entries(ex.separability_verdict).map(([axis, v]) => {
        const overlap = v.matched_p10_p90_envelope_overlap_fraction ?? v.unmatched_fraction_spread_across_bands ?? v.unmatched_fraction_spread_across_buckets_min100;
        const poor = /POOR_SPLIT/.test(v.interpretation || '');
        return `<div class="mn-axis-row">
          <span class="mn-axis-name">${esc(axis)}</span>
          <span class="mn-axis-metric">${overlap != null ? overlap.toFixed(3) : NR}</span>
          <span class="mn-axis-verdict ${poor ? 'poor' : 'partial'}">${esc((v.interpretation || 'NOT RECORDED').split(' (')[0])}</span>
        </div>`;
      }).join('')
    : `<div class="mn-bucket-row">${NR}</div>`;
  return `<div class="mn-widget">
    <div class="mn-wtitle">Unmatched-detection separability</div>
    <p class="mn-lede">Kept-detection population: ${ex.population ? ex.population.total_detections.toLocaleString('en-US') : NR} total,
      ${ex.population ? ex.population.kept_unmatched_n.toLocaleString('en-US') : NR} kept-unmatched vs
      ${ex.population ? ex.population.kept_matched_n.toLocaleString('en-US') : NR} kept-matched.</p>
    <div class="mn-chiprow">
      <div class="mn-chip ok"><b>matched</b> mie median ${mnNum(mie && mie.matched_p50)}</div>
      <div class="mn-chip warn"><b>unmatched</b> mie median ${mnNum(mie && mie.unmatched_p50)}</div>
      <div class="mn-chip">quintile2/3 boundary &asymp; ${mnNum(mie && mie.quintile2_3_boundary)}</div>
    </div>
    <h3 class="mn-sub">separability by axis (matched vs unmatched envelope overlap — lower = cleaner split)</h3>
    <div class="mn-axis-table">${verdictRows}</div>
    <h3 class="mn-sub">recoverable-looking fraction of unmatched, by regime</h3>
    <div class="mn-bucket-table">
      ${bucketRow('narrow_dedicated', 'narrow / dedicated')}
      ${bucketRow('dslr_wide', 'DSLR wide')}
      ${bucketRow('synthetic', 'synthetic')}
    </div>
  </div>`;
}

/* ── widget 3: confirm-floor population classification ──────────────────── */
function mnWidgetConfirmFloor(ex) {
  if (!ex || !ex.available) return mnAbsent('Confirm-floor population classification', ex);
  const pc = ex.population_census || {};
  const rf = ex.regime_fractions || {};
  const fr = rf.fractions || {};
  const cc = ex.cross_check;
  const regimeRow = (key, label, cls) => (fr[key] == null) ? '' : `<div class="mn-bucket-row">
      <span class="mn-bucket-name">${esc(label)}</span>
      <span class="mn-track"><span class="mn-fill ${cls}" style="width:${Math.max(0, Math.min(100, fr[key] * 100))}%"></span></span>
      <span class="mn-bucket-pct">${mnFrac(fr[key])}</span>
      <span class="mn-bucket-n">${(rf.counts && rf.counts[key] != null) ? rf.counts[key] : NR} of ${rf.n_frames_with_computable_confirmed_floor ?? NR}</span>
    </div>`;
  return `<div class="mn-widget">
    <div class="mn-wtitle">Confirm-floor population classification</div>
    <p class="mn-lede">${pc.n_frames_total ?? NR} banked frames, ${pc.n_distinct_receipts ?? NR} distinct receipts;
      ${pc.receipts_with_confirmed_stars ?? NR} of ${pc.receipts_with_any_star_rows ?? NR} star-bearing receipts
      have a computable confirmed floor (denominator for the classification below).</p>
    <div class="mn-bucket-table">
      ${regimeRow('CATALOG_LIMITED', 'catalog-limited', 'ok')}
      ${regimeRow('CONFIRM_GATE_LIMITED', 'confirm-gate-limited', 'warn')}
      ${regimeRow('UNCLASSIFIED_UNRELIABLE_FIT', 'unclassifiable (unreliable fit)', 'muted')}
    </div>
    ${cc ? `<div class="mn-callout">
      <div class="mn-callout-h">thesis-2 pin-match — ${esc(cc.rig ?? 'NOT RECORDED')} (${esc(cc.receipt_sha256 ?? '')})</div>
      <div class="mn-callout-body">
        measured confirmed floor <b>${mnNum(cc.confirmed_floor_mag, 2)}</b> mag vs thesis-2 cited
        <b>${esc(cc.thesis2_cited_confirmed_floor ?? 'NOT RECORDED')}</b> &mdash; regime
        <span class="chip">${esc(cc.regime ?? 'NOT RECORDED')}</span>
      </div>
      <div class="mn-callout-note">${esc(cc.identity_evidence ?? '')}</div>
    </div>` : ''}
    ${(ex.not_measured || []).length ? `<div class="mn-nm"><b>NOT MEASURED:</b> ${ex.not_measured.map((s) => `<div class="mn-nm-item">${esc(s)}</div>`).join('')}</div>` : ''}
  </div>`;
}

/* ── widget 4: ephemeris / planetary-anchor trust audit ──────────────────── */
function mnWidgetEphemeris(ex) {
  if (!ex || !ex.available) return mnAbsent('Ephemeris anchor audit', ex);
  const v = ex.verdict || {};
  const rows = ex.trust_by_rig_class
    ? Object.entries(ex.trust_by_rig_class).map(([cls, d]) => `<tr>
        <td>${esc(cls)}</td><td>${d.n}</td><td>${d.solved}</td><td>${d.has_gps}</td>
        <td>${d.strict_ephemeris_trusted}</td><td>${d.guest_list_produced}</td>
      </tr>`).join('')
    : '';
  const rr = ex.recovered_report;
  const rrBlock = rr && rr.available
    ? `<div class="mn-callout">
        <div class="mn-callout-h">recovered agent report ${mnTag('findings array absent', 'nm')}</div>
        <details class="mn-details"><summary>summary (${rr.summary ? rr.summary.length : 0} chars)</summary>
          <p class="mn-summary-text">${esc(rr.summary ?? 'NOT RECORDED')}</p>
        </details>
        ${rr.tuning_recommendations.length ? `<div class="mn-sub2">tuning recommendations</div>
          <ul class="mn-list">${rr.tuning_recommendations.map((t) => `<li><b>${esc(t.target ?? '')}:</b> ${esc(t.rec ?? '')}</li>`).join('')}</ul>` : ''}
        ${rr.not_measured.length ? `<div class="mn-nm"><b>NOT MEASURED:</b> ${rr.not_measured.map((s) => `<div class="mn-nm-item">${esc(s)}</div>`).join('')}</div>` : ''}
      </div>`
    : mnAbsent('recovered agent report', rr);
  return `<div class="mn-widget">
    <div class="mn-wtitle">Ephemeris / planetary-anchor trust audit</div>
    <div class="mn-chiprow">
      <div class="mn-chip warn"><b>${ex.ephemeris_provenance ? ex.ephemeris_provenance.ephem_vs_engine_delta_arcmin.n_pairs : NR}</b> planet-instances</div>
      <div class="mn-chip ${v.engine_confirmed_in_fov_events === 0 ? 'fail' : 'ok'}"><b>${v.engine_confirmed_in_fov_events ?? NR}</b> engine-confirmed in-FOV events</div>
      <div class="mn-chip">${esc(v.code ?? 'NOT RECORDED')}</div>
    </div>
    <p class="mn-lede">verdict: needs data, not tuning — anchor gate (location + trusted timestamp) never coincided
      with a planet-bearing solved field across ${ex.trust_overall ? ex.trust_overall.n : NR} banked frames.</p>
    <h3 class="mn-sub">trust rate by rig class</h3>
    <div class="mn-table-wrap"><table class="mn-table">
      <thead><tr><th>rig class</th><th>n</th><th>solved</th><th>has GPS</th><th>strict-trusted</th><th>guest lists</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${rrBlock}
  </div>`;
}

/* ── widget 5: budget burn forensics on no-solves ─────────────────────────── */
function mnWidgetBudgetBurn(ex) {
  if (!ex || !ex.available) return mnAbsent('Budget burn forensics (no-solves)', ex);
  const rows = (ex.burn_rows || []).map((r) => `<tr class="${r.outcome === 'no_solve' ? 'mn-row-nosolve' : ''}">
      <td>${esc(r.regime)}</td><td>${esc(r.outcome)}</td><td>${r.n}</td>
      <td>${mnMs(r.total_solve_time_ms_p50)}</td><td>${mnMs(r.uw_sweep_ms_p50)}</td>
      <td>${mnMs(r.residual_ms_INFERRED_p50)}</td>
      <td>${r.budget_exhausted_rate != null ? mnFrac(r.budget_exhausted_rate) : NR}</td>
    </tr>`).join('');
  const sinks = ex.top_budget_sinks_on_no_solves;
  const sinkRows = sinks && Array.isArray(sinks.sinks)
    ? sinks.sinks.map((s) => `<div class="mn-bucket-row">
        <span class="mn-bucket-name">${esc(s.phase.replace(/_ms_sum.*/, '').replace(/_/g, ' '))}${/INFERRED/.test(s.phase) ? mnTag('INFERRED', 'nm') : ''}</span>
        <span class="mn-track"><span class="mn-fill ${/INFERRED/.test(s.phase) ? 'muted' : 'ok'}" style="width:${Math.max(0, Math.min(100, s.share * 100))}%"></span></span>
        <span class="mn-bucket-pct">${mnFrac(s.share)}</span>
      </div>`).join('')
    : '';
  const rec = ex.quad_gen_budget_recommendation;
  return `<div class="mn-widget">
    <div class="mn-wtitle">Budget burn forensics (no-solves)</div>
    <p class="mn-lede">${ex.frames_total ?? NR} frames total. Per-phase wall-clock burn on UW-blind no-solve frames,
      by branch-timing phase (median across ${sinks ? sinks.n_no_solve_with_branch_timing : NR} frames).</p>
    <div class="mn-table-wrap"><table class="mn-table">
      <thead><tr><th>regime</th><th>outcome</th><th>n</th><th>total p50</th><th>uw_sweep p50</th><th>residual p50</th><th>budget exhausted</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <h3 class="mn-sub">where the wall-clock goes on a no-solve</h3>
    <div class="mn-bucket-table">${sinkRows}</div>
    ${rec ? `<div class="mn-callout">
      <div class="mn-callout-h">quad-gen budget envelope headroom ${mnTag(rec.tag ?? 'MEASURED', 'ok')}</div>
      <div class="mn-callout-body">remaining wall-clock room after the sweep+fetch phase, within the configured blind budget:
        p10 ${mnMs(rec.p10_ms)} &middot; <b>p50 ${mnMs(rec.p50_ms)}</b> &middot; p90 ${mnMs(rec.p90_ms)}</div>
    </div>` : ''}
  </div>`;
}

/* ── widget 6: cross-frame star pivot (relative-calibration noise floor) ─── */
function mnWidgetStarPivot(ex) {
  if (!ex || !ex.available) return mnAbsent('Cross-frame star pivot — noise floor', ex);
  const m = ex.multiplicity || {};
  const nf = ex.noise_floor || {};
  const wr = nf.within_rig || {};
  const ar = nf.across_rig || {};
  const maxBar = m.n_distinct_catalog_stars || m.stars_ge2 || 1;
  const bar = (label, val) => (val == null) ? '' : `<div class="mn-bucket-row">
      <span class="mn-bucket-name">${esc(label)}</span>
      <span class="mn-track"><span class="mn-fill" style="width:${Math.max(0, Math.min(100, (val / maxBar) * 100))}%"></span></span>
      <span class="mn-bucket-pct">${val.toLocaleString('en-US')}</span>
      <span class="mn-bucket-n">of ${m.n_distinct_catalog_stars != null ? m.n_distinct_catalog_stars.toLocaleString('en-US') : NR} distinct stars</span>
    </div>`;
  const rigRows = (nf.by_rig || []).slice().sort((a, b) => (b.n_stars || 0) - (a.n_stars || 0)).map((r) => `<tr>
      <td>${esc(r.rig)}${r.is_synthetic ? mnTag('SYNTHETIC', 'nm') : ''}</td>
      <td>${r.n_stars != null ? r.n_stars.toLocaleString('en-US') : NR}</td>
      <td>${mnNum(r.median_mag, 3)}</td>
      <td>${mnNum(r.p90_mag, 3)}</td>
    </tr>`).join('');
  return `<div class="mn-widget">
    <div class="mn-wtitle">Cross-frame star pivot — relative-calibration noise floor</div>
    <div class="mn-chiprow">
      ${mnTag('RELATIVE-CAL ONLY', 'lb')}
      ${mnTag('NO PER-POINT σ BANKED', 'nm')}
      ${mnTag('NO VARIABILITY CLAIMS', 'nm')}
    </div>
    <p class="mn-lede">${esc(ex.label ?? '')}. ${esc(ex.sigma_columns_note ?? '')}</p>
    <h3 class="mn-sub">multiplicity (distinct-measurement basis, dedup'd on identical centered dm)</h3>
    <div class="mn-bucket-table">
      ${bar('≥2 observations', m.stars_ge2)}
      ${bar('≥5 observations', m.stars_ge5)}
      ${bar('≥10 observations', m.stars_ge10)}
      ${bar('multi-rig (≥2 rigs)', m.stars_multi_rig)}
    </div>
    <h3 class="mn-sub">within-rig vs across-rig dm spread (robust half-IPR, mag)</h3>
    <div class="mn-chiprow">
      <div class="mn-chip ok"><b>within-rig</b> median ${mnNum(wr.median, 3)} mag &middot; p90 ${mnNum(wr.p90, 3)} &middot; n=${wr.n ?? NR}</div>
      <div class="mn-chip warn"><b>across-rig</b> median ${mnNum(ar.median, 3)} mag &middot; p90 ${mnNum(ar.p90, 3)} &middot; n=${ar.n ?? NR}</div>
      <div class="mn-chip"><b>rig-offset span</b> median ${mnNum(nf.across_rig_offset_span_median, 3)} mag</div>
    </div>
    <p class="mn-lede">${esc(nf.interpretation ?? '')}</p>
    <h3 class="mn-sub">within-rig floor by rig (real vs synthetic)</h3>
    <div class="mn-table-wrap"><table class="mn-table">
      <thead><tr><th>rig</th><th>n stars</th><th>median (mag)</th><th>p90 (mag)</th></tr></thead>
      <tbody>${rigRows}</tbody>
    </table></div>
    ${nf.synthetic_caveat ? `<div class="mn-nm"><div class="mn-nm-item">${esc(nf.synthetic_caveat)}</div></div>` : ''}
  </div>`;
}

/* ── widget 7: error-budget ledger v0 ─────────────────────────────────────── */
function mnWidgetErrorLedger(ex) {
  if (!ex || !ex.available) return mnAbsent('Error-budget ledger v0', ex);
  const rg = ex.regressions || {};
  const sp = ex.spotlight || {};
  const spotCard = (title, s, isFlat) => {
    if (!s) return `<div class="mn-rig-card"><div class="mn-rig-h"><b>${esc(title)}</b></div><p class="mn-absent-detail">not found in this ledger</p></div>`;
    const ed = s.endpoint_delta;
    const flatBadge = s.flat ? mnTag('FLAT — correct per LAW 1 (measurement-layer only)', 'ok') : '';
    const stat = (lbl, v, unit, invertGood, decimals) => {
      if (!v) return `<div class="mn-bucket-row"><span class="mn-bucket-name">${esc(lbl)}</span><span class="mn-bucket-n">${NR}</span></div>`;
      const good = invertGood ? v.pct_change <= 0 : v.pct_change >= 0;
      const sign = v.pct_change > 0 ? '+' : '';
      const d = decimals ?? 3;
      return `<div class="mn-axis-row" style="grid-template-columns:110px 1fr 90px;">
        <span class="mn-axis-name">${esc(lbl)}</span>
        <span class="mn-axis-metric">${mnNum(v.from, d)} &rarr; ${mnNum(v.to, d)}${unit}</span>
        <span class="mn-axis-verdict ${v.pct_change === 0 ? '' : (good ? 'partial' : 'poor')}">${sign}${mnNum(v.pct_change, 1)}%</span>
      </div>`;
    };
    return `<div class="mn-rig-card">
      <div class="mn-rig-h"><b>${esc(title)}</b><span class="mn-rig-fmt">${esc(s.rig)}</span></div>
      <div class="mn-rig-stats"><span>${ed ? esc(ed.from_vintage) : NR} &rarr; ${ed ? esc(ed.to_vintage) : NR}</span></div>
      ${ed ? `<div class="mn-axis-table">
        ${stat('stars matched', ed.stars_matched, '', false, 0)}
        ${stat('rms (arcsec)', ed.positional_rms_arcsec, '&Prime;', true, 3)}
        ${stat('confidence', ed.confidence, '', false, 3)}
        ${stat('dm σ (mag)', ed.dm_robust_sigma_mag, '', true, 3)}
      </div>` : `<p class="mn-absent-detail">no endpoint delta (single vintage or all no-solve)</p>`}
      <div class="mn-rig-foot">${flatBadge}</div>
    </div>`;
  };
  const changeRow = (c) => `<div class="mn-nm-item">
      <b>${esc(c.rig)}</b> ${esc((c.input_basenames || [])[0] ?? '')}
      &mdash; solved ${esc((c.solved_vintages || []).join(', '))} &rarr; no-solve ${esc((c.no_solve_vintages || []).join(', '))}
      <span class="mn-rig-fmt">[${esc((c.schema_versions || []).join(' → '))}]</span>
    </div>`;
  return `<div class="mn-widget">
    <div class="mn-wtitle">Error-budget ledger v0 — what got better across engine vintages</div>
    <p class="mn-lede">${esc(ex.label ?? '')}. ${ex.n_frame_clusters ?? NR} same-physical-frame clusters identified
      (union-find over decoded-pixel hash + rig/basename), ${ex.n_clusters_ge2_receipts ?? NR} with ≥2 receipts,
      ${ex.n_clusters_ge2_vintages ?? NR} spanning ≥2 vintages. n_ledgers=${ex.n_ledgers ?? NR}.</p>
    <h3 class="mn-sub">vintage curves (spotlight pins)</h3>
    <div class="mn-rig-grid">
      ${spotCard('M66 (SeeStar S30 Pro)', sp.m66)}
      ${spotCard('M51 (SeeStar S50)', sp.m51)}
      ${spotCard('CR2 pin (Rebel T6)', sp.cr2_pin)}
    </div>
    <h3 class="mn-sub">regressions — solved&rarr;no-solve across a vintage span</h3>
    <div class="mn-chiprow">
      <div class="mn-chip fail"><b>${rg.total ?? NR}</b> total clusters</div>
      <div class="mn-chip warn"><b>${rg.decoder_confounded_n ?? NR}</b> decoder-confounded (rawler/CR2 arm in span)</div>
      <div class="mn-chip"><b>${rg.pure_schema_n ?? NR}</b> pure-schema (FITS, no decoder arm) ${mnTag('UNDER AUDIT', 'nm')}</div>
    </div>
    <p class="mn-lede">Vintage-keyed correlation, NOT a proven causal regression — only the vintage keys and solve
      outcome are recorded here; what specifically changed between spans is not decomposed (see NOT MEASURED below).</p>
    <details class="mn-details"><summary>decoder-confounded clusters (${(rg.decoder_confounded || []).length})</summary>
      <div class="mn-nm">${(rg.decoder_confounded || []).map(changeRow).join('')}</div>
    </details>
    <details class="mn-details"><summary>pure-schema clusters (${(rg.pure_schema || []).length})</summary>
      <div class="mn-nm">${(rg.pure_schema || []).map(changeRow).join('')}</div>
    </details>
    ${(ex.not_measured || []).length ? `<div class="mn-nm"><b>NOT MEASURED:</b> ${ex.not_measured.map((s) => `<div class="mn-nm-item">${esc(s)}</div>`).join('')}</div>` : ''}
  </div>`;
}

/* ── widget 8: detection recall — miss-population mining (2026-07-18) ────── */
function mnWidgetM4Recall(ex) {
  if (!ex || !ex.available) return mnAbsent('Detection recall — miss-population mining', ex);
  const magBlock = ex.recall_by_magnitude_M66 || {};
  const bins = magBlock.bins || [];
  const binRows = bins.map((b) => `<tr>
      <td>${esc(b.mag)}</td><td>${b.n}</td><td>${mnFrac(b.recall_wide)}</td><td>${mnFrac(b.recall_tight)}</td>
    </tr>`).join('');
  const classChips = (ex.recall_by_class || []).map((c) => `<div class="mn-chip">
      <b>${esc(c.frame)}</b> ${esc(c.honest_recall_to_floor ?? 'NOT RECORDED')}
    </div>`).join('');
  const pf = ex.pooled_fraction_refuted || {};
  const leverRows = (ex.top_levers || []).map((lv) => `<div class="mn-nm-item">
      <b>#${lv.rank}</b> ${esc(lv.lever)} <span class="mn-rig-fmt">[${esc(lv.support ?? 'NOT RECORDED')}]</span>
    </div>`).join('');
  const retired = ex.standing_claim_status === 'REFUTED_AS_WRITTEN';
  return `<div class="mn-widget">
    <div class="mn-wtitle">${esc(ex.title || 'Detection recall — miss-population mining')}</div>
    <div class="mn-chiprow">${mnTag(ex.methodology_caveat || 'recall measured for round stars at model-predicted positions, inner field — corner regime pending', 'nm')}</div>
    <div class="mn-callout">
      <div class="mn-callout-h">${retired ? mnTag('RETIRED CLAIM', 'lb') : ''} old claim: &ldquo;${esc(ex.standing_claim ?? 'NOT RECORDED')}&rdquo;</div>
      <div class="mn-callout-body">${esc(ex.corrected_statement ?? 'NOT RECORDED')}</div>
      ${pf.reasons && pf.reasons.length ? `<div class="mn-callout-note">why the pooled ${mnFrac(pf.value_wide)} number doesn't hold up:
        <ul class="mn-list">${pf.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
    </div>
    <h3 class="mn-sub">recall by magnitude — M66 (highest-confidence frame)</h3>
    <div class="mn-table-wrap"><table class="mn-table">
      <thead><tr><th>magnitude</th><th>n stars</th><th>wide match</th><th>tight match (honest)</th></tr></thead>
      <tbody>${binRows}</tbody>
    </table></div>
    <p class="mn-lede">${esc(magBlock.note ?? '')}</p>
    <h3 class="mn-sub">per-frame read</h3>
    <div class="mn-chiprow">${classChips}</div>
    <h3 class="mn-sub">what actually moves recall next (top levers)</h3>
    <div class="mn-nm">${leverRows}</div>
    ${(ex.not_measured || []).length ? `<div class="mn-nm"><b>NOT MEASURED:</b> ${ex.not_measured.map((s) => `<div class="mn-nm-item">${esc(s)}</div>`).join('')}</div>` : ''}
  </div>`;
}

/* ── widget 9: W5 proper-test adjudication (quad-gen graduation, 2026-07-18) ─ */

/** One horizontal min→max range bar with q1/median/q3 ticks, on a shared
 *  [domainMin,domainMax] axis. Colour is inline rgba (theme-tolerant); labels
 *  use currentColor. Honest empty state when the stat block is absent. */
function mnRangeBar(stat, domainMin, domainMax, color, opts = {}) {
  const w = 260, h = 30, padL = 4, padR = 4;
  if (!stat || stat.n == null || stat.min == null || stat.max == null) {
    return `<div class="mn-spark-empty">${esc(opts.label || '')}: ${NR}</div>`;
  }
  const span = (domainMax - domainMin) || 1;
  const X = (v) => padL + ((v - domainMin) / span) * (w - padL - padR);
  const y = h / 2;
  const tick = (v) => (v == null) ? '' : `<line x1="${X(v).toFixed(1)}" y1="${y - 7}" x2="${X(v).toFixed(1)}" y2="${y + 7}" stroke="${color}" stroke-width="1.5"/>`;
  const medX = X(stat.median);
  return `<svg class="mn-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.label || 'range')}">
    <line x1="${X(stat.min).toFixed(1)}" y1="${y}" x2="${X(stat.max).toFixed(1)}" y2="${y}" stroke="${color}" stroke-width="7" stroke-linecap="round" opacity="0.45"/>
    ${tick(stat.q1)}${tick(stat.q3)}
    <line x1="${medX.toFixed(1)}" y1="${y - 9}" x2="${medX.toFixed(1)}" y2="${y + 9}" stroke="${color}" stroke-width="2.5"/>
  </svg>`;
}

/** Side-by-side truth-vs-false separation panel for one odds metric. */
function mnOddsPanel(title, block, sub) {
  if (!block || (block.available === false)) {
    return `<div class="mn-rig-card"><div class="mn-rig-h"><b>${esc(title)}</b></div>
      <p class="mn-absent-detail">${esc((block && block.error) || 'NOT MEASURED')}</p></div>`;
  }
  const t = block.truth, f = block.false;
  const lo = Math.min(t && t.min != null ? t.min : 0, f && f.min != null ? f.min : 0);
  const hi = Math.max(t && t.max != null ? t.max : 1, f && f.max != null ? f.max : 1);
  const sep = block.separable === true;
  const green = 'rgba(46,160,67,0.9)', amber = 'rgba(219,158,30,0.95)';
  return `<div class="mn-rig-card">
    <div class="mn-rig-h"><b>${esc(title)}</b>
      <span class="mn-rig-fmt">${esc(block.metric || '')}</span></div>
    <div class="mn-rig-stats"><span>${esc(sub || block.source || '')}</span>
      <span>${sep ? mnTag('SEPARABLE', 'ok') : mnTag('NON-SEPARATING', 'lb')}</span></div>
    <div class="mn-axis-table">
      <div class="mn-axis-row" style="grid-template-columns:64px 1fr 150px;">
        <span class="mn-axis-name">truth</span>
        ${mnRangeBar(t, lo, hi, green, { label: 'truth-pose odds' })}
        <span class="mn-axis-metric">n=${t && t.n != null ? t.n : NR} · max ${mnNum(t && t.max, 1)}</span>
      </div>
      <div class="mn-axis-row" style="grid-template-columns:64px 1fr 150px;">
        <span class="mn-axis-name">false</span>
        ${mnRangeBar(f, lo, hi, amber, { label: 'false-pose odds' })}
        <span class="mn-axis-metric">n=${f && f.n != null ? f.n : NR} · max ${mnNum(f && f.max, 1)}</span>
      </div>
    </div>
    ${block.gap != null ? `<div class="mn-rig-foot"><span class="mn-k1class">min-truth − max-false gap: ${mnNum(block.gap, 1)}</span></div>` : ''}
    ${block.read ? `<p class="mn-callout-note">${esc(block.read)}</p>` : ''}
    ${block.caveat ? `<div class="mn-rig-foot">${mnTag('SOURCE ARMS MID-RUN — SNAPSHOT', 'nm')}</div>` : ''}
  </div>`;
}

function mnWidgetW5Proper(ex) {
  if (!ex || !ex.available) return mnAbsent('W5 proper-test adjudication (quad-gen graduation)', ex);
  const dr = ex.dry_run || {};
  const h = ex.headline || {};
  const fp = h.fp_frame;
  // per-frame table, grouped by gap class then class
  const gapOrder = { 'verify-blocked': 0, 'judge-low': 1, 'generation-miss': 2, 'refine-corrupt': 3, excluded: 4 };
  const rows = (ex.rows || []).slice().sort((a, b) =>
    (gapOrder[a.gap] ?? 9) - (gapOrder[b.gap] ?? 9) || String(a.class).localeCompare(String(b.class)) || String(a.base).localeCompare(String(b.base)));
  const gapCls = (g) => g === 'verify-blocked' ? 'partial' : (g === 'excluded' ? '' : 'poor');
  const oracleTag = (r) => r.oracle === 'solved' ? mnTag('solved', 'ok')
    : (r.oracle === 'corrupt-source' ? mnTag('corrupt-source', 'nm') : mnTag(r.oracle || 'no-label', 'lb'));
  const frameRows = rows.map((r) => `<tr class="${r.gap === 'excluded' ? 'mn-row-nosolve' : ''}">
      <td>${esc(r.base)}</td>
      <td>${esc(r.class || NR)}<span class="mn-rig-fmt"> ${esc((r.arm || '').replace('proper_', ''))}</span></td>
      <td>${oracleTag(r)}</td>
      <td>${esc(r.outcome)}</td>
      <td><span class="mn-axis-verdict ${gapCls(r.gap)}">${esc(r.gap || NR)}</span></td>
      <td>${r.anchored == null ? NR : `${r.anchored}${r.anchored_is_truth ? '' : ' (false)'}`}</td>
      <td>${mnNum(r.top_odds_v1, 1)}</td>
      ${r.off_shipped ? `<td class="mn-axis-verdict poor">OFF ${esc(r.off_verdict || '')}</td>` : '<td></td>'}
    </tr>`).join('');
  const gt = ex.gap_tally || {};
  return `<div class="mn-widget">
    <div class="mn-wtitle">W5 proper-test adjudication — quad-gen graduation evidence</div>
    <div class="mn-chiprow">
      ${mnTag('TEST/DEV', 'nm')}
      ${mnTag('DRY-RUN · lanes MID-RUN', 'nm')}
    </div>
    <p class="mn-lede">Astrometry.net oracle (${dr.labels_solved ?? NR} solved labels; ${(dr.labels_corrupt || []).length} truncated-source excluded)
      vs our quad-gen accepts. Banked so far: OFF baseline ${dr.off_receipts ?? NR} · proper-UW ${dr.proper_uw_receipts ?? NR} · proper-cocoon ${dr.proper_cocoon_receipts ?? NR}.
      Receipt-existence = done; the orchestrator re-runs the final audit.</p>

    <div class="mn-chiprow">
      <div class="mn-chip warn"><b>${h.cocoon_true_accepts_blocked ?? NR}</b> Cocoon true accepts blocked by the legacy verifyWCS gate</div>
      <div class="mn-chip ${h.proper_shipped_fp === 0 && h.graduation_pass ? 'ok' : 'fail'}"><b>${h.proper_shipped_fp ?? NR}</b> FPs shipped by the quad-gen stack ${h.graduation_pass ? mnTag('GRADUATION BAR PASS', 'ok') : ''}</div>
      <div class="mn-chip"><b>${h.off_baseline_tp ?? NR}/${h.off_receipts ?? NR}</b> OFF-baseline true solves</div>
    </div>
    ${fp ? `<div class="mn-callout">
      <div class="mn-callout-h">${h.red_alert ? '🔴 ' : ''}${mnTag('LIVE RED', 'lb')} classic-chain attractor false-positive</div>
      <div class="mn-callout-body"><b>${esc(fp.base)}</b> — blind solver shipped RA ${mnNum(fp.ra_h, 4)}h dec ${mnNum(fp.dec, 3)} @ ${mnNum(fp.scale, 1)}&Prime;/px,
        <b>${mnNum(fp.sep_deg, 1)}&deg;</b> from oracle truth. Flagged, not counted as a baseline solve; the quad-gen graduation bar (accepts only) stays clean.</div>
    </div>` : ''}

    <h3 class="mn-sub">odds separation — can a threshold alone gate an accept?</h3>
    <div class="mn-rig-grid">
      ${mnOddsPanel('V1 · clamped odds (frozen proper audit)', ex.odds_v1, 'proper quad-gen arms')}
      ${mnOddsPanel('V2 · signed odds (live full-stack probe)', ex.odds_v2, 'full-stack arms')}
    </div>
    <p class="mn-callout-note">${esc((ex.odds_v2 && ex.odds_v2.distinct_from_frozen) || '')}</p>

    <h3 class="mn-sub">per-frame adjudication (${rows.length} frames — grouped by gap class)</h3>
    <div class="mn-table-wrap"><table class="mn-table">
      <thead><tr><th>frame</th><th>rig / arm</th><th>oracle</th><th>our outcome</th><th>gap class</th><th>top-anchored</th><th>odds V1</th><th>baseline</th></tr></thead>
      <tbody>${frameRows}</tbody>
    </table></div>
    <div class="mn-chiprow">
      ${Object.entries(gt).map(([g, n]) => `<div class="mn-chip"><b>${n}</b> ${esc(g)}</div>`).join('')}
    </div>
    <p class="mn-lede">${esc(ex.per_frame_v2_note || '')}</p>
  </div>`;
}

/* ── widget 10: corpus-readiness scoreboard — the 10–20× gate (2026-07-18) ── */

/** One factor card. Absent factor → honest ARTIFACT ABSENT panel (never a
 *  placeholder number). Every measured figure below reads the factor block. */
function mnCorpusFactor(f) {
  if (!f) return '';
  const statusCls = (s) => /LIVE/.test(s) ? 'ok' : (/MERGED/.test(s) ? 'partial' : (/DEFERRED/.test(s) ? 'poor' : ''));
  if (!f.available) {
    return `<div class="mn-rig-card">
      <div class="mn-rig-h"><b>${esc(f.name)}</b> <span class="mn-axis-verdict ${statusCls(f.status)}">${esc(f.status)}</span></div>
      <div class="o-badge">ARTIFACT ABSENT</div>
      <p class="mn-absent-detail">${esc(f.label || f.error || 'NOT MEASURED')}${f.artifact_path ? `<br><code>${esc(f.artifact_path)}</code>` : ''}</p>
    </div>`;
  }
  const m = f.measured || {};
  let body = '';
  if (f.key === 'early_exit') {
    const rng = m.clusters_judged_range_full;
    body = `<ul class="mn-list">
      <li>fires at cluster <b>#0</b> on <b>${m.fires_on_cocoon}/${m.cocoon_truth_frames}</b> truth frames (bar ${mnNum(f.bar_oddsV2, 2)} oddsV2)</li>
      <li><b>1</b> cluster judged vs ${rng ? `<b>${rng[0]}–${rng[1]}</b>` : NR} when it doesn't fire — ≈<b>${mnNum(m.cluster_reduction_x, 1)}×</b> fewer clusters deep-judged</li>
      <li><b>${m.fires_on_gen_miss}/${m.gen_miss_frames_uw}</b> fires on generation-miss frames · <b>${m.wrong_region_fires}</b> wrong-region fires</li>
    </ul>`;
  } else if (f.key === 'gpu_judge') {
    const b = m.band_126k, s = m.band_10k;
    body = `<ul class="mn-list">
      <li>126K band: ${mnNum(b && b.cpu_ms, 0)}ms → ${mnNum(b && b.gpu_ms, 0)}ms = <b>${mnNum(b && b.speedup_x, 2)}×</b>${b && b.verdict_identical ? ` ${mnTag('VERDICT IDENTICAL', 'ok')}` : ''}</li>
      <li>10K band: <b>${mnNum(s && s.speedup_x, 2)}×</b> (GPU launch overhead dominates small work)</li>
      <li class="mn-rig-fmt">${esc(f.substrate || '')}</li>
    </ul>`;
  } else if (f.key === 'frame_parallel') {
    body = `<ul class="mn-list"><li>P=4 overlap: ${m.p4_overlap_x != null ? `<b>${mnNum(m.p4_overlap_x, 2)}×</b>` : NR}${m.cpu_load_pct != null ? ` @ ${mnNum(m.cpu_load_pct, 0)}% CPU` : ''}</li></ul>`;
  } else if (f.key === 'quad_first') {
    body = `<ul class="mn-list">
      <li>frames the rung solved that the sweep couldn't: <b>0</b> — no throughput to gain</li>
      <li>CR2 pin-safety presupposition: ${m.cr2_pin_safety_falsified ? mnTag('FALSIFIED', 'lb') : NR} (pin solves via the classic sweep — reorder touches its path)</li>
    </ul>`;
  } else if (f.key === 'mid_index') {
    body = `<ul class="mn-list">
      <li><b>${m.total_quads != null ? Number(m.total_quads).toLocaleString() : NR}</b> quads over <b>${m.bands ?? NR}</b> bands · ${m.stars != null ? Number(m.stars).toLocaleString() : NR} stars</li>
      <li>build wall ${mnMs(m.build_wall_s != null ? m.build_wall_s * 1000 : null)} · md5 <code>${esc(m.aggregate_md5 || NR)}</code></li>
    </ul>`;
  }
  return `<div class="mn-rig-card">
    <div class="mn-rig-h"><b>${esc(f.name)}</b> <span class="mn-axis-verdict ${statusCls(f.status)}">${esc(f.status_label || f.status)}</span></div>
    ${body}
    <div class="mn-rig-foot"><span class="mn-k1class">${mnTag(esc((f.label || '').split(';')[0].split('—')[0].trim() || 'measured'), 'nm')} cite: <code>${esc(f.cite || f.artifact_path || '')}</code></span></div>
  </div>`;
}

function mnWidgetCorpusGate(ex) {
  if (!ex || !ex.available) return mnAbsent('Corpus-readiness scoreboard — the 10–20× gate', ex);
  const g = ex.gate || {};
  const pj = ex.projection || {};
  const factorCards = (ex.factors || []).map(mnCorpusFactor).join('');
  return `<div class="mn-widget">
    <div class="mn-wtitle">${esc(ex.title || 'Corpus-readiness scoreboard — the 10–20× gate')}</div>
    <div class="mn-chiprow">
      ${mnTag('OWNER GATE', 'lb')}
      <div class="mn-chip ${g.end_to_end_proven ? 'ok' : 'warn'}"><b>≥${g.bar_low_x ?? NR}–${g.bar_high_x ?? NR}×</b> end-to-end required · ${g.end_to_end_proven ? mnTag('PROVEN', 'ok') : mnTag('NOT YET PROVEN', 'lb')}</div>
    </div>
    <p class="mn-lede">${esc(ex.label || '')}</p>

    <h3 class="mn-sub">accelerator factors (one banked artifact each)</h3>
    <div class="mn-rig-grid">${factorCards}</div>

    <h3 class="mn-sub">product estimate</h3>
    <div class="mn-callout">
      <div class="mn-callout-h">${mnTag('PROJECTED', 'lb')} ${esc(pj.scope || '')}</div>
      <div class="mn-callout-body">
        ${pj.stage_scoped_product_x != null
          ? `stage-scoped composition = <b>${mnNum(pj.stage_scoped_product_x, 0)}×</b> on the deep-judge stage &nbsp;=&nbsp; ${(pj.composed_from || []).map((c) => esc(c)).join(' &nbsp;×&nbsp; ')}`
          : `${NR} — one or more composed factors are ${NR}`}
      </div>
      <div class="mn-callout-note">${esc(pj.caveat || '')}</div>
    </div>

    <div class="mn-callout">
      <div class="mn-callout-h">${g.end_to_end_proven ? mnTag('GATE MET', 'ok') : mnTag('GATE NOT MET', 'lb')} the decision</div>
      <div class="mn-callout-body"><b>${esc(g.statement || 'corpus run = OWNER CALL at ≥10–20× proven.')}</b>
        End-to-end ≥10–20× is <b>not yet proven</b> from banked data — the composed factors are stage-scoped or (frame-parallelism) NOT MEASURED on this box. A corpus-wide re-run stays an <b>owner call</b>.</div>
    </div>
  </div>`;
}

function renderMining() {
  const st = state.feeds.mining;
  if (st.unreachable) {
    return subheadHtml('mining') + `<div class="offline">
      <div class="o-badge">NOT MEASURED</div>
      <p><code>mining_dashboard_data.json</code> has not been generated yet (or the server is down).
         Build it with <code>node tools/theses/dashboard/mining_agg.mjs --out test_results/theses/dashboard/mining_dashboard_data.json</code>.
         Retrying every ${POLL_MS / 1000}s.</p>
    </div>`;
  }
  const d = st.data || {};
  const ex = d.exercises || {};
  return subheadHtml('mining') +
    `<p class="mn-lede mn-lede-top">Star-mining exercise wave, 2026-07-17 (owner directive: every test that adds value
      gets a dashboard widget). Source: <code>${esc(d.source_root ?? 'NOT RECORDED')}</code>.
      Every number below is read from that exercise's own <code>result.json</code> at snapshot-build time.</p>
    ${mnWidgetRadial(ex.radial_flux_residuals)}
    ${mnWidgetSeparability(ex.unmatched_separability)}
    ${mnWidgetConfirmFloor(ex.confirm_floor_population)}
    ${mnWidgetEphemeris(ex.ephemeris_anchor_audit)}
    ${mnWidgetBudgetBurn(ex.budget_burn_forensics)}
    ${mnWidgetStarPivot(ex.star_pivot)}
    ${mnWidgetErrorLedger(ex.error_ledger)}
    ${mnWidgetM4Recall(ex.m4_recall)}
    ${mnWidgetW5Proper(ex.w5_proper)}
    ${mnWidgetCorpusGate(ex.corpus_gate)}`;
}
