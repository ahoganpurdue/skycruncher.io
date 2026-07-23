import { describe, it, expect, vi } from 'vitest';
import {
    PipelineEventBus,
    EVENT_HISTORY_CAP,
    type PipelineEvent,
    type PipelineEventInput
} from '../events/pipeline_events';

/**
 * PHASE U — GLASS PIPELINE EVENT BUS
 * Pure bus mechanics only. The OrchestratorSession emission sites are NOT
 * exercised here (heavy browser/GPU deps); they are covered by the E2E
 * harness once the UI migrates onto the event stream.
 */
describe('PipelineEventBus', () => {

    it('stamps emitted events with t (epoch ms) and delivers them to subscribers', () => {
        const bus = new PipelineEventBus();
        const received: PipelineEvent[] = [];
        bus.subscribe(e => received.push(e));

        const before = Date.now();
        const stamped = bus.emit({ kind: 'run_started', mode: 'wizard', sourceFormat: 'FITS' });
        const after = Date.now();

        expect(received).toHaveLength(1);
        expect(received[0]).toBe(stamped);
        expect(received[0].kind).toBe('run_started');
        if (received[0].kind === 'run_started') {
            expect(received[0].mode).toBe('wizard');
            expect(received[0].sourceFormat).toBe('FITS');
        }
        expect(stamped.t).toBeGreaterThanOrEqual(before);
        expect(stamped.t).toBeLessThanOrEqual(after);
        expect(stamped.seq).toBe(1);
    });

    it('unsubscribe stops delivery (and is safe to call twice)', () => {
        const bus = new PipelineEventBus();
        const a: PipelineEvent[] = [];
        const b: PipelineEvent[] = [];
        const unsubA = bus.subscribe(e => a.push(e));
        bus.subscribe(e => b.push(e));

        bus.emit({ kind: 'stage_started', stage: 'load', label: 'Load & Inspect' });
        unsubA();
        unsubA(); // idempotent
        bus.emit({ kind: 'stage_finished', stage: 'load', ok: true, ms: 12 });

        expect(a).toHaveLength(1);
        expect(b).toHaveLength(2);
    });

    it('assigns strictly monotonic seq numbers across event kinds', () => {
        const bus = new PipelineEventBus();
        bus.emit({ kind: 'run_started', mode: 'auto' });
        bus.emit({ kind: 'stage_started', stage: 'solve', label: 'Plate Solve' });
        bus.emit({ kind: 'warning', message: 'degraded', stage: 'solve' });
        bus.emit({ kind: 'run_finished', ok: false });

        const seqs = bus.getHistory().map(e => e.seq);
        expect(seqs).toHaveLength(4);
        for (let i = 1; i < seqs.length; i++) {
            expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
        }
    });

    it('keeps a replayable history for late subscribers', () => {
        const bus = new PipelineEventBus();
        bus.emit({ kind: 'run_started', mode: 'wizard' });
        bus.emit({ kind: 'stage_started', stage: 'extract', label: 'Star Detection' });
        bus.emit({
            kind: 'finding',
            finding: { kind: 'stars_detected', count: 812, anomalies: 17 }
        });

        // A subscriber arriving mid-run replays history, then receives live events.
        const seen: PipelineEvent[] = [];
        bus.getHistory().forEach(e => seen.push(e));
        bus.subscribe(e => seen.push(e));
        bus.emit({ kind: 'stage_finished', stage: 'extract', ok: true, ms: 1500 });

        expect(seen.map(e => e.kind)).toEqual(['run_started', 'stage_started', 'finding', 'stage_finished']);
        expect(seen.map(e => e.seq)).toEqual([1, 2, 3, 4]);
    });

    it('ring buffer drops oldest events past the default cap (~2000) but seq keeps counting', () => {
        const bus = new PipelineEventBus();
        const total = EVENT_HISTORY_CAP + 50;
        for (let i = 0; i < total; i++) {
            bus.emit({ kind: 'stage_progress', stage: 'solve', pct: i % 100 });
        }

        const history = bus.getHistory();
        expect(history).toHaveLength(EVENT_HISTORY_CAP);
        expect(history[0].seq).toBe(51);              // oldest 50 evicted
        expect(history[history.length - 1].seq).toBe(total);
    });

    it('honors a custom capacity', () => {
        const bus = new PipelineEventBus(3);
        for (let i = 0; i < 5; i++) {
            bus.emit({ kind: 'warning', message: `w${i}` });
        }
        const history = bus.getHistory();
        expect(history).toHaveLength(3);
        expect(history.map(e => e.seq)).toEqual([3, 4, 5]);
    });

    it('clear() empties history without resetting seq monotonicity', () => {
        const bus = new PipelineEventBus();
        bus.emit({ kind: 'run_started', mode: 'auto' });
        bus.emit({ kind: 'run_finished', ok: true });
        bus.clear();
        expect(bus.getHistory()).toHaveLength(0);

        const next = bus.emit({ kind: 'run_started', mode: 'wizard' });
        expect(next.seq).toBe(3); // continues past the cleared events
        expect(bus.getHistory()).toHaveLength(1);
    });

    it('a throwing subscriber does not break emission or starve other subscribers', () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const bus = new PipelineEventBus();
            const received: PipelineEvent[] = [];
            bus.subscribe(() => { throw new Error('UI subscriber exploded'); });
            bus.subscribe(e => received.push(e));

            expect(() => {
                bus.emit({ kind: 'warning', message: 'still delivered' });
                bus.emit({ kind: 'run_finished', ok: true });
            }).not.toThrow();

            expect(received).toHaveLength(2);
            expect(bus.getHistory()).toHaveLength(2);
            expect(errSpy).toHaveBeenCalled();
        } finally {
            errSpy.mockRestore();
        }
    });

    it('type-level smoke: one of every event kind (incl. reserved finding kinds) emits cleanly', () => {
        const bus = new PipelineEventBus();

        const one: PipelineEventInput[] = [
            { kind: 'run_started', mode: 'wizard', sourceFormat: 'FITS' },
            { kind: 'stage_started', stage: 'load', label: 'Load & Inspect' },
            { kind: 'stage_progress', stage: 'load', pct: 42, note: 'Decoding FITS image...' },
            { kind: 'stage_finished', stage: 'load', ok: true, ms: 310 },
            { kind: 'finding', finding: { kind: 'stars_detected', count: 640, anomalies: 12 } },
            { kind: 'finding', finding: { kind: 'scale_locked', arcsecPerPx: 2.39, source: 'FITS_HEADER' } },
            { kind: 'finding', finding: { kind: 'solve_candidate', idx: 3, quadError: 1.2e-4, inferredScale: 2.41, status: 'REJECTED_SCALE_GATE' } },
            { kind: 'finding', finding: { kind: 'solution_locked', raHours: 11.34, decDeg: 13.0, scale: 2.39, rotationDeg: 173.2, matched: 41, confidence: 0.63 } },
            { kind: 'finding', finding: { kind: 'packet_built', stars: 640 } },
            // Reserved DSLR / science-workbench kinds — must construct today:
            { kind: 'finding', finding: { kind: 'hint_applied', source: 'FITS_HEADER', raHours: 5.588, decDeg: -5.39, radiusDeg: 10 } },
            { kind: 'finding', finding: { kind: 'blind_search_progress', centersTried: 12, centersTotal: 96, raHours: 4.1, decDeg: 22.0 } },
            { kind: 'finding', finding: { kind: 'artifact_classified', artifactClass: 'satellite', count: 2 } },
            { kind: 'finding', finding: { kind: 'extinction_measured', gradient: 0.08, airMass: 1.4 } },
            { kind: 'warning', message: 'No capture timestamp in file metadata', stage: 'extract' },
            { kind: 'provenance_changed', key: 'coordinateSystem', from: 'PIXEL_ARRAY', to: 'WCS', stage: 'step4_solve' },
            { kind: 'run_finished', ok: true }
        ];

        for (const e of one) bus.emit(e);

        const history = bus.getHistory();
        expect(history).toHaveLength(one.length);
        expect(history.filter(e => e.kind === 'finding')).toHaveLength(9);
        // Discriminant narrowing sanity on the stamped union:
        const locked = history.find(e => e.kind === 'finding' && e.finding.kind === 'solution_locked');
        expect(locked).toBeDefined();
        if (locked && locked.kind === 'finding' && locked.finding.kind === 'solution_locked') {
            expect(locked.finding.matched).toBe(41);
        }
    });
});
