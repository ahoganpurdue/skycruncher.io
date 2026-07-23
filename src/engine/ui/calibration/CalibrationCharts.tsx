/**
 * -----------------------------------------------------------------
 * STEP-6 INSTRUMENT CHARTS — distortion, vignette, residual quiver
 * -----------------------------------------------------------------
 * Honest instrument rendering of the MEASURED lens profile:
 *   - proper axes with labeled ticks and units (px, normalized radius r, gain)
 *   - responsive SVG (viewBox — never squashed by the container)
 *   - the residual vector field: catalog-projected (linear WCS) -> observed
 *     positions for every verified matched star, magnified with a labeled
 *     scale factor. Real data only; charts render nothing when the
 *     measurement is absent.
 *
 * All geometry is computed lazily at render time (owner performance
 * directive) — nothing here runs inside the pipeline hot path.
 */

import React, { useMemo, useState } from 'react';
import { niceTicks, fmtCoef, distortionShiftPx, vignetteGainAt } from './chart_math';
import type { QuiverModel } from './quiver_model';

// Palette (src/index.css tokens — charts must match the instrument aesthetic)
const C = {
    bg: 'transparent',
    gridSubtle: '#1c2230',
    axis: '#2a3245',
    axisStrong: '#3d4763',
    textMuted: '#5d6880',
    textSecondary: '#9aa5bd',
    data: '#c7d5f0',
    distortion: '#fbbf24', // warn amber — distortion series
    vignette: '#38bdf8',   // accent cyan — vignette series
    quiver: '#34d399',     // solve green — verified residual vectors
    quiverOutlier: '#fbbf24',
    zero: '#3d4763'
};

const MONO = '"JetBrains Mono", "Consolas", monospace';

// ─── shared curve-chart frame ───────────────────────────────────────────────

interface CurveChartProps {
    /** Sampled curve: x in [0,1] (normalized radius), y in data units. */
    samples: { r: number; y: number }[];
    color: string;
    yLabel: string;
    xLabel: string;
    /** Horizontal reference line value (e.g. 0 for distortion, 1 for vignette). */
    yRef: number;
    /** Extra always-included y values for range computation. */
    yInclude?: number[];
    /** Bottom-right annotation (e.g. what r=1 means in px). */
    cornerNote?: string;
    /** Hover readout formatter. */
    readout: (r: number, y: number) => string;
    testId?: string;
}

const VW = 480, VH = 232;
const ML = 56, MR = 14, MT = 14, MB = 36;
const PW = VW - ML - MR, PH = VH - MT - MB;

const CurveChart: React.FC<CurveChartProps> = ({ samples, color, yLabel, xLabel, yRef, yInclude = [], cornerNote, readout, testId }) => {
    const [hoverR, setHoverR] = useState<number | null>(null);

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
        return { yMin, yMax, yTicks, xTicks, sx, sy, path };
    }, [samples, yRef, yInclude]);

    const { yTicks, xTicks, sx, sy, path } = geom;

    // Hover: nearest sample to the pointer's r
    const hover = useMemo(() => {
        if (hoverR == null || !samples.length) return null;
        let best = samples[0];
        for (const s of samples) if (Math.abs(s.r - hoverR) < Math.abs(best.r - hoverR)) best = s;
        return best;
    }, [hoverR, samples]);

    return (
        <svg
            viewBox={`0 0 ${VW} ${VH}`}
            className="w-full h-auto select-none"
            data-testid={testId}
            role="img"
            aria-label={`${yLabel} vs ${xLabel}`}
            onMouseMove={(e) => {
                const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                const vx = (e.clientX - rect.left) / rect.width * VW;
                const r = (vx - ML) / PW;
                setHoverR(r >= 0 && r <= 1 ? r : null);
            }}
            onMouseLeave={() => setHoverR(null)}
        >
            {/* grid + axes */}
            {yTicks.map(t => (
                <g key={`y${t}`}>
                    <line x1={ML} x2={VW - MR} y1={sy(t)} y2={sy(t)} stroke={t === yRef ? C.zero : C.gridSubtle} strokeWidth={t === yRef ? 1 : 0.6} />
                    <text x={ML - 6} y={sy(t) + 3} textAnchor="end" fontSize={8.5} fill={C.textMuted} fontFamily={MONO}>{fmtCoef(t, 3)}</text>
                </g>
            ))}
            {xTicks.map(t => (
                <g key={`x${t}`}>
                    <line x1={sx(t)} x2={sx(t)} y1={MT} y2={MT + PH} stroke={C.gridSubtle} strokeWidth={0.6} />
                    <text x={sx(t)} y={MT + PH + 12} textAnchor="middle" fontSize={8.5} fill={C.textMuted} fontFamily={MONO}>{t}</text>
                </g>
            ))}
            <rect x={ML} y={MT} width={PW} height={PH} fill="none" stroke={C.axis} strokeWidth={1} />

            {/* series */}
            <path d={path} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />

            {/* axis labels */}
            <text x={ML} y={MT - 4} fontSize={8.5} fill={C.textSecondary} fontFamily={MONO} letterSpacing={0.5}>{yLabel}</text>
            <text x={ML + PW / 2} y={VH - 8} textAnchor="middle" fontSize={8.5} fill={C.textSecondary} fontFamily={MONO} letterSpacing={0.5}>{xLabel}</text>
            {cornerNote && (
                <text x={VW - MR} y={VH - 8} textAnchor="end" fontSize={8} fill={C.textMuted} fontFamily={MONO}>{cornerNote}</text>
            )}

            {/* hover crosshair + readout */}
            {hover && (
                <g pointerEvents="none">
                    <line x1={sx(hover.r)} x2={sx(hover.r)} y1={MT} y2={MT + PH} stroke={C.axisStrong} strokeWidth={0.8} strokeDasharray="3 3" />
                    <circle cx={sx(hover.r)} cy={sy(hover.y)} r={2.6} fill={color} />
                    <text
                        x={sx(hover.r) > ML + PW * 0.6 ? sx(hover.r) - 6 : sx(hover.r) + 6}
                        y={MT + 12}
                        textAnchor={sx(hover.r) > ML + PW * 0.6 ? 'end' : 'start'}
                        fontSize={9} fill={C.data} fontFamily={MONO}
                    >{readout(hover.r, hover.y)}</text>
                </g>
            )}
        </svg>
    );
};

// ─── distortion chart ───────────────────────────────────────────────────────

export const DistortionChart: React.FC<{
    k1: number; k2: number; k3: number;
    rRefPx: number;
}> = ({ k1, k2, k3, rRefPx }) => {
    const samples = useMemo(() => {
        const t0 = Date.now();
        const out: { r: number; y: number }[] = [];
        for (let i = 0; i <= 96; i++) {
            const r = i / 96;
            out.push({ r, y: distortionShiftPx(r, k1, k2, k3, rRefPx) });
        }
        console.log(`[Step6Charts] distortion geometry ${String(Date.now() - t0)}ms`);
        return out;
    }, [k1, k2, k3, rRefPx]);

    const noMeasurement = k1 === 0 && k2 === 0 && k3 === 0;
    return (
        <div>
            <CurveChart
                samples={samples}
                color={C.distortion}
                yLabel="RADIAL SHIFT Δr (px)"
                xLabel="normalized ideal radius r"
                yRef={0}
                cornerNote={`r = 1 ≙ ${Math.round(rRefPx)} px off-axis`}
                readout={(r, y) => `r=${r.toFixed(2)}  Δr=${y >= 0 ? '+' : ''}${y.toFixed(2)}px`}
                testId="step6-distortion-chart"
            />
            {noMeasurement && (
                <div className="text-[10px] text-text-muted font-mono mt-1">
                    Δr(r) = 0 everywhere — no measurable distortion in this fit.
                </div>
            )}
        </div>
    );
};

// ─── vignette chart ─────────────────────────────────────────────────────────

export const VignetteChart: React.FC<{ v1: number }> = ({ v1 }) => {
    const samples = useMemo(() => {
        const t0 = Date.now();
        const out: { r: number; y: number }[] = [];
        for (let i = 0; i <= 96; i++) {
            const r = i / 96;
            out.push({ r, y: vignetteGainAt(r, v1) });
        }
        console.log(`[Step6Charts] vignette geometry ${String(Date.now() - t0)}ms`);
        return out;
    }, [v1]);

    const corner = vignetteGainAt(1, v1);
    const stops = corner > 0 ? Math.log2(1 / corner) : null;
    return (
        <div>
            <CurveChart
                samples={samples}
                color={C.vignette}
                yLabel="RELATIVE ILLUMINATION I(r)"
                xLabel="normalized radius r"
                yRef={1}
                yInclude={[1]}
                cornerNote={stops != null ? `corner: ${(100 * (corner - 1)).toFixed(1)}% (${stops >= 0 ? '−' : '+'}${Math.abs(stops).toFixed(2)} EV)` : undefined}
                readout={(r, y) => `r=${r.toFixed(2)}  I=${y.toFixed(4)}`}
                testId="step6-vignette-chart"
            />
            {v1 === 0 && (
                <div className="text-[10px] text-text-muted font-mono mt-1">
                    I(r) = 1 everywhere — no measured flux falloff in this fit.
                </div>
            )}
        </div>
    );
};

// ─── residual vector field (quiver) ─────────────────────────────────────────

export const ResidualQuiver: React.FC<{ model: QuiverModel; pixelScale?: number }> = ({ model, pixelScale }) => {
    const { arrows, rmsPx, medianPx, magnification, bbox, outlierCount, outlierLimitPx } = model;

    // Normalized plot space: 1000 wide, height follows the frame aspect.
    const spanX = Math.max(1e-6, bbox.maxX - bbox.minX);
    const spanY = Math.max(1e-6, bbox.maxY - bbox.minY);
    const W = 1000;
    const H = Math.max(220, Math.min(900, W * spanY / spanX));
    const pad = 26;
    const sx = (x: number) => pad + (x - bbox.minX) / spanX * (W - 2 * pad);
    const sy = (y: number) => pad + (y - bbox.minY) / spanY * (H - 2 * pad);
    const pxToPlot = (W - 2 * pad) / spanX; // plot units per image px
    const scaleBarLen = magnification * pxToPlot; // 1 px residual at current magnification
    const arcsec = pixelScale && pixelScale > 0 ? pixelScale : null;

    return (
        <div data-testid="step6-residual-quiver">
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 mb-2 font-mono text-[10px] text-text-muted">
                <span><span className="text-data">{arrows.length}</span> MATCHED STARS</span>
                <span>RESIDUAL RMS <span className="text-data">{rmsPx.toFixed(2)}px{arcsec ? ` · ${(rmsPx * arcsec).toFixed(2)}″` : ''}</span></span>
                <span>MEDIAN <span className="text-data">{medianPx.toFixed(2)}px</span></span>
                <span>ARROWS MAGNIFIED <span className="text-warn">×{magnification}</span></span>
                {outlierCount > 0 && (
                    <span><span style={{ color: C.quiverOutlier }}>▪</span> {outlierCount} &gt;5× median (dashed, clipped to {outlierLimitPx.toFixed(1)}px for display — hover for true value)</span>
                )}
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
                aria-label="Residual vector field: catalog-projected to observed star positions">
                <defs>
                    <marker id="quiver-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                        <path d="M0,0.5 L8,4 L0,7.5 Z" fill={C.quiver} />
                    </marker>
                    <marker id="quiver-head-outlier" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                        <path d="M0,0.5 L8,4 L0,7.5 Z" fill={C.quiverOutlier} />
                    </marker>
                </defs>
                <rect x={pad} y={pad} width={W - 2 * pad} height={H - 2 * pad} fill="none" stroke={C.axis} strokeWidth={1} />
                {/* quarter grid */}
                {[0.25, 0.5, 0.75].map(f => (
                    <g key={f}>
                        <line x1={pad + f * (W - 2 * pad)} x2={pad + f * (W - 2 * pad)} y1={pad} y2={H - pad} stroke={C.gridSubtle} strokeWidth={0.6} />
                        <line y1={pad + f * (H - 2 * pad)} y2={pad + f * (H - 2 * pad)} x1={pad} x2={W - pad} stroke={C.gridSubtle} strokeWidth={0.6} />
                    </g>
                ))}
                {/* frame-extent labels (solve-buffer pixel space) */}
                <text x={pad} y={pad - 6} fontSize={11} fill={C.textMuted} fontFamily={MONO}>{Math.round(bbox.minX)},{Math.round(bbox.minY)}px</text>
                <text x={W - pad} y={pad - 6} textAnchor="end" fontSize={11} fill={C.textMuted} fontFamily={MONO}>{Math.round(bbox.maxX)},{Math.round(bbox.maxY)}px</text>

                {arrows.map((a, i) => {
                    const isOutlier = outlierLimitPx > 0 && a.mag > outlierLimitPx;
                    // Outliers (duplicate/net-cap pairings) are drawn CLIPPED to the
                    // 5x-median display length (dashed) — un-clipped they cross the
                    // whole frame and bury the coherent distortion field. True
                    // magnitude stays in the hover tooltip; direction is preserved.
                    const drawScale = isOutlier ? outlierLimitPx / a.mag : 1;
                    const x1 = sx(a.px), y1 = sy(a.py);
                    const x2 = sx(a.px + a.dx * magnification * drawScale), y2 = sy(a.py + a.dy * magnification * drawScale);
                    return (
                        <g key={i}>
                            <title>{`${a.id ?? 'star'}${a.gmag != null ? ` mag ${a.gmag.toFixed(1)}` : ''}: ${a.mag.toFixed(2)}px${arcsec ? ` (${(a.mag * arcsec).toFixed(2)}″)` : ''}  d=(${a.dx.toFixed(2)}, ${a.dy.toFixed(2)})px${isOutlier ? '  [CLIPPED in display]' : ''}`}</title>
                            <circle cx={x1} cy={y1} r={2} fill={C.textMuted} opacity={0.55} />
                            <line x1={x1} y1={y1} x2={x2} y2={y2}
                                stroke={isOutlier ? C.quiverOutlier : C.quiver}
                                strokeWidth={1.4} opacity={isOutlier ? 0.7 : 0.9}
                                strokeDasharray={isOutlier ? '7 5' : undefined}
                                markerEnd={isOutlier ? 'url(#quiver-head-outlier)' : 'url(#quiver-head)'} />
                        </g>
                    );
                })}

                {/* scale key: what a 1 px residual looks like at this magnification */}
                <g transform={`translate(${pad + 8}, ${H - pad - 12})`}>
                    <line x1={0} y1={0} x2={scaleBarLen} y2={0} stroke={C.data} strokeWidth={1.6} />
                    <line x1={0} y1={-3.5} x2={0} y2={3.5} stroke={C.data} strokeWidth={1.2} />
                    <line x1={scaleBarLen} y1={-3.5} x2={scaleBarLen} y2={3.5} stroke={C.data} strokeWidth={1.2} />
                    <text x={scaleBarLen + 8} y={3.5} fontSize={11} fill={C.textSecondary} fontFamily={MONO}>
                        1.0 px residual{arcsec ? ` = ${arcsec.toFixed(2)}″` : ''} (×{magnification})
                    </text>
                </g>
            </svg>
            <div className="text-[10px] text-text-muted font-mono mt-1">
                DOT = catalog star projected through the LINEAR WCS · ARROW → observed centroid.
                The coherent part of this field is lens distortion; the incoherent part is centroid noise.
            </div>
        </div>
    );
};
