//! M1 real-release gates (env-gated: SOLVER_TEST_RELEASE_DIR, default = the g15u release on
//! D:; skips with a message when absent):
//!   - full open + validate: counts == manifest (6,491,802 stars; per-band nQuads;
//!     20,962,625 total quads); Full → Stamp verification roundtrip incl. the builder's
//!     aggregate md5 (c6ce0418…) recomputed byte-for-byte.
//!   - spot-decode 100 random rows per band; both access paths bit-identical; code_key
//!     re-derived from the stored code columns (f32→f64 widening; near-bin-edge rounding
//!     allowance, since the builder keyed the f64 code before f32 storage).
//!   - DIFFERENTIAL LOOKUP GATE: 10,000 seeded keys per band (present samples + uniform
//!     absents + bucket-edge specials incl. 0, 2^28-1, i32::MAX, -1): prefix-table lookup ==
//!     brute linear scan of the sorted column. Zero mismatches.
//!   - probe-block sweep == direct lookups.
//!   - star grid on the real catalog: cone at (207.1549, -59.6731) r=2° == brute force,
//!     ascending rows, g-ascending.
//!   - manifest mutation loud-refusals.

use std::path::PathBuf;
use std::time::Instant;

use solver_contracts::config::ReleaseVerifyMode;
use solver_contracts::coordinates::{SkyDeg, UnitVec3};
use solver_core::index::band::KEY_SPACE;
use solver_core::index::probe::ProbeBlock;
use solver_core::index::QuadIndex;
use solver_core::stars::{in_cone, StarGrid, StarsView};

const DEFAULT_RELEASE: &str =
    "D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u";
const G15U_NAME: &str = "starplates-2026.07-quadidx-g15u";
const G15U_STARS: u64 = 6_491_802;
const G15U_QUADS: u64 = 20_962_625;
const G15U_AGG_MD5: &str = "c6ce0418da091fda89a706be0da3d25d";

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
}

fn release_dir() -> Option<PathBuf> {
    let d = std::env::var("SOLVER_TEST_RELEASE_DIR").unwrap_or_else(|_| DEFAULT_RELEASE.into());
    let p = PathBuf::from(d);
    if p.join("manifest.json").exists() {
        Some(p)
    } else {
        None
    }
}

/// Builder's codeBin: clamp(floor((v - CODE_LO)/(CODE_HI - CODE_LO) * nbins), 0, nbins-1).
fn code_bin(v: f64) -> i32 {
    let b = (((v + 0.5) / 2.0) * 128.0).floor();
    (b as i64).clamp(0, 127) as i32
}

fn recompute_key(code: [f32; 4]) -> i32 {
    let b0 = code_bin(code[0] as f64);
    let b1 = code_bin(code[1] as f64);
    let b2 = code_bin(code[2] as f64);
    let b3 = code_bin(code[3] as f64);
    ((b0 * 128 + b1) * 128 + b2) * 128 + b3
}

fn decompose_key(key: i32) -> [i32; 4] {
    let k = key;
    [k >> 21 & 127, k >> 14 & 127, k >> 7 & 127, k & 127]
}

/// The builder keyed the f64 code; storage rounds to f32. A stored-vs-recomputed bin may
/// legitimately differ by one when the component sits within f32 rounding of a bin edge.
fn near_bin_edge(v: f32) -> bool {
    let vf = v as f64;
    let t = ((vf + 0.5) / 2.0) * 128.0;
    let dist_to_edge = (t - t.round()).abs();
    // a few f32 ulps of v, expressed in bin units (64 bins per unit of v)
    let ulp_bins = (vf.abs() + 0.5) * (f32::EPSILON as f64) * 64.0 * 4.0;
    dist_to_edge <= ulp_bins
}

#[test]
fn m1_release_gates() {
    let Some(dir) = release_dir() else {
        eprintln!("SKIP m1_release_gates: release not found (set SOLVER_TEST_RELEASE_DIR)");
        return;
    };
    let stamp_dir = std::env::temp_dir().join("skycruncher_m1_release_stamps");

    // ── gate 1: Full-verified open (streams + checksums every byte; writes stamp) ──
    let t = Instant::now();
    let idx_full = QuadIndex::open(&dir, ReleaseVerifyMode::Full, Some(&stamp_dir), true)
        .expect("Full-verified open");
    eprintln!(
        "[m1] Full open: total {} ms (verify {} ms, parse {} ms)",
        t.elapsed().as_millis(),
        idx_full.open_stats.verify_ms,
        idx_full.open_stats.parse_ms
    );
    drop(idx_full);

    // ── gate 2: Stamp-verified open (the warm production path) + prefetch pass ──
    let t = Instant::now();
    let mut idx = QuadIndex::open(&dir, ReleaseVerifyMode::Stamp, Some(&stamp_dir), true)
        .expect("Stamp-verified open");
    eprintln!(
        "[m1] Stamp open: total {} ms (verify {} ms, prefetch {} ms, parse {} ms)",
        t.elapsed().as_millis(),
        idx.open_stats.verify_ms,
        idx.open_stats.prefetch_ms,
        idx.open_stats.parse_ms
    );

    // ── gate 3: counts == manifest (+ hard release-identity pins for THE g15u release) ──
    assert_eq!(idx.stars.n_rows, idx.manifest.stars.rows);
    let quad_sum: u64 = idx.bands.iter().map(|b| b.n_quads).sum();
    assert_eq!(quad_sum, idx.manifest.totals.quads);
    for (b, blob) in idx.bands.iter().zip(idx.manifest.bands.iter()) {
        assert_eq!(b.view.n_rows, blob.n_quads, "band {} row count", b.index);
    }
    if idx.manifest.release == G15U_NAME {
        assert_eq!(idx.stars.n_rows, G15U_STARS, "g15u star count pin");
        assert_eq!(quad_sum, G15U_QUADS, "g15u quad count pin");
        assert_eq!(idx.manifest.aggregate_md5, G15U_AGG_MD5, "g15u aggregate md5 pin");
    }

    // brightness-rank contract: g_mag non-decreasing (10k random adjacent pairs + endpoints)
    {
        let g = idx.stars.gmag.as_ref();
        let mut rng = Rng(0x5747_4152_5335);
        for _ in 0..10_000 {
            let i = (rng.next() % (idx.stars.n_rows - 1)) as usize;
            assert!(
                g[i] <= g[i + 1],
                "g_mag sort violation at rows {i}/{}: {} > {}",
                i + 1,
                g[i],
                g[i + 1]
            );
        }
        assert!(g[0] <= g[g.len() - 1]);
    }

    // ── gate 4: prefix tables for all bands (prepare-phase, explicit) ──
    let all: Vec<u32> = (0..idx.bands.len() as u32).collect();
    let t = Instant::now();
    idx.build_prefix_tables(&all).expect("prefix build");
    eprintln!("[m1] prefix tables (15 bands): {} ms", t.elapsed().as_millis());

    // ── gate 5: spot-decode 100 random rows per band, both access paths, key re-derivation ──
    let mut rng = Rng(0xB1A5_ED00_57A7);
    let mut edge_allowances = 0u32;
    for band in &idx.bands {
        let n = band.view.n_rows;
        if n == 0 {
            continue;
        }
        for _ in 0..100 {
            let r = rng.next() % n;
            let a = band.view.quad_at(r); // path A: batch-addressed view
            let b = band.rows(r, 1).next().expect("row iter"); // path B: range iterator
            assert_eq!(a.code.map(f32::to_bits), b.code.map(f32::to_bits));
            assert_eq!(a.star, b.star);
            assert_eq!(a.diam_deg.to_bits(), b.diam_deg.to_bits());
            assert_eq!(a.code_key, b.code_key);

            for s in a.star {
                assert!((s as u64) < idx.stars.n_rows, "band {} row {r}: star ref {s} out of range", band.index);
            }
            assert!(a.diam_deg.is_finite() && a.diam_deg > 0.0);

            let rk = recompute_key(a.code);
            if rk != a.code_key {
                // allowed ONLY for f32-rounding at a bin edge, one bin step per component
                edge_allowances += 1;
                let got = decompose_key(rk);
                let want = decompose_key(a.code_key);
                for c in 0..4 {
                    if got[c] != want[c] {
                        assert!(
                            (got[c] - want[c]).abs() == 1 && near_bin_edge(a.code[c]),
                            "band {} row {r}: key {} != stored {} (component {c}: bin {} vs {}, code {}, not a bin-edge rounding case)",
                            band.index,
                            rk,
                            a.code_key,
                            got[c],
                            want[c],
                            a.code[c]
                        );
                    }
                }
            }
        }
    }
    eprintln!(
        "[m1] spot-decode 100 rows/band: PASS ({edge_allowances}/1500 f32 bin-edge allowances)"
    );

    // ── gate 6: DIFFERENTIAL LOOKUP — 10k seeded keys/band, prefix path == brute scan ──
    let t = Instant::now();
    let mut total_keys = 0usize;
    for band in &idx.bands {
        let n = band.view.n_rows;
        let mut keys: Vec<i32> = vec![-1, 0, 1, (KEY_SPACE - 1) as i32, i32::MAX];
        if n > 0 {
            let first = band.view.key_at(0);
            let last = band.view.key_at(n - 1);
            keys.extend_from_slice(&[first, last, first.saturating_sub(1), last.saturating_add(1)]);
            // 5000 present keys sampled from the column (+ their bucket-edge companions)
            for i in 0..5000u32 {
                let k = band.view.key_at(rng.next() % n);
                keys.push(k);
                if i % 10 == 0 {
                    keys.push(k & !0xFFF); // bucket floor
                    keys.push((k | 0xFFF).min((KEY_SPACE - 1) as i32)); // bucket ceiling
                }
            }
        }
        // absents (uniform over key space) up to 10k
        while keys.len() < 10_000 {
            keys.push((rng.next() % KEY_SPACE as u64) as i32);
        }
        total_keys += keys.len();
        keys.sort_unstable();
        keys.dedup();

        // brute: single resumable linear pass over the sorted column
        let mut row: u64 = 0;
        let mut mismatches = 0u32;
        for &k in &keys {
            while row < n && band.view.key_at(row) < k {
                row += 1;
            }
            let start = row;
            let mut end = row;
            while end < n && band.view.key_at(end) == k {
                end += 1;
            }
            let brute = (start, (end - start) as u32);
            let got = band.lookup(k);
            if got != brute {
                mismatches += 1;
                eprintln!(
                    "[m1] band {} key {k}: lookup {:?} != brute {:?}",
                    band.index, got, brute
                );
            }
            row = end;
        }
        assert_eq!(mismatches, 0, "band {} differential lookup mismatches", band.index);
    }
    eprintln!(
        "[m1] differential lookup: {} keys across 15 bands, 0 mismatches, {} ms",
        total_keys,
        t.elapsed().as_millis()
    );

    // ── gate 7: probe-block sweep == direct lookups ──
    {
        let band = &idx.bands[2];
        let n = band.view.n_rows;
        let mut pb = ProbeBlock::with_capacity(256);
        let mut slot_keys: Vec<i32> = Vec::new();
        for i in 0..200u32 {
            let k = if i % 4 == 3 {
                (rng.next() % KEY_SPACE as u64) as i32 // mostly-absent
            } else {
                band.view.key_at(rng.next() % n) // present
            };
            pb.push(k, i);
            slot_keys.push(k);
        }
        pb.sort();
        let mut seen = vec![false; slot_keys.len()];
        pb.sweep(band, |slot, rs, rc| {
            let direct = band.lookup(slot_keys[slot as usize]);
            assert_eq!((rs, rc), direct, "probe sweep vs direct lookup, slot {slot}");
            seen[slot as usize] = true;
        });
        assert!(seen.iter().all(|&s| s), "sweep must visit every probe");
    }
    eprintln!("[m1] probe sweep: PASS");

    // ── gate 8: star grid on the real catalog + cone smoke vs brute force ──
    let sv = StarsView {
        ra_deg: idx.stars.ra.as_ref(),
        dec_deg: idx.stars.dec.as_ref(),
    };
    let t = Instant::now();
    let grid = StarGrid::build(sv);
    eprintln!("[m1] star grid build (6.49M rows): {} ms", t.elapsed().as_millis());

    let center = SkyDeg {
        ra: 207.1549,
        dec: -59.6731,
    };
    let radius = 2.0;
    let k = 300;
    let t = Instant::now();
    let mut got = Vec::new();
    grid.brightest_in_cone(sv, center, radius, k, &mut got);
    let q_ms = t.elapsed().as_millis();

    let c_unit = UnitVec3::from_sky(center);
    let cos_r = radius.to_radians().cos();
    let mut expect = Vec::new();
    for i in 0..sv.ra_deg.len() {
        if in_cone(sv.ra_deg[i], sv.dec_deg[i], &c_unit, cos_r) {
            expect.push(i as u32);
            if expect.len() == k {
                break;
            }
        }
    }
    assert_eq!(got, expect, "real-release cone smoke vs brute");
    assert!(!got.is_empty(), "CSM30799-field cone must contain stars");
    assert!(got.windows(2).all(|w| w[0] < w[1]), "ascending rows");
    let g = idx.stars.gmag.as_ref();
    assert!(
        got.windows(2).all(|w| g[w[0] as usize] <= g[w[1] as usize]),
        "g-ascending rows"
    );
    eprintln!(
        "[m1] cone smoke (207.1549, -59.6731) r=2°: {} rows in {} ms, g {:.2}..{:.2}: PASS",
        got.len(),
        q_ms,
        g[got[0] as usize],
        g[*got.last().unwrap() as usize]
    );

    // ── gate 9: manifest mutation loud-refusals ──
    {
        let m0 = &idx.manifest;
        let mut m = m0.clone();
        m.format_version = 2;
        assert!(m.validate().is_err(), "format_version mutation must refuse");
        let mut m = m0.clone();
        m.bands.pop();
        assert!(m.validate().is_err(), "14-band mutation must refuse");
        let mut m = m0.clone();
        m.schema.nbins = 64;
        assert!(m.validate().is_err(), "nbins mutation must refuse");
        let mut m = m0.clone();
        m.totals.quads += 1;
        assert!(m.validate().is_err(), "totals mutation must refuse");
        let mut m = m0.clone();
        if m.bands[0].batches.len() > 1 {
            m.bands[0].batches[1].row_start += 1;
            assert!(m.validate().is_err(), "batch contiguity mutation must refuse");
        }
        let mut m = m0.clone();
        m.stars.sha256 = "zz".repeat(32);
        assert!(m.validate().is_err(), "non-hex sha mutation must refuse");
        idx.manifest.validate().expect("unmutated manifest still validates");
    }
    eprintln!("[m1] manifest loud-refusals: PASS");
}
