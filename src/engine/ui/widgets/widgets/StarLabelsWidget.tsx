/**
 * DATA-BACKED WIDGET (chart tier) — named-star overlay on the solved frame.
 *
 * PURE READ over `receipt.solution.matched_stars` (each carrying a catalog sky
 * position ra_deg/dec_deg AND its fitted image xy) + `receipt.metadata` (frame
 * w/h) + the solution center. It renders the solved star field (matched-star
 * markers) and overlays human names from the bundled `NAMED_STARS` reference:
 *
 *   ANCHORED (full strength) — a matched atlas star lies within ANCHOR_TOL_DEG of
 *     a named reference: the label attaches to that atlas star's REAL fitted xy.
 *   PREDICTED (dimmer, badged) — a named reference with no co-located matched star,
 *     placed via the solution's OWN empirical sky→pixel map, and ONLY when that map
 *     validates (enough matches + small residual). Labelled catalog-predicted, and
 *     withheld entirely when the map is unusable (honest-absent, never guessed).
 *
 * Labels declutter greedily by brightness (never overlap; leader lines when
 * offset). Names are needed because the shipped Gaia atlas rows carry no proper
 * name and saturate at the bright end (see data/named_stars.ts).
 *
 * Honest-or-absent (LAW 3): no solution / no matched stars ⇒ selector returns
 * null ⇒ the dock frame shows NOT MEASURED.
 *
 * Ledger: UI render layer only. Reads a fitted solution for display; fits nothing
 * astrometric, mutates no WCS/matched_stars, leaves the sacred solve untouched.
 */

import React, { useMemo } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { finite } from '../widget_math';
import { Readout } from '../chart_primitives';
import { NAMED_STARS } from '../data/named_stars';
import {
    resolveNamedLabels, layoutLabels,
    type MatchedSample, type LabelCandidate,
} from '../data/star_labels';

export interface StarLabelsData {
    w: number; h: number;
    markers: { x: number; y: number }[];
    anchored: LabelCandidate[];
    predicted: LabelCandidate[];
    map: { valid: boolean; rmsPx: number | null; n: number };
    matchedCount: number;
}

/** PURE selector: solution.matched_stars + metadata → labelled star field, or null. */
export function selectStarLabels(receipt: WidgetReceipt): StarLabelsData | null {
    const raw = Array.isArray(receipt?.solution?.matched_stars) ? receipt!.solution.matched_stars : [];
    const matched: MatchedSample[] = [];
    const markers: { x: number; y: number }[] = [];
    for (const m of raw) {
        const x = finite(m?.x), y = finite(m?.y);
        const raDeg = finite(m?.ra_deg), decDeg = finite(m?.dec_deg);
        if (x == null || y == null) continue;
        markers.push({ x, y });
        if (raDeg != null && decDeg != null) matched.push({ raHours: raDeg / 15, decDeg, x, y });
    }
    if (markers.length === 0) return null;             // no solved star field ⇒ NOT MEASURED

    const w = finite(receipt?.metadata?.width) ?? (Math.max(1, ...markers.map(p => p.x)) + 1);
    const h = finite(receipt?.metadata?.height) ?? (Math.max(1, ...markers.map(p => p.y)) + 1);

    const raH = finite(receipt?.solution?.ra_hours);
    const decD = finite(receipt?.solution?.dec_degrees);
    const center = raH != null && decD != null ? { ra0Hours: raH, dec0Deg: decD } : null;

    const { anchored, predicted, map } = resolveNamedLabels(matched, NAMED_STARS, { w, h }, center);
    return { w, h, markers, anchored, predicted, map, matchedCount: markers.length };
}

const StarLabelsRender: React.FC<WidgetRenderProps<StarLabelsData>> = ({ data }) => {
    const { w, h, markers, anchored, predicted, map, matchedCount } = data;

    // SVG in image aspect, capped for the dock.
    const VW = 300;
    const VH = Math.max(60, Math.round(VW * h / Math.max(1, w)));

    const layout = useMemo(
        () => layoutLabels([...anchored, ...predicted], { w, h, vw: VW, vh: VH }),
        [anchored, predicted, w, h, VH],
    );

    const sx = VW / Math.max(1, w), sy = VH / Math.max(1, h);
    const magR = (mag: number) => Math.max(1.1, Math.min(3, 3.2 - 0.28 * mag)); // brighter ⇒ larger

    return (
        <div className="flex flex-col gap-3" data-testid="widget-star-labels">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
                <Readout label="Matched" value={String(matchedCount)} />
                <Readout label="Named" value={String(anchored.length)} title="named reference stars co-located with a matched atlas star" />
                <Readout label="Predicted" value={map.valid ? String(predicted.length) : '—'}
                         title="catalog-predicted names via the solution's empirical sky→pixel map" />
                <Readout label="Map RMS"
                         value={map.valid && map.rmsPx != null ? `${map.rmsPx.toFixed(1)} px` : 'NOT MEASURED'}
                         title="empirical sky→pixel map residual (withheld when unusable)" />
            </div>

            <svg viewBox={`0 0 ${VW} ${VH}`} width={VW} className="h-auto select-none border border-line rounded"
                 role="img" aria-label="solved star field with named-star labels" data-testid="widget-star-labels-svg">
                {/* solved star field — faint matched-star markers */}
                {markers.map((p, i) => (
                    <circle key={`m${i}`} cx={p.x * sx} cy={p.y * sy} r={0.7}
                            fill="var(--chart-seq-4)" fillOpacity={0.4} />
                ))}

                {/* predicted-star markers (hollow, dim) — only when the map validated */}
                {map.valid && predicted.map((c, i) => (
                    <circle key={`p${i}`} cx={c.x * sx} cy={c.y * sy} r={magR(c.mag)}
                            fill="none" stroke="var(--chart-cat-4)" strokeOpacity={0.5} strokeWidth={0.7}
                            strokeDasharray="1.4 1.2" />
                ))}

                {/* anchored named-star markers (emphasized) */}
                {anchored.map((c, i) => (
                    <circle key={`a${i}`} cx={c.x * sx} cy={c.y * sy} r={magR(c.mag)}
                            fill="var(--chart-cat-3)" fillOpacity={0.9} />
                ))}

                {/* leader lines (only where a label was offset from its marker) */}
                {layout.placed.filter(pl => pl.leader).map((pl, i) => (
                    <line key={`l${i}`} x1={pl.mx} y1={pl.my} x2={pl.lx} y2={pl.ly}
                          stroke="var(--chart-grid-subtle)" strokeWidth={0.4} strokeOpacity={0.8} />
                ))}

                {/* decluttered labels */}
                {layout.placed.map((pl, i) => (
                    <text key={`t${i}`} x={pl.lx} y={pl.ly} textAnchor={pl.align}
                          style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '6.5px',
                              fill: pl.source === 'anchored' ? 'var(--chart-data-text)' : 'var(--chart-tick-text)',
                              fontStyle: pl.source === 'predicted' ? 'italic' : 'normal',
                          }}
                          fillOpacity={pl.source === 'anchored' ? 1 : 0.75}>{pl.text}</text>
                ))}
            </svg>

            <div className="text-[10px] font-mono text-text-muted">
                green = named on a matched star · dashed violet = catalog-predicted
                {!map.valid && ' · predicted layer withheld (map unusable)'}
                {layout.dropped > 0 && ` · ${layout.dropped} label${layout.dropped === 1 ? '' : 's'} decluttered`}
            </div>
        </div>
    );
};

export const starLabelsWidget: WidgetManifest<StarLabelsData> = {
    id: 'star_labels',
    title: 'Named Stars',
    intent: 'Put human names on the solved frame: proper names (Bayer fallback) anchored to matched atlas stars, plus dimmer catalog-predicted names via the solution’s own empirical sky→pixel map. Names come from a bundled reference because the Gaia atlas rows carry none and saturate at the bright end. Labels declutter by brightness; the predicted layer is withheld when the map can’t validate.',
    dataSelector: selectStarLabels,
    weightTier: 'chart',
    render: StarLabelsRender,
};
