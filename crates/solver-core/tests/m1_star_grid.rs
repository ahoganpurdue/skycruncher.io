//! M1 star-grid gates: synthetic catalogs (poles, RA wrap 359.9/0.1, dense clusters) —
//! `brightest_in_cone` must equal a brute-force reference exactly on 200 seeded random
//! queries plus adversarial specials (pole-containing cone, wrap-crossing cone, wide-field
//! fallback, radius-boundary cases).

use solver_contracts::coordinates::{SkyDeg, UnitVec3};
use solver_core::stars::{in_cone, StarGrid, StarsView};

/// splitmix64 — deterministic, dependency-free.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn f64(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Uniform-sphere synthetic catalog + adversarial structures. Row order = "brightness".
fn synthetic_catalog() -> (Vec<f64>, Vec<f64>) {
    let mut rng = Rng(0xC0FF_EE00_5EED);
    let mut ra = Vec::new();
    let mut dec = Vec::new();
    for _ in 0..20_000 {
        ra.push(rng.f64() * 360.0);
        dec.push((2.0 * rng.f64() - 1.0).asin().to_degrees());
    }
    // dense polar clusters (N within 1° of pole, S hugging -90)
    for _ in 0..500 {
        ra.push(rng.f64() * 360.0);
        dec.push(89.0 + rng.f64());
    }
    for _ in 0..500 {
        ra.push(rng.f64() * 360.0);
        dec.push(-90.0 + rng.f64() * 0.8);
    }
    // RA wrap band 359.5..360 ∪ 0..0.5
    for _ in 0..500 {
        let low = rng.f64() < 0.5;
        ra.push(if low {
            rng.f64() * 0.5
        } else {
            359.5 + rng.f64() * 0.5
        });
        dec.push((2.0 * rng.f64() - 1.0).asin().to_degrees());
    }
    // dense cluster blob at (180, 45)
    for _ in 0..1000 {
        ra.push(180.0 + (rng.f64() - 0.5) * 0.4);
        dec.push(45.0 + (rng.f64() - 0.5) * 0.3);
    }
    (ra, dec)
}

/// Brute-force reference: same predicate, ascending row order, first k.
fn brute(ra: &[f64], dec: &[f64], center: SkyDeg, radius_deg: f64, k: usize) -> Vec<u32> {
    let c = UnitVec3::from_sky(center);
    let cos_r = radius_deg.clamp(0.0, 180.0).to_radians().cos();
    let mut out = Vec::new();
    for i in 0..ra.len() {
        if in_cone(ra[i], dec[i], &c, cos_r) {
            out.push(i as u32);
            if out.len() == k {
                break;
            }
        }
    }
    out
}

fn check(
    grid: &StarGrid,
    ra: &[f64],
    dec: &[f64],
    center: SkyDeg,
    radius: f64,
    k: usize,
    label: &str,
) {
    let expect = brute(ra, dec, center, radius, k);
    let mut got = Vec::new();
    grid.brightest_in_cone(StarsView { ra_deg: ra, dec_deg: dec }, center, radius, k, &mut got);
    assert_eq!(
        got, expect,
        "{label}: grid != brute at center=({}, {}) r={radius} k={k} (got {} rows, expected {})",
        center.ra,
        center.dec,
        got.len(),
        expect.len()
    );
}

#[test]
fn grid_matches_brute_on_200_seeded_random_queries() {
    let (ra, dec) = synthetic_catalog();
    let grid = StarGrid::build(StarsView { ra_deg: &ra, dec_deg: &dec });
    let mut rng = Rng(0xDEAD_BEEF_0042);
    let ks = [1usize, 7, 50, 10_000];
    for qi in 0..200 {
        let center = SkyDeg {
            ra: rng.f64() * 360.0,
            dec: (2.0 * rng.f64() - 1.0).asin().to_degrees(),
        };
        let radius = 0.05 + rng.f64() * 4.5;
        let k = ks[qi % ks.len()];
        check(&grid, &ra, &dec, center, radius, k, &format!("random q{qi}"));
    }
}

#[test]
fn pole_containing_cones() {
    let (ra, dec) = synthetic_catalog();
    let grid = StarGrid::build(StarsView { ra_deg: &ra, dec_deg: &dec });
    // north pole inside the cone
    check(&grid, &ra, &dec, SkyDeg { ra: 123.4, dec: 89.8 }, 1.0, 10_000, "N-pole");
    check(&grid, &ra, &dec, SkyDeg { ra: 10.0, dec: 89.6 }, 3.0, 10_000, "N-pole wide");
    // south pole
    check(&grid, &ra, &dec, SkyDeg { ra: 300.0, dec: -89.9 }, 0.5, 10_000, "S-pole");
    check(&grid, &ra, &dec, SkyDeg { ra: 45.0, dec: -88.0 }, 4.0, 10_000, "S-pole wide");
    // near-pole but pole NOT inside (worst-case conservative RA extent)
    check(&grid, &ra, &dec, SkyDeg { ra: 200.0, dec: 85.0 }, 4.5, 10_000, "near-pole");
}

#[test]
fn wrap_crossing_cones() {
    let (ra, dec) = synthetic_catalog();
    let grid = StarGrid::build(StarsView { ra_deg: &ra, dec_deg: &dec });
    check(&grid, &ra, &dec, SkyDeg { ra: 359.9, dec: 0.0 }, 0.5, 10_000, "wrap 359.9");
    check(&grid, &ra, &dec, SkyDeg { ra: 0.05, dec: -30.0 }, 1.2, 10_000, "wrap 0.05");
    check(&grid, &ra, &dec, SkyDeg { ra: 0.0, dec: 20.0 }, 2.0, 10_000, "wrap 0.0");
    check(&grid, &ra, &dec, SkyDeg { ra: 359.999, dec: 60.0 }, 3.0, 10_000, "wrap hi-dec");
}

#[test]
fn dense_cluster_and_tiny_radius() {
    let (ra, dec) = synthetic_catalog();
    let grid = StarGrid::build(StarsView { ra_deg: &ra, dec_deg: &dec });
    check(&grid, &ra, &dec, SkyDeg { ra: 180.0, dec: 45.0 }, 0.3, 10_000, "cluster all");
    check(&grid, &ra, &dec, SkyDeg { ra: 180.0, dec: 45.0 }, 0.3, 5, "cluster k=5");
    check(&grid, &ra, &dec, SkyDeg { ra: 180.05, dec: 45.02 }, 0.001, 10_000, "tiny r");
}

#[test]
fn wide_field_fallback_and_radius_boundary() {
    let (ra, dec) = synthetic_catalog();
    let grid = StarGrid::build(StarsView { ra_deg: &ra, dec_deg: &dec });
    // exactly 5.0 → grid path; 5.001+ → linear-scan fallback; both must equal brute
    check(&grid, &ra, &dec, SkyDeg { ra: 90.0, dec: 10.0 }, 5.0, 10_000, "r=5.0 grid path");
    check(&grid, &ra, &dec, SkyDeg { ra: 90.0, dec: 10.0 }, 5.001, 10_000, "r=5.001 fallback");
    check(&grid, &ra, &dec, SkyDeg { ra: 90.0, dec: 10.0 }, 12.0, 200, "r=12 fallback k");
    check(&grid, &ra, &dec, SkyDeg { ra: 0.0, dec: -90.0 }, 179.9, 25_000, "hemisphere+");
}

#[test]
fn k_zero_and_empty_results() {
    let (ra, dec) = synthetic_catalog();
    let grid = StarGrid::build(StarsView { ra_deg: &ra, dec_deg: &dec });
    let mut out = vec![99u32; 3];
    grid.brightest_in_cone(
        StarsView { ra_deg: &ra, dec_deg: &dec },
        SkyDeg { ra: 10.0, dec: 10.0 },
        1.0,
        0,
        &mut out,
    );
    assert!(out.is_empty(), "k=0 must clear+return empty");
    // a cone with (almost surely) nothing in it: tiny radius at an empty spot
    check(&grid, &ra, &dec, SkyDeg { ra: 271.234, dec: -12.345 }, 1e-7, 10, "empty cone");
}

#[test]
fn output_is_ascending_row_ids() {
    let (ra, dec) = synthetic_catalog();
    let grid = StarGrid::build(StarsView { ra_deg: &ra, dec_deg: &dec });
    let mut out = Vec::new();
    grid.brightest_in_cone(
        StarsView { ra_deg: &ra, dec_deg: &dec },
        SkyDeg { ra: 180.0, dec: 45.0 },
        2.0,
        10_000,
        &mut out,
    );
    assert!(!out.is_empty());
    assert!(
        out.windows(2).all(|w| w[0] < w[1]),
        "rows must be strictly ascending (brightness order by contract)"
    );
}
