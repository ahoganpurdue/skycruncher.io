//! g15u quad-index release access (M1 lane).
//!
//! Layers:
//!   manifest        — serde model of `manifest.json` + loud-refuse structural validation
//!   release_verify  — checksum policy (Full sha256+md5 / Stamp size+mtime / None=SKIPPED_UNVERIFIED)
//!   mmap_arrow      — zero-copy mmap → Arrow IPC column views (`ScalarBuffer` per column)
//!   band            — per-band prefix-table key lookup over the sorted `code_key` column
//!   probe           — sorted (key, slot) probe blocks swept against a band (near-sequential merge-join)
//!
//! Everything loud-refuses on mismatch: schema, counts, checksums, sort order. No env reads.

pub mod band;
pub mod manifest;
pub mod mmap_arrow;
pub mod probe;
pub mod release_verify;

use std::path::{Path, PathBuf};
use std::time::Instant;

use solver_contracts::config::ReleaseVerifyMode;

use self::band::Band;
use self::manifest::Manifest;
use self::mmap_arrow::StarTable;
use self::release_verify::VerifyOutcome;

/// Typed loud-refuse errors for every index failure mode.
#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("index I/O error on {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("manifest parse refused ({path}): {msg}")]
    ManifestParse { path: String, msg: String },
    #[error("manifest validation refused: {0}")]
    Validation(String),
    #[error("arrow parse refused ({path}): {msg}")]
    Arrow { path: String, msg: String },
    #[error("schema refused ({path}): {msg}")]
    Schema { path: String, msg: String },
    #[error("checksum mismatch {file}: manifest sha256 {expected} != computed {actual}")]
    ChecksumMismatch {
        file: String,
        expected: String,
        actual: String,
    },
    #[error("size mismatch {file}: manifest {expected} bytes != actual {actual} bytes")]
    SizeMismatch {
        file: String,
        expected: u64,
        actual: u64,
    },
    #[error("aggregate md5 mismatch: manifest {expected} != computed {actual}")]
    AggregateMismatch { expected: String, actual: String },
    #[error("verify stamp missing at {0} — run a Full verification pass first")]
    StampMissing(String),
    #[error("verify stamp parse refused ({path}): {msg}")]
    StampParse { path: String, msg: String },
    #[error("manifest changed since stamp: stamped sha256 {expected} != current {actual}")]
    ManifestChanged { expected: String, actual: String },
    #[error("stamp mismatch {file} ({field}): stamped {expected} != actual {actual}")]
    StampMismatch {
        file: String,
        field: String,
        expected: String,
        actual: String,
    },
}

/// Wall-clock accounting for the open path (receipt telemetry feed).
#[derive(Debug, Default, Clone)]
pub struct IndexOpenStats {
    pub verify_ms: u64,
    /// Sequential page-warm passes (0 when Full verify already streamed every byte).
    pub prefetch_ms: u64,
    /// mmap + IPC footer/batch parse + column validation.
    pub parse_ms: u64,
    /// Cumulative prefix-table build time (updated by `build_prefix_tables`).
    pub prefix_build_ms: u64,
}

/// An opened g15u release: manifest + verification outcome + star table + 15 bands.
pub struct QuadIndex {
    pub dir: PathBuf,
    pub manifest: Manifest,
    pub verify: VerifyOutcome,
    pub stars: StarTable,
    pub bands: Vec<Band>,
    pub open_stats: IndexOpenStats,
}

impl QuadIndex {
    /// Open a release directory: manifest load+validate → checksum policy → mmap all Arrow
    /// files with schema/count/sort validation. `stamp_dir` is caller-supplied (needed for
    /// `Full` stamp writing and `Stamp` reading). `prefetch` runs a sequential page-warm pass
    /// per file (HDD reality; skipped when `Full` verification already streamed the bytes).
    pub fn open(
        dir: &Path,
        mode: ReleaseVerifyMode,
        stamp_dir: Option<&Path>,
        prefetch: bool,
    ) -> Result<Self, IndexError> {
        let manifest = Manifest::load(&dir.join("manifest.json"))?;
        manifest.validate()?;

        let t_verify = Instant::now();
        let verify = release_verify::verify_release(dir, &manifest, mode, stamp_dir)?;
        let verify_ms = t_verify.elapsed().as_millis() as u64;

        // Full verification already read every byte sequentially — a second pass is wasted I/O.
        let do_prefetch = prefetch && mode != ReleaseVerifyMode::Full;

        let mut stats = IndexOpenStats {
            verify_ms,
            ..Default::default()
        };

        let (stars, s_stats) =
            StarTable::open(&dir.join(&manifest.stars.file), manifest.stars.rows, do_prefetch)?;
        stats.prefetch_ms += s_stats.prefetch_ms;
        stats.parse_ms += s_stats.parse_ms;

        let batch_rows = manifest.schema.batch_rows as usize;
        let mut bands = Vec::with_capacity(manifest.bands.len());
        for blob in &manifest.bands {
            let (view, b_stats) =
                mmap_arrow::BandView::open(&dir.join(&blob.file), blob, batch_rows, do_prefetch)?;
            stats.prefetch_ms += b_stats.prefetch_ms;
            stats.parse_ms += b_stats.parse_ms;
            bands.push(Band::new(blob, view));
        }

        Ok(Self {
            dir: dir.to_path_buf(),
            manifest,
            verify,
            stars,
            bands,
            open_stats: stats,
        })
    }

    /// Build prefix tables for the given bands, explicitly, in the prepare phase — the solve
    /// loop never allocates. Idempotent per band.
    pub fn build_prefix_tables(&mut self, bands: &[u32]) -> Result<(), IndexError> {
        let t = Instant::now();
        for &b in bands {
            let band = self
                .bands
                .get_mut(b as usize)
                .ok_or_else(|| IndexError::Validation(format!("band index {b} out of range")))?;
            band.build_prefix_table();
        }
        self.open_stats.prefix_build_ms += t.elapsed().as_millis() as u64;
        Ok(())
    }

    #[inline]
    pub fn band(&self, i: u32) -> &Band {
        &self.bands[i as usize]
    }
}
