// ═══════════════════════════════════════════════════════════════════════════
// UW DEEP EVIDENCE — atlas paging wrapper for the tight-reverify tier (variant A)
// ═══════════════════════════════════════════════════════════════════════════
// Round-1 measured the tier starves on the wide-net BRIGHT subset (~10-16 pairs):
// a >16 deg ultra-wide field SKIPS deep-sector paging entirely
// (solver_entry.ts:379-382 — "deep catalog skipped (L1/L2 only)"), so the fit
// never sees enough pairs. This wrapper repairs the EVIDENCE SOURCE without
// touching the pure tier math: it pages a SAMPLED atlas pattern over the candidate
// footprint (center + the four frame corners, each a <=SECTOR_LOAD_MAX_RADIUS_DEG
// disk — physics-honest, well-distributed), pools the loaded DEEP rows, wide-matches
// the FULL detection list against them for >=100 fit pairs, and hands the deep
// catalog + deep matches to the pure runUwTightReverify core.
//
// FAIL-SOFT: any paging/fetch error -> null (caller falls back / declines). The
// atlas singleton caches sectors, so repeated candidate fires re-page cheaply.
// TWO-LEDGER: coordinate-space only; the science buffer is never touched here.
// ═══════════════════════════════════════════════════════════════════════════

import { SkyTransform } from '../../core/SkyTransform';
import { StarCatalogAdapter } from './star_catalog_adapter';
import { deepWideMatch, runUwTightReverify, type UwTightReverifyConfig, type UwTightReverifyResult } from './uw_tight_reverify';
import type { DetectedStar, WCSTransform } from '../../types/Main_types';
import type { StandardStar } from './standard_stars';

const J2000_JD = 2451545.0; // nominal epoch for the deep fetch (PM over ~25yr << 1px at UW scale)

export interface UwDeepEvidenceResult {
    result: UwTightReverifyResult;
    deepCatCount: number;
    deepMatchCount: number;
    pagedPositions: number;
}

/**
 * Page a sampled atlas pattern over the candidate footprint, pool the deep rows,
 * wide-match the full detection set, and run the pure tier on that deep evidence.
 * Returns null on any failure (fail-soft).
 */
export async function runUwTightReverifyDeep(args: {
    wcs: WCSTransform;
    detected: DetectedStar[];
    imageW: number;
    imageH: number;
    safeScale: number;
    baseNetPx: number;
    wideSlope: number;
    opticalCenterX: number;
    opticalCenterY: number;
    /** Per-position paging radius (deg), <= SECTOR_LOAD_MAX_RADIUS_DEG. */
    pageDeg: number;
    /** Brightest-N cap on the pooled deep catalog (compute guard). */
    deepCatCap: number;
    config: UwTightReverifyConfig;
}): Promise<UwDeepEvidenceResult | null> {
    const { wcs, detected, imageW, imageH, safeScale, baseNetPx, wideSlope, opticalCenterX, opticalCenterY, pageDeg, deepCatCap, config } = args;
    try {
        const adapter = StarCatalogAdapter.getinstance();

        // Sampled pattern: candidate center + the four frame corners projected to sky.
        const corners: Array<[number, number]> = [
            [(imageW - 1) / 2, (imageH - 1) / 2],
            [0, 0], [imageW - 1, 0], [0, imageH - 1], [imageW - 1, imageH - 1],
        ];
        const positions: Array<{ ra: number; dec: number }> = [];
        for (const [px, py] of corners) {
            const sky = SkyTransform.pixelToSky(px, py, wcs);
            if (sky && Number.isFinite(sky.ra_hours) && Number.isFinite(sky.dec_degrees)) {
                positions.push({ ra: sky.ra_hours, dec: sky.dec_degrees });
            }
        }
        if (positions.length === 0) return null;

        // Page deep sectors around each sampled position (idempotent / cached).
        for (const pos of positions) {
            await adapter.ensureSectorLoaded(pos.ra, pos.dec, Math.min(pageDeg, 16));
        }

        // Pool the deep in-footprint catalog about the candidate center.
        const halfDiagDeg = (Math.hypot(imageW, imageH) * safeScale / 3600) / 2 + 2;
        let deepCat: StandardStar[] = await adapter.findStarsInField(wcs.crval[0], wcs.crval[1], halfDiagDeg, J2000_JD);
        if (!deepCat || deepCat.length === 0) return null;

        // Brightest-N cap for compute safety (the fit + tight passes iterate this).
        if (deepCat.length > deepCatCap) {
            deepCat = [...deepCat].sort((a, b) => (a.magnitude_V ?? 99) - (b.magnitude_V ?? 99)).slice(0, deepCatCap);
        }

        // Deep wide-match the FULL detection list against the deep catalog -> fit pairs.
        const deepMatches = deepWideMatch({
            wcs, catalog: deepCat, detected, imageW, imageH, safeScale,
            baseNetPx, wideSlope, opticalCenterX, opticalCenterY,
        });

        const result = runUwTightReverify({
            wcs, catalogStars: deepCat, detected, imageW, imageH, safeScale,
            wideMatches: deepMatches, config,
        });

        return { result, deepCatCount: deepCat.length, deepMatchCount: deepMatches.length, pagedPositions: positions.length };
    } catch (e) {
        console.warn(`[PlateSolver] [UW-DEEP-EVIDENCE] paging/match failed, tier falls back: ${(e as any)?.message ?? e}`);
        return null;
    }
}
