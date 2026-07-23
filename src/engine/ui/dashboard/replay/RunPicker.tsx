/**
 * RUN PICKER — choose the run to replay (★ Replay Dashboard).
 *
 * Sources (all `RunHandle`s): the LIVE current run (streamed from the session
 * bus), any PAST run retained in-memory, and a LOADED `test_results/runs/*.jsonl`
 * artifact the user drops in. The file loader is defensive (parse errors are
 * surfaced, never thrown) so an owner can review a packaged run without booting
 * a solve.
 */

import React, { useRef, useState } from 'react';
import type { RunHandle } from './runs_source';
import { parseRunJsonl, runIdOf } from './runs_source';

const KIND_BADGE: Record<RunHandle['kind'], { label: string; cls: string }> = {
    live: { label: 'LIVE', cls: 'text-solve' },
    past: { label: 'PAST', cls: 'text-accent-300' },
    loaded: { label: 'FILE', cls: 'text-warn' },
};

export const RunPicker: React.FC<{
    runs: RunHandle[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    onLoad: (handle: RunHandle) => void;
}> = ({ runs, selectedId, onSelect, onLoad }) => {
    const fileRef = useRef<HTMLInputElement>(null);
    const [note, setNote] = useState<string | null>(null);

    const ingest = async (file: File) => {
        try {
            const text = await file.text();
            const { envelopes, errors } = parseRunJsonl(text);
            if (envelopes.length === 0) {
                setNote(`No valid envelopes in ${file.name}${errors.length ? ` (${errors.length} bad lines)` : ''}`);
                return;
            }
            const id = runIdOf(envelopes, `loaded_${file.name}`);
            onLoad({ id, kind: 'loaded', label: `${file.name} · ${envelopes.length} stages`, envelopes });
            onSelect(id);
            setNote(errors.length ? `Loaded ${envelopes.length} stages · skipped ${errors.length} bad lines` : `Loaded ${envelopes.length} stages`);
        } catch {
            setNote(`Could not read ${file.name}`);
        }
    };

    return (
        <div
            className="flex items-center gap-2 flex-wrap px-3 py-2 border-b border-line bg-space-900/60"
            data-testid="replay-run-picker"
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) void ingest(f);
            }}
        >
            <span className="text-text-muted text-[10px] font-bold uppercase tracking-widest mr-1">Run</span>
            <select
                value={selectedId ?? ''}
                onChange={e => onSelect(e.target.value)}
                data-testid="replay-run-select"
                className="bg-space-800 border border-line rounded-md px-2 py-1 text-[11px] font-mono text-text-primary max-w-[380px]"
            >
                {runs.length === 0 && <option value="">No runs — drop a runs/*.jsonl</option>}
                {runs.map(r => (
                    <option key={r.id} value={r.id}>
                        [{KIND_BADGE[r.kind].label}] {r.label}
                    </option>
                ))}
            </select>

            {selectedId && (() => {
                const sel = runs.find(r => r.id === selectedId);
                return sel ? <span className={`text-[10px] font-mono ${KIND_BADGE[sel.kind].cls}`}>{KIND_BADGE[sel.kind].label}</span> : null;
            })()}

            <div className="flex-1" />

            <button
                type="button"
                onClick={() => fileRef.current?.click()}
                data-testid="replay-load-jsonl"
                className="px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest bg-space-800 text-text-secondary hover:text-text-primary border border-line"
            >
                Load JSONL
            </button>
            <input
                ref={fileRef}
                type="file"
                accept=".jsonl,.json,.txt"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) void ingest(f); e.target.value = ''; }}
            />
            {note && <span className="text-[10px] font-mono text-text-muted w-full sm:w-auto" data-testid="replay-run-note">{note}</span>}
        </div>
    );
};
