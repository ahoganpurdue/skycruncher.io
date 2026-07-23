/**
 * UNIFIED EXPORT DISPATCHER — availability matrix logic (LAW 3: honest-or-absent).
 *
 * Pins the pure `exportAvailability` / `hasFittedWcs` logic that drives the step-7
 * export selector's DISABLED+reason rows. No DOM / no Tauri here — just the matrix:
 * receipt/arrow need a completed run; FITS/ASDF need a FITTED WCS AND the science
 * frame (reason surfaces the first unmet precondition); PNG/C2PA are declared-coming.
 */
import { describe, it, expect } from 'vitest';
import {
    exportAvailability,
    hasFittedWcs,
    EXPORT_FORMATS,
    type ExportFormat,
} from '../ui/utils/save_export';

const fittedReceipt = (extra: any = {}) => ({
    version: '2.12.0',
    solution: { spatial_hash: 'abc' },
    wcs: { SOURCE: 'FITTED', CRVAL1: 150, CRVAL2: 20 },
    ...extra,
});
const synthReceipt = () => ({ version: '2.12.0', wcs: { SOURCE: 'SYNTHESIZED' } });
const noWcsReceipt = () => ({ version: '2.12.0', wcs: null });

describe('hasFittedWcs', () => {
    it('true only for a FITTED WCS source', () => {
        expect(hasFittedWcs(fittedReceipt())).toBe(true);
        expect(hasFittedWcs(synthReceipt())).toBe(false);
        expect(hasFittedWcs(noWcsReceipt())).toBe(false);
        expect(hasFittedWcs(null)).toBe(false);
    });
});

describe('exportAvailability — matrix', () => {
    it('no receipt: everything real is disabled with the "run first" reason', () => {
        const m = exportAvailability(null, { hasImage: false });
        expect(m.receipt.available).toBe(false);
        expect(m.receipt.reason).toMatch(/Run the pipeline first/);
        expect(m.fits.available).toBe(false);
        expect(m.asdf.available).toBe(false);
        expect(m.arrow.available).toBe(false);
    });

    it('receipt + arrow are available the moment a run exists (no WCS needed)', () => {
        const m = exportAvailability(noWcsReceipt(), { hasImage: false });
        expect(m.receipt.available).toBe(true);
        expect(m.receipt.reason).toBeNull();
        expect(m.arrow.available).toBe(true);
        expect(m.arrow.reason).toBeNull();
    });

    it('FITS/ASDF disabled with the WCS reason when the WCS is not FITTED', () => {
        const m = exportAvailability(synthReceipt(), { hasImage: true });
        expect(m.fits.available).toBe(false);
        expect(m.fits.reason).toMatch(/fitted WCS/i);
        expect(m.asdf.available).toBe(false);
        expect(m.asdf.reason).toMatch(/fitted WCS/i);
    });

    it('FITS/ASDF disabled with the FRAME reason when WCS is fitted but no image', () => {
        const m = exportAvailability(fittedReceipt(), { hasImage: false });
        expect(m.fits.available).toBe(false);
        expect(m.fits.reason).toMatch(/science frame/i);
        expect(m.asdf.available).toBe(false);
        expect(m.asdf.reason).toMatch(/science frame/i);
    });

    it('FITS/ASDF available with a fitted WCS AND the science frame present', () => {
        const m = exportAvailability(fittedReceipt(), { hasImage: true });
        expect(m.fits.available).toBe(true);
        expect(m.fits.reason).toBeNull();
        expect(m.asdf.available).toBe(true);
        expect(m.asdf.reason).toBeNull();
    });

    it('the "run first" precondition wins over WCS/frame reasons (first unmet surfaces)', () => {
        const m = exportAvailability(null, { hasImage: true });
        expect(m.fits.reason).toMatch(/Run the pipeline first/);
    });

    it('PNG and C2PA are declared-coming: always disabled + flagged', () => {
        const m = exportAvailability(fittedReceipt(), { hasImage: true });
        for (const f of ['png', 'c2pa'] as ExportFormat[]) {
            expect(m[f].available).toBe(false);
            expect(m[f].coming).toBe(true);
            expect(m[f].reason).toMatch(/coming/i);
        }
    });

    it('every EXPORT_FORMATS entry has a matrix row', () => {
        const m = exportAvailability(fittedReceipt(), { hasImage: true });
        for (const fmt of EXPORT_FORMATS) {
            expect(m[fmt.id]).toBeDefined();
        }
        // the coming flags in the registry match the matrix
        expect(EXPORT_FORMATS.filter(f => f.coming).map(f => f.id).sort()).toEqual(['c2pa', 'png']);
    });
});
