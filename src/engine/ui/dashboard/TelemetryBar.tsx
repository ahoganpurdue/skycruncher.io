import React from 'react';
import { Activity, Thermometer, Target, ShieldAlert, Zap } from 'lucide-react';
import { ForensicMetrics } from '../../types/Main_types';

interface TelemetryBarProps {
    metrics: ForensicMetrics;
    /** Real clean-star count, or null when no count exists on this data path
     *  (renders as '--' — never 0-as-fact). */
    starCount: number | null;
    anomalyCount: number;
}

export function TelemetryBar({ metrics, starCount, anomalyCount }: TelemetryBarProps) {
    const {
        interference_flag,
        global_bv_mean,
        mean_fwhm,
        rms_truth_score
    } = metrics;

    // rms_truth_score is `handshake_rms || 0` upstream — 0 is a "not computed"
    // sentinel, not a perfect solve. Same for global_bv_mean (no B-V-measured
    // stars) and mean_fwhm (no stars). Sentinels render as '--', never as fact.
    const hasRms = rms_truth_score > 0;
    // The derived score (100 − rms×10)% is only meaningful below 10″ RMS —
    // beyond that it goes negative (receipt reality: 31.09″ ⇒ −210.9%). The
    // MEASURED RMS is always the headline value; the score renders only
    // inside the formula's valid domain and is '--' otherwise.
    const inScoreDomain = hasRms && rms_truth_score < 10;
    const truthScore = inScoreDomain ? (100 - rms_truth_score * 10).toFixed(1) : null;
    const isObservatoryGrade = hasRms && rms_truth_score < 1.0;
    const hasBv = global_bv_mean !== 0;
    const hasFwhm = mean_fwhm > 0;

    return (
        <div className="telemetry-bar">
            {/* 1. Star/Anomaly Ratio */}
            <div className={`metric-card ${interference_flag ? 'warning' : ''}`}>
                <div className="metric-icon">
                    {interference_flag ? <ShieldAlert size={16} color="var(--sc-danger)" /> : <Activity size={16} color="var(--sc-accent)" />}
                </div>
                <div className="metric-info">
                    <div className="metric-label">Signal Density</div>
                    <div className="metric-value">
                        {starCount ?? '--'}<span className="unit"> / </span>{anomalyCount}
                    </div>
                    {interference_flag && <div className="metric-status">HIGH INTERFERENCE</div>}
                </div>
            </div>

            {/* 2. Global B-V Mean */}
            <div className="metric-card">
                <div className="metric-icon">
                    <Thermometer size={16} color="var(--sc-warn)" />
                </div>
                <div className="metric-info">
                    <div className="metric-label">Sky Temperature</div>
                    <div className="metric-value">
                        {hasBv ? global_bv_mean.toFixed(2) : '--'}<span className="unit"> B-V</span>
                    </div>
                </div>
            </div>

            {/* 3. Sharpness (FWHM) */}
            <div className="metric-card">
                <div className="metric-icon">
                    <Target size={16} color="var(--sc-solve)" />
                </div>
                <div className="metric-info">
                    <div className="metric-label">Focus Score</div>
                    <div className="metric-value">
                        {hasFwhm ? mean_fwhm.toFixed(1) : '--'}<span className="unit"> px</span>
                    </div>
                </div>
            </div>

            {/* 4. Truth Score (RMS) */}
            <div className={`metric-card ${isObservatoryGrade ? 'gold' : ''}`}>
                <div className="metric-icon">
                    <Zap size={16} color={isObservatoryGrade ? 'var(--sc-warn)' : 'var(--sc-info)'} />
                </div>
                <div className="metric-info">
                    <div className="metric-label">Truth Score</div>
                    <div className="metric-value">
                        {hasRms ? rms_truth_score.toFixed(2) : '--'}{hasRms && <span className="unit"> ″ RMS</span>}
                    </div>
                    <div className="metric-sub">
                        {hasRms
                            ? (truthScore !== null ? `score ${truthScore}%` : 'score -- (rms ≥ 10″)')
                            : 'RMS not measured'}
                    </div>
                </div>
            </div>

            <style>{`
                .telemetry-bar {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                    gap: 12px;
                    padding: 12px;
                    background: var(--sc-shell);
                    border-bottom: 1px solid var(--sc-line-subtle);
                    backdrop-filter: blur(12px);
                    z-index: 10;
                }
                .metric-card {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 8px 12px;
                    border-radius: 6px;
                    background: var(--sc-card);
                    border: 1px solid var(--sc-line-subtle);
                    transition: all 0.2s;
                }
                .metric-card.warning {
                    background: var(--sc-danger-dim);
                    border-color: var(--sc-danger);
                    animation: pulse-red 2s infinite;
                }
                .metric-card.gold {
                    border-color: var(--sc-warn);
                    background: var(--sc-warn-dim);
                }
                .metric-icon {
                    flex-shrink: 0;
                }
                .metric-info {
                    flex: 1;
                }
                .metric-label {
                    font-size: 10px;
                    text-transform: uppercase;
                    letter-spacing: 1px;
                    color: var(--sc-muted);
                    margin-bottom: 2px;
                }
                .metric-value {
                    font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace);
                    font-feature-settings: "tnum", "zero";
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--sc-data);
                }
                .metric-value .unit {
                    font-size: 10px;
                    opacity: 0.5;
                    font-weight: 400;
                }
                .metric-status {
                    font-size: 8px;
                    font-weight: 800;
                    color: var(--sc-danger);
                    margin-top: 2px;
                }
                .metric-sub {
                    /* Carries the derived score number — measured-number voice
                       (mono + tnum), same family as .metric-value. */
                    font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace);
                    font-feature-settings: "tnum", "zero";
                    font-size: 9px;
                    opacity: 0.4;
                    margin-top: 1px;
                }
                @keyframes pulse-red {
                    0% { border-color: color-mix(in srgb, var(--sc-danger) 50%, transparent); }
                    50% { border-color: var(--sc-danger); }
                    100% { border-color: color-mix(in srgb, var(--sc-danger) 50%, transparent); }
                }
            `}</style>
        </div>
    );
}
