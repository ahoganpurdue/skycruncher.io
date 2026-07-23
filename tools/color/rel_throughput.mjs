// ═══════════════════════════════════════════════════════════════════════════
// RELATIVE THROUGHPUT / QE CONSISTENCY report  (D11 sub-test 8, tools-lane)
// ═══════════════════════════════════════════════════════════════════════════
// REPORT ONLY. Reuses the SPCC TLS channel gains already measured per frame
// (spcc_gains_n5.json) and asks: does the SAME rig report the SAME relative
// channel response [g_R : 1 : g_B] across frames? Instability itself is the
// finding. Everything here is RELATIVE, APPROXIMATE, atmosphere-confounded —
// NEVER absolute QE. No gate touched, no calibrated constant authored.
//
// F2 (binding): the pre-registered <=0.05 fractional-std bar applies to the
// POST-r2-FILTER subset only — the r2 >= SPCC_GAINS_MIN_R2 (0.55) frames, which
// is n=2 (M66 + M81). That result is DIRECTIONAL(n=2) BY CONSTRUCTION. The
// full-7 spread is reported separately as CONTEXT and is NEVER scored vs the bar.
//
//   node tools/color/rel_throughput.mjs \
//       [--gains test_results/overnight_run_2026-07-10/spcc_gains_n5.json] \
//       [--anchor "Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit"] \
//       [--out  test_results/overnight_run_2026-07-10/rel_throughput_result.json]
//
// FROZEN BARS (sub-test 8):
//   fractional std of (g_R, g_B) across the r2-filtered subset: SUCCESS <=0.05 · KILL >0.15
//   TLS r2 >= 0.55 on >=5 of 7 frames: SUCCESS
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateNoiseModel, loadFitsPlane } from '../denoise/denoise.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const GAINS = path.resolve(ROOT, argVal('--gains', 'test_results/overnight_run_2026-07-10/spcc_gains_n5.json'));
const ANCHOR = path.resolve(ROOT, argVal('--anchor', 'Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit'));
const OUT = path.resolve(ROOT, argVal('--out', 'test_results/overnight_run_2026-07-10/rel_throughput_result.json'));
const MIN_R2 = 0.55; // SPCC_GAINS_MIN_R2 (src/engine/pipeline/constants/pipeline_config.ts)

// ── dispersion helpers ──
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
function stdPop(a) { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); }
function stdSamp(a) { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : NaN; }
const cv = (a, samp) => { const m = mean(a); const s = samp ? stdSamp(a) : stdPop(a); return m !== 0 ? s / Math.abs(m) : NaN; };

function fractionalStd(frames, label) {
    const gR = frames.map(f => f.gR), gB = frames.map(f => f.gB);
    return {
        label, n: frames.length, frames: frames.map(f => f.frameLabel),
        g_R: { values: gR.map(v => +v.toFixed(5)), mean: +mean(gR).toFixed(5), std_pop: +stdPop(gR).toFixed(5), std_samp: +(stdSamp(gR) || NaN).toFixed(5), cv_pop: +cv(gR, false).toFixed(5), cv_samp: +(cv(gR, true) || NaN).toFixed(5) },
        g_B: { values: gB.map(v => +v.toFixed(5)), mean: +mean(gB).toFixed(5), std_pop: +stdPop(gB).toFixed(5), std_samp: +(stdSamp(gB) || NaN).toFixed(5), cv_pop: +cv(gB, false).toFixed(5), cv_samp: +(cv(gB, true) || NaN).toFixed(5) },
    };
}

function main() {
    if (!fs.existsSync(GAINS)) { console.error(`[rel] GAINS ABSENT: ${GAINS}`); process.exit(3); }
    const sweep = JSON.parse(fs.readFileSync(GAINS, 'utf8'));

    // color-fit frames = those that produced a TLS fit (gains present, method TLS)
    const colorFits = sweep.frames.filter(f => f.gains && Array.isArray(f.gains.gains))
        .map(f => ({
            frameLabel: f.label, file: f.file, matched: f.matched,
            gR: f.gains.gains[0], gB: f.gains.gains[2],
            r2: f.gains.r2, nStars: f.gains.nStars, applied: f.gains.applied,
            gatePassed: f.gains.gate?.passed, gateReason: f.gains.gate?.reason,
            degenerate: f.gains.nStars < 20 || f.gains.gains[0] === 1 && f.gains.gains[2] === 1 && f.gains.r2 === 0,
        }));

    // subsets
    const r2Filtered = colorFits.filter(f => f.r2 >= MIN_R2);              // n=2: M66 + M81
    const nonDegen = colorFits.filter(f => !f.degenerate);                 // real fits (nStars>=20)
    const all7 = colorFits;                                                // full color-fit set

    const r2CountPass = colorFits.filter(f => f.r2 >= MIN_R2).length;
    const r2Coverage = { pass: r2CountPass, of: colorFits.length, threshold: MIN_R2, criterion: '>=5 of 7', met: r2CountPass >= 5 };

    // ── PRIMARY (F2): post-r2-filter subset vs the 0.05 bar, DIRECTIONAL(n=2) ──
    const primary = fractionalStd(r2Filtered, `POST-r2-FILTER (r2>=${MIN_R2}) — SCORED vs 0.05 bar, DIRECTIONAL(n=${r2Filtered.length})`);
    const worstCV = Math.max(primary.g_R.cv_pop, primary.g_B.cv_pop); // population CV as the pre-registered dispersion
    const barVerdict = (v) => v <= 0.05 ? 'PASS' : (v > 0.15 ? 'KILL(region)' : 'DIRECTIONAL(mid)');

    // ── CONTEXT (never vs bar): full-7 + non-degenerate spreads ──
    const contextFull7 = fractionalStd(all7, 'FULL-7 color fits — CONTEXT ONLY, never vs bar');
    const contextNonDegen = fractionalStd(nonDegen, `NON-DEGENERATE (nStars>=20, n=${nonDegen.length}) — CONTEXT ONLY`);

    // ── absolute-scale anchor: photon-transfer gain (denoise estimator), APPROXIMATE ──
    let anchor = { status: 'ABSENT', note: `SeeStar anchor FITS not found: ${path.relative(ROOT, ANCHOR)}`, gain_e_per_adu: null };
    const fp = loadFitsPlane(ANCHOR, 1); // plane 1 (green) if multi-plane
    if (fp) {
        const model = estimateNoiseModel(fp.plane, fp.W, fp.H, {});
        anchor = {
            status: 'MEASURED',
            frame: path.relative(ROOT, ANCHOR), plane: `idx ${Math.min(1, fp.NP - 1)} of ${fp.NP}`,
            gain_e_per_adu: model.gain_e_per_adu != null ? +model.gain_e_per_adu.toPrecision(5) : null,
            read_noise_e: model.read_noise_e != null ? +model.read_noise_e.toPrecision(5) : null,
            source: model.source, label: 'APPROXIMATE',
            photon_transfer: model.photon_transfer,
            note: 'photon-transfer estimate on a STACKED SeeStar frame — heavily-stacked frames flatten the variance-mean line (degenerate flag), so treat as an order-of-magnitude anchor only. Absolute e-/ADU is NOT a per-sub calibration.',
        };
    }

    // ── airmass per frame (honest-absent) ──
    const airmass = {
        in_spcc_receipt: false,
        note: 'AIRMASS/OBJCTALT not carried in spcc_gains_n5.json nor typically in SeeStar live-stack FITS headers. NOT MEASURED — the proposal top-kill-risk (airmass drift masquerading as throughput instability) is therefore UNSEPARABLE within this single-airmass-unknown dataset.',
        per_frame: colorFits.map(f => ({ frame: f.frameLabel, airmass: null })),
    };

    const result = {
        schema: 'skycruncher.d11.rel_throughput/1',
        generated_at: new Date().toISOString(),
        classification: 'RESEARCH / atmosphere-confounded / RELATIVE — never absolute QE',
        source_sweep: path.relative(ROOT, GAINS),
        min_r2: MIN_R2,
        body: 'SeeStar / IMX462 (N=1 body — MEDIUM-LOW confidence per proposal)',
        r2_coverage_criterion: r2Coverage,
        primary_scored: {
            ...primary,
            bar: { success: '<=0.05', kill: '>0.15' },
            g_R_cv_pop: primary.g_R.cv_pop, g_B_cv_pop: primary.g_B.cv_pop,
            g_R_cv_samp: primary.g_R.cv_samp, g_B_cv_samp: primary.g_B.cv_samp,
            worst_cv_pop: +worstCV.toFixed(5),
            verdict_g_R: barVerdict(primary.g_R.cv_pop),
            verdict_g_B: barVerdict(primary.g_B.cv_pop),
            verdict: barVerdict(worstCV),
            construction_note: `DIRECTIONAL by construction — only n=${r2Filtered.length} frames clear r2>=${MIN_R2}. A 2-point dispersion cannot distinguish real throughput instability from single-frame outliers.`,
        },
        context_only: { full7: contextFull7, non_degenerate: contextNonDegen },
        absolute_anchor: anchor,
        airmass,
        per_frame_gains: colorFits.map(f => ({
            frame: f.frameLabel, file: f.file, matched: f.matched, nStars: f.nStars,
            g_R: +f.gR.toFixed(5), g_B: +f.gB.toFixed(5), r2: +f.r2.toFixed(5),
            applied: f.applied, gate: f.gateReason, degenerate: f.degenerate,
        })),
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

    console.log(`[rel] r2-coverage: ${r2Coverage.pass}/${r2Coverage.of} frames >= r2 ${MIN_R2} (criterion >=5 of 7: ${r2Coverage.met ? 'MET' : 'FAILED'})`);
    console.log(`[rel] PRIMARY post-r2-filter n=${r2Filtered.length} (${r2Filtered.map(f => f.frameLabel).join(' + ')}):`);
    console.log(`      g_R = [${primary.g_R.values.join(', ')}]  cv_pop=${primary.g_R.cv_pop} cv_samp=${primary.g_R.cv_samp}  [${result.primary_scored.verdict_g_R}]`);
    console.log(`      g_B = [${primary.g_B.values.join(', ')}]  cv_pop=${primary.g_B.cv_pop} cv_samp=${primary.g_B.cv_samp}  [${result.primary_scored.verdict_g_B}]`);
    console.log(`      -> worst cv_pop = ${worstCV.toFixed(4)}  vs bar <=0.05 / KILL>0.15  => ${result.primary_scored.verdict}  (DIRECTIONAL n=${r2Filtered.length})`);
    console.log(`[rel] CONTEXT full-7 g_R cv_pop=${contextFull7.g_R.cv_pop} g_B cv_pop=${contextFull7.g_B.cv_pop} (NOT scored)`);
    console.log(`[rel] anchor: ${anchor.status}${anchor.gain_e_per_adu != null ? ` gain~${anchor.gain_e_per_adu} e-/ADU (APPROXIMATE, ${anchor.photon_transfer?.degenerate ? 'degenerate PT' : 'PT ok'})` : ''}`);
    console.log(`[rel] airmass: NOT MEASURED (honest-absent)`);
    console.log(`[rel] -> ${path.relative(ROOT, OUT)}`);
}

main();
