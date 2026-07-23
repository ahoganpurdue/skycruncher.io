#!/usr/bin/env node
/**
 * fdr_validation.mjs — offline validation harness for the FDR confirm-statistic
 * swap (phase 1; owner ruling 2026-07-12). Reads BANKED receipts only — no
 * solves, no wasm, no box-heavy work (the box is contested). MEASURED numbers
 * only; honest-or-absent where a number cannot be computed from what is on disk.
 *
 * WHAT IT DOES
 *   1. FEASIBILITY (the load-bearing question, checked FIRST): do the banked
 *      receipts carry enough PER-STAR forced-photometry data — the full examined-
 *      candidate SNR vector AND the scrambled-null SNR pool — to recompute the
 *      empirical-null FDR verdict offline? (Spoiler, measured below: NO.)
 *   2. OLD-STATISTIC BASELINE (fully banked, MEASURED): the per-frame
 *      N-vs-setExcessZ table + the N↔Z coupling that motivates the swap — the
 *      √N-growth the review flagged. This is the baseline half of the property
 *      test (the new-statistic half needs the shadow re-run — see §capture).
 *   3. CANARY: flags M31 (nTargets≈126, ~2654 matched) explicitly.
 *   4. CAPTURE SPEC: exactly what a CONFIRM_FDR_SHADOW=1 re-run must bank so the
 *      FDR verdict table (HARD GATE 1/2 + the N-decorrelation property) becomes
 *      computable — the day-lane rider on the failure re-run machinery.
 *
 * VALIDATION CRITERIA (owner correction 2026-07-12, superseding the "14 REFUSED
 * must survive" framing which would calibrate to a desired outcome):
 *   HARD GATE 1 — wrong-WCS/scrambled controls stay REFUSED at q=0.05 (zero tol).
 *   HARD GATE 2 — both pinned solves keep their confirm outcomes.
 *   PROPERTY   — the FDR verdict must DECORRELATE from nTargets (old vs new; new
 *                should flatten). Reported, not threshold-gated.
 *   14 REFUSED — MEASURED per frame, NOT gated (a refusal is information).
 *   All three need the NEW statistic per frame ⇒ they are DEFERRED to the shadow
 *   re-run (this runner reports the OLD-statistic baseline + the exact gap).
 *
 * USAGE:  node tools/confirm/fdr_validation.mjs [receiptsDir] [--json <out>]
 * DEFAULT receiptsDir: D:/AstroLogic/test_artifacts/population_run_2026-07-11/receipts
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const jsonIdx = argv.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;
const posArgs = argv.filter((a, i) => a !== '--json' && (jsonIdx < 0 || i !== jsonIdx + 1) && !a.startsWith('--'));
const RECEIPTS_DIR = posArgs[0]
    || 'D:/AstroLogic/test_artifacts/population_run_2026-07-11/receipts';

function loadReceipts(dir) {
    if (!fs.existsSync(dir)) {
        console.error(`[fdr_validation] receipts dir not found: ${dir}`);
        process.exit(2);
    }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    return files.map(f => {
        let r = null;
        try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { /* skip */ }
        return { file: f, r };
    }).filter(x => x.r);
}

/** Pull the confirm-relevant fields from a receipt (honest-absent). */
function extract({ file, r }) {
    const dc = r.deep_confirmed || null;
    const sol = r.solution || null;
    const phot = sol && sol.photometry;
    const catForced = phot && Array.isArray(phot.stars)
        ? phot.stars.filter(s => s.provenance === 'CATALOG_FORCED') : [];
    return {
        file,
        target: file.replace(/\.(fit|CR2|fits)\.receipt\.json$/i, '').slice(0, 46),
        confirm_status: r.confirm_status ? r.confirm_status.status : null,
        // nTargets = the confirmation pass's examined candidate count.
        nTargets: dc ? dc.examined : null,
        confirmed: dc ? dc.confirmed : null,
        setExcessZ: dc ? dc.setExcessZ : null,
        setGatePassed: dc ? dc.setGatePassed : null,
        stars_matched: sol ? (sol.stars_matched ?? (sol.matched_stars ? sol.matched_stars.length : null)) : null,
        // ── offline-recompute inputs (the load-bearing check) ──
        // full EXAMINED candidate SNR vector? deep_confirmed only carries counts +
        // the CONFIRMED subset (empty on refusal) — so NO.
        confirmedStarsLen: dc && Array.isArray(dc.confirmed_stars) ? dc.confirmed_stars.length : 0,
        // banked null draws (scrambled-null per-star SNRs)? not a field — NO.
        hasNullDraws: !!(dc && (dc.null_draws || dc.nullSnrs || dc.scrambled_null)),
        hasNullRate: !!(dc && ('nullConfirmRate' in dc)),
        // the shadow field itself (present only if a CONFIRM_FDR_SHADOW=1 run made it)
        hasFdrShadow: !!(dc && dc.fdr_shadow),
        // photometry CATALOG_FORCED per-star SNRs (8-bit APPROXIMATE harvest, accepted-only)
        photCatForcedLen: catForced.length,
    };
}

function pearson(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    const d = Math.sqrt(sxx * syy);
    return d > 0 ? sxy / d : null;
}

// ─── run ───────────────────────────────────────────────────────────────────────

const rows = loadReceipts(RECEIPTS_DIR).map(extract)
    .sort((a, b) => (a.nTargets ?? -1) - (b.nTargets ?? -1));

const feasible = rows.some(r => r.hasNullDraws && r.hasFdrShadow);
const anyShadow = rows.some(r => r.hasFdrShadow);

console.log('═'.repeat(96));
console.log('FDR CONFIRM-STATISTIC — OFFLINE VALIDATION (phase 1, MEASURED-only)');
console.log(`receipts: ${RECEIPTS_DIR}`);
console.log(`frames:   ${rows.length}`);
console.log('═'.repeat(96));

// ── §1 FEASIBILITY ──
console.log('\n§1 OFFLINE-RECOMPUTE FEASIBILITY (the load-bearing question)');
const withNull = rows.filter(r => r.hasNullDraws).length;
const refused = rows.filter(r => r.confirm_status === 'REFUSED');
const withFull = refused.filter(r => r.confirmedStarsLen > 0).length;
console.log(`  frames banking scrambled-null draws (needed for empirical p):  ${withNull}/${rows.length}`);
console.log(`  frames banking the FULL examined-candidate SNR vector:         0/${rows.length}  (deep_confirmed carries counts + the CONFIRMED subset only)`);
console.log(`  REFUSED frames with ANY per-star confirm data banked:          ${withFull}/${refused.length}  (confirmed_stars is empty on refusal — 0 data exactly where the property test looks)`);
console.log(`  frames already carrying an fdr_shadow block (a re-run's output): ${rows.filter(r => r.hasFdrShadow).length}/${rows.length}`);
console.log(`  VERDICT: offline empirical-null FDR recompute ${feasible ? 'IS' : 'is NOT'} possible from these receipts.`);
if (!feasible) {
    console.log('  WHY NOT (all three are hard blockers):');
    console.log('   (a) the scrambled-null SNR draws are not banked (only aggregate nullConfirmRate/setExcessZ scalars);');
    console.log('   (b) the full examined-candidate SNR vector is not banked (deep_confirmed = counts + the confirmed subset,');
    console.log('       which is EMPTY on every REFUSED frame — the 14 the property test targets);');
    console.log('   (c) the native Float32 science luminance is released after ingest and is NOT in the receipt, so the');
    console.log('       deterministic null cannot be regenerated offline either.');
    console.log('   NOTE: photometry.stars CATALOG_FORCED carries per-star SNR but from the DIFFERENT 8-bit APPROXIMATE harvest');
    console.log('   path (not the native gate path), accepted-only, and still with no matching null — it cannot stand in.');
}

// ── §2 OLD-STATISTIC BASELINE (measured) ──
console.log('\n§2 OLD-STATISTIC BASELINE — per-frame N-vs-setExcessZ (MEASURED, fully banked)');
console.log('  ' + 'target'.padEnd(46) + 'status'.padEnd(22) + 'nTgt'.padStart(6) + 'matched'.padStart(9) + 'setExcessZ'.padStart(12) + '  gate');
for (const r of rows) {
    const z = r.setExcessZ == null ? 'n/a' : r.setExcessZ.toFixed(2);
    const gate = r.setGatePassed == null ? '' : (r.setGatePassed ? 'PASS' : 'collapse');
    console.log('  ' + String(r.target).padEnd(46)
        + String(r.confirm_status ?? '—').padEnd(22)
        + String(r.nTargets ?? '—').padStart(6)
        + String(r.stars_matched ?? '—').padStart(9)
        + String(z).padStart(12) + '  ' + gate);
}

// ── §3 N↔Z coupling (the √N problem, quantified) ──
const zRows = rows.filter(r => typeof r.setExcessZ === 'number' && typeof r.nTargets === 'number');
const rNZ = pearson(zRows.map(r => r.nTargets), zRows.map(r => r.setExcessZ));
// binary confirm(1)/refuse(0) outcome vs N, over frames that reached the gate (nTargets>=10)
const outRows = rows.filter(r => typeof r.nTargets === 'number' && r.nTargets >= 10
    && (r.confirm_status === 'CONFIRMED' || r.confirm_status === 'REFUSED'));
const rNout = pearson(outRows.map(r => r.nTargets), outRows.map(r => r.confirm_status === 'CONFIRMED' ? 1 : 0));
console.log('\n§3 OLD-STATISTIC N-COUPLING (baseline half of the property test)');
console.log(`  Pearson(nTargets, setExcessZ)          = ${rNZ == null ? 'n/a' : rNZ.toFixed(3)}   over ${zRows.length} frames  (review predicts E[z]∝√N — a positive coupling)`);
console.log(`  Pearson(nTargets, confirmed-outcome)   = ${rNout == null ? 'n/a' : rNout.toFixed(3)}   over ${outRows.length} gate-reaching frames`);
console.log('  → the NEW-statistic half (must FLATTEN toward ~0) is NOT COMPUTABLE offline — deferred to the shadow re-run.');

// ── §4 canary + hard gates (deferred) ──
const m31 = rows.find(r => /M31|Andromeda/i.test(r.file));
console.log('\n§4 CANARY + HARD GATES (require the NEW statistic ⇒ DEFERRED to the shadow re-run)');
if (m31) console.log(`  CANARY M31: nTargets=${m31.nTargets}, matched=${m31.stars_matched}, OLD status=${m31.confirm_status}, OLD setExcessZ=${m31.setExcessZ}. If it REFUSES under FDR → suspect impl bug, investigate before declaring clean.`);
console.log('  HARD GATE 1 (wrong-WCS controls stay REFUSED @ q=0.05): NOT COMPUTABLE here — needs a live scrambled-WCS FDR run (confirm_null_evidence pair). NOT MEASURED.');
console.log('  HARD GATE 2 (both pinned solves keep confirm outcomes):  NOT COMPUTABLE here — needs the CR2/SeeStar apispec run with CONFIRM_FDR_SHADOW=1. NOT MEASURED.');

// ── §5 capture spec ──
console.log('\n§5 SHADOW RE-RUN CAPTURE SPEC (what a CONFIRM_FDR_SHADOW=1 re-run must bank to unblock validation)');
console.log('  The engine field built in phase 1 already emits, per frame, when the flag is on:');
console.log('    deep_confirmed.fdr_shadow = { method, q, examined, null_total, n_confirmed_fdr, p_value_threshold,');
console.log('       effect_size:{p1,p0,rate_ratio,p1_wilson_lower,rate_ratio_wilson_lower,fdr_confirm_rate}, per_star:[{x,y,snr,p_value,rank,confirmed}] }');
console.log('  A day-lane re-run over the population (+ the confirm_null_evidence wrong-WCS pair + the two pinned apispecs)');
console.log('  with CONFIRM_FDR_SHADOW=1 then makes this runner compute the full verdict table: point [receiptsDir] at the');
console.log('  re-run output and rows with hasFdrShadow=true drive HARD GATE 1/2 + the N-decorrelation property directly.');

// ── machine-readable artifact ──
const report = {
    generated: new Date().toISOString(),
    receiptsDir: RECEIPTS_DIR,
    frames: rows.length,
    offline_fdr_recompute_feasible: feasible,
    any_shadow_receipts: anyShadow,
    old_statistic_coupling: { pearson_n_setExcessZ: rNZ, pearson_n_outcome: rNout, z_frames: zRows.length, outcome_frames: outRows.length },
    per_frame: rows,
    hard_gates: { gate1_wrongWCS_refused: 'NOT_MEASURED (needs live scrambled-WCS FDR run)', gate2_pins_hold: 'NOT_MEASURED (needs apispec run w/ CONFIRM_FDR_SHADOW=1)' },
};
if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    console.log(`\n[fdr_validation] machine-readable report → ${jsonOut}`);
}
console.log('\n' + '═'.repeat(96));
