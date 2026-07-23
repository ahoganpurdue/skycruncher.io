use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn solve_ridge_directed(
    det_x: &[f64], 
    det_y: &[f64],
    cat_xi_px: &[f64], 
    cat_eta_px: &[f64],
    anchor_x: f64, 
    anchor_y: f64,
    coarse_step: f64, 
    fine_range: f64, 
    fine_step: f64,
    match_radius_px: f64
) -> Vec<f64> {
    let mut results = Vec::new();
    let n_det = det_x.len();
    let n_cat = cat_xi_px.len();
    
    if n_det == 0 || n_cat == 0 { return results; }

    let mut best_consensus = 0;
    let mut best_rotation = 0.0;
    let mut best_parity = 1.0;

    let rad = coarse_step.to_radians();
    let match_radius_sq = match_radius_px * match_radius_px;

    // Coarse Search: 0 to 360 degrees
    for p in &[1.0, -1.0] {
        let parity = *p;
        let mut angle: f64 = 0.0;
        while angle < 360.0 {
            let rot_rad = angle.to_radians();
            let cos_r = rot_rad.cos();
            let sin_r = rot_rad.sin();

            let mut consensus = 0;
            for i in 0..n_cat {
                // Rotate and flip catalog point relative to anchor
                let rx = cat_xi_px[i] * cos_r - cat_eta_px[i] * sin_r * parity;
                let ry = cat_xi_px[i] * sin_r + cat_eta_px[i] * cos_r * parity;
                
                let tx = anchor_x + rx;
                let ty = anchor_y + ry;

                // Check for match in detections
                for j in 0..n_det {
                    let dx = det_x[j] - tx;
                    let dy = det_y[j] - ty;
                    if dx*dx + dy*dy < match_radius_sq {
                        consensus += 1;
                        break;
                    }
                }
            }

            if consensus > best_consensus {
                best_consensus = consensus;
                best_rotation = angle;
                best_parity = parity;
            }
            angle += coarse_step;
        }
    }

    // Fine Search around best coarse rotation
    let start_fine = best_rotation - fine_range;
    let end_fine = best_rotation + fine_range;
    let mut angle = start_fine;
    while angle <= end_fine {
        let rot_rad = angle.to_radians();
        let cos_r = rot_rad.cos();
        let sin_r = rot_rad.sin();

        let mut consensus = 0;
        for i in 0..n_cat {
            let rx = cat_xi_px[i] * cos_r - cat_eta_px[i] * sin_r * best_parity;
            let ry = cat_xi_px[i] * sin_r + cat_eta_px[i] * cos_r * best_parity;
            let tx = anchor_x + rx;
            let ty = anchor_y + ry;

            for j in 0..n_det {
                let dx = det_x[j] - tx;
                let dy = det_y[j] - ty;
                if dx*dx + dy*dy < match_radius_sq {
                    consensus += 1;
                    break;
                }
            }
        }

        if consensus > best_consensus {
            best_consensus = consensus;
            best_rotation = angle;
        }
        angle += fine_step;
    }

    results.push(best_rotation);
    results.push(best_parity);
    results.push(best_consensus as f64);

    results
}
