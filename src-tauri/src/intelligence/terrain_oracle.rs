/// Native ONNX inference for boundary detection (sky/ground segmentation).
///
/// Replaces the browser-side `ort.Tensor.fromGpuBuffer()` pattern.
/// Uses the `ort` Rust crate with DirectML execution provider to leverage
/// the RTX 3060's Tensor cores for AI segmentation without crossing
/// the JSâ†”Rust boundary with image data.
///
/// [Module: M5] [Domain: SegmentationState] UNDETECTED -> AI_BOUNDARY_DETECTED
/// [Module: M5] [Domain: MemoryResidency] NATIVE_GPU_VRAM -> NATIVE_GPU_VRAM

use std::path::Path;

/// Native boundary detector using ONNX Runtime + DirectML.
///
/// Wraps a MobileSAM or similar lightweight segmentation model loaded
/// from the app's resource directory.
pub struct BoundaryDetector {
    session: ort::Session,
}

impl BoundaryDetector {
    /// Load an ONNX segmentation model from the given path.
    ///
    /// Uses the DirectML execution provider on Windows to leverage GPU
    /// acceleration (Tensor cores on NVIDIA RTX, shader cores on AMD).
    /// Falls back to CPU if DirectML is unavailable.
    pub fn init(model_path: &Path) -> Result<Self, String> {
        let session = ort::Session::builder()
            .map_err(|e| format!("[M5] Failed to create ONNX session builder: {}", e))?
            .with_execution_providers([
                ort::DirectMLExecutionProvider::default().build(),
            ])
            .map_err(|e| format!("[M5] Failed to configure DirectML provider: {}", e))?
            .commit_from_file(model_path)
            .map_err(|e| format!("[M5] Failed to load ONNX model from {:?}: {}", model_path, e))?;

        log::info!("[M5] BoundaryDetector initialized from {:?}", model_path);
        Ok(Self { session })
    }

    /// Run boundary segmentation on a luminance buffer.
    ///
    /// Input:  Downsampled luminance (f32, 0.0-1.0), shape [1, 1, height, width]
    /// Output: Binary mask (u8, 0 or 255) indicating sky vs ground.
    ///
    /// The model expects a normalized single-channel image resized to its
    /// input dimensions (typically 256Ã—256 or 512Ã—512). The output is
    /// upscaled back to the original dimensions by the caller.
    pub fn detect(
        &self,
        luminance: &[f32],
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, String> {
        let expected_len = (width as usize) * (height as usize);
        if luminance.len() != expected_len {
            return Err(format!(
                "[M5] Luminance buffer size mismatch: expected {}, got {}",
                expected_len,
                luminance.len()
            ));
        }

        // Build the input tensor [batch=1, channels=1, height, width]
        let input_shape = [1_i64, 1, height as i64, width as i64];
        let input_tensor = ort::Value::from_array(
            ndarray::ArrayView::from_shape(
                (1, 1, height as usize, width as usize),
                luminance,
            ).map_err(|e| format!("[M5] Failed to create ndarray view: {}", e))?,
        ).map_err(|e| format!("[M5] Failed to create input tensor: {}", e))?;

        // Run inference
        let outputs = self.session
            .run(ort::inputs!["input" => input_tensor].map_err(|e| format!("[M5] Failed to create inputs: {}", e))?)
            .map_err(|e| format!("[M5] Inference failed: {}", e))?;

        // Extract the output mask
        let output = outputs.get("output")
            .ok_or("[M5] Model output 'output' not found")?;

        let output_array = output.try_extract_tensor::<f32>()
            .map_err(|e| format!("[M5] Failed to extract output tensor: {}", e))?;

        // Threshold the probability map to a binary mask
        let mask: Vec<u8> = output_array.iter()
            .map(|&v| if v > 0.5 { 255u8 } else { 0u8 })
            .collect();

        log::info!(
            "[M5] Boundary detection complete: {}Ã—{}, {} sky pixels",
            width, height, mask.iter().filter(|&&v| v == 255).count()
        );

        Ok(mask)
    }
}
