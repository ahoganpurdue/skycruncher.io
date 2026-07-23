import React, { useSyncExternalStore } from 'react';
import { subscribeThemeChange, dimOpacity } from './theme_state';

/**
 * THEME DIM OVERLAY (RENDER plane) — a single full-viewport black scrim whose
 * opacity is the current theme's per-theme brightness (1 - brightness/100).
 *
 * Mounted ONCE at the app root. `pointer-events: none` so it never intercepts
 * a click; a very high z-index so it dims EVERYTHING uniformly (header, modals,
 * widgets). Day themes default to full brightness → opacity 0 → nothing paints.
 * Night defaults to 45 → opacity 0.55, so a pop-out/telescope screen can never
 * become the bright rectangle in the dark.
 *
 * The opacity fade uses --ease-instrument, but night's motion-kill
 * (`[data-theme="night"] *`) neutralizes it there — dimming is instant in
 * night, no gradual bright→dark flash either direction. Presentation only.
 */
export const ThemeDimOverlay: React.FC = () => {
    const opacity = useSyncExternalStore(
        subscribeThemeChange,
        () => dimOpacity(),   // client snapshot (reads current theme + brightness)
        () => 0,              // server/headless snapshot: no dim
    );
    return (
        <div
            aria-hidden
            data-testid="theme-dim-overlay"
            style={{
                position: 'fixed',
                inset: 0,
                background: '#000',
                pointerEvents: 'none',
                zIndex: 2147483000,
                opacity,
                transition: 'opacity 200ms var(--ease-instrument, ease)',
            }}
        />
    );
};
