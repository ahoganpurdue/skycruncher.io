/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED STAGE: SCIENCE — SPCC spectrophotometric calibration (C1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL (aperture photometry on the full-res linear RGB frame;
 * catalog truth is read-only input, WCS is never touched).
 *
 * ONE implementation of the SPCC gate + block assembly (design divergence
 * #6 — the single sanctioned C1 behavior change): SPCC used to run only on
 * `runPipeline` (isFits-gated); the wizard DISCARDED its scienceRgb frame
 * so SPCC could never run there. Both pipelines now call `runSpcc`:
 *
 *   - auto path: preview-space matched stars + ScaleManager (previewToNative)
 *   - wizard path: NATIVE-space matched stars (unbinned science buffer) —
 *     scales MUST be null there (1:1 mapping); passing the ScaleManager
 *     would double-scale the aperture centers off the stars.
 *
 * Gate preserved verbatim from the auto path: FITS input AND a retained
 * scienceRgb AND at least one matched star. The <8-usable-stars honesty
 * rule marks the block UNCALIBRATED via the fit validity, never fabricates.
 */

import { computeSpccCalibration, type SpccCalibration } from '../m8_photometry/spcc_calibrator';
import type { SpccBlock } from '../m9_export/serializer';
import type { MatchedStar, CatalogBand } from '../../types/Main_types';
import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import { fitVignettePerBand, type VignetteMap } from '../m10_psf/vignette_map';
import { isQeThroughputEnabled, computeQeThroughput, type QeThroughput } from '../m8_photometry/qe_throughput';
import { findSensorByCamera } from '../m2_hardware/sensor_db';

/**
 * [SCHEMA B] Per-star SPCC photometry surfaced for the receipt `photometry` block.
 * SPCC's per-star measurements (per-channel aperture flux, instrumental mag,
 * instrumental color) were computed but dropped at serialization (only aggregates
 * reached the spcc block). This surfaces them WITHOUT new math. SPCC assumes Gaia G
 * per its header, so cat_g is Gaia G and cat_band is fixed 'GaiaG'.
 */
export interface SpccPerStar {
    gaia_id: string | null;
    x: number;
    y: number;
    /** Per-channel aperture flux (measureApertureRGB), background-subtracted. */
    flux_r: number | null;
    flux_g: number | null;
    flux_b: number | null;
    /** Instrumental magnitude from flux_g (PhotometryManager gain LUT). */
    m_inst: number | null;
    /** Instrumental color −2.5·log10(flux_b/flux_r). */
    inst_color: number | null;
    /** Catalog magnitude (matched.catalog.mag). SPCC treats it as Gaia G in its
     *  fit, but the star's TRUE band is `cat_band` (per row — a HYG-matched star is
     *  Johnson V even though SPCC assumed G). */
    cat_g: number | null;
    /** Catalog BP-RP (matched.catalog.bv). */
    cat_bp_rp: number | null;
    /** [SCHEMA B] The matched star's ACTUAL catalog band (per row, never pooled). */
    cat_band: CatalogBand | null;
    /** True when the star contributed to the SPCC fits. */
    usable: boolean;
}

/**
 * Surface SPCC per-star measurements, index-aligned with the matched stars passed
 * to computeSpccCalibration (cal.stars[i] ↔ matched[i]). Pure surfacing; returns
 * only stars that yielded a usable per-channel measurement (honest — off-frame /
 * saturated stars are dropped, not zero-filled).
 */
export function surfaceSpccPerStar(cal: SpccCalibration, matched: MatchedStar[]): SpccPerStar[] {
    const out: SpccPerStar[] = [];
    const n = Math.min(cal.stars.length, matched.length);
    for (let i = 0; i < n; i++) {
        const s = cal.stars[i];
        const m = matched[i];
        if (!s.measurement) continue; // off-frame / no aperture → honest-absent
        out.push({
            gaia_id: m.catalog.gaia_id ?? null,
            x: m.detected.x,
            y: m.detected.y,
            flux_r: Number.isFinite(s.measurement.flux_r) ? s.measurement.flux_r : null,
            flux_g: Number.isFinite(s.measurement.flux_g) ? s.measurement.flux_g : null,
            flux_b: Number.isFinite(s.measurement.flux_b) ? s.measurement.flux_b : null,
            m_inst: s.mInst,
            inst_color: s.instColor,
            cat_g: Number.isFinite(m.catalog.mag) ? m.catalog.mag : null,
            cat_bp_rp: typeof m.catalog.bv === 'number' && Number.isFinite(m.catalog.bv) ? m.catalog.bv : null,
            cat_band: m.catalog.band ?? null,
            usable: s.usable,
        });
    }
    return out;
}

/** Full-resolution normalized interleaved RGB frame (decoder-owned buffer). */
export interface ScienceRgbFrame {
    data: Float32Array;
    width: number;
    height: number;
}

export interface SpccOutcome {
    /** Full calibration (per-star measurements, fits) — null when gated off. */
    cal: SpccCalibration | null;
    /** Receipt-ready SPCC block — undefined when SPCC did not run. */
    block: SpccBlock | undefined;
}

/**
 * Run SPCC when eligible. `scales` maps detected coords to native pixels:
 * pass the ScaleManager for preview-space detections (auto path) or null
 * for native-space detections (wizard path).
 */
export function runSpcc(
    matchedStars: { detected: { x: number; y: number; fwhm?: number }; catalog: { mag: number; bv?: number } }[],
    scienceRgb: ScienceRgbFrame | null,
    scales: { previewToNative(x: number, y: number): { x: number; y: number } } | null,
    exposureTime: number,
    isFits: boolean,
    airMass: number,
    log?: (msg: string) => void,
    // CELL ④ — camera model for the QE-throughput divide-out. Inert unless the
    // env flag VITE_SPCC_QE_THROUGHPUT is ON (default OFF) ⇒ byte-identical.
    cameraModel?: string | null,
): SpccOutcome {
    const useSpcc = isFits && !!scienceRgb && matchedStars.length > 0;
    if (!useSpcc) return { cal: null, block: undefined };

    // CELL ② — fit the per-band vignette map ONLY when the correction flag is ON
    // (extra compute + it feeds the flux divide). OFF (default) ⇒ null ⇒ the
    // extraction below is byte-identical (both extra args are inert).
    let vignette: VignetteMap | null = null;
    if (PIPELINE_CONSTANTS.PSF_FLUX_VIGNETTE_CORRECT) {
        vignette = fitVignettePerBand(scienceRgb!.data, scienceRgb!.width, scienceRgb!.height);
        log?.(`CELL② vignette per-band fit: r(a2=${vignette.r.a2},a4=${vignette.r.a4}) g(a2=${vignette.g.a2},a4=${vignette.g.a4}) b(a2=${vignette.b.a2},a4=${vignette.b.a4}) [EXPERIMENTAL]`);
    }

    // CELL ④ — resolve the per-band QE throughput ONLY when the flag is ON. OFF
    // (default) ⇒ null ⇒ computeSpccCalibration leaves fluxes untouched (byte-
    // identical). Body without a resolvable qe_curve ⇒ honest SKIP (null), never
    // a fabricated correction.
    let qeThroughput: QeThroughput | null = null;
    if (isQeThroughputEnabled() && cameraModel) {
        qeThroughput = computeQeThroughput(findSensorByCamera(cameraModel));
        if (qeThroughput) {
            log?.(`CELL④ QE throughput ${qeThroughput.sensorModel}: factor r=${qeThroughput.factor.r.toFixed(3)} g=${qeThroughput.factor.g.toFixed(3)} b=${qeThroughput.factor.b.toFixed(3)} [EXPERIMENTAL${qeThroughput.approximate ? ', APPROXIMATE' : ''}]`);
        } else {
            log?.(`CELL④ QE throughput: no resolvable qe_curve for '${cameraModel}' — honest SKIP`);
        }
    }

    const cal = computeSpccCalibration(matchedStars, scienceRgb!, scales, exposureTime, vignette, airMass, qeThroughput);
    if (cal.n_usable < 8) {
        log?.(`SPCC: only ${cal.n_usable} usable stars (<8 required) — photometry marked UNCALIBRATED`);
    }

    const block: SpccBlock = {
        source: cal.colorFit.valid ? 'SPCC_RGB' : 'UNCALIBRATED',
        color_slope: cal.colorFit.slope,
        color_intercept: cal.colorFit.intercept,
        color_r2: cal.colorFit.r2,
        color_rmse: cal.colorFit.rmse,
        zeropoint: cal.zpFit.zeropoint,
        zp_rmse: cal.zpFit.rmse,
        n_stars: cal.n_usable,
        air_mass: airMass,
        fidelity: cal.fidelity,
        // §3.2 render-lane white-balance gains — ALWAYS recorded (record-always,
        // whether or not applied to pixels; the block states its own gate/applied).
        gains: cal.gains,
        // CELL ②③ — honest-or-absent correction provenance (null by default).
        vignette: cal.vignette ?? null,
        extinction: cal.extinction ?? null,
    };

    return { cal, block };
}
