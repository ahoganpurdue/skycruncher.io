// ═══════════════════════════════════════════════════════════════════════════
// LENS DISTORTION — Brown-Conrady coordinate functions (COORDINATE ledger)
// ═══════════════════════════════════════════════════════════════════════════
// NEXT_MOVES §8 (lens-prior distortion correction, the 14mm-gauntlet lever).
//
// TWO-LEDGER LAW: this is a COORDINATE-space transform of sparse detection
// POINTS — NOT an image-space pixel resample. It moves star POSITIONS so a
// barrel-warped ("mustache") frame's asterism CODE lines up with the
// rectilinear catalog projection BEFORE quad/code formation and the anchored
// sweep. The ORIGINAL native pixel coordinates are kept for photometry; only
// the MATCHING coordinates get undistorted here.
//
// DELIBERATE INCUBATOR DUPLICATION (CLAUDE.md LAW 4): the math below is a
// faithful port of the verified prototype in `tools/psf/corrections.mjs`
// (`makeBrownConrady`). The tool lane stays the fast-iteration incubator + CLI
// driver; this engine module is the ported, module-seam consumer used by the
// live solve path. Keep the two in sync when the model changes.
//
// MODEL (matches corrections.mjs exactly):
//   r normalized to the HALF-DIAGONAL; optical center assumed at frame center.
//   Native (as-captured, distorted) radius r_d relates to corrected
//   (rectilinear, undistorted) radius r_u by
//     r_d = r_u * (1 + k1 r_u^2 + k2 r_u^4).
//   Forward (corrected → native) is a direct evaluation; the inverse
//   (native → corrected — what the solve path needs) has no closed form, so it
//   is solved by a 10-iteration radial fixed point.
//
// RADIAL ONLY (k1, k2). The tangential decentering terms p1/p2 carried by
// `DistortionCoeffs` are intentionally NOT applied: the incubator prototype is
// radial-only (no clean radial fixed-point inverse exists with tangential
// terms), and the lever's target — ROKINON_14_MUSTACHE — has p1 = p2 = 0, so
// the port is EXACT for it. Lenses whose p1/p2 are non-zero (all ≤ 2e-4 in
// LENS_DB) are approximated by their radial part; the nominal prior is
// APPROXIMATE by design and is later superseded by an LM/SIP refit from real
// matched pairs (M7). Honest-or-absent: this limitation is documented, not
// silently swallowed.

import type { DistortionCoeffs, LensProfile } from './lens_profiles';
import { LENS_DB, findLensByModel } from './lens_profiles';

/** A coordinate-space distortion model over a fixed frame geometry. */
export interface LensDistortionModel {
  readonly model: 'brown-conrady' | 'identity';
  readonly k1: number;
  readonly k2: number;
  /** Optical center (frame center) in pixels. */
  readonly cx: number;
  readonly cy: number;
  /** Half-diagonal in pixels — the radial normalization length. */
  readonly halfDiagPx: number;
  /** corrected → native (distorted): direct radial evaluation. out = [xn, yn]. */
  toNative(xc: number, yc: number, out: [number, number]): [number, number];
  /** native (distorted) → corrected (undistorted): radial fixed-point inverse. */
  toCorrected(xn: number, yn: number, out: [number, number]): [number, number];
  /** displacement |native − corrected| in px at normalized radius r∈[0,1]. */
  shiftAt(r: number): number;
}

/**
 * Build the Brown-Conrady radial coordinate functions for a frame of size
 * w×h with the given k1/k2 (r normalized to the half-diagonal, center = frame
 * center). Faithful port of `tools/psf/corrections.mjs::makeBrownConrady`.
 */
export function makeBrownConradyDistortion(
  k1: number,
  k2: number,
  w: number,
  h: number,
): LensDistortionModel {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const hd = Math.hypot(cx, cy);
  const invHd = 1 / hd;

  const toNative = (xc: number, yc: number, out: [number, number]): [number, number] => {
    const nx = (xc - cx) * invHd;
    const ny = (yc - cy) * invHd;
    const r2 = nx * nx + ny * ny;
    const f = 1 + k1 * r2 + k2 * r2 * r2;
    out[0] = cx + nx * f * hd;
    out[1] = cy + ny * f * hd;
    return out;
  };

  const toCorrected = (xn: number, yn: number, out: [number, number]): [number, number] => {
    const dx = (xn - cx) * invHd;
    const dy = (yn - cy) * invHd;
    const rd = Math.hypot(dx, dy);
    let ru = rd;
    for (let i = 0; i < 10; i++) {
      const f = 1 + k1 * ru * ru + k2 * ru * ru * ru * ru;
      ru = f > 1e-6 ? rd / f : rd;
    }
    const s = rd > 1e-12 ? ru / rd : 1;
    out[0] = cx + dx * s * hd;
    out[1] = cy + dy * s * hd;
    return out;
  };

  const shiftAt = (r: number): number => {
    const f = 1 + k1 * r * r + k2 * r * r * r * r;
    return Math.abs(1 - f) * r * hd;
  };

  return { model: 'brown-conrady', k1, k2, cx, cy, halfDiagPx: hd, toNative, toCorrected, shiftAt };
}

/** Identity coordinate model — the NO-OP used when no lens profile resolves. */
export function makeIdentityDistortion(w: number, h: number): LensDistortionModel {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const id = (x: number, y: number, out: [number, number]): [number, number] => {
    out[0] = x;
    out[1] = y;
    return out;
  };
  return {
    model: 'identity',
    k1: 0,
    k2: 0,
    cx,
    cy,
    halfDiagPx: Math.hypot(cx, cy),
    toNative: id,
    toCorrected: id,
    shiftAt: () => 0,
  };
}

/**
 * Interpolate distortion coefficients for a focal length that may fall between
 * a zoom lens's sampled values. Mirrors `lens_profiles.ts::interpolateVignette`
 * (same clamp-and-linear-blend shape) for the distortion table.
 *
 * NOTE: unlike interpolateVignette, this does NOT sort `profile.focal_lengths`
 * in place — it sorts a copy, so the shared LENS_DB is never mutated.
 */
export function interpolateDistortion(
  profile: LensProfile,
  focalLength: number,
): DistortionCoeffs {
  const fls = [...profile.focal_lengths].sort((a, b) => a - b);

  // Exact match
  if (profile.distortion[focalLength]) return profile.distortion[focalLength];

  // Clamp to bounds
  if (focalLength <= fls[0]) return profile.distortion[fls[0]];
  if (focalLength >= fls[fls.length - 1]) return profile.distortion[fls[fls.length - 1]];

  // Linear interpolation between the two nearest sampled focal lengths
  for (let i = 0; i < fls.length - 1; i++) {
    if (focalLength >= fls[i] && focalLength <= fls[i + 1]) {
      const t = (focalLength - fls[i]) / (fls[i + 1] - fls[i]);
      const a = profile.distortion[fls[i]];
      const b = profile.distortion[fls[i + 1]];
      return {
        k1: a.k1 + t * (b.k1 - a.k1),
        k2: a.k2 + t * (b.k2 - a.k2),
        k3: (a.k3 ?? 0) + t * ((b.k3 ?? 0) - (a.k3 ?? 0)),
        p1: a.p1 + t * (b.p1 - a.p1),
        p2: a.p2 + t * (b.p2 - a.p2),
      };
    }
  }

  return profile.distortion[fls[0]]; // Fallback
}

// ─── LENS RESOLUTION LADDER ──────────────────────────────────────────────────
// NEXT_MOVES §8: resolve a distortion profile ONLY from evidence we trust —
// an explicit user hint (manual glass) or a TRUSTED EXIF LensModel matching
// LENS_DB. Returns a NO-OP (null) for a placeholder/untrusted/lying EXIF so the
// prior stays OFF by default (byte-identical-by-construction guarantee).
//
// LYING-EXIF LANDMINE (CLAUDE.md): the bundled CR2 carries `focal_length = 50`
// (a factory-default LIE; the real lens is a 14mm Rokinon) with NO LensModel →
// normalized to the truthy placeholder `'Unknown Lens'`. This resolver keys on
// the LENS MODEL (or a user hint), never on the focal-length value, and rejects
// the placeholder via the SAME guard optics_manager uses. It must return null
// for the bundled CR2 — proven in the unit tests + logged at solve time.

/** Structural subset of `HardMetadata` this resolver reads. */
export interface LensResolutionMetadata {
  /** EXIF lens model, or the truthy placeholder 'Unknown'/'Unknown Lens'. */
  lens_model?: string;
  /** EXIF focal length (mm) — MAY be a lying factory default (e.g. 50). */
  focal_length?: number;
  /** User focal-length hint (mm) — the top trust rung for focal length. */
  focal_length_hint_mm?: number;
}

/**
 * RUNG-0 candidate: a MEASURED distortion profile resolved by the optical-train
 * fingerprint (SHA256(camera+lens+filter)) from the Optical-Workbench store. When
 * present (only ever passed when SOLVER_IDENTITY_PROFILE is ON and the store held
 * a measured profile for the frame's train), it is the TOP rung — `resolveLens
 * Distortion` returns it before consulting the LENS_DB/EXIF rungs, realizing the
 * Feb spec's "skips generic DB lookups". Constructed OUTSIDE this resolver
 * (workbench_store `resolveIdentityProfile`) so this module stays store-neutral.
 */
export interface IdentityDistortionProfile {
  /** Measured k1 (pooled median for the train). */
  k1: number;
  /** Measured k2 (0 when the train only ever fitted radial k1). */
  k2: number;
  /** The optical-train hash this profile is keyed to (auditability). */
  trainHash: string;
  /** Human lens label for the receipt (the identity's lens string). */
  lensModel?: string;
  /** Focal length (mm) the profile applies at (context; coeffs are already fixed). */
  focalLength?: number;
}

/** Explicit user hint for manual glass (interactive lens selection). */
export interface LensDistortionHint {
  /** Exact LENS_DB key (e.g. 'ROKINON_14_MUSTACHE'), preferred if known. */
  lensKey?: string;
  /** Free-text lens model → findLensByModel (case-insensitive substring). */
  lensModel?: string;
  /** Focal length (mm) to interpolate coeffs at; else falls back to metadata / lens default. */
  focalLength?: number;
}

/** A resolved distortion prior. `null` return means NO profile (identity/no-op). */
export interface LensDistortionResolution {
  k1: number;
  k2: number;
  coeffs: DistortionCoeffs;
  /**
   * Origin of the prior. `USER_HINT`/`EXIF_TRUSTED` are the two LENS_DB-backed
   * rungs resolved by `resolveLensDistortion`. `WORKBENCH_POOLED` is a run-time
   * prior seeded by the session from ≥3 agreeing same-rig Optical-Workbench
   * deposits (SOLVER_WORKBENCH_PRIOR, default OFF) — it is MEASURED-pooled, not
   * a library nominal, and is constructed OUTSIDE this resolver (workbench_store
   * `poolWorkbenchPrior`), then injected on the SolveContext. `lensKey` carries
   * the sentinel `WORKBENCH_POOLED` for that arm (no LENS_DB row backs it).
   *
   * `measured:identity` is RUNG-0 — the optical-train-fingerprint match (Feb-2026
   * spec: "If a user previously calibrated this setup, it skips generic DB
   * lookups"). When the frame's SHA256(camera+lens+filter) train hash resolves to
   * a MEASURED profile in the Optical-Workbench store, that profile is used
   * DIRECTLY and the generic LENS_DB/EXIF rungs are SKIPPED. It is the TOP rung
   * (above USER_HINT/EXIF), gated by SOLVER_IDENTITY_PROFILE (default OFF). Like
   * WORKBENCH_POOLED it is MEASURED, not a library nominal; `lensKey` carries the
   * sentinel `measured:identity`.
   */
  provenance: 'USER_HINT' | 'EXIF_TRUSTED' | 'WORKBENCH_POOLED' | 'measured:identity';
  /** LENS_DB key the profile came from. */
  lensKey: string;
  /** Human-readable lens model. */
  lensModel: string;
  /** Focal length (mm) used to interpolate the coeffs. */
  focalLength: number;
}

// Mirrors the optics_manager.ts placeholder guard EXACTLY: matches 'Unknown'
// and 'Unknown Lens' (case-insensitive). OR-ed with an empty/whitespace model.
const PLACEHOLDER_LENS_RE = /^unknown( lens)?$/i;

function lensKeyOf(profile: LensProfile): string | null {
  for (const [key, p] of Object.entries(LENS_DB)) {
    if (p === profile) return key;
  }
  return null;
}

/** Choose the focal length to interpolate at: hint → metadata hint → EXIF → lens default. */
function pickFocalLength(
  hintFocal: number | undefined,
  metadata: LensResolutionMetadata | null | undefined,
  profile: LensProfile,
): number {
  if (Number.isFinite(hintFocal) && (hintFocal as number) > 0) return hintFocal as number;
  const mh = metadata?.focal_length_hint_mm;
  if (Number.isFinite(mh) && (mh as number) > 0) return mh as number;
  const mf = metadata?.focal_length;
  if (Number.isFinite(mf) && (mf as number) > 0) return mf as number;
  return profile.focal_lengths[0];
}

/**
 * Focal length from metadata hints/EXIF alone (no LENS_DB profile fallback), for
 * the rung-0 identity path where the measured coeffs are already fixed and the
 * focal length is CONTEXT only. Returns 0 when absent.
 */
function pickFocalLengthValue(metadata: LensResolutionMetadata | null | undefined): number {
  const mh = metadata?.focal_length_hint_mm;
  if (Number.isFinite(mh) && (mh as number) > 0) return mh as number;
  const mf = metadata?.focal_length;
  if (Number.isFinite(mf) && (mf as number) > 0) return mf as number;
  return 0;
}

/**
 * Resolve a lens-distortion prior. Returns `null` (NO-OP) unless a lens is
 * CONFIDENTLY resolved from: (rung-0) an optical-train IDENTITY match to a
 * MEASURED store profile, (a) a user hint, or (b) a trusted, non-placeholder EXIF
 * LensModel that matches LENS_DB. Rung-0 (`identity`) is the TOP rung: when
 * supplied it wins and the generic LENS_DB/EXIF lookups are SKIPPED (Feb spec).
 */
export function resolveLensDistortion(
  metadata: LensResolutionMetadata | null | undefined,
  userHint?: LensDistortionHint | null,
  identity?: IdentityDistortionProfile | null,
): LensDistortionResolution | null {
  // (rung-0) OPTICAL-TRAIN IDENTITY — a MEASURED profile for a previously-
  // calibrated setup. Highest trust: skips the generic LENS_DB/EXIF lookups
  // entirely (Feb spec: "If a user previously calibrated this setup, it skips
  // generic DB lookups"). Only ever passed when SOLVER_IDENTITY_PROFILE is ON and
  // the store held a measured profile, so the flag-OFF / no-identity path below is
  // byte-identical to the pre-existing ladder.
  if (identity && Number.isFinite(identity.k1)) {
    const coeffs: DistortionCoeffs = { k1: identity.k1, k2: identity.k2, k3: 0, p1: 0, p2: 0 };
    return {
      k1: identity.k1,
      k2: identity.k2,
      coeffs,
      provenance: 'measured:identity',
      lensKey: 'measured:identity',
      lensModel: identity.lensModel ?? (metadata?.lens_model ?? 'measured:identity').toString(),
      focalLength: identity.focalLength ?? pickFocalLengthValue(metadata),
    };
  }

  // (a) Explicit USER HINT for manual glass — highest trust, overrides a lying EXIF.
  if (userHint && (userHint.lensKey || userHint.lensModel)) {
    let profile: LensProfile | null = null;
    let key: string | null = null;
    if (userHint.lensKey && LENS_DB[userHint.lensKey]) {
      key = userHint.lensKey;
      profile = LENS_DB[userHint.lensKey];
    } else if (userHint.lensModel) {
      profile = findLensByModel(userHint.lensModel);
      key = profile ? lensKeyOf(profile) : null;
    }
    if (profile && key) {
      const focalLength = pickFocalLength(userHint.focalLength, metadata, profile);
      const coeffs = interpolateDistortion(profile, focalLength);
      return {
        k1: coeffs.k1,
        k2: coeffs.k2,
        coeffs,
        provenance: 'USER_HINT',
        lensKey: key,
        lensModel: profile.model,
        focalLength,
      };
    }
    // A hint that doesn't resolve is not fabricated into a profile — fall
    // through to the EXIF rung (which still guards placeholders).
  }

  // (b) TRUSTED EXIF LensModel → findLensByModel. Reject placeholders/untrusted.
  const lens = (metadata?.lens_model ?? '').toString().trim();
  if (!lens || PLACEHOLDER_LENS_RE.test(lens)) return null; // 'Unknown Lens' / empty → NO profile
  const profile = findLensByModel(lens);
  if (!profile) return null;
  const key = lensKeyOf(profile);
  if (!key) return null;
  const focalLength = pickFocalLength(undefined, metadata, profile);
  const coeffs = interpolateDistortion(profile, focalLength);
  return {
    k1: coeffs.k1,
    k2: coeffs.k2,
    coeffs,
    provenance: 'EXIF_TRUSTED',
    lensKey: key,
    lensModel: profile.model,
    focalLength,
  };
}
