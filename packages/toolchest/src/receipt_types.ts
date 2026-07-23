/**
 * ReceiptLike — the STRUCTURAL subset of the wizard receipt that the toolchest
 * Arrow export consumes. Deliberately decoupled from the engine: we type only the
 * fields we read, so `packages/toolchest` never imports `src/engine/*`. The
 * authoritative producer is `src/engine/pipeline/stages/package.ts` (exportPacket);
 * `receipt.version` carries the live `RECEIPT_SCHEMA_VERSION` (2.10.0 at authoring),
 * which we surface as provenance rather than mirroring the constant here.
 *
 * UNIT TRAP (CLAUDE.md): `solution.ra_hours` is in HOURS; per-star `ra_deg` is in
 * DEGREES. Both are labelled explicitly in the emitted Arrow field metadata.
 */

/** One matched star, from `receipt.solution.matched_stars[]` (package.ts:322). */
export interface MatchedStarLike {
    gaia_id: number | string | null;
    name: string | null;
    /** Catalog RA — DEGREES (per the `ra_deg` field name in package.ts:333). */
    ra_deg: number;
    /** Catalog Dec — DEGREES. */
    dec_deg: number;
    /** Catalog magnitude in `cat_band` (Gaia G vs Johnson V, per row). */
    mag: number;
    bv: number | null;
    /** Catalog band tag ('G' Gaia | 'V' Johnson), SCHEMA B hybrid rows. */
    cat_band: string | null;
    /** Detected pixel position (image-space, y-down). */
    x: number;
    y: number;
    flux: number | null;
    /** Detected FWHM in PIXELS. */
    fwhm: number | null;
    /** Scalar residual magnitude in ARCSEC. */
    residual_arcsec: number;
    /** 2D pixel residual (det − predicted); null when no CD/legacy. */
    dx_px: number | null;
    dy_px: number | null;
    /** Tangent-plane sky residual components in ARCSEC (via fitted CD). */
    dRA_arcsec: number | null;
    dDec_arcsec: number | null;
    /** Per-channel peak samples [R,G,B] peeked from the linear frame; null-absent. */
    peak_rgb: [number, number, number] | null;
    measured_bv: number | null;
}

/** One blind detection, from `receipt.signal.clean_stars[]` (SignalPoint). */
export interface DetectionLike {
    id: number;
    /** Detection pixel position on the (binned) science grid. */
    x: number;
    y: number;
    /** Original sensor-space coordinate (native grid). */
    rawX: number;
    rawY: number;
    flux: number;
    peak: number;
    /** FWHM in PIXELS. */
    fwhm: number;
    snr: number;
    /** 0 (circle) → 1 (line). */
    ellipticity: number;
    /** 0 (line) → 1 (circle). */
    circularity: number;
    /** Elongation angle in RADIANS. */
    theta: number;
    culling_reason?: string;
}

/** One confirmed forced star, from `receipt.deep_confirmed.confirmed_stars[]`. */
export interface ForcedConfirmedLike {
    /** Predicted (catalog-forced) pixel position. */
    x: number;
    y: number;
    /** Catalog magnitude; null when the deep-catalog row carried none. */
    mag: number | null;
    gaia_id: string | null;
    snr: number;
    flux: number;
    /** Per-star confirmation confidence (0..1). */
    confidence: number;
}

export interface SolutionLike {
    /** Solve centre RA — HOURS (the internal convention; NOT degrees). */
    ra_hours: number;
    /** Solve centre Dec — DEGREES. */
    dec_degrees: number;
    /** Plate scale — ARCSEC / PIXEL. */
    pixel_scale: number;
    /** Field roll — DEGREES. */
    roll_degrees: number;
    /** Parity token (sign not asserted; carried verbatim as text). */
    parity: number | string | null;
    confidence: number;
    fov_width_deg: number;
    fov_height_deg: number;
    spatial_hash: string | null;
    mean_fwhm_px: number | null;
    mean_residual_arcsec: number | null;
    stars_matched: number;
    solve_time_ms: number | null;
    matched_stars?: MatchedStarLike[];
}

export interface ConfirmStatusLike {
    status: string;
    setExcessZ: number | null;
    nTargets: number;
    confirmed: number;
    setGateZ: number;
    reason: string | null;
}

export interface DeepConfirmedLike {
    confirmed_stars?: ForcedConfirmedLike[];
}

export interface SignalLike {
    clean_stars?: DetectionLike[];
}

/** The receipt as far as the toolchest reads it. */
export interface ReceiptLike {
    /** Live RECEIPT_SCHEMA_VERSION carried on the receipt (provenance source). */
    version?: string;
    solution: SolutionLike | null;
    signal?: SignalLike | null;
    deep_confirmed?: DeepConfirmedLike | null;
    confirm_status?: ConfirmStatusLike | null;
}
