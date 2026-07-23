import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
    StarCatalogAdapter,
    type DeepCatalogRow,
    type G15uQueryFn,
} from '../pipeline/m6_plate_solve/star_catalog_adapter';

/**
 * G15U confirm-lane source (VITE_CATALOG_G15U, default OFF).
 *
 * The post-solve confirm/deep-verify lane can re-source its deep catalog from the
 * greenfield quad-index's stars.arrow (Gaia DR3 G≤15) instead of the legacy hybrid
 * Gaia+HYG sectors. These tests pin the seam CONTRACT without touching the 181 MB
 * file: the injectable query (setG15uQuery) proves routing + flag-OFF inertness +
 * fail-soft fallback, exactly as m6_starplates_provider does for the v2 seam.
 */
describe('M6 g15u confirm-lane source (StarCatalogAdapter)', () => {
    const adapter = StarCatalogAdapter.getinstance();
    const origFlag = StarCatalogAdapter.isG15uCatalogSourceEnabled();

    beforeEach(() => {
        StarCatalogAdapter.setG15uQuery(null);
        StarCatalogAdapter.setG15uCatalogSource(false);
    });

    afterAll(() => {
        StarCatalogAdapter.setG15uQuery(null);
        StarCatalogAdapter.setG15uCatalogSource(origFlag);
    });

    it('flag defaults OFF (browser/legacy tier keeps the hybrid path)', () => {
        // The static default is env-driven; in vitest VITE_CATALOG_G15U is unset,
        // so the source must be OFF — the confirm lane stays on the hybrid atlas.
        expect(StarCatalogAdapter.isG15uCatalogSourceEnabled()).toBe(false);
    });

    it('setG15uCatalogSource toggles the flag', () => {
        StarCatalogAdapter.setG15uCatalogSource(true);
        expect(StarCatalogAdapter.isG15uCatalogSourceEnabled()).toBe(true);
        StarCatalogAdapter.setG15uCatalogSource(false);
        expect(StarCatalogAdapter.isG15uCatalogSourceEnabled()).toBe(false);
    });

    it('queryDeepCatalogG15u routes to the injected query with the caller args', async () => {
        const seen: number[] = [];
        const rows: DeepCatalogRow[] = [
            { ra_hours: 11.34, dec_degrees: 12.9, magnitude_V: 9.1, gaia_id: 'Gaia_1', band: 'GaiaG' },
        ];
        const fake: G15uQueryFn = async (raHours, decDeg, radiusDeg, magLimit) => {
            seen.push(raHours, decDeg, radiusDeg, magLimit);
            return rows;
        };
        StarCatalogAdapter.setG15uQuery(fake);
        const out = await adapter.queryDeepCatalogG15u(11.34, 12.9, 0.75, 12.5);
        expect(out).toEqual(rows);
        expect(seen).toEqual([11.34, 12.9, 0.75, 12.5]);
    });

    it('is fail-soft: a null query result (absence) returns null → hybrid fallback', async () => {
        StarCatalogAdapter.setG15uQuery(async () => null);
        expect(await adapter.queryDeepCatalogG15u(5, 5, 1, 12.5)).toBeNull();
    });

    it('is fail-soft: a THROWING query is caught and returns null (never propagates)', async () => {
        StarCatalogAdapter.setG15uQuery(async () => { throw new Error('boom'); });
        await expect(adapter.queryDeepCatalogG15u(5, 5, 1, 12.5)).resolves.toBeNull();
    });
});
