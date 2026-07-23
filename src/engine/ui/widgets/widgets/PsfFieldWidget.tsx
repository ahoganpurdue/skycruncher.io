/**
 * EXEMPLAR WIDGET (heavy tier) — PSF FWHM / ellipticity summary + region map.
 *
 * PARALLEL-NEW summary fed from the additive `psf_field` receipt block (the
 * serialized M10 characterization). The live-session PSF panel in ui/psf/
 * PsfPanel.tsx is LEFT UNTOUCHED — this widget is a receipt-only read, not a
 * refactor of that panel. PIXEL-ledger data, but this is pure display: it never
 * measures, never touches WCS / matched_stars.
 *
 * Honest-or-absent: psf_field null, method NOT_MEASURED, or no median FWHM ⇒
 * selector returns null ⇒ the dock frame shows NOT MEASURED. Every approximation
 * carried in the block is surfaced as APPROXIMATE.
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';

/** One cell of the serialized 3×3 region map (psf_characterize serializer). */
interface PsfRegion {
    n: number;
    fwhmMedianPx: number | null;
    ellipticityMedian: number | null;
}

export interface PsfFieldData {
    method: string;
    fwhmMedianMajPx: number | null;
    ellipticityMedian: number | null;
    nFit: number;
    /** Row-major top-left → bottom-right (the serializer's order). */
    regions: PsfRegion[];
    approximate: string[];
}

/** PURE selector: receipt.psf_field → summary, or null (NOT MEASURED). */
export function selectPsfField(receipt: WidgetReceipt): PsfFieldData | null {
    const pf = receipt?.psf_field;
    if (!pf) return null;
    if (pf.method === 'NOT_MEASURED') return null;
    if (pf.fwhm_median_maj_px == null) return null;   // honest absence
    const regionsRaw: any[] = Array.isArray(pf.regions) ? pf.regions : [];
    return {
        method: String(pf.method ?? 'NOT_MEASURED'),
        fwhmMedianMajPx: typeof pf.fwhm_median_maj_px === 'number' ? pf.fwhm_median_maj_px : null,
        ellipticityMedian: typeof pf.ellipticity_median === 'number' ? pf.ellipticity_median : null,
        nFit: typeof pf.n_fit === 'number' ? pf.n_fit : 0,
        regions: regionsRaw.map(r => ({
            n: typeof r?.n === 'number' ? r.n : 0,
            fwhmMedianPx: typeof r?.fwhmMedianPx === 'number' ? r.fwhmMedianPx : null,
            ellipticityMedian: typeof r?.ellipticityMedian === 'number' ? r.ellipticityMedian : null,
        })),
        approximate: Array.isArray(pf.approximate) ? pf.approximate : [],
    };
}

// Row-major 3×3 region labels (top-left → bottom-right), matching the serializer.
const REGION_LABELS = ['TL', 'TC', 'TR', 'L', 'C', 'R', 'BL', 'BC', 'BR'];

const PsfFieldRender: React.FC<WidgetRenderProps<PsfFieldData>> = ({ data }) => {
    const meds = data.regions.map(r => r.fwhmMedianPx).filter((m): m is number => m != null);
    const best = meds.length ? Math.min(...meds) : 0;
    const worst = meds.length ? Math.max(...meds) : 1;
    const span = Math.max(1e-6, worst - best);

    return (
        <div className="flex flex-col gap-3" data-testid="widget-psf-field">
            <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-text-muted">
                <span>STARS <span className="text-data">{data.nFit}</span></span>
                <span>MEDIAN FWHM <span className="text-data">{data.fwhmMedianMajPx != null ? `${data.fwhmMedianMajPx.toFixed(2)} px` : '—'}</span></span>
                {data.ellipticityMedian != null && (
                    <span>ELLIPTICITY <span className="text-data">{data.ellipticityMedian.toFixed(3)}</span></span>
                )}
                <span>METHOD <span className="text-data">{data.method}</span></span>
            </div>

            <div className="grid grid-cols-3 gap-1 w-64">
                {data.regions.slice(0, 9).map((cell, i) => {
                    const t = cell.fwhmMedianPx != null ? (cell.fwhmMedianPx - best) / span : 0;
                    // Softer corner (higher FWHM) = warmer amber; matches the step-6
                    // report card intent, now token-driven (cat-2 == warn amber).
                    const bg = cell.fwhmMedianPx != null
                        ? `color-mix(in srgb, var(--chart-cat-2) ${(5 + 40 * t).toFixed(1)}%, transparent)`
                        : 'transparent';
                    return (
                        <div
                            key={REGION_LABELS[i] ?? i}
                            title={`${REGION_LABELS[i] ?? ''}: ${cell.n} stars`}
                            className="rounded border border-line p-2 text-center"
                            style={{ backgroundColor: bg }}
                        >
                            <div className="font-mono text-data text-sm">{cell.fwhmMedianPx != null ? cell.fwhmMedianPx.toFixed(2) : '—'}</div>
                            <div className="text-[9px] text-text-muted font-mono">{cell.n > 0 ? `n=${cell.n}` : 'no stars'}</div>
                        </div>
                    );
                })}
            </div>
            <div className="text-[10px] text-text-muted font-mono">median FWHM(maj) px per region · amber = softer corner</div>

            {data.approximate.map((a, i) => (
                <div key={i} className="text-[10px] font-mono text-warn">APPROXIMATE — {a}</div>
            ))}
        </div>
    );
};

export const psfFieldWidget: WidgetManifest<PsfFieldData> = {
    id: 'psf_field',
    title: 'PSF Field',
    intent: 'Per-region median FWHM / ellipticity across the frame — where is the image sharp, and where do stars smear (corner softness, tilt)?',
    dataSelector: selectPsfField,
    weightTier: 'heavy',
    render: PsfFieldRender,
};
