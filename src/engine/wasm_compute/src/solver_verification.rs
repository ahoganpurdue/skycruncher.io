use wasm_bindgen::prelude::*;


#[wasm_bindgen]
pub fn verify_astrometric_lock(
    det_x: &[f64],
    det_y: &[f64],
    cat_ra: &[f64],
    cat_dec: &[f64],
    wcs_cd: &[f64],
    wcs_crval: &[f64],
    wcs_crpix: &[f64],
    verify_radius_deg: f64,
) -> Vec<f64> {
    let mut matches_list = Vec::new();
    let mut total_residual_px = 0.0;
    
    let cd11 = wcs_cd[0];
    let cd12 = wcs_cd[1];
    let cd21 = wcs_cd[2];
    let cd22 = wcs_cd[3];
    
    let crval_ra = wcs_crval[0];
    let crval_dec = wcs_crval[1];
    
    let crpix_x = wcs_crpix[0];
    let crpix_y = wcs_crpix[1];

    let n_det = det_x.len();
    let n_cat = cat_ra.len();

    for i in 0..n_det {
        let dx = det_x[i];
        let dy = det_y[i];

        let dx_rel = dx - crpix_x;
        let dy_rel = dy - crpix_y;

        // Tangent-plane offsets from the CD matrix are DEGREES.
        // UNITS FIX: crval_ra and cat_ra are in HOURS (the TS contract) —
        // the old code added degree offsets directly onto the hours value
        // (RA axis stretched 15x), so true matches fell outside the radius
        // and ~half the detections paired with random neighbours instead.
        // Every historical "[VERIFIED] N stars" at a wrong scale came from
        // this. Convert explicitly: hours -> degrees for the comparison.
        let xi_deg = cd11 * dx_rel + cd12 * dy_rel;
        let eta_deg = cd21 * dx_rel + cd22 * dy_rel;

        let dec_rad = crval_dec.to_radians();
        let cos_dec = dec_rad.cos();

        let ra_deg = crval_ra * 15.0 + xi_deg / cos_dec.max(0.01);
        let dec_deg = crval_dec + eta_deg;

        let mut best_dist_deg_sq = verify_radius_deg * verify_radius_deg;
        let mut best_cat_idx = 0;
        let mut found = false;

        for j in 0..n_cat {
            let dra = (ra_deg - cat_ra[j] * 15.0) * cos_dec;
            let ddec = dec_deg - cat_dec[j];
            let dist_sq = dra * dra + ddec * ddec;

            if dist_sq < best_dist_deg_sq {
                best_dist_deg_sq = dist_sq;
                best_cat_idx = j;
                found = true;
            }
        }

        if found {
            let det_cd = (cd11 * cd22 - cd12 * cd21).abs();
            let deg_per_px = det_cd.sqrt();
            let residual_px = best_dist_deg_sq.sqrt() / deg_per_px.max(1e-9);
            
            total_residual_px += residual_px;
            matches_list.push((i, best_cat_idx, residual_px * (deg_per_px * 3600.0))); // residual in arcsec
        }
    }

    let matches_count = matches_list.len();
    let confidence = if n_det > 0 { matches_count as f64 / n_det as f64 } else { 0.0 };
    let avg_residual_arcsec = if matches_count > 0 { (total_residual_px / matches_count as f64) * ( (cd11*cd22 - cd12*cd21).abs().sqrt() * 3600.0 ) } else { 0.0 };
    
    let mut results = Vec::new();
    results.push(if matches_count >= 4 && confidence > 0.4 { 1.0 } else { 0.0 });
    results.push(confidence);
    results.push(matches_count as f64);
    results.push(avg_residual_arcsec);
    
    for (d_idx, c_idx, res) in matches_list {
        results.push(d_idx as f64);
        results.push(c_idx as f64);
        results.push(res);
    }
    
    results
}

#[wasm_bindgen]
pub fn generate_geometric_quads(
    stars_x: &[f64],
    stars_y: &[f64],
    max_stars: usize,
) -> Vec<f64> {
    let mut results = Vec::new();
    let n = stars_x.len().min(stars_y.len()).min(max_stars);
    if n < 4 { return results; }

    for i in 0..n - 3 {
        for j in i + 1..n - 2 {
            for k in j + 1..n - 1 {
                for l in k + 1..n {
                    if let Some(quad) = build_quad_descriptor(stars_x, stars_y, i, j, k, l) {
                        results.push(quad.0[0] as f64);
                        results.push(quad.0[1] as f64);
                        results.push(quad.0[2] as f64);
                        results.push(quad.0[3] as f64);
                        results.push(quad.1[0]);
                        results.push(quad.1[1]);
                        results.push(quad.1[2]);
                        results.push(quad.1[3]);
                    }
                }
            }
        }
    }
    results
}

fn build_quad_descriptor(
    stars_x: &[f64],
    stars_y: &[f64],
    i: usize, j: usize, k: usize, l: usize
) -> Option<([usize; 4], [f64; 4])> {
    let indices = [i, j, k, l];
    let px = [stars_x[i], stars_x[j], stars_x[k], stars_x[l]];
    let py = [stars_y[i], stars_y[j], stars_y[k], stars_y[l]];

    let mut max_d2 = -1.0;
    let mut ai = 0;
    let mut bi = 1;

    for m in 0..4 {
        for n in m + 1..4 {
            let dx = px[m] - px[n];
            let dy = py[m] - py[n];
            let d2 = dx * dx + dy * dy;
            if d2 > max_d2 {
                max_d2 = d2;
                ai = m;
                bi = n;
            }
        }
    }

    let mut idx_a = ai;
    let mut idx_b = bi;
    let mut others = Vec::new();
    for m in 0..4 {
        if m != ai && m != bi { others.push(m); }
    }
    let mut idx_c = others[0];
    let mut idx_d = others[1];

    let ax = px[idx_a]; let ay = py[idx_a];
    let bx = px[idx_b]; let by = py[idx_b];
    let cx = px[idx_c]; let cy = py[idx_c];
    let dx = px[idx_d]; let dy = py[idx_d];

    let ux = bx - ax;
    let uy = by - ay;
    let det = ux * ux + uy * uy;
    if det < 1e-9 { return None; }

    let transform = |x: f64, y: f64| -> (f64, f64) {
        let rdx = x - ax;
        let rdy = y - ay;
        ((rdx * ux + rdy * uy) / det, (-rdx * uy + rdy * ux) / det)
    };

    let (mut tcx, mut tcy) = transform(cx, cy);
    let (mut tdx, mut tdy) = transform(dx, dy);

    if tcx + tdx > 1.0 {
        tcx = 1.0 - tcx; tcy = -tcy;
        tdx = 1.0 - tdx; tdy = -tdy;
        let temp = idx_a; idx_a = idx_b; idx_b = temp;
    }

    if tcx > tdx || (tcx == tdx && tcy > tdy) {
        let temp_x = tcx; tcx = tdx; tdx = temp_x;
        let temp_y = tcy; tcy = tdy; tdy = temp_y;
        let temp = idx_c; idx_c = idx_d; idx_d = temp;
    }

    Some(([indices[idx_a], indices[idx_b], indices[idx_c], indices[idx_d]], [tcx, tcy, tdx, tdy]))
}
