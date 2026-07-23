/**
 * -----------------------------------------------------------------
 * PEEK CONTROLLER — press-and-hold state machine (RENDER plane, Law 4)
 * -----------------------------------------------------------------
 * The pure, DOM-free core of the night preview-peek interaction (NightPeek):
 * a pointer must be held for at least `holdMs` (default 150) before the peek
 * reveals true color, so a stray tap can never flash the eyes. Releasing (up /
 * leave / cancel) disarms a pending hold and instantly un-peeks.
 *
 * Extracted from the component so the timing is unit-testable in the node env
 * with fake timers (the repo's pure-logic-test idiom). Uses only setTimeout /
 * clearTimeout — no DOM, no React. Presentation only; touches nothing but a
 * boolean the component maps to veil opacity.
 */

export interface PeekController {
    /** Pointer down: arm the hold timer (idempotent while armed/peeking). */
    down(): void;
    /** Pointer up / leave / cancel: disarm a pending hold and un-peek. */
    up(): void;
    /** Current reveal state. */
    isPeeking(): boolean;
    /** Clear any pending timer (call on unmount). */
    dispose(): void;
}

export interface PeekControllerOptions {
    /** Hold duration before the peek reveals, in ms. Default 150. */
    holdMs?: number;
    /** Fired only on an actual state transition (never redundant). */
    onChange: (peeking: boolean) => void;
}

/** Default press-and-hold threshold (ms) before a peek reveals. */
export const DEFAULT_PEEK_HOLD_MS = 150;

export function createPeekController(opts: PeekControllerOptions): PeekController {
    const holdMs = opts.holdMs != null && Number.isFinite(opts.holdMs) && opts.holdMs >= 0
        ? opts.holdMs
        : DEFAULT_PEEK_HOLD_MS;

    let peeking = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const set = (v: boolean): void => {
        if (v === peeking) return;
        peeking = v;
        try { opts.onChange(v); } catch { /* a bad listener never wedges the machine */ }
    };

    const clearTimer = (): void => {
        if (timer != null) { clearTimeout(timer); timer = null; }
    };

    return {
        down(): void {
            if (peeking || timer != null) return; // already armed / revealed
            timer = setTimeout(() => { timer = null; set(true); }, holdMs);
        },
        up(): void {
            clearTimer();
            set(false);
        },
        isPeeking(): boolean {
            return peeking;
        },
        dispose(): void {
            clearTimer();
        },
    };
}
