// tools/trails/trail_test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// FROZEN, PRE-REGISTERED test for the deterministic trail tagger (trail_tag.mjs).
// Per proposal §(d) (trails_proposal_speculative.md). Gates were fixed BEFORE
// this ran; thresholds are NOT tuned to pass — a KILL is a valid outcome.
//
//   (i)  INJECTION (detection-list level): parameterised synthetic streaks into
//        COPIES of real solved frames' detection lists. Deterministic grid,
//        NO RNG beyond the tagger's fixed RANSAC seed.
//   (ii) GATE 1 (rejection): >=90% injected members tagged for SNR>=8 dashed;
//        >=80% for faint-continuous. KILL below 50% / 40%.
//   (iii)GATE 2 (zero-loss / byte-identity proxy): tagger on the UNMODIFIED
//        sacred lists must tag NONE of SeeStar's 272 / CR2's 55 matched stars.
//        Any hit = FAIL (even at 100% rejection).
//   (iv) ADVERSARIAL VERIFY PROBE: forced_confirm C2 shapeConsistency
//        (forced_confirm.ts:202-234) REPLICATED (src/ read-only, browser-bound
//        pixel path) with EXACT thresholds — measures the engine's hole.
//
// Emits: test_results/overnight_run_2026-07-10/trail_test_results.json
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagTrails, DEFAULTS, RANSAC_SEED } from './trail_tag.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = path.join(ROOT, 'test_results', 'overnight_run_2026-07-10', 'trail_test_results.json');

// ── FROZEN tagger config for the whole test (single config for zero-loss AND
// rejection — spec-faithful solver_entry shape values; NOT tuned to pass).
const CFG = Object.freeze({
    ...DEFAULTS,
    ransacIters: 50000,   // reduced from 150k for test runtime; injected trails are
    topKExhaustive: 100,  // bright/dense → still reliably found. Determinism intact.
    maxTrails: 50,        // large cap so the injected trail is never crowded out.
});

// ── FROZEN injection grid ────────────────────────────────────────────────────
const L_FRACS = [0.2, 0.5, 1.0];      // × diag
const ANGLES_DEG = [15, 60, 120];
const SNRS = [5, 8, 15];
const DASH_PERIODS = [40, 80, 120];   // px (dashed only), spec "period 40-120px"
const ELL_CONT = 0.82;                // continuous fragment ellipticity (spec 0.75-0.9)
const ELL_DASH = 0.05;                // round dash

// ── frames ───────────────────────────────────────────────────────────────────
function loadReceiptFrame(tag, relPath, w, h) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
    const clean = d.signal.clean_stars;
    const matched = d.solution.matched_stars;
    return { tag, width: w, height: h, clean, matched, hasMatched: true };
}
function loadDumpFrame(tag, relPath) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
    const clean = (d.detections || []).map(s => ({ ...s }));
    const w = d.width, h = d.height;
    return { tag, width: w, height: h, clean, matched: null, hasMatched: false, note: 'app.json dump: only {x,y,flux,fwhm} — no shape fields (S1 disabled for real dets); no matched_stars (zero-loss NOT_MEASURED)' };
}

function fluxStats(clean) {
    const f = clean.map(s => s.flux || 0).filter(v => v > 0).sort((a, b) => a - b);
    if (!f.length) return { median: 1, p95: 1 };
    const q = p => f[Math.min(f.length - 1, Math.floor(p * f.length))];
    return { median: q(0.5), p95: q(0.95) };
}
function medFwhm(clean) {
    const f = clean.map(s => s.moment_fwhm_px || s.fwhm || 0).filter(v => v > 0).sort((a, b) => a - b);
    return f.length ? f[Math.floor(f.length / 2)] : 4;
}

// Build one injected streak; returns { points, m } (deterministic, no RNG).
function buildStreak(frame, { Lfrac, angleDeg, snr, type, period }, fx, fwhm) {
    const diag = Math.hypot(frame.width, frame.height);
    const L = Lfrac * diag;
    const a = angleDeg * Math.PI / 180;
    const ux = Math.cos(a), uy = Math.sin(a);
    const cx = frame.width / 2, cy = frame.height / 2;
    const spacing = type === 'continuous' ? Math.max(2, fwhm) : period;
    const nRaw = Math.floor(L / spacing) + 1;
    const points = [];
    for (let i = 0; i < nRaw; i++) {
        const t = -L / 2 + i * spacing;
        const x = cx + t * ux, y = cy + t * uy;
        if (x < 0 || x > frame.width || y < 0 || y > frame.height) continue; // clip to frame
        if (type === 'continuous') {
            points.push({
                x, y, flux: fx.median * (snr / 8), fwhm, snr,
                ellipticity: ELL_CONT, moment_ellipticity: ELL_CONT, circularity: 1 - ELL_CONT,
                theta: a, __injected: true,
            });
        } else {
            points.push({
                x, y, flux: fx.p95 * (snr / 8), fwhm, snr,
                ellipticity: ELL_DASH, moment_ellipticity: ELL_DASH, circularity: 1 - ELL_DASH,
                theta: 0, __injected: true,
            });
        }
    }
    return { points, m: points.length };
}

function classify(c) {
    if (c.type === 'dashed' && c.snr >= 8) return 'dashed_snr8plus';   // GATE 1a (>=90%, KILL<50)
    if (c.type === 'continuous' && c.snr === 5) return 'faint_continuous'; // GATE 1b (>=80%, KILL<40)
    if (c.type === 'dashed') return 'dashed_faint';
    return 'continuous_bright';
}

// ── (i)+(ii) run injection + zero-loss for one frame ─────────────────────────
function runFrame(frame) {
    const fx = fluxStats(frame.clean);
    const fwhm = medFwhm(frame.clean);
    const cases = [];
    // GATE 2 (zero-loss) FIRST on the unmodified list.
    let zeroLoss = { measured: frame.hasMatched, n_matched: frame.matched ? frame.matched.length : null };
    {
        const r = tagTrails(frame.clean, { width: frame.width, height: frame.height }, CFG);
        const tagged = new Set(); r.trails.forEach(tr => tr.member_indices.forEach(k => tagged.add(k)));
        zeroLoss.n_trails_on_clean = r.trails.length;
        zeroLoss.n_tagged_members = tagged.size;
        if (frame.hasMatched) {
            const key = (x, y) => x.toFixed(4) + ',' + y.toFixed(4);
            const mk = new Set(frame.matched.map(s => key(s.x, s.y)));
            const hits = [];
            for (const k of tagged) { const s = frame.clean[k]; if (mk.has(key(s.x, s.y))) hits.push({ idx: k, x: +s.x.toFixed(1), y: +s.y.toFixed(1), flux: +(s.flux || 0).toFixed(2) }); }
            zeroLoss.matched_star_hits = hits.length;
            zeroLoss.hits = hits;
            zeroLoss.verdict = hits.length === 0 ? 'PASS' : 'FAIL';
        } else {
            zeroLoss.verdict = 'NOT_MEASURED';
        }
    }
    // (i) injection grid
    const build = [];
    for (const Lfrac of L_FRACS) for (const angleDeg of ANGLES_DEG) for (const snr of SNRS) {
        build.push({ Lfrac, angleDeg, snr, type: 'continuous', period: null });
        for (const period of DASH_PERIODS) build.push({ Lfrac, angleDeg, snr, type: 'dashed', period });
    }
    for (const c of build) {
        const { points, m } = buildStreak(frame, c, fx, fwhm);
        if (m < CFG.minInliers) { cases.push({ ...c, m, injected_tagged: null, frac: null, skipped: 'too_few_points_after_clip' }); continue; }
        const n0 = frame.clean.length;
        const merged = frame.clean.concat(points);
        const r = tagTrails(merged, { width: frame.width, height: frame.height }, CFG);
        const tagged = new Set(); r.trails.forEach(tr => tr.member_indices.forEach(k => tagged.add(k)));
        let injTagged = 0; for (let k = n0; k < n0 + m; k++) if (tagged.has(k)) injTagged++;
        // collateral: real (non-injected) dets tagged, and matched-star hits during injection
        let realTagged = 0, matchedDuringInj = 0;
        let mkc = null;
        if (frame.hasMatched) { const key = (x, y) => x.toFixed(4) + ',' + y.toFixed(4); mkc = new Set(frame.matched.map(s => key(s.x, s.y))); }
        for (const k of tagged) {
            if (k >= n0) continue; realTagged++;
            if (mkc) { const s = frame.clean[k]; if (mkc.has(s.x.toFixed(4) + ',' + s.y.toFixed(4))) matchedDuringInj++; }
        }
        cases.push({ ...c, class: classify(c), m, injected_tagged: injTagged, frac: +(injTagged / m).toFixed(4), real_tagged: realTagged, matched_star_tagged_during_inj: matchedDuringInj });
    }
    return { tag: frame.tag, width: frame.width, height: frame.height, n_clean: frame.clean.length, med_fwhm: +fwhm.toFixed(2), flux_median: +fx.median.toFixed(3), flux_p95: +fx.p95.toFixed(3), note: frame.note || null, zero_loss: zeroLoss, cases };
}

// ── (iv) ADVERSARIAL VERIFY PROBE — REPLICATED-LOGIC of forced_confirm C2 ─────
// shapeConsistency, forced_confirm.ts:202-234, defaults :120-123. NOT the live
// path (that path measures momentFwhm/ellipticity/sharpness from PIXELS, which
// are browser-bound). Here shape stats are SUPPLIED for the synthetic point;
// the DECISION FUNCTION + thresholds are copied exactly.
const C2 = Object.freeze({ shapeMinSnr: 5, shapeFwhmTolFrac: 0.6, shapeEllipticityMax: 0.7, shapeSharpnessMax: 1.1 });
function c2Replicated(m, fp) {
    if (fp.fwhmPx == null || fp.source === 'NOT_MEASURED') return 'NOT_MEASURED'; // :204
    if (fp.undersampled) return 'NOT_MEASURED';                                   // :205
    if (m.snr < C2.shapeMinSnr) return 'NOT_MEASURED';                            // :206
    if (m.momentFwhmPx == null) return 'NOT_MEASURED';                            // :225
    const tol = C2.shapeFwhmTolFrac * fp.fwhmPx;                                  // :227
    const fwhmOk = Math.abs(m.momentFwhmPx - fp.fwhmPx) <= tol;                   // :228
    const ellOk = m.momentEllipticity == null || m.momentEllipticity <= C2.shapeEllipticityMax; // :229-230
    const sharpOk = m.sharpness == null || m.sharpness <= C2.shapeSharpnessMax;   // :231-232
    return (fwhmOk && ellOk && sharpOk) ? 'PASS' : 'FAIL';                        // :233
}
function verifyProbe() {
    const wellSampled = { fwhmPx: 4.0, source: 'MEASURED', undersampled: false };
    const undersampled = { fwhmPx: 1.4, source: 'MEASURED', undersampled: true };
    const scenarios = [
        { name: 'A_elongated_fragment_wellsampled_snr8', fp: wellSampled, m: { snr: 8, momentFwhmPx: 4.5, momentEllipticity: 0.82, sharpness: 0.2 }, expect: 'FAIL (elongation caught)' },
        { name: 'B_round_dash_undersampled_snr8', fp: undersampled, m: { snr: 8, momentFwhmPx: 1.5, momentEllipticity: 0.05, sharpness: 0.3 }, expect: 'NOT_MEASURED (undersampled hole)' },
        { name: 'C_round_dash_wellsampled_snr8', fp: wellSampled, m: { snr: 8, momentFwhmPx: 4.0, momentEllipticity: 0.05, sharpness: 0.3 }, expect: 'PASS (round dash slips through shape test)' },
        { name: 'D_round_dash_wellsampled_snr4', fp: wellSampled, m: { snr: 4, momentFwhmPx: 4.0, momentEllipticity: 0.05, sharpness: 0.3 }, expect: 'NOT_MEASURED (SNR<5 floor)' },
        { name: 'E_elongated_fragment_undersampled_snr8', fp: undersampled, m: { snr: 8, momentFwhmPx: 1.5, momentEllipticity: 0.82, sharpness: 0.4 }, expect: 'NOT_MEASURED (undersampled abstains even for elongated)' },
    ];
    return scenarios.map(s => ({ ...s, verdict: c2Replicated(s.m, s.fp) }));
}

// ── aggregation + gate evaluation ────────────────────────────────────────────
function aggregate(frameResults) {
    const byClass = {};
    for (const fr of frameResults) {
        for (const c of fr.cases) {
            if (c.frac == null) continue;
            const cls = c.class;
            (byClass[cls] ||= []).push(c.frac);
        }
    }
    const summ = {};
    for (const [k, arr] of Object.entries(byClass)) {
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        summ[k] = { n_cases: arr.length, mean_frac: +mean.toFixed(4), min_frac: +Math.min(...arr).toFixed(4), max_frac: +Math.max(...arr).toFixed(4) };
    }
    return summ;
}

function main() {
    const t0 = Date.now();
    const frames = [];
    frames.push(loadReceiptFrame('SeeStar_M66', 'test_results/deep_cones/m66.receipt.json', 2160, 3840));
    frames.push(loadReceiptFrame('bundled_CR2', 'test_results/deep_cones/cr2.receipt.json', 5202, 3464));
    const img1757 = path.join(ROOT, 'test_results/cr2_dets/IMG_1757.app.json');
    if (fs.existsSync(img1757)) frames.push(loadDumpFrame('IMG_1757', 'test_results/cr2_dets/IMG_1757.app.json'));

    const frameResults = frames.map(f => { const r = runFrame(f); console.error(`[trail_test] ${f.tag}: zero_loss=${r.zero_loss.verdict} (hits=${r.zero_loss.matched_star_hits ?? 'n/a'}), ${r.cases.length} injection cases`); return r; });
    const classSumm = aggregate(frameResults);
    const probe = verifyProbe();

    // GATE evaluation
    const g1a = classSumm.dashed_snr8plus;   // >=90%, KILL<50%
    const g1b = classSumm.faint_continuous;  // >=80%, KILL<40%
    const gate1a = { class: 'dashed_snr8plus', target: '>=0.90', kill: '<0.50', mean_frac: g1a?.mean_frac, min_frac: g1a?.min_frac, verdict: g1a == null ? 'NOT_MEASURED' : (g1a.mean_frac < 0.50 ? 'KILL' : (g1a.mean_frac >= 0.90 ? 'PASS' : 'BELOW_TARGET')) };
    const gate1b = { class: 'faint_continuous', target: '>=0.80', kill: '<0.40', mean_frac: g1b?.mean_frac, min_frac: g1b?.min_frac, verdict: g1b == null ? 'NOT_MEASURED' : (g1b.mean_frac < 0.40 ? 'KILL' : (g1b.mean_frac >= 0.80 ? 'PASS' : 'BELOW_TARGET')) };
    const zl = frameResults.filter(f => f.zero_loss.measured);
    const zlFail = zl.some(f => f.zero_loss.verdict === 'FAIL');
    const gate2 = {
        target: 'ZERO matched-star tags on unmodified sacred lists',
        per_frame: zl.map(f => ({ tag: f.tag, matched: f.zero_loss.n_matched, hits: f.zero_loss.matched_star_hits, verdict: f.zero_loss.verdict })),
        verdict: zlFail ? 'FAIL' : 'PASS',
    };

    // Overall verdict: GATE 2 FAIL => KILL (any hit kills even at 100% rejection).
    let overall;
    if (gate2.verdict === 'FAIL') overall = 'KILL';
    else if (gate1a.verdict === 'KILL' || gate1b.verdict === 'KILL') overall = 'KILL';
    else if (gate1a.verdict === 'PASS' && gate1b.verdict === 'PASS') overall = 'PASS';
    else overall = 'FAIL';

    const out = {
        meta: {
            generated: new Date().toISOString(),
            proposal: 'test_results/overnight_run_2026-07-10/trails_proposal_speculative.md',
            tagger: 'tools/trails/trail_tag.mjs', ransac_seed: RANSAC_SEED,
            config: CFG,
            frozen_grid: { L_fracs: L_FRACS, angles_deg: ANGLES_DEG, snrs: SNRS, dash_periods: DASH_PERIODS, ell_continuous: ELL_CONT, ell_dash: ELL_DASH },
            frames: frameResults.map(f => ({ tag: f.tag, n_clean: f.n_clean, w: f.width, h: f.height, med_fwhm: f.med_fwhm, has_matched: !!f.zero_loss.measured, note: f.note })),
            runtime_s: +((Date.now() - t0) / 1000).toFixed(1),
        },
        gate1_rejection: { by_class: classSumm, gate1a_dashed_snr8plus: gate1a, gate1b_faint_continuous: gate1b },
        gate2_zero_loss: gate2,
        verify_probe: { label: 'REPLICATED-LOGIC (forced_confirm.ts:202-234, NOT live path)', thresholds: C2, scenarios: probe },
        frame_detail: frameResults,
        VERDICT: overall,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    // concise console summary
    console.log('\n=== TRAIL TAGGER FROZEN TEST ===');
    console.log('GATE 1a dashed_snr8plus:', JSON.stringify(gate1a));
    console.log('GATE 1b faint_continuous:', JSON.stringify(gate1b));
    console.log('GATE 2 zero_loss:', JSON.stringify(gate2.per_frame), '->', gate2.verdict);
    console.log('VERIFY PROBE (C2 replicated):');
    for (const s of probe) console.log('  ', s.name, '->', s.verdict, '| expected:', s.expect);
    console.log('OVERALL VERDICT:', overall);
    console.log('wrote', OUT, `(${out.meta.runtime_s}s)`);
}

main();
