/**
 * AnnotationForm.tsx — optional observer-testimony capture (step-7).
 *
 * A collapsed "Add observer notes" section. The five free-text fields normalize
 * through `buildUserAnnotations` and are handed to the host via `onApply`, which
 * wires them onto the session so the NEXT export carries the `user_annotations`
 * block. Nothing here is parsed into the solve — this is testimony, kept separate
 * from the solve-feeding SoftMetadata.
 *
 * DOCTRINE — MCP drafts require explicit user confirm: an `mcpDraft` prop only
 * PREFILLS the fields (provenance stamped 'mcp_assisted'); nothing is attached to
 * the session until the user clicks Attach. The MCP `draft_annotation` tool NEVER
 * writes a session — this Attach button is the sole gate that promotes a draft.
 */
import React, { useState } from 'react';
import {
    buildUserAnnotations,
    type AnnotationField,
    type UserAnnotations,
} from '../pipeline/stages/user_annotations';

interface AnnotationFormProps {
    /** Attach normalized annotations onto the session (null clears them). */
    onApply: (annotations: UserAnnotations | null) => void;
    /** Currently-attached annotations (drives the "attached" indicator). */
    current?: UserAnnotations | null;
    /** MCP-drafted prefill — REQUIRES explicit user confirm (Attach) to take effect. */
    mcpDraft?: Partial<Record<AnnotationField, string>> | null;
}

type Fields = Record<AnnotationField, string>;

const EMPTY: Fields = {
    description: '', location_text: '', sky_bortle_text: '', rig_notes: '', session_issues: '',
};

export const AnnotationForm: React.FC<AnnotationFormProps> = ({ onApply, current, mcpDraft }) => {
    const [open, setOpen] = useState<boolean>(!!mcpDraft);
    const [fields, setFields] = useState<Fields>(() => ({
        ...EMPTY,
        ...(current ?? {}),
        ...(mcpDraft ?? {}),
    }));
    const [attached, setAttached] = useState<boolean>(!!current);
    const isMcp = !!mcpDraft;

    const set = (k: AnnotationField, v: string) => {
        setFields(prev => ({ ...prev, [k]: v }));
        setAttached(false);
    };

    const apply = () => {
        const annotations = buildUserAnnotations(fields, { provenance: isMcp ? 'mcp_assisted' : 'user' });
        onApply(annotations);
        setAttached(true);
    };

    const clear = () => {
        setFields(EMPTY);
        onApply(null);
        setAttached(false);
    };

    return (
        <div className="annotation-form" data-testid="annotation-form">
            <button
                type="button"
                className="annotation-toggle"
                data-testid="annotation-toggle"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
            >
                <span>{open ? '▾' : '▸'} Add observer notes</span>
                {attached && <span className="annotation-attached">attached</span>}
                <span className="annotation-optional">optional</span>
            </button>

            {open && (
                <div className="annotation-body">
                    {isMcp && (
                        <div className="annotation-mcp-banner" data-testid="annotation-mcp-banner">
                            AI-assisted draft — review and edit, then Attach to confirm.
                        </div>
                    )}
                    <p className="annotation-note">
                        Free-text testimony. Recorded verbatim in the receipt — never used in the solve.
                    </p>

                    <label className="annotation-field">
                        <span>Description</span>
                        <textarea
                            data-testid="annotation-description"
                            rows={2}
                            value={fields.description}
                            onChange={e => set('description', e.target.value)}
                            placeholder="Target / intent (e.g. M31, 20×300s Ha)"
                        />
                    </label>
                    <label className="annotation-field">
                        <span>Location</span>
                        <input
                            data-testid="annotation-location"
                            value={fields.location_text}
                            onChange={e => set('location_text', e.target.value)}
                            placeholder="e.g. Anza-Borrego, CA"
                        />
                    </label>
                    <label className="annotation-field">
                        <span>Sky</span>
                        <input
                            data-testid="annotation-sky"
                            value={fields.sky_bortle_text}
                            onChange={e => set('sky_bortle_text', e.target.value)}
                            placeholder="e.g. Bortle 4, some haze"
                        />
                    </label>
                    <label className="annotation-field">
                        <span>Rig</span>
                        <input
                            data-testid="annotation-rig"
                            value={fields.rig_notes}
                            onChange={e => set('rig_notes', e.target.value)}
                            placeholder="e.g. RASA 8 + ASI2600MC"
                        />
                    </label>
                    <label className="annotation-field">
                        <span>Issues</span>
                        <textarea
                            data-testid="annotation-issues"
                            rows={2}
                            value={fields.session_issues}
                            onChange={e => set('session_issues', e.target.value)}
                            placeholder="Anything that went wrong (clouds, wind, focus drift)"
                        />
                    </label>

                    <div className="annotation-actions">
                        <button
                            type="button"
                            className="annotation-apply"
                            data-testid="annotation-apply"
                            onClick={apply}
                        >
                            {isMcp ? 'Confirm & attach' : 'Attach notes'}
                        </button>
                        <button
                            type="button"
                            className="annotation-clear"
                            data-testid="annotation-clear"
                            onClick={clear}
                        >
                            Clear
                        </button>
                    </div>
                </div>
            )}

            <style>{`
                .annotation-form { width: 100%; text-align: left; margin-top: 12px; }
                .annotation-toggle {
                    display: flex; align-items: center; gap: 8px; width: 100%;
                    background: transparent; border: none; cursor: pointer; padding: 6px 0;
                    font-size: 0.78em; color: var(--sc-text-2);
                }
                .annotation-toggle:hover { color: var(--sc-text); }
                .annotation-optional {
                    margin-left: auto; font-size: 0.85em; text-transform: uppercase;
                    letter-spacing: 0.1em; color: var(--sc-muted);
                }
                .annotation-attached {
                    font-size: 0.85em; color: var(--sc-solve); text-transform: uppercase;
                    letter-spacing: 0.08em;
                }
                .annotation-body {
                    display: flex; flex-direction: column; gap: 8px;
                    background: rgba(255,255,255,0.03);
                    border: 1px solid rgba(255,255,255,0.08);
                    border-radius: 6px; padding: 10px; margin-top: 4px;
                }
                .annotation-mcp-banner {
                    font-size: 0.72em; color: var(--sc-warn); background: rgba(255,221,153,0.08);
                    border: 1px solid rgba(255,221,153,0.2); border-radius: 4px; padding: 6px 8px;
                }
                .annotation-note {
                    font-size: 0.68em; color: var(--sc-muted); margin: 0;
                }
                .annotation-field { display: flex; flex-direction: column; gap: 3px; }
                .annotation-field > span {
                    font-size: 0.66em; text-transform: uppercase; letter-spacing: 0.1em;
                    color: var(--sc-muted);
                }
                .annotation-field input, .annotation-field textarea {
                    background: rgba(0,0,0,0.35);
                    border: 1px solid rgba(255,255,255,0.15);
                    color: var(--sc-text);
                    border-radius: 4px; padding: 5px 7px; font-size: 0.8em;
                    font-family: inherit; resize: vertical;
                }
                .annotation-field input:focus, .annotation-field textarea:focus {
                    outline: none; border-color: rgba(85,170,255,0.5);
                }
                .annotation-actions { display: flex; gap: 8px; margin-top: 2px; }
                .annotation-apply {
                    background: var(--sc-btn-fill); color: var(--sc-btn-fill-text); border: none; border-radius: 4px;
                    padding: 6px 12px; font-size: 0.78em; font-weight: 600; cursor: pointer;
                }
                .annotation-apply:hover { filter: brightness(1.15); }
                .annotation-clear {
                    background: transparent; color: var(--sc-text-2);
                    border: 1px solid rgba(255,255,255,0.2); border-radius: 4px;
                    padding: 6px 12px; font-size: 0.78em; cursor: pointer;
                }
                .annotation-clear:hover { background: rgba(255,255,255,0.05); }
            `}</style>
        </div>
    );
};
