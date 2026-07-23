// ═══════════════════════════════════════════════════════════════════════════
// DENOISE LANE — deterministic render-layer noise reduction (Phase-1)
// GAT (Generalized Anscombe VST) → MAD noise estimate → starlet (à trous)
// soft-shrinkage → EXACT UNBIASED inverse VST.
// ═══════════════════════════════════════════════════════════════════════════
// TWO-LEDGER LAW: this is a PIXEL-ledger, POST-solve, RENDER-layer operation.
// Measurement (WCS / detection / forced-photometry) NEVER runs on denoised
// data — it runs on the unmodified native grid. This lane only ever produces a
// display product + an additive, honest receipt. DEFAULT-consistent: no gate,
// no solver, no calibrated constant is touched. It is a new leaf.
//
// The single measured noise model (Poisson–Gaussian) parameterizes the VST and
// every threshold (research doc §5.1 + §6). Where FITS metadata carries a
// usable gain/read-noise in e⁻ we use it (source: FITS_META); otherwise we
// ESTIMATE it from the photon-transfer relation (variance-vs-mean across the
// field) and label it APPROXIMATE — never a bare number (honest-or-absent).
//
// CRITICAL TRAP (Mäkitalo & Foi, IEEE TIP 2013): after denoising in the VST
// domain we apply the EXACT UNBIASED inverse, NOT the naive algebraic inverse —
// the naive inverse biases low photon counts downward. Both are implemented;
// the pipeline uses the exact one, `naiveInverseGat` exists only to let the
// fixture demonstrate the bias the exact form removes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFits, readPlaneRaw, writeFitsPlanar } from '../stack/fits_io.mjs';

// ── constants ────────────────────────────────────────────────────────────────

/** B3-spline à trous scaling kernel (Starck & Murtagh). Separable, sums to 1. */
export const B3_KERNEL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

/**
 * Per-scale noise-propagation factors for the B3 à trous starlet under unit
 * white Gaussian noise (Starck, Murtagh & Fadili, "Sparse Image and Signal
 * Processing", Table for the 2-D isotropic undecimated wavelet). σ_j = σ · s_j.
 * Index 0 = scale 1 (finest). Beyond this table s_j keeps ~halving; we clamp.
 */
export const STARLET_NOISE_FACTORS = [0.8907, 0.2007, 0.0857, 0.0413, 0.0205, 0.0103, 0.0052];

export const DENOISE_DEFAULTS = Object.freeze({
    kappa: 3.0,      // soft-threshold multiplier t_j = κ·σ_j
    scales: 5,       // number of à trous detail scales (coarse residual kept intact)
    detail: 0.0,     // NXT-equivalent HF re-injection strength (bounded; DEFAULT OFF)
    lowCountThresh: 20, // VST validity floor (counts/px) — research doc §5.1 caveat
});

// ── robust statistics ─────────────────────────────────────────────────────────

/** Median of the finite entries of a typed array (copy + sort). */
export function median(arr) {
    const v = [];
    for (let i = 0; i < arr.length; i++) { const x = arr[i]; if (Number.isFinite(x)) v.push(x); }
    if (v.length === 0) return NaN;
    v.sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
}

/**
 * Robust noise σ via the Median Absolute Deviation: σ̂ = MAD/0.6745.
 * Data-derived (not a knob). Non-finite entries are ignored.
 */
export function madSigma(arr) {
    const med = median(arr);
    if (!Number.isFinite(med)) return NaN;
    const dev = [];
    for (let i = 0; i < arr.length; i++) { const x = arr[i]; if (Number.isFinite(x)) dev.push(Math.abs(x - med)); }
    dev.sort((a, b) => a - b);
    const m = dev.length >> 1;
    const mad = dev.length % 2 ? dev[m] : 0.5 * (dev[m - 1] + dev[m]);
    return mad / 0.6745;
}

// ── noise model (Poisson–Gaussian; photon-transfer estimation) ────────────────

/**
 * Estimate the Poisson–Gaussian noise model from the pixels themselves via the
 * photon-transfer relation Var(y) = α·(mean − offset) + σ², fit robustly over a
 * grid of small tiles. Returns the VST parameters (α = ADU-domain Poisson slope,
 * σ = read-noise-equiv std in ADU, offset = pedestal) plus the human-facing
 * gain (e⁻/ADU = 1/α) and read-noise (e⁻ = σ/α).
 *
 * `meta` may carry a metadata gain/read-noise ALREADY in e⁻ units; a ZWO-style
 * "GAIN" register value is NOT that and must not be passed here (honest-or-absent).
 */
export function estimateNoiseModel(plane, W, H, meta = {}) {
    // Metadata path: only if a real e⁻-domain gain is supplied.
    if (Number.isFinite(meta.gain_e_per_adu) && meta.gain_e_per_adu > 0) {
        const g = meta.gain_e_per_adu;
        const rn = Number.isFinite(meta.read_noise_e) ? meta.read_noise_e : 0;
        const off = Number.isFinite(meta.offset_adu) ? meta.offset_adu : median(plane);
        const alpha = 1 / g;
        const sigma = rn * alpha; // e⁻ → ADU
        return {
            alpha, sigma, offset: off,
            gain_e_per_adu: g, read_noise_e: rn,
            source: 'FITS_META', approximate: false,
            photon_transfer: null,
        };
    }

    // Estimation path: STRUCTURE-ROBUST photon-transfer over a tile grid.
    // Raw tile variance is contaminated by scene structure (galaxy gradients,
    // star cores) and grossly overestimates the noise slope. Instead we read the
    // noise off the FINEST starlet detail scale w_1 (smooth structure lives in
    // coarse scales; sparse star cores are rejected by MAD), as a function of the
    // local SMOOTHED intensity — the honest variance-vs-mean relation.
    const medFill = median(plane);
    const filled = new Float64Array(plane.length);
    for (let i = 0; i < plane.length; i++) filled[i] = Number.isFinite(plane[i]) ? plane[i] : medFill;
    const st1 = starletTransform(filled, W, H, 1);
    const w1 = st1.scales[0], smooth = st1.coarse;
    const s1f = STARLET_NOISE_FACTORS[0];

    const TILE = 32;
    const means = [], vars = [];
    const buf = new Float64Array(TILE * TILE);
    for (let ty = 0; ty + TILE <= H; ty += TILE) {
        for (let tx = 0; tx + TILE <= W; tx += TILE) {
            let n = 0, valid = 0;
            for (let j = 0; j < TILE; j++) {
                const row = (ty + j) * W + tx;
                for (let i = 0; i < TILE; i++) {
                    if (Number.isFinite(plane[row + i])) valid++;
                    buf[n++] = w1[row + i];
                }
            }
            if (valid > TILE * TILE * 0.75) {
                // local mean = median of the smoothed image (structure-free level)
                const sm = new Float64Array(TILE * TILE);
                for (let j = 0, k = 0; j < TILE; j++) {
                    const row = (ty + j) * W + tx;
                    for (let i = 0; i < TILE; i++) sm[k++] = smooth[row + i];
                }
                const localMean = median(sm);
                const noiseSig = madSigma(buf) / s1f;      // image-domain σ from w_1
                if (Number.isFinite(noiseSig)) { means.push(localMean); vars.push(noiseSig * noiseSig); }
            }
        }
    }

    // offset = robust background pedestal (tile-mean at the 5th percentile).
    const sortedMeans = means.slice().sort((a, b) => a - b);
    const offset = sortedMeans.length
        ? sortedMeans[Math.floor(sortedMeans.length * 0.05)]
        : median(plane);

    // Robust line fit Var = α·(mean − offset) + σ². Bin by mean into quantiles,
    // take the per-bin MEDIAN variance (rejects source/outlier tiles), then a
    // least-squares fit on the bin medians.
    const pts = means.map((m, i) => ({ x: m - offset, y: vars[i] })).filter((p) => p.x >= 0);
    pts.sort((a, b) => a.x - b.x);
    const NB = 12, bins = [];
    for (let b = 0; b < NB; b++) {
        const lo = Math.floor((b * pts.length) / NB), hi = Math.floor(((b + 1) * pts.length) / NB);
        if (hi <= lo) continue;
        const xs = [], ys = [];
        for (let k = lo; k < hi; k++) { xs.push(pts[k].x); ys.push(pts[k].y); }
        bins.push({ x: median(Float64Array.from(xs)), y: median(Float64Array.from(ys)) });
    }
    let alpha = NaN, sigma2 = NaN;
    if (bins.length >= 2) {
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const p of bins) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
        const nb = bins.length, denom = nb * sxx - sx * sx;
        if (Math.abs(denom) > 1e-9) {
            alpha = (nb * sxy - sx * sy) / denom;
            sigma2 = (sy - alpha * sx) / nb;
        }
    }

    // Guard degenerate fits (heavily-stacked frames can be read-noise-dominated
    // with a near-flat variance-mean line). Fall back to a MAD-derived Gaussian
    // model and flag low confidence — still honest, still runs the VST.
    let degenerate = false;
    if (!Number.isFinite(alpha) || alpha <= 0) {
        degenerate = true;
        // sub-sample MAD to bound cost on large planes.
        const sample = new Float64Array(Math.min(plane.length, 1 << 20));
        const step = Math.max(1, Math.floor(plane.length / sample.length));
        for (let i = 0, k = 0; k < sample.length && i < plane.length; i += step, k++) sample[k] = plane[i];
        const s = madSigma(sample);
        alpha = 1e-6;                 // → VST degenerates toward a pure Gaussian stabilizer
        sigma2 = Number.isFinite(s) ? s * s : 1;
    }
    const sigma = Math.sqrt(Math.max(sigma2, 1e-12));

    return {
        alpha, sigma, offset,
        gain_e_per_adu: 1 / alpha,
        read_noise_e: sigma / alpha,
        source: 'ESTIMATED', approximate: true,
        photon_transfer: { tiles: means.length, bins: bins.length, degenerate },
    };
}

// ── Generalized Anscombe VST + exact-unbiased inverse (Mäkitalo & Foi 2013) ────

/**
 * Forward Generalized Anscombe transform on a background-subtracted value y.
 * GAT(y) = (2/α)·√(α·y + 3/8·α² + σ²)  →  ≈ unit-variance Gaussian.
 * Below the transform floor (α·y+3/8·α²+σ² ≤ 0) the argument is clamped to 0.
 */
export function gat(y, alpha, sigma) {
    const arg = alpha * y + 0.375 * alpha * alpha + sigma * sigma;
    return arg > 0 ? (2 / alpha) * Math.sqrt(arg) : 0;
}

/**
 * EXACT UNBIASED inverse GAT (closed-form asymptotic, Mäkitalo & Foi 2011/2013).
 * Reduces to the standard-Anscombe count domain u = y/α with normalized read
 * noise σ_n = σ/α, applies the exact unbiased inverse, subtracts σ_n², maps back.
 * This is the algorithm's inverse — bias-corrected so E[inv(GAT(y))] ≈ E[y].
 */
export function inverseGatExact(D, alpha, sigma) {
    const sn2 = (sigma / alpha) * (sigma / alpha);
    // Forward is bounded below by GAT1(0); clamp D so the D^-k terms stay tame.
    const Dmin = 2 * Math.sqrt(0.375 + sn2);
    const d = D > Dmin ? D : Dmin;
    const R = Math.sqrt(1.5);
    const u = 0.25 * d * d
        + 0.25 * R / d
        - 1.375 / (d * d)
        + 0.625 * R / (d * d * d)
        - 0.125
        - sn2;
    return alpha * Math.max(u, 0);
}

/**
 * NAIVE algebraic inverse (the TRAP). Solving GAT(y)=D for y directly:
 * y = α·((D/2)² − 3/8 − σ_n²). Biases low counts low. NOT used in the pipeline —
 * present only so the fixture can measure the bias the exact inverse removes.
 */
export function naiveInverseGat(D, alpha, sigma) {
    const sn2 = (sigma / alpha) * (sigma / alpha);
    const u = 0.25 * D * D - 0.375 - sn2;
    return alpha * Math.max(u, 0);
}

/** Apply the forward VST to a whole plane (offset-subtracted). NaN → NaN. */
export function gatImage(plane, model) {
    const { alpha, sigma, offset } = model;
    const out = new Float64Array(plane.length);
    for (let i = 0; i < plane.length; i++) {
        const v = plane[i];
        out[i] = Number.isFinite(v) ? gat(v - offset, alpha, sigma) : NaN;
    }
    return out;
}

/** Inverse VST (exact-unbiased) back to original ADU units (offset restored). */
export function inverseGatImage(D, model) {
    const { alpha, sigma, offset } = model;
    const out = new Float64Array(D.length);
    for (let i = 0; i < D.length; i++) {
        const v = D[i];
        out[i] = Number.isFinite(v) ? inverseGatExact(v, alpha, sigma) + offset : NaN;
    }
    return out;
}

// ── starlet (à trous, isotropic undecimated wavelet) ──────────────────────────

/** Reflect an index into [0, n). */
function reflect(i, n) {
    if (n === 1) return 0;
    while (i < 0 || i >= n) { if (i < 0) i = -i; if (i >= n) i = 2 * n - 2 - i; }
    return i;
}

/**
 * One à trous smoothing pass at dilation `step` (separable B3 convolution,
 * mirror boundary). NaN pixels are treated as reflect-fill neighbours so the
 * footprint mask does not leak (restored to NaN by the caller).
 */
function atrousSmooth(src, W, H, step) {
    const k = B3_KERNEL, tmp = new Float64Array(W * H), out = new Float64Array(W * H);
    // horizontal
    for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
            let s = 0;
            for (let t = -2; t <= 2; t++) {
                let v = src[row + reflect(x + t * step, W)];
                if (!Number.isFinite(v)) v = src[row + x];
                s += k[t + 2] * (Number.isFinite(v) ? v : 0);
            }
            tmp[row + x] = s;
        }
    }
    // vertical
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let s = 0;
            for (let t = -2; t <= 2; t++) {
                const v = tmp[reflect(y + t * step, H) * W + x];
                s += k[t + 2] * v;
            }
            out[y * W + x] = s;
        }
    }
    return out;
}

/**
 * Isotropic undecimated (starlet) transform. Returns J detail scales
 * w_j = c_{j-1} − c_j and the coarse residual c_J. Reconstruction is EXACTLY
 * additive: data = coarse + Σ w_j (telescoping), so κ=∞→no-op is lossless.
 */
export function starletTransform(data, W, H, J) {
    let c = Float64Array.from(data);
    const scales = [];
    for (let j = 1; j <= J; j++) {
        const step = 1 << (j - 1);
        const cNext = atrousSmooth(c, W, H, step);
        const w = new Float64Array(W * H);
        for (let i = 0; i < w.length; i++) w[i] = c[i] - cNext[i];
        scales.push(w);
        c = cNext;
    }
    return { scales, coarse: c };
}

/** Reconstruct data = coarse + Σ scales (inverse starlet). */
export function starletReconstruct({ scales, coarse }) {
    const out = Float64Array.from(coarse);
    for (const w of scales) for (let i = 0; i < out.length; i++) out[i] += w[i];
    return out;
}

/** Soft-threshold in place: sign(w)·max(|w|−t, 0). */
function softThreshold(w, t) {
    for (let i = 0; i < w.length; i++) {
        const v = w[i], a = Math.abs(v);
        w[i] = a > t ? Math.sign(v) * (a - t) : 0;
    }
}

// ── the render-layer denoise op ───────────────────────────────────────────────

/**
 * Deterministic denoise of one plane. Returns { output, receipt }.
 * Pipeline: estimate noise model → GAT → starlet → per-scale MAD thresholds
 * t_j = κ·σ_j → soft-shrink detail scales (coarse residual kept) → exact inverse.
 * The coarse residual carries the LARGE-SCALE extended (galaxy/nebula) signal
 * untouched, so large-scale extended flux is preserved. Fine-scale extended/
 * diffuse structure, however, rides the SHRUNK detail scales and is NOT
 * guaranteed preserved — an adversarial review measured ~9% diffuse-flux loss
 * at ~1σ/px. Only detail-scale content (noise AND any fine diffuse signal) is
 * shrunk.
 */
export function denoiseImage(plane, W, H, opts = {}) {
    const o = { ...DENOISE_DEFAULTS, ...opts };
    const model = o.noiseModel || estimateNoiseModel(plane, W, H, opts.meta || {});

    // low-count regime honesty (VST degrades below ~20 counts/px).
    let lowN = 0, valid = 0;
    for (let i = 0; i < plane.length; i++) {
        const v = plane[i];
        if (!Number.isFinite(v)) continue;
        valid++;
        if ((v - model.offset) / model.alpha < o.lowCountThresh) lowN++;
    }
    const lowFrac = valid ? lowN / valid : 1;

    // 1) forward VST → ~unit-variance Gaussian
    const D = gatImage(plane, model);
    // NaN mask: work on a filled copy, restore NaN at the end.
    const nanMask = new Uint8Array(D.length);
    const fillVal = median(D);
    const Dfill = new Float64Array(D.length);
    for (let i = 0; i < D.length; i++) {
        if (Number.isFinite(D[i])) Dfill[i] = D[i];
        else { Dfill[i] = fillVal; nanMask[i] = 1; }
    }

    // 2) starlet decomposition
    const st = starletTransform(Dfill, W, H, o.scales);

    // 3) MAD noise on the finest scale → per-scale thresholds t_j = κ·σ_j.
    //    In the VST domain σ_noise ≈ 1; recovering that is a built-in sanity check.
    const s1 = STARLET_NOISE_FACTORS[0];
    const madS1 = madSigma(st.scales[0]);
    const sigmaNoise = madS1 / s1;             // underlying VST-domain noise σ
    const thresholds = [];
    const keptScales = st.scales.map((w, j) => {
        const sj = sigmaNoise * (STARLET_NOISE_FACTORS[j] ?? STARLET_NOISE_FACTORS[STARLET_NOISE_FACTORS.length - 1] * Math.pow(0.5, j - STARLET_NOISE_FACTORS.length + 1));
        const t = o.kappa * sj;
        thresholds.push(t);
        const shrunk = Float64Array.from(w);
        softThreshold(shrunk, t);
        return shrunk;
    });

    // 5) optional NXT-equivalent detail re-injection: add back a bounded,
    //    local-SNR-scaled fraction of the removed finest-scale HF. DEFAULT OFF.
    if (o.detail > 0) {
        const w1 = st.scales[0], k1 = keptScales[0];
        const cap = o.kappa * sigmaNoise * s1; // bound "just shy of dark halos"
        for (let i = 0; i < w1.length; i++) {
            const removed = w1[i] - k1[i];
            const snr = Math.min(1, Math.abs(k1[i]) / (sigmaNoise * s1 + 1e-9));
            let add = o.detail * snr * removed;
            if (add > cap) add = cap; else if (add < -cap) add = -cap;
            k1[i] += add;
        }
    }

    // 4/reconstruct) inverse starlet then EXACT-unbiased inverse VST.
    const Drec = starletReconstruct({ scales: keptScales, coarse: st.coarse });
    for (let i = 0; i < Drec.length; i++) if (nanMask[i]) Drec[i] = NaN;
    const output = inverseGatImage(Drec, model);
    // preserve exact NaN footprint from the input
    for (let i = 0; i < output.length; i++) if (!Number.isFinite(plane[i])) output[i] = NaN;

    const receipt = {
        schema: 'denoise/1.0.0',
        method: 'GAT+starlet+MAD',
        noise_model: {
            gain_e_per_adu: round(model.gain_e_per_adu, 6),
            read_noise_e: round(model.read_noise_e, 4),
            offset_adu: round(model.offset, 4),
            source: model.source,
            label: model.approximate ? 'APPROXIMATE' : 'MEASURED',
            photon_transfer: model.photon_transfer,
        },
        vst: {
            transform: 'generalized_anscombe',
            alpha: round(model.alpha, 8),
            sigma: round(model.sigma, 6),
            inverse: 'exact_unbiased (Makitalo-Foi 2013)',
        },
        mad_sigma_vst_domain: round(sigmaNoise, 5), // ≈1.0 is the health check
        starlet: { scales: o.scales, kernel: 'B3_spline_atrous' },
        kappa: o.kappa,
        thresholds: thresholds.map((t) => round(t, 5)),
        detail_reinjection: o.detail,
        low_count: {
            threshold_counts: o.lowCountThresh,
            fraction_below: round(lowFrac, 4),
            regime_flag: lowFrac > 0.5,
            note: lowFrac > 0.5
                ? 'APPROXIMATE — >50% of pixels below VST validity floor; prefer exact-Poisson methods'
                : 'ok',
        },
    };
    return { output, receipt };
}

function round(x, n) {
    if (!Number.isFinite(x)) return null;
    const f = 10 ** n;
    return Math.round(x * f) / f;
}

// ── validation helpers (used by the fixture test) ─────────────────────────────

/**
 * Background noise floor = MAD σ of the finest starlet detail scale (Starck's
 * robust estimator); rescaled by the s_1 factor to the image-domain σ. This is
 * exactly the "noise-floor" the denoise reduces — report pre vs post.
 */
export function backgroundMadSigma(plane, W, H) {
    // fill NaN so the transform is defined; the finest scale is dominated by noise.
    const med = median(plane);
    const filled = new Float64Array(plane.length);
    for (let i = 0; i < plane.length; i++) filled[i] = Number.isFinite(plane[i]) ? plane[i] : med;
    const { scales } = starletTransform(filled, W, H, 1);
    return madSigma(scales[0]) / STARLET_NOISE_FACTORS[0];
}

/** Brightest-first local maxima (5×5-ish peak test), N sources, margin-guarded. */
export function detectTopSources(plane, W, H, N, margin = 8) {
    const out = [];
    for (let y = margin; y < H - margin; y++) {
        const row = y * W;
        for (let x = margin; x < W - margin; x++) {
            const v = plane[row + x];
            if (!Number.isFinite(v)) continue;
            if (v > plane[row + x - 1] && v >= plane[row + x + 1]
                && v > plane[row - W + x] && v >= plane[row + W + x]
                && v > plane[row - W + x - 1] && v > plane[row - W + x + 1]
                && v >= plane[row + W + x - 1] && v >= plane[row + W + x + 1]) {
                out.push({ x, y, v });
            }
        }
    }
    out.sort((a, b) => b.v - a.v);
    return out.slice(0, N);
}

/**
 * Sum of local-background-subtracted aperture flux over `sources`. Background =
 * median of an annulus [rIn,rOut]; aperture = disc radius r. Isolates SOURCE
 * flux (not sky) so the ratio after/before is a true flux-conservation check.
 */
export function apertureFluxSum(plane, W, H, sources, r = 4, rIn = 6, rOut = 10) {
    let total = 0;
    for (const s of sources) {
        const cx = Math.round(s.x), cy = Math.round(s.y);
        const ann = [];
        for (let dy = -rOut; dy <= rOut; dy++) {
            const yy = cy + dy; if (yy < 0 || yy >= H) continue;
            for (let dx = -rOut; dx <= rOut; dx++) {
                const xx = cx + dx; if (xx < 0 || xx >= W) continue;
                const d2 = dx * dx + dy * dy;
                if (d2 >= rIn * rIn && d2 <= rOut * rOut) {
                    const v = plane[yy * W + xx];
                    if (Number.isFinite(v)) ann.push(v);
                }
            }
        }
        const bg = ann.length ? median(Float64Array.from(ann)) : 0;
        for (let dy = -r; dy <= r; dy++) {
            const yy = cy + dy; if (yy < 0 || yy >= H) continue;
            for (let dx = -r; dx <= r; dx++) {
                const xx = cx + dx; if (xx < 0 || xx >= W) continue;
                if (dx * dx + dy * dy <= r * r) {
                    const v = plane[yy * W + xx];
                    if (Number.isFinite(v)) total += v - bg;
                }
            }
        }
    }
    return total;
}

/**
 * Load one plane of a FITS file in original (ADU) units via the stack lane's
 * fits_io. Thin typed wrapper so callers (incl. the fixture test) never have to
 * import the untyped .mjs directly. Returns null if the file is absent — the
 * corpus is gitignored/local-only, so callers guard on null.
 */
export function loadFitsPlane(file, planeIdx = 0) {
    if (!fs.existsSync(file)) return null;
    const f = openFits(file);
    try {
        const plane = readPlaneRaw(f, Math.min(planeIdx, f.NP - 1));
        return { plane, W: f.W, H: f.H, NP: f.NP, cards: f.cards };
    } finally {
        f.close();
    }
}

/** Extract a W2×H2 crop with top-left at (x0,y0) from a plane. */
export function cropPlane(plane, W, H, x0, y0, W2, H2) {
    const out = new Float32Array(W2 * H2);
    for (let j = 0; j < H2; j++) {
        const src = (y0 + j) * W + x0;
        for (let i = 0; i < W2; i++) out[j * W2 + i] = plane[src + i];
    }
    return out;
}

// ── CLI driver ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const a = { input: null, out: null, kappa: DENOISE_DEFAULTS.kappa, detail: DENOISE_DEFAULTS.detail, scales: DENOISE_DEFAULTS.scales, json: false };
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--kappa') a.kappa = +argv[++i];
        else if (t === '--detail') a.detail = +argv[++i];
        else if (t === '--scales') a.scales = +argv[++i];
        else if (t === '--out') a.out = argv[++i];
        else if (t === '--json') a.json = true;
        else if (!a.input) a.input = t;
    }
    return a;
}

async function main() {
    const a = parseArgs(process.argv.slice(2));
    if (!a.input) {
        console.error('usage: node tools/denoise/denoise.mjs <input.fits> [--kappa 3] [--scales 5] [--detail 0] [--out <path>] [--json]');
        process.exit(2);
    }
    const f = openFits(a.input);
    const { W, H, NP } = f;
    const outPlanes = [], receipts = [];
    for (let p = 0; p < NP; p++) {
        const plane = readPlaneRaw(f, p);
        const { output, receipt } = denoiseImage(plane, W, H, { kappa: a.kappa, detail: a.detail, scales: a.scales });
        outPlanes.push(Float32Array.from(output));
        receipts.push(receipt);
    }
    f.close();

    const outPath = a.out || a.input.replace(/\.(fits?|fit)$/i, '') + '.denoised.fits';
    writeFitsPlanar(outPath, outPlanes, W, H, [
        ['HISTORY', 'SkyCruncher denoise lane (render-layer, GAT+starlet+MAD)'],
        ['DNZKAPPA', a.kappa, 'soft-threshold kappa'],
    ]);

    const report = {
        input: a.input, output: outPath, planes: NP, width: W, height: H,
        receipt: NP === 1 ? receipts[0] : receipts,
    };
    if (a.json) console.log(JSON.stringify(report, null, 2));
    else {
        console.log(`denoised → ${outPath}  (${W}x${H}x${NP})`);
        const r0 = receipts[0];
        console.log(`  noise: gain≈${r0.noise_model.gain_e_per_adu} e/ADU (${r0.noise_model.label}), σ_read≈${r0.noise_model.read_noise_e} e`);
        console.log(`  VST α=${r0.vst.alpha} σ=${r0.vst.sigma}, MAD(VST)=${r0.mad_sigma_vst_domain} (≈1 healthy)`);
        console.log(`  κ=${r0.kappa} thresholds=[${r0.thresholds.join(', ')}]`);
        console.log(`  low-count<${r0.low_count.threshold_counts}: ${(r0.low_count.fraction_below * 100).toFixed(1)}% (${r0.low_count.note})`);
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('DENOISE_FAIL:', e.message); process.exit(1); });
