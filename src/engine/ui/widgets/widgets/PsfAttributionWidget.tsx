/**
 * PSF ATTRIBUTION LEDGER (chart tier) — the physics decomposition of the measured
 * PSF (anisotropy / drift / diffraction / seeing / refraction / coma / field
 * rotation), brought into the widget registry (consolidation delta 2026-07-12).
 * Previously step-local (mounted only inside PsfPanel); this entry renders the
 * IDENTICAL `AttributionLedger` — which is already built to consume the serialized
 * receipt block (`serializePsfAttributionBlock` re-keys `field_rotation`) — so it
 * lights up on the Widget Shelf / dock / replay dashboard.
 *
 * PURE READ over `receipt.psf_attribution`. Honest-or-absent (LAW 3): null when the
 * block is absent OR present with no physics tiers ⇒ the dock frame shows NOT
 * MEASURED / AWAITING SOLVE. Pipeline-authored labels/numbers are receipt-copied —
 * nothing recomputed, nothing invented.
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { AttributionLedger, type PsfAttributionLike } from '../../psf/AttributionLedger';

/** The tier sections a renderable attribution block may carry. A block with none of
 *  these is not chartable ⇒ honest absence. */
const TIER_KEYS = ['measured', 'drift', 'diffraction', 'seeing', 'refraction', 'coma', 'field_rotation', 'fieldRotation'] as const;

/** PURE selector: receipt.psf_attribution → the block, or null (NOT MEASURED). */
export function selectPsfAttribution(receipt: WidgetReceipt): PsfAttributionLike | null {
    const block = receipt?.psf_attribution;
    if (!block || typeof block !== 'object') return null;
    const hasTier = TIER_KEYS.some(k => (block as Record<string, unknown>)[k] != null);
    return hasTier ? (block as PsfAttributionLike) : null;
}

const PsfAttributionRender: React.FC<WidgetRenderProps<PsfAttributionLike>> = ({ data }) => (
    <AttributionLedger attribution={data} />
);

export const psfAttributionWidget: WidgetManifest<PsfAttributionLike> = {
    id: 'psf_attribution',
    title: 'PSF Attribution',
    intent: 'Physics ledger decomposing the measured PSF into drift / diffraction / seeing / differential refraction / coma — how much of the star shape each effect explains.',
    dataSelector: selectPsfAttribution,
    weightTier: 'chart',
    render: PsfAttributionRender,
};
