/**
 * EXEMPLAR WIDGET (stats tier) — solve summary.
 *
 * PURE READ over `receipt.solution` → the four headline solve numbers. Wraps
 * data the wizard already surfaces elsewhere (parallel-new; no existing view is
 * modified). Honest-or-absent: no solution block ⇒ selector returns null ⇒ the
 * dock frame shows a single NOT MEASURED state. Present-but-null sub-values
 * render as an em-dash (honest absence of that one field, never a placeholder).
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { confirmTierLabel, type ConfirmStatus } from '../../../pipeline/m6_plate_solve/confirm_status';

export interface SolveSummaryData {
    raHours: number | null;
    pixelScale: number | null;
    starsMatched: number | null;
    confidence: number | null;
    /** [SAFETY CATCHER] Derived confirmation verdict, read straight from the
     *  receipt's `confirm_status` block (the widget re-derives NOTHING). null
     *  when there is no solve / no confirm block (honest absence). */
    confirmStatus: ConfirmStatus | null;
}

const finiteOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

/** PURE selector: receipt.solution → headline numbers, or null (NOT MEASURED). */
export function selectSolveSummary(receipt: WidgetReceipt): SolveSummaryData | null {
    const sol = receipt?.solution;
    if (!sol) return null;
    return {
        raHours: finiteOrNull(sol.ra_hours),
        pixelScale: finiteOrNull(sol.pixel_scale),
        starsMatched: finiteOrNull(sol.stars_matched),
        confidence: finiteOrNull(sol.confidence),
        // Read the receipt's derived verdict; do NOT re-classify here.
        confirmStatus: (receipt?.confirm_status?.status as ConfirmStatus | undefined) ?? null,
    };
}

/** Tone-colored text per state (existing kit color tokens; tone EARNED). */
const CONFIRM_TONE: Record<ConfirmStatus, string> = {
    CONFIRMED: 'text-solve',
    REFUSED: 'text-danger',
    INSUFFICIENT_TARGETS: 'text-warn',
    NOT_RUN: 'text-text-secondary',
    // 2.18.0: the test could not decide (resolution), distinct from a refusal.
    CONFIRM_UNDERPOWERED: 'text-warn',
};

const fmt = (v: number | null, digits: number, suffix = ''): string =>
    v == null ? '—' : `${v.toFixed(digits)}${suffix}`;

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div className="flex flex-col gap-0.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">{label}</span>
        <span className="font-mono text-data text-sm">{value}</span>
    </div>
);

const SolveSummaryRender: React.FC<WidgetRenderProps<SolveSummaryData>> = ({ data }) => (
    <div className="flex flex-col gap-3" data-testid="widget-solve-summary">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Stat label="RA" value={fmt(data.raHours, 6, ' h')} />
            <Stat label="Scale" value={fmt(data.pixelScale, 4, ' ″/px')} />
            <Stat label="Matched" value={data.starsMatched == null ? '—' : String(data.starsMatched)} />
            <Stat label="Lock Score (heuristic)" value={fmt(data.confidence, 4)} />
        </div>
        {/* [SAFETY CATCHER] The confirmation tier next to the headline numbers, so
            confidence never stands alone. Absent block → nothing (honest absence). */}
        {data.confirmStatus != null && (
            <div
                className={`text-[11px] font-bold uppercase tracking-wide ${CONFIRM_TONE[data.confirmStatus]}`}
                data-testid="widget-solve-summary-confirm"
                data-confirm-status={data.confirmStatus}
            >
                {confirmTierLabel(data.confirmStatus)}
            </div>
        )}
    </div>
);

export const solveSummaryWidget: WidgetManifest<SolveSummaryData> = {
    id: 'solve_summary',
    title: 'Solve Summary',
    intent: 'The four headline solve numbers (RA, plate scale, matched stars, confidence) — did this frame lock, and how well?',
    dataSelector: selectSolveSummary,
    weightTier: 'stats',
    render: SolveSummaryRender,
};
