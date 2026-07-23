import React from 'react';
import type { HorizonEnvelope } from '../pipeline/m4_signal_detect/horizon_envelope';
import type { HorizonCorrectionRecord } from '../pipeline/m4_signal_detect/horizon_editor';

/**
 * HORIZON EDITOR panel — the step-3 overlay affordance for correcting the
 * detection-envelope horizon (drag nodes · shift-click add · shift-click a node
 * to remove). RENDER-plane / control only: it edits RECORDED TESTIMONY and never
 * touches the automatic estimate, the solve, or any measurement.
 *
 * Honest-or-absent (LAW 3): the affordance exists ONLY when the automatic
 * envelope actually shows terrain evidence — the exact gate the amber overlay
 * draws on. No envelope / no terrain evidence ⇒ this renders NOTHING (returns
 * null): the editor never invites the observer to "correct" a horizon that was
 * never asserted, and a never-edited session stays byte-identical.
 *
 * Two live states once present:
 *  - AUTO           — showing the automatic estimate; nothing corrected yet.
 *  - USER CORRECTED — the observer asserted a horizon (deltas recorded); a Reset
 *                     returns to the automatic estimate.
 */
export interface HorizonEditorPanelProps {
    /** The automatic estimate. null / no-terrain-evidence ⇒ panel is absent. */
    envelope: HorizonEnvelope | null;
    /** The active correction record, or null when nothing is corrected. */
    correction: HorizonCorrectionRecord | null;
    /** Whether edit mode is engaged (node handles are live on the canvas). */
    editing: boolean;
    onToggleEdit: () => void;
    onReset: () => void;
}

export const HorizonEditorPanel: React.FC<HorizonEditorPanelProps> = ({
    envelope, correction, editing, onToggleEdit, onReset,
}) => {
    // Honest-or-absent: no affordance without measured terrain evidence.
    if (!envelope || !envelope.hasTerrainEvidence) return null;

    const corrected = !!correction;
    const editCount = correction ? correction.deltas.length : 0;
    const nodeCount = correction ? correction.corrected.length : envelope.points.length;

    return (
        <div
            data-testid="horizon-editor-panel"
            data-corrected={corrected ? 'true' : 'false'}
            className="bg-space-900/80 backdrop-blur-md border border-line p-3 rounded-lg w-60 shadow-2xl"
        >
            <div className="flex items-center justify-between mb-2 border-b border-line-subtle pb-2">
                <div className="text-[10px] font-bold text-text-muted uppercase tracking-widest">
                    Horizon
                </div>
                <span
                    data-testid="horizon-editor-state"
                    className={`text-[9px] font-mono uppercase tracking-widest ${corrected ? 'text-warn' : 'text-text-muted'}`}
                >
                    {corrected ? 'USER CORRECTED' : 'AUTO'}
                </span>
            </div>

            <div className="flex items-center justify-between text-[10px] font-mono text-text-secondary mb-2">
                <span>{nodeCount} nodes</span>
                {corrected && (
                    <span data-testid="horizon-editor-edits" className="text-warn">
                        {editCount} {editCount === 1 ? 'edit' : 'edits'}
                    </span>
                )}
            </div>

            <div className="flex gap-2">
                <button
                    data-testid="horizon-editor-toggle"
                    type="button"
                    aria-pressed={editing}
                    onClick={onToggleEdit}
                    title="Edit the horizon: drag nodes; shift-click the line to add a node; shift-click a node to remove it. Recorded as testimony — never changes the automatic estimate or the solve."
                    className={`flex-1 px-2 py-1 text-[10px] font-bold rounded border uppercase tracking-wide transition-colors ${
                        editing
                            ? 'border-accent-500/60 bg-accent-glow text-accent-300'
                            : 'border-line bg-space-800/60 text-text-secondary hover:border-line-strong'
                    }`}
                >
                    {editing ? 'Editing' : 'Edit'}
                </button>
                {corrected && (
                    <button
                        data-testid="horizon-editor-reset"
                        type="button"
                        onClick={onReset}
                        title="Discard the correction and return to the automatic detection-envelope estimate."
                        className="px-2 py-1 text-[10px] font-bold rounded border border-line bg-space-800/60 text-text-muted hover:text-text-secondary hover:border-line-strong uppercase tracking-wide transition-colors"
                    >
                        Reset
                    </button>
                )}
            </div>

            {editing && (
                <div className="mt-2 text-[9px] font-mono text-text-muted leading-tight">
                    drag node · shift-click line = add · shift-click node = remove
                </div>
            )}
        </div>
    );
};
