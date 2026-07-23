//! M4a synthetic wide-field proof -- independent of the g15u release (no index needed):
//! render detections through an EXACT TAN at 52 asec/px on a 5796x3870 frame (rotation +
//! a parity-1 variant), compute catalog codes directly from TRUE sky positions
//! (meanRaDec + gnomonic + canonical coder), and assert the pipeline's re-tangented det
//! codes match at (a) the true scale and (b) the band-edge worst-case sampled scale.
//!
//! ERROR TAXONOMY at mismatched scale (measured here, 2026-07-20): errors are BIMODAL --
//! (1) a CONTINUOUS curvature branch (the k*eps*B family the sampling rule bounds), and
//! (2) rare discrete CANONICAL-BOUNDARY FLIPS: a quad near the coder's fold (cx+dx = 1) or
//! C/D-order (dx = cx) decision boundary crosses it under perturbation and the canonical
//! code jumps O(1). Flips are an intrinsic attrition class of canonical coding
//! (astrometry.net shares it); the gate here asserts the CONTINUOUS branch <= tol and
//! separately bounds the flip RATE. The desk-check measures the real-world composite.
//!
//! Plus unit tests: sky-true separation monotonicity/extremum + solver clamps, parity-code
//! canonicality (bit-exact mirror), deterministic emission order (two identical runs, in
//! canonical order), and the non-monotone (near-radial) regime handling.

use solver_contracts::config::SearchPolicy;
use solver_contracts::coordinates::SkyDeg;
use solver_contracts::request::Detection;
use solver_core::coder::{self, PointW, QuadCode};
use solver_core::geom;
use solver_core::prep::prepare;
use solver_core::quadgen::{
    code_quad_at_scale, mirror_code, sample_scales, BandMeta, CandidateHit, CandidateSink,
    PairGeom, QuadGen, D2R,
};

const W: f64 = 5796.0;
const H: f64 = 3870.0;
const CODE_TOL: f64 = 0.015;
/// g15u band edges (manifest `edges`, 15 sqrt(2) annuli).
const EDGES: [f64; 16] = [
    0.25, 0.354, 0.5, 0.707, 1.0, 1.414, 2.0, 2.828, 4.0, 5.657, 8.0, 11.314, 16.0, 22.627,
    32.0, 45.255,
];

/// splitmix64 -- deterministic, dependency-free.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Exact TAN camera: pixel (0-based, y-down) -> sky, CRPIX at the frame center.
/// CD = s_deg * R(rot) * diag(1, parity)  =>  det(CD) sign = parity.
struct SynTan {
    ra0: f64,
    dec0: f64,
    cd: [[f64; 2]; 2],
}
impl SynTan {
    fn new(ra0: f64, dec0: f64, rot_deg: f64, s_asec: f64, parity: f64) -> Self {
        let s = s_asec / 3600.0;
        let (sr, cr) = (rot_deg * D2R).sin_cos();
        Self { ra0, dec0, cd: [[s * cr, -s * sr * parity], [s * sr, s * cr * parity]] }
    }
    fn pix2sky(&self, x: f64, y: f64) -> SkyDeg {
        let u = x - W * 0.5;
        let v = y - H * 0.5;
        let xi = (self.cd[0][0] * u + self.cd[0][1] * v) * D2R; // rad
        let eta = (self.cd[1][0] * u + self.cd[1][1] * v) * D2R;
        let (sa, ca) = (self.ra0 * D2R).sin_cos();
        let (sd, cdec) = (self.dec0 * D2R).sin_cos();
        let r0 = [cdec * ca, cdec * sa, sd];
        let e = [-sa, ca, 0.0];
        let n = [-sd * ca, -sd * sa, cdec];
        let vx = r0[0] + xi * e[0] + eta * n[0];
        let vy = r0[1] + xi * e[1] + eta * n[1];
        let vz = r0[2] + xi * e[2] + eta * n[2];
        let norm = (vx * vx + vy * vy + vz * vz).sqrt();
        let dec = (vz / norm).clamp(-1.0, 1.0).asin() / D2R;
        let mut ra = vy.atan2(vx) / D2R;
        if ra < 0.0 {
            ra += 360.0;
        }
        SkyDeg { ra, dec }
    }
}

/// Catalog-side canonical code of a 4-star set from TRUE sky positions (the builder recipe:
/// unit-vector mean -> gnomonic about the centroid -> canonical coder, basis = pts[0],[1]).
fn catalog_code(sky: &[SkyDeg; 4]) -> Option<[f64; 4]> {
    let c = geom::mean_ra_dec(sky);
    let mut pts = [PointW { x: 0.0, y: 0.0, w: 0.0 }; 4];
    for k in 0..4 {
        let t = geom::gnomonic(sky[k].ra, sky[k].dec, c.ra, c.dec)?;
        pts[k] = PointW { x: t.x, y: t.y, w: 0.0 };
    }
    let mut out: Vec<QuadCode> = Vec::new();
    coder::build_quad_codes(&pts, 0.0, f64::INFINITY, 2, &mut out);
    out.iter()
        .find(|q| (q.ids[0] == 0 && q.ids[1] == 1) || (q.ids[0] == 1 && q.ids[1] == 0))
        .map(|q| q.code)
}

fn dist(a: &[f64; 4], b: &[f64; 4]) -> f64 {
    (0..4).map(|i| (a[i] - b[i]) * (a[i] - b[i])).sum::<f64>().sqrt()
}

/// Distance modulo the coder's canonical-branch choices: min over the identity, the C/D
/// swap image, the fold image, and the fold-of-swap image. A code whose raw distance is
/// large but whose canonical-image distance is small crossed a fold/order decision
/// boundary under perturbation (BOUNDARY FLIP), not a curvature failure.
fn dist_canon(a: &[f64; 4], b: &[f64; 4]) -> f64 {
    let images = [
        *a,
        [a[2], a[3], a[0], a[1]],               // C/D swap
        [1.0 - a[2], -a[3], 1.0 - a[0], -a[1]], // fold (ordered form)
        [1.0 - a[0], -a[1], 1.0 - a[2], -a[3]], // fold of the swap image
    ];
    images.iter().map(|im| dist(im, b)).fold(f64::INFINITY, f64::min)
}

/// Seeded 4-point pixel quads with the basis pair spanning a target separation and C, D
/// inside the AB pixel circle (so the basis survives the coder in both planes).
fn gen_quads(rng: &mut Rng, n: usize, min_d: f64, max_d: f64) -> Vec<[(f64, f64); 4]> {
    let mut out = Vec::new();
    while out.len() < n {
        let ax = rng.uniform(20.0, W - 20.0);
        let ay = rng.uniform(20.0, H - 20.0);
        let bx = rng.uniform(20.0, W - 20.0);
        let by = rng.uniform(20.0, H - 20.0);
        let d = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
        if d < min_d || d > max_d {
            continue;
        }
        let (mx, my) = ((ax + bx) * 0.5, (ay + by) * 0.5);
        let r = d * 0.5;
        let mut inner = Vec::new();
        while inner.len() < 2 {
            let px = rng.uniform(mx - r, mx + r);
            let py = rng.uniform(my - r, my + r);
            let rr = ((px - mx).powi(2) + (py - my).powi(2)).sqrt();
            if rr < r * 0.85 && px > 5.0 && px < W - 5.0 && py > 5.0 && py < H - 5.0 {
                inner.push((px, py));
            }
        }
        out.push([(ax, ay), (bx, by), inner[0], inner[1]]);
    }
    out
}

// ------------------------- (a) true-scale code identity -------------------------

#[test]
fn true_scale_code_identity_both_parities() {
    let s_asec = 52.0;
    let s = s_asec / 3600.0;
    let mut scratch = Vec::new();
    for (variant, par) in [(0u8, 1.0f64), (1u8, -1.0f64)] {
        let cam = SynTan::new(207.15, -59.67, 95.2, s_asec, par);
        let mut rng = Rng(0xC0FFEE ^ variant as u64);
        let quads = gen_quads(&mut rng, 40, 300.0, 5500.0);
        let mut matched_parity = [0usize; 2];
        for pts in &quads {
            let sky = [
                cam.pix2sky(pts[0].0, pts[0].1),
                cam.pix2sky(pts[1].0, pts[1].1),
                cam.pix2sky(pts[2].0, pts[2].1),
                cam.pix2sky(pts[3].0, pts[3].1),
            ];
            let Some(cat) = catalog_code(&sky) else { continue };
            let Some(det) = code_quad_at_scale(pts, W, H, s, &mut scratch) else {
                panic!("det-side coder rejected a constructed basis quad");
            };
            let d0 = dist(&det.code, &cat);
            let d1 = dist(&mirror_code(&det.code), &cat);
            let (dmin, which) = if d0 <= d1 { (d0, 0) } else { (d1, 1) };
            assert!(
                dmin < 1e-9,
                "true-scale code identity broken: d0={d0:.3e} d1={d1:.3e} variant={variant}"
            );
            assert!(
                d0.max(d1) > CODE_TOL,
                "wrong parity unexpectedly within tol (degenerate quad?) d0={d0:.3e} d1={d1:.3e}"
            );
            matched_parity[which] += 1;
        }
        // Convention pin: within one camera variant EVERY quad matches on the SAME parity.
        assert!(
            matched_parity[0] == 0 || matched_parity[1] == 0,
            "mixed parity within one variant: {matched_parity:?}"
        );
        let expected = variant as usize; // det(CD) > 0 -> det parity 0; < 0 -> parity 1
        assert!(
            matched_parity[expected] > 0 && matched_parity[1 - expected] == 0,
            "parity convention drifted: variant={variant} matched={matched_parity:?}"
        );
    }
}

// --------------- (b) band-edge worst-case sampled-scale conformance ---------------

#[test]
fn band_edge_worst_case_sample_within_tol() {
    let s_asec = 52.0;
    let s_true = s_asec / 3600.0;
    let policy = SearchPolicy::default();
    let (s_lo, s_hi) = (policy.scale_lo_asec / 3600.0, policy.scale_hi_asec / 3600.0);
    let cam = SynTan::new(150.0, 20.0, 30.0, s_asec, 1.0);
    let mut rng = Rng(0xBEEF);
    // include wide (corner-reaching) basis pairs -- the high-field-angle regime
    let quads = gen_quads(&mut rng, 400, 400.0, 6500.0);
    let mut scratch = Vec::new();
    let mut tested = 0usize;
    let mut flips = 0usize;
    let mut max_cont = 0.0f64;
    let mut max_k = 0.0f64;
    let mut n_hist = [0usize; 9];
    for pts in &quads {
        let sky = [
            cam.pix2sky(pts[0].0, pts[0].1),
            cam.pix2sky(pts[1].0, pts[1].1),
            cam.pix2sky(pts[2].0, pts[2].1),
            cam.pix2sky(pts[3].0, pts[3].1),
        ];
        let Some(cat) = catalog_code(&sky) else { continue };
        // basis-pair TRUE separation and its band
        let g = PairGeom::new(pts[0].0, pts[0].1, pts[1].0, pts[1].1, W, H);
        let t = g.sep_deg(s_true);
        let Some(b) = (0..15).find(|&b| t >= EDGES[b] && t < EDGES[b + 1]) else { continue };
        let r2max = pts
            .iter()
            .map(|&(x, y)| (x - W * 0.5).powi(2) + (y - H * 0.5).powi(2))
            .fold(0.0f64, f64::max);
        // the REAL sampling rule for this (pair, band); its design worst-case mismatch
        let ss = sample_scales(&g, EDGES[b], EDGES[b + 1], r2max, CODE_TOL, s_lo, s_hi);
        n_hist[ss.n as usize] += 1;
        let ratio = ss.worst_ratio(EDGES[b], EDGES[b + 1]);
        for target in [t / ratio, t * ratio] {
            let s_w = g.solve_scale_for_sep(target, s_lo, s_hi);
            let Some(det) = code_quad_at_scale(pts, W, H, s_w, &mut scratch) else {
                continue; // basis re-arbitration at the shifted scale -- legal attrition
            };
            let raw = dist(&det.code, &cat);
            let cont = dist_canon(&det.code, &cat);
            if raw > CODE_TOL && cont <= CODE_TOL {
                flips += 1; // canonical-boundary flip: counted, not a curvature failure
            } else {
                let sin2_w = solver_core::quadgen::sin2_field_angle(r2max, s_w)
                    .max(solver_core::quadgen::sin2_field_angle(r2max, s_true));
                let k_emp = cont / ((ratio - 1.0).max(1e-12) * sin2_w.max(1e-12));
                max_k = max_k.max(k_emp);
                max_cont = max_cont.max(cont);
                assert!(
                    cont <= CODE_TOL,
                    "continuous code error out of tol: band {b} sep {t:.3} ratio {ratio:.4} \
                     n_samples {} err {cont:.5} k_emp {k_emp:.3}",
                    ss.n
                );
            }
            tested += 1;
        }
    }
    let flip_rate = flips as f64 / tested.max(1) as f64;
    eprintln!(
        "[m4a synthetic] band-edge worst-case: {tested} samples, max continuous err {max_cont:.5} \
         (tol {CODE_TOL}), max k_emp(sin2-basis) {max_k:.3}, boundary flips {flips} ({:.1}%), \
         n-samples hist {:?}",
        flip_rate * 100.0,
        &n_hist[1..]
    );
    assert!(tested >= 200, "too few worst-case samples exercised ({tested})");
    assert!(
        flip_rate < 0.10,
        "canonical-boundary flip rate {flip_rate:.3} implausibly high -- geometry bug?"
    );
}

// ----------------- separation monotonicity / extremum / clamps -----------------

#[test]
fn sep_monotone_rising_and_radial_peak() {
    let policy = SearchPolicy::default();
    let (s_lo, s_hi) = (policy.scale_lo_asec / 3600.0, policy.scale_hi_asec / 3600.0);

    // Tangential pair (opposite sides of center): P1.P2 < 0 => monotone on all s.
    let g_tan = PairGeom::new(W * 0.5 - 900.0, H * 0.5, W * 0.5 + 900.0, H * 0.5, W, H);
    assert!(g_tan.tau_peak().is_none(), "tangential pair must be monotone");
    let mut prev = -1.0;
    for k in 0..=200 {
        let s = s_lo * (s_hi / s_lo).powf(k as f64 / 200.0);
        let sep = g_tan.sep_deg(s);
        assert!(sep > prev, "monotonicity violated at s={s}");
        prev = sep;
    }

    // Near-radial wide pair: interior maximum INSIDE the blind window (the measured
    // deviation from the plan's blanket monotone claim).
    let g_rad = PairGeom::new(W * 0.5 + 1000.0, H * 0.5, W * 0.5 + 3000.0, H * 0.5, W, H);
    let tau_p = g_rad.tau_peak().expect("radial pair has an interior sep maximum");
    let s_p = tau_p / D2R;
    assert!(
        s_p > s_lo && s_p < s_hi,
        "radial-pair peak expected inside the blind window (s* = {:.1} asec/px)",
        s_p * 3600.0
    );
    // rises before, falls after
    assert!(g_rad.sep_deg(s_p * 0.9) < g_rad.sep_deg(s_p));
    assert!(g_rad.sep_deg(s_p * 1.1) < g_rad.sep_deg(s_p));
    // extremum-aware range: max > both endpoint values
    let (mn, mx) = g_rad.sep_range_deg(s_lo, s_hi);
    assert!(mx > g_rad.sep_deg(s_lo).max(g_rad.sep_deg(s_hi)) - 1e-12);
    assert!((mn - g_rad.sep_deg(s_lo).min(g_rad.sep_deg(s_hi))).abs() < 1e-12);

    // solver: reachable rising target hits exactly
    let t = g_rad.sep_deg(s_p * 0.5);
    let s_sol = g_rad.solve_scale_for_sep(t, s_lo, s_hi);
    assert!((g_rad.sep_deg(s_sol) - t).abs() < 1e-9);
    assert!(s_sol < s_p, "rising-branch root preferred");
    // clamp below window (tau/D2R round trip => approx, not bit-equal)
    let s_clamped = g_rad.solve_scale_for_sep(1e-9, s_lo, s_hi);
    assert!((s_clamped - s_lo).abs() <= 1e-12 * s_lo);
    // unreachable above the peak clamps to the argmax
    let peak_sep = g_rad.sep_deg(s_p);
    let s_over = g_rad.solve_scale_for_sep(peak_sep * 1.5, s_lo, s_hi);
    assert!((s_over - s_p).abs() < 1e-12 * s_p.max(1.0));

    // falling-branch-only target: for a strictly radial pair the falling asymptote is 0,
    // so sep(s_hi) can drop below sep(s_lo); a target between them is falling-only.
    let (f_lo, f_hi) = (g_rad.sep_deg(s_lo), g_rad.sep_deg(s_hi));
    if f_hi < f_lo {
        let t2 = 0.5 * (f_hi + f_lo);
        let s2 = g_rad.solve_scale_for_sep(t2, s_lo, s_hi);
        assert!((g_rad.sep_deg(s2) - t2).abs() < 1e-9, "falling-branch solve");
        assert!(s2 > s_p, "falling-branch root lies above the peak");
    } else {
        // geometry did not produce the rare ordering -- still assert the peak dominates
        assert!(peak_sep >= f_lo.max(f_hi));
    }
}

// ----------------- parity-code canonicality (bit-exact) -----------------

#[test]
fn mirror_code_bit_exact_and_canonical() {
    let mut rng = Rng(0xDECAF);
    let mut out_a: Vec<QuadCode> = Vec::new();
    let mut out_b: Vec<QuadCode> = Vec::new();
    let mut checked = 0;
    for _ in 0..500 {
        let mut pts = [PointW { x: 0.0, y: 0.0, w: 0.0 }; 4];
        for p in pts.iter_mut() {
            p.x = rng.uniform(-3.0, 3.0);
            p.y = rng.uniform(-3.0, 3.0);
        }
        let mirrored: [PointW; 4] =
            std::array::from_fn(|i| PointW { x: pts[i].x, y: -pts[i].y, w: 0.0 });
        coder::build_quad_codes(&pts, 0.0, f64::INFINITY, 2, &mut out_a);
        coder::build_quad_codes(&mirrored, 0.0, f64::INFINITY, 2, &mut out_b);
        assert_eq!(out_a.len(), out_b.len(), "mirror changed quad admission");
        for (qa, qb) in out_a.iter().zip(out_b.iter()) {
            assert_eq!(qa.ids, qb.ids, "mirror changed canonical order");
            let neg = mirror_code(&qa.code);
            for k in 0..4 {
                assert_eq!(
                    neg[k].to_bits(),
                    qb.code[k].to_bits(),
                    "parity code not bit-exact at component {k}"
                );
            }
            // canonical invariants hold for the mirrored code
            assert!(neg[0] + neg[2] <= 1.0, "fold invariant violated");
            assert!(neg[2] >= neg[0], "C/D order invariant violated");
            checked += 1;
        }
    }
    assert!(checked > 200, "too few mirrored quads checked ({checked})");
}

// ----------------- deterministic emission (two identical runs) -----------------

#[derive(Default)]
struct RecordSink {
    quads: Vec<(u64, [u32; 4])>,
    coded: Vec<(u64, [u32; 4], u32, u8, u8, u64, [u64; 4])>,
    hits: usize,
}
impl CandidateSink for RecordSink {
    fn on_quad(&mut self, seq: u64, ids: [u32; 4]) {
        self.quads.push((seq, ids));
    }
    fn on_coded(
        &mut self,
        seq: u64,
        ids: [u32; 4],
        band: u32,
        parity: u8,
        sample: u8,
        s: f64,
        code: &[f64; 4],
    ) {
        self.coded
            .push((seq, ids, band, parity, sample, s.to_bits(), code.map(f64::to_bits)));
    }
    fn on_hit(&mut self, _hit: &CandidateHit) {
        self.hits += 1;
    }
}

fn synthetic_bands() -> Vec<BandMeta> {
    (0..15)
        .map(|b| BandMeta {
            index: b as u32,
            lo_deg: EDGES[b],
            hi_deg: EDGES[b + 1],
            n_quads: 1, // nonempty so the mask logic engages; probing skipped (no index)
        })
        .collect()
}

fn run_once(seed: u64) -> RecordSink {
    let mut rng = Rng(seed);
    let mut dets = Vec::new();
    for i in 0..110u32 {
        let x = rng.uniform(1.0, W - 1.0);
        let y = rng.uniform(1.0, H - 1.0);
        dets.push(Detection {
            id: i,
            x,
            y,
            flux: rng.uniform(0.1, 100.0),
            peak_value: rng.uniform(0.0, 0.23),
            fwhm: 3.0,
            snr: 8.0,
        });
        // sprinkle dedup pressure
        if i % 17 == 0 {
            dets.push(Detection {
                id: 1000 + i,
                x: x + 1.5,
                y,
                flux: 0.05,
                peak_value: 0.01,
                fwhm: 3.0,
                snr: 5.0,
            });
        }
    }
    let policy = SearchPolicy {
        rung_ladder: vec![40, 80],
        rung_final_all: true,
        ..SearchPolicy::default()
    };
    let prep = prepare(&dets, W as u32, H as u32, &policy);
    let mut qg = QuadGen::new(&prep, W as u32, H as u32, &policy, synthetic_bands());
    let mut sink = RecordSink::default();
    while qg.next_rung(None, &mut sink).is_some() {}
    sink
}

#[test]
fn deterministic_emission_and_canonical_order() {
    let a = run_once(42);
    let b = run_once(42);
    assert_eq!(a.quads.len(), b.quads.len());
    assert_eq!(a.quads, b.quads, "quad emission not deterministic");
    assert_eq!(a.coded.len(), b.coded.len());
    assert_eq!(a.coded, b.coded, "coded stream not deterministic (incl. f64 bits)");
    assert!(a.quads.len() > 1000, "expected a substantive quad stream, got {}", a.quads.len());

    // canonical: quad_seq strictly increasing, dense from 0
    for (k, &(seq, _)) in a.quads.iter().enumerate() {
        assert_eq!(seq, k as u64, "quad_seq must be dense and ordered");
    }
    // per-quad coded call order: (band, sample, parity) lexicographic within a quad_seq,
    // quad_seq non-decreasing overall
    let mut prev: Option<(u64, u32, u8, u8)> = None;
    for &(seq, _, band, parity, sample, _, _) in &a.coded {
        if let Some((ps, pb, pp, psa)) = prev {
            assert!(seq >= ps, "coded stream regressed in quad_seq");
            if seq == ps {
                let cur = (band, sample, parity);
                let prv = (pb, psa, pp);
                assert!(cur >= prv, "coded order within quad not (band, sample, parity) asc");
            }
        }
        prev = Some((seq, band, parity, sample));
    }
    assert_eq!(a.hits, 0, "no index attached -- no hits possible");
}
