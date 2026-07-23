import { describe, it, expect } from 'vitest';
import { shouldConfirmNewImage, DECODE_FAILURE_MESSAGE } from '../ui/session_replacement';

/**
 * SESSION REPLACEMENT — the app was one-shot per launch (2026-07-22 ship-blocker).
 * These gate the honest-discard DECISION (when does "new image" confirm?) and the
 * single-sourced honest failure copy. The full reset state-machine + the CR2→CR2
 * memory behavior are covered by the browser proof (tools/e2e/run_cr2_then_cr2.mjs);
 * this is the pure-logic gate.
 */
describe('session replacement — honest-discard decision (shouldConfirmNewImage)', () => {
    it('a fresh landing has nothing to lose → no confirm', () => {
        expect(shouldConfirmNewImage({ showWizard: false, hasResults: false, hasExported: false })).toBe(false);
    });

    it('a run IN FLIGHT (wizard open) always confirms — even before any results', () => {
        expect(shouldConfirmNewImage({ showWizard: true, hasResults: false, hasExported: false })).toBe(true);
        // Mid-flight stays gated regardless of the (stale) exported flag.
        expect(shouldConfirmNewImage({ showWizard: true, hasResults: false, hasExported: true })).toBe(true);
    });

    it('completed results NOT yet exported → confirm (never silently discard unsaved work)', () => {
        expect(shouldConfirmNewImage({ showWizard: false, hasResults: true, hasExported: false })).toBe(true);
    });

    it('completed results ALREADY exported → nothing to lose → no confirm', () => {
        expect(shouldConfirmNewImage({ showWizard: false, hasResults: true, hasExported: true })).toBe(false);
    });

    it('the honest failure message names the memory class + the recovery, no fake claim', () => {
        expect(DECODE_FAILURE_MESSAGE).toMatch(/failed/i);
        expect(DECODE_FAILURE_MESSAGE).toMatch(/memory/i);
        expect(DECODE_FAILURE_MESSAGE).toMatch(/new image|restart/i);
        // Honest-or-absent (LAW 3): no fabricated number/percentage in the copy.
        expect(DECODE_FAILURE_MESSAGE).not.toMatch(/\d+\s?%/);
    });
});
