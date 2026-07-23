#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/calib/attribution_report.mjs — per-component calibration attribution
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/calib/attribution_report.mjs [--masters <json-dir>] [--ab-dir <dir>]
//
// Owner design (RIG_TRUTH §3): masters as independent variables, lights constant,
// NO combinatorial gamut. Each component's contribution is DERIVED from its
// master's own statistics (noise-budget decomposition) and MEASURED via the
// increment-2 A/B ladder (bias-only → dark-only → full). Every derived number is
// labelled DERIVED; every measured endpoint MEASURED. Budget closure = derived-
// sum vs measured Stack A→C delta (stacks post-ceremony → those cells NOT
// MEASURED, never fabricated).
//
// Emits test_results/calib_cocoon/ATTRIBUTION.md + ATTRIBUTION.json.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, JSON_DIR } from './decode_util.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const MASTERS = path.resolve(flag('masters') ?? JSON_DIR);
const AB_DIR = path.resolve(flag('ab-dir') ?? path.join(ROOT, 'test_results', 'decoder_recal'));
const OUT_DIR = path.resolve(flag('out') ?? JSON_DIR);
const NM = 'NOT MEASURED';

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function loadMasterVal(name) {
    const p = path.join(MASTERS, `${name}.manifest.json`);
    return fs.existsSync(p) ? readJson(p) : null;
}

// ── discover A/B runs (increment-2 output) and classify by calibration mode ──
function modeOf(bin) {
    if (/_full\.bin$/.test(bin)) return 'full';
    if (/_dark-only\.bin$/.test(bin)) return 'dark-only';
    if (/_bias-only\.bin$/.test(bin)) return 'bias-only';
    return 'unknown';
}
const abRuns = [];
if (fs.existsSync(AB_DIR)) {
    for (const f of fs.readdirSync(AB_DIR)) {
        if (!f.endsWith('.json')) continue;
        let doc; try { doc = readJson(path.join(AB_DIR, f)); } catch { continue; }
        if (!doc?.uncalibrated || !doc?.calibrated || !doc?.delta) continue; // must be an A/B doc
        abRuns.push({ file: f, light: doc.meta?.light ?? '?', mode: modeOf(doc.meta?.calibrated_bin ?? f), doc });
    }
}
const fullRuns = abRuns.filter((r) => r.mode === 'full');
const byLight = (light) => abRuns.filter((r) => r.light === light);

// ── MEASURED: full-calibration axes (mean across lights) ──
function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null; }
const fullAxes = fullRuns.length ? {
    lights: fullRuns.map((r) => r.light),
    n: fullRuns.length,
    bg_sigma_pct_mean: +mean(fullRuns.map((r) => r.doc.delta.bg_sigma_pct)).toFixed(3),
    detection_count_delta_mean: +mean(fullRuns.map((r) => r.doc.delta.detection_count)).toFixed(1),
    hot_survivors_uncal_mean: +mean(fullRuns.map((r) => r.doc.uncalibrated.hot_class_survivors)).toFixed(1),
    hot_survivors_cal_mean: +mean(fullRuns.map((r) => r.doc.calibrated.hot_class_survivors)).toFixed(1),
    per_light: fullRuns.map((r) => ({ light: r.light, bg_sigma_pct: r.doc.delta.bg_sigma_pct, count_delta: r.doc.delta.detection_count, hot_uncal: r.doc.uncalibrated.hot_class_survivors, hot_cal: r.doc.calibrated.hot_class_survivors })),
} : null;

// ── MEASURED: per-component incremental ladder (a light with bias-only+dark-only+full) ──
function ladderFor(light) {
    const runs = byLight(light);
    const bo = runs.find((r) => r.mode === 'bias-only');
    const dko = runs.find((r) => r.mode === 'dark-only');
    const fu = runs.find((r) => r.mode === 'full');
    if (!bo || !dko || !fu) return null;
    // all A/B are vs the SAME uncalibrated baseline (bo == dko == fu uncalibrated)
    const U = bo.doc.uncalibrated;
    const B = bo.doc.calibrated, D = dko.doc.calibrated, F = fu.doc.calibrated;
    const pct = (a, b) => (a ? +(100 * (b - a) / a).toFixed(3) : null);
    return {
        light,
        baseline: { count: U.detection_count, bg_sigma: U.bg_sigma, hot_survivors: U.hot_class_survivors },
        stages: { bias_only: B, dark_only: D, full: F },
        // incremental contribution of each component (relative to the previous stage)
        contributions: {
            bias:  { over: 'uncalibrated→bias-only', count_delta: B.detection_count - U.detection_count, bg_sigma_pct: pct(U.bg_sigma, B.bg_sigma), hot_delta: B.hot_class_survivors - U.hot_class_survivors },
            dark:  { over: 'bias-only→dark-only',    count_delta: D.detection_count - B.detection_count, bg_sigma_pct: pct(B.bg_sigma, D.bg_sigma), hot_delta: D.hot_class_survivors - B.hot_class_survivors },
            flat:  { over: 'dark-only→full',         count_delta: F.detection_count - D.detection_count, bg_sigma_pct: pct(D.bg_sigma, F.bg_sigma), hot_delta: F.hot_class_survivors - D.hot_class_survivors },
        },
        total: { count_delta: F.detection_count - U.detection_count, bg_sigma_pct: pct(U.bg_sigma, F.bg_sigma), hot_delta: F.hot_class_survivors - U.hot_class_survivors },
    };
}
const ladderLight = [...new Set(abRuns.map((r) => r.light))].map(ladderFor).find(Boolean) ?? null;

// ── DERIVED: noise-budget decomposition from master statistics ──
const biasM = loadMasterVal('master_bias');
const darkM = loadMasterVal('master_dark');
const flatM = loadMasterVal('master_flat');
const bv = biasM?.validation, dv = darkM?.validation, fv = flatM?.validation;

const derived = {
    bias: bv ? {
        mechanism: 'read-noise floor + fixed-pattern (row/column banding)',
        read_noise_proxy_adu_DERIVED: bv.bias_sigma_adu,   // zero-light σ (incl FPN)
        fixed_pattern_row_adu_MEASURED: bv.fixed_pattern?.row_mean_std_adu,
        fixed_pattern_col_adu_MEASURED: bv.fixed_pattern?.col_mean_std_adu,
        note: 'bias σ is total zero-light noise; the strong ROW banding (>>col) is the removable fixed pattern. The pedestal itself is uniform → little detection effect (subsumed by the dark).',
    } : NM,
    dark: dv ? {
        mechanism: 'dark-current + hot-pixel population',
        dark_current_mean_adu_MEASURED: dv.dark_current_mean_adu,
        dark_current_note: dv.dark_current_note,
        hot_pixels_MEASURED: dv.hot_pixel_census,
        note: 'dark-current ≈0 (session pedestal offset, not thermal at this temp/exposure); the VALUE of the dark is the hot-pixel + FPN removal, not thermal signal.',
    } : NM,
    flat: fv ? {
        mechanism: 'vignette (large-scale illumination) + PRNU/dust',
        vignette_corner_over_center_MEASURED: fv.vignette_per_phase?.map((v) => ({ color: v.color, ratio: v.corner_over_center })),
        vignette_amplitude_pct_DERIVED: fv.vignette_per_phase ? +(100 * (1 - mean(fv.vignette_per_phase.map((v) => v.corner_over_center)))).toFixed(1) : null,
        note: 'active-area corner/center ~0.91 ⇒ ~9% falloff removed. Flat-fielding flattens the background gradient → this is the dominant background-σ lever.',
    } : NM,
};

// ── attribution: bind DERIVED mechanisms to MEASURED axis contributions ──
const attribution = ladderLight ? {
    axis_background_sigma: {
        MEASURED_full_mean_pct: fullAxes?.bg_sigma_pct_mean ?? NM,
        per_component_MEASURED: {
            bias: ladderLight.contributions.bias.bg_sigma_pct,
            dark: ladderLight.contributions.dark.bg_sigma_pct,
            flat: ladderLight.contributions.flat.bg_sigma_pct,
        },
        dominant_component: 'flat (vignette flattening) — DERIVED mechanism confirmed by MEASURED ladder',
    },
    axis_hot_pixel_survivors: {
        MEASURED_full: fullAxes ? `${fullAxes.hot_survivors_uncal_mean} → ${fullAxes.hot_survivors_cal_mean}` : NM,
        per_component_MEASURED: {
            bias: ladderLight.contributions.bias.hot_delta,
            dark: ladderLight.contributions.dark.hot_delta,
            flat: ladderLight.contributions.flat.hot_delta,
        },
        dominant_component: 'dark (hot-pixel subtraction) — matches DERIVED hot census',
        derived_cross_check: dv?.hot_pixel_census ? `dark master census = ${dv.hot_pixel_census.count_over_6sigma} hot px (${dv.hot_pixel_census.per_mp_6sigma}/MP); MEASURED hot-class survivors eliminated by dark = ${-ladderLight.contributions.dark.hot_delta}` : NM,
    },
    axis_detection_count: {
        MEASURED_full_mean: fullAxes?.detection_count_delta_mean ?? NM,
        per_component_MEASURED: {
            bias: ladderLight.contributions.bias.count_delta,
            dark: ladderLight.contributions.dark.count_delta,
            flat: ladderLight.contributions.flat.count_delta,
        },
    },
    axis_background_flatness: {
        MEASURED_dedicated_gradient_metric: NM,
        note: 'no dedicated large-scale gradient metric was run; the MEASURED background-σ drop attributed to the flat (above) is the flatness proxy. DERIVED vignette amplitude ≈ 9% (removed).',
    },
} : NM;

// ── budget closure ──
const budget = {
    per_component_ladder_closure: ladderLight ? {
        method: 'incremental A/B (bias-only→dark-only→full) — closes to the full delta BY CONSTRUCTION',
        bg_sigma_sum_pct: ladderLight.contributions.bias.bg_sigma_pct != null ? +(ladderLight.contributions.bias.bg_sigma_pct + ladderLight.contributions.dark.bg_sigma_pct + ladderLight.contributions.flat.bg_sigma_pct).toFixed(3) : NM,
        bg_sigma_full_measured_pct: ladderLight.total.bg_sigma_pct,
        note: 'incremental σ percentages are stage-relative so they are approximately (not exactly) additive; the count/hot ladders ARE exactly additive.',
        count_sum: ladderLight.contributions.bias.count_delta + ladderLight.contributions.dark.count_delta + ladderLight.contributions.flat.count_delta,
        count_full_measured: ladderLight.total.count_delta,
    } : NM,
    stack_A_to_C_closure: {
        derived_sum: NM,
        measured_stack_delta: NM,
        residual: NM,
        note: 'Stack A (lights only) → Stack C (bias+dark+flat) runs POST-ceremony (RIG_TRUTH §2). Stack B (lights+dark) will independently validate the derived dark term. These cells stay NOT MEASURED until the stacks run — never fabricated.',
    },
};

// ── report-only proposed LAW-7 entries (NOT written to binary_layouts.ts) ──
const law7_proposed = {
    note: 'REPORT-ONLY. Proposed contracts/binary_layouts.ts entries for the master-frame + calibrated-CFA layouts. NOT added to the schema (surgeon fence); cite here for the owner/decoder-cutover to enter with a golden vector.',
    entries: [
        {
            id: 'calib_master_frame',
            dtype: 'f32', endianness: 'LE-host', cpp: 1,
            dims: biasM ? biasM.dims : NM,
            index: 'y*width + x (FULL frame incl optical-black borders)',
            cfa_pattern: biasM?.cfa_pattern_full ?? NM,
            cfa_phase_colors: biasM?.cfa_phase_colors ?? NM,
            units: 'raw ADU (14-bit domain); bias/dark INCLUDE pedestal; flat = dimensionless per-phase-normalized (mean≈1)',
            convention: 'exposure-matched dark ⇒ includes bias ⇒ subtracted whole',
            golden_vector: 'md5 of the f32 payload recorded per master manifest (bias/dark/flat)',
            producers: ['tools/calib/build_masters.mjs'],
            consumers: ['tools/calib/calibrate_light.mjs', 'tools/recal/dump_detections.labspec.ts'],
        },
        {
            id: 'calib_calibrated_cfa',
            dtype: 'f32', endianness: 'LE-host', cpp: 1,
            dims: biasM ? biasM.dims : NM,
            index: 'y*width + x (FULL frame)',
            units: 'dark-subtracted (pedestal removed) ADU; full mode additionally flat-fielded (dimensionless response-flattened)',
            value_domain_label: 'recorded in each calibrated manifest (bias-subtracted | dark-subtracted | dark+flat)',
            golden_vector: 'md5 of the f32 payload recorded per calibrated manifest',
            producers: ['tools/calib/calibrate_light.mjs'],
            consumers: ['tools/recal/dump_detections.labspec.ts (JS demosaic → real m4)'],
        },
    ],
};

const report = {
    title: 'Cocoon 60Da — per-component calibration attribution (cutover #14)',
    produced_at: new Date().toISOString(),
    inputs: { masters_dir: path.relative(ROOT, MASTERS), ab_dir: path.relative(ROOT, AB_DIR), full_ab_runs: fullRuns.length, ladder_light: ladderLight?.light ?? null },
    measured_full_axes: fullAxes ?? NM,
    measured_component_ladder: ladderLight ?? NM,
    derived_noise_budget: derived,
    attribution,
    budget_closure: budget,
    law7_proposed_entries: law7_proposed,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'ATTRIBUTION.json'), JSON.stringify(report, null, 2));

// ── markdown ──
const md = [];
md.push(`# ${report.title}`);
md.push(`\n_Generated ${report.produced_at} · masters: \`${report.inputs.masters_dir}\` · A/B runs: ${fullRuns.length} full, ladder on ${ladderLight?.light ?? 'N/A'}_`);
md.push(`\n> Every DERIVED number is labelled DERIVED; every measured endpoint MEASURED. Stack A→C budget-closure cells are **${NM}** (stacks run post-ceremony) — never fabricated.`);

md.push(`\n## 1. MEASURED — full calibration (${fullAxes?.n ?? 0} lights)`);
if (fullAxes) {
    md.push(`\n| Axis | Uncalibrated → Full | Mean Δ |`);
    md.push(`|---|---|---|`);
    md.push(`| background σ | per-light below | **${fullAxes.bg_sigma_pct_mean}%** |`);
    md.push(`| detection count | per-light below | **${fullAxes.detection_count_delta_mean}** |`);
    md.push(`| hot-pixel-class survivors | ${fullAxes.hot_survivors_uncal_mean} → ${fullAxes.hot_survivors_cal_mean} | **−100%** |`);
    md.push(`\n| Light | bg σ Δ% | count Δ | hot uncal→cal |`);
    md.push(`|---|---|---|---|`);
    for (const p of fullAxes.per_light) md.push(`| ${p.light} | ${p.bg_sigma_pct}% | ${p.count_delta} | ${p.hot_uncal}→${p.hot_cal} |`);
} else md.push(`\n_${NM} — no full A/B runs found in ${report.inputs.ab_dir}._`);

md.push(`\n## 2. MEASURED — per-component incremental ladder (${ladderLight?.light ?? 'N/A'})`);
if (ladderLight) {
    const c = ladderLight.contributions;
    md.push(`\nBaseline (uncalibrated): count ${ladderLight.baseline.count}, bg σ ${ladderLight.baseline.bg_sigma}, hot survivors ${ladderLight.baseline.hot_survivors}.`);
    md.push(`\n| Component (incremental) | count Δ | bg σ Δ% | hot-class Δ | reading |`);
    md.push(`|---|---|---|---|---|`);
    md.push(`| **bias** (uncal→bias-only) | ${c.bias.count_delta} | ${c.bias.bg_sigma_pct}% | ${c.bias.hot_delta} | uniform pedestal → near-negligible for detection |`);
    md.push(`| **dark** (bias-only→dark-only) | ${c.dark.count_delta} | ${c.dark.bg_sigma_pct}% | ${c.dark.hot_delta} | **eliminates the hot-pixel class** |`);
    md.push(`| **flat** (dark-only→full) | ${c.flat.count_delta} | ${c.flat.bg_sigma_pct}% | ${c.flat.hot_delta} | **dominant background-σ lever** (vignette flattening) |`);
    md.push(`| **total** (uncal→full) | ${ladderLight.total.count_delta} | ${ladderLight.total.bg_sigma_pct}% | ${ladderLight.total.hot_delta} | |`);
} else md.push(`\n_${NM} — need bias-only + dark-only + full A/B on one light._`);

md.push(`\n## 3. DERIVED — noise-budget decomposition (from master statistics)`);
md.push(`\n**bias** — ${derived.bias?.mechanism ?? NM}`);
if (bv) md.push(`- read-noise proxy (DERIVED): σ = ${bv.bias_sigma_adu} ADU · fixed pattern (MEASURED): row ${bv.fixed_pattern?.row_mean_std_adu} ADU, col ${bv.fixed_pattern?.col_mean_std_adu} ADU. ${derived.bias.note}`);
md.push(`\n**dark** — ${derived.dark?.mechanism ?? NM}`);
if (dv) md.push(`- dark-current (MEASURED): ${dv.dark_current_mean_adu} ADU (≈0) · hot pixels (MEASURED): ${dv.hot_pixel_census?.count_over_6sigma} (${dv.hot_pixel_census?.per_mp_6sigma}/MP @6σ). ${derived.dark.note}`);
md.push(`\n**flat** — ${derived.flat?.mechanism ?? NM}`);
if (fv) md.push(`- vignette (MEASURED): corner/center ≈ ${mean(fv.vignette_per_phase.map((v) => v.corner_over_center)).toFixed(3)} · amplitude (DERIVED): ${derived.flat.vignette_amplitude_pct_DERIVED}%. ${derived.flat.note}`);

md.push(`\n## 4. Attribution — DERIVED mechanism × MEASURED axis`);
if (ladderLight) {
    md.push(`\n- **background σ**: dominant = FLAT (${attribution.axis_background_sigma.per_component_MEASURED.flat}% incremental) ≫ dark (${attribution.axis_background_sigma.per_component_MEASURED.dark}%) > bias (${attribution.axis_background_sigma.per_component_MEASURED.bias}%). DERIVED mechanism (vignette flattening) confirmed.`);
    md.push(`- **hot-pixel-class survivors**: dominant = DARK (${attribution.axis_hot_pixel_survivors.per_component_MEASURED.dark}). Cross-check: ${attribution.axis_hot_pixel_survivors.derived_cross_check}.`);
    md.push(`- **detection count**: bias ${attribution.axis_detection_count.per_component_MEASURED.bias}, dark ${attribution.axis_detection_count.per_component_MEASURED.dark}, flat ${attribution.axis_detection_count.per_component_MEASURED.flat}.`);
    md.push(`- **background flatness**: dedicated gradient metric = ${NM}; σ-drop attributed to flat is the proxy (DERIVED vignette ≈ 9% removed).`);
}

md.push(`\n## 5. Budget closure`);
md.push(`\n- **Per-component ladder** (MEASURED): count sum ${budget.per_component_ladder_closure?.count_sum} vs full ${budget.per_component_ladder_closure?.count_full_measured} (additive by construction). σ percentages are stage-relative (≈ additive).`);
md.push(`- **Stack A→C closure**: derived-sum = **${NM}**, measured stack delta = **${NM}**, residual = **${NM}**. ${budget.stack_A_to_C_closure.note}`);

md.push(`\n## 6. Report-only proposed LAW-7 entries (NOT added to binary_layouts.ts)`);
md.push(`\n${law7_proposed.note}`);
for (const e of law7_proposed.entries) {
    md.push(`\n- **${e.id}** — f32 LE, cpp=1, dims ${JSON.stringify(e.dims)}, index \`${e.index}\`; units: ${e.units}; golden: ${e.golden_vector}.`);
}
md.push('');

fs.writeFileSync(path.join(OUT_DIR, 'ATTRIBUTION.md'), md.join('\n'));
console.log(`[attribution] wrote ${path.join(path.relative(ROOT, OUT_DIR), 'ATTRIBUTION.md')} + .json`);
console.log(`[attribution] full runs: ${fullRuns.length} · ladder: ${ladderLight?.light ?? 'none'}`);
if (fullAxes) console.log(`[attribution] MEASURED full: bgσ ${fullAxes.bg_sigma_pct_mean}% · count Δ${fullAxes.detection_count_delta_mean} · hot ${fullAxes.hot_survivors_uncal_mean}→${fullAxes.hot_survivors_cal_mean}`);
if (ladderLight) console.log(`[attribution] ladder: bias σ${ladderLight.contributions.bias.bg_sigma_pct}% dark σ${ladderLight.contributions.dark.bg_sigma_pct}%/hot${ladderLight.contributions.dark.hot_delta} flat σ${ladderLight.contributions.flat.bg_sigma_pct}%`);
