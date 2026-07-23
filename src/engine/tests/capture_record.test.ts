import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineEventBus } from '../events/pipeline_events';
import {
    buildCaptureRecord,
    serializeCaptureRecordJsonl,
    CaptureRecorder,
    registerCaptureSink,
    getCompletedRun,
    clearCompletedRuns,
    sha256Hex,
    type CaptureEnvelope,
} from '../events/capture_record';

/**
 * CAPTURE RECORD — the ★ dashboard/flowchart wave-1 persistence substrate.
 * Covers the envelope shape, LAW-3 null-honest verdicts, the frame-sha dedup
 * key (incl. async back-fill), nested-stage pairing, warning attribution, the
 * live recorder → sink path, and the cross-env content hash.
 */
describe('buildCaptureRecord', () => {
    it('produces one envelope per stage with run_id + frame_sha + verdict/counts/payload_ref', () => {
        const bus = new PipelineEventBus();
        bus.setRunContext({ runId: 'session_42', frameSha: 'deadbeef' });
        bus.emit({ kind: 'run_started', mode: 'wizard', sourceFormat: 'FITS' });
        bus.emit({ kind: 'stage_started', stage: 'extract', label: 'Star Detection' });
        bus.emit({
            kind: 'stage_finished', stage: 'extract', ok: true, ms: 1500,
            verdict: 'PASS', counts: { stars: 812 }, payloadRef: 'signal',
        });
        bus.emit({ kind: 'run_finished', ok: true });

        const record = buildCaptureRecord(bus.getHistory());
        expect(record).toHaveLength(1);
        const env = record[0];
        expect(env.run_id).toBe('session_42');
        expect(env.frame_sha).toBe('deadbeef');
        expect(env.stage_id).toBe('extract');
        expect(env.ok).toBe(true);
        expect(env.ms).toBe(1500);
        expect(env.verdict).toBe('PASS');
        expect(env.counts).toEqual({ stars: 812 });
        expect(env.payload_ref).toBe('signal');
        expect(env.t_end).toBeGreaterThanOrEqual(env.t_start);
        // Envelope shape is complete (all contract keys present).
        expect(Object.keys(env).sort()).toEqual(
            ['counts', 'frame_sha', 'ms', 'ok', 'payload_ref', 'run_id', 'seq', 'stage_id', 't_end', 't_start', 'verdict', 'warnings'].sort(),
        );
    });

    it('is null-honest: an unmeasured stage carries verdict=null, {} counts, null payload_ref (never a placeholder)', () => {
        const bus = new PipelineEventBus();
        bus.setRunContext({ runId: 'r' });
        bus.emit({ kind: 'stage_started', stage: 'metrology', label: 'Scale & Ephemeris' });
        bus.emit({ kind: 'stage_finished', stage: 'metrology', ok: true, ms: 10 });

        const [env] = buildCaptureRecord(bus.getHistory());
        expect(env.verdict).toBeNull();
        expect(env.counts).toEqual({});
        expect(env.payload_ref).toBeNull();
    });

    it('carries the dedup key: frame_sha back-fills async (last non-null stamp wins)', () => {
        const bus = new PipelineEventBus();
        bus.setRunContext({ runId: 'r', frameSha: null }); // not yet hashed
        bus.emit({ kind: 'stage_started', stage: 'load', label: 'Load' });
        // digest resolves mid-run:
        bus.setRunContext({ frameSha: 'abc123' });
        bus.emit({ kind: 'stage_finished', stage: 'load', ok: true, ms: 5 });

        const [env] = buildCaptureRecord(bus.getHistory());
        expect(env.frame_sha).toBe('abc123');
    });

    it('honest-absent when never hashed: frame_sha=null and run_id=null are preserved', () => {
        const bus = new PipelineEventBus();
        bus.emit({ kind: 'stage_started', stage: 'load', label: 'Load' });
        bus.emit({ kind: 'stage_finished', stage: 'load', ok: false, ms: 3, verdict: 'FAIL' });

        const [env] = buildCaptureRecord(bus.getHistory());
        expect(env.run_id).toBeNull();
        expect(env.frame_sha).toBeNull();
        expect(env.verdict).toBe('FAIL');
    });

    it('pairs NESTED stages LIFO (calibrate umbrella spans its inner sub-stages)', () => {
        const bus = new PipelineEventBus();
        bus.setRunContext({ runId: 'r' });
        bus.emit({ kind: 'stage_started', stage: 'calibrate', label: 'Calibration' });
        bus.emit({ kind: 'stage_started', stage: 'psf_field', label: 'PSF Field' });
        bus.emit({ kind: 'stage_finished', stage: 'psf_field', ok: true, ms: 40, verdict: 'PASS' });
        bus.emit({ kind: 'stage_started', stage: 'bc_measure', label: 'Measured BC' });
        bus.emit({ kind: 'stage_finished', stage: 'bc_measure', ok: true, ms: 7, verdict: 'NOT_MEASURED' });
        bus.emit({ kind: 'stage_finished', stage: 'calibrate', ok: true, ms: 60, verdict: 'PASS' });

        const record = buildCaptureRecord(bus.getHistory());
        const byId = Object.fromEntries(record.map(e => [e.stage_id, e]));
        expect(record).toHaveLength(3);
        // The umbrella must start no later than its inner stages and end no earlier.
        expect(byId.calibrate.t_start).toBeLessThanOrEqual(byId.psf_field.t_start);
        expect(byId.calibrate.t_end).toBeGreaterThanOrEqual(byId.bc_measure.t_end);
        expect(byId.bc_measure.verdict).toBe('NOT_MEASURED');
    });

    it('attributes warnings to the stage whose window contains them', () => {
        const bus = new PipelineEventBus();
        bus.setRunContext({ runId: 'r' });
        bus.emit({ kind: 'stage_started', stage: 'psf_field', label: 'PSF Field' });
        bus.emit({ kind: 'warning', message: 'PSF characterization skipped', stage: 'psf_field' });
        bus.emit({ kind: 'stage_finished', stage: 'psf_field', ok: true, ms: 12 });

        const [env] = buildCaptureRecord(bus.getHistory());
        expect(env.warnings).toEqual(['PSF characterization skipped']);
    });
});

describe('serializeCaptureRecordJsonl', () => {
    it('emits one JSON object per line with a trailing newline; round-trips', () => {
        const env: CaptureEnvelope = {
            run_id: 'r', frame_sha: null, stage_id: 'solve', seq: 4,
            t_start: 1, t_end: 3, ms: 2, ok: true, verdict: 'PASS',
            counts: { matched: 272 }, warnings: [], payload_ref: 'solution',
        };
        const jsonl = serializeCaptureRecordJsonl([env, env]);
        const lines = jsonl.split('\n').filter(Boolean);
        expect(lines).toHaveLength(2);
        expect(jsonl.endsWith('\n')).toBe(true);
        expect(JSON.parse(lines[0])).toEqual(env);
    });

    it('empty record → empty string (no stray newline)', () => {
        expect(serializeCaptureRecordJsonl([])).toBe('');
    });
});

describe('CaptureRecorder', () => {
    beforeEach(() => clearCompletedRuns());

    it('flushes on run_finished into the store and every registered sink', () => {
        const bus = new PipelineEventBus();
        const recorder = new CaptureRecorder(bus);
        const sinkCalls: Array<{ runId: string; n: number }> = [];
        const off = registerCaptureSink((runId, envelopes) => sinkCalls.push({ runId, n: envelopes.length }));

        bus.setRunContext({ runId: 'session_run', frameSha: 'sha' });
        bus.emit({ kind: 'run_started', mode: 'wizard' });
        bus.emit({ kind: 'stage_started', stage: 'load', label: 'Load' });
        bus.emit({ kind: 'stage_finished', stage: 'load', ok: true, ms: 9, verdict: 'PASS' });
        bus.emit({ kind: 'run_finished', ok: true });

        expect(sinkCalls).toEqual([{ runId: 'session_run', n: 1 }]);
        const stored = getCompletedRun('session_run');
        expect(stored).toBeTruthy();
        expect(stored![0].stage_id).toBe('load');
        expect(stored![0].frame_sha).toBe('sha');

        off();
        recorder.dispose();
    });

    it('a throwing sink never breaks the run (recorder swallows it)', () => {
        const bus = new PipelineEventBus();
        new CaptureRecorder(bus);
        const off = registerCaptureSink(() => { throw new Error('sink exploded'); });
        bus.setRunContext({ runId: 'r2' });
        expect(() => {
            bus.emit({ kind: 'run_started', mode: 'wizard' });
            bus.emit({ kind: 'run_finished', ok: true });
        }).not.toThrow();
        off();
    });
});

describe('sha256Hex', () => {
    it('matches the canonical SHA-256("abc") test vector', async () => {
        const buf = new TextEncoder().encode('abc');
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        const hex = await sha256Hex(ab);
        expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
});
