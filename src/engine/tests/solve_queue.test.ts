import { describe, it, expect } from 'vitest';
import {
    createQueueItem,
    markRunning,
    markSolved,
    markFailed,
    setStageNote,
    nextQueuedId,
    isQueueDrained,
    queueSummary,
    resultFromSolution,
    type QueueItem,
    type SolutionLike,
} from '../ui/dashboard/solve_queue/queue_state';

describe('solve queue — pure state machine', () => {
    it('classifies supported extensions as queued and unknown ones as unsupported', () => {
        const fits = createQueueItem('a', 'm66.fits', 100, 'drop');
        const fit = createQueueItem('b', 'stack.fit', 100, 'drop');
        const cr2 = createQueueItem('c', 'IMG_1757.CR2', 100, 'drop'); // case-insensitive
        // .png/.bmp stay unsupported (JPEG/TIFF now queue at demo tier — 2026-07-11).
        const png = createQueueItem('d', 'preview.png', 100, 'drop');
        const bmp = createQueueItem('e', 'scan.bmp', 100, 'drop');

        expect(fits.status).toBe('queued');
        expect(fit.status).toBe('queued');
        expect(cr2.status).toBe('queued');
        // Honest skip — never enqueued as false hope (LAW 3), with a real verdict.
        expect(png.status).toBe('unsupported');
        expect(png.error).toMatch(/unsupported/i);
        expect(bmp.status).toBe('unsupported');
    });

    it('a fresh item carries no fabricated result/error (honest-absent)', () => {
        const it0 = createQueueItem('a', 'm66.fits', 500, 'local-dir');
        expect(it0.result).toBeNull();
        expect(it0.error).toBeNull();
        expect(it0.runId).toBeNull();
        expect(it0.frameSha).toBeNull();
        expect(it0.sourceId).toBe('local-dir');
    });

    it('markRunning → markSolved carries the measured result and clears notes', () => {
        let items: QueueItem[] = [createQueueItem('a', 'm66.fits', 1, 'drop')];
        items = markRunning(items, 'a', { runId: 'queue_abc', frameSha: 'abc', format: 'FITS' });
        expect(items[0].status).toBe('running');
        expect(items[0].runId).toBe('queue_abc');
        expect(items[0].format).toBe('FITS');

        items = setStageNote(items, 'a', 'Solving plate…');
        expect(items[0].stageNote).toBe('Solving plate…');

        items = markSolved(items, 'a', { raHours: 11.34, decDeg: 13, scaleArcsecPerPx: 3.67, matched: 272, confidence: 0.83 });
        expect(items[0].status).toBe('solved');
        expect(items[0].result?.matched).toBe(272);
        expect(items[0].stageNote).toBeNull();
        expect(items[0].error).toBeNull();
    });

    it('markFailed sets an honest verdict and no result', () => {
        let items: QueueItem[] = [createQueueItem('a', 'm66.fits', 1, 'drop')];
        items = markFailed(items, 'a', 'Plate solve failed — no geometric lock.');
        expect(items[0].status).toBe('failed');
        expect(items[0].result).toBeNull();
        expect(items[0].error).toMatch(/no geometric lock/);
    });

    it('nextQueuedId walks queued items in order and skips terminal states', () => {
        let items: QueueItem[] = [
            createQueueItem('a', 'bad.png', 1, 'drop'),   // unsupported — skipped
            createQueueItem('b', 'one.fits', 1, 'drop'),
            createQueueItem('c', 'two.cr2', 1, 'drop'),
        ];
        expect(nextQueuedId(items)).toBe('b');
        items = markSolved(items, 'b', { raHours: 0, decDeg: 0, scaleArcsecPerPx: 1, matched: 10, confidence: 0.5 });
        expect(nextQueuedId(items)).toBe('c');
        items = markFailed(items, 'c', 'no lock');
        expect(nextQueuedId(items)).toBeNull();
        expect(isQueueDrained(items)).toBe(true);
    });

    it('queueSummary tallies every status honestly', () => {
        let items: QueueItem[] = [
            createQueueItem('a', 'one.fits', 1, 'drop'),
            createQueueItem('b', 'two.cr2', 1, 'drop'),
            createQueueItem('c', 'skip.png', 1, 'drop'), // unsupported
        ];
        items = markSolved(items, 'a', { raHours: 0, decDeg: 0, scaleArcsecPerPx: 1, matched: 5, confidence: 0.9 });
        items = markFailed(items, 'b', 'no lock');
        const s = queueSummary(items);
        expect(s).toEqual({ total: 3, queued: 0, running: 0, solved: 1, failed: 1, unsupported: 1 });
    });

    it('BulkProgressLine math is a determinate measured count (denominator excludes unsupported)', () => {
        // The pane's "X / Y processed" line: X = solved+failed (finished work),
        // Y = total − unsupported (only ever-runnable files). Never a percent/ETA.
        let items: QueueItem[] = [
            createQueueItem('a', 'one.fits', 1, 'drop'),
            createQueueItem('b', 'two.cr2', 1, 'drop'),
            createQueueItem('c', 'skip.png', 1, 'drop'),   // unsupported — never counted in Y
            createQueueItem('d', 'three.fits', 1, 'drop'),
        ];
        items = markSolved(items, 'a', { raHours: 0, decDeg: 0, scaleArcsecPerPx: 1, matched: 5, confidence: 0.9 });
        items = markFailed(items, 'b', 'no lock');
        const s = queueSummary(items);
        const processed = s.solved + s.failed;
        const runnableTotal = s.total - s.unsupported;
        expect(processed).toBe(2);
        expect(runnableTotal).toBe(3);           // 4 total − 1 unsupported
        // "N / N processed" is reachable even with a skipped PNG in view.
        items = markSolved(items, 'd', { raHours: 0, decDeg: 0, scaleArcsecPerPx: 1, matched: 9, confidence: 0.7 });
        const s2 = queueSummary(items);
        expect((s2.solved + s2.failed)).toBe(s2.total - s2.unsupported);
    });

    it('resultFromSolution mirrors the solution_locked field derivation', () => {
        const withMatched: SolutionLike = {
            ra_hours: 17.5858, dec_degrees: -20, pixel_scale: 63.21, confidence: 0.86,
            matched_stars: { length: 55 },
        };
        expect(resultFromSolution(withMatched)).toEqual({
            raHours: 17.5858, decDeg: -20, scaleArcsecPerPx: 63.21, matched: 55, confidence: 0.86,
        });
        // Falls back to diagnostics.stars_matched when matched_stars is absent.
        const viaDiag: SolutionLike = {
            ra_hours: 1, dec_degrees: 2, pixel_scale: 3, confidence: 0.4,
            matched_stars: null, diagnostics: { stars_matched: 42 },
        };
        expect(resultFromSolution(viaDiag).matched).toBe(42);
        // Neither present → 0 (not a fabricated non-zero).
        const neither: SolutionLike = { ra_hours: 1, dec_degrees: 2, pixel_scale: 3, confidence: 0.4 };
        expect(resultFromSolution(neither).matched).toBe(0);
    });

    it('patch operations are immutable (no in-place mutation)', () => {
        const items: QueueItem[] = [createQueueItem('a', 'm66.fits', 1, 'drop')];
        const next = markRunning(items, 'a', { runId: 'r', frameSha: null, format: 'FITS' });
        expect(items[0].status).toBe('queued'); // original untouched
        expect(next[0].status).toBe('running');
        expect(next).not.toBe(items);
    });
});
