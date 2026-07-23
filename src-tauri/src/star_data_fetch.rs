//! In-app star-data download — provision the R2 star-data releases from the app.
//!
//! The desktop equivalent of `tools/setup/fetch_index.mjs`. Two release KINDS
//! share one streamed-fetch + sha-verify + progress-event engine, selected by the
//! `kind` command arg (`"index"` default / `"atlas"`):
//!   • INDEX — the greenfield g15u BAND-FILE release (manifest.json + stars.arrow
//!     + band_0..14) → the machine's `index_root` (the dir the greenfield solver
//!     reads; resolved by `greenfield_solve::resolve_quadidx_dir`). Reassembles
//!     the chunked band_0 from `band_0.parts.json` (`skycruncher.r2.chunked-object/1`).
//!   • ATLAS — the browser/legacy-lane deep-catalog atlas aggregate
//!     (`skycruncher.r2.atlas-aggregate/1`: `files[]` + `sectors/`) → `atlas_root`
//!     (default `<app_local>/data/atlas` = the storagePaths atlas_root default the TS
//!     confirm-lane loader reads, `storage.json` `atlas_root` override). Plans
//!     the live JSON sector set (`role: sector-json-live`, ~340 MB); the atlas
//!     path join (`sectors/<key>`) lets download_object/status/verify be REUSED
//!     verbatim. Contract: `docs/R2_STARDATA_LAYOUT.md` §2.
//! Every file's sha256 is verified against the manifest; per-file + overall
//! progress is emitted to the webview.
//!
//! Generalized from index-only per owner sign-off 2026-07-22 ("we have the
//! functionality in the app to pull in stars and quads" — the LAW-5 grant for
//! this scope: `star_data_fetch.rs` + the app-side row).
//!
//! Ledger: N/A (transport + integrity only; no COORDINATE/PIXEL math, no binary
//! boundary — the Arrow/JSON bytes are verified opaque against the manifest sha).
//!
//! The base URL / release prefix are NEVER hardcoded here — the UI passes them
//! from the shared config point `src/config/starDataSource.ts` across IPC (LAW 6).
//! Nothing in this module is reachable except through the four explicit commands;
//! it is never invoked implicitly by the solve path.

use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

use crate::greenfield_solve::resolve_quadidx_dir;

/// Event name for streamed download/verify progress (webview listens via
/// `@tauri-apps/api/event`; `core:event:default` covers listen).
const PROGRESS_EVENT: &str = "star-data-progress";

/// Per-object HTTP total budget (generous — the cancel flag is the user's control).
const OBJECT_TIMEOUT_SECS: u64 = 1200;

/// Max attempts per single object (resume-based; chunked bands restart per call).
const MAX_ATTEMPTS: u32 = 3;

/// Progress emit throttle during streaming.
const PROGRESS_THROTTLE: Duration = Duration::from_millis(200);

const STREAM_BUF: usize = 256 * 1024;

// ─── shared cancel/running control (held in AppState) ───────────────────────────

/// Download control shared with the app state. `cancel` is checked between chunks
/// and at every file boundary; `running` guards against concurrent downloads.
#[derive(Default)]
pub struct StarDataControl {
    pub cancel: AtomicBool,
    pub running: AtomicBool,
}

// ─── R2 manifest shapes (extra fields ignored by serde) ─────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct FileEntry {
    file: String,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    bytes: Option<u64>,
}

/// One entry of an `atlas-aggregate/1` manifest (`files[]`). `key` is the BARE
/// object name (e.g. `level_3_sector_0.json`); the object lives under the release
/// prefix at `sectors/<key>` (see `planned_files`). `role` distinguishes the live
/// JSON sector set (`sector-json-live`) that `star_catalog_adapter` loads from the
/// dormant `sector-arrow-twin` mirror (docs/R2_STARDATA_LAYOUT.md §2).
#[derive(Debug, Clone, Deserialize)]
struct AtlasFileEntry {
    key: String,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    bytes: Option<u64>,
    #[serde(default)]
    role: Option<String>,
}

/// The R2 release manifest. TWO shapes share this one struct (extra fields ignored
/// by serde), disambiguated by which array is present (never both):
///   • g15u INDEX release (`starplates-*-quadidx-*`): `stars` + `bands`.
///   • ATLAS aggregate (`schema: skycruncher.r2.atlas-aggregate/1`): `files[]`.
/// `planned_files` flattens whichever is present (atlas detected by `files`).
/// `release` populates the status/report label for both.
#[derive(Debug, Clone, Deserialize)]
struct IndexManifest {
    #[serde(default)]
    release: Option<String>,
    #[serde(default)]
    stars: Option<FileEntry>,
    #[serde(default)]
    bands: Option<Vec<FileEntry>>,
    /// Atlas-aggregate object list (`sectors/*`). None on an index manifest.
    #[serde(default)]
    files: Option<Vec<AtlasFileEntry>>,
}

#[derive(Debug, Clone, Deserialize)]
struct WholeInfo {
    #[serde(default)]
    bytes: Option<u64>,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PartEntry {
    order: i64,
    key: String,
    #[serde(default)]
    bytes: Option<u64>,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PartsManifest {
    #[serde(default)]
    schema: Option<String>,
    whole: WholeInfo,
    #[serde(default)]
    parts: Vec<PartEntry>,
}

/// One data file the fetcher must ensure locally (flattened from the manifest).
#[derive(Debug, Clone)]
struct PlannedFile {
    file: String,
    sha256: Option<String>,
    bytes: u64,
}

/// `sectors/<key>` join for an atlas object key (idempotent if already prefixed;
/// normalises any backslashes a manifest might carry to the forward-slash the URL
/// suffix + relative local path both use).
fn atlas_object_path(key: &str) -> String {
    let k = key.replace('\\', "/");
    if k.starts_with("sectors/") {
        k
    } else {
        format!("sectors/{k}")
    }
}

fn planned_files(m: &IndexManifest) -> Vec<PlannedFile> {
    // ── ATLAS aggregate (`files[]` present) ──────────────────────────────────
    // Plan the LIVE JSON sector set ONLY — the set `star_catalog_adapter` loads
    // (docs/R2_STARDATA_LAYOUT.md §2). The dormant `sector-arrow-twin` objects
    // (~195 MB of the 535 MB release) are NOT consumed, so honest sizes = the
    // ~340 MB live set. Each object lives at `sectors/<key>` under the release
    // prefix, so `file` carries that join: the wire URL is `{base}/{prefix}/{file}`
    // and the local dest is `{atlas_root}/{file}` — download_object/reassemble/
    // status/verify are reused UNCHANGED (they operate on `file` verbatim).
    if let Some(files) = &m.files {
        let mut out = Vec::new();
        for f in files {
            let is_live = match f.role.as_deref() {
                Some(role) => role == "sector-json-live",
                None => f.key.ends_with(".json"), // robust when a manifest omits role
            };
            if !is_live {
                continue;
            }
            out.push(PlannedFile {
                file: atlas_object_path(&f.key),
                sha256: f.sha256.clone(),
                bytes: f.bytes.unwrap_or(0),
            });
        }
        return out;
    }

    // ── INDEX manifest (`stars` + `bands`) — UNCHANGED ───────────────────────
    let mut out = Vec::new();
    let mut push = |f: &FileEntry| {
        out.push(PlannedFile {
            file: f.file.clone(),
            sha256: f.sha256.clone(),
            bytes: f.bytes.unwrap_or(0),
        });
    };
    if let Some(s) = &m.stars {
        push(s);
    }
    for b in m.bands.as_deref().unwrap_or(&[]) {
        push(b);
    }
    out
}

/// `band_0.arrow` → `band_0.parts.json` (drop `.arrow`, add `.parts.json`).
fn parts_manifest_key(file: &str) -> String {
    match file.strip_suffix(".arrow") {
        Some(stem) => format!("{stem}.parts.json"),
        None => format!("{file}.parts.json"),
    }
}

// ─── IPC-facing result shapes (field names are the TS contract) ─────────────────

/// Per-file presence state for the status probe (size only — NO sha, fast).
/// `state` ∈ `"missing" | "present" | "size_mismatch"`.
#[derive(Debug, Clone, Serialize)]
pub struct StarDataFileStatus {
    pub file: String,
    pub bytes: u64,
    pub state: String,
}

/// Local-provisioning status of the index (honest: presence + size, never sha here).
#[derive(Debug, Clone, Serialize)]
pub struct StarDataStatus {
    pub index_root: String,
    /// Where the enumerating manifest came from (`"local"`, a URL, or `null`).
    pub manifest_source: Option<String>,
    pub release: Option<String>,
    pub file_count: u32,
    pub total_bytes: u64,
    /// Files whose local size matches the manifest (NOT sha-verified — see verify).
    pub present_count: u32,
    pub present_bytes: u64,
    pub files: Vec<StarDataFileStatus>,
}

/// Per-file outcome of a download/verify pass (sha-checked).
/// `state` ∈ `"verified" | "missing" | "mismatch" | "error" | "skipped"`.
#[derive(Debug, Clone, Serialize)]
pub struct StarDataFileResult {
    pub file: String,
    pub bytes: u64,
    pub state: String,
    pub fetched_bytes: u64,
    pub reason: Option<String>,
}

/// Result of a download or verify pass.
#[derive(Debug, Clone, Serialize)]
pub struct StarDataReport {
    /// `"download"` | `"verify"`.
    pub phase: String,
    pub index_root: String,
    pub manifest_source: Option<String>,
    pub release: Option<String>,
    pub file_count: u32,
    pub total_bytes: u64,
    /// Files present locally AND sha-matched against the manifest.
    pub verified_count: u32,
    /// Files newly downloaded this pass (subset of verified).
    pub downloaded_count: u32,
    pub bytes_fetched: u64,
    pub cancelled: bool,
    /// `verified_count == file_count && file_count > 0` — the only honest "done".
    pub complete: bool,
    pub files: Vec<StarDataFileResult>,
}

/// Streamed progress event payload (throttled during transfer).
#[derive(Debug, Clone, Serialize)]
pub struct StarDataProgress {
    /// `"download"` | `"verify"` | `"reassemble"`.
    pub phase: String,
    pub file: String,
    /// 1-based index of the current file.
    pub file_index: u32,
    pub file_count: u32,
    pub file_done_bytes: u64,
    pub file_total_bytes: u64,
    pub overall_done_bytes: u64,
    pub overall_total_bytes: u64,
}

// ─── HTTP + hashing helpers ─────────────────────────────────────────────────────

fn agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .build();
    let config = ureq::Agent::config_builder()
        .tls_config(tls)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(OBJECT_TIMEOUT_SECS)))
        .build();
    ureq::Agent::new_with_config(config)
}

fn finalize_hex(hasher: Sha256) -> String {
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    use std::fmt::Write as _;
    for b in digest {
        let _ = write!(out, "{:02x}", b);
    }
    out
}

/// Streaming sha256 of an existing file (verify already-present files).
fn sha256_of_file_streaming(path: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; STREAM_BUF];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("E_CANCELLED".to_string());
        }
        let n = f.read(&mut buf).map_err(|e| format!("read {path:?}: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(finalize_hex(hasher))
}

/// Feed an existing file's whole content into `hasher`; returns bytes hashed.
fn prehash_prefix(path: &Path, hasher: &mut Sha256, cancel: &AtomicBool) -> Result<u64, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
    let mut buf = [0u8; STREAM_BUF];
    let mut total = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("E_CANCELLED".to_string());
        }
        let n = f.read(&mut buf).map_err(|e| format!("read {path:?}: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok(total)
}

fn part_path(dest: &Path) -> PathBuf {
    PathBuf::from(format!("{}.part", dest.display()))
}

/// Read a whole (small) HTTP body via the streaming reader (`as_reader` — the
/// proven ureq 3.x path used by starplates/sync.rs; avoids any convenience-method
/// size cap). Only used for small JSON (manifest.json / *.parts.json).
fn read_body_all(body: &mut ureq::Body) -> Result<Vec<u8>, String> {
    let mut reader = body.as_reader();
    let mut buf = Vec::new();
    reader.read_to_end(&mut buf).map_err(|e| format!("read body: {e}"))?;
    Ok(buf)
}

fn rename_with_retry(from: &Path, to: &Path) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..5 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = format!("rename {from:?} -> {to:?}: {e}");
                std::thread::sleep(Duration::from_millis(50 * (attempt + 1)));
            }
        }
    }
    Err(last)
}

/// Outcome of a single-object / chunked acquisition.
enum Acq {
    /// Verified on disk; carries bytes fetched over the wire this call.
    Verified(u64),
    /// User cancelled mid-transfer (partial left for a single-object resume).
    Cancelled,
}

/// Download one single R2 object into `dest` with HTTP Range resume and
/// incremental sha256 (pre-hashing a resumed prefix). Verifies size + sha256.
/// `on_bytes(file_done_bytes)` is called as bytes land (caller throttles/accounts).
fn download_object(
    agent: &ureq::Agent,
    url: &str,
    dest: &Path,
    expected_sha: Option<&str>,
    expected_bytes: u64,
    on_bytes: &mut dyn FnMut(u64),
    cancel: &AtomicBool,
) -> Result<Acq, String> {
    let tmp = part_path(dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
    }

    // Resume bookkeeping: a leftover .part longer than the manifest size is garbage.
    let mut offset: u64 = match std::fs::metadata(&tmp) {
        Ok(m) if expected_bytes > 0 && m.len() > expected_bytes => {
            let _ = std::fs::remove_file(&tmp);
            0
        }
        Ok(m) => m.len(),
        Err(_) => 0,
    };

    let mut hasher = Sha256::new();
    // Does `hasher` cover the whole final file? Only when a network path fed it.
    let mut hasher_has_full = false;
    let mut fetched: u64 = 0;

    let already_complete = expected_bytes > 0 && offset >= expected_bytes;
    if !already_complete {
        let mut req = agent.get(url);
        if offset > 0 {
            req = req.header("Range", &format!("bytes={offset}-"));
        }
        let mut resp = req.call().map_err(|e| format!("GET {url}: {e}"))?;
        let status = resp.status().as_u16();
        let (append, has_body) = match status {
            206 => (offset > 0, true),
            200 => (false, true),
            416 if offset > 0 => (true, false), // range not satisfiable: tmp likely complete
            other => return Err(format!("GET {url}: HTTP {other}")),
        };
        if !append {
            offset = 0;
        }
        if append {
            // Pre-hash the bytes already on disk so the digest stays incremental.
            offset = prehash_prefix(&tmp, &mut hasher, cancel)?;
        }
        hasher_has_full = true;
        if has_body {
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(!append)
                .open(&tmp)
                .map_err(|e| format!("open {tmp:?}: {e}"))?;
            if append {
                file.seek(std::io::SeekFrom::End(0))
                    .map_err(|e| format!("seek {tmp:?}: {e}"))?;
            }
            let mut reader = resp.body_mut().as_reader();
            let mut buf = [0u8; STREAM_BUF];
            loop {
                if cancel.load(Ordering::Relaxed) {
                    let _ = file.flush();
                    return Ok(Acq::Cancelled);
                }
                let n = reader.read(&mut buf).map_err(|e| format!("read {url}: {e}"))?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n]).map_err(|e| format!("write {tmp:?}: {e}"))?;
                hasher.update(&buf[..n]);
                fetched += n as u64;
                offset += n as u64;
                on_bytes(offset);
            }
            file.sync_all().map_err(|e| format!("fsync {tmp:?}: {e}"))?;
        }
    }

    // Size check (when known).
    let on_disk = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if expected_bytes > 0 && on_disk != expected_bytes {
        return Err(format!(
            "size {on_disk} != expected {expected_bytes} for {}",
            dest.display()
        ));
    }
    on_bytes(on_disk);

    let digest_hex = if hasher_has_full {
        finalize_hex(hasher)
    } else {
        // Fully-preexisting .part path: hasher never fed — hash from disk.
        sha256_of_file_streaming(&tmp, cancel)?
    };

    if let Some(exp) = expected_sha {
        if digest_hex != exp {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!(
                "sha mismatch for {} (expected {exp}, got {digest_hex}) — tmp discarded",
                dest.display()
            ));
        }
    }
    rename_with_retry(&tmp, dest)?;
    Ok(Acq::Verified(fetched))
}

/// Reassemble a chunked object (`band_N.parts.json`) into `dest`: fetch each part
/// in ascending order, concatenate, per-part sha verify, then whole-file sha
/// verify. Restarts cleanly per call (no mid-reassembly resume — matches
/// fetch_index.mjs). `on_bytes(whole_done_bytes)` fires as parts stream in.
fn reassemble_chunked(
    agent: &ureq::Agent,
    base_url: &str,
    prefix: &str,
    pm: &PartsManifest,
    dest: &Path,
    expected_sha: Option<&str>,
    on_bytes: &mut dyn FnMut(u64),
    cancel: &AtomicBool,
) -> Result<Acq, String> {
    if let Some(schema) = &pm.schema {
        if !schema.starts_with("skycruncher.r2.chunked-object/") {
            return Err(format!("unexpected chunk schema {schema}"));
        }
    }
    let whole_sha = expected_sha.map(|s| s.to_string()).or_else(|| pm.whole.sha256.clone());
    let mut parts = pm.parts.clone();
    if parts.is_empty() {
        return Err("chunk manifest has no parts".to_string());
    }
    parts.sort_by_key(|p| p.order);

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
    }
    let tmp = part_path(dest);
    let _ = std::fs::remove_file(&tmp); // atomic restart

    let mut whole = Sha256::new();
    let mut written: u64 = 0;
    let mut fetched: u64 = 0;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&tmp)
        .map_err(|e| format!("open {tmp:?}: {e}"))?;

    for p in &parts {
        let url = format!("{base_url}/{prefix}/{}", p.key);
        let mut resp = agent.get(&url).call().map_err(|e| format!("GET {url}: {e}"))?;
        let status = resp.status().as_u16();
        if !(status == 200 || status == 206) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("part {} → HTTP {status}", p.key));
        }
        let mut part_hasher = Sha256::new();
        let mut part_written: u64 = 0;
        let mut reader = resp.body_mut().as_reader();
        let mut buf = [0u8; STREAM_BUF];
        loop {
            if cancel.load(Ordering::Relaxed) {
                drop(file);
                let _ = std::fs::remove_file(&tmp);
                return Ok(Acq::Cancelled);
            }
            let n = reader.read(&mut buf).map_err(|e| format!("read {url}: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| format!("write {tmp:?}: {e}"))?;
            whole.update(&buf[..n]);
            part_hasher.update(&buf[..n]);
            written += n as u64;
            part_written += n as u64;
            fetched += n as u64;
            on_bytes(written);
        }
        if let Some(psha) = &p.sha256 {
            let got = finalize_hex(part_hasher);
            if &got != psha {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("part {} sha mismatch (got {got})", p.key));
            }
        }
        if let Some(pb) = p.bytes {
            if part_written != pb {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("part {} wrote {part_written} B ≠ {pb} B", p.key));
            }
        }
    }
    file.sync_all().map_err(|e| format!("fsync {tmp:?}: {e}"))?;
    drop(file);

    if let Some(wb) = pm.whole.bytes {
        if written != wb {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("reassembled {written} B ≠ whole {wb} B"));
        }
    }
    let got = finalize_hex(whole);
    if let Some(exp) = &whole_sha {
        if &got != exp {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("whole sha mismatch (got {got})"));
        }
    }
    rename_with_retry(&tmp, dest)?;
    Ok(Acq::Verified(fetched))
}

// ─── manifest loading ───────────────────────────────────────────────────────────

/// Load the enumerating manifest: local `<dest>/manifest.json` first, else (when a
/// base URL is given) the remote `{base}/{prefix}/manifest.json`. Returns the
/// parsed manifest, a source label, and the raw bytes (to persist locally).
fn load_manifest(
    agent: &ureq::Agent,
    dest: &Path,
    base_url: Option<&str>,
    prefix: &str,
) -> Result<(IndexManifest, String, Vec<u8>), String> {
    let local = dest.join("manifest.json");
    if local.is_file() {
        let bytes = std::fs::read(&local).map_err(|e| format!("read {local:?}: {e}"))?;
        let m: IndexManifest =
            serde_json::from_slice(&bytes).map_err(|e| format!("parse local manifest: {e}"))?;
        return Ok((m, "local".to_string(), bytes));
    }
    let base = base_url.ok_or_else(|| {
        "E_NO_MANIFEST: no local manifest.json and no base URL to fetch it from".to_string()
    })?;
    let url = format!("{base}/{prefix}/manifest.json");
    let mut resp = agent.get(&url).call().map_err(|e| format!("GET {url}: {e}"))?;
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(format!("manifest {url} → HTTP {status}"));
    }
    let bytes = read_body_all(resp.body_mut())?;
    let m: IndexManifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse remote manifest: {e}"))?;
    Ok((m, url, bytes))
}

// ─── core passes (explicit dest; testable without Tauri) ────────────────────────

/// Presence + size probe (NO sha — fast). Honest: reports missing / present
/// (size-matched, not verified) / size_mismatch per file.
pub fn status_core(
    dest: &Path,
    base_url: Option<&str>,
    prefix: &str,
) -> Result<StarDataStatus, String> {
    let ag = agent();
    let (manifest, source, _raw) = match load_manifest(&ag, dest, base_url, prefix) {
        Ok(t) => t,
        Err(e) => {
            // No manifest at all — honest empty status (not provisioned / offline).
            return Ok(StarDataStatus {
                index_root: dest.display().to_string(),
                manifest_source: None,
                release: None,
                file_count: 0,
                total_bytes: 0,
                present_count: 0,
                present_bytes: 0,
                files: vec![StarDataFileStatus {
                    file: format!("<manifest unavailable: {e}>"),
                    bytes: 0,
                    state: "missing".to_string(),
                }],
            });
        }
    };
    let files = planned_files(&manifest);
    let total_bytes: u64 = files.iter().map(|f| f.bytes).sum();
    let mut present_count = 0u32;
    let mut present_bytes = 0u64;
    let mut out = Vec::with_capacity(files.len());
    for f in &files {
        let p = dest.join(&f.file);
        let state = match std::fs::metadata(&p) {
            Err(_) => "missing",
            Ok(m) => {
                if f.bytes == 0 || m.len() == f.bytes {
                    present_count += 1;
                    present_bytes += m.len();
                    "present"
                } else {
                    "size_mismatch"
                }
            }
        };
        out.push(StarDataFileStatus {
            file: f.file.clone(),
            bytes: f.bytes,
            state: state.to_string(),
        });
    }
    Ok(StarDataStatus {
        index_root: dest.display().to_string(),
        manifest_source: Some(source),
        release: manifest.release.clone(),
        file_count: files.len() as u32,
        total_bytes,
        present_count,
        present_bytes,
        files: out,
    })
}

/// Verify-only pass: sha256 every present file against the manifest; report
/// per-file verified / missing / mismatch. No network beyond the manifest.
pub fn verify_core(
    dest: &Path,
    base_url: Option<&str>,
    prefix: &str,
    progress: &dyn Fn(&StarDataProgress),
    cancel: &AtomicBool,
) -> Result<StarDataReport, String> {
    let ag = agent();
    let (manifest, source, _raw) = load_manifest(&ag, dest, base_url, prefix)?;
    let files = planned_files(&manifest);
    let total_bytes: u64 = files.iter().map(|f| f.bytes).sum();
    let mut overall_base = 0u64;
    let mut verified_count = 0u32;
    let mut results = Vec::with_capacity(files.len());
    let mut cancelled = false;

    for (i, f) in files.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let p = dest.join(&f.file);
        let (state, reason) = if !p.is_file() {
            ("missing", Some("not present locally".to_string()))
        } else {
            progress(&StarDataProgress {
                phase: "verify".to_string(),
                file: f.file.clone(),
                file_index: (i + 1) as u32,
                file_count: files.len() as u32,
                file_done_bytes: 0,
                file_total_bytes: f.bytes,
                overall_done_bytes: overall_base,
                overall_total_bytes: total_bytes,
            });
            match sha256_of_file_streaming(&p, cancel) {
                Err(e) if e == "E_CANCELLED" => {
                    cancelled = true;
                    ("skipped", Some("cancelled".to_string()))
                }
                Err(e) => ("error", Some(e)),
                Ok(got) => match &f.sha256 {
                    Some(exp) if &got == exp => {
                        verified_count += 1;
                        ("verified", None)
                    }
                    Some(_) => ("mismatch", Some(format!("sha {got}"))),
                    None => {
                        verified_count += 1;
                        ("verified", Some("no manifest sha to check".to_string()))
                    }
                },
            }
        };
        results.push(StarDataFileResult {
            file: f.file.clone(),
            bytes: f.bytes,
            state: state.to_string(),
            fetched_bytes: 0,
            reason,
        });
        overall_base += f.bytes;
        progress(&StarDataProgress {
            phase: "verify".to_string(),
            file: f.file.clone(),
            file_index: (i + 1) as u32,
            file_count: files.len() as u32,
            file_done_bytes: f.bytes,
            file_total_bytes: f.bytes,
            overall_done_bytes: overall_base,
            overall_total_bytes: total_bytes,
        });
        if cancelled {
            break;
        }
    }

    let file_count = files.len() as u32;
    Ok(StarDataReport {
        phase: "verify".to_string(),
        index_root: dest.display().to_string(),
        manifest_source: Some(source),
        release: manifest.release.clone(),
        file_count,
        total_bytes,
        verified_count,
        downloaded_count: 0,
        bytes_fetched: 0,
        cancelled,
        complete: file_count > 0 && verified_count == file_count,
        files: results,
    })
}

/// Full download pass: for each manifest file, skip if present + size + sha match,
/// else acquire (single object w/ resume, or chunked reassembly for band_0),
/// sha-verify, and emit progress. Persists manifest.json locally. Never aborts the
/// batch on a single failure; honest per-file states.
#[allow(clippy::too_many_arguments)]
pub fn download_core(
    dest: &Path,
    base_url: &str,
    prefix: &str,
    progress: &dyn Fn(&StarDataProgress),
    cancel: &AtomicBool,
) -> Result<StarDataReport, String> {
    let ag = agent();
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir {dest:?}: {e}"))?;
    let (manifest, source, raw) = load_manifest(&ag, dest, Some(base_url), prefix)?;
    // Persist the manifest locally (source of truth for future status/verify).
    let local_manifest = dest.join("manifest.json");
    if !local_manifest.is_file() {
        std::fs::write(&local_manifest, &raw).map_err(|e| format!("write manifest: {e}"))?;
    }

    let files = planned_files(&manifest);
    let file_count = files.len() as u32;
    let total_bytes: u64 = files.iter().map(|f| f.bytes).sum();
    let mut overall_base = 0u64;
    let mut verified_count = 0u32;
    let mut downloaded_count = 0u32;
    let mut bytes_fetched = 0u64;
    let mut cancelled = false;
    let mut results = Vec::with_capacity(files.len());

    for (i, f) in files.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let file_index = (i + 1) as u32;
        let dest_file = dest.join(&f.file);
        // Snapshot the running total so `emit_ctx` never borrows the mutated var.
        let ob = overall_base;
        let emit_ctx = |phase: &str, file_done: u64| {
            progress(&StarDataProgress {
                phase: phase.to_string(),
                file: f.file.clone(),
                file_index,
                file_count,
                file_done_bytes: file_done,
                file_total_bytes: f.bytes,
                overall_done_bytes: ob + file_done.min(f.bytes),
                overall_total_bytes: total_bytes,
            });
        };

        // Already present + size + sha → skip (verified). Honest "done" needs sha.
        if dest_file.is_file() {
            let size_ok = f.bytes == 0
                || std::fs::metadata(&dest_file).map(|m| m.len()).unwrap_or(0) == f.bytes;
            if size_ok {
                emit_ctx("verify", 0);
                match sha256_of_file_streaming(&dest_file, cancel) {
                    Ok(got) if f.sha256.as_deref().map_or(true, |e| e == got) => {
                        verified_count += 1;
                        emit_ctx("verify", f.bytes);
                        results.push(StarDataFileResult {
                            file: f.file.clone(),
                            bytes: f.bytes,
                            state: "verified".to_string(),
                            fetched_bytes: 0,
                            reason: Some("already present".to_string()),
                        });
                        overall_base += f.bytes;
                        continue;
                    }
                    Err(e) if e == "E_CANCELLED" => {
                        cancelled = true;
                        break;
                    }
                    _ => { /* sha mismatch or read error → re-acquire below */ }
                }
            }
        }

        // Acquire with resume-based retry (single object; band_0 → chunked on 404).
        let mut last_emit = Instant::now();
        let mut on_bytes = |file_done: u64| {
            if last_emit.elapsed() >= PROGRESS_THROTTLE {
                last_emit = Instant::now();
                emit_ctx("download", file_done);
            }
        };

        let mut attempt = 0u32;
        let outcome: Result<Acq, String> = loop {
            attempt += 1;
            if cancel.load(Ordering::Relaxed) {
                break Ok(Acq::Cancelled);
            }
            let url = format!("{base_url}/{prefix}/{}", f.file);
            let r = download_object(
                &ag,
                &url,
                &dest_file,
                f.sha256.as_deref(),
                f.bytes,
                &mut on_bytes,
                cancel,
            );
            match r {
                Ok(a) => break Ok(a),
                Err(e) if e.starts_with("GET ") && e.contains("HTTP 404") => {
                    // No single object → chunked reassembly via <stem>.parts.json.
                    let pkey = parts_manifest_key(&f.file);
                    let purl = format!("{base_url}/{prefix}/{pkey}");
                    match ag.get(&purl).call() {
                        Ok(mut presp) if presp.status().as_u16() == 200 => {
                            match read_body_all(presp.body_mut()) {
                                Ok(pbytes) => match serde_json::from_slice::<PartsManifest>(&pbytes) {
                                    Ok(pm) => {
                                        break reassemble_chunked(
                                            &ag,
                                            base_url,
                                            prefix,
                                            &pm,
                                            &dest_file,
                                            f.sha256.as_deref(),
                                            &mut on_bytes,
                                            cancel,
                                        );
                                    }
                                    Err(pe) => break Err(format!("parse {pkey}: {pe}")),
                                },
                                Err(pe) => break Err(format!("read {pkey}: {pe}")),
                            }
                        }
                        Ok(presp) => {
                            break Err(format!(
                                "R2-ABSENT (no single object + {pkey} HTTP {})",
                                presp.status().as_u16()
                            ))
                        }
                        Err(pe) => break Err(format!("GET {purl}: {pe}")),
                    }
                }
                Err(e) if attempt < MAX_ATTEMPTS => {
                    log::warn!("[star_data] {} attempt {attempt} failed: {e} — retrying", f.file);
                    std::thread::sleep(Duration::from_millis(500 * attempt as u64));
                    continue;
                }
                Err(e) => break Err(e),
            }
        };

        match outcome {
            Ok(Acq::Verified(fetched)) => {
                verified_count += 1;
                downloaded_count += 1;
                bytes_fetched += fetched;
                emit_ctx("download", f.bytes);
                results.push(StarDataFileResult {
                    file: f.file.clone(),
                    bytes: f.bytes,
                    state: "verified".to_string(),
                    fetched_bytes: fetched,
                    reason: None,
                });
            }
            Ok(Acq::Cancelled) => {
                cancelled = true;
                results.push(StarDataFileResult {
                    file: f.file.clone(),
                    bytes: f.bytes,
                    state: "skipped".to_string(),
                    fetched_bytes: 0,
                    reason: Some("cancelled".to_string()),
                });
                break;
            }
            Err(e) => {
                log::warn!("[star_data] {} FAILED: {e}", f.file);
                results.push(StarDataFileResult {
                    file: f.file.clone(),
                    bytes: f.bytes,
                    state: "error".to_string(),
                    fetched_bytes: 0,
                    reason: Some(e),
                });
            }
        }
        overall_base += f.bytes;
    }

    Ok(StarDataReport {
        phase: "download".to_string(),
        index_root: dest.display().to_string(),
        manifest_source: Some(source),
        release: manifest.release.clone(),
        file_count,
        total_bytes,
        verified_count,
        downloaded_count,
        bytes_fetched,
        cancelled,
        complete: file_count > 0 && verified_count == file_count,
        files: results,
    })
}

// ─── Tauri commands ─────────────────────────────────────────────────────────────

/// Env override for the atlas directory (mirrors greenfield_solve's
/// `SKYCRUNCHER_QUADIDX_DIR` exactly, for the atlas destination).
const ATLAS_ENV: &str = "SKYCRUNCHER_ATLAS_DIR";

/// Read `atlas_root` from `<app_local>/storage.json` — the MIRROR of
/// greenfield_solve::index_root_from_storage_config for the atlas destination
/// (same per-machine config file, written by the storage settings UI /
/// tools/setup provisioner; schema `tools/config/storage_paths.mjs`). Absent /
/// unparseable / empty → None (honest fall-through to the default). The desktop
/// runs with NO storage.json, so this returns None there — default is used.
fn atlas_root_from_storage_config(app_local_data_dir: Option<&Path>) -> Option<PathBuf> {
    let base = app_local_data_dir?;
    let bytes = std::fs::read(base.join("storage.json")).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let s = v.get("atlas_root")?.as_str()?.trim();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

/// Atlas-dir resolution — same SHAPE as `resolve_quadidx_dir` (env → storage.json
/// → default), but the DEFAULT is `<app_local>/data/atlas`, NOT `resolve_quadidx_dir`'s
/// `<app_local>/quadidx`. This divergence is DELIBERATE and load-bearing: unlike the
/// index (written AND read by the Rust solver at the same resolver, so its default is
/// self-consistent), the atlas is WRITTEN here but READ by the TS confirm-lane loader
/// (`atlas_local_tier.ts` → `storagePaths.resolveStoragePaths().atlas_root`). The two
/// MUST agree on the no-config default, or a fresh machine (no storage.json) would
/// download to one dir and read from another. `storagePaths`/`storage_paths.mjs`
/// `withDefaults` sets `atlas_root = <data_root>/atlas = <app_local>/data/atlas`, so
/// this mirrors THAT — and a fresh machine then behaves identically to one whose
/// storage.json was written once (`atlas_root` = the same default).
///   1. `SKYCRUNCHER_ATLAS_DIR` env override (dev knob — highest priority; the webview
///      loader does NOT read env, so use storage.json when the reader must follow too)
///   2. `storage.json` `atlas_root` (per-machine config — read IDENTICALLY by TS)
///   3. `app_local_data_dir()/data/atlas` (default = the storagePaths atlas_root default)
fn resolve_atlas_dir(app_local_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Ok(v) = std::env::var(ATLAS_ENV) {
        if !v.trim().is_empty() {
            return Ok(PathBuf::from(v));
        }
    }
    if let Some(p) = atlas_root_from_storage_config(app_local_data_dir.as_deref()) {
        return Ok(p);
    }
    app_local_data_dir
        .map(|base| base.join("data").join("atlas"))
        .ok_or_else(|| {
            format!("E_ATLAS_MISSING: no {ATLAS_ENV} override, no storage.json atlas_root, and the app-local data dir could not be resolved")
        })
}

/// Resolve the destination root for a pass. `kind == Some("atlas")` routes to the
/// atlas_root; anything else (incl. `None`) routes to the quad-index root — so the
/// existing index invocation (which passes no `kind`) is byte-identical.
fn resolve_dest(app: &tauri::AppHandle, kind: Option<&str>) -> Result<PathBuf, String> {
    let app_local = app.path().app_local_data_dir().ok();
    match kind {
        Some("atlas") => resolve_atlas_dir(app_local),
        _ => resolve_quadidx_dir(app_local),
    }
}

/// Presence/size status of a star-data release at the machine's destination root.
/// `base_url`/`prefix` (from the shared config point) let it fetch the remote
/// manifest to enumerate the expected file set when none is present locally.
/// `kind` (`"index"` default / `"atlas"`) selects the destination root; the index
/// call omits it and is byte-identical.
#[tauri::command]
pub async fn star_data_status(
    app: tauri::AppHandle,
    base_url: Option<String>,
    prefix: String,
    kind: Option<String>,
) -> Result<StarDataStatus, String> {
    let dest = resolve_dest(&app, kind.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || status_core(&dest, base_url.as_deref(), &prefix))
        .await
        .map_err(|e| format!("E_STATUS_JOIN: {e}"))?
}

/// Download + sha-verify a whole release from R2 into its destination root,
/// emitting `star-data-progress` events. Rejects a concurrent run. `base_url`/
/// `prefix` come from the shared config point (never hardcoded server-side);
/// `kind` (`"index"` default / `"atlas"`) selects index_root vs atlas_root.
#[tauri::command]
pub async fn star_data_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    base_url: String,
    prefix: String,
    kind: Option<String>,
) -> Result<StarDataReport, String> {
    let control = state.star_data.clone();
    if control.running.swap(true, Ordering::SeqCst) {
        return Err("E_STAR_DATA_BUSY: a download is already running".to_string());
    }
    control.cancel.store(false, Ordering::SeqCst);
    let dest = match resolve_dest(&app, kind.as_deref()) {
        Ok(d) => d,
        Err(e) => {
            control.running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let app_emit = app.clone();
    let control2 = control.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let emitter = app_emit;
        let progress = move |p: &StarDataProgress| {
            let _ = emitter.emit(PROGRESS_EVENT, p);
        };
        download_core(&dest, &base_url, &prefix, &progress, &control2.cancel)
    })
    .await
    .map_err(|e| format!("E_DOWNLOAD_JOIN: {e}"));
    control.running.store(false, Ordering::SeqCst);
    result?
}

/// Verify-only: sha256 every present file against the manifest; emit progress.
/// `kind` (`"index"` default / `"atlas"`) selects the destination root.
#[tauri::command]
pub async fn star_data_verify(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    base_url: Option<String>,
    prefix: String,
    kind: Option<String>,
) -> Result<StarDataReport, String> {
    let control = state.star_data.clone();
    control.cancel.store(false, Ordering::SeqCst);
    let dest = resolve_dest(&app, kind.as_deref())?;
    let app_emit = app.clone();
    let control2 = control.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emitter = app_emit;
        let progress = move |p: &StarDataProgress| {
            let _ = emitter.emit(PROGRESS_EVENT, p);
        };
        verify_core(&dest, base_url.as_deref(), &prefix, &progress, &control2.cancel)
    })
    .await
    .map_err(|e| format!("E_VERIFY_JOIN: {e}"))?
}

/// Signal an in-flight download/verify to stop at the next safe point.
#[tauri::command]
pub fn star_data_cancel(state: tauri::State<'_, crate::AppState>) {
    state.star_data.cancel.store(true, Ordering::SeqCst);
}

// ─── tests ──────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::starplates::sha256_hex;

    #[test]
    fn parts_manifest_key_maps_arrow_to_parts_json() {
        assert_eq!(parts_manifest_key("band_0.arrow"), "band_0.parts.json");
        assert_eq!(parts_manifest_key("stars.arrow"), "stars.parts.json");
        assert_eq!(parts_manifest_key("weird"), "weird.parts.json");
    }

    #[test]
    fn planned_files_flattens_stars_then_bands_in_order() {
        let m: IndexManifest = serde_json::from_str(
            r#"{"release":"r","stars":{"file":"stars.arrow","sha256":"aa","bytes":10},
                "bands":[{"file":"band_0.arrow","sha256":"bb","bytes":20,"index":0,"loDeg":0.25},
                         {"file":"band_1.arrow","bytes":30}]}"#,
        )
        .unwrap();
        let f = planned_files(&m);
        assert_eq!(f.len(), 3);
        assert_eq!(f[0].file, "stars.arrow");
        assert_eq!(f[0].bytes, 10);
        assert_eq!(f[1].file, "band_0.arrow");
        assert_eq!(f[2].file, "band_1.arrow");
        assert_eq!(f[2].sha256, None);
    }

    #[test]
    fn atlas_object_path_joins_sectors_idempotently() {
        assert_eq!(atlas_object_path("level_3_sector_0.json"), "sectors/level_3_sector_0.json");
        assert_eq!(atlas_object_path("sectors/level_3_sector_9.json"), "sectors/level_3_sector_9.json");
        assert_eq!(atlas_object_path("sectors\\level_3_sector_2.json"), "sectors/level_3_sector_2.json");
    }

    #[test]
    fn planned_files_atlas_plans_live_json_only_with_sectors_join() {
        // atlas-aggregate/1 shape: files[] with role; only sector-json-live planned,
        // arrow twins excluded, key → sectors/<key>. Extra fields ignored by serde.
        let m: IndexManifest = serde_json::from_str(
            r#"{"schema":"skycruncher.r2.atlas-aggregate/1","release":"atlas-rel","total_files":4,
                "files":[
                  {"key":"level_3_sector_0.json","bytes":100,"sha256":"aa","content_type":"application/json","role":"sector-json-live"},
                  {"key":"level_3_sector_0.arrow","bytes":50,"sha256":"bb","role":"sector-arrow-twin"},
                  {"key":"level_3_sector_1.json","bytes":200,"sha256":"cc","role":"sector-json-live"},
                  {"key":"level_3_sector_1.arrow","bytes":60,"sha256":"dd","role":"sector-arrow-twin"}
                ]}"#,
        )
        .unwrap();
        let f = planned_files(&m);
        assert_eq!(f.len(), 2, "only the two sector-json-live entries are planned");
        assert_eq!(f[0].file, "sectors/level_3_sector_0.json");
        assert_eq!(f[0].bytes, 100);
        assert_eq!(f[0].sha256.as_deref(), Some("aa"));
        assert_eq!(f[1].file, "sectors/level_3_sector_1.json");
        assert_eq!(f[1].bytes, 200);
    }

    #[test]
    fn planned_files_atlas_role_absent_falls_back_to_json_extension() {
        let m: IndexManifest = serde_json::from_str(
            r#"{"files":[{"key":"level_3_sector_0.json","bytes":10},
                        {"key":"level_3_sector_0.arrow","bytes":5}]}"#,
        )
        .unwrap();
        let f = planned_files(&m);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].file, "sectors/level_3_sector_0.json");
    }

    #[test]
    fn atlas_root_from_storage_config_reads_atlas_root() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("skc_atlas_cfg_{nonce}"));
        std::fs::create_dir_all(&base).unwrap();

        // No storage.json → None (desktop with no config falls through to default).
        assert!(atlas_root_from_storage_config(Some(&base)).is_none());

        // storage.json with atlas_root → honored.
        std::fs::write(
            base.join("storage.json"),
            br#"{"version":1,"atlas_root":"X:\\atlas\\gaiapure"}"#,
        )
        .unwrap();
        assert_eq!(
            atlas_root_from_storage_config(Some(&base)),
            Some(PathBuf::from("X:\\atlas\\gaiapure"))
        );

        // storage.json without atlas_root → None (honest fall-through to default).
        std::fs::write(base.join("storage.json"), br#"{"version":1}"#).unwrap();
        assert!(atlas_root_from_storage_config(Some(&base)).is_none());

        // No base dir → None.
        assert!(atlas_root_from_storage_config(None).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_atlas_dir_default_is_app_local_data_atlas() {
        // With no env override and no storage.json, the default is <app_local>/data/atlas
        // — the SAME value storagePaths.atlas_root resolves to (withDefaults), so the
        // Rust download destination and the TS confirm-lane loader agree on a fresh
        // machine. (env override not set here to avoid mutating process env under a
        // parallel test runner.)
        let base = PathBuf::from("Z:\\skc_app_local_nonexistent");
        let got = resolve_atlas_dir(Some(base.clone())).unwrap();
        assert_eq!(got, base.join("data").join("atlas"));
        assert!(resolve_atlas_dir(None).is_err());
    }

    #[test]
    fn parts_manifest_parses_real_shape() {
        let pm: PartsManifest = serde_json::from_str(
            r#"{"schema":"skycruncher.r2.chunked-object/1","release":"x","target":"band_0.arrow",
                "whole":{"bytes":503430346,"sha256":"dd21"},
                "parts":[{"order":1,"key":"band_0.arrow.part01","bytes":2,"sha256":"da"},
                         {"order":0,"key":"band_0.arrow.part00","bytes":1,"sha256":"35"}]}"#,
        )
        .unwrap();
        assert_eq!(pm.whole.bytes, Some(503430346));
        assert_eq!(pm.parts.len(), 2);
        // sort is applied by reassemble; here just prove both parsed.
        assert!(pm.parts.iter().any(|p| p.order == 0 && p.key.ends_with("part00")));
    }

    /// status_core over a temp dir with a hand-written manifest: no network, honest
    /// missing/present/size_mismatch per file.
    #[test]
    fn status_core_reports_presence_and_size() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("skc_star_data_status_{nonce}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"{"release":"rel","stars":{"file":"stars.arrow","sha256":"x","bytes":3},
                "bands":[{"file":"band_0.arrow","sha256":"y","bytes":5},
                         {"file":"band_1.arrow","sha256":"z","bytes":7}]}"#,
        )
        .unwrap();
        std::fs::write(dir.join("stars.arrow"), b"abc").unwrap(); // 3 == bytes → present
        std::fs::write(dir.join("band_0.arrow"), b"ab").unwrap(); // 2 != 5 → size_mismatch
        // band_1.arrow absent → missing

        let st = status_core(&dir, None, "unused").unwrap();
        assert_eq!(st.file_count, 3);
        assert_eq!(st.total_bytes, 15);
        assert_eq!(st.release.as_deref(), Some("rel"));
        assert_eq!(st.present_count, 1);
        let by = |name: &str| st.files.iter().find(|f| f.file == name).unwrap().state.clone();
        assert_eq!(by("stars.arrow"), "present");
        assert_eq!(by("band_0.arrow"), "size_mismatch");
        assert_eq!(by("band_1.arrow"), "missing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// verify_core over a temp dir: sha match → verified; wrong bytes → mismatch;
    /// absent → missing; complete only when all verified.
    #[test]
    fn verify_core_shas_and_reports() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("skc_star_data_verify_{nonce}"));
        std::fs::create_dir_all(&dir).unwrap();
        let sha_abc = sha256_hex(b"abc");
        std::fs::write(
            dir.join("manifest.json"),
            format!(
                r#"{{"release":"rel","stars":{{"file":"stars.arrow","sha256":"{sha_abc}","bytes":3}},
                    "bands":[{{"file":"band_1.arrow","sha256":"deadbeef","bytes":3}}]}}"#
            ),
        )
        .unwrap();
        std::fs::write(dir.join("stars.arrow"), b"abc").unwrap(); // matches sha_abc
        std::fs::write(dir.join("band_1.arrow"), b"abc").unwrap(); // sha != deadbeef → mismatch

        let cancel = AtomicBool::new(false);
        let noop = |_: &StarDataProgress| {};
        let rep = verify_core(&dir, None, "unused", &noop, &cancel).unwrap();
        assert_eq!(rep.file_count, 2);
        assert_eq!(rep.verified_count, 1);
        assert!(!rep.complete);
        let by = |name: &str| rep.files.iter().find(|f| f.file == name).unwrap().state.clone();
        assert_eq!(by("stars.arrow"), "verified");
        assert_eq!(by("band_1.arrow"), "mismatch");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// LIVE R2 proof (ignored by default; network + ~1 GB). Set
    /// STAR_DATA_LIVE_DEST to a scratch dir on D: and run with `--ignored`.
    /// Exercises the full download_core path incl. chunked band_0 reassembly.
    #[test]
    #[ignore]
    fn live_download_full_index() {
        let base = std::env::var("STAR_DATA_LIVE_BASE")
            .unwrap_or_else(|_| "https://pub-19850926b2c64818900201eb0c1c98b7.r2.dev".to_string());
        let prefix = std::env::var("STAR_DATA_LIVE_PREFIX")
            .unwrap_or_else(|_| "starplates-2026.07-quadidx-g15u".to_string());
        let dest = std::env::var("STAR_DATA_LIVE_DEST")
            .expect("set STAR_DATA_LIVE_DEST to a scratch dir on D:");
        let dest = PathBuf::from(dest);
        let cancel = AtomicBool::new(false);
        let progress = |p: &StarDataProgress| {
            if p.file_done_bytes == p.file_total_bytes && p.file_total_bytes > 0 {
                eprintln!(
                    "[live] {}/{} {} done ({} B) overall {}/{}",
                    p.file_index, p.file_count, p.file, p.file_total_bytes,
                    p.overall_done_bytes, p.overall_total_bytes
                );
            }
        };
        let rep = download_core(&dest, &base, &prefix, &progress, &cancel).expect("download_core");
        eprintln!(
            "[live] release={:?} verified={}/{} downloaded={} bytes_fetched={} complete={}",
            rep.release, rep.verified_count, rep.file_count, rep.downloaded_count,
            rep.bytes_fetched, rep.complete
        );
        for f in &rep.files {
            eprintln!("   {} -> {} ({:?})", f.file, f.state, f.reason);
        }
        assert!(rep.complete, "index not complete: {rep:?}");
    }
}
