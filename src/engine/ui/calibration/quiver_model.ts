/**
 * -----------------------------------------------------------------
 * RESIDUAL QUIVER MODEL — catalog-projected -> observed vectors
 * -----------------------------------------------------------------
 * Pure data preparation for the step-6 residual vector field. Projects every
 * verified (sentinel-filtered) matched star through the LINEAR WCS via the
 * same ResidualAnalyzer convention the M7 fit used, and derives honest
 * display statistics (RMS, median, labeled magnification). No React.
 */

import { PlateSolution } from '../../types/Main_types';
import { ResidualAnalyzer } from '../../pipeline/m7_astrometry/residual_analyzer';
import { quiverMagnification } from './chart_math';

export interface QuiverArrow {
    px: number; py: number;   // catalog-projected (linear WCS), solve-buffer px
    dx: number; dy: number;   // observed - projected (px)
    mag: number;
    id?: string;
    gmag?: number;
}

export interface QuiverModel {
    arrows: QuiverArrow[];
    rmsPx: number;
    medianPx: number;
    magnification: number;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    outlierCount: number;
    outlierLimitPx: number;
}

/** Shared display-statistics tail: rms / median / labeled magnification / outliers /
 *  bbox from a built arrow set. ONE home for the quiver stats math (LAW 4) — both the
 *  live-solution builder and the receipt-fed builder finalize through here, so the
 *  step-6 quiver and the Widget-Shelf quiver are statistically identical. Null when
 *  too few usable arrows (< 15) survived. */
function finalizeQuiverModel(
    arrows: QuiverArrow[],
    bbox: { minX: number; minY: number; maxX: number; maxY: number },
): QuiverModel | null {
    if (arrows.length < 15) return null;
    const mags = arrows.map(a => a.mag).sort((a, b) => a - b);
    const medianPx = mags[mags.length >> 1];
    const rmsPx = Math.sqrt(arrows.reduce((s, a) => s + a.mag * a.mag, 0) / arrows.length);
    const diag = Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) || 1;
    const magnification = quiverMagnification(medianPx, 0.03 * diag);
    const outlierLimitPx = 5 * medianPx;
    const outlierCount = medianPx > 0 ? arrows.filter(a => a.mag > outlierLimitPx).length : 0;
    return { arrows, rmsPx, medianPx, magnification, bbox, outlierCount, outlierLimitPx };
}

/** Build the quiver model from the solved matches. Pure; null when unusable. */
export function buildQuiverModel(solution: PlateSolution): QuiverModel | null {
    const wcs = solution?.wcs;
    if (!wcs?.crpix || !wcs?.cd || !wcs?.crval) return null;
    const matches = (solution.matched_stars ?? []).filter(m =>
        Number.isFinite(m.residual_arcsec) &&
        m.residual_arcsec < 999 &&
        !(m.catalog?.gaia_id || '').startsWith('planet_')
    );
    if (matches.length < 15) return null;

    const arrows: QuiverArrow[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of matches) {
        const p = ResidualAnalyzer.skyToLinearPixel(m.catalog.ra, m.catalog.dec, wcs);
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const dx = m.detected.x - p.x;
        const dy = m.detected.y - p.y;
        arrows.push({ px: p.x, py: p.y, dx, dy, mag: Math.hypot(dx, dy), id: m.catalog.gaia_id, gmag: m.catalog.mag });
        minX = Math.min(minX, p.x, m.detected.x); maxX = Math.max(maxX, p.x, m.detected.x);
        minY = Math.min(minY, p.y, m.detected.y); maxY = Math.max(maxY, p.y, m.detected.y);
    }
    return finalizeQuiverModel(arrows, { minX, minY, maxX, maxY });
}

/** One serialized receipt matched-star row (the SCHEMA A subset the quiver needs).
 *  `dx_px`/`dy_px` are the LINEAR verify residual (det − predicted) banked at solve
 *  time — the SAME quantity buildQuiverModel re-projects — so the receipt quiver is a
 *  faithful reconstruction WITHOUT re-projecting through the WCS. */
export interface ReceiptQuiverStar {
    x: number; y: number;
    dx_px?: number | null; dy_px?: number | null;
    residual_arcsec?: number | null;
    gaia_id?: string | null;
    mag?: number | null;
}

/** Build the quiver model from a RECEIPT's `solution.matched_stars` (pure read; no
 *  re-projection — the projected position is detected − residual). Same 15-arrow floor
 *  and stats as the live builder. Null when unusable (no residual vectors / too few). */
export function buildQuiverModelFromReceipt(matchedStars: ReceiptQuiverStar[] | null | undefined): QuiverModel | null {
    if (!Array.isArray(matchedStars)) return null;
    const arrows: QuiverArrow[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of matchedStars) {
        // Same sentinel + planet filter as the live builder.
        if (!Number.isFinite(m.residual_arcsec) || (m.residual_arcsec as number) >= 999) continue;
        if ((m.gaia_id || '').startsWith('planet_')) continue;
        const dx = m.dx_px, dy = m.dy_px;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue; // no banked residual vector
        if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
        const px = m.x - (dx as number);   // projected = detected − residual
        const py = m.y - (dy as number);
        arrows.push({ px, py, dx: dx as number, dy: dy as number, mag: Math.hypot(dx as number, dy as number),
                      id: m.gaia_id ?? undefined, gmag: (typeof m.mag === 'number' ? m.mag : undefined) });
        minX = Math.min(minX, px, m.x); maxX = Math.max(maxX, px, m.x);
        minY = Math.min(minY, py, m.y); maxY = Math.max(maxY, py, m.y);
    }
    return finalizeQuiverModel(arrows, { minX, minY, maxX, maxY });
}
