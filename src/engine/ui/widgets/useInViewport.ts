/**
 * useInViewport — reports whether an ALWAYS-RENDERED host element is at least
 * partially in the viewport, for gating the conditional render of something ELSE
 * (the viewport-fixed widget ribbon, SPEC §6b).
 *
 * WHY A DEDICATED HOOK (not useRafGate): the ribbon is rendered `null` while out
 * of view, so its visibility MUST be driven by an element that always exists — a
 * self-gating deadlock (observing an element inside the conditionally-rendered
 * subtree) can never set the flag back true.
 *
 * SYMMETRIC TRIGGER LIFECYCLE (the StrictMode fix): the callback ref does NOTHING
 * but record the host node into state (`setHostNode`). EVERY trigger — the
 * IntersectionObserver, the ResizeObserver, the capture-phase scroll + resize
 * listeners, and the deferred re-evaluations — is attached in ONE effect keyed on
 * `[hostNode]` and detached in that effect's cleanup. This is deliberate: React
 * dev StrictMode mounts, unmounts, then remounts. An observer attached in a
 * callback ref but disconnected in an effect cleanup is torn down on the strict
 * unmount and NEVER re-attached on the remount (the callback ref already fired),
 * while effect-attached window listeners re-attach normally — an asymmetry that
 * left the observers dead and the ribbon permanently hidden. Attaching everything
 * in the one effect makes setup and cleanup mirror images, so all triggers survive
 * the remount.
 *
 * TRIGGER COVERAGE (all funnel into one rect-based `evaluate()` — single source of
 * truth = measured viewport overlap, `rectInViewport`):
 *   • IntersectionObserver — the primary "entered/left the viewport" signal.
 *   • ResizeObserver on the host — the MOUNT-RACE trigger: IO fires one initial
 *     callback while the host is still laying out (degenerate rect → out of view),
 *     then its intersection STATUS never changes as the host merely GROWS 0→its
 *     real size, so IO never fires again on an idle page. The size change does.
 *   • capture-phase window `scroll` — catches scrolling in an INNER container
 *     (window.scrollY stays 0; scroll does not bubble, but capture sees it).
 *   • `resize` + one rAF + one macrotask — belt-and-suspenders for environments
 *     without RO and for layout that settles a beat after mount.
 *
 * SSR / headless-safe: no `window`/`IntersectionObserver`/`ResizeObserver` ⇒
 * degrades to visible (never hides the ribbon in an environment it cannot
 * measure); never throws.
 *
 * Ledger: RENDER PLANE — display gating only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { rectInViewport } from './docking/docking_store';

export interface InViewport<T extends Element> {
    /** Attach to the ALWAYS-rendered host element (callback ref). */
    setRef: (el: T | null) => void;
    /** The same host, for callers that also need to measure it. */
    ref: MutableRefObject<T | null>;
    /** True while the host is at least partially (within `nearPx`) in the viewport. */
    inView: boolean;
}

export function useInViewport<T extends Element = HTMLElement>(nearPx = 0): InViewport<T> {
    const ref = useRef<T | null>(null);
    const [hostNode, setHostNode] = useState<T | null>(null);
    // Degrade-to-visible: start visible; the trigger effect corrects it from the
    // real rect on mount, so we never leave the ribbon stuck hidden.
    const [inView, setInView] = useState(true);

    // Callback ref: record the host node for BOTH measurement (ref) and to key the
    // trigger effect (state). NO observers are attached here — see the effect.
    const setRef = useCallback((node: T | null) => {
        ref.current = node;
        setHostNode(node);
    }, []);

    useEffect(() => {
        const el = hostNode;
        if (!el) return;

        const evaluate = () => {
            if (typeof window === 'undefined' || typeof el.getBoundingClientRect !== 'function') {
                setInView(true);
                return;
            }
            const r = el.getBoundingClientRect();
            setInView(rectInViewport(r, window.innerWidth, window.innerHeight, nearPx));
        };

        let io: IntersectionObserver | undefined;
        let ro: ResizeObserver | undefined;
        if (typeof IntersectionObserver !== 'undefined') {
            io = new IntersectionObserver(() => evaluate(), { root: null, threshold: 0 });
            io.observe(el);
        }
        if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(() => evaluate());
            ro.observe(el);
        }
        const onChange = () => evaluate();
        if (typeof window !== 'undefined') {
            window.addEventListener('scroll', onChange, { capture: true, passive: true });
            window.addEventListener('resize', onChange);
        }

        evaluate();
        const raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(() => evaluate()) : 0;
        const to = typeof setTimeout !== 'undefined' ? setTimeout(() => evaluate(), 0) : undefined;

        return () => {
            io?.disconnect();
            ro?.disconnect();
            if (typeof window !== 'undefined') {
                window.removeEventListener('scroll', onChange, { capture: true } as EventListenerOptions);
                window.removeEventListener('resize', onChange);
            }
            if (raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
            if (to !== undefined) clearTimeout(to);
        };
    }, [hostNode, nearPx]);

    return { setRef, ref, inView };
}
