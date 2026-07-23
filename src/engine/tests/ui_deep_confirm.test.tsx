import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeepConfirmCard, DeepConfirmed } from '../ui/dashboard/DeepConfirmCard';
import { StarIntegrityList } from '../ui/dashboard/StarIntegrityList';
import { MatchedStar, PlateSolution } from '../types/Main_types';
import { PIPELINE_CONSTANTS } from '../pipeline/constants/pipeline_config';

/**
 * W2.1 DeepConfirmCard + W2.3 StarIntegrityList forced-classing —
 * server-render assertions (node env, no jsdom; same harness as ui_kit).
 *
 * LAW 3 checks are the point of this suite: honest absence (no frame at
 * all), earned gate color (solve only on setGatePassed === true), `--`
 * sentinels for null setExcessZ / null per-star SNR, and forced rows that
 * can never be silently mixed with matched anchors.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

// ── Fixtures — the live sacred-run receipt values ─────────────────────────

const LIVE_DEEP: DeepConfirmed = {
    provenance: 'CATALOG_FORCED_CONFIRMED',
    examined: 205,
    confirmed: 198,
    setExcessZ: 77.9,
    setGatePassed: true,
    approximate: false,
    grid: 'NATIVE_FLOAT_LUMINANCE',
    framePsf: { fwhmPx: 3.9, ellipticity: 0.12, source: 'psf_field' },
    confirmed_stars: [],
};

const GATE_FAILED_DEEP: DeepConfirmed = {
    ...LIVE_DEEP,
    confirmed: 0,           // set gate failed → confirmed collapses to zero
    setExcessZ: 4.2,
    setGatePassed: false,
};

// ── DeepConfirmCard ───────────────────────────────────────────────────────

describe('dashboard/DeepConfirmCard — present state (sacred-run values)', () => {
    const out = html(<DeepConfirmCard deep={LIVE_DEEP} />);

    it('renders the card with the big confirmed/examined stat', () => {
        expect(out).toContain('data-testid="deep-confirm-card"');
        expect(out).toContain('data-testid="deep-confirm-stat"');
        expect(out).toContain('198');
        expect(out).toContain('/ 205 confirmed');
    });

    it('big stat is data-voice: mono + tabular figures at the stat-tile display size', () => {
        expect(out).toContain('font-mono text-data tabular-nums text-2xl');
    });

    it('progress bar width reflects confirmed/examined (96.6%)', () => {
        expect(out).toContain('data-testid="deep-confirm-bar"');
        expect(out).toContain('width:96.6%');
    });

    it('set excess renders signed sigma from the receipt', () => {
        expect(out).toContain('+77.9σ');
    });

    it('gate chip is EARNED solve-green PASSED on setGatePassed === true', () => {
        expect(out).toMatch(/data-testid="deep-confirm-gate"[^>]*>PASSED</);
        expect(out).toContain('bg-solve-dim text-solve');
    });

    it('gate label carries the calibrated threshold from PIPELINE_CONSTANTS', () => {
        expect(out).toContain(`Set gate (≥${PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z}σ)`);
    });

    it('grid + provenance render pipeline-authored strings', () => {
        expect(out).toContain('NATIVE_FLOAT_LUMINANCE');
        expect(out).toMatch(/data-testid="deep-confirm-provenance"[^>]*>CATALOG_FORCED_CONFIRMED</);
    });

    it('MANDATORY caveat chip (Appendix L.3) is present, warn tone', () => {
        expect(out).toContain('N=1 CALIBRATED — SEESTAR ONLY');
        expect(out).toMatch(/bg-warn-dim text-warn[^>]*>N=1 CALIBRATED — SEESTAR ONLY</);
    });

    it('no APPROXIMATE chip when approximate is false (earned only)', () => {
        expect(out).not.toContain('deep-confirm-approx');
    });
});

describe('dashboard/DeepConfirmCard — absent state (LAW 3 honest absence)', () => {
    it('renders NOTHING when deep_confirmed is undefined', () => {
        expect(html(<DeepConfirmCard deep={undefined} />)).toBe('');
    });

    it('renders NOTHING when deep_confirmed is null', () => {
        expect(html(<DeepConfirmCard deep={null} />)).toBe('');
    });
});

describe('dashboard/DeepConfirmCard — gate-failed state', () => {
    const out = html(<DeepConfirmCard deep={GATE_FAILED_DEEP} />);

    it('gate chip is danger FAILED — solve-green is never given away', () => {
        expect(out).toMatch(/data-testid="deep-confirm-gate"[^>]*>FAILED</);
        expect(out).toContain('bg-danger-dim text-danger');
        expect(out).not.toContain('>PASSED<');
        expect(out).not.toContain('bg-solve-dim text-solve');
    });

    it('collapsed confirmed count renders as the real 0, not hidden', () => {
        expect(out).toContain('data-testid="deep-confirm-stat"');
        expect(out).toContain('/ 205 confirmed');
    });

    it('caveat chip still mandatory in the failed state', () => {
        expect(out).toContain('N=1 CALIBRATED — SEESTAR ONLY');
    });
});

describe('dashboard/DeepConfirmCard — honesty edges', () => {
    it('null setExcessZ renders the -- sentinel, never a fake 0σ', () => {
        const out = html(<DeepConfirmCard deep={{ ...GATE_FAILED_DEEP, setExcessZ: null }} />);
        expect(out).toMatch(/data-testid="deep-confirm-excess"[^>]*>--</);
        expect(out).not.toContain('0.0σ');
        // Sentinel wears the muted voice, not the measured-number color (A.6).
        expect(out).toMatch(/text-text-muted"[^>]*data-testid="deep-confirm-excess"/);
    });

    it('APPROXIMATE chip is earned by the approximate flag (8-bit grid)', () => {
        const out = html(<DeepConfirmCard deep={{
            ...LIVE_DEEP, approximate: true, grid: 'RGBA_LUMINANCE_8BIT',
        }} />);
        expect(out).toMatch(/data-testid="deep-confirm-approx"[^>]*>APPROXIMATE</);
        expect(out).toContain('RGBA_LUMINANCE_8BIT');
    });

    it('not_measured renders the reason + NOT MEASURED chip, no fabricated stats', () => {
        const out = html(<DeepConfirmCard deep={{
            ...LIVE_DEEP,
            examined: 0, confirmed: 0, setExcessZ: null, setGatePassed: false,
            not_measured: 'no science buffer survived to the confirmation pass',
        }} />);
        expect(out).toContain('data-testid="deep-confirm-not-measured"');
        expect(out).toContain('NOT MEASURED');
        expect(out).toContain('no science buffer survived to the confirmation pass');
        // no stat, no bar, no gate chip — absence is absence
        expect(out).not.toContain('deep-confirm-stat');
        expect(out).not.toContain('deep-confirm-bar');
        expect(out).not.toContain('deep-confirm-gate');
        // caveat chip still mandatory
        expect(out).toContain('N=1 CALIBRATED — SEESTAR ONLY');
    });
});

// ── StarIntegrityList forced-classing (W2.3) ──────────────────────────────

const matchedStar = (over: Partial<{ snr: number | undefined; name: string; gaia: string }> = {}): MatchedStar => ({
    detected: {
        x: 100, y: 200, rawX: 100, rawY: 200, flux: 5000, fwhm: 3.2,
        magnitude: 9.1,
        ...(over.snr !== undefined ? { snr: over.snr } : {}),
    },
    catalog: { ra: 170.06, dec: 12.99, mag: 9.3, name: over.name, gaia_id: over.gaia ?? 'Gaia_3915824286237534000' },
    residual: { dx: 0.4, dy: -0.2 },
    residual_arcsec: 0.87,
});

const FORCED: NonNullable<PlateSolution['deep_forced']> = {
    provenance: 'CATALOG_FORCED',
    probed: 500, accepted: 169, structured: 3,
    rApPx: 4, fwhmPx: 3.9, snrThreshold: 2,
    grid: 'NATIVE_FLOAT_LUMINANCE',
    stars: [
        { x: 10, y: 20, mag: 11.13, gaia_id: 'Gaia_55296', snr: 1076.0, flux: 90000 },
        { x: 30, y: 40, mag: null, gaia_id: null, snr: 2.4, flux: 120 },
    ],
};

describe('dashboard/StarIntegrityList — forced-photometry classing', () => {
    const out = html(<StarIntegrityList matches={[matchedStar()]} forced={FORCED} />);

    it('header provenance count chips carry the full class counts', () => {
        expect(out).toMatch(/data-testid="integrity-count-matched"[^>]*>1 MATCHED</);
        expect(out).toMatch(/data-testid="integrity-count-forced"[^>]*>2 CATALOG-FORCED</);
    });

    it('count chips map earned tones: matched=solve, forced=accent', () => {
        expect(out).toMatch(/bg-solve-dim text-solve[^>]*>1 MATCHED</);
        expect(out).toMatch(/bg-accent-glow text-accent-300[^>]*>2 CATALOG-FORCED</);
    });

    it('every row carries a class chip — provenance never silently mixed', () => {
        expect(out).toContain('>MATCHED</span>');
        expect(out).toContain('>FORCED</span>');
    });

    it('forced rows carry the dashed accent rail class', () => {
        expect(out).toContain('data-testid="integrity-forced-row"');
        expect(out).toContain('class="forced-row"');
        expect(out).toContain('2px dashed var(--color-accent-500)');
    });

    it('forced row shows catalog id, mag, and measured SNR', () => {
        expect(out).toContain('Gaia_55296');
        expect(out).toContain('11.13');
        expect(out).toContain('1076.0');
    });

    it('forced row nulls render the -- sentinel (gaia_id, mag) in the muted voice', () => {
        // second forced star: gaia_id null, mag null
        const forcedRows = out.split('integrity-forced-row').length - 1;
        expect(forcedRows).toBe(2);
        expect(out).toMatch(/<td class="catalog-id cell-absent">--<\/td>/);
        expect(out).toMatch(/<td class="mag-delta cell-absent">--<\/td>/);
    });

    it('forced rows have no residual/vector — sentinel, never a fake 0', () => {
        expect(out).toMatch(/<td class="residual-absent">--<\/td>/);
    });

    it('matched row with no measured SNR renders -- (explicit null in receipt)', () => {
        expect(out).toMatch(/<td class="snr cell-absent">--<\/td>/);
    });

    it('matched row with a measured SNR renders the number', () => {
        const withSnr = html(<StarIntegrityList matches={[matchedStar({ snr: 42.5 })]} forced={null} />);
        expect(withSnr).toMatch(/<td class="snr">42.5<\/td>/);
    });

    it('a star that is both a MATCHED anchor and a forced probe renders ONE row (anchor wins)', () => {
        // The deep harvest probes matched anchors too — the same gaia_id would
        // otherwise render twice (duplicate React keys, double-listed star).
        const dupForced: NonNullable<PlateSolution['deep_forced']> = {
            ...FORCED,
            stars: [
                { x: 100, y: 200, mag: 9.3, gaia_id: 'Gaia_3915824286237534000', snr: 900.0, flux: 80000 },
                ...FORCED.stars,
            ],
        };
        const out = html(<StarIntegrityList matches={[matchedStar()]} forced={dupForced} />);
        // The anchor's id appears exactly once (its MATCHED row).
        expect(out.split('Gaia_3915824286237534000').length - 1).toBe(1);
        // Non-anchor forced rows still render.
        expect(out).toContain('Gaia_55296');
        const forcedRows = out.split('integrity-forced-row').length - 1;
        expect(forcedRows).toBe(2);
        // Count chip stays the FULL harvest count — display dedup never edits totals.
        expect(out).toMatch(/data-testid="integrity-count-forced"[^>]*>3 CATALOG-FORCED</);
    });

    it('forced rows carry the honesty caption — probes, not WCS anchors', () => {
        expect(out).toContain('data-testid="integrity-prov-note"');
        expect(out).toContain('forced rows = photometry probes, not WCS anchors');
        // No forced rows → no caption to earn.
        const noForced = html(<StarIntegrityList matches={[matchedStar()]} />);
        expect(noForced).not.toContain('integrity-prov-note');
    });
});

describe('dashboard/StarIntegrityList — absence states', () => {
    it('no forced block → no forced chip, no forced rows, no 0-count chip', () => {
        const out = html(<StarIntegrityList matches={[matchedStar()]} />);
        expect(out).not.toContain('integrity-count-forced');
        expect(out).not.toContain('integrity-forced-row');
        expect(out).toContain('1 MATCHED');
    });

    it('empty everything → the existing empty state, string unchanged', () => {
        const out = html(<StarIntegrityList matches={[]} forced={null} />);
        expect(out).toContain('No matched stars available.');
    });

    it('forced-only (no matches) still renders the table, matched chip absent', () => {
        const out = html(<StarIntegrityList matches={[]} forced={FORCED} />);
        expect(out).not.toContain('integrity-count-matched');
        expect(out).toContain('2 CATALOG-FORCED');
        expect(out).toContain('integrity-forced-row');
        expect(out).not.toContain('No matched stars available.');
    });
});
