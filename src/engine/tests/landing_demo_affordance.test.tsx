import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MainUpload } from '../ui/MainUpload';

/**
 * LANDING DEMO AFFORDANCE (P5) — the booth "Watch a live solve" one-click. It
 * reuses the existing demo fetch path (bundled SeeStar M66 FITS → the REAL
 * wizard pipeline), so this asserts only that the affordance is OBVIOUS and its
 * copy is honest (LAW 3): a real solve, not canned data, no fabricated numbers.
 */
describe('Landing "Watch a live solve" affordance', () => {
    it('surfaces an obvious, honest one-click demo-solve control', () => {
        const markup = renderToStaticMarkup(<MainUpload onFileSelect={() => {}} />);
        expect(markup).toContain('data-testid="watch-live-solve"');
        expect(markup).toContain('Watch a Live Solve');
        // Honest framing (LAW 3): a REAL pipeline run, explicitly not canned data.
        expect(markup).toContain('real pipeline');
        expect(markup).toContain('zero canned data');
    });

    // The landing upload surface used to carry a manual-location city input gated
    // on `useManualLocation`, which was NEVER set true (unreachable dead code) and
    // whose geocoded output was consumed nowhere downstream. Removed: honest-or-
    // absent (LAW 3) — no fake/placeholder location affordance on the landing;
    // real observer-location entry lives in the wizard (step-2).
    it('renders no dead placeholder-city / manual-location affordance', () => {
        const markup = renderToStaticMarkup(<MainUpload onFileSelect={() => {}} />);
        expect(markup).not.toContain('Enter City, State');
        expect(markup).not.toContain('manual-location-input');
    });
});
