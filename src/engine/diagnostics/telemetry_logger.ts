
/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * TELEMETRY LOGGER â€” The "Control Room"
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Captures granular runtime data from the pipeline for debugging and AI analysis.
 * Maintains a single, hierarchical JSON object of the pipeline state.
 */

export interface DiagnosticConfig {
    vanguardSigma: number;
    deepScanSigma: number;
    maxFwhm: number;
    minCircularity: number;
    planetarytolerancePx: number;
}

export type TelemetryStageId = 'ingest' | 'stamping' | 'demosaic' | 'signal' | 'solver' | 'verification' | 'calibration' | 'registration' | 'stacking' | 'post_process' | 'flat';

export class TelemetryLogger {
    private report: {
        session_id: string;
        timestamp: string;
        config: DiagnosticConfig;
        hardware_profile: any;
        stages: Record<string, any>;
        anomalies: any[];
        final_lock: any;
        manifest?: any;
    };

    constructor(sessionId: string, config: DiagnosticConfig) {
        this.report = {
            session_id: sessionId,
            timestamp: new Date().toISOString(),
            config: config,
            hardware_profile: {},
            stages: {},
            anomalies: [],
            final_lock: {}
        };
    }

    private subscribers: ((report: any) => void)[] = [];

    public subscribe(callback: (report: any) => void) {
        this.subscribers.push(callback);
        // Emit immediately upon subscription so UI gets current state
        callback(this.report);
        return () => {
            this.subscribers = this.subscribers.filter(cb => cb !== callback);
        };
    }

    private emit() {
        this.subscribers.forEach(cb => cb(this.report));
    }

    public logManifest(manifest: any) {
        this.report.manifest = { ...manifest };
        this.emit();
    }

    public logStage(stageName: string, statusOrDuration: string | number, data?: any) {
        const timestamp = new Date().toISOString();
        
        if (!this.report.stages[stageName]) {
            this.report.stages[stageName] = { 
                 status: 'PENDING', 
                 events: [] 
            };
        }

        const stage = this.report.stages[stageName];
        
        if (typeof statusOrDuration === 'number') {
            stage.duration_ms = statusOrDuration;
        } else {
            stage.status = statusOrDuration;
            stage.timestamp = timestamp;
        }
        
        if (data) {
            Object.assign(stage, data);
        }
        
        this.emit();
    }

    public logHardware(profile: any) {
        this.report.hardware_profile = profile;
        this.emit();
    }

    public logAnomaly(type: string, data: any) {
        this.report.anomalies.push({ type, ...data });
        this.emit();
    }

    public logFinalLock(data: any) {
        this.report.final_lock = data;
        this.emit();
    }

    // Adaptor for existing code that uses updateState / log
    // We map these to the new structure to avoid breaking existing calls immediately
    public updateState(section: string, data: any) {
        if (!this.report.stages[section]) {
            this.report.stages[section] = {};
        }
        this.report.stages[section] = { ...this.report.stages[section], ...data };
        this.emit();
    }
    
    public log(stage: string, event: string, level?: string, data?: any) {
        // Map legacy log calls to stages or anomalies
        // If event is actually a message, handle it
        if (!level) {
             // Overload: log(stage, message)
             const msg = event;
             this.updateState(stage, { last_message: msg });
        } else if (level === 'ERROR' || level === 'WARN') {
            this.logAnomaly(event, { stage, level, data });
        } else {
            this.updateState(stage, { [event]: data });
        }
        this.emit();
    }


    public getReport() {
        return this.report;
    }

    /**
     * Triggers a browser download of the telemetry report as a JSON file.
     */
    public downloadReport() {
        if (typeof document === 'undefined') return;
        
        const blob = new Blob([JSON.stringify(this.report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `skycruncher_telemetry_${this.report.session_id}_${new Date().getTime()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Generates a Markdown-formatted report for LLM ingestion.
     * Designed to be copied/pasted into an AI chat for instant debugging.
     */
    public generateAIDebugReport(): string {
        const r = this.report;
        let md = `# SKYCRUNCHER Telemetry Report (${r.timestamp})\n`;
        md += `**Session ID:** \`${r.session_id}\`\n\n`;

        md += `## 1. Configuration & Hardware\n`;
        md += `- **Vanguard Sigma:** ${r.config.vanguardSigma}\n`;
        md += `- **Deep Scan Sigma:** ${r.config.deepScanSigma}\n`;
        md += `- **Camera:** ${r.hardware_profile.camera || 'N/A'}\n`;
        md += `- **Focal Length:** ${r.hardware_profile.focal_length || 'N/A'} mm\n`;
        md += `- **Scale:** ${r.hardware_profile.inferred_scale?.toFixed(2) || 'N/A'} "/px\n\n`;

        md += `## 2. Pipeline Stages\n`;
        for (const [stage, data] of Object.entries(r.stages)) {
            md += `### ${stage}\n`;
            if (data.duration_ms) md += `- **Duration:** ${data.duration_ms}ms\n`;
            for (const [key, val] of Object.entries(data)) {
                if (key === 'duration_ms') continue;
                const valStr = typeof val === 'object' ? JSON.stringify(val) : val;
                md += `- **${key}:** ${valStr}\n`;
            }
            md += `\n`;
        }

        md += `## 3. Anomalies & Warnings\n`;
        if (r.anomalies.length === 0) {
            md += `_No anomalies detected._\n`;
        } else {
            r.anomalies.forEach(a => {
                md += `- **[${a.type}]** ${JSON.stringify(a)}\n`;
            });
        }
        md += `\n`;

        md += `## 4. Final Lock State\n`;
        if (Object.keys(r.final_lock).length === 0) {
            md += `_No lock data recorded._\n`;
        } else {
            for (const [key, val] of Object.entries(r.final_lock)) {
                 md += `- **${key}:** ${val}\n`;
            }
        }

        return md;
    }
}

