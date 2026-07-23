// ═══════════════════════════════════════════════════════════════════════════
// MESH RECALL — PURE VERDICT SCORER (THESIS-2026-07-11-mesh-recall-m4)
// ═══════════════════════════════════════════════════════════════════════════
// Applies the FROZEN P1–P10 pass criteria + kill_clause (registered thesis
// sha256 d759cf22…) to per-frame measurements emitted by the DAY-LANE harness
// (recall_mesh.adaptivespec.ts). ZERO engine deps → dry-importable + unit-
// testable with no wasm/box (author-tonight, run-day-lane split). It SCORES; it
// never tunes. Honest-or-absent: ABSTAIN / VOID / OUT-OF-DOMAIN are first-class.
//
// INPUT CONTRACT — the day-lane harness emits, per frame:
//   { frame, role:'positive'|'negative-control'|'supporting', decoderArm:'rawler'|'libraw',
//     // P1 preconditions + binding surface
//     expectedTruth, limitingMag:(number|null), matchRadiusPx, bindingFraction,
//     // P8 WCS residual precondition
//     wcsResidualPx:(number|null), nBrightForResidual,
//     // P10 gradient-domain membership
//     bgGradientSigma,
//     // recall/precision (mesh vs the RECALL-MAX global ceiling + untuned baseline)
//     baseline:{recall,precision}, globalBest:{recall,precision,fpRatio}, mesh:{recall,precision,fpRatio},
//     deltaR_mesh,               // mesh.recall − globalBest.recall (vs the CEILING, not baseline)
//     // P5 dark/bright split (from the mesh's own B surface)
//     deltaR_dark, deltaR_bright,
//     // P4 scrambled-truth null (ONE pinned RA/Dec-offset construction, ≥100 draws)
//     zScr, nScr,
//     // P7 rawler-arm CFA-parity cross-check (rawler frames only; else null)
//     cfaPersistence:(number|null), deltaR_libraw:(number|null),
//     // P9 pre-mask flat-surface identity control
//     flatIdentity:boolean }      // FLAT mesh reproduces global_baseline bit-for-bit
// plus a run-level: { seestarFlatDeltaR, bgGradFloor:2.0, calibratedConstantsMoved:boolean }
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// tie-averaged (fractional) ranks — correct Spearman with ties requires them.
function avgRank(vals) {
    const n = vals.length;
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    let i = 0;
    while (i < n) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
    return r;
}
// Spearman ρ = Pearson correlation of tie-averaged ranks (EXACT with ties, unlike
// the 1−6Σd²/n(n²−1) shortcut which is only valid tie-free).
function spearman(pairs) {
    const n = pairs.length; if (n < 3) return null;
    const rx = avgRank(pairs.map((p) => p[0])), ry = avgRank(pairs.map((p) => p[1]));
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const mx = mean(rx), my = mean(ry);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
    return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
}

// ── per-frame preconditions → in-domain / ABSTAIN / OUT-OF-DOMAIN / VOID ──────
function frameStatus(f, run) {
    // P9 VOID (instrument-invalid) takes precedence over everything
    if (f.flatIdentity === false) return { status: 'VOID', reason: 'P9 flat-surface identity control failed — pre-mask corrupts extractor input' };
    // P1 preconditions
    if (!(f.expectedTruth >= 30)) return { status: 'ABSTAIN', reason: `P1: expectedTruth ${f.expectedTruth} < 30` };
    if (f.limitingMag == null) return { status: 'ABSTAIN', reason: 'P1: limitingMag null' };
    if (f.matchRadiusPx !== 3) return { status: 'ABSTAIN', reason: `P1: matchRadiusPx ${f.matchRadiusPx} ≠ 3` };
    if (!(f.bindingFraction >= 0.5)) return { status: 'ABSTAIN', reason: `P1: T_local non-binding (fraction ${f.bindingFraction} < 0.5)` };
    // P8 WCS residual precondition
    if (f.wcsResidualPx == null || !(f.wcsResidualPx <= 1.0)) return { status: 'ABSTAIN', reason: `P8: bright-star WCS residual ${f.wcsResidualPx}px > 1.0 (edge truth unmatchable)` };
    // P10 gradient-domain membership (positive stratum only)
    if (f.role === 'positive') {
        const floor = run.bgGradFloor ?? 2.0;
        const flatX3 = 3 * (run.seestarBgGradientSigma ?? 0);
        if (!(f.bgGradientSigma >= floor && f.bgGradientSigma >= flatX3)) return { status: 'OUT-OF-DOMAIN', reason: `P10: bgGradientSigma ${f.bgGradientSigma} below floor ${floor} or <3× flat-control` };
    }
    return { status: 'IN-DOMAIN', reason: 'preconditions met' };
}

export function scoreMeshVerdict(run) {
    const frames = run.frames ?? [];
    const perFrame = frames.map((f) => ({ frame: f.frame, decoderArm: f.decoderArm, role: f.role, ...frameStatus(f, run), f }));

    // VOID short-circuit
    const voided = perFrame.find((p) => p.status === 'VOID');
    if (voided) return { overall: 'VOID', reason: voided.reason, perFrame: perFrame.map(strip), killClauseFired: [], suggestedStatus: 'PARTIAL' };

    // positive anchors that are IN-DOMAIN (the promotable stratum)
    const POS = ['bundled_cr2', 'IMG_1757'];
    const posAnchors = perFrame.filter((p) => POS.includes(p.frame) && p.decoderArm === 'rawler');
    const inDomainPos = posAnchors.filter((p) => p.status === 'IN-DOMAIN');
    const kill = [];
    const criteria = {};

    // Positive stratum collapse (honest null, not a pass/fail)
    if (inDomainPos.length === 0) {
        return { overall: 'NOT-MEASURED', reason: 'both positive anchors ABSTAIN/OUT-OF-DOMAIN — positive stratum collapsed (honest null)', perFrame: perFrame.map(strip), killClauseFired: [], suggestedStatus: 'PARTIAL' };
    }

    // P2 recall gain over the RECALL-MAX ceiling
    const dR = inDomainPos.map((p) => p.f.deltaR_mesh);
    const medDR = median(dR);
    const eachGe02 = inDomainPos.every((p) => p.f.deltaR_mesh >= 0.02);
    const anyNeg = inDomainPos.some((p) => p.f.deltaR_mesh < 0);
    let p2v; if (anyNeg || medDR <= 0) p2v = 'FAIL'; else if (medDR >= 0.05 && eachGe02) p2v = 'PASS'; else if (medDR >= 0.02 && inDomainPos.every((p) => p.f.deltaR_mesh >= 0)) p2v = 'DIRECTIONAL'; else p2v = 'FAIL';
    criteria.P2 = { medianDeltaR: medDR, perAnchorDeltaR: inDomainPos.map((p) => ({ frame: p.frame, dR: p.f.deltaR_mesh })), gate: 'median ≥ +0.05 AND each ≥ +0.02', verdict: p2v };
    if (p2v === 'FAIL') kill.push('P2: median ΔR ≤ 0 or ΔR < 0 on an anchor (no recall gain over the ceiling)');

    // P3 precision non-regression + FP ceiling
    let p3v = 'PASS';
    for (const p of inDomainPos) {
        const okBase = p.f.mesh.precision >= p.f.baseline.precision - 0.02;
        const okBest = p.f.mesh.precision >= p.f.globalBest.precision - 0.02;
        const okFP = p.f.mesh.fpRatio <= 1.2;
        if (!(okBase && okBest && okFP)) p3v = 'FAIL';
    }
    criteria.P3 = { gate: 'precision ≥ (baseline−0.02) AND ≥ (global_best−0.02); FP_ratio ≤ 1.2', verdict: p3v };
    if (p3v === 'FAIL') kill.push('P3: precision regressed >0.02 or FP_ratio >1.2 (recall bought with junk)');

    // P4 scrambled-null separation
    const p4bad = inDomainPos.some((p) => !(p.f.zScr >= 3.0 && p.f.nScr >= 100));
    criteria.P4 = { perAnchor: inDomainPos.map((p) => ({ frame: p.frame, zScr: p.f.zScr, nScr: p.f.nScr })), gate: 'z_scr ≥ 3.0, N_scr ≥ 100', verdict: p4bad ? 'FAIL' : 'PASS' };
    if (p4bad) kill.push('P4: z_scr < 3.0 (gain within the scrambled-truth chance null)');

    // P5 dark-region concentration
    let p5v = 'PASS';
    for (const p of inDomainPos) if (!(p.f.deltaR_dark >= 2 * p.f.deltaR_bright && p.f.deltaR_bright >= -0.03)) p5v = 'FAIL';
    criteria.P5 = { perAnchor: inDomainPos.map((p) => ({ frame: p.frame, dark: p.f.deltaR_dark, bright: p.f.deltaR_bright })), gate: 'ΔR_dark ≥ 2·ΔR_bright AND ΔR_bright ≥ −0.03', verdict: p5v };
    if (p5v === 'FAIL') kill.push('P5: uniform gain (threshold-lowering) or embedded-star recall crater');

    // P6 gradient scaling + flat control. The correlation is "across frames": all
    // in-domain frames (positives + supporting) PLUS the low-gradient SeeStar flat
    // control point (run-level) which anchors the low end of the ΔR-vs-gradient trend.
    const gradPairs = perFrame.filter((p) => p.status === 'IN-DOMAIN' && typeof p.f.deltaR_mesh === 'number').map((p) => [p.f.deltaR_mesh, p.f.bgGradientSigma]);
    if (run.seestarFlatDeltaR != null && run.seestarBgGradientSigma != null) gradPairs.push([run.seestarFlatDeltaR, run.seestarBgGradientSigma]);
    const rho = spearman(gradPairs);
    const seestarOk = (run.seestarFlatDeltaR ?? 0) >= -0.02;
    const p6v = (rho != null && rho >= 0.6 && seestarOk) ? 'PASS' : (rho == null ? 'ABSTAIN' : 'FAIL');
    criteria.P6 = { spearman: rho, nPairs: gradPairs.length, seestarFlatDeltaR: run.seestarFlatDeltaR ?? null, gate: 'ρ ≥ 0.6 AND SeeStar ΔR ≥ −0.02', verdict: p6v };
    if (p6v === 'FAIL') kill.push('P6: ΔR not gradient-driven (ρ<0.6) or flat SeeStar control lost recall >0.02');

    // P7 rawler arm + CFA gate (promotion cap, not a kill)
    let p7cap = null;
    const p7 = inDomainPos.filter((p) => p.f.cfaPersistence != null);
    let p7v = 'ABSTAIN';
    if (p7.length) {
        const persistOk = p7.every((p) => p.f.cfaPersistence >= 0.80);
        const armOk = p7.every((p) => (p.f.deltaR_libraw == null) || (p.f.deltaR_mesh - p.f.deltaR_libraw >= 0));
        p7v = (persistOk && armOk) ? 'PASS' : 'FAIL';
        if (!persistOk) p7cap = 'DIRECTIONAL-CFA-CONFOUNDED';
    }
    criteria.P7 = { perAnchor: p7.map((p) => ({ frame: p.frame, cfaPersistence: p.f.cfaPersistence, deltaR_rawler: p.f.deltaR_mesh, deltaR_libraw: p.f.deltaR_libraw })), gate: 'CFA-ON persistence ≥ 0.80 AND ΔR(rawler)−ΔR(libraw) ≥ 0', verdict: p7v, promotionCap: p7cap };

    // P1 binding-fraction (report the surviving values; abstention already handled in preconditions)
    criteria.P1 = { perAnchor: inDomainPos.map((p) => ({ frame: p.frame, bindingFraction: p.f.bindingFraction, expectedTruth: p.f.expectedTruth, matchRadiusPx: p.f.matchRadiusPx })), gate: 'T_local binding fraction ≥ 0.5 (precondition)', verdict: 'PASS' };

    // calibrated-constant guard (VOIDs pre-run per the frozen clause)
    if (run.calibratedConstantsMoved) { kill.push('a calibrated constant moved (k/sigFactor/sigma_base/SOLVER_UW_SWEEP_MIN_Z) — VOIDs the additive-mesh thesis'); }

    // ── overall mapping (honest abstention ≠ failure) ────────────────────────
    let overall, suggestedStatus;
    if (run.calibratedConstantsMoved) { overall = 'VOID'; suggestedStatus = 'PARTIAL'; }
    else if (kill.length) { overall = 'FAIL'; suggestedStatus = 'FAIL'; }
    else if (p2v === 'PASS' && p3v === 'PASS' && p4bad === false && p5v === 'PASS' && p6v === 'PASS') {
        overall = p7cap ? 'DIRECTIONAL-CFA-CONFOUNDED' : 'PASS';
        suggestedStatus = p7cap ? 'PARTIAL' : 'PASS';
    } else if (p2v === 'DIRECTIONAL') { overall = 'DIRECTIONAL'; suggestedStatus = 'PARTIAL'; }
    else { overall = 'PARTIAL'; suggestedStatus = 'PARTIAL'; }

    return { overall, killClauseFired: kill, criteria, perFrame: perFrame.map(strip), suggestedStatus, promotionCap: p7cap };
}
function strip(p) { return { frame: p.frame, decoderArm: p.decoderArm, role: p.role, status: p.status, reason: p.reason }; }

// ── selftest with mock frames (pure; no wasm/box) ────────────────────────────
function selftest() {
    let pass = 0, fail = 0;
    const chk = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };
    const posFrame = (over) => ({ frame: 'bundled_cr2', role: 'positive', decoderArm: 'rawler', expectedTruth: 120, limitingMag: 12.5, matchRadiusPx: 3, bindingFraction: 0.72, wcsResidualPx: 0.6, nBrightForResidual: 40, bgGradientSigma: 6.0, baseline: { recall: 0.50, precision: 0.92 }, globalBest: { recall: 0.55, precision: 0.90, fpRatio: 1.0 }, mesh: { recall: 0.63, precision: 0.90, fpRatio: 1.05 }, deltaR_mesh: 0.08, deltaR_dark: 0.14, deltaR_bright: 0.01, zScr: 5.2, nScr: 120, cfaPersistence: 0.88, deltaR_libraw: 0.05, flatIdentity: true, ...over });
    const frame1757 = (over) => ({ ...posFrame(), frame: 'IMG_1757', bgGradientSigma: 4.0, deltaR_mesh: 0.06, deltaR_dark: 0.11, deltaR_bright: 0.005, ...over });
    const baseRun = () => ({ frames: [posFrame(), frame1757()], seestarFlatDeltaR: -0.005, seestarBgGradientSigma: 0.5, bgGradFloor: 2.0, calibratedConstantsMoved: false });

    let v = scoreMeshVerdict(baseRun());
    chk('clean PASS', v.overall === 'PASS' && v.killClauseFired.length === 0);

    let r = baseRun(); r.frames[0].deltaR_mesh = -0.01; r.frames[0].deltaR_dark = -0.01;
    v = scoreMeshVerdict(r); chk('ΔR<0 on an anchor → FAIL (P2 kill)', v.overall === 'FAIL' && v.killClauseFired.some((k) => k.startsWith('P2')));

    r = baseRun(); r.frames[0].zScr = 1.5;
    v = scoreMeshVerdict(r); chk('z_scr<3 → FAIL (P4 kill)', v.overall === 'FAIL' && v.killClauseFired.some((k) => k.startsWith('P4')));

    r = baseRun(); r.frames[0].deltaR_bright = 0.10; r.frames[0].deltaR_dark = 0.11; // dark < 2*bright
    v = scoreMeshVerdict(r); chk('uniform gain (dark<2·bright) → FAIL (P5 kill)', v.overall === 'FAIL' && v.killClauseFired.some((k) => k.startsWith('P5')));

    r = baseRun(); r.frames[0].flatIdentity = false;
    v = scoreMeshVerdict(r); chk('flat-identity fail → VOID', v.overall === 'VOID');

    r = baseRun(); r.frames[0].bindingFraction = 0.3; r.frames[1].bindingFraction = 0.2;
    v = scoreMeshVerdict(r); chk('both anchors non-binding → NOT-MEASURED (collapse)', v.overall === 'NOT-MEASURED');

    r = baseRun(); r.frames[0].cfaPersistence = 0.5; r.frames[1].cfaPersistence = 0.6;
    v = scoreMeshVerdict(r); chk('CFA persistence<0.80 → DIRECTIONAL-CFA-CONFOUNDED cap', v.overall === 'DIRECTIONAL-CFA-CONFOUNDED' && v.suggestedStatus === 'PARTIAL');

    r = baseRun(); r.frames[0].deltaR_mesh = 0.03; r.frames[1].deltaR_mesh = 0.03; // median 0.03 in [0.02,0.05)
    v = scoreMeshVerdict(r); chk('+0.02≤median<+0.05 → DIRECTIONAL', v.criteria.P2.verdict === 'DIRECTIONAL' && v.overall === 'DIRECTIONAL');

    r = baseRun(); r.calibratedConstantsMoved = true;
    v = scoreMeshVerdict(r); chk('calibrated constant moved → VOID', v.overall === 'VOID');

    console.log(`\nmesh selftest-score: ${pass} passed, ${fail} failed`);
    return { pass, fail };
}

function isMain() { const b = process.argv[1] ? path.resolve(process.argv[1]) : ''; return b === fileURLToPath(import.meta.url); }
if (isMain()) {
    const arg = process.argv.slice(2);
    if (arg.includes('--selftest')) { const t = selftest(); process.exit(t.fail ? 1 : 0); }
    const inFile = arg.find((a) => !a.startsWith('--'));
    if (!inFile) { console.error('usage: mesh_score.mjs <run.json> | --selftest'); process.exit(2); }
    const run = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    const v = scoreMeshVerdict(run);
    console.log(JSON.stringify(v, null, 2));
}
