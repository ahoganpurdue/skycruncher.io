/**
 * save_export — render-plane PNG availability + guard tests (DOM-free).
 *
 * Covers the additive display-PNG path: the availability matrix flips PNG from
 * declared-coming to a real export once a rendered display canvas exists, and the
 * dispatcher treats the PNG as a RENDER-PLANE product (independent of the receipt),
 * while the science formats still require a completed run.
 */
import { describe, it, expect } from 'vitest';
import { exportAvailability, saveExport } from './save_export';

const FITTED_RECEIPT = { wcs: { SOURCE: 'FITTED' }, solution: { spatial_hash: 'abc123' } };

describe('exportAvailability — render-plane PNG', () => {
    it('PNG stays declared-coming when no display render exists (headless / desktop)', () => {
        const m = exportAvailability(FITTED_RECEIPT, { hasImage: true });
        expect(m.png.available).toBe(false);
        expect(m.png.coming).toBe(true);
    });

    it('PNG stays declared-coming when hasRender is explicitly false', () => {
        const m = exportAvailability(FITTED_RECEIPT, { hasImage: true, hasRender: false });
        expect(m.png.available).toBe(false);
        expect(m.png.coming).toBe(true);
    });

    it('PNG becomes a real export once a display render is present', () => {
        const m = exportAvailability(FITTED_RECEIPT, { hasImage: true, hasRender: true });
        expect(m.png.available).toBe(true);
        expect(m.png.coming).toBe(false);
        expect(m.png.reason).toBeNull();
    });

    it('a display render does not fabricate the science formats (still need a fitted WCS + frame)', () => {
        const m = exportAvailability(null, { hasRender: true });
        expect(m.png.available).toBe(true);   // render is receipt-independent
        expect(m.fits.available).toBe(false); // science still gated
        expect(m.asdf.available).toBe(false);
        expect(m.receipt.available).toBe(false);
    });

    it('C2PA remains declared-coming regardless of the render', () => {
        const m = exportAvailability(FITTED_RECEIPT, { hasImage: true, hasRender: true });
        expect(m.c2pa.available).toBe(false);
        expect(m.c2pa.coming).toBe(true);
    });
});

describe('saveExport — render-plane PNG guards', () => {
    it('PNG without render bytes reports the render reason, not the no-run reason', async () => {
        await expect(saveExport('png', { receipt: null })).rejects.toThrow(/rendered view/i);
    });

    it('the science formats still require a completed run', async () => {
        await expect(saveExport('receipt', { receipt: null })).rejects.toThrow(/no receipt/i);
        await expect(saveExport('fits', { receipt: null })).rejects.toThrow(/no receipt/i);
    });
});
