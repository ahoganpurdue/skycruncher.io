/**
 * FORCED-PHOTOMETRY CONFIRMATION (chart tier) — the deep-confirmation card, brought
 * into the widget registry (consolidation delta 2026-07-12). Previously a dashboard
 * fixed-panel card; this entry renders the IDENTICAL `DeepConfirmCard` from the
 * receipt's `deep_confirmed` block (carried through buildReceipt unchanged, all
 * scalar fields). Its MANDATORY "N=1 CALIBRATED — SEESTAR ONLY" caveat rides along.
 *
 * PURE READ over `receipt.deep_confirmed`. Honest-or-absent (LAW 3): null when the
 * confirmation pass did not run / no solve ⇒ the dock frame shows NOT MEASURED /
 * AWAITING SOLVE. Every number is receipt-copied — nothing recomputed.
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { DeepConfirmCard, type DeepConfirmed } from '../../dashboard/DeepConfirmCard';

/** PURE selector: receipt.deep_confirmed → the block, or null (NOT MEASURED). */
export function selectDeepConfirm(receipt: WidgetReceipt): DeepConfirmed | null {
    const deep = receipt?.deep_confirmed;
    return (deep && typeof deep === 'object') ? (deep as DeepConfirmed) : null;
}

const DeepConfirmRender: React.FC<WidgetRenderProps<DeepConfirmed>> = ({ data }) => (
    <DeepConfirmCard deep={data} />
);

export const deepConfirmWidget: WidgetManifest<DeepConfirmed> = {
    id: 'deep_confirm',
    title: 'Forced-Photometry Confirmation',
    intent: 'Forced-photometry confirmation of the solve (confirmed/examined, set-excess σ vs the family-wise gate) — does independent aperture photometry back the plate lock?',
    dataSelector: selectDeepConfirm,
    weightTier: 'chart',
    render: DeepConfirmRender,
};
