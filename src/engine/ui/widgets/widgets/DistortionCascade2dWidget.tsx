/**
 * DATA-BACKED WIDGET (heavy tier) — distortion cascade (the #12 preview).
 *
 * PURE READ over four distortion representations that may co-exist in a receipt:
 *   1. NOMINAL BC   — `hardware.distortion_profile` (library/prior radial k1..k3)
 *   2. MEASURED BC  — `lens_distortion_measured` (fitted per-capture Brown-Conrady)
 *   3. SIP          — `solution.astrometry.sip` (fitted polynomial distortion)
 *   4. TPS          — `solution.astrometry.tps` (fitted thin-plate spline)
 *
 * Each is sampled — render-side, via `widget_math` evaluators that mirror the
 * engine's own conventions — into a displacement-magnitude surface drawn as a
 * 2.5D isometric wireframe. A stage whose receipt block is absent shows a NOT
 * MEASURED tile (honest-or-absent, per stage). Each surface is normalized to its
 * OWN peak (annotated in px) so the SHAPE of each model is comparable even when
 * their magnitudes differ by orders.
 *
 * Ledger: COORDINATE evaluation, render-side only (no solving, no mutation).
 *
 * Honest-or-absent: no distortion representation present at all ⇒ null ⇒ NOT MEASURED.
 */

import React, { useMemo } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { finite, nominalRadialShiftPx, measuredBcShiftPx, sipShiftPx, tpsShiftPx, type TpsBlock } from '../widget_math';

interface NominalBlk { k1: number; k2: number; k3: number; rRefPx: number; cx: number; cy: number }
interface MeasuredBlk { coeffs: Record<string, { value: number }>; cx: number; cy: number; halfDiag: number }
interface SipBlk { a: number[][]; b: number[][]; crpixX: number; crpixY: number }

export interface CascadeData {
    w: number; h: number;
    nominal: NominalBlk | null;
    measured: MeasuredBlk | null;
    sip: SipBlk | null;
    tps: TpsBlock | null;
}

/** PURE selector: gather every present distortion representation, or null. */
export function selectDistortionCascade(receipt: WidgetReceipt): CascadeData | null {
    const w = finite(receipt?.metadata?.width) ?? 0;
    const h = finite(receipt?.metadata?.height) ?? 0;
    const W = w > 0 ? w : 2160, H = h > 0 ? h : 3840;           // safe render extent

    // 1. nominal BC
    const dp = receipt?.hardware?.distortion_profile;
    const rRef = finite(receipt?.hardware?.fit_stats?.r_ref_px);
    const nominal: NominalBlk | null = dp && rRef && rRef > 0 ? {
        k1: finite(dp.k1) ?? 0, k2: finite(dp.k2) ?? 0, k3: finite(dp.k3) ?? 0,
        rRefPx: rRef, cx: W / 2, cy: H / 2,
    } : null;

    // 2. measured BC
    const bc = receipt?.lens_distortion_measured;
    const fc = Array.isArray(bc?.frame_center) ? bc.frame_center : null;
    const hd = finite(bc?.half_diag_px);
    const measured: MeasuredBlk | null = bc && !bc.not_measured && fc && hd && hd > 0 ? {
        coeffs: bc.coefficients ?? {}, cx: finite(fc[0]) ?? W / 2, cy: finite(fc[1]) ?? H / 2, halfDiag: hd,
    } : null;

    // 3. SIP
    const sipRaw = receipt?.solution?.astrometry?.sip;
    const crpixX = finite(receipt?.wcs?.CRPIX1) ?? W / 2;
    const crpixY = finite(receipt?.wcs?.CRPIX2) ?? H / 2;
    const sip: SipBlk | null = sipRaw && Array.isArray(sipRaw.a) && Array.isArray(sipRaw.b)
        ? { a: sipRaw.a, b: sipRaw.b, crpixX, crpixY } : null;

    // 4. TPS
    const t = receipt?.solution?.astrometry?.tps;
    const tps: TpsBlock | null = t && Array.isArray(t.control_points) && t.control_points.length > 0
        ? t as TpsBlock : null;

    if (!nominal && !measured && !sip && !tps) return null;     // honest absence
    return { w: W, h: H, nominal, measured, sip, tps };
}

// ─── isometric wireframe surface tile ───────────────────────────────────────

const N = 9;                        // grid resolution per axis
const TW = 190, TH = 150;           // tile viewbox
const ISO = { ox: TW / 2, oy: 40, cw: 8.6, ch: 4.3, zScale: 78 };

function project(i: number, j: number, z: number): [number, number] {
    const sx = ISO.ox + (i - j) * ISO.cw;
    const sy = ISO.oy + (i + j) * ISO.ch - z * ISO.zScale;
    return [sx, sy];
}

const SurfaceTile: React.FC<{ title: string; z: number[][] | null; peak: number | null; colorVar: string }> = ({ title, z, peak, colorVar }) => (
    <div className="flex flex-col gap-1 border border-line rounded-lg p-2 bg-space-900/40" data-testid={`cascade-tile-${title.replace(/\s+/g, '-').toLowerCase()}`}>
        <div className="flex items-baseline justify-between">
            <span className="text-[9px] font-bold uppercase tracking-widest text-text-muted">{title}</span>
            <span className="font-mono text-[9px] text-data">{peak == null ? 'NOT MEASURED' : `peak ${peak.toFixed(2)}px`}</span>
        </div>
        {z == null ? (
            <div className="text-[10px] font-mono text-text-muted py-6 text-center">NOT MEASURED</div>
        ) : (
            <svg viewBox={`0 0 ${TW} ${TH}`} className="w-full h-auto select-none" role="img" aria-label={`${title} displacement surface`}>
                {/* row lines (constant i) */}
                {z.map((row, i) => (
                    <polyline key={`r${i}`} fill="none" style={{ stroke: `var(${colorVar})` }} strokeWidth={0.7} strokeOpacity={0.85}
                        points={row.map((v, j) => project(i, j, v).join(',')).join(' ')} />
                ))}
                {/* column lines (constant j) */}
                {z[0].map((_, j) => (
                    <polyline key={`c${j}`} fill="none" style={{ stroke: `var(${colorVar})` }} strokeWidth={0.7} strokeOpacity={0.5}
                        points={z.map((row, i) => project(i, j, row[j]).join(',')).join(' ')} />
                ))}
            </svg>
        )}
    </div>
);

function sampleSurface(fn: (x: number, y: number) => number, w: number, h: number): { z: number[][]; peak: number } {
    const raw: number[][] = [];
    let peak = 0;
    for (let i = 0; i < N; i++) {
        const row: number[] = [];
        for (let j = 0; j < N; j++) {
            const x = i / (N - 1) * w, y = j / (N - 1) * h;
            const s = Math.abs(fn(x, y));
            row.push(s); if (s > peak) peak = s;
        }
        raw.push(row);
    }
    const norm = peak > 0 ? raw.map(r => r.map(v => v / peak)) : raw.map(r => r.map(() => 0));
    return { z: norm, peak };
}

const DistortionCascadeRender: React.FC<WidgetRenderProps<CascadeData>> = ({ data }) => {
    const tiles = useMemo(() => {
        const { w, h, nominal, measured, sip, tps } = data;
        const mk = (fn: ((x: number, y: number) => number) | null) => fn ? sampleSurface(fn, w, h) : null;
        return {
            nominal: mk(nominal ? (x, y) => nominalRadialShiftPx(Math.hypot(x - nominal.cx, y - nominal.cy), nominal.k1, nominal.k2, nominal.k3, nominal.rRefPx) : null),
            measured: mk(measured ? (x, y) => measuredBcShiftPx(x, y, measured.coeffs, measured.cx, measured.cy, measured.halfDiag) : null),
            sip: mk(sip ? (x, y) => sipShiftPx(x, y, sip.a, sip.b, sip.crpixX, sip.crpixY) : null),
            tps: mk(tps ? (x, y) => tpsShiftPx(x, y, tps) : null),
        };
    }, [data]);

    return (
        <div className="flex flex-col gap-2" data-testid="widget-distortion-cascade-2d">
            <div className="grid grid-cols-2 gap-2">
                <SurfaceTile title="Nominal BC" z={tiles.nominal?.z ?? null} peak={tiles.nominal?.peak ?? null} colorVar="--chart-cat-4" />
                <SurfaceTile title="Measured BC" z={tiles.measured?.z ?? null} peak={tiles.measured?.peak ?? null} colorVar="--chart-cat-2" />
                <SurfaceTile title="SIP" z={tiles.sip?.z ?? null} peak={tiles.sip?.peak ?? null} colorVar="--chart-cat-1" />
                <SurfaceTile title="TPS" z={tiles.tps?.z ?? null} peak={tiles.tps?.peak ?? null} colorVar="--chart-cat-3" />
            </div>
            <div className="text-[10px] font-mono text-text-muted">
                render-side eval of each fitted model on a {N}×{N} grid · each surface normalized to its own peak (px annotated) · absent stage = NOT MEASURED
            </div>
        </div>
    );
};

export const distortionCascade2dWidget: WidgetManifest<CascadeData> = {
    id: 'distortion_cascade_2d',
    title: 'Distortion Cascade (2.5D)',
    intent: 'Displacement-magnitude surfaces for each distortion model the pipeline fitted (nominal BC → measured BC → SIP → TPS) side by side — how does the correction sharpen as the model gets richer, and where does each act?',
    dataSelector: selectDistortionCascade,
    weightTier: 'heavy',
    render: DistortionCascadeRender,
};
