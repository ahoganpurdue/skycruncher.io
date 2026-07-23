import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmTierBadge, type DeepConfirmed } from '../ui/dashboard/ConfirmTierBadge';
import { selectSolveSummary, solveSummaryWidget } from '../ui/widgets/widgets/SolveSummaryWidget';

/**
 * SAFETY-CATCHER UI — ConfirmTierBadge + SolveSummaryWidget tier surfacing.
 *
 * Server-render assertions (node env, no jsdom; same harness as ui_deep_confirm).
 * Pins: (a) each tier renders its exact NEW display phrase + earned tone class +
 * data-confirm-status; (b) honest absence (no deep_confirmed → nothing unless a
 * solve exists); (c) the summary widget reads the receipt's derived verdict and
 * shows the tier so confidence never stands alone.
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const CONFIRMED: DeepConfirmed = {
    provenance: 'CATALOG_FORCED_CONFIRMED',
    examined: 205, confirmed: 198, setExcessZ: 77.9, setGatePassed: true,
    approximate: false, grid: 'NATIVE_FLOAT_LUMINANCE',
    framePsf: { fwhmPx: 3.9, ellipticity: 0.12, source: 'psf_field' },
    confirmed_stars: [],
};
const REFUSED: DeepConfirmed = { ...CONFIRMED, examined: 40, confirmed: 0, setExcessZ: 4.2, setGatePassed: false };
const INSUFFICIENT: DeepConfirmed = {
    ...CONFIRMED, examined: 8, confirmed: 0, setExcessZ: null, setGatePassed: false,
    not_measured: 'Too few candidates (8 < 10) for a set-level confirmation statistic — NOT MEASURED.',
};

describe('ConfirmTierBadge — tier phrases + earned tone', () => {
    it('CONFIRMED → solve-green tier phrase', () => {
        const out = html(<ConfirmTierBadge deep={CONFIRMED} />);
        expect(out).toContain('data-confirm-status="CONFIRMED"');
        expect(out).toContain('SOLVED — CONFIRMED');
        expect(out).toContain('text-solve');
    });

    it('REFUSED → danger tier phrase', () => {
        const out = html(<ConfirmTierBadge deep={REFUSED} />);
        expect(out).toContain('data-confirm-status="REFUSED"');
        expect(out).toContain('SOLVED — UNCONFIRMED (verification refused)');
        expect(out).toContain('text-danger');
        expect(out).not.toContain('text-solve'); // solve-green is never given away
    });

    it('INSUFFICIENT_TARGETS → warn tier phrase', () => {
        const out = html(<ConfirmTierBadge deep={INSUFFICIENT} />);
        expect(out).toContain('data-confirm-status="INSUFFICIENT_TARGETS"');
        expect(out).toContain('too few reference stars');
        expect(out).toContain('text-warn');
    });
});

describe('ConfirmTierBadge — honest absence', () => {
    it('renders NOTHING when deep is null and hideWhenNull defaults true', () => {
        expect(html(<ConfirmTierBadge deep={null} />)).toBe('');
        expect(html(<ConfirmTierBadge deep={undefined} />)).toBe('');
    });

    it('surfaces explicit NOT_RUN when a solve exists but no confirmation ran', () => {
        const out = html(<ConfirmTierBadge deep={null} hideWhenNull={false} />);
        expect(out).toContain('data-confirm-status="NOT_RUN"');
        expect(out).toContain('SOLVED — UNCONFIRMED (verification unavailable)');
    });
});

describe('ConfirmTierBadge — live in-flight state (event-driven)', () => {
    it('null deep + inFlight → "Confirming…" (not a premature verdict), even when hidden by default', () => {
        const out = html(<ConfirmTierBadge deep={null} inFlight />);
        expect(out).toContain('data-confirm-status="CONFIRMING"');
        expect(out).toContain('Confirming');
        expect(out).not.toContain('verification unavailable');
    });

    it('null deep, not in-flight, hideWhenNull default → still honestly hidden', () => {
        expect(html(<ConfirmTierBadge deep={null} inFlight={false} />)).toBe('');
    });

    it('a landed verdict wins over inFlight (result beats the spinner)', () => {
        const out = html(<ConfirmTierBadge deep={CONFIRMED} inFlight />);
        expect(out).toContain('data-confirm-status="CONFIRMED"');
        expect(out).toContain('SOLVED — CONFIRMED');
        expect(out).not.toContain('Confirming');
    });
});

describe('SolveSummaryWidget — reads the receipt verdict, shows the tier', () => {
    const receipt = (confirmStatus: string | null, hasSolution = true): any => ({
        solution: hasSolution
            ? { ra_hours: 11.34, pixel_scale: 3.68, stars_matched: 272, confidence: 0.831 }
            : null,
        confirm_status: confirmStatus == null ? null : { status: confirmStatus },
    });

    it('selector reads confirm_status.status straight from the receipt (no re-derivation)', () => {
        expect(selectSolveSummary(receipt('CONFIRMED'))?.confirmStatus).toBe('CONFIRMED');
        expect(selectSolveSummary(receipt('REFUSED'))?.confirmStatus).toBe('REFUSED');
        expect(selectSolveSummary(receipt(null))?.confirmStatus).toBeNull();
    });

    it('render shows the tier phrase next to the headline numbers', () => {
        const data = selectSolveSummary(receipt('CONFIRMED'))!;
        const out = html(React.createElement(solveSummaryWidget.render as any, { data }));
        expect(out).toContain('data-testid="widget-solve-summary-confirm"');
        expect(out).toContain('SOLVED — CONFIRMED');
        expect(out).toContain('data-confirm-status="CONFIRMED"');
    });

    it('no confirm line when the receipt carries no verdict (honest absence)', () => {
        const data = selectSolveSummary(receipt(null))!;
        const out = html(React.createElement(solveSummaryWidget.render as any, { data }));
        expect(out).not.toContain('widget-solve-summary-confirm');
        // the headline grid still renders
        expect(out).toContain('data-testid="widget-solve-summary"');
    });
});
