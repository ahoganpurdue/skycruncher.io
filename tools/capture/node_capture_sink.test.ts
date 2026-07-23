import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PipelineEventBus } from '@/engine/events/pipeline_events';
import {
    CaptureRecorder,
    clearCompletedRuns,
    serializeCaptureRecordJsonl,
    buildCaptureRecord,
    type CaptureEnvelope,
} from '@/engine/events/capture_record';
import { parseCaptureJsonl } from '@/engine/events/capture_aggregate';
import {
    writeCaptureRecord,
    captureOutPath,
    installNodeCaptureSink,
    type CaptureFsLike,
} from './node_capture_sink';

/**
 * NODE CAPTURE SINK (efficiency-review I1 / C6a) — the filesystem writer that
 * persists the already-computed-then-discarded per-stage + A3 per-branch timing.
 * Hermetic: an injected fs spy for the logic tests, one real-disk round-trip in
 * os.tmpdir for the fs path. No pipeline / no wasm / no solve contact.
 */

/** In-memory fs spy — records dirs created and file contents written. */
function makeFsSpy(): CaptureFsLike & { dirs: string[]; files: Map<string, string> } {
    const dirs: string[] = [];
    const files = new Map<string, string>();
    return {
        dirs,
        files,
        mkdirSync: (p: string) => { dirs.push(p); return undefined; },
        writeFileSync: (p: string, data: string) => { files.set(p, data); },
    };
}

/** A minimal but realistic run: per-stage envelopes + one A3 solve branch. */
function emitRun(bus: PipelineEventBus, runId: string, opts?: { branch?: string; branchMs?: number; attempts?: number; matched?: number }): void {
    bus.setRunContext({ runId, frameSha: 'a'.repeat(64) });
    bus.emit({ kind: 'run_started', mode: 'wizard', sourceFormat: 'FITS' });
    bus.emit({ kind: 'stage_started', stage: 'load', label: 'Load' });
    bus.emit({ kind: 'stage_finished', stage: 'load', ok: true, ms: 42 });
    bus.emit({ kind: 'stage_started', stage: 'extract', label: 'Star Detection' });
    bus.emit({ kind: 'stage_finished', stage: 'extract', ok: true, ms: 1908, verdict: 'PASS', counts: { stars: 812 }, payloadRef: 'signal' });
    // A3 per-branch timing — the value the review flagged as computed-then-discarded.
    const branch = opts?.branch ?? 'solve.uw_sweep';
    bus.emit({ kind: 'stage_started', stage: branch, label: 'Solve · Ultra-Wide Anchored Sweep' });
    bus.emit({
        kind: 'stage_finished', stage: branch, ok: true, ms: opts?.branchMs ?? 5200,
        verdict: 'PASS', counts: { attempts: opts?.attempts ?? 48, matched: opts?.matched ?? 55 }, payloadRef: 'solution',
    });
    bus.emit({ kind: 'stage_started', stage: 'integrate', label: 'Integrate' });
    bus.emit({ kind: 'stage_finished', stage: 'integrate', ok: true, ms: 30, verdict: 'PASS' });
    bus.emit({ kind: 'run_finished', ok: true });
}

const uninstallers: Array<() => void> = [];
afterEach(() => {
    while (uninstallers.length) uninstallers.pop()!();
    clearCompletedRuns();
});

describe('captureOutPath', () => {
    it('defaults to <run_id>.jsonl (the A4 corpus layout)', () => {
        expect(captureOutPath({ dir: '/runs' }, 'session_42')).toBe(path.join('/runs', 'session_42.jsonl'));
    });
    it('honors a fixed filename (the <run>/capture.jsonl per-run-dir layout)', () => {
        expect(captureOutPath({ dir: '/runs/r7', filename: 'capture.jsonl' }, 'session_42')).toBe(path.join('/runs/r7', 'capture.jsonl'));
    });
    it('sanitizes unsafe run-id characters into a filesystem-safe basename', () => {
        const p = captureOutPath({ dir: '/runs' }, 'a/b:c*?<>|');
        expect(path.basename(p)).toBe('a_b_c_.jsonl');
    });
});

describe('writeCaptureRecord', () => {
    it('writes the serialized JSONL to <dir>/<run_id>.jsonl and returns the path', () => {
        const spy = makeFsSpy();
        const envs = buildCaptureRecordFor('session_7');
        const out = writeCaptureRecord('/out', 'session_7', envs, { fsImpl: spy });
        expect(out).toBe(path.join('/out', 'session_7.jsonl'));
        expect(spy.dirs).toContain('/out');
        expect(spy.files.get(out!)).toBe(serializeCaptureRecordJsonl(envs));
        // Round-trips back to the same envelopes (parse the persisted text).
        expect(parseCaptureJsonl(spy.files.get(out!)!)).toEqual(envs);
    });

    it('is honest-absent: an empty record writes NOTHING and returns null', () => {
        const spy = makeFsSpy();
        expect(writeCaptureRecord('/out', 'session_7', [], { fsImpl: spy })).toBeNull();
        expect(spy.files.size).toBe(0);
        expect(spy.dirs.length).toBe(0);
    });

    it('is honest-absent: a missing run_id writes NOTHING and returns null', () => {
        const spy = makeFsSpy();
        expect(writeCaptureRecord('/out', null, buildCaptureRecordFor('x'), { fsImpl: spy })).toBeNull();
        expect(spy.files.size).toBe(0);
    });

    it('is non-fatal: a throwing fs is swallowed and returns null (never breaks a solve)', () => {
        const bad: CaptureFsLike = {
            mkdirSync: () => { throw new Error('EACCES'); },
            writeFileSync: () => { throw new Error('EACCES'); },
        };
        expect(() => writeCaptureRecord('/out', 'r', buildCaptureRecordFor('r'), { fsImpl: bad })).not.toThrow();
        expect(writeCaptureRecord('/out', 'r', buildCaptureRecordFor('r'), { fsImpl: bad })).toBeNull();
    });
});

describe('installNodeCaptureSink (end-to-end via the live CaptureRecorder)', () => {
    it('persists per-stage + A3 per-branch timing on run_finished', () => {
        const bus = new PipelineEventBus();
        new CaptureRecorder(bus); // recorder flushes to registered sinks on run_finished
        const spy = makeFsSpy();
        const written: Array<{ path: string; runId: string; n: number }> = [];
        uninstallers.push(installNodeCaptureSink({
            dir: '/out',
            fsImpl: spy,
            onWrite: (p, runId, envs) => written.push({ path: p, runId, n: envs.length }),
        }));

        emitRun(bus, 'session_ci', { branch: 'solve.uw_sweep', branchMs: 5200, attempts: 48, matched: 55 });

        // Exactly one file written, at the A4-layout path, via the onWrite hook.
        expect(written).toHaveLength(1);
        expect(written[0].runId).toBe('session_ci');
        expect(written[0].path).toBe(path.join('/out', 'session_ci.jsonl'));

        const text = spy.files.get(path.join('/out', 'session_ci.jsonl'))!;
        const persisted = parseCaptureJsonl(text);
        const byId = new Map(persisted.map(e => [e.stage_id, e]));
        // Per-orchestrator-stage timing survived.
        expect(byId.get('extract')!.ms).toBe(1908);
        expect(byId.get('load')!.ms).toBe(42);
        // A3 per-branch timing survived (ms + attempts) — the review's discarded value.
        const branch = byId.get('solve.uw_sweep')!;
        expect(branch.ms).toBe(5200);
        expect(branch.counts.attempts).toBe(48);
        expect(branch.counts.matched).toBe(55);
        expect(branch.verdict).toBe('PASS');
    });

    it('unregistering the sink stops further writes (no cross-run leakage)', () => {
        const bus = new PipelineEventBus();
        new CaptureRecorder(bus);
        const spy = makeFsSpy();
        const off = installNodeCaptureSink({ dir: '/out', fsImpl: spy });
        emitRun(bus, 'run_a');
        expect(spy.files.size).toBe(1);
        off();
        emitRun(bus, 'run_b');
        expect(spy.files.size).toBe(1); // no new file after unregister
    });
});

describe('real filesystem round-trip', () => {
    it('writes an on-disk JSONL that round-trips through parseCaptureJsonl', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-sink-'));
        try {
            const envs = buildCaptureRecordFor('session_disk');
            const out = writeCaptureRecord(dir, 'session_disk', envs);
            expect(out).toBeTruthy();
            expect(fs.existsSync(out!)).toBe(true);
            const text = fs.readFileSync(out!, 'utf8');
            expect(text.endsWith('\n')).toBe(true);
            expect(parseCaptureJsonl(text)).toEqual(envs);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

/** Build a real CaptureEnvelope[] via the production builder for a given run id. */
function buildCaptureRecordFor(runId: string): CaptureEnvelope[] {
    const bus = new PipelineEventBus();
    emitRun(bus, runId);
    return buildCaptureRecord(bus.getHistory());
}
