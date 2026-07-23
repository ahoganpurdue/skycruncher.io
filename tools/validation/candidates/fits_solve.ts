// ═══════════════════════════════════════════════════════════════════════════
// CANDIDATE — fits_solve (the FITS solve-vs-truth rail, SOLVER domain)
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the FITS sibling of uw_anchor_topN (CR2). Where the CR2 rail drives the
// ultra-wide anchored sweep, THIS rail drives the REAL narrow FITS wizard solve
// (tools/api/headless_driver.runWizardPipeline → OrchestratorSession step1→6) over
// the local FITS corpus and grades each solve AGAINST ORACLE TRUTH.
//
// LIVE binding (NOT descriptor-only): tools/validation/fits_binding.* runs both arms
// as fresh vitest processes and run_fits_sweep.ts pairs them into a truth-adjudicated
// ledger. Unlike the CR2 anchored sweep (which records a bright-anchor center), the
// FITS wizard records the FITTED FRAME CENTER (solution.ra_hours/dec_degrees =
// centerSky, verified apples-to-apples with the frame-center truth labels — M66
// solves to 0.36° of its OBJECT-RA/DEC label, inside the 1° tolerance). So the FITS
// binding sets provenance.recorded_center_is_frame=true and truth adjudication goes
// LIVE: a truth-DISAGREEING FITS lock becomes a `new_false_positive` regression.
//
// THE ON ARM IS AN IDENTITY / NULL LEVER — a documented SEAM, not a fabricated win.
// Config site: src/engine/pipeline/constants/pipeline_config.ts
//   SOLVER_FITS_VALIDATION_ARM (default 0). offValue 0 ≡ onValue 1 → the narrow FITS
//   solve is BYTE-IDENTICAL in both arms (no FITS solver knob reads it yet). The rail
//   exists for the OFF-arm solver-vs-truth validation; when a genuinely-safe FITS
//   lever lands it hangs off this same constant as a real 0↔1 split. Until then the
//   A/B delta is structurally empty (no improvement, no regression) BY DESIGN — the
//   value is the per-frame truth verdict, not a graduation.

import { extractSolverOutcome, computeSolverDelta } from '../domains.ts';
import type { Candidate } from '../types.ts';

export const FITS_SOLVE: Candidate = {
  id: 'fits_solve',
  description:
    'Narrow FITS wizard solve scored against oracle truth (frame-center WCS, truth-adjudicated → TRUE_POSITIVE / new_false_positive). ON arm is an IDENTITY seam (OFF≡ON, no fabricated lever); primary value is the OFF-arm solver-vs-truth validation.',
  domain: 'SOLVER',
  // Narrow FITS cohorts. FOV-gated the OPPOSITE way from uw_anchor_topN (the UW
  // anchor lever never reaches a narrow field; this rail is narrow FITS only).
  applicability: new Set(['FITS_SEESTAR', 'FITS_OTHER']),
  binding: {
    envVar: 'SOLVER_FITS_VALIDATION_ARM',
    offValue: '0', // baseline narrow FITS solve
    onValue: '1', // identity seam — byte-identical solve until a real FITS lever lands
    defaultByType: { FITS_SEESTAR: 'OFF', FITS_OTHER: 'OFF' },
  },
  extractOutcome: extractSolverOutcome,
  computeDelta: computeSolverDelta,
  policy: {
    // ≥3 DISTINCT FITS_SEESTAR frames truth-adjudicated before a non-INSUFFICIENT
    // verdict (M66 is N=1 today; the corpus adds M51 variants). lost_lock (a solver
    // regression) and new_false_positive (a truth-disagreeing lock) BOTH block — the
    // whole point of wiring truth is that a wrong lock is a first-class regression.
    nMin: { FITS_SEESTAR: 3, FITS_OTHER: 3 },
    nMinDefault: 3,
    k: 1,
    blockingRegressions: ['lost_lock', 'new_false_positive'],
  },
  // Honest current state: the OFF arm reproduces the sacred SeeStar M66 solve and it
  // truth-adjudicates TRUE_POSITIVE — but the ON arm is an identity seam (no lever to
  // graduate) and the corpus does not yet reach N_min of DISTINCT solved+labelled
  // FITS targets. So the rail VALIDATES the solver against truth; it does not (yet)
  // graduate a lever.
  seedVerdicts: { FITS_SEESTAR: 'INSUFFICIENT-DATA', FITS_OTHER: 'INSUFFICIENT-DATA' },
};
