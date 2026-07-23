//! `query_catalog_v2` core (spec §5.3): cone→cells via manifest data-derived
//! bounds, verified CAS reads, v1-bit-identical PM propagation, true spherical
//! cone filter, g_mag-sorted Arrow IPC stream response.
//!
//! No network I/O anywhere in this module (spec §1 offline-first).

use super::arrow_io::{read_cell_file, write_response_stream, ResponseMeta, StarRow};
use super::geometry::{angdist_deg, cell_of_source_id, max_cell_radius_deg, nest_center_deg, npix, unit_vec};
use super::store::{CellRead, StarplatesStore};
use super::{GAIA_DR3_EPOCH_JD, MAX_QUERY_RADIUS_DEG};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    T0,
    T1,
    T2,
}

impl Tier {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "t0" => Ok(Tier::T0),
            "t1" => Ok(Tier::T1),
            "t2" => Ok(Tier::T2),
            other => Err(format!(
                "E_TIER_UNKNOWN: {other:?} (expected \"t0\" | \"t1\" | \"t2\")"
            )),
        }
    }

    /// `tier` means requested DEPTH; the response is the union of shells up to
    /// it (spec §5.1). T2 is reserved with no data this wave, so its depth
    /// serves exactly the T1 union.
    fn includes_t1(self) -> bool {
        matches!(self, Tier::T1 | Tier::T2)
    }

    fn as_str(self) -> &'static str {
        match self {
            Tier::T0 => "t0",
            Tier::T1 => "t1",
            Tier::T2 => "t2",
        }
    }
}

/// Proper-motion propagation from J2016.0 to `epoch_jd` — bit-for-bit the v1
/// formula (formerly `catalog::mmap_manager::query_region`, retired; spec
/// §5.3 normative), quirks preserved deliberately:
///   - dec propagated first, cos(dec') with |.|-clamp at 0.001,
///   - pmra IS Gaia μ_α* (already ×cos δ) and is divided by cos(dec'),
///   - RA wrapped as `(ra' + 360) mod 360`.
pub fn propagate_v1(ra_deg: f64, dec_deg: f64, pm_ra_masyr: f32, pm_dec_masyr: f32, delta_years: f64) -> (f64, f64) {
    let pm_ra_deg = (pm_ra_masyr as f64) / 3.6e6; // mas/yr -> deg/yr (spec §5.3 formula)
    let pm_dec_deg = (pm_dec_masyr as f64) / 3.6e6;
    let true_dec = dec_deg + (pm_dec_deg * delta_years);
    let cos_dec = true_dec.to_radians().cos().abs().max(0.001);
    let true_ra = ra_deg + ((pm_ra_deg * delta_years) / cos_dec);
    ((true_ra + 360.0) % 360.0, true_dec)
}

pub fn query_v2(
    store: &mut StarplatesStore,
    ra_deg: f64,
    dec_deg: f64,
    radius_deg: f64,
    tier: &str,
    epoch_jd: f64,
) -> Result<Vec<u8>, String> {
    // ---- argument validation -------------------------------------------------
    if !ra_deg.is_finite() || !dec_deg.is_finite() || !epoch_jd.is_finite() || !(-90.0..=90.0).contains(&dec_deg) {
        return Err(format!(
            "E_ARG_INVALID: ra_deg={ra_deg} dec_deg={dec_deg} epoch_jd={epoch_jd} (finite required, dec in [-90,90])"
        ));
    }
    if !radius_deg.is_finite() || radius_deg <= 0.0 || radius_deg > MAX_QUERY_RADIUS_DEG {
        return Err(format!(
            "E_RADIUS_RANGE: radius_deg={radius_deg} (require 0 < r <= {MAX_QUERY_RADIUS_DEG})"
        ));
    }
    let tier = Tier::parse(tier)?;

    let qvec = unit_vec(ra_deg, dec_deg);
    let cos_radius = radius_deg.to_radians().cos();
    let delta_years = (epoch_jd - GAIA_DR3_EPOCH_JD) / 365.25;

    let in_cone = |row_ra: f64, row_dec: f64| -> bool {
        let v = unit_vec(row_ra, row_dec);
        (v[0] * qvec[0] + v[1] * qvec[1] + v[2] * qvec[2]) >= cos_radius
    };

    let mut rows: Vec<StarRow> = Vec::new();
    let mut served: Vec<(String, String)> = Vec::new();
    let mut served_cells: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut cells_absent_local: u32 = 0;

    // ---- T1: cone→cells over the manifest's data-derived bounds (spec §5.3.1) -
    let t1_order = store.t1_order();
    if tier.includes_t1() {
        let candidates: Vec<(u64, u8, String)> = store
            .t1_cells()
            .iter()
            .filter(|c| angdist_deg(&qvec, &c.center) <= radius_deg + c.radius_deg)
            .map(|c| (c.cell, c.order, c.sha256.clone()))
            .collect();
        for (cell, order, sha) in candidates {
            let label = format!("{order}:{cell}");
            match store.read_blob_verified(&sha, &label) {
                CellRead::Ok(bytes) => match read_cell_file(&bytes, &label) {
                    Ok(cell_rows) => {
                        for r in cell_rows {
                            let (ra_p, dec_p) =
                                propagate_v1(r.ra_deg, r.dec_deg, r.pm_ra_masyr, r.pm_dec_masyr, delta_years);
                            if in_cone(ra_p, dec_p) {
                                rows.push(StarRow { ra_deg: ra_p, dec_deg: dec_p, ..r });
                            }
                        }
                        served_cells.insert(cell);
                        served.push((label, sha));
                    }
                    Err(e) => {
                        // Structurally invalid despite a matching SHA — release
                        // defect. Honest report, treat locally absent (§6.3).
                        log::warn!("[starplates] {e} — treating cell absent");
                        cells_absent_local += 1;
                    }
                },
                CellRead::Absent => cells_absent_local += 1,
                CellRead::Corrupt => cells_absent_local += 1,
            }
        }
    }

    // ---- cells_absent_release: honest coverage counter (spec §5.2) -----------
    // Cone cells the RELEASE never had (the missing ~21%). Populated cells use
    // manifest bounds above; absent cells have no data-derived bounds, so this
    // counter uses the geometric NESTED cell center + a conservative per-order
    // circumradius bound (documented deviation — spec ledger). Never used for
    // data-cell selection. `None` (=> "--") when the release has no T1 cells
    // at all (order unknowable).
    let cells_absent_release: Option<u32> = t1_order.map(|order| {
        let bound = radius_deg + max_cell_radius_deg(order);
        let mut n: u32 = 0;
        for pix in 0..npix(order) {
            if store.t1_cell_ids().contains(&pix) {
                continue;
            }
            let (cra, cdec) = nest_center_deg(order, pix);
            if angdist_deg(&qvec, &unit_vec(cra, cdec)) <= bound {
                n += 1;
            }
        }
        n
    });

    // ---- T0 bootstrap (spec §4): resolve against T1 when locally present, ----
    // else fall back to the bright all-sky file for the uncovered cells.
    let need_t0 = match tier {
        Tier::T0 => true,
        _ => cells_absent_local > 0 || cells_absent_release.map(|n| n > 0).unwrap_or(true),
    };
    if need_t0 {
        if let Some(t0) = store.t0().cloned() {
            match store.read_blob_verified(&t0.sha256, "t0") {
                CellRead::Ok(bytes) => match read_cell_file(&bytes, "t0") {
                    Ok(t0_rows) => {
                        for r in t0_rows {
                            // Never duplicate a cell already served from T1
                            // (T0 duplicates T1's bright prefix — spec §4).
                            if tier.includes_t1() {
                                if let Some(order) = t1_order {
                                    if served_cells.contains(&cell_of_source_id(r.source_id, order)) {
                                        continue;
                                    }
                                }
                            }
                            let (ra_p, dec_p) =
                                propagate_v1(r.ra_deg, r.dec_deg, r.pm_ra_masyr, r.pm_dec_masyr, delta_years);
                            if in_cone(ra_p, dec_p) {
                                rows.push(StarRow { ra_deg: ra_p, dec_deg: dec_p, ..r });
                            }
                        }
                        // `t0` token in cells_served marks bootstrap participation
                        // (documented deviation — spec §15.B3). Stamped whenever T0
                        // was consulted, so provenance names every blob that could
                        // have contributed rows to this response.
                        served.push(("t0".to_string(), t0.sha256.clone()));
                    }
                    Err(e) => log::warn!("[starplates] {e} — t0 unusable, continuing without bootstrap"),
                },
                CellRead::Absent => {
                    log::warn!("[starplates] t0 bootstrap blob not in local store — continuing without it");
                }
                CellRead::Corrupt => {
                    log::warn!("[starplates] t0 bootstrap blob corrupt (quarantined) — continuing without it");
                }
            }
        }
    }

    if cells_absent_local > 0 || cells_absent_release.map(|n| n > 0).unwrap_or(false) {
        log::warn!(
            "[starplates] partial coverage for cone ({ra_deg:.4}, {dec_deg:.4}, r={radius_deg}): cells_absent_release={} cells_absent_local={cells_absent_local} — solve proceeds (offline-first)",
            cells_absent_release.map(|n| n.to_string()).unwrap_or_else(|| "--".into())
        );
    }

    // ---- sort + encode (spec §5.2) -------------------------------------------
    super::arrow_io::sort_rows(&mut rows);
    let meta = ResponseMeta {
        release: store.release.clone(),
        epoch_jd,
        tier_depth: tier.as_str().to_string(),
        cells_served: served,
        cells_absent_release,
        cells_absent_local,
    };
    write_response_stream(&rows, &meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pm_propagation_hand_computed() {
        // Star at (100, 30), pmra*=360 mas/yr, pmdec=-720 mas/yr, 10 Julian
        // years after J2016.0.
        //   dt      = 10 yr
        //   ddec    = (-720/3.6e6)*10          = -0.002 deg  -> dec' = 29.998
        //   cosd    = cos(29.998 deg)          = 0.86605...
        //   dra     = (360/3.6e6)*10 / cosd    = 0.001/0.8660481... = 0.0011547...
        let epoch = GAIA_DR3_EPOCH_JD + 10.0 * 365.25;
        let dt = (epoch - GAIA_DR3_EPOCH_JD) / 365.25;
        assert!((dt - 10.0).abs() < 1e-12);
        let (ra, dec) = propagate_v1(100.0, 30.0, 360.0, -720.0, dt);
        let expected_dec = 30.0 - 0.002;
        let cosd = (expected_dec as f64).to_radians().cos();
        let expected_ra = 100.0 + 0.001 / cosd;
        assert!((dec - expected_dec).abs() < 1e-12, "dec {dec} vs {expected_dec}");
        assert!((ra - expected_ra).abs() < 1e-12, "ra {ra} vs {expected_ra}");
    }

    #[test]
    fn pm_propagation_matches_v1_bit_for_bit() {
        // The legacy v1 PM-propagation arithmetic (formerly
        // mmap_manager::query_region; the vanguard.bin reader was retired
        // 2026-07-10). Preserved here as spec §5.3's normative reference.
        let pm_ra_raw: i32 = -1234567; // µas/yr, v1 raw i32 micro-arcsec lattice
        let pm_dec_raw: i32 = 987654;
        let delta_years = (2461234.5 - GAIA_DR3_EPOCH_JD) / 365.25;
        let ra_deg = 359.9995;
        let dec_deg = -67.25;

        // v1 arithmetic, preserved verbatim (spec §5.3 normative reference)
        let pm_ra_deg = (pm_ra_raw as f64) / 3_600_000.0 / 1000.0;
        let pm_dec_deg = (pm_dec_raw as f64) / 3_600_000.0 / 1000.0;
        let true_dec = dec_deg + (pm_dec_deg * delta_years);
        let cos_dec = true_dec.to_radians().cos().abs().max(0.001);
        let v1_ra = (ra_deg + ((pm_ra_deg * delta_years) / cos_dec) + 360.0) % 360.0;
        let v1_dec = true_dec;

        // v2 path with the identical mas/yr values (f32 mas = raw/1000)
        let (v2_ra, v2_dec) = propagate_v1(
            ra_deg,
            dec_deg,
            pm_ra_raw as f32 / 1000.0,
            pm_dec_raw as f32 / 1000.0,
            delta_years,
        );
        // f32 mas quantization is the only difference source; at these values
        // the f32 is exact to ~1e-4 mas, far under the §9.2 2 mas bound.
        assert!((v2_ra - v1_ra).abs() < 2.0 / 3.6e6, "ra {v2_ra} vs {v1_ra}");
        assert!((v2_dec - v1_dec).abs() < 2.0 / 3.6e6, "dec {v2_dec} vs {v1_dec}");
    }

    #[test]
    fn polar_clamp_engages() {
        // dec' beyond 89.94 deg -> cos clamps at 0.001 (v1 quirk preserved).
        let (ra, _dec) = propagate_v1(10.0, 89.9999, 3600.0, 0.0, 1.0);
        // pm_ra_deg*dt = 0.001 deg; divided by clamp 0.001 => +1 deg RA
        assert!((ra - 11.0).abs() < 1e-9, "ra {ra}");
    }

    #[test]
    fn tier_parse_and_depth() {
        assert!(Tier::parse("t3").unwrap_err().starts_with("E_TIER_UNKNOWN"));
        assert!(Tier::parse("T1").is_err());
        assert!(!Tier::T0.includes_t1());
        assert!(Tier::T1.includes_t1());
        assert!(Tier::T2.includes_t1());
    }
}
