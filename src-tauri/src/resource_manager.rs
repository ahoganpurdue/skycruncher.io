use std::path::PathBuf;

/// Centralized resource manager for bundled assets.
///
/// Resolves paths to the bundled starplates release, DEM tiles, ONNX models,
/// and other large assets that ship with the desktop installer.
///
/// In a Tauri app, bundled resources are accessible via `AppHandle::path().resource_dir()`.
/// This manager wraps that API and provides a consistent interface for all subsystems.
pub struct ResourceManager {
    resource_dir: PathBuf,
}

impl ResourceManager {
    /// Initialize from a Tauri app handle's resource directory.
    pub fn new(resource_dir: PathBuf) -> Self {
        log::info!("[ResourceManager] Resource directory: {:?}", resource_dir);
        Self { resource_dir }
    }

    /// Resolve the bundled resource directory from a live app handle.
    pub fn init(app: &tauri::AppHandle) -> Result<Self, String> {
        use tauri::Manager;
        let dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir unresolved: {e}"))?;
        Ok(Self::new(dir))
    }

    /// Directory holding the bundled starplates release(s)
    /// (docs/STARPLATES_SPEC.md §8: `resources/starplates/<release-id>/…`,
    /// bundled via tauri.conf.json `"resources": ["resources/starplates/**"]`).
    /// Read-only seed material — the local store (§6) is the runtime source.
    pub fn starplates_release_dir(&self) -> PathBuf {
        self.resolve("resources/starplates")
    }

    /// Resolve a relative resource path to an absolute path.
    pub fn resolve(&self, relative: &str) -> PathBuf {
        self.resource_dir.join(relative)
    }

    /// Get the directory containing DEM (SRTM HGT) tiles.
    pub fn dem_tiles_dir(&self) -> PathBuf {
        self.resolve("dem_tiles")
    }

    /// Get the path to the Terrain Segmentation ONNX model.
    pub fn terrain_model_path(&self) -> PathBuf {
        self.resolve("terrain_oracle.onnx")
    }

    /// Get the path to the Distortion Oracle ONNX model.
    pub fn distortion_model_path(&self) -> PathBuf {
        self.resolve("distortion_oracle.onnx")
    }

    /// Check if a specific resource exists on disk.
    pub fn exists(&self, relative: &str) -> bool {
        self.resolve(relative).exists()
    }

    /// List all available DEM tiles in the tiles directory.
    pub fn list_dem_tiles(&self) -> Vec<String> {
        let dir = self.dem_tiles_dir();
        if !dir.exists() {
            return Vec::new();
        }

        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(|entry| {
                        let entry = entry.ok()?;
                        let name = entry.file_name().to_str()?.to_string();
                        if name.ends_with(".hgt") {
                            Some(name)
                        } else {
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}
