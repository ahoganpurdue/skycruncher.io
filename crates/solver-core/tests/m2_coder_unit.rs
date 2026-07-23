//! M2 unit battery — hand-built boundary semantics + quantisation edges +
//! the JS coder.golden.json scenes A/B as a secondary cross-language fixture.
//!
//! Boundary semantics under test (all STRICT/inclusive exactly as coder.mjs):
//!   - pair window: d2 < sepMin² or d2 > sepMax² REJECTS → exact boundary KEPT
//!   - interior: (P−mid)² <= d²/4 INCLUSIVE (point exactly on the circle counts)
//!   - fold iff cx+dx > 1 STRICT (exactly 1 → NO fold)
//!   - C/D swap iff dx < cx STRICT (exactly equal → NO swap)
//!   - interior cap: STABLE sort by w desc (ties keep interior-array order)
//!   - code_bin clamp at 0/127, NO wrap; code_key mixed-radix base-128 from f64

use serde::Deserialize;
use solver_core::coder::{
    build_quad_codes, code_bin, code_bin_range, code_key, PointW, QuadCode, CODE_HI, CODE_LO,
    DEFAULT_CODE_TOL, NBINS,
};

fn codes(pts: &[PointW], sep_min: f64, sep_max: f64, cap: usize) -> Vec<QuadCode> {
    let mut out = Vec::new();
    build_quad_codes(pts, sep_min, sep_max, cap, &mut out);
    out
}

fn p(x: f64, y: f64, w: f64) -> PointW {
    PointW { x, y, w }
}

// ── canon boundaries ─────────────────────────────────────────────────────────

#[test]
fn m2_fold_boundary_cx_plus_dx_exactly_one_no_fold() {
    // identity basis: A=(0,0), B=(1,0) → z(p) = p. cx+dx = 0.25+0.75 = 1.0 EXACT.
    let pts = [p(0.0, 0.0, 4.0), p(1.0, 0.0, 3.0), p(0.25, 0.3, 2.0), p(0.75, -0.2, 1.0)];
    let out = codes(&pts, 0.0, f64::INFINITY, 2);
    let q = out.iter().find(|q| q.ids[0] == 0 && q.ids[1] == 1).expect("AB pair quad");
    assert_eq!(q.ids, [0, 1, 2, 3], "cx+dx == 1 exactly must NOT fold (strict >)");
    assert_eq!(q.code, [0.25, 0.3, 0.75, -0.2]);
}

#[test]
fn m2_fold_fires_just_above_one() {
    // cx+dx = 0.26+0.75 = 1.01 > 1 → fold (swap A/B, z → 1−z), then C/D
    // reorder: folded C=(0.74,−0.3), D=(0.25,0.2) → dx<cx → swap → ids (1,0,3,2).
    let pts = [p(0.0, 0.0, 4.0), p(1.0, 0.0, 3.0), p(0.26, 0.3, 2.0), p(0.75, -0.2, 1.0)];
    let out = codes(&pts, 0.0, f64::INFINITY, 2);
    let q = out.iter().find(|q| (q.ids[0] == 1 && q.ids[1] == 0) || (q.ids[0] == 0 && q.ids[1] == 1)).expect("AB pair quad");
    assert_eq!(q.ids, [1, 0, 3, 2], "fold must swap A/B and the C/D reorder must follow");
    assert_eq!(q.code, [1.0 - 0.75, 0.2, 1.0 - 0.26, -0.3]);
}

#[test]
fn m2_cd_tie_dx_equals_cx_no_swap() {
    // cx = dx = 0.5 exactly → strict `dx < cx` is false → interior-array order kept.
    let pts = [p(0.0, 0.0, 4.0), p(1.0, 0.0, 3.0), p(0.5, 0.3, 2.0), p(0.5, -0.2, 1.0)];
    let out = codes(&pts, 0.0, f64::INFINITY, 2);
    let q = out.iter().find(|q| q.ids[0] == 0 && q.ids[1] == 1).expect("AB pair quad");
    assert_eq!(q.ids, [0, 1, 2, 3], "dx == cx exactly must NOT swap C/D (strict <)");
    assert_eq!(q.code, [0.5, 0.3, 0.5, -0.2]);
}

// ── pair-window boundary semantics ───────────────────────────────────────────

#[test]
fn m2_sep_window_boundaries_inclusive() {
    // |AB| = 2 exactly; C,D interior. Only the AB pair is in-window by construction.
    let pts = [p(0.0, 0.0, 4.0), p(2.0, 0.0, 3.0), p(1.0, 0.5, 2.0), p(1.0, -0.5, 1.0)];
    // d == sepMin == sepMax == 2 → kept (JS rejects on STRICT < / >).
    assert_eq!(codes(&pts, 2.0, 2.0, 6).len(), 1, "exact-boundary separation must be KEPT");
    // sepMin one ulp above 2 → rejected.
    let just_above = f64::from_bits(2.0f64.to_bits() + 1);
    assert_eq!(codes(&pts, just_above, f64::INFINITY, 6).iter().filter(|q| (q.ids[0].min(q.ids[1]), q.ids[0].max(q.ids[1])) == (0, 1)).count(), 0);
    // sepMax one ulp below 2 → rejected.
    let just_below = f64::from_bits(2.0f64.to_bits() - 1);
    assert_eq!(codes(&pts, 0.0, just_below, 6).iter().filter(|q| (q.ids[0].min(q.ids[1]), q.ids[0].max(q.ids[1])) == (0, 1)).count(), 0);
}

#[test]
fn m2_interior_boundary_on_circle_inclusive() {
    // (1,±1) sit EXACTLY on the AB-diameter circle (mid (1,0), r² = 1) → interior.
    let pts = [p(0.0, 0.0, 4.0), p(2.0, 0.0, 3.0), p(1.0, 1.0, 2.0), p(1.0, -1.0, 1.0)];
    let out = codes(&pts, 0.0, f64::INFINITY, 6);
    assert!(
        out.iter().any(|q| q.ids[0].min(q.ids[1]) == 0 && q.ids[0].max(q.ids[1]) == 1),
        "points exactly on the circle must count as interior (<= inclusive)"
    );
    // the (2,3) diameter pair also holds A,B on its circle → symmetric quad.
    assert_eq!(out.len(), 2);
}

// ── interior cap: stable w-desc sort, truncate ───────────────────────────────

#[test]
fn m2_cap_stable_sort_w_desc_ties_keep_array_order() {
    // AB window admits ONLY the (0,1) pair (|AB| = 10, all other dists < 8).
    // Interior array order = [2,3,4,5,6]; w = [5,3,3,4,1].
    // Stable w-desc: [2(w5), 5(w4), 3(w3), 4(w3), 6(w1)] → cap 3 keeps [2,5,3]
    // (the w=3 TIE must keep index 3 — an unstable sort could keep 4 instead).
    let pts = [
        p(0.0, 0.0, 0.0),
        p(10.0, 0.0, 0.0),
        p(4.0, 1.0, 5.0),
        p(5.0, 1.0, 3.0),
        p(6.0, 1.0, 3.0),
        p(4.0, -1.0, 4.0),
        p(5.0, -1.0, 1.0),
    ];
    let out = codes(&pts, 8.0, 12.0, 3);
    assert_eq!(out.len(), 3, "C(3,2) = 3 quads from the capped interior");
    let mut pairs: Vec<(u32, u32)> =
        out.iter().map(|q| (q.ids[2].min(q.ids[3]), q.ids[2].max(q.ids[3]))).collect();
    pairs.sort_unstable();
    assert_eq!(pairs, vec![(2, 3), (2, 5), (3, 5)], "cap must keep {{2,5,3}} — stability decides the w=3 tie");
}

#[test]
fn m2_fewer_than_two_interior_skips_pair() {
    let pts = [p(0.0, 0.0, 1.0), p(2.0, 0.0, 1.0), p(1.0, 0.4, 1.0), p(9.0, 9.0, 1.0)];
    // only one point inside the (0,1) circle; other pairs lack 2 interior too.
    assert!(codes(&pts, 1.9, 2.1, 6).is_empty());
}

// ── quantisation: code_bin / code_key / neighbour ranges ─────────────────────

#[test]
fn m2_code_bin_edges_and_clamp() {
    assert_eq!(code_bin(CODE_LO), 0);
    assert_eq!(code_bin(CODE_HI), NBINS - 1, "v = CODE_HI lands past the last bin → clamp 127");
    assert_eq!(code_bin(0.5), 64, "exact k/128 edge value belongs to bin k");
    // one ulp below 0.5: the true sum (v − CODE_LO) = 1 − 2⁻⁵⁴ lies midway
    // between 1 − 2⁻⁵³ and 1.0 → IEEE tie-to-even rounds UP to 1.0 → bin 64.
    // JS-verified identical (the bin edge is an f64-ARITHMETIC edge, not a
    // real-number edge — conformance means matching THIS, not the real line).
    assert_eq!(code_bin(f64::from_bits(0.5f64.to_bits() - 1)), 64, "1 ulp below edge: tie-to-even lands IN bin k (JS-identical)");
    // two ulps below (0.5 − 2⁻⁵³): the sum 1 − 2⁻⁵³ is exactly representable →
    // floor((1 − 2⁻⁵³)·64) = 63.
    assert_eq!(code_bin(f64::from_bits(0.5f64.to_bits() - 2)), 63, "2 ulps below edge stays in bin k-1");
    // exact edge for an arbitrary k: v = k/128*2 − 0.5, k = 100 → 1.0625
    assert_eq!(code_bin(100.0 / 128.0 * 2.0 - 0.5), 100);
    // out-of-range clamps, no wrap
    assert_eq!(code_bin(-3.0), 0);
    assert_eq!(code_bin(7.0), 127);
}

#[test]
fn m2_code_key_mixed_radix_from_f64() {
    assert_eq!(code_key(&[CODE_LO; 4]), 0);
    assert_eq!(code_key(&[CODE_HI; 4]), 128 * 128 * 128 * 128 - 1); // 268 435 455 < 2³¹
    // mixed-radix order is [cx, cy, dx, dy] with cx most significant
    let k = code_key(&[0.5, CODE_LO, CODE_LO, CODE_LO]);
    assert_eq!(k, 64 * 128 * 128 * 128);
    assert_eq!(code_key(&[CODE_LO, CODE_LO, CODE_LO, 0.5]), 64);
}

#[test]
fn m2_code_bin_range_clamps_at_0_and_127_no_wrap() {
    assert_eq!(code_bin_range(CODE_LO, DEFAULT_CODE_TOL), (0, 0), "lo edge: v−tol underflows → clamp 0, no wrap to 127");
    assert_eq!(code_bin_range(CODE_HI, DEFAULT_CODE_TOL), (127, 127), "hi edge: v+tol overflows → clamp 127, no wrap to 0");
    assert_eq!(code_bin_range(0.5, DEFAULT_CODE_TOL), (63, 64), "tol window straddling an edge spans both bins");
    let (lo, hi) = code_bin_range(0.25, DEFAULT_CODE_TOL);
    assert!(lo <= hi && hi - lo <= 1, "tol 0.015 < bin width 1/64 → at most 2 cells per dim");
}

// ── secondary fixture: the JS coder.golden.json scenes (cross-language) ──────
// Scene C (matchAndGate/summarize) is out of M2 scope — the Rust port carries
// only buildQuadCodes; scenes A and B fully exercise it (incl. the cap path).
//
// TRANSPORT: expected codes arrive as u64 BIT-PATTERN hex strings
// (codes_bits), regenerated + fresh-validated by golden_extract.mjs. Decimal
// JSON floats are NOT used for expectations: serde_json's default float parse
// is not guaranteed correctly rounded (measured 1-ulp miss on
// -0.22107142773826638 without the float_roundtrip feature). Scene pts are
// small exact decimals (integers) — safe in any parser.

fn hex_bits_f64(s: &str) -> f64 {
    let t = s.strip_prefix("0x").unwrap_or(s);
    f64::from_bits(u64::from_str_radix(t, 16).expect("bad f64 bits hex"))
}

#[derive(Deserialize)]
struct GoldenScenes {
    qopts: GoldenOpts,
    #[serde(rename = "sceneA_quad4")]
    scene_a: SceneA,
    #[serde(rename = "sceneB_field40")]
    scene_b: SceneB,
}

#[derive(Deserialize)]
struct GoldenOpts {
    #[serde(rename = "sepMin")]
    sep_min: f64,
    #[serde(rename = "sepMax")]
    sep_max: f64,
    #[serde(rename = "capInterior")]
    cap_interior: usize,
}

#[derive(Deserialize)]
struct ScenePt {
    x: f64,
    y: f64,
    w: f64,
}

#[derive(Deserialize)]
struct SceneA {
    pts: Vec<ScenePt>,
    count: usize,
    codes_bits: Vec<String>,
    quads: Vec<u32>,
}

#[derive(Deserialize)]
struct SceneB {
    seed: u32,
    n: usize,
    #[serde(rename = "W")]
    w: f64,
    #[serde(rename = "H")]
    h: f64,
    count: usize,
    codes_bits: Vec<String>,
    quads: Vec<u32>,
}

fn load_scenes() -> GoldenScenes {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/coder_golden_scenes.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read coder_golden_scenes.json"))
        .expect("parse coder_golden_scenes.json")
}

/// mulberry32 — exact port of the JS scene generator (u32 wrapping ops ≡ the
/// JS |0 / >>> / Math.imul semantics; verified against sceneB below).
struct Mulberry32 {
    a: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self { a: seed }
    }
    fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6D2B79F5);
        let a = self.a;
        let mut t = (a ^ (a >> 15)).wrapping_mul(a | 1);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

fn assert_scene(pts: &[PointW], opts: &GoldenOpts, count: usize, codes_bits: &[String], quads_flat: &[u32], scene: &str) {
    let out = codes(pts, opts.sep_min, opts.sep_max, opts.cap_interior);
    assert_eq!(out.len(), count, "{scene}: quad count");
    for (q, quad) in out.iter().enumerate() {
        for k in 0..4 {
            let got = quad.code[k];
            let exp = hex_bits_f64(&codes_bits[q * 4 + k]);
            assert!(
                got.to_bits() == exp.to_bits(),
                "{scene}: quad {q} code[{k}] got {got} (0x{:016x}) expected {exp} (0x{:016x})",
                got.to_bits(),
                exp.to_bits()
            );
            assert_eq!(quad.ids[k], quads_flat[q * 4 + k], "{scene}: quad {q} ids[{k}]");
        }
    }
}

#[test]
fn m2_golden_scene_a_quad4_bit_exact() {
    let g = load_scenes();
    let pts: Vec<PointW> = g.scene_a.pts.iter().map(|p| PointW { x: p.x, y: p.y, w: p.w }).collect();
    assert_scene(&pts, &g.qopts, g.scene_a.count, &g.scene_a.codes_bits, &g.scene_a.quads, "sceneA");
}

#[test]
fn m2_golden_scene_b_field40_bit_exact() {
    let g = load_scenes();
    assert_eq!(g.scene_b.seed, 7);
    let mut rng = Mulberry32::new(g.scene_b.seed);
    let n = g.scene_b.n;
    let mut pts = Vec::with_capacity(n);
    for i in 0..n {
        // JS: pts.push({ x: rand()*W, y: rand()*H, w: n - i }) — x drawn first.
        let x = rng.next() * g.scene_b.w;
        let y = rng.next() * g.scene_b.h;
        pts.push(PointW { x, y, w: (n - i) as f64 });
    }
    assert_scene(&pts, &g.qopts, g.scene_b.count, &g.scene_b.codes_bits, &g.scene_b.quads, "sceneB");
}

// ── reuse semantics of the out-vec contract ──────────────────────────────────

#[test]
fn m2_out_vec_cleared_between_calls() {
    let pts = [p(0.0, 0.0, 4.0), p(1.0, 0.0, 3.0), p(0.25, 0.3, 2.0), p(0.75, -0.2, 1.0)];
    let mut out = Vec::new();
    build_quad_codes(&pts, 0.0, f64::INFINITY, 2, &mut out);
    let first = out.len();
    build_quad_codes(&pts, 0.0, f64::INFINITY, 2, &mut out);
    assert_eq!(out.len(), first, "out must be cleared, not appended across calls");
}
