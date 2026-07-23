/**
 * SCHEMA B (ATMOSPHERE_SEXTANT_SPEC inc 4) — per-star photometry block + band tag.
 *
 * Pins: (a) catalog band tagged per row (Gaia G vs Johnson V), never pooled;
 * (b) m_inst == −2.5·log10(flux) for MATCHED/CATALOG_FORCED; (c) block null when
 * no per-star photometry exists, and CATALOG_FORCED records absent when forced
 * photometry never ran; (d) alt/X honest-absent (null); + SPCC per-star surfacing
 * carries per-row band; + the block survives the save_packet replacer as plain data.
 */
import { describe, it, expect } from 'vitest';
import { buildReceipt, type ReceiptInputs } from '../pipeline/stages/package';
import { serializeReceipt } from '../pipeline/stages/receipt_serializer';
import { surfaceSpccPerStar } from '../pipeline/stages/science';
import { StarCatalogAdapter } from '../pipeline/m6_plate_solve/star_catalog_adapter';
import type { MatchedStar, PlateSolution } from '../types/Main_types';
import type { SpccCalibration } from '../pipeline/m8_photometry/spcc_calibrator';

function receiptFor(solution: PlateSolution | null, spccStars?: any[]): any {
    const i: ReceiptInputs = {
        metadata: null, signal: null, solution, planets: [], hardware: null,
        forensics: null, scales: null, warnings: [], timestampTrusted: false,
        spcc: undefined, spccStars, imageWidth: 1000, imageHeight: 1000,
    };
    return buildReceipt(i);
}

function matched(gaia_id: string, mag: number, band: 'GaiaG' | 'JohnsonV', flux: number, bv = 0.6): MatchedStar {
    return {
        detected: { x: 10, y: 20, flux, fwhm: 3, peak_rgb: [0.5, 0.4, 0.3] } as any,
        catalog: { ra: 150, dec: 20, mag, bv, ra_hours: 10, dec_degrees: 20, gaia_id, band } as any,
        residual_arcsec: 1.0,
    };
}

function solution(matched_stars: MatchedStar[], extra: Partial<PlateSolution> = {}): PlateSolution {
    return {
        ra: 150, dec: 20, ra_hours: 10, dec_degrees: 20, pixel_scale: 3.6,
        rotation: 0, fov_width_deg: 1, fov_height_deg: 1, parity: 1, spatial_hash: 'x',
        confidence: 0.9, num_stars: matched_stars.length, matched_stars,
        wcs: { crpix: [500, 500], crval: [10, 20], cd: [[-1e-3, 0], [0, 1e-3]] },
        ...extra,
    } as PlateSolution;
}

describe('SCHEMA B — catalog band tag (per-row discrimination)', () => {
    const adapter = StarCatalogAdapter.getinstance();

    it('Gaia-format row → band GaiaG', () => {
        adapter.ingestStars([{ id: 0, ra: 170.4, dec: 12.8, mag_g: 9, bp_rp: 0.8, source_id: 777001 }]);
        const s = adapter.getStars().find(x => x.gaia_id === 'Gaia_777001');
        expect(s?.band).toBe('GaiaG');
    });

    it('legacy HYG row → band JohnsonV', () => {
        adapter.ingestStars([{ id: 777002, ra: 5.5, dec: 10, mag: 2 }]);
        const s = adapter.getStars().find(x => x.gaia_id === 'HYG_777002');
        expect(s?.band).toBe('JohnsonV');
    });

    it('matched_stars[].cat_band is carried per row (never pooled)', () => {
        const r = receiptFor(solution([
            matched('Gaia_1', 9, 'GaiaG', 100),
            matched('HYG_2', 7, 'JohnsonV', 200),
        ]));
        const ms = r.solution.matched_stars;
        expect(ms.find((m: any) => m.gaia_id === 'Gaia_1').cat_band).toBe('GaiaG');
        expect(ms.find((m: any) => m.gaia_id === 'HYG_2').cat_band).toBe('JohnsonV');
    });
});

describe('SCHEMA B — photometry block', () => {
    it('m_inst == −2.5·log10(flux) for a MATCHED star', () => {
        const r = receiptFor(solution([matched('Gaia_1', 9, 'GaiaG', 123.4)]));
        const rec = r.solution.photometry.stars.find((s: any) => s.provenance === 'MATCHED');
        expect(rec.m_inst).toBeCloseTo(-2.5 * Math.log10(123.4), 12);
        expect(rec.cat_band).toBe('GaiaG');
        expect(rec.flux_rgb_kind).toBe('PEAK_RGB'); // matched peaks, NOT aperture flux
    });

    it('non-positive/absent flux → m_inst null (honest-absent, not -Inf)', () => {
        const m = matched('Gaia_1', 9, 'GaiaG', 0);
        (m.detected as any).flux = 0;
        const r = receiptFor(solution([m]));
        const rec = r.solution.photometry.stars.find((s: any) => s.provenance === 'MATCHED');
        expect(rec.m_inst).toBeNull();
    });

    it('CATALOG_FORCED records present when deep_forced ran, m_inst from flux', () => {
        const sol = solution([matched('Gaia_1', 9, 'GaiaG', 100)], {
            deep_forced: {
                provenance: 'CATALOG_FORCED', probed: 1, accepted: 1, structured: 0,
                rApPx: 2, fwhmPx: 3, snrThreshold: 2,
                stars: [{ x: 5, y: 6, mag: 12.5, gaia_id: 'Gaia_9', snr: 8, flux: 3.4 }],
            } as any,
        });
        const forced = receiptFor(sol).solution.photometry.stars.filter((s: any) => s.provenance === 'CATALOG_FORCED');
        expect(forced.length).toBe(1);
        expect(forced[0].m_inst).toBeCloseTo(-2.5 * Math.log10(3.4), 12);
        expect(forced[0].flux_err).toBeCloseTo(3.4 / 8, 12); // recovered forcedMeasure noise
        expect(forced[0].cat_band).toBeNull(); // deep_forced.stars carries no band → honest-absent
    });

    it('honest-absent: no CATALOG_FORCED records when forced photometry never ran', () => {
        const r = receiptFor(solution([matched('Gaia_1', 9, 'GaiaG', 100)])); // no deep_forced
        const forced = r.solution.photometry.stars.filter((s: any) => s.provenance === 'CATALOG_FORCED');
        expect(forced.length).toBe(0);
    });

    it('photometry block is null when there is no per-star photometry at all', () => {
        expect(receiptFor(null).solution).toBeNull();
        const empty = solution([]); // solved but zero matched, no forced, no spcc
        expect(receiptFor(empty).solution.photometry).toBeNull();
    });

    it('alt_deg / airmass are null (no observer/location in receipt scope)', () => {
        const r = receiptFor(solution([matched('Gaia_1', 9, 'GaiaG', 100)]));
        const rec = r.solution.photometry.stars[0];
        expect(rec.alt_deg).toBeNull();
        expect(rec.airmass).toBeNull();
    });

    it('block survives the save_packet replacer as plain numbers/objects', () => {
        const r = receiptFor(solution([matched('Gaia_1', 9, 'GaiaG', 100)]));
        const round = JSON.parse(serializeReceipt(r));
        const rec = round.solution.photometry.stars[0];
        expect(typeof rec.m_inst).toBe('number');
        expect(typeof rec.flux_rgb.r).toBe('number');
        expect(rec.cat_band).toBe('GaiaG');
    });
});

describe('SCHEMA B — SPCC per-star surfacing preserves per-row band', () => {
    function cal(perStar: { flux_r: number; flux_g: number; flux_b: number; mInst: number | null; instColor: number | null; usable: boolean }[]): SpccCalibration {
        return {
            valid: true,
            colorFit: { valid: true, slope: 1, intercept: 0, r2: 1, rmse: 0, n_used: perStar.length },
            zpFit: { valid: true, zeropoint: 0, rmse: 0, n_used: perStar.length },
            n_usable: perStar.filter(p => p.usable).length,
            stars: perStar.map(p => ({
                measurement: { flux_r: p.flux_r, flux_g: p.flux_g, flux_b: p.flux_b } as any,
                instColor: p.instColor, mInst: p.mInst, usable: p.usable,
            })),
            fidelity: null,
            gains: { gains: [1, 1, 1], method: 'TLS', nStars: 0, r2: 0, slope_br: NaN, slope_gr: NaN,
                     uncertainty: [0, 0, 0], whiteRefBpRp: 0, applied: false, gate: { passed: false, reason: 'fixture' } },
        };
    }

    it('carries the ACTUAL matched-star band (a HYG-matched SPCC star is JohnsonV, not GaiaG)', () => {
        const matchedStars = [
            matched('Gaia_1', 9, 'GaiaG', 100),
            matched('HYG_2', 8.3, 'JohnsonV', 50),
        ];
        const c = cal([
            { flux_r: 30, flux_g: 20, flux_b: 18, mInst: -5, instColor: 0.5, usable: true },
            { flux_r: 15, flux_g: 10, flux_b: 9, mInst: -4, instColor: 0.4, usable: true },
        ]);
        const surfaced = surfaceSpccPerStar(c, matchedStars);
        expect(surfaced.length).toBe(2);
        expect(surfaced[0].cat_band).toBe('GaiaG');
        expect(surfaced[1].cat_band).toBe('JohnsonV'); // per-row, NOT blanket GaiaG
        // Round-trip into the receipt photometry block preserves the per-row band.
        const r = receiptFor(solution(matchedStars), surfaced);
        const spccRecs = r.solution.photometry.stars.filter((s: any) => s.provenance === 'SPCC');
        expect(spccRecs.map((s: any) => s.cat_band).sort()).toEqual(['GaiaG', 'JohnsonV']);
        expect(spccRecs[0].flux_rgb_kind).toBe('APERTURE_RGB'); // real per-channel aperture flux
    });

    it('drops off-frame stars (null measurement) — honest, not zero-filled', () => {
        const matchedStars = [matched('Gaia_1', 9, 'GaiaG', 100)];
        const c = cal([{ flux_r: 0, flux_g: 0, flux_b: 0, mInst: null, instColor: null, usable: false }]);
        c.stars[0].measurement = null; // off-frame
        expect(surfaceSpccPerStar(c, matchedStars).length).toBe(0);
    });
});
