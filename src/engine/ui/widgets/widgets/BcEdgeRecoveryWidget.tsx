/**
 * DATA-BACKED WIDGET (heavy tier) — Brown-Conrady edge-recovery view.
 *
 * PURE READ over `receipt.lens_distortion_measured` (the MEASURED per-capture
 * Brown-Conrady block) + `receipt.solution.matched_stars` + `receipt.metadata`.
 *
 * The ideal view is a before/after matched-star rematch (`bc_rematch`), but that
 * block is NOT serialized into the receipt on this base — so this widget uses
 * the documented FALLBACK: the matched-star radial distribution over the MEASURED
 * BC displacement field. It samples |BC displacement| on a grid (the ring that
 * grows toward the corners), overplots matched stars, and reports the fit's
 * edge-recovery evidence (rms_2d_px vs baseline_rms_2d_px, octant coverage). When
 * a `bc_rematch` block IS present it is surfaced; otherwise its absence is stated.
 *
 * Ledger: COORDINATE evaluation, render-side only (samples a stored fitted
 * function; solves nothing, mutates nothing).
 *
 * Honest-or-absent: no measured BC block, or `not_measured` set ⇒ null ⇒ NOT MEASURED.
 */

import React, { useMemo } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { finite, measuredBcShiftPx } from '../widget_math';
import { Readout } from '../chart_primitives';

interface XY { x: number; y: number }
export interface BcEdgeData {
    cx: number; cy: number; halfDiag: number;
    coeffs: Record<string, { value: number }>;
    k1: number | null; k2: number | null;
    rms2d: number | null; baselineRms: number | null;
    nPairs: number | null; nUsed: number | null; rMax: number | null;
    octantCounts: number[]; octantLabels: string[];
    matched: XY[]; w: number; h: number;
    rematchPresent: boolean;
}

/** PURE selector: lens_distortion_measured (+ matched/meta) → edge-recovery inputs. */
export function selectBcEdge(receipt: WidgetReceipt): BcEdgeData | null {
    const bc = receipt?.lens_distortion_measured;
    if (!bc || bc.not_measured) return null;                    // honest absence
    const fc = Array.isArray(bc.frame_center) ? bc.frame_center : null;
    const halfDiag = finite(bc.half_diag_px);
    if (!fc || halfDiag == null || halfDiag <= 0) return null;
    const matched = (Array.isArray(receipt?.solution?.matched_stars) ? receipt!.solution.matched_stars : [])
        .map((p: any) => ({ x: finite(p?.x), y: finite(p?.y) }))
        .filter((p: any): p is XY => p.x != null && p.y != null);
    const w = finite(receipt?.metadata?.width) ?? (finite(fc[0])! * 2 + 1);
    const h = finite(receipt?.metadata?.height) ?? (finite(fc[1])! * 2 + 1);
    return {
        cx: finite(fc[0]) ?? 0, cy: finite(fc[1]) ?? 0, halfDiag,
        coeffs: bc.coefficients ?? {},
        k1: finite(bc.k1), k2: finite(bc.k2),
        rms2d: finite(bc.rms_2d_px), baselineRms: finite(bc.baseline_rms_2d_px),
        nPairs: finite(bc.n_pairs), nUsed: finite(bc.n_used), rMax: finite(bc.r_max_sampled),
        octantCounts: Array.isArray(bc.octant_counts) ? bc.octant_counts : [],
        octantLabels: Array.isArray(bc.octant_labels) ? bc.octant_labels : [],
        matched, w, h,
        rematchPresent: !!(receipt?.bc_rematch || receipt?.solution?.bc_rematch),
    };
}

const SEQ = ['--chart-seq-1', '--chart-seq-2', '--chart-seq-3', '--chart-seq-4', '--chart-seq-5'];

const BcEdgeRender: React.FC<WidgetRenderProps<BcEdgeData>> = ({ data }) => {
    const { cx, cy, halfDiag, coeffs, matched, w, h } = data;
    const GX = 12, GY = Math.max(4, Math.round(12 * h / Math.max(1, w)));
    const field = useMemo(() => {
        const cells: number[] = [];
        let mx = 1e-9;
        for (let gy = 0; gy < GY; gy++) {
            for (let gx = 0; gx < GX; gx++) {
                const px = (gx + 0.5) / GX * w, py = (gy + 0.5) / GY * h;
                const s = measuredBcShiftPx(px, py, coeffs, cx, cy, halfDiag);
                cells.push(s); if (s > mx) mx = s;
            }
        }
        return { cells, mx };
    }, [coeffs, cx, cy, halfDiag, w, h, GX, GY]);

    const VW = 240, VH = Math.round(VW * h / Math.max(1, w));
    const cw = VW / GX, ch = VH / GY;
    const recovery = data.rms2d != null && data.baselineRms != null ? data.baselineRms - data.rms2d : null;

    return (
        <div className="flex flex-col gap-3" data-testid="widget-bc-edge-recovery">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
                <Readout label="Pairs" value={data.nPairs == null ? '—' : `${data.nUsed ?? '?'}/${data.nPairs}`} />
                <Readout label="k1" value={data.k1 == null ? '—' : data.k1.toExponential(2)} />
                <Readout label="k2" value={data.k2 == null ? '—' : data.k2.toExponential(2)} />
                <Readout label="RMS 2D" value={data.rms2d == null ? '—' : `${data.rms2d.toFixed(3)} px`} />
                <Readout label="vs baseline" value={recovery == null ? '—' : `${recovery >= 0 ? '−' : '+'}${Math.abs(recovery).toFixed(3)} px`}
                    title="baseline_rms_2d_px − rms_2d_px (positive = BC reduced residual)" />
                <Readout label="Peak shift" value={`${field.mx.toFixed(2)} px`} title="max |BC displacement| sampled over the frame" />
            </div>
            <svg viewBox={`0 0 ${VW} ${VH}`} width={VW} className="h-auto select-none border border-line rounded"
                 role="img" aria-label="measured Brown-Conrady displacement field with matched stars" data-testid="widget-bc-field-svg">
                {field.cells.map((s, i) => {
                    const gx = i % GX, gy = Math.floor(i / GX);
                    const t = s / field.mx;
                    const idx = Math.min(SEQ.length - 1, Math.floor(t * SEQ.length));
                    return <rect key={i} x={gx * cw} y={gy * ch} width={cw} height={ch} fill={`var(${SEQ[idx]})`} fillOpacity={0.9} />;
                })}
                {matched.map((p, i) => (
                    <circle key={i} cx={p.x / w * VW} cy={p.y / h * VH} r={0.9} fill="var(--chart-cat-2)" fillOpacity={0.85} />
                ))}
                {/* optical center */}
                <circle cx={cx / w * VW} cy={cy / h * VH} r={2} fill="none" stroke="var(--chart-cat-3)" strokeWidth={0.8} />
            </svg>
            {/* octant coverage strip */}
            {data.octantLabels.length > 0 && (
                <div className="flex gap-1 flex-wrap font-mono text-[9px] text-text-muted">
                    {data.octantLabels.map((lb, i) => (
                        <span key={lb} className="px-1.5 py-0.5 rounded border border-line"
                              title="matched pairs in this octant (fit coverage)">{lb} {data.octantCounts[i] ?? 0}</span>
                    ))}
                </div>
            )}
            <div className="text-[10px] font-mono text-text-muted">
                {data.rematchPresent
                    ? 'BC rematch block present — before/after available.'
                    : 'bc_rematch not in receipt — showing measured-BC displacement field + matched-star distribution (fallback).'}
            </div>
        </div>
    );
};

export const bcEdgeRecoveryWidget: WidgetManifest<BcEdgeData> = {
    id: 'bc_edge_recovery',
    title: 'BC Edge Recovery',
    intent: 'Measured Brown-Conrady displacement field (growing toward the corners) with matched stars overplotted — how much does the fitted distortion move edge stars, and does re-matching under it recover residual?',
    dataSelector: selectBcEdge,
    weightTier: 'heavy',
    render: BcEdgeRender,
};
