/**
 * ═══════════════════════════════════════════════════════════════════════════
 * M10 PSF — spatially-varying PSF characterization (ROADMAP Phase S · item 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL. Measures the PSF on the NATIVE untouched pixel grid at the
 * SOLVED star positions (the coordinate ledger supplies WHERE; this module
 * reads pixels and never touches the WCS, matched_stars or solve confidence).
 * Per-star 2D-Gaussian fits → a FWHM / ellipticity / orientation field
 * (a 3×3 map = coma / astigmatism characterization across the frame).
 *
 * Fitter: the compiled Rust Levenberg-Marquardt primitive
 * `wasm_compute.refine_stars_lm` (models A·exp(-quadratic), NO pedestal term
 * — so we local-background-subtract each stamp before fitting; that is a
 * per-pixel scalar op, NOT a resample). The fitter is INJECTABLE and the
 * module is headless/mock-safe: when no compiled fitter is available (e.g.
 * the vitest wasm mock) it degrades HONESTLY to the moment-based measure
 * (psf_core.measureStar) and labels the report method accordingly — it never
 * fabricates a Gaussian fit it did not run.
 *
 * INCUBATOR NOTE (LAW 4): the moment primitives are shared with the tools/psf
 * headless lane via psf_core (ported, single home). The LM fitter lives ONLY
 * in Rust (wasm_compute/src/photometry.rs::fit_gaussian_2d); this module is
 * its first caller. No numeric algorithm is duplicated in TS.
 *
 * Typed input/output; event bus injected (never imported from a singleton).
 */

import {
    measureStar, robustStats, pixelNoiseSigma, regionGrid3x3, medianOf,
    PsfStarMeasure
} from './psf_core';
import type { PipelineEventBus } from '../../events/pipeline_events';
import { gainAt, type VignetteMap } from './vignette_map';
// Namespace import: resolves to the engine's single wasm module instance in
// the browser / headless (real compiled fitter present) and to the vitest
// mock in default unit tests (refine_stars_lm absent → moment fallback).
import * as wasmCompute from '../../wasm_compute/pkg/wasm_compute';

const FW = 2 * Math.sqrt(2 * Math.log(2)); // 2.354820045 — FWHM per unit sigma

// ─── contracts ──────────────────────────────────────────────────────────────

/** A star position on the science-buffer's own (native) pixel grid. */
export interface PsfFieldStar { x: number; y: number; }

/**
 * The compiled LM stamp fitter contract (matches wasm `refine_stars_lm`):
 * `pixelsFlat` = N concatenated equal-size stamps (each stampW·stampH, f32);
 * `paramsFlat` = [A, cx, cy, sx, sy, theta] per star (f64) initial guess;
 * returns the refined [A, cx, cy, sx, sy, theta] per star.
 */
export type StampFitter = (
    pixelsFlat: Float32Array, stampW: number, stampH: number, paramsFlat: Float64Array
) => Float64Array | Float64Array[] | ArrayLike<number>;

export type PsfFieldMethod = 'WASM_LM_GAUSSIAN' | 'MOMENT_FALLBACK' | 'NOT_MEASURED';

export interface PsfFieldFit {
    /** Refined center in NATIVE-grid pixels. */
    x: number; y: number;
    amp: number;
    /** Gaussian sigmas (px) along the fitted principal axes. */
    sigmaMajPx: number; sigmaMinPx: number;
    fwhmMajPx: number; fwhmMinPx: number;
    /** 1 − minor/major (0 = round, →1 = elongated). */
    ellipticity: number;
    /** Major-axis position angle, degrees in [0,180) from +x (image space). */
    orientationDeg: number;
    /** How THIS star was measured (fit may fall back per-star even when the run is LM). */
    source: 'lm' | 'moment';
    /** CELL ② — vignette/transmission flux-recovery gain at this star (luma band),
     *  or undefined when no vignette map was supplied (default). Additive. */
    vignetteGain?: number;
    /** CELL ② — amp DIVIDED by the vignette transmission (= amp·vignetteGain),
     *  the flux corrected for optical falloff at the star's position. Raw `amp` is
     *  preserved above; this is reported ALONGSIDE it. undefined when no map. */
    ampVignetteCorrected?: number;
}

export interface PsfFieldRegion {
    n: number;
    fwhmMedianPx: number | null;
    ellipticityMedian: number | null;
    orientationMedianDeg: number | null;
}

export interface PsfFieldReport {
    ledger: 'PIXEL';
    /** Which pixel grid the FWHM numbers live in (set by the caller). */
    grid?: 'SCIENCE_NATIVE' | 'SCIENCE_BINNED2X';
    width: number; height: number;
    method: PsfFieldMethod;
    /** Square stamp edge (px) used for every fit. */
    stampSize: number;
    nInput: number;
    /** Stars that produced a usable measurement. */
    nFit: number;
    /** Stars measured by the LM fit vs the moment fallback. */
    nLm: number; nMoment: number;
    rejected: Record<string, number>;
    /** Median over all fits. Null when nothing was measurable (honest absence). */
    fwhmMedianMajPx: number | null;
    fwhmMedianMinPx: number | null;
    ellipticityMedian: number | null;
    orientationMedianDeg: number | null;
    /** 3×3 region grids, row-major top-left → bottom-right (the coma/astig map). */
    regions: PsfFieldRegion[];
    /** Per-star fits (native-grid positions). */
    fits: PsfFieldFit[];
    /** Every approximation, spelled out (UI must render these as APPROXIMATE). */
    approximate: string[];
    /** Set ONLY when method === 'NOT_MEASURED': why nothing was measured. */
    notMeasured?: string;
    timings: Record<string, number>;
}

export interface PsfFieldOptions {
    /** Half-size of the square fit stamp (default 8 → 17×17). */
    stampRadius?: number;
    /** Cap on stars actually fitted (brightest-first). Default 400. */
    maxStars?: number;
    /** Reject a stamp whose peak-above-background is below this ×σ. Default 5. */
    minPeakSigma?: number;
}

export interface PsfFieldInput {
    /** Luminance science buffer (w·h), pixel ledger, on its own grid. */
    lum: Float32Array;
    width: number;
    height: number;
    /** Solved star positions (native-grid pixels). */
    stars: PsfFieldStar[];
    options?: PsfFieldOptions;
    /**
     * LM stamp fitter. Default: the compiled wasm `refine_stars_lm` if
     * present, else undefined → the whole run degrades to MOMENT_FALLBACK.
     */
    fit?: StampFitter;
    /** CELL ② — OPTIONAL vignette/transmission map. When supplied, each fit gains
     *  a `vignetteGain` + `ampVignetteCorrected` (luma band, at the fit position),
     *  reported ALONGSIDE the raw amp. The flag-gate lives in the caller (the map
     *  is produced + passed only when PSF_FLUX_VIGNETTE_CORRECT is ON), so absence
     *  (default) ⇒ no correction ⇒ byte-identical. */
    vignette?: VignetteMap | null;
    events?: PipelineEventBus;
}

// ─── internals ──────────────────────────────────────────────────────────────

/**
 * The default fitter: the compiled Rust LM, or null when it isn't loaded.
 * The try/catch is load-bearing: a strict ESM mock (vitest setup.ts) THROWS
 * on access to an undefined export — which is precisely the "no compiled
 * fitter" case we degrade on (→ MOMENT_FALLBACK), not an error.
 */
function resolveDefaultFitter(): StampFitter | null {
    try {
        const fn = (wasmCompute as any).refine_stars_lm;
        return typeof fn === 'function' ? (fn as StampFitter) : null;
    } catch {
        return null;
    }
}

/**
 * Sigmas (sx,sy) + rotation θ → major/minor FWHM, ellipticity and the
 * major-axis position angle in [0,180). The Rust Gaussian places sx along the
 * x′ axis rotated by θ; the major axis is x′ when sx≥sy, else y′ (θ+90°).
 */
function shapeFromSigmas(sx: number, sy: number, thetaRad: number) {
    const sMaj = Math.max(sx, sy);
    const sMin = Math.min(sx, sy);
    let paDeg = (sx >= sy ? thetaRad : thetaRad + Math.PI / 2) * 180 / Math.PI;
    paDeg = ((paDeg % 180) + 180) % 180; // fold to [0,180)
    return {
        sigmaMajPx: sMaj,
        sigmaMinPx: sMin,
        fwhmMajPx: FW * sMaj,
        fwhmMinPx: FW * sMin,
        ellipticity: sMaj > 0 ? 1 - sMin / sMaj : 0,
        orientationDeg: paDeg
    };
}

/** Moment measure → a PsfFieldFit (the honest fallback / per-star rescue). */
function fitFromMoment(m: PsfStarMeasure): PsfFieldFit {
    const sMaj = m.fwhmMaj / FW, sMin = m.fwhmMin / FW;
    let paDeg = ((m.thetaDeg % 180) + 180) % 180;
    return {
        x: m.cx, y: m.cy, amp: m.peakAboveBg,
        sigmaMajPx: sMaj, sigmaMinPx: sMin,
        fwhmMajPx: m.fwhmMaj, fwhmMinPx: m.fwhmMin,
        ellipticity: m.ellipticity, orientationDeg: paDeg,
        source: 'moment'
    };
}

// ─── the stage ──────────────────────────────────────────────────────────────

/**
 * Characterize the spatially-varying PSF at the solved star positions.
 *
 * Pure/synchronous (the LM fit is CPU/wasm; no RL, no GPU) — safe to call on
 * the headless critical path. Never throws on a bad star; refuses only a
 * length/dimension lie.
 */
export function characterizePsfField(input: PsfFieldInput): PsfFieldReport {
    const { lum, width: w, height: h } = input;
    const o = input.options ?? {};
    const stampR = Math.max(4, Math.floor(o.stampRadius ?? 8));
    const maxStars = o.maxStars ?? 400;
    const minPeakSigma = o.minPeakSigma ?? 5;
    const stampSize = 2 * stampR + 1;
    const approximate: string[] = [];
    const timings: Record<string, number> = {};
    let t0 = Date.now();

    if (lum.length !== w * h) {
        throw new Error(`PSF field: buffer length ${lum.length} != ${w}×${h}`);
    }

    const fitter = input.fit ?? resolveDefaultFitter();
    const { med: pedestal } = robustStats(lum);
    const sigmaPixel = pixelNoiseSigma(lum);

    const base: PsfFieldReport = {
        ledger: 'PIXEL',
        width: w, height: h,
        method: 'NOT_MEASURED',
        stampSize,
        nInput: input.stars.length,
        nFit: 0, nLm: 0, nMoment: 0,
        rejected: { edge: 0, faint: 0, momentFailed: 0, fitRejected: 0 },
        fwhmMedianMajPx: null, fwhmMedianMinPx: null,
        ellipticityMedian: null, orientationMedianDeg: null,
        regions: Array.from({ length: 9 }, () => ({
            n: 0, fwhmMedianPx: null, ellipticityMedian: null, orientationMedianDeg: null
        })),
        fits: [],
        approximate,
        timings
    };

    if (input.stars.length === 0) {
        base.notMeasured = 'No solved star positions supplied — PSF field NOT MEASURED.';
        return base;
    }

    // ── Candidate stamps: dedupe near-identical positions, drop edge/faint,
    //    seed each with a moment measure (also the per-star fallback). ──
    const margin = stampR + 2;
    interface Cand {
        px: number; py: number;          // integer stamp center (native)
        seed: PsfStarMeasure;            // moment seed / fallback
    }
    const seen = new Set<number>();
    const cands: Cand[] = [];
    for (const s of input.stars) {
        const px = Math.round(s.x), py = Math.round(s.y);
        if (px < margin || py < margin || px >= w - margin || py >= h - margin) {
            base.rejected.edge++; continue;
        }
        const key = py * w + px;
        if (seen.has(key)) continue;
        seen.add(key);
        const m = measureStar(lum, w, h, px, py, sigmaPixel, stampR);
        if (!m) { base.rejected.momentFailed++; continue; }
        if (m.peakAboveBg < minPeakSigma * sigmaPixel) { base.rejected.faint++; continue; }
        cands.push({ px, py, seed: m });
    }
    // Brightest first, then cap (a dense field needn't fit thousands).
    cands.sort((a, b) => b.seed.peakAboveBg - a.seed.peakAboveBg);
    const used = cands.slice(0, maxStars);
    timings.seed_ms = Date.now() - t0; t0 = Date.now();

    if (used.length === 0) {
        base.notMeasured =
            `All ${input.stars.length} positions rejected (edge=${base.rejected.edge}, ` +
            `faint=${base.rejected.faint}, momentFailed=${base.rejected.momentFailed}) — PSF field NOT MEASURED.`;
        return base;
    }

    const fits: PsfFieldFit[] = [];
    let usedLm = false;

    if (fitter) {
        // ── Batch LM path: local-background-subtract each stamp (the Rust
        //    model has no pedestal term), pack uniform stamps + seeds. ──
        const N = used.length;
        const pixelsPerStar = stampSize * stampSize;
        const pixelsFlat = new Float32Array(N * pixelsPerStar);
        const paramsFlat = new Float64Array(N * 6);
        for (let s = 0; s < N; s++) {
            const { px, py, seed } = used[s];
            const bg = seed.bgLoc;
            const pOff = s * pixelsPerStar;
            for (let j = 0; j < stampSize; j++) {
                const srcRow = (py - stampR + j) * w + (px - stampR);
                const dstRow = pOff + j * stampSize;
                for (let i = 0; i < stampSize; i++) {
                    pixelsFlat[dstRow + i] = lum[srcRow + i] - bg; // scalar bg-subtract, no resample
                }
            }
            // seed [A, cx, cy, sx, sy, theta] in STAMP-LOCAL coords
            const q = s * 6;
            paramsFlat[q]     = Math.max(seed.peakAboveBg, 1e-6);
            paramsFlat[q + 1] = seed.cx - (px - stampR);
            paramsFlat[q + 2] = seed.cy - (py - stampR);
            paramsFlat[q + 3] = Math.max(0.6, seed.fwhmMaj / FW);
            paramsFlat[q + 4] = Math.max(0.6, seed.fwhmMin / FW);
            paramsFlat[q + 5] = (seed.thetaDeg * Math.PI) / 180;
        }

        let out: ArrayLike<number> | null = null;
        try {
            const r = fitter(pixelsFlat, stampSize, stampSize, paramsFlat);
            out = Array.isArray(r) ? (r as any).flat?.() ?? r : (r as ArrayLike<number>);
        } catch (err) {
            approximate.push(`LM fitter threw (${err instanceof Error ? err.message : String(err)}) — fell back to moment measures for all stars.`);
            out = null;
        }

        if (out && out.length >= N * 6) {
            usedLm = true;
            const maxSigma = stampR; // a fit wider than the stamp is untrustworthy
            for (let s = 0; s < N; s++) {
                const { px, py, seed } = used[s];
                const q = s * 6;
                const amp = out[q];
                const lcx = out[q + 1], lcy = out[q + 2];
                const sx = Math.abs(out[q + 3]), sy = Math.abs(out[q + 4]);
                const theta = out[q + 5];
                const centered = Math.abs(lcx - stampR) <= 2.5 && Math.abs(lcy - stampR) <= 2.5;
                const sane = Number.isFinite(amp) && amp > 0 &&
                    Number.isFinite(sx) && Number.isFinite(sy) &&
                    sx >= 0.5 && sy >= 0.5 && sx <= maxSigma && sy <= maxSigma &&
                    centered;
                if (sane) {
                    const shape = shapeFromSigmas(sx, sy, theta);
                    fits.push({
                        x: (px - stampR) + lcx, y: (py - stampR) + lcy,
                        amp, source: 'lm', ...shape
                    });
                } else {
                    base.rejected.fitRejected++;
                    fits.push(fitFromMoment(seed)); // honest per-star rescue
                }
            }
        } else {
            if (out) approximate.push(`LM fitter returned ${out.length} params for ${N} stars — fell back to moment measures.`);
            for (const c of used) fits.push(fitFromMoment(c.seed));
        }
    } else {
        // No compiled fitter (mock / not booted): honest moment field.
        approximate.push('Compiled Gaussian LM fitter unavailable — FWHM/ellipticity from second moments (MOMENT_FALLBACK).');
        for (const c of used) fits.push(fitFromMoment(c.seed));
    }
    timings.fit_ms = Date.now() - t0;

    // ── CELL ② — vignette/transmission flux correction (additive, luma band) ──
    // Only when a map is supplied (the caller produces it iff the flag is ON).
    // Divides the extracted amp by the transmission at the star's NATIVE position
    // (= amp · gain); raw amp preserved. Never a buffer pre-warp (MULTILAYER §4).
    if (input.vignette) {
        for (const f of fits) {
            const g = gainAt(input.vignette, f.x, f.y, 'luma');
            f.vignetteGain = +g.toFixed(6);
            f.ampVignetteCorrected = f.amp * g;
        }
        approximate.push('CELL② vignette flux correction applied to psf_field amp (luma band, reported alongside raw amp) — APPROXIMATE, EXPERIMENTAL.');
    }

    // ── Aggregate ──
    base.method = usedLm ? 'WASM_LM_GAUSSIAN' : 'MOMENT_FALLBACK';
    base.fits = fits;
    base.nFit = fits.length;
    base.nLm = fits.filter(f => f.source === 'lm').length;
    base.nMoment = fits.filter(f => f.source === 'moment').length;
    base.fwhmMedianMajPx = medianOf(fits.map(f => f.fwhmMajPx));
    base.fwhmMedianMinPx = medianOf(fits.map(f => f.fwhmMinPx));
    base.ellipticityMedian = medianOf(fits.map(f => f.ellipticity));
    base.orientationMedianDeg = medianOf(fits.map(f => f.orientationDeg));

    // Region maps reuse the shared 3×3 median helper (expects cx/cy keys).
    const asCxCy = fits.map(f => ({ cx: f.x, cy: f.y, fwhmMajPx: f.fwhmMajPx, ellipticity: f.ellipticity, orientationDeg: f.orientationDeg }));
    const fwhmGrid = regionGrid3x3(asCxCy, w, h, 'fwhmMajPx');
    const ellGrid = regionGrid3x3(asCxCy, w, h, 'ellipticity');
    const oriGrid = regionGrid3x3(asCxCy, w, h, 'orientationDeg');
    base.regions = fwhmGrid.map((g, i) => ({
        n: g.n,
        fwhmMedianPx: g.median,
        ellipticityMedian: ellGrid[i].median,
        orientationMedianDeg: oriGrid[i].median
    }));

    if (base.method === 'WASM_LM_GAUSSIAN') {
        approximate.push('Local background subtracted per stamp (constant border median) before the LM fit — the Rust Gaussian carries no pedestal term.');
        if (base.nMoment > 0) approximate.push(`${base.nMoment}/${base.nFit} stars fell back to moment measures (LM rejected as non-physical).`);
    }

    // Reuse the existing psf_measured finding kind (no event-type change).
    input.events?.emit({
        kind: 'finding',
        finding: {
            kind: 'psf_measured',
            nStars: base.nFit,
            fwhmMedianPx: base.fwhmMedianMajPx != null ? +base.fwhmMedianMajPx.toFixed(3) : 0
        }
    });

    return base;
}
