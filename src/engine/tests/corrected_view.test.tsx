import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    detectCorrectedView,
    CORRECTED_VIEW_NOT_AVAILABLE,
    CORRECTED_VIEW_AVAILABLE,
    type CorrectedViewInfo,
} from '../ui/corrected_view';
import { CorrectedViewPill } from '../ui/CorrectedViewPill';
import {
    CORRECTED_VIEW_STORAGE_KEY,
    getCorrectedViewPref,
    setCorrectedViewPref,
} from '../ui/render_prefs';
import type { PlateSolution } from '../types/Main_types';

/** In-memory localStorage stub (node env has none). */
function installLocalStorage(seed?: Record<string, string>) {
    const store = new Map<string, string>(Object.entries(seed ?? {}));
    (globalThis as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
    };
}

/** Minimal PlateSolution shells — detectCorrectedView reads only astrometry.sip. */
const sol = (astrometry?: PlateSolution['astrometry']): PlateSolution =>
    ({ astrometry } as unknown as PlateSolution);

const VALID_SIP = { a_order: 2, b_order: 2, a: [[0, 0], [0.001, 0]], b: [[0, 0.001], [0, 0]] };

describe('detectCorrectedView (render-plane availability, LAW 3 honest-or-absent)', () => {
    it('null / undefined solution ⇒ NOT AVAILABLE (never fabricated)', () => {
        for (const s of [null, undefined]) {
            const info = detectCorrectedView(s);
            expect(info.available).toBe(false);
            expect(info.source).toBeNull();
            expect(info.label).toBe(CORRECTED_VIEW_NOT_AVAILABLE);
        }
    });

    it('solution without astrometry ⇒ NOT AVAILABLE', () => {
        expect(detectCorrectedView(sol(undefined)).available).toBe(false);
    });

    it('astrometry present but no SIP (TPS-only) ⇒ NOT AVAILABLE (no preview warp primitive)', () => {
        const info = detectCorrectedView(sol({ rms_arcsec: 1, distortion_detected: true, tps: null }));
        expect(info.available).toBe(false);
        expect(info.source).toBeNull();
    });

    it('SIP with empty coefficient arrays ⇒ NOT AVAILABLE (no usable warp)', () => {
        const info = detectCorrectedView(sol({
            rms_arcsec: 1, distortion_detected: true,
            sip: { a_order: 0, b_order: 0, a: [], b: [] },
        }));
        expect(info.available).toBe(false);
    });

    it('fitted SIP polynomial ⇒ AVAILABLE, source SIP, APPROXIMATE label', () => {
        const info = detectCorrectedView(sol({ rms_arcsec: 1, distortion_detected: true, sip: VALID_SIP }));
        expect(info.available).toBe(true);
        expect(info.source).toBe('SIP');
        expect(info.label).toBe(CORRECTED_VIEW_AVAILABLE);
    });
});

const AVAIL: CorrectedViewInfo = { available: true, source: 'SIP', label: CORRECTED_VIEW_AVAILABLE };
const UNAVAIL: CorrectedViewInfo = { available: false, source: null, label: CORRECTED_VIEW_NOT_AVAILABLE };

describe('CorrectedViewPill (honest-or-absent render)', () => {
    it('available + OFF: interactive switch, unchecked, NO APPROX badge', () => {
        const m = renderToStaticMarkup(<CorrectedViewPill info={AVAIL} on={false} onToggle={() => {}} />);
        expect(m).toContain('data-testid="wizard-corrected-view"');
        expect(m).toContain('data-available="true"');
        expect(m).toContain('role="switch"');
        expect(m).toContain('aria-checked="false"');
        expect(m).not.toContain('wizard-corrected-view-badge'); // no APPROX badge while OFF
    });

    it('available + ON: checked switch with the APPROX badge (correction is APPROXIMATE)', () => {
        const m = renderToStaticMarkup(<CorrectedViewPill info={AVAIL} on={true} onToggle={() => {}} />);
        expect(m).toContain('aria-checked="true"');
        expect(m).toContain('APPROX');
        expect(m).toContain('wizard-corrected-view-badge');
    });

    it('NOT available: disabled, non-switch pill carrying the honest NOT-AVAILABLE text', () => {
        const m = renderToStaticMarkup(<CorrectedViewPill info={UNAVAIL} on={false} onToggle={() => {}} />);
        expect(m).toContain('data-available="false"');
        expect(m).toContain('disabled');
        expect(m).toContain(CORRECTED_VIEW_NOT_AVAILABLE); // honest text present (aria-label/title)
        expect(m).not.toContain('role="switch"');
        expect(m).not.toContain('wizard-corrected-view-badge'); // no APPROX badge when unavailable
    });
});

describe('corrected-view render pref (DEFAULT OFF)', () => {
    afterEach(() => { delete (globalThis as any).localStorage; });

    it('defaults to OFF with no stored value', () => {
        installLocalStorage();
        expect(getCorrectedViewPref()).toBe(false);
    });

    it('round-trips through the dedicated storage key', () => {
        installLocalStorage();
        setCorrectedViewPref(true);
        expect(localStorage.getItem(CORRECTED_VIEW_STORAGE_KEY)).toBe('1');
        expect(getCorrectedViewPref()).toBe(true);
        setCorrectedViewPref(false);
        expect(getCorrectedViewPref()).toBe(false);
    });

    it('never throws when storage is unavailable (honest fallback to OFF)', () => {
        delete (globalThis as any).localStorage;
        expect(() => setCorrectedViewPref(true)).not.toThrow();
        expect(getCorrectedViewPref()).toBe(false);
    });
});
