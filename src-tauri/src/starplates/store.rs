//! Local content-addressed starplates store (spec §6).
//!
//! Layout:
//! ```text
//! <store>/
//!   pinned.json                          { release, manifest_sha256 }
//!   releases/<release-id>/manifest.json
//!   cas/<aa>/<sha256>.arrow              immutable blob bytes
//!   quarantine/                          failed-verification blobs (autopsy)
//! ```
//!
//! Verification (spec §6.3): ARROW1 magic on every open; full SHA-256 on
//! install and on first open per session. Verification failure => quarantine,
//! treat locally absent, never fail the query.

use super::geometry::{npix, unit_vec};
use super::manifest::{BlobEntry, Manifest, PinnedRelease};
use super::{sha256_hex, STORE_ENV_OVERRIDE};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

/// serde JSON status blob returned by `starplates_init` / `starplates_status` (spec §5.1).
#[derive(Debug, Clone, serde::Serialize)]
pub struct StarplatesStatus {
    pub release: String,
    pub format_version: u32,
    pub tier_depth_available: String,
    pub cells_total: u32,
    pub cells_populated: u32,
    pub cells_local: u32,
    pub t0_rows: u64,
    pub coverage_t1: f64,
}

/// One T1 cell from the manifest, with precomputed cone bound.
#[derive(Debug, Clone)]
pub struct CellEntry {
    pub cell: u64,
    pub order: u8,
    pub sha256: String,
    pub path: String,
    pub rows: u64,
    /// Data-derived cone bound from the manifest (spec §2.3).
    pub center: [f64; 3],
    pub radius_deg: f64,
}

#[derive(Debug, Clone)]
pub struct T0Entry {
    pub sha256: String,
    pub path: String,
    pub rows: u64,
}

/// Outcome of a verified CAS read.
pub enum CellRead {
    /// Blob not in the local store (never downloaded / seeded).
    Absent,
    /// Blob present but failed verification; it has been quarantined.
    Corrupt,
    Ok(Vec<u8>),
}

#[derive(Debug)]
pub struct StarplatesStore {
    root: PathBuf,
    pub release: String,
    manifest: Manifest,
    /// T1 cells sorted by cell id ascending.
    t1: Vec<CellEntry>,
    t1_ids: HashSet<u64>,
    t1_order: Option<u8>,
    t0: Option<T0Entry>,
    /// SHAs fully verified this session (spec §6.3 per-session verified-set).
    verified: HashSet<String>,
}

impl StarplatesStore {
    // ------------------------------------------------------------------
    // Directory resolution (spec §6.1)
    // ------------------------------------------------------------------

    /// Resolution order: `SKYCRUNCHER_STARPLATES_DIR` env override, then
    /// `<app_local_data_dir>/starplates` (the caller passes the Tauri-resolved
    /// base so this stays testable headless).
    pub fn resolve_root(app_local_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
        if let Ok(v) = std::env::var(STORE_ENV_OVERRIDE) {
            if !v.trim().is_empty() {
                return Ok(PathBuf::from(v));
            }
        }
        app_local_data_dir
            .map(|base| base.join("starplates"))
            .ok_or_else(|| {
                format!(
                    "E_STORE_MISSING: no {STORE_ENV_OVERRIDE} override and the app-local data dir could not be resolved"
                )
            })
    }

    // ------------------------------------------------------------------
    // Atomic writes (spec §6.3)
    // ------------------------------------------------------------------

    /// tmp → flush/fsync → rename, with sharing-violation backoff
    /// (3 tries, 100/300/900 ms) — spec §6.3 verbatim.
    pub fn atomic_write(final_path: &Path, bytes: &[u8]) -> Result<(), String> {
        let parent = final_path
            .parent()
            .ok_or_else(|| format!("no parent dir for {final_path:?}"))?;
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        let tmp = final_path.with_extension("tmp");
        {
            let mut f = std::fs::File::create(&tmp).map_err(|e| format!("create {tmp:?}: {e}"))?;
            f.write_all(bytes).map_err(|e| format!("write {tmp:?}: {e}"))?;
            f.sync_all().map_err(|e| format!("fsync {tmp:?}: {e}"))?;
        }
        rename_with_backoff(&tmp, final_path)
    }

    /// Verify bytes against `expected_sha` and install into the CAS.
    /// Already-present blobs are left untouched (CAS objects are immutable).
    pub fn install_blob(root: &Path, expected_sha: &str, bytes: &[u8]) -> Result<(), String> {
        let actual = sha256_hex(bytes);
        if actual != expected_sha {
            return Err(format!(
                "blob sha mismatch: expected {expected_sha}, got {actual} — refusing to install"
            ));
        }
        let dest = cas_path_for(root, expected_sha);
        if dest.exists() {
            return Ok(());
        }
        Self::atomic_write(&dest, bytes)
    }

    // ------------------------------------------------------------------
    // First-run seeding from bundled resources (spec §8)
    // ------------------------------------------------------------------

    /// Idempotent: if `pinned.json` already exists the store is left untouched
    /// (returns Ok(false)). Otherwise copies the single bundled release's
    /// manifest into `releases/`, ingests every bundled blob present on disk
    /// (T0 + manifest ship in-app; T1 does not) into the CAS with SHA
    /// verification, and writes `pinned.json` last as the commit point.
    pub fn seed_from_bundle(root: &Path, bundle_root: &Path) -> Result<bool, String> {
        if root.join("pinned.json").exists() {
            return Ok(false);
        }
        if !bundle_root.exists() {
            return Ok(false); // nothing to seed from; open() will report E_STORE_MISSING honestly
        }
        let mut candidates: Vec<PathBuf> = Vec::new();
        let entries = std::fs::read_dir(bundle_root)
            .map_err(|e| format!("E_STORE_MISSING: cannot read bundle dir {bundle_root:?}: {e}"))?;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.join("manifest.json").is_file() {
                candidates.push(p);
            }
        }
        if candidates.is_empty() {
            return Ok(false);
        }
        if candidates.len() > 1 {
            return Err(format!(
                "E_MANIFEST_INVALID: {} bundled releases under {bundle_root:?}; expected exactly one (spec §2.4: the app ships one pinned release)",
                candidates.len()
            ));
        }
        let release_dir = &candidates[0];
        let manifest_bytes = std::fs::read(release_dir.join("manifest.json"))
            .map_err(|e| format!("E_MANIFEST_INVALID: cannot read bundled manifest: {e}"))?;
        let manifest_sha = sha256_hex(&manifest_bytes);
        let manifest = Manifest::parse(&manifest_bytes)?;

        // 1. Manifest into the store.
        let store_manifest = root
            .join("releases")
            .join(&manifest.release)
            .join("manifest.json");
        Self::atomic_write(&store_manifest, &manifest_bytes)?;

        // 2. Every bundled blob that exists on disk (T0 expected; anything else welcome).
        for blob in &manifest.blobs {
            let src = release_dir.join(blob.path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if !src.is_file() {
                continue; // T1 cells are not bundled — lazy sync fills them (spec §4)
            }
            let bytes = std::fs::read(&src).map_err(|e| format!("read bundled blob {src:?}: {e}"))?;
            Self::install_blob(root, &blob.sha256, &bytes)
                .map_err(|e| format!("E_MANIFEST_INVALID: bundled blob {}: {e}", blob.path))?;
        }

        // 3. Pin last — the commit point.
        let pin = PinnedRelease {
            release: manifest.release.clone(),
            manifest_sha256: manifest_sha,
        };
        let pin_bytes = serde_json::to_vec_pretty(&pin).map_err(|e| e.to_string())?;
        Self::atomic_write(&root.join("pinned.json"), &pin_bytes)?;
        log::info!(
            "[starplates] store seeded at {root:?} from bundle: release {}",
            manifest.release
        );
        Ok(true)
    }

    // ------------------------------------------------------------------
    // Open (spec §2.4 pinning + §6.3 manifest verification)
    // ------------------------------------------------------------------

    pub fn open(root: &Path) -> Result<Self, String> {
        let pin_path = root.join("pinned.json");
        let pin_bytes = std::fs::read(&pin_path).map_err(|_| {
            format!(
                "E_STORE_MISSING: {pin_path:?} not found — no seeded/synced starplates store at this location"
            )
        })?;
        let pin: PinnedRelease = serde_json::from_slice(&pin_bytes)
            .map_err(|e| format!("E_MANIFEST_INVALID: pinned.json parse failed: {e}"))?;
        let manifest_path = root
            .join("releases")
            .join(&pin.release)
            .join("manifest.json");
        let manifest_bytes = std::fs::read(&manifest_path)
            .map_err(|_| format!("E_STORE_MISSING: pinned manifest {manifest_path:?} not found"))?;
        let actual_sha = sha256_hex(&manifest_bytes);
        if actual_sha != pin.manifest_sha256 {
            return Err(format!(
                "E_MANIFEST_INVALID: manifest sha {actual_sha} does not match pin {} — refusing tampered/torn manifest (spec §6.3)",
                pin.manifest_sha256
            ));
        }
        let manifest = Manifest::parse(&manifest_bytes)?;
        if manifest.release != pin.release {
            return Err(format!(
                "E_MANIFEST_INVALID: manifest release {:?} does not match pin {:?}",
                manifest.release, pin.release
            ));
        }

        let mut t1: Vec<CellEntry> = Vec::new();
        let mut t0: Option<T0Entry> = None;
        let mut t1_order: Option<u8> = None;
        for blob in &manifest.blobs {
            match blob.tier.as_str() {
                "t0" => {
                    t0 = Some(T0Entry {
                        sha256: blob.sha256.clone(),
                        path: blob.path.clone(),
                        rows: blob.rows,
                    });
                }
                "t1" => {
                    // validate() guarantees these are present
                    let order = blob.healpix_order.unwrap();
                    match t1_order {
                        None => t1_order = Some(order),
                        Some(o) if o == order => {}
                        Some(o) => {
                            return Err(format!(
                                "E_MANIFEST_INVALID: mixed t1 healpix orders {o} and {order}"
                            ));
                        }
                    }
                    t1.push(CellEntry {
                        cell: blob.cell.unwrap(),
                        order,
                        sha256: blob.sha256.clone(),
                        path: blob.path.clone(),
                        rows: blob.rows,
                        center: unit_vec(blob.center_ra_deg.unwrap(), blob.center_dec_deg.unwrap()),
                        radius_deg: blob.radius_deg.unwrap(),
                    });
                }
                "t2" => {
                    log::warn!(
                        "[starplates] manifest carries t2 blob {} — t2 serving is reserved this wave (spec §4); blob ignored",
                        blob.path
                    );
                }
                _ => unreachable!("validate() rejects unknown tiers"),
            }
        }
        t1.sort_by_key(|c| c.cell);
        let t1_ids: HashSet<u64> = t1.iter().map(|c| c.cell).collect();

        Ok(Self {
            root: root.to_path_buf(),
            release: manifest.release.clone(),
            manifest,
            t1,
            t1_ids,
            t1_order,
            t0,
            verified: HashSet::new(),
        })
    }

    // ------------------------------------------------------------------
    // Accessors
    // ------------------------------------------------------------------

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn t1_cells(&self) -> &[CellEntry] {
        &self.t1
    }

    pub fn t1_cell_ids(&self) -> &HashSet<u64> {
        &self.t1_ids
    }

    pub fn t1_order(&self) -> Option<u8> {
        self.t1_order
    }

    pub fn t0(&self) -> Option<&T0Entry> {
        self.t0.as_ref()
    }

    pub fn cas_path(&self, sha: &str) -> PathBuf {
        cas_path_for(&self.root, sha)
    }

    pub fn blob_local(&self, sha: &str) -> bool {
        self.cas_path(sha).is_file()
    }

    pub fn blobs(&self) -> &[BlobEntry] {
        &self.manifest.blobs
    }

    // ------------------------------------------------------------------
    // Verified reads + self-heal (spec §6.3)
    // ------------------------------------------------------------------

    /// Read a CAS blob with the §6.3 verification ladder:
    /// ARROW1 magic on every open, full SHA-256 on first open per session.
    /// Failure quarantines the blob and reports `Corrupt` (treated as locally
    /// absent by the query layer — corruption never fails a solve).
    pub fn read_blob_verified(&mut self, sha: &str, label: &str) -> CellRead {
        let path = self.cas_path(sha);
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return CellRead::Absent,
            Err(e) => {
                log::warn!("[starplates] E_CELL_CORRUPT:{label}: unreadable ({e}) — treating absent");
                return CellRead::Absent;
            }
        };
        if bytes.len() < 12 || &bytes[0..6] != super::arrow_io::ARROW_FILE_MAGIC {
            log::warn!("[starplates] E_CELL_CORRUPT:{label}: bad ARROW1 magic — quarantining");
            self.quarantine(sha);
            return CellRead::Corrupt;
        }
        if !self.verified.contains(sha) {
            let actual = sha256_hex(&bytes);
            if actual != sha {
                log::warn!(
                    "[starplates] E_CELL_CORRUPT:{label}: sha mismatch (got {actual}) — quarantining"
                );
                self.quarantine(sha);
                return CellRead::Corrupt;
            }
            self.verified.insert(sha.to_string());
        }
        CellRead::Ok(bytes)
    }

    /// Mark a blob's session verification as void (used after quarantine).
    fn quarantine(&mut self, sha: &str) {
        self.verified.remove(sha);
        let src = self.cas_path(sha);
        let qdir = self.root.join("quarantine");
        if let Err(e) = std::fs::create_dir_all(&qdir) {
            log::warn!("[starplates] quarantine mkdir failed: {e}");
            return;
        }
        let dest = qdir.join(format!("{sha}.arrow"));
        // Best effort — if the rename fails we still treat the cell absent this
        // session; a later session will re-verify and retry.
        if let Err(e) = std::fs::rename(&src, &dest) {
            log::warn!("[starplates] quarantine rename {src:?} -> {dest:?} failed: {e}");
        }
    }

    // ------------------------------------------------------------------
    // Status (spec §5.1)
    // ------------------------------------------------------------------

    pub fn status(&self) -> StarplatesStatus {
        let cells_total: u32 = self
            .t1_order
            .map(|o| npix(o).min(u32::MAX as u64) as u32)
            .unwrap_or(0);
        let cells_populated = self.t1.len() as u32;
        let cells_local = self.t1.iter().filter(|c| self.blob_local(&c.sha256)).count() as u32;
        let t0_local = self
            .t0
            .as_ref()
            .map(|t| self.blob_local(&t.sha256))
            .unwrap_or(false);
        let t0_rows = if t0_local {
            self.t0.as_ref().map(|t| t.rows).unwrap_or(0)
        } else {
            0
        };
        let tier_depth_available = if cells_local > 0 {
            "t1"
        } else if t0_local {
            "t0"
        } else {
            "none"
        };
        let coverage_t1 = if cells_total > 0 {
            cells_populated as f64 / cells_total as f64
        } else {
            0.0
        };
        StarplatesStatus {
            release: self.release.clone(),
            format_version: self.manifest.format_version,
            tier_depth_available: tier_depth_available.to_string(),
            cells_total,
            cells_populated,
            cells_local,
            t0_rows,
            coverage_t1,
        }
    }
}

pub fn cas_path_for(root: &Path, sha: &str) -> PathBuf {
    let shard = &sha[0..2.min(sha.len())];
    root.join("cas").join(shard).join(format!("{sha}.arrow"))
}

/// `std::fs::rename` with the §6.3 backoff (3 tries, 100/300/900 ms) — Windows
/// Defender/indexers briefly hold new files (ERROR_SHARING_VIOLATION).
pub(crate) fn rename_with_backoff(from: &Path, to: &Path) -> Result<(), String> {
    let mut last_err = String::new();
    for (attempt, delay_ms) in [(0u32, 100u64), (1, 300), (2, 900)] {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = format!("rename {from:?} -> {to:?} (attempt {}): {e}", attempt + 1);
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            }
        }
    }
    // Final attempt after the last backoff window.
    std::fs::rename(from, to).map_err(|e| format!("{last_err}; final: {e}"))
}
