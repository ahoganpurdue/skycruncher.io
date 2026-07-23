import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnsupportedHandoffCard } from '../ui/dashboard/solve_queue/SolveQueuePane';
import { createQueueItem } from '../ui/dashboard/solve_queue/queue_state';
import { supportedFormatsLabel } from '../pipeline/m1_ingestion/format_registry';
import type { IntakeConfig } from '../ui/config/intake_config';

/**
 * UNSUPPORTED-HANDOFF CARD (P4 Proposal 1) — presentation of existing truth: a
 * refused format (e.g. PNG/BMP — JPEG/TIFF now ingest at demo tier) becomes an
 * actionable funnel, not a dead end. The card reads `supportedFormatsLabel()`
 * (never a hard-coded format list, LAW 6) and the intake CONFIG; the item stays
 * `unsupported` (no reclassification, LAW 3).
 */
describe('UnsupportedHandoffCard', () => {
    const png = createQueueItem('u1', 'sunset.png', 100, 'drop');
    const bmp = createQueueItem('u2', 'scan.bmp', 100, 'drop');

    it('renders nothing when there are no unsupported files (absent, not a decorative zero)', () => {
        const markup = renderToStaticMarkup(<UnsupportedHandoffCard items={[]} />);
        expect(markup).toBe('');
    });

    it('lists the unsupported files under a "Not ingested today (N)" section with the real supported label', () => {
        const markup = renderToStaticMarkup(<UnsupportedHandoffCard items={[png, bmp]} />);
        expect(markup).toContain('sq-unsupported-handoff');
        expect(markup).toContain('Not ingested today (2)');
        expect(markup).toContain('sunset.png');
        expect(markup).toContain('scan.bmp');
        // Supported formats derive from the registry, never a hard-coded list.
        expect(markup).toContain(supportedFormatsLabel());
        // Confirm the classification these rows carry is genuinely unsupported.
        expect(png.status).toBe('unsupported');
    });

    it('renders the handoff text WITHOUT a link when the intake URL is unset (LAW 3 — honest-or-absent)', () => {
        const noUrl: IntakeConfig = { uploadUrl: null, uploadLabel: 'shared community folder' };
        const markup = renderToStaticMarkup(<UnsupportedHandoffCard items={[png]} config={noUrl} />);
        expect(markup).toContain('shared community folder');
        expect(markup).not.toContain('<a '); // no dead/placeholder link
    });

    it('renders a real link only when the intake URL is configured', () => {
        const withUrl: IntakeConfig = { uploadUrl: 'https://example.org/drop', uploadLabel: 'community Drive folder' };
        const markup = renderToStaticMarkup(<UnsupportedHandoffCard items={[png]} config={withUrl} />);
        expect(markup).toContain('href="https://example.org/drop"');
        expect(markup).toContain('community Drive folder');
    });
});
