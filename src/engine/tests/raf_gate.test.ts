import { describe, it, expect } from 'vitest';
import { rafGateActive } from '../ui/widgets/useRafGate';

/**
 * useRafGate — the house idle gate for rAF-driven widgets (owner walkthrough
 * 2026-07-21 main-thread starvation). The PURE decision is the whole contract:
 * an animation loop runs iff the caller enabled it AND the tab is visible AND the
 * widget element is on-screen. Any one condition false ⇒ the loop idles.
 */
describe('rafGateActive — run iff enabled AND visible AND on-screen', () => {
    it('runs only when all three are true', () => {
        expect(rafGateActive(true, true, true)).toBe(true);
    });

    it('idles when the tab is hidden', () => {
        expect(rafGateActive(false, true, true)).toBe(false);
    });

    it('idles when the element is off-screen', () => {
        expect(rafGateActive(true, false, true)).toBe(false);
    });

    it('idles when the caller disabled it', () => {
        expect(rafGateActive(true, true, false)).toBe(false);
    });

    it('any single false condition idles the loop (truth table)', () => {
        for (const doc of [true, false]) {
            for (const on of [true, false]) {
                for (const en of [true, false]) {
                    expect(rafGateActive(doc, on, en)).toBe(doc && on && en);
                }
            }
        }
    });
});
