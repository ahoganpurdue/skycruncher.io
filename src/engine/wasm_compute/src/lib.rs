use wasm_bindgen::prelude::*;
// use std::collections::HashMap; // Removed unused
use std::cell::RefCell;

pub mod photometry;
pub mod manifest;
pub mod solver_verification;
pub mod sky_transform;
pub mod ephemeris;
pub mod statistics;
/// Refine star parameters using Levenberg-Marquardt fitting.
/// Reads from a previously-populated Float32 luminance buffer (ptr).
/// params: [A, cx, cy, sx, sy, theta] * N
#[wasm_bindgen]
pub fn refine_stars_bulk(
    lum_ptr: *const f32,
    width: u32,
    height: u32,
    mut params: Vec<f64>,
    stamp_size: u32,
) -> Vec<f64> {
    let lum = unsafe { std::slice::from_raw_parts(lum_ptr, (width * height) as usize) };
    crate::photometry::refine_stars_bulk_impl(lum, width, height, &mut params, stamp_size);
    params
}

// ═════════════════════════════════════════════════════════════════════════
// FAST-CACHE MEMORY SPACE
// ═════════════════════════════════════════════════════════════════════════

thread_local! {
    // Reusable Visited Buffer to prevent massive per-frame allocations
    static VISITED_CACHE: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static INPUT_BUFFER: RefCell<Vec<f32>> = RefCell::new(Vec::new());
    // [Module: M1] CFA normalization buffers
    static CFA_INPUT_BUFFER: RefCell<Vec<u16>> = RefCell::new(Vec::new());
    static CFA_OUTPUT_BUFFER: RefCell<Vec<f32>> = RefCell::new(Vec::new());
}

#[wasm_bindgen]
pub fn get_input_buffer_ptr(size: usize) -> *mut f32 {
    INPUT_BUFFER.with(|buf| {
        let mut b = buf.borrow_mut();
        if b.len() < size {
            b.resize(size, 0.0);
        }
        b.as_mut_ptr()
    })
}

// ═════════════════════════════════════════════════════════════════════════
// CFA NORMALIZATION (Uint16 → Float32, Black-Level Subtract)
// ═════════════════════════════════════════════════════════════════════════
//
// [Module: M1] [Domain: NormalizationState] RAW_14BIT -> NORMALIZED_FLOAT32
//
// Offloads the O(N) normalization loop from the JS main thread into WASM.
// Uses thread-local buffers for zero-copy: TypeScript writes Uint16 data
// directly into WASM linear memory via get_cfa_input_ptr(), then calls
// normalize_cfa() which writes Float32 output and returns its pointer.

/// Allocate and return a pointer to the CFA input buffer.
/// TypeScript should write Uint16 sensor data here before calling normalize_cfa.
#[wasm_bindgen]
pub fn get_cfa_input_ptr(size: usize) -> *mut u16 {
    CFA_INPUT_BUFFER.with(|buf| {
        let mut b = buf.borrow_mut();
        if b.len() < size {
            b.resize(size, 0);
        }
        b.as_mut_ptr()
    })
}

/// Normalize CFA data: (value - black_level) / (max_val - black_level), clamped to [0, 1].
/// Reads from the CFA_INPUT_BUFFER, writes to CFA_OUTPUT_BUFFER, returns pointer to output.
///
/// # Arguments
/// * `len` - Number of Uint16 elements to normalize
/// * `black_level` - Sensor black level (e.g. 2048 for 14-bit Canon)
/// * `max_val` - Maximum sensor value (e.g. 16383 for 14-bit)
#[wasm_bindgen]
pub fn normalize_cfa(len: u32, black_level: u16, max_val: u16) -> *const f32 {
    let length = len as usize;
    let range = (max_val as f32) - (black_level as f32);
    let inv_range = if range > 0.0 { 1.0 / range } else { 0.0 };

    CFA_INPUT_BUFFER.with(|input_ref| {
        CFA_OUTPUT_BUFFER.with(|output_ref| {
            let input = input_ref.borrow();
            let mut output = output_ref.borrow_mut();

            if output.len() < length {
                output.resize(length, 0.0);
            }

            for i in 0..length {
                let raw = input[i] as f32;
                let val = (raw - black_level as f32) * inv_range;
                output[i] = if val > 0.0 { val } else { 0.0 };
            }

            output.as_ptr()
        })
    })
}

// ═════════════════════════════════════════════════════════════════════════
// RUST WASM MODULE: Agnostic Metrology (Vector Consensus)
// ═════════════════════════════════════════════════════════════════════════

#[wasm_bindgen]
pub fn convert_rgba_to_luma(
    ptr: *const u8,
    width: u32,
    height: u32,
) -> *const f32 {
    let size = (width * height) as usize;
    let rgba = unsafe { std::slice::from_raw_parts(ptr, size * 4) };
    
    CFA_OUTPUT_BUFFER.with(|buf| {
        let mut output = buf.borrow_mut();
        if output.len() < size {
            output.resize(size, 0.0);
        }

        for i in 0..size {
            let r = rgba[i * 4] as f32;
            let g = rgba[i * 4 + 1] as f32;
            let b = rgba[i * 4 + 2] as f32;
            // ITU-R BT.709 luminance weights / 255
            output[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
        }
        output.as_ptr()
    })
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[wasm_bindgen]
pub fn init_pipeline() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn validate_manifest(js_manifest: JsValue) -> Result<JsValue, JsValue> {
    let manifest: manifest::PipelineManifest = serde_wasm_bindgen::from_value(js_manifest)?;
    
    // For now, just echo it back as proof of round-trip serialization
    let echoed = serde_wasm_bindgen::to_value(&manifest)?;
    Ok(echoed)
}

#[wasm_bindgen]
pub struct VectorStar {
    pub x: f64,
    pub y: f64,
    pub brightness: f64,
}

#[wasm_bindgen]
impl VectorStar {
    #[wasm_bindgen(constructor)]
    pub fn new(x: f64, y: f64, brightness: f64) -> VectorStar {
        VectorStar { x, y, brightness }
    }
}

#[wasm_bindgen]
pub struct AtlasStar {
    pub ra: f64,
    pub dec: f64,
    pub mag: f64,
}

#[wasm_bindgen]
impl AtlasStar {
    #[wasm_bindgen(constructor)]
    pub fn new(ra: f64, dec: f64, mag: f64) -> AtlasStar {
        AtlasStar { ra, dec, mag }
    }
}

#[wasm_bindgen]
pub struct SolveResult {
    pub scale: f64,
    pub match_count: usize,
}


struct TriangleDescriptor {
    longest: f64,
    r1: f64,
    r2: f64,
}

fn get_triangle_descriptor(s0: &VectorStar, s1: &VectorStar, s2: &VectorStar) -> TriangleDescriptor {
    let d01 = ((s0.x - s1.x).powi(2) + (s0.y - s1.y).powi(2)).sqrt();
    let d12 = ((s1.x - s2.x).powi(2) + (s1.y - s2.y).powi(2)).sqrt();
    let d20 = ((s2.x - s0.x).powi(2) + (s2.y - s0.y).powi(2)).sqrt();

    let mut sides = [d01, d12, d20];
    sides.sort_by(|a, b| b.partial_cmp(a).unwrap());

    let longest = sides[0];
    if longest == 0.0 {
        return TriangleDescriptor { longest: 0.0, r1: 0.0, r2: 0.0 };
    }

    TriangleDescriptor {
        longest,
        r1: sides[1] / longest,
        r2: sides[2] / longest,
    }
}

fn calculate_angular_distance(ra1: f64, dec1: f64, ra2: f64, dec2: f64) -> f64 {
    // Equirectangular approximation for small angles, or Haversine?
    // The JS version used Haversine-like. Let's use Haversine for accuracy on celestial sphere.
    let deg2rad = std::f64::consts::PI / 180.0;
    
    let r1 = ra1 * deg2rad;
    let d1 = dec1 * deg2rad;
    let r2 = ra2 * deg2rad;
    let d2 = dec2 * deg2rad;
    
    let dlon = r2 - r1;
    let dlat = d2 - d1;
    
    let a = (dlat / 2.0).sin().powi(2) + d1.cos() * d2.cos() * (dlon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin(); // JS Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) simplifies to this
    
    c / deg2rad // Return degrees
}

#[wasm_bindgen]
pub fn solve_blind(
    anchors_x: &[f64], anchors_y: &[f64], anchors_b: &[f64],
    atlas_ra: &[f64], atlas_dec: &[f64], atlas_mag: &[f64],
    scale_hint: f64
) -> SolveResult {
    
    let mut anchors = Vec::with_capacity(anchors_x.len());
    for i in 0..anchors_x.len() {
        anchors.push(VectorStar { x: anchors_x[i], y: anchors_y[i], brightness: anchors_b[i] });
    }
    
    let mut atlas = Vec::with_capacity(atlas_ra.len());
    for i in 0..atlas_ra.len() {
        atlas.push(AtlasStar { ra: atlas_ra[i], dec: atlas_dec[i], mag: atlas_mag[i] });
    }

    let n_anchors = anchors.len();
    let n_atlas = atlas.len();
    
    let mut matches = Vec::new();
    let triangle_tolerance = 0.015;

    // ── O(N_anchors^3) Loop ──
    for i in 0..n_anchors.saturating_sub(2) {
        for j in i + 1..n_anchors.saturating_sub(1) {
            for k in j + 1..n_anchors {
                let s0 = &anchors[i];
                let s1 = &anchors[j];
                let s2 = &anchors[k];

                let desc = get_triangle_descriptor(s0, s1, s2);
                if desc.longest < 20.0 { continue; }

                // ── O(N_atlas^3) Loop ──
                for ai in 0..n_atlas.saturating_sub(2) {
                    for aj in ai + 1..n_atlas.saturating_sub(1) {
                        for ak in aj + 1..n_atlas {
                            let a0 = &atlas[ai];
                            let a1 = &atlas[aj];
                            let a2 = &atlas[ak];

                            let a01 = calculate_angular_distance(a0.ra, a0.dec, a1.ra, a1.dec);
                            let a12 = calculate_angular_distance(a1.ra, a1.dec, a2.ra, a2.dec);
                            let a20 = calculate_angular_distance(a2.ra, a2.dec, a0.ra, a0.dec);

                            let mut sides_deg = [a01, a12, a20];
                            sides_deg.sort_by(|a, b| b.partial_cmp(a).unwrap());

                            let longest_deg = sides_deg[0];
                            if longest_deg < 0.1 { continue; }

                            // [O(N^6) combinatorial Pruning using physical Scale Hint]
                            if scale_hint > 0.0 {
                                let expected_longest_deg = (desc.longest * scale_hint) / 3600.0;
                                // Allow +/- 20% variance to capture focus breath / crop sensor differences
                                if (longest_deg - expected_longest_deg).abs() / expected_longest_deg > 0.20 {
                                    continue;
                                }
                            }

                            let ratio1_deg = sides_deg[1] / longest_deg;
                            let ratio2_deg = sides_deg[2] / longest_deg;

                            if (ratio1_deg - desc.r1).abs() < triangle_tolerance && 
                               (ratio2_deg - desc.r2).abs() < triangle_tolerance {
                                
                                let _scale_px_per_deg = desc.longest / longest_deg;
                                let scale = (longest_deg * 3600.0) / desc.longest; // arcsec/px
                                
                                if scale > 0.5 && scale < 100.0 {
                                    let error = (ratio1_deg - desc.r1).abs() + (ratio2_deg - desc.r2).abs();
                                    if error < 0.02 {
                                        matches.push((scale, error));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if matches.is_empty() {
        return SolveResult { scale: 0.0, match_count: 0 };
    }

    // Sort by scale to find clusters
    matches.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    
    let mut best_cluster = Vec::new();
    let mut current_cluster = Vec::new();
    
    for m in matches.iter() {
        if current_cluster.is_empty() {
            current_cluster.push(*m);
        } else {
            let centroid: f64 = current_cluster.iter().map(|c| c.0).sum::<f64>() / current_cluster.len() as f64;
            if (m.0 - centroid).abs() / centroid < 0.05 {
                current_cluster.push(*m);
            } else {
                if current_cluster.len() > best_cluster.len() {
                    best_cluster = current_cluster.clone();
                }
                current_cluster = vec![*m];
            }
        }
    }
    if current_cluster.len() > best_cluster.len() {
        best_cluster = current_cluster;
    }

    if best_cluster.len() >= 3 {
        let avg_scale: f64 = best_cluster.iter().map(|m| m.0).sum::<f64>() / best_cluster.len() as f64;
        return SolveResult { scale: avg_scale, match_count: best_cluster.len() };
    } 
    
    // Fallback: lowest error
    matches.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    if matches[0].1 < 0.005 {
        return SolveResult { scale: matches[0].0, match_count: 1 };
    }
    SolveResult { scale: 0.0, match_count: 0 }
}

#[wasm_bindgen]
pub fn solve_guided(
    anchors_x: &[f64], anchors_y: &[f64], anchors_b: &[f64],
    atlas_ra: &[f64], atlas_dec: &[f64], atlas_mag: &[f64],
    exif_scale_hint: f64
) -> SolveResult {
    let mut anchors = Vec::with_capacity(anchors_x.len());
    for i in 0..anchors_x.len() {
        anchors.push(VectorStar { x: anchors_x[i], y: anchors_y[i], brightness: anchors_b[i] });
    }
    
    let mut atlas = Vec::with_capacity(atlas_ra.len());
    for i in 0..atlas_ra.len() {
        atlas.push(AtlasStar { ra: atlas_ra[i], dec: atlas_dec[i], mag: atlas_mag[i] });
    }

    if anchors.is_empty() {
        return SolveResult { scale: 0.0, match_count: 0 };
    }

    let anchor = &anchors[0];
    let probes = &anchors[1..anchors.len().min(9)];
    let mut scale_candidates = Vec::new();

    let mag_tolerance = 0.15;
    let geo_tolerance = 0.20;

    for probe in probes {
        let dist_px = ((probe.x - anchor.x).powi(2) + (probe.y - anchor.y).powi(2)).sqrt();
        let pixel_mag_ratio = probe.brightness / if anchor.brightness == 0.0 { 1.0 } else { anchor.brightness };

        for i in 0..atlas.len() {
            let a1 = &atlas[i];
            for j in 0..atlas.len() {
                if i == j { continue; }
                let a2 = &atlas[j];

                let dist_deg = calculate_angular_distance(a1.ra, a1.dec, a2.ra, a2.dec);
                let derived_scale = (dist_deg * 3600.0) / dist_px;

                let geo_error = (derived_scale - exif_scale_hint).abs() / if exif_scale_hint == 0.0 { 1.0 } else { exif_scale_hint };
                if geo_error < geo_tolerance {
                    let ratio_calc = 10.0_f64.powf(0.4 * (a1.mag - a2.mag));
                    let mag_error = (pixel_mag_ratio - ratio_calc).abs();

                    if mag_error < mag_tolerance {
                        scale_candidates.push(derived_scale);
                    }
                }
            }
        }
    }

    if scale_candidates.len() < 3 {
        return SolveResult { scale: 0.0, match_count: 0 };
    }

    scale_candidates.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median_scale = scale_candidates[scale_candidates.len() / 2];

    SolveResult { scale: median_scale, match_count: scale_candidates.len() }
}

#[wasm_bindgen]
pub fn refine_stars_lm(
    pixels_flat: &[f32], // array of concatenated star stamps
    width: u32,
    height: u32,
    params_flat: &[f64]  // [A, cx, cy, sx, sy, theta] per star
) -> Vec<f64> {
    let num_stars = params_flat.len() / 6;
    let pixels_per_star = (width * height) as usize;
    let mut results = Vec::with_capacity(num_stars * 6);
    
    for i in 0..num_stars {
        let p_start = i * 6;
        let p_vec = nalgebra::Vector6::new(
            params_flat[p_start],
            params_flat[p_start + 1],
            params_flat[p_start + 2],
            params_flat[p_start + 3],
            params_flat[p_start + 4],
            params_flat[p_start + 5]
        );
        
        let pix_start = i * pixels_per_star;
        let pix_end = pix_start + pixels_per_star;
        let stamp = &pixels_flat[pix_start..pix_end];
        
        let fitted = photometry::fit_gaussian_2d(stamp, width, height, 0, 0, p_vec);
        
        results.push(fitted[0]); // A
        results.push(fitted[1]); // cx
        results.push(fitted[2]); // cy
        results.push(fitted[3]); // sx
        results.push(fitted[4]); // sy
        results.push(fitted[5]); // theta
    }
    
    results
}

// ═════════════════════════════════════════════════════════════════════════
// SOURCE EXTRACTION (Morphological Stamping)
// ═════════════════════════════════════════════════════════════════════════

#[wasm_bindgen]
pub fn extract_blobs_shared(
    ptr: *const f32,
    w: u32,
    h: u32,
    thresh: f32,
    bg: f32,
) -> Vec<f64> {
    let total_pixels = (w * h) as usize;
    // ZERO-COPY: Create a slice from the raw pointer without copying
    let lum = unsafe { std::slice::from_raw_parts(ptr, total_pixels) };
    internal_extract_blobs(lum, w, h, thresh, bg)
}

#[wasm_bindgen]
pub fn extract_blobs(
    lum: &[f32],
    w: u32,
    h: u32,
    thresh: f32,
    bg: f32,
) -> Vec<f64> {
    internal_extract_blobs(lum, w, h, thresh, bg)
}

fn internal_extract_blobs(
    lum: &[f32],
    w: u32,
    h: u32,
    thresh: f32,
    bg: f32,
) -> Vec<f64> {
    let mut results = Vec::new();
    let mut q = Vec::new(); 

    VISITED_CACHE.with(|cache_ref| {
        let mut visited = cache_ref.borrow_mut();
        let total_pixels = (w * h) as usize;
        
        // Fast-Cache allocation: only grow if necessary
        if visited.len() < total_pixels {
            visited.resize(total_pixels, 0);
        }
        
        // Zero out only the utilized portion of the persistent cache
        for v in visited.iter_mut().take(total_pixels) {
            *v = 0;
        }

        for y in 1..(h - 1) {
            for x in 1..(w - 1) {
                let idx = (y * w + x) as usize;
                if lum[idx] > thresh && visited[idx] == 0 {
                    // start flood fill
                    q.clear();
                    q.push((x, y));
                    visited[idx] = 1;

                    let mut sum_x: f64 = 0.0;
                    let mut sum_y: f64 = 0.0;
                    let mut sum_flux: f64 = 0.0;
                    let mut peak_val: f64 = 0.0;
                    let mut count = 0;

                    let mut sum_x2: f64 = 0.0;
                    let mut sum_y2: f64 = 0.0;
                    let mut sum_xy: f64 = 0.0;

                    while let Some((cx, cy)) = q.pop() {
                        let c_idx = (cy * w + cx) as usize;
                        let val = lum[c_idx] as f64;
                        let net_flux = if val > bg as f64 { val - bg as f64 } else { 0.0 };

                        if val > peak_val {
                            peak_val = val;
                        }

                        sum_flux += net_flux;
                        sum_x += (cx as f64) * net_flux;
                        sum_y += (cy as f64) * net_flux;
                        sum_x2 += (cx as f64) * (cx as f64) * net_flux;
                        sum_y2 += (cy as f64) * (cy as f64) * net_flux;
                        sum_xy += (cx as f64) * (cy as f64) * net_flux;
                        count += 1;

                        // Neighbors (4-way)
                        let neighbors = [
                            (cx + 1, cy),
                            (cx.saturating_sub(1), cy),
                            (cx, cy + 1),
                            (cx, cy.saturating_sub(1)),
                        ];

                        for &(nx, ny) in &neighbors {
                            if nx < w && ny < h {
                                let n_idx = (ny * w + nx) as usize;
                                if visited[n_idx] == 0 && lum[n_idx] > thresh {
                                    visited[n_idx] = 1;
                                    q.push((nx, ny));
                                }
                            }
                        }
                    }

                    if count >= 2 && sum_flux > 0.0 {
                        let center_x = sum_x / sum_flux;
                        let center_y = sum_y / sum_flux;

                        let mut var_x = (sum_x2 / sum_flux) - (center_x * center_x);
                        if var_x < 0.0 { var_x = 0.0; }
                        
                        let mut var_y = (sum_y2 / sum_flux) - (center_y * center_y);
                        if var_y < 0.0 { var_y = 0.0; }
                        
                        let var_xy = (sum_xy / sum_flux) - (center_x * center_y);

                        let sigma_x = var_x.sqrt();
                        let sigma_y = var_y.sqrt();
                        let fwhm = 2.355 * (sigma_x * sigma_y).sqrt();

                        let min_sigma = if sigma_x < sigma_y { sigma_x } else { sigma_y };
                        let max_sigma = if sigma_x > sigma_y { sigma_x } else { sigma_y };
                        
                        let circularity = if max_sigma < 0.1 {
                            1.0
                        } else {
                            (min_sigma / max_sigma).min(1.0)
                        };

                        let theta = 0.5 * (2.0 * var_xy).atan2(var_x - var_y);

                        // Physical SNR approximation: Flux / sqrt(Sky Background Area * BG + ReadNoise^2)
                        let snr_area = (fwhm / 2.0).powi(2) * std::f64::consts::PI;
                        let snr = sum_flux / (sum_flux + snr_area * (bg as f64)).sqrt().max(1.0);

                        // Push flat array data: x, y, rawX, rawY, flux, peak, fwhm, circularity, theta, snr
                        results.push(center_x);
                        results.push(center_y);
                        results.push(center_x); // rawX
                        results.push(center_y); // rawY
                        results.push(sum_flux);
                        results.push(peak_val);
                        results.push(fwhm);
                        results.push(circularity);
                        results.push(theta);
                        results.push(snr);
                    }
                }
            }
        }
    });

    results
}

// ═════════════════════════════════════════════════════════════════════════
// COORDINATE FLATTENING (Brown-Conrady Inverse)
// ═════════════════════════════════════════════════════════════════════════

#[wasm_bindgen]
pub fn flatten_coordinates(
    x_coords: &[f64],
    y_coords: &[f64],
    cx: f64,
    cy: f64,
    k1: f64,
    k2: f64,
    k3: f64,
    p1: f64,
    p2: f64,
    r_ref: f64
) -> Vec<f64> {
    let mut results = Vec::with_capacity(x_coords.len() * 2);
    // let cx = width / 2.0; // Removed internal calculation
    // let cy = height / 2.0;
    
    let actual_r_ref = if r_ref > 0.0 { r_ref } else {
        (cx * cx + cy * cy).sqrt().max(1.0)
    };

    for i in 0..x_coords.len() {
        let x = x_coords[i];
        let y = y_coords[i];
        
        let x_dist = (x - cx) / actual_r_ref;
        let y_dist = (y - cy) / actual_r_ref;
        let rd = (x_dist * x_dist + y_dist * y_dist).sqrt();
        
        if rd < 1e-9 {
            results.push(x);
            results.push(y);
            continue;
        }

        // Newton-Raphson for radial inversion
        let mut ru = rd;
        
        for _ in 0..10 {
            let ru2 = ru * ru;
            let ru4 = ru2 * ru2;
            let ru6 = ru4 * ru2;
            
            let f = ru * (1.0 + k1 * ru2 + k2 * ru4 + k3 * ru6) - rd;
            if f.abs() < 1e-7 {
                break;
            }
            
            let df = 1.0 + 3.0 * k1 * ru2 + 5.0 * k2 * ru4 + 7.0 * k3 * ru6;
            ru = ru - f / df;
        }

        let scale = ru / rd;
        
        let r2 = ru * ru;
        let dx_tang = 2.0 * p1 * x_dist * y_dist + p2 * (r2 + 2.0 * x_dist * x_dist);
        let dy_tang = p1 * (r2 + 2.0 * y_dist * y_dist) + 2.0 * p2 * x_dist * y_dist;

        let ideal_x = cx + (x_dist * scale - dx_tang) * actual_r_ref;
        let ideal_y = cy + (y_dist * scale - dy_tang) * actual_r_ref;
        
        results.push(ideal_x);
        results.push(ideal_y);
    }

    results
}

pub mod solver_spherical;
pub mod solver_planar;
pub mod solver_ridge;
pub mod bright_star_atlas;

// wasm-bindgen will automatically export #[wasm_bindgen] functions from these modules
pub use crate::solver_spherical::solve_spherical_global;
pub use crate::solver_planar::solve_planar_local;
pub use crate::solver_ridge::solve_ridge_directed;
pub use crate::statistics::{estimate_background_wasm, calculate_stats_wasm};
pub use crate::sky_transform::{fit_wcs_bulk, wcs_pixels_to_sky_bulk, gnomonic_project_bulk};

// ═════════════════════════════════════════════════════════════════════════
// BAYER BINNING (RAW -> LUMA PROXY)
// ═════════════════════════════════════════════════════════════════════════

/// Perform 2x2 binning on Bayer raw data to create a high-SNR luminance proxy.
/// This bypasses demosaicing for star detection.
#[wasm_bindgen]
pub fn bin_bayer_to_luma(
    ptr: *const u16,
    width: u32,
    height: u32,
    stride: u32,
    black_level: u16,
    white_level: u16,
) -> *const f32 {
    let w = (width / 2) as usize;
    let h = (height / 2) as usize;
    let s = stride as usize;
    let output_len = w * h;
    let raw = unsafe { std::slice::from_raw_parts(ptr, (height * stride) as usize) };
    let range = (white_level as f32) - (black_level as f32);
    let inv_range = if range > 0.0 { 1.0 / (range * 4.0) } else { 0.0 };

    CFA_OUTPUT_BUFFER.with(|buf| {
        let mut output = buf.borrow_mut();
        if output.len() < output_len {
            output.resize(output_len, 0.0);
        }

        for y in 0..h {
            for x in 0..w {
                let r_idx = y * 2 * s + x * 2;
                // Sum 2x2 block: [R1, G1, G2, B1]
                let val = (raw[r_idx] as f32 + 
                           raw[r_idx + 1] as f32 + 
                           raw[r_idx + s] as f32 + 
                           raw[r_idx + s + 1] as f32) - (black_level as f32 * 4.0);
                
                output[y * w + x] = (val * inv_range).clamp(0.0, 1.0);
            }
        }
        output.as_ptr()
    })
}


// NOTE: solve_plate_wasm is replaced by solve_planar_local.
// The TypeScript dispatcher will handle the migration.
