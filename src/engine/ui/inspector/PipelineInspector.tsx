import React from 'react';
import { InspectorModel, StageRow } from './inspector_model';
import { FindingsFeed } from './FindingsFeed';

/**
 * PIPELINE INSPECTOR — the Glass Pipeline surface (Phase U).
 *
 * A right-side drawer inside the wizard modal. Renders purely from the
 * typed event stream (stage timeline, findings, warnings, provenance FSM)
 * so it works identically opened live or late (ring-buffer replay).
 * Overlay (not flex-split) so step canvases keep their layout underneath.
 */

interface PipelineInspectorProps {
    model: InspectorModel;
    eventCount: number;
    onClose: () => void;
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <section>
        <h3 className="text-[10px] uppercase tracking-[0.2em] text-text-muted font-semibold border-b border-line-subtle pb-1.5 mb-2">
            {title}
        </h3>
        {children}
    </section>
);

// ── Stage timeline ────────────────────────────────────────────────────────

const DOT: Record<StageRow['state'], string> = {
    pending: 'bg-pending/50',
    running: 'bg-accent-400 animate-pulse',
    ok: 'bg-solve',
    failed: 'bg-danger',
    skipped: 'bg-text-muted/60',
};

const LABEL: Record<StageRow['state'], string> = {
    pending: 'text-text-muted',
    running: 'text-text-primary',
    ok: 'text-text-secondary',
    failed: 'text-danger',
    skipped: 'text-text-muted',
};

const fmtMs = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);

/**
 * Honest, structural reason a conditionally-run stage was skipped. These are
 * TRUE gate conditions from the pipeline (e.g. SPCC is FITS-gated at
 * stages/science.ts) — not fabricated copy. Unknown skips render "not
 * applicable to this input" rather than an invented reason.
 */
const SKIP_REASON: Record<string, string> = {
    spcc: 'requires a FITS photometric input',
    spcc_render_gains: 'catalog white-balance gains not applied (gate not met / off)',
    render_apply_sip: 'no fitted SIP undistort applied to the preview',
    bc_rematch: 'no edge-star densification improved the solve',
    forced_confirm: 'no science buffer / catalog targets to confirm against',
    psf_field: 'PSF field not characterized for this frame',
    psf_attribution: 'no confirmable PSF decomposition',
};

const StageTimeline: React.FC<{ stages: StageRow[] }> = ({ stages }) => (
    <div>
        {stages.map((s) => (
            <div key={s.id} data-testid={`inspector-stage-${s.id}`} data-state={s.state}>
                <div className="flex items-center gap-3 py-1">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[s.state]}`} />
                    <span className={`flex-1 text-xs ${LABEL[s.state]}`}>{s.label}</span>
                    <span className="font-mono text-[10px] text-text-muted tabular-nums">
                        {s.state === 'running' ? '···'
                            : s.state === 'skipped' ? <span className="uppercase tracking-wide">skipped</span>
                            : fmtMs(s.ms)}
                    </span>
                </div>
                {s.state === 'failed' && s.error && (
                    <div className="pl-5 pb-1 text-[10px] font-mono text-danger leading-snug break-words">{s.error}</div>
                )}
                {s.state === 'skipped' && (
                    <div className="pl-5 pb-1 text-[10px] font-mono text-text-muted leading-snug break-words">
                        {SKIP_REASON[s.id] ?? 'not applicable to this input'}
                    </div>
                )}
            </div>
        ))}
    </div>
);

// ── Warnings ──────────────────────────────────────────────────────────────

const WarningsSection: React.FC<{ warnings: InspectorModel['warnings'] }> = ({ warnings }) => {
    if (warnings.length === 0) {
        // Honest, not celebratory: absence of degradations is a quiet fact.
        return <div className="text-xs text-text-muted">No degradations recorded.</div>;
    }
    return (
        <div className="space-y-1.5">
            {warnings.map((w) => (
                <div key={w.seq} className="border-l-2 border-warn/60 pl-2 py-0.5">
                    <div className="text-[11px] text-warn leading-snug">{w.message}</div>
                    {w.stage && (
                        <div className="text-[9px] font-mono text-text-muted uppercase tracking-wider mt-0.5">{w.stage}</div>
                    )}
                </div>
            ))}
        </div>
    );
};

// ── Provenance (the manifest FSM made visible) ────────────────────────────

const ProvenancePanel: React.FC<{ groups: InspectorModel['provenance'] }> = ({ groups }) => {
    if (groups.length === 0) {
        return <div className="text-xs text-text-muted">No facts earned yet.</div>;
    }
    return (
        <div className="space-y-2.5">
            {groups.map((g) => (
                <div key={g.stage}>
                    <div className="text-[9px] font-mono uppercase tracking-widest text-text-faint mb-0.5">{g.stage}</div>
                    {g.rows.map((r) => (
                        <div
                            key={r.seq}
                            data-testid="inspector-provenance-row"
                            className="flex items-baseline gap-1.5 flex-wrap font-mono text-[10px] py-0.5"
                        >
                            <span className="text-text-secondary">{r.key}:</span>
                            <span className="text-text-muted">{r.from ?? '∅'}</span>
                            <span className="text-accent-400">→</span>
                            <span className="text-data">{r.to}</span>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
};

// ── Drawer shell ──────────────────────────────────────────────────────────

export const PipelineInspector: React.FC<PipelineInspectorProps> = ({ model, eventCount, onClose }) => (
    <aside
        data-testid="inspector-panel"
        aria-label="Pipeline inspector"
        className="absolute inset-y-0 right-0 z-30 w-[400px] max-w-[85%] flex flex-col
                   bg-space-900/95 backdrop-blur-md border-l border-line
                   shadow-[-24px_0_48px_rgba(0,0,0,0.45)]"
    >
        <header className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-line-subtle bg-space-850/80">
            <div className="flex items-center gap-2 min-w-0">
                <span className="text-[11px] font-semibold tracking-[0.2em] text-text-primary uppercase whitespace-nowrap">
                    Pipeline Inspector
                </span>
                {model.run.sourceFormat && (
                    <span className="px-1.5 py-px rounded bg-space-750 text-[9px] font-mono text-text-secondary">
                        {model.run.sourceFormat}
                    </span>
                )}
                {model.run.finishedOk != null && (
                    <span
                        className={`px-1.5 py-px rounded text-[9px] font-semibold ${
                            model.run.finishedOk ? 'bg-solve-dim text-solve' : 'bg-danger-dim text-danger'
                        }`}
                    >
                        {model.run.finishedOk ? 'RUN OK' : 'RUN FAILED'}
                    </span>
                )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
                <span className="font-mono text-[10px] text-text-muted tabular-nums">{eventCount} EV</span>
                <button
                    data-testid="inspector-close"
                    onClick={onClose}
                    aria-label="Close inspector"
                    className="text-text-muted hover:text-text-primary text-sm leading-none px-1 transition-colors"
                >
                    ✕
                </button>
            </div>
        </header>

        <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 space-y-5">
            <Section title="Stage Timeline">
                <StageTimeline stages={model.stages} />
            </Section>
            <Section title="Findings">
                <FindingsFeed feed={model.feed} />
            </Section>
            <Section title="Warnings">
                <WarningsSection warnings={model.warnings} />
            </Section>
            <Section title="Provenance">
                <ProvenancePanel groups={model.provenance} />
            </Section>
        </div>
    </aside>
);
