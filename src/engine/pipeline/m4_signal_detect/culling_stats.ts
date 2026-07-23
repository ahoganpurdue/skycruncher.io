/**
 * -----------------------------------------------------------------
 * CULLING STATS — per-reason counts for the step-3 trust surface
 * -----------------------------------------------------------------
 * One place that reconciles the three populations a culled star can land in:
 *   - anomalies[]          (kept + drawable when its filter toggle is on)
 *   - planet_candidates[]  (PLANET-routed; drawn separately in CLEAN view)
 *   - dropped              (hard-REJECTED in m4 — only the tally knows)
 *
 * `visible` is what toggling that reason's overlay filter will actually show;
 * `dropped` is the honest remainder from the m4 assignment-time tally.
 */

import { CullingReason, SignalPacket } from '../../types/Main_types';

export interface CullingCount {
    reason: CullingReason;
    /** Culled points the overlay can draw (anomalies + planet candidates). */
    visible: number;
    /** Additionally culled candidates that were dropped from every list. */
    dropped: number;
}

/** Stable display order: the classic list first, then any newly-produced reasons. */
const REASON_ORDER: CullingReason[] = [
    'TOPOGRAPHY', 'SATELLITE', 'CIRCULARITY', 'LOW_SNR', 'COLOR_SNR',
    'PLANET', 'LIGHT_POLLUTION', 'DEDUPLICATION', 'HIGH_DENSITY',
    // Thermal-noise per-blob cuts (detection_cuts.ts, NEXT_MOVES §7):
    'FWHM_FLOOR', 'SHARPNESS', 'ELLIPTICITY'
];

export function computeCullingCounts(signal: SignalPacket | null): CullingCount[] {
    if (!signal) return [];

    const visible: Partial<Record<CullingReason, number>> = {};
    const bump = (map: Partial<Record<CullingReason, number>>, r?: CullingReason) => {
        if (!r || r === 'NONE') return;
        map[r] = (map[r] || 0) + 1;
    };
    for (const a of signal.anomalies ?? []) bump(visible, a.culling_reason);
    for (const p of signal.planet_candidates ?? []) bump(visible, p.culling_reason);

    const tally = signal.culling_tally ?? {};
    const reasons = new Set<CullingReason>([
        ...Object.keys(visible) as CullingReason[],
        ...Object.keys(tally) as CullingReason[]
    ]);

    const ordered = REASON_ORDER.filter(r => reasons.has(r))
        .concat([...reasons].filter(r => !REASON_ORDER.includes(r)));

    return ordered.map(reason => {
        const vis = visible[reason] || 0;
        const total = tally[reason];
        return {
            reason,
            visible: vis,
            // Pre-tally packets (or reasons missing from the tally) can't
            // claim dropped counts — never invent a number.
            dropped: total != null ? Math.max(0, total - vis) : 0
        };
    });
}
