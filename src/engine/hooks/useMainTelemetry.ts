import { useState, useEffect } from 'react';
import { OrchestratorSession } from '../pipeline/orchestrator_session';

/**
 * useMainTelemetry
 * 
 * Bridges the UI to the TelemetryLogger.
 * Provides a reactive state of the latest telemetry report.
 */
export function useMainTelemetry(session: OrchestratorSession | null) {
    const [report, setReport] = useState<any>(session?.logger.getReport() || null);

    useEffect(() => {
        if (!session) return;

        // Subscribe to logger updates
        const unsubscribe = session.logger.subscribe((newReport: any) => {
            setReport({ ...newReport });
        });

        return () => {
            unsubscribe();
        };
    }, [session]);

    const logEvent = (stage: string, event: string, level?: string, data?: any) => {
        if (!session) return;
        session.logger.log(stage, event, level, data);
    };

    const downloadLogs = () => {
        if (!session) return;
        session.logger.downloadReport();
    };

    return {
        report,
        logEvent,
        downloadLogs
    };
}
