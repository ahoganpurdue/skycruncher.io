import React, { useEffect, useState } from 'react';
import { OrchestratorSession } from '../pipeline/orchestrator_session';
import { getStepMeta } from './wizard_steps';
import './styles/Symbols.css';

interface IngestionStepProps {
    session: OrchestratorSession;
    /** Run-All: auto-advance when ingestion completes (same onComplete the button uses). */
    autoRun?: boolean;
    onComplete: () => void;
}

export const IngestionStep: React.FC<IngestionStepProps> = ({ session, autoRun, onComplete }) => {
    const [logs, setLogs] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [isComplete, setIsComplete] = useState(false);

    // AUTO: proceed once ingestion verified — same handler as the Proceed
    // button. Short beat so the completion state is visible, not subliminal.
    useEffect(() => {
        if (!autoRun || !isComplete) return;
        const id = setTimeout(onComplete, 700);
        return () => clearTimeout(id);
    }, [autoRun, isComplete, onComplete]);

    useEffect(() => {
        let isCancelled = false;
        
        const runIngestion = async () => {
            setLoading(true);
            setLogs([`[${new Date().toLocaleTimeString()}] INGESTION_SEQUENCE: [START]`]);
            
            // Poll for status updates from the session
            const statusInterval = setInterval(() => {
                const currentStatus = session.status;
                setLogs(prev => {
                    if (prev[prev.length - 1]?.includes(currentStatus)) return prev;
                    return [...prev, `[${new Date().toLocaleTimeString()}] ${currentStatus.toUpperCase().replace(/\s+/g, '_').replace(/\./g, '')}: [RUNNING]`];
                });
            }, 100);

            try {
                // ACTUALLY TRIGGER THE LOAD
                await session.step1_Load();
                
                if (!isCancelled) {
                    setLogs(prev => [
                        ...prev, 
                        `[${new Date().toLocaleTimeString()}] METADATA: Source=[${session.metadata?.timestamp_source}] Lat=[${session.metadata?.gps_lat}] Lon=[${session.metadata?.gps_lon}]`,
                        session.metadata?.gps_source === 'DEFAULT' ? `[${new Date().toLocaleTimeString()}] WARNING: Invalid zero-GPS or missing EXIF. Observer location absent (unmeasured).` : `[${new Date().toLocaleTimeString()}] GPS: Locked via EXIF.`,
                        `[${new Date().toLocaleTimeString()}] INGESTION_SEQUENCE: [COMPLETE]`
                    ]);
                    setLoading(false);
                    setIsComplete(true);
                }
            } catch (err) {
                if (!isCancelled) {
                    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ERROR: ${err instanceof Error ? err.message : String(err)}`]);
                    setLoading(false);
                }
            } finally {
                clearInterval(statusInterval);
            }
        };

        runIngestion();
        return () => { isCancelled = true; };
    }, [session]);

    return (
        <div className="flex flex-col h-full font-mono text-sm">
            <div className="p-8 border-b border-line-subtle">
                <h2 className="text-2xl font-light text-text-primary mb-2 font-sans italic">{getStepMeta(1).title}</h2>
                <p className="text-text-secondary font-sans max-w-xl">
                    {getStepMeta(1).subtitle}
                </p>
            </div>

            <div className="flex-1 overflow-y-auto p-8 space-y-2 scrollbar-thin scrollbar-thumb-white/10">
                {logs.map((log, i) => (
                    <div key={i} className="flex gap-4 animate-fadeIn">
                        <span className="text-text-faint whitespace-nowrap">{i + 1}.</span>
                        {/* Log lines emit upper-case markers (WARNING:/ERROR:) — match
                            case-insensitively so the severity color actually fires. */}
                        <span className={/WARNING/i.test(log) ? 'text-warn' : /ERROR/i.test(log) ? 'text-danger' : 'text-data'}>
                            {log}
                        </span>
                    </div>
                ))}
                {loading && (
                    <div className="flex gap-4 animate-pulse">
                        <span className="text-text-faint">_</span>
                        <span className="text-accent-300">Executing...</span>
                    </div>
                )}
                {isComplete && (
                    <div className="mt-8 p-4 bg-solve-dim border border-solve/30 rounded text-solve animate-bounce-in">
                        <div className="flex items-center gap-3">
                            <span className="icon-check"></span>
                            <div>
                                <div className="font-bold uppercase tracking-widest text-xs">Ingestion Verified</div>
                                {/* Honest-or-absent (LAW 3): absent metadata renders the
                                    '--' sentinel (kit/KV convention), never "undefined". */}
                                <div className="text-[10px] opacity-80">Payload mapped: {session.metadata?.camera_model || '--'} @ {session.metadata?.focal_length ? `${session.metadata.focal_length}mm` : '--'}</div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <div className="h-20 flex items-center justify-end px-8 bg-space-900/70 border-t border-line-subtle">
                <button
                    data-testid="step1-proceed"
                    onClick={onComplete}
                    disabled={!isComplete}
                    className="px-8 py-3 bg-accent-600 hover:bg-accent-500 disabled:bg-space-750 disabled:text-text-muted text-white rounded font-bold transition-all uppercase tracking-widest text-xs"
                >
                    Proceed to Context <span className="icon-arrow-right"></span>
                </button>
            </div>
            
            <style dangerouslySetInnerHTML={{ __html: `
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(5px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .animate-fadeIn {
                    animation: fadeIn 0.3s ease-out forwards;
                }
                @keyframes bounce-in {
                    0% { transform: scale(0.9); opacity: 0; }
                    50% { transform: scale(1.05); }
                    100% { transform: scale(1); opacity: 1; }
                }
                .animate-bounce-in {
                    animation: bounce-in 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
                }
            `}} />
        </div>
    );
};
