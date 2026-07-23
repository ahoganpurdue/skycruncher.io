import { useState, useEffect, useCallback } from 'react';
import { OrchestratorSession } from '../pipeline/orchestrator_session';
import { HardMetadata } from '../types/Main_types';

/**
 * usePipelineFSM
 * 
 * Manages the lifecycle of the OrchestratorSession and the stepwise flow
 * of the SkyCruncher pipeline. Mathematically enforces module transitions.
 */
export function usePipelineFSM(
    file: File | null,
    hint?: { ra: number; dec: number; label: string } | null
) {
    const [step, setStep] = useState<number>(1);
    const [session, setSession] = useState<OrchestratorSession | null>(null);
    const [metadata, setMetadata] = useState<HardMetadata | null>(null);
    const [isInitializing, setIsInitializing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Initialize Session
    useEffect(() => {
        if (!file) return;

        let mounted = true;
        const init = async () => {
            setIsInitializing(true);
            setError(null);
            try {
                const buffer = await file.arrayBuffer();
                if (mounted) {
                    // Forward the upload-surface target hint (search PRIOR only)
                    // to the session's CONFIG rung. Null on the default path →
                    // byte-identical to the historical solve.
                    const sess = new OrchestratorSession(buffer, { callerHint: hint ?? null });
                    setSession(sess);
                    if ((import.meta as any).env?.DEV) (window as any).__astroSession = sess;
                }
            } catch (err: any) {
                if (mounted) {
                    setError(err.message || 'Failed to initialize session buffer');
                }
            } finally {
                if (mounted) {
                    setIsInitializing(false);
                }
            }
        };
        init();

        return () => {
            mounted = false;
        };
    }, [file, hint]);

    const nextStep = useCallback(() => {
        if (!session) return;
        
        // Safety guards based on architecture rules
        if (step === 2 && !session.metadata) {
            console.warn('[PipelineFSM] Cannot proceed: Metadata validation required.');
            return;
        }
        // Phase 3 FSM Modification: Guard on computed_jd for module 6!
        // We simulate Plate Solver start around step 5 or similar. If we reach the phase needing proper motion:
        if (step >= 5) {
            // Check if computed_jd is available
            const jd = session.environment?.computed_jd;
            if (jd === undefined) {
                console.warn('[PipelineFSM] Cannot proceed: JD_VALIDATED missing but required for Plate Solving propagation.');
                // Depending on the UI flow we might want to throw or set exact step
                return;
            }
        }

        if (step === 4 && !session.signal) {
            console.warn('[PipelineFSM] Cannot proceed: Signal extraction required.');
            return;
        }

        setStep(prev => Math.min(prev + 1, 7));
    }, [step, session]);

    const prevStep = useCallback(() => {
        setStep(prev => Math.max(prev - 1, 1));
    }, []);

    const reset = useCallback(() => {
        setStep(1);
        // Note: We don't necessarily want to reload the whole file if just resetting steps
    }, []);

    const updateMetadata = useCallback((updates: Partial<HardMetadata>) => {
        if (!session) return;
        session.metadata = { ...session.metadata!, ...updates };
        setMetadata({ ...session.metadata });
    }, [session]);

    // Sync metadata from session when session updates it internally
    useEffect(() => {
        if (session && session.metadata) {
            setMetadata(session.metadata);
        }
    }, [session, step]); // Re-sync on step change in case session updated metadata

    return {
        step,
        session,
        metadata,
        isInitializing,
        error,
        nextStep,
        prevStep,
        setStep,
        reset,
        updateMetadata
    };
}
