// ═══════════════════════════════════════════════════════════════════════════
// PSF-ATTRIBUTION VALIDATION — adjudicate the receipt's psf_attribution block
// against the KNOWN rig (folded into the FITS solve-vs-truth rail, pillar C).
// ═══════════════════════════════════════════════════════════════════════════
//
// The engine's M10 PSF-attribution stage (src/.../stages/psf_attribution.ts)
// INFERS a tracking regime from the measured PSF (elongation vs the calculated
// static sidereal drift): TRACKED / UNTRACKED / INDETERMINATE / NOT_MEASURED. It
// also emits a diffraction FLOOR (a hard physical lower bound on the PSF).
//
// This module is the VALIDATION layer: it does NOT recompute physics — it checks
// two independent claims against ground we already know:
//   1. TRACKING vs RIG   — a SeeStar (a tracking mount) MUST infer TRACKED; a
//      KNOWN-untracked single sub MUST infer UNTRACKED. A mismatch is a real
//      attribution FAIL (the inference contradicts the hardware).
//   2. FLOOR CONSISTENCY — the measured PSF cannot be TIGHTER than the diffraction
//      floor (a lower bound is a lower bound). measured < floor ⇒ a physics
//      violation (a mis-measured PSF or a mis-computed floor).
//
// HONEST-OR-ABSENT throughout: an unknown rig → NO_EXPECTATION (skipped, never a
// guessed pass/fail); an unmeasured/indeterminate inference or an absent floor →
// NOT_MEASURED / INCONCLUSIVE (never a fabricated verdict). Pure — no I/O, no clock.

import { hasWholeToken } from '@/engine/pipeline/m2_hardware/identifier_matcher';

/** The engine's tracking inference vocabulary (mirrors psf_attribution.ts). */
export type TrackingInference = 'TRACKED' | 'UNTRACKED' | 'INDETERMINATE' | 'NOT_MEASURED';

/** What we EXPECT a rig's PSF to reveal. UNKNOWN ⇒ no assertion (honest-absent). */
export type ExpectedTracking = 'TRACKED' | 'UNTRACKED' | 'UNKNOWN';

/**
 * Map a corpus rig (cohort + camera string) → the tracking regime we EXPECT.
 * Conservative on purpose (over-claiming here would manufacture false FAILs):
 *  - SeeStar (a tracking smart-scope; 60s subs are round) ⇒ TRACKED.
 *  - a KNOWN untracked single frame (the bundled beach CR2, sidereal-trailed)
 *    ⇒ UNTRACKED.
 *  - everything else (a DSLR that may sit on a tracking EQ mount, an unknown rig)
 *    ⇒ UNKNOWN — we refuse to assert a regime we cannot know.
 */
export function expectedTrackingForRig(cohort?: string | null, camera?: string | null): ExpectedTracking {
  const cam = camera ?? '';
  const coh = (cohort ?? '').toUpperCase();
  // WHOLE-TOKEN match (identifier_matcher.hasWholeToken), not substring: the old
  // `cam.includes('t6')` fired on a Rebel T6i/T6s (DISTINCT bodies) or any 't6'
  // fragment, manufacturing a spurious UNTRACKED verdict (flag #7). 't6' now
  // matches only the token `t6`, never `t6i`/`x-t6`.
  if (coh === 'FITS_SEESTAR' || hasWholeToken(cam, 'seestar')) return 'TRACKED';
  // The one rig we KNOW is untracked: the bundled Rokinon-14mm beach CR2 single sub.
  if (hasWholeToken(cam, 'rokinon') || hasWholeToken(cam, 't6')) return 'UNTRACKED';
  return 'UNKNOWN';
}

// ─── tracking-inference validation ────────────────────────────────────────────
export interface PsfTrackingValidation {
  /** PASS (inference matches rig) · FAIL (contradicts rig) · INCONCLUSIVE
   *  (indeterminate/unmeasured inference) · NO_EXPECTATION (unknown rig). */
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NO_EXPECTATION';
  expected: ExpectedTracking;
  inferred: TrackingInference | null;
  rationale: string;
}

/** Read the tracking inference off a serialized psf_attribution block (honest-absent). */
export function readTrackingInference(block: any): TrackingInference | null {
  const inf = block?.tracking?.inference;
  return inf === 'TRACKED' || inf === 'UNTRACKED' || inf === 'INDETERMINATE' || inf === 'NOT_MEASURED'
    ? inf
    : null;
}

/**
 * Validate the block's tracking inference against the rig expectation.
 *   unknown rig                  → NO_EXPECTATION (skip)
 *   no/indeterminate/unmeasured  → INCONCLUSIVE (honest-absent — neither confirms nor refutes)
 *   inference === expected       → PASS
 *   inference is the OPPOSITE     → FAIL (a real contradiction with the hardware)
 */
export function validateTrackingInference(block: any, expected: ExpectedTracking): PsfTrackingValidation {
  const inferred = readTrackingInference(block);
  if (expected === 'UNKNOWN') {
    return { status: 'NO_EXPECTATION', expected, inferred, rationale: 'Rig tracking regime unknown — no assertion (honest-absent).' };
  }
  if (inferred == null || inferred === 'NOT_MEASURED' || inferred === 'INDETERMINATE') {
    return {
      status: 'INCONCLUSIVE',
      expected,
      inferred,
      rationale: `Tracking inference ${inferred ?? 'absent'} — cannot confirm or refute the expected ${expected} (honest-absent).`,
    };
  }
  if (inferred === expected) {
    return { status: 'PASS', expected, inferred, rationale: `Inferred ${inferred} matches the known rig (${expected}).` };
  }
  return {
    status: 'FAIL',
    expected,
    inferred,
    rationale: `Inferred ${inferred} CONTRADICTS the known rig (expected ${expected}).`,
  };
}

// ─── diffraction-floor consistency ────────────────────────────────────────────
export interface PsfFloorConsistency {
  /** CONSISTENT (measured ≥ floor) · VIOLATION (measured < floor) · NOT_MEASURED. */
  status: 'CONSISTENT' | 'VIOLATION' | 'NOT_MEASURED';
  /** Tightest measured axis FWHM (px) — the axis most likely to breach the floor. */
  measuredMinPx: number | null;
  /** Green diffraction-floor FWHM (px) — the hard physical lower bound. */
  diffractionFloorPx: number | null;
  /** measured / floor (must be ≳ 1). */
  ratio: number | null;
  note: string;
}

/**
 * The measured PSF's SHORT axis must not fall below the diffraction floor. A small
 * tolerance (default 10%) absorbs measurement noise / undersampled quantization —
 * a genuine violation is a hard physical impossibility, not a borderline case.
 * Absent measurement or floor → NOT_MEASURED (honest-absent, never a fabricated pass).
 */
export function checkDiffractionFloor(block: any, tolFrac = 0.1): PsfFloorConsistency {
  const measuredMinPx = numOrNull(block?.decomposition?.measuredMinPx);
  const diffractionFloorPx = numOrNull(block?.decomposition?.diffractionFloorPx);
  if (measuredMinPx == null || diffractionFloorPx == null || diffractionFloorPx <= 0) {
    return {
      status: 'NOT_MEASURED',
      measuredMinPx,
      diffractionFloorPx,
      ratio: null,
      note: 'Measured minor-axis FWHM or diffraction floor absent — floor consistency NOT MEASURED (honest-absent).',
    };
  }
  const ratio = measuredMinPx / diffractionFloorPx;
  const consistent = measuredMinPx >= diffractionFloorPx * (1 - tolFrac);
  return {
    status: consistent ? 'CONSISTENT' : 'VIOLATION',
    measuredMinPx,
    diffractionFloorPx,
    ratio: +ratio.toFixed(4),
    note: consistent
      ? `Measured min-axis FWHM ${measuredMinPx.toFixed(3)}px ≥ diffraction floor ${diffractionFloorPx.toFixed(3)}px (ratio ${ratio.toFixed(2)}).`
      : `Measured min-axis FWHM ${measuredMinPx.toFixed(3)}px < diffraction floor ${diffractionFloorPx.toFixed(3)}px — physically impossible (ratio ${ratio.toFixed(2)}).`,
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ─── combined adjudication ────────────────────────────────────────────────────
export interface PsfAttributionAdjudication {
  frame_id: string;
  cohort: string | null;
  camera: string | null;
  expected_tracking: ExpectedTracking;
  tracking: PsfTrackingValidation;
  floor: PsfFloorConsistency;
  /** Overall: PASS unless the tracking CONTRADICTS the rig or the floor is VIOLATED.
   *  Honest-absent statuses (INCONCLUSIVE / NO_EXPECTATION / NOT_MEASURED) never fail. */
  pass: boolean;
  /** True when NEITHER check produced a concrete verdict (nothing was validated). */
  inconclusive: boolean;
}

export interface AdjudicateInput {
  frame_id: string;
  /** The serialized receipt.psf_attribution block (or null if the stage didn't run). */
  block: any;
  cohort?: string | null;
  camera?: string | null;
  /** Optional explicit expectation (overrides the rig heuristic — for tests/known frames). */
  expectedOverride?: ExpectedTracking;
}

/** Adjudicate a frame's psf_attribution block against its known rig. */
export function adjudicatePsfAttribution(input: AdjudicateInput): PsfAttributionAdjudication {
  const expected = input.expectedOverride ?? expectedTrackingForRig(input.cohort, input.camera);
  const tracking = validateTrackingInference(input.block, expected);
  const floor = checkDiffractionFloor(input.block);
  const pass = tracking.status !== 'FAIL' && floor.status !== 'VIOLATION';
  const inconclusive =
    (tracking.status === 'INCONCLUSIVE' || tracking.status === 'NO_EXPECTATION') &&
    floor.status === 'NOT_MEASURED';
  return {
    frame_id: input.frame_id,
    cohort: input.cohort ?? null,
    camera: input.camera ?? null,
    expected_tracking: expected,
    tracking,
    floor,
    pass,
    inconclusive,
  };
}
