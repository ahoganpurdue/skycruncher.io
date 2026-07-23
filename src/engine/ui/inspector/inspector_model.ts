/**
 * -----------------------------------------------------------------
 * INSPECTOR MODEL — pure fold of the pipeline event stream
 * -----------------------------------------------------------------
 * Turns the raw `PipelineEvent[]` history into the view model the
 * Pipeline Inspector renders: stage timeline, findings feed (with the
 * solver-candidate forensics aggregated into one table), warnings, and
 * the provenance FSM grouped by stage. Pure + headless — no React.
 */

import { PipelineEvent, FindingPayload, RunMode } from '../../events/pipeline_events';
import { STEP_META } from '../wizard_steps';

export type StageState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface StageRow {
    id: string;
    label: string;
    state: StageState;
    /** Wall-clock duration, present once the stage finished. */
    ms?: number;
    /** Error message when state === 'failed'. */
    error?: string;
}

export interface SolveCandidateRow {
    seq: number;
    idx: number;
    quadError?: number;
    inferredScale?: number;
    status: string;
}

/** A finding that is NOT a solve_candidate (those aggregate into one table). */
export type ScalarFinding = Exclude<FindingPayload, { kind: 'solve_candidate' }>;

export type FeedItem =
    | { type: 'finding'; seq: number; t: number; finding: ScalarFinding }
    | { type: 'candidates'; seq: number; t: number; items: SolveCandidateRow[] };

export interface ProvenanceRow {
    seq: number;
    key: string;
    from?: string;
    to: string;
}

export interface ProvenanceGroup {
    stage: string;
    rows: ProvenanceRow[];
}

export interface WarningRow {
    seq: number;
    message: string;
    stage?: string;
}

export interface InspectorModel {
    stages: StageRow[];
    feed: FeedItem[];
    warnings: WarningRow[];
    provenance: ProvenanceGroup[];
    run: { mode?: RunMode; sourceFormat?: string; finishedOk?: boolean };
    /** True while any stage has started but not finished — gates Back/nav. */
    stageRunning: boolean;
}

/**
 * The canonical stage sequence (same ids/labels the OrchestratorSession
 * emits — labels sourced from the shared wizard step copy). Declared here
 * so un-started stages render as honest "pending" rows; any stage id the
 * bus emits that is NOT in this list is appended dynamically.
 */
const KNOWN_STAGES: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'load', label: STEP_META[0].title },
    { id: 'extract', label: STEP_META[2].title },
    { id: 'metrology', label: STEP_META[3].title },
    { id: 'solve', label: STEP_META[4].title },
    { id: 'calibrate', label: STEP_META[5].title },
    { id: 'integrate', label: STEP_META[6].title },
];

export function foldPipelineEvents(events: readonly PipelineEvent[]): InspectorModel {
    const stageIndex = new Map<string, StageRow>();
    const stageOrder: string[] = [];
    for (const s of KNOWN_STAGES) {
        stageIndex.set(s.id, { id: s.id, label: s.label, state: 'pending' });
        stageOrder.push(s.id);
    }

    const feed: FeedItem[] = [];
    let candidates: Extract<FeedItem, { type: 'candidates' }> | null = null;
    const warnings: WarningRow[] = [];
    const provenanceIndex = new Map<string, ProvenanceGroup>();
    const provenanceOrder: string[] = [];
    const run: InspectorModel['run'] = {};
    const openStages = new Set<string>();

    const stageRowFor = (id: string, label?: string): StageRow => {
        let row = stageIndex.get(id);
        if (!row) {
            row = { id, label: label ?? id, state: 'pending' };
            stageIndex.set(id, row);
            stageOrder.push(id);
        }
        return row;
    };

    for (const e of events) {
        switch (e.kind) {
            case 'run_started':
                run.mode = e.mode;
                run.sourceFormat = e.sourceFormat;
                run.finishedOk = undefined;
                break;
            case 'run_finished':
                run.finishedOk = e.ok;
                break;
            case 'stage_started': {
                const row = stageRowFor(e.stage, e.label);
                row.label = e.label || row.label;
                row.state = 'running';
                row.ms = undefined;
                row.error = undefined;
                openStages.add(e.stage);
                break;
            }
            case 'stage_finished': {
                const row = stageRowFor(e.stage);
                // A stage can finish ok:true yet be a genuine SKIP (e.g. SPCC on a
                // non-FITS input). Render that honestly as 'skipped' instead of a
                // green 0ms "ran successfully" that it never did (LAW 3).
                row.state = e.ok ? (e.verdict === 'SKIP' ? 'skipped' : 'ok') : 'failed';
                row.ms = e.ms;
                row.error = e.error;
                openStages.delete(e.stage);
                break;
            }
            case 'stage_progress':
                // Intra-stage progress renders via the steps' live status —
                // the timeline keys off start/finish only.
                break;
            case 'finding': {
                if (e.finding.kind === 'solve_candidate') {
                    const item: SolveCandidateRow = {
                        seq: e.seq,
                        idx: e.finding.idx,
                        quadError: e.finding.quadError,
                        inferredScale: e.finding.inferredScale,
                        status: e.finding.status,
                    };
                    if (!candidates) {
                        candidates = { type: 'candidates', seq: e.seq, t: e.t, items: [item] };
                        feed.push(candidates);
                    } else {
                        candidates.items.push(item);
                    }
                } else if (e.finding.kind === 'blind_search_progress') {
                    // High-frequency narration: keep only the latest tick so
                    // the feed shows live progress instead of a scroll of it.
                    const last = feed[feed.length - 1];
                    const entry = { type: 'finding', seq: e.seq, t: e.t, finding: e.finding } as const;
                    if (last && last.type === 'finding' && last.finding.kind === 'blind_search_progress') {
                        feed[feed.length - 1] = entry;
                    } else {
                        feed.push(entry);
                    }
                } else if (e.finding.kind === 'psf_measured') {
                    // Two stages legitimately re-emit the SAME measured PSF:
                    // psf_field (the measurement) and psf_attribution (the physics
                    // decomposition that consumes it). Identical nStars+fwhm ⇒ one
                    // honest row, not the same number printed twice. A genuinely
                    // different measurement (different nStars or fwhm) still shows.
                    const f = e.finding;
                    const dup = feed.some(it =>
                        it.type === 'finding' &&
                        it.finding.kind === 'psf_measured' &&
                        it.finding.nStars === f.nStars &&
                        it.finding.fwhmMedianPx === f.fwhmMedianPx);
                    if (!dup) feed.push({ type: 'finding', seq: e.seq, t: e.t, finding: f });
                } else {
                    feed.push({ type: 'finding', seq: e.seq, t: e.t, finding: e.finding });
                }
                break;
            }
            case 'warning':
                warnings.push({ seq: e.seq, message: e.message, stage: e.stage });
                break;
            case 'provenance_changed': {
                let group = provenanceIndex.get(e.stage);
                if (!group) {
                    group = { stage: e.stage, rows: [] };
                    provenanceIndex.set(e.stage, group);
                    provenanceOrder.push(e.stage);
                }
                group.rows.push({ seq: e.seq, key: e.key, from: e.from, to: e.to });
                break;
            }
        }
    }

    return {
        stages: stageOrder.map((id) => stageIndex.get(id)!),
        feed,
        warnings,
        provenance: provenanceOrder.map((s) => provenanceIndex.get(s)!),
        run,
        stageRunning: openStages.size > 0,
    };
}
