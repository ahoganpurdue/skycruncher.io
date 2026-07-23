/**
 * RESIDUAL VECTOR FIELD (heavy tier) — the step-6 residual quiver, brought into
 * the widget registry (consolidation delta 2026-07-12). The step-6
 * `ForensicCalibrationStep` mounts `ResidualQuiver` from a live-solution
 * `buildQuiverModel`; this registry entry renders the IDENTICAL component from the
 * RECEIPT's already-banked SCHEMA-A residual vectors (`buildQuiverModelFromReceipt`),
 * so it lights up on the Widget Shelf / dock / replay dashboard without touching the
 * step flow.
 *
 * PURE READ over `receipt.solution.matched_stars`. Honest-or-absent (LAW 3): null
 * when there is no solve, no banked residual vectors, or < 15 usable arrows ⇒ the
 * dock frame shows NOT MEASURED / AWAITING SOLVE. The render component + all quiver
 * statistics are reused (LAW 4 — no numeric logic duplicated here).
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { ResidualQuiver } from '../../calibration/CalibrationCharts';
import { buildQuiverModelFromReceipt, type QuiverModel, type ReceiptQuiverStar } from '../../calibration/quiver_model';

export interface ResidualQuiverData {
    model: QuiverModel;
    /** Arcsec/px for the residual → arcsec labels; null when unknown. */
    pixelScale: number | null;
}

/** PURE selector: receipt.solution.matched_stars → quiver model, or null (NOT MEASURED). */
export function selectResidualQuiver(receipt: WidgetReceipt): ResidualQuiverData | null {
    const sol = receipt?.solution;
    if (!sol) return null;
    const model = buildQuiverModelFromReceipt(sol.matched_stars as ReceiptQuiverStar[] | undefined);
    if (!model) return null;
    const pixelScale = typeof sol.pixel_scale === 'number' && Number.isFinite(sol.pixel_scale) && sol.pixel_scale > 0
        ? sol.pixel_scale : null;
    return { model, pixelScale };
}

const ResidualQuiverRender: React.FC<WidgetRenderProps<ResidualQuiverData>> = ({ data }) => (
    <ResidualQuiver model={data.model} pixelScale={data.pixelScale ?? undefined} />
);

export const residualQuiverWidget: WidgetManifest<ResidualQuiverData> = {
    id: 'residual_quiver',
    title: 'Residual Vector Field',
    intent: 'Per-star residual arrows (catalog-projected → observed) from the solved matches — the coherent part is lens distortion, the incoherent part is centroid noise.',
    dataSelector: selectResidualQuiver,
    weightTier: 'heavy',
    render: ResidualQuiverRender,
};
