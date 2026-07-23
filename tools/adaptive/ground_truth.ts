/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GROUND TRUTH — pluggable truth source for the knob optimizer (SANDBOX)
 * ═══════════════════════════════════════════════════════════════════════════
 * The optimizer scores detections against "truth". Truth is a PLUGGABLE
 * interface so today's catalog-projected truth can be upgraded, without
 * touching the optimizer, to FORCED-PHOTOMETRY-CONFIRMED truth (the forced-
 * photometry wave in flight) later.
 *
 *   CatalogProjectedGroundTruth  — TODAY. Project the atlas through the solved
 *     WCS (reuse deep_verify.projectCatalogToPixels). Predicted positions =
 *     where real stars must be. Label-noise is real and acknowledged: catalog
 *     completeness, limiting magnitude, proper motion, and edge distortion all
 *     inject error. Honest-or-absent: a detection with no catalog star within
 *     the match radius is only a CONFIDENT false positive when it is brighter
 *     than the catalog limiting magnitude; fainter ⇒ AMBIGUOUS (could be a real
 *     star the catalog does not reach), never silently counted as a miss.
 *
 *   ForcedPhotometryGroundTruth  — FUTURE SEAM (documented, not built). Wraps
 *     deep_verify.forcedMeasure / deepVerifyEscalation to CONFIRM that catalog-
 *     predicted positions carry real flux on THIS frame, promoting projected
 *     truth to measured truth and collapsing the ambiguous band. Same interface
 *     ⇒ a drop-in for the optimizer.
 */

import type { WCSTransform } from '@/engine/types/Main_types';
import { projectCatalogToPixels } from '@/engine/pipeline/m6_plate_solve/deep_verify';

export interface GroundTruthStar {
    x: number;
    y: number;
    mag: number | null;
    gaia_id?: string | null;
}

export interface GroundTruth {
    /** Predicted in-frame star positions (pixel space of the detection grid). */
    stars: GroundTruthStar[];
    /** Faint completeness bound: unmatched detections brighter than this are
     *  CONFIDENT false positives; fainter ones are ambiguous. null ⇒ unknown. */
    limitingMag: number | null;
    source: 'CATALOG_PROJECTED' | 'FORCED_PHOTOMETRY_CONFIRMED';
    note: string;
}

export interface GroundTruthSource {
    readonly name: string;
    build(): Promise<GroundTruth>;
}

export interface CatalogStarLike {
    ra_hours: number;
    dec_degrees: number;
    magnitude_V?: number;
    gaia_id?: string;
}

/**
 * Catalog-projected truth. `catalogStars` are supplied by the caller (queried
 * via StarCatalogAdapter.findStarsInField against the solved center) so this
 * module stays free of the atlas-loading plumbing.
 */
export class CatalogProjectedGroundTruth implements GroundTruthSource {
    readonly name = 'catalog-projected';
    constructor(
        private readonly catalogStars: CatalogStarLike[],
        private readonly wcs: WCSTransform,
        private readonly width: number,
        private readonly height: number,
        private readonly opts: { limitingMagPercentile?: number; withinRadiusPx?: { x: number; y: number; r: number } } = {}
    ) {}

    build(): Promise<GroundTruth> {
        const projected = projectCatalogToPixels({
            stars: this.catalogStars,
            wcs: this.wcs,
            w: this.width,
            h: this.height,
            margin: 8,
            withinRadiusPx: this.opts.withinRadiusPx,
        });
        const stars: GroundTruthStar[] = projected.map(p => ({ x: p.x, y: p.y, mag: p.mag ?? null, gaia_id: p.gaia_id ?? null }));

        // Limiting magnitude = the faint edge of the in-field catalog (the atlas
        // depth here). Trimmed to a high percentile so one faint outlier doesn't
        // inflate the "confident FP" bar. Honest: this is the catalog's reach,
        // not a claim about the sky's true depth.
        const mags = stars.map(s => s.mag).filter((m): m is number => m != null).sort((a, b) => a - b);
        const pct = this.opts.limitingMagPercentile ?? 0.98;
        const limitingMag = mags.length ? mags[Math.min(mags.length - 1, Math.floor(pct * mags.length))] : null;

        return Promise.resolve({
            stars,
            limitingMag,
            source: 'CATALOG_PROJECTED',
            note: `atlas projected through solved WCS; ${stars.length} in-frame; limitingMag≈${limitingMag?.toFixed(2) ?? 'NOT MEASURED'} (p${Math.round(pct * 100)} of in-field catalog mags). Label noise: catalog completeness + limiting mag + edge distortion.`,
        });
    }
}

/**
 * FUTURE SEAM (not built — deferred per task). The forced-photometry wave will
 * confirm each catalog position carries real flux on THIS frame via
 * deep_verify.forcedMeasure, promoting projected truth to measured truth. The
 * constructor signature is sketched so the optimizer can consume it unchanged.
 */
export class ForcedPhotometryGroundTruth implements GroundTruthSource {
    readonly name = 'forced-photometry-confirmed';
    constructor(_deps: {
        lum: Float32Array; width: number; height: number;
        catalogStars: CatalogStarLike[]; wcs: WCSTransform; fwhmPx: number;
    }) {}
    build(): Promise<GroundTruth> {
        // Intentionally unimplemented — the seam exists so the upgrade is a
        // constructor swap, not an optimizer rewrite. See module header.
        throw new Error('ForcedPhotometryGroundTruth: deferred (forced-photometry wave in flight). Use CatalogProjectedGroundTruth today.');
    }
}
