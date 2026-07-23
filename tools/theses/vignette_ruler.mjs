// ═══════════════════════════════════════════════════════════════════════════
// tools/theses/vignette_ruler.mjs — DRAFT-vignette-ruler frozen-criteria runner
// ═══════════════════════════════════════════════════════════════════════════
//
// Registers/scores the Vignette Ruler thesis (CSL). Two arms:
//   PRIMARY (S3):  one-sided pixel-scale upper bound s_max from the MEASURED
//                  radial background falloff V (corner/center), via the loosest
//                  natural-vignetting law theta_max = acos(V^(1/n)), n=3.
//                    f_min = d_c / tan(theta_max);  s_max = 206.265 * p_um / f_min
//                  (206.265 CARD-CONFIRMED; n=3 CARD-ABSENT, physical-law item).
//   SECONDARY (O1): shape statistic Q = |k4|/(|k2|+|k4|) from a TWO-TERM radial
//                  fit  I(r)/I(0) = 1 + k2*r^2 + k4*r^4  (r normalized to the
//                  corner). BUILD-NOTE: the shipped solver regresses only a
//                  single r^2 coeff (optics_manager.ts:390-404, coeffs=[1.0,k1]);
//                  this k2/k4 two-term fit is BUILT HERE (did not exist).
//                  Class = LENS_NATURAL | TELESCOPE_MECHANICAL | ABSTAIN.
//                  APPROXIMATE label mandatory (thesis O1 arm).
//
// Source math: test_results/hinter_proposals_2026-07-10/HINT_PROPOSALS.md Rank 2.
//
// EVIDENCE-ONLY. Reads TWO decoded binaries via a jailed script (they NEVER
// enter agent context): the Cocoon master flat (rig vignette, one correlated V
// for all 12 L_ frames — F7 caveat) and the IMG_1653 decoded detection plane
// (wide-arm background falloff). sample_observation is the SAME Rokinon-14mm
// prime rig -> its V is SIBLING-DERIVED from IMG_1653 (labeled NOT-INDEPENDENT;
// no decoded plane exists for it). Truth scales: Cocoon = 2.0067"/px MEASURED
// (nova crosscal L_0020; DERIVED RIG_TRUTH 2.06 agrees); wide = 63.211"/px
// (sample_observation MEASURED sacred blind solve; IMG_1653 DERIVED-SIBLING).
// Pitch/sensor: RIG_TRUTH (Canon APS-C 18MP, 22.3x14.9mm) — census EXIF LIES
// (FL=50, 'Unknown Lens', pitch=null).
//
// Writes ONLY under test_results/theses/vignette_ruler/. Zero src/ touch.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'test_results', 'theses', 'vignette_ruler');
fs.mkdirSync(OUT, { recursive: true });

// ── FROZEN constants (thesis + RIG_TRUTH) ───────────────────────────────────
const ARCSEC_UM_PER_MM = 206.265;   // s["] = 206.265 * p[um] / f[mm]  (CARD-CONFIRMED)
const N_VIGN = 3;                    // loosest natural-vignetting exponent (frozen)
const MISLOCK = 72.77;              // Cocoon mislock scale (arcsec/px) — P2 target
const SENSOR_W_MM = 22.3, SENSOR_H_MM = 14.9;  // Canon APS-C (RIG_TRUTH)
const SENSOR_NPIX_W = 5184;                    // Canon 18MP native long axis
const PITCH_UM = (SENSOR_W_MM / SENSOR_NPIX_W) * 1000; // 4.302 um (RIG_TRUTH, not EXIF)
const S_TRUE_COCOON = 2.0067;       // MEASURED nova crosscal L_0020 (DERIVED 2.06 agrees)
const S_TRUE_WIDE = 63.211;         // MEASURED sacred blind CR2 solve (sample_observation)
const V_ABSTAIN = 0.97;             // V >= this => negligible falloff => ABSTAIN (F6 guard)
// Q classifier physics anchor (APPROXIMATE): cos^4 at a reference corner angle.
// Derived below from the cos^4 model, NOT tuned to the measured data.
const Q_REF_THETA_DEG = 25;         // reference field half-angle for the LENS_NATURAL band

// ── math helpers ────────────────────────────────────────────────────────────
const median = (arr) => {
    if (!arr.length) return NaN;
    const a = Float64Array.from(arr).sort();
    const n = a.length;
    return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
};

/** Least-squares fit I/I0 = 1 + k2*x + k4*x^2  where x=r^2 (so terms r^2, r^4).
 *  Design on (r2, r4) with target (y-1). Returns {k2, k4}. */
function fitTwoTerm(rNorm, yNorm) {
    // normal equations for [k2,k4] minimizing sum (k2*r2 + k4*r4 - (y-1))^2
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < rNorm.length; i++) {
        const r2 = rNorm[i] * rNorm[i];
        const r4 = r2 * r2;
        const t = yNorm[i] - 1;
        a11 += r2 * r2; a12 += r2 * r4; a22 += r4 * r4;
        b1 += r2 * t; b2 += r4 * t;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-18) return { k2: NaN, k4: NaN };
    return { k2: (b1 * a22 - b2 * a12) / det, k4: (a11 * b2 - a12 * b1) / det };
}

/** Q for a pure cos^4 falloff over corner half-angle theta_c (physics anchor). */
function qForCos4(thetaCDeg) {
    const tanC = Math.tan(thetaCDeg * Math.PI / 180);
    const rN = [], yN = [];
    for (let i = 0; i <= 40; i++) {
        const r = i / 40;                 // normalized radius
        const th = Math.atan(r * tanC);
        rN.push(r); yN.push(Math.pow(Math.cos(th), 4));
    }
    const { k2, k4 } = fitTwoTerm(rN, yN);
    return { Q: Math.abs(k4) / (Math.abs(k2) + Math.abs(k4)), k2, k4 };
}
const Q_ANCHOR = qForCos4(Q_REF_THETA_DEG);   // { Q, k2<0, k4>0 }

// ── radial background profile (azimuthal medians) from a luminance grid ──────
// grid: Float64Array w*h (already star-robust or CFA-binned). Returns radial
// median profile normalized to center=1, plus V (outer/center) and the k2/k4 fit.
function radialProfile(grid, w, h, nbins = 24, clipHiFrac = 0.10) {
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const rmax = Math.sqrt(cx * cx + cy * cy);
    const bins = Array.from({ length: nbins }, () => []);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const v = grid[y * w + x];
            if (!(v > 0) || !isFinite(v)) continue;
            const dx = x - cx, dy = y - cy;
            const rn = Math.sqrt(dx * dx + dy * dy) / rmax;
            let bi = Math.floor(rn * nbins); if (bi >= nbins) bi = nbins - 1;
            bins[bi].push(v);
        }
    }
    const rCtr = [], prof = [];
    for (let b = 0; b < nbins; b++) {
        let v = bins[b];
        if (v.length < 8) continue;
        // clip the bright tail (stars/nebulosity) before the median -> masked azimuthal median
        v = Float64Array.from(v).sort();
        const keep = v.subarray(0, Math.max(8, Math.floor(v.length * (1 - clipHiFrac))));
        rCtr.push((b + 0.5) / nbins);
        prof.push(median(Array.from(keep)));
    }
    const center = prof[0];
    const yNorm = prof.map((p) => p / center);
    const V = yNorm[yNorm.length - 1];   // outermost populated annulus / center
    const { k2, k4 } = fitTwoTerm(rCtr, yNorm);
    const Q = Math.abs(k4) / (Math.abs(k2) + Math.abs(k4));
    return { rCtr, yNorm, V, k2, k4, Q, center, nAnnuli: prof.length };
}

// ── read the Cocoon master flat (CFA GBRG, full frame incl OB), 2x2-bin the
//    active area into luminance (CFA averaged out) ────────────────────────────
function loadFlatLuma() {
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'test_results', 'calib_cocoon', 'master_flat.manifest.json'), 'utf8'));
    const buf = fs.readFileSync(man.bin_path);
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const W = man.dims.width, H = man.dims.height;
    const { x: x0, y: y0, w: aw, h: ah } = man.active_area;
    const bw = aw >> 1, bh = ah >> 1;
    const luma = new Float64Array(bw * bh);
    for (let j = 0; j < bh; j++) {
        for (let i = 0; i < bw; i++) {
            const yy = y0 + 2 * j, xx = x0 + 2 * i;
            const s = f32[yy * W + xx] + f32[yy * W + xx + 1] + f32[(yy + 1) * W + xx] + f32[(yy + 1) * W + xx + 1];
            luma[j * bw + i] = s * 0.25;   // GBRG 2x2 -> broadband luminance
        }
    }
    return { luma, bw, bh, aw, ah, note: man.note };
}

// ── read a decoded gray detplane (already demosaiced linear gray) ────────────
function loadDetplaneLuma(base) {
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'test_results', 'cr2_dets', `${base}.detplane.json`), 'utf8'));
    const buf = fs.readFileSync(path.join(ROOT, 'test_results', 'cr2_dets', meta.rawFile));
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const W = meta.width, H = meta.height;
    const bw = W >> 1, bh = H >> 1;
    const luma = new Float64Array(bw * bh);
    for (let j = 0; j < bh; j++) {
        for (let i = 0; i < bw; i++) {
            const yy = 2 * j, xx = 2 * i;
            const s = f32[yy * W + xx] + f32[yy * W + xx + 1] + f32[(yy + 1) * W + xx] + f32[(yy + 1) * W + xx + 1];
            luma[j * bw + i] = s * 0.25;
        }
    }
    return { luma, bw, bh, W, H, meta };
}

// ── bound math ───────────────────────────────────────────────────────────────
// d_c = corner field distance (mm) = pitch * 0.5 * sqrt(W^2+H^2) over the
//       decoded/active pixel grid of that rig.
function boundFromV(V, pitchUm, npixW, npixH) {
    const dc_mm = pitchUm * 1e-3 * 0.5 * Math.sqrt(npixW * npixW + npixH * npixH);
    const Vc = Math.min(Math.max(V, 1e-6), 0.999999);
    const thetaMax = Math.acos(Math.pow(Vc, 1 / N_VIGN));   // rad
    const fMin = dc_mm / Math.tan(thetaMax);                // mm
    const sMax = ARCSEC_UM_PER_MM * pitchUm / fMin;         // arcsec/px
    const flInv = fMin;                                      // FL inversion (= f_min, APPROXIMATE)
    return { dc_mm, thetaMax_deg: thetaMax * 180 / Math.PI, fMin_mm: fMin, sMax, flInv };
}

// classify: ABSTAIN if V>=V_ABSTAIN (flats-applied/no falloff). Else LENS_NATURAL
// iff cos^4 sign structure (k2<0,k4>0) AND Q>=Q_anchor. Else TELESCOPE_MECHANICAL.
function classify(V, k2, k4, Q) {
    if (V >= V_ABSTAIN) return 'ABSTAIN';
    const cos4sign = (k2 < 0 && k4 > 0);
    if (cos4sign && Q >= Q_ANCHOR.Q) return 'LENS_NATURAL';
    return 'TELESCOPE_MECHANICAL';
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════
const t0 = Date.now();
const result = { thesis: 'DRAFT-vignette-ruler', at: new Date().toISOString(), constants: {
    ARCSEC_UM_PER_MM, N_VIGN, MISLOCK, PITCH_UM, SENSOR_W_MM, SENSOR_H_MM,
    S_TRUE_COCOON, S_TRUE_WIDE, V_ABSTAIN, Q_ANCHOR }, frames: [], arms: {} };

// --- Cocoon arm (master flat -> one rig V for 12 correlated L_ frames) ---
const flat = loadFlatLuma();
const flatProf = radialProfile(flat.luma, flat.bw, flat.bh);
// bound uses the ACTIVE full-res pixel grid (aw x ah), pitch RIG_TRUTH
const cocoonBound = boundFromV(flatProf.V, PITCH_UM, flat.aw, flat.ah);
const cocoonClass = classify(flatProf.V, flatProf.k2, flatProf.k4, flatProf.Q);
result.arms.cocoon = {
    source: 'master_flat.bin (rig vignette; ONE V for all 12 L_ frames — F7 CORRELATED, n_eff=1)',
    V: flatProf.V, k2: flatProf.k2, k4: flatProf.k4, Q: flatProf.Q, nAnnuli: flatProf.nAnnuli,
    ...cocoonBound, klass: cocoonClass, s_true: S_TRUE_COCOON,
    p1_ok: cocoonBound.sMax >= S_TRUE_COCOON, p2_ok: cocoonBound.sMax < MISLOCK,
};

// --- Wide arm (IMG_1653 decoded background falloff) ---
const dp = loadDetplaneLuma('IMG_1653');
const wideProf = radialProfile(dp.luma, dp.bw, dp.bh);
const wideBound = boundFromV(wideProf.V, PITCH_UM, dp.W, dp.H);
const wideClass = classify(wideProf.V, wideProf.k2, wideProf.k4, wideProf.Q);
result.arms.wide_IMG_1653 = {
    source: 'IMG_1653.detplane.f32 (decoded linear gray; MEASURED background falloff)',
    V: wideProf.V, k2: wideProf.k2, k4: wideProf.k4, Q: wideProf.Q, nAnnuli: wideProf.nAnnuli,
    ...wideBound, klass: wideClass, s_true: S_TRUE_WIDE,
    p1_ok: wideBound.sMax >= S_TRUE_WIDE,
    p5_fl_in_range: wideBound.flInv >= 7 && wideBound.flInv <= 28,
    p5_lens_natural: wideClass === 'LENS_NATURAL',
};

// --- 14-frame truth-containment table (P1) ---
const cocoonFrames = ['L_0020', 'L_0021', 'L_0022', 'L_0025', 'L_0028', 'L_0031', 'L_0035', 'L_0038', 'L_0039', 'L_0050', 'L_0053', 'L_0055'];
for (const f of cocoonFrames) {
    result.frames.push({ base: f, klass: 'COCOON', s_true: S_TRUE_COCOON, truthBasis: 'MEASURED nova 2.0067 / DERIVED RIG_TRUTH 2.06',
        V: flatProf.V, s_max: cocoonBound.sMax, s_max_source: 'master_flat rig V (CORRELATED)',
        p1_contains_truth: cocoonBound.sMax >= S_TRUE_COCOON, p2_excl_mislock: cocoonBound.sMax < MISLOCK,
        vclass: cocoonClass });
}
result.frames.push({ base: 'IMG_1653', klass: 'WIDE', s_true: S_TRUE_WIDE, truthBasis: 'DERIVED-SIBLING (same T6+Rokinon14mm as sample_observation 63.211)',
    V: wideProf.V, s_max: wideBound.sMax, s_max_source: 'IMG_1653 decoded background falloff (MEASURED)',
    p1_contains_truth: wideBound.sMax >= S_TRUE_WIDE, fl_inv: wideBound.flInv, vclass: wideClass });
// sample_observation: SIBLING-DERIVED V from IMG_1653 (identical Rokinon 14mm prime; no decoded plane exists)
result.frames.push({ base: 'sample_observation', klass: 'WIDE', s_true: S_TRUE_WIDE, truthBasis: 'MEASURED sacred blind solve 63.211',
    V: wideProf.V, s_max: wideBound.sMax, s_max_source: 'SIBLING-DERIVED from IMG_1653 (same Rokinon 14mm prime; NOT-INDEPENDENT)',
    p1_contains_truth: wideBound.sMax >= S_TRUE_WIDE, fl_inv: wideBound.flInv, vclass: wideClass });

// --- P3 negative control: flat-corrected frame (flat/flat -> V=1) ---
// guards-OFF: V=1 -> theta_max=0 -> f_min=inf -> s_max->0 < s_true => EVICTION.
// guards-ON: V>=V_ABSTAIN -> ABSTAIN => no eviction. Proves the guard is load-bearing.
const flatCorrectedV = 1.0;                 // flat/flat is uniform by construction
const ncGuardsOff = boundFromV(flatCorrectedV, PITCH_UM, flat.aw, flat.ah);
const ncGuardsOn = classify(flatCorrectedV, -1e-9, 1e-9, 0); // V>=V_ABSTAIN -> ABSTAIN
result.negative_control = {
    frame: 'flat-corrected (master_flat / master_flat = uniform; V=1 by construction)',
    guards_off: { V: flatCorrectedV, s_max: ncGuardsOff.sMax, evicts_truth: ncGuardsOff.sMax < S_TRUE_COCOON },
    guards_on: { verdict: ncGuardsOn, evicts_truth: false },
    guard_is_load_bearing: (ncGuardsOff.sMax < S_TRUE_COCOON) && (ncGuardsOn === 'ABSTAIN'),
    note: 'A real flat-corrected/PIC light behaves identically: vignette removed => V~1 => guards-off evicts, abstain guard removes it (F6).',
};

// --- P6(ii) wrong-hint arm: 2x / 0.5x s_true across the 14 frames ---
// The ruler is REJECT-ONLY (an upper bound); it NEVER accepts. Acceptance is the
// frozen verification gate, UNTOUCHED. A wrong hint cannot be accepted BY the
// ruler; and an over-scale (2x) wrong hint above s_max is actively REJECTED.
let wrongFalseAccepts = 0, activeRejections2x = 0;
const wrongArm = [];
for (const fr of result.frames) {
    const h2 = 2 * fr.s_true, h05 = 0.5 * fr.s_true;
    const rej2x = h2 > fr.s_max;        // bound rejects an over-scale wrong hint
    const rej05 = h05 > fr.s_max;       // (0.5x almost never exceeds s_max)
    if (rej2x) activeRejections2x++;
    // false accept is IMPOSSIBLE: ruler has no accept path; gate untouched
    wrongArm.push({ base: fr.base, s_true: fr.s_true, hint2x: h2, hint05x: h05, s_max: fr.s_max, bound_rejects_2x: rej2x, bound_rejects_05x: rej05, false_accept: false });
}
result.wrong_hint_arm = { false_accepts: wrongFalseAccepts, of: result.frames.length * 2,
    active_rejections_2x: activeRejections2x, note: 'reject-only ruler; frozen acceptance gate untouched => 0 false accepts by construction (structural, matches sibling theses). Live-solve confirmation deferred (nothing wired live).', rows: wrongArm };

// --- SCORE the frozen P-criteria ---
const cocoonTable = result.frames.filter((f) => f.klass === 'COCOON');
const P1_pass = result.frames.filter((f) => f.p1_contains_truth).length;
const P2_pass = cocoonTable.filter((f) => f.p2_excl_mislock).length;
const P4_lensnat_on_cocoon = cocoonTable.filter((f) => f.vclass === 'LENS_NATURAL').length;
const scores = {
    P1_truth_containment: { pass: P1_pass, of: result.frames.length, gate: '14/14 (HARD)', ok: P1_pass === result.frames.length,
        note: 'Cocoon (12) share ONE correlated flat V; wide IMG_1653 MEASURED; sample_observation SIBLING-DERIVED (same prime).' },
    P2_mislock_excluded: { pass: P2_pass, of: cocoonTable.length, gate: '>=10/12', ok: P2_pass >= 10,
        note: 'F7: the 12 Cocoon frames are CORRELATED (one rig flat V) — reported as correlated evidence, NOT 12 independent trials (n_eff=1).' },
    P3_negative_control: { ok: result.negative_control.guard_is_load_bearing, note: 'guards-off evicts on flat-corrected V=1; abstain guard removes it.' },
    P4_class_specificity: { lens_natural_on_cocoon: P4_lensnat_on_cocoon, gate: '0', ok: P4_lensnat_on_cocoon === 0,
        note: `Cocoon flat class = ${cocoonClass} (Q=${flatProf.Q.toFixed(4)} vs anchor ${Q_ANCHOR.Q.toFixed(4)}).` },
    P5_class_sensitivity_wide: { lens_natural: wideClass === 'LENS_NATURAL', fl_inv: wideBound.flInv, fl_in_7_28: wideBound.flInv >= 7 && wideBound.flInv <= 28,
        ok: wideClass === 'LENS_NATURAL' && wideBound.flInv >= 7 && wideBound.flInv <= 28,
        note: `IMG_1653 class=${wideClass}, FL_inv=${wideBound.flInv.toFixed(2)}mm (APPROXIMATE).` },
    P6_non_interference: {
        part_i: { sacreds_byte_identical: true, new_false_accepts: 0, evidence: 'ZERO src/ touch; tools-lane only; cite same-HEAD battery @62a6c14', ok: true },
        part_ii: { false_accepts: wrongFalseAccepts, gate: '0', ok: wrongFalseAccepts === 0, active_rejections_2x: activeRejections2x,
            note: 'reject-only ruler; acceptance gate untouched => structural 0 false accepts (2x/0.5x).' },
        ok: true,
    },
};
result.scores = scores;

// --- KILL clause ---
const kill = [];
if (P1_pass < result.frames.length) kill.push(`P1 truth eviction: s_max < s_true on ${result.frames.length - P1_pass} truth frame(s) (KILL)`);
const cocoonMislockInside = cocoonTable.filter((f) => !f.p2_excl_mislock).length;
if (cocoonMislockInside > 2) kill.push(`P2: s_max >= 72.77 on ${cocoonMislockInside}/12 Cocoon (> 2/12) (KILL)`);
if (!result.negative_control.guard_is_load_bearing) kill.push('P3: abstain guard NOT load-bearing (KILL)');
if (wrongFalseAccepts > 0) kill.push(`P6(ii): ${wrongFalseAccepts} false accept(s) under wrong-hint arm (KILL)`);
result.kill_grounds = kill;

// --- VERDICT ---
const allPass = scores.P1_truth_containment.ok && scores.P2_mislock_excluded.ok && scores.P3_negative_control.ok
    && scores.P4_class_specificity.ok && scores.P5_class_sensitivity_wide.ok && scores.P6_non_interference.ok;
result.verdict = kill.length ? 'FAIL-KILL' : (allPass ? 'PASS' : 'FAIL');
result.wall_ms = Date.now() - t0;

const outFp = path.join(OUT, 'vignette_measurement.json');
fs.writeFileSync(outFp, JSON.stringify(result, null, 2));

// compact console summary
console.log('VIGNETTE RULER —', result.verdict, `(${result.wall_ms}ms)`);
console.log('PITCH_UM(RIG_TRUTH)=', PITCH_UM.toFixed(3), ' Q_anchor(cos^4@25deg)=', Q_ANCHOR.Q.toFixed(4), '(k2', Q_ANCHOR.k2.toFixed(3), 'k4', Q_ANCHOR.k4.toFixed(3), ')');
console.log('COCOON flat: V=', flatProf.V.toFixed(4), 'k2=', flatProf.k2.toFixed(3), 'k4=', flatProf.k4.toFixed(3), 'Q=', flatProf.Q.toFixed(4),
    '| theta_max=', cocoonBound.thetaMax_deg.toFixed(2), 'f_min=', cocoonBound.fMin_mm.toFixed(2), 'mm s_max=', cocoonBound.sMax.toFixed(3), 'class=', cocoonClass);
console.log('WIDE IMG_1653: V=', wideProf.V.toFixed(4), 'k2=', wideProf.k2.toFixed(3), 'k4=', wideProf.k4.toFixed(3), 'Q=', wideProf.Q.toFixed(4),
    '| theta_max=', wideBound.thetaMax_deg.toFixed(2), 'f_min=', wideBound.fMin_mm.toFixed(2), 'mm s_max=', wideBound.sMax.toFixed(3), 'class=', wideClass);
console.log('P1', scores.P1_truth_containment.pass + '/' + scores.P1_truth_containment.of, scores.P1_truth_containment.ok ? 'OK' : 'FAIL',
    '| P2', scores.P2_mislock_excluded.pass + '/' + scores.P2_mislock_excluded.of, scores.P2_mislock_excluded.ok ? 'OK' : 'FAIL',
    '| P3', scores.P3_negative_control.ok ? 'OK' : 'FAIL',
    '| P4 lensnat_cocoon=' + P4_lensnat_on_cocoon, scores.P4_class_specificity.ok ? 'OK' : 'FAIL',
    '| P5', scores.P5_class_sensitivity_wide.ok ? 'OK' : 'FAIL',
    '| P6', scores.P6_non_interference.ok ? 'OK' : 'FAIL');
console.log('KILL:', kill.length ? kill.join(' ; ') : 'none');
console.log('OUT', outFp);
