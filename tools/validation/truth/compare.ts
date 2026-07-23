// ═══════════════════════════════════════════════════════════════════════════
// WCS COMPARISON — solved-vs-truth → TRUE_POSITIVE | FALSE_POSITIVE | NO_TRUTH
// (spec: docs/VALIDATION_HARNESS.md · Enhancement 1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Operates on the VERIFY-PASSING candidate WCS (crval center + optional
// scale/rotation/parity) — it does NOT require the finalized WCS. Pure and
// deterministic: no Date.now / Math.random, no I/O. The verdict is a mechanical
// function of the tolerances (honest-or-absent per-axis: an unmeasured axis is
// SKIPPED, never failed).

import {
  DEFAULT_TOLERANCES,
  baseTolerancesForTier,
  tierOf,
  normalize360,
  type TruthLabel,
  type TruthTolerances,
  type TruthVerdict,
} from './schema.ts';

const RAD = Math.PI / 180;

/** The solved geometry to grade — the verify-passing candidate WCS. */
export interface SolvedWcs {
  /** RA of the solved center, HOURS. */
  ra_hours: number;
  /** DEC of the solved center, DEGREES. */
  dec_degrees: number;
  /** Solved plate scale, arcsec/px (null/undefined ⇒ scale check skipped). */
  pixel_scale_arcsec?: number | null;
  /** Solved rotation, degrees (null/undefined ⇒ rotation check skipped). */
  rotation_deg?: number | null;
  /** Solved parity (used only to disambiguate the parity-aware rotation check). */
  parity?: 1 | -1 | null;
}

/** Full comparison detail — the audit trail behind the verdict. */
export interface ComparisonResult {
  verdict: TruthVerdict;
  /** Great-circle center separation (deg), or null if not computable. */
  center_sep_deg: number | null;
  /** Fractional scale error, or null if either scale absent. */
  scale_err_frac: number | null;
  /** Parity-aware rotation error (deg), or null if either rotation absent. */
  rotation_err_deg: number | null;
  /** The tolerances actually applied (label override merged over defaults). */
  tolerances: TruthTolerances;
  /** Which check(s) FAILED (empty ⇒ TRUE_POSITIVE within all applicable axes). */
  reasons: string[];
}

/**
 * Great-circle angular separation (DEGREES) between two sky points.
 * RA in HOURS (×15 → deg). Haversine — stable at small separations.
 */
export function angularSeparationDeg(
  raHoursA: number,
  decDegA: number,
  raHoursB: number,
  decDegB: number,
): number {
  const ra1 = raHoursA * 15 * RAD;
  const ra2 = raHoursB * 15 * RAD;
  const dec1 = decDegA * RAD;
  const dec2 = decDegB * RAD;
  const dRa = ra2 - ra1;
  const dDec = dec2 - dec1;
  const h =
    Math.sin(dDec / 2) ** 2 +
    Math.cos(dec1) * Math.cos(dec2) * Math.sin(dRa / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / RAD;
}

/** Smallest circular difference between two angles (deg), in [0, 180]. */
export function circularDiffDeg(a: number, b: number): number {
  const d = Math.abs(normalize360(a) - normalize360(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Parity-aware rotation error (deg). A mirror flip (parity mismatch) maps a
 * rotation θ → −θ, so:
 *  - both parities known & EQUAL     → direct circular diff.
 *  - both parities known & DIFFERENT → compare against the mirrored truth (−rot).
 *  - parity unknown on either side   → return MIN(direct, mirrored): we cannot
 *    tell handedness apart, so grade leniently (never flag a FALSE_POSITIVE on a
 *    sign convention we refuse to assert — see CLAUDE.md parity trap).
 * Returns null when either rotation is absent (axis skipped).
 */
export function rotationErrorDeg(
  solvedRot: number | null | undefined,
  truthRot: number | undefined,
  solvedParity?: 1 | -1 | null,
  truthParity?: 1 | -1,
): number | null {
  if (solvedRot == null || truthRot == null) return null;
  const direct = circularDiffDeg(solvedRot, truthRot);
  const mirrored = circularDiffDeg(solvedRot, -truthRot);
  if ((solvedParity === 1 || solvedParity === -1) && (truthParity === 1 || truthParity === -1)) {
    return solvedParity === truthParity ? direct : mirrored;
  }
  return Math.min(direct, mirrored);
}

/**
 * Merge tolerances for a label: the label's TIER sets the base window (GOLD ⇒ tight
 * DEFAULT_TOLERANCES, COARSE ⇒ loosened COARSE_TOLERANCES), then the label's own
 * per-axis `tolerances` override it, then a caller `override` wins last. A null
 * truth (NO_TRUTH) has no tier ⇒ the tight default (never used to fail — the caller
 * short-circuits NO_TRUTH before comparing).
 */
export function resolveTolerances(
  truth: TruthLabel | null,
  override?: Partial<TruthTolerances>,
): TruthTolerances {
  const base = truth ? baseTolerancesForTier(tierOf(truth)) : DEFAULT_TOLERANCES;
  return {
    ...base,
    ...(truth?.tolerances ?? {}),
    ...(override ?? {}),
  };
}

/**
 * Grade a solved WCS against a truth label.
 *   truth === null           → NO_TRUTH (honest-absent; never a guessed verdict).
 *   center OR scale OR rot    → any measured axis OUT of tolerance → FALSE_POSITIVE.
 *   all measured axes in-tol  → TRUE_POSITIVE.
 * Unmeasured axes (null truth scale, absent rotation) are SKIPPED, not failed.
 */
export function compareToTruth(
  solved: SolvedWcs,
  truth: TruthLabel | null,
  override?: Partial<TruthTolerances>,
): ComparisonResult {
  const tolerances = resolveTolerances(truth, override);
  if (!truth) {
    return {
      verdict: 'NO_TRUTH',
      center_sep_deg: null,
      scale_err_frac: null,
      rotation_err_deg: null,
      tolerances,
      reasons: [],
    };
  }

  const reasons: string[] = [];

  // ── center (always available on both sides) ──
  const center_sep_deg = angularSeparationDeg(
    solved.ra_hours,
    solved.dec_degrees,
    truth.ra_hours,
    truth.dec_degrees,
  );
  if (center_sep_deg > tolerances.center_deg) {
    reasons.push(`center ${center_sep_deg.toFixed(3)}° > ${tolerances.center_deg}°`);
  }

  // ── scale (skip if either side lacks it) ──
  let scale_err_frac: number | null = null;
  if (
    typeof solved.pixel_scale_arcsec === 'number' &&
    solved.pixel_scale_arcsec > 0 &&
    typeof truth.pixel_scale_arcsec === 'number' &&
    truth.pixel_scale_arcsec > 0
  ) {
    scale_err_frac = Math.abs(solved.pixel_scale_arcsec - truth.pixel_scale_arcsec) / truth.pixel_scale_arcsec;
    if (scale_err_frac > tolerances.scale_frac) {
      reasons.push(`scale ${(scale_err_frac * 100).toFixed(2)}% > ${(tolerances.scale_frac * 100).toFixed(2)}%`);
    }
  }

  // ── rotation (parity-aware; skip if either side lacks it) ──
  const rotation_err_deg = rotationErrorDeg(
    solved.rotation_deg,
    truth.rotation_deg,
    solved.parity,
    truth.parity,
  );
  if (rotation_err_deg != null && rotation_err_deg > tolerances.rotation_deg) {
    reasons.push(`rotation ${rotation_err_deg.toFixed(2)}° > ${tolerances.rotation_deg}°`);
  }

  return {
    verdict: reasons.length === 0 ? 'TRUE_POSITIVE' : 'FALSE_POSITIVE',
    center_sep_deg,
    scale_err_frac,
    rotation_err_deg,
    tolerances,
    reasons,
  };
}
