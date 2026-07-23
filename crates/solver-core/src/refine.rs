//! refine — σ-clipped linear TAN refine over accepted one-to-one matches, plus the
//! trace-replay match extractor that turns a verifier run into (det ↔ star) rows (M4b).
//!
//! REFINE (plan rev 2 §Verification + accept chain): from an ACCEPTED verify's one-to-one
//! matches, iterate ≤ refine_max_iter:
//!   1. project the matched stars to the tangent plane about the CURRENT CRVAL (f64,
//!      geom::gnomonic — degrees);
//!   2. solve the 6-dof linear LS  ξ = a·dx + b·dy + c,  η = d·dx + e·dy + f  with
//!      (dx,dy) = pixel − CRPIX and CRPIX FIXED at the frame center; the constant term
//!      (c,f) is the tangent-plane offset of the true pole, so CRVAL is RE-CENTERED each
//!      iteration via the exact inverse gnomonic (CRVAL MUST be free to move — a
//!      fixed-CRVAL fit cannot serve a corner-quad proposal on an 86° field). Assigning
//!      the fitted CD in the pre-move basis is first-order; the iteration absorbs it
//!      (the final iteration's offset ≈ 0).
//!   3. σ-clip: rows with pixel residual > refine_clip_rms · RMS are retired; refit.
//!   Stop when stable (no clips ∧ CRVAL shift < 1e-11°). Fewer than refine_min_matches
//!   survivors ⇒ the refine DEGENERATES TO IDENTITY (input WCS returned, flagged) — the
//!   accept chain still runs its independent rematch + re-judge.
//!
//! Centering trick: the LS design is centered on the matched pixels' mean, which
//! block-diagonalizes the normal equations (2×2 + scalar) — better conditioned than the
//! raw 3×3 for corner-heavy match sets, algebraically identical.
//!
//! MATCH EXTRACTION: the verifier reports only aggregate stats + an optional trace
//! (processing order, per-position theta, per-ref claims). To map trace rows back to
//! det ids / star rows this module REPLAYS the verifier's two input filters exactly —
//! seed exclusion (index filter) and RoR culling (same `ror2_of` + strict `<` predicate,
//! same NR) — and asserts the replayed list lengths against the verifier's own n_ref /
//! n_test. Any drift between replay and verifier is a loud panic, never a silent
//! mis-attribution. Per-row `log_lr` is the row's OWN foreground/background log-ratio
//! (loggmax − d²/2σ² − logbg), recomputed from the same formulas — NOT the running-odds
//! delta (conflict switches redistribute those); documented on MatchRow.
//! Matches are cut at the prefix-max position (p ≤ besti), the a.net verify semantic
//! (matches beyond the peak dragged the odds down and are not part of the accepted set).
//!
//! LAW 1: COORDINATE-ledger math. No I/O, no env reads (crate-wide grep-guard).

use solver_contracts::coordinates::{SkyDeg, TanWcs};
use solver_contracts::result::{MatchRow, VerifyStats};

use crate::geom;
use crate::hypo::{inverse_gnomonic, project_tan};
use crate::verify::{ror2_of, sigma2_at_radius, VerifyOpts, VerifyTrace};

/// Refine parameters (resolved once from EvidencePolicy).
#[derive(Debug, Clone, Copy)]
pub struct RefineParams {
    pub min_matches: u32,
    pub clip_rms: f64,
    pub max_iter: u32,
}

impl From<&solver_contracts::config::EvidencePolicy> for RefineParams {
    fn from(p: &solver_contracts::config::EvidencePolicy) -> Self {
        Self {
            min_matches: p.refine_min_matches,
            clip_rms: p.refine_clip_rms,
            max_iter: p.refine_max_iter,
        }
    }
}

/// Reusable buffers (construct once; capacities persist — zero-alloc at steady state
/// after a prepare-phase warmup at the verify caps).
#[derive(Debug, Default)]
pub struct RefineScratch {
    active: Vec<bool>,
    resid2: Vec<f64>,
}

impl RefineScratch {
    pub fn new() -> Self {
        Self::default()
    }
    /// Pre-size for up to `n` matches (prepare phase).
    pub fn warm(&mut self, n: usize) {
        self.active.reserve(n);
        self.resid2.reserve(n);
    }
}

/// Refine outcome. `degenerate == true` ⇒ `wcs` is the UNCHANGED input pose.
#[derive(Debug, Clone, Copy)]
pub struct RefineOutcome {
    pub wcs: TanWcs,
    pub iterations: u32,
    pub survivors: u32,
    pub clipped: u32,
    pub degenerate: bool,
    /// Final RMS pixel residual over survivors (0.0 when degenerate).
    pub rms_px: f64,
}

/// σ-clipped linear TAN refine (module header). `det_px[i]` ↔ `star_sky[i]` are the
/// accepted one-to-one matches.
pub fn refine_tan(
    wcs0: &TanWcs,
    det_px: &[[f64; 2]],
    star_sky: &[SkyDeg],
    params: &RefineParams,
    scratch: &mut RefineScratch,
) -> RefineOutcome {
    assert_eq!(det_px.len(), star_sky.len(), "match arrays length mismatch");
    let n = det_px.len();
    let identity = |clipped: u32| RefineOutcome {
        wcs: *wcs0,
        iterations: 0,
        survivors: n as u32 - clipped,
        clipped,
        degenerate: true,
        rms_px: 0.0,
    };
    if (n as u32) < params.min_matches {
        return identity(0);
    }

    scratch.active.clear();
    scratch.active.resize(n, true);
    scratch.resid2.clear();
    scratch.resid2.resize(n, 0.0);

    let mut wcs = *wcs0;
    let mut clipped_total: u32 = 0;
    let mut iterations: u32 = 0;
    let mut rms_px = 0.0f64;

    for _ in 0..params.max_iter {
        iterations += 1;

        // ── accumulate the centered normal equations over active rows ──
        let (mut mx, mut my, mut cnt) = (0.0f64, 0.0f64, 0usize);
        for i in 0..n {
            if scratch.active[i] {
                mx += det_px[i][0];
                my += det_px[i][1];
                cnt += 1;
            }
        }
        if (cnt as u32) < params.min_matches {
            return identity(clipped_total);
        }
        mx /= cnt as f64;
        my /= cnt as f64;

        let (mut s11, mut s12, mut s22) = (0.0f64, 0.0f64, 0.0f64);
        let (mut sx1, mut sx2, mut sx0) = (0.0f64, 0.0f64, 0.0f64);
        let (mut sy1, mut sy2, mut sy0) = (0.0f64, 0.0f64, 0.0f64);
        let mut projectable = true;
        for i in 0..n {
            if !scratch.active[i] {
                continue;
            }
            let t = match geom::gnomonic(star_sky[i].ra, star_sky[i].dec, wcs.crval.ra, wcs.crval.dec)
            {
                Some(t) => t,
                None => {
                    // Star behind the tangent plane under the current pose — a pose this
                    // wrong cannot be linearly refined; degenerate to identity.
                    projectable = false;
                    break;
                }
            };
            let q1 = (det_px[i][0] - wcs.crpix.x) - (mx - wcs.crpix.x); // = x - mx
            let q2 = (det_px[i][1] - wcs.crpix.y) - (my - wcs.crpix.y);
            s11 += q1 * q1;
            s12 += q1 * q2;
            s22 += q2 * q2;
            sx1 += q1 * t.x;
            sx2 += q2 * t.x;
            sx0 += t.x;
            sy1 += q1 * t.y;
            sy2 += q2 * t.y;
            sy0 += t.y;
        }
        if !projectable {
            return identity(clipped_total);
        }
        let det2 = s11 * s22 - s12 * s12;
        if !(det2.abs() > 1e-9) || !det2.is_finite() {
            // Collinear / coincident match geometry — 6-dof fit is rank-deficient.
            return identity(clipped_total);
        }

        // Solve the centered 2×2 systems; constants from the means.
        let a = (sx1 * s22 - sx2 * s12) / det2;
        let b = (sx2 * s11 - sx1 * s12) / det2;
        let d = (sy1 * s22 - sy2 * s12) / det2;
        let e = (sy2 * s11 - sy1 * s12) / det2;
        let cbar = sx0 / cnt as f64;
        let fbar = sy0 / cnt as f64;
        // ξ(dx,dy) = a·(x−mx) + b·(y−my) + cbar ; re-express about CRPIX:
        let dmx = mx - wcs.crpix.x;
        let dmy = my - wcs.crpix.y;
        let c0 = cbar - a * dmx - b * dmy;
        let f0 = fbar - d * dmx - e * dmy;

        // CRVAL re-centered from the fitted constant term (exact inverse gnomonic).
        let new_crval = inverse_gnomonic(c0, f0, wcs.crval.ra, wcs.crval.dec);
        let crval_shift =
            angular_sep_deg(wcs.crval, new_crval);
        wcs = TanWcs {
            crval: new_crval,
            crpix: wcs.crpix,
            cd: [[a, b], [d, e]],
        };

        // ── residuals + σ-clip ──
        let (mut sum2, mut m) = (0.0f64, 0usize);
        for i in 0..n {
            if !scratch.active[i] {
                continue;
            }
            let r2 = match project_tan(&wcs, star_sky[i]) {
                Some(p) => {
                    let rx = p.x - det_px[i][0];
                    let ry = p.y - det_px[i][1];
                    rx * rx + ry * ry
                }
                None => f64::INFINITY,
            };
            scratch.resid2[i] = r2;
            if r2.is_finite() {
                sum2 += r2;
                m += 1;
            }
        }
        if m == 0 {
            return identity(clipped_total);
        }
        rms_px = (sum2 / m as f64).sqrt();
        let clip2 = (params.clip_rms * rms_px) * (params.clip_rms * rms_px);
        let mut clipped_now: u32 = 0;
        for i in 0..n {
            if scratch.active[i] && !(scratch.resid2[i] <= clip2) {
                scratch.active[i] = false;
                clipped_now += 1;
            }
        }
        clipped_total += clipped_now;

        let survivors = n as u32 - clipped_total;
        if survivors < params.min_matches {
            return identity(clipped_total);
        }
        if clipped_now == 0 && crval_shift < 1e-11 {
            break;
        }
    }

    RefineOutcome {
        wcs,
        iterations,
        survivors: n as u32 - clipped_total,
        clipped: clipped_total,
        degenerate: false,
        rms_px,
    }
}

/// Great-circle separation in degrees between two sky positions.
pub fn angular_sep_deg(a: SkyDeg, b: SkyDeg) -> f64 {
    let ua = geom::unit_vec(a.ra, a.dec);
    let ub = geom::unit_vec(b.ra, b.dec);
    geom::dot_deg(&ua, &ub)
}

// ───────────────────────────────────────────────────────────────────────────
// match extraction (verifier-trace replay)
// ───────────────────────────────────────────────────────────────────────────

/// Reusable index-map buffers for the filter replay.
#[derive(Debug, Default)]
pub struct MatchExtractScratch {
    /// culled ref index → ORIGINAL ref index
    ref_map: Vec<u32>,
    /// culled test index → ORIGINAL test index
    test_map: Vec<u32>,
}

impl MatchExtractScratch {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn warm(&mut self, refs: usize, tests: usize) {
        self.ref_map.reserve(refs);
        self.test_map.reserve(tests);
    }
}

#[inline]
fn dist2(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = ax - bx;
    let dy = ay - by;
    dx * dx + dy * dy
}

/// Turn a seed-excluded verifier run (its inputs + stats + trace) into one-to-one
/// `MatchRow`s in `out` (cleared first). See module header for the replay contract.
///
/// * `refs_px`/`ref_rows`: the UNfiltered reference list handed to
///   `verify_with_seed_exclusion` (projected px + star rows, parallel).
/// * `tests`/`test_ids`: the UNfiltered test list (x, y, bright) + det ids, parallel.
/// * `seed_ref`/`seed_test`, `det_a`/`det_b`: exactly the wrapper's arguments.
#[allow(clippy::too_many_arguments)]
pub fn extract_matches(
    refs_px: &[[f64; 2]],
    ref_rows: &[u32],
    tests: &[(f64, f64, f64)],
    test_ids: &[u32],
    seed_ref: [usize; 4],
    seed_test: [usize; 4],
    det_a: [f64; 2],
    det_b: [f64; 2],
    w: f64,
    h: f64,
    opts: &VerifyOpts,
    stats: &VerifyStats,
    trace: &VerifyTrace,
    scratch: &mut MatchExtractScratch,
    out: &mut Vec<MatchRow>,
) {
    assert_eq!(refs_px.len(), ref_rows.len(), "ref arrays mismatch");
    assert_eq!(tests.len(), test_ids.len(), "test arrays mismatch");
    out.clear();

    // ── replay 1: seed exclusion (index filter, order preserved) ──
    scratch.ref_map.clear();
    scratch.test_map.clear();
    for i in 0..refs_px.len() {
        if !seed_ref.contains(&i) {
            scratch.ref_map.push(i as u32);
        }
    }
    for i in 0..tests.len() {
        if !seed_test.contains(&i) {
            scratch.test_map.push(i as u32);
        }
    }

    // ── replay 2: anchor + RoR culling (verify.rs preprocessing, formula-identical) ──
    let qcx = (det_a[0] + det_b[0]) / 2.0;
    let qcy = (det_a[1] + det_b[1]) / 2.0;
    let q2 = dist2(qcx, qcy, det_a[0], det_a[1]);
    let pix2 = opts.verify_pix_sigma * opts.verify_pix_sigma;
    let frame_area = (w * h).max(1.0);

    if opts.do_ror && q2 > 0.0 && !scratch.ref_map.is_empty() {
        let ror2 = ror2_of(q2, frame_area, opts.distractor, scratch.ref_map.len(), pix2);
        if ror2.is_finite() {
            // In-place retain preserves order — same predicate (strict <) as verify.rs.
            scratch
                .ref_map
                .retain(|&i| {
                    let r = refs_px[i as usize];
                    dist2(r[0], r[1], qcx, qcy) < ror2
                });
            scratch.test_map.retain(|&i| {
                let t = tests[i as usize];
                dist2(t.0, t.1, qcx, qcy) < ror2
            });
        }
    }

    // Replay-vs-verifier cross-check: any drift is a loud panic, never mis-attribution.
    assert_eq!(
        scratch.ref_map.len(),
        stats.n_ref as usize,
        "match-extraction replay drift: culled ref count"
    );
    assert_eq!(
        scratch.test_map.len(),
        stats.n_test as usize,
        "match-extraction replay drift: culled test count"
    );

    let nr = scratch.ref_map.len();
    if nr == 0 || stats.besti < 0 {
        return;
    }
    let logbg = (1.0 / stats.eff_area).ln();
    let nr_f = nr as f64;

    // ── walk the trace up to the prefix-max cut ──
    let cut = stats.besti as usize;
    for p in 0..trace.theta.len().min(cut + 1) {
        let th = trace.theta[p];
        if th < 0 {
            continue;
        }
        let culled_test = trace.order[p] as usize;
        let culled_ref = th as usize;
        let orig_test = scratch.test_map[culled_test] as usize;
        let orig_ref = scratch.ref_map[culled_ref] as usize;
        let t = tests[orig_test];
        let r = refs_px[orig_ref];
        let sig2 = sigma2_at_radius(pix2, dist2(t.0, t.1, qcx, qcy), q2, opts.do_gamma);
        let d2 = dist2(t.0, t.1, r[0], r[1]);
        // Formula + association identical to verify.rs's matched-row foreground.
        let loggmax = ((1.0 - opts.distractor) / (2.0 * std::f64::consts::PI * sig2 * nr_f)).ln();
        let logfg = loggmax - d2 / (2.0 * sig2);
        out.push(MatchRow {
            det_id: test_ids[orig_test],
            star_row: ref_rows[orig_ref],
            residual_x: t.0 - r[0],
            residual_y: t.1 - r[1],
            log_lr: logfg - logbg,
            test_order: p as u32,
        });
    }
}
