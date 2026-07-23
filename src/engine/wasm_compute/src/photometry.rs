use nalgebra::{Matrix6, Vector6, SVector, DMatrix, DVector};

const MAX_ITER: usize = 20;
const LAMBDA_INIT: f64 = 0.01;
const tolerance: f64 = 1e-4;

/// Fits a 2D Gaussian to the given pixel stamp using Levenberg-Marquardt.
/// Given: [A, cx, cy, sx, sy, theta]
pub fn fit_gaussian_2d(
    pixels: &[f32],
    w: u32,
    h: u32,
    offset_x: u32,
    offset_y: u32,
    mut params: SVector<f64, 6>, // [A, cx, cy, sx, sy, theta]
) -> SVector<f64, 6> {
    let mut lambda = LAMBDA_INIT;
    
    for _iter in 0..MAX_ITER {
        let mut j_t_j = Matrix6::zeros();
        let mut j_t_dy = Vector6::zeros();
        let mut error_sum = 0.0;
        
        // Extract parameters
        let amp = params[0];
        let cx = params[1];
        let cy = params[2];
        let sx = params[3].max(0.1); // prevent div by zero
        let sy = params[4].max(0.1);
        let theta = params[5];

        let cos_t = theta.cos();
        let sin_t = theta.sin();
        let cos2 = cos_t * cos_t;
        let sin2 = sin_t * sin_t;
        let sint_cost = sin_t * cos_t;

        // Gaussian coefficients
        let a_coeff = cos2 / (2.0 * sx * sx) + sin2 / (2.0 * sy * sy);
        let b_coeff = -sint_cost / (sx * sx) + sint_cost / (sy * sy);
        let c_coeff = sin2 / (2.0 * sx * sx) + cos2 / (2.0 * sy * sy);

        let mut num_points = 0.0;

        for ly in 0..h {
            for lx in 0..w {
                let px = (offset_x + lx) as f64;
                let py = (offset_y + ly) as f64;
                
                let dx = px - cx;
                let dy = py - cy;
                
                let exponent = a_coeff * dx * dx + b_coeff * dx * dy + c_coeff * dy * dy;
                // Exponent cutoff
                if exponent > 9.0 { continue; } // exp(-9) is very small
                
                let exp_val = (-exponent).exp();
                let f_val = amp * exp_val;
                
                let obs = pixels[(ly * w + lx) as usize] as f64;
                let residual = obs - f_val;
                error_sum += residual * residual;
                num_points += 1.0;

                // Derivatives
                // dF/da = exp_val
                let df_da = exp_val;
                
                // dF/dcx, dF/dcy via chain rule
                // dF/dx = F * d(-exponent)/dx = F * (-2*a_coeff*dx - b_coeff*dy) => dF/dcx = -dF/dx
                let d_exp_dx = 2.0 * a_coeff * dx + b_coeff * dy;
                let d_exp_dy = 2.0 * c_coeff * dy + b_coeff * dx;
                
                let df_dcx = f_val * d_exp_dx;
                let df_dcy = f_val * d_exp_dy;
                
                // Simplified derivatives for shape (we can approximate sx, sy, theta updates or use finite diffs)
                // For performance, we'll use exact partials if we can, but since this is heavy, 
                // we'll use analytical for A, cx, cy and leave shape fixed if LM diverges early, 
                // but let's just do full analytical.
                
                let da_dsx = -cos2 / (sx * sx * sx);
                let db_dsx = 2.0 * sint_cost / (sx * sx * sx);
                let dc_dsx = -sin2 / (sx * sx * sx);
                
                let d_exp_dsx = da_dsx * dx * dx + db_dsx * dx * dy + dc_dsx * dy * dy;
                let df_dsx = f_val * (-d_exp_dsx);

                let da_dsy = -sin2 / (sy * sy * sy);
                let db_dsy = -2.0 * sint_cost / (sy * sy * sy);
                let dc_dsy = -cos2 / (sy * sy * sy);
                
                let d_exp_dsy = da_dsy * dx * dx + db_dsy * dx * dy + dc_dsy * dy * dy;
                let df_dsy = f_val * (-d_exp_dsy);

                // Theta
                let dt_cos2 = -2.0 * sint_cost;
                let dt_sin2 = 2.0 * sint_cost;
                let dt_sint_cost = cos2 - sin2;
                
                let da_dt = dt_cos2 / (2.0 * sx * sx) + dt_sin2 / (2.0 * sy * sy);
                let db_dt = -dt_sint_cost / (sx * sx) + dt_sint_cost / (sy * sy);
                let dc_dt = dt_sin2 / (2.0 * sx * sx) + dt_cos2 / (2.0 * sy * sy);

                let d_exp_dt = da_dt * dx * dx + db_dt * dx * dy + dc_dt * dy * dy;
                let df_dt = f_val * (-d_exp_dt);

                let j = Vector6::new(df_da, df_dcx, df_dcy, df_dsx, df_dsy, df_dt);
                
                j_t_j += j * j.transpose();
                j_t_dy += j * residual;
            }
        }
        
        if num_points < 6.0 {
            break; // Not enough valid points
        }
        
        // LM Damping
        let mut j_t_j_damped = j_t_j;
        for i in 0..6 {
            j_t_j_damped[(i, i)] *= 1.0 + lambda;
        }
        
        // Solve (J^T J + lambda I) d = J^T R
        // Handle determinant zero
        if let Some(inv) = j_t_j_damped.try_inverse() {
            let delta = inv * j_t_dy;
            let mut new_params = params + delta;
            
            // Constrain
            new_params[0] = new_params[0].max(0.0); // positive amplitude
            new_params[3] = new_params[3].clamp(0.1, 20.0); // reasonable limits on sx
            new_params[4] = new_params[4].clamp(0.1, 20.0); // reasonable limits on sy
            
            // Check improvement
            // (Skipping rigorous chi-square check for raw performance; standard heuristic)
            if delta.norm() < tolerance {
                params = new_params;
                break;
            }
            // Simple update
            params = new_params;
            lambda *= 0.1;
        } else {
            // Ill-conditioned matrix, increase damping
            lambda *= 10.0;
        }
    }
    
    params
}

/// Perform bulk Levenberg-Marquardt refinement on a list of stars.
/// Instead of extracting stamps in JS, we pass the full luminance pointer.
/// params_inout: Flat array of [A, cx, cy, sx, sy, theta] per star.
/// Returns the updated params in-place.
pub fn refine_stars_bulk_impl(
    lum: &[f32],
    width: u32,
    height: u32,
    params_inout: &mut [f64],
    stamp_size: u32,
) {
    let n_stars = params_inout.len() / 6;
    let half_stamp = (stamp_size / 2) as i32;
    
    // We reuse a small buffer for the stamp pixels to avoid allocations
    let mut stamp_pixels = vec![0.0; (stamp_size * stamp_size) as usize];

    for i in 0..n_stars {
        let offset = i * 6;
        let cx_global = params_inout[offset + 1];
        let cy_global = params_inout[offset + 2];
        
        let cx_rounded = cx_global.round() as i32;
        let cy_rounded = cy_global.round() as i32;

        // Skip if too close to image boundary
        if cx_rounded < half_stamp || cx_rounded >= (width as i32) - half_stamp || 
           cy_rounded < half_stamp || cy_rounded >= (height as i32) - half_stamp {
            continue;
        }

        // 1. Extract the stamp into local buffer
        for dy in -half_stamp..=half_stamp {
            for dx in -half_stamp..=half_stamp {
                let gx = cx_rounded + dx;
                let gy = cy_rounded + dy;
                let stamp_idx = ((dy + half_stamp) * (stamp_size as i32) + (dx + half_stamp)) as usize;
                stamp_pixels[stamp_idx] = lum[(gy * (width as i32) + gx) as usize];
            }
        }

        // 2. Map global params to local stamp coordinates
        let local_cx = cx_global - (cx_rounded - half_stamp) as f64;
        let local_cy = cy_global - (cy_rounded - half_stamp) as f64;
        
        let mut p_vec = SVector::<f64, 6>::new(
            params_inout[offset],
            local_cx,
            local_cy,
            params_inout[offset + 3],
            params_inout[offset + 4],
            params_inout[offset + 5]
        );

        // 3. Fit
        let refined = fit_gaussian_2d(&stamp_pixels, stamp_size, stamp_size, 0, 0, p_vec);

        // 4. Map back to global coordinates
        params_inout[offset] = refined[0];
        params_inout[offset + 1] = refined[1] + (cx_rounded - half_stamp) as f64;
        params_inout[offset + 2] = refined[2] + (cy_rounded - half_stamp) as f64;
        params_inout[offset + 3] = refined[3];
        params_inout[offset + 4] = refined[4];
        params_inout[offset + 5] = refined[5];
    }
}

