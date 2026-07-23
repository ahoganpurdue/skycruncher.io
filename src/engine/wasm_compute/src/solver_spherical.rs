use wasm_bindgen::prelude::*;
use crate::bright_star_atlas::{BRIGHT_ATLAS, AtlasEntry};

#[wasm_bindgen]
pub fn solve_spherical_global(
    det_x: &[f64], 
    det_y: &[f64],
    focal_mm: f64, 
    pitch_mm: f64,
    cx: f64,
    cy: f64,
    lat_deg: f64,
    lon_deg: f64,
    jd: f64,
    config_tolerance: f64
) -> Vec<f64> {
    let mut results = Vec::new();
    let n = det_x.len().min(det_y.len());
    if n < 4 { return results; }

    let lat_rad = lat_deg.to_radians();
    let lon_rad = lon_deg.to_radians();

    // 1. Get visible stars and estimate FOV
    // FOV (diagonal) ~= 2 * atan(sensor_size / (2 * focal))
    // For a 36mm sensor (standard reference for wide-field logic triggers)
    let diag_mm = (cx*cx + cy*cy).sqrt() * 2.0 * pitch_mm;
    let fov_rad = 2.0 * (diag_mm / (2.0 * focal_mm)).atan();
    // Pruning threshold: stars must be within FOV of each other
    let max_chord = (2.0 - 2.0 * fov_rad.cos()).sqrt();

    let visible_stars = crate::bright_star_atlas::get_visible_stars(lat_rad, lon_rad, jd, 0.0);
    if visible_stars.len() < 4 { return results; }

    // 2. Convert detections to 3D unit vectors
    let mut det_units = Vec::with_capacity(n);
    for i in 0..n {
        let x_norm = (det_x[i] - cx) * pitch_mm / focal_mm;
        let y_norm = (det_y[i] - cy) * pitch_mm / focal_mm;
        let z = 1.0 / (1.0 + x_norm*x_norm + y_norm*y_norm).sqrt();
        det_units.push([x_norm * z, y_norm * z, z]);
    }

    // 3. Precompute Atlas Quads within FOV (Hash Table Optimization)
    // In a real high-perf system, this would be a static spatial index.
    // Here we build a local hash for the visible subset.
    use std::collections::HashMap;
    let mut atlas_hashes = HashMap::new();
    
    let m = visible_stars.len();
    for ai in 0..m.saturating_sub(3) {
        for aj in ai+1..m.saturating_sub(2) {
            let dist_ij = chord_dist(visible_stars[ai].unit, visible_stars[aj].unit);
            if dist_ij > max_chord { continue; }
            
            for ak in aj+1..m.saturating_sub(1) {
                let dist_jk = chord_dist(visible_stars[aj].unit, visible_stars[ak].unit);
                if dist_jk > max_chord { continue; }
                
                for al in ak+1..m {
                    let dist_kl = chord_dist(visible_stars[ak].unit, visible_stars[al].unit);
                    if dist_kl > max_chord { continue; }

                    let atlas_u = [
                        visible_stars[ai].unit,
                        visible_stars[aj].unit,
                        visible_stars[ak].unit,
                        visible_stars[al].unit,
                    ];
                    
                    if !is_compact(&atlas_u) { continue; }
                    
                    let atlas_code = compute_5d_chord_hash(&atlas_u);
                    // Quantize for hash lookup (1% buckets)
                    let key = (
                        (atlas_code[0] * 100.0) as i32,
                        (atlas_code[1] * 100.0) as i32,
                        (atlas_code[2] * 100.0) as i32,
                        (atlas_code[3] * 100.0) as i32,
                        (atlas_code[4] * 100.0) as i32,
                    );
                    atlas_hashes.insert(key, [ai, aj, ak, al]);
                }
            }
        }
    }

    // 4. Quad Matching
    for i in 0..n.saturating_sub(3) {
        for j in i+1..n.saturating_sub(2) {
            for k in j+1..n.saturating_sub(1) {
                for l in k+1..n {
                    let u = [det_units[i], det_units[j], det_units[k], det_units[l]];
                    if !is_compact(&u) { continue; }
                    
                    let det_code = compute_5d_chord_hash(&u);
                    if !det_code.iter().all(|v| v.is_finite()) { continue; }
                    let key = (
                        (det_code[0] * 100.0) as i32,
                        (det_code[1] * 100.0) as i32,
                        (det_code[2] * 100.0) as i32,
                        (det_code[3] * 100.0) as i32,
                        (det_code[4] * 100.0) as i32,
                    );

                    if let Some(atlas_idx) = atlas_hashes.get(&key) {
                        // Found a potential match!
                        results.push(i as f64);
                        results.push(j as f64);
                        results.push(k as f64);
                        results.push(l as f64);
                        
                        results.push(visible_stars[atlas_idx[0]].ra_rad);
                        results.push(visible_stars[atlas_idx[0]].dec_rad);
                        results.push(visible_stars[atlas_idx[1]].ra_rad);
                        results.push(visible_stars[atlas_idx[1]].dec_rad);
                        results.push(visible_stars[atlas_idx[2]].ra_rad);
                        results.push(visible_stars[atlas_idx[2]].dec_rad);
                        results.push(visible_stars[atlas_idx[3]].ra_rad);
                        results.push(visible_stars[atlas_idx[3]].dec_rad);
                        
                        // Quantized hash match gives quality ~= 1/100 per dimension
                        results.push(0.01_f64);
                        
                        if results.len() >= 13 * 10 { return results; }
                    }
                }
            }
        }
    }

    results
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0]*b[0] + a[1]*b[1] + a[2]*b[2]
}

fn chord_dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    (2.0 - 2.0 * dot(a, b)).sqrt()
}

fn is_compact(u: &[[f64; 3]; 4]) -> bool {
    for i in 0..4 {
        for j in i+1..4 {
            if dot(u[i], u[j]) < 0.0 { return false; }
        }
    }
    true
}

fn compute_5d_chord_hash(u: &[[f64; 3]; 4]) -> [f64; 5] {
    let mut chords = [0.0; 6];
    let mut idx = 0;
    for i in 0..4 {
        for j in i+1..4 {
            chords[idx] = chord_dist(u[i], u[j]);
            idx += 1;
        }
    }
    // NaN-safe: a non-finite chord (NaN detection coords) must not panic.
    chords.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let longest = chords[0];
    [
        chords[1] / longest,
        chords[2] / longest,
        chords[3] / longest,
        chords[4] / longest,
        chords[5] / longest,
    ]
}
