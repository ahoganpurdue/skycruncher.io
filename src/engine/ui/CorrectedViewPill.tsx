import React from 'react';
import type { CorrectedViewInfo } from './corrected_view';
import { CORRECTED_VIEW_NOT_AVAILABLE } from './corrected_view';

/**
 * CORRECTED VIEW pill — wizard header toggle (render-plane only, DEFAULT OFF).
 *
 * Mirrors the OKLAB pill styling/pattern. Honest-or-absent (LAW 3):
 *  - available + ON  → active pill + an APPROX badge (the correction is APPROXIMATE).
 *  - available + OFF → inactive pill.
 *  - NOT available   → a DISABLED, muted pill whose title/aria carries the honest
 *                      "NO FITTED DISTORTION — NOT AVAILABLE" — never a fake toggle.
 *
 * The button NEVER affects the solve, WCS, matched stars, or any measurement —
 * it only swaps which (already-computed) preview image the post-solve canvas
 * displays. OFF ⇒ the caller passes no corrected URL ⇒ byte-identical render.
 */
export interface CorrectedViewPillProps {
    info: CorrectedViewInfo;
    on: boolean;
    onToggle: () => void;
}

const AVAILABLE_TITLE =
    'Corrected view (render only): re-display the preview through the fitted SIP distortion so the ' +
    'measured distortion is visually removed. APPROXIMATE — render-layer, never affects the solve or any measurement.';

const UNAVAILABLE_TITLE =
    `${CORRECTED_VIEW_NOT_AVAILABLE}. Corrected view needs a fitted SIP distortion solution for this frame; ` +
    'it renders nothing rather than fake a correction.';

export const CorrectedViewPill: React.FC<CorrectedViewPillProps> = ({ info, on, onToggle }) => {
    const base =
        'flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-semibold uppercase tracking-widest transition-colors';

    if (!info.available) {
        // Honest disabled state — non-interactive, muted; the honest text rides
        // the title + aria-label so it is discoverable (and test-visible).
        return (
            <button
                data-testid="wizard-corrected-view"
                data-available="false"
                type="button"
                disabled
                aria-disabled={true}
                aria-label={CORRECTED_VIEW_NOT_AVAILABLE}
                title={UNAVAILABLE_TITLE}
                className={`${base} border-line bg-space-900/40 text-text-muted/60 opacity-50 cursor-not-allowed`}
            >
                Corrected
            </button>
        );
    }

    return (
        <button
            data-testid="wizard-corrected-view"
            data-available="true"
            role="switch"
            type="button"
            aria-checked={on}
            onClick={onToggle}
            title={AVAILABLE_TITLE}
            className={`${base} ${
                on
                    ? 'border-accent-500/60 bg-accent-glow text-accent-300'
                    : 'border-line bg-space-800/60 text-text-muted hover:text-text-secondary hover:border-line-strong'
            }`}
        >
            Corrected
            {on && (
                <span
                    data-testid="wizard-corrected-view-badge"
                    className="font-mono text-[9px] tracking-normal normal-case text-warn"
                >
                    APPROX
                </span>
            )}
        </button>
    );
};
