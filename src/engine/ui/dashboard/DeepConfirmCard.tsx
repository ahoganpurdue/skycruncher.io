import React from 'react';
import { Card, Chip, EmptyState } from '../kit';
import { PlateSolution } from '../../types/Main_types';
import { PIPELINE_CONSTANTS } from '../../pipeline/constants/pipeline_config';

/**
 * DEEP CONFIRMATION CARD (gallery W2.1) — first UI consumer of
 * `solution.deep_confirmed` (CATALOG_FORCED_CONFIRMED, forced_confirm.ts).
 *
 * LAW 3 (honest-or-absent):
 *  - `deep_confirmed` absent → the card renders NOTHING (no empty frame).
 *  - `not_measured` set → NOT MEASURED chip + the pipeline-authored reason;
 *    no fabricated stats.
 *  - The gate chip is EARNED: solve-green "PASSED" only on
 *    `setGatePassed === true`; otherwise danger "FAILED".
 *  - `setExcessZ` null → the `--` sentinel, never a fake 0σ.
 *  - The gate threshold in the label is read from PIPELINE_CONSTANTS
 *    (SOLVER_CONFIRM_SET_EXCESS_Z), never hardcoded copy.
 *
 * MANDATORY caveat chip (Architecture Appendix L.3): the set gate was
 * calibrated on a single SeeStar M66 frame — "N=1 CALIBRATED — SEESTAR ONLY"
 * renders in every non-null state. This widget may not ship without it.
 */

export type DeepConfirmed = NonNullable<PlateSolution['deep_confirmed']>;

interface DeepConfirmCardProps {
    deep: DeepConfirmed | null | undefined;
}

/** Label/value row — 9-10px uppercase tracked label, data voice on the right. */
const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-center justify-between gap-2">
        <span className="text-text-muted text-[10px] uppercase tracking-wider font-sans">{label}</span>
        <span className="flex items-center gap-1.5">{children}</span>
    </div>
);

export function DeepConfirmCard({ deep }: DeepConfirmCardProps) {
    // Honest absence: no deep_confirmed block → no card, no empty frame.
    if (deep == null) return null;

    const gatePassed = deep.setGatePassed === true;
    const pct = deep.examined > 0 ? (deep.confirmed / deep.examined) * 100 : null;
    const excess = deep.setExcessZ != null
        ? `${deep.setExcessZ >= 0 ? '+' : ''}${deep.setExcessZ.toFixed(1)}σ`
        : '--';

    return (
        <Card testid="deep-confirm-card" className="mt-3">
            <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                <h4 className="text-text-muted text-[10px] font-bold uppercase tracking-widest m-0">
                    Forced-Photometry Confirmation
                </h4>
                {/* MANDATORY — Architecture Appendix L.3. Never remove. */}
                <Chip tone="warn" testid="deep-confirm-caveat">N=1 CALIBRATED — SEESTAR ONLY</Chip>
            </div>

            {deep.not_measured != null ? (
                <div className="flex flex-col gap-1.5" data-testid="deep-confirm-not-measured">
                    <span><Chip tone="neutral">NOT MEASURED</Chip></span>
                    <EmptyState>{deep.not_measured}</EmptyState>
                </div>
            ) : (
                <>
                    <div
                        data-testid="deep-confirm-stat"
                        className="font-mono text-data tabular-nums text-2xl leading-none"
                    >
                        {deep.confirmed}
                        <span className="text-text-muted text-[0.65em]"> / {deep.examined} confirmed</span>
                    </div>

                    {pct != null && (
                        <div aria-hidden="true" className="h-1.5 mt-1.5 rounded-full bg-space-700 overflow-hidden">
                            <div
                                data-testid="deep-confirm-bar"
                                className="h-full bg-accent-500"
                                style={{ width: `${pct.toFixed(1)}%` }}
                            />
                        </div>
                    )}

                    <div className="font-mono text-[11px] mt-3 flex flex-col gap-1">
                        <Row label="Set excess">
                            {/* Sentinel wears the muted voice, never the measured-number color (A.6). */}
                            <span
                                className={deep.setExcessZ != null ? 'text-data tabular-nums' : 'text-text-muted'}
                                data-testid="deep-confirm-excess"
                            >{excess}</span>
                        </Row>
                        <Row label={`Set gate (≥${PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z}σ)`}>
                            {gatePassed ? (
                                <Chip tone="solve" testid="deep-confirm-gate">PASSED</Chip>
                            ) : (
                                <Chip tone="danger" testid="deep-confirm-gate">FAILED</Chip>
                            )}
                        </Row>
                        <Row label="Grid">
                            {/* 8-bit fallback grid is an honest degradation → warn chip, earned by the flag. */}
                            {deep.approximate && <Chip tone="warn" testid="deep-confirm-approx">APPROXIMATE</Chip>}
                            <span className="text-data" data-testid="deep-confirm-grid">{deep.grid}</span>
                        </Row>
                        <Row label="Provenance">
                            <Chip tone="accent" testid="deep-confirm-provenance">{deep.provenance}</Chip>
                        </Row>
                    </div>
                </>
            )}
        </Card>
    );
}
