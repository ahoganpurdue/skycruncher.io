/**
 * ═══════════════════════════════════════════════════════════════════════════
 * M10 PSF — MULTISCALE NEBULOSITY LAYER (additive starlet decomposition)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL. Runs on the NATIVE-grid science LUMINANCE (no coordinate warp
 * has touched these pixels — LAW 1: never resample before measurement). This IS
 * the render-law star/background separation, produced ONCE on the measurement
 * grid before any warp.
 *
 * DEFAULT-OFF render producer. Nothing here is wired into the live solve/receipt
 * path; it is invoked only when a render consumer explicitly asks for the
 * decomposition (rides the RL-deconv off-by-default pattern). The solve, WCS,
 * matched_stars and forced-photometry chains are untouched.
 *
 * ── WHY (owner layers ruling 2026-07-10; researcher proposal 2026-07-11) ─────
 * The single-scale box-blur "diffuse stub" in richardsonLucyWindowProtected
 * (rl_deconv.ts) folds real diffuse structure finer than its box radius into the
 * compact/star band. This ELEVATES that stub to a first-class MULTISCALE layer:
 * an à-trous / starlet (isotropic undecimated wavelet) decomposition split into
 * an ADDITIVE-COMPLETE set of layers {star, nebulosity, sky_gradient, residual}
 * whose sum reconstructs the input within float epsilon.
 *
 * ── LAYER CONTRACT (honest-or-absent) ───────────────────────────────────────
 *   star         = SIGNIFICANT fine-scale coefficients in COMPACT components
 *                  (|w_j| > κ·σ_j on scales [1..jLo-1], connected-component area
 *                  ≤ aMaxPx). IUWT principle: compact/bright ≈ scales 2-3.
 *   nebulosity   = SIGNIFICANT mid/coarse-scale coefficients on scales [jLo..J],
 *                  MINUS the (dilated) star footprint. Built from RAW starlet
 *                  coefficients (NOT shrinkage output) so it is flux-preserving
 *                  — it does NOT inherit the ~9% shrinkage loss of the denoise
 *                  lane. HONEST-OR-ABSENT: data=null when the significant
 *                  nebulosity support is below minSupportFrac (guards against
 *                  fabricating nebulosity on a pure-noise / correlated-noise
 *                  field). Its coefficients then fall through to `residual`.
 *   sky_gradient = the coarsest starlet residual c_J (the large-scale DC floor /
 *                  background pedestal). This is BACKGROUND, never labelled
 *                  nebulosity — the honest-or-absent gate is about significant
 *                  diffuse STRUCTURE, not the always-present DC floor. Reconciles
 *                  with the existing deg-2 surface; the deg-2 CEILING law holds
 *                  (we never raise a polynomial degree here).
 *   residual     = everything not claimed above = the insignificant noise floor
 *                  across scales; defined as the exact remainder so the set is
 *                  additive-complete: star + nebulosity + sky_gradient + residual
 *                  == input (within float ε ~1e-6 relative; asserted <1e-4 by the
 *                  P1 unit test).
 *
 * APPROXIMATE (approximate:true throughout): the star/nebulosity scale cut jLo,
 * the significance κ, and the compactness area aMaxPx are algorithm knobs to be
 * EVIDENCE-set per rig from the measured PSF FWHM — never treated as calibrated
 * gate constants. NO Oklab / perceptual transform touches this math (physics
 * stays LINEAR; palettes are a render mapping, out of scope here).
 *
 * Math is textbook (Starck, Murtagh & Fadili 2010, à-trous / starlet); the
 * transform primitives mirror the render-fenced tools/denoise/denoise.mjs
 * (B3-spline [1,4,6,4,1]/16, dilation 2^(j-1), mirror boundary).
 */

import { dilateMask } from './rl_deconv';

/** B3-spline à-trous scaling kernel (Starck & Murtagh). Separable, sums to 1. */
const B3_KERNEL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16] as const;

/**
 * Per-scale noise-propagation factors for the B3 à-trous starlet under unit
 * white noise (Starck's table; mirror boundary). σ_j = σ_noise · factor[j-1].
 * Beyond the tabulated scales the factor halves per additional scale.
 */
const STARLET_NOISE_FACTORS = [0.8907, 0.2007, 0.0857, 0.0413, 0.0205, 0.0103, 0.0052] as const;

function noiseFactor(j1: number): number {
    // j1 is 0-based scale index (scale j = j1 + 1)
    if (j1 < STARLET_NOISE_FACTORS.length) return STARLET_NOISE_FACTORS[j1];
    const last = STARLET_NOISE_FACTORS.length - 1;
    return STARLET_NOISE_FACTORS[last] * Math.pow(0.5, j1 - last);
}

/** Reflect an index into [0, n) (mirror boundary, matches denoise.mjs). */
function reflect(i: number, n: number): number {
    if (n === 1) return 0;
    while (i < 0 || i >= n) {
        if (i < 0) i = -i;
        if (i >= n) i = 2 * n - 2 - i;
    }
    return i;
}

/** One à-trous smoothing pass at dilation `step` (separable B3, mirror boundary). */
function atrousSmooth(src: Float64Array, w: number, h: number, step: number): Float64Array {
    const k = B3_KERNEL;
    const tmp = new Float64Array(w * h);
    const out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let t = -2; t <= 2; t++) s += k[t + 2] * src[row + reflect(x + t * step, w)];
            tmp[row + x] = s;
        }
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let t = -2; t <= 2; t++) s += k[t + 2] * tmp[reflect(y + t * step, h) * w + x];
            out[y * w + x] = s;
        }
    }
    return out;
}

export interface StarletTransform {
    /** Detail scales w_j = c_{j-1} − c_j, index 0 = finest (scale 1). */
    scales: Float64Array[];
    /** Coarse residual c_J. */
    coarse: Float64Array;
}

/**
 * Isotropic undecimated (starlet) transform. Reconstruction is exactly additive:
 * data = coarse + Σ scales (telescoping), so an all-pass copy is lossless within
 * float ε.
 */
export function starletTransform(data: ArrayLike<number>, w: number, h: number, J: number): StarletTransform {
    let c: Float64Array = Float64Array.from(data as ArrayLike<number>);
    const scales: Float64Array[] = [];
    for (let j = 1; j <= J; j++) {
        const step = 1 << (j - 1);
        const cNext = atrousSmooth(c, w, h, step);
        const wj = new Float64Array(w * h);
        for (let i = 0; i < wj.length; i++) wj[i] = c[i] - cNext[i];
        scales.push(wj);
        c = cNext;
    }
    return { scales, coarse: c };
}

/**
 * Median absolute deviation → Gaussian-equivalent σ (÷0.6745). Used on the
 * finest starlet detail scale to estimate the pixel noise σ.
 */
export function madSigma(arr: ArrayLike<number>): number {
    const finite: number[] = [];
    for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (Number.isFinite(v)) finite.push(v);
    }
    if (finite.length === 0) return NaN;
    finite.sort((a, b) => a - b);
    const med = finite[finite.length >> 1];
    const dev = finite.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
    const mad = dev[dev.length >> 1];
    return mad / 0.6745;
}

/** 8-connectivity connected-component areas over a 0/1 mask (iterative flood fill). */
function componentAreas(mask: Uint8Array, w: number, h: number): { label: Int32Array; areas: number[] } {
    const label = new Int32Array(w * h).fill(-1);
    const areas: number[] = [];
    const stack: number[] = [];
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || label[start] >= 0) continue;
        const id = areas.length;
        let area = 0;
        stack.length = 0;
        stack.push(start);
        label[start] = id;
        while (stack.length) {
            const p = stack.pop()!;
            area++;
            const px = p % w, py = (p - px) / w;
            for (let dy = -1; dy <= 1; dy++) {
                const ny = py + dy;
                if (ny < 0 || ny >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = px + dx;
                    if (nx < 0 || nx >= w) continue;
                    const q = ny * w + nx;
                    if (mask[q] && label[q] < 0) {
                        label[q] = id;
                        stack.push(q);
                    }
                }
            }
        }
        areas.push(area);
    }
    return { label, areas };
}

/**
 * One EXTERNAL detected-star footprint (native-grid pixel position + exclusion
 * radius). Sourced from the pipeline detection stage (m4_signal_detect /
 * psf_core.findMaxima+measureStar) — NOT re-detected here. Consumed as given: no
 * resampling, no coordinate warp (PIXEL ledger, native grid).
 */
export interface StarFootprintDetection {
    x: number;
    y: number;
    radiusPx: number;
}

export interface NebulosityLayerOpts {
    /** Number of à-trous detail scales (coarse residual kept separate). */
    scales?: number;
    /** Star/nebulosity scale cut: star = scales [1..jLo-1], nebulosity = [jLo..J]. */
    jLo?: number;
    /** Significance multiplier: a coefficient is significant when |w_j| > κ·σ_j. */
    kappa?: number;
    /**
     * Peak-detection multiplier for the STAR band: a fine-band component is a star
     * only if it contains a coefficient |w_j| > κ_peak·σ_j. Real stars have a
     * strongly significant core; marginal κσ noise blobs do not — this rejects
     * noise-seeded pseudo-stars (standard IUWT source-detection criterion).
     */
    kappaPeak?: number;
    /** Min connected-component area (px) for a fine-band component to count as a star (rejects isolated noise spikes). */
    minStarAreaPx?: number;
    /** Max connected-component area (px) for a fine-band component to count as a COMPACT star. */
    aMaxPx?: number;
    /** Dilation radius (px) of the star mask used to exclude star halos from nebulosity. */
    starDilatePx?: number;
    /**
     * SPATIAL-COHERENCE gate (the honest-or-absent core): a significant
     * nebulosity coefficient counts only if it belongs to a connected component
     * of at least this many pixels. Real diffuse emission is spatially extended;
     * κσ noise false-positives are isolated 1-few-px specks, so this filters
     * fabricated nebulosity on a pure-/correlated-noise field (proposal KC1 / P4).
     */
    minNebAreaPx?: number;
    /** Honest-or-absent floor: nebulosity.data is null when its significant support < this fraction of the frame. */
    minSupportFrac?: number;
    /**
     * EXTERNAL detected-star footprints (native grid) from the pipeline detection
     * stage. Rasterized to filled discs of `radiusPx` and UNIONED with the internal
     * wavelet star footprint BEFORE the nebulosity estimation, so a bright/saturated
     * star whose fine-band blob exceeds `aMaxPx` (and is therefore absent from the
     * wavelet star mask) still has its à-trous halo/ring excluded from nebulosity
     * instead of leaking in as a mexican-hat donut (row-545 finding). PIXEL ledger,
     * native grid — positions used as given, no resampling. Byte-identical off:
     * absent/empty ⇒ zero effect on the decomposition.
     */
    starDetections?: readonly StarFootprintDetection[];
    /**
     * Precomputed external star-exclusion mask (length w*h, non-zero = excluded).
     * Same role as `starDetections`; unioned with it and with the wavelet footprint.
     */
    starMaskExternal?: ArrayLike<number>;
    /**
     * Extra dilation (px) applied to the rasterized external footprint. Covers the
     * coarse-scale à-trous ring beyond the detection radius. 0 ⇒ no extra dilation.
     */
    starHaloDilatePx?: number;
}

/**
 * The nine algorithm KNOBS (shipped defaults). External-mask fields
 * (starDetections/starMaskExternal/starHaloDilatePx) are read separately and
 * default to "off" so this table stays byte-identical to the shipped state.
 */
type NebulosityKnobs = Required<Pick<NebulosityLayerOpts,
    'scales' | 'jLo' | 'kappa' | 'kappaPeak' | 'minStarAreaPx' | 'aMaxPx'
    | 'starDilatePx' | 'minNebAreaPx' | 'minSupportFrac'>>;

const DEFAULTS: NebulosityKnobs = {
    scales: 5,
    jLo: 3,
    // κ=4 (not 3): controls false positives so the honest-or-absent gate holds on
    // pure/correlated-noise fields — κ=3 lets coarse-scale correlated noise form
    // spurious coherent blobs (proposal KC1 / P4). Standard extended-source κ.
    kappa: 4,
    kappaPeak: 5,
    minStarAreaPx: 4,
    aMaxPx: 300,
    starDilatePx: 3,
    minNebAreaPx: 64,
    minSupportFrac: 0.005,
};

// ── PER-RIG KNOB SURFACE (row-545 remediation, item 1) ───────────────────────
// The docstring's standing rule: the star/nebulosity scale-cut, compactness and
// dilation are algorithm knobs to be EVIDENCE-set per rig from the measured PSF
// FWHM and frame scale — NOT one global default, and never calibrated gate
// constants (APPROXIMATE throughout). `nebulosityKnobsForRig` derives them from
// two measured quantities with the provenance for each derivation inline. Purely
// opt-in: callers pass the result as `opts`; the shipped DEFAULTS (and therefore
// the byte-identical off state) are untouched.

export interface RigKnobParams {
    /** Measured/estimated PSF FWHM in native pixels (compact-star core width). */
    fwhmPx: number;
    /** Long-side dimension of the native frame (px) — sets the diffuse-structure scale ceiling. */
    longSidePx: number;
    /** Optional pixel scale ("/px) — carried for provenance / future angular knobs; not consumed. */
    pixelScaleArcsecPerPx?: number;
}

/**
 * Derive per-rig starlet knobs from the measured PSF FWHM + frame scale. Every
 * derivation is tied to the à-trous scale radius law (detail scale j smooths at
 * radius ~2^(j-1) px) so there are NO magic constants — only the reference points
 * cited in each comment. Returns a partial `NebulosityLayerOpts` (only the knobs
 * that are rig-dependent; the false-positive guards κ/κ_peak/minStarArea stay at
 * DEFAULTS via the {...DEFAULTS, ...opts} merge).
 */
export function nebulosityKnobsForRig(p: RigKnobParams): NebulosityLayerOpts {
    const fwhm = Number.isFinite(p.fwhmPx) && p.fwhmPx > 0 ? p.fwhmPx : 2.5;
    const longSide = Number.isFinite(p.longSidePx) && p.longSidePx > 0 ? p.longSidePx : 2048;

    // J: choose the number of detail scales so the COARSEST detail scale reaches
    // ~longSide/16 (the galaxy-halo / Milky-Way-band regime). At the shipped J=5
    // the coarsest detail radius is only ~16 px, so the MW band + dust lanes are
    // swept entirely into the DC pedestal c_J (row-545). radius(J)=2^(J-1) px ⇒
    // J = round(log2(longSide/16)) + 1. Clamp [5,8] to bound native-convolution cost.
    const targetCoarsePx = longSide / 16;
    const J = Math.max(5, Math.min(8, Math.round(Math.log2(Math.max(2, targetCoarsePx))) + 1));

    // jLo (star/nebulosity cut): the star band [1..jLo-1] must span the PSF core so
    // the compact stellar signal sits in `star` and the nebulosity band starts ABOVE
    // the PSF scale. scale (jLo-1) reaches radius 2^(jLo-2); require ≥ FWHM ⇒
    // jLo = round(log2(FWHM)) + 2. Clamp [3, J-1] (star band non-empty, neb band ≥1 scale).
    const jLo = Math.max(3, Math.min(J - 1, Math.round(Math.log2(Math.max(2, fwhm))) + 2));

    // starDilatePx: a compact star's à-trous NEGATIVE ring at the coarsest star-band
    // scale sits at radius ~2^(jLo-1) px. Dilate the star footprint by that radius so
    // the ring is excluded from nebulosity — the shipped 3 px left mexican-hat donuts
    // that dominated M66 "nebulosity" at 67 % support (row-545). Floor at the shipped 3.
    const starDilatePx = Math.max(3, Math.round(Math.pow(2, jLo - 1)));

    // aMaxPx (compact-star cap): a real star's significant fine-band footprint is
    // ≲ a disc of radius ~3·FWHM; larger connected blobs are diffuse structure.
    // area = π·(3·FWHM)². Floor at the shipped 300 so small-FWHM rigs never tighten
    // below the default (which would push borderline stars into nebulosity).
    const aMaxPx = Math.max(300, Math.round(Math.PI * (3 * fwhm) ** 2));

    // minNebAreaPx (spatial-coherence floor): scales with pixel count so a fixed
    // ANGULAR extent maps to a pixel-area threshold. Reference: the shipped 64 px at a
    // 2048-long frame ⇒ 64·(longSide/2048)². Floor at 64.
    const minNebAreaPx = Math.max(64, Math.round(64 * (longSide / 2048) ** 2));

    // starHaloDilatePx: extend the EXTERNAL detected-star footprint by the same ring
    // radius so bright/saturated stars (dropped by the aMaxPx compactness cut, hence
    // absent from the wavelet star mask) have their ring excluded too.
    return { scales: J, jLo, starDilatePx, aMaxPx, minNebAreaPx, starHaloDilatePx: starDilatePx };
}

/** Rig-class presets keyed by a coarse rig label (APPROXIMATE characterizations,
 *  provenance in each comment). `default: null` ⇒ keep the shipped DEFAULTS. */
export type NebulosityRigClass = 'seestar_dso' | 'dslr_widefield' | 'default';
export const RIG_KNOB_PRESETS: Record<NebulosityRigClass, RigKnobParams | null> = {
    // SeeStar S30/S50 deep-sky stack: ~3.7"/px, tight core (~2-3 px FWHM), ~8 MP.
    seestar_dso: { fwhmPx: 2.6, longSidePx: 3840, pixelScaleArcsecPerPx: 3.7 },
    // Wide-field DSLR (Canon CR2 / Fuji RAF; MW band + terrain): larger core, 18-40 MP.
    dslr_widefield: { fwhmPx: 3.2, longSidePx: 5200, pixelScaleArcsecPerPx: 60 },
    // Shipped DEFAULTS — the byte-identical off state.
    default: null,
};

/** One decomposed layer (PIXEL ledger, native grid, honest-or-absent). */
export interface DecomposedLayer {
    /** Reconstructed pixels for this layer, or null when honest-absent (nebulosity only). */
    data: Float32Array | null;
    /** 0/1 support mask of the pixels assigned to this layer's significant coefficients. */
    support_mask: Uint8Array;
    /** Σ data over support (0 when data is null). */
    integrated_flux: number;
    /** Support fraction of the frame [0,1]. */
    support_frac: number;
    /** Integrated significance proxy: Σ|coeff| over support, in σ_noise units. */
    snr: number;
    /** True when this layer cleared its significance/support floor. */
    significance_flag: boolean;
    /** Inclusive starlet scale band [lo,hi] this layer draws from (0 = coarse residual). */
    scale_band: [number, number];
    ledger: 'PIXEL';
    grid: 'native';
    method: string;
    approximate: boolean;
}

export interface NebulosityDecomposition {
    star: DecomposedLayer;
    nebulosity: DecomposedLayer;
    sky_gradient: DecomposedLayer;
    residual: DecomposedLayer;
    w: number;
    h: number;
    scales: number;
    jLo: number;
    kappa: number;
    /** Estimated pixel noise σ from the finest starlet detail scale. */
    sigmaNoise: number;
    method: string;
    approximate: true;
}

function emptyLayer(
    n: number, scaleBand: [number, number], method: string, significant: boolean, data: Float32Array | null,
): DecomposedLayer {
    return {
        data,
        support_mask: new Uint8Array(n),
        integrated_flux: 0,
        support_frac: 0,
        snr: 0,
        significance_flag: significant,
        scale_band: scaleBand,
        ledger: 'PIXEL',
        grid: 'native',
        method,
        approximate: true,
    };
}

/**
 * Decompose a native-grid luminance frame into the additive-complete layer set.
 * PIXEL ledger, native grid. Pure — no side effects, no solve/WCS touch.
 *
 * Additive-complete: star.data + nebulosity(or its coeffs in residual) +
 * sky_gradient.data + residual.data == input within float ε.
 */
export function decomposeNebulosityLayers(
    obs: ArrayLike<number>, w: number, h: number, opts: NebulosityLayerOpts = {},
): NebulosityDecomposition {
    const o = { ...DEFAULTS, ...opts };
    const J = Math.max(2, o.scales);
    const jLo = Math.min(Math.max(2, o.jLo), J); // star band must be non-empty ([1..jLo-1]) and ≤ J
    const n = w * h;
    const method = `starlet-B3-atrous J=${J} jLo=${jLo} κ=${o.kappa}`;

    const st = starletTransform(obs, w, h, J);
    // σ_noise from the finest detail scale (Starck): σ = MAD(w_1) / factor_1.
    const sigmaNoise = madSigma(st.scales[0]) / STARLET_NOISE_FACTORS[0];
    const sigSafe = Number.isFinite(sigmaNoise) && sigmaNoise > 0 ? sigmaNoise : 0;

    // Per-scale significance masks.
    const sig: Uint8Array[] = st.scales.map((wj, j1) => {
        const thr = o.kappa * sigSafe * noiseFactor(j1);
        const m = new Uint8Array(n);
        if (thr > 0) for (let i = 0; i < n; i++) if (Math.abs(wj[i]) > thr) m[i] = 1;
        return m;
    });

    // ── STAR band: significant fine-scale coefficients in COMPACT components ──
    // Union the significant masks over the fine band, label, keep compact comps.
    const fineUnion = new Uint8Array(n);
    for (let j1 = 0; j1 < jLo - 1; j1++) {
        const m = sig[j1];
        for (let i = 0; i < n; i++) if (m[i]) fineUnion[i] = 1;
    }
    // Peak-detection mask: fine-band coefficients that clear the STRONGER κ_peak
    // threshold (a real star core; marginal noise blobs never reach it).
    const finePeak = new Uint8Array(n);
    for (let j1 = 0; j1 < jLo - 1; j1++) {
        const thrPeak = o.kappaPeak * sigSafe * noiseFactor(j1);
        const wj = st.scales[j1];
        if (thrPeak > 0) for (let i = 0; i < n; i++) if (Math.abs(wj[i]) > thrPeak) finePeak[i] = 1;
    }
    const { label, areas } = componentAreas(fineUnion, w, h);
    // A component qualifies as a star only if it contains a peak-significant pixel.
    const hasPeak = new Uint8Array(areas.length);
    for (let i = 0; i < n; i++) if (finePeak[i] && label[i] >= 0) hasPeak[label[i]] = 1;
    const starMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const id = label[i];
        // COMPACT: area in [minStarAreaPx, aMaxPx] — rejects isolated noise specks
        // (too small) and diffuse blobs (too large); AND a strong peak (real source).
        if (id >= 0 && hasPeak[id] && areas[id] >= o.minStarAreaPx && areas[id] <= o.aMaxPx) starMask[i] = 1;
    }
    // Star footprint = dilated star mask (excludes halos from nebulosity).
    const starFootprint = o.starDilatePx > 0 ? dilateMask(starMask, w, h, o.starDilatePx) : starMask;

    // ── EXTERNAL star footprint (row-545 remediation, item 2) ────────────────
    // Rasterize the pipeline's detected-star discs + optional precomputed mask,
    // dilate by the halo radius, then UNION with the wavelet footprint. This
    // catches the bright/saturated stars the aMaxPx compactness cut drops from the
    // wavelet star mask (their mexican-hat rings are the dominant false
    // "nebulosity" on real frames). Byte-identical off: no detections + no mask ⇒
    // externalFootprint stays null ⇒ combinedStarFootprint === starFootprint.
    const dets = o.starDetections;
    const extMask = o.starMaskExternal;
    let externalFootprint: Uint8Array | null = null;
    if ((dets && dets.length > 0) || (extMask && extMask.length > 0)) {
        externalFootprint = new Uint8Array(n);
        if (extMask) {
            const lim = Math.min(n, extMask.length);
            for (let i = 0; i < lim; i++) if (extMask[i]) externalFootprint[i] = 1;
        }
        if (dets) {
            for (const d of dets) {
                if (!Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.radiusPx)) continue;
                const r = Math.max(0, d.radiusPx);
                const cx = Math.round(d.x), cy = Math.round(d.y);
                const r2 = r * r;
                const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
                const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
                for (let yy = y0; yy <= y1; yy++) {
                    const dyy = yy - cy;
                    for (let xx = x0; xx <= x1; xx++) {
                        const dxx = xx - cx;
                        if (dxx * dxx + dyy * dyy <= r2) externalFootprint[yy * w + xx] = 1;
                    }
                }
            }
        }
        const halo = o.starHaloDilatePx ?? 0;
        if (halo > 0) externalFootprint = dilateMask(externalFootprint, w, h, halo);
    }
    const combinedStarFootprint: Uint8Array = externalFootprint
        ? Uint8Array.from(starFootprint, (v, i) => (v || externalFootprint![i] ? 1 : 0))
        : starFootprint;

    // ── NEBULOSITY band: significant mid/coarse coefficients minus star footprint,
    // then SPATIAL-COHERENCE filtered (keep only components ≥ minNebAreaPx). The
    // coherence step is the honest-or-absent core: extended emission forms large
    // connected components, κσ noise forms isolated specks that get dropped.
    const nebCand = new Uint8Array(n);
    for (let j1 = jLo - 1; j1 < J; j1++) {
        const m = sig[j1];
        for (let i = 0; i < n; i++) if (m[i] && !combinedStarFootprint[i]) nebCand[i] = 1;
    }
    const nebCC = componentAreas(nebCand, w, h);
    const nebMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const id = nebCC.label[i];
        if (id >= 0 && nebCC.areas[id] >= o.minNebAreaPx) nebMask[i] = 1;
    }
    let nebSupport = 0;
    for (let i = 0; i < n; i++) if (nebMask[i]) nebSupport++;
    const nebSupportFrac = nebSupport / n;
    const nebSignificant = nebSupport > 0 && nebSupportFrac >= o.minSupportFrac;

    // ── Assemble additive layers ────────────────────────────────────────────
    const starData = new Float32Array(n);
    const nebData = new Float32Array(n);
    const skyData = new Float32Array(n);   // = coarse residual c_J
    const residData = new Float32Array(n);

    for (let i = 0; i < n; i++) skyData[i] = st.coarse[i];

    // Accumulate detail-scale coefficients into exactly one of star / neb / residual.
    // When nebulosity is honest-absent, its coefficients fall through to residual.
    let starSupport = 0, starFlux = 0, starAbs = 0;
    let nebFlux = 0, nebAbs = 0;
    for (let i = 0; i < n; i++) {
        let star = 0, neb = 0, resid = 0;
        for (let j1 = 0; j1 < J; j1++) {
            const c = st.scales[j1][i];
            const isStar = starMask[i] && j1 < jLo - 1 && sig[j1][i] === 1;
            const isNeb = nebSignificant && nebMask[i] && j1 >= jLo - 1 && sig[j1][i] === 1;
            if (isStar) star += c;
            else if (isNeb) neb += c;
            else resid += c;
        }
        starData[i] = star;
        nebData[i] = neb;
        residData[i] = resid;
        if (starMask[i]) { starSupport++; starFlux += star; starAbs += Math.abs(star); }
        if (nebSignificant && nebMask[i]) { nebFlux += neb; nebAbs += Math.abs(neb); }
    }

    // sky_gradient integrated flux + snr proxy.
    let skyFlux = 0;
    for (let i = 0; i < n; i++) skyFlux += skyData[i];

    const invSig = sigSafe > 0 ? 1 / sigSafe : 0;

    const star: DecomposedLayer = {
        ...emptyLayer(n, [1, jLo - 1], method, starSupport > 0, starData),
        support_mask: starMask,
        integrated_flux: starFlux,
        support_frac: starSupport / n,
        snr: starAbs * invSig,
    };
    const nebulosity: DecomposedLayer = {
        ...emptyLayer(n, [jLo, J], method, nebSignificant, nebSignificant ? nebData : null),
        support_mask: nebSignificant ? nebMask : new Uint8Array(n),
        integrated_flux: nebSignificant ? nebFlux : 0,
        support_frac: nebSignificant ? nebSupportFrac : 0,
        snr: nebSignificant ? nebAbs * invSig : 0,
    };
    const sky_gradient: DecomposedLayer = {
        ...emptyLayer(n, [0, 0], method, true, skyData),
        support_mask: new Uint8Array(n).fill(1),
        integrated_flux: skyFlux,
        support_frac: 1,
        snr: 0,
    };
    const residual: DecomposedLayer = {
        ...emptyLayer(n, [1, J], method, true, residData),
        // residual carries no positive "support" claim — it's the leftover floor.
        integrated_flux: (() => { let s = 0; for (let i = 0; i < n; i++) s += residData[i]; return s; })(),
        snr: 0,
    };

    return {
        star, nebulosity, sky_gradient, residual,
        w, h, scales: J, jLo, kappa: o.kappa,
        sigmaNoise: sigSafe, method, approximate: true,
    };
}

/**
 * Reconstruct the input from the additive-complete layer set:
 * star + (nebulosity coeffs, folded into residual when honest-absent) +
 * sky_gradient + residual. Exact within float ε.
 */
export function reconstructLayers(d: NebulosityDecomposition): Float32Array {
    const n = d.w * d.h;
    const out = new Float32Array(n);
    const neb = d.nebulosity.data; // null when honest-absent (its coeffs live in residual)
    const star = d.star.data!;
    const sky = d.sky_gradient.data!;
    const resid = d.residual.data!;
    for (let i = 0; i < n; i++) {
        out[i] = star[i] + (neb ? neb[i] : 0) + sky[i] + resid[i];
    }
    return out;
}

// ── Receipt surface (additive, honest-or-absent) ────────────────────────────
// Shape of the `nebulosity_layer` receipt block. WIRED into the live buildReceipt
// (stages/package.ts) at schema 2.14.0 as an additive block: the receipt calls
// buildNebulosityLayerReceipt(i.nebulosityDecomposition ?? null). The PRODUCER
// (decomposeNebulosityLayers) is still a DEFAULT-OFF render tool with NO stage
// wired into the solve path, so nebulosityDecomposition is always absent today and
// the block serializes as `nebulosity_layer: null` (honest producer-gap — the
// NebulosityLayersWidget renders DECOMPOSITION NOT RUN). The byte-identical
// solve/receipt path is unchanged (null block); when a render stage runs the
// decomposition and passes it through, the block lights up with zero further wiring.

export interface NebulosityLayerReceiptLayer {
    present: boolean;
    integrated_flux: number;
    support_frac: number;
    snr: number;
    scale_band: [number, number];
    significance_flag: boolean;
}

export interface NebulosityLayerReceipt {
    method: string;
    ledger: 'PIXEL';
    grid: 'native';
    scales: number;
    jLo: number;
    kappa: number;
    sigma_noise: number;
    reconstruction_max_abs_err: number;
    layers: {
        star: NebulosityLayerReceiptLayer;
        nebulosity: NebulosityLayerReceiptLayer;
        sky_gradient: NebulosityLayerReceiptLayer;
        residual: NebulosityLayerReceiptLayer;
    };
    approximate: true;
}

function receiptLayer(l: DecomposedLayer): NebulosityLayerReceiptLayer {
    return {
        present: l.data !== null,
        integrated_flux: l.integrated_flux,
        support_frac: l.support_frac,
        snr: l.snr,
        scale_band: l.scale_band,
        significance_flag: l.significance_flag,
    };
}

/**
 * Build the additive `nebulosity_layer` receipt block, or null when the producer
 * is off / not run (honest-or-absent). Pure surfacing of the decomposition — no
 * pixels, no calibrated constants.
 */
export function buildNebulosityLayerReceipt(
    d: NebulosityDecomposition | null, obs?: ArrayLike<number>,
): NebulosityLayerReceipt | null {
    if (!d) return null;
    let maxAbsErr = 0;
    if (obs) {
        const rec = reconstructLayers(d);
        for (let i = 0; i < rec.length; i++) {
            const e = Math.abs(rec[i] - (obs[i] as number));
            if (e > maxAbsErr) maxAbsErr = e;
        }
    }
    return {
        method: d.method,
        ledger: 'PIXEL',
        grid: 'native',
        scales: d.scales,
        jLo: d.jLo,
        kappa: d.kappa,
        sigma_noise: d.sigmaNoise,
        reconstruction_max_abs_err: maxAbsErr,
        layers: {
            star: receiptLayer(d.star),
            nebulosity: receiptLayer(d.nebulosity),
            sky_gradient: receiptLayer(d.sky_gradient),
            residual: receiptLayer(d.residual),
        },
        approximate: true,
    };
}
