/**
 * useReplayClock — RAF-driven scrub clock for the ★ Replay Dashboard time slider.
 *
 * Advances an absolute scrub time (epoch ms) at `speed`× wall-clock while
 * playing, clamped to [tStart, tEnd]; auto-pauses at the end. Speed supports
 * slow-mo (0.25×) AND sped-up (4×/16×) per the owner spec. The clock is the
 * ONLY place a real wall-clock (`performance.now`) enters replay — the state
 * derivation stays pure.
 */
import { useEffect, useRef, useState, useCallback } from 'react';

export const REPLAY_SPEEDS = [0.25, 1, 4, 16] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export interface ReplayClock {
    /** Current absolute scrub time (epoch ms). */
    t: number;
    playing: boolean;
    speed: ReplaySpeed;
    setT: (t: number) => void;
    setSpeed: (s: ReplaySpeed) => void;
    play: () => void;
    pause: () => void;
    toggle: () => void;
    /** Jump to start and pause. */
    restart: () => void;
}

export function useReplayClock(bounds: { tStart: number; tEnd: number }): ReplayClock {
    const [t, setTState] = useState(bounds.tStart);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState<ReplaySpeed>(1);

    // Keep the latest bounds/speed in refs so the RAF loop reads fresh values
    // without re-subscribing every frame.
    const boundsRef = useRef(bounds);
    boundsRef.current = bounds;
    const speedRef = useRef<ReplaySpeed>(speed);
    speedRef.current = speed;

    const setT = useCallback((next: number) => {
        const { tStart, tEnd } = boundsRef.current;
        setTState(Math.min(tEnd, Math.max(tStart, next)));
    }, []);

    // Reset to start whenever the run window changes (new run selected).
    useEffect(() => {
        setTState(bounds.tStart);
        setPlaying(false);
    }, [bounds.tStart, bounds.tEnd]);

    useEffect(() => {
        if (!playing) return;
        let raf = 0;
        let last = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const tick = (now: number) => {
            const dt = now - last;
            last = now;
            setTState(prev => {
                const { tStart, tEnd } = boundsRef.current;
                if (tEnd <= tStart) { setPlaying(false); return tStart; }
                const next = prev + dt * speedRef.current;
                if (next >= tEnd) { setPlaying(false); return tEnd; }
                return next;
            });
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [playing]);

    const play = useCallback(() => {
        const { tStart, tEnd } = boundsRef.current;
        // Replaying from the end restarts from the top.
        setTState(prev => (prev >= tEnd ? tStart : prev));
        setPlaying(true);
    }, []);
    const pause = useCallback(() => setPlaying(false), []);
    const toggle = useCallback(() => setPlaying(p => !p), []);
    const restart = useCallback(() => { setTState(boundsRef.current.tStart); setPlaying(false); }, []);

    return { t, playing, speed, setT, setSpeed, play, pause, toggle, restart };
}
