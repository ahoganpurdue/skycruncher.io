// ─────────────────────────────────────────────────────────────────────────────
// BUNDLE ENTRY (LAW 4 incubator, reverse): a thin re-export surface so the tools
// render lane can exercise two READ-ONLY engine modules from a plain-node driver
// via an esbuild bundle. Defines NO new science — pure re-export of the shipped
// engine functions. Not imported by any engine code.
// ─────────────────────────────────────────────────────────────────────────────
export {
    decomposeNebulosityLayers,
    reconstructLayers,
    buildNebulosityLayerReceipt,
    nebulosityKnobsForRig,
    RIG_KNOB_PRESETS,
} from '../../src/engine/pipeline/m10_psf/nebulosity_layer';
export { ImageProcessor } from '../../src/engine/core/ImageProcessor';
// Detection primitives (the shipped pipeline detector surface) — used by the
// evidence lane to build EXTERNAL star footprints from the SAME source finder the
// solve uses, not a re-implementation.
export {
    findMaxima,
    measureStar,
    pixelNoiseSigma,
    robustStats,
} from '../../src/engine/pipeline/m10_psf/psf_core';
