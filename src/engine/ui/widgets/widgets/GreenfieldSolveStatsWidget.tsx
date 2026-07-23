/**
 * DATA-BACKED WIDGET (chart tier) — GREENFIELD SOLVE STATISTICS (all-real).
 *
 * A pure read over the greenfield receipt (`solution.greenfield_receipt` or a bare
 * receipt) — NO synthesis anywhere. It surfaces exactly what the solver recorded:
 *   - headline: terminal state · wall · log-odds · matches
 *   - per-band: quads/probes tested, in-tol hits, proposals, verified, bail counts,
 *     and probe+verify wall — in TESTED order (descending band, coarse→fine)
 *   - accept: band/rung/hypothesis + SANE fine-consensus corroboration count
 *   - provenance: index release + build
 *
 * Honest-or-absent (LAW 3): a field the receipt does not carry renders "NOT
 * RECORDED", NEVER 0. A genuinely-measured zero (e.g. a band coded 0 det_quads
 * because it was never coded) is shown as an explicit "skipped", not a fake count.
 *
 * Ledger: UI render layer only. Reads an already-collected receipt for display;
 * solves nothing, mutates nothing.
 */

import React from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { Readout, HBars, type HBar } from '../chart_primitives';
import { normalizeGreenfieldReceipt, type GreenfieldReceipt } from '../data/greenfield_receipt';

export interface GreenfieldStatsData { gf: GreenfieldReceipt }

/** PURE selector: any greenfield-bearing receipt → normalized stats, or null. */
export function selectGreenfieldStats(receipt: WidgetReceipt): GreenfieldStatsData | null {
    const gf = normalizeGreenfieldReceipt(receipt);
    if (!gf) return null;
    return { gf };
}

const NR = 'NOT RECORDED';
const num = (v: number | null | undefined, digits = 0): string =>
    (v == null || !Number.isFinite(v)) ? NR : (digits > 0 ? v.toFixed(digits) : String(v));
const ms = (v: number | null | undefined): string => (v == null || !Number.isFinite(v)) ? NR : `${v} ms`;

const GreenfieldStatsRender: React.FC<WidgetRenderProps<GreenfieldStatsData>> = ({ data }) => {
    const { gf } = data;
    const fv = gf.finalVerify;

    const coded = gf.perBand.filter(b => b.coded);
    const skipped = gf.perBand.filter(b => !b.coded);
    const saneCount = (gf.fineConsensus?.corroborating ?? []).filter(c => c.sane).length;
    const junkCount = (gf.fineConsensus?.corroborating ?? []).length - saneCount;

    // Per-band wall (probe + verify) stacked, coded bands only.
    const probeBars: HBar[] = coded.map(b => ({
        label: `band ${b.band}`, value: Math.round((b.probeWallMs ?? 0) + (b.verifyWallMs ?? 0)),
        colorVar: '--chart-cat-1',
        note: `(${num(b.probeWallMs)}+${num(b.verifyWallMs)})`,
    }));

    return (
        <div className="flex flex-col gap-3" data-testid="widget-greenfield-stats">
            {/* headline */}
            <div className="flex flex-wrap gap-x-5 gap-y-1">
                <Readout label="State" value={gf.state ?? NR} title="terminal solver state (load-bearing contract string)" />
                <Readout label="Wall" value={ms(gf.wallMs)} title="total solve wall time" />
                <Readout label="Log-odds" value={num(fv?.logOdds ?? null, 2)} title="final verify log-odds" />
                <Readout label="Matches" value={num(fv?.nMatched ?? (gf.matches.length || null))} title="verified matched stars" />
                <Readout label="Classification" value={gf.classification ?? NR} />
            </div>

            {/* accept summary */}
            <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-2">
                <Readout label="Accept band" value={num(gf.acceptBand)} />
                <Readout label="Rung" value={num(gf.acceptRung)} />
                <Readout label="Hypothesis" value={num(gf.hypothesisSeq)} title="accepted hypothesis sequence #" />
                <Readout label="Scale" value={gf.scaleArcsecPx != null ? `${gf.scaleArcsecPx.toFixed(3)} "/px` : NR} />
                <Readout label="Parity" value={num(gf.parity)} />
                <Readout label="Search truncated" value={gf.searchTruncated == null ? NR : (gf.searchTruncated ? 'yes' : 'no')} />
            </div>

            {/* per-band table (tested order: descending band) */}
            <div className="overflow-x-auto">
                <table className="w-full border-collapse font-mono text-[10px]" data-testid="widget-greenfield-stats-perband">
                    <thead>
                        <tr className="text-text-muted uppercase tracking-wider">
                            {['band', 'det quads', 'probes', 'raw hits', 'proposals', 'verified', 'bailed', 'probe ms', 'verify ms'].map(h => (
                                <th key={h} className="text-right px-1.5 py-0.5 border-b border-line">{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {[...coded].sort((a, b) => b.band - a.band).map(b => (
                            <tr key={b.band} className="text-data">
                                <td className="text-right px-1.5 py-0.5">{b.band}</td>
                                <td className="text-right px-1.5 py-0.5">{num(b.detQuads)}</td>
                                <td className="text-right px-1.5 py-0.5">{num(b.probes)}</td>
                                <td className="text-right px-1.5 py-0.5">{num(b.rawHits)}</td>
                                <td className="text-right px-1.5 py-0.5">{num(b.proposals)}</td>
                                <td className="text-right px-1.5 py-0.5">{num(b.verified)}</td>
                                <td className="text-right px-1.5 py-0.5">{num(b.bailed)}</td>
                                <td className="text-right px-1.5 py-0.5">{num(b.probeWallMs)}</td>
                                <td className="text-right px-1.5 py-0.5">{num(b.verifyWallMs)}</td>
                            </tr>
                        ))}
                        {skipped.length > 0 && (
                            <tr className="text-text-muted italic">
                                <td className="text-right px-1.5 py-0.5" colSpan={9}>
                                    bands {skipped.map(b => b.band).sort((a, b) => a - b).join(', ')} — not coded (accept abort; never probed)
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* wall per band */}
            {probeBars.length > 0 && (
                <div className="flex flex-col gap-1">
                    <div className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Wall per coded band (probe+verify)</div>
                    <HBars bars={probeBars} unit=" ms" testId="widget-greenfield-stats-walls" />
                </div>
            )}

            {/* fine-consensus corroboration */}
            <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-2">
                <Readout label="Consensus bands" value={gf.fineConsensus ? (gf.fineConsensus.bandsTested.join(', ') || NR) : NR} title="fine-consensus corroboration bands tested" />
                <Readout label="Sane corroborations" value={gf.fineConsensus ? String(saneCount) : NR}
                         title="corroborating quads that agree with the accepted pose (small offset, scale≈1, tight residuals)" />
                <Readout label="Discarded (junk)" value={gf.fineConsensus ? String(junkCount) : NR}
                         title="corroborations with implausible pose — NOT counted as evidence" />
                <Readout label="Consensus wall" value={ms(gf.fineConsensus?.wallMs ?? null)} />
            </div>

            {/* provenance */}
            <div className="text-[10px] font-mono text-text-muted border-t border-line pt-2">
                index: {gf.index?.releaseId ?? NR} · {gf.index?.totalQuads != null ? `${gf.index.totalQuads.toLocaleString()} quads` : NR}
                {gf.build?.solver_core_version ? ` · core ${String(gf.build.solver_core_version)}` : ''}
                {gf.frame ? ` · frame ${gf.frame.width}×${gf.frame.height} (${gf.frame.source})` : ''}
            </div>
        </div>
    );
};

export const greenfieldSolveStatsWidget: WidgetManifest<GreenfieldStatsData> = {
    id: 'greenfield_solve_stats',
    title: 'Greenfield Solve Statistics',
    intent: 'The greenfield solver core’s own account of a solve, all-real: terminal state, wall, log-odds and matches; per-band quads/probes/hits/proposals/verified/bail counts and probe+verify wall in tested order (coarse→fine); accept band/rung/hypothesis; and the count of SANE fine-consensus corroborations (junk poses discarded, never counted). Fields the receipt does not carry read NOT RECORDED, never zero.',
    dataSelector: selectGreenfieldStats,
    weightTier: 'chart',
    render: GreenfieldStatsRender,
};
