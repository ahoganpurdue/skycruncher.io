/**
 * useRafGate — the house-standard idle gate for requestAnimationFrame-driven
 * widgets (owner walkthrough 2026-07-21: "the app froze for a bit while
 * navigating"). A widget's animation loop should run ONLY when it can actually be
 * seen. This hook reports that condition:
 *
 *   active === (caller-enabled) AND (document is visible) AND (element on-screen)
 *
 * • document.hidden / visibilitychange → a backgrounded tab idles every loop.
 * • IntersectionObserver → a widget scrolled out of view, or sitting in a hidden
 *   dockview tab (display:none ⇒ zero intersection), idles too.
 *
 * Consumers gate their rAF scheduling on `active` and attach `ref` to the element
 * whose visibility governs the loop (usually the widget's canvas/root). When
 * `active` flips false the consumer cancels its rAF; when it flips true the effect
 * re-runs and the loop restarts — so nothing paints while nobody is watching.
 *
 * SSR / jsdom-safe: with no `document` or no `IntersectionObserver` it degrades to
 * "assume visible" (active follows `enabled` only) — never gates work off in an
 * environment that cannot observe visibility, and never throws.
 *
 * Ledger: RENDER PLANE — display cadence only, no pipeline reach.
 */

import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

/**
 * PURE decision (extracted so the gate is unit-testable without a DOM): an
 * rAF loop should run iff the caller enabled it AND the tab is visible AND the
 * element is on-screen.
 */
export function rafGateActive(docVisible: boolean, onScreen: boolean, enabled: boolean): boolean {
    return enabled && docVisible && onScreen;
}

/** True when a real `document` reports itself visible (or when there is none). */
function readDocVisible(): boolean {
    if (typeof document === 'undefined') return true;
    // `visibilityState` is the spec surface; treat only an explicit 'hidden' as off.
    return document.visibilityState !== 'hidden';
}

export interface RafGate<T extends Element> {
    /** Attach to the element whose on-screen state governs the loop. */
    ref: MutableRefObject<T | null>;
    /** Run the rAF loop iff this is true. */
    active: boolean;
}

/**
 * @param enabled caller's own run condition (e.g. a feature is on). Default true.
 */
export function useRafGate<T extends Element = HTMLElement>(enabled = true): RafGate<T> {
    const ref = useRef<T | null>(null);
    const [onScreen, setOnScreen] = useState(true);        // assume visible until IO says otherwise
    const [docVisible, setDocVisible] = useState<boolean>(readDocVisible);

    // Tab visibility (document.hidden).
    useEffect(() => {
        if (typeof document === 'undefined') return;
        const onVis = () => setDocVisible(readDocVisible());
        document.addEventListener('visibilitychange', onVis);
        onVis();
        return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    // Element on-screen (IntersectionObserver). Absent API ⇒ assume on-screen.
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof IntersectionObserver === 'undefined') { setOnScreen(true); return; }
        const io = new IntersectionObserver(
            (entries) => { for (const e of entries) setOnScreen(e.isIntersecting); },
            { root: null, threshold: 0 },
        );
        io.observe(el);
        return () => io.disconnect();
    }, []);

    return { ref, active: rafGateActive(docVisible, onScreen, enabled) };
}
