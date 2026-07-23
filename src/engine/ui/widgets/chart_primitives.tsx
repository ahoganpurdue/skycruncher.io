/**
 * SHARED WIDGET CHART PRIMITIVES (Phase 2, render layer only).
 *
 * Small, token-driven, hand-rolled SVG/DOM building blocks reused across the
 * Phase-2 widgets so no chart chrome is copy-pasted (LAW 4, presentation edition).
 * Pure presentational — every color/size is a CSS `var(--chart-*)` token, never
 * a hardcoded hex. No data logic lives here.
 */

import React from 'react';

const MONO = 'var(--font-mono)';

/** Inline label + mono value readout. */
export const Readout: React.FC<{ label: string; value: string; title?: string }> = ({ label, value, title }) => (
    <span className="inline-flex items-baseline gap-1.5" title={title}>
        <span className="text-[9px] font-bold uppercase tracking-widest text-text-muted">{label}</span>
        <span className="font-mono text-data text-[11px]">{value}</span>
    </span>
);

export interface HBar { label: string; value: number; colorVar?: string; note?: string }

/**
 * Horizontal labeled bars (waterfalls, tallies). Values are drawn to the max of
 * the set; a zero-length axis renders an empty track (honest, never faked).
 */
export const HBars: React.FC<{ bars: HBar[]; unit?: string; testId?: string }> = ({ bars, unit = '', testId }) => {
    const max = Math.max(1e-9, ...bars.map(b => Math.abs(b.value)));
    return (
        <div className="flex flex-col gap-1.5" data-testid={testId}>
            {bars.map((b, i) => (
                <div key={i} className="flex items-center gap-2">
                    <div className="w-28 shrink-0 text-[9px] font-mono uppercase tracking-wider text-text-muted text-right">{b.label}</div>
                    <div className="flex-1 h-4 bg-space-800 rounded-sm overflow-hidden">
                        <div
                            className="h-full rounded-sm"
                            style={{ width: `${(Math.abs(b.value) / max) * 100}%`, backgroundColor: `var(${b.colorVar ?? '--chart-cat-1'})` }}
                        />
                    </div>
                    <div className="w-20 shrink-0 font-mono text-data text-[11px]">{b.value}{unit}{b.note ? ` ${b.note}` : ''}</div>
                </div>
            ))}
        </div>
    );
};

/**
 * Vertical histogram (distributions). `bins` = per-bar counts; `tickLabels`
 * (optional, aligned to bar edges) render under the axis. Token-driven.
 */
export const VHistogram: React.FC<{
    counts: number[]; colorVar?: string; xLabel?: string; yLabel?: string;
    edgeLabels?: string[]; testId?: string;
}> = ({ counts, colorVar = '--chart-cat-1', xLabel, yLabel, edgeLabels, testId }) => {
    const VW = 460, VH = 190, ML = 34, MR = 10, MT = 12, MB = 30;
    const PW = VW - ML - MR, PH = VH - MT - MB;
    const n = counts.length || 1;
    const max = Math.max(1, ...counts);
    const bw = PW / n;
    const yTicks = [0, Math.ceil(max / 2), max];
    return (
        <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full h-auto select-none" data-testid={testId} role="img"
             aria-label={`${yLabel ?? 'count'} vs ${xLabel ?? 'bin'}`}>
            {yTicks.map(t => {
                const y = MT + PH - (t / max) * PH;
                return (
                    <g key={t}>
                        <line x1={ML} x2={VW - MR} y1={y} y2={y} style={{ stroke: 'var(--chart-grid-subtle)' }} strokeWidth={0.6} />
                        <text x={ML - 4} y={y + 3} textAnchor="end" style={{ fontFamily: MONO, fontSize: 'var(--chart-text-tick)', fill: 'var(--chart-tick-text)' }}>{t}</text>
                    </g>
                );
            })}
            {counts.map((c, i) => {
                const bh = (c / max) * PH;
                return <rect key={i} x={ML + i * bw + 0.6} y={MT + PH - bh} width={Math.max(0.5, bw - 1.2)} height={bh}
                             style={{ fill: `var(${colorVar})` }} />;
            })}
            <line x1={ML} x2={VW - MR} y1={MT + PH} y2={MT + PH} style={{ stroke: 'var(--chart-axis)' }} strokeWidth={1} />
            {edgeLabels && edgeLabels.map((lb, i) => (
                <text key={i} x={ML + (i / (edgeLabels.length - 1)) * PW} y={MT + PH + 12}
                      textAnchor={i === 0 ? 'start' : i === edgeLabels.length - 1 ? 'end' : 'middle'}
                      style={{ fontFamily: MONO, fontSize: 'var(--chart-text-tick)', fill: 'var(--chart-tick-text)' }}>{lb}</text>
            ))}
            {xLabel && <text x={ML + PW / 2} y={VH - 3} textAnchor="middle" style={{ fontFamily: MONO, fontSize: 'var(--chart-text-axis)', fill: 'var(--chart-legend-text)' }}>{xLabel}</text>}
            {yLabel && <text x={ML} y={MT - 3} style={{ fontFamily: MONO, fontSize: 'var(--chart-text-axis)', fill: 'var(--chart-legend-text)' }}>{yLabel}</text>}
        </svg>
    );
};
