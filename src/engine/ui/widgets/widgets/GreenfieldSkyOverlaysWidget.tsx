/**
 * HEAVY WIDGET (SVG) — GREENFIELD SKY OVERLAYS.
 *
 * Toggleable overlays over the solved frame, all computed from the receipt's TAN
 * WCS (projection conventions copied from SkyTransform.pixelToSky — crpix.x/.y, CD
 * deg/px, gnomonic; never re-derived):
 *   - RA/Dec grid   — net-new graticule (data/sky_overlays.ts), ENABLED.
 *   - Named stars   — bundled NAMED_STARS projected through the receipt WCS, ENABLED.
 *   - Matched stars — the real accepted matched-detection field, ENABLED when the
 *                     receipt has detections attached, else DISABLED (honest tooltip).
 *   - Galaxies/DSOs — DISABLED: no DSO catalog is wired in-tree (no new catalog bundled).
 *   - Alt/Az grid   — DISABLED: requires trusted time + site (timestampTrusted pattern);
 *                     a greenfield receipt carries neither.
 *   - GWCS/distortion — DISABLED: TAN-only receipt; the distortion overlay needs the
 *                     legacy GWCS lane. The option is wired, not the math.
 *
 * Honest-or-absent (LAW 3): no WCS / no frame ⇒ selector returns null ⇒ NOT MEASURED.
 * A disabled toggle states WHY, never renders a fake layer.
 *
 * Ledger: UI render layer only. Projects an already-fitted WCS for display; mutates
 * nothing, solves nothing.
 */

import React, { useMemo, useState } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import {
    normalizeGreenfieldReceipt, buildSkyToPixel, matchedDetPositions,
    type GreenfieldReceipt,
} from '../data/greenfield_receipt';
import { buildGraticule, projectNamedStars, type GraticuleLine } from '../data/sky_overlays';
import { NAMED_STARS } from '../data/named_stars';
import { layoutLabels, type LabelCandidate } from '../data/star_labels';

export interface SkyOverlaysData {
    gf: GreenfieldReceipt;
    frame: { width: number; height: number; source: string };
    graticule: GraticuleLine[];
    fieldDeg: number;
    named: LabelCandidate[];
    matched: { x: number; y: number }[];
    hasDetections: boolean;
    altAzAvailable: boolean;
}

/** PURE selector: greenfield receipt with a TAN WCS → projected overlays, or null. */
export function selectGreenfieldSkyOverlays(receipt: WidgetReceipt): SkyOverlaysData | null {
    const gf = normalizeGreenfieldReceipt(receipt);
    if (!gf || !gf.wcs || !gf.frame) return null;   // no solved WCS ⇒ nothing to overlay

    const proj = buildSkyToPixel(gf.wcs);
    const { lines, fieldDeg } = buildGraticule(proj, gf.frame);
    const named = projectNamedStars(proj, NAMED_STARS, gf.frame);
    const matched = matchedDetPositions(gf).map(p => ({ x: p.x, y: p.y }));

    // Alt/Az needs trusted time + site (timestampTrusted pattern). Greenfield receipts
    // carry neither — honest-disabled. (Wired to light up if a session ever attaches them.)
    const sess = (receipt as any)?.session ?? (receipt as any)?.solution?.session;
    const altAzAvailable = !!(sess?.timestampTrusted && sess?.site);

    return {
        gf, frame: gf.frame, graticule: lines, fieldDeg, named, matched,
        hasDetections: !!gf.detections, altAzAvailable,
    };
}

const magR = (mag: number) => Math.max(1.1, Math.min(3, 3.2 - 0.28 * mag));

const SkyOverlaysRender: React.FC<WidgetRenderProps<SkyOverlaysData>> = ({ data }) => {
    const { frame, graticule, fieldDeg, named, matched, hasDetections, altAzAvailable } = data;

    const [showGrid, setShowGrid] = useState(true);
    const [showNamed, setShowNamed] = useState(true);
    const [showMatched, setShowMatched] = useState(hasDetections);

    const VW = 320;
    const VH = Math.max(80, Math.round(VW * frame.height / Math.max(1, frame.width)));
    const sx = VW / Math.max(1, frame.width), sy = VH / Math.max(1, frame.height);

    const layout = useMemo(
        () => layoutLabels(named, { w: frame.width, h: frame.height, vw: VW, vh: VH }, { maxLabels: 24 }),
        [named, frame.width, frame.height, VH],
    );

    const gridPath = (segments: [number, number][][]): string =>
        segments.map(seg => 'M' + seg.map(([x, y]) => `${(x * sx).toFixed(1)} ${(y * sy).toFixed(1)}`).join(' L ')).join(' ');

    const Toggle: React.FC<{ on: boolean; set?: (v: boolean) => void; label: string; disabled?: boolean; why?: string }> =
        ({ on, set, label, disabled, why }) => (
            <label className={`flex items-center gap-1 ${disabled ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'}`} title={disabled ? why : undefined}>
                <input type="checkbox" checked={disabled ? false : on} disabled={disabled}
                       onChange={e => set?.(e.target.checked)} className="accent-[var(--color-solve)]" />
                <span>{label}{disabled && why ? ' ⃠' : ''}</span>
            </label>
        );

    return (
        <div className="flex flex-col gap-2" data-testid="widget-greenfield-sky-overlays">
            {/* toggles */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-data">
                <Toggle on={showGrid} set={setShowGrid} label="RA/Dec grid" />
                <Toggle on={showNamed} set={setShowNamed} label="named stars" />
                <Toggle on={showMatched} set={setShowMatched} label="matched stars"
                        disabled={!hasDetections} why="detection positions not attached to this receipt" />
                <Toggle on={false} label="galaxies/DSOs" disabled why="no DSO catalog wired" />
                <Toggle on={false} label="Alt/Az grid" disabled={!altAzAvailable} why="needs trusted time + site (session has neither)" />
                <Toggle on={false} label="GWCS/distortion" disabled why="TAN-only receipt — distortion overlay requires the legacy GWCS lane" />
            </div>

            <svg viewBox={`0 0 ${VW} ${VH}`} width={VW} className="h-auto select-none border border-line rounded bg-space-950"
                 role="img" aria-label="solved frame with RA/Dec graticule and named-star overlays"
                 data-testid="widget-greenfield-sky-overlays-svg">
                {/* graticule */}
                {showGrid && graticule.map((ln, i) => (
                    <path key={`g${i}`} d={gridPath(ln.segments)} fill="none"
                          stroke={ln.kind === 'ra' ? 'var(--chart-grid-subtle)' : 'var(--chart-seq-3)'}
                          strokeWidth={0.4} strokeOpacity={0.7} />
                ))}
                {/* graticule labels: at each line's first in-frame point */}
                {showGrid && graticule.map((ln, i) => {
                    const seg = ln.segments[0]; if (!seg || !seg.length) return null;
                    const [x, y] = seg[Math.floor(seg.length / 2)];
                    return (
                        <text key={`gl${i}`} x={x * sx + 1} y={y * sy - 1}
                              style={{ fontFamily: 'var(--font-mono)', fontSize: '5px', fill: 'var(--chart-tick-text)' }}
                              fillOpacity={0.7}>{ln.label}</text>
                    );
                })}

                {/* matched-detection field (real accepted correspondences) */}
                {showMatched && matched.map((p, i) => (
                    <circle key={`m${i}`} cx={p.x * sx} cy={p.y * sy} r={0.9}
                            fill="var(--color-solve)" fillOpacity={0.85} />
                ))}

                {/* named-star markers */}
                {showNamed && named.map((c, i) => (
                    <circle key={`n${i}`} cx={c.x * sx} cy={c.y * sy} r={magR(c.mag)}
                            fill="none" stroke="var(--chart-cat-4)" strokeOpacity={0.7} strokeWidth={0.6} />
                ))}
                {/* leader lines + decluttered labels */}
                {showNamed && layout.placed.filter(pl => pl.leader).map((pl, i) => (
                    <line key={`nl${i}`} x1={pl.mx} y1={pl.my} x2={pl.lx} y2={pl.ly}
                          stroke="var(--chart-grid-subtle)" strokeWidth={0.35} strokeOpacity={0.7} />
                ))}
                {showNamed && layout.placed.map((pl, i) => (
                    <text key={`nt${i}`} x={pl.lx} y={pl.ly} textAnchor={pl.align}
                          style={{ fontFamily: 'var(--font-mono)', fontSize: '6px', fill: 'var(--chart-data-text)' }}>{pl.text}</text>
                ))}
            </svg>

            <div className="text-[10px] font-mono text-text-muted leading-snug">
                overlays projected through the receipt TAN WCS · field ≈ {fieldDeg.toFixed(1)}° ·
                {' '}{named.length} named in-frame · {hasDetections ? `${matched.length} matched stars` : 'matched-star layer unavailable (no detections)'}
                {' · '}named positions are catalog coords via the solved WCS (not per-star matched fits)
            </div>
        </div>
    );
};

export const greenfieldSkyOverlaysWidget: WidgetManifest<SkyOverlaysData> = {
    id: 'greenfield_sky_overlays',
    title: 'Sky Overlays',
    intent: 'Toggleable overlays over the solved frame, all projected through the receipt’s TAN WCS: an RA/Dec graticule, bundled named stars at their catalog positions, and the real matched-detection field. Galaxies/DSOs, an Alt/Az grid, and a GWCS distortion overlay are wired but honestly disabled — no DSO catalog is bundled, a greenfield receipt carries no trusted time+site, and a TAN-only receipt has no distortion model to draw.',
    dataSelector: selectGreenfieldSkyOverlays,
    weightTier: 'heavy',
    render: SkyOverlaysRender,
};
