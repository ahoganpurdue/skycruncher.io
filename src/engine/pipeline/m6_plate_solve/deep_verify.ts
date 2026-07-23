/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DEEP VERIFY — catalog-forced photometry for the solver (M6)
 * ═══════════════════════════════════════════════════════════════════════════
 * ENGINE PORT of `tools/psf/forced_detect.mjs` `forcedMeasure` (incubator law:
 * the tools/ file remains the reference implementation + CLI lane; this port
 * is the in-app consumer. The duplication is DELIBERATE and noted in both
 * headers — police divergence, not existence).
 *
 * Blind detection asks "where are the stars?"; forced detection asks "the
 * catalog says a star is HERE — how much flux is at that exact position?"
 * Fixing the position removes the position-search trials penalty, so a far
 * lower significance bar (~2σ) is honest: the hypothesis was formed BEFORE
 * looking at the pixels.
 *
 * TWO LEDGERS (owner law):
 *   position lane — catalog (ra_hours, dec_degrees) → gnomonic TAN about
 *     crval (HOURS internally, engine convention) → CD⁻¹ → pixel.
 *   pixel lane — matched-aperture photometry on the solver's detection grid:
 *     r_ap = max(2, 0.68·FWHM, 1.2·posRms) px
 *     background = sigma-clipped median of annulus [r_ap+3, r_ap+8]
 *       (widened until ≥ 40 px), local so gradients cancel
 *     flux = sum(aperture) − n_ap · bg_median
 *     noise = σ_local · sqrt(n_ap + n_ap²/n_ann)
 *     snr = flux / noise; accepted at snr ≥ threshold (default 2)
 *     STRUCTURED-BACKGROUND GUARD — CONDITIONAL on a supplied frame sigma:
 *     when the caller provides sigmaPix, an annulus whose scatter exceeds
 *     3·sigmaPix (terrain, foliage, nebular filaments) can never "accept".
 *     With sigmaPix null (the raw forcedMeasure default) the guard is a NO-OP
 *     and structured background CAN accept — callers must supply a measured
 *     sigma to arm it. Every live engine path does: runForcedPhotometry
 *     auto-derives sigmaPix via sampledBackgroundSigma when not overridden.
 *
 * Provenance: every forced measurement is tagged CATALOG_FORCED — aperture
 * flux at catalog-predicted positions, NEVER blind discoveries; downstream
 * consumers must not launder them into one.
 *
 * ESCALATION STATISTIC (verify-escalation seam, NEXT_MOVES §7·5a): the null
 * is calibrated ON-FRAME at deterministic scrambled positions; acceptance
 * compares the predicted-position acceptance count against the scrambled
 * base rate as a binomial excess z. Truth gains +10σ-class; junk collapses.
 */

import { SkyTransform } from '../../core/SkyTransform';
import type { WCSTransform } from '../../types/Main_types';
import { gainAt, type VignetteMap } from '../m10_psf/vignette_map';

export interface ForcedPosition {
    x: number;
    y: number;
    mag?: number | null;
    gaia_id?: string | null;
}

export interface ForcedMeasurement {
    x: number;
    y: number;
    mag: number | null;
    gaia_id: string | null;
    flux: number;
    snr: number;
    n_ap: number;
    bg: number;
    sigma_local: number;
    structured: boolean;
    accepted: boolean;
    provenance: 'CATALOG_FORCED';
    /** CELL ② — forced flux DIVIDED by the vignette transmission at (x,y) (luma
     *  band) = flux · gain. Set ONLY when a vignette map is supplied (default:
     *  absent). The raw `flux` above is preserved and is what forced_confirm's
     *  gate consumes — this is additive evidence, never the gate input. */
    flux_vignette_corrected?: number;
}

/**
 * Matched-aperture forced photometry at FIXED positions (no recentering —
 * recentering would bias faint fluxes up; see header). Direct port of
 * tools/psf/forced_detect.mjs::forcedMeasure — same math, same guards.
 */
export function forcedMeasure(args: {
    L: Float32Array;
    w: number;
    h: number;
    positions: ForcedPosition[];
    fwhmPx: number;
    posRmsPx?: number;
    snrThreshold?: number;
    sigmaPix?: number | null;
    /** CELL ② — OPTIONAL vignette map. When present each result gains a
     *  `flux_vignette_corrected` (luma band, additive); the raw `flux` and the
     *  accept/gate logic are untouched. Absent (the sacred call site) ⇒ no field
     *  ⇒ byte-identical. */
    vignette?: VignetteMap | null;
}): { rApPx: number; results: ForcedMeasurement[] } {
    const { L, w, h, positions, fwhmPx } = args;
    const posRmsPx = args.posRmsPx ?? 0;
    const snrThreshold = args.snrThreshold ?? 2;
    const sigmaPix = args.sigmaPix ?? null;
    const vignette = args.vignette ?? null;

    const rAp = Math.max(2, 0.68 * fwhmPx, 1.2 * posRmsPx);
    const rIn0 = rAp + 3;
    const out: ForcedMeasurement[] = [];
    for (const p of positions) {
        const cx = Math.round(p.x), cy = Math.round(p.y);
        const RA = Math.ceil(rAp);
        if (cx < RA + 1 || cy < RA + 1 || cx >= w - RA - 1 || cy >= h - RA - 1) continue;
        let apSum = 0, nAp = 0;
        for (let dy = -RA; dy <= RA; dy++) {
            for (let dx = -RA; dx <= RA; dx++) {
                if (dx * dx + dy * dy > rAp * rAp) continue;
                apSum += L[(cy + dy) * w + cx + dx];
                nAp++;
            }
        }
        // annulus, widened until >= 40 px inside the frame
        let rIn = rIn0, rOut = rIn0 + 5;
        const ann: number[] = [];
        for (let tries = 0; tries < 3; tries++) {
            ann.length = 0;
            const RO = Math.ceil(rOut);
            for (let dy = -RO; dy <= RO; dy++) {
                const Y = cy + dy;
                if (Y < 0 || Y >= h) continue;
                for (let dx = -RO; dx <= RO; dx++) {
                    const X = cx + dx;
                    if (X < 0 || X >= w) continue;
                    const r2 = dx * dx + dy * dy;
                    if (r2 < rIn * rIn || r2 > rOut * rOut) continue;
                    ann.push(L[Y * w + X]);
                }
            }
            if (ann.length >= 40) break;
            rOut += 3;
        }
        if (ann.length < 12) continue;
        // sigma-clipped background (median/MAD, one clip round)
        ann.sort((a, b) => a - b);
        let med = ann[ann.length >> 1];
        let dev = ann.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
        let sig = 1.4826 * dev[dev.length >> 1];
        const kept = ann.filter((v) => Math.abs(v - med) <= 3 * sig);
        if (kept.length >= 12) {
            med = kept[kept.length >> 1];
            dev = kept.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
            sig = 1.4826 * dev[dev.length >> 1];
        }
        const sigmaLocal = Math.max(sig, sigmaPix != null ? 0.5 * sigmaPix : 0, 1e-9);
        // STRUCTURED-BACKGROUND GUARD (same law as the render stage)
        const structured = sigmaPix != null && sig > 3 * sigmaPix;
        const flux = apSum - nAp * med;
        const noise = sigmaLocal * Math.sqrt(nAp + (nAp * nAp) / kept.length);
        const snr = flux / noise;
        const rec: ForcedMeasurement = {
            x: p.x, y: p.y, mag: p.mag ?? null, gaia_id: p.gaia_id ?? null,
            flux, snr, n_ap: nAp, bg: med, sigma_local: sigmaLocal,
            structured,
            accepted: !structured && snr >= snrThreshold,
            provenance: 'CATALOG_FORCED',
        };
        // CELL ② — additive corrected flux ONLY when a map is supplied (default:
        // no key added ⇒ byte-identical result object).
        if (vignette) rec.flux_vignette_corrected = flux * gainAt(vignette, p.x, p.y, 'luma');
        out.push(rec);
    }
    return { rApPx: rAp, results: out };
}

// ── position lane (coordinate math only — no pixels touched) ─────────────────

/**
 * Project catalog stars through a linear WCS into pixel space (engine
 * conventions: crval[0]/ra_hours in HOURS; CD in deg/px). Returns only
 * in-frame positions, optionally restricted to a radius around a point
 * (ultra-wide: the linear WCS only holds near the anchor patch).
 */
export function projectCatalogToPixels(args: {
    stars: { ra_hours: number; dec_degrees: number; magnitude_V?: number; gaia_id?: string }[];
    wcs: WCSTransform;
    w: number;
    h: number;
    margin?: number;
    withinRadiusPx?: { x: number; y: number; r: number };
}): ForcedPosition[] {
    const { stars, wcs, w, h } = args;
    const margin = args.margin ?? 10;
    const [[c11, c12], [c21, c22]] = wcs.cd;
    const det = c11 * c22 - c12 * c21;
    if (Math.abs(det) < 1e-18) return [];
    const out: ForcedPosition[] = [];
    for (const s of stars) {
        const p = SkyTransform.gnomonicProject(s.ra_hours, s.dec_degrees, wcs.crval[0], wcs.crval[1]);
        if (!Number.isFinite(p.xi) || !Number.isFinite(p.eta)) continue;
        const x = wcs.crpix[0] + (c22 * p.xi - c12 * p.eta) / det;
        const y = wcs.crpix[1] + (-c21 * p.xi + c11 * p.eta) / det;
        if (x < margin || y < margin || x >= w - margin || y >= h - margin) continue;
        if (args.withinRadiusPx) {
            const d = Math.hypot(x - args.withinRadiusPx.x, y - args.withinRadiusPx.y);
            if (d > args.withinRadiusPx.r) continue;
        }
        out.push({ x, y, mag: s.magnitude_V ?? null, gaia_id: s.gaia_id ?? null });
    }
    return out;
}

// ── pixel-lane support ───────────────────────────────────────────────────────

/**
 * Plain-JS luminance from RGBA ImageData (same weights as SourceExtractor's
 * fallback: 0.299/0.587/0.114 over 0..255 → 0..1). Deterministic, no WASM —
 * the escalation must behave identically in the browser and in vitest.
 */
export function luminanceFromImageData(imageData: { data: Uint8ClampedArray; width: number; height: number }): Float32Array {
    const { data, width, height } = imageData;
    const size = width * height;
    const lum = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        lum[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255.0;
    }
    return lum;
}

/**
 * Robust frame-noise estimate: median + MAD over a strided sample (prime
 * stride avoids row aliasing). Deterministic. Feeds forcedMeasure's
 * structured-background guard and noise floor.
 */
export function sampledBackgroundSigma(L: Float32Array): { median: number; sigma: number } {
    const sample: number[] = [];
    for (let i = 0; i < L.length; i += 997) sample.push(L[i]);
    sample.sort((a, b) => a - b);
    const median = sample[sample.length >> 1] ?? 0;
    const dev = sample.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    const sigma = 1.4826 * (dev[dev.length >> 1] ?? 0);
    return { median, sigma: Math.max(sigma, 1e-9) };
}

/**
 * Median measured FWHM (px) of the detection set — the single source of the
 * forced-aperture size for BOTH forced-photometry lanes (escalation +
 * post-solve harvest) and the confirmation pass. Extracted verbatim from the
 * two inline copies (solver_entry escalation + harvest) so the aperture width
 * is chosen ONCE, identically, and can no longer silently diverge between the
 * lanes that measure the same flux at the same catalog positions.
 * `fwhms.length ? fwhms[fwhms.length>>1] : fallback` — byte-identical to both.
 */
export function computeFrameFwhmPx(
    detected: { fwhm?: number }[],
    fallbackPx = 2.5,
): number {
    const fwhms = detected
        .map(d => d.fwhm)
        .filter((f): f is number => Number.isFinite(f as number) && (f as number) > 0)
        .sort((a, b) => a - b);
    return fwhms.length ? fwhms[fwhms.length >> 1] : fallbackPx;
}

/**
 * ONE shared forced-photometry composition (the de-forked context builder the
 * duplication review requires). Given a luminance/native grid + the catalog-
 * projected positions + the detection set, it derives the frame noise and the
 * forced-aperture FWHM identically and runs `forcedMeasure`. BOTH the solve-
 * side escalation and the post-solve densification/confirmation consume this,
 * so the grid → noise → fwhm → aperture → measure sequence lives in a single
 * place. Pure over the supplied grid (no catalog paging, no projection — those
 * differ per lane and stay in the callers). Leaf primitives (forcedMeasure,
 * sampledBackgroundSigma, computeFrameFwhmPx) are reused unchanged.
 */
export function runForcedPhotometry(args: {
    L: Float32Array;
    w: number;
    h: number;
    positions: ForcedPosition[];
    /** Detection set — median fwhm sets the aperture (computeFrameFwhmPx). */
    detected: { fwhm?: number }[];
    posRmsPx?: number;
    snrThreshold?: number;
    /** Override the frame sigma (else sampledBackgroundSigma over L). */
    sigmaPix?: number | null;
    fwhmFallbackPx?: number;
}): { rApPx: number; results: ForcedMeasurement[]; fwhmPx: number; sigmaPix: number } {
    const fwhmPx = computeFrameFwhmPx(args.detected, args.fwhmFallbackPx ?? 2.5);
    const sigmaPix = args.sigmaPix ?? sampledBackgroundSigma(args.L).sigma;
    const { rApPx, results } = forcedMeasure({
        L: args.L, w: args.w, h: args.h, positions: args.positions,
        fwhmPx, posRmsPx: args.posRmsPx, snrThreshold: args.snrThreshold,
        sigmaPix,
    });
    return { rApPx, results, fwhmPx, sigmaPix };
}

/** Deterministic PRNG (mulberry32) — the scrambled null must be reproducible
 *  run-to-run or the calibrated gates would wobble. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Uniform in-frame scrambled positions (the on-frame chance null). Chance
 *  hits on real stars are PART of the base rate — do not avoid them.
 *
 *  `localAnnulus` mode (the per-star confirmation null, C3): direct
 *  AREA-UNIFORM polar sampling inside [rIn,rOut] about a center — NOT the
 *  frame-uniform sampler with a radius-reject guard (which exhausts on a small
 *  per-star disk and silently under-fills K). One generator, one PRNG
 *  (mulberry32), two modes — the frame-level and the per-star nulls share it. */
export function scrambledPositions(args: {
    n: number; w: number; h: number; margin?: number; seed: number;
    withinRadiusPx?: { x: number; y: number; r: number };
    localAnnulus?: { x: number; y: number; rIn: number; rOut: number };
}): ForcedPosition[] {
    const margin = args.margin ?? 10;
    const rnd = mulberry32(args.seed);
    const out: ForcedPosition[] = [];
    let guard = 0;
    if (args.localAnnulus) {
        const { x: cx, y: cy, rIn, rOut } = args.localAnnulus;
        const rIn2 = rIn * rIn, span = rOut * rOut - rIn * rIn;
        while (out.length < args.n && guard++ < args.n * 50) {
            const ang = rnd() * 2 * Math.PI;
            const r = Math.sqrt(rIn2 + rnd() * span); // area-uniform in the annulus
            const x = cx + r * Math.cos(ang);
            const y = cy + r * Math.sin(ang);
            if (x < margin || y < margin || x >= args.w - margin || y >= args.h - margin) continue;
            out.push({ x, y });
        }
        return out;
    }
    while (out.length < args.n && guard++ < args.n * 100) {
        const x = margin + rnd() * (args.w - 2 * margin);
        const y = margin + rnd() * (args.h - 2 * margin);
        if (args.withinRadiusPx) {
            if (Math.hypot(x - args.withinRadiusPx.x, y - args.withinRadiusPx.y) > args.withinRadiusPx.r) continue;
        }
        out.push({ x, y });
    }
    return out;
}

// ── ensemble statistic (shared) ──────────────────────────────────────────────

/**
 * Binomial excess z of `observed` acceptances out of `n` trials against an
 * on-frame null base rate. Continuity floor on p0 (an all-zero null would
 * otherwise divide by zero — floor at half an acceptance over the null draws).
 * ONE implementation shared by the escalation statistic (deepVerifyEscalation)
 * and the set-level confirmation gate (forced_confirm.confirmForcedSet) so the
 * family-wise excess math cannot fork. Reproduces deepVerifyEscalation's exact
 * prior formula: p0 = max(nullRate, 0.5/nullN); z = (obs - n·p0)/√(n·p0·(1-p0)).
 */
export function binomialExcessZ(observed: number, n: number, nullRate: number, nullN: number): number {
    if (n <= 0) return 0;
    const p0 = Math.max(nullRate, 0.5 / Math.max(nullN, 1));
    const denom = Math.sqrt(n * p0 * (1 - p0));
    if (!(denom > 0)) return 0;
    return (observed - n * p0) / denom;
}

// ── escalation statistic ─────────────────────────────────────────────────────

export interface DeepVerifyEscalationResult {
    nPred: number;
    predAccepted: number;
    predStructured: number;
    predFrac: number;
    nNull: number;
    nullAccepted: number;
    nullFrac: number;
    /** Binomial excess of predicted-position acceptances over the scrambled
     *  on-frame base rate. The +10σ-class gate reads this. */
    excessZ: number;
    rApPx: number;
    fwhmPx: number;
    snrThreshold: number;
}

/**
 * Catalog-forced escalation: measure at predicted positions, calibrate the
 * null at scrambled on-frame positions (same count × `scrambles` draws), and
 * return the binomial excess. Pure function over the supplied luminance —
 * the solver decides what to do with the number (gates live in the caller
 * with the other calibrated constants).
 */
export function deepVerifyEscalation(args: {
    L: Float32Array;
    w: number;
    h: number;
    predicted: ForcedPosition[];
    fwhmPx: number;
    /** Astrometric-model positional RMS (px) — widens r_ap honestly; the
     *  scrambled null uses the SAME aperture so the base rate stays fair. */
    posRmsPx?: number;
    sigmaPix?: number | null;
    snrThreshold?: number;
    scrambles?: number;
    seed?: number;
    withinRadiusPx?: { x: number; y: number; r: number };
}): DeepVerifyEscalationResult | null {
    const snrThreshold = args.snrThreshold ?? 2;
    const scrambles = args.scrambles ?? 5;
    const seed = args.seed ?? 0x5EE57A57; // deterministic default
    const posRmsPx = args.posRmsPx ?? 0;
    if (args.predicted.length < 10) return null; // too few probes for a statistic

    const pred = forcedMeasure({
        L: args.L, w: args.w, h: args.h, positions: args.predicted,
        fwhmPx: args.fwhmPx, posRmsPx, snrThreshold, sigmaPix: args.sigmaPix ?? null,
    });
    const nPred = pred.results.length;
    if (nPred < 10) return null;
    const predAccepted = pred.results.filter(r => r.accepted).length;
    const predStructured = pred.results.filter(r => r.structured).length;

    let nNull = 0, nullAccepted = 0;
    for (let s = 0; s < scrambles; s++) {
        const nullPos = scrambledPositions({
            n: args.predicted.length, w: args.w, h: args.h,
            seed: seed + s * 7919, withinRadiusPx: args.withinRadiusPx,
        });
        const nul = forcedMeasure({
            L: args.L, w: args.w, h: args.h, positions: nullPos,
            fwhmPx: args.fwhmPx, posRmsPx, snrThreshold, sigmaPix: args.sigmaPix ?? null,
        });
        nNull += nul.results.length;
        nullAccepted += nul.results.filter(r => r.accepted).length;
    }
    if (nNull < 10) return null;

    // Binomial excess with a continuity floor on the base rate (an all-zero
    // null would otherwise divide by zero — floor at half an acceptance).
    const p0 = Math.max(nullAccepted / nNull, 0.5 / nNull);
    const excessZ = (predAccepted - nPred * p0) / Math.sqrt(nPred * p0 * (1 - p0));

    return {
        nPred, predAccepted, predStructured,
        predFrac: predAccepted / nPred,
        nNull, nullAccepted,
        nullFrac: nullAccepted / nNull,
        excessZ,
        rApPx: pred.rApPx,
        fwhmPx: args.fwhmPx,
        snrThreshold,
    };
}
