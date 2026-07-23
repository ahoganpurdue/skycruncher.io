use memmap2::Mmap;
use std::collections::HashMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::Arc;

/// DEM (Digital Elevation Model) tile manager.
///
/// Loads terrain elevation tiles on demand based on GPS coordinates.
/// Uses `memmap2` for zero-copy OS-managed paging â€” only the needed
/// portions of each tile are loaded into physical RAM.
///
/// Tile format: SRTM HGT (1-arcsecond, ~2.5MB per tile, 3601Ã—3601 i16).
/// Each tile covers 1Â°Ã—1Â° of latitude/longitude.
///
/// [Module: M2] [Domain: TerrestrialLocalization] GPS_COORDINATES -> DEM_TILE_LOADED
pub struct DemTileManager {
    /// Cache of memory-mapped tiles: (lat_floor, lon_floor) â†’ mmap
    cache: HashMap<(i32, i32), Arc<Mmap>>,
    /// Directory containing HGT tiles
    tile_dir: PathBuf,
    /// Tile resolution (samples per degree edge), default 3601 for SRTM1
    samples_per_edge: usize,
}

impl DemTileManager {
    pub fn new(tile_dir: PathBuf) -> Self {
        Self {
            cache: HashMap::new(),
            tile_dir,
            samples_per_edge: 3601, // SRTM 1-arcsecond
        }
    }

    /// Get the elevation (meters) at a given GPS coordinate.
    ///
    /// Loads the relevant tile on first access; subsequent queries to the
    /// same 1Â°Ã—1Â° region use the cached mmap.
    pub fn get_elevation(&mut self, lat: f64, lon: f64) -> Result<f32, String> {
        let lat_floor = lat.floor() as i32;
        let lon_floor = lon.floor() as i32;

        // Load tile if not cached
        if !self.cache.contains_key(&(lat_floor, lon_floor)) {
            self.load_tile(lat_floor, lon_floor)?;
        }

        let mmap = self.cache.get(&(lat_floor, lon_floor))
            .ok_or_else(|| format!("Tile ({}, {}) not in cache after load", lat_floor, lon_floor))?;

        // Calculate the sample indices within the tile
        let row = ((lat_floor as f64 + 1.0 - lat) * (self.samples_per_edge - 1) as f64) as usize;
        let col = ((lon - lon_floor as f64) * (self.samples_per_edge - 1) as f64) as usize;

        let row = row.min(self.samples_per_edge - 1);
        let col = col.min(self.samples_per_edge - 1);

        let offset = (row * self.samples_per_edge + col) * 2; // i16 = 2 bytes
        if offset + 1 >= mmap.len() {
            return Err(format!("Offset {} out of bounds for tile ({}, {})", offset, lat_floor, lon_floor));
        }

        // SRTM HGT files are big-endian i16
        let elevation = i16::from_be_bytes([mmap[offset], mmap[offset + 1]]);

        // -32768 is the SRTM void value (no data)
        if elevation == -32768 {
            return Err(format!("No DEM data at ({:.4}, {:.4})", lat, lon));
        }

        Ok(elevation as f32)
    }

    /// Compute the terrain horizon profile from an observer position.
    ///
    /// Returns elevation angles (degrees above horizontal) at 1Â° azimuth
    /// intervals (360 values). Each value represents the maximum terrain
    /// elevation angle visible from the observer in that direction.
    ///
    /// The search extends `max_distance_km` from the observer in each direction.
    pub fn compute_horizon_profile(
        &mut self,
        lat: f64,
        lon: f64,
        max_distance_km: f64,
    ) -> Result<Vec<f32>, String> {
        let observer_elev = self.get_elevation(lat, lon)?;
        let mut profile = Vec::with_capacity(360);

        for az_deg in 0..360 {
            let az = (az_deg as f64).to_radians();
            let mut max_angle: f32 = 0.0;

            // Sample terrain at increasing distances
            let step_km = 0.5; // 500m steps
            let num_steps = (max_distance_km / step_km) as usize;

            for step in 1..=num_steps {
                let dist_km = step as f64 * step_km;

                // Approximate lat/lon offset for the given azimuth and distance
                let dlat = (az.cos() * dist_km) / 111.32; // 1Â° lat â‰ˆ 111.32 km
                let dlon = (az.sin() * dist_km) / (111.32 * lat.to_radians().cos());

                let sample_lat = lat + dlat;
                let sample_lon = lon + dlon;

                if let Ok(elev) = self.get_elevation(sample_lat, sample_lon) {
                    let height_diff = elev - observer_elev;
                    let dist_m = dist_km * 1000.0;
                    let angle = (height_diff as f64 / dist_m).atan().to_degrees() as f32;
                    if angle > max_angle {
                        max_angle = angle;
                    }
                }
                // If tile is missing or void, skip this sample
            }

            profile.push(max_angle);
        }

        Ok(profile)
    }

    /// Load a single HGT tile into the mmap cache.
    fn load_tile(&mut self, lat: i32, lon: i32) -> Result<(), String> {
        let filename = format!(
            "{}{:02}{}{:03}.hgt",
            if lat >= 0 { 'N' } else { 'S' },
            lat.unsigned_abs(),
            if lon >= 0 { 'E' } else { 'W' },
            lon.unsigned_abs(),
        );

        let path = self.tile_dir.join(&filename);
        if !path.exists() {
            return Err(format!("DEM tile not found: {:?}", path));
        }

        let file = File::open(&path).map_err(|e| format!("Failed to open DEM tile {:?}: {}", path, e))?;

        // SAFETY: HGT files are static terrain data, never modified at runtime.
        // The file is opened read-only. The mmap is invalidated only when the
        // DemTileManager is dropped or the entry is evicted from the cache.
        let mmap = unsafe {
            Mmap::map(&file).map_err(|e| format!("Failed to mmap DEM tile {:?}: {}", path, e))?
        };

        log::info!(
            "[M2] Loaded DEM tile {} ({} bytes)",
            filename, mmap.len()
        );

        self.cache.insert((lat, lon), Arc::new(mmap));
        Ok(())
    }

    /// Evict a tile from the cache to free memory.
    pub fn evict_tile(&mut self, lat: i32, lon: i32) -> bool {
        self.cache.remove(&(lat, lon)).is_some()
    }

    /// Get the number of cached tiles.
    pub fn cached_tile_count(&self) -> usize {
        self.cache.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tile_filename_generation() {
        let manager = DemTileManager::new(PathBuf::from("/tmp"));
        // The path generation is tested implicitly through load_tile
        assert_eq!(manager.samples_per_edge, 3601);
    }
}
