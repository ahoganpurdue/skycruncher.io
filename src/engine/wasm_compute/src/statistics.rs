use wasm_bindgen::prelude::*;

// BackgroundStats removed in favor of Vec<f32> for FFI stability

/// Estimate the image background level and noise (sigma) using
/// iterative sigma-clipping.
/// 
/// # Arguments
/// * `data` - Flat array of luminance values
/// * `iterations` - Number of clipping passes (default: 3)
/// * `sigma_clip` - Clipping threshold in standard deviations (default: 3.0)
#[wasm_bindgen]
pub fn estimate_background_wasm(
    data: &[f32],
    iterations: u32,
    sigma_clip: f32,
) -> Vec<f32> {
    if data.is_empty() {
        return vec![0.0, 0.0];
    }

    // Step-sample the data for speed (1/16th of pixels)
    let step = 4;
    let mut samples: Vec<f32> = data.iter()
        .step_by(step)
        .cloned()
        .collect();

    let mut median = 0.0;
    let mut std = 0.0;

    for _ in 0..iterations {
        if samples.is_empty() { break; }
        
        // Sort for median
        // Note: f32 doesn't implement Ord, so we use partial_cmp
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        
        median = samples[samples.len() / 2];
        
        let mut sum_sq = 0.0;
        for &v in &samples {
            sum_sq += (v - median).powi(2);
        }
        std = (sum_sq / samples.len() as f32).sqrt();

        // Clip
        let lower = median - sigma_clip * std;
        let upper = median + sigma_clip * std;
        
        let next_samples: Vec<f32> = samples.iter()
            .cloned()
            .filter(|&v| v >= lower && v <= upper)
            .collect();
            
        if next_samples.len() == samples.len() { break; }
        samples = next_samples;
    }

    vec![median, std]
}

/// Calculate basic statistics for a Float32Array efficiently.
#[wasm_bindgen]
pub struct BasicStats {
    pub min: f32,
    pub max: f32,
    pub mean: f32,
    pub median: f32,
    pub std_dev: f32,
}

#[wasm_bindgen]
pub fn calculate_stats_wasm(data: &[f32]) -> BasicStats {
    if data.is_empty() {
        return BasicStats { min: 0.0, max: 0.0, mean: 0.0, median: 0.0, std_dev: 0.0 };
    }

    let mut min = f32::MAX;
    let mut max = f32::MIN;
    let mut sum = 0.0;
    let mut sum_sq = 0.0;

    for &v in data {
        if v < min { min = v; }
        if v > max { max = v; }
        sum += v;
        sum_sq += v * v;
    }

    let len = data.len() as f32;
    let mean = sum / len;
    let variance = (sum_sq / len) - (mean * mean);
    let std_dev = variance.max(0.0).sqrt();

    // Median requires sort - we do this on a copy
    let mut sorted = data.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted[sorted.len() / 2];

    BasicStats {
        min,
        max,
        mean,
        median,
        std_dev,
    }
}
