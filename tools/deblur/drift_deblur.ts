/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DRIFT-DEBLUR LANE — known-kernel sidereal-drift deconvolution (PIXEL ledger)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The FIRST bridge that feeds a proven MEASUREMENT back into the image. It
 * deconvolves a frame with the EXACT sidereal-drift PSF kernel that the
 * PSF-ATTRIBUTION stage emits — and ONLY when attribution says drift is
 * `CONFIRMED_PRESENT`. Because the kernel is CALCULATED (immutable celestial
 * mechanics: `15.041″/s · cos(Dec) · t`, oriented along the RA axis), not fit
 * or guessed, this is a WELL-POSED, measurement-grade deconvolution.
 *
 * TWO-LEDGER LAW (non-negotiable): this is a PIXEL / render op, POST-solve. The
 * MEASUREMENT (psf_field, WCS, matched_stars, forced photometry) is NEVER re-run
 * on the deblurred pixels — the native grid stays the sole measurement source.
 * It is a DECONVOLUTION, not a warp: it does NOT consume the one-warp budget.
 *
 * REUSE (LAW-4, no code in two places):
 *   • deconvolution   → m10_psf/rl_deconv.ts  (damped Richardson–Lucy + convolve2d)
 *   • exact kernel     → m10_psf/psf_physics.ts (driftPsfKernel: uniform line)
 *   • measurement      → m10_psf/psf_core.ts   (measureStar, pixelNoiseSigma)
 *   • epistemic contract → tools/denoise/ml_stubs/types.ts
 *       (PreservationProof / ProofMetric / classifyEpistemic / emptyProof)
 *
 * EPISTEMICS (the point): every pixel-affecting op must ship a machine-checkable
 * PreservationProof. Because the kernel is EXACT, a PASSING proof PROMOTES the op
 * to VERIFIED_PRESERVING (measurement-grade). A FAILING proof stays AESTHETIC and
 * is FLAGGED — never silently accepted. `classifyEpistemic` is the sole choke-point.
 *
 * DEFAULT-OFF: `runDriftDeblur` requires `enabled: true`; otherwise it returns a
 * null/honest-absent report (LAW-3). The `deblur` receipt block is null on absence.
 *
 * RUNNER NOTE: like the other engine-importing tools/*.ts (tools/validation,
 * tools/asdf), this lane reuses the engine deconvolution graph and therefore runs
 * under the repo's TS-aware runner (vitest/vite) — the rigorous proof lives in
 * src/engine/tests/drift_deblur.test.ts.
 */

import { convolve2d, richardsonLucyWindow } from '../../src/engine/pipeline/m10_psf/rl_deconv';
import { measureStar, pixelNoiseSigma } from '../../src/engine/pipeline/m10_psf/psf_core';
import type { PsfKernel } from '../../src/engine/pipeline/m10_psf/psf_core';
import { foldPa180 } from '../../src/engine/pipeline/m10_psf/psf_physics';
import type { DriftKernel } from '../../src/engine/pipeline/m10_psf/psf_physics';
import type { DriftPresence } from '../../src/engine/pipeline/stages/psf_attribution';
import {
    classifyEpistemic, emptyProof, NOT_MEASURED,
} from '../denoise/ml_stubs/types';
import type {
    PreservationProof, ProofMetric, EpistemicType,
} from '../denoise/ml_stubs/types';

const DEG = Math.PI / 180;

/** DEFAULT-OFF flag — the lane never runs unless a caller explicitly enables it. */
export const DRIFT_DEBLUR_DEFAULT_OFF = false as const;

export const DEBLUR_DEFAULTS = Object.freeze({
    /** Damped-RL iterations for a known-line kernel (converges well; damping caps ringing). */
    iters: 30,
    /** Extra padding (px) beyond the half-trail when sizing the rasterized kernel. */
    kernelPadPx: 2,
    /** Line supersampling per px for the anti-aliased uniform-line kernel. */
    kernelOversample: 8,
});

// ─── EXACT kernel rasterization (the uniform sidereal line) ───────────────────

function splat(k: Float64Array, size: number, x: number, y: number, w: number): void {
    if (x < 0 || y < 0 || x >= size || y >= size || w === 0) return;
    k[y * size + x] += w;
}

/**
 * Rasterize the EXACT drift kernel — a UNIFORM LINE of `lengthPx` at `paDeg`
 * (image-space math angle, atan2(dy,dx); a line is head/tail-symmetric so the PA
 * is folded to [0,180)) — into a normalized (Σ=1), odd-sized 2-D `PsfKernel`.
 *
 * The line is supersampled and bilinearly splatted so the discretized kernel is
 * anti-aliased and sub-pixel faithful to the calculated trail. This is the
 * point-spread that a static (untracked) mount stamps on every star; it is
 * COMPUTED from celestial mechanics, never fit.
 */
export function rasterizeDriftKernel(
    lengthPx: number, paDeg: number,
    opts?: { padPx?: number; oversample?: number }
): PsfKernel {
    const pad = opts?.padPx ?? DEBLUR_DEFAULTS.kernelPadPx;
    const os = opts?.oversample ?? DEBLUR_DEFAULTS.kernelOversample;
    const L = Math.max(0, lengthPx);
    const half = L / 2;
    const R = Math.max(1, Math.ceil(half) + pad);
    const size = 2 * R + 1;
    const k = new Float64Array(size * size);
    const th = foldPa180(paDeg) * DEG;
    const ux = Math.cos(th), uy = Math.sin(th);
    const cx = R, cy = R;
    const N = Math.max(1, Math.ceil(L * os) + 1);
    const wS = 1 / N;
    for (let s = 0; s < N; s++) {
        const t = N === 1 ? 0 : -half + (L * s) / (N - 1);
        const px = cx + t * ux, py = cy + t * uy;
        const x0 = Math.floor(px), y0 = Math.floor(py);
        const fx = px - x0, fy = py - y0;
        splat(k, size, x0, y0, (1 - fx) * (1 - fy) * wS);
        splat(k, size, x0 + 1, y0, fx * (1 - fy) * wS);
        splat(k, size, x0, y0 + 1, (1 - fx) * fy * wS);
        splat(k, size, x0 + 1, y0 + 1, fx * fy * wS);
    }
    let sum = 0;
    for (let i = 0; i < k.length; i++) sum += k[i];
    if (sum > 0) for (let i = 0; i < k.length; i++) k[i] /= sum;
    return { k, size };
}

// ─── deconvolution (reuses rl_deconv) + forward reconvolution ─────────────────

export interface DeblurOptions {
    iters?: number;
    /** Pixel-noise σ that drives the RL damping band (defaults to a MAD estimate). */
    sigmaDamp?: number;
}

/**
 * Deblur one native-grid plane with the EXACT kernel via damped Richardson–Lucy
 * (m10_psf/rl_deconv). RL requires non-negative data, so the plane is clamped at
 * 0 first (a flat positive background — the astro case — passes through untouched
 * because obs≈conv there and the damping pins the ratio at 1).
 */
export async function deblurPlaneWithKernel(
    plane: Float32Array, w: number, h: number, kernel: PsfKernel, opts?: DeblurOptions
): Promise<Float32Array> {
    const obs = new Float32Array(plane.length);
    for (let i = 0; i < plane.length; i++) { const v = plane[i]; obs[i] = v > 0 ? v : 0; }
    const sigmaDamp = opts?.sigmaDamp ?? pixelNoiseSigma(obs);
    const iters = opts?.iters ?? DEBLUR_DEFAULTS.iters;
    const res = await richardsonLucyWindow({ obs, w, h, kernel, iters, sigmaDamp });
    return res.estimate;
}

/** Forward-convolve a plane with a kernel (clamp-to-edge). Reuses rl_deconv.convolve2d. */
export function convolvePlane(src: Float32Array, w: number, h: number, kernel: PsfKernel): Float32Array {
    const dst = new Float32Array(src.length);
    convolve2d(src, dst, w, h, kernel.k, kernel.size);
    return dst;
}

// ─── aperture photometry helpers (for the preservation proof) ─────────────────

/**
 * Net aperture flux at (cx,cy): Σ(pixels within radius R) − nPix·bg, where bg is
 * the median of an annulus ring [R, R+2] (local background). Returns {flux, nPix}.
 */
function apertureNetFlux(
    plane: Float32Array, w: number, h: number, cx: number, cy: number, R: number
): { flux: number; nPix: number } {
    const x0 = Math.max(0, Math.floor(cx - R - 3)), x1 = Math.min(w - 1, Math.ceil(cx + R + 3));
    const y0 = Math.max(0, Math.floor(cy - R - 3)), y1 = Math.min(h - 1, Math.ceil(cy + R + 3));
    const R2 = R * R, Ro2 = (R + 2) * (R + 2);
    const ring: number[] = [];
    let sum = 0, nPix = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x - cx, dy = y - cy, r2 = dx * dx + dy * dy;
            const v = plane[y * w + x];
            if (r2 <= R2) { sum += v; nPix++; }
            else if (r2 <= Ro2) ring.push(v);
        }
    }
    let bg = 0;
    if (ring.length) { ring.sort((a, b) => a - b); bg = ring[ring.length >> 1]; }
    return { flux: sum - nPix * bg, nPix };
}

// ─── the four preservation-proof metrics ──────────────────────────────────────

/** (a) flux conservation — Σ net flux over catalog/bright sources; ratio after/before ≈ 1. */
export function fluxConservationMetric(
    before: Float32Array, after: Float32Array, w: number, h: number,
    sources: SourcePos[], apR: number, tol: number
): ProofMetric {
    let fb = 0, fa = 0;
    for (const s of sources) {
        fb += apertureNetFlux(before, w, h, s.x, s.y, apR).flux;
        fa += apertureNetFlux(after, w, h, s.x, s.y, apR).flux;
    }
    const ratio = fb > 0 ? fa / fb : NaN;
    const pass = Number.isFinite(ratio) && Math.abs(1 - ratio) <= tol;
    return {
        metric: 'sum_flux_ratio_catalog_stars',
        value: Number.isFinite(ratio) ? +ratio.toFixed(6) : NOT_MEASURED,
        tolerance: tol, pass,
    };
}

/** (b) astrometric invariance — max source centroid shift (px); the measurement must be untouched. */
export function astrometricInvarianceMetric(
    before: Float32Array, after: Float32Array, w: number, h: number,
    sources: SourcePos[], sigmaN: number, tol: number, boxR: number
): ProofMetric {
    let maxShift = 0, ran = 0;
    for (const s of sources) {
        const a = measureStar(before, w, h, Math.round(s.x), Math.round(s.y), sigmaN, boxR);
        const b = measureStar(after, w, h, Math.round(s.x), Math.round(s.y), sigmaN, boxR);
        if (a && b) {
            const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
            if (d > maxShift) maxShift = d;
            ran++;
        }
    }
    const pass = ran > 0 && maxShift <= tol;
    return {
        metric: 'max_centroid_shift_px',
        value: ran > 0 ? +maxShift.toFixed(5) : NOT_MEASURED,
        tolerance: tol, pass,
    };
}

/**
 * (c) reconvolution residual — reconvolve the deblurred output with the EXACT
 * kernel; the result must reproduce the observed (blurred) input to the noise
 * floor. rms(reconv − input)/σ_noise ≤ tol. This is the self-consistency proof
 * that the exact kernel truly explains the data (the crux of well-posedness).
 * The kernel-radius border is excluded (clamp-to-edge convolution is APPROXIMATE
 * there — it never touches the interior measurement region).
 */
export function reconvolutionResidualMetric(
    deblurred: Float32Array, input: Float32Array, w: number, h: number,
    kernel: PsfKernel, sigmaN: number, tol: number
): ProofMetric {
    const reconv = convolvePlane(deblurred, w, h, kernel);
    const margin = (kernel.size - 1) / 2 + 1;
    let s2 = 0, n = 0;
    for (let y = margin; y < h - margin; y++) {
        for (let x = margin; x < w - margin; x++) {
            const d = reconv[y * w + x] - input[y * w + x];
            s2 += d * d; n++;
        }
    }
    const rms = n > 0 ? Math.sqrt(s2 / n) : NaN;
    const ratio = Number.isFinite(rms) && sigmaN > 0 ? rms / sigmaN : NaN;
    const pass = Number.isFinite(ratio) && ratio <= tol;
    return {
        metric: 'rms_residual_over_noise',
        value: Number.isFinite(ratio) ? +ratio.toFixed(4) : NOT_MEASURED,
        tolerance: tol, pass,
    };
}

/**
 * (d) forced-photometry recheck — the standalone prototype-lane equivalent of
 * the engine forced-photometry integrity gate (deep_verify/forced_confirm): at
 * FIXED catalog positions, the per-source aperture-flux shift must be within the
 * source's photometric noise. max |Δflux|/σ_flux ≤ tol.
 *
 * σ_flux uses the STANDARD CCD photometric error model — the QUADRATURE of the
 * background aperture noise AND the source's own Poisson (shot) noise:
 *   σ_flux² = σ_pixel²·nPix  +  F_source
 * (F_source = net aperture counts; a 1 e⁻/ADU floor when no gain is supplied —
 * the same honest-or-absent stance as the denoise noise model). Omitting the
 * source term would compare a bright star's sub-percent flux redistribution
 * against background noise alone and spuriously read it as many σ; the source
 * shot-noise term is what makes this a realistic forced-photometry test.
 */
export function forcedPhotometryMetric(
    before: Float32Array, after: Float32Array, w: number, h: number,
    sources: SourcePos[], apR: number, sigmaN: number, tol: number
): ProofMetric {
    let maxZ = 0, ran = 0;
    for (const s of sources) {
        const b = apertureNetFlux(before, w, h, s.x, s.y, apR);
        const a = apertureNetFlux(after, w, h, s.x, s.y, apR);
        // background aperture variance + source Poisson variance (shot noise).
        const sigFlux = Math.sqrt(sigmaN * sigmaN * Math.max(1, b.nPix) + Math.max(0, b.flux));
        if (sigFlux > 0) {
            const z = Math.abs(a.flux - b.flux) / sigFlux;
            if (z > maxZ) maxZ = z;
            ran++;
        }
    }
    const pass = ran > 0 && maxZ <= tol;
    return {
        metric: 'catalog_flux_shift_sigma',
        value: ran > 0 ? +maxZ.toFixed(4) : NOT_MEASURED,
        tolerance: tol, pass,
    };
}

export interface SourcePos { x: number; y: number; }

export interface ProofInputs {
    before: Float32Array;
    after: Float32Array;
    w: number; h: number;
    kernel: PsfKernel;
    sources: SourcePos[];
    sigmaN: number;
    apR: number;
    boxR: number;
}

/**
 * Assemble the full PreservationProof. Tolerances are SINGLE-SOURCED from the
 * reused `emptyProof()` contract (tools/denoise/ml_stubs/types) — never re-declared
 * here, so the gate cannot be quietly loosened to pass (owner rule: add evidence,
 * never lower a gate).
 */
export function buildPreservationProof(p: ProofInputs): PreservationProof {
    const proof = emptyProof();
    proof.flux_conservation = fluxConservationMetric(
        p.before, p.after, p.w, p.h, p.sources, p.apR, proof.flux_conservation.tolerance);
    proof.astrometric_invariance = astrometricInvarianceMetric(
        p.before, p.after, p.w, p.h, p.sources, p.sigmaN, proof.astrometric_invariance.tolerance, p.boxR);
    proof.reconvolution_residual = reconvolutionResidualMetric(
        p.after, p.before, p.w, p.h, p.kernel, p.sigmaN, proof.reconvolution_residual.tolerance);
    proof.forced_photometry_recheck = forcedPhotometryMetric(
        p.before, p.after, p.w, p.h, p.sources, p.apR, p.sigmaN, proof.forced_photometry_recheck.tolerance);
    return proof;
}

// ─── top-level report + runner ────────────────────────────────────────────────

export interface DeblurReport {
    ledger: 'PIXEL';
    /** True only when the deblur actually ran (enabled AND drift confirmed). */
    applied: boolean;
    method: 'DAMPED_RICHARDSON_LUCY_KNOWN_KERNEL';
    reason: string;
    presence: DriftPresence | null;
    /** The EXACT kernel that was applied (null when not applied). */
    kernel: { lengthPx: number; paDeg: number; profile: string; rasterSize: number } | null;
    iters: number | null;
    sigmaDamp: number | null;
    preservation_proof: PreservationProof | null;
    /** VERIFIED_PRESERVING on a passing proof; AESTHETIC on a failing one; null when absent. */
    epistemic_type: EpistemicType | null;
    label: 'MEASUREMENT_GRADE' | 'AESTHETIC_NOT_MEASURED' | null;
    note: string;
}

export interface DriftDeblurInput {
    /** Native-grid single-channel science plane (PIXEL ledger; the render input). */
    plane: Float32Array;
    width: number;
    height: number;
    /** The attribution presence gate — deblur runs ONLY on CONFIRMED_PRESENT. */
    presence: DriftPresence;
    /** The EXACT drift kernel emitted by psf_attribution (attribution.drift.kernel). */
    driftKernel: DriftKernel | null;
    /** Catalog / bright-source positions the preservation proof is evaluated on. */
    sources: SourcePos[];
    /** DEFAULT-OFF: must be explicitly true or the lane returns honest-absent. */
    enabled?: boolean;
    sigmaDamp?: number;
    iters?: number;
    apR?: number;
    boxR?: number;
    padPx?: number;
    oversample?: number;
}

function absentReport(reason: string, presence: DriftPresence | null): DeblurReport {
    return {
        ledger: 'PIXEL', applied: false, method: 'DAMPED_RICHARDSON_LUCY_KNOWN_KERNEL',
        reason, presence, kernel: null, iters: null, sigmaDamp: null,
        preservation_proof: null, epistemic_type: null, label: null,
        note: 'No deblur performed — honest-absent (DEFAULT-OFF or drift not confirmed).',
    };
}

/**
 * Run the drift-deblur. DEFAULT-OFF and gated on CONFIRMED_PRESENT drift; every
 * other path is honest-absent (null deblur, null proof). On the confirmed path it
 * builds the EXACT kernel, deconvolves, PROVES preservation, and classifies the
 * epistemic tier via the single choke-point `classifyEpistemic`.
 */
export async function runDriftDeblur(
    i: DriftDeblurInput
): Promise<{ report: DeblurReport; deblurred: Float32Array | null }> {
    const enabled = i.enabled ?? DRIFT_DEBLUR_DEFAULT_OFF;
    if (!enabled) {
        return { report: absentReport('DEFAULT-OFF — drift-deblur not enabled (flag off).', i.presence), deblurred: null };
    }
    if (i.presence !== 'CONFIRMED_PRESENT' || !i.driftKernel) {
        return {
            report: absentReport(
                `Drift not CONFIRMED_PRESENT (presence=${i.presence}${i.driftKernel ? '' : ', no kernel'}) — honest-absent, no deblur.`,
                i.presence),
            deblurred: null,
        };
    }

    const kernel = rasterizeDriftKernel(i.driftKernel.lengthPx, i.driftKernel.paDeg,
        { padPx: i.padPx, oversample: i.oversample });
    const sigmaDamp = i.sigmaDamp ?? pixelNoiseSigma(i.plane);
    const iters = i.iters ?? DEBLUR_DEFAULTS.iters;
    const deblurred = await deblurPlaneWithKernel(i.plane, i.width, i.height, kernel, { iters, sigmaDamp });

    const apR = i.apR ?? Math.max(6, Math.ceil(i.driftKernel.lengthPx / 2) + 4);
    const boxR = i.boxR ?? Math.max(7, Math.ceil(i.driftKernel.lengthPx / 2) + 4);
    const proof = buildPreservationProof({
        before: i.plane, after: deblurred, w: i.width, h: i.height,
        kernel, sources: i.sources, sigmaN: sigmaDamp, apR, boxR,
    });
    const epistemic = classifyEpistemic(proof);
    const label = epistemic === 'VERIFIED_PRESERVING' ? 'MEASUREMENT_GRADE' : 'AESTHETIC_NOT_MEASURED';

    return {
        report: {
            ledger: 'PIXEL', applied: true, method: 'DAMPED_RICHARDSON_LUCY_KNOWN_KERNEL',
            reason: 'Drift CONFIRMED_PRESENT — deconvolved with the EXACT calculated sidereal kernel.',
            presence: i.presence,
            kernel: {
                lengthPx: i.driftKernel.lengthPx, paDeg: i.driftKernel.paDeg,
                profile: i.driftKernel.profile, rasterSize: kernel.size,
            },
            iters, sigmaDamp: +sigmaDamp.toFixed(5),
            preservation_proof: proof,
            epistemic_type: epistemic, label,
            note: epistemic === 'VERIFIED_PRESERVING'
                ? 'Preservation proof PASSED against the EXACT calculated kernel → VERIFIED_PRESERVING (measurement-grade, not aesthetic).'
                : 'Preservation proof FAILED ≥1 check → AESTHETIC and FLAGGED. Never silently accepted.',
        },
        deblurred,
    };
}

/**
 * Additive `deblur` receipt block — null on absence (the op did not run), else the
 * full honest report. Mirrors serializePsfAttributionBlock's additive contract.
 */
export function serializeDeblurBlock(report: DeblurReport): Record<string, any> | null {
    if (!report.applied) return null;
    return {
        ledger: report.ledger,
        method: report.method,
        presence: report.presence,
        kernel: report.kernel,
        iters: report.iters,
        sigma_damp: report.sigmaDamp,
        preservation_proof: report.preservation_proof,
        epistemic_type: report.epistemic_type,
        label: report.label,
        note: report.note,
    };
}
