/**
 * DATA-BACKED WIDGET (chart tier) — forced-photometry confirmation significance.
 *
 * PURE READ over `receipt.deep_confirmed` (the CATALOG_FORCED_CONFIRMED block
 * from forced_confirm.ts). Honest naming: the receipt records a SET-level
 * excess-Z gate (`setExcessZ`) plus PER-STAR forced-photometry SNR — it does
 * NOT record a per-star z, so this widget plots the per-star SNR distribution
 * (the forced-photometry detection significance) and surfaces `setExcessZ` as
 * the set-level gate readout. No fabricated per-star z is invented.
 *
 * Honest-or-absent: no deep_confirmed block, or no confirmed stars ⇒ null ⇒ the
 * dock frame shows NOT MEASURED.
 */

import React, { useMemo } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { finite, logHistogram } from '../widget_math';
import { Readout, VHistogram } from '../chart_primitives';

type TestName = 'snr' | 'localNull' | 'shape' | 'neighbor' | 'color';
const TESTS: TestName[] = ['snr', 'localNull', 'shape', 'neighbor', 'color'];

export interface ForcedPhotZData {
    examined: number | null;
    confirmed: number | null;
    setExcessZ: number | null;
    setGatePassed: boolean | null;
    approximate: boolean;
    snr: number[];
    /** per-test {pass, notMeasured, total} across confirmed stars. */
    tally: Record<TestName, { pass: number; notMeasured: number; total: number }>;
}

/** PURE selector: receipt.deep_confirmed → significance summary, or null. */
export function selectForcedPhotZ(receipt: WidgetReceipt): ForcedPhotZData | null {
    const dc = receipt?.deep_confirmed;
    if (!dc) return null;
    const stars: any[] = Array.isArray(dc.confirmed_stars) ? dc.confirmed_stars : [];
    if (stars.length === 0) return null;                         // honest absence
    const snr = stars.map(s => finite(s?.snr)).filter((v): v is number => v != null);
    const tally = Object.fromEntries(TESTS.map(t => [t, { pass: 0, notMeasured: 0, total: 0 }])) as ForcedPhotZData['tally'];
    for (const s of stars) {
        const tests = s?.tests ?? {};
        for (const t of TESTS) {
            const v = tests[t];
            if (v == null) continue;
            tally[t].total++;
            if (v === 'PASS') tally[t].pass++;
            else if (v === 'NOT_MEASURED') tally[t].notMeasured++;
        }
    }
    return {
        examined: finite(dc.examined),
        confirmed: finite(dc.confirmed),
        setExcessZ: finite(dc.setExcessZ),
        setGatePassed: typeof dc.setGatePassed === 'boolean' ? dc.setGatePassed : null,
        approximate: dc.approximate === true,
        snr, tally,
    };
}

const ForcedPhotZRender: React.FC<WidgetRenderProps<ForcedPhotZData>> = ({ data }) => {
    const hist = useMemo(() => logHistogram(data.snr, 20), [data.snr]);
    const edgeLabels = hist
        ? [hist.lo, Math.sqrt(hist.lo * hist.hi), hist.hi].map(v => v >= 100 ? v.toFixed(0) : v.toFixed(1))
        : [];
    return (
        <div className="flex flex-col gap-3" data-testid="widget-forced-photometry-z">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
                <Readout label="Examined" value={data.examined == null ? '—' : String(data.examined)} />
                <Readout label="Confirmed" value={data.confirmed == null ? '—' : String(data.confirmed)} />
                <Readout label="Set excess-Z" value={data.setExcessZ == null ? '—' : data.setExcessZ.toFixed(1)} />
                <Readout label="Gate"
                    value={data.setGatePassed == null ? '—' : data.setGatePassed ? 'PASSED' : 'FAILED'} />
            </div>
            {hist ? (
                <VHistogram counts={hist.counts} colorVar="--chart-cat-3"
                    xLabel="per-star forced-photometry SNR (log bins)" yLabel="stars"
                    edgeLabels={edgeLabels} testId="widget-forced-z-hist" />
            ) : (
                <div className="text-[10px] font-mono text-text-muted">No positive per-star SNR recorded.</div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-text-muted">
                {TESTS.map(t => {
                    const c = data.tally[t];
                    const label = c.total === 0
                        ? `${t}: —`
                        : c.notMeasured === c.total
                            ? `${t}: NOT MEASURED`
                            : `${t}: ${c.pass}/${c.total} pass`;
                    return <span key={t}>{label}</span>;
                })}
            </div>
            {data.approximate && <div className="text-[10px] font-mono text-warn">APPROXIMATE — set gate flagged approximate.</div>}
        </div>
    );
};

export const forcedPhotometryZWidget: WidgetManifest<ForcedPhotZData> = {
    id: 'forced_photometry_z',
    title: 'Forced-Photometry Significance',
    intent: 'Distribution of per-star forced-photometry SNR at catalog positions, plus the set-level excess-Z gate — did deep stars actually land where the WCS predicts?',
    dataSelector: selectForcedPhotZ,
    weightTier: 'chart',
    render: ForcedPhotZRender,
};
