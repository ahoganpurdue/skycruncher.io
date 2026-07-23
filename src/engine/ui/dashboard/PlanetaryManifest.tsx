import React from 'react';
import { Box, Circle, HelpCircle, Info } from 'lucide-react';
import { SolarBody } from '../../types/Main_types';

interface PlanetaryManifestProps {
    planets: SolarBody[];
    onHoverBody?: (body: SolarBody | null) => void;
}

export function PlanetaryManifest({ planets, onHoverBody }: PlanetaryManifestProps) {
    if (planets.length === 0) {
        return (
            <div className="planetary-manifest empty">
                <div className="empty-text">No solar system bodies detected in frame.</div>
            </div>
        );
    }

    return (
        <div className="planetary-manifest">
            <div className="dashboard-section-header">
                <Box size={14} className="header-icon" />
                Planetary Manifest (Anchors)
            </div>
            
            <div className="manifest-list scrollbar-thin">
                {planets.map((body) => (
                    <div 
                        key={body.id} 
                        className="manifest-row"
                        onMouseEnter={() => onHoverBody?.(body)}
                        onMouseLeave={() => onHoverBody?.(null)}
                    >
                        <div className="body-main">
                            <div className="body-color-swatch" style={{ background: body.color || 'var(--sc-text)' }} />
                            <div className="body-identification">
                                <div className="body-name">{body.name.toUpperCase()}</div>
                                <div className="body-type">{body.type}</div>
                            </div>
                        </div>

                        <div className="body-stats">
                            <div className="stat">
                                <span className="label">Angular Size</span>
                                <span className="value">{body.radius_arcsec.toFixed(1)}"</span>
                            </div>
                            <div className="stat">
                                {/* Phase only when the ephemeris computed one —
                                    a missing phase is '--', not a fake 100%. */}
                                <span className="label">Phase</span>
                                <span className="value">{body.phase != null ? `${(body.phase * 100).toFixed(1)}%` : '--'}</span>
                            </div>
                            <div className="stat">
                                {/* The real state is binary (handshake locked or
                                    not) — no fabricated percentage bar. */}
                                <span className="label">Match</span>
                                <span className={`value ${body.locked ? 'match-locked' : 'match-candidate'}`}>
                                    {body.locked ? 'LOCKED' : 'CANDIDATE'}
                                </span>
                            </div>
                        </div>

                        <div className="body-residuals" title="Residual Error to Catalog">
                             <div className="residual-label">RMS</div>
                             <div className="residual-value">{body.residual_pixels != null ? `${body.residual_pixels.toFixed(2)} px` : '--'}</div>
                        </div>
                    </div>
                ))}
            </div>

            <style>{`
                .planetary-manifest {
                    background: var(--sc-shell);
                    border: 1px solid var(--sc-line-subtle);
                    border-radius: 8px;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    max-height: 300px;
                }
                .dashboard-section-header {
                    padding: 10px 16px;
                    background: var(--sc-card);
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 1.5px;
                    color: var(--sc-text-2);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    border-bottom: 1px solid var(--sc-line-subtle);
                }
                .header-icon { opacity: 0.5; }

                .manifest-list {
                    flex: 1;
                    overflow-y: auto;
                    padding: 8px;
                }
                .manifest-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 10px;
                    border-radius: 4px;
                    background: var(--sc-card);
                    margin-bottom: 4px;
                    transition: background 0.2s, transform 0.1s;
                    cursor: crosshair;
                }
                .manifest-row:hover {
                    background: var(--sc-accent-glow);
                    transform: translateX(4px);
                }
                
                .body-main {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    width: 150px;
                }
                .body-color-swatch {
                    width: 12px;
                    height: 12px;
                    border-radius: 50%;
                    box-shadow: 0 0 8px currentColor;
                    flex-shrink: 0;
                }
                .body-name {
                    font-size: 13px;
                    font-weight: 800;
                    color: var(--sc-text);
                    letter-spacing: 0.5px;
                }
                .body-type {
                    font-size: 9px;
                    color: var(--sc-muted);
                    text-transform: uppercase;
                }

                .body-stats {
                    flex: 1;
                    display: flex;
                    gap: 24px;
                    padding: 0 16px;
                }
                .stat {
                    display: flex;
                    flex-direction: column;
                }
                .stat .label {
                    font-size: 9px;
                    color: var(--sc-muted);
                    text-transform: uppercase;
                }
                .stat .value {
                    font-family: var(--font-mono, monospace);
                    font-size: 11px;
                    color: var(--sc-data);
                }

                /* Status color is earned: solve-green only for a confirmed
                   ephemeris lock; candidates stay neutral. */
                .stat .value.match-locked { color: var(--sc-solve); }
                .stat .value.match-candidate { color: var(--sc-text-2); }

                .body-residuals {
                    text-align: right;
                    border-left: 1px solid var(--sc-line-subtle);
                    padding-left: 16px;
                }
                .residual-label {
                    font-size: 8px;
                    color: var(--sc-muted);
                }
                .residual-value {
                    font-family: var(--font-mono, monospace);
                    font-size: 10px;
                    color: var(--sc-danger);
                }

                .empty {
                    padding: 40px;
                    text-align: center;
                    border: 1px dashed var(--sc-line);
                }
                .empty-text {
                    font-size: 12px;
                    color: var(--sc-muted);
                }
            `}</style>
        </div>
    );
}
