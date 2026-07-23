
/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * DYNAMIC PIPELINE CONFIGURATION
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Defines the structure for tunable pipeline parameters (sliders) and
 * maps them to the internal algorithmic constants.
 */

import { PIPELINE_CONSTANTS } from '../pipeline/constants/pipeline_config';

export interface DynamicPipelineConfig {
    // Stage 1: Signal
    signal_sigma_threshold: number;  // Default 3.0
    signal_fwhm_max: number;         // Default 180 (was 60)
    min_circularity: number;         // Default 0.6
    planetary_tolerance_px: number;  // Default 20
    
    // Stage 2: Solver
    solver_sigma: number;            // Default 3.0 -> 1.5 retry
    solver_blind_sigma: number;      // Default 2.5
    solver_quad_tolerance: number;   // Default 0.03 (Standard) -> 0.12 (Wide)
    solver_scale_variance: number;   // Default 0.05
    
    // Stage 3: Verification
    verification_color_strictness: number; // 0.0 - 1.0
    verification_strobe_rejection: boolean;

    // Stage 3b: WCS Verification tuning (optional — absent reproduces the
    // wide-field defaults hardcoded in verifyWCS: 5 matches @ 60%, cutoff 20)
    verify_min_anchor_matches?: number;   // Dense-field minimum anchor matches (default 5)
    verify_min_confidence?: number;       // Dense-field minimum anchor confidence (default 0.6)
    verify_dense_field_cutoff?: number;   // Detections below this use the sparse branch (default 20)
}

// Initial Default State (Matches PIPELINE_CONSTANTS)
export const DEFAULT_PIPELINE_CONFIG: DynamicPipelineConfig = {
    signal_sigma_threshold: 3.0,
    signal_fwhm_max: 180,
    min_circularity: 0.6,
    planetary_tolerance_px: 20,
    
    solver_sigma: 3.0,
    solver_blind_sigma: PIPELINE_CONSTANTS.SOLVER_BLIND_SIGMA,
    solver_quad_tolerance: PIPELINE_CONSTANTS.SOLVER_QUAD_tolerance_DEFAULT,
    solver_scale_variance: PIPELINE_CONSTANTS.SOLVER_MAX_SCALE_variance,
    
    verification_color_strictness: 0.5,
    verification_strobe_rejection: true
};

