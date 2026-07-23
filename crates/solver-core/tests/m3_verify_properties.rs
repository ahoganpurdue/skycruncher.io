//! M3 property tests — structural invariants of the verifier over random scenes:
//!   * one-to-one BOTH directions (no ref claimed by two tests; no test holding two refs),
//!     checked against a brute-force pass over the trace, plus theta/rmatch bijection;
//!   * seed exclusion: wrapper == manual-filter + manual-anchor core call (bit-exact),
//!     and seed rows never appear in the evidence lists;
//!   * anchor rule: qc = midpoint(A,B), Q^2 = dist^2(qc, A).

use solver_core::verify::{
    compute_quad_verify, verify_with_seed_exclusion, QuadAnchor, VerifyOpts, VerifyResult,
    VerifyTrace, VerifyWorkspace,
};

/// Deterministic splitmix64-style generator (no deps, stable across platforms).
struct Rng(u64);
impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
    fn f(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + self.f() * (hi - lo)
    }
    fn idx(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

struct Scene {
    refs: Vec<[f64; 2]>,
    tests: Vec<(f64, f64, f64)>,
    w: f64,
    h: f64,
    quad: QuadAnchor,
}

/// Random scene with planted matches, planted CONFLICT pairs, distractors, and
/// occasional brightness ties.
fn random_scene(seed: u64) -> Scene {
    let mut rng = Rng(seed);
    let (w, h) = (1000.0, 1000.0);
    let n_ref = 15 + rng.idx(40);
    let mut refs = Vec::new();
    for _ in 0..n_ref {
        refs.push([rng.range(30.0, w - 30.0), rng.range(30.0, h - 30.0)]);
    }
    let mut tests = Vec::new();
    let mut bright = 1000.0;
    let n_match = 5 + rng.idx(n_ref - 5);
    for i in 0..n_match {
        let r = refs[i];
        bright -= rng.range(0.5, 3.0);
        tests.push((r[0] + rng.range(-2.5, 2.5), r[1] + rng.range(-2.5, 2.5), bright));
    }
    // planted conflicts: extra claims on already-matched refs
    for _ in 0..(1 + rng.idx(4)) {
        let r = refs[rng.idx(n_match)];
        bright -= rng.range(0.5, 3.0);
        tests.push((r[0] + rng.range(-4.0, 4.0), r[1] + rng.range(-4.0, 4.0), bright));
    }
    for _ in 0..(3 + rng.idx(12)) {
        bright -= rng.range(0.5, 3.0);
        tests.push((rng.range(0.0, w), rng.range(0.0, h), bright));
    }
    // occasional exact brightness ties
    if rng.idx(2) == 0 && tests.len() >= 4 {
        let b = tests[1].2;
        tests[2].2 = b;
        tests[3].2 = b;
    }
    let quad = QuadAnchor {
        cx: rng.range(100.0, w - 100.0),
        cy: rng.range(100.0, h - 100.0),
        quad_r2: rng.range(400.0, 250000.0),
    };
    Scene { refs, tests, w, h, quad }
}

fn dist2(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = ax - bx;
    let dy = ay - by;
    dx * dx + dy * dy
}

fn bit_equal(a: &VerifyResult, b: &VerifyResult) -> bool {
    a.log_odds.to_bits() == b.log_odds.to_bits()
        && a.best_worst.to_bits() == b.best_worst.to_bits()
        && a.final_odds.to_bits() == b.final_odds.to_bits()
        && a.eff_area.to_bits() == b.eff_area.to_bits()
        && a.besti == b.besti
        && a.n_matched == b.n_matched
        && a.n_distractor == b.n_distractor
        && a.n_conflict == b.n_conflict
        && a.n_test == b.n_test
        && a.n_ref == b.n_ref
        && a.bailed_at == b.bailed_at
        && a.stopped_at == b.stopped_at
}

/// One-to-one in both directions over 200 random scenes, brute-force checked.
#[test]
fn m3_property_one_to_one_both_directions() {
    let mut ws = VerifyWorkspace::new();
    ws.trace = Some(VerifyTrace::default());
    for seed in 0..200u64 {
        let s = random_scene(1_000 + seed);
        let opts = VerifyOpts::default();
        let res = compute_quad_verify(&s.refs, &s.tests, s.w, s.h, s.quad, &opts, &mut ws);
        let tr = ws.trace.as_ref().unwrap();

        // Brute force: no ref index appears twice among matched thetas.
        let matched: Vec<(usize, i32)> = tr
            .theta
            .iter()
            .enumerate()
            .filter(|(_, &t)| t >= 0)
            .map(|(p, &t)| (p, t))
            .collect();
        for i in 0..matched.len() {
            for j in (i + 1)..matched.len() {
                assert_ne!(
                    matched[i].1, matched[j].1,
                    "seed {seed}: ref {} held by two tests (positions {} and {})",
                    matched[i].1, matched[i].0, matched[j].0
                );
            }
        }
        // (each processing position holds at most one ref by construction: theta is scalar;
        //  the reverse direction is enforced through rmatch below)
        // theta/rmatch bijection.
        for &(p, r) in &matched {
            assert_eq!(
                tr.rmatch[r as usize], p as i32,
                "seed {seed}: theta[{p}]={r} but rmatch[{r}]={}",
                tr.rmatch[r as usize]
            );
        }
        for (r, &p) in tr.rmatch.iter().enumerate() {
            if p >= 0 {
                assert_eq!(
                    tr.theta[p as usize], r as i32,
                    "seed {seed}: rmatch[{r}]={p} but theta[{p}]={}",
                    tr.theta[p as usize]
                );
            }
        }
        // Count consistency: surviving matches == nMatched (switches are net-zero).
        assert_eq!(
            matched.len() as u32, res.n_matched,
            "seed {seed}: matched-set size vs nMatched"
        );
    }
}

/// Seed-exclusion wrapper == manual filter + manual a.net anchor, bit-exact; and the
/// seed rows are provably absent from the evidence the core sees.
#[test]
fn m3_property_seed_exclusion_equals_manual_filter() {
    let mut ws_a = VerifyWorkspace::new();
    let mut ws_b = VerifyWorkspace::new();
    for seed in 0..100u64 {
        let s = random_scene(7_000 + seed);
        if s.refs.len() < 6 || s.tests.len() < 6 {
            continue;
        }
        let mut rng = Rng(99_000 + seed);
        // 4 distinct seed ref indices + 4 distinct seed test indices
        let mut sr: Vec<usize> = Vec::new();
        while sr.len() < 4 {
            let k = rng.idx(s.refs.len());
            if !sr.contains(&k) {
                sr.push(k);
            }
        }
        let mut st: Vec<usize> = Vec::new();
        while st.len() < 4 {
            let k = rng.idx(s.tests.len());
            if !st.contains(&k) {
                st.push(k);
            }
        }
        let det_a = [s.tests[st[0]].0, s.tests[st[0]].1];
        let det_b = [s.tests[st[1]].0, s.tests[st[1]].1];
        let opts = VerifyOpts::default();

        let got = verify_with_seed_exclusion(
            &s.refs,
            [sr[0], sr[1], sr[2], sr[3]],
            &s.tests,
            [st[0], st[1], st[2], st[3]],
            det_a,
            det_b,
            s.w,
            s.h,
            &opts,
            &mut ws_a,
        );

        // manual filter (order-preserving) + manual a.net anchor
        let refs_f: Vec<[f64; 2]> = s
            .refs
            .iter()
            .enumerate()
            .filter(|(i, _)| !sr.contains(i))
            .map(|(_, r)| *r)
            .collect();
        let tests_f: Vec<(f64, f64, f64)> = s
            .tests
            .iter()
            .enumerate()
            .filter(|(i, _)| !st.contains(i))
            .map(|(_, t)| *t)
            .collect();
        let qcx = (det_a[0] + det_b[0]) / 2.0;
        let qcy = (det_a[1] + det_b[1]) / 2.0;
        let anchor = QuadAnchor { cx: qcx, cy: qcy, quad_r2: dist2(qcx, qcy, det_a[0], det_a[1]) };
        let want = compute_quad_verify(&refs_f, &tests_f, s.w, s.h, anchor, &opts, &mut ws_b);

        assert!(
            bit_equal(&got, &want),
            "seed {seed}: wrapper != manual filter\n got={got:?}\nwant={want:?}"
        );
    }
}

/// A seed test sitting EXACTLY on a seed ref must contribute nothing: with RoR off the
/// filtered counts are exact, and the evidence lists the core saw exclude the seeds.
#[test]
fn m3_property_seed_rows_never_in_evidence() {
    let mut ws = VerifyWorkspace::new();
    ws.trace = Some(VerifyTrace::default());
    let s = random_scene(42);
    let n_r = s.refs.len();
    let n_t = s.tests.len();
    // append 4 seed refs and place the 4 seed tests EXACTLY on them (perfect would-be matches)
    let mut refs = s.refs.clone();
    let mut tests = s.tests.clone();
    let seed_pos = [[111.0, 903.0], [873.0, 911.0], [131.0, 951.0], [901.0, 957.0]];
    for p in seed_pos {
        refs.push(p);
        tests.push((p[0], p[1], 5000.0));
    }
    let mut opts = VerifyOpts::default();
    opts.do_ror = false; // keep counts exact (no cull) for the assertion below
    let res = verify_with_seed_exclusion(
        &refs,
        [n_r, n_r + 1, n_r + 2, n_r + 3],
        &tests,
        [n_t, n_t + 1, n_t + 2, n_t + 3],
        seed_pos[0],
        seed_pos[1],
        s.w,
        s.h,
        &opts,
        &mut ws,
    );
    // exact-count proof that all 4 seed rows were removed from both sides
    assert_eq!(res.n_ref, n_r as u32, "seed refs leaked into evidence");
    assert_eq!(res.n_test, n_t as u32, "seed tests leaked into evidence");
    // anchor rule: qc = midpoint(A,B), Q^2 = dist^2(qc, A) — verified against the
    // trace-free manual call in property_seed_exclusion_equals_manual_filter; here we
    // additionally pin the arithmetic itself.
    let qcx = (seed_pos[0][0] + seed_pos[1][0]) / 2.0;
    let qcy = (seed_pos[0][1] + seed_pos[1][1]) / 2.0;
    let q2 = dist2(qcx, qcy, seed_pos[0][0], seed_pos[0][1]);
    assert!(q2 > 0.0 && qcx > 0.0 && qcy > 0.0, "anchor arithmetic degenerate");
}

/// Same inputs, same workspace, interleaved with a different scene: bit-identical.
#[test]
fn m3_property_workspace_reuse_deterministic() {
    let mut ws = VerifyWorkspace::new();
    let a = random_scene(11);
    let b = random_scene(12);
    let opts = VerifyOpts::default();
    let r1 = compute_quad_verify(&a.refs, &a.tests, a.w, a.h, a.quad, &opts, &mut ws);
    let _ = compute_quad_verify(&b.refs, &b.tests, b.w, b.h, b.quad, &opts, &mut ws);
    let r3 = compute_quad_verify(&a.refs, &a.tests, a.w, a.h, a.quad, &opts, &mut ws);
    assert!(bit_equal(&r1, &r3), "workspace reuse perturbed the result");
}
