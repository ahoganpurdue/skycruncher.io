use wasm_bindgen::prelude::*;
use std::f64::consts::PI;

pub const ARCSEC_PER_RAD: f64 = 206264.80624709636;
pub const DEG2RAD: f64 = PI / 180.0;
pub const RAD2DEG: f64 = 180.0 / PI;

/// Calculate internal angular separation between two points on the sphere.
/// Uses the Haversine formula for stability with small distances.
#[wasm_bindgen]
pub fn calculate_angular_separation(ra1_rad: f64, dec1_rad: f64, ra2_rad: f64, dec2_rad: f64) -> f64 {
    let dlon = ra2_rad - ra1_rad;
    let dlat = dec2_rad - dec1_rad;
    
    let a = (dlat / 2.0).sin().powi(2) + dec1_rad.cos() * dec2_rad.cos() * (dlon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin(); // Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) -> 2 * asin
    
    c
}

/// Standard Gnomonic (TAN) projection: Sky -> Tangent Plane (Radians)
#[wasm_bindgen]
pub fn gnomonic_project(
    ra_rad: f64, dec_rad: f64,
    ra0_rad: f64, dec0_rad: f64
) -> Vec<f64> {
    let cos_dec = dec_rad.cos();
    let sin_dec = dec_rad.sin();
    let cos_dec0 = dec0_rad.cos();
    let sin_dec0 = dec0_rad.sin();
    let cos_d_ra = (ra_rad - ra0_rad).cos();

    let denom = sin_dec0 * sin_dec + cos_dec0 * cos_dec * cos_d_ra;
    
    // Behind the tangent point horizon
    if denom < 0.001 {
        return vec![f64::NAN, f64::NAN];
    }

    let xi = (cos_dec * (ra_rad - ra0_rad).sin()) / denom;
    let eta = (cos_dec0 * sin_dec - sin_dec0 * cos_dec * cos_d_ra) / denom;

    vec![xi, eta]
}

/// Inverse Gnomonic: Tangent Plane -> Sky (Radians)
#[wasm_bindgen]
pub fn inverse_gnomonic(
    xi_rad: f64, eta_rad: f64,
    ra0_rad: f64, dec0_rad: f64
) -> Vec<f64> {
    let rho = (xi_rad * xi_rad + eta_rad * eta_rad).sqrt();
    
    if rho < 1e-12 {
        return vec![ra0_rad, dec0_rad];
    }

    let c = rho.atan();
    let sin_c = c.sin();
    let cos_c = c.cos();
    let sin_dec0 = dec0_rad.sin();
    let cos_dec0 = dec0_rad.cos();

    let dec = (cos_c * sin_dec0 + (eta_rad * sin_c * cos_dec0) / rho).asin();
    let ra = ra0_rad + (xi_rad * sin_c).atan2(rho * cos_dec0 * cos_c - eta_rad * sin_dec0 * sin_c);

    vec![ra, dec]
}

/// Apply a WCS transform: pixel -> sky coordinates in bulk.
/// Input: Flat array of [x0, y0, x1, y1...]
/// Output: Flat array of [ra0, dec0, ra1, dec1...] (in Radians)
#[wasm_bindgen]
pub fn wcs_pixels_to_sky_bulk(
    xy_coords: &[f64],
    crpix_x: f64, crpix_y: f64,
    crval_ra: f64, crval_dec: f64, // In Radians
    cd11: f64, cd12: f64,
    cd21: f64, cd22: f64
) -> Vec<f64> {
    let num_points = xy_coords.len() / 2;
    let mut results = Vec::with_capacity(num_points * 2);

    for i in 0..num_points {
        let x = xy_coords[i * 2];
        let y = xy_coords[i * 2 + 1];

        let dx = x - crpix_x;
        let dy = y - crpix_y;
        
        // Linear transform (Pixels -> Tangent Plane in Radians)
        // Note: CD values should be in Radians/Pixel
        let xi = cd11 * dx + cd12 * dy;
        let eta = cd21 * dx + cd22 * dy;
        
        let sky = inverse_gnomonic(xi, eta, crval_ra, crval_dec);
        results.push(sky[0]);
        results.push(sky[1]);
    }

    results
}

/// Bulk Gnomonic projection: Sky -> Tangent Plane Coordinates
/// Input: Flat array of [ra0, dec0, ra1, dec1...] (in Radians)
/// Output: Flat array of [xi0, eta0, xi1, eta1...] (in Radians)
#[wasm_bindgen]
pub fn gnomonic_project_bulk(
    radec_coords: &[f64],
    ra0_rad: f64, dec0_rad: f64
) -> Vec<f64> {
    let num_points = radec_coords.len() / 2;
    let mut results = Vec::with_capacity(num_points * 2);

    for i in 0..num_points {
        let ra = radec_coords[i * 2];
        let dec = radec_coords[i * 2 + 1];

        let proj = gnomonic_project(ra, dec, ra0_rad, dec0_rad);
        results.push(proj[0]);
        results.push(proj[1]);
    }

    results
}

#[wasm_bindgen]
pub fn calculate_cd_matrix(scale_arcsec: f64, rotation_deg: f64, parity: f64) -> Vec<f64> {
    let scale_rad = (scale_arcsec / 3600.0) * DEG2RAD;
    let rot_rad = rotation_deg * DEG2RAD;
    let cos_r = rot_rad.cos();
    let sin_r = rot_rad.sin();

    // CD1_1 = s * cos(rot)
    // CD1_2 = -s * sin(rot)
    // CD2_1 = -s * sin(rot) * parity
    // CD2_2 = -s * cos(rot) * parity
    vec![
        scale_rad * cos_r, -scale_rad * sin_r,
        -scale_rad * sin_r * parity, -scale_rad * cos_r * parity
    ]
}

#[wasm_bindgen]
pub fn pixel_scale_from_cd(cd11: f64, cd12: f64, cd21: f64, cd22: f64) -> f64 {
    // scale from radians/pixel to arcsec/pixel
    let scale1 = (cd11.powi(2) + cd21.powi(2)).sqrt() * RAD2DEG * 3600.0;
    let scale2 = (cd12.powi(2) + cd22.powi(2)).sqrt() * RAD2DEG * 3600.0;
    (scale1 + scale2) / 2.0
}

#[wasm_bindgen]
pub fn rotation_from_cd(cd11: f64, cd12: f64) -> f64 {
    cd12.atan2(cd11) * RAD2DEG
}
#[wasm_bindgen]
pub fn fit_wcs_bulk(
    pixel_x: &[f64],
    pixel_y: &[f64],
    sky_xi: &[f64],
    sky_eta: &[f64],
    crpix_x: f64,
    crpix_y: f64,
) -> Vec<f64> {
    let n = pixel_x.len();
    if n < 3 {
        return vec![];
    }

    let mut sum_dx2 = 0.0;
    let mut sum_dy2 = 0.0;
    let mut sum_dxdy = 0.0;
    let mut sum_dx_xi = 0.0;
    let mut sum_dy_xi = 0.0;
    let mut sum_dx_eta = 0.0;
    let mut sum_dy_eta = 0.0;

    for i in 0..n {
        let dx = pixel_x[i] - crpix_x;
        let dy = pixel_y[i] - crpix_y;
        sum_dx2 += dx * dx;
        sum_dy2 += dy * dy;
        sum_dxdy += dx * dy;
        sum_dx_xi += dx * sky_xi[i];
        sum_dy_xi += dy * sky_xi[i];
        sum_dx_eta += dx * sky_eta[i];
        sum_dy_eta += dy * sky_eta[i];
    }

    let det = sum_dx2 * sum_dy2 - sum_dxdy * sum_dxdy;
    if det.abs() < 1e-20 {
        return vec![];
    }

    let cd11 = (sum_dy2 * sum_dx_xi - sum_dxdy * sum_dy_xi) / det;
    let cd12 = (sum_dx2 * sum_dy_xi - sum_dxdy * sum_dx_xi) / det;
    let cd21 = (sum_dy2 * sum_dx_eta - sum_dxdy * sum_dy_eta) / det;
    let cd22 = (sum_dx2 * sum_dy_eta - sum_dxdy * sum_dx_eta) / det;

    vec![cd11, cd12, cd21, cd22]
}
