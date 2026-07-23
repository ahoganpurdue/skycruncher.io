import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PipelineEventBus } from '../events/pipeline_events';
import { CaptureRecorder, clearCompletedRuns, type CaptureEnvelope } from '../events/capture_record';
import {
    persistRun,
    loadPersistedRunMap,
    loadAllPersistedRuns,
    clearPersistedRuns,
    installCapturePersistSink,
    CAPTURE_PERSIST_KEY,
    PERSIST_RUNS_CAP,
} from '../events/capture_persist';
import { aggregateCaptureRuns } from '../events/capture_aggregate';

/**
 * CAPTURE PERSISTENCE (A4 item 2). The durable localStorage corpus that lets the
 * ★ flowchart aggregate span EVERY run this box has seen — across reloads. Covers
 * persist/load, freshest-wins per run id, the bound, versioned invalidation, and
 * the sink install + in-memory backfill (first solve captured before the
 * dashboard mounts).
 */

function installLocalStorage() {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
    };
}

let seq = 0;
function env(o: Partial<CaptureEnvelope> & { stage_id: string; run_id: string }): CaptureEnvelope {
    seq += 1;
    return {
        run_id: o.run_id,
        frame_sha: o.frame_sha ?? null,
        stage_id: o.stage_id,
        seq: o.seq ?? seq,
        t_start: o.t_start ?? 0,
        t_end: o.t_end ?? 1,
        ms: o.ms ?? 1,
        ok: o.ok ?? true,
        verdict: o.verdict ?? null,
        counts: o.counts ?? {},
        warnings: o.warnings ?? [],
        payload_ref: o.payload_ref ?? null,
    };
}

beforeEach(() => { installLocalStorage(); clearCompletedRuns(); clearPersistedRuns(); });
afterEach(() => { delete (globalThis as any).localStorage; });

describe('persistRun / loadAllPersistedRuns', () => {
    it('persists a run and loads it back as CaptureEnvelope[][]', () => {
        persistRun('r1', [env({ run_id: 'r1', stage_id: 'load' })]);
        const runs = loadAllPersistedRuns();
        expect(runs).toHaveLength(1);
        expect(runs[0][0].stage_id).toBe('load');
    });

    it('is idempotent per run id — the freshest record replaces the older one', () => {
        persistRun('r', [env({ run_id: 'r', stage_id: 'load' })]);
        persistRun('r', [env({ run_id: 'r', stage_id: 'load' }), env({ run_id: 'r', stage_id: 'solve' })]);
        const runs = loadAllPersistedRuns();
        expect(runs).toHaveLength(1);
        expect(runs[0]).toHaveLength(2); // replaced, not appended
    });

    it('no-ops on empty run / missing id', () => {
        persistRun('', [env({ run_id: 'x', stage_id: 'load' })]);
        persistRun('r', []);
        persistRun(null, [env({ run_id: 'x', stage_id: 'load' })]);
        expect(loadAllPersistedRuns()).toHaveLength(0);
    });

    it('bounds the corpus at PERSIST_RUNS_CAP (oldest dropped first)', () => {
        for (let i = 0; i < PERSIST_RUNS_CAP + 5; i++) {
            persistRun(`run_${i}`, [env({ run_id: `run_${i}`, stage_id: 'load' })]);
        }
        const map = loadPersistedRunMap();
        expect(Object.keys(map)).toHaveLength(PERSIST_RUNS_CAP);
        expect(map['run_0']).toBeUndefined();                       // earliest evicted
        expect(map[`run_${PERSIST_RUNS_CAP + 4}`]).toBeDefined();   // newest retained
    });

    it('a stale-version blob invalidates cleanly (empty corpus, no throw)', () => {
        localStorage.setItem(CAPTURE_PERSIST_KEY, JSON.stringify({ v: 0, data: { legacy: [] } }));
        expect(loadPersistedRunMap()).toEqual({});
        expect(loadAllPersistedRuns()).toEqual([]);
    });

    it('feeds the flowchart aggregate substrate directly', () => {
        persistRun('r1', [
            env({ run_id: 'r1', frame_sha: 'sha1', stage_id: 'load', t_end: 1 }),
            env({ run_id: 'r1', frame_sha: 'sha1', stage_id: 'integrate', ok: true, t_end: 2 }),
        ]);
        const agg = aggregateCaptureRuns(loadAllPersistedRuns());
        expect(agg.frame_count).toBe(1);
        expect(agg.successful_frames).toBe(1);
        expect(agg.stages['load'].reached).toBe(1);
    });
});

describe('installCapturePersistSink', () => {
    function driveRun(bus: PipelineEventBus, runId: string, sha: string | null): void {
        bus.setRunContext({ runId, frameSha: sha });
        bus.emit({ kind: 'run_started', mode: 'wizard' });
        bus.emit({ kind: 'stage_started', stage: 'load', label: 'Load' });
        bus.emit({ kind: 'stage_finished', stage: 'load', ok: true, ms: 5, verdict: 'PASS' });
        bus.emit({ kind: 'run_finished', ok: true });
    }

    it('mirrors a completed run to localStorage (survives a reload)', () => {
        const off = installCapturePersistSink();
        const bus = new PipelineEventBus();
        const rec = new CaptureRecorder(bus);
        driveRun(bus, 'run_live', 'shaLive');
        const runs = loadAllPersistedRuns();
        expect(runs).toHaveLength(1);
        expect(runs[0][0].stage_id).toBe('load');
        off();
        rec.dispose();
    });

    it('backfills the in-memory ring on install (first solve captured before mount)', () => {
        // A run completes BEFORE any persist sink exists (in-memory only).
        const bus = new PipelineEventBus();
        const rec = new CaptureRecorder(bus);
        driveRun(bus, 'pre_mount', 'shaPre');
        expect(loadAllPersistedRuns()).toHaveLength(0); // not yet on disk
        const off = installCapturePersistSink();        // install ⇒ backfill
        expect(loadAllPersistedRuns()).toHaveLength(1);
        off();
        rec.dispose();
    });

    it('is idempotent — a second install does not double-register (one persisted run)', () => {
        const off1 = installCapturePersistSink();
        const off2 = installCapturePersistSink(); // no-op while installed
        const bus = new PipelineEventBus();
        const rec = new CaptureRecorder(bus);
        driveRun(bus, 'once', 'shaOnce');
        expect(loadAllPersistedRuns()).toHaveLength(1); // exactly one record, not two
        off2();
        off1();
        rec.dispose();
    });
});
