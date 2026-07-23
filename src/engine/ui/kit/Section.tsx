import React from 'react';

/**
 * SECTION — tracked uppercase eyebrow + hairline divider, the standard
 * grouping element of the inspector drawer.
 *
 * Hoisted verbatim from the inline `Section` in
 * inspector/PipelineInspector.tsx so a later refactor onto the kit is a
 * visual no-op.
 */
export const Section: React.FC<{
    title: string;
    testid?: string;
    children: React.ReactNode;
}> = ({ title, testid, children }) => (
    <section data-testid={testid}>
        <h3 className="text-[10px] uppercase tracking-[0.2em] text-text-muted font-semibold border-b border-line-subtle pb-1.5 mb-2">
            {title}
        </h3>
        {children}
    </section>
);
