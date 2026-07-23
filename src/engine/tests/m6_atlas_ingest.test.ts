import { describe, it, expect } from 'vitest';
import { StarCatalogAdapter } from '../pipeline/m6_plate_solve/star_catalog_adapter';

/**
 * M6 Atlas ingest regression tests.
 *
 * The atlas generator writes Gaia-format records where EVERY entry has id:0
 * and `ra` in DEGREES. The legacy HYG shape uses id:0 exclusively for Sol
 * and carries `ra` in HOURS. ingestStars must distinguish the two shapes.
 */
describe('M6 Atlas Ingest (StarCatalogAdapter.ingestStars)', () => {
    const adapter = StarCatalogAdapter.getinstance();

    it('ingests Gaia-format records with id:0 (not filtered as Sol) and converts ra degrees to hours', () => {
        const before = adapter.getStars().length;
        adapter.ingestStars([
            { id: 0, ra: 170.425, dec: 12.84, mag_g: 9, bp_rp: 0.8, pm_ra: 1.0, pm_dec: -2.0, source_id: 123 }
        ]);
        const stars = adapter.getStars();
        expect(stars.length).toBe(before + 1);

        const star = stars[stars.length - 1];
        expect(star.gaia_id).toBe('Gaia_123');
        expect(star.ra_hours).toBeCloseTo(170.425 / 15, 3); // ≈ 11.3617h
        expect(star.dec_degrees).toBeCloseTo(12.84, 6);
        expect(star.magnitude_V).toBe(9);
        expect(star.color_index_BV).toBe(0.8);
    });

    it('filters the legacy HYG Sol record (id:0, no source_id)', () => {
        const before = adapter.getStars().length;
        adapter.ingestStars([
            { id: 0, ra: 5.5, dec: 10, mag: 2 }
        ]);
        expect(adapter.getStars().length).toBe(before);
    });

    it('keeps legacy HYG records (ra already in hours)', () => {
        const before = adapter.getStars().length;
        adapter.ingestStars([
            { id: 7, ra: 5.5, dec: 10, mag: 2 }
        ]);
        const stars = adapter.getStars();
        expect(stars.length).toBe(before + 1);

        const star = stars[stars.length - 1];
        expect(star.gaia_id).toBe('HYG_7');
        expect(star.ra_hours).toBe(5.5); // hours, NOT divided by 15
        expect(star.dec_degrees).toBe(10);
        expect(star.magnitude_V).toBe(2);
    });
});

/**
 * F4 — Tycho-2 / Hipparcos bright-star SUPPLEMENT rows (build_gaia_pure_sectors.mjs)
 * carry a `mag_system` tag (VT/BT/Hp) and NO source_id. They are Gaia-SHAPED
 * (ra in DEGREES, mag_g present) but their mag is the NATIVE VT/BT/Hp magnitude —
 * ingestStars must read `mag_system` and (a) tag the correct native band, never
 * GaiaG, and (b) mint a TYC_/HIP_ provenance id, NEVER the retired HYG_ namespace.
 * magnitude_V stays the native mag (no cross-system transform — LAW 3).
 */
describe('M6 Atlas Ingest — Tycho/Hipparcos supplement (mag_system routing, F4)', () => {
    const adapter = StarCatalogAdapter.getinstance();

    it('Tycho-2 V_T row → band TychoVT, TYC_ id, native VT mag, ra degrees, bt_vt carried', () => {
        const before = adapter.getStars().length;
        adapter.ingestStars([
            { id: 5, ra: 170.5, dec: 12.9, mag_g: 8.123, mag_system: 'VT', bt_vt: 0.45, cat: 'tycho2', cat_id: 'TYC 1234-5678-1' }
        ]);
        const stars = adapter.getStars();
        expect(stars.length).toBe(before + 1);

        const star = stars[stars.length - 1];
        expect(star.band).toBe('TychoVT');
        expect(star.gaia_id).toBe('TYC_TYC 1234-5678-1');    // TYC_ namespace…
        expect(star.gaia_id.startsWith('HYG_')).toBe(false); // …never the retired HYG_
        expect(star.magnitude_V).toBe(8.123);                // native VT, NOT transformed to G
        expect(star.ra_hours).toBeCloseTo(170.5 / 15, 6);    // supplement ra is in DEGREES
        expect(star.dec_degrees).toBe(12.9);
        expect(star.bt_vt).toBe(0.45);                        // additive carry-through
    });

    it('Tycho-2 B_T-only row (no VT) → band TychoBT, no fabricated bt_vt', () => {
        const before = adapter.getStars().length;
        adapter.ingestStars([
            { id: 6, ra: 200.0, dec: -5.0, mag_g: 10.5, mag_system: 'BT', cat: 'tycho2', cat_id: 'TYC 4-5-6' }
        ]);
        const stars = adapter.getStars();
        expect(stars.length).toBe(before + 1);

        const star = stars[stars.length - 1];
        expect(star.band).toBe('TychoBT');
        expect(star.gaia_id).toBe('TYC_TYC 4-5-6');
        expect(star.magnitude_V).toBe(10.5);
        expect(star.bt_vt).toBeUndefined();
    });

    it('Hipparcos Hp row → band HipparcosHp, HIP_ id, native Hp mag', () => {
        const before = adapter.getStars().length;
        adapter.ingestStars([
            { id: 7, ra: 88.79, dec: 7.4, mag_g: 0.87, mag_system: 'Hp', cat: 'hipparcos', cat_id: 'HIP 27989' }
        ]);
        const stars = adapter.getStars();
        expect(stars.length).toBe(before + 1);

        const star = stars[stars.length - 1];
        expect(star.band).toBe('HipparcosHp');
        expect(star.gaia_id).toBe('HIP_HIP 27989');
        expect(star.gaia_id.startsWith('HYG_')).toBe(false);
        expect(star.magnitude_V).toBe(0.87);
        expect(star.bt_vt).toBeUndefined();
    });

    it('Gaia-format row (no mag_system) is untouched by the fix → band GaiaG, Gaia_ id', () => {
        const before = adapter.getStars().length;
        adapter.ingestStars([
            { id: 0, ra: 45.0, dec: 20.0, mag_g: 11.2, bp_rp: 0.9, source_id: 999 }
        ]);
        const stars = adapter.getStars();
        expect(stars.length).toBe(before + 1);

        const star = stars[stars.length - 1];
        expect(star.band).toBe('GaiaG');
        expect(star.gaia_id).toBe('Gaia_999');
        expect(star.bt_vt).toBeUndefined();
    });

    it('legacy HYG-shape row (cold path) is untouched → band JohnsonV, HYG_ id', () => {
        const before = adapter.getStars().length;
        adapter.ingestStars([
            { id: 42, ra: 5.5, dec: 10, mag: 2.1 }
        ]);
        const stars = adapter.getStars();
        expect(stars.length).toBe(before + 1);

        const star = stars[stars.length - 1];
        expect(star.band).toBe('JohnsonV');
        expect(star.gaia_id).toBe('HYG_42');
        expect(star.magnitude_V).toBe(2.1);
    });
});
