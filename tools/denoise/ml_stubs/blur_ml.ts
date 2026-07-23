// ═══════════════════════════════════════════════════════════════════════════
// ML STUB — BLUR / DECONVOLUTION (PSF-conditioned unrolled optimization)
// ═══════════════════════════════════════════════════════════════════════════
// solve/verify path stays ML-free; render-layer post-solve only.
//
// DEFAULT OFF. Real, type-correct, UNCALLED — the body throws. Research doc §3.2:
// unlike BlurXTerminator (BLIND — infers the PSF from stars), SkyCruncher already
// MEASURES the PSF field (m10_psf LM fits), so this op is PSF-CONDITIONED, not
// blind: the measured field is an EXPLICIT network input. The network is an
// UNROLLED optimizer (learned ADMM/ISTA; Diamond & Sitzmann, "Unrolled
// Optimization with Deep Priors", arXiv:1705.08041) — fixed iterations, each a
// data-consistency step (g⊛·) plus a learned proximal step, so the image-
// formation model is baked in and the network stays small + interpretable.
//
// RE-CONVOLUTION RESIDUAL GATE IS MANDATORY: re-convolve the output with the
// measured PSF and require ‖g⊛f̂ − h‖ ≈ noise floor; a structured (non-noise)
// residual FAILS the gate and the op is flagged AESTHETIC, never accepted as
// measurement-grade (this is the exact line the XTerminators cross silently).
//
// PLUGS IN HERE: extend m10_psf/rl_deconv.ts (engine) and the tools/psf/ lane
// (deterministic damped/regularized RL + starlet regularization ships first;
// this ML op is the non-stellar-gap arm). The overnight loop mints training data
// as synthetic degradations of the user's own high-SNR stacks AND runs the
// forced-photometry validation — NOT a live-solve dependency.

import {
  DEFAULT_OFF,
  classifyEpistemic,
  emptyProof,
  type EnhancementOpResult,
  type ImagePlane,
  type MeasuredPsfFieldRef,
  type MlProvenance,
  type PreservationProof,
  type ProofMetric,
} from './types.ts';

export interface BlurMlOptions {
  /** DEFAULT OFF */
  enabled: boolean;
  /** REQUIRED — provenance must trace to real capture */
  provenance: MlProvenance;
  /** the MEASURED, spatially-varying LM PSF field — explicit input (NOT blind) */
  psf_field: MeasuredPsfFieldRef;
  /** number of unrolled data-consistency + proximal iterations */
  unrolled_iterations: number;
  /** re-convolution residual must be ≤ this multiple of the noise floor to pass */
  reconvolution_tolerance: number;
}

export interface BlurMlResult extends EnhancementOpResult {
  output: ImagePlane;
  /** rms(g⊛f̂ − h) / expected_noise — the mandatory data-fidelity gate result */
  reconvolution_residual: ProofMetric;
}

/**
 * PSF-conditioned unrolled deconvolution. PSEUDOCODE (never executed):
 *
 *   assert opts.enabled                              // DEFAULT OFF
 *   g   = opts.psf_field                             // MEASURED kernel, explicit (not blind)
 *   net = load(opts.provenance.model_hash)            // small unrolled ADMM/ISTA, PSF-conditioned
 *   f̂  = net(image, g, opts.unrolled_iterations)
 *   r   = rms(conv(g, f̂) − image) / expected_noise    // re-convolution residual
 *   proof.reconvolution_residual = { value: r, tolerance: opts.reconvolution_tolerance, pass: r ≤ tol }
 *   proof.flux_conservation                          // Σflux over catalog stars pre/post
 *   proof.astrometric_invariance                     // centroids unmoved
 *   proof.forced_photometry_recheck                  // deep_verify/forced_confirm pre/post
 *   epistemic = classifyEpistemic(proof)             // AESTHETIC unless ALL pass (incl. residual)
 *   return { output: f̂, reconvolution_residual, epistemic_type, preservation_proof, provenance, label }
 */
export function blurMl(image: ImagePlane, opts: BlurMlOptions): BlurMlResult {
  void image;
  void opts;
  void DEFAULT_OFF;
  const proof: PreservationProof = emptyProof();
  const _epistemic = classifyEpistemic(proof); // ⇒ 'AESTHETIC' while unpopulated
  void _epistemic;
  const _residualGate: ProofMetric = proof.reconvolution_residual;
  void _residualGate;
  throw new Error(
    'NOT_IMPLEMENTED: ML variant — deterministic-first; gated by preservation proof; DEFAULT OFF',
  );
}
