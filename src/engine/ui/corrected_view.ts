/**
 * -----------------------------------------------------------------
 * CORRECTED VIEW — render-plane availability probe + warp SELECTION (PURE)
 * -----------------------------------------------------------------
 * Pure logic shared by the wizard CORRECTED VIEW toggle (CorrectedViewPill.tsx),
 * the FinalImageView "Applied science / Original" switch, and the render-plane
 * warp method (OrchestratorSession.renderCorrectedPreviewUrl / render_apply_sip
 * stage). Kept React/DOM-free so the headless session can import it without
 * pulling the UI component graph.
 *
 * LEDGERS (owner three-layer convention): CORRECTED VIEW lives on the RENDER
 * PLANE — it CONSUMES the coordinate ledger (the fitted distortion solution) and
 * the pixel ledger (the preview buffer) and FEEDS NEITHER. It never mutates the
 * solve, WCS, matched stars, or any receipt/measurement value.
 *
 * WARP SELECTION LADDER (v1, per RENDER_V1_APPLIED_SCIENCE_PLAN §2 — the models
 * are ALTERNATIVE representations of ONE displacement field, NEVER summed):
 *   1. TPS  (`astrometry.tps`, admitted by its out-of-sample gate) when its
 *      post-fit RMS beats the SIP fit RMS. A REFUSED TPS never renders.
 *   2. SIP  (`astrometry.sip`, fitted; both a[][]/b[][] present) — the model the
 *      primary render warp consumed historically. The measured Brown-Conrady
 *      rematch, when it applies, RE-FITS SIP on the densified set, so `sip`
 *      already carries the total (BC-inclusive) residual — BC never composes with
 *      SIP (that would DOUBLE-correct).
 *   3. BC measured (`bcMeasured` k1/k2) — fallback ONLY when neither SIP nor TPS
 *      exists (rare: SIP/TPS re-fit on the BC-densified set, so BC-applied usually
 *      means SIP is present). A frame-measured radial fit, not a nominal prior.
 * NOMINAL priors (LENS_DB/Lensfun, identity-keyed, not fitted on THIS frame) are
 * NOT part of this ladder — they are a separate, explicit, opt-in concern (plan
 * Open Q1), never auto-applied to the "measurements as displayed" render.
 *
 * CONVENTION TRAP: the render warp uses the ENGINE-INTERNAL SIP/displacement
 * convention. The FITS-convention SIP negation lives at the export boundary
 * (`export/sip_convention.ts`) — do NOT apply that negation here (it would double
 * the distortion). `ImageProcessor.applyRenderWarp` consumes engine-internal
 * models directly.
 */

import type { PlateSolution } from '../types/Main_types';

/** Which fitted distortion model drives the render warp (null ⇒ none usable). */
export type CorrectedViewSource = 'TPS' | 'SIP' | 'BC_MEASURED';

export interface CorrectedViewInfo {
    /** True iff a fitted distortion model the preview warp can consume exists. */
    available: boolean;
    /** Which fitted distortion source drives the correction (null ⇒ none usable). */
    source: CorrectedViewSource | null;
    /** Honest one-line status for the UI title/aria (APPROXIMATE when available). */
    label: string;
}

/** The full selection result — richer than CorrectedViewInfo (carries the RMS the
 *  ladder arbitrated on + a per-source caption). Returned by {@link selectRenderWarp}. */
export interface RenderWarpSelection {
    source: CorrectedViewSource;
    /** Post-fit RMS (arcsec) the ladder arbitrated on; null when not comparable
     *  (BC measured carries no comparable single RMS). */
    rms_arcsec: number | null;
    /** Honest, source-specific caption for the FinalImageView label (APPROXIMATE). */
    label: string;
}

/** Honest disabled-state text surfaced when no fitted distortion exists. */
export const CORRECTED_VIEW_NOT_AVAILABLE = 'NO FITTED DISTORTION — NOT AVAILABLE';

/** Honest active-state text (APPROXIMATE, render-layer) — generic (source-agnostic)
 *  so the existing pill/tests keep their contract; per-source detail lives on
 *  {@link RenderWarpSelection.label}. */
export const CORRECTED_VIEW_AVAILABLE = 'APPROXIMATE · render-layer distortion correction';

/** Per-source honest captions (APPROXIMATE, render-layer). */
const SOURCE_LABEL: Record<CorrectedViewSource, string> = {
    TPS: 'APPROXIMATE · render-layer distortion correction (measured TPS spline)',
    SIP: 'APPROXIMATE · render-layer distortion correction (fitted SIP polynomial)',
    BC_MEASURED: 'APPROXIMATE · render-layer distortion correction (measured Brown-Conrady)',
};

/** A frame-measured Brown-Conrady fit, shape-narrowed to what the ladder reads
 *  (structural subset of m2_hardware MeasuredDistortion — kept local so this pure
 *  leaf never imports the pipeline). */
export interface BcMeasuredLike {
    k1: number;
    k2?: number | null;
    not_measured?: string | null;
}

/**
 * RENDER-PLANE warp SELECTION (pure, allocation-light). Walks the trust ladder and
 * returns the single arbitrated model to warp with — or null (honest-absent) when
 * no per-frame-fitted model qualifies. Never mutates its inputs; never fabricates a
 * correction; never composes models (SELECTION, not composition — §2 of the plan).
 *
 * @param bcMeasured optional frame-measured BC fit (rung 3). Omitted by the pure
 *        pill probe (SIP/TPS only); the render sites pass it for full coverage.
 */
export function selectRenderWarp(
    solution: PlateSolution | null | undefined,
    bcMeasured?: BcMeasuredLike | null,
): RenderWarpSelection | null {
    const astro = solution?.astrometry;

    // — SIP usability + its fit RMS (SIP-inclusive; BC folds into it) —
    const sip = astro?.sip;
    const sipUsable = !!(
        sip &&
        Array.isArray(sip.a) && sip.a.length > 0 &&
        Array.isArray(sip.b) && sip.b.length > 0
    );
    const sipRms = sipUsable && Number.isFinite(astro?.rms_arcsec) ? (astro!.rms_arcsec as number) : null;

    // — TPS admitted (out-of-sample gate passed) + render-usable model —
    const tps = astro?.tps;
    const tpsAdmitted = !!(
        astro?.tps_gate?.admitted &&
        tps &&
        Array.isArray(tps.control_points) && tps.control_points.length > 0 &&
        Array.isArray(tps.weights_x) && tps.weights_x.length === tps.control_points.length &&
        Array.isArray(tps.weights_y) && tps.weights_y.length === tps.control_points.length &&
        Number.isFinite(tps.scale) && tps.scale > 0
    );
    const tpsRms = tpsAdmitted && Number.isFinite(tps!.rms_after_arcsec) ? tps!.rms_after_arcsec : null;

    // Rung 1 — admitted TPS, ONLY when it beats the SIP fit RMS (or no SIP to
    // compare against). A refused TPS is never admitted, so never selected.
    if (tpsAdmitted && (!sipUsable || (tpsRms != null && sipRms != null && tpsRms < sipRms))) {
        return { source: 'TPS', rms_arcsec: tpsRms, label: SOURCE_LABEL.TPS };
    }

    // Rung 2 — fitted SIP (the historical render-warpable model; BC-inclusive).
    if (sipUsable) {
        return { source: 'SIP', rms_arcsec: sipRms, label: SOURCE_LABEL.SIP };
    }

    // Rung 3 — measured Brown-Conrady, fallback ONLY when neither SIP nor TPS
    // exists. Never composed with SIP (that would double-correct). Requires a real
    // fit (finite non-zero k1/k2, not the NOT-MEASURED sentinel).
    if (
        bcMeasured && !bcMeasured.not_measured && Number.isFinite(bcMeasured.k1) &&
        (Math.abs(bcMeasured.k1) > 0 || Math.abs(bcMeasured.k2 ?? 0) > 0)
    ) {
        return { source: 'BC_MEASURED', rms_arcsec: null, label: SOURCE_LABEL.BC_MEASURED };
    }

    return null;
}

/**
 * Render-plane availability probe (pure). Thin adapter over {@link selectRenderWarp}
 * preserving the historical CorrectedViewInfo contract (generic AVAILABLE label).
 * The pure form takes solution only (SIP/TPS coverage — the pill's on-demand render
 * runs where bcMeasured is available and passes it for the rare BC-only case).
 */
export function detectCorrectedView(
    solution: PlateSolution | null | undefined,
    bcMeasured?: BcMeasuredLike | null,
): CorrectedViewInfo {
    const sel = selectRenderWarp(solution, bcMeasured);
    if (!sel) {
        return { available: false, source: null, label: CORRECTED_VIEW_NOT_AVAILABLE };
    }
    return { available: true, source: sel.source, label: CORRECTED_VIEW_AVAILABLE };
}
