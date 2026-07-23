//! M1 release-verify policy gate: Full → Stamp roundtrip in a temp dir; corrupted-manifest
//! and size/mtime-mismatch loud-refuse; None returns the SKIPPED_UNVERIFIED marker.
//! Uses a tiny synthetic "release" (verify hashes bytes — it never parses Arrow).

use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};
use solver_contracts::config::ReleaseVerifyMode;
use solver_core::index::manifest::{BandBlob, Manifest, SchemaInfo, StarsBlob, Totals};
use solver_core::index::release_verify::{aggregate_md5, verify_release, VerifyOutcome};
use solver_core::index::IndexError;

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn band_blob(index: u32, file: &str, payload: &[u8]) -> BandBlob {
    BandBlob {
        index,
        file: file.to_string(),
        lo_deg: 0.25,
        hi_deg: 0.354,
        mag_limit: 10.0,
        n_quads: 0,
        capped: false,
        sha256: sha256_hex(payload),
        bytes: payload.len() as u64,
        batches: Vec::new(),
    }
}

#[test]
fn stamp_policy_roundtrip_and_loud_refusals() {
    let root = std::env::temp_dir().join(format!("skycruncher_m1_stamp_{}", std::process::id()));
    let dir: PathBuf = root.join("release");
    let stamp_dir: PathBuf = root.join("stamps");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&dir).unwrap();

    let stars_bytes = b"fake star payload v1".to_vec();
    let band0_bytes = b"band zero payload ...".to_vec();
    let band1_bytes = b"band one payload!!".to_vec();
    fs::write(dir.join("stars.arrow"), &stars_bytes).unwrap();
    fs::write(dir.join("band_0.arrow"), &band0_bytes).unwrap();
    fs::write(dir.join("band_1.arrow"), &band1_bytes).unwrap();

    let pairs = vec![
        ("stars.arrow".to_string(), sha256_hex(&stars_bytes)),
        ("band_0.arrow".to_string(), sha256_hex(&band0_bytes)),
        ("band_1.arrow".to_string(), sha256_hex(&band1_bytes)),
    ];
    let manifest = Manifest {
        release: "m1-stamp-test".into(),
        format_version: 1,
        writer: None,
        coder: None,
        source: None,
        schema: SchemaInfo {
            stars: "ra_deg:f64, dec_deg:f64, g_mag:f32, source_id:u64".into(),
            band: "code0..3:f32, star0..3:u32, diam_deg:f32, code_key:i32".into(),
            ledger: None,
            ipc: None,
            compression: None,
            nbins: 128,
            batch_rows: 20000,
        },
        params: None,
        edges: vec![0.25, 0.354, 0.5],
        depths: vec![10.0, 10.0],
        stars: StarsBlob {
            file: "stars.arrow".into(),
            sha256: sha256_hex(&stars_bytes),
            bytes: stars_bytes.len() as u64,
            rows: 1,
        },
        bands: vec![
            band_blob(0, "band_0.arrow", &band0_bytes),
            band_blob(1, "band_1.arrow", &band1_bytes),
        ],
        totals: Totals {
            quads: 0,
            stars: 1,
            bytes: (stars_bytes.len() + band0_bytes.len() + band1_bytes.len()) as u64,
        },
        aggregate_md5: aggregate_md5(&pairs),
    };
    let manifest_json = serde_json::to_string_pretty(&manifest).unwrap();
    fs::write(dir.join("manifest.json"), &manifest_json).unwrap();

    // 1) Full pass writes a stamp
    let out = verify_release(&dir, &manifest, ReleaseVerifyMode::Full, Some(&stamp_dir)).unwrap();
    assert_eq!(out, VerifyOutcome::FullPass { files: 3 });
    assert!(stamp_dir.join("m1-stamp-test.stamp.json").exists());

    // 2) Stamp pass (warm path)
    let out = verify_release(&dir, &manifest, ReleaseVerifyMode::Stamp, Some(&stamp_dir)).unwrap();
    assert_eq!(out, VerifyOutcome::StampPass { files: 3 });

    // 3) None → SKIPPED_UNVERIFIED marker
    let out = verify_release(&dir, &manifest, ReleaseVerifyMode::None, None).unwrap();
    assert_eq!(out, VerifyOutcome::SkippedUnverified);
    assert_eq!(out.receipt_marker(), "SKIPPED_UNVERIFIED");

    // 4) Stamp without a stamp_dir refuses
    match verify_release(&dir, &manifest, ReleaseVerifyMode::Stamp, None) {
        Err(IndexError::StampMissing(_)) => {}
        other => panic!("expected StampMissing, got {other:?}"),
    }

    // 5) corrupted manifest.json → Stamp loud-refuses (ManifestChanged)
    fs::write(dir.join("manifest.json"), format!("{manifest_json} ")).unwrap();
    match verify_release(&dir, &manifest, ReleaseVerifyMode::Stamp, Some(&stamp_dir)) {
        Err(IndexError::ManifestChanged { .. }) => {}
        other => panic!("expected ManifestChanged, got {other:?}"),
    }
    fs::write(dir.join("manifest.json"), &manifest_json).unwrap(); // restore exact bytes
    verify_release(&dir, &manifest, ReleaseVerifyMode::Stamp, Some(&stamp_dir))
        .expect("restored manifest must pass Stamp again");

    // 6) size mismatch → Stamp loud-refuses on bytes
    fs::write(dir.join("band_1.arrow"), b"short").unwrap();
    match verify_release(&dir, &manifest, ReleaseVerifyMode::Stamp, Some(&stamp_dir)) {
        Err(IndexError::StampMismatch { file, field, .. }) => {
            assert_eq!(file, "band_1.arrow");
            assert_eq!(field, "bytes");
        }
        other => panic!("expected StampMismatch(bytes), got {other:?}"),
    }

    // 7) Full on the corrupted file → SizeMismatch
    match verify_release(&dir, &manifest, ReleaseVerifyMode::Full, None) {
        Err(IndexError::SizeMismatch { file, .. }) => assert_eq!(file, "band_1.arrow"),
        other => panic!("expected SizeMismatch, got {other:?}"),
    }

    // 8) restore identical bytes: size matches, mtime changed → Stamp catches mtime
    fs::write(dir.join("band_1.arrow"), &band1_bytes).unwrap();
    match verify_release(&dir, &manifest, ReleaseVerifyMode::Stamp, Some(&stamp_dir)) {
        Err(IndexError::StampMismatch { file, field, .. }) => {
            assert_eq!(file, "band_1.arrow");
            assert_eq!(field, "mtime_ms");
        }
        // Some filesystems can restore an identical mtime within the same ms tick — then the
        // stamp legitimately passes. Accept, but only the pass.
        Ok(VerifyOutcome::StampPass { .. }) => {}
        other => panic!("expected StampMismatch(mtime_ms) or pass, got {other:?}"),
    }
    // Full re-verify re-stamps → Stamp passes again
    verify_release(&dir, &manifest, ReleaseVerifyMode::Full, Some(&stamp_dir)).unwrap();
    verify_release(&dir, &manifest, ReleaseVerifyMode::Stamp, Some(&stamp_dir)).unwrap();

    // 9) wrong per-file sha in manifest → Full ChecksumMismatch
    let mut bad = manifest.clone();
    bad.bands[0].sha256 = "0".repeat(64);
    match verify_release(&dir, &bad, ReleaseVerifyMode::Full, None) {
        Err(IndexError::ChecksumMismatch { file, .. }) => assert_eq!(file, "band_0.arrow"),
        other => panic!("expected ChecksumMismatch, got {other:?}"),
    }

    // 10) wrong aggregate md5 → Full AggregateMismatch
    let mut bad = manifest.clone();
    bad.aggregate_md5 = "f".repeat(32);
    match verify_release(&dir, &bad, ReleaseVerifyMode::Full, None) {
        Err(IndexError::AggregateMismatch { .. }) => {}
        other => panic!("expected AggregateMismatch, got {other:?}"),
    }

    let _ = fs::remove_dir_all(&root);
}
