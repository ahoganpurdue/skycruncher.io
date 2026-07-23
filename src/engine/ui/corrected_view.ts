/**
 * -----------------------------------------------------------------
 * CORRECTED VIEW — render-plane availability probe (PURE, no React, no DOM)
 * -----------------------------------------------------------------
 * Pure logic shared by the wizard CORRECTED VIEW toggle (CorrectedViewPill.tsx)
 * and the render-plane warp method (OrchestratorSession.renderCorrectedPreviewUrl).
 * Kept React/DOM-free so the headless session can import it without pulling the
 * UI component graph.
 *
 * LEDGERS (owner three-layer convention): CORRECTED VIEW lives on the RENDER
 * PLANE — it CONSUMES the coordinate ledger (the fitted distortion solution) and
 * the pixel ledger (the preview buffer) and FEEDS NEITHER. It never mutates the
 * solve, WCS, matched stars, or any receipt/measurement value.
 *
 * WARP SOURCE: only a fitted SIP polynomial (`solution.astrometry.sip`, both
 * `a[][]` and `b[][]` present) can drive the preview warp — that is the model
 * `ImageProcessor.applySipUndistort` consumes. TPS (`astrometry.tps`) is a
 * tabular transform with no preview-lane warp primitive, and the measured
 * Brown-Conrady rematch folds INTO `sip` when its never-worse guard applied it
 * (`bc_rematch.applied`). Absent a usable SIP, this reports NOT AVAILABLE — an
 * honest disabled state, never a fabricated correction (LAW 3).
 *
 * CONVENTION TRAP: the FITS-convention SIP negation lives at the export boundary
 * (`export/sip_convention.ts`). Engine-internal SIP is self-consistent and is
 * exactly what `applySipUndistort` expects — do NOT apply that negation here.
 */

import type { PlateSolution } from '../types/Main_types';

/** Only SIP is render-warpable in the preview lane today. */
export type CorrectedViewSource = 'SIP';

export interface CorrectedViewInfo {
    /** True iff a fitted distortion model the preview warp can consume exists. */
    available: boolean;
    /** Which fitted distortion source drives the correction (null ⇒ none usable). */
    source: CorrectedViewSource | null;
    /** Honest one-line status for the UI title/aria (APPROXIMATE when available). */
    label: string;
}

/** Honest disabled-state text surfaced when no fitted distortion exists. */
export const CORRECTED_VIEW_NOT_AVAILABLE = 'NO FITTED DISTORTION — NOT AVAILABLE';

/** Honest active-state text (APPROXIMATE, render-layer). */
export const CORRECTED_VIEW_AVAILABLE = 'APPROXIMATE · render-layer distortion correction';

/**
 * Render-plane availability probe (pure, allocation-free). A SIP polynomial with
 * non-empty `a[][]` and `b[][]` is the only distortion source the preview warp
 * can consume. Never mutates its input; never fabricates a correction.
 */
export function detectCorrectedView(solution: PlateSolution | null | undefined): CorrectedViewInfo {
    const sip = solution?.astrometry?.sip;
    const usable = !!(
        sip &&
        Array.isArray(sip.a) && sip.a.length > 0 &&
        Array.isArray(sip.b) && sip.b.length > 0
    );
    if (!usable) {
        return { available: false, source: null, label: CORRECTED_VIEW_NOT_AVAILABLE };
    }
    return { available: true, source: 'SIP', label: CORRECTED_VIEW_AVAILABLE };
}
