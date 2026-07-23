// ═══════════════════════════════════════════════════════════════════════════
// GROUND-TRUTH SCHEMA for the Validation & Graduation Harness
// (spec: docs/VALIDATION_HARNESS.md · Enhancement 1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Turns the calibrated arbiter's "verifyWCS passed" into a TRUE_POSITIVE vs
// FALSE_POSITIVE verdict by comparing the verify-passing candidate WCS against a
// per-frame ground-truth label. This file is the VOCABULARY: the truth record,
// its provenance, the astrometry.net ingestion shape, and the comparison
// tolerances. Pure, headless, zero calibrated-path dependency — same law as the
// rest of tools/validation/.
//
// HONEST-OR-ABSENT: a frame with no label resolves to NO_TRUTH; a truth with no
// measured scale carries `pixel_scale_arcsec: null` (center-only truth). We
// never fabricate a number we do not have.

// ─── Truth provenance ────────────────────────────────────────────────────────
/**
 * Where a truth label came from — ordered roughly by independence/strength:
 * - `astrometry.net` : an INDEPENDENT blind solve (the gold standard once we
 *   have one — forward-compatible today, see `fromAstrometryNet`).
 * - `fits_header`    : CRVAL/RA/DEC + optics from the capture software's header
 *   (goto pointing + nominal focal-length scale — APPROXIMATE for scale).
 * - `bundled_known`  : a frame whose answer is pinned in the repo (the bundled
 *   CR2, anchored to a brute-forced ground truth).
 * - `pipeline_bootstrapped` : our own confirmed solve reused as truth (weakest —
 *   circular; use only when explicitly cross-checked, never to grade itself).
 */
export type TruthSource =
  | 'fits_header'
  | 'astrometry_net'
  | 'bundled_known'
  | 'pipeline_bootstrapped';

/** Verdict of a solved WCS vs a truth label (or the absence of truth). */
export type TruthVerdict = 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'NO_TRUTH';

/**
 * Adjudication TRUST TIER — a SECOND axis, orthogonal to `source` (which records
 * WHERE the coordinate numbers came from). The tier records HOW MUCH we trust a
 * label to arbitrate a solve, so a verdict is never silently conflated across tiers:
 *
 * - `GOLD`   : an INDEPENDENT / corroborated truth — an astrometry.net blind solve,
 *   a repo-pinned brute-forced answer (the bundled CR2), or a goto pointing that has
 *   been cross-checked against such an oracle (SeeStar M66, agrees to 0.079° — see
 *   MEMORY astrometry-truth-oracle-state). GOLD adjudicates at the TIGHT default
 *   tolerance and IS the trusted science bar.
 * - `COARSE` : a mount GOTO pointing straight off the capture/stacking header
 *   (FITS OBJECT RA/DEC, or a stacking-software CRVAL) with NO independent
 *   cross-check. The goto is good to ~1° — far more than enough to catch a gross
 *   mislock (a wrong lock lands ≫5° off-center) but NOT a trusted science product.
 *   COARSE adjudicates at a LOOSENED tolerance so a genuine near-boundary solve is
 *   not flipped to a false FALSE_POSITIVE.
 *
 * LAW 2 ("gates never lowered — evidence added"): COARSE is ADDED evidence at its
 * own honest tier; it NEVER relaxes the GOLD bar. A frame with neither stays NO_TRUTH.
 */
export type TruthTier = 'GOLD' | 'COARSE';

/**
 * Agreement window a solved WCS must fall inside to count as TRUE_POSITIVE.
 * A check whose truth value is absent (e.g. no rotation in a FITS header) is
 * SKIPPED, never failed — honest-or-absent applies per-axis.
 */
export interface TruthTolerances {
  /** Max center angular separation (great-circle degrees). */
  center_deg: number;
  /** Max fractional scale error |Δscale| / truth_scale. */
  scale_frac: number;
  /** Max rotation error (degrees, parity-aware — see compare.ts). */
  rotation_deg: number;
}

/**
 * DEFAULT tolerances (rationale in docs/VALIDATION_HARNESS.md · Enh1):
 * - center 1.0° : ≥3× margin over the largest HONEST pointing offset we have
 *   measured (bundled CR2 0.2–0.3° vs brute-forced truth; SeeStar goto ~0.3°),
 *   while a WRONG lock lands ≫5° off-center. Center is the strongest FP tell.
 * - scale 5%    : absorbs the nominal-focal-length approximation (SeeStar M66
 *   header-derived scale is ~1.7% off the solved value) and the CR2's 0.2%,
 *   while a wrong-scale lock is off ≫20%. A CD-matrix/astrometry.net truth can
 *   override this tighter per-label.
 * - rotation 5° : GENEROUS on purpose — parity/rotation conventions are
 *   treacherous ("Parity … Do not assert sign", CLAUDE.md) and rotation truth is
 *   frequently absent. When absent the axis is skipped entirely.
 */
export const DEFAULT_TOLERANCES: TruthTolerances = {
  center_deg: 1.0,
  scale_frac: 0.05,
  rotation_deg: 5.0,
};

/**
 * COARSE-tier base tolerances (goto pointing). The SeeStar mount goto is good to
 * ~1° (M66's OBJECT card sits 0.36° off the wizard-fitted center, ~1° off the
 * astrometry.net oracle), uncomfortably close to the tight 1.0° default — so COARSE
 * LOOSENS the center window to 2.0° to avoid flipping a genuine near-boundary solve
 * to a false FALSE_POSITIVE, while staying ≪5° (a gross mislock is still caught).
 * Scale stays the 5% band (the nominal-focal-length header scale is APPROXIMATE),
 * rotation stays generous. NOT a rubber-stamp: a lock >2° off-center still fails.
 */
export const COARSE_TOLERANCES: TruthTolerances = {
  center_deg: 2.0,
  scale_frac: 0.05,
  rotation_deg: 5.0,
};

// ─── The truth label ─────────────────────────────────────────────────────────
/**
 * One frame's ground truth. Internal-unit convention matches the solve
 * machinery: RA in HOURS, DEC in DEGREES (degrees-at-the-FITS-boundary is
 * converted on ingest, never stored raw). `pixel_scale_arcsec` is nullable
 * (center-only truth); rotation/parity are optional (frequently unknown).
 */
export interface TruthLabel {
  /** Frame identity — MUST match the harness's input_id / distilled `frame`. */
  frame_id: string;
  source: TruthSource;
  /** RA of the frame center, HOURS (internal convention). */
  ra_hours: number;
  /** DEC of the frame center, DEGREES. */
  dec_degrees: number;
  /** Plate scale, arcsec/px. `null` ⇒ center-only truth (honest-absent). */
  pixel_scale_arcsec: number | null;
  /** Field rotation, degrees. Optional — often unknown from a header. */
  rotation_deg?: number;
  /** Handedness: +1 or −1. Optional; sign conventions vary, treat leniently. */
  parity?: 1 | -1;
  /** Human-readable trail: exactly how this truth was obtained. */
  provenance_note: string;
  /** ISO timestamp the label was generated (DATA — never control flow). */
  generated_at?: string;
  /**
   * Adjudication trust tier (see TruthTier). Explicit when a label's tier is not
   * the source default (a goto pointing cross-checked to an oracle is GOLD; a raw
   * goto is COARSE). Absent ⇒ derived from `source` by `tierOf`.
   */
  tier?: TruthTier;
  /** Per-label tolerance override (else tier/global defaults apply). */
  tolerances?: Partial<TruthTolerances>;
  /**
   * The frame's content SHA-256 (hex) — the PER-IMAGE identity key. A measured
   * hint bound to this hash (e.g. the measured-scale hint provider,
   * src/engine/core/scale_hint_provider.ts) is delivered ONLY to a frame whose
   * bytes match; it NEVER propagates by camera body/model (owner law
   * 2026-07-09: "people put different lenses on different cameras"). Absent ⇒ the
   * label cannot seed a content-hash hint (honest-absent). Same hash the ingest
   * source-provenance keys on (m1_ingestion/source_provenance.ts).
   */
  content_sha256?: string;
}

/**
 * The adjudication TIER for a label: an explicit `tier` wins; else it is derived
 * from `source`. Independent/pinned sources (astrometry.net, the brute-forced
 * bundled answer) are GOLD; a raw capture-header goto/CRVAL (`fits_header`) is
 * COARSE by default — a `fits_header` label only reaches GOLD by carrying an
 * explicit `tier: 'GOLD'` (i.e. it was cross-checked against an oracle).
 */
export function tierOf(label: TruthLabel): TruthTier {
  if (label.tier === 'GOLD' || label.tier === 'COARSE') return label.tier;
  return label.source === 'astrometry_net' || label.source === 'bundled_known'
    ? 'GOLD'
    : 'COARSE';
}

/** Base tolerances a tier adjudicates at (a label's own `tolerances` override this). */
export function baseTolerancesForTier(tier: TruthTier): TruthTolerances {
  return tier === 'COARSE' ? COARSE_TOLERANCES : DEFAULT_TOLERANCES;
}

/** On-disk labels file: either a bare array or `{ labels: [...] }`. */
export interface TruthLabelsFile {
  /** Optional schema tag for forward migrations. */
  schema?: string;
  labels: TruthLabel[];
}

// ─── astrometry.net FORWARD-COMPAT ingestion ─────────────────────────────────
// We have NO astrometry.net solves yet. This is designed so dropping one in
// LATER "just works". astrometry.net emits truth in two interchangeable shapes:
//
// (1) A `.wcs` / `wcs.fits` FITS header (its solve-field product). Expected cards:
//        CTYPE1 = 'RA---TAN' / CTYPE2 = 'DEC--TAN'
//        CRVAL1 =  <ra_deg>          CRVAL2 =  <dec_deg>
//        CRPIX1 =  <x>               CRPIX2 =  <y>            (1-based)
//        CD1_1 CD1_2 CD2_1 CD2_2     <deg/px>  (may instead be CDELT1/2 + CROTA2)
//     → map with `fromAstrometryNetWcs`.
//
// (2) The API job `calibration` JSON (GET /api/jobs/<id>/calibration/):
//        { "ra": <deg>, "dec": <deg>, "radius": <deg>,
//          "pixscale": <arcsec/px>, "orientation": <deg>, "parity": 1.0 | -1.0 }
//     → map with `fromAstrometryNetCalibration`.
//
// Both funnel into the SAME `TruthLabel` (source: 'astrometry_net').

/** astrometry.net `.wcs` FITS-header WCS (CD-matrix form). */
export interface AstrometryNetWcs {
  /** CRVAL1 — RA in DEGREES (FITS-boundary units). */
  crval1_deg: number;
  /** CRVAL2 — DEC in DEGREES. */
  crval2_deg: number;
  /** CD matrix (deg/px): [CD1_1, CD1_2, CD2_1, CD2_2]. */
  cd: [number, number, number, number];
}

/** astrometry.net API `calibration` blob. */
export interface AstrometryNetCalibration {
  /** RA in DEGREES. */
  ra: number;
  /** DEC in DEGREES. */
  dec: number;
  /** Plate scale, arcsec/px. */
  pixscale: number;
  /** Field orientation, degrees (up-angle; convention documented, treated leniently). */
  orientation?: number;
  /** +1 (normal) / −1 (flipped). astrometry.net emits 1.0 / −1.0. */
  parity?: number;
}

const RAD = Math.PI / 180;

/** Ingest an astrometry.net `.wcs` FITS-header WCS into a TruthLabel. */
export function fromAstrometryNetWcs(
  wcs: AstrometryNetWcs,
  frameId: string,
  extra: { provenance_note?: string; generated_at?: string; tolerances?: Partial<TruthTolerances> } = {},
): TruthLabel {
  const [cd11, cd12, cd21, cd22] = wcs.cd;
  // scale = sqrt(|det CD|) · 3600 — rotation/parity-robust plate scale.
  const det = cd11 * cd22 - cd12 * cd21;
  const pixel_scale_arcsec = Math.sqrt(Math.abs(det)) * 3600;
  // rotation from the CD matrix (convention-dependent → treated leniently, and
  // rotation tolerance is generous). atan2(CD2_1, CD1_1) is one standard form.
  const rotation_deg = normalize360((Math.atan2(cd21, cd11) / RAD));
  // astrometry.net "positive" parity ↔ det(CD) < 0 (RA east-to-the-left with
  // north up). Recorded, but sign is NEVER asserted downstream (parity-aware
  // rotation compare tolerates a wrong sign).
  const parity: 1 | -1 = det < 0 ? 1 : -1;
  return {
    frame_id: frameId,
    source: 'astrometry_net',
    ra_hours: wcs.crval1_deg / 15,
    dec_degrees: wcs.crval2_deg,
    pixel_scale_arcsec,
    rotation_deg,
    parity,
    provenance_note: extra.provenance_note ?? 'astrometry.net .wcs (CD matrix)',
    generated_at: extra.generated_at,
    tolerances: extra.tolerances,
  };
}

/** Ingest an astrometry.net API `calibration` blob into a TruthLabel. */
export function fromAstrometryNetCalibration(
  cal: AstrometryNetCalibration,
  frameId: string,
  extra: {
    provenance_note?: string;
    generated_at?: string;
    tolerances?: Partial<TruthTolerances>;
    /** Frame content SHA-256 (hex) — the per-IMAGE key for a content-hash hint. */
    content_sha256?: string;
  } = {},
): TruthLabel {
  const label: TruthLabel = {
    frame_id: frameId,
    source: 'astrometry_net',
    ra_hours: cal.ra / 15,
    dec_degrees: cal.dec,
    pixel_scale_arcsec: typeof cal.pixscale === 'number' ? cal.pixscale : null,
    provenance_note: extra.provenance_note ?? 'astrometry.net API calibration',
    generated_at: extra.generated_at,
    tolerances: extra.tolerances,
  };
  if (typeof cal.orientation === 'number') label.rotation_deg = normalize360(cal.orientation);
  if (cal.parity === 1 || cal.parity === -1) label.parity = cal.parity;
  if (typeof extra.content_sha256 === 'string' && extra.content_sha256) {
    label.content_sha256 = extra.content_sha256;
  }
  return label;
}

/** Normalize an angle to [0, 360). */
export function normalize360(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}
