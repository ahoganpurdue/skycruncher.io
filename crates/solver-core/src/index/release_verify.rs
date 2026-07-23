//! Release checksum policy — three modes, all loud-refuse on any mismatch:
//!   Full  — stream-sha256 every data file vs the manifest, recompute the aggregate md5
//!           (sorted newline-joined "file:sha256" lines + trailing newline — the builder's
//!           serializeIndex recipe), then write a stamp JSON to a caller-supplied stamp dir.
//!   Stamp — re-hash manifest.json vs the stamped sha256 + size/mtime stat of every data file
//!           vs the stamp (<5 ms warm path). A missing stamp refuses: run Full first.
//!   None  — returns `SkippedUnverified` (receipt marker SKIPPED_UNVERIFIED; benchmarks only).

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use md5::Md5;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solver_contracts::config::ReleaseVerifyMode;

use super::manifest::Manifest;
use super::IndexError;

/// Verification outcome, carried into receipts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyOutcome {
    FullPass { files: u32 },
    StampPass { files: u32 },
    SkippedUnverified,
}

impl VerifyOutcome {
    /// Receipt marker string (IndexProvenance.verify_mode).
    pub fn receipt_marker(&self) -> &'static str {
        match self {
            VerifyOutcome::FullPass { .. } => "FULL",
            VerifyOutcome::StampPass { .. } => "STAMP",
            VerifyOutcome::SkippedUnverified => "SKIPPED_UNVERIFIED",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct StampFile {
    name: String,
    bytes: u64,
    mtime_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Stamp {
    release: String,
    /// sha256 of manifest.json bytes at Full-verification time.
    manifest_sha256: String,
    files: Vec<StampFile>,
}

fn io_err(path: &Path, e: std::io::Error) -> IndexError {
    IndexError::Io {
        path: path.display().to_string(),
        source: e,
    }
}

fn sha256_file(path: &Path) -> Result<(String, u64), IndexError> {
    let mut f = File::open(path).map_err(|e| io_err(path, e))?;
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; 4 << 20];
    let mut total: u64 = 0;
    loop {
        let n = f.read(&mut chunk).map_err(|e| io_err(path, e))?;
        if n == 0 {
            break;
        }
        hasher.update(&chunk[..n]);
        total += n as u64;
    }
    Ok((hex(&hasher.finalize()), total))
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// The builder's aggregate recipe: sorted "file:sha256" lines, '\n'-joined, trailing '\n', md5.
pub fn aggregate_md5(pairs: &[(String, String)]) -> String {
    let mut lines: Vec<String> = pairs.iter().map(|(f, s)| format!("{f}:{s}")).collect();
    lines.sort_unstable();
    let mut joined = lines.join("\n");
    joined.push('\n');
    let mut h = Md5::new();
    md5::Digest::update(&mut h, joined.as_bytes());
    hex(&md5::Digest::finalize(h))
}

fn data_files(manifest: &Manifest) -> Vec<(&str, &str, u64)> {
    let mut v: Vec<(&str, &str, u64)> = Vec::with_capacity(1 + manifest.bands.len());
    v.push((manifest.stars.file.as_str(), manifest.stars.sha256.as_str(), manifest.stars.bytes));
    for b in &manifest.bands {
        v.push((b.file.as_str(), b.sha256.as_str(), b.bytes));
    }
    v
}

fn stamp_path(stamp_dir: &Path, manifest: &Manifest) -> PathBuf {
    stamp_dir.join(format!("{}.stamp.json", manifest.release))
}

fn file_stat(path: &Path) -> Result<(u64, u64), IndexError> {
    let meta = std::fs::metadata(path).map_err(|e| io_err(path, e))?;
    let mtime = meta
        .modified()
        .map_err(|e| io_err(path, e))?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok((meta.len(), mtime))
}

/// Run the configured verification policy on a release directory.
/// `stamp_dir` is caller-supplied: Full writes a stamp there (if given), Stamp requires one.
pub fn verify_release(
    dir: &Path,
    manifest: &Manifest,
    mode: ReleaseVerifyMode,
    stamp_dir: Option<&Path>,
) -> Result<VerifyOutcome, IndexError> {
    match mode {
        ReleaseVerifyMode::None => Ok(VerifyOutcome::SkippedUnverified),
        ReleaseVerifyMode::Full => verify_full(dir, manifest, stamp_dir),
        ReleaseVerifyMode::Stamp => verify_stamp(dir, manifest, stamp_dir),
    }
}

fn verify_full(
    dir: &Path,
    manifest: &Manifest,
    stamp_dir: Option<&Path>,
) -> Result<VerifyOutcome, IndexError> {
    let files = data_files(manifest);
    let mut computed: Vec<(String, String)> = Vec::with_capacity(files.len());
    let mut stamped: Vec<StampFile> = Vec::with_capacity(files.len());
    for (name, expected_sha, expected_bytes) in &files {
        let path = dir.join(name);
        let (sha, size) = sha256_file(&path)?;
        if size != *expected_bytes {
            return Err(IndexError::SizeMismatch {
                file: (*name).to_string(),
                expected: *expected_bytes,
                actual: size,
            });
        }
        if sha != expected_sha.to_ascii_lowercase() {
            return Err(IndexError::ChecksumMismatch {
                file: (*name).to_string(),
                expected: (*expected_sha).to_string(),
                actual: sha,
            });
        }
        let (stat_bytes, mtime_ms) = file_stat(&path)?;
        stamped.push(StampFile {
            name: (*name).to_string(),
            bytes: stat_bytes,
            mtime_ms,
        });
        computed.push(((*name).to_string(), sha));
    }
    let agg = aggregate_md5(&computed);
    if agg != manifest.aggregate_md5.to_ascii_lowercase() {
        return Err(IndexError::AggregateMismatch {
            expected: manifest.aggregate_md5.clone(),
            actual: agg,
        });
    }

    if let Some(sd) = stamp_dir {
        let manifest_path = dir.join("manifest.json");
        let (manifest_sha, _) = sha256_file(&manifest_path)?;
        let stamp = Stamp {
            release: manifest.release.clone(),
            manifest_sha256: manifest_sha,
            files: stamped,
        };
        std::fs::create_dir_all(sd).map_err(|e| io_err(sd, e))?;
        let sp = stamp_path(sd, manifest);
        let json = serde_json::to_string_pretty(&stamp).expect("stamp serialization");
        std::fs::write(&sp, json).map_err(|e| io_err(&sp, e))?;
    }
    Ok(VerifyOutcome::FullPass {
        files: files.len() as u32,
    })
}

fn verify_stamp(
    dir: &Path,
    manifest: &Manifest,
    stamp_dir: Option<&Path>,
) -> Result<VerifyOutcome, IndexError> {
    let sd = stamp_dir.ok_or_else(|| {
        IndexError::StampMissing("<no stamp_dir supplied for Stamp mode>".to_string())
    })?;
    let sp = stamp_path(sd, manifest);
    if !sp.exists() {
        return Err(IndexError::StampMissing(sp.display().to_string()));
    }
    let bytes = std::fs::read(&sp).map_err(|e| io_err(&sp, e))?;
    let stamp: Stamp = serde_json::from_slice(&bytes).map_err(|e| IndexError::StampParse {
        path: sp.display().to_string(),
        msg: e.to_string(),
    })?;
    if stamp.release != manifest.release {
        return Err(IndexError::StampMismatch {
            file: "manifest.json".into(),
            field: "release".into(),
            expected: stamp.release,
            actual: manifest.release.clone(),
        });
    }

    // Manifest re-hash: any manifest change invalidates the stamp.
    let manifest_path = dir.join("manifest.json");
    let (manifest_sha, _) = sha256_file(&manifest_path)?;
    if manifest_sha != stamp.manifest_sha256 {
        return Err(IndexError::ManifestChanged {
            expected: stamp.manifest_sha256,
            actual: manifest_sha,
        });
    }

    // The stamp must cover exactly the manifest's data files.
    let files = data_files(manifest);
    if stamp.files.len() != files.len() {
        return Err(IndexError::StampMismatch {
            file: "<stamp>".into(),
            field: "file_count".into(),
            expected: stamp.files.len().to_string(),
            actual: files.len().to_string(),
        });
    }
    for (name, _, _) in &files {
        let sf = stamp
            .files
            .iter()
            .find(|s| s.name == *name)
            .ok_or_else(|| IndexError::StampMismatch {
                file: (*name).to_string(),
                field: "presence".into(),
                expected: "stamped".into(),
                actual: "missing from stamp".into(),
            })?;
        let path = dir.join(name);
        let (size, mtime_ms) = file_stat(&path)?;
        if size != sf.bytes {
            return Err(IndexError::StampMismatch {
                file: (*name).to_string(),
                field: "bytes".into(),
                expected: sf.bytes.to_string(),
                actual: size.to_string(),
            });
        }
        if mtime_ms != sf.mtime_ms {
            return Err(IndexError::StampMismatch {
                file: (*name).to_string(),
                field: "mtime_ms".into(),
                expected: sf.mtime_ms.to_string(),
                actual: mtime_ms.to_string(),
            });
        }
    }
    Ok(VerifyOutcome::StampPass {
        files: files.len() as u32,
    })
}
