// ═══════════════════════════════════════════════════════════════════════════
// COLOR INCUBATOR — STAR-COLOR FIDELITY GATE (prototype, REPORT-ONLY)
// ═══════════════════════════════════════════════════════════════════════════
// Tier-2 §4.1 of docs/COLOR_MATH_PROGRAM.md: the color analog of the astrometric
// solve gate. We ALREADY hold, per matched star, a measured instrumental color
//   instColor = −2.5·log10(flux_b/flux_r)          (spcc_calibrator.ts:229)
// and Gaia catalog truth BP-RP. The engine fits catBpRp = slope·instColor +
// intercept with 2.5σ clipping (spcc_calibrator.ts:100-154) and records
// slope/r2/rmse in the receipt `spcc` block. This driver PROMOTES that telemetry
// into a pass/fail-SHAPED verdict — but stays RECORDED EVIDENCE, never enforced
// (owner guards calibrated gates; the acceptance bar is set from corpus evidence
// LATER, not here). `validated` is therefore null; a `proposed_verdict` field
// shows what the block WOULD say under an illustrative, clearly-labelled bar.
//
// It reproduces the engine fit from the receipt's per-star records (a cross-check
// that this prototype mirrors the shipped math to numeric identity), then adds the
// residual/outlier statistics a gate would need.
//
// SCOPE: FITS lane only — SPCC gates on isFits && scienceRgb && matchedStars>0
// (stages/science.ts:118); the CR2/DSLR path never carries SPCC today. Every
// SPCC receipt we can find/generate is the SAME SeeStar M66 frame → N=1 DISTINCT
// FRAME. This is stated loudly in the output and is the whole point of the bar
// being "PROPOSED-N=1".
//
// Usage:  node tools/color/star_color_fidelity.mjs [receipt.json ...]
//         (no args → auto-discovers known SPCC receipts under test_results/)
// Output: test_results/color_incubator/star_color_fidelity.json  (+ console)
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'test_results', 'color_incubator');

// ─── engine-faithful robust regression (mirror of fitColorRegression) ────────
// Model: catBpRp = slope·instColor + intercept, k-σ clipped. Reproduced here so
// the prototype has no engine import and can be pointed at any receipt.
function fitColorRegression(samples, { sigmaClip = 2.5, maxIter = 3, minStars = 8 } = {}) {
    let active = samples.slice();
    let slope = 1, intercept = 0;
    let clippedTotal = 0;
    for (let iter = 0; iter < maxIter; iter++) {
        if (active.length < minStars) return { valid: false, slope, intercept, r2: 0, rmse: 0, n_used: active.length, n_clipped: clippedTotal };
        const n = active.length;
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const s of active) { sx += s.instColor; sy += s.catBpRp; sxx += s.instColor * s.instColor; sxy += s.instColor * s.catBpRp; }
        const denom = n * sxx - sx * sx;
        if (Math.abs(denom) < 1e-12) return { valid: false, slope, intercept, r2: 0, rmse: 0, n_used: n, n_clipped: clippedTotal };
        slope = (n * sxy - sx * sy) / denom;
        intercept = (sy - slope * sx) / n;
        const residuals = active.map(s => s.catBpRp - (slope * s.instColor + intercept));
        const sigma = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / n);
        if (sigma <= 1e-12) break;
        const kept = active.filter((_, i) => Math.abs(residuals[i]) <= sigmaClip * sigma);
        clippedTotal += active.length - kept.length;
        if (kept.length === active.length) break;
        active = kept;
    }
    if (active.length < minStars) return { valid: false, slope, intercept, r2: 0, rmse: 0, n_used: active.length, n_clipped: clippedTotal };
    const n = active.length;
    const meanY = active.reduce((a, s) => a + s.catBpRp, 0) / n;
    let ssRes = 0, ssTot = 0;
    for (const s of active) {
        const r = s.catBpRp - (slope * s.instColor + intercept);
        ssRes += r * r; ssTot += (s.catBpRp - meanY) ** 2;
    }
    const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : 0;
    const rmse = Math.sqrt(ssRes / n);
    return { valid: true, slope, intercept, r2, rmse, n_used: n, n_clipped: clippedTotal };
}

function median(a) {
    if (!a.length) return NaN;
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ─── errors-in-variables slope bracket (audit-flagged) ───────────────────────
// The engine fit is OLS of the PRECISE catalog color (Y=catBpRp) on the NOISY
// instrumental color (X=instColor). With measurement error in the PREDICTOR, OLS
// slope is attenuated toward zero — the true slope is steeper. We bracket it:
//   ols_yx  = Sxy/Sxx        (engine direction; attenuated / lower bound in |slope|)
//   rev_yx  = Syy/Sxy        (reverse regression inverted; upper bound in |slope|)
//   tls     = orthogonal (total least squares) point estimate, between the two
// Reported so the verdict block can carry the bias-corrected view; NOT used to
// derive channel gains (audit: unsound until a real EIV fit lands).
function slopeBracket(samples) {
    const n = samples.length;
    if (n < 3) return null;
    let mx = 0, my = 0;
    for (const s of samples) { mx += s.instColor; my += s.catBpRp; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const s of samples) {
        const dx = s.instColor - mx, dy = s.catBpRp - my;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    if (Math.abs(sxy) < 1e-12) return null;
    const ols_yx = sxy / sxx;
    const rev_yx = syy / sxy;
    const tls = (syy - sxx + Math.sqrt((syy - sxx) ** 2 + 4 * sxy * sxy)) / (2 * sxy);
    return {
        ols_yx, rev_yx, tls,
        attenuation_ratio_tls_over_ols: tls / ols_yx,   // >1 ⇒ OLS under-estimates the slope
    };
}

// Unclipped (full-set) r2/rmse — the HONEST counterpart to the survivor-only
// numbers the engine records (clipping makes r2/rmse optimistic).
function unclippedStats(samples, slope, intercept) {
    const n = samples.length;
    const my = samples.reduce((a, s) => a + s.catBpRp, 0) / n;
    let ssRes = 0, ssTot = 0;
    for (const s of samples) {
        const r = s.catBpRp - (slope * s.instColor + intercept);
        ssRes += r * r; ssTot += (s.catBpRp - my) ** 2;
    }
    return { r2: ssTot > 1e-12 ? 1 - ssRes / ssTot : 0, rmse_mag: Math.sqrt(ssRes / n), n };
}

// ─── extract per-star color samples from a receipt ───────────────────────────
// The SPCC-provenance star records carry `inst_color` (= −2.5·log10(flux_b/flux_r),
// aperture-measured) and `cat_bp_rp` (Gaia BP-RP truth). MATCHED-provenance records
// carry only PEAK_RGB and null inst_color, so they are (correctly) skipped — we use
// exactly the sample set the engine fit used.
function extractSamples(receipt) {
    const stars = receipt?.solution?.photometry?.stars || [];
    const samples = [];
    for (const s of stars) {
        if (s.inst_color == null || s.cat_bp_rp == null) continue;
        if (!Number.isFinite(s.inst_color) || !Number.isFinite(s.cat_bp_rp)) continue;
        samples.push({
            instColor: s.inst_color,
            catBpRp: s.cat_bp_rp,
            gaia_id: s.gaia_id ?? null,
            x: s.x ?? null, y: s.y ?? null,
            provenance: s.provenance ?? null,
        });
    }
    return samples;
}

function isFitsReceipt(receipt) {
    // SeeStar science frames are FITS; sniff the metadata/source for a FITS marker.
    const blob = JSON.stringify(receipt?.metadata || {}) + ' ' + JSON.stringify(receipt?.source_provenance || {});
    if (/fits|\.fit\b|xisf|seestar|dso_stacked/i.test(blob)) return true;
    // Fallback: SPCC only ever runs on the FITS lane, so a populated spcc.n_stars
    // with inst_color-bearing stars is itself a FITS-lane signature.
    return (receipt?.spcc?.n_stars || 0) > 0;
}

// ─── the fidelity computation for one receipt ────────────────────────────────
function evaluateReceipt(filePath) {
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (e) { return { file: filePath, status: 'UNREADABLE', error: String(e.message || e) }; }

    const samples = extractSamples(receipt);
    const spccBlock = receipt.spcc || null;
    const fitsLane = isFitsReceipt(receipt);

    if (samples.length === 0) {
        return {
            file: path.relative(ROOT, filePath),
            status: spccBlock && spccBlock.n_stars ? 'SPCC_BLOCK_ONLY_NO_PERSTAR' : 'NO_SPCC',
            fits_lane: fitsLane,
            receipt_spcc: spccBlock ? { slope: spccBlock.color_slope, r2: spccBlock.color_r2, rmse: spccBlock.color_rmse, n: spccBlock.n_stars } : null,
        };
    }

    const fit = fitColorRegression(samples);
    const bracket = slopeBracket(samples);
    const unclipped = unclippedStats(samples, fit.slope, fit.intercept);

    // residuals on the FULL sample set (pre-clip) against the fitted line
    const resid = samples.map(s => s.catBpRp - (fit.slope * s.instColor + fit.intercept));
    const absResid = resid.map(Math.abs);
    const medAbs = median(absResid);
    const madMag = 1.4826 * median(absResid.map(a => Math.abs(a - medAbs)));
    // robust σ from the final fit rmse; outlier fractions on the full set
    const outlier2rmse = fit.rmse > 0 ? absResid.filter(a => a > 2 * fit.rmse).length / samples.length : 0;
    const outlier3rmse = fit.rmse > 0 ? absResid.filter(a => a > 3 * fit.rmse).length / samples.length : 0;

    // cross-check vs the engine's own recorded fit (proves this driver mirrors the ship math)
    let engineDelta = null;
    if (spccBlock && Number.isFinite(spccBlock.color_r2)) {
        engineDelta = {
            slope_abs: Math.abs(fit.slope - spccBlock.color_slope),
            r2_abs: Math.abs(fit.r2 - spccBlock.color_r2),
            rmse_abs: Math.abs(fit.rmse - spccBlock.color_rmse),
            reproduces_engine: Math.abs(fit.r2 - spccBlock.color_r2) < 1e-6 && Math.abs(fit.rmse - spccBlock.color_rmse) < 1e-6,
        };
    }

    // ─── PROPOSED verdict block (SHAPE only — NOT enforced, NOT calibrated) ──
    // Illustrative bar for discussion; the real bar comes from corpus evidence.
    // Reported so the owner can see what a gate WOULD emit, without it gating anything.
    const PROPOSED_BAR = { r2_min: 0.90, rmse_max_mag: 0.10, n_stars_min: 20 };
    const wouldPass = fit.valid && fit.r2 >= PROPOSED_BAR.r2_min && fit.rmse <= PROPOSED_BAR.rmse_max_mag && fit.n_used >= PROPOSED_BAR.n_stars_min;

    return {
        file: path.relative(ROOT, filePath),
        status: 'EVALUATED',
        fits_lane: fitsLane,
        n_samples: samples.length,
        instColor_range: [Math.min(...samples.map(s => s.instColor)), Math.max(...samples.map(s => s.instColor))],
        catBpRp_range: [Math.min(...samples.map(s => s.catBpRp)), Math.max(...samples.map(s => s.catBpRp))],
        recomputed_fit_ols: {
            slope: fit.slope, intercept: fit.intercept, r2: fit.r2,
            rmse_mag: fit.rmse, n_used: fit.n_used, n_clipped: fit.n_clipped,
            frame: 'OLS: catBpRp (precise) on instColor (noisy); survivor-only stats — OPTIMISTIC',
        },
        unclipped_fit: {                          // honest full-set counterpart
            r2: unclipped.r2, rmse_mag: unclipped.rmse_mag, n: unclipped.n,
            note: 'same OLS line, evaluated on ALL samples (no σ-clip) — the un-optimistic view',
        },
        slope_bracket_eiv: bracket,               // attenuation-bias correction (audit-flagged)
        residual_stats_mag: {
            median_abs: medAbs, mad: madMag,
            outlier_frac_gt2rmse: outlier2rmse, outlier_frac_gt3rmse: outlier3rmse,
        },
        engine_crosscheck: engineDelta,
        // ── the SHAPE the owner is asked to react to ──
        proposed_verdict: {
            validated: null,                       // NEVER enforced here — calibration deferred
            r2: fit.r2,                            // headline = OLS, for receipt continuity
            rmse_mag: fit.rmse,
            n_stars: fit.n_used,
            slope_ols: fit.slope,
            slope_tls_eiv: bracket ? bracket.tls : null,      // bias-corrected (steeper)
            slope_bracket: bracket ? [bracket.ols_yx, bracket.rev_yx] : null,
            r2_unclipped: unclipped.r2,
            rmse_mag_unclipped: unclipped.rmse_mag,
            bar: 'PROPOSED-N=1',
            proposed_bar_illustrative: PROPOSED_BAR,
            would_pass_illustrative: wouldPass,     // for discussion ONLY
            channel_gain_application: 'NOT PROPOSED — deriving channel gains from the OLS slope is unsound until an errors-in-variables fit lands (parallel color audit). Gate stays a color-fidelity PASS/FAIL only.',
            provenance: {
                source: 'SPCC_RGB',
                metric: 'catBpRp = slope*instColor + intercept, 2.5σ-clipped robust LS (engine); + TLS/EIV bracket + unclipped stats added here',
                truth: 'Gaia BP-RP',
                caveats: [
                    'N=1 distinct frame (SeeStar M66 FITS); RESEARCH, not a trusted science product',
                    'OLS regresses precise catalog color on NOISY instrumental color -> slope attenuated toward 0 (see slope_tls_eiv for bias-corrected)',
                    'headline r2/rmse are on 2.5σ-clipped survivors -> OPTIMISTIC; see r2_unclipped/rmse_mag_unclipped',
                ],
            },
        },
    };
}

// ─── receipt discovery ───────────────────────────────────────────────────────
function discoverReceipts() {
    const found = [];
    const tr = path.join(ROOT, 'test_results');
    const candidates = [
        path.join(tr, 'deep_cones', 'm66.receipt.json'),
        path.join(tr, 'deep_cones', 'cr2.receipt.json'),
    ];
    // one representative e2e seestar receipt (they are regenerations of the same frame;
    // include ALL of them but tag as duplicates downstream)
    const e2eDir = path.join(tr, 'e2e');
    if (fs.existsSync(e2eDir)) {
        for (const d of fs.readdirSync(e2eDir)) {
            const rp = path.join(e2eDir, d, 'receipt.json');
            if (d.startsWith('seestar_') && fs.existsSync(rp)) candidates.push(rp);
        }
    }
    const apiDir = path.join(tr, 'api_runs');
    if (fs.existsSync(apiDir)) {
        for (const f of fs.readdirSync(apiDir)) if (f.endsWith('.receipt.json')) candidates.push(path.join(apiDir, f));
    }
    for (const c of candidates) if (fs.existsSync(c) && !found.includes(c)) found.push(c);
    return found;
}

// ─── main ─────────────────────────────────────────────────────────────────────
function main() {
    const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
    const receipts = args.length ? args.map(a => path.resolve(a)) : discoverReceipts();

    const results = receipts.map(evaluateReceipt);
    const evaluated = results.filter(r => r.status === 'EVALUATED');

    // dedupe DISTINCT frames by fit signature (same M66 frame regenerated many times)
    const sig = (r) => `${r.recomputed_fit_ols?.n_used}|${r.recomputed_fit_ols?.r2?.toFixed(9)}|${r.recomputed_fit_ols?.rmse_mag?.toFixed(9)}`;
    const distinct = new Map();
    for (const r of evaluated) if (!distinct.has(sig(r))) distinct.set(sig(r), r);

    const summary = {
        generated: new Date().toISOString(),
        note: 'REPORT-ONLY prototype (Tier-2 §4.1). validated=null everywhere; the bar is PROPOSED, never enforced.',
        n_receipts_scanned: receipts.length,
        n_evaluated: evaluated.length,
        n_distinct_frames: distinct.size,
        distinct_frame_fits: [...distinct.values()].map(r => ({
            example_file: r.file,
            r2_ols: r.recomputed_fit_ols.r2,
            rmse_mag_ols: r.recomputed_fit_ols.rmse_mag,
            r2_unclipped: r.unclipped_fit.r2,
            rmse_mag_unclipped: r.unclipped_fit.rmse_mag,
            n_used: r.recomputed_fit_ols.n_used,
            slope_ols: r.recomputed_fit_ols.slope,
            slope_tls_eiv: r.slope_bracket_eiv?.tls ?? null,
            outlier_frac_gt3rmse: r.residual_stats_mag.outlier_frac_gt3rmse,
            reproduces_engine: r.engine_crosscheck?.reproduces_engine ?? null,
        })),
        per_receipt: results,
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, 'star_color_fidelity.json');
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

    // console digest
    console.log('=== STAR-COLOR FIDELITY (report-only) ===');
    console.log(`scanned ${receipts.length} receipts | evaluated ${evaluated.length} | DISTINCT frames ${distinct.size}`);
    for (const r of distinct.values()) {
        const c = r.engine_crosscheck, b = r.slope_bracket_eiv, u = r.unclipped_fit;
        console.log(`  ${r.file}`);
        console.log(`    OLS  r2=${r.recomputed_fit_ols.r2.toFixed(5)} rmse=${r.recomputed_fit_ols.rmse_mag.toFixed(5)} mag n_used=${r.recomputed_fit_ols.n_used}/${r.n_samples} slope=${r.recomputed_fit_ols.slope.toFixed(4)}`);
        console.log(`    UNCLIP r2=${u.r2.toFixed(5)} rmse=${u.rmse_mag.toFixed(5)} mag (honest full-set)   slope_TLS=${b ? b.tls.toFixed(4) : 'NA'} (bias-corr, x${b ? b.attenuation_ratio_tls_over_ols.toFixed(3) : 'NA'})`);
        console.log(`    outliers >3·rmse=${(r.residual_stats_mag.outlier_frac_gt3rmse * 100).toFixed(1)}%  reproduces_engine_fit=${c?.reproduces_engine}`);
        console.log(`    proposed_verdict.would_pass_illustrative=${r.proposed_verdict.would_pass_illustrative} (bar r2>=${r.proposed_verdict.proposed_bar_illustrative.r2_min}, rmse<=${r.proposed_verdict.proposed_bar_illustrative.rmse_max_mag}, n>=${r.proposed_verdict.proposed_bar_illustrative.n_stars_min})`);
    }
    console.log(`\nwrote ${path.relative(ROOT, outPath)}`);
}

main();
