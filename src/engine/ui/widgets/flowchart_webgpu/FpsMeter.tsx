/**
 * FPS METER — a thin, honest render-cadence overlay (shared A/B instrument).
 *
 * Measures the rAF frame cadence of whatever pane it sits in — display FPS +
 * smoothed frame-interval (ms). It does NOT reach into a renderer; it times the
 * browser's own animation callback, which for a continuously-repainting pane is
 * the honest "how smooth is this" number the owner's A/B needs. The WebGPU twin
 * additionally reports its measured GPU encode-ms (which this generic meter can't
 * see) via its own readout — labelled distinctly so nothing is conflated.
 *
 * SSR / jsdom safe: renders a static placeholder on first paint and only starts
 * the rAF loop in an effect (no requestAnimationFrame at module/first-render).
 * Honest-or-absent: shows "-- fps" until it has two frames to divide.
 *
 * IDLE DISCIPLINE (owner walkthrough 2026-07-21 — main-thread starvation): the
 * meter no longer spins a 60/sec setState storm. (1) It idles entirely when its
 * badge is off-screen or the tab is hidden (`useRafGate`), so a meter in a
 * background dockview tab costs nothing. (2) Even while visible it SAMPLES cadence
 * every frame but only REPAINTS the badge ~4×/sec — the display number an owner
 * reads doesn't need 60 React re-renders a second.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useRafGate } from '../useRafGate';

/** Minimum ms between badge repaints — samples stay per-frame, re-renders throttle. */
const REPAINT_INTERVAL_MS = 250;

export const FpsMeter: React.FC<{ label?: string; className?: string }> = ({ label = 'rAF', className }) => {
    const [text, setText] = useState('-- fps');
    const { ref, active } = useRafGate<HTMLSpanElement>();
    const last = useRef(0);
    const ema = useRef(0);
    const lastPaint = useRef(0);

    useEffect(() => {
        if (!active || typeof requestAnimationFrame === 'undefined') return;
        let raf = 0;
        let alive = true;
        last.current = 0;        // reset the cadence baseline whenever we (re)start
        const tick = () => {
            if (!alive) return;
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (last.current) {
                const dt = now - last.current;
                const fps = dt > 0 ? 1000 / dt : 0;
                ema.current = ema.current ? ema.current * 0.9 + fps * 0.1 : fps;
                if (now - lastPaint.current >= REPAINT_INTERVAL_MS) {
                    lastPaint.current = now;
                    const ms = ema.current > 0 ? 1000 / ema.current : 0;
                    setText(`${ema.current.toFixed(0)} fps · ${ms.toFixed(1)} ms`);
                }
            }
            last.current = now;
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => { alive = false; if (raf) cancelAnimationFrame(raf); };
    }, [active]);

    return (
        <span
            ref={ref}
            className={className ?? 'font-mono text-[9px] text-text-muted tabular-nums'}
            data-testid="fps-meter"
            title="Display cadence measured from requestAnimationFrame (not GPU encode time)"
        >
            {label}: {text}
        </span>
    );
};

export default FpsMeter;
