//! Greenfield native plate-solve seam — flag-gated desktop command.
//!
//! Wraps the greenfield `solver-core` as a LIBRARY: mirrors the engine-invocation
//! shape of `crates/solver-cli/src/solve_cmd.rs::solve` (prepare → Engine::new →
//! run → assemble_receipt). It does NOT shell out to the CLI and does NOT duplicate
//! any decision logic — only the CLI's I/O plumbing (index open with first-contact
//! upgrade, stamp-dir resolution, UTC stamp) is replicated here.
//!
//! Ledger: COORDINATE (WCS/scale/matches are the product; no pixel-buffer ops here).
//!
//! DOUBLE-GATED at the app boundary (TS side): env flag `VITE_SOLVER_GREENFIELD`
//! (DEFAULT ON for the desktop runtime; disabled only by explicit `=0`) AND Tauri
//! runtime. The browser build is ALWAYS legacy — the Tauri-runtime gate never lets it
//! reach this command, independent of the flag. `VITE_SOLVER_GREENFIELD=0` selects the
//! in-app LEGACY cold path (mirrors the libraw decoder cold-path pattern).
//!
//! Response contract `{ receipt, solved, hydrated_matches }` — `solved` is the
//! `decision.result.solved` struct surfaced explicitly for direct TS access, and
//! `hydrated_matches` is RESPONSE-SIDE hydration from the index stars table. The
//! receipt schema is UNTOUCHED (no binary boundary changes — LAW 7 N/A).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use solver_contracts::config::{ReleaseVerifyMode, SolveConfig};
use solver_contracts::receipt::SolveReceipt;
use solver_contracts::request::{Detection, Priors, SolveRequest};
use solver_contracts::result::SolvedResult;
use solver_core::build_info;
use solver_core::coordinator;
use solver_core::index::{IndexError, QuadIndex};
use solver_core::runtime::SolveRuntime;

/// Env override for the g15u quad-index directory (else `app_local_data_dir()/quadidx`).
const QUADIDX_ENV: &str = "SKYCRUNCHER_QUADIDX_DIR";

/// One detection at the desktop seam (typed IPC arg). Absent optional measurements
/// (peak_value / snr) arrive as JSON `null` — NaN is NOT representable in JSON, so
/// the TS seam sends null explicitly and `nan_from_null` restores f64::NAN here
/// (in-process NaN semantics preserved: peak-arm off). The `id` field is carried but
/// NOT authoritative: the contract id is the ARRAY INDEX (the raw detection `id` is
/// non-unique in banked data — see `solver-core` prep.rs rank-semantics note); the
/// TS seam sends `array index = id`, so the two agree.
#[derive(Debug, Clone, Deserialize)]
pub struct DetIn {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub flux: f64,
    #[serde(default = "f64_nan", deserialize_with = "nan_from_null")]
    pub peak_value: f64,
    pub fwhm: f64,
    #[serde(default = "f64_nan", deserialize_with = "nan_from_null")]
    pub snr: f64,
}

fn f64_nan() -> f64 {
    f64::NAN
}

/// JSON `null` (or a missing key) → f64::NAN: the wire encoding of "absent
/// measurement" at this seam, since JSON cannot carry NaN.
fn nan_from_null<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
}

/// One RESPONSE-SIDE hydrated match: the final one-to-one correspondence with the
/// catalog star's sky position/magnitude looked up from the index stars table.
#[derive(Debug, Clone, Serialize)]
pub struct HydratedMatch {
    pub det_id: u32,
    /// Release-local star row (row index into stars.arrow).
    pub star_row: u32,
    /// Catalog ICRS RA (degrees) at the release epoch.
    pub ra: f64,
    /// Catalog ICRS Dec (degrees) at the release epoch.
    pub dec: f64,
    /// Gaia G magnitude (stored f32; widened to f64 for JSON/TS).
    pub gmag: f64,
    /// Final-match residual components (two, NOT a scalar) — units per `MatchRow`.
    pub residual_x: f64,
    pub residual_y: f64,
}

/// The `solve_greenfield` response. `solved` mirrors `receipt.decision.result.solved`
/// (surfaced at top level for direct TS access); `hydrated_matches` is response-side.
#[derive(Debug, Clone, Serialize)]
pub struct GreenfieldResponse {
    pub receipt: SolveReceipt,
    pub solved: Option<SolvedResult>,
    pub hydrated_matches: Vec<HydratedMatch>,
}

/// Stamp dir sibling of the index dir (CLI parity: `solve_cmd.rs::default_stamp_dir`).
fn default_stamp_dir(index_dir: &Path) -> PathBuf {
    index_dir
        .parent()
        .map(|p| p.join("solver_stamps"))
        .unwrap_or_else(|| PathBuf::from("solver_stamps"))
}

/// Seconds-precision UTC without a chrono dependency (CLI parity).
fn utc_now_string() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

/// Open the release under the configured checksum policy. Stamp-mode first contact
/// (no stamp yet) upgrades to a Full sha256 pass, which also writes the stamp for
/// next time — identical to `solve_cmd.rs::open_index` (I/O plumbing, not decision
/// logic).
fn open_index(
    dir: &Path,
    mode: ReleaseVerifyMode,
    stamp_dir: &Path,
    prefetch: bool,
) -> Result<QuadIndex, String> {
    match QuadIndex::open(dir, mode, Some(stamp_dir), prefetch) {
        Ok(ix) => Ok(ix),
        Err(IndexError::StampMissing(_)) if mode == ReleaseVerifyMode::Stamp => {
            QuadIndex::open(dir, ReleaseVerifyMode::Full, Some(stamp_dir), prefetch)
                .map_err(|e| format!("E_INDEX_OPEN (full first-contact): {e}"))
        }
        Err(e) => Err(format!("E_INDEX_OPEN: {e}")),
    }
}

/// Read `index_root` from the per-machine storage config, if present. The config
/// lives at `<app_local_data_dir>/storage.json` and is written by the app's storage
/// settings UI / the `tools/setup` provisioner (schema: `tools/config/storage_paths.mjs`).
/// Absent or unparseable → `None`. The DESKTOP runs with NO storage.json, so this
/// returns `None` there and the existing default is used — behavior UNCHANGED.
pub(crate) fn index_root_from_storage_config(app_local_data_dir: Option<&Path>) -> Option<PathBuf> {
    let base = app_local_data_dir?;
    let bytes = std::fs::read(base.join("storage.json")).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let s = v.get("index_root")?.as_str()?.trim();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

/// Index-dir resolution (single source of truth shared with the TS/tools resolver):
///   1. `SKYCRUNCHER_QUADIDX_DIR` env override (dev/desktop — highest priority, UNCHANGED)
///   2. `storage.json` `index_root` (per-machine config, present on a mapped/fresh machine)
///   3. `app_local_data_dir()/quadidx` (default fallback, UNCHANGED)
/// The caller passes the Tauri-resolved base so this stays testable headless
/// (mirrors `starplates::store::resolve_root`).
pub(crate) fn resolve_quadidx_dir(app_local_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Ok(v) = std::env::var(QUADIDX_ENV) {
        if !v.trim().is_empty() {
            return Ok(PathBuf::from(v));
        }
    }
    if let Some(p) = index_root_from_storage_config(app_local_data_dir.as_deref()) {
        return Ok(p);
    }
    app_local_data_dir
        .map(|base| base.join("quadidx"))
        .ok_or_else(|| {
            format!("E_QUADIDX_MISSING: no {QUADIDX_ENV} override, no storage.json index_root, and the app-local data dir could not be resolved")
        })
}

/// Build the shipped-arm `SolveConfig`: solver defaults + `abort_on_accept`,
/// `band_major` off, the optional `budget_ms` override, and the optional two-flow
/// scale window. PURE + no I/O so the config resolution is unit-testable without the
/// banked index. `scale_window = None` (the shipped default + the CLI sentinel arm)
/// leaves the frozen blind window [0.5, 300] ″/px untouched ⇒ `resolved_config`
/// byte-identical. Constants FROZEN — `band_order` stays Ascending, all accept/verify
/// thresholds untouched; the scale window is a search-order prior, not a gate.
fn resolve_shipped_config(budget_ms: Option<u64>, scale_window: Option<(f64, f64)>) -> SolveConfig {
    let mut config = SolveConfig::default();
    if let Some(b) = budget_ms {
        config.search.budget_ms = b;
    }
    config.search.abort_on_accept = true;
    config.search.band_major = false;
    // Two-flow scale-window hint (TS seam VITE_SOLVER_SCALE_HINT, DEFAULT OFF): a
    // TRUSTED window narrows the admissible band range around the scale prior (wide →
    // coarse bands, narrow → fine bands — the owner's coarse→fine / fine→coarse
    // routing, via the ALREADY-EXISTING scale window, NOT band_order).
    if let Some((lo, hi)) = scale_window {
        config.search.scale_lo_asec = lo;
        config.search.scale_hi_asec = hi;
    }
    config
}

/// CORE solve: detections + dims + budget + optional scale window + index dir →
/// response. No IPC, no env reads for CONFIG (the index dir arrives resolved).
/// Constants FROZEN — the only config deviations from `SolveConfig::default()` are
/// `abort_on_accept = true` and `band_major = false` (the shipped arm), the optional
/// `budget_ms` override, and the optional `scale_window` search hint (two-flow band
/// traversal). `scale_window = None` (the shipped default + the CLI sentinel arm)
/// leaves the frozen blind window untouched ⇒ `resolved_config` byte-identical.
pub fn solve_greenfield_core(
    detections: &[DetIn],
    width: u32,
    height: u32,
    budget_ms: Option<u64>,
    scale_window: Option<(f64, f64)>,
    index_dir: &Path,
) -> Result<GreenfieldResponse, String> {
    // Contract detections; contract id = ARRAY INDEX (raw `id` is non-unique).
    let dets: Vec<Detection> = detections
        .iter()
        .enumerate()
        .map(|(i, d)| Detection {
            id: i as u32,
            x: d.x,
            y: d.y,
            flux: d.flux,
            peak_value: d.peak_value,
            fwhm: d.fwhm,
            snr: d.snr,
        })
        .collect();

    // Input digest over the canonical serialization of the contract detections
    // (no raw file at this seam; deterministic + audit-honest).
    let input_bytes =
        serde_json::to_vec(&dets).map_err(|e| format!("detections serialize: {e}"))?;
    let input_digest = coordinator::sha256_hex(&input_bytes);

    // Resolved config: solver defaults + abort_on_accept, band_major=false. Constants
    // FROZEN; band_order stays Ascending; release_verify stays Stamp (all defaults).
    // The scale-window ENFORCEMENT lives here — `config.search.scale_lo/hi_asec` is what
    // coordinator/quadgen/hypo read for the AbscaleWindow band gate (solver-core never
    // reads priors.scale_window; grep-verified).
    let config = resolve_shipped_config(budget_ms, scale_window);

    // Provenance parity with the CLI (solve_cmd.rs:216-223): record the same window on
    // the request priors as the honest "HINTED" marker. This does NOT drive the search
    // (config.search is the enforcement); it is receipt provenance only. `None`
    // (flag-off) ⇒ `Priors::default()` ⇒ byte-identical.
    let mut priors = Priors::default();
    priors.scale_window = scale_window;

    let request = SolveRequest {
        frame_id: "desktop".to_string(),
        width,
        height,
        detections: dets,
        priors,
    };

    // Index open under the configured checksum policy (Stamp; first contact upgrades).
    let stamp = default_stamp_dir(index_dir);
    let started_utc = utc_now_string();
    let mut index = open_index(
        index_dir,
        config.execution.release_verify,
        &stamp,
        config.execution.prefetch,
    )?;

    // prepare → engine → run (the exact CLI invocation shape).
    let prepared = coordinator::prepare(&request, &config, &mut index);
    let runtime = SolveRuntime::from_policy(&config.search);
    let mut engine = coordinator::Engine::new(&prepared, &index, &config, &runtime);
    let run = engine.run();

    // Clone the solved result BEFORE `assemble_receipt` consumes `run`.
    let solved: Option<SolvedResult> = run.result.solved.clone();

    // git_commit is UNVERIFIED at desktop runtime (no source tree; no git subprocess in
    // the shipped app) — the honest value, matching the CLI's own fallback.
    let build = build_info::build_info("UNVERIFIED".to_string());
    let receipt = coordinator::assemble_receipt(
        &request.frame_id,
        &input_digest,
        &request,
        &config,
        build,
        &index,
        &prepared,
        run,
        started_utc,
        config.execution.threads,
    );

    // Response-side hydration from the index stars table (fields ra/dec/gmag; gmag f32).
    let n_rows = index.stars.n_rows as usize;
    let hydrated_matches: Vec<HydratedMatch> = match &solved {
        Some(s) => s
            .matches
            .iter()
            .filter_map(|m| {
                let row = m.star_row as usize;
                if row >= n_rows {
                    return None;
                }
                Some(HydratedMatch {
                    det_id: m.det_id,
                    star_row: m.star_row,
                    ra: index.stars.ra[row],
                    dec: index.stars.dec[row],
                    gmag: index.stars.gmag[row] as f64,
                    residual_x: m.residual_x,
                    residual_y: m.residual_y,
                })
            })
            .collect(),
        None => Vec::new(),
    };

    Ok(GreenfieldResponse {
        receipt,
        solved,
        hydrated_matches,
    })
}

/// Flag-gated desktop command: drive the greenfield solver natively. Registered in
/// `generate_handler!`. The TS seam invokes it by DEFAULT under a Tauri runtime
/// (disabled only by explicit `VITE_SOLVER_GREENFIELD=0`, the cold path); the browser
/// build never reaches it.
#[tauri::command]
pub async fn solve_greenfield(
    app: tauri::AppHandle,
    detections: Vec<DetIn>,
    width: u32,
    height: u32,
    budget_ms: Option<u64>,
    // Two-flow scale-window hint (TS seam `scaleLo`/`scaleHi`, DEFAULT OFF). BOTH
    // bounds are required to form a window; either absent ⇒ no hint (blind default).
    scale_lo: Option<f64>,
    scale_hi: Option<f64>,
) -> Result<GreenfieldResponse, String> {
    let app_local = app.path().app_local_data_dir().ok();
    let index_dir = resolve_quadidx_dir(app_local)?;
    let scale_window = match (scale_lo, scale_hi) {
        (Some(lo), Some(hi)) => Some((lo, hi)),
        _ => None,
    };
    // Solve is CPU/IO-bound + blocking (mmap, sha, compute) — run off the async
    // runtime so the webview stays responsive.
    tauri::async_runtime::spawn_blocking(move || {
        solve_greenfield_core(&detections, width, height, budget_ms, scale_window, &index_dir)
    })
    .await
    .map_err(|e| format!("E_SOLVE_JOIN: {e}"))?
}

// ─────────────────────────────────────────────────────────────────────────────
// Rust exit gate — banked M66 SeeStar detections must SOLVE + hydrate against g15u.
// Drives the command's CORE fn directly (no IPC). Reads real banked artifacts on
// D:; honest SKIP when they are absent (a clean checkout won't false-fail).
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use solver_contracts::result::TerminalState;

    /// Golden vector for the IPC boundary: the TS seam sends `null` for absent
    /// peak_value/snr (NaN is not JSON). A payload with nulls AND with missing keys
    /// must deserialize with those fields restored to NaN — this exact shape is what
    /// a real webview invoke produces (2026-07-21 walkthrough instant-fail root cause:
    /// bare `f64` fields rejected `null` and poisoned the whole payload).
    #[test]
    fn detin_accepts_null_and_missing_optional_measurements() {
        let with_nulls = r#"{"id":0,"x":1.5,"y":2.5,"flux":100.0,"peak_value":null,"fwhm":3.0,"snr":null}"#;
        let d: DetIn = serde_json::from_str(with_nulls).expect("null-bearing DetIn must parse");
        assert!(d.peak_value.is_nan() && d.snr.is_nan());
        assert_eq!((d.x, d.y, d.flux, d.fwhm), (1.5, 2.5, 100.0, 3.0));

        let missing_keys = r#"{"id":1,"x":0.0,"y":0.0,"flux":50.0,"fwhm":2.0}"#;
        let d2: DetIn = serde_json::from_str(missing_keys).expect("missing-key DetIn must parse");
        assert!(d2.peak_value.is_nan() && d2.snr.is_nan());

        let finite = r#"{"id":2,"x":9.0,"y":9.0,"flux":1.0,"peak_value":800.0,"fwhm":2.2,"snr":12.5}"#;
        let d3: DetIn = serde_json::from_str(finite).expect("finite DetIn must parse");
        assert_eq!((d3.peak_value, d3.snr), (800.0, 12.5));
    }

    /// Two-flow scale window plumbing (no index needed): `None` is the frozen blind
    /// default arm (byte-identity basis for the sentinel), `Some((lo,hi))` narrows the
    /// admissible band range while every FROZEN accept flag stays put.
    #[test]
    fn resolve_shipped_config_applies_scale_window_and_keeps_frozen_arm() {
        let d = resolve_shipped_config(None, None);
        // Frozen blind default preserved when no window is passed.
        assert_eq!(d.search.scale_lo_asec, 0.5);
        assert_eq!(d.search.scale_hi_asec, 300.0);
        // Shipped arm: abort_on_accept ON, band_major OFF, band_order Ascending.
        assert!(d.search.abort_on_accept && !d.search.band_major);
        assert!(d.search.band_order.is_ascending());

        // A WIDE window narrows scale_lo/hi and nothing else in the arm.
        let w = resolve_shipped_config(Some(240_000), Some((20.0, 300.0)));
        assert_eq!((w.search.scale_lo_asec, w.search.scale_hi_asec), (20.0, 300.0));
        assert_eq!(w.search.budget_ms, 240_000);
        assert!(w.search.abort_on_accept && !w.search.band_major);
        assert!(w.search.band_order.is_ascending());
    }

    /// Storage-config index_root resolution (fresh-machine portability). fs-only,
    /// no env (env is process-global + parallel-test-hostile) — covers the NEW tier 2.
    #[test]
    fn index_root_from_storage_config_reads_index_root() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("skc_storage_cfg_test_{nonce}"));
        std::fs::create_dir_all(&base).unwrap();

        // No storage.json → None (desktop with no config falls through unchanged).
        assert!(index_root_from_storage_config(Some(&base)).is_none());

        // storage.json with a remapped index_root → honored.
        std::fs::write(
            base.join("storage.json"),
            br#"{"version":1,"index_root":"X:\\quads\\g15u"}"#,
        )
        .unwrap();
        assert_eq!(
            index_root_from_storage_config(Some(&base)),
            Some(PathBuf::from("X:\\quads\\g15u"))
        );

        // storage.json without index_root → None (honest fall-through to the default).
        std::fs::write(base.join("storage.json"), br#"{"version":1}"#).unwrap();
        assert!(index_root_from_storage_config(Some(&base)).is_none());

        // No app-local base at all → None.
        assert!(index_root_from_storage_config(None).is_none());

        let _ = std::fs::remove_dir_all(&base);
    }

    const M66_DETECTIONS: &str = "D:/AstroLogic/test_artifacts/corpus_grad_2026-07-18/A/detections/detections_DSO_Stacked_738_M_66_60.0s_20260516_064736.fit_31500.json";
    const G15U_FALLBACK: &str =
        "D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u";
    /// M66 SeeStar reference scale (arcsec/px) — the pinned reference solve.
    const M66_SCALE_TARGET: f64 = 3.679_184_978_895_153;

    /// Banked-detections parser (TEST ONLY: the command takes typed `DetIn` from the
    /// TS seam; only the gate reads a banked file). Mirrors `solve_cmd.rs::parse_banked`
    /// (contract id = array index; missing optional fields → NaN).
    fn parse_banked_dets(raw: &[u8]) -> Result<Vec<DetIn>, String> {
        let v: serde_json::Value =
            serde_json::from_slice(raw).map_err(|e| format!("detections JSON parse: {e}"))?;
        let arr = v
            .get("detections")
            .and_then(|d| d.as_array())
            .ok_or("missing top-level detections[] array")?;
        let f = |row: &serde_json::Value, k: &str| row.get(k).and_then(|x| x.as_f64());
        let mut out = Vec::with_capacity(arr.len());
        for (i, row) in arr.iter().enumerate() {
            let (Some(x), Some(y), Some(flux)) = (f(row, "x"), f(row, "y"), f(row, "flux")) else {
                return Err(format!("detections[{i}] missing x/y/flux"));
            };
            out.push(DetIn {
                id: i as u32,
                x,
                y,
                flux,
                peak_value: f(row, "peak_value").unwrap_or(f64::NAN),
                fwhm: f(row, "fwhm").unwrap_or(f64::NAN),
                snr: f(row, "snr").unwrap_or(f64::NAN),
            });
        }
        Ok(out)
    }

    #[test]
    fn m66_solves_and_hydrates() {
        let idx = std::env::var(QUADIDX_ENV)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| G15U_FALLBACK.to_string());
        let idx_path = PathBuf::from(&idx);

        if !idx_path.join("manifest.json").exists() || !Path::new(M66_DETECTIONS).exists() {
            eprintln!(
                "[m66 gate] SKIP — banked index/detections absent on this box (idx={idx}, dets={M66_DETECTIONS})"
            );
            return;
        }

        let raw = std::fs::read(M66_DETECTIONS).expect("read M66 detections");
        let dets = parse_banked_dets(&raw).expect("parse M66 detections");
        assert!(!dets.is_empty(), "no detections parsed");

        // scale_window = None: the M66 gate exercises the frozen blind default arm.
        let resp = solve_greenfield_core(&dets, 2160, 3840, None, None, &idx_path)
            .expect("solve_greenfield_core failed");

        let state = resp.receipt.decision.result.state;
        assert_eq!(state, TerminalState::Solved, "expected SOLVED, got {state:?}");

        let solved = resp.solved.as_ref().expect("solved payload missing");
        assert!(
            !resp.hydrated_matches.is_empty(),
            "hydrated_matches empty on a SOLVED result"
        );
        for m in &resp.hydrated_matches {
            assert!(
                m.ra.is_finite() && m.dec.is_finite() && m.gmag.is_finite(),
                "non-finite hydrated ra/dec/gmag: {m:?}"
            );
        }

        let scale = solved.scale_arcsec_px;
        let rel = ((scale - M66_SCALE_TARGET) / M66_SCALE_TARGET).abs();
        assert!(
            rel <= 0.02,
            "scale {scale} not within +/-2% of {M66_SCALE_TARGET} (rel {rel})"
        );

        eprintln!(
            "[m66 gate] SOLVED scale={scale} matches={} hydrated={} crval=({:.6},{:.6})",
            solved.matches.len(),
            resp.hydrated_matches.len(),
            solved.wcs.crval.ra,
            solved.wcs.crval.dec
        );
    }
}
