//! Download manager for `starplates_sync` (spec §7 client sync).
//!
//! Strictly outside the solve path: nothing here is ever invoked implicitly —
//! only the explicit `starplates_sync` command reaches this module, and the
//! frontend gates that behind `VITE_STARPLATES_SYNC` (default OFF).
//!
//! Per blob: resumable HTTPS range GET from the R2 public base URL, full
//! SHA-256 verification, atomic tmp→fsync→verify→rename into the CAS
//! (spec §6.3). Failures are recorded per blob and never abort the batch.

use super::geometry::{angdist_deg, unit_vec};
use super::store::{cas_path_for, StarplatesStore};
use super::{sha256_hex, SYNC_BASE_URL_ENV};
use std::io::{Read, Seek, Write};
use std::path::Path;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SyncRegion {
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub radius_deg: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncReport {
    pub release: String,
    pub tier: String,
    pub requested: u32,
    pub already_present: u32,
    pub downloaded: u32,
    pub bytes_fetched: u64,
    pub failed: Vec<SyncFailure>,
}

#[derive(Debug, Clone)]
pub struct BlobPlan {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Resolve the R2 public base URL: explicit command argument first, then the
/// `SKYCRUNCHER_STARPLATES_BASE_URL` env var. No silent default (spec §1:
/// honest data or `--`; the bucket exists but its public hostname is deploy
/// config, not code).
pub fn resolve_base_url(explicit: Option<String>) -> Result<String, String> {
    if let Some(u) = explicit {
        if !u.trim().is_empty() {
            return Ok(u.trim_end_matches('/').to_string());
        }
    }
    match std::env::var(SYNC_BASE_URL_ENV) {
        Ok(u) if !u.trim().is_empty() => Ok(u.trim_end_matches('/').to_string()),
        _ => Err(format!(
            "E_SYNC_NO_BASE_URL: pass base_url or set {SYNC_BASE_URL_ENV} (e.g. the starplates R2 public bucket URL)"
        )),
    }
}

/// Select the blobs a sync run should ensure locally. `tier` follows the query
/// depth semantics ("t1" also wants the "t0" bootstrap present); an optional
/// region restricts T1 to a FOV neighborhood via the same manifest cone
/// bounds the query path uses.
pub fn plan_sync(
    store: &StarplatesStore,
    tier: &str,
    region: Option<&SyncRegion>,
) -> Result<Vec<BlobPlan>, String> {
    if !matches!(tier, "t0" | "t1" | "t2") {
        return Err(format!("E_TIER_UNKNOWN: {tier:?} (expected \"t0\" | \"t1\" | \"t2\")"));
    }
    if let Some(r) = region {
        if !r.ra_deg.is_finite()
            || !r.dec_deg.is_finite()
            || !(-90.0..=90.0).contains(&r.dec_deg)
            || !r.radius_deg.is_finite()
            || r.radius_deg <= 0.0
            || r.radius_deg > 180.0
        {
            return Err(format!(
                "E_ARG_INVALID: sync region ({}, {}, r={}) out of range",
                r.ra_deg, r.dec_deg, r.radius_deg
            ));
        }
    }
    let size_by_sha: std::collections::HashMap<&str, u64> = store
        .blobs()
        .iter()
        .map(|b| (b.sha256.as_str(), b.bytes))
        .collect();
    let mut plan: Vec<BlobPlan> = Vec::new();
    if let Some(t0) = store.t0() {
        // Bootstrap blob is wanted at every depth.
        plan.push(BlobPlan {
            path: t0.path.clone(),
            sha256: t0.sha256.clone(),
            bytes: size_by_sha.get(t0.sha256.as_str()).copied().unwrap_or(0),
        });
    }
    if matches!(tier, "t1" | "t2") {
        let qvec = region.map(|r| unit_vec(r.ra_deg, r.dec_deg));
        for c in store.t1_cells() {
            if let (Some(qv), Some(r)) = (qvec.as_ref(), region) {
                if angdist_deg(qv, &c.center) > r.radius_deg + c.radius_deg {
                    continue;
                }
            }
            plan.push(BlobPlan {
                path: c.path.clone(),
                sha256: c.sha256.clone(),
                bytes: size_by_sha.get(c.sha256.as_str()).copied().unwrap_or(0),
            });
        }
    }
    // "t2" adds nothing further: reserved, no data this release (spec §4).
    Ok(plan)
}

fn agent() -> Result<ureq::Agent, String> {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .build();
    let config = ureq::Agent::config_builder()
        .tls_config(tls)
        .http_status_as_error(false)
        .timeout_global(Some(std::time::Duration::from_secs(300)))
        .build();
    Ok(ureq::Agent::new_with_config(config))
}

/// Download one blob with resume support into `<cas>/<aa>/<sha>.arrow`.
/// Returns bytes fetched over the wire on success.
fn download_one(
    agent: &ureq::Agent,
    base_url: &str,
    release: &str,
    root: &Path,
    blob: &BlobPlan,
) -> Result<u64, String> {
    let final_path = cas_path_for(root, &blob.sha256);
    let parent = final_path
        .parent()
        .ok_or_else(|| "cas path has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
    let tmp = final_path.with_extension("tmp");

    // Resume bookkeeping: a leftover .tmp longer than the manifest size is
    // garbage from a prior failed run — restart clean.
    let offset: u64 = match std::fs::metadata(&tmp) {
        Ok(m) if blob.bytes > 0 && m.len() > blob.bytes => {
            let _ = std::fs::remove_file(&tmp);
            0
        }
        Ok(m) => m.len(),
        Err(_) => 0,
    };

    let url = format!("{base_url}/{release}/{}", blob.path);
    let mut fetched: u64 = 0;

    // Fetch remainder unless the tmp file is already complete.
    if blob.bytes == 0 || offset < blob.bytes {
        let mut req = agent.get(&url);
        if offset > 0 {
            req = req.header("Range", &format!("bytes={offset}-"));
        }
        let mut resp = req.call().map_err(|e| format!("GET {url}: {e}"))?;
        let status = resp.status().as_u16();
        let append = match status {
            206 => true,
            // Server ignored the Range header — truncate and restart.
            200 => false,
            416 if offset > 0 => {
                // Range not satisfiable: tmp may already hold the full body —
                // fall through to verification without reading a body.
                true
            }
            other => return Err(format!("GET {url}: HTTP {other}")),
        };
        if status != 416 {
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
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = reader.read(&mut buf).map_err(|e| format!("read {url}: {e}"))?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n]).map_err(|e| format!("write {tmp:?}: {e}"))?;
                fetched += n as u64;
            }
            file.sync_all().map_err(|e| format!("fsync {tmp:?}: {e}"))?;
        }
    }

    // Full-content SHA-256 verification before the blob may enter the CAS.
    let bytes = std::fs::read(&tmp).map_err(|e| format!("read-back {tmp:?}: {e}"))?;
    let actual = sha256_hex(&bytes);
    if actual != blob.sha256 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "sha mismatch for {} (expected {}, got {actual}) — tmp discarded",
            blob.path, blob.sha256
        ));
    }
    // Atomic rename of the verified tmp into the CAS, §6.3 backoff.
    super::store::rename_with_backoff(&tmp, &final_path)?;
    Ok(fetched)
}

/// Execute a sync plan. Never touches `pinned.json`; never deletes CAS
/// objects; safe to re-run (idempotent, HEAD-equivalent presence check).
pub fn run_sync(root: &Path, base_url: &str, release: &str, tier: &str, plan: &[BlobPlan]) -> SyncReport {
    let mut report = SyncReport {
        release: release.to_string(),
        tier: tier.to_string(),
        requested: plan.len() as u32,
        already_present: 0,
        downloaded: 0,
        bytes_fetched: 0,
        failed: Vec::new(),
    };
    let agent = match agent() {
        Ok(a) => a,
        Err(e) => {
            report.failed.push(SyncFailure { path: "<agent>".into(), error: e });
            return report;
        }
    };
    for blob in plan {
        if cas_path_for(root, &blob.sha256).is_file() {
            report.already_present += 1;
            continue;
        }
        match download_one(&agent, base_url, release, root, blob) {
            Ok(fetched) => {
                report.downloaded += 1;
                report.bytes_fetched += fetched;
            }
            Err(e) => {
                log::warn!("[starplates] sync failure for {}: {e}", blob.path);
                report.failed.push(SyncFailure { path: blob.path.clone(), error: e });
            }
        }
    }
    log::info!(
        "[starplates] sync {release}/{tier}: requested={} present={} downloaded={} failed={} bytes={}",
        report.requested,
        report.already_present,
        report.downloaded,
        report.failed.len(),
        report.bytes_fetched
    );
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_resolution_is_explicit_only() {
        // NOTE: does not mutate the env (tests run in-process concurrently);
        // asserts the no-config case errors with the stable prefix when the
        // env var is absent.
        if std::env::var(SYNC_BASE_URL_ENV).is_ok() {
            eprintln!("skipping: {SYNC_BASE_URL_ENV} set in this environment");
            return;
        }
        let err = resolve_base_url(None).unwrap_err();
        assert!(err.starts_with("E_SYNC_NO_BASE_URL"), "{err}");
        assert_eq!(
            resolve_base_url(Some("https://cdn.example/starplates/".into())).unwrap(),
            "https://cdn.example/starplates"
        );
    }
}
