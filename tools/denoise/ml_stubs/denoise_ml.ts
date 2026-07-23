// ═══════════════════════════════════════════════════════════════════════════
// ML STUB — self-supervised DENOISE (Noise2Noise on the user's own sub-frames)
// ═══════════════════════════════════════════════════════════════════════════
// solve/verify path stays ML-free; render-layer post-solve only.
//
// DEFAULT OFF. Real, type-correct, and UNCALLED — the body throws so it can
// never silently run. Research doc §5.2(1): Noise2Noise (Lehtinen et al. 2018)
// trains on pairs (x+n₁, x+n₂) of the SAME scene and converges to the clean
// signal with NO clean target. SkyCruncher already has exactly these independent
// sub-exposures, so there is no external prior and nothing to hallucinate — the
// strongest "true to the science" ML denoise option.
//
// Variants to consider (comments only): Self2Self / TDR (Nature Astronomy vol.9,
// 2025) adds a RESTORATION BOUND — any pixel whose change exceeds R (R below the
// measured noise level) is restored, giving deviation control the XTerminators
// lack; ASTERIS (Science 2025) is the multi-frame spatiotemporal variant that a
// KS test showed preserves the PSF (p=0.9 vs co-addition).
//
// PLUGS IN HERE: this same lane, tools/denoise/ — as the ML arm alongside the
// deterministic GAT+starlet default. The overnight loop is the offline factory
// that mints the sub-frame-pair training set AND runs the forced-photometry
// validation; it is NOT a live-solve dependency.

import {
  DEFAULT_OFF,
  NOT_MEASURED,
  classifyEpistemic,
  emptyProof,
  type EnhancementOpResult,
  type ImagePlane,
  type MlProvenance,
  type PreservationProof,
  type ProofMetric,
  type SubFramePair,
} from './types.ts';

export interface DenoiseMlOptions {
  /** must be explicitly enabled; DEFAULT OFF */
  enabled: boolean;
  /** REQUIRED — ML provenance must trace to real capture */
  provenance: MlProvenance;
  /** deviation-map magnitude gate as a multiple of the measured σ (≤ 1 ⇒ noise-like) */
  deviation_sigma_bound: number;
}

export interface DenoiseMlResult extends EnhancementOpResult {
  output: ImagePlane;
  /** output − mean(inputs); MUST be asserted noise-like (flat spectrum, |·| ≤ σ) */
  deviation_map: ImagePlane;
}

/**
 * Self-supervised Noise2Noise denoise over an independent sub-exposure pair.
 * PSEUDOCODE (never executed):
 *
 *   assert opts.enabled            // DEFAULT OFF
 *   σ = pair.noise_model → measured Poisson–Gaussian σ (bounds the gate)
 *   net = load(opts.provenance.model_hash)          // small U-Net, single-digit MB (tract/burn)
 *   ŷ  = net(pair.a)               // trained with target = pair.b (no clean target)
 *   dev = ŷ − 0.5·(pair.a + pair.b)                 // deviation map
 *   proof.reconvolution_residual   // dev must be spectrally flat AND |dev| ≤ σ·deviation_sigma_bound
 *   proof.flux_conservation        // Σflux over catalog stars, pre vs post
 *   proof.forced_photometry_recheck// deep_verify/forced_confirm run pre/post
 *   epistemic = classifyEpistemic(proof)            // AESTHETIC unless ALL pass
 *   return { output: ŷ, deviation_map: dev, epistemic_type, preservation_proof, provenance, label }
 *
 * The deviation-map gate is what makes this honest: structured (non-noise)
 * residual ⇒ the transform invented/destroyed signal ⇒ AESTHETIC, never MEASURED.
 */
export function denoiseMl(pair: SubFramePair, opts: DenoiseMlOptions): DenoiseMlResult {
  void pair;
  void opts;
  void DEFAULT_OFF;
  void NOT_MEASURED;
  // real preservation-proof scaffold; every metric NOT_MEASURED until the gate runs
  const proof: PreservationProof = emptyProof();
  const _epistemic = classifyEpistemic(proof); // ⇒ 'AESTHETIC' while proof is unpopulated
  void _epistemic;
  const _devGate: ProofMetric = proof.reconvolution_residual;
  void _devGate;
  throw new Error(
    'NOT_IMPLEMENTED: ML variant — deterministic-first; gated by preservation proof; DEFAULT OFF',
  );
}
