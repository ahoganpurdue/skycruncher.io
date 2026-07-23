import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { StarCatalogAdapter, type CatalogHealthWarning } from '../pipeline/m6_plate_solve/star_catalog_adapter';

/**
 * M6 catalog-health surfacing (honest-or-absent, LAW 3).
 *
 * The adapter used to swallow every catalog failure to the console and return
 * silently — in the packaged v1.0.0 app a failed atlas/sector load made the whole
 * solve fail INVISIBLY. These tests pin the new contract:
 *   - a REAL failure (network / parse throw, atlas never loaded) is RECORDED in
 *     the health snapshot AND emitted as an honest `warning` through the sink;
 *   - a legitimately-empty sector (200 OK empty list) OR an ambiguous void-sector
 *     404 stays SILENT (no user-facing warning) so healthy solves are unchanged.
 *
 * This file never loads the atlas, so the singleton's `isLoaded` stays false —
 * which is exactly the "queried before load" condition test 4 exercises. All
 * sector-loading tests use DISTINCT sky coordinates so the private `loadedSectors`
 * cache (no reset hook) can't leak a "already loaded, skipped" between tests.
 */
describe('M6 catalog-health (StarCatalogAdapter)', () => {
    const adapter = StarCatalogAdapter.getinstance();
    const origBinary = StarCatalogAdapter.isBinarySourceEnabled();

    beforeEach(() => {
        adapter.resetHealth();
        StarCatalogAdapter.setHealthSink(null);
        StarCatalogAdapter.setAtlasLoader(null);
        // Deterministic: exercise the JSON sector path only (skip the Arrow probe).
        StarCatalogAdapter.setBinarySource(false);
    });
    afterAll(() => {
        StarCatalogAdapter.setHealthSink(null);
        StarCatalogAdapter.setAtlasLoader(null);
        StarCatalogAdapter.setBinarySource(origBinary);
        adapter.resetHealth();
    });

    it('RECORDS + EMITS an honest warning when a sector fetch THROWS (network error)', async () => {
        const warnings: CatalogHealthWarning[] = [];
        StarCatalogAdapter.setHealthSink((e) => warnings.push(e));
        StarCatalogAdapter.setAtlasLoader(async () => { throw new Error('ECONNREFUSED'); });

        await adapter.ensureSectorLoaded(11.3, 13.0, 3);

        expect(adapter.getHealth().sectorLoadErrors).toBeGreaterThanOrEqual(1);
        expect(warnings.length).toBeGreaterThanOrEqual(1);
        expect(warnings[0].kind).toBe('warning');
        expect(warnings[0].stage).toBe('catalog');
        expect(warnings[0].message).toMatch(/catalog/i);
        // The emitted message is the real degradation text — never a fake number.
        expect(warnings[0].message).not.toMatch(/\d+\.\d+/);
    });

    it('stays SILENT on a legitimately-empty sector (200 OK, empty star list)', async () => {
        const warnings: CatalogHealthWarning[] = [];
        StarCatalogAdapter.setHealthSink((e) => warnings.push(e));
        StarCatalogAdapter.setAtlasLoader(
            async () => ({ ok: true, json: async () => [] } as unknown as Response),
        );

        await adapter.ensureSectorLoaded(2.0, 40.0, 3);

        expect(adapter.getHealth().sectorLoadErrors).toBe(0);
        expect(warnings.length).toBe(0);
    });

    it('RECORDS a sector HTTP miss (404) but stays SILENT — a void sector is ambiguous', async () => {
        const warnings: CatalogHealthWarning[] = [];
        StarCatalogAdapter.setHealthSink((e) => warnings.push(e));
        StarCatalogAdapter.setAtlasLoader(
            async () => ({ ok: false, status: 404 } as unknown as Response),
        );

        await adapter.ensureSectorLoaded(20.0, -50.0, 3);

        expect(adapter.getHealth().sectorHttpMisses).toBeGreaterThanOrEqual(1);
        expect(adapter.getHealth().sectorLoadErrors).toBe(0);
        expect(warnings.length).toBe(0);
    });

    it('EMITS + flags unusable when findStarsInField is queried before the catalog loads', async () => {
        const warnings: CatalogHealthWarning[] = [];
        StarCatalogAdapter.setHealthSink((e) => warnings.push(e));

        // Fresh singleton in this isolated test file: the atlas was never loaded.
        const rows = await adapter.findStarsInField(11.3, 13.0, 3, 2451545);

        expect(rows).toEqual([]);
        expect(adapter.getHealth().queriedBeforeLoad).toBe(true);
        expect(adapter.getHealth().usable).toBe(false);
        expect(warnings.some((w) => /not loaded|unavailable/i.test(w.message))).toBe(true);
    });

    it('EMITS each distinct failure at most once (de-duped), while counts keep accruing', async () => {
        const warnings: CatalogHealthWarning[] = [];
        StarCatalogAdapter.setHealthSink((e) => warnings.push(e));
        StarCatalogAdapter.setAtlasLoader(async () => { throw new Error('down'); });

        await adapter.ensureSectorLoaded(8.0, 60.0, 3);
        await adapter.ensureSectorLoaded(16.0, -30.0, 3);

        const sectorWarnings = warnings.filter((w) => /sector/i.test(w.message));
        expect(sectorWarnings.length).toBe(1); // one warning per failure key
        expect(adapter.getHealth().sectorLoadErrors).toBeGreaterThan(1); // counts still accrue
    });

    it('a healthy sector load records NO failure and emits nothing (byte-identity guard)', async () => {
        const warnings: CatalogHealthWarning[] = [];
        StarCatalogAdapter.setHealthSink((e) => warnings.push(e));
        StarCatalogAdapter.setAtlasLoader(
            async () => ({ ok: true, json: async () => [
                { id: 0, source_id: 1, ra: 60.0, dec: 42.0, mag_g: 8 },
            ] } as unknown as Response),
        );

        await adapter.ensureSectorLoaded(4.0, 42.0, 3);

        const h = adapter.getHealth();
        expect(h.sectorLoadErrors).toBe(0);
        expect(h.sectorHttpMisses).toBe(0);
        expect(warnings.length).toBe(0);
    });
});
