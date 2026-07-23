import React from 'react';

/**
 * KV — mono key/value cell for solution grids.
 *
 * Hoisted verbatim from the inline `KV` in inspector/FindingsFeed.tsx.
 * NOTE: exactly like the original, it INHERITS `font-mono` from its
 * container (FindingRow's content div is `font-mono text-[11px]`); it does
 * not force the family itself — keep it inside a mono context.
 *
 * LAW 3 sentinel mode (A.6/B.4: a sentinel never wears the measured-number
 * color): `v == null` renders the `--` sentinel in text-muted; `muted`
 * forces the muted voice for explicit sentinel strings ("NOT MEASURED").
 */
export const KV: React.FC<{
    k: string;
    v: string | null;
    /** Render the value in the muted (sentinel/NOT MEASURED) voice. */
    muted?: boolean;
    testid?: string;
}> = ({ k, v, muted, testid }) => (
    <div data-testid={testid} className="flex justify-between gap-2">
        <span className="text-text-muted">{k}</span>
        {v == null ? (
            <span className="text-text-muted">--</span>
        ) : (
            <span className={muted ? 'text-text-muted' : 'text-data tabular-nums'}>{v}</span>
        )}
    </div>
);

/**
 * READOUT — the standalone "data voice" primitive: a measured value in
 * mono + tabular figures (`text-data`), with its unit dimmed at 0.7em
 * (the CoefValue/unit convention, UI_STYLE_GUIDE.md B.3).
 *
 * LAW 3 (honest-or-absent): a null/undefined value renders the `--`
 * sentinel in text-muted, with NO unit — never a fabricated 0. Callers
 * format finite numbers themselves (they own precision restraint).
 */
export const Readout: React.FC<{
    value: string | number | null | undefined;
    unit?: string;
    className?: string;
    testid?: string;
}> = ({ value, unit, className, testid }) => (
    <span data-testid={testid} className={`font-mono text-data tabular-nums ${className ?? ''}`}>
        {value == null ? (
            <span className="text-text-muted">--</span>
        ) : (
            <>
                {value}
                {unit != null && <span className="text-text-muted text-[0.7em]"> {unit}</span>}
            </>
        )}
    </span>
);
