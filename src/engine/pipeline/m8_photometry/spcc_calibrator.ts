/**
 * SPCC CALIBRATOR — Spectrophotometric Color Calibration (M8)
 * ═════════════════════════════════════════════════════════════════════════
 * [Module: M8] [Domain: PhotometricSolution]
 *
 * Fits the instrumental color response against Gaia catalog truth:
 *   1. Color regression:  catBpRp = slope · instColor + intercept
 *      where instColor = −2.5·log10(flux_b / flux_r)
 *   2. Zero-point fit:    zp = clipped median(catG − mInst)
 *
 * Catalog truth per matched star (see solver_entry.ts verifyWCS):
 *   matched.catalog.bv  IS Gaia BP-RP (unconditionally TRUE since the 2026-07-22
 *   Gaia-pure sector cutover — the legacy HYG rows' spectralTypeToBpRp()
 *   APPROXIMATION fallback in star_catalog_adapter is extinct with them)
 *   matched.catalog.mag IS Gaia G
 *
 * The zero-point regression absorbs the absolute error of the gain LUT
 * (and single-frame extinction); `air_mass` is recorded upstream for
 * future multi-frame extinction solves.
 */

import { PhotometryManager } from './photometry_manager';
import { measureApertureRGB, type RgbApertureMeasurement } from './rgb_aperture_photometry';
import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import { gainAt, serializeVignetteMap, type VignetteMap } from '../m10_psf/vignette_map';
import { isQeThroughputEnabled, type QeThroughput } from './qe_throughput';

// ─── TYPES ────────────────────────────────────────────────────────────

export interface ColorSample {
    /** Instrumental color: −2.5·log10(flux_b/flux_r) */
    instColor: number;
    /** Catalog BP-RP */
    catBpRp: number;
}

export interface ColorFit {
    valid: boolean;
    slope: number;
    intercept: number;
    r2: number;
    rmse: number;
    n_used: number;
}

export interface ZeroPointSample {
    /** Catalog Gaia G magnitude */
    catG: number;
    /** Instrumental magnitude */
    mInst: number;
}

export interface ZeroPointFit {
    valid: boolean;
    zeropoint: number;
    rmse: number;
    n_used: number;
}

/** Per-star SPCC measurement, index-aligned with the input matched stars. */
export interface SpccStarMeasurement {
    measurement: RgbApertureMeasurement | null;
    /** Instrumental color, or null when flux_b/flux_r unusable */
    instColor: number | null;
    /** Instrumental magnitude (G-channel), or null when flux_g unusable */
    mInst: number | null;
    /** True when the star contributed samples to the fits */
    usable: boolean;
}

export interface SpccCalibration {
    valid: boolean;
    colorFit: ColorFit;
    zpFit: ZeroPointFit;
    stars: SpccStarMeasurement[];
    /** Stars that passed exclusion (saturation / positivity / frame bounds) */
    n_usable: number;
    /** Color-fidelity report (survivor vs unclipped + TLS/EIV bracket) — MEASURED
     *  evidence, never a gate. null when the color fit is invalid. */
    fidelity: ColorFidelity | null;
    /** SPCC-derived render-lane white-balance gains (COLOR_MATH_PROGRAM §3.2).
     *  ALWAYS present when SPCC ran — carries its own quality gate + `applied`
     *  flag (record-always; application is render-lane / PIXEL ledger only).
     *  NEVER affects `valid` (that stays a function of the color/zero-point fits —
     *  LAW 2: no gate drift, gains are additive evidence). */
    gains: SpccChannelGains;
    /** CELL ② — the per-band vignette/transmission map whose gains DIVIDED the
     *  extracted per-star fluxes feeding the color/zp/gain fits, or null when
     *  PSF_FLUX_VIGNETTE_CORRECT was OFF (default) / no map supplied. Additive,
     *  honest-or-absent; fit_rms per band is the propagated flux uncertainty. */
    vignette?: Record<string, unknown> | null;
    /** CELL ③ — the per-star atmospheric-extinction correction applied to the
     *  fluxes feeding the zero-point, or null when PSF_FLUX_EXTINCTION_CORRECT was
     *  OFF (default) / no airmass. {k, k_source, airmass, applied}. Additive. */
    extinction?: {
        k: number; k_source: 'DEFAULT' | 'MEASURED'; airmass: number; applied: boolean; note: string;
    } | null;
    /** CELL ④ — the per-band sensor-QE throughput divide-out (×1/QE at the R/G/B
     *  representative wavelengths) applied to the extracted per-star fluxes feeding
     *  the color/zp/gain fits, or null when SPCC_QE_THROUGHPUT was OFF (default) /
     *  no qe_curve resolved. Additive, honest-or-absent; `approximate` carries the
     *  sensor_db APPROXIMATE label. NOT serialized into the receipt this wave (the
     *  receipt bump is a separate lane — a rider for the next receipt train). */
    qe?: {
        factor: { r: number; g: number; b: number };
        qe: { r: number; g: number; b: number };
        wavelength_nm: { r: number; g: number; b: number };
        sensor_model: string;
        approximate: boolean;
        applied: boolean;
        note: string;
    } | null;
}

interface MatchedStarLike {
    detected: { x: number; y: number; fwhm?: number };
    catalog: { mag: number; bv?: number };
}

interface ScalesLike {
    previewToNative(x: number, y: number): { x: number; y: number };
}

// ─── FITTING ──────────────────────────────────────────────────────────

const INVALID_COLOR_FIT: ColorFit = { valid: false, slope: 1, intercept: 0, r2: 0, rmse: 0, n_used: 0 };
const INVALID_ZP_FIT: ZeroPointFit = { valid: false, zeropoint: 0, rmse: 0, n_used: 0 };

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Robust 1-D linear regression with k-sigma outlier clipping.
 * Model: catBpRp = slope · instColor + intercept
 */
export function fitColorRegression(
    samples: ColorSample[],
    opts: { sigmaClip?: number; maxIter?: number; minStars?: number } = {}
): ColorFit {
    const sigmaClip = opts.sigmaClip ?? 2.5;
    const maxIter = opts.maxIter ?? 3;
    const minStars = opts.minStars ?? 8;

    let active = samples.slice();
    let slope = 1;
    let intercept = 0;

    for (let iter = 0; iter < maxIter; iter++) {
        if (active.length < minStars) return { ...INVALID_COLOR_FIT, n_used: active.length };

        // Closed-form least squares
        const n = active.length;
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const s of active) {
            sx += s.instColor;
            sy += s.catBpRp;
            sxx += s.instColor * s.instColor;
            sxy += s.instColor * s.catBpRp;
        }
        const denom = n * sxx - sx * sx;
        if (Math.abs(denom) < 1e-12) return { ...INVALID_COLOR_FIT, n_used: n };
        slope = (n * sxy - sx * sy) / denom;
        intercept = (sy - slope * sx) / n;

        // k-sigma clip on residuals
        const residuals = active.map(s => s.catBpRp - (slope * s.instColor + intercept));
        const sigma = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / n);
        if (sigma <= 1e-12) break;

        const kept = active.filter((_, i) => Math.abs(residuals[i]) <= sigmaClip * sigma);
        if (kept.length === active.length) break; // converged
        active = kept;
    }

    if (active.length < minStars) return { ...INVALID_COLOR_FIT, n_used: active.length };

    // Final statistics on the surviving set
    const n = active.length;
    const meanY = active.reduce((a, s) => a + s.catBpRp, 0) / n;
    let ssRes = 0, ssTot = 0;
    for (const s of active) {
        const r = s.catBpRp - (slope * s.instColor + intercept);
        ssRes += r * r;
        ssTot += (s.catBpRp - meanY) ** 2;
    }
    const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : 0;
    const rmse = Math.sqrt(ssRes / n);

    return { valid: true, slope, intercept, r2, rmse, n_used: n };
}

/**
 * Robust zero-point fit: zp = clipped median(catG − mInst),
 * rmse = 1.4826 · MAD (robust sigma estimate).
 */
export function fitZeroPoint(
    samples: ZeroPointSample[],
    opts: { sigmaClip?: number; minStars?: number } = {}
): ZeroPointFit {
    const sigmaClip = opts.sigmaClip ?? 2.5;
    const minStars = opts.minStars ?? 5;

    let diffs = samples.map(s => s.catG - s.mInst);
    if (diffs.length < minStars) return { ...INVALID_ZP_FIT, n_used: diffs.length };

    let zp = median(diffs);
    let mad = median(diffs.map(d => Math.abs(d - zp)));
    let sigma = 1.4826 * mad;

    if (sigma > 1e-12) {
        const clipped = diffs.filter(d => Math.abs(d - zp) <= sigmaClip * sigma);
        if (clipped.length >= minStars && clipped.length < diffs.length) {
            diffs = clipped;
            zp = median(diffs);
            mad = median(diffs.map(d => Math.abs(d - zp)));
            sigma = 1.4826 * mad;
        }
    }

    return { valid: true, zeropoint: zp, rmse: sigma, n_used: diffs.length };
}

// ─── ORCHESTRATION ────────────────────────────────────────────────────

/**
 * COLOR-FIDELITY REPORT SURFACE (Tier-2 §4.1 of docs/COLOR_MATH_PROGRAM.md).
 * Promotes the SPCC color regression from raw slope/r2 telemetry to a MEASURED
 * report block — the honest bracket around the engine's survivor-only OLS fit:
 *   • unclipped r2/rmse on the FULL sample set (survivor stats are optimistic);
 *   • a TLS / errors-in-variables slope (OLS attenuates the slope toward zero
 *     because the instrumental-color PREDICTOR is noisy — the f4dbca9 audit).
 * EVIDENCE, never a gate: `validated` is always null and channel-gain application
 * is explicitly NOT derived from the slope (unsound until a real EIV fit lands).
 * N=1 (SeeStar) today — RESEARCH, not a trusted product.
 */
export interface ColorFidelity {
    /** survivor-set r2 (= colorFit.r2 — σ-clipped, OPTIMISTIC). */
    r2_survivor: number;
    /** full-set r2 against the fitted line (no σ-clip — the honest view). */
    r2_unclipped: number;
    /** survivor-set rmse (mag). */
    rmse_survivor_mag: number;
    /** full-set rmse (mag). */
    rmse_unclipped_mag: number;
    /** OLS slope (engine direction; attenuated by errors-in-variables). */
    slope_ols: number;
    /** total-least-squares slope (bias-corrected, steeper), or null. */
    slope_tls: number | null;
    /** [ols_yx, rev_yx] slope bracket, or null. */
    slope_bracket: [number, number] | null;
    /** slope_tls / slope_bracket[0] — denominator is the FULL-sample unclipped
     *  OLS slope (ols_yx), NOT the σ-clipped `slope_ols` field, so recomputing
     *  from slope_tls/slope_ols gives a different number
     *  (>1 ⇒ OLS under-estimates the slope), or null. */
    attenuation_ratio: number | null;
    /** number of color samples in the fit. */
    n_samples: number;
    /** research bar tag — NEVER an enforced gate. */
    bar: 'RESEARCH_N1';
    /** ALWAYS null: color fidelity is a MEASURED report surface, not a gate. */
    validated: null;
}

/**
 * Compute the color-fidelity report from the color samples + the engine's fit.
 * Pure statistics over data the SPCC fit already used; touches nothing else.
 */
export function computeColorFidelity(samples: ColorSample[], colorFit: ColorFit): ColorFidelity {
    const n = samples.length;
    // full-set (unclipped) stats against the engine's fitted line
    const my = n > 0 ? samples.reduce((a, s) => a + s.catBpRp, 0) / n : 0;
    let ssRes = 0, ssTot = 0;
    for (const s of samples) {
        const r = s.catBpRp - (colorFit.slope * s.instColor + colorFit.intercept);
        ssRes += r * r; ssTot += (s.catBpRp - my) ** 2;
    }
    const r2_unclipped = ssTot > 1e-12 ? 1 - ssRes / ssTot : 0;
    const rmse_unclipped = n > 0 ? Math.sqrt(ssRes / n) : 0;

    // TLS / errors-in-variables slope bracket (centered moments)
    let slope_tls: number | null = null;
    let slope_bracket: [number, number] | null = null;
    let attenuation_ratio: number | null = null;
    if (n >= 3) {
        let mx = 0, myy = 0;
        for (const s of samples) { mx += s.instColor; myy += s.catBpRp; }
        mx /= n; myy /= n;
        let sxx = 0, syy = 0, sxy = 0;
        for (const s of samples) {
            const dx = s.instColor - mx, dy = s.catBpRp - myy;
            sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
        }
        if (Math.abs(sxy) > 1e-12 && sxx > 1e-12) {
            const ols_yx = sxy / sxx;
            const rev_yx = syy / sxy;
            slope_tls = (syy - sxx + Math.sqrt((syy - sxx) ** 2 + 4 * sxy * sxy)) / (2 * sxy);
            slope_bracket = [ols_yx, rev_yx];
            attenuation_ratio = ols_yx !== 0 ? slope_tls / ols_yx : null;
        }
    }

    return {
        r2_survivor: colorFit.r2,
        r2_unclipped,
        rmse_survivor_mag: colorFit.rmse,
        rmse_unclipped_mag: rmse_unclipped,
        slope_ols: colorFit.slope,
        slope_tls,
        slope_bracket,
        attenuation_ratio,
        n_samples: n,
        bar: 'RESEARCH_N1',
        validated: null,
    };
}

// ─── CHANNEL-GAIN ESTIMATOR (COLOR_MATH_PROGRAM §3.2) ──────────────────────
//
// SPCC-grounded white balance, DERIVED for the render lane (PIXEL ledger). The
// existing STF stretch white-balances by assuming "the bright-star ensemble is
// white" (ImageProcessor star-ensemble-white heuristic). That is the biased
// assumption SPCC exists to replace: here we FIT the per-channel gains that make
// a catalog white-reference star (BP-RP = whiteRefBpRp, A0V/Vega ≈ 0) render
// neutral, from the matched stars' measured per-channel flux vs Gaia BP-RP.
//
// ESTIMATOR = TLS (total least squares / errors-in-variables), NEVER OLS. Both
// the instrumental color (photon noise) and the catalog color (intrinsic RGB↔
// Gaia bandpass scatter) carry error; OLS(color|BP-RP) attenuates the slope
// toward zero (~33% low — the 0afe8c9 audit, TLS slope 1.326 vs attenuated OLS),
// which would bias the gains. TLS is the direction-symmetric principal-axis fit.

/** Per-star input to the channel-gain fit: background-subtracted per-channel
 *  aperture flux + catalog BP-RP color. Built for USABLE stars only. */
export interface ChannelGainSample {
    flux_r: number;
    flux_g: number;
    flux_b: number;
    catBpRp: number;
}

/** SPCC-derived render-lane white-balance gains (PIXEL ledger). Multiplicative,
 *  applied in the LINEAR domain, normalized to GREEN = 1 (astro/Bayer WB
 *  convention — green is the luminance-dominant anchor). ALWAYS recorded. */
export interface SpccChannelGains {
    /** [g_R, g_G, g_B] with g_G == 1. Identity [1,1,1] when the fit is invalid. */
    gains: [number, number, number];
    /** estimator tag — ALWAYS 'TLS' (never OLS; see header). */
    method: 'TLS';
    /** survivor stars used in the fit (post fidelity-gate σ-clip). */
    nStars: number;
    /** binding fit quality = min(r² of the b−r and g−r TLS color axes). */
    r2: number;
    /** TLS slope of the b−r instrumental color vs BP-RP (slope-sanity quantity). */
    slope_br: number;
    /** TLS slope of the g−r instrumental color vs BP-RP. */
    slope_gr: number;
    /** per-channel fractional 1σ gain uncertainty [R,G,B] (G is the anchor ⇒ 0). */
    uncertainty: [number, number, number];
    /** the white-reference BP-RP the gains neutralize to (A0V ≈ 0). */
    whiteRefBpRp: number;
    /** TRUE only when valid AND the quality gate passed AND application is enabled.
     *  The render lane reads THIS flag; record-only otherwise (honest fallback). */
    applied: boolean;
    /** quality-gate verdict — recorded even when applied is false (LAW 3). */
    gate: { passed: boolean; reason: string };
}

/** Tunable gate + reference for the channel-gain fit (read from PIPELINE_CONSTANTS
 *  at the orchestration layer; the estimator stays PURE for unit tests). */
export interface ChannelGainConfig {
    whiteRefBpRp: number;
    minStars: number;
    minR2: number;
    slopeMin: number;
    slopeMax: number;
    minGain: number;
    maxGain: number;
    applyEnabled: boolean;
    sigmaClip?: number;
    maxIter?: number;
}

/**
 * Total-least-squares (orthogonal / errors-in-variables) line fit y = a + b·x.
 * Principal-axis slope — the same closed form used by computeColorFidelity.
 * Returns null when the geometry is degenerate (no color spread).
 */
function fitTLS(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number; rmse: number } | null {
    const n = xs.length;
    if (n < 3) return null;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = ys[i] - my;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    if (!(Math.abs(sxy) > 1e-12) || !(sxx > 1e-12)) return null;
    const slope = (syy - sxx + Math.sqrt((syy - sxx) ** 2 + 4 * sxy * sxy)) / (2 * sxy);
    const intercept = my - slope * mx;
    let ssRes = 0;
    for (let i = 0; i < n; i++) {
        const r = ys[i] - (slope * xs[i] + intercept);
        ssRes += r * r;
    }
    const r2 = syy > 1e-12 ? 1 - ssRes / syy : 0;
    const rmse = Math.sqrt(ssRes / n);
    return { slope, intercept, r2, rmse };
}

/**
 * Reproduce the fidelity-gate SURVIVOR set: the indices kept after
 * fitColorRegression's iterative OLS k-σ clip on the b−r color residual. The
 * SELECTION mirrors the SPCC color fit exactly (OLS clip) so the gains are fit
 * on the SAME survivors; the gains themselves are then fit with TLS. Pure.
 */
function selectColorSurvivors(
    instColor: number[], catBpRp: number[],
    opts: { sigmaClip: number; maxIter: number; minStars: number }
): number[] {
    let idx = instColor.map((_, i) => i);
    for (let iter = 0; iter < opts.maxIter; iter++) {
        if (idx.length < opts.minStars) return idx;
        const n = idx.length;
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const i of idx) {
            sx += instColor[i]; sy += catBpRp[i];
            sxx += instColor[i] * instColor[i]; sxy += instColor[i] * catBpRp[i];
        }
        const denom = n * sxx - sx * sx;
        if (Math.abs(denom) < 1e-12) return idx;
        const slope = (n * sxy - sx * sy) / denom;
        const intercept = (sy - slope * sx) / n;
        const resid = idx.map(i => catBpRp[i] - (slope * instColor[i] + intercept));
        const sigma = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / n);
        if (sigma <= 1e-12) return idx;
        const kept = idx.filter((_, k) => Math.abs(resid[k]) <= opts.sigmaClip * sigma);
        if (kept.length === idx.length) return idx; // converged
        idx = kept;
    }
    return idx;
}

/**
 * Fit the per-channel render white-balance gains via TLS on the survivor star
 * set. DETERMINISTIC + unbiased (LAW: TLS never OLS). Derivation:
 *   For each survivor, form the instrumental colors
 *     y_br = −2.5·log10(flux_b/flux_r),  y_gr = −2.5·log10(flux_g/flux_r).
 *   TLS-fit each vs catalog BP-RP → color at the white reference x0:
 *     c_br0 = a_br + b_br·x0,  c_gr0 = a_gr + b_gr·x0.
 *   Gains neutralize a white-ref star (corrected m_b−m_r = m_g−m_r = 0 at x0):
 *     g_B/g_R = 10^(c_br0/2.5),  g_G/g_R = 10^(c_gr0/2.5), then renormalize G=1.
 * Always returns a record (identity gains when invalid); `gate`/`applied` state
 * the quality verdict. NEVER throws.
 */
export function fitChannelGains(samples: ChannelGainSample[], cfg: ChannelGainConfig): SpccChannelGains {
    const invalid = (reason: string, n: number): SpccChannelGains => ({
        gains: [1, 1, 1], method: 'TLS', nStars: n, r2: 0, slope_br: NaN, slope_gr: NaN,
        uncertainty: [0, 0, 0], whiteRefBpRp: cfg.whiteRefBpRp, applied: false,
        gate: { passed: false, reason },
    });

    // Positive-flux, finite-color samples only (log needs strictly positive flux).
    const valid = samples.filter(s =>
        s.flux_r > 0 && s.flux_g > 0 && s.flux_b > 0 && Number.isFinite(s.catBpRp));
    if (valid.length < cfg.minStars) return invalid(`n<${cfg.minStars}`, valid.length);

    // Survivor set = fidelity-gate OLS σ-clip on the b−r color (mirrors the fit).
    const instColor = valid.map(s => -2.5 * Math.log10(s.flux_b / s.flux_r));
    const catBpRp = valid.map(s => s.catBpRp);
    const keep = selectColorSurvivors(instColor, catBpRp, {
        sigmaClip: cfg.sigmaClip ?? 2.5, maxIter: cfg.maxIter ?? 3, minStars: cfg.minStars,
    });
    if (keep.length < cfg.minStars) return invalid(`survivors<${cfg.minStars}`, keep.length);

    const surv = keep.map(i => valid[i]);
    const x = surv.map(s => s.catBpRp);
    const yBR = surv.map(s => -2.5 * Math.log10(s.flux_b / s.flux_r));
    const yGR = surv.map(s => -2.5 * Math.log10(s.flux_g / s.flux_r));

    const fBR = fitTLS(x, yBR);
    const fGR = fitTLS(x, yGR);
    if (!fBR || !fGR) return invalid('degenerate', surv.length);

    const x0 = cfg.whiteRefBpRp;
    const cBR0 = fBR.intercept + fBR.slope * x0; // b−r color at the white ref
    const cGR0 = fGR.intercept + fGR.slope * x0; // g−r color at the white ref

    // Gains that neutralize the white-ref star, renormalized so green == 1.
    const gR = Math.pow(10, -cGR0 / 2.5);          // g_R / g_G
    const gB = Math.pow(10, (cBR0 - cGR0) / 2.5);  // g_B / g_G
    const gains: [number, number, number] = [gR, 1, gB];

    // Fractional 1σ gain uncertainty from the color-fit scatter at the ref
    // (σ_gain/gain ≈ ln10/2.5 · σ_color, σ_color ≈ rmse/√n). Green anchor ⇒ 0.
    const k = Math.log(10) / 2.5;
    const uncertainty: [number, number, number] = [
        k * fGR.rmse / Math.sqrt(surv.length),
        0,
        k * fBR.rmse / Math.sqrt(surv.length),
    ];
    const r2 = Math.min(fBR.r2, fGR.r2);

    // ── QUALITY GATE (render-lane; RESEARCH-calibrated — see pipeline_config) ──
    let reason = 'PASS';
    if (surv.length < cfg.minStars) reason = `survivors<${cfg.minStars}`;
    else if (!Number.isFinite(r2) || r2 < cfg.minR2) reason = `r2<${cfg.minR2}`;
    else if (!(fBR.slope >= cfg.slopeMin && fBR.slope <= cfg.slopeMax)) reason = `slope∉[${cfg.slopeMin},${cfg.slopeMax}]`;
    // g−r slope: SAME bound as b−r (ultracode HELD #22 — the g−r TLS fit also
    // sets gR/gB via cGR0 but was unguarded by a slope bound). Reuses the
    // existing calibrated slopeMin/slopeMax — no new calibrated value; breach
    // routes to the same honest gate-fail path (recorded, never applied).
    // Distinct reason string so the pre-existing b−r reason stays byte-stable.
    else if (!(fGR.slope >= cfg.slopeMin && fGR.slope <= cfg.slopeMax)) reason = `slope_gr∉[${cfg.slopeMin},${cfg.slopeMax}]`;
    else if (!gains.every(g => Number.isFinite(g) && g >= cfg.minGain && g <= cfg.maxGain)) reason = `gain∉[${cfg.minGain},${cfg.maxGain}]`;
    const passed = reason === 'PASS';

    return {
        gains, method: 'TLS', nStars: surv.length, r2,
        slope_br: fBR.slope, slope_gr: fGR.slope, uncertainty,
        whiteRefBpRp: x0, applied: passed && cfg.applyEnabled,
        gate: { passed, reason },
    };
}

/**
 * Run full SPCC calibration against a set of solver-matched stars.
 *
 * @param matchedStars Matched star list (detected preview coords + Gaia truth)
 * @param scienceRgb   Full-resolution normalized interleaved RGB buffer
 * @param scales       ScaleManager (preview → native mapping); null falls back
 *                     to treating detected coordinates as native (ratio 1:1)
 * @param exposureTime Exposure time in seconds (for rate normalization)
 */
export function computeSpccCalibration(
    matchedStars: MatchedStarLike[],
    scienceRgb: { data: Float32Array; width: number; height: number },
    scales: ScalesLike | null,
    exposureTime: number,
    // CELL ②③ — measurement-layer flux corrections (OPTIONAL, additive). Both
    // gated by PIPELINE_CONSTANTS flags (default OFF); when the flags are OFF the
    // fluxes below equal the raw aperture fluxes bit-for-bit → byte-identical.
    vignette: VignetteMap | null = null,
    airMass: number | null = null,
    // CELL ④ — per-band sensor-QE throughput divide-out (OPTIONAL, additive).
    // Gated by isQeThroughputEnabled() (env VITE_SPCC_QE_THROUGHPUT, default OFF);
    // OFF / null ⇒ fluxes untouched → byte-identical. Resolved at the runSpcc seam.
    qeThroughput: QeThroughput | null = null,
): SpccCalibration {
    const { data, width, height } = scienceRgb;
    const colorSamples: ColorSample[] = [];
    const zpSamples: ZeroPointSample[] = [];
    const gainSamples: ChannelGainSample[] = [];
    const stars: SpccStarMeasurement[] = [];
    let nUsable = 0;

    // CELL ②③ — resolve the measurement-layer flux-correction context ONCE. When a
    // flag is OFF the per-star branch is unreachable → raw fluxes flow untouched.
    const applyVign = PIPELINE_CONSTANTS.PSF_FLUX_VIGNETTE_CORRECT && !!vignette;
    const extK = PIPELINE_CONSTANTS.PSF_EXTINCTION_K_DEFAULT;
    const applyExt = PIPELINE_CONSTANTS.PSF_FLUX_EXTINCTION_CORRECT &&
        typeof airMass === 'number' && Number.isFinite(airMass) && airMass >= 1 &&
        Number.isFinite(extK);
    // Extinction dims a star by k·X mag → recover flux by ×10^(0.4·k·X). One
    // broadband k applied to all bands (color ratio unchanged; corrects the
    // zero-point). A future per-band k would make it chromatic.
    const extScale = applyExt ? Math.pow(10, 0.4 * extK * (airMass as number)) : 1;

    // CELL ④ — per-band QE throughput divide-out. Double-gated (flag AND a
    // resolved qeThroughput) exactly like CELL ②; OFF ⇒ the per-band branch is
    // unreachable → raw fluxes flow untouched (byte-identical). Per-band factor is
    // CHROMATIC (a constant per band across all stars: it shifts the instrumental
    // colors/mags by a fixed per-band offset, which the color intercept, zero-
    // point, and white-balance gains absorb — the sensor's spectral-response bias
    // removed from the calibration).
    const applyQe = isQeThroughputEnabled() && !!qeThroughput;
    const qeFactor = qeThroughput?.factor ?? { r: 1, g: 1, b: 1 };

    for (const matched of matchedStars) {
        const native = scales
            ? scales.previewToNative(matched.detected.x, matched.detected.y)
            : { x: matched.detected.x, y: matched.detected.y };

        // Off-frame exclusion (aperture center must sit inside the buffer)
        if (native.x < 1 || native.y < 1 || native.x >= width - 1 || native.y >= height - 1) {
            stars.push({ measurement: null, instColor: null, mInst: null, usable: false });
            continue;
        }

        const m = measureApertureRGB(data, width, height, native.x, native.y, matched.detected.fwhm || 3.0);

        // CELL ②③ — corrected per-band fluxes (== raw when both flags OFF). The
        // EXTRACTION happened on native pixels above; corrections divide the
        // EXTRACTED quantity (MULTILAYER_MATRIX §4), never a buffer pre-warp.
        let fR = m.flux_r, fG = m.flux_g, fB = m.flux_b;
        if (applyVign) {
            fR *= gainAt(vignette as VignetteMap, native.x, native.y, 'r');
            fG *= gainAt(vignette as VignetteMap, native.x, native.y, 'g');
            fB *= gainAt(vignette as VignetteMap, native.x, native.y, 'b');
        }
        if (applyExt) { fR *= extScale; fG *= extScale; fB *= extScale; }
        // CELL ④ — divide out the per-band sensor QE (×1/QE). Same measurement-
        // level divide-out as CELL ②: the EXTRACTION happened on native pixels
        // above; only the EXTRACTED flux is corrected (never a buffer pre-warp).
        if (applyQe) { fR *= qeFactor.r; fG *= qeFactor.g; fB *= qeFactor.b; }

        let instColor: number | null = null;
        let mInst: number | null = null;
        let usable = false;

        if (m.n_aperture > 0 && m.n_annulus >= 8 && !m.saturated) {
            if (fB > 0 && fR > 0) {
                instColor = -2.5 * Math.log10(fB / fR);
            }
            if (fG > 0) {
                // Norm-sum → ADU → e⁻ → mag via the active sensor profile (gain LUT)
                mInst = PhotometryManager.calculateInstrumentalMagnitude(fG, exposureTime || 1);
            }

            const catBpRp = matched.catalog.bv;
            if (instColor !== null && Number.isFinite(instColor) && typeof catBpRp === 'number' && Number.isFinite(catBpRp)) {
                colorSamples.push({ instColor, catBpRp });
                usable = true;
                // Channel-gain sample needs all THREE channels positive (b−r AND
                // g−r color axes); the green gate above only guarantees b/r.
                if (fG > 0) {
                    gainSamples.push({ flux_r: fR, flux_g: fG, flux_b: fB, catBpRp });
                }
            }
            if (mInst !== null && Number.isFinite(mInst) && Number.isFinite(matched.catalog.mag)) {
                zpSamples.push({ catG: matched.catalog.mag, mInst });
                usable = true;
            }
        }

        if (usable) nUsable++;
        stars.push({ measurement: m, instColor, mInst, usable });
    }

    const colorFit = fitColorRegression(colorSamples);
    const zpFit = fitZeroPoint(zpSamples);
    // Color-fidelity report surface (§4.1) — computed only when the color fit is
    // valid; honest-absent (null) otherwise. Pure telemetry, never a gate.
    const fidelity = colorFit.valid ? computeColorFidelity(colorSamples, colorFit) : null;

    // Render-lane channel gains (§3.2) — ALWAYS computed (record-always); the
    // returned block carries its own quality gate + `applied` flag. Reads the
    // RESEARCH-calibrated SPCC_GAINS_* thresholds; NEVER feeds `valid`.
    const gains = fitChannelGains(gainSamples, {
        whiteRefBpRp: PIPELINE_CONSTANTS.SPCC_GAINS_WHITE_REF_BP_RP,
        minStars: PIPELINE_CONSTANTS.SPCC_GAINS_MIN_STARS,
        minR2: PIPELINE_CONSTANTS.SPCC_GAINS_MIN_R2,
        slopeMin: PIPELINE_CONSTANTS.SPCC_GAINS_SLOPE_MIN,
        slopeMax: PIPELINE_CONSTANTS.SPCC_GAINS_SLOPE_MAX,
        minGain: PIPELINE_CONSTANTS.SPCC_GAINS_MIN_GAIN,
        maxGain: PIPELINE_CONSTANTS.SPCC_GAINS_MAX_GAIN,
        applyEnabled: PIPELINE_CONSTANTS.SPCC_GAINS_APPLY,
    });

    return {
        valid: colorFit.valid || zpFit.valid,
        colorFit,
        zpFit,
        stars,
        n_usable: nUsable,
        fidelity,
        gains,
        // CELL ②③ — honest-or-absent correction provenance (null when the flags
        // were OFF, i.e. on both pinned reference solves by default).
        vignette: applyVign ? serializeVignetteMap(vignette) : null,
        extinction: applyExt
            ? {
                k: extK, k_source: 'DEFAULT' as const, airmass: airMass as number, applied: true,
                note: `Per-star extinction ×10^(0.4·k·X), k=${extK} mag/airmass (DEFAULT broadband-V, not measured), X=${(airMass as number).toFixed(3)}. Single k ⇒ zero-point corrected, color ratio unchanged. APPROXIMATE.`,
            }
            : null,
        // CELL ④ — honest-or-absent QE-throughput provenance (null when OFF, i.e.
        // on both pinned reference solves by default). `approximate` carried from
        // sensor_db. Not serialized to the receipt this wave (rider).
        qe: applyQe
            ? {
                factor: { ...(qeThroughput as QeThroughput).factor },
                qe: { ...(qeThroughput as QeThroughput).qe },
                wavelength_nm: { ...(qeThroughput as QeThroughput).wavelengthNm },
                sensor_model: (qeThroughput as QeThroughput).sensorModel,
                approximate: (qeThroughput as QeThroughput).approximate,
                applied: true,
                note: `Per-band QE throughput divide-out ×1/QE at R=${(qeThroughput as QeThroughput).wavelengthNm.r}/G=${(qeThroughput as QeThroughput).wavelengthNm.g}/B=${(qeThroughput as QeThroughput).wavelengthNm.b}nm from ${(qeThroughput as QeThroughput).sensorModel}. Constant per band ⇒ color intercept / zero-point / white-balance gains absorb the offset.${(qeThroughput as QeThroughput).approximate ? ' QE curve APPROXIMATE (datasheet-generic/borrowed, not per-copy measured).' : ' QE curve from vendor datasheet.'}`,
            }
            : null,
    };
}
