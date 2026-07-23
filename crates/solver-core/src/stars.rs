//! Star spatial grid: dec-ring (0.5°) × RA-bucket CSR over the brightness-sorted star table.
//!
//! Build = 2-pass counting sort scattering star rows IN ROW ORDER ⇒ every cell list is
//! ascending row id = brightness-sorted for free (stars.arrow rows are g-ascending).
//!
//! Query `brightest_in_cone`: wrap-aware RA ranges with a PROVEN-conservative per-ring RA
//! extent bound (see geometry notes below), pole-containing circles degrade to full-RA rings,
//! exact fully-inside vs boundary cell classification (boundary cells: per-star great-circle
//! test), k-way merge by row id (min-heap over cell cursors) ⇒ output ascending row id =
//! brightness order. Wide-field fallback (radius > 5°): brightness-order linear scan with
//! membership test, early exit at k.
//!
//! Geometry notes (safety proofs, sketched):
//! - Meridian-distance bound: for any point within angular distance r of center C,
//!   |sin Δα| · cos δ ≤ sin r  ⇒  sin Δα_true(δ) ≤ sin r / cos δ_worst for every δ in a ring
//!   (δ_worst = ring edge of max |δ|).
//! - Δα_true ≤ 90° whenever the circle does NOT contain a pole and sin r / cos δ_worst < 1:
//!   a cap point with RA offset > 90° forces colatitude(C) + colatitude(P) ≤ √2·r, which
//!   either puts the pole inside the cap (pole branch → full rings) or makes
//!   sin r / cos δ_worst ≥ 1 (full-ring branch). Hence Δα = asin(sin r / cos δ_worst) is a
//!   correct conservative per-ring bound; ±1 bucket expansion absorbs FP rounding.
//! - Fully-inside classification is EXACT: min over the cell of dot(star, center) =
//!   min over δ∈{lo,hi, interior critical point} of sinδ0·sinδ + cosδ0·cosδ·q, where q is the
//!   min of cos(RA offset) over the cell (−1 if the cell spans the antimeridian of C). The
//!   interior critical minimum (−R) is included, so wide polar cells are handled. A 1e-9
//!   cos-space margin pushes ambiguous cells to the boundary class (per-star exact test) —
//!   misclassification can only cost work, never correctness.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use solver_contracts::coordinates::{SkyDeg, UnitVec3};

/// Dec ring height in degrees.
pub const RING_HEIGHT_DEG: f64 = 0.5;
/// Radius above which the brightness-order linear-scan fallback is used.
pub const WIDE_RADIUS_DEG: f64 = 5.0;

const N_RINGS: u32 = (180.0 / RING_HEIGHT_DEG) as u32; // 360

/// Borrowed star coordinate columns (must be the SAME data the grid was built from).
#[derive(Clone, Copy)]
pub struct StarsView<'a> {
    pub ra_deg: &'a [f64],
    pub dec_deg: &'a [f64],
}

/// The single membership predicate — used by the grid query AND by brute-force references.
#[inline]
pub fn in_cone(ra_deg: f64, dec_deg: f64, center_unit: &UnitVec3, cos_radius: f64) -> bool {
    UnitVec3::from_sky(SkyDeg {
        ra: ra_deg,
        dec: dec_deg,
    })
    .dot(center_unit)
        >= cos_radius
}

/// CSR grid over dec rings × per-ring RA buckets.
pub struct StarGrid {
    n_stars: u32,
    /// Cell-index base per ring (len N_RINGS+1).
    ring_cell_base: Vec<u32>,
    /// RA bucket count per ring (len N_RINGS).
    ring_nbuckets: Vec<u32>,
    /// CSR offsets (len total_cells+1).
    cell_start: Vec<u32>,
    /// Star row ids, cell-grouped, ascending within each cell (len n_stars).
    star_rows: Vec<u32>,
}

#[inline]
fn ring_of(dec: f64) -> u32 {
    let r = ((dec + 90.0) / RING_HEIGHT_DEG).floor() as i64;
    r.clamp(0, (N_RINGS - 1) as i64) as u32
}

#[inline]
fn norm_ra(ra: f64) -> f64 {
    let mut x = ra % 360.0;
    if x < 0.0 {
        x += 360.0;
    }
    if x >= 360.0 {
        x = 0.0;
    }
    x
}

/// Wrap a degree offset into [-180, 180).
#[inline]
fn wrap_deg(d: f64) -> f64 {
    let mut x = d % 360.0;
    if x < -180.0 {
        x += 360.0;
    } else if x >= 180.0 {
        x -= 360.0;
    }
    x
}

impl StarGrid {
    /// Build from coordinate columns (degrees). ~2 passes, no trig.
    pub fn build(stars: StarsView<'_>) -> StarGrid {
        let n = stars.ra_deg.len();
        assert_eq!(n, stars.dec_deg.len(), "ra/dec column length mismatch");
        assert!(n <= u32::MAX as usize, "star count exceeds u32");

        let mut ring_nbuckets = Vec::with_capacity(N_RINGS as usize);
        let mut ring_cell_base = Vec::with_capacity(N_RINGS as usize + 1);
        let mut base: u32 = 0;
        for r in 0..N_RINGS {
            ring_cell_base.push(base);
            let dec_mid = -90.0 + (r as f64 + 0.5) * RING_HEIGHT_DEG;
            let nb = (360.0 * dec_mid.to_radians().cos() / RING_HEIGHT_DEG).round();
            let nb = if nb < 1.0 { 1u32 } else { nb as u32 };
            ring_nbuckets.push(nb);
            base += nb;
        }
        ring_cell_base.push(base);
        let total_cells = base as usize;

        // pass 1: cell of every star + counts
        let mut cell_of = vec![0u32; n];
        let mut counts = vec![0u32; total_cells];
        for i in 0..n {
            let dec = stars.dec_deg[i];
            let ra = stars.ra_deg[i];
            assert!(
                dec.is_finite() && ra.is_finite(),
                "non-finite star coordinate at row {i}"
            );
            let ring = ring_of(dec);
            let nb = ring_nbuckets[ring as usize];
            let mut b = (norm_ra(ra) / 360.0 * nb as f64).floor() as u32;
            if b >= nb {
                b = nb - 1;
            }
            let cell = ring_cell_base[ring as usize] + b;
            cell_of[i] = cell;
            counts[cell as usize] += 1;
        }

        // prefix sum
        let mut cell_start = vec![0u32; total_cells + 1];
        let mut acc: u32 = 0;
        for c in 0..total_cells {
            cell_start[c] = acc;
            acc += counts[c];
        }
        cell_start[total_cells] = acc;

        // pass 2: scatter in row order ⇒ ascending row ids per cell
        let mut cursor: Vec<u32> = cell_start[..total_cells].to_vec();
        let mut star_rows = vec![0u32; n];
        for i in 0..n {
            let c = cell_of[i] as usize;
            star_rows[cursor[c] as usize] = i as u32;
            cursor[c] += 1;
        }

        StarGrid {
            n_stars: n as u32,
            ring_cell_base,
            ring_nbuckets,
            cell_start,
            star_rows,
        }
    }

    #[inline]
    fn bucket_of(&self, ring: u32, ra: f64) -> u32 {
        let nb = self.ring_nbuckets[ring as usize];
        let mut b = (norm_ra(ra) / 360.0 * nb as f64).floor() as u32;
        if b >= nb {
            b = nb - 1;
        }
        b
    }

    /// Exact minimum of dot(star, center) over the cell [ra1, ra2]×[dec_lo, dec_hi].
    fn cell_min_dot(
        sin_d0: f64,
        cos_d0: f64,
        center_ra: f64,
        dec_lo: f64,
        dec_hi: f64,
        ra1: f64,
        ra2: f64,
    ) -> f64 {
        // q = min over the cell's RA range of cos(alpha - center_ra)
        let t = norm_ra(center_ra + 180.0);
        let contains_antimeridian = ra1 <= t && t <= ra2;
        let q = if contains_antimeridian {
            -1.0
        } else {
            let c1 = wrap_deg(ra1 - center_ra).to_radians().cos();
            let c2 = wrap_deg(ra2 - center_ra).to_radians().cos();
            c1.min(c2)
        };
        let a = sin_d0;
        let b = cos_d0 * q;
        let f = |dec: f64| {
            let (s, c) = dec.to_radians().sin_cos();
            a * s + b * c
        };
        let mut m = f(dec_lo).min(f(dec_hi));
        // interior critical minimum: (sin d, cos d) ∝ -(a, b); valid iff cos d >= 0
        let r = (a * a + b * b).sqrt();
        if r > 0.0 && -b >= 0.0 {
            let dm = (-a).atan2(-b).to_degrees();
            if dm > dec_lo && dm < dec_hi {
                m = m.min(-r);
            }
        }
        m
    }

    /// The k brightest catalog rows inside the cone, ascending row id (= brightness order,
    /// stars.arrow contract). `stars` MUST be the columns the grid was built from.
    pub fn brightest_in_cone(
        &self,
        stars: StarsView<'_>,
        center: SkyDeg,
        radius_deg: f64,
        k: usize,
        out: &mut Vec<u32>,
    ) {
        out.clear();
        if k == 0 || self.n_stars == 0 {
            return;
        }
        assert_eq!(
            stars.ra_deg.len(),
            self.n_stars as usize,
            "stars view does not match grid"
        );
        let radius = radius_deg.clamp(0.0, 180.0);
        let c_unit = UnitVec3::from_sky(center);
        let cos_r = radius.to_radians().cos();

        // Wide-field fallback: brightness-order linear scan with membership test.
        if radius > WIDE_RADIUS_DEG {
            for row in 0..self.n_stars {
                if in_cone(
                    stars.ra_deg[row as usize],
                    stars.dec_deg[row as usize],
                    &c_unit,
                    cos_r,
                ) {
                    out.push(row);
                    if out.len() == k {
                        return;
                    }
                }
            }
            return;
        }

        let (sin_d0, cos_d0) = center.dec.to_radians().sin_cos();
        let sin_r = radius.to_radians().sin();
        let dec_min = center.dec - radius;
        let dec_max = center.dec + radius;
        // Pole-containing circles degrade to full-RA rings.
        let pole = dec_max >= 90.0 || dec_min <= -90.0;
        let r0 = ring_of(dec_min.max(-90.0));
        let r1 = ring_of(dec_max.min(90.0));

        struct Cursor {
            pos: u32,
            end: u32,
            boundary: bool,
        }
        let mut cursors: Vec<Cursor> = Vec::new();

        let add_cell = |cursors: &mut Vec<Cursor>, ring: u32, bucket: u32| {
            let nb = self.ring_nbuckets[ring as usize];
            let cell = (self.ring_cell_base[ring as usize] + bucket) as usize;
            let start = self.cell_start[cell];
            let end = self.cell_start[cell + 1];
            if start == end {
                return;
            }
            let dec_lo = -90.0 + ring as f64 * RING_HEIGHT_DEG;
            let dec_hi = dec_lo + RING_HEIGHT_DEG;
            let width = 360.0 / nb as f64;
            let ra1 = bucket as f64 * width;
            let ra2 = ra1 + width;
            let min_dot =
                Self::cell_min_dot(sin_d0, cos_d0, center.ra, dec_lo, dec_hi, ra1, ra2);
            let fully_inside = min_dot >= cos_r + 1e-9;
            cursors.push(Cursor {
                pos: start,
                end,
                boundary: !fully_inside,
            });
        };

        for ring in r0..=r1 {
            let dec_lo = -90.0 + ring as f64 * RING_HEIGHT_DEG;
            let dec_hi = dec_lo + RING_HEIGHT_DEG;
            let nb = self.ring_nbuckets[ring as usize];

            // conservative per-ring RA extent (see module geometry notes)
            let cos_worst = dec_lo.abs().max(dec_hi.abs()).to_radians().cos();
            let full_ring = pole || cos_worst <= sin_r;
            if full_ring || nb <= 3 {
                for b in 0..nb {
                    add_cell(&mut cursors, ring, b);
                }
                continue;
            }
            let d_alpha = (sin_r / cos_worst).asin().to_degrees();
            let b_lo = self.bucket_of(ring, center.ra - d_alpha);
            let b_hi = self.bucket_of(ring, center.ra + d_alpha);
            // ±1 bucket expansion absorbs FP rounding at bucket edges
            let span = ((b_hi + nb - b_lo) % nb) + 3;
            if span >= nb {
                for b in 0..nb {
                    add_cell(&mut cursors, ring, b);
                }
                continue;
            }
            let mut b = (b_lo + nb - 1) % nb;
            for _ in 0..span {
                add_cell(&mut cursors, ring, b);
                b = (b + 1) % nb;
            }
        }

        // Advance a cursor to its next qualifying star row (boundary cells: exact test).
        let advance = |cur: &mut Cursor| -> Option<u32> {
            while cur.pos < cur.end {
                let row = self.star_rows[cur.pos as usize];
                cur.pos += 1;
                if !cur.boundary
                    || in_cone(
                        stars.ra_deg[row as usize],
                        stars.dec_deg[row as usize],
                        &c_unit,
                        cos_r,
                    )
                {
                    return Some(row);
                }
            }
            None
        };

        // k-way merge by row id: min-heap over cell cursors ⇒ globally ascending row ids.
        let mut heap: BinaryHeap<Reverse<(u32, u32)>> = BinaryHeap::with_capacity(cursors.len());
        for (ci, cur) in cursors.iter_mut().enumerate() {
            if let Some(row) = advance(cur) {
                heap.push(Reverse((row, ci as u32)));
            }
        }
        while let Some(Reverse((row, ci))) = heap.pop() {
            out.push(row);
            if out.len() == k {
                return;
            }
            if let Some(next) = advance(&mut cursors[ci as usize]) {
                heap.push(Reverse((next, ci)));
            }
        }
    }
}
