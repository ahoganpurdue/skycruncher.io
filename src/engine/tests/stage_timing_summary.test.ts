import { describe, it, expect } from 'vitest';
import { PipelineEventBus } from '../events/pipeline_events';
import {
    summarizeStageTimings,
    STAGE_TIMING_SCHEMA_VERSION,
} from '../events/stage_timing_summary';

/**
 * STAGE TIMING SUMMARY — the per-run timing rollup (efficiency review I1/I2).
 * Covers the per-stage ms map, the SPAN total (no nested double-count), the
 * decoder-arm passthrough, source_format/ok/frame_sha extraction, and the
 * LAW-3 honest-null on an incomplete run.
 */
describe('summarizeStageTimings', () => {
    it('folds a full run into a per-stage ms map + span total + context', () => {
        const bus = new PipelineEventBus();
        bus.setRunContext({ runId: 'session_1', frameSha: 'abc123' });
        bus.emit({ kind: 'run_started', mode: 'wizard', sourceFormat: 'FITS' });
        bus.emit({ kind: 'stage_started', stage: 'load', label: 'Load' });
        bus.emit({ kind: 'stage_finished', stage: 'load', ok: true, ms: 100 });
        bus.emit({ kind: 'stage_started', stage: 'extract', label: 'Detect' });
        bus.emit({ kind: 'stage_finished', stage: 'extract', ok: true, ms: 250 });
        bus.emit({ kind: 'run_finished', ok: true });

        const s = summarizeStageTimings(bus.getHistory(), { decoderArm: 'rawler' });
        expect(s.v).toBe(STAGE_TIMING_SCHEMA_VERSION);
        expect(s.run_id).toBe('session_1');
        expect(s.frame_sha).toBe('abc123');
        expect(s.source_format).toBe('FITS');
        expect(s.decoder_arm).toBe('rawler');
        expect(s.ok).toBe(true);
        expect(s.n_stages).toBe(2);
        expect(s.stages).toEqual({ load: 100, extract: 250 });
        // Span = max(end) - min(start); each stage's start = finished.t - ms.
        expect(typeof s.total_ms).toBe('number');
        expect(s.total_ms).toBeGreaterThanOrEqual(0);
    });

    it('uses SPAN not SUM so a nested (umbrella) stage is not double-counted', () => {
        // Synthesize monotonic timestamps: an umbrella stage that wraps two
        // children, all inside a single [0, 1000] wall window.
        const now = Date.now();
        const events = [
            { kind: 'run_started', mode: 'wizard', sourceFormat: 'CR2', t: now, seq: 1, runId: 'r' },
            // children (finish first, inside the umbrella window)
            { kind: 'stage_finished', stage: 'psf_field', ok: true, ms: 300, t: now + 400, seq: 2, runId: 'r' },
            { kind: 'stage_finished', stage: 'bc_rematch', ok: true, ms: 200, t: now + 700, seq: 3, runId: 'r' },
            // umbrella spans the whole calibrate window
            { kind: 'stage_finished', stage: 'calibrate', ok: true, ms: 1000, t: now + 1000, seq: 4, runId: 'r' },
            { kind: 'run_finished', ok: true, t: now + 1000, seq: 5, runId: 'r' },
        ] as unknown as Parameters<typeof summarizeStageTimings>[0];

        const s = summarizeStageTimings(events, { decoderArm: 'rawler' });
        // SUM would be 300+200+1000 = 1500 (double-counts children under umbrella).
        // SPAN = max(end)=now+1000 − min(start)=now+0 (calibrate start) = 1000.
        expect(s.total_ms).toBe(1000);
        expect(s.stages).toEqual({ psf_field: 300, bc_rematch: 200, calibrate: 1000 });
        expect(s.n_stages).toBe(3);
        expect(s.source_format).toBe('CR2');
    });

    it('is honest-absent on an incomplete run (no run_finished ⇒ ok=null)', () => {
        const bus = new PipelineEventBus();
        bus.setRunContext({ runId: 'r2' });
        bus.emit({ kind: 'run_started', mode: 'wizard', sourceFormat: 'FITS' });
        bus.emit({ kind: 'stage_finished', stage: 'load', ok: true, ms: 50 });
        // no run_finished — the run crashed/aborted

        const s = summarizeStageTimings(bus.getHistory(), { decoderArm: 'libraw' });
        expect(s.ok).toBeNull();
        expect(s.decoder_arm).toBe('libraw');
        expect(s.n_stages).toBe(1);
        expect(s.stages).toEqual({ load: 50 });
    });

    it('empty stream ⇒ null-honest totals, no throw', () => {
        const s = summarizeStageTimings([], { decoderArm: 'rawler' });
        expect(s.run_id).toBeNull();
        expect(s.frame_sha).toBeNull();
        expect(s.source_format).toBeNull();
        expect(s.ok).toBeNull();
        expect(s.total_ms).toBeNull();
        expect(s.n_stages).toBe(0);
        expect(s.stages).toEqual({});
    });

    it('frame_sha honors async back-fill (last non-null wins)', () => {
        const bus = new PipelineEventBus();
        bus.setRunContext({ runId: 'r3' });
        bus.emit({ kind: 'run_started', mode: 'wizard' });   // frameSha still undefined
        bus.setRunContext({ frameSha: 'late_hash' });         // resolves mid-run
        bus.emit({ kind: 'stage_finished', stage: 'load', ok: true, ms: 10 });
        bus.emit({ kind: 'run_finished', ok: true });

        const s = summarizeStageTimings(bus.getHistory(), { decoderArm: 'rawler' });
        expect(s.frame_sha).toBe('late_hash');
    });
});
