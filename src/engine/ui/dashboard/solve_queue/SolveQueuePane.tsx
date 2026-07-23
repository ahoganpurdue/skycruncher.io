/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLVE QUEUE PANE — the BULK INGESTOR dashboard surface ("headless baked in")
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Accepts DROPPED files AND pick-from-source (re-mappable connectors), runs the
 * REAL wizard pipeline per file SEQUENTIALLY (queue_runner → a fresh
 * OrchestratorSession each), and — because the session stamps setRunContext +
 * attaches a CaptureRecorder — every run lands in the in-memory capture store,
 * immediately replayable in the ReplayDashboard (mounted here on demand) and
 * feeding flowchart stats.
 *
 * HONEST-OR-ABSENT (LAW 3): no progress bars, no placeholder numbers. Each row
 * shows its real lifecycle status, the live stage label off the bus while
 * running, and either the MEASURED result line (RA/scale/matched/conf) or an
 * honest failure/unsupported verdict. The pipeline's own status-string polled
 * contract is untouched — this pane only reads.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { supportedFormatsLabel } from '../../../pipeline/m1_ingestion/format_registry';
import { getIntakeConfig, type IntakeConfig } from '../../config/intake_config';
import {
    createQueueItem,
    queueSummary,
    buildSolveSidecar,
    type QueueItem,
    type QueueItemStatus,
    type QueueSolveResult,
} from './queue_state';
import {
    buildConnectors,
    filesToSourceFiles,
    ConnectorStubError,
    isTauriRuntime,
    type SourceFile,
    type SourceConnector,
} from './connectors';
import { processQueue, type RunnerDeps, type RunnerSession } from './queue_runner';

// The replay dashboard is heavy (full widget registry graph) — load it only
// when the user opens it, after runs have been captured.
const ReplayDashboard = React.lazy(() =>
    import('../replay/ReplayDashboard').then((m) => ({ default: m.ReplayDashboard })),
);

// ─── flag (DEFAULT ON, opt-out — mirrors the WidgetDock / ReplayDashboard flags) ───
export const SOLVE_QUEUE_STORAGE_KEY = 'skycruncher.solvequeue.pane';
export function getSolveQueueEnabled(): boolean {
    try { return localStorage.getItem(SOLVE_QUEUE_STORAGE_KEY) !== '0'; } catch { return true; }
}
export function setSolveQueueEnabled(on: boolean): void {
    try { localStorage.setItem(SOLVE_QUEUE_STORAGE_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}

/**
 * The default runner deps: the REAL in-browser pipeline. `createSession`
 * dynamic-imports OrchestratorSession (keeps the heavy stage graph out of the
 * pane's static bundle; only loaded on first run) with generatePreviews:false
 * (bulk = light; detection input is unaffected, so solves stay byte-identical).
 * `computeSha` is the shared capture-record digest.
 */
function makeDefaultDeps(): RunnerDeps {
    return {
        createSession: async (buffer) => {
            const { OrchestratorSession } = await import('../../../pipeline/orchestrator_session');
            return (new OrchestratorSession(buffer, { generatePreviews: false }) as unknown) as RunnerSession;
        },
        computeSha: async (buffer) => {
            const { sha256Hex } = await import('../../../events/capture_record');
            return sha256Hex(buffer);
        },
    };
}

const STATUS_COLOR: Record<QueueItemStatus, string> = {
    queued: 'var(--sc-pending)',
    running: 'var(--sc-accent)',
    solved: 'var(--sc-solve)',
    failed: 'var(--sc-danger)',
    unsupported: 'var(--sc-warn)',
};

export interface SolveQueuePaneProps {
    /** Runner deps injection (tests/stories). Defaults to the REAL pipeline. */
    deps?: RunnerDeps;
    /** Flag override (defaults to the localStorage flag). */
    enabled?: boolean;
}

export function SolveQueuePane({ deps, enabled }: SolveQueuePaneProps): React.ReactElement | null {
    const on = enabled ?? getSolveQueueEnabled();

    const [items, setItems] = useState<QueueItem[]>([]);
    const [running, setRunning] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [showReplay, setShowReplay] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    // Per-row Receipt focus: the runId whose captured run the replay dashboard
    // should open on (null ⇒ whole-session default). Set by a row's Receipt btn.
    const [receiptRunId, setReceiptRunId] = useState<string | null>(null);

    const itemsRef = useRef<QueueItem[]>([]);
    const sourcesRef = useRef<Map<string, SourceFile>>(new Map());
    const stopRef = useRef(false);
    const idRef = useRef(0);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const connectors = useMemo<SourceConnector[]>(() => buildConnectors(), []);
    const runnerDeps = useMemo<RunnerDeps>(() => deps ?? makeDefaultDeps(), [deps]);

    const commit = useCallback((next: QueueItem[]) => {
        itemsRef.current = next;
        setItems(next);
    }, []);

    const enqueue = useCallback((files: SourceFile[], sourceId: string) => {
        if (files.length === 0) return;
        const created: QueueItem[] = [];
        for (const f of files) {
            const id = `q${++idRef.current}`;
            sourcesRef.current.set(id, f);
            created.push(createQueueItem(id, f.name, f.sizeBytes, sourceId));
        }
        commit([...itemsRef.current, ...created]);
    }, [commit]);

    const onDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        if (running) return;
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) enqueue(filesToSourceFiles(Array.from(files)), 'drop');
    }, [enqueue, running]);

    const onPick = useCallback(async (c: SourceConnector) => {
        if (running) return;
        setNotice(null);
        try {
            const files = await c.pick();
            if (files.length === 0) { setNotice(`No supported files found in ${c.displayName}.`); return; }
            enqueue(files, c.id);
        } catch (err) {
            if (err instanceof ConnectorStubError) setNotice(err.message);
            else if ((err as Error)?.name === 'AbortError') { /* user cancelled the picker — silent */ }
            else setNotice(`${c.displayName}: ${(err as Error)?.message ?? 'could not open source'}`);
        }
    }, [enqueue, running]);

    // ── live-stack chain: emit the acceptance sidecar next to a solved frame ──
    // DESKTOP ONLY. On a genuine solve, write `<framePath>.solve.json` next to the
    // source frame so the live-stack follower (tools/stack/live_stack.mjs,
    // run with `--solve-dir <that folder>`) accepts the frame and re-stacks. The
    // browser lane no-ops (no Tauri fs, no on-disk path) → byte-identical. A write
    // failure is logged honestly and NEVER blocks/fails the solve (LAW 3).
    const writeSolveSidecar = useCallback(async (item: QueueItem, result: QueueSolveResult) => {
        if (!isTauriRuntime()) return;                         // browser build: no-op
        const framePath = sourcesRef.current.get(item.id)?.path;
        if (!framePath) return;                                // dropped/demo source — no frame on disk to sit beside
        try {
            // `writeFile` (bytes) maps to the `write_file` command granted by the
            // hardened default capability; `writeTextFile` would need an ungranted
            // `write_text_file` permission — stay on the granted command.
            const { writeFile } = await import('@tauri-apps/plugin-fs');
            const sidecar = buildSolveSidecar(item.name, result);
            const bytes = new TextEncoder().encode(JSON.stringify(sidecar, null, 2));
            await writeFile(`${framePath}.solve.json`, bytes);
        } catch (err) {
            console.warn(`[solve-queue] live-stack sidecar not written for ${item.name} (non-fatal):`, err);
        }
    }, []);

    const runQueue = useCallback(async () => {
        if (running) return;
        stopRef.current = false;
        setRunning(true);
        setNotice(null);
        try {
            await processQueue(
                itemsRef.current,
                async (item) => {
                    const src = sourcesRef.current.get(item.id);
                    if (!src) throw new Error('source handle lost (re-add the file)');
                    return src.read();
                },
                runnerDeps,
                commit,
                () => stopRef.current,
                writeSolveSidecar,
            );
        } finally {
            setRunning(false);
            setShowReplay(true); // captured runs are now replayable
        }
    }, [running, runnerDeps, commit, writeSolveSidecar]);

    const clearDone = useCallback(() => {
        commit(itemsRef.current.filter((it) => it.status === 'queued' || it.status === 'running'));
    }, [commit]);

    // Per-row Receipt: focus the replay dashboard on this row's captured run.
    // Honest — only terminal rows that actually ran carry a runId.
    const openReceipt = useCallback((runId: string) => {
        setReceiptRunId(runId);
        setShowReplay(true);
    }, []);

    if (!on) return null;

    const summary = queueSummary(items);
    const hasRunnable = summary.queued > 0;
    const capturedRuns = summary.solved + summary.failed;
    // Lift unsupported rows OUT of the run list into the honest handoff section;
    // the main list shows only ingestable frames. Tally still counts unsupported.
    const runnableItems = items.filter((it) => it.status !== 'unsupported');
    const unsupportedItems = items.filter((it) => it.status === 'unsupported');
    // BulkProgressLine: a DETERMINATE, measured count of finished work — never a
    // fabricated percent/ETA. Denominator excludes unsupported (never runnable),
    // so "N / N processed" is reachable even with skipped JPEGs in view.
    const runnableTotal = summary.total - summary.unsupported;
    const processedCount = summary.solved + summary.failed;

    return (
        <div className="sq-pane">
            <div className="sq-head">
                <button className="sq-collapse" onClick={() => setCollapsed((c) => !c)} title={collapsed ? 'Expand' : 'Collapse'}>
                    {collapsed ? '▸' : '▾'}
                </button>
                <div className="sq-title">Solve Queue <span className="sq-sub">bulk ingestor · runs the real pipeline, one file at a time</span></div>
                <div className="sq-tally">
                    {summary.total > 0 && (
                        <>
                            <span title="solved" style={{ color: STATUS_COLOR.solved }}>{summary.solved}✓</span>
                            <span title="failed" style={{ color: STATUS_COLOR.failed }}>{summary.failed}✗</span>
                            <span title="queued" style={{ color: STATUS_COLOR.queued }}>{summary.queued}⋯</span>
                            {summary.unsupported > 0 && <span title="unsupported" style={{ color: STATUS_COLOR.unsupported }}>{summary.unsupported}⊘</span>}
                        </>
                    )}
                </div>
            </div>

            {!collapsed && (
                <div className="sq-body">
                    {/* DROP ZONE */}
                    <div
                        className={`sq-drop ${isDragging ? 'dragging' : ''} ${running ? 'disabled' : ''}`}
                        onDragOver={(e) => { e.preventDefault(); if (!running) setIsDragging(true); }}
                        onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
                        onDrop={onDrop}
                        onClick={() => !running && fileInputRef.current?.click()}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            style={{ display: 'none' }}
                            onChange={(e) => {
                                if (e.target.files && e.target.files.length > 0) enqueue(filesToSourceFiles(Array.from(e.target.files)), 'drop');
                                e.target.value = '';
                            }}
                        />
                        <strong>Drop frames here</strong>
                        <span className="sq-hint">or click to browse</span>
                    </div>

                    {/* CONNECTOR CARDS (re-mappable sources) */}
                    <div className="sq-connectors">
                        {connectors.map((c) => (
                            <button
                                key={c.id}
                                className={`sq-conn sq-conn-${c.status}`}
                                disabled={running || c.status === 'unavailable'}
                                onClick={() => onPick(c)}
                                title={c.description}
                            >
                                <div className="sq-conn-name">
                                    {c.displayName}
                                    {c.status === 'stub' && <span className="sq-pill sq-pill-stub">STUB</span>}
                                    {c.status === 'unavailable' && <span className="sq-pill sq-pill-na">N/A</span>}
                                </div>
                                <div className="sq-conn-note">{c.note}</div>
                            </button>
                        ))}
                    </div>

                    {notice && <div className="sq-notice">{notice}</div>}

                    {/* CONTROLS */}
                    <div className="sq-controls">
                        <button className="sq-run" disabled={!hasRunnable || running} onClick={runQueue}>
                            {running ? 'Solving…' : `Run queue${hasRunnable ? ` (${summary.queued})` : ''}`}
                        </button>
                        {running && <button className="sq-stop" onClick={() => { stopRef.current = true; }}>Stop after current</button>}
                        {!running && summary.total > 0 && <button className="sq-clear" onClick={clearDone}>Clear finished</button>}
                        {capturedRuns > 0 && !running && (
                            <button className="sq-replay" onClick={() => { setReceiptRunId(null); setShowReplay((s) => !s); }}>
                                {showReplay ? 'Hide replay' : `Open replay dashboard (${capturedRuns} captured)`}
                            </button>
                        )}
                    </div>

                    {/* BULK PROGRESS — determinate, measured "X / Y processed" (Y excludes
                        unsupported). No bar, no percent, no ETA (LAW 3). */}
                    {runnableTotal > 0 && (
                        <div className="sq-progress" data-testid="sq-bulk-progress">
                            <strong>{processedCount}</strong> / {runnableTotal} processed
                        </div>
                    )}

                    {/* QUEUE LIST (ingestable frames only — unsupported lifted out below) */}
                    {runnableItems.length > 0 && (
                        <ul className="sq-list">
                            {runnableItems.map((it) => (
                                <li key={it.id} className="sq-row">
                                    <span className="sq-badge" style={{ background: STATUS_COLOR[it.status] }}>{it.status}</span>
                                    <span className="sq-name" title={it.name}>{it.name}</span>
                                    <span className="sq-result">{resultLine(it)}</span>
                                    {/* Per-row Receipt — only terminal rows that actually ran
                                        carry a runId (honest: queued/running expose none). */}
                                    {(it.status === 'solved' || it.status === 'failed') && it.runId && (
                                        <button
                                            className="sq-receipt"
                                            data-testid={`sq-receipt-${it.id}`}
                                            onClick={() => openReceipt(it.runId!)}
                                            title="Open this run in the replay dashboard"
                                        >
                                            Receipt
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}

                    {/* NOT INGESTED TODAY — honest actionable handoff for unsupported formats */}
                    <UnsupportedHandoffCard items={unsupportedItems} />

                    {/* REPLAY (captured runs — immediately replayable; focused per-row) */}
                    {showReplay && capturedRuns > 0 && (
                        <React.Suspense fallback={<div className="sq-notice">Loading replay dashboard…</div>}>
                            <ReplayDashboard focusRunId={receiptRunId} />
                        </React.Suspense>
                    )}
                </div>
            )}

            <style>{`
                .sq-pane { width: 100%; max-width: 820px; margin: 0 auto; background: rgba(0,0,0,0.28);
                    border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; color: var(--sc-text); font-size: 0.9rem; }
                .sq-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06); }
                .sq-collapse { background: none; border: none; color: var(--sc-accent); cursor: pointer; font-size: 1rem; padding: 0 4px; }
                .sq-title { font-weight: 700; letter-spacing: 0.4px; flex: 1; }
                .sq-sub { font-weight: 400; opacity: 0.5; font-size: 0.75rem; margin-left: 8px; }
                .sq-tally { display: flex; gap: 10px; font-family: monospace; font-size: 0.85rem; }
                .sq-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
                .sq-drop { border: 2px dashed rgba(255,255,255,0.2); border-radius: 10px; padding: 16px; text-align: center;
                    cursor: pointer; transition: all 0.15s; display: flex; flex-direction: column; gap: 4px; }
                .sq-drop:hover, .sq-drop.dragging { border-color: var(--sc-accent); background: rgba(79,172,254,0.08); color: var(--sc-text); }
                .sq-drop.disabled { opacity: 0.5; cursor: not-allowed; }
                .sq-hint { font-size: 0.75rem; opacity: 0.55; }
                .sq-connectors { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
                .sq-conn { text-align: left; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
                    border-radius: 8px; padding: 10px; cursor: pointer; color: var(--sc-text); transition: all 0.15s; }
                .sq-conn:hover:not(:disabled) { border-color: rgba(79,172,254,0.5); background: rgba(79,172,254,0.08); }
                .sq-conn:disabled { opacity: 0.55; cursor: not-allowed; }
                .sq-conn-stub { border-style: dashed; }
                .sq-conn-name { font-weight: 600; font-size: 0.82rem; display: flex; align-items: center; gap: 6px; }
                .sq-conn-note { font-size: 0.68rem; opacity: 0.55; margin-top: 3px; line-height: 1.3; }
                .sq-pill { font-size: 0.55rem; font-weight: 700; padding: 1px 5px; border-radius: 3px; letter-spacing: 0.5px; }
                .sq-pill-stub { background: var(--sc-warn); color: var(--sc-page); }
                .sq-pill-na { background: rgba(255,255,255,0.15); color: var(--sc-text-2); }
                .sq-notice { font-size: 0.78rem; color: var(--sc-warn); background: rgba(224,160,74,0.1);
                    border: 1px solid rgba(224,160,74,0.25); border-radius: 6px; padding: 8px 10px; }
                .sq-controls { display: flex; gap: 10px; flex-wrap: wrap; }
                .sq-controls button { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-weight: 600; font-size: 0.82rem; }
                .sq-run { background: var(--sc-btn-fill); color: var(--sc-btn-fill-text); }
                .sq-run:disabled { opacity: 0.4; cursor: not-allowed; }
                .sq-stop { background: rgba(255,107,107,0.2); color: var(--sc-danger); border: 1px solid rgba(255,107,107,0.4) !important; }
                .sq-clear, .sq-replay { background: rgba(255,255,255,0.08); color: var(--sc-text-2); }
                .sq-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow-y: auto; }
                .sq-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; background: rgba(255,255,255,0.03); border-radius: 6px; }
                .sq-badge { font-size: 0.6rem; font-weight: 700; text-transform: uppercase; color: var(--sc-page); padding: 2px 7px; border-radius: 4px; min-width: 64px; text-align: center; }
                .sq-name { flex: 0 0 auto; max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 0.78rem; }
                .sq-result { flex: 1; text-align: right; font-family: monospace; font-size: 0.74rem; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .sq-receipt { flex: 0 0 auto; background: rgba(255,255,255,0.08); color: var(--sc-text-2); border: 1px solid rgba(255,255,255,0.12);
                    border-radius: 4px; padding: 3px 9px; font-size: 0.68rem; font-weight: 600; cursor: pointer; }
                .sq-receipt:hover { border-color: rgba(79,172,254,0.5); background: rgba(79,172,254,0.1); color: var(--sc-text); }
                .sq-progress { font-family: monospace; font-size: 0.78rem; opacity: 0.8; }
                .sq-progress strong { color: var(--sc-solve); }
                .sq-handoff { border: 1px solid rgba(224,160,74,0.28); background: rgba(224,160,74,0.06); border-radius: 8px; padding: 12px 14px; }
                .sq-handoff-head { font-weight: 700; font-size: 0.82rem; color: var(--sc-warn); margin-bottom: 8px; }
                .sq-handoff-files { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
                .sq-handoff-file { font-family: monospace; font-size: 0.7rem; background: rgba(255,255,255,0.05); border-radius: 4px;
                    padding: 2px 7px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .sq-handoff-body p { margin: 0 0 6px; font-size: 0.78rem; line-height: 1.45; opacity: 0.9; }
                .sq-handoff-body p:last-child { margin-bottom: 0; }
                .sq-handoff-link { color: var(--sc-accent); text-decoration: underline; }
            `}</style>
        </div>
    );
}

/**
 * UNSUPPORTED-FORMAT HANDOFF — turns a dead JPEG/TIFF row into an actionable
 * funnel, not an error (P4 Proposal 1). Presentation-only: reads the existing
 * `unsupported` items + `supportedFormatsLabel()` + the intake CONFIG. The item
 * status stays exactly `unsupported` (no reclassification, no false hope, LAW 3).
 *
 * Two honest next steps:
 *   • Primary (works now): drop the RAW instead — supported formats come from
 *     `supportedFormatsLabel()`, never a hard-coded list (LAW 6, drift-proof).
 *   • Secondary (honest future): leave it in the community drop location so we
 *     process it when JPEG/TIFF support lands. The link is CONFIG and honest-or-
 *     absent — with no configured URL the card renders the instruction with NO
 *     dead link (LAW 3 applies to links too).
 */
export function UnsupportedHandoffCard(
    { items, config }: { items: readonly QueueItem[]; config?: IntakeConfig },
): React.ReactElement | null {
    if (items.length === 0) return null; // absent, not a decorative zero
    const cfg = config ?? getIntakeConfig();
    return (
        <div className="sq-handoff" data-testid="sq-unsupported-handoff">
            <div className="sq-handoff-head">Not ingested today ({items.length})</div>
            <ul className="sq-handoff-files">
                {items.map((it) => (
                    <li key={it.id} className="sq-handoff-file" title={it.name}>{it.name}</li>
                ))}
            </ul>
            <div className="sq-handoff-body">
                <p>
                    We ingest <strong>{supportedFormatsLabel()}</strong> today. Shot RAW+JPEG?
                    Drop the <strong>RAW</strong> instead — that is what the instrument reads.
                </p>
                <p>
                    JPEG/TIFF support is on the roadmap.{' '}
                    {cfg.uploadUrl ? (
                        <>
                            Leave it in the{' '}
                            <a className="sq-handoff-link" href={cfg.uploadUrl} target="_blank" rel="noopener noreferrer">
                                {cfg.uploadLabel}
                            </a>{' '}
                            with your name and we will process it when that support lands.
                        </>
                    ) : (
                        <>
                            Leave it in the <strong>{cfg.uploadLabel}</strong> with your name and we
                            will process it when that support lands.
                        </>
                    )}
                </p>
            </div>
        </div>
    );
}

/** The honest per-row result/status text (MEASURED numbers or a real verdict). */
function resultLine(it: QueueItem): string {
    if (it.status === 'solved' && it.result) {
        const r = it.result;
        return `RA ${r.raHours.toFixed(4)}h · ${r.scaleArcsecPerPx.toFixed(3)}"/px · ${r.matched} matched · conf ${r.confidence.toFixed(3)}`;
    }
    if (it.status === 'running') return it.stageNote ?? 'running…';
    if (it.status === 'failed' || it.status === 'unsupported') return it.error ?? it.status;
    return 'queued';
}
