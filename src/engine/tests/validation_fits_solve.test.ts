// Unit tests for the FITS solve-vs-truth RAIL (candidate fits_solve) + the folded-in
// PSF-attribution validation (pillar C). Pure, ZERO calibrated-path / heavy-solve
// dependency — the REAL M66 wizard solve is the opt-in fits_binding.fitspec.ts; here
// we prove the wiring with the REAL empirical M66 solve numbers as fixtures.
//
// Covers:
//  • fits_solve candidate registration + binding shape (identity seam documented).
//  • CENTER-CONVENTION verification: the FITS wizard records the FRAME CENTER
//    (solution.ra_hours/dec_degrees), apples-to-apples with the frame-center truth
//    labels — the REAL M66 solve (11.3412h, +13.048°, 3.6776"/px) grades TRUE_POSITIVE
//    against its OBJECT-RA/DEC label (0.36° / 1.6% inside default tol).
//  • a truth-DISAGREEING FITS lock → new_false_positive through the UNCHANGED delta.
//  • PSF-attribution tracking-vs-rig + diffraction-floor consistency (honest-absent).

import { describe, it, expect } from 'vitest';
import path from 'node:path';

import { compareToTruth, type SolvedWcs } from '../../../tools/validation/truth/compare.ts';
import { loadLabelsFile, resolveTruth } from '../../../tools/validation/truth/loader.ts';
import { reconcileFitsTruth, FAILURE } from '../../../tools/overnight/rotation.mjs';
import type { TruthLabel } from '../../../tools/validation/truth/schema.ts';
import {
  applyTruthToRunResult,
  recordedCenterIsFrameCenter,
} from '../../../tools/validation/truth/harness_hook.ts';
import { extractSolverOutcome, computeSolverDelta } from '../../../tools/validation/domains.ts';
import type { RunResult } from '../../../tools/validation/types.ts';
import { getCandidate } from '../../../tools/validation/registry.ts';
import { FITS_SOLVE } from '../../../tools/validation/candidates/fits_solve.ts';
import {
  expectedTrackingForRig,
  validateTrackingInference,
  checkDiffractionFloor,
  adjudicatePsfAttribution,
  readTrackingInference,
} from '../../../tools/validation/psf_attribution_check.ts';

// ── REAL empirical M66 solve (the sacred SeeStar e2e frame) ──────────────────────
// solution.ra_hours = 11.341253475172621h (byte-identical to the sacred regression),
// dec = 13.048392248246461° (fitted frame center), scale = 3.6776147325019153"/px.
const M66_SOLVED: SolvedWcs = {
  ra_hours: 11.341253475172621,
  dec_degrees: 13.048392248246461,
  pixel_scale_arcsec: 3.6776147325019153,
};
const M66_LABEL_ID = 'DSO_Stacked_738_M 66_60.0s_20260516_064736';

describe('fits_solve · candidate registration + identity-seam binding', () => {
  it('is registered and applies to the narrow FITS cohorts only', () => {
    expect(getCandidate('fits_solve')).toBe(FITS_SOLVE);
    expect(FITS_SOLVE.domain).toBe('SOLVER');
    expect([...FITS_SOLVE.applicability].sort()).toEqual(['FITS_OTHER', 'FITS_SEESTAR']);
    expect(FITS_SOLVE.applicability.has('CR2_DSLR')).toBe(false);
  });

  it('binds the NEW FITS validation env var (never a calibrated SOLVER_UW_* value)', () => {
    expect(FITS_SOLVE.binding.envVar).toBe('SOLVER_FITS_VALIDATION_ARM');
    // identity seam: OFF (0) and ON (1) are distinct values but produce a byte-
    // identical solve today (documented in the candidate + config-site comment).
    expect(FITS_SOLVE.binding.offValue).toBe('0');
    expect(FITS_SOLVE.binding.onValue).toBe('1');
    expect(FITS_SOLVE.binding.defaultByType.FITS_SEESTAR).toBe('OFF');
  });

  it('blocks on lost_lock AND new_false_positive (a wrong lock is first-class harm)', () => {
    expect(FITS_SOLVE.policy.blockingRegressions).toEqual(['lost_lock', 'new_false_positive']);
  });
});

describe('fits_solve · CENTER CONVENTION verified (frame center ≡ truth label)', () => {
  it('the committed labels.json M66 label is a FRAME-CENTER (OBJECT RA/DEC) label', () => {
    const seed = path.resolve(__dirname, '../../../tools/validation/truth/labels.json');
    const label = loadLabelsFile(seed).find((l) => l.frame_id === M66_LABEL_ID);
    expect(label).toBeTruthy();
    expect(label!.source).toBe('fits_header');
    expect(label!.ra_hours).toBeCloseTo(11.36166687, 5);
    expect(label!.dec_degrees).toBeCloseTo(12.8419437, 5);
  });

  it('REAL M66 fitted frame center grades TRUE_POSITIVE against its label (0.36°, 1.6%)', () => {
    const seed = path.resolve(__dirname, '../../../tools/validation/truth/labels.json');
    const label = loadLabelsFile(seed).find((l) => l.frame_id === M66_LABEL_ID)!;
    const r = compareToTruth(M66_SOLVED, label);
    // The apples-to-apples proof: the solved center sits 0.36° off the OBJECT-RA/DEC
    // label (goto pointing) — NOT ~12° off like a bright-anchor center would be.
    expect(r.center_sep_deg!).toBeGreaterThan(0.2);
    expect(r.center_sep_deg!).toBeLessThan(0.5);
    expect(r.scale_err_frac!).toBeLessThan(0.05);
    expect(r.verdict).toBe('TRUE_POSITIVE');
  });

  it('a bright-anchor-style center (~12° off) would FALSE_POSITIVE — WHY the frame-center convention matters', () => {
    const anchorish: SolvedWcs = { ra_hours: 12.15, dec_degrees: 13.05, pixel_scale_arcsec: 3.6776 };
    const seed = path.resolve(__dirname, '../../../tools/validation/truth/labels.json');
    const label = loadLabelsFile(seed).find((l) => l.frame_id === M66_LABEL_ID)!;
    expect(compareToTruth(anchorish, label).verdict).toBe('FALSE_POSITIVE');
  });
});

describe('fits_solve · truth adjudication LIVE for FITS (frame-center raw)', () => {
  function fitsRaw(overrides: Partial<RunResult> = {}): RunResult {
    return {
      wall_ms: 1000, locked: true,
      ra: M66_SOLVED.ra_hours, dec: M66_SOLVED.dec_degrees,
      pixel_scale_arcsec: M66_SOLVED.pixel_scale_arcsec, matched: 272, budget_ms: 1000,
      // the FITS binding records the FRAME CENTER → adjudication is LIVE.
      provenance: { recorded_center_is_frame: true },
      ...overrides,
    };
  }
  const M66_TRUTH: TruthLabel = {
    frame_id: M66_LABEL_ID, source: 'fits_header',
    ra_hours: 11.36166687, dec_degrees: 12.8419437, pixel_scale_arcsec: 3.73854960875,
    provenance_note: 'test',
  };
  const noLock = extractSolverOutcome({ wall_ms: 1, locked: false });

  it('the FITS binding marks its recorded center as the frame center (guard passes)', () => {
    expect(recordedCenterIsFrameCenter(fitsRaw())).toBe(true);
  });

  it('M66 agreeing lock → TRUE_POSITIVE, no false positive (an honest lock)', () => {
    const adj = applyTruthToRunResult(fitsRaw(), M66_TRUTH);
    expect((adj.truth as { verdict: string }).verdict).toBe('TRUE_POSITIVE');
    expect(adj.false_positive).toBe(false);
  });

  it('a DISAGREEING FITS frame-center lock → new_false_positive (blocks graduation)', () => {
    const wrong = fitsRaw({ ra: 5.0, dec: -10.0 }); // wrong lock, far from truth
    const adj = applyTruthToRunResult(wrong, M66_TRUTH);
    expect(adj.false_positive).toBe(true);
    const delta = computeSolverDelta(noLock, extractSolverOutcome(adj));
    expect(delta.regressions).toContain('new_false_positive');
    expect(delta.improvements).not.toContain('new_verified_lock');
  });

  it('NO_TRUTH FITS frame → byte-identical grading (honest-absent)', () => {
    const raw = fitsRaw({ ra: 5.0, dec: -10.0 });
    const withNull = computeSolverDelta(noLock, extractSolverOutcome(applyTruthToRunResult(raw, null)));
    const without = computeSolverDelta(noLock, extractSolverOutcome(raw));
    expect(withNull).toEqual(without);
    expect(withNull.regressions).not.toContain('new_false_positive');
  });
});

// ── REGRESSION: the overnight bug — a COARSE-labelled FITS frame graded `no-truth` ──
// r_cc_M51_square08 solved (both arms) + IS present in labels.json as a COARSE label,
// yet the first graded overnight run scored it `no-truth`. ROOT CAUSE: the FITS-rail
// truth verdict is adjudicated inside the MERGE (written to fits_trials_detail.json +
// the ledger), NOT back into the raw arm JSON — but the driver read `raw.truth.verdict`
// off the raw arm file (undefined), so it kept the astrometry.net oracle's stale
// NO_SOLVE (the oracle can't solve a star-poor narrow field). The isolated resolveTruth
// unit test passed because it never traversed the driver→merge seam. This test DOES.
describe('fits_solve · COARSE truth surfaces END-TO-END through the driver/merge path (regression)', () => {
  const BUG_FRAME = 'r_cc_M51_square08-linearfit4-5_stars';
  const labelsFile = path.resolve(__dirname, '../../../tools/validation/truth/labels.json');
  // The REAL recorded frame center from the overnight raw arm result (_fits_raw/arm0).
  const raw: RunResult = {
    wall_ms: 6097, locked: true,
    ra: 13.500776783723637, dec: 47.20423936980351,
    pixel_scale_arcsec: 0.789909442220531, matched: 44, budget_ms: 6097,
    // the FITS binding records the FRAME CENTER → truth adjudication is LIVE.
    provenance: { recorded_center_is_frame: true },
  };

  it('the bug frame IS present in the tracked labels.json as a COARSE label (center tol 2°)', () => {
    const label = loadLabelsFile(labelsFile).find((l) => l.frame_id === BUG_FRAME);
    expect(label).toBeTruthy();
    expect(label!.tier).toBe('COARSE');
    expect(label!.tolerances?.center_deg).toBe(2);
  });

  it('the MERGE step adjudicates the labelled lock TRUE_POSITIVE / COARSE (guard passes)', async () => {
    expect(recordedCenterIsFrameCenter(raw)).toBe(true);
    const truth = await resolveTruth(BUG_FRAME, { labelsFile });
    expect(truth).toBeTruthy();
    const adj = applyTruthToRunResult(raw, truth); // what run_fits_sweep.merge writes to the detail
    const t = adj.truth as { verdict: string; tier: string | null };
    expect(t.verdict).toBe('TRUE_POSITIVE');
    expect(t.tier).toBe('COARSE');
  });

  it('the DRIVER surfaces the COARSE verdict + clears the stale oracle `no-truth` taxonomy', async () => {
    const truth = await resolveTruth(BUG_FRAME, { labelsFile });
    const adj = applyTruthToRunResult(raw, truth);
    const railDetail = { verdict: (adj.truth as { verdict: string }).verdict, tier: (adj.truth as { tier: string | null }).tier };
    // stage-2 astrometry.net NO_SOLVE'd this star-poor field → the driver arrived at no-truth.
    const rc = reconcileFitsTruth('NO_SOLVE', FAILURE.NO_TRUTH, railDetail);
    expect(rc.verdict).toBe('TRUE_POSITIVE');
    expect(rc.tier).toBe('COARSE');        // tier carried through verbatim — never conflated with GOLD
    expect(rc.taxonomy).toBe(FAILURE.OK);  // THE FIX: the frame has truth + was processed → not `no-truth`
  });

  it('honest-absent: no label (or no-lock) ⇒ the oracle verdict + taxonomy stand (byte-identical)', () => {
    expect(reconcileFitsTruth('NO_SOLVE', FAILURE.NO_TRUTH, null)).toEqual({
      verdict: 'NO_SOLVE', tier: null, taxonomy: FAILURE.NO_TRUTH,
    });
    // a locked-but-unlabelled frame the merge tags 'NO_TRUTH' is likewise honest-absent.
    expect(reconcileFitsTruth(null, FAILURE.NO_TRUTH, { verdict: 'NO_TRUTH', tier: null }).taxonomy)
      .toBe(FAILURE.NO_TRUTH);
  });

  it('never DOWNGRADES a real failure taxonomy (a solve-fail is preserved even with a rail verdict)', () => {
    const rc = reconcileFitsTruth('NO_SOLVE', FAILURE.SOLVE_FAIL, { verdict: 'TRUE_POSITIVE', tier: 'COARSE' });
    expect(rc.taxonomy).toBe(FAILURE.SOLVE_FAIL); // only a stale `no-truth` is cleared
    expect(rc.verdict).toBe('TRUE_POSITIVE');
  });
});

describe('psf-attribution validation · tracking inference vs KNOWN rig', () => {
  it('expectedTrackingForRig: SeeStar → TRACKED; known untracked CR2 → UNTRACKED; else UNKNOWN', () => {
    expect(expectedTrackingForRig('FITS_SEESTAR', 'ZWO Seestar S30 Pro')).toBe('TRACKED');
    expect(expectedTrackingForRig('FITS_SEESTAR', 'imx585')).toBe('TRACKED'); // cohort wins
    expect(expectedTrackingForRig('CR2_DSLR', 'Canon T6 + Rokinon 14mm')).toBe('UNTRACKED');
    // a DSLR that may ride a tracking EQ mount → NO assertion (honest-absent).
    expect(expectedTrackingForRig('FITS_OTHER', 'Canon EOS 60D')).toBe('UNKNOWN');
    expect(expectedTrackingForRig(null, null)).toBe('UNKNOWN');
  });

  it('word-boundary "t6": a Rebel T6i/T6s (DISTINCT body) is NOT the untracked T6 (flag #7)', () => {
    // The old `cam.includes('t6')` manufactured a spurious UNTRACKED verdict for
    // any 't6' fragment. Whole-token match: T6i/T6s → UNKNOWN, real T6 → UNTRACKED.
    expect(expectedTrackingForRig('CR2_DSLR', 'Canon EOS Rebel T6i')).toBe('UNKNOWN');
    expect(expectedTrackingForRig('CR2_DSLR', 'Canon EOS Rebel T6s')).toBe('UNKNOWN');
    expect(expectedTrackingForRig('CR2_DSLR', 'Canon EOS Rebel T6')).toBe('UNTRACKED');
  });

  it('readTrackingInference reads the block (honest-absent → null)', () => {
    expect(readTrackingInference({ tracking: { inference: 'TRACKED' } })).toBe('TRACKED');
    expect(readTrackingInference({ tracking: { inference: 'bogus' } })).toBeNull();
    expect(readTrackingInference(null)).toBeNull();
  });

  it('SeeStar inferring TRACKED → PASS (the expected result on a real SeeStar frame)', () => {
    const v = validateTrackingInference({ tracking: { inference: 'TRACKED' } }, 'TRACKED');
    expect(v.status).toBe('PASS');
    expect(v.inferred).toBe('TRACKED');
  });

  it('SeeStar inferring UNTRACKED → FAIL (contradicts the tracking mount)', () => {
    const v = validateTrackingInference({ tracking: { inference: 'UNTRACKED' } }, 'TRACKED');
    expect(v.status).toBe('FAIL');
  });

  it('indeterminate / unmeasured inference → INCONCLUSIVE (never a fabricated FAIL)', () => {
    expect(validateTrackingInference({ tracking: { inference: 'INDETERMINATE' } }, 'TRACKED').status).toBe('INCONCLUSIVE');
    expect(validateTrackingInference({ tracking: { inference: 'NOT_MEASURED' } }, 'TRACKED').status).toBe('INCONCLUSIVE');
    expect(validateTrackingInference(null, 'TRACKED').status).toBe('INCONCLUSIVE');
  });

  it('unknown rig → NO_EXPECTATION (skipped, never a guessed verdict)', () => {
    expect(validateTrackingInference({ tracking: { inference: 'TRACKED' } }, 'UNKNOWN').status).toBe('NO_EXPECTATION');
  });
});

describe('psf-attribution validation · diffraction-floor consistency', () => {
  it('measured min-axis ≥ floor → CONSISTENT', () => {
    const c = checkDiffractionFloor({ decomposition: { measuredMinPx: 2.5, diffractionFloorPx: 1.0 } });
    expect(c.status).toBe('CONSISTENT');
    expect(c.ratio).toBeCloseTo(2.5, 3);
  });

  it('measured min-axis BELOW the floor → VIOLATION (physically impossible)', () => {
    const c = checkDiffractionFloor({ decomposition: { measuredMinPx: 0.5, diffractionFloorPx: 1.0 } });
    expect(c.status).toBe('VIOLATION');
  });

  it('absent measurement or floor → NOT_MEASURED (honest-absent)', () => {
    expect(checkDiffractionFloor({ decomposition: { measuredMinPx: null, diffractionFloorPx: 1.0 } }).status).toBe('NOT_MEASURED');
    expect(checkDiffractionFloor(null).status).toBe('NOT_MEASURED');
  });
});

describe('psf-attribution validation · combined adjudication (SeeStar frame)', () => {
  const seestarBlock = {
    tracking: { inference: 'TRACKED', tier: 'INFERRED' },
    decomposition: { measuredMinPx: 2.4, measuredMajPx: 2.5, diffractionFloorPx: 0.6 },
  };

  it('a real SeeStar block (TRACKED + measured ≥ floor) → pass, tracking PASS', () => {
    const a = adjudicatePsfAttribution({ frame_id: 'm66', block: seestarBlock, cohort: 'FITS_SEESTAR', camera: 'ZWO Seestar S30 Pro' });
    expect(a.expected_tracking).toBe('TRACKED');
    expect(a.tracking.status).toBe('PASS');
    expect(a.floor.status).toBe('CONSISTENT');
    expect(a.pass).toBe(true);
    expect(a.inconclusive).toBe(false);
  });

  it('a SeeStar block inferring UNTRACKED → pass=false (tracking FAIL)', () => {
    const bad = { ...seestarBlock, tracking: { inference: 'UNTRACKED' } };
    const a = adjudicatePsfAttribution({ frame_id: 'm66', block: bad, cohort: 'FITS_SEESTAR' });
    expect(a.tracking.status).toBe('FAIL');
    expect(a.pass).toBe(false);
  });

  it('a null block (attribution did not run) → inconclusive, never a fabricated fail', () => {
    const a = adjudicatePsfAttribution({ frame_id: 'x', block: null, cohort: 'FITS_SEESTAR' });
    expect(a.pass).toBe(true); // honest-absent does not fail
    expect(a.tracking.status).toBe('INCONCLUSIVE');
    expect(a.floor.status).toBe('NOT_MEASURED');
    expect(a.inconclusive).toBe(true);
  });
});
