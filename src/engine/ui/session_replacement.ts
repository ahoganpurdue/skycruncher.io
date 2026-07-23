/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SESSION REPLACEMENT — app-shell lifecycle helpers (pure, unit-tested)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The app was one-shot per launch (owner, 2026-07-22: "once I run an image ONCE,
 * I can't run another"). MainApp now REPLACES the session for a new image; the
 * decision logic + the honest failure copy live here — separated from MainApp's
 * React wiring so the honest-discard behavior and the failure message have a
 * unit gate (session_replacement.test.ts). No React, no side effects.
 */

/**
 * The honest message shown when a decode/extract FATALLY fails. Historically a
 * SILENT wedge (SignalGraphStep only console.error'd, leaving the step frozen
 * with no message — the owner's "nothing happens, can't run another image").
 * Shared by the wizard step's inline surface and the App's landing banner so the
 * copy is single-sourced. Names the memory-exhaustion class (the measured cause
 * of the second-large-RAW failure on a constrained webview) and how to clear it.
 */
export const DECODE_FAILURE_MESSAGE =
    'Image decode/processing failed. Large RAW files can exhaust memory after '
    + 'several runs in one session — start a new image, or restart the app, to clear it.';

/**
 * Should a "new image" request ASK before discarding the current one?
 *
 * True when there is a run IN FLIGHT (the wizard is open) OR results the user
 * has NOT exported — i.e. there is unsaved work to lose. Honest-or-absent (LAW
 * 3): never silently destroy unsaved work; nothing to lose (fresh landing, or
 * results already exported) ⇒ no prompt, straight to a clean reset.
 */
export function shouldConfirmNewImage(s: {
    /** The pipeline wizard is open (a solve is in flight or paused mid-flow). */
    showWizard: boolean;
    /** A completed run's results are on screen (astroData present). */
    hasResults: boolean;
    /** The user downloaded this run's receipt (so discarding loses nothing). */
    hasExported: boolean;
}): boolean {
    return s.showWizard || (s.hasResults && !s.hasExported);
}
