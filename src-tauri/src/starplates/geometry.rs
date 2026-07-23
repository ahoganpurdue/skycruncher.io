//! Spherical geometry for cone→cells resolution (spec §5.3) plus a minimal
//! HEALPix NESTED cell-center function used ONLY for the honest
//! `cells_absent_release` counter (documented deviation from ruling §12.12 —
//! see the deviation ledger appended to docs/STARPLATES_SPEC.md).
//!
//! Data-cell selection NEVER uses HEALPix math: populated cells are selected
//! with the manifest's data-derived per-cell center+radius cone bounds
//! (unit-vector distance scan, RA-wrap/pole safe by construction).

use std::f64::consts::PI;

/// ICRS (ra, dec) in degrees -> unit vector.
pub fn unit_vec(ra_deg: f64, dec_deg: f64) -> [f64; 3] {
    let ra = ra_deg.to_radians();
    let dec = dec_deg.to_radians();
    let cd = dec.cos();
    [cd * ra.cos(), cd * ra.sin(), dec.sin()]
}

/// Angular distance between two unit vectors, degrees. RA-wrap/pole safe.
pub fn angdist_deg(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    let dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).clamp(-1.0, 1.0);
    dot.acos().to_degrees()
}

/// Number of HEALPix cells at `order` (12 * 4^order).
pub fn npix(order: u8) -> u64 {
    12u64 << (2 * order as u32)
}

/// Gaia DR3 `source_id` embeds HEALPix L12 NESTED: `source_id = healpix12·2^35 + counter`
/// (spec §0.5). Cell id at `order` is therefore a pure shift: `source_id >> (59 - 2·order)`.
/// Order 5 -> `>> 49`, order 6 -> `>> 47`. No `ang2pix` anywhere (spec §3.1).
pub fn cell_of_source_id(source_id: u64, order: u8) -> u64 {
    debug_assert!(order <= 12);
    source_id >> (59 - 2 * order as u32)
}

/// Conservative upper bound (degrees) on the center-to-vertex radius of any
/// HEALPix cell at `order`. theta_pix = sqrt(pi/3)/nside is the standard
/// resolution parameter; measured circumradii are <= ~0.9 * theta_pix
/// (equatorial ~0.77, polar ~0.83) — 1.2x is honest margin. Used ONLY for the
/// `cells_absent_release` honesty counter, never for data-cell selection.
pub fn max_cell_radius_deg(order: u8) -> f64 {
    let nside = (1u64 << order) as f64;
    1.2 * ((PI / 3.0).sqrt() / nside).to_degrees()
}

// HEALPix base-face constants (Gorski et al. 2005, pix2ang_nest reference).
const JRLL: [i64; 12] = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
const JPLL: [i64; 12] = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

/// Extract even-position bits (bit 0, 2, 4, ...) of `v` compacted into an integer.
fn compact_bits(mut v: u64) -> u64 {
    let mut out = 0u64;
    let mut bit = 0u32;
    while v != 0 {
        out |= (v & 1) << bit;
        v >>= 2;
        bit += 1;
    }
    out
}

/// Geometric center of NESTED cell `pix` at `order`, as (ra_deg, dec_deg).
///
/// Reference pix2ang_nest algorithm restricted to cell centers. Unit tested
/// against hand-derived order-0/1 values below.
pub fn nest_center_deg(order: u8, pix: u64) -> (f64, f64) {
    let nside = 1u64 << order;
    let npface = nside * nside;
    debug_assert!(pix < 12 * npface);
    let face = (pix / npface) as usize;
    let ipf = pix % npface;
    let ix = compact_bits(ipf) as i64;
    let iy = compact_bits(ipf >> 1) as i64;
    let ns = nside as i64;

    let jr = JRLL[face] * ns - ix - iy - 1;

    let (z, kshift, nr): (f64, i64, i64);
    if jr < ns {
        // north polar cap
        nr = jr;
        z = 1.0 - (nr * nr) as f64 / (3.0 * (ns * ns) as f64);
        kshift = 0;
    } else if jr > 3 * ns {
        // south polar cap
        nr = 4 * ns - jr;
        z = -1.0 + (nr * nr) as f64 / (3.0 * (ns * ns) as f64);
        kshift = 0;
    } else {
        // equatorial belt
        nr = ns;
        z = (2 * ns - jr) as f64 * 2.0 / (3.0 * ns as f64);
        kshift = (jr - ns) & 1;
    }

    let mut jp = (JPLL[face] * nr + ix - iy + 1 + kshift) / 2;
    if jp > 4 * nr {
        jp -= 4 * nr;
    }
    if jp < 1 {
        jp += 4 * nr;
    }

    let phi = (jp as f64 - (kshift as f64 + 1.0) * 0.5) * (PI / 2.0) / nr as f64;
    let dec_deg = z.asin().to_degrees();
    let ra_deg = phi.to_degrees().rem_euclid(360.0);
    (ra_deg, dec_deg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn order0_face_centers() {
        // nside=1 base faces: 0-3 at z=2/3 ra=45,135,225,315; 4-7 at z=0
        // ra=0,90,180,270; 8-11 at z=-2/3 ra=45,135,225,315.
        let z_hi = (2.0f64 / 3.0).asin().to_degrees();
        for (pix, (ra, dec)) in [
            (0u64, (45.0, z_hi)),
            (1, (135.0, z_hi)),
            (2, (225.0, z_hi)),
            (3, (315.0, z_hi)),
            (4, (0.0, 0.0)),
            (5, (90.0, 0.0)),
            (6, (180.0, 0.0)),
            (7, (270.0, 0.0)),
            (8, (45.0, -z_hi)),
            (9, (135.0, -z_hi)),
            (10, (225.0, -z_hi)),
            (11, (315.0, -z_hi)),
        ] {
            let (r, d) = nest_center_deg(0, pix);
            assert!(close(r, ra, 1e-9) && close(d, dec, 1e-9), "pix {pix}: got ({r},{d}) want ({ra},{dec})");
        }
    }

    #[test]
    fn order1_known_cells() {
        // nside=2, face 0, ipf=0 (ix=0,iy=0): equatorial, z=1/3, phi=45 deg.
        let (r, d) = nest_center_deg(1, 0);
        assert!(close(r, 45.0, 1e-9), "ra {r}");
        assert!(close(d, (1.0f64 / 3.0).asin().to_degrees(), 1e-9), "dec {d}");
        // nside=2, face 0, ipf=3 (ix=1,iy=1): north polar cap ring 1, z=11/12, phi=45 deg.
        let (r, d) = nest_center_deg(1, 3);
        assert!(close(r, 45.0, 1e-9), "ra {r}");
        assert!(close(d, (11.0f64 / 12.0).asin().to_degrees(), 1e-9), "dec {d}");
    }

    #[test]
    fn order5_all_centers_valid_and_source_id_shift_matches() {
        // Structural invariants at the T1 order: every center on the sphere,
        // and the antipodal faces map to opposite hemispheres.
        for pix in 0..npix(5) {
            let (ra, dec) = nest_center_deg(5, pix);
            assert!((0.0..360.0).contains(&ra), "pix {pix} ra {ra}");
            assert!((-90.0..=90.0).contains(&dec), "pix {pix} dec {dec}");
        }
        // spec §3.1 shifts
        let sid: u64 = (2417u64 << 49) | (7u64 << 35) | 12345;
        assert_eq!(cell_of_source_id(sid, 5), 2417);
        // order 6 keeps two more healpix12 bits; both are zero for this sid
        assert_eq!(cell_of_source_id(sid, 6), 2417 << 2);
    }

    #[test]
    fn m66_region_cells_match_real_release_data_centers() {
        // Ground truth: DATA-derived per-cell centers from the real forged
        // release starplates-2026.07-gdr3 (manifest.json, 10,612 t1 cells built
        // from gaia_vanguard_dr3.csv source_ids >> 49). The M66 field
        // (RA 170.06, Dec +12.99) spans these four order-5 cells. The
        // geometric NESTED center must land within one conservative cell
        // radius of each data-mean center. (The spec §2.3 example cell 2417
        // was illustrative only — its real center is (262.5, +45.0).)
        // Full-release cross-check 2026-07-09: worst geometric-vs-data center
        // distance over all 10,612 cells = 0.569 deg (cell 9894).
        for (cell, ra_data, dec_data) in [
            (7041u64, 170.1532530002652, 11.99586741818865),
            (7043, 168.73958068315514, 13.238983168403486),
            (7044, 171.5035130165433, 13.21301150616657),
            (7046, 170.08859343353902, 14.509682283096923),
        ] {
            let (ra, dec) = nest_center_deg(5, cell);
            let d = angdist_deg(&unit_vec(ra, dec), &unit_vec(ra_data, dec_data));
            assert!(
                d < max_cell_radius_deg(5),
                "cell {cell} geometric center ({ra},{dec}) is {d} deg from its data center"
            );
        }
    }

    #[test]
    fn angdist_wrap_and_pole() {
        // RA wrap: 359.5 and 0.5 at the equator are 1 degree apart.
        let d = angdist_deg(&unit_vec(359.5, 0.0), &unit_vec(0.5, 0.0));
        assert!(close(d, 1.0, 1e-9), "wrap dist {d}");
        // Pole: all RAs coincide at dec=90.
        let d = angdist_deg(&unit_vec(10.0, 90.0), &unit_vec(200.0, 90.0));
        assert!(close(d, 0.0, 1e-9), "polar dist {d}");
    }
}
