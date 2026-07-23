// ═══════════════════════════════════════════════════════════════════════════
// MF — VST-STABILIZED MATCHED-FILTER DETECTION FRONT-END (candidates only).
// ═══════════════════════════════════════════════════════════════════════════
// PROPOSAL: test_results/overnight_run_2026-07-10/denoise_proposal_speculative.md
// Novelty claim: ZERO (established method: Anscombe VST + Neyman-Pearson matched
// filter for a known-shape point source in white Gaussian noise; Turin 1960,
// Vio & Andreani 2004/2016). This lane is a DETECTION-CANDIDATE GENERATOR ONLY.
//
// TWO-LEDGER LAW (structurally required, not optional): detection runs on the
// FILTERED plane; the matched filter broadens the effective PSF to √2·FWHM so
// centroids degrade — MEASUREMENT (flux/FWHM/forced-photometry) must return to
// the RAW native grid. This tool never emits fluxes, never touches WCS. It is a
// leaf: DEFAULT-unreachable (no live-path importer), both pinned solves stay
// byte-identical.
//
// PIPELINE (per plane):
//   1. Poisson–Gaussian noise model — reuse denoise.mjs:estimateNoiseModel
//      (FITS meta gain/read-noise = MEASURED; else photon-transfer = APPROXIMATE).
//   2. GAT-stabilize the background to ≈ N(0,1) — reuse denoise.mjs:gat.
//   3. Correlate with a MEAN-SUBTRACTED (zero-sum) Gaussian kernel at the
//      predicted/measured FWHM. Output normalized by ‖kernel‖ so the response on
//      pure noise has unit variance → the peak value IS the matched-filter SNR
//      in σ units (analytic per-pixel FAR = Gaussian tail).
//   4. Peak-extract local maxima above a σ-threshold → candidates {x,y,mf_snr}.
// Deterministic. No RNG.
// ═══════════════════════════════════════════════════════════════════════════
import { gat, estimateNoiseModel, median } from '../denoise/denoise.mjs';

/** FWHM(px) → Gaussian σ. */
export const fwhmToSigma = (fwhm) => fwhm / 2.3548200450309493;

/**
 * Build a MEAN-SUBTRACTED (zero-sum) 2-D Gaussian matched-filter kernel.
 * Zero-sum ⇒ the filter is insensitive to a flat background pedestal (rejects DC),
 * exactly the Neyman-Pearson detector for a point source over unknown constant sky.
 * Returned separably is impossible after mean-subtraction, so we carry the full 2-D
 * kernel and its L2 norm ‖k‖ (the matched-filter output-noise std for unit-variance
 * input). Half-width r = ceil(3σ), clamped to [2, 12].
 */
export function gaussianKernel(fwhm) {
    const sig = Math.max(0.35, fwhmToSigma(fwhm));
    const r = Math.max(2, Math.min(12, Math.ceil(3 * sig)));
    const n = 2 * r + 1;
    const raw = new Float64Array(n * n);
    let sum = 0;
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const v = Math.exp(-(i * i + j * j) / (2 * sig * sig));
        raw[(j + r) * n + (i + r)] = v; sum += v;
    }
    const mean = sum / (n * n);
    let norm2 = 0;
    const k = new Float64Array(n * n);
    for (let t = 0; t < k.length; t++) { k[t] = raw[t] - mean; norm2 += k[t] * k[t]; }
    return { k, r, n, sigma: sig, norm: Math.sqrt(norm2) };
}

/**
 * VST-stabilize a plane. NaN pixels → NaN (footprint preserved). Returns the
 * stabilized plane and the fitted noise model receipt.
 */
export function stabilize(plane, W, H, meta = {}) {
    const model = estimateNoiseModel(plane, W, H, meta);
    const D = new Float64Array(plane.length);
    for (let i = 0; i < plane.length; i++) {
        const v = plane[i];
        D[i] = Number.isFinite(v) ? gat(v - model.offset, model.alpha, model.sigma) : NaN;
    }
    return { D, model };
}

/**
 * Correlate a stabilized plane with the zero-sum Gaussian kernel, normalized by
 * ‖k‖. On stabilized noise (≈unit variance) the response is ≈ N(0,1), so the
 * value at a pixel is the matched-filter SNR (σ units). Mirror-reflect boundary;
 * NaN neighbours are skipped (kernel renormalized over the valid support so an
 * edge/footprint pixel is not biased). Returns Float32 response + mad(response).
 */
export function matchedFilter(D, W, H, kernel) {
    const { k, r, n, norm } = kernel;
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const c = D[y * W + x];
            if (!Number.isFinite(c)) { out[y * W + x] = NaN; continue; }
            let acc = 0, kn2 = 0, valid = 0, tot = 0;
            for (let j = -r; j <= r; j++) {
                let yy = y + j; if (yy < 0) yy = -yy; else if (yy >= H) yy = 2 * H - 2 - yy;
                if (yy < 0) yy = 0; else if (yy >= H) yy = H - 1;
                const rowD = yy * W, rowK = (j + r) * n;
                for (let i = -r; i <= r; i++) {
                    let xx = x + i; if (xx < 0) xx = -xx; else if (xx >= W) xx = 2 * W - 2 - xx;
                    if (xx < 0) xx = 0; else if (xx >= W) xx = W - 1;
                    const dv = D[rowD + xx]; if (!Number.isFinite(dv)) continue;
                    const kv = k[rowK + (i + r)];
                    acc += kv * dv; kn2 += kv * kv; valid++; tot++;
                }
            }
            // If a substantial part of the support fell on NaN, renormalize the
            // output noise by the valid-support norm so SNR stays in σ units.
            const localNorm = valid >= tot ? norm : Math.sqrt(kn2);
            out[y * W + x] = localNorm > 1e-9 ? acc / localNorm : 0;
        }
    }
    return out;
}

/**
 * Extract local-maximum candidates from the matched-filter response above a
 * σ-threshold. 3×3 strict-peak test (deterministic tie-break so no RNG), margin
 * guard. Returns [{x, y, mf_snr}] sorted by mf_snr desc.
 */
export function extractPeaks(resp, W, H, threshold, margin = 8) {
    const out = [];
    for (let y = margin; y < H - margin; y++) {
        const row = y * W;
        for (let x = margin; x < W - margin; x++) {
            const v = resp[row + x];
            if (!Number.isFinite(v) || v < threshold) continue;
            if (v > resp[row + x - 1] && v >= resp[row + x + 1]
                && v > resp[row - W + x] && v >= resp[row + W + x]
                && v > resp[row - W + x - 1] && v > resp[row - W + x + 1]
                && v >= resp[row + W + x - 1] && v >= resp[row + W + x + 1]) {
                out.push({ x, y, mf_snr: v });
            }
        }
    }
    out.sort((a, b) => b.mf_snr - a.mf_snr);
    return out;
}

/**
 * Count peaks ≥ threshold WITHOUT materializing the list (for threshold search).
 */
export function countPeaks(resp, W, H, threshold, margin = 8) {
    let n = 0;
    for (let y = margin; y < H - margin; y++) {
        const row = y * W;
        for (let x = margin; x < W - margin; x++) {
            const v = resp[row + x];
            if (!Number.isFinite(v) || v < threshold) continue;
            if (v > resp[row + x - 1] && v >= resp[row + x + 1]
                && v > resp[row - W + x] && v >= resp[row + W + x]
                && v > resp[row - W + x - 1] && v > resp[row - W + x + 1]
                && v >= resp[row + W + x - 1] && v >= resp[row + W + x + 1]) n++;
        }
    }
    return n;
}

/**
 * Full front-end: plane → matched-filter SNR plane + fitted model + kernel.
 * `fwhm` is the predicted/measured PSF FWHM in px.
 *
 * The raw ‖k‖-normalized response would be a true σ-statistic ONLY if the VST
 * perfectly stabilized the background to unit variance; in practice it does not
 * (stacked/correlated frames, imperfect photon-transfer fit), so we ROBUSTLY
 * self-normalize the response by its own MAD-σ (median-based ⇒ background-driven,
 * insensitive to sparse star/thermal peaks — those still tower above it). This is
 * standard matched-filter practice (cf. the neighborhood ledger's empirical
 * /bgSigma) and makes the pinned σ-threshold a GENUINE, frame-transferable σ.
 * `vst_response_sigma` (the pre-normalization MAD, ideal ≈1) is reported as the
 * honest VST-health diagnostic. Does NOT threshold (caller pins t* on a clean
 * control). Peaks from thermal artefacts are NOT masked: MAD tracks the noise
 * floor, not the sparse spikes, so an artefact-rich frame still explodes the
 * candidate count — exactly what the count gate must catch.
 */
export function mfResponse(plane, W, H, { fwhm, meta = {} } = {}) {
    const kernel = gaussianKernel(fwhm);
    const { D, model } = stabilize(plane, W, H, meta);
    const raw = matchedFilter(D, W, H, kernel);
    const vstSigma = madSigmaOf(raw, 31);              // robust background σ of the raw response
    const s = Number.isFinite(vstSigma) && vstSigma > 1e-9 ? vstSigma : 1;
    const resp = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) resp[i] = Number.isFinite(raw[i]) ? raw[i] / s : NaN;
    return { resp, model, kernel, vst_response_sigma: vstSigma };
}

// robust MAD σ helper (response-plane health)
export function madSigmaOf(arr, stride = 1) {
    const s = [];
    for (let i = 0; i < arr.length; i += stride) { const v = arr[i]; if (Number.isFinite(v)) s.push(v); }
    const med = median(Float64Array.from(s));
    const dev = s.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    return (dev.length ? dev[dev.length >> 1] : NaN) / 0.6745;
}

// ── CLI driver (thin) ─────────────────────────────────────────────────────────
async function main() {
    const fs = await import('node:fs');
    const { loadFitsPlane } = await import('../denoise/denoise.mjs');
    const argv = process.argv.slice(2);
    const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
    const file = argv[0];
    if (!file) { console.error('usage: node tools/detect/mf_detect.mjs <plane.fits|plane.f32> [--w W --h H] [--fwhm 2.5] [--thresh 5] [--json]'); process.exit(2); }
    const fwhm = parseFloat(arg('--fwhm', '2.5'));
    const thr = parseFloat(arg('--thresh', '5'));
    let plane, W, H;
    if (/\.f32$/i.test(file)) {
        W = parseInt(arg('--w', '0'), 10); H = parseInt(arg('--h', '0'), 10);
        const raw = fs.readFileSync(file);
        plane = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
        if (!W || !H || W * H !== plane.length) { console.error(`--w/--h required and W*H must equal ${plane.length}`); process.exit(2); }
    } else {
        const fp = loadFitsPlane(file, 0);
        if (!fp) { console.error(`FITS not found: ${file}`); process.exit(2); }
        plane = fp.plane; W = fp.W; H = fp.H;
    }
    const { resp, model, kernel, vst_response_sigma } = mfResponse(plane, W, H, { fwhm });
    const cands = extractPeaks(resp, W, H, thr);
    const report = {
        file, W, H, fwhm, threshold_sigma: thr,
        kernel: { half: kernel.r, sigma: +kernel.sigma.toFixed(3), norm: +kernel.norm.toFixed(4) },
        noise_model: { source: model.source, label: model.approximate ? 'APPROXIMATE' : 'MEASURED', alpha: model.alpha, sigma: model.sigma, offset: model.offset },
        vst_response_sigma: +(+vst_response_sigma).toFixed(4),           // ideal ≈1 (VST health)
        normalized_response_mad: +madSigmaOf(resp, 97).toFixed(4),       // ≈1 by construction (sanity)
        candidates: cands.length,
    };
    if (arg('--json', null) !== null) console.log(JSON.stringify(report, null, 2));
    else console.log(`MF: ${cands.length} candidates ≥${thr}σ  (fwhm=${fwhm}px kσ=${kernel.sigma.toFixed(2)} ‖k‖=${kernel.norm.toFixed(3)}; noise=${report.noise_model.label}; VST resp σ=${report.vst_response_sigma})`);
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('MF_FAIL:', e.stack || e.message); process.exit(1); });
