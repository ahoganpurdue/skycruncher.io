import { useState, useCallback, useEffect } from 'react';
import { OrchestratorSession } from '../pipeline/orchestrator_session';
import { PlateSolution } from '../types/Main_types';

/**
 * usePlateSolver
 * 
 * Orchestrates the asynchronous plate solving process.
 * Manages solving state, progress status, and the final solution.
 */
export function usePlateSolver(session: OrchestratorSession | null) {
    const [isSolving, setIsSolving] = useState(false);
    const [status, setStatus] = useState('');
    const [solution, setSolution] = useState<PlateSolution | null>(session?.solution || null);
    const [error, setError] = useState<string | null>(null);

    const solve = useCallback(async () => {
        if (!session || isSolving) return;

        setIsSolving(true);
        setError(null);
        setStatus('Initializing Solver...');

        // Update status from session periodically
        const interval = setInterval(() => {
            setStatus(session.status);
        }, 100);

        try {
            const res = await session.step4_Solve();
            setSolution(res);
            if (!res) {
                setError('Plate solve failed to find a solution.');
            }
        } catch (err: any) {
            console.error('[usePlateSolver] Solve Error:', err);
            setError(err.message || 'An unexpected error occurred during plate solving.');
        } finally {
            clearInterval(interval);
            setIsSolving(false);
        }
    }, [session, isSolving]);

    // Sync solution if session changed
    useEffect(() => {
        if (session) {
            setSolution(session.solution);
        }
    }, [session]);

    return {
        solve,
        isSolving,
        status,
        solution,
        error
    };
}
