/**
 * A deterministic, representative receipt used by the round-trip tests AND the
 * committed-fixture generator. Values are hand-chosen to exercise: the RA-hours
 * vs RA-degrees unit split, nullable fields WITH nulls (bv/flux/peak_rgb) and
 * nullable fields WITHOUT nulls, a large Gaia id (2^53 precision), and a genuine
 * negative residual component. NOT a real solve — a fixture. Field values are the
 * shape the engine emits (package.ts exportPacket), not a fabricated science claim.
 */
import type { ReceiptLike } from '../receipt_types';

export function sampleReceipt(): ReceiptLike {
    return {
        version: '2.10.0',
        solution: {
            ra_hours: 11.341253475172621, // HOURS (× 15 = 170.1188… deg)
            dec_degrees: 41.269,
            pixel_scale: 3.6776147325019153,
            roll_degrees: -12.5,
            parity: 1,
            confidence: 0.83108935,
            fov_width_deg: 1.234,
            fov_height_deg: 0.987,
            spatial_hash: 'abc123def',
            mean_fwhm_px: 2.41,
            mean_residual_arcsec: 0.512,
            stars_matched: 3,
            solve_time_ms: 842,
            matched_stars: [
                {
                    gaia_id: 2321974934842921472, // > 2^53 → carried as string
                    name: 'HD 12345',
                    ra_deg: 170.11880212758932, // DEGREES (= ra_hours*15 region)
                    dec_deg: 41.2701,
                    mag: 8.42,
                    bv: 0.65,
                    cat_band: 'G',
                    x: 1024.5,
                    y: 768.25,
                    flux: 12345.6,
                    fwhm: 2.35,
                    residual_arcsec: 0.31,
                    dx_px: 0.12,
                    dy_px: -0.08,
                    dRA_arcsec: 0.21,
                    dDec_arcsec: -0.14,
                    peak_rgb: [60000, 45000, 30000],
                    measured_bv: 0.61,
                },
                {
                    gaia_id: null,
                    name: null,
                    ra_deg: 170.5001,
                    dec_deg: 41.3102,
                    mag: 10.11,
                    bv: null, // nullable-with-null
                    cat_band: 'V',
                    x: 512.0,
                    y: 300.75,
                    flux: null,
                    fwhm: null,
                    residual_arcsec: 0.77,
                    dx_px: null,
                    dy_px: null,
                    dRA_arcsec: null,
                    dDec_arcsec: null,
                    peak_rgb: null, // → peak_r/g/b null
                    measured_bv: null,
                },
                {
                    gaia_id: '410903020304050607',
                    name: 'TYC 999-1-1',
                    ra_deg: 169.882,
                    dec_deg: 41.1,
                    mag: 9.03,
                    bv: 1.2,
                    cat_band: 'G',
                    x: 200.125,
                    y: 900.0,
                    flux: 5000.25,
                    fwhm: 2.5,
                    residual_arcsec: 0.44,
                    dx_px: -0.2,
                    dy_px: 0.3,
                    dRA_arcsec: -0.33,
                    dDec_arcsec: 0.41,
                    peak_rgb: [50000, 40000, 25000],
                    measured_bv: 1.15,
                },
            ],
        },
        signal: {
            clean_stars: [
                { id: 0, x: 1024.5, y: 768.25, rawX: 2049.0, rawY: 1536.5, flux: 12345.6, peak: 60000, fwhm: 2.35, snr: 88.2, ellipticity: 0.05, circularity: 0.95, theta: 0.12, culling_reason: 'NONE' },
                { id: 1, x: 512.0, y: 300.75, rawX: 1024.0, rawY: 601.5, flux: 900.1, peak: 4200, fwhm: 1.9, snr: 12.4, ellipticity: 0.11, circularity: 0.89, theta: -0.44, culling_reason: 'NONE' },
                { id: 2, x: 200.125, y: 900.0, rawX: 400.25, rawY: 1800.0, flux: 5000.25, peak: 50000, fwhm: 2.5, snr: 44.0, ellipticity: 0.02, circularity: 0.98, theta: 1.57 },
            ],
        },
        deep_confirmed: {
            confirmed_stars: [
                { x: 1024.5, y: 768.25, mag: 8.42, gaia_id: '2321974934842921472', snr: 35.6, flux: 1.2346e4, confidence: 0.997 },
                { x: 620.0, y: 410.5, mag: null, gaia_id: null, snr: 6.1, flux: 3.3e3, confidence: 0.812 },
            ],
        },
        confirm_status: {
            status: 'CONFIRMED',
            setExcessZ: 35.6,
            nTargets: 46,
            confirmed: 18,
            setGateZ: 15,
            reason: null,
        },
    };
}

/** A no-solve receipt — every table must come back with the full schema and 0 rows. */
export function emptyReceipt(): ReceiptLike {
    return { version: '2.10.0', solution: null };
}
