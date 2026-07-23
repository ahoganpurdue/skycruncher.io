import React from 'react';
import { Award, Compass, TrendingDown, TrendingUp } from 'lucide-react';
import { MatchedStar, PlateSolution } from '../../types/Main_types';
import { Chip } from '../kit';

type DeepForced = NonNullable<PlateSolution['deep_forced']>;

interface StarIntegrityListProps {
    matches: MatchedStar[];
    /**
     * CATALOG_FORCED harvest (solution.deep_forced) — forced-photometry rows
     * measured at catalog-predicted positions, NEVER blind detections. They
     * render as explicitly classed rows (FORCED chip + dashed accent rail) so
     * provenance is visually inseparable from the row — "never silently
     * mixed" with the matched WCS anchors (gallery W2.3).
     */
    forced?: DeepForced | null;
}

export function StarIntegrityList({ matches, forced }: StarIntegrityListProps) {
    // Take Top 20 best matches
    const top20 = [...matches]
        .sort((a, b) => a.residual_arcsec - b.residual_arcsec)
        .slice(0, 20);

    // Forced rows: honest-or-absent — only rows the harvest actually accepted.
    // The deep harvest probes ALL in-field catalog stars (matched anchors
    // included), so bright anchors appear in BOTH lists. A star already shown
    // as a MATCHED anchor is excluded from the forced display — one star, one
    // row, provenance classes stay disjoint (the count chips keep the full
    // per-class totals). Top 20 by SNR after exclusion.
    const matchedIds = new Set(
        matches.map(m => m.catalog.gaia_id).filter((id): id is string => !!id),
    );
    const forcedStars = forced?.stars ?? [];
    const forcedTop20 = forcedStars
        .filter(s => !(s.gaia_id && matchedIds.has(s.gaia_id)))
        .sort((a, b) => b.snr - a.snr)
        .slice(0, 20);

    if (top20.length === 0 && forcedTop20.length === 0) {
        return (
            <div className="star-integrity empty">
                <div className="empty-text">No matched stars available.</div>
            </div>
        );
    }

    return (
        <div className="star-integrity">
            <div className="dashboard-section-header">
                < Award size={14} className="header-icon" />
                "Top 20" Star Integrity (WCS Anchors)
            </div>

            {/* Provenance counts (gallery W2.3) — chips are EARNED: each renders
                only when its class actually has members; no `0 …` chips. */}
            {(matches.length > 0 || forcedStars.length > 0) && (
                <div className="prov-chips" data-testid="integrity-prov-chips">
                    {matches.length > 0 && (
                        <Chip tone="solve" testid="integrity-count-matched">{matches.length} MATCHED</Chip>
                    )}
                    {forcedStars.length > 0 && (
                        <Chip tone="accent" testid="integrity-count-forced">{forcedStars.length} CATALOG-FORCED</Chip>
                    )}
                    {/* Additive honesty caption (the header string above is
                        load-bearing and stays): forced rows are photometry
                        probes at predicted positions, NOT WCS anchors. */}
                    {forcedStars.length > 0 && (
                        <span className="prov-note" data-testid="integrity-prov-note">
                            forced rows = photometry probes, not WCS anchors
                        </span>
                    )}
                </div>
            )}

            <div className="integrity-list scrollbar-thin">
                <table className="integrity-table">
                    <thead>
                        <tr>
                            <th>Catalog ID</th>
                            <th>Class</th>
                            <th>Residual</th>
                            <th>Vector</th>
 <th> Mag</th>
                            <th>SNR</th>
                        </tr>
                    </thead>
                    <tbody>
                        {top20.map((m, idx) => {
                            // Δmag only exists when the detection carries a
                            // measured magnitude — never fabricate one from 0.
                            const magDelta = m.detected.magnitude != null
                                ? m.detected.magnitude - m.catalog.mag
                                : null;
                            const isBrighter = magDelta != null && magDelta < 0;
                            // Real residual direction (dx/dy) — no random
                            // decorative rotation. '--' when no vector exists.
                            const vectorAngle = m.residual
                                ? Math.atan2(m.residual.dy, m.residual.dx) * 180 / Math.PI
                                : null;

                            return (
                                <tr key={`matched-${m.catalog.gaia_id || idx}`}>
                                    <td className="catalog-id">{m.catalog.name || m.catalog.gaia_id || 'Unknown'}</td>
                                    <td><Chip tone="solve">MATCHED</Chip></td>
                                    <td className="residual">{m.residual_arcsec.toFixed(2)}"</td>
                                    <td className={vectorAngle != null ? 'vector' : 'vector cell-absent'}>
                                        {vectorAngle != null ? (
                                            <div className="vector-icon" style={{ transform: `rotate(${vectorAngle}deg)` }}>
                                                <Compass size={12} />
                                            </div>
                                        ) : '--'}
                                    </td>
                                    {magDelta != null ? (
                                        <td className={`mag-delta ${isBrighter ? 'brighter' : 'dimmer'}`}>
                                            {isBrighter ? <TrendingDown size={10} /> : <TrendingUp size={10} />}
                                            {Math.abs(magDelta).toFixed(1)}
                                        </td>
                                    ) : (
                                        <td className="mag-delta cell-absent">--</td>
                                    )}
                                    {/* Per-star SNR: honestly '--' when the
                                        detection carries no measured SNR. */}
                                    <td className={m.detected.snr != null ? 'snr' : 'snr cell-absent'}>{m.detected.snr != null ? m.detected.snr.toFixed(1) : '--'}</td>
                                </tr>
                            );
                        })}

                        {/* CATALOG_FORCED rows — dashed accent rail + FORCED chip;
                            aperture measurements at predicted positions, so no
                            residual/vector exists ('--', never a fake 0). */}
                        {forcedTop20.map((s, idx) => (
                            <tr key={`forced-${s.gaia_id || idx}`} className="forced-row" data-testid="integrity-forced-row">
                                <td className={s.gaia_id ? 'catalog-id' : 'catalog-id cell-absent'}>{s.gaia_id || '--'}</td>
                                <td><Chip tone="accent">FORCED</Chip></td>
                                <td className="residual-absent">--</td>
                                <td className="vector cell-absent">--</td>
                                <td className={s.mag != null ? 'mag-delta' : 'mag-delta cell-absent'}>{s.mag != null ? s.mag.toFixed(2) : '--'}</td>
                                <td className="snr">{s.snr.toFixed(1)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <style>{`
                .star-integrity {
                    background: var(--sc-shell);
                    border: 1px solid var(--sc-line-subtle);
                    border-radius: 8px;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    max-height: 300px;
                }
                .prov-chips {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 6px;
                    padding: 8px 12px;
                    border-bottom: 1px solid var(--color-line-subtle);
                }
                .prov-note {
                    font-size: 9px;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--color-text-muted);
                }
                .integrity-list {
                    flex: 1;
                    overflow-y: auto;
                }
                .integrity-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 11px;
                }
                .integrity-table th {
                    text-align: left;
                    padding: 8px 12px;
                    background: var(--sc-card);
                    color: var(--sc-muted);
                    text-transform: uppercase;
                    font-size: 9px;
                    position: sticky;
                    top: 0;
                }
                .integrity-table td {
                    padding: 6px 12px;
                    border-bottom: 1px solid var(--sc-line-subtle);
                    font-family: var(--font-mono, monospace);
                }
                .integrity-table tr:hover {
                    background: var(--sc-elev);
                }

                /* Forced-photometry classing (gallery W2.3): the dashed accent
                   rail marks provenance CATALOG_FORCED on the row itself —
                   tokens only, no raw hex. */
                .integrity-table tr.forced-row td {
                    background: color-mix(in srgb, var(--color-accent-glow) 40%, transparent);
                }
                .integrity-table tr.forced-row td:first-child {
                    border-left: 2px dashed var(--color-accent-500);
                }
                .integrity-table tr.forced-row:hover td {
                    background: color-mix(in srgb, var(--color-accent-glow) 60%, transparent);
                }
                .residual-absent {
                    color: var(--color-text-muted);
                }
                .snr {
                    color: var(--color-data);
                    font-feature-settings: "tnum" 1, "zero" 1;
                }

                .catalog-id {
                    color: var(--sc-text);
                    font-weight: 500;
                }
                .residual {
                    color: var(--sc-solve);
                }
                .vector {
                    color: var(--sc-faint);
                }
                .vector-icon {
                    display: inline-block;
                }

                .mag-delta {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                .mag-delta.brighter { color: var(--sc-accent); }
                .mag-delta.dimmer { color: var(--sc-danger); }

                /* Sentinel voice — LAST so it wins the equal-specificity tie
                   against .catalog-id/.vector/.snr/.mag-delta: every '--'
                   reads muted, never a value voice (A.6). */
                .cell-absent {
                    color: var(--color-text-muted);
                }

                .empty {
                    padding: 40px;
                    text-align: center;
                    border: 1px dashed var(--sc-line);
                }
            `}</style>
        </div>
    );
}
