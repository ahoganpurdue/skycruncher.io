/**
 * DATA-BACKED WIDGET (chart tier, KEYSTONE) — measured color vs catalog temperature.
 *
 * PURE READ over `receipt.solution.matched_stars`. Each matched star carries a
 * catalog `bv` (Johnson B−V, a temperature proxy) AND a measured color: the
 * pipeline's `measured_bv` plus a linear `peak_rgb` triple. This widget plots
 * catalog B−V (x, temperature axis) against the MEASURED B−V (y), with the
 * y = x identity line = perfect agreement, and each point tinted by its measured
 * peak-RGB. It answers: does the instrument's measured stellar color track the
 * catalog temperature locus, or is there a systematic color bias?
 *
 * The Planckian temperature scale is annotated on the x-axis via the published
 * Ballesteros B−V→K relation (labeled APPROXIMATE — it is a closed-form locus,
 * not a per-star fit).
 *
 * Honest-or-absent: no matched stars carrying BOTH a catalog bv and a measured
 * color ⇒ null ⇒ the dock frame shows NOT MEASURED.
 */

import React, { useMemo } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { finite, bvToKelvin } from '../widget_math';

export interface ColorPoint { catBv: number; measBv: number; rgb: [number, number, number] | null }
export interface ColorColorData { points: ColorPoint[]; n: number }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** PURE selector: matched_stars → paired (catalog bv, measured bv) points, or null. */
export function selectColorColor(receipt: WidgetReceipt): ColorColorData | null {
    const stars: any[] = Array.isArray(receipt?.solution?.matched_stars) ? receipt!.solution.matched_stars : [];
    const points: ColorPoint[] = [];
    for (const s of stars) {
        const catBv = finite(s?.bv);
        const measBv = finite(s?.measured_bv);
        if (catBv == null || measBv == null) continue;
        const rgb = Array.isArray(s?.peak_rgb) && s.peak_rgb.length >= 3
            ? [finite(s.peak_rgb[0]) ?? 0, finite(s.peak_rgb[1]) ?? 0, finite(s.peak_rgb[2]) ?? 0] as [number, number, number]
            : null;
        points.push({ catBv, measBv, rgb });
    }
    if (points.length === 0) return null;                       // honest absence
    return { points, n: points.length };
}

const VW = 460, VH = 300, ML = 44, MR = 14, MT = 30, MB = 42;
const PW = VW - ML - MR, PH = VH - MT - MB;
const MONO = 'var(--font-mono)';
// Temperature ticks (K) → B−V via the inverse locus is annotated at fixed B−V.
const BV_TICKS = [-0.2, 0.2, 0.6, 1.0, 1.4, 1.8];

const ColorColorRender: React.FC<WidgetRenderProps<ColorColorData>> = ({ data }) => {
    const geom = useMemo(() => {
        const xs = data.points.map(p => p.catBv), ys = data.points.map(p => p.measBv);
        const lo = Math.min(-0.4, ...xs, ...ys), hi = Math.max(2.0, ...xs, ...ys);
        const sx = (v: number) => ML + (v - lo) / (hi - lo) * PW;
        const sy = (v: number) => MT + PH - (v - lo) / (hi - lo) * PH;
        return { lo, hi, sx, sy };
    }, [data.points]);
    const { lo, hi, sx, sy } = geom;

    return (
        <div className="flex flex-col gap-2" data-testid="widget-color-color-planckian">
            <div className="text-[10px] font-mono text-text-muted">
                {data.n} matched stars · measured B−V vs catalog B−V · dashed = perfect agreement (y = x)
            </div>
            <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full h-auto select-none" role="img"
                 aria-label="measured B−V versus catalog B−V color-color diagram" data-testid="widget-color-color-svg">
                {/* frame */}
                <rect x={ML} y={MT} width={PW} height={PH} fill="none" style={{ stroke: 'var(--chart-axis)' }} strokeWidth={1} />
                {/* identity line y = x */}
                <line x1={sx(lo)} y1={sy(lo)} x2={sx(hi)} y2={sy(hi)}
                      style={{ stroke: 'var(--chart-zero)' }} strokeWidth={1} strokeDasharray="4 3" />
                {/* x ticks with temperature annotation */}
                {BV_TICKS.map(bv => {
                    const k = bvToKelvin(bv);
                    return (
                        <g key={`x${bv}`}>
                            <line x1={sx(bv)} x2={sx(bv)} y1={MT} y2={MT + PH} style={{ stroke: 'var(--chart-grid-subtle)' }} strokeWidth={0.5} />
                            <text x={sx(bv)} y={MT + PH + 12} textAnchor="middle" style={{ fontFamily: MONO, fontSize: 'var(--chart-text-tick)', fill: 'var(--chart-tick-text)' }}>{bv.toFixed(1)}</text>
                            {k != null && <text x={sx(bv)} y={MT + PH + 22} textAnchor="middle" style={{ fontFamily: MONO, fontSize: '7.5px', fill: 'var(--chart-tick-text)' }}>{Math.round(k / 100) * 100}K</text>}
                        </g>
                    );
                })}
                {/* y ticks */}
                {BV_TICKS.map(bv => (
                    <g key={`y${bv}`}>
                        <line x1={ML} x2={ML + PW} y1={sy(bv)} y2={sy(bv)} style={{ stroke: 'var(--chart-grid-subtle)' }} strokeWidth={0.5} />
                        <text x={ML - 4} y={sy(bv) + 3} textAnchor="end" style={{ fontFamily: MONO, fontSize: 'var(--chart-text-tick)', fill: 'var(--chart-tick-text)' }}>{bv.toFixed(1)}</text>
                    </g>
                ))}
                {/* points */}
                {data.points.map((p, i) => {
                    const fill = p.rgb
                        ? `rgb(${Math.round(clamp01(p.rgb[0]) * 255)},${Math.round(clamp01(p.rgb[1]) * 255)},${Math.round(clamp01(p.rgb[2]) * 255)})`
                        : 'var(--chart-cat-1)';
                    return <circle key={i} cx={sx(p.catBv)} cy={sy(p.measBv)} r={2.1} fill={fill} fillOpacity={0.82} />;
                })}
                {/* axis labels */}
                <text x={ML + PW / 2} y={VH - 4} textAnchor="middle" style={{ fontFamily: MONO, fontSize: 'var(--chart-text-axis)', fill: 'var(--chart-legend-text)' }}>catalog B−V  (→ Planckian temperature, APPROXIMATE)</text>
                <text x={12} y={MT + PH / 2} textAnchor="middle" transform={`rotate(-90 12 ${MT + PH / 2})`} style={{ fontFamily: MONO, fontSize: 'var(--chart-text-axis)', fill: 'var(--chart-legend-text)' }}>measured B−V</text>
            </svg>
        </div>
    );
};

export const colorColorPlanckianWidget: WidgetManifest<ColorColorData> = {
    id: 'color_color_planckian',
    title: 'Color–Color (Planckian)',
    intent: 'Measured stellar color (peak-RGB / measured B−V) against catalog B−V temperature, with the y = x agreement line — does the instrument reproduce the Planckian color locus, or is there a color bias?',
    dataSelector: selectColorColor,
    weightTier: 'chart',
    render: ColorColorRender,
};
