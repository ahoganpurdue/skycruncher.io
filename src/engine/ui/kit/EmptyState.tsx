import React from 'react';

/**
 * EMPTY STATE — the italic "absence voice" (UI_STYLE_GUIDE.md A.6/B.1:
 * italics only for absence/placeholder/hint states).
 *
 * Hoisted verbatim from the "No findings yet — run a stage." empty state in
 * inspector/FindingsFeed.tsx (`text-xs text-text-muted italic`).
 *
 * LAW 3: absence is stated honestly, ideally with the reason or the action
 * that would produce data ("No findings yet — run a stage."). Never render
 * an empty state that pretends to be a zero measurement.
 */
export const EmptyState: React.FC<{ testid?: string; children: React.ReactNode }> = ({ testid, children }) => (
    <div data-testid={testid} className="text-xs text-text-muted italic">
        {children}
    </div>
);
