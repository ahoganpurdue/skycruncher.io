/**
 * EXEMPLAR WIDGET (chart tier) — distortion + vignette curves.
 *
 * PARALLEL-NEW port of the step-6 curves in ui/calibration/CalibrationCharts.tsx
 * — that original file is LEFT UNTOUCHED. The only substantive change here is
 * that this copy draws its palette from the NEW chart tokens via CSS `var(...)`
 * (the original carries a hardcoded `const C={...}` hex block whose comment
 * falsely claims it uses tokens). The presentation MATH is reused as-is from
 * the shared, already-tested ui/calibration/chart_math.ts (LAW 4 — no numeric
 * logic duplicated).
 *
 * PURE READ over `receipt.hardware` (the fitted lens profile). Honest-or-absent:
 * no chartable measurement (no distortion fit AND no vignette) ⇒ null ⇒ the
 * dock frame shows NOT MEASURED. A flat curve is annotated honestly as "0
 * everywhere", never hidden as if it were absent.
 */

import React, { useMemo } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { niceTicks, fmtCoef, distortionShiftPx, vignetteGainAt } from '../../calibration/chart_math';

export interface DistortionCurvesData {
    k1: number; k2: number; k3: number;
    rRefPx: number;
    v1: number;
    /** True when a real ≥10-match radial-distortion fit exists (else curve = 0). */
    distortionMeasured: boolean;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** PURE selector: receipt.hardware → curve coefficients, or null (NOT MEASURED). */
export function selectDistortionCurves(receipt: WidgetReceipt): DistortionCurvesData | null {
    const hw = receipt?.hardware;
    if (!hw) return null;
    const dist = hw.distortion_profile;
    const fit = hw.fit_stats;
    const v1 = num(hw.vignette_v1);
    const rRefPx = num(fit?.r_ref_px);
    const nMatches = num(fit?.n_matches);
    // Mirror the step-6 gate: a trustworthy distortion curve needs ≥10 matches
    // and a positive reference radius.
    const distortionMeasured = !!dist && nMatches >= 10 && rRefPx > 0;
    // Honest absence: nothing chartable at all.
    if (!distortionMeasured && v1 === 0) return null;
    return {
        k1: num(dist?.k1), k2: num(dist?.k2), k3: num(dist?.k3),
        rRefPx, v1, distortionMeasured,
    };
}

// ─── curve chart (token-driven copy; original hex palette not reused) ─────────

const VW = 480, VH = 232, ML = 56, MR = 14, MT = 14, MB = 36;
const PW = VW - ML - MR, PH = VH - MT - MB;
const MONO = 'var(--font-mono)';

const txt = (size: string, fill: string, extra?: React.CSSProperties): React.CSSProperties =>
    ({ fontFamily: MONO, fontSize: size, fill, ...extra });

const CurveChart: React.FC<{
    samples: { r: number; y: number }[];
    colorVar: string;            // token NAME, e.g. '--chart-cat-2'
    yLabel: string; xLabel: string; yRef: number;
    yInclude?: number[]; cornerNote?: string; testId?: string;
}> = ({ samples, colorVar, yLabel, xLabel, yRef, yInclude = [], cornerNote, testId }) => {
    const geom = useMemo(() => {
        const ys = samples.map(s => s.y).concat(yInclude, [yRef]);
        let yMin = Math.min(...ys), yMax = Math.max(...ys);
        const pad = Math.max((yMax - yMin) * 0.12, Math.abs(yMax) * 1e-6, 1e-9);
        yMin -= pad; yMax += pad;
        const yTicks = niceTicks(yMin, yMax, 5);
        const xTicks = [0, 0.25, 0.5, 0.75, 1];
        const sx = (r: number) => ML + r * PW;
        const sy = (y: number) => MT + (yMax - y) / (yMax - yMin) * PH;
        const path = samples.map((s, i) => `${i === 0 ? 'M' : 'L'}${sx(s.r).toFixed(2)},${sy(s.y).toFixed(2)}`).join('');
        return { yTicks, xTicks, sx, sy, path };
    }, [samples, yRef, yInclude]);
    const { yTicks, xTicks, sx, sy, path } = geom;

    return (
        <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full h-auto select-none"
             data-testid={testId} role="img" aria-label={`${yLabel} vs ${xLabel}`}>
            {yTicks.map(t => (
                <g key={`y${t}`}>
                    <line x1={ML} x2={VW - MR} y1={sy(t)} y2={sy(t)}
                          style={{ stroke: t === yRef ? 'var(--chart-zero)' : 'var(--chart-grid-subtle)' }}
                          strokeWidth={t === yRef ? 1 : 0.6} />
                    <text x={ML - 6} y={sy(t) + 3} textAnchor="end"
                          style={txt('var(--chart-text-tick)', 'var(--chart-tick-text)')}>{fmtCoef(t, 3)}</text>
                </g>
            ))}
            {xTicks.map(t => (
                <g key={`x${t}`}>
                    <line x1={sx(t)} x2={sx(t)} y1={MT} y2={MT + PH}
                          style={{ stroke: 'var(--chart-grid-subtle)' }} strokeWidth={0.6} />
                    <text x={sx(t)} y={MT + PH + 12} textAnchor="middle"
                          style={txt('var(--chart-text-tick)', 'var(--chart-tick-text)')}>{t}</text>
                </g>
            ))}
            <rect x={ML} y={MT} width={PW} height={PH} fill="none"
                  style={{ stroke: 'var(--chart-axis)' }} strokeWidth={1} />
            <path d={path} fill="none" style={{ stroke: `var(${colorVar})` }} strokeWidth={1.8} strokeLinejoin="round" />
            <text x={ML} y={MT - 4} style={txt('var(--chart-text-axis)', 'var(--chart-legend-text)', { letterSpacing: 0.5 })}>{yLabel}</text>
            <text x={ML + PW / 2} y={VH - 8} textAnchor="middle"
                  style={txt('var(--chart-text-axis)', 'var(--chart-legend-text)', { letterSpacing: 0.5 })}>{xLabel}</text>
            {cornerNote && (
                <text x={VW - MR} y={VH - 8} textAnchor="end"
                      style={txt('var(--chart-text-tick)', 'var(--chart-tick-text)')}>{cornerNote}</text>
            )}
        </svg>
    );
};

const SAMPLES = 96;

const DistortionCurvesRender: React.FC<WidgetRenderProps<DistortionCurvesData>> = ({ data }) => {
    const { k1, k2, k3, rRefPx, v1, distortionMeasured } = data;

    const distSamples = useMemo(() => {
        const out: { r: number; y: number }[] = [];
        for (let i = 0; i <= SAMPLES; i++) { const r = i / SAMPLES; out.push({ r, y: distortionShiftPx(r, k1, k2, k3, rRefPx) }); }
        return out;
    }, [k1, k2, k3, rRefPx]);

    const vigSamples = useMemo(() => {
        const out: { r: number; y: number }[] = [];
        for (let i = 0; i <= SAMPLES; i++) { const r = i / SAMPLES; out.push({ r, y: vignetteGainAt(r, v1) }); }
        return out;
    }, [v1]);

    const noDistortion = k1 === 0 && k2 === 0 && k3 === 0;

    return (
        <div className="flex flex-col gap-4" data-testid="widget-distortion-curves">
            <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-1">Distortion — radial shift</div>
                <CurveChart
                    samples={distSamples} colorVar="--chart-cat-2"
                    yLabel="RADIAL SHIFT Δr (px)" xLabel="normalized ideal radius r" yRef={0}
                    cornerNote={rRefPx > 0 ? `r = 1 ≙ ${Math.round(rRefPx)} px off-axis` : undefined}
                    testId="widget-distortion-chart"
                />
                {(!distortionMeasured || noDistortion) && (
                    <div className="text-[10px] text-text-muted font-mono mt-1">
                        Δr(r) = 0 everywhere — no measurable distortion in this fit.
                    </div>
                )}
            </div>
            <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted mb-1">Vignette — relative illumination</div>
                <CurveChart
                    samples={vigSamples} colorVar="--chart-cat-1"
                    yLabel="RELATIVE ILLUMINATION I(r)" xLabel="normalized radius r" yRef={1} yInclude={[1]}
                    testId="widget-vignette-chart"
                />
                {v1 === 0 && (
                    <div className="text-[10px] text-text-muted font-mono mt-1">
                        I(r) = 1 everywhere — no measured flux falloff in this fit.
                    </div>
                )}
            </div>
        </div>
    );
};

export const distortionCurvesWidget: WidgetManifest<DistortionCurvesData> = {
    id: 'distortion_curves',
    title: 'Distortion & Vignette',
    intent: 'Radial-shift and relative-illumination curves from the fitted lens profile — how much does this optic bend and darken toward the edge?',
    dataSelector: selectDistortionCurves,
    weightTier: 'chart',
    render: DistortionCurvesRender,
};
