// ═══════════════════════════════════════════════════════════════════════════
// SOLVERKIT — CONTRACTS (the seams every tool in this kit speaks)
// ═══════════════════════════════════════════════════════════════════════════
// Incubator lane (CLAUDE.md LAW 4): everything here is HEADLESS, reuses the
// live primitives (WASM, forced_detect atlas/projection helpers), and touches
// NO app/client code. A tool graduates to the client only after it clears the
// EVIDENCE GATE below.
//
// Two composable roles. A solve = GENERATOR -> VALIDATOR.
//
//   GENERATOR   (hypothesis maker)
//     in:  { det[], cat[], meta }            // detections, catalog region, frame meta
//     out: CandidateWCS[]                    // ranked; may be empty (honest: no hypothesis)
//     A generator proposes *where the sky is*. It is allowed to be cheap,
//     lossy, and wrong — the validator is the skeptic. Generators MUST tag
//     each candidate with the measured evidence that produced it (sweep z,
//     quad error, matchCount) and NEVER a fabricated confidence.
//
//   VALIDATOR  (skeptic / consensus)
//     in:  { candidate: WCS, det[], cat[], opts }
//     out: ValidationResult { inliers, matched, sigma, score, refinedWcs,
//                             accepted, nullMean, nullStd, provenance }
//     A validator independently re-derives consensus from the pixels/catalog,
//     measures it against a chance null (its own sigma), LO-refines, and
//     returns accepted=true ONLY when the measured evidence clears the gate.
//     `sigma`/`score` are MEASURED. If a value cannot be measured it is null
//     and reported "NOT MEASURED" — never a placeholder number.
//
// ── WCS shape (solverkit canonical) ────────────────────────────────────────
//   crval : [raDeg, decDeg]   sky tangent point, DEGREES (NOT hours — this is
//                             the tools/psf projectStars convention; hours live
//                             only inside the app's coordinate ledger)
//   crpix : [x, y]            reference pixel (0-based, native grid)
//   cd    : [[c11,c12],[c21,c22]]   deg/px linear terms, [xi,eta]=CD·(pix-crpix)
// This is byte-compatible with tools/psf/forced_detect.projectStars.
//
// ── EVIDENCE-GATE-TO-CLIENT RULE ───────────────────────────────────────────
// A solverkit tool may be promoted into src/ (the wizard/auto path) ONLY when,
// on the measured gauntlet (gauntlet.mjs):
//   1. it produces byte-reproducible numbers (deterministic; no RNG without a
//      fixed seed — solverkit RANSAC seeds its PRNG),
//   2. every accept clears sigma >= GATE.Z (5.0) AND inliers >= GATE.MIN_INLIERS
//      against the tool's OWN chance null (gates are never lowered — evidence is
//      added), and
//   3. it does not regress the sacred e2e (seestar byte-identical; cr2 solved).
// Until then it lives here, out of the live workflow's way.
// ═══════════════════════════════════════════════════════════════════════════

/** Acceptance gate — shared by every validator. Never lowered; evidence added. */
export const GATE = Object.freeze({
    Z: 5.0,           // sigma above the tool's own chance null
    MIN_INLIERS: 8,   // absolute floor so a 3-star coincidence can't "verify"
});

/** Live app constants mirrored here (values read from pipeline_config.ts). */
export const PC = Object.freeze({
    SOLVER_UW_VERIFY_MAG_LIMIT: 6.0,
    SOLVER_UW_SWEEP_MIN_Z: 4.5,
    SOLVER_VERIFICATION_RADIUS_ARCSEC: 120,
    SOLVER_MAX_VERIFY_RADIUS_ARCSEC: 2000,
});

/**
 * Ultra-wide verify/sweep matching-net slope — SINGLE solverkit source, pinned
 * to the engine's `VERIFY_NET` export (owner-queue ④). The radius-scaled net is
 * `tol(r) = max(tolBasePx, WIDE_NET_SLOPE · r)`, shared by the UW anchored sweep
 * and verifyWCS's ultra-wide TS matcher. Value is byte-identical to the engine
 * literal (0.035) — this replaces the eight scattered `tolSlope: 0.035` literals
 * that used to live across the verify/sweep/gauntlet drivers.
 *
 * WHY A PINNED MIRROR, NOT AN ESM `import` FROM THE ENGINE (the surgeon's intent
 * was a true import): the canonical export lives in
 * `src/engine/pipeline/m6_plate_solve/solver_entry.ts:VERIFY_NET`, but that
 * module's transitive import graph is extensionless TypeScript (`./foo`, not
 * `./foo.ts`) and is NOT Node-loadable under this repo's native type-stripping
 * (no tsx/loader on the solverkit lane — verified: `import` fails on the first
 * hop `./star_catalog_adapter`). The Node-importable precedents (nova_truth.mjs →
 * schema.ts, forced_detect.mjs → tps_eval.ts) are ZERO-import LEAF modules; a
 * true import of VERIFY_NET requires first extracting it into such a leaf in
 * `src/` — a change outside the incubator (tools-lane) scope. Until that leaf
 * exists, this is the single mirror point that a future import replaces 1:1
 * (same shape, same field name). Keep in sync with the engine literal.
 */
export const VERIFY_NET = Object.freeze({
    WIDE_NET_SLOPE: 0.035,
});

/**
 * @typedef {{x:number,y:number,flux:number,fwhm:number}} Detection
 * @typedef {{ra_deg:number,dec_deg:number,mag:number,gaia_id?:string}} CatStar
 * @typedef {{crval:[number,number],crpix:[number,number],cd:[[number,number],[number,number]]}} WCS
 * @typedef {{wcs:WCS, source:string, evidence:object}} CandidateWCS
 * @typedef {{inliers:number,matched:number,sigma:number|null,score:number|null,
 *            refinedWcs:WCS|null,accepted:boolean,nullMean:number|null,
 *            nullStd:number|null,provenance:string}} ValidationResult
 */

/** Build a ValidationResult marked NOT MEASURED (honest absence, not a fake). */
export function notMeasured(provenance, reason) {
    return {
        inliers: 0, matched: 0, sigma: null, score: null, refinedWcs: null,
        accepted: false, nullMean: null, nullStd: null,
        provenance, reason: reason ?? 'NOT MEASURED',
    };
}
