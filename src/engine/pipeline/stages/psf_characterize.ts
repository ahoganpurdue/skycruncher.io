/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED STAGE: PSF CHARACTERIZATION — post-solve, pre-export (M10, PIXEL ledger)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL. Measures the spatially-varying PSF at the SOLVED matched-star
 * positions on the science buffer's OWN grid (native, or 2×2-binned when the
 * Bayer-native path produced a binned buffer) — never resampled before
 * measurement. Reads only the luminance buffer; it NEVER touches the WCS,
 * matched_stars, or the solve confidence (the coordinate ledger the sacred
 * e2e assert on).
 *
 * Both consumers run this ONCE: the wizard (orchestrator_session step5) and the
 * headless local instance (tools/api/headless_driver → the same session steps).
 * Structured as an independently-orderable stage: it shares the post-solve
 * region with the forced-photometry harvest, so the orchestrator sequences them.
 *
 * Honest degradation: no solution / no science buffer / incoherent dims →
 * returns null (the receipt records `psf_field: null`, never a fabricated map).
 */

import { characterizePsfField, type PsfFieldReport } from '../m10_psf/psf_field';
import { fitVignetteLuma } from '../m10_psf/vignette_map';
import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import type { PlateSolution } from '../../types/Main_types';
import type { PipelineEventBus } from '../../events/pipeline_events';

export interface PsfCharacterizeInput {
    /** Science luminance buffer (native or 2×-binned), or null. */
    scienceBuffer: Float32Array | null;
    /** NATIVE image dims (the binned case is derived here). */
    width: number;
    height: number;
    solution: PlateSolution | null;
    events?: PipelineEventBus;
    options?: { stampRadius?: number; maxStars?: number; minPeakSigma?: number };
}

/**
 * Run PSF field characterization at the solved star positions. Pure/sync
 * (CPU/wasm fit — no GPU, headless-safe). Returns null on honest absence.
 */
export function runPsfCharacterization(i: PsfCharacterizeInput): PsfFieldReport | null {
    const lum = i.scienceBuffer;
    if (!lum || !i.solution) return null;

    // Grid disambiguation — identical predicate to runPsfDiagnostics: the
    // science buffer is either native (w·h) or 2×2-binned (⌊w/2⌋·⌊h/2⌋).
    const isBinned = lum.length === (Math.floor(i.width / 2) * Math.floor(i.height / 2))
        && lum.length !== i.width * i.height;
    const bw = isBinned ? Math.floor(i.width / 2) : i.width;
    const bh = isBinned ? Math.floor(i.height / 2) : i.height;
    if (lum.length !== bw * bh) return null; // dims incoherent — skip honestly

    // SOLVED positions = catalog-matched detections, in the science-buffer grid.
    // Exclude planetary-verification sentinels (not stellar PSFs).
    const stars = (i.solution.matched_stars ?? [])
        .filter(m =>
            Number.isFinite(m?.detected?.x) && Number.isFinite(m?.detected?.y) &&
            !((m.catalog?.gaia_id || '').startsWith('planet_')))
        .map(m => ({ x: m.detected.x, y: m.detected.y }));

    // CELL ② — produce a LUMA vignette map ONLY when the correction flag is ON;
    // default OFF ⇒ undefined ⇒ characterizePsfField records no corrected amp
    // (byte-identical). Luminance buffer ⇒ achromatic (magnitude) correction only.
    const vignette = PIPELINE_CONSTANTS.PSF_FLUX_VIGNETTE_CORRECT
        ? fitVignetteLuma(lum, bw, bh)
        : null;

    const report = characterizePsfField({
        lum, width: bw, height: bh, stars,
        options: i.options,
        vignette,
        events: i.events
    });
    report.grid = isBinned ? 'SCIENCE_BINNED2X' : 'SCIENCE_NATIVE';
    return report;
}

/**
 * Compact, JSON-ready PSF-field block for the receipt (the spatially-varying
 * map + aggregate medians; the raw per-star fits stay a diagnostic detail).
 * Every number is honest-or-null.
 */
export function serializePsfFieldBlock(r: PsfFieldReport): Record<string, any> {
    return {
        ledger: r.ledger,
        method: r.method,
        grid: r.grid ?? null,
        stamp_size: r.stampSize,
        n_input: r.nInput,
        n_fit: r.nFit,
        n_lm: r.nLm,
        n_moment: r.nMoment,
        fwhm_median_maj_px: r.fwhmMedianMajPx,
        fwhm_median_min_px: r.fwhmMedianMinPx,
        ellipticity_median: r.ellipticityMedian,
        orientation_median_deg: r.orientationMedianDeg,
        // 3×3 coma/astigmatism map, row-major top-left → bottom-right.
        regions: r.regions,
        approximate: r.approximate,
        not_measured: r.notMeasured ?? null
    };
}
