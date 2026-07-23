import React from 'react';

/**
 * CHIP / BADGE — the "tinted well" status chip: a -dim token fill behind its
 * solid-color text (UI_STYLE_GUIDE.md A.2, A.5).
 *
 * Hoisted verbatim from the inline `Chip` in inspector/FindingsFeed.tsx
 * (shell classes + solve/accent/warn/neutral tones) so a later refactor of
 * that file onto the kit is a visual no-op. `danger` matches the RUN FAILED
 * badge in inspector/PipelineInspector.tsx (`bg-danger-dim text-danger`);
 * `info` binds the --color-info token (indigo, style guide B.2 Palette A —
 * neutral informational callouts, so cyan isn't overloaded).
 *
 * LAW 3 (honest-or-absent): tone is EARNED. `solve` requires a truthy
 * verified predicate; never pass it as an optimistic default.
 *
 * ONE deliberate deviation from the verbatim hoist: `font-sans`. Chip labels
 * are the sans label voice (A.3); without an explicit family a chip inside a
 * mono context (integrity table cells, mono KV stacks) inherits monospace
 * and drifts from every other chip in the app.
 */

export type ChipTone = 'solve' | 'warn' | 'danger' | 'accent' | 'info' | 'neutral';

/**
 * Hue-independent status glyph dimension (restyle 2026-07-21): ● solve · ▲ warn
 * · ✕ danger · ◌ absent. Ships in ALL themes so night (no hue) degrades nothing.
 * The glyph is rendered by a CSS ::before on [data-sc-glyph] (src/index.css) —
 * it is NEVER part of the DOM text, so the machine-read status string a chip
 * wraps stays byte-verbatim. Earned-status tones carry their glyph by default;
 * informational tones (accent/info/neutral) carry none unless the caller asks
 * (e.g. `glyph="absent"` for a NOT-MEASURED chip). `glyph="none"` suppresses.
 */
export type ChipGlyph = 'solve' | 'warn' | 'danger' | 'absent';

const TONES: Record<ChipTone, string> = {
    solve: 'bg-solve-dim text-solve',
    warn: 'bg-warn-dim text-warn',
    danger: 'bg-danger-dim text-danger',
    accent: 'bg-accent-glow text-accent-300',
    info: 'bg-info-dim text-info',
    neutral: 'bg-space-750 text-text-secondary',
};

const TONE_GLYPH: Partial<Record<ChipTone, ChipGlyph>> = {
    solve: 'solve',
    warn: 'warn',
    danger: 'danger',
};

export const Chip: React.FC<{
    tone: ChipTone;
    /** Override the tone-derived glyph; 'none' suppresses it (e.g. neutral tags). */
    glyph?: ChipGlyph | 'none';
    testid?: string;
    children: React.ReactNode;
}> = ({ tone, glyph, testid, children }) => {
    const g = glyph !== undefined ? glyph : TONE_GLYPH[tone];
    return (
        <span
            data-testid={testid}
            data-sc-glyph={g && g !== 'none' ? g : undefined}
            className={`font-sans px-1.5 py-px rounded text-[9px] font-semibold tracking-wide whitespace-nowrap ${TONES[tone]}`}
        >
            {children}
        </span>
    );
};

/** Alias — run-status call-sites read better as `Badge`. Same component. */
export const Badge = Chip;
