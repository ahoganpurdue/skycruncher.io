//! M4b gate: σ-clipped TAN refine + trace-replay match extraction (plan rev 2 §M4b).
//!
//! Refine: from a perturbed start pose, converge toward the synthetic truth; CRVAL must
//! MOVE; outliers must be clipped; < refine_min_matches degenerates to identity.
//! Extraction: replay the real verifier's filters + trace into one-to-one MatchRows —
//! one-to-one BOTH directions, counts consistent with the verifier's own stats.

use solver_contracts::config::EvidencePolicy;
use solver_contracts::coordinates::{PixelXY, SkyDeg, TanWcs};
use solver_core::hypo::{inverse_gnomonic, project_tan};
use solver_core::refine::{
    angular_sep_deg, extract_matches, refine_tan, MatchExtractScratch, RefineParams, RefineScratch,
};
use solver_core::verify::{verify_with_seed_exclusion, VerifyOpts, VerifyTrace, VerifyWorkspace};

/// A synthetic truth WCS in the engine's convention (crpix = frame center).
fn truth_wcs() -> (TanWcs, f64, f64) {
    let (w, h) = (5796.0, 3870.0);
    let s = 52.7726 / 3600.0; // deg/px
    let rot: f64 = 33.0f64.to_radians();
    let (sr, cr) = rot.sin_cos();
    (
        TanWcs {
            crval: SkyDeg { ra: 207.154938, dec: -59.673110 },
            crpix: PixelXY { x: w / 2.0, y: h / 2.0 },
            cd: [[s * cr, -s * sr], [s * sr, s * cr]],
        },
        w,
        h,
    )
}

/// px → sky through a TanWcs (test-side inverse of project_tan).
fn px_to_sky(wcs: &TanWcs, x: f64, y: f64) -> SkyDeg {
    let dx = x - wcs.crpix.x;
    let dy = y - wcs.crpix.y;
    let tx = wcs.cd[0][0] * dx + wcs.cd[0][1] * dy;
    let ty = wcs.cd[1][0] * dx + wcs.cd[1][1] * dy;
    inverse_gnomonic(tx, ty, wcs.crval.ra, wcs.crval.dec)
}

fn field_matches(wcs: &TanWcs, w: f64, h: f64, n: usize) -> (Vec<[f64; 2]>, Vec<SkyDeg>) {
    // deterministic spread grid (avoids collinearity)
    let mut det = Vec::with_capacity(n);
    let mut sky = Vec::with_capacity(n);
    let cols = 8usize;
    for i in 0..n {
        let gx = (i % cols) as f64 + 0.5 + 0.13 * ((i / cols) as f64 % 3.0);
        let gy = (i / cols) as f64 + 0.5;
        let x = gx * w / cols as f64;
        let y = gy * h / ((n / cols + 1) as f64);
        det.push([x, y]);
        sky.push(px_to_sky(wcs, x, y));
    }
    (det, sky)
}

fn perturbed(wcs: &TanWcs) -> TanWcs {
    let mut p = *wcs;
    p.crval.ra += 0.03; // ~0.03° pointing error
    p.crval.dec -= 0.02;
    let rot: f64 = 0.004; // ~0.23° rotation error
    let (sr, cr) = rot.sin_cos();
    let cd = p.cd;
    let scale_err = 1.004; // 0.4% scale error
    p.cd = [
        [
            scale_err * (cd[0][0] * cr - cd[1][0] * sr),
            scale_err * (cd[0][1] * cr - cd[1][1] * sr),
        ],
        [
            scale_err * (cd[0][0] * sr + cd[1][0] * cr),
            scale_err * (cd[0][1] * sr + cd[1][1] * cr),
        ],
    ];
    p
}

#[test]
fn refine_converges_toward_truth_and_crval_moves() {
    let (truth, w, h) = truth_wcs();
    let (det, sky) = field_matches(&truth, w, h, 40);
    let start = perturbed(&truth);
    let start_err = angular_sep_deg(start.crval, truth.crval);
    assert!(start_err > 0.02, "perturbation sanity");

    let params = RefineParams::from(&EvidencePolicy::default());
    let mut scratch = RefineScratch::new();
    let out = refine_tan(&start, &det, &sky, &params, &mut scratch);

    assert!(!out.degenerate, "must not degenerate");
    assert_eq!(out.survivors, 40);
    // NOTE ON BARS: the affine-refit-with-re-tangent iteration converges GEOMETRICALLY
    // (per-pass ratio couples the crval offset to the squared field half-extent — this is
    // an 86°-class synthetic frame), and refine_max_iter = 5 is an owner-guarded
    // PROVISIONAL constant that must not be tuned to a test. 5 passes from a 1.8-arcmin
    // start land at ~1e-4 px rms — four orders below the 3 px verify sigma. Bars assert
    // that physically-meaningful convergence, not machine exactness.
    let end_err = angular_sep_deg(out.wcs.crval, truth.crval);
    eprintln!(
        "refine converge: start_err {start_err:.3e} deg → end_err {end_err:.3e} deg, \
         rms {:.3e} px, iters {}",
        out.rms_px, out.iterations
    );
    assert!(out.rms_px < 1e-3, "rms must reach sub-mpx: got {}", out.rms_px);
    assert!(
        end_err < 1e-5,
        "CRVAL must converge toward truth: start {start_err} deg → end {end_err} deg"
    );
    let crval_moved = angular_sep_deg(out.wcs.crval, start.crval);
    assert!(crval_moved > 0.02, "CRVAL must be free to move (moved {crval_moved} deg)");

    // reprojection through the refined WCS at matching precision
    for (d, s) in det.iter().zip(sky.iter()) {
        let p = project_tan(&out.wcs, *s).unwrap();
        let e = ((p.x - d[0]).powi(2) + (p.y - d[1]).powi(2)).sqrt();
        assert!(e < 5e-3, "refined reprojection residual {e}");
    }
}

#[test]
fn refine_clips_outliers() {
    let (truth, w, h) = truth_wcs();
    let (mut det, sky) = field_matches(&truth, w, h, 40);
    // poison 3 rows with large pixel offsets (matches to the wrong star)
    det[5][0] += 400.0;
    det[17][1] -= 350.0;
    det[31][0] -= 500.0;

    let params = RefineParams::from(&EvidencePolicy::default());
    let mut scratch = RefineScratch::new();
    let out = refine_tan(&truth, &det, &sky, &params, &mut scratch);

    assert!(!out.degenerate);
    assert_eq!(out.clipped, 3, "exactly the 3 poisoned rows must clip");
    assert_eq!(out.survivors, 37);
    // Post-clip the fit re-converges from the outlier-dragged first pass within the
    // remaining owner-guarded 5-iteration budget (see convergence note above).
    let err = angular_sep_deg(out.wcs.crval, truth.crval);
    eprintln!("refine clip: post-clip rms {:.3e} px, crval err {err:.3e} deg", out.rms_px);
    assert!(out.rms_px < 0.2, "post-clip rms {}", out.rms_px);
    assert!(err < 1e-3, "post-clip CRVAL error {err} deg");
}

#[test]
fn refine_below_min_matches_degenerates_to_identity() {
    let (truth, w, h) = truth_wcs();
    let (det, sky) = field_matches(&truth, w, h, 5); // < refine_min_matches (6)
    let start = perturbed(&truth);
    let params = RefineParams::from(&EvidencePolicy::default());
    let mut scratch = RefineScratch::new();
    let out = refine_tan(&start, &det, &sky, &params, &mut scratch);
    assert!(out.degenerate);
    // identity = bit-identical input WCS
    assert_eq!(out.wcs.crval.ra.to_bits(), start.crval.ra.to_bits());
    assert_eq!(out.wcs.cd[0][0].to_bits(), start.cd[0][0].to_bits());
    assert_eq!(out.iterations, 0);
}

/// Extraction against the REAL verifier: seeded run over a synthetic aligned scene,
/// trace-replay must produce one-to-one rows consistent with the verifier's stats.
#[test]
fn extract_matches_replays_verifier_filters() {
    let (w, h) = (2000.0, 1500.0);
    // refs = 60 grid points; tests = same points slightly jittered (guaranteed matches)
    // + 10 far distractors; seeds = 4 of the matched pairs.
    let mut refs: Vec<[f64; 2]> = Vec::new();
    let mut ref_rows: Vec<u32> = Vec::new();
    for i in 0..60u32 {
        let x = (i % 10) as f64 * 190.0 + 60.0;
        let y = (i / 10) as f64 * 230.0 + 80.0;
        refs.push([x, y]);
        ref_rows.push(1000 + i);
    }
    let mut tests: Vec<(f64, f64, f64)> = Vec::new();
    let mut test_ids: Vec<u32> = Vec::new();
    for (i, r) in refs.iter().enumerate() {
        tests.push((r[0] + 0.4, r[1] - 0.3, 500.0 - i as f64));
        test_ids.push(i as u32);
    }
    for i in 0..10u32 {
        // distractors well away from any ref
        tests.push((95.0 + i as f64 * 11.0, 1450.0, 10.0 - i as f64));
        test_ids.push(60 + i);
    }

    let seed_ref = [0usize, 1, 10, 11];
    let seed_test = [0usize, 1, 10, 11];
    let det_a = refs[0];
    let det_b = refs[11];

    let opts = VerifyOpts::default();
    let mut ws = VerifyWorkspace::new();
    ws.trace = Some(VerifyTrace::default());
    let stats = verify_with_seed_exclusion(
        &refs, seed_ref, &tests, seed_test, det_a, det_b, w, h, &opts, &mut ws,
    );
    assert!(stats.n_matched > 30, "aligned scene must match richly: {}", stats.n_matched);
    assert!(stats.log_odds > 0.0);

    let trace = ws.trace.take().unwrap();
    let mut scratch = MatchExtractScratch::new();
    let mut out = Vec::new();
    extract_matches(
        &refs, &ref_rows, &tests, &test_ids, seed_ref, seed_test, det_a, det_b, w, h, &opts,
        &stats, &trace, &mut scratch, &mut out,
    );

    assert!(!out.is_empty());
    assert!(
        out.len() <= stats.n_matched as usize,
        "extracted {} > verifier n_matched {}",
        out.len(),
        stats.n_matched
    );
    // one-to-one BOTH directions
    let mut dets: Vec<u32> = out.iter().map(|m| m.det_id).collect();
    let mut stars: Vec<u32> = out.iter().map(|m| m.star_row).collect();
    dets.sort_unstable();
    stars.sort_unstable();
    let dn = dets.len();
    dets.dedup();
    stars.dedup();
    assert_eq!(dets.len(), dn, "duplicate det_id in matches");
    assert_eq!(stars.len(), dn, "duplicate star_row in matches");
    // seeds must be EXCLUDED
    for m in &out {
        assert!(!seed_test.contains(&(m.det_id as usize)), "seed det leaked into matches");
        assert!(
            !(m.star_row >= 1000 && seed_ref.contains(&((m.star_row - 1000) as usize))),
            "seed ref leaked into matches"
        );
    }
    // residuals are the actual offsets (matched pairs were jittered by (+0.4, −0.3))
    for m in &out {
        assert!((m.residual_x - 0.4).abs() < 1e-9 && (m.residual_y + 0.3).abs() < 1e-9);
        assert!(m.log_lr.is_finite());
        assert!(m.log_lr > 0.0, "an aligned match must carry positive evidence");
    }
}
