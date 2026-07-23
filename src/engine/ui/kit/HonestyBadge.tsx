import React from 'react';

/**
 * HONESTY BADGE — the provenance state machine as one component
 * (UI_STYLE_GUIDE.md A.6 "the app's signature pattern", B.4).
 *
 * States and shell classes hoisted verbatim from the time/GPS source badges
 * in PipelineWizard.tsx (`text-[10px] px-1.5 rounded` + solve/warn tinted
 * wells) so a later refactor of those badges onto the kit is a visual no-op.
 *
 *   FITS        → solve  "FITS HEADER"      (trusted: read from the file)
 *   EXIF        → solve  "EXIF"             (trusted: read from the file)
 *   USER        → warn   "USER"             (honest: human-entered, unverified)
 *   DEFAULT     → warn   "DEFAULT — VERIFY" (fallback wearing its warning)
 *   APPROXIMATE → warn   "APPROX"           (borrowed/family-chart value, B.4)
 *
 * LOAD-BEARING STRINGS: "FITS HEADER" / "EXIF" / "USER" / "DEFAULT — VERIFY"
 * are the exact strings the polled e2e UI contract asserts on
 * (data-testid="time-source-badge" / "gps-source-badge-*"). Never reword.
 *
 * LAW 3: only file-derived provenance (EXIF/FITS) earns solve green.
 */

export type HonestySource = 'FITS' | 'EXIF' | 'USER' | 'DEFAULT' | 'APPROXIMATE';

const STATES: Record<HonestySource, { label: string; cls: string }> = {
    FITS: { label: 'FITS HEADER', cls: 'bg-solve-dim text-solve' },
    EXIF: { label: 'EXIF', cls: 'bg-solve-dim text-solve' },
    USER: { label: 'USER', cls: 'bg-warn-dim text-warn' },
    DEFAULT: { label: 'DEFAULT — VERIFY', cls: 'bg-warn-dim text-warn' },
    APPROXIMATE: { label: 'APPROX', cls: 'bg-warn-dim text-warn' },
};

export const HonestyBadge: React.FC<{ source: HonestySource; testid?: string }> = ({ source, testid }) => {
    const s = STATES[source];
    return (
        <span data-testid={testid} className={`text-[10px] px-1.5 rounded ${s.cls}`}>
            {s.label}
        </span>
    );
};
