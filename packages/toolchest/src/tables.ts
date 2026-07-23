/**
 * The four TABULAR products of a completed run, as Apache Arrow Tables.
 * Tables ride Arrow; rasters (previews, science buffers, PSF stamps) ride typed
 * arrays and are NOT emitted here (Arrow Carrier program rule: never mix).
 *
 * Each builder READS the receipt only — no engine behaviour, no re-computation.
 * Honest-or-absent: a null solution / absent block yields an EMPTY table with the
 * full schema (0 rows), never a fabricated row.
 */
import { Field, Float64, Int32, Utf8, type Table } from 'apache-arrow';
import { assembleTable, f64, f64Nullable, i32, utf8, fieldMeta, type Column } from './arrow_columns';
import { schemaMetadata } from './provenance';
import type {
    ReceiptLike,
    MatchedStarLike,
    DetectionLike,
    ForcedConfirmedLike,
} from './receipt_types';

const F64 = new Float64();
const I32 = new Int32();
const UTF8 = new Utf8();

// Field constructors: nn = non-nullable (no validity bitmap), nl = nullable.
const nnF = (name: string, units: string, source: string, note?: string): Field =>
    new Field(name, F64, false, fieldMeta(units, source, note));
const nlF = (name: string, units: string, source: string, note?: string): Field =>
    new Field(name, F64, true, fieldMeta(units, source, note));
const nnI = (name: string, units: string, source: string): Field =>
    new Field(name, I32, false, fieldMeta(units, source));
const nlU = (name: string, units: string, source: string, note?: string): Field =>
    new Field(name, UTF8, true, fieldMeta(units, source, note));

// ---------------------------------------------------------------------------
// 1. matched_stars — per-star science (catalog identity + detected position +
//    residual vector components + photometry). Source: solution.matched_stars.
// ---------------------------------------------------------------------------
export function matchedStarsTable(receipt: ReceiptLike): Table {
    const rows: MatchedStarLike[] = receipt.solution?.matched_stars ?? [];
    const src = 'receipt.solution.matched_stars';
    const peakR = rows.map((r) => (r.peak_rgb ? r.peak_rgb[0] : null));
    const peakG = rows.map((r) => (r.peak_rgb ? r.peak_rgb[1] : null));
    const peakB = rows.map((r) => (r.peak_rgb ? r.peak_rgb[2] : null));

    const columns: Column[] = [
        { field: nlU('gaia_id', 'Gaia DR3 source id (string — dodges 2^53 rounding)', `${src}[].gaia_id`), data: utf8(rows.map((r) => r.gaia_id)) },
        { field: nlU('name', 'catalog name', `${src}[].name`), data: utf8(rows.map((r) => r.name)) },
        { field: nnF('ra_deg', 'degrees', `${src}[].ra_deg`, 'catalog RA in DEGREES (NOT hours — cf. run_summary.ra_hours)'), data: f64(rows.map((r) => r.ra_deg)) },
        { field: nnF('dec_deg', 'degrees', `${src}[].dec_deg`), data: f64(rows.map((r) => r.dec_deg)) },
        { field: nnF('mag', 'magnitude (in cat_band)', `${src}[].mag`), data: f64(rows.map((r) => r.mag)) },
        { field: nlF('bv', 'magnitude (B−V colour index)', `${src}[].bv`), data: f64Nullable(rows.map((r) => r.bv)) },
        { field: nlU('cat_band', "photometric band ('G' Gaia | 'V' Johnson)", `${src}[].cat_band`), data: utf8(rows.map((r) => r.cat_band)) },
        { field: nnF('x', 'pixels (image-space, y-down)', `${src}[].x`), data: f64(rows.map((r) => r.x)) },
        { field: nnF('y', 'pixels (image-space, y-down)', `${src}[].y`), data: f64(rows.map((r) => r.y)) },
        { field: nlF('flux', 'ADU (detected total)', `${src}[].flux`), data: f64Nullable(rows.map((r) => r.flux)) },
        { field: nlF('fwhm', 'pixels', `${src}[].fwhm`), data: f64Nullable(rows.map((r) => r.fwhm)) },
        { field: nnF('residual_arcsec', 'arcsec (scalar residual magnitude)', `${src}[].residual_arcsec`), data: f64(rows.map((r) => r.residual_arcsec)) },
        { field: nlF('dx_px', 'pixels (det − predicted, x)', `${src}[].dx_px`), data: f64Nullable(rows.map((r) => r.dx_px)) },
        { field: nlF('dy_px', 'pixels (det − predicted, y)', `${src}[].dy_px`), data: f64Nullable(rows.map((r) => r.dy_px)) },
        { field: nlF('dRA_arcsec', 'arcsec (tangent-plane sky residual, RA)', `${src}[].dRA_arcsec`), data: f64Nullable(rows.map((r) => r.dRA_arcsec)) },
        { field: nlF('dDec_arcsec', 'arcsec (tangent-plane sky residual, Dec)', `${src}[].dDec_arcsec`), data: f64Nullable(rows.map((r) => r.dDec_arcsec)) },
        { field: nlF('peak_r', 'ADU (red channel peak sample)', `${src}[].peak_rgb[0]`), data: f64Nullable(peakR) },
        { field: nlF('peak_g', 'ADU (green channel peak sample)', `${src}[].peak_rgb[1]`), data: f64Nullable(peakG) },
        { field: nlF('peak_b', 'ADU (blue channel peak sample)', `${src}[].peak_rgb[2]`), data: f64Nullable(peakB) },
        { field: nlF('measured_bv', 'magnitude (measured B−V)', `${src}[].measured_bv`), data: f64Nullable(rows.map((r) => r.measured_bv)) },
    ];
    return assembleTable(columns, schemaMetadata('matched_stars', src, receipt.version));
}

// ---------------------------------------------------------------------------
// 2. detections — blind source-extraction output that survived culling.
//    Source: signal.clean_stars (SignalPoint[]).
// ---------------------------------------------------------------------------
export function detectionsTable(receipt: ReceiptLike): Table {
    const rows: DetectionLike[] = receipt.signal?.clean_stars ?? [];
    const src = 'receipt.signal.clean_stars';
    const columns: Column[] = [
        { field: nnI('id', 'detection index', `${src}[].id`), data: i32(rows.map((r) => r.id)) },
        { field: nnF('x', 'pixels (science grid, y-down)', `${src}[].x`), data: f64(rows.map((r) => r.x)) },
        { field: nnF('y', 'pixels (science grid, y-down)', `${src}[].y`), data: f64(rows.map((r) => r.y)) },
        { field: nnF('rawX', 'pixels (native sensor space)', `${src}[].rawX`), data: f64(rows.map((r) => r.rawX)) },
        { field: nnF('rawY', 'pixels (native sensor space)', `${src}[].rawY`), data: f64(rows.map((r) => r.rawY)) },
        { field: nnF('flux', 'ADU (total brightness)', `${src}[].flux`), data: f64(rows.map((r) => r.flux)) },
        { field: nnF('peak', 'ADU (max pixel value)', `${src}[].peak`), data: f64(rows.map((r) => r.peak)) },
        { field: nnF('fwhm', 'pixels', `${src}[].fwhm`), data: f64(rows.map((r) => r.fwhm)) },
        { field: nnF('snr', 'ratio (signal-to-noise)', `${src}[].snr`), data: f64(rows.map((r) => r.snr)) },
        { field: nnF('ellipticity', 'ratio 0(circle)..1(line)', `${src}[].ellipticity`), data: f64(rows.map((r) => r.ellipticity)) },
        { field: nnF('circularity', 'ratio 0(line)..1(circle)', `${src}[].circularity`), data: f64(rows.map((r) => r.circularity)) },
        { field: nnF('theta', 'radians (elongation angle)', `${src}[].theta`), data: f64(rows.map((r) => r.theta)) },
        { field: nlU('culling_reason', 'enum tag (NONE for kept detections)', `${src}[].culling_reason`), data: utf8(rows.map((r) => r.culling_reason ?? null)) },
    ];
    return assembleTable(columns, schemaMetadata('detections', src, receipt.version));
}

// ---------------------------------------------------------------------------
// 3. forced_confirmed — catalog-forced photometry confirmed by the family-wise
//    gate (provenance CATALOG_FORCED_CONFIRMED; never blind discoveries).
//    Source: deep_confirmed.confirmed_stars.
// ---------------------------------------------------------------------------
export function forcedConfirmedTable(receipt: ReceiptLike): Table {
    const rows: ForcedConfirmedLike[] = receipt.deep_confirmed?.confirmed_stars ?? [];
    const src = 'receipt.deep_confirmed.confirmed_stars';
    const columns: Column[] = [
        { field: nnF('x', 'pixels (predicted, image-space)', `${src}[].x`), data: f64(rows.map((r) => r.x)) },
        { field: nnF('y', 'pixels (predicted, image-space)', `${src}[].y`), data: f64(rows.map((r) => r.y)) },
        { field: nlF('mag', 'magnitude (catalog)', `${src}[].mag`), data: f64Nullable(rows.map((r) => r.mag)) },
        { field: nlU('gaia_id', 'Gaia DR3 source id', `${src}[].gaia_id`), data: utf8(rows.map((r) => r.gaia_id)) },
        { field: nnF('snr', 'ratio (aperture SNR)', `${src}[].snr`), data: f64(rows.map((r) => r.snr)) },
        { field: nnF('flux', 'ADU (forced aperture flux)', `${src}[].flux`), data: f64(rows.map((r) => r.flux)) },
        { field: nnF('confidence', 'probability 0..1', `${src}[].confidence`), data: f64(rows.map((r) => r.confidence)) },
    ];
    return assembleTable(columns, schemaMetadata('forced_confirmed', src, receipt.version));
}

// ---------------------------------------------------------------------------
// 4. run_summary — single-row solve scalars + confirmation verdict.
//    Source: receipt.solution (+ confirm_status). Empty (0 rows) when no solve.
// ---------------------------------------------------------------------------
export function runSummaryTable(receipt: ReceiptLike): Table {
    const s = receipt.solution;
    const c = receipt.confirm_status ?? null;
    const src = 'receipt.solution';
    const one = <T,>(v: T): T[] => (s ? [v] : []);

    const columns: Column[] = [
        // THE UNIT TRAP: solve-centre RA is in HOURS, not degrees.
        { field: nnF('ra_hours', 'HOURS (internal RA convention — NOT degrees)', `${src}.ra_hours`, 'multiply by 15 for degrees; cf. matched_stars.ra_deg'), data: f64(one(s?.ra_hours ?? 0)) },
        { field: nnF('dec_degrees', 'degrees', `${src}.dec_degrees`), data: f64(one(s?.dec_degrees ?? 0)) },
        { field: nnF('pixel_scale', 'arcsec/pixel', `${src}.pixel_scale`), data: f64(one(s?.pixel_scale ?? 0)) },
        { field: nnF('roll_degrees', 'degrees', `${src}.roll_degrees`), data: f64(one(s?.roll_degrees ?? 0)) },
        { field: nlU('parity', 'parity token (sign NOT asserted)', `${src}.parity`), data: utf8(one(s?.parity ?? null)) },
        { field: nnF('confidence', 'score 0..1', `${src}.confidence`), data: f64(one(s?.confidence ?? 0)) },
        { field: nnF('fov_width_deg', 'degrees', `${src}.fov_width_deg`), data: f64(one(s?.fov_width_deg ?? 0)) },
        { field: nnF('fov_height_deg', 'degrees', `${src}.fov_height_deg`), data: f64(one(s?.fov_height_deg ?? 0)) },
        { field: nlU('spatial_hash', 'opaque hash string', `${src}.spatial_hash`), data: utf8(one(s?.spatial_hash ?? null)) },
        { field: nlF('mean_fwhm_px', 'pixels', `${src}.mean_fwhm_px`), data: f64Nullable(one(s?.mean_fwhm_px ?? null)) },
        { field: nlF('mean_residual_arcsec', 'arcsec', `${src}.mean_residual_arcsec`), data: f64Nullable(one(s?.mean_residual_arcsec ?? null)) },
        { field: nnI('stars_matched', 'count', `${src}.stars_matched`), data: i32(one(s?.stars_matched ?? 0)) },
        { field: nlF('solve_time_ms', 'milliseconds', `${src}.solve_time_ms`), data: f64Nullable(one(s?.solve_time_ms ?? null)) },
        { field: nlU('confirm_status', 'enum {CONFIRMED,REFUSED,INSUFFICIENT_TARGETS,NOT_RUN}', 'receipt.confirm_status.status'), data: utf8(one(c?.status ?? null)) },
        { field: nlF('confirm_set_excess_z', 'sigma (set-level excess-Z over null)', 'receipt.confirm_status.setExcessZ'), data: f64Nullable(one(c?.setExcessZ ?? null)) },
        { field: nnI('confirm_n_targets', 'count (forced targets examined)', 'receipt.confirm_status.nTargets'), data: i32(one(c?.nTargets ?? 0)) },
        { field: nnI('confirmed_count', 'count (post family-wise gate)', 'receipt.confirm_status.confirmed'), data: i32(one(c?.confirmed ?? 0)) },
        { field: nlU('receipt_schema_version', 'semver string', 'receipt.version'), data: utf8(one(receipt.version ?? null)) },
    ];
    return assembleTable(columns, schemaMetadata('run_summary', src, receipt.version));
}

/** All four tabular products of a run, keyed by table name. */
export function exportAllTables(receipt: ReceiptLike): Record<'matched_stars' | 'detections' | 'forced_confirmed' | 'run_summary', Table> {
    return {
        matched_stars: matchedStarsTable(receipt),
        detections: detectionsTable(receipt),
        forced_confirmed: forcedConfirmedTable(receipt),
        run_summary: runSummaryTable(receipt),
    };
}
