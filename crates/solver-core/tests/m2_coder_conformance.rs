//! M2 GATE — canonical coder conformance vs the g15u release's STORED bytes.
//!
//! For each golden case (extracted by crates/conformance/golden_extract.mjs;
//! expectations are the release's stored bits, never recomputed): rebuild the
//! quad per the builder recipe —
//!   meanRaDec(4 stars, STORED star0..3 order) → gnomonic (degrees) about that
//!   centroid → pts {x, y, w = −g} → build_quad_codes(sepMin 0, sepMax ∞,
//!   capInterior 2) → the emitted quad whose ids == (0,1,2,3)
//! — then assert the f32-narrowed code bits, the f64-derived code_key, and the
//! f32 diam_deg bits ALL equal the stored values. GATE: every case bit-exact.
//!
//! ESCALATION RULE (binding, plan rev 2 M2): any mismatch dumps the case's
//! full f64 intermediates below AND must be compared against the JS recompute
//!   node crates/conformance/golden_extract.mjs --case <band>:<row>
//! If the divergence is ≤2 ulp in a trig output and the f32 mismatch is a
//! last-bit or single-bin flip: classify LIBM_ULP, STOP, and report to 'main'
//! with the concrete case. NEVER loosen the comparison; NEVER work around
//! silently.

use serde::Deserialize;
use solver_core::coder::{build_quad_codes, code_key, PointW, QuadCode};
use solver_core::contracts::coordinates::SkyDeg;
use solver_core::geom::{dot_deg, gnomonic, mean_ra_dec, unit_vec};

#[derive(Deserialize)]
struct Fixture {
    release: String,
    aggregate_md5: String,
    nbins: i32,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    band: u32,
    row: u64,
    category: String,
    star_rows: [u64; 4],
    /// stars.arrow ra_deg f64 BIT PATTERNS (hex strings). Bits transport is
    /// mandatory: serde_json's default decimal-float parse is not guaranteed
    /// correctly rounded (measured 1-ulp miss; float_roundtrip feature not
    /// enabled) — a bit-exactness gate cannot ride on it.
    ra_bits: [String; 4],
    /// stars.arrow dec_deg f64 bit patterns (hex strings).
    dec_bits: [String; 4],
    /// stars.arrow g_mag f32 bit patterns.
    g_bits: [u32; 4],
    /// STORED code0..3 f32 bit patterns.
    expected_code_bits: [u32; 4],
    /// STORED code_key (builder computed it from the F64 code).
    expected_code_key: i32,
    /// STORED diam_deg f32 bit pattern.
    diam_deg_bits: u32,
}

impl Case {
    fn ra(&self, k: usize) -> f64 {
        hex_bits_f64(&self.ra_bits[k])
    }
    fn dec(&self, k: usize) -> f64 {
        hex_bits_f64(&self.dec_bits[k])
    }
    /// g as the builder saw it: the f32 catalog value widened to f64 (exact).
    fn g(&self, k: usize) -> f64 {
        f32::from_bits(self.g_bits[k]) as f64
    }
}

fn hex_bits_f64(s: &str) -> f64 {
    let t = s.strip_prefix("0x").unwrap_or(s);
    f64::from_bits(u64::from_str_radix(t, 16).expect("bad f64 bits hex"))
}

fn load_fixture() -> Fixture {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/quads_golden_g15u.json");
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read golden fixture {path}: {e} (regenerate via crates/conformance/golden_extract.mjs)"));
    serde_json::from_str(&raw).expect("golden fixture parse")
}

/// Recompute one case per the builder recipe. Returns (found quad, centroid,
/// gnomonic points) or an error string.
fn recompute(c: &Case) -> Result<(QuadCode, SkyDeg, [PointW; 4]), String> {
    let stars: Vec<SkyDeg> =
        (0..4).map(|k| SkyDeg { ra: c.ra(k), dec: c.dec(k) }).collect();
    let ctr = mean_ra_dec(&stars); // STORED order — summation order is contractual
    let mut pts = [PointW { x: 0.0, y: 0.0, w: 0.0 }; 4];
    for k in 0..4 {
        let gp = gnomonic(c.ra(k), c.dec(k), ctr.ra, ctr.dec)
            .ok_or_else(|| format!("gnomonic returned None for star{k} (behind tangent point)"))?;
        pts[k] = PointW { x: gp.x, y: gp.y, w: -c.g(k) };
    }
    let mut out: Vec<QuadCode> = Vec::new();
    build_quad_codes(&pts, 0.0, f64::INFINITY, 2, &mut out);
    let found = out
        .iter()
        .find(|q| q.ids == [0, 1, 2, 3])
        .copied()
        .ok_or_else(|| {
            let ids: Vec<[u32; 4]> = out.iter().map(|q| q.ids).collect();
            format!("no emitted quad with ids (0,1,2,3); emitted ids = {ids:?}")
        })?;
    Ok((found, ctr, pts))
}

fn dump_case(c: &Case, detail: &str) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "\n─── CASE band={} row={} cat={} star_rows={:?} ───\n{detail}\n",
        c.band, c.row, c.category, c.star_rows
    ));
    if let Ok((found, ctr, pts)) = recompute(c) {
        s.push_str(&format!(
            "  centroid ra={} (0x{:016x}) dec={} (0x{:016x})\n",
            ctr.ra, ctr.ra.to_bits(), ctr.dec, ctr.dec.to_bits()
        ));
        for k in 0..4 {
            let u = unit_vec(c.ra(k), c.dec(k));
            s.push_str(&format!(
                "  star{k} ra={} dec={} u=[0x{:016x},0x{:016x},0x{:016x}]\n    gnomonic x={} (0x{:016x}) y={} (0x{:016x})\n",
                c.ra(k), c.dec(k),
                u.x.to_bits(), u.y.to_bits(), u.z.to_bits(),
                pts[k].x, pts[k].x.to_bits(), pts[k].y, pts[k].y.to_bits()
            ));
        }
        s.push_str(&format!(
            "  f64 code = {:?}\n  f64 bits = [0x{:016x},0x{:016x},0x{:016x},0x{:016x}]\n",
            found.code,
            found.code[0].to_bits(), found.code[1].to_bits(),
            found.code[2].to_bits(), found.code[3].to_bits()
        ));
        let got_bits: Vec<u32> = found.code_f32().iter().map(|v| v.to_bits()).collect();
        s.push_str(&format!(
            "  f32 bits got {:?} expected {:?}\n  code_key got {} expected {}\n",
            got_bits, c.expected_code_bits,
            code_key(&found.code), c.expected_code_key
        ));
    }
    s.push_str(&format!(
        "  JS twin: node crates/conformance/golden_extract.mjs --case {}:{}\n",
        c.band, c.row
    ));
    s.push_str("  ESCALATION: if divergence is ≤2 ulp in a trig output and the f32 mismatch is a last-bit/single-bin flip → classify LIBM_ULP, STOP, report to 'main'. Never loosen; never work around silently.\n");
    s
}

#[test]
fn m2_golden_conformance_stored_bytes_bit_exact() {
    let fx = load_fixture();
    assert_eq!(fx.release, "starplates-2026.07-quadidx-g15u", "fixture is for a different release");
    assert_eq!(fx.aggregate_md5, "c6ce0418da091fda89a706be0da3d25d", "fixture release aggregate_md5 drifted");
    assert_eq!(fx.nbins, 128, "fixture nbins != the release quantisation");
    assert_eq!(fx.cases.len(), 112, "expected the full 112-case stratified set");

    let mut failures: Vec<String> = Vec::new();
    let mut pass = 0usize;
    for c in &fx.cases {
        match recompute(c) {
            Err(e) => failures.push(dump_case(c, &format!("RECOMPUTE FAILED: {e}"))),
            Ok((found, _ctr, _pts)) => {
                let got_bits = found.code_f32().map(|v| v.to_bits());
                let got_key = code_key(&found.code);
                let got_diam_bits =
                    (dot_deg(&unit_vec(c.ra(0), c.dec(0)), &unit_vec(c.ra(1), c.dec(1))) as f32)
                        .to_bits();
                let code_ok = got_bits == c.expected_code_bits;
                let key_ok = got_key == c.expected_code_key;
                let diam_ok = got_diam_bits == c.diam_deg_bits;
                if code_ok && key_ok && diam_ok {
                    pass += 1;
                } else {
                    failures.push(dump_case(
                        c,
                        &format!(
                            "MISMATCH: code_bits_ok={code_ok} key_ok={key_ok} diam_ok={diam_ok} (diam bits got 0x{got_diam_bits:08x} expected 0x{:08x})",
                            c.diam_deg_bits
                        ),
                    ));
                }
            }
        }
    }
    if !failures.is_empty() {
        panic!(
            "M2 CONFORMANCE GATE RED: {}/{} bit-exact; {} failing case(s):\n{}",
            pass,
            fx.cases.len(),
            failures.len(),
            failures.join("\n")
        );
    }
}

/// Stratification sanity: the fixture must actually cover the edge-case
/// categories the plan names (fold boundary, C/D near-tie, bin edges,
/// |dec|>85°, RA wrap) — an all-random fixture would silently weaken the gate.
#[test]
fn m2_golden_fixture_stratification_present() {
    let fx = load_fixture();
    let count = |cat: &str| fx.cases.iter().filter(|c| c.category == cat).count();
    assert!(count("fold") >= 15, "fold-boundary cases missing");
    assert!(count("cdtie") >= 10, "C/D near-tie cases missing");
    assert!(count("binedge") >= 10, "bin-edge cases missing");
    assert!(count("highdec") >= 10, "|dec|>85 cases missing");
    assert!(count("rawrap") >= 10, "RA-wrap cases missing");
    // every band represented
    for band in 0..15u32 {
        assert!(
            fx.cases.iter().filter(|c| c.band == band).count() >= 7,
            "band {band} under-represented"
        );
    }
    // stored-order canonicality spot-check: expected f32 codes satisfy the two
    // canon invariants (cx+dx ≤ 1 within f32 rounding slack; dx ≥ cx likewise).
    for c in &fx.cases {
        let cx = f32::from_bits(c.expected_code_bits[0]) as f64;
        let dx = f32::from_bits(c.expected_code_bits[2]) as f64;
        assert!(cx + dx <= 1.0 + 1e-6, "stored code violates fold canon: band {} row {}", c.band, c.row);
        assert!(dx - cx >= -1e-6, "stored code violates C/D order canon: band {} row {}", c.band, c.row);
    }
}
