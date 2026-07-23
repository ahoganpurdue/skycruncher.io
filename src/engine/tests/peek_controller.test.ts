/**
 * PEEK CONTROLLER — unit tests (node env, fake timers; the DOM-free core of the
 * NightPeek press-and-hold interaction). Verifies the hold threshold, that a
 * quick tap never reveals, custom holdMs, idempotent arming, and disposal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPeekController, DEFAULT_PEEK_HOLD_MS } from '../ui/theme/peek_controller';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createPeekController', () => {
    it('reveals only after the hold threshold (>=150ms), then un-peeks on release', () => {
        const changes: boolean[] = [];
        const c = createPeekController({ onChange: (v) => changes.push(v) });

        c.down();
        expect(c.isPeeking()).toBe(false);
        vi.advanceTimersByTime(DEFAULT_PEEK_HOLD_MS - 1);
        expect(c.isPeeking()).toBe(false); // not yet
        vi.advanceTimersByTime(1);
        expect(c.isPeeking()).toBe(true);
        expect(changes).toEqual([true]);

        c.up();
        expect(c.isPeeking()).toBe(false);
        expect(changes).toEqual([true, false]);
    });

    it('a quick tap (< holdMs) never reveals and never fires onChange', () => {
        const changes: boolean[] = [];
        const c = createPeekController({ onChange: (v) => changes.push(v) });

        c.down();
        vi.advanceTimersByTime(100); // release before 150
        c.up();
        vi.advanceTimersByTime(500); // the disarmed timer must not fire
        expect(c.isPeeking()).toBe(false);
        expect(changes).toEqual([]);
    });

    it('honors a custom holdMs', () => {
        const c = createPeekController({ holdMs: 400, onChange: () => {} });
        c.down();
        vi.advanceTimersByTime(399);
        expect(c.isPeeking()).toBe(false);
        vi.advanceTimersByTime(1);
        expect(c.isPeeking()).toBe(true);
    });

    it('repeated down() while armed is idempotent (one reveal, one onChange)', () => {
        const changes: boolean[] = [];
        const c = createPeekController({ onChange: (v) => changes.push(v) });
        c.down();
        c.down();
        c.down();
        vi.advanceTimersByTime(DEFAULT_PEEK_HOLD_MS);
        expect(c.isPeeking()).toBe(true);
        expect(changes).toEqual([true]);
    });

    it('dispose() clears a pending hold — no reveal after unmount', () => {
        const changes: boolean[] = [];
        const c = createPeekController({ onChange: (v) => changes.push(v) });
        c.down();
        c.dispose();
        vi.advanceTimersByTime(1000);
        expect(c.isPeeking()).toBe(false);
        expect(changes).toEqual([]);
    });

    it('up() before the threshold disarms cleanly (no late reveal)', () => {
        const c = createPeekController({ onChange: () => {} });
        c.down();
        c.up();
        vi.advanceTimersByTime(1000);
        expect(c.isPeeking()).toBe(false);
    });
});
