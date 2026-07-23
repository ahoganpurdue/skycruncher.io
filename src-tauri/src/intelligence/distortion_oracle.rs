use std::path::Path;
use ort::{Session, Value};
use ndarray::Array4;

/// Native Macro-Distortion Oracle using ONNX Runtime + DirectML.
///
/// This oracle proposes initial Brown-Conrady coefficients (k1, k2) based
/// on the geometric "stretch" vectors of bright light sources. This acts 
/// as a high-speed "Proposer" for the deterministic metrology engine.
///
/// [Module: M7] [Domain: DistortionCorrection] UNDETECTED -> PROPOSED_K1_K2
pub struct DistortionOracle {
    session: Session,
}

impl DistortionOracle {
    /// Load the lightweight Distortion Oracle ONNX model from the given path.
    pub fn init(model_path: &Path) -> Result<Self, String> {
        let session = Session::builder()
            .map_err(|e| format!("[M7] Failed to create ONNX session builder: {}", e))?
            .with_execution_providers([
                ort::DirectMLExecutionProvider::default().build(),
            ])
            .map_err(|e| format!("[M7] Failed to configure DirectML: {}", e))?
            .commit_from_file(model_path)
            .map_err(|e| format!("[M7] Failed to load distortion model from {:?}: {}", model_path, e))?;
        
        log::info!("[M7] DistortionOracle initialized from {:?}", model_path);
        Ok(Self { session })
    }

    /// Propose Brown-Conrady k1, k2 coefficients.
    /// 
    /// Input:  Features extracted from bright light sources (centroids, offsets, intensities).
    /// Output: (k1, k2) proposed coefficients.
    ///
    /// The deterministic engine applies these to a subset of centroids. If the
    /// residual RMS error is < 1.0px, the expensive Levenberg-Marquardt loop is skipped.
    pub fn propose_coefficients(&self, features: &[f32], feature_count: usize) -> Result<(f32, f32), String> {
        // Build the input tensor [batch=1, channels=1, height=1, width=feature_count]
        let input_tensor = Array4::from_shape_vec((1, 1, 1, feature_count), features.to_vec())
            .map_err(|e| format!("[M7] Failed to create input tensor shape: {}", e))?;

        let input_values = [Value::from_array(input_tensor).map_err(|e| e.to_string())?];
        
        let results = self.session.run(input_values)
            .map_err(|e| format!("[M7] Distortion Oracle inference failed: {}", e))?;

        // Extract (k1, k2) from the first output
        let output = results[0].try_extract_tensor::<f32>()
            .map_err(|e| format!("[M7] Failed to extract output: {}", e))?;

        if output.len() < 2 {
            return Err("[M7] Distortion model returned insufficient data".into());
        }

        Ok((output[0], output[1]))
    }
}
