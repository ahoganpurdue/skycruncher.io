import React from 'react';

/**
 * CARD / PANEL — token-bound surfaces with the signature 10px uppercase
 * tracked caption header (UI_STYLE_GUIDE.md A.5).
 *
 * Class strings hoisted verbatim from ForensicCalibrationStep.tsx:
 *  - Card  = metric card   `bg-space-800 border border-line p-4 rounded-lg`
 *  - Panel = chart panel   `bg-space-900/70 border border-line rounded-xl p-4`
 *  - caption h4            `text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2`
 * so a later refactor of that file onto the kit is a visual no-op.
 */

const CAPTION = 'text-text-muted text-[10px] font-bold uppercase tracking-widest mb-2';

interface SurfaceProps {
    /** Uppercase tracked caption header; omit for a headerless surface. */
    caption?: string;
    className?: string;
    testid?: string;
    children: React.ReactNode;
}

/** Metric card — the space-800 rounded-lg surface (coefficient cards). */
export const Card: React.FC<SurfaceProps> = ({ caption, className, testid, children }) => (
    <div data-testid={testid} className={`bg-space-800 border border-line p-4 rounded-lg ${className ?? ''}`}>
        {caption != null && <h4 className={CAPTION}>{caption}</h4>}
        {children}
    </div>
);

/** Chart panel — the translucent space-900/70 rounded-xl surface. */
export const Panel: React.FC<SurfaceProps> = ({ caption, className, testid, children }) => (
    <div data-testid={testid} className={`bg-space-900/70 border border-line rounded-xl p-4 ${className ?? ''}`}>
        {caption != null && <h4 className={CAPTION}>{caption}</h4>}
        {children}
    </div>
);
