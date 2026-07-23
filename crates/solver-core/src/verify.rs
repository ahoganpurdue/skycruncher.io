//! verify — a.net `real_verify_star_lists` port (M3 lane).
//!
//! Semantics source of truth (READ-ONLY oracle):
//!   D:/AstroLogic/worktrees/wt-quadonly/src/engine/pipeline/m6_plate_solve/quad_verify_model.ts
//! (itself a faithful port of astrometry.net verify.c:448-773 + RoR/effective-area
//! preprocessing + per-star positional variance). This module reproduces the TS oracle's
//! f64 semantics OPERATION-ORDER-EXACT — every formula keeps the TS expression's
//! association (e.g. `s += a - b` is `s = s + (a - b)`, never `(s + a) - b`) so the only
//! permitted float divergence is platform-libm 1-ulp (ln), absorbed by the 1e-9-relative
//! conformance tolerance. Integer/decision fields must be bit-equal (m3_verify_identity).
//!
//! PLUS the one a.net semantic the TS oracle lacks: SEED EXCLUSION
//! (`verify_with_seed_exclusion`) — a.net removes the 4 matched quad stars from BOTH input
//! lists before verification (verify.c:209-258 test side, :1340-1365 ref side; ror2 uses
//! post-removal NR) and anchors sigma-growth/RoR on qc = midpoint(det A, det B),
//! Q^2 = dist^2(qc, A) (verify.c:894-903). That is deliberately NOT the TS
//! `quadFromPoints` centroid/mean-r^2 — a different quantity.
//!
//! LEDGER: COORDINATE (pure geometry over caller-supplied pixel positions; no projection,
//! no catalog, no I/O). No env reads (crate-wide grep-guard).

use solver_contracts::config::EvidencePolicy;
use solver_contracts::result::VerifyStats;

/// Field-for-field the TS oracle's `QuadVerifyModelResult` (same fields as the contract's
/// `VerifyStats`; re-exported alias so verify callers speak one name).
pub type VerifyResult = VerifyStats;

// theta sentinels — only the sign is load-bearing (match >= 0, non-match < 0), mirroring
// the TS oracle (quad_verify_model.ts:59-63).
const THETA_DISTRACTOR: i32 = -1;
const THETA_CONFLICT: i32 = -2;

/// Verifier options — mirrors the TS `QuadVerifyModelOpts` + `QUAD_VERIFY_MODEL_DEFAULTS`
/// (quad_verify_model.ts:65-94). All PROVISIONAL a.net-verbatim values; never tuned to pass.
#[derive(Debug, Clone, Copy)]
pub struct VerifyOpts {
    /// Base positional sigma in px (a.net "verify pixels"); sigma^2 = this^2.
    pub verify_pix_sigma: f64,
    /// Distractor fraction D (a.net distractor ratio, 0.25).
    pub distractor: f64,
    /// Nearest-neighbour search radius in sigmas (a.net 5 => r^2 <= 25 sigma^2).
    pub max_match_sigma: f64,
    /// Distance-graded sigma growth sigma^2 = pix^2 (1 + r^2/Q^2) (a.net gamma, default true).
    pub do_gamma: bool,
    /// Ring-of-relevance culling + effective-area normalisation (a.net do_ror, default true).
    pub do_ror: bool,
    /// Effective-area bin grid N (N x N over the frame).
    pub eff_area_grid_n: u32,
    /// Per-pose bail: running odds < log_bail => abandon the scan (a.net ln(1e-100)).
    pub log_bail: f64,
    /// Early-stop: running odds > log_stop => stop scanning. TS shadow default +inf.
    pub log_stop: f64,
}

impl Default for VerifyOpts {
    fn default() -> Self {
        Self {
            verify_pix_sigma: 3.0,
            distractor: 0.25,
            max_match_sigma: 5.0,
            do_gamma: true,
            do_ror: true,
            eff_area_grid_n: 16,
            log_bail: 1e-100_f64.ln(), // ln(1e-100), computed exactly as the TS default does
            log_stop: f64::INFINITY,
        }
    }
}

impl From<&EvidencePolicy> for VerifyOpts {
    /// Take every aligned field from the resolved config. `log_stop` stays +inf here (the
    /// TS-oracle shadow default): wiring `log_accept` as an in-scan early-stop is an M4b
    /// accept-chain decision, not a verifier-port decision.
    fn from(p: &EvidencePolicy) -> Self {
        Self {
            verify_pix_sigma: p.verify_pix_sigma,
            distractor: p.distractor,
            max_match_sigma: p.max_match_sigma,
            do_gamma: p.do_gamma,
            do_ror: p.do_ror,
            eff_area_grid_n: p.eff_area_grid_n,
            log_bail: p.log_bail,
            log_stop: f64::INFINITY,
        }
    }
}

/// The anchor the variance model + RoR grow from. For a seed-excluded verify this is the
/// a.net quad anchor (midpoint(A,B), dist^2(qc,A)); for direct calls it is caller-supplied.
#[derive(Debug, Clone, Copy)]
pub struct QuadAnchor {
    pub cx: f64,
    pub cy: f64,
    pub quad_r2: f64,
}

/// Reusable buffers — construct once, reuse across calls (reset per call by truncation;
/// capacity is never shrunk, so a steady-state solve loop allocates zero here).
#[derive(Debug, Default)]
pub struct VerifyWorkspace {
    // core scan buffers
    order: Vec<u32>,
    rmatch: Vec<i32>,
    rprob: Vec<f64>,
    theta: Vec<i32>,
    ref_c: Vec<[f64; 2]>,
    test_c: Vec<(f64, f64, f64)>,
    // seed-exclusion input filters (separate so the wrapper can borrow them while the
    // core borrows the rest; moved out/in via mem::take, zero-alloc at steady state)
    seed_refs: Vec<[f64; 2]>,
    seed_tests: Vec<(f64, f64, f64)>,
    /// Optional trace sink: when `Some`, the core records post-scan per-position theta
    /// (in processing order), the processing order itself, and per-ref rmatch. Used by
    /// property tests; `None` on the hot path.
    pub trace: Option<VerifyTrace>,
}

/// Post-scan internal state snapshot for property tests (one-to-one invariants).
#[derive(Debug, Default, Clone)]
pub struct VerifyTrace {
    /// theta[p] for each processing position p: ref index >= 0, or a negative sentinel.
    pub theta: Vec<i32>,
    /// Processing order: order[p] = index into the (culled) test list.
    pub order: Vec<u32>,
    /// rmatch[j] for each (culled) ref j: claiming processing position, or -1.
    pub rmatch: Vec<i32>,
}

impl VerifyWorkspace {
    pub fn new() -> Self {
        Self::default()
    }
}

#[inline]
fn dist2(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = ax - bx;
    let dy = ay - by;
    dx * dx + dy * dy
}

/// Positional-variance model sigma^2(r) = verifyPix^2 (1 + r^2/Q^2) — TS oracle
/// `sigma2AtRadius` (quad_verify_model.ts:47-50). `do_gamma=false` or degenerate Q^2 =>
/// flat sigma^2.
#[inline]
pub fn sigma2_at_radius(verify_pix2: f64, r2: f64, quad_r2: f64, do_gamma: bool) -> f64 {
    if !do_gamma || !(quad_r2 > 0.0) {
        return verify_pix2;
    }
    verify_pix2 * (1.0 + r2 / quad_r2)
}

/// Radius-of-relevance^2 — TS oracle `ror2Of` (quad_verify_model.ts:54-57):
/// ror^2 = Q^2 * max(1, A(1-D)/(4 pi NR pix^2) - 1).
#[inline]
pub fn ror2_of(quad_r2: f64, area: f64, distractor: f64, nr: usize, pix2: f64) -> f64 {
    if !(quad_r2 > 0.0) || nr == 0 || !(pix2 > 0.0) {
        return f64::INFINITY;
    }
    let t = (area * (1.0 - distractor)) / (4.0 * std::f64::consts::PI * nr as f64 * pix2) - 1.0;
    quad_r2 * (if t > 1.0 { t } else { 1.0 })
}

/// a.net-complete signed verification over PIXEL-space positions — the TS oracle's
/// `computeQuadVerifyModel` (quad_verify_model.ts:128-280), decision-identical.
///
/// `refs`: catalog predictions projected to px. `tests`: (x, y, bright) detections.
/// Returns the full TS field set (prefix-max log-odds, besti, bestWorst, finalOdds,
/// counts, effArea, bailedAt/stoppedAt).
pub fn compute_quad_verify(
    refs: &[[f64; 2]],
    tests: &[(f64, f64, f64)],
    w: f64,
    h: f64,
    quad: QuadAnchor,
    opts: &VerifyOpts,
    ws: &mut VerifyWorkspace,
) -> VerifyResult {
    let pix2 = opts.verify_pix_sigma * opts.verify_pix_sigma;
    let d = opts.distractor;
    let nn_radius2 = opts.max_match_sigma * opts.max_match_sigma; // multiplies per-star sigma^2
    let frame_area = (w * h).max(1.0);
    let (qcx, qcy) = (quad.cx, quad.cy);
    let q2 = quad.quad_r2;

    // ── RoR preprocessing (TS :142-163): cull test+ref beyond ror^2; effA = A*good/total.
    // Culled lists are materialized into workspace buffers either way (copy of <= a few
    // hundred rows; capacity retained => zero-alloc at steady state).
    ws.ref_c.clear();
    ws.test_c.clear();
    let mut eff_area = frame_area;
    let mut culled = false;
    if opts.do_ror && q2 > 0.0 && !refs.is_empty() {
        let ror2 = ror2_of(q2, frame_area, d, refs.len(), pix2);
        if ror2.is_finite() {
            culled = true;
            for r in refs {
                if dist2(r[0], r[1], qcx, qcy) < ror2 {
                    ws.ref_c.push(*r);
                }
            }
            for t in tests {
                if dist2(t.0, t.1, qcx, qcy) < ror2 {
                    ws.test_c.push(*t);
                }
            }
            // effective area: fraction of frame bins whose centre lies within ror^2 (TS :152-161).
            let gn = if opts.eff_area_grid_n < 1 { 1u32 } else { opts.eff_area_grid_n };
            let mut good: u32 = 0;
            for iy in 0..gn {
                for ix in 0..gn {
                    let bx = (ix as f64 + 0.5) * (w / gn as f64);
                    let by = (iy as f64 + 0.5) * (h / gn as f64);
                    if dist2(bx, by, qcx, qcy) < ror2 {
                        good += 1;
                    }
                }
            }
            eff_area = frame_area * (good as f64 / (gn as u64 * gn as u64) as f64);
        }
    }
    if !culled {
        ws.ref_c.extend_from_slice(refs);
        ws.test_c.extend_from_slice(tests);
    }

    let nr = ws.ref_c.len();
    let nt = ws.test_c.len();
    let empty = VerifyResult {
        log_odds: 0.0,
        besti: -1,
        best_worst: 0.0,
        final_odds: 0.0,
        n_matched: 0,
        n_distractor: 0,
        n_conflict: 0,
        n_test: nt as u32,
        n_ref: nr as u32,
        eff_area,
        bailed_at: -1,
        stopped_at: -1,
    };
    if nr == 0 || nt == 0 || !(eff_area > 0.0) {
        if let Some(tr) = ws.trace.as_mut() {
            tr.theta.clear();
            tr.order.clear();
            tr.rmatch.clear();
        }
        return empty;
    }

    let logbg = (1.0 / eff_area).ln();

    // Bright-first processing order — stable on ties by original index (TS :177-180).
    ws.order.clear();
    ws.order.extend(0..nt as u32);
    {
        let test_c = &ws.test_c;
        ws.order.sort_by(|&a, &b| {
            let ba = test_c[a as usize].2;
            let bb = test_c[b as usize].2;
            bb.partial_cmp(&ba)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.cmp(&b))
        });
    }

    // Per-reference bookkeeping + per-position theta (TS :183-186).
    ws.rmatch.clear();
    ws.rmatch.resize(nr, -1);
    ws.rprob.clear();
    ws.rprob.resize(nr, f64::NEG_INFINITY);
    ws.theta.clear();
    ws.theta.resize(nt, THETA_DISTRACTOR);

    let nr_f = nr as f64;
    // logdAt(mu) = ln(D + ((1-D) mu)/NR) + logbg (TS :188) — association preserved.
    let logd_at = |mu: f64| -> f64 { (d + ((1.0 - d) * mu) / nr_f).ln() + logbg };

    let mut logodds: f64 = 0.0;
    let mut best = f64::NEG_INFINITY;
    let mut besti: i64 = -1;
    let mut worst: f64 = 0.0;
    let mut best_worst = f64::NEG_INFINITY;
    let mut mu: f64 = 0.0;
    let (mut n_matched, mut n_distractor, mut n_conflict) = (0u32, 0u32, 0u32);
    let (mut bailed_at, mut stopped_at) = (-1i64, -1i64);

    for p in 0..nt {
        let t = ws.test_c[ws.order[p] as usize];
        let sig2 = sigma2_at_radius(pix2, dist2(t.0, t.1, qcx, qcy), q2, opts.do_gamma);
        let logd = logd_at(mu);

        // Nearest reference within the sigma-scaled radius; `<=` keeps the TS last-wins
        // exact-tie behavior (TS :204-210). Already-matched refs stay searchable — the
        // conflict block resolves duplicates.
        let mut refj: i32 = -1;
        let mut bestd2 = sig2 * nn_radius2;
        for j in 0..nr {
            let r = ws.ref_c[j];
            let d2 = dist2(t.0, t.1, r[0], r[1]);
            if d2 <= bestd2 {
                bestd2 = d2;
                refj = j as i32;
            }
        }

        let mut logfg: f64;
        if refj == -1 {
            logfg = f64::NEG_INFINITY;
        } else {
            let loggmax = ((1.0 - d) / (2.0 * std::f64::consts::PI * sig2 * nr_f)).ln();
            logfg = loggmax - bestd2 / (2.0 * sig2);
        }

        if logfg < logd {
            // Distractor: no acceptable prediction here (TS :220-224).
            logfg = logd;
            ws.theta[p] = THETA_DISTRACTOR;
            n_distractor += 1;
        } else if ws.rmatch[refj as usize] != -1 {
            // CONFLICT: refj already claimed at processing position oldj. Keep-vs-switch
            // with exact retroactive re-weighting over intervening distractors
            // (TS :225-253 / verify.c:576-657).
            let rj = refj as usize;
            let oldfg = ws.rprob[rj];
            let keepfg = logd; // this detection would become a distractor
            let mut switchfg = logfg; // ...or it takes the match and the old one demotes
            let oldj = ws.rmatch[rj]; // processing position of the old claim (>= 0)
            let mut muj: f64 = 0.0;
            let mut j: usize = 0;
            while j < oldj as usize {
                if ws.theta[j] >= 0 {
                    muj += 1.0;
                }
                j += 1;
            }
            // Old match at oldj becomes a distractor evaluated with muj matches before it.
            switchfg += logd_at(muj) - oldfg;
            // NOTE: j == oldj here; the first iteration below sees theta[oldj] >= 0 and
            // counts it into muj (exactly the TS loop-resumption semantics).
            while j < p {
                if ws.theta[j] < 0 {
                    // Intervening distractor re-weighted for one fewer preceding match.
                    switchfg += logd_at(muj) - logd_at(muj + 1.0);
                } else {
                    muj += 1.0;
                }
                j += 1;
            }
            if switchfg > keepfg {
                // Upgrade: old match demoted, this detection claims refj.
                ws.theta[oldj as usize] = THETA_CONFLICT;
                n_conflict += 1; // the demoted old match becomes a conflict
                ws.theta[p] = refj;
                ws.rmatch[rj] = p as i32;
                ws.rprob[rj] = logfg; // THIS detection's own fg (pre-switchfg), per TS :245
                logfg = switchfg; // running odds absorbs the total change here
                // mu unchanged: -1 (old demoted) + 1 (this promoted).
            } else {
                // Keep the old match: this detection becomes a conflict/distractor.
                logfg = keepfg;
                ws.theta[p] = THETA_CONFLICT;
                n_conflict += 1;
            }
        } else {
            // New match (TS :254-261).
            ws.rmatch[refj as usize] = p as i32;
            ws.rprob[refj as usize] = logfg;
            ws.theta[p] = refj;
            mu += 1.0;
            n_matched += 1;
        }

        logodds += logfg - logbg;

        if logodds < opts.log_bail {
            bailed_at = p as i64;
            break;
        }
        worst = if logodds < worst { logodds } else { worst };
        if logodds > best {
            best = logodds;
            besti = p as i64;
            best_worst = worst;
        }
        if logodds > opts.log_stop {
            stopped_at = p as i64;
            break;
        }
    }

    if let Some(tr) = ws.trace.as_mut() {
        tr.theta.clear();
        tr.theta.extend_from_slice(&ws.theta);
        tr.order.clear();
        tr.order.extend_from_slice(&ws.order);
        tr.rmatch.clear();
        tr.rmatch.extend_from_slice(&ws.rmatch);
    }

    VerifyResult {
        log_odds: if best == f64::NEG_INFINITY { 0.0 } else { best },
        besti,
        best_worst: if best_worst == f64::NEG_INFINITY { 0.0 } else { best_worst },
        final_odds: logodds,
        n_matched,
        n_distractor,
        n_conflict,
        n_test: nt as u32,
        n_ref: nr as u32,
        eff_area,
        bailed_at,
        stopped_at,
    }
}

/// a.net seed exclusion + quad anchor (the one semantic the TS oracle lacks), as an
/// INPUT-FILTERING wrapper — exactly a.net's normalization (verify.c:209-258 test side,
/// :1340-1365 ref side; RoR's NR is the post-removal count because the core only ever
/// sees the filtered lists).
///
/// * `seed_ref_indices`: indices into `all_refs` of the 4 catalog quad stars — removed.
/// * `seed_test_indices`: indices into `all_tests` of the 4 matched detections — removed.
/// * `det_a`, `det_b`: the quad's A/B detections in px. Anchor per a.net verify.c:894-903:
///   qc = midpoint(A, B), Q^2 = dist^2(qc, A). (Deliberately NOT the TS `quadFromPoints`
///   centroid/mean-r^2 — that is a different quantity.)
///
/// Order of surviving rows is preserved (filter, not permutation). Duplicate indices are
/// harmless (a row is removed once). Out-of-range indices are ignored.
#[allow(clippy::too_many_arguments)]
pub fn verify_with_seed_exclusion(
    all_refs: &[[f64; 2]],
    seed_ref_indices: [usize; 4],
    all_tests: &[(f64, f64, f64)],
    seed_test_indices: [usize; 4],
    det_a: [f64; 2],
    det_b: [f64; 2],
    w: f64,
    h: f64,
    opts: &VerifyOpts,
    ws: &mut VerifyWorkspace,
) -> VerifyResult {
    // a.net quad anchor: qc = midpoint(det A, det B); Q^2 = dist^2(qc, A).
    let qcx = (det_a[0] + det_b[0]) / 2.0;
    let qcy = (det_a[1] + det_b[1]) / 2.0;
    let quad_r2 = dist2(qcx, qcy, det_a[0], det_a[1]);
    let anchor = QuadAnchor { cx: qcx, cy: qcy, quad_r2 };

    // Filter into workspace buffers (moved out so the core can borrow ws mutably;
    // moved back afterwards — capacities survive, zero-alloc at steady state).
    let mut seed_refs = std::mem::take(&mut ws.seed_refs);
    let mut seed_tests = std::mem::take(&mut ws.seed_tests);
    seed_refs.clear();
    seed_tests.clear();
    for (i, r) in all_refs.iter().enumerate() {
        if !seed_ref_indices.contains(&i) {
            seed_refs.push(*r);
        }
    }
    for (i, t) in all_tests.iter().enumerate() {
        if !seed_test_indices.contains(&i) {
            seed_tests.push(*t);
        }
    }

    let res = compute_quad_verify(&seed_refs, &seed_tests, w, h, anchor, opts, ws);

    ws.seed_refs = seed_refs;
    ws.seed_tests = seed_tests;
    res
}
