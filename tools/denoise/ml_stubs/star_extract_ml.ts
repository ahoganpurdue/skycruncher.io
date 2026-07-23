// ═══════════════════════════════════════════════════════════════════════════
// ML STUB — STAR EXTRACTION (synthetic-injection U-Net, StarX-equivalent)
// ═══════════════════════════════════════════════════════════════════════════
// solve/verify path stays ML-free; render-layer post-solve only.
//
// DEFAULT OFF. Real, type-correct, UNCALLED — the body throws. Research doc §4.2:
// train a compact encoder-decoder U-Net (StarNet-style) with L1 / PERCEPTUAL
// loss ONLY — NO ADVERSARIAL loss (the generative component most prone to
// hallucination) — on SYNTHETIC PSF-model star injection into VERIFIED REAL
// STARLESS data, where positions/fluxes are exactly known, so fabrication is
// impossible in principle. Outputs a starless layer and a stars layer; recombine
// via SCREEN BLEND  combined = 1 − (1−stars)(1−starless)  (bounded ≤ 1, avoids
// the naive stars+starless star-bloat).
//
// Astrometric-invariance gate (doc §4.3): detection centroids must be
// byte-identical before/after — MEASUREMENT NEVER runs on the recombined image.
//
// PLUGS IN HERE: the render-layer separation lane tools/starsep/ (deterministic
// detect + LM-PSF subtraction + screen recombination first; this ML op is the
// crowded-field arm). Detection itself stays in m4_signal_detect. The overnight
// loop mints the injection training set (real starless + known injected stars)
// AND runs the forced-photometry validation of recovered injected photometry.

import {
  DEFAULT_OFF,
  classifyEpistemic,
  emptyProof,
  type EnhancementOpResult,
  type ImagePlane,
  type MeasuredPsfFieldRef,
  type MlProvenance,
  type PreservationProof,
} from './types.ts';

export interface StarExtractMlOptions {
  /** DEFAULT OFF */
  enabled: boolean;
  /** REQUIRED — provenance must trace to real capture (the real starless base) */
  provenance: MlProvenance;
  /** the MEASURED PSF field used to synthesize the injection training set */
  psf_field: MeasuredPsfFieldRef;
  /** L1 + perceptual only; adversarial is forbidden (hallucination-prone) */
  loss: { l1: boolean; perceptual: boolean; adversarial: false };
}

export interface StarExtractMlResult extends EnhancementOpResult {
  starless: ImagePlane;
  stars: ImagePlane;
  /** the exact linear recombination used: screen blend */
  recombination: { formula: '1-(1-stars)(1-starless)'; kind: 'screen_blend' };
}

/**
 * Split an image into starless + stars layers. PSEUDOCODE (never executed):
 *
 *   assert opts.enabled                         // DEFAULT OFF
 *   assert opts.loss.adversarial === false      // no adversarial loss, ever
 *   net = load(opts.provenance.model_hash)       // U-Net trained on injection-into-real-starless
 *   starless = net(image)
 *   stars    = image − starless                  // linear-space subtraction
 *   combined = 1 − (1 − stars)(1 − starless)     // screen blend, bounded ≤ 1
 *   proof.astrometric_invariance                 // detection centroids byte-identical pre/post
 *   proof.flux_conservation                      // injected-star photometry recovered in `stars`
 *   proof.forced_photometry_recheck              // deep_verify/forced_confirm pre/post
 *   epistemic = classifyEpistemic(proof)         // AESTHETIC unless ALL pass
 *   return { starless, stars, recombination, epistemic_type, preservation_proof, provenance, label }
 */
export function starExtractMl(image: ImagePlane, opts: StarExtractMlOptions): StarExtractMlResult {
  void image;
  void opts;
  void DEFAULT_OFF;
  const proof: PreservationProof = emptyProof();
  const _epistemic = classifyEpistemic(proof); // ⇒ 'AESTHETIC' while unpopulated
  void _epistemic;
  throw new Error(
    'NOT_IMPLEMENTED: ML variant — deterministic-first; gated by preservation proof; DEFAULT OFF',
  );
}
