import React, { useState } from 'react';
import { Crosshair } from 'lucide-react';

interface TargetHintInputProps {
    // If RA is -1, then Dec is interpreted as Azimuth (Degrees)
    onHintSubmit: (ra: number, dec: number, label: string) => void;
}

export const TargetHintInput: React.FC<TargetHintInputProps> = ({ onHintSubmit }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [manualRa, setManualRa] = useState('');
    const [manualDec, setManualDec] = useState('');
    const [searchTerm, setSearchTerm] = useState('');

    // Pre-defined "Top Hits" for quick testing (Can be expanded with a real catalog later)
    const QUICK_TARGETS = [
        { name: "Andromeda (M31)", ra: 0.712, dec: 41.26 },
        { name: "Orion Nebula (M42)", ra: 5.588, dec: -5.39 },
        { name: "Vega", ra: 18.616, dec: 38.78 },
        { name: "Polaris", ra: 2.53, dec: 89.26 },
        { name: "Sirius", ra: 6.75, dec: -16.71 },
        { name: "Pleiades (M45)", ra: 3.79, dec: 24.11 }
    ];

    // Button-enabling validity — the old handler silently no-opped on
    // empty/invalid coords, which reads as a broken button.
    const manualValid = !isNaN(parseFloat(manualRa)) && !isNaN(parseFloat(manualDec));

    const handleSubmit = () => {
        const ra = parseFloat(manualRa);
        const dec = parseFloat(manualDec);
        if (!isNaN(ra) && !isNaN(dec)) {
            onHintSubmit(ra, dec, "Manual Hint");
            setIsOpen(false);
        }
    };

    const handleQuickSelect = (target: typeof QUICK_TARGETS[0]) => {
        onHintSubmit(target.ra, target.dec, target.name);
        setManualRa(target.ra.toString());
        setManualDec(target.dec.toString());
        setSearchTerm(target.name);
        setIsOpen(false);
    };

    if (!isOpen) {
        return (
            <button 
                className="target-hint-trigger"
                onClick={() => setIsOpen(true)}
                title="Help the solver by providing a hint"
            >
                <Crosshair size={14} style={{ marginRight: 6 }} />
                <span>Add Search Hint</span>
            </button>
        );
    }

    return (
        <div className="target-hint-panel">
            <div className="hint-header">
                <Crosshair size={16} className="icon-pulse" />
                <h4>Target Hint</h4>
                <button className="close-btn" onClick={() => setIsOpen(false)}>&times;</button>
            </div>
            
            <div className="hint-body">
                <p className="hint-desc">
                    Help the Plate Solver find your stars.
                </p>

                <div className="quick-tags">
                    {QUICK_TARGETS.filter(t => t.name.toLowerCase().includes(searchTerm.toLowerCase())).slice(0, 4).map(t => (
                        <span key={t.name} className="tag" onClick={() => handleQuickSelect(t)}>
                            {t.name}
                        </span>
                    ))}
                </div>

                <div className="cardinal-section" style={{marginBottom: 12}}>
                    <label style={{fontSize: '0.7rem', color: 'var(--sc-muted)', display: 'block', marginBottom: 4}}>Cardinal Direction</label>
                    <div className="cardinal-grid">
                        {[
                            { label: 'NW', az: 315 }, { label: 'N', az: 0 }, { label: 'NE', az: 45 },
                            { label: 'W', az: 270 }, { label: 'Zenith', az: -1 }, { label: 'E', az: 90 },
                            { label: 'SW', az: 225 }, { label: 'S', az: 180 }, { label: 'SE', az: 135 }
                        ].map(dir => (
                            <button 
                                key={dir.label} 
                                className="cardinal-btn"
                                onClick={() => onHintSubmit(
                                    // Special hack: Pass negative RA to indicate "Azimuth Mode" to the parent
                                    -1, 
                                    dir.az, 
                                    dir.label === 'Zenith' ? 'Near Zenith' : `Looking ${dir.label}`
                                )}
                                title={dir.label}
                            >
                                {dir.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="manual-coords">
                    <div className="input-group">
                        <label>RA (Hours)</label>
                        <input 
                            type="number" 
                            step="0.1" 
                            value={manualRa} 
                            onChange={(e) => setManualRa(e.target.value)} 
                            placeholder="e.g. 5.5"
                        />
                    </div>
                    <div className="input-group">
                        <label>Dec (Deg)</label>
                        <input 
                            type="number" 
                            step="0.1" 
                            value={manualDec} 
                            onChange={(e) => setManualDec(e.target.value)} 
                            placeholder="e.g. -5.4"
                        />
                    </div>
                </div>

                <button
                    className="apply-hint-btn"
                    onClick={handleSubmit}
                    disabled={!manualValid}
                    title={manualValid ? 'Use these coordinates as the search hint' : 'Enter both RA (hours) and Dec (degrees) first'}
                >
                    Set Focus Target
                </button>
            </div>

            <style>{`
                .target-hint-trigger {
                    display: flex;
                    align-items: center;
                    background: var(--sc-card);
                    border: 1px solid var(--sc-line);
                    color: var(--sc-text-2);
                    padding: 6px 12px;
                    border-radius: 4px;
                    font-size: 0.8rem;
                    cursor: pointer;
                    margin-top: 8px;
                    transition: all 0.2s;
                }
                .target-hint-trigger:hover {
                    background: var(--sc-accent-glow);
                    color: var(--sc-accent);
                    border-color: var(--sc-accent-ring);
                }
                .target-hint-panel {
                    background: var(--sc-panel);
                    border: 1px solid var(--sc-line);
                    border-radius: 4px;
                    padding: 12px;
                    margin-top: 8px;
                    animation: fadeIn 0.2s ease-out;
                }
                .hint-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 8px;
                    color: var(--sc-accent);
                }
                .hint-header h4 {
                    margin: 0;
                    font-size: 0.9rem;
                    font-weight: 600;
                    flex-grow: 1;
                    margin-left: 8px;
                }
                .close-btn {
                    background: none;
                    border: none;
                    color: var(--sc-muted);
                    font-size: 1.2rem;
                    cursor: pointer;
                    padding: 0 4px;
                }
                .close-btn:hover { color: var(--sc-text); }
                .hint-desc {
                    font-size: 0.75rem;
                    color: var(--sc-text-2);
                    margin-bottom: 10px;
                }
                .quick-tags {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    margin-bottom: 12px;
                }
                .tag {
                    background: var(--sc-card);
                    padding: 4px 8px;
                    border-radius: 12px;
                    font-size: 0.7rem;
                    color: var(--sc-text-2);
                    cursor: pointer;
                    border: 1px solid transparent;
                }
                .tag:hover {
                    background: var(--sc-accent-glow);
                    color: var(--sc-text);
                    border-color: var(--sc-accent-ring);
                }
                .cardinal-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 4px;
                }
                .cardinal-btn {
                    background: var(--sc-card);
                    border: 1px solid var(--sc-line);
                    color: var(--sc-text-2);
                    padding: 6px;
                    border-radius: 4px;
                    font-size: 0.75rem;
                    cursor: pointer;
                    text-align: center;
                }
                .cardinal-btn:hover {
                    background: var(--sc-elev);
                    color: var(--sc-text);
                    border-color: var(--sc-line-strong);
                }
                .manual-coords {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 10px;
                }
                .input-group {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .input-group label {
                    font-size: 0.7rem;
                    color: var(--sc-muted);
                }
                .input-group input {
                    background: var(--sc-card);
                    border: 1px solid var(--sc-line);
                    color: var(--sc-text);
                    padding: 6px;
                    border-radius: 3px;
                    font-family: var(--font-mono, monospace);
                    font-size: 0.85rem;
                }
                .apply-hint-btn {
                    width: 100%;
                    background: var(--sc-btn-fill);
                    color: var(--sc-btn-fill-text);
                    border: 1px solid var(--sc-btn-border);
                    padding: 8px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 0.85rem;
                    font-weight: 500;
                }
                .apply-hint-btn:hover:not(:disabled) {
                    opacity: 0.9;
                }
                .apply-hint-btn:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                }
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(-5px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .icon-pulse {
                    color: var(--sc-warn);
                }
            `}</style>
        </div>
    );
};
