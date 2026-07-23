/**
 * PLANETARY MANIFEST (chart tier) — the solved frame's solar-system anchors,
 * brought into the widget registry (consolidation delta 2026-07-12). Previously a
 * dashboard fixed-panel card; this entry renders the IDENTICAL `PlanetaryManifest`
 * from the receipt's top-level `planets` (SolarBody[], carried through buildReceipt
 * unchanged).
 *
 * PURE READ over `receipt.planets`, gated on a solve. Honest-or-absent (LAW 3):
 * null when there is no solve (a failure receipt also carries `planets:[]`, which
 * must read as AWAITING SOLVE, not "no bodies in frame") ⇒ the dock frame shows the
 * honest empty state. When solved, the array (possibly empty) is passed through —
 * the component's own "No solar system bodies detected in frame" is the honest
 * MEASURED-none state.
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { PlanetaryManifest } from '../../dashboard/PlanetaryManifest';
import type { SolarBody } from '../../../types/Main_types';

/** PURE selector: receipt.planets (only on a solve) → SolarBody[], or null (absent). */
export function selectPlanetaryManifest(receipt: WidgetReceipt): SolarBody[] | null {
    if (!receipt?.solution) return null;               // no solve ⇒ ephemeris not meaningful
    const planets = receipt?.planets;
    return Array.isArray(planets) ? (planets as SolarBody[]) : null;
}

const PlanetaryManifestRender: React.FC<WidgetRenderProps<SolarBody[]>> = ({ data }) => (
    <PlanetaryManifest planets={data} />
);

export const planetaryManifestWidget: WidgetManifest<SolarBody[]> = {
    id: 'planetary_manifest',
    title: 'Planetary Manifest',
    intent: 'Solar-system bodies projected into the solved frame (angular size, phase, catalog residual) — the ephemeris anchors used to cross-check the solve.',
    dataSelector: selectPlanetaryManifest,
    weightTier: 'chart',
    render: PlanetaryManifestRender,
};
