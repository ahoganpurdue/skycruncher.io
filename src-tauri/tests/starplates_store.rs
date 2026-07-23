//! Integration tests for the starplates native provider (docs/STARPLATES_SPEC.md
//! §9.4 checklist, Rust side): store seed/open/verify, cone→cells bound
//! correctness (center / RA-wrap / polar), corruption self-heal, atomic
//! install, wire-layout golden bytes, and interop with the real forged
//! release bundled under `src-tauri/resources/starplates/`.

use app_lib::starplates::arrow_io::{
    cell_metadata_value, read_cell_file, read_response_stream, sort_rows, write_cell_file, StarRow,
};
use app_lib::starplates::geometry::{angdist_deg, nest_center_deg, npix, unit_vec};
use app_lib::starplates::manifest::{BlobEntry, Manifest};
use app_lib::starplates::query::query_v2;
use app_lib::starplates::sha256_hex;
use app_lib::starplates::store::{cas_path_for, StarplatesStore};
use std::path::{Path, PathBuf};

const FIXTURE_RELEASE: &str = "starplates-0000.00-fixture";

fn vec_to_radec(v: [f64; 3]) -> (f64, f64) {
    let ra = v[1].atan2(v[0]).to_degrees().rem_euclid(360.0);
    let dec = v[2].asin().to_degrees();
    (ra, dec)
}

/// Data-derived cone bound exactly as the forge computes it (spec §2.3):
/// center = normalized mean unit vector, radius = max member distance.
fn data_bound(rows: &[StarRow]) -> (f64, f64, f64) {
    let mut sum = [0.0f64; 3];
    for r in rows {
        let v = unit_vec(r.ra_deg, r.dec_deg);
        sum[0] += v[0];
        sum[1] += v[1];
        sum[2] += v[2];
    }
    let norm = (sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]).sqrt();
    let c = [sum[0] / norm, sum[1] / norm, sum[2] / norm];
    let radius = rows
        .iter()
        .map(|r| angdist_deg(&c, &unit_vec(r.ra_deg, r.dec_deg)))
        .fold(0.0f64, f64::max);
    let (ra, dec) = vec_to_radec(c);
    (ra, dec, radius)
}

fn star(cell: u64, counter: u64, d_ra: f64, d_dec: f64, g: f32, pm_ra: f32, pm_dec: f32) -> StarRow {
    let (cra, cdec) = nest_center_deg(5, cell);
    StarRow {
        ra_deg: (cra + d_ra).rem_euclid(360.0),
        dec_deg: (cdec + d_dec).clamp(-90.0, 90.0),
        pm_ra_masyr: pm_ra,
        pm_dec_masyr: pm_dec,
        g_mag: g,
        bp_rp: 0.5,
        source_id: (cell << 49) | (counter << 35) | counter,
    }
}

/// Write a bundle-shaped mini release (manifest + t0 + t1 cells) to `dir`.
fn write_bundle(dir: &Path, cells: &[(u64, Vec<StarRow>)], t0_rows: &[StarRow]) {
    let release_dir = dir.join(FIXTURE_RELEASE);
    let mut blobs: Vec<BlobEntry> = Vec::new();

    let mut t0_sorted = t0_rows.to_vec();
    sort_rows(&mut t0_sorted);
    let t0_bytes = write_cell_file(
        &t0_sorted,
        &cell_metadata_value(FIXTURE_RELEASE, 1, "t0", None, None),
    )
    .unwrap();
    std::fs::create_dir_all(release_dir.join("t0")).unwrap();
    std::fs::write(release_dir.join("t0/allsky.arrow"), &t0_bytes).unwrap();
    blobs.push(BlobEntry {
        path: "t0/allsky.arrow".into(),
        sha256: sha256_hex(&t0_bytes),
        bytes: t0_bytes.len() as u64,
        tier: "t0".into(),
        healpix_order: None,
        cell: None,
        rows: t0_sorted.len() as u64,
        mag_min: None,
        mag_max: Some(9.0),
        source_epoch: Some("J2016.0".into()),
        coverage: Some(1.0),
        center_ra_deg: None,
        center_dec_deg: None,
        radius_deg: None,
    });

    std::fs::create_dir_all(release_dir.join("t1")).unwrap();
    for (cell, rows) in cells {
        let mut sorted = rows.clone();
        sort_rows(&mut sorted);
        let bytes = write_cell_file(
            &sorted,
            &cell_metadata_value(FIXTURE_RELEASE, 1, "t1", Some(5), Some(*cell)),
        )
        .unwrap();
        let rel = format!("t1/c5-{cell:05}.arrow");
        std::fs::write(release_dir.join(&rel), &bytes).unwrap();
        let (cra, cdec, radius) = data_bound(&sorted);
        blobs.push(BlobEntry {
            path: rel,
            sha256: sha256_hex(&bytes),
            bytes: bytes.len() as u64,
            tier: "t1".into(),
            healpix_order: Some(5),
            cell: Some(*cell),
            rows: sorted.len() as u64,
            mag_min: sorted.first().map(|r| r.g_mag as f64),
            mag_max: sorted.last().map(|r| r.g_mag as f64),
            source_epoch: Some("J2016.0".into()),
            coverage: Some(1.0),
            center_ra_deg: Some(cra),
            center_dec_deg: Some(cdec),
            radius_deg: Some(radius),
        });
    }

    let manifest = Manifest {
        release: FIXTURE_RELEASE.into(),
        format_version: 1,
        writer: "starplates_store.rs test fixture (arrow-rs=54.3.1)".into(),
        source: serde_json::json!({ "catalog": "synthetic", "epoch": "J2016.0", "epoch_jd": 2457388.5 }),
        schema: serde_json::json!({}),
        tiers: serde_json::json!({}),
        blobs,
    };
    let bytes = serde_json::to_vec_pretty(&manifest).unwrap();
    std::fs::write(release_dir.join("manifest.json"), bytes).unwrap();
}

/// Standard fixture: M66-region cells 7044 + 7046 populated; 7041/7043 (also
/// in-cone) deliberately missing from the release; T0 carries the bright
/// duplicates plus one bright star in the missing cell 7043.
fn m66_fixture(dir: &Path) {
    let c7044 = vec![
        star(7044, 1, 0.1, 0.1, 5.5, 100.0, -50.0), // bright — duplicated in t0
        star(7044, 2, -0.2, 0.05, 10.5, 0.0, 0.0),
        star(7044, 3, 0.05, -0.15, 12.4, -20.0, 20.0),
    ];
    let c7046 = vec![
        star(7046, 1, 0.0, 0.2, 8.0, 0.0, 0.0), // bright — duplicated in t0
        star(7046, 2, 0.3, -0.1, 11.0, 0.0, 0.0),
    ];
    let t0 = vec![
        c7044[0], // duplicate of the served cell's bright prefix
        c7046[0],
        star(7043, 9, 0.0, 0.0, 6.5, 0.0, 0.0), // bright star in a release-absent cell
    ];
    write_bundle(dir, &[(7044, c7044.clone()), (7046, c7046.clone())], &t0);
}

fn seeded_store(tmp: &Path) -> StarplatesStore {
    let bundle = tmp.join("bundle");
    let root = tmp.join("store");
    m66_fixture(&bundle);
    let seeded = StarplatesStore::seed_from_bundle(&root, &bundle).unwrap();
    assert!(seeded, "first seed must run");
    StarplatesStore::open(&root).unwrap()
}

#[test]
fn seed_open_status_idempotent() {
    let tmp = tempfile::tempdir().unwrap();
    let store = seeded_store(tmp.path());
    let status = store.status();
    assert_eq!(status.release, FIXTURE_RELEASE);
    assert_eq!(status.format_version, 1);
    assert_eq!(status.cells_total, 12288);
    assert_eq!(status.cells_populated, 2);
    assert_eq!(status.cells_local, 2); // every t1 blob was present in the bundle
    assert_eq!(status.t0_rows, 3);
    assert_eq!(status.tier_depth_available, "t1");

    // Re-seed is a no-op (idempotent — spec §5.1).
    let again =
        StarplatesStore::seed_from_bundle(&tmp.path().join("store"), &tmp.path().join("bundle"))
            .unwrap();
    assert!(!again);
}

#[test]
fn query_m66_cone_end_to_end() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = seeded_store(tmp.path());
    // Center between cells 7044/7046, generous radius: both served, and the
    // t0 supplement covers the release-absent cell 7043.
    let (ra0, dec0) = nest_center_deg(5, 7044);
    let bytes = query_v2(&mut store, ra0, dec0, 3.0, "t1", 2457388.5).unwrap();
    let (rows, md) = read_response_stream(&bytes).unwrap();

    // 5 t1 rows + 1 t0 supplement row (7043); the two t0 duplicates of served
    // cells are excluded by the source_id>>49 dedup.
    assert_eq!(rows.len(), 6, "rows: {rows:?}");
    assert!(rows.windows(2).all(|w| w[0].g_mag <= w[1].g_mag), "g_mag sort");
    // epoch == J2016.0 => positions identical to stored (PM delta 0)
    assert_eq!(md["skycruncher.positions"], "propagated");
    assert_eq!(md["skycruncher.epoch_jd"], "2457388.5");
    assert_eq!(md["skycruncher.release"], FIXTURE_RELEASE);
    assert_eq!(md["skycruncher.tier_depth"], "t1");
    assert_eq!(md["skycruncher.cells_served"], "5:7044,5:7046,t0");
    assert_eq!(md["skycruncher.cells_absent_local"], "0");
    // 7041 + 7043 (and possibly more ring cells) are release-absent in-cone.
    let absent_release: u32 = md["skycruncher.cells_absent_release"].parse().unwrap();
    assert!(absent_release >= 2, "absent_release {absent_release}");
    // cell_shas align 1:1 with cells_served tokens
    assert_eq!(md["skycruncher.cell_shas"].split(',').count(), 3);

    // Tight cone inside 7044: only that cell's data is served from T1 and the
    // per-row spherical filter keeps exactly the one star inside 0.15 deg.
    // (cells_absent_release stays >0 here because the counter's conservative
    // cell-radius bound sees the absent NEIGHBOR cells of this fixture; the t0
    // supplement it triggers contributes no rows outside the cone.)
    let tight = query_v2(&mut store, ra0, dec0, 0.15, "t1", 2457388.5).unwrap();
    let (tight_rows, md2) = read_response_stream(&tight).unwrap();
    assert!(md2["skycruncher.cells_served"].starts_with("5:7044"), "{}", md2["skycruncher.cells_served"]);
    assert_eq!(tight_rows.len(), 1, "tight cone rows: {tight_rows:?}");
    assert!((tight_rows[0].g_mag - 5.5).abs() < 1e-6);

    // t0 depth serves only the bootstrap file.
    let t0_resp = query_v2(&mut store, ra0, dec0, 3.0, "t0", 2457388.5).unwrap();
    let (t0_rows, md3) = read_response_stream(&t0_resp).unwrap();
    assert_eq!(md3["skycruncher.cells_served"], "t0");
    assert_eq!(t0_rows.len(), 3);

    // t2 depth == union up to t2 == t1 result this release (t2 reserved).
    let t2_resp = query_v2(&mut store, ra0, dec0, 3.0, "t2", 2457388.5).unwrap();
    let (t2_rows, _) = read_response_stream(&t2_resp).unwrap();
    assert_eq!(t2_rows.len(), 6);
}

#[test]
fn pm_propagation_applied_at_query_time() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = seeded_store(tmp.path());
    let (ra0, dec0) = nest_center_deg(5, 7044);
    // +100 Julian years: the 7044 bright star has pmra*=100 mas/yr, pmdec=-50.
    let epoch = 2457388.5 + 100.0 * 365.25;
    let bytes = query_v2(&mut store, ra0, dec0, 3.0, "t1", epoch).unwrap();
    let (rows, _) = read_response_stream(&bytes).unwrap();
    let bright = rows.iter().find(|r| (r.g_mag - 5.5).abs() < 1e-6).unwrap();
    let stored = star(7044, 1, 0.1, 0.1, 5.5, 100.0, -50.0);
    let d_dec = bright.dec_deg - stored.dec_deg;
    // v1 formula: ddec = (pm_dec/3.6e6)*dt = -50*100/3.6e6 deg
    let expect_ddec = -50.0 * 100.0 / 3.6e6;
    assert!((d_dec - expect_ddec).abs() < 1e-12, "ddec {d_dec} vs {expect_ddec}");
    let cosd = bright.dec_deg.to_radians().cos().abs().max(0.001);
    let expect_dra = (100.0 * 100.0 / 3.6e6) / cosd;
    assert!((bright.ra_deg - stored.ra_deg - expect_dra).abs() < 1e-10);
    // pm columns remain the ORIGINAL Gaia values (informational — spec §5.2)
    assert!((bright.pm_ra_masyr - 100.0).abs() < 1e-6);
}

#[test]
fn corruption_self_heals_and_never_fails_the_query() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = seeded_store(tmp.path());
    let (ra0, dec0) = nest_center_deg(5, 7044);

    // Bit-flip the 7044 cell blob in the CAS (body region, past the magic).
    let sha_7044 = store
        .t1_cells()
        .iter()
        .find(|c| c.cell == 7044)
        .unwrap()
        .sha256
        .clone();
    let cas = cas_path_for(store.root(), &sha_7044);
    let mut bytes = std::fs::read(&cas).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xFF;
    std::fs::write(&cas, &bytes).unwrap();

    let resp = query_v2(&mut store, ra0, dec0, 3.0, "t1", 2457388.5).unwrap();
    let (rows, md) = read_response_stream(&resp).unwrap();
    // 7044 quarantined + treated absent; 7046 still served; t0 now supplements
    // 7044's bright star (6 - 3 t1 rows of 7044 + 1 recovered bright = 4).
    assert_eq!(md["skycruncher.cells_absent_local"], "1");
    assert_eq!(md["skycruncher.cells_served"], "5:7046,t0");
    assert_eq!(rows.len(), 4, "rows: {rows:?}");
    assert!(!cas.exists(), "corrupt blob must leave the CAS");
    let quarantined = store.root().join("quarantine").join(format!("{sha_7044}.arrow"));
    assert!(quarantined.exists(), "corrupt blob must be quarantined for autopsy");

    // The session survives and stays consistent on re-query.
    let resp2 = query_v2(&mut store, ra0, dec0, 3.0, "t1", 2457388.5).unwrap();
    let (rows2, md2) = read_response_stream(&resp2).unwrap();
    assert_eq!(rows2.len(), 4);
    assert_eq!(md2["skycruncher.cells_absent_local"], "1");
}

#[test]
fn atomic_install_rejects_sha_mismatch() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("store");
    let bogus_sha = "ab".repeat(32);
    let err = StarplatesStore::install_blob(&root, &bogus_sha, b"not the right bytes").unwrap_err();
    assert!(err.contains("sha mismatch"), "{err}");
    assert!(!cas_path_for(&root, &bogus_sha).exists());
    // No stray tmp file may remain either.
    let shard = root.join("cas").join(&bogus_sha[0..2]);
    if shard.exists() {
        assert_eq!(std::fs::read_dir(shard).unwrap().count(), 0);
    }
}

#[test]
fn manifest_tamper_is_refused_at_open() {
    let tmp = tempfile::tempdir().unwrap();
    let _ = seeded_store(tmp.path());
    let root = tmp.path().join("store");
    let mpath = root
        .join("releases")
        .join(FIXTURE_RELEASE)
        .join("manifest.json");
    let mut bytes = std::fs::read(&mpath).unwrap();
    let pos = bytes.len() / 2;
    bytes[pos] = if bytes[pos] == b' ' { b'\t' } else { b' ' };
    std::fs::write(&mpath, &bytes).unwrap();
    let err = StarplatesStore::open(&root).unwrap_err();
    assert!(err.starts_with("E_MANIFEST_INVALID"), "{err}");
}

#[test]
fn argument_validation_error_prefixes() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = seeded_store(tmp.path());
    let e = query_v2(&mut store, 170.0, 13.0, 0.0, "t1", 2457388.5).unwrap_err();
    assert!(e.starts_with("E_RADIUS_RANGE"), "{e}");
    let e = query_v2(&mut store, 170.0, 13.0, 16.5, "t1", 2457388.5).unwrap_err();
    assert!(e.starts_with("E_RADIUS_RANGE"), "{e}");
    let e = query_v2(&mut store, 170.0, 13.0, 2.0, "t9", 2457388.5).unwrap_err();
    assert!(e.starts_with("E_TIER_UNKNOWN"), "{e}");
    let e = query_v2(&mut store, 170.0, 95.0, 2.0, "t1", 2457388.5).unwrap_err();
    assert!(e.starts_with("E_ARG_INVALID"), "{e}");
    let e = query_v2(&mut store, f64::NAN, 13.0, 2.0, "t1", 2457388.5).unwrap_err();
    assert!(e.starts_with("E_ARG_INVALID"), "{e}");
}

#[test]
fn cone_bounds_ra_wrap_and_polar() {
    // Find real order-5 cells straddling RA 0 and near the north pole, place
    // synthetic stars there, and confirm cone→cells resolution catches them
    // from the far side of the wrap / across the pole.
    let mut wrap_cell = None;
    let mut polar_cell = None;
    for pix in 0..npix(5) {
        let (ra, dec) = nest_center_deg(5, pix);
        // Order-5 equatorial centers top out at RA 358.59 (phi lattice) —
        // 358.5 catches the last column before the wrap.
        if wrap_cell.is_none() && ra > 358.5 && dec.abs() < 10.0 {
            wrap_cell = Some(pix);
        }
        if polar_cell.is_none() && dec > 88.5 {
            polar_cell = Some(pix);
        }
        if wrap_cell.is_some() && polar_cell.is_some() {
            break;
        }
    }
    let (wrap_cell, polar_cell) = (wrap_cell.unwrap(), polar_cell.unwrap());

    let tmp = tempfile::tempdir().unwrap();
    let bundle = tmp.path().join("bundle");
    let root = tmp.path().join("store");
    let wrap_rows = vec![star(wrap_cell, 1, 0.05, 0.0, 7.0, 0.0, 0.0)];
    let polar_rows = vec![star(polar_cell, 1, 0.0, 0.05, 7.5, 0.0, 0.0)];
    write_bundle(
        &bundle,
        &[(wrap_cell, wrap_rows.clone()), (polar_cell, polar_rows.clone())],
        &[],
    );
    StarplatesStore::seed_from_bundle(&root, &bundle).unwrap();
    let mut store = StarplatesStore::open(&root).unwrap();

    // Query from the OTHER side of RA=0 — a flat dRA metric would miss this.
    let (wra, wdec) = nest_center_deg(5, wrap_cell);
    let q_ra = 0.4; // wrap cell center is >359
    let true_dist = angdist_deg(&unit_vec(q_ra, wdec), &unit_vec(wra, wdec));
    assert!(true_dist < 2.0, "test geometry sanity: {true_dist}");
    let resp = query_v2(&mut store, q_ra, wdec, 2.0, "t1", 2457388.5).unwrap();
    let (rows, md) = read_response_stream(&resp).unwrap();
    assert!(
        md["skycruncher.cells_served"].contains(&format!("5:{wrap_cell}")),
        "wrap cell not served: {}",
        md["skycruncher.cells_served"]
    );
    assert_eq!(rows.len(), 1, "wrap row not returned");

    // Polar query: cone across the pole at a different RA.
    let resp = query_v2(&mut store, 200.0, 89.5, 3.0, "t1", 2457388.5).unwrap();
    let (rows, md) = read_response_stream(&resp).unwrap();
    assert!(
        md["skycruncher.cells_served"].contains(&format!("5:{polar_cell}")),
        "polar cell not served: {}",
        md["skycruncher.cells_served"]
    );
    assert_eq!(rows.len(), 1, "polar row not returned");
}

// ---------------------------------------------------------------------------
// Wire-layout golden bytes (task requirement): a small fixture cell checked in.
// The committed file was written by a PRIOR process; regenerating the identical
// bytes here proves the cell writer is cross-process deterministic (spec §3.3)
// — this is exactly why cell metadata is single-key (see arrow_io.rs header).
// ---------------------------------------------------------------------------

fn golden_rows() -> Vec<StarRow> {
    let mut rows = vec![
        StarRow { ra_deg: 170.1, dec_deg: 12.9, pm_ra_masyr: -10.5, pm_dec_masyr: 3.25, g_mag: 9.5, bp_rp: 0.65, source_id: (7044u64 << 49) | 77 },
        StarRow { ra_deg: 170.0, dec_deg: 13.0, pm_ra_masyr: 1.0, pm_dec_masyr: -2.0, g_mag: 5.25, bp_rp: 1.5, source_id: (7044u64 << 49) | 3 },
        StarRow { ra_deg: 169.9, dec_deg: 12.7, pm_ra_masyr: 0.0, pm_dec_masyr: 0.0, g_mag: 5.25, bp_rp: -0.125, source_id: (7044u64 << 49) | 1 },
    ];
    sort_rows(&mut rows);
    rows
}

fn golden_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("starplates")
        .join("golden_cell_5-07044.arrow")
}

/// SHA-256 of the committed golden cell fixture. Regenerate the file with
/// `STARPLATES_REGEN_FIXTURES=1 cargo test -p app --test starplates_store regen`
/// and update this constant ONLY on a deliberate format change (spec §3.2 is
/// FROZEN — an unexpected diff here is a broken byte contract).
const GOLDEN_CELL_SHA256: &str = "7ede8fa4b395749e318c1c1310997b6c05a801024b32067e178a4f02bc78e666";

#[test]
fn regen_golden_fixture_when_asked() {
    if std::env::var("STARPLATES_REGEN_FIXTURES").as_deref() != Ok("1") {
        eprintln!("skipping fixture regeneration (set STARPLATES_REGEN_FIXTURES=1 to write)");
        return;
    }
    let bytes = write_cell_file(
        &golden_rows(),
        &cell_metadata_value("starplates-0000.00-fixture", 1, "t1", Some(5), Some(7044)),
    )
    .unwrap();
    std::fs::create_dir_all(golden_path().parent().unwrap()).unwrap();
    std::fs::write(golden_path(), &bytes).unwrap();
    eprintln!("wrote {:?} sha256={}", golden_path(), sha256_hex(&bytes));
}

#[test]
fn golden_cell_bytes_are_stable() {
    let committed = match std::fs::read(golden_path()) {
        Ok(b) => b,
        Err(_) => {
            panic!(
                "golden fixture missing at {:?} — run STARPLATES_REGEN_FIXTURES=1 cargo test -p app --test starplates_store regen",
                golden_path()
            );
        }
    };
    assert_eq!(
        sha256_hex(&committed),
        GOLDEN_CELL_SHA256,
        "committed golden fixture drifted"
    );
    let regenerated = write_cell_file(
        &golden_rows(),
        &cell_metadata_value("starplates-0000.00-fixture", 1, "t1", Some(5), Some(7044)),
    )
    .unwrap();
    assert_eq!(
        committed, regenerated,
        "cell writer is no longer byte-deterministic across processes (spec §3.3)"
    );
    // And the golden bytes decode to the golden rows.
    let rows = read_cell_file(&committed, "golden").unwrap();
    assert_eq!(rows, golden_rows());
}

// ---------------------------------------------------------------------------
// Interop with the REAL forged release (Node forge, apache-arrow JS 21.1.0):
// the bundled T0 blob must decode through the Rust reader. Skips honestly if
// the bundle is not present in this checkout.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Download manager: real HTTP round trip against an in-test server, including
// resume (206), sha-mismatch rejection, and idempotent re-run.
// ---------------------------------------------------------------------------

/// Minimal blocking HTTP/1.1 file server for the sync tests. Serves
/// `GET /<release>/<path>` from a map; honors `Range: bytes=N-`; optional
/// per-path corruption to exercise the sha gate.
fn spawn_blob_server(
    blobs: std::collections::HashMap<String, Vec<u8>>,
    corrupt_paths: std::collections::HashSet<String>,
) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let blobs = blobs.clone();
            let corrupt = corrupt_paths.clone();
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut byte = [0u8; 1];
                // Read headers until CRLFCRLF (requests have no body).
                while !buf.ends_with(b"\r\n\r\n") {
                    match stream.read(&mut byte) {
                        Ok(1) => buf.push(byte[0]),
                        _ => return,
                    }
                }
                let req = String::from_utf8_lossy(&buf);
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let range_from: Option<u64> = req
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                    .and_then(|l| l.split('=').nth(1))
                    .and_then(|v| v.trim().trim_end_matches('-').parse().ok());
                let respond = |stream: &mut std::net::TcpStream, status: &str, body: &[u8], extra: &str| {
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(body);
                };
                match blobs.get(&path) {
                    None => respond(&mut stream, "404 Not Found", b"", ""),
                    Some(bytes) => {
                        let mut body = bytes.clone();
                        if corrupt.contains(&path) {
                            let n = body.len();
                            body[n / 2] ^= 0xFF;
                        }
                        match range_from {
                            Some(from) if (from as usize) < body.len() => {
                                let total = body.len();
                                let slice = body[from as usize..].to_vec();
                                let hdr = format!(
                                    "Content-Range: bytes {from}-{}/{total}\r\n",
                                    total - 1
                                );
                                respond(&mut stream, "206 Partial Content", &slice, &hdr);
                            }
                            Some(_) => respond(&mut stream, "416 Range Not Satisfiable", b"", ""),
                            None => respond(&mut stream, "200 OK", &body, ""),
                        }
                    }
                }
            });
        }
    });
    format!("http://{addr}")
}

#[test]
fn sync_downloads_verifies_and_installs() {
    use app_lib::starplates::sync::{plan_sync, run_sync};

    // Bundle with manifest ONLY (blob files removed) — the store starts empty
    // of blobs, exactly like a fresh install before any T1 sync.
    let tmp = tempfile::tempdir().unwrap();
    let bundle = tmp.path().join("bundle");
    let root = tmp.path().join("store");
    m66_fixture(&bundle);
    let release_dir = bundle.join(FIXTURE_RELEASE);
    // Collect blob bytes for the server, then delete them from the bundle.
    let manifest_bytes = std::fs::read(release_dir.join("manifest.json")).unwrap();
    let manifest = Manifest::parse(&manifest_bytes).unwrap();
    let mut server_blobs = std::collections::HashMap::new();
    for b in &manifest.blobs {
        let p = release_dir.join(&b.path);
        server_blobs.insert(
            format!("/{FIXTURE_RELEASE}/{}", b.path),
            std::fs::read(&p).unwrap(),
        );
        std::fs::remove_file(&p).unwrap();
    }
    StarplatesStore::seed_from_bundle(&root, &bundle).unwrap();
    let mut store = StarplatesStore::open(&root).unwrap();
    assert_eq!(store.status().cells_local, 0);
    assert_eq!(store.status().tier_depth_available, "none");

    // First sync: everything downloads, verifies, installs.
    let base = spawn_blob_server(server_blobs.clone(), Default::default());
    let plan = plan_sync(&store, "t1", None).unwrap();
    assert_eq!(plan.len(), 3); // t0 + 2 cells
    let report = run_sync(store.root(), &base, FIXTURE_RELEASE, "t1", &plan);
    assert_eq!(report.downloaded, 3, "failures: {:?}", report.failed);
    assert!(report.failed.is_empty());
    assert!(report.bytes_fetched > 0);
    assert_eq!(store.status().cells_local, 2);
    assert_eq!(store.status().tier_depth_available, "t1");

    // Synced store actually serves queries.
    let (ra0, dec0) = nest_center_deg(5, 7044);
    let resp = query_v2(&mut store, ra0, dec0, 3.0, "t1", 2457388.5).unwrap();
    let (rows, _) = read_response_stream(&resp).unwrap();
    assert_eq!(rows.len(), 6);

    // Idempotent re-run: nothing re-downloaded.
    let report2 = run_sync(store.root(), &base, FIXTURE_RELEASE, "t1", &plan);
    assert_eq!(report2.already_present, 3);
    assert_eq!(report2.downloaded, 0);
    assert_eq!(report2.bytes_fetched, 0);
}

#[test]
fn sync_resumes_partial_downloads_with_range_get() {
    use app_lib::starplates::sync::{plan_sync, run_sync};

    let tmp = tempfile::tempdir().unwrap();
    let bundle = tmp.path().join("bundle");
    let root = tmp.path().join("store");
    m66_fixture(&bundle);
    let release_dir = bundle.join(FIXTURE_RELEASE);
    let manifest = Manifest::parse(&std::fs::read(release_dir.join("manifest.json")).unwrap()).unwrap();
    let mut server_blobs = std::collections::HashMap::new();
    for b in &manifest.blobs {
        let p = release_dir.join(&b.path);
        server_blobs.insert(format!("/{FIXTURE_RELEASE}/{}", b.path), std::fs::read(&p).unwrap());
        std::fs::remove_file(&p).unwrap();
    }
    StarplatesStore::seed_from_bundle(&root, &bundle).unwrap();
    let store = StarplatesStore::open(&root).unwrap();

    // Pre-stage a half-downloaded .tmp for the t0 blob.
    let t0_blob = manifest.blobs.iter().find(|b| b.tier == "t0").unwrap();
    let full = &server_blobs[&format!("/{FIXTURE_RELEASE}/{}", t0_blob.path)];
    let half = full.len() / 2;
    let tmp_path = cas_path_for(&root, &t0_blob.sha256).with_extension("tmp");
    std::fs::create_dir_all(tmp_path.parent().unwrap()).unwrap();
    std::fs::write(&tmp_path, &full[..half]).unwrap();

    let base = spawn_blob_server(server_blobs.clone(), Default::default());
    let plan = plan_sync(&store, "t0", None).unwrap();
    assert_eq!(plan.len(), 1);
    let report = run_sync(store.root(), &base, FIXTURE_RELEASE, "t0", &plan);
    assert_eq!(report.downloaded, 1, "failures: {:?}", report.failed);
    // Only the missing remainder crossed the wire (206 resume).
    assert_eq!(report.bytes_fetched, (full.len() - half) as u64);
    assert!(cas_path_for(&root, &t0_blob.sha256).is_file());
    assert!(!tmp_path.exists(), "tmp must be renamed away");
}

#[test]
fn sync_rejects_sha_mismatch_and_reports_honestly() {
    use app_lib::starplates::sync::{plan_sync, run_sync};

    let tmp = tempfile::tempdir().unwrap();
    let bundle = tmp.path().join("bundle");
    let root = tmp.path().join("store");
    m66_fixture(&bundle);
    let release_dir = bundle.join(FIXTURE_RELEASE);
    let manifest = Manifest::parse(&std::fs::read(release_dir.join("manifest.json")).unwrap()).unwrap();
    let mut server_blobs = std::collections::HashMap::new();
    for b in &manifest.blobs {
        let p = release_dir.join(&b.path);
        server_blobs.insert(format!("/{FIXTURE_RELEASE}/{}", b.path), std::fs::read(&p).unwrap());
        std::fs::remove_file(&p).unwrap();
    }
    StarplatesStore::seed_from_bundle(&root, &bundle).unwrap();
    let store = StarplatesStore::open(&root).unwrap();

    let t0_blob = manifest.blobs.iter().find(|b| b.tier == "t0").unwrap();
    let corrupt: std::collections::HashSet<String> =
        [format!("/{FIXTURE_RELEASE}/{}", t0_blob.path)].into();
    let base = spawn_blob_server(server_blobs, corrupt);
    let plan = plan_sync(&store, "t1", None).unwrap();
    let report = run_sync(store.root(), &base, FIXTURE_RELEASE, "t1", &plan);
    assert_eq!(report.downloaded, 2);
    assert_eq!(report.failed.len(), 1);
    assert!(report.failed[0].error.contains("sha mismatch"), "{:?}", report.failed);
    // The corrupt payload never entered the CAS.
    assert!(!cas_path_for(&root, &t0_blob.sha256).is_file());
}

#[test]
fn real_bundled_release_decodes_through_rust_reader() {
    let bundle_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("starplates");
    let release_dir = bundle_root.join("starplates-2026.07-gdr3");
    let manifest_path = release_dir.join("manifest.json");
    if !manifest_path.is_file() {
        eprintln!("skipping: no bundled release at {release_dir:?}");
        return;
    }
    let manifest_bytes = std::fs::read(&manifest_path).unwrap();
    let manifest = Manifest::parse(&manifest_bytes).expect("real manifest must validate");
    let t0 = manifest
        .blobs
        .iter()
        .find(|b| b.tier == "t0")
        .expect("bundled release must carry t0");
    let t0_bytes = std::fs::read(release_dir.join(&t0.path)).expect("bundled t0 blob present");
    assert_eq!(sha256_hex(&t0_bytes), t0.sha256, "bundled t0 sha matches manifest");
    let rows = read_cell_file(&t0_bytes, "t0").expect("JS-forged t0 decodes in arrow-rs");
    assert_eq!(rows.len() as u64, t0.rows, "row count matches manifest");
    assert!(
        rows.windows(2).all(|w| w[0].g_mag < w[1].g_mag
            || (w[0].g_mag == w[1].g_mag && w[0].source_id <= w[1].source_id)),
        "t0 rows sorted g_mag asc, source_id asc (spec §3.2)"
    );
    // End-to-end: seed a scratch store from the real bundle and run an M66
    // t0-depth query through the full native path.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("store");
    StarplatesStore::seed_from_bundle(&root, &bundle_root).unwrap();
    let mut store = StarplatesStore::open(&root).unwrap();
    let resp = query_v2(&mut store, 170.117, 13.048, 2.353, "t0", 2461176.6630218057).unwrap();
    let (stars, md) = read_response_stream(&resp).unwrap();
    assert!(!stars.is_empty(), "M66 cone empty at t0 depth");
    assert_eq!(md["skycruncher.release"], "starplates-2026.07-gdr3");
    eprintln!(
        "real-release M66 t0 query: {} rows, mag {:.2}..{:.2}",
        stars.len(),
        stars.first().unwrap().g_mag,
        stars.last().unwrap().g_mag
    );
}
