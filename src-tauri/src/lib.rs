mod ipc_buffer;
#[cfg(any(feature = "ai-terrain", feature = "ai-distortion", feature = "ai"))]
mod intelligence;
mod dem;
mod greenfield_solve;
mod resource_manager;
mod star_data_fetch;
pub mod starplates;

use tauri::{State, Manager};
use crate::greenfield_solve::solve_greenfield;
use crate::star_data_fetch::{
    star_data_cancel, star_data_download, star_data_status, star_data_verify, StarDataControl,
};
use native_gpu::NativeGpuContext;
use crate::ipc_buffer::{BufferRegistry, BufferHandle};
use crate::starplates::store::{StarplatesStatus, StarplatesStore};
use crate::starplates::sync::{SyncRegion, SyncReport};
use std::sync::{Arc, Mutex};

struct AppState {
    gpu: Arc<NativeGpuContext>,
    buffers: Mutex<BufferRegistry>,
    starplates: Mutex<Option<StarplatesStore>>,
    /// Cancel/running control for the in-app star-data download (star_data_fetch).
    star_data: Arc<StarDataControl>,
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CORE IPC COMMANDS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/// Returns true if running in a native Tauri environment with wgpu support.
#[tauri::command]
async fn is_native() -> bool {
    true
}

/// Run demosaic on raw Bayer data via native wgpu.
///
/// RAW-BYTES IPC (docs/NEXT_MOVES.md §14.c; LAW 7 binary_layouts#tauri_native_ipc):
/// the Bayer buffer arrives as a raw little-endian u16 body (`InvokeBody::Raw`),
/// dims via the `width`/`height` invoke headers, and the demosaiced interleaved-RGB
/// f32 frame (width*height*3) returns as raw little-endian bytes via
/// `tauri::ipc::Response` — NO JSON number-
/// array smuggling in either direction. Mirrors the `query_catalog_v2` binary path
/// and retires the 300-700MB `Array.from` round-trip the old signature paid on the
/// gated/rare native path. TRANSPORT-ONLY change: dtype/stride/units are unchanged
/// (see the LAW-7 entry). Input validation is preserved.
///
/// [Module: M3] [Domain: MemoryResidency] ARROW_BUFFER -> NATIVE_GPU_VRAM
/// [Module: M3] [Domain: PhotoDataSource] RAW -> BAYER_ARRAY
#[tauri::command]
async fn demosaic_native(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    // Extract every owned input from `request` up front so NO request-lifetime
    // borrow crosses the `.await` below.
    let (bayer_data, width, height) = {
        let bayer_bytes = match request.body() {
            tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
            _ => return Err(
                "demosaic_native expects a raw ArrayBuffer body (Bayer u16 LE); got a JSON body".to_string()
            ),
        };
        let header_u32 = |name: &str| -> Result<u32, String> {
            request
                .headers()
                .get(name)
                .ok_or_else(|| format!("missing '{name}' invoke header"))?
                .to_str()
                .map_err(|e| format!("invalid '{name}' header (non-ASCII): {e}"))?
                .parse::<u32>()
                .map_err(|e| format!("invalid '{name}' header value: {e}"))
        };
        let width = header_u32("width")?;
        let height = header_u32("height")?;

        // Input validation: prevent absurd allocations (unchanged from the JSON path).
        let max_pixels: u32 = 200_000_000; // 200MP ceiling
        if width == 0 || height == 0 {
            return Err(format!("Invalid dimensions: {}x{} (zero not allowed)", width, height));
        }
        if width.checked_mul(height).map_or(true, |p| p > max_pixels) {
            return Err(format!("Dimensions {}x{} exceed 200MP ceiling", width, height));
        }
        // Each pixel is exactly one u16 = 2 LE bytes; the body must be an exact multiple.
        let expected_bytes = width as usize * height as usize * 2;
        if bayer_bytes.len() != expected_bytes {
            return Err(format!(
                "Buffer size mismatch: expected {} bytes ({} u16 pixels for {}x{}), got {}",
                expected_bytes,
                width as usize * height as usize,
                width, height,
                bayer_bytes.len()
            ));
        }

        // Decode LE u16 explicitly (alignment-safe: the &[u8] body is only u8-aligned,
        // so a bytemuck cast would be UB/panic; from_le_bytes is host-endian-agnostic).
        let bayer_data: Vec<u16> = bayer_bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        (bayer_data, width, height)
    };
    // Release the borrowed-request wrapper before the async GPU dispatch so no
    // request-lifetime borrow is captured across the await (State<'_> is await-safe).
    drop(request);

    let pipeline = native_gpu::demosaic::DemosaicPipeline::new(&state.gpu);
    // Interleaved RGB f32 (width*height*3), channel c at (y*width+x)*3+c.
    let rgb: Vec<f32> = pipeline.run(&state.gpu, &bayer_data, width, height).await?;

    // Serialize the RGB f32 frame as raw little-endian bytes (no JSON array).
    let mut out = Vec::with_capacity(rgb.len() * 4);
    for v in &rgb {
        out.extend_from_slice(&v.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(out))
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// BUFFER HANDLE COMMANDS (Zero-Copy IPC Protocol)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/// Register a binary buffer in the Rust-side registry.
///
/// HONEST STATUS (see docs/NEXT_MOVES.md §14.f): this registry is a DESIGN
/// STUB, not a working zero-copy path. Registration itself sends `data`
/// across IPC (`Vec<u8>` deserialized from the invoke body), and the handle
/// consumers the design implies (`run_demosaic(handle)` / `get_preview`)
/// were never built — `BufferRegistry::get()` has zero callers outside its
/// own tests. Do not build on this as-is; fold it into the §14.c raw-bytes
/// IPC redesign or delete it.
#[tauri::command]
async fn register_buffer(
    state: State<'_, AppState>,
    data: Vec<u8>,
) -> Result<BufferHandle, String> {
    let mut buffers = state.buffers.lock().map_err(|e| e.to_string())?;
    Ok(buffers.register(data))
}

/// Release a buffer handle when it is no longer needed.
#[tauri::command]
async fn release_buffer(
    state: State<'_, AppState>,
    handle: BufferHandle,
) -> Result<bool, String> {
    let mut buffers = state.buffers.lock().map_err(|e| e.to_string())?;
    Ok(buffers.release(handle))
}

/// Get diagnostics about the buffer registry.
#[tauri::command]
async fn buffer_diagnostics(
    state: State<'_, AppState>,
) -> Result<(usize, usize), String> {
    let buffers = state.buffers.lock().map_err(|e| e.to_string())?;
    Ok((buffers.active_count(), buffers.total_bytes()))
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AI ORACLE COMMANDS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

#[cfg(feature = "ai-terrain")]
#[tauri::command]
async fn run_terrain_oracle(
    app: tauri::AppHandle,
    luminance: Vec<f32>,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    use crate::intelligence::terrain_oracle::BoundaryDetector;
    use crate::resource_manager::ResourceManager;

    let resources = ResourceManager::init(&app)?;
    let model_path = resources.terrain_model_path();
    
    let oracle = BoundaryDetector::init(&model_path)?;
    oracle.detect(&luminance, width, height)
}

#[cfg(feature = "ai-distortion")]
#[tauri::command]
async fn run_distortion_oracle(
    app: tauri::AppHandle,
    features: Vec<f32>,
) -> Result<(f32, f32), String> {
    use crate::intelligence::distortion_oracle::DistortionOracle;
    use crate::resource_manager::ResourceManager;

    let resources = ResourceManager::init(&app)?;
    let model_path = resources.distortion_model_path();
    
    let oracle = DistortionOracle::init(&model_path)?;
    oracle.propose_coefficients(&features, features.len())
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// APP ENTRYPOINT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// ═════════════════════════════════════════════════════════════════════
// STARPLATES COMMANDS (docs/STARPLATES_SPEC.md §5 — the sole native catalog
// path since the legacy init_catalog/query_catalog/vanguard.bin reader was
// retired 2026-07-10; browser/headless callers use the JSON atlas directly)
// ═════════════════════════════════════════════════════════════════════

/// Idempotent store bring-up (spec §5.1): resolves the store dir (§6.1), seeds
/// from bundled resources on first run (§8), loads + SHA-validates the pinned
/// manifest (§2.4, §6.3) and builds the in-memory cell index.
#[tauri::command]
async fn starplates_init(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<StarplatesStatus, String> {
    {
        let guard = state.starplates.lock().map_err(|e| e.to_string())?;
        if let Some(store) = &*guard {
            return Ok(store.status());
        }
    }
    let app_local = app.path().app_local_data_dir().ok();
    let root = StarplatesStore::resolve_root(app_local)?;
    // First-run seed from the bundled release (resources/starplates/**). The
    // bundle is read-only seed material; the store is the runtime source (§8).
    match crate::resource_manager::ResourceManager::init(&app) {
        Ok(rm) => {
            let bundle_dir = rm.starplates_release_dir();
            StarplatesStore::seed_from_bundle(&root, &bundle_dir)?;
        }
        Err(e) => log::warn!("[starplates] resource dir unavailable ({e}); skipping bundle seed"),
    }
    let store = StarplatesStore::open(&root)?;
    let status = store.status();
    log::info!(
        "[starplates] init: release {} · cells {}/{} local · t0_rows {}",
        status.release, status.cells_local, status.cells_populated, status.t0_rows
    );
    *state.starplates.lock().map_err(|e| e.to_string())? = Some(store);
    Ok(status)
}

/// Cone query against the starplates store (spec §5.1/§5.2/§5.3). Returns raw
/// Arrow IPC STREAM bytes via `tauri::ipc::Response` — no JSON serialization
/// (retires §0 defect #3). Positions are PM-propagated to `epoch_jd` with
/// v1's exact formula; rows sorted g_mag asc, source_id asc.
#[tauri::command]
async fn query_catalog_v2(
    state: State<'_, AppState>,
    ra_deg: f64,
    dec_deg: f64,
    radius_deg: f64,
    tier: String,
    epoch_jd: f64,
) -> Result<tauri::ipc::Response, String> {
    let mut guard = state.starplates.lock().map_err(|e| e.to_string())?;
    let store = guard
        .as_mut()
        .ok_or("E_NOT_INITIALIZED: call starplates_init first")?;
    let bytes = starplates::query::query_v2(store, ra_deg, dec_deg, radius_deg, &tier, epoch_jd)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Store status snapshot (same shape as `starplates_init`'s result).
#[tauri::command]
async fn starplates_status(state: State<'_, AppState>) -> Result<StarplatesStatus, String> {
    let guard = state.starplates.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .map(|s| s.status())
        .ok_or_else(|| "E_NOT_INITIALIZED: call starplates_init first".to_string())
}

/// Explicit, UI/CLI-triggered blob sync from the R2 public base URL (spec §7).
/// NEVER invoked implicitly by the solve path; resumable range GETs, per-blob
/// SHA-256 verify, atomic install. `version`, when given, must match the pin —
/// release upgrades ship as a new pin (spec §2.4), not through sync.
#[tauri::command]
async fn starplates_sync(
    state: State<'_, AppState>,
    version: Option<String>,
    tier: String,
    region: Option<SyncRegion>,
    base_url: Option<String>,
) -> Result<SyncReport, String> {
    let (root, release, plan) = {
        let guard = state.starplates.lock().map_err(|e| e.to_string())?;
        let store = guard
            .as_ref()
            .ok_or("E_NOT_INITIALIZED: call starplates_init first")?;
        if let Some(v) = &version {
            if v != &store.release {
                return Err(format!(
                    "E_SYNC_RELEASE_MISMATCH: pinned {:?}, requested {:?} — release upgrades flip pinned.json (spec §2.4), sync only fills the pinned release",
                    store.release, v
                ));
            }
        }
        let plan = starplates::sync::plan_sync(store, &tier, region.as_ref())?;
        (store.root().to_path_buf(), store.release.clone(), plan)
    };
    let base = starplates::sync::resolve_base_url(base_url)?;
    let tier_owned = tier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        starplates::sync::run_sync(&root, &base, &release, &tier_owned, &plan)
    })
    .await
    .map_err(|e| format!("E_SYNC_JOIN: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Restores dialog-granted fs scopes on startup + saves every new grant.
        // Registered AFTER fs so the fs scope manager exists to restore into.
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let gpu = tauri::async_runtime::block_on(NativeGpuContext::init())
                .map_err(|e| e.to_string())?;
            
            app.manage(AppState {
                gpu: Arc::new(gpu),
                buffers: Mutex::new(BufferRegistry::new()),
                starplates: Mutex::new(None), // Initialized later via starplates_init
                star_data: Arc::new(StarDataControl::default()),
            });

            log::info!("[SkyCruncher] Native GPU context initialized");
            log::info!("[SkyCruncher] Buffer registry ready");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_native,
            demosaic_native,
            register_buffer,
            release_buffer,
            buffer_diagnostics,
            starplates_init,
            query_catalog_v2,
            starplates_status,
            starplates_sync,
            solve_greenfield,
            star_data_status,
            star_data_download,
            star_data_verify,
            star_data_cancel,
            #[cfg(feature = "ai-terrain")]
            run_terrain_oracle,
            #[cfg(feature = "ai-distortion")]
            run_distortion_oracle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
