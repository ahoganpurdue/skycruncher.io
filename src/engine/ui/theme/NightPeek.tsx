import React, { useState, useRef, useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { subscribeThemeChange, getTheme } from './theme_state';
import { createPeekController, type PeekController } from './peek_controller';

/**
 * NIGHT PEEK (RENDER plane — presentation only, Law 4) — wraps a preview
 * surface (the rendered frame / dashboard preview image) so that in the NIGHT
 * (stargazing) theme it shows RED-CHANNEL-ONLY, dark-adaptation-safe, and a
 * press-and-hold reveals the true-color frame for as long as you hold.
 *
 * WHY red isolation is the safe state and peeking "costs night vision": rod
 * cells are nearly blind at 620nm+, so a pure-red preview preserves dark
 * adaptation; revealing the green/blue channels is exactly what resets it —
 * regardless of brightness. So the veil isolates red (safe) and the peek shows
 * full color (costly). The label states that cost honestly.
 *
 * MECHANISM (canvas-free, render plane only — the underlying buffers are NEVER
 * touched): a `mix-blend-mode: multiply` veil painted over the children with the
 * night red token zeroes the G/B channels of whatever is behind it (image,
 * canvas, WebGL — content-agnostic). `isolation: isolate` on the wrapper keeps
 * the multiply confined to this preview, never the page. Extra dimming is
 * already supplied by the app-wide ThemeDimOverlay, so one veil suffices.
 *
 * NON-NIGHT: a pure pass-through — it returns the children with NO wrapper, NO
 * overlay, NO handlers, NO subscription cost beyond one theme read. Dark/light
 * DOM and behavior are byte-for-byte what they were before wrapping (this is why
 * it is safe on the solve-carrying wizard/dashboard surfaces: inert off-night).
 *
 * Press-and-hold threshold + un-peek live in the DOM-free peek_controller.
 */
export interface NightPeekProps {
    children: React.ReactNode;
    /** Optional class on the night wrapper (ignored off-night). */
    className?: string;
    /** Optional style merged onto the night wrapper (ignored off-night). */
    style?: React.CSSProperties;
    /** Wrapper display in night; default 'inline-block' (sizes to an <img>). */
    display?: React.CSSProperties['display'];
}

export const NightPeek: React.FC<NightPeekProps> = ({ children, className, style, display = 'inline-block' }) => {
    const theme = useSyncExternalStore(subscribeThemeChange, getTheme, () => 'dark' as const);
    const [peeking, setPeeking] = useState(false);
    const [hovering, setHovering] = useState(false);
    const ctrlRef = useRef<PeekController | null>(null);
    if (ctrlRef.current === null) {
        ctrlRef.current = createPeekController({ onChange: setPeeking });
    }
    useEffect(() => () => ctrlRef.current?.dispose(), []);

    // Off-night: pure pass-through — zero wrapper, zero overhead, zero handlers.
    if (theme !== 'night') return <>{children}</>;

    const ctrl = ctrlRef.current;
    return (
        <div
            data-testid="night-peek"
            data-peeking={peeking ? '1' : '0'}
            className={className}
            style={{ position: 'relative', isolation: 'isolate', display, lineHeight: 0, ...style }}
            onPointerDown={() => ctrl.down()}
            onPointerUp={() => ctrl.up()}
            onPointerCancel={() => ctrl.up()}
            onPointerEnter={() => setHovering(true)}
            onPointerLeave={() => { ctrl.up(); setHovering(false); }}
        >
            {children}
            {/* Red-channel isolation veil — hidden while peeking (true color shown).
                pointer-events:none so the hold gesture lands on the wrapper. */}
            {!peeking && (
                <div
                    aria-hidden
                    data-testid="night-peek-veil"
                    style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'var(--sc-peek-red)',
                        mixBlendMode: 'multiply',
                        pointerEvents: 'none',
                        zIndex: 1,
                    }}
                />
            )}
            {/* Persistent honest-cost label — shown on hover or while peeking. */}
            <div
                data-testid="night-peek-label"
                aria-hidden={!(hovering || peeking)}
                style={{
                    position: 'absolute',
                    top: 8,
                    left: 8,
                    zIndex: 2,
                    pointerEvents: 'none',
                    opacity: hovering || peeking ? 1 : 0,
                    font: "700 9px var(--font-mono, monospace)",
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                    color: 'var(--sc-text-2)',
                    background: 'var(--sc-scrim)',
                    border: '1px solid var(--sc-line)',
                    borderRadius: 3,
                    padding: '2px 7px',
                }}
            >
                peek — costs night vision
            </div>
        </div>
    );
};
