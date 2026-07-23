// ==============================================================================
// SKYCRUNCHER - UNIFIED CALIBRATION KERNEL (WGSL)
// ==============================================================================
// Epistemic Hygiene: High Confidence (Fact) - Geometric & Photometric Correction
// Implements "Step 7: WebGPU Global Execution" from the Zonal Spec.
// ==============================================================================

@group(0) @binding(0) var<storage, read> raw_data: array<f32>;
@group(0) @binding(1) var<storage, read_write> calibrated_out: array<vec4<f32>>;

// Solved coefficients from Rust solvers
struct CalibrationCoeffs {
    width: u32,
    height: u32,
    zp: f32,
    num_tps_anchors: u32,
    
    // TPS Control Points & Weights (Max 64 anchors for aggressive pruning)
    tps_anchors_x: array<f32, 64>,
    tps_anchors_y: array<f32, 64>,
    tps_weights_x: array<f32, 64>,
    tps_weights_y: array<f32, 64>,
    tps_affine_x: vec3<f32>,
    tps_affine_y: vec3<f32>,
    
    // Skyglow Model (4x4 grid of knots)
    skyglow_knots: array<f32, 16>,
}
@group(1) @binding(0) var<storage, read> coeffs: CalibrationCoeffs;

// ------------------------------------------------------------------------------
// GEOMETRIC FLATTENING (Thin Plate Spline)
// ------------------------------------------------------------------------------
fn u_tps(r: f32) -> f32 {
    if (r == 0.0) { return 0.0; }
    return r * r * log(r);
}

fn evaluate_tps(x: f32, y: f32, is_x_axis: bool) -> f32 {
    if (coeffs.num_tps_anchors == 0u) {
        return 0.0; // No displacement
    }

    var displacement: f32 = 0.0;
    
    if (is_x_axis) {
        // Affine base
        displacement = coeffs.tps_affine_x.x + coeffs.tps_affine_x.y * x + coeffs.tps_affine_x.z * y - x;
        for (var i = 0u; i < coeffs.num_tps_anchors; i++) {
            let dx = x - coeffs.tps_anchors_x[i];
            let dy = y - coeffs.tps_anchors_y[i];
            let r = sqrt(dx * dx + dy * dy);
            displacement += coeffs.tps_weights_x[i] * u_tps(r);
        }
    } else {
        // Affine base
        displacement = coeffs.tps_affine_y.x + coeffs.tps_affine_y.y * x + coeffs.tps_affine_y.z * y - y;
        for (var i = 0u; i < coeffs.num_tps_anchors; i++) {
            let dx = x - coeffs.tps_anchors_x[i];
            let dy = y - coeffs.tps_anchors_y[i];
            let r = sqrt(dx * dx + dy * dy);
            displacement += coeffs.tps_weights_y[i] * u_tps(r);
        }
    }

    return displacement;
}

// ------------------------------------------------------------------------------
// BILINEAR SAMPLING
// ------------------------------------------------------------------------------
fn sample_bilinear(x: f32, y: f32) -> vec3<f32> {
    let tx = clamp(x, 0.0, f32(coeffs.width) - 1.0);
    let ty = clamp(y, 0.0, f32(coeffs.height) - 1.0);

    let x0 = u32(floor(tx));
    let y0 = u32(floor(ty));
    let x1 = min(x0 + 1u, coeffs.width - 1u);
    let y1 = min(y0 + 1u, coeffs.height - 1u);

    let fx = tx - f32(x0);
    let fy = ty - f32(y0);

    let idx00 = (y0 * coeffs.width + x0) * 3u;
    let idx10 = (y0 * coeffs.width + x1) * 3u;
    let idx01 = (y1 * coeffs.width + x0) * 3u;
    let idx11 = (y1 * coeffs.width + x1) * 3u;

    let c00 = vec3<f32>(raw_data[idx00], raw_data[idx00+1u], raw_data[idx00+2u]);
    let c10 = vec3<f32>(raw_data[idx10], raw_data[idx10+1u], raw_data[idx10+2u]);
    let c01 = vec3<f32>(raw_data[idx01], raw_data[idx01+1u], raw_data[idx01+2u]);
    let c11 = vec3<f32>(raw_data[idx11], raw_data[idx11+1u], raw_data[idx11+2u]);

    let top = mix(c00, c10, fx);
    let bot = mix(c01, c11, fx);
    
    return mix(top, bot, fy);
}

// ------------------------------------------------------------------------------
// ADDITIVE CORRECTION (CUBIC B-SPLINE)
// ------------------------------------------------------------------------------
fn cubic_basis(t: f32) -> f32 {
    let abs_t = abs(t);
    if (abs_t < 1.0) {
        return 0.5 * abs_t * abs_t * abs_t - abs_t * abs_t + (2.0 / 3.0);
    } else if (abs_t < 2.0) {
        let tz = 2.0 - abs_t;
        return (1.0 / 6.0) * tz * tz * tz;
    }
    return 0.0;
}

fn evaluate_bspline(x: f32, y: f32) -> f32 {
    let grid_w = 4u;
    let grid_h = 4u;
    
    let bin_w = f32(coeffs.width) / f32(grid_w - 1u);
    let bin_h = f32(coeffs.height) / f32(grid_h - 1u);

    let u_coord = x / bin_w;
    let v_coord = y / bin_h;

    let u0 = i32(floor(u_coord));
    let v0 = i32(floor(v_coord));

    let fu = u_coord - f32(u0);
    let fv = v_coord - f32(v0);

    var value: f32 = 0.0;

    for (var j: i32 = -1; j <= 2; j++) {
        let row = v0 + j;
        let clamped_row = min(max(row, 0), i32(grid_h) - 1);
        let basis_v = cubic_basis(fv - f32(j));

        for (var i: i32 = -1; i <= 2; i++) {
            let col = u0 + i;
            let clamped_col = min(max(col, 0), i32(grid_w) - 1);
            let basis_u = cubic_basis(fu - f32(i));

            let idx = u32(clamped_row) * grid_w + u32(clamped_col);
            value += coeffs.skyglow_knots[idx] * basis_u * basis_v;
        }
    }

    return value;
}

// ------------------------------------------------------------------------------
// MULTIPLICATIVE CORRECTION (EXTINCTION)
// ------------------------------------------------------------------------------
fn calculate_extinction_gain(x: f32, y: f32) -> f32 {
    // Air mass and extinction models (based on Digital Elevation Model mapping)
    // For now, this acts as a placeholder gradient or flat 1.0.
    // In Phase 3, this will map to proper altitude vectors for the pixel.
    return 1.0; 
}

// ------------------------------------------------------------------------------
// GLOBAL KERNEL EXECUTION
// ------------------------------------------------------------------------------
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let x = f32(id.x);
    let y = f32(id.y);
    let width = coeffs.width;
    
    if (id.x >= width || id.y >= coeffs.height) {
        return;
    }

    let idx = id.y * width + id.x;

    // 1. Geometric Flattening (TPS)
    // Resolve "Where the photon actually hit the sensor"
    let dx = evaluate_tps(x, y, true);
    let dy = evaluate_tps(x, y, false);
    let source_pixel = sample_bilinear(x + dx, y + dy);

    // 2. Additive Correction (Skyglow / Zodiacal)
    // Remove background energy
    let skyglow = evaluate_bspline(x, y);
    let signal_only = max(vec3<f32>(0.0), source_pixel - skyglow);

    // 3. Multiplicative Correction (Atmospheric Extinction)
    // Normalize transmission based on Altitude h solved by Virtual Sextant
    let extinction = calculate_extinction_gain(x, y); 
    
    // Zp factor turns it into calibrated instrumental flux
    let final_energy = signal_only * extinction * coeffs.zp;

    // Write Out to Calibrated VRAM (vec4<f32> for compositing or processing)
    calibrated_out[idx] = vec4<f32>(final_energy.rgb, 1.0);
}
