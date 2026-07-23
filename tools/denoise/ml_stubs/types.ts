// ═══════════════════════════════════════════════════════════════════════════
// ML PLUG-IN STUBS — shared epistemic contracts (types only)
// ═══════════════════════════════════════════════════════════════════════════
// solve/verify path stays ML-free; render-layer post-solve only.
//
// These types encode SkyCruncher's ethos at the TYPE LEVEL so a future ML op
// CANNOT be wired in without declaring its epistemic status, carrying real
// provenance, and shipping a machine-checkable preservation proof. They mirror
// PROVENANCE_HANDOFF_DESIGN.md §2 (the M/V/A epistemic layers) and §4.2 (the
// preservation_proof / MlProvenance payloads). Nothing here runs — the ops that
// consume these contracts (denoise_ml / star_extract_ml / blur_ml) are real,
// type-correct, and UNCALLED, and every body throws NOT_IMPLEMENTED.

import type { NoiseModel } from '../denoise.mjs';

/**
 * The three epistemic types every pixel-affecting op is assigned (PROVENANCE §2).
 *  - MEASURED             : derived from unmodified capture, with error bars (never an ML op).
 *  - VERIFIED_PRESERVING  : changes pixels but PROVEN to preserve the science within tolerance.
 *  - AESTHETIC            : legitimate but unproven — a look, not a measurement.
 * An ML op is AESTHETIC by default and may ONLY be promoted to VERIFIED_PRESERVING
 * when its PreservationProof passes (see classifyEpistemic).
 */
export type EpistemicType = 'MEASURED' | 'VERIFIED_PRESERVING' | 'AESTHETIC';

/** Sentinel for a proof/metric that has not been computed (honest-or-absent). */
export const NOT_MEASURED = 'NOT_MEASURED' as const;
export type NotMeasured = typeof NOT_MEASURED;

/** One machine-checkable proof metric: value vs tolerance → pass (PROVENANCE §4.2). */
export interface ProofMetric {
  /** what was measured, e.g. 'sum_flux_ratio_catalog_stars' */
  metric: string;
  /** measured value, or NOT_MEASURED if the check was not run */
  value: number | NotMeasured;
  /** the tolerance the value must satisfy for pass */
  tolerance: number;
  /** true only when the check ran AND value is within tolerance */
  pass: boolean;
}

/**
 * The preservation proof — the part C2PA cannot express and the spine of the
 * whole design (PROVENANCE §4.2). Any op claiming measurement-grade must PASS
 * every applicable check; a failing/absent check forces the AESTHETIC label.
 */
export interface PreservationProof {
  /** total flux over catalog stars conserved (ratio ≈ 1) */
  flux_conservation: ProofMetric;
  /** star centroids unmoved (max shift px) — measurement never runs on altered pixels */
  astrometric_invariance: ProofMetric;
  /** re-convolve output with the MEASURED PSF; residual ≈ noise floor, not structured */
  reconvolution_residual: ProofMetric;
  /** existing forced-photometry (deep_verify/forced_confirm) run pre/post as the integrity gate */
  forced_photometry_recheck: ProofMetric;
}

/**
 * ML provenance — REQUIRED for every ML op. ML provenance MUST trace to real
 * capture (no untraceable pretrained prior). Prefer training on synthetic
 * degradations / injections of the USER'S OWN data.
 */
export interface MlProvenance {
  /** sha256 of the exact model weights that ran */
  model_hash: string;
  /** where the training data came from, e.g. 'user_own_subframe_pairs' | 'public:<traceable_ref>' */
  training_data_provenance: string;
  /** hard requirement: the training data resolves to a real capture chain */
  traceable_to_real_capture: true;
}

/**
 * The typed result every enhancement op returns. `provenance` is REQUIRED for ML
 * ops (deterministic ops may omit it). `label` is the human-facing badge that
 * MUST agree with `epistemic_type` (MEASUREMENT_GRADE ⇔ VERIFIED_PRESERVING,
 * AESTHETIC_NOT_MEASURED ⇔ AESTHETIC).
 */
export interface EnhancementOpResult {
  epistemic_type: EpistemicType;
  /** the op's parameters (traceable; never a bare magic number) */
  params: Record<string, unknown>;
  preservation_proof: PreservationProof;
  /** REQUIRED for ML ops */
  provenance?: MlProvenance;
  label: 'MEASUREMENT_GRADE' | 'AESTHETIC_NOT_MEASURED';
}

/** Shared marker: an op is DEFAULT-OFF until explicitly enabled behind a flag. */
export const DEFAULT_OFF = false as const;

/**
 * A single-channel image on the NATIVE pixel grid (render-layer input). ML ops
 * receive already-solved, already-measured pixels — never the reverse.
 */
export interface ImagePlane {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Reference to the MEASURED, spatially-varying LM PSF field (m10_psf/psf_field.ts).
 * Blur ML is PSF-CONDITIONED, not blind: this is an explicit input, and its hash
 * is recorded in provenance so the kernel is fully traceable.
 */
export interface MeasuredPsfFieldRef {
  /** sha256 of the sealed native-grid PSF map */
  grid_hash: string;
  median_fwhm_px: number;
  /** sample the measured PSF stamp at a field position (native grid) */
  sampleAt(x: number, y: number): Float32Array;
}

/** A pair of INDEPENDENT sub-exposures of the same scene (Noise2Noise input). */
export interface SubFramePair {
  a: ImagePlane;
  b: ImagePlane;
  /** the measured noise model (from the deterministic lane) — bounds the deviation gate */
  noise_model: NoiseModel;
}

/**
 * Promote to VERIFIED_PRESERVING ONLY when EVERY applicable proof metric passes;
 * otherwise the op is AESTHETIC. This is the single choke-point that keeps an ML
 * op from ever silently claiming measurement-grade. Pure, side-effect-free.
 */
export function classifyEpistemic(proof: PreservationProof): EpistemicType {
  const checks = [
    proof.flux_conservation,
    proof.astrometric_invariance,
    proof.reconvolution_residual,
    proof.forced_photometry_recheck,
  ];
  const allRan = checks.every((c) => c.value !== NOT_MEASURED);
  const allPass = checks.every((c) => c.pass === true);
  return allRan && allPass ? 'VERIFIED_PRESERVING' : 'AESTHETIC';
}

/** An unpopulated proof — every metric NOT_MEASURED, so classifyEpistemic → AESTHETIC. */
export function emptyProof(): PreservationProof {
  const blank = (metric: string, tolerance: number): ProofMetric => ({
    metric, value: NOT_MEASURED, tolerance, pass: false,
  });
  return {
    flux_conservation: blank('sum_flux_ratio_catalog_stars', 0.02),
    astrometric_invariance: blank('max_centroid_shift_px', 0.1),
    reconvolution_residual: blank('rms_residual_over_noise', 1.2),
    forced_photometry_recheck: blank('catalog_flux_shift_sigma', 2.0),
  };
}
