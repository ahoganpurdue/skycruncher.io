/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * OPTICS MANAGER â€” The Lens & Atmospheric Calibrator
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Owns the physical reality of the optics and atmosphere.
 * Centralizes Brown-Conrady distortion, FOV math, and refraction.
 */

import { UnitConverter } from './UnitConverter';
import {
    queryFocalLengthHintProviders,
    WIDE_FIELD_FL_PRIOR_MM,
    type OpticsHint,
} from './optics_hint_provider';

/**
 * Result of the trust-ordered focal-length resolution. `value_mm` is the seed
 * handed to the scale search (undefined only when there is no metadata at all);
 * `hint` is the labelled ASSUMPTION a provider supplied (null when the FL was
 * trusted evidence — user hint or genuine EXIF — so nothing was assumed). The
 * hint is what the receipt records so the assumption is receipt-visible.
 */
export interface FocalLengthResolution {
    value_mm: number | undefined;
    hint: OpticsHint | null;
}

export interface DistortionProfile {
    k1: number;
    k2: number;
    k3: number;
    p1: number;
    p2: number;
    /** Normalization radius (e.g. half-diagonal in pixels or degrees) */
    r_ref?: number;
}

export interface VignetteProfile {
    /** Polynomial coefficients [k0, k1, k2, k3, k4...] where intensity = sum(ki * r^(2i)) */
    coeffs: number[];
    /** Falloff exponent for Cos^N(theta) model (usually 4) */
    cosPower?: number;
}

export interface Point2D {
    x: number;
    y: number;
}

export class OpticsManager {
    
    // â”€â”€â”€ LENS DISTORTION & PROFILES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // ─── HEURISTIC OPTICS PRIORS (named + documented, never masquerading as truth) ───
    //
    // These are ASSUMPTIONS of last resort, not measurements. They exist only
    // so a blind scale search has a seed when the file carries no trustworthy
    // optics and the user gave no hint. Named (never bare literals in call
    // sites) so they can never quietly leak into the UI as "known" values and
    // so a single edit re-tunes every consumer.

    /**
     * Wide-field focal-length PRIOR (mm) — re-exported for the public API +
     * calibration tests. The value and its MISFIRE CAVEAT (ROADMAP 228b) now
     * live with the provider that owns the assumption:
     * `core/optics_hint_provider.ts` (WIDE_FIELD_FL_PRIOR_MM). Consulted through
     * the hint-provider seam by getEffectiveFocalLength, never inline anymore.
     */
    public static readonly WIDE_FIELD_FL_PRIOR_MM = WIDE_FIELD_FL_PRIOR_MM;

    /**
     * Fallback pixel pitch (µm) for the blind Tri-Lock when neither an EXIF
     * hint nor a sensor-DB pitch is available (roughly a Canon APS-C cell).
     * An ASSUMPTION — a full-frame body (real ~6.25 µm) fed this APS-C value
     * mis-scales by ~45% (ROADMAP 228a). The honest fix is to derive pitch from
     * EXIF FocalPlaneResolution / sensor dims, else declare it NOT MEASURED and
     * stay blind; tracked separately.
     */
    public static readonly FALLBACK_PITCH_UM = 4.3;

    /**
     * Resolve the effective focal length (mm) for scale seeding AND the labelled
     * assumption (if any) that produced it, in trust order:
     *
     *   1. USER HINT  — an explicit `focal_length_hint_mm` (a human knows their
     *      lens; turns the pre-solve scale search into a lookup — ROADMAP Tier-1
     *      hint). Trusted EVIDENCE, so `hint` is null. The verify gate stays the
     *      arbiter, so a wrong hint can only fail to verify, never corrupt a
     *      "verified" answer.
     *   2. HINT-PROVIDER SEAM — when the nominal FL is untrusted, the ordered
     *      focal-length hint providers (core/optics_hint_provider.ts) are asked
     *      for a labelled ASSUMPTION. Provider #1 is the wide-field prior (the
     *      electronics-less 50 mm-default case). A returned hint REPLACES the
     *      nominal FL and rides out to the receipt (`optics_hints`). This is the
     *      plug point for the reserved ML hint-recommender — hints SEED only.
     *   3. EXIF FL    — trusted as-is when no provider fired (lens reported, a
     *      non-default FL, or the flag-OFF honest-absent fallthrough).
     *
     * `value_mm` is undefined only when there is no metadata at all.
     */
    public static resolveFocalLengthWithHint(metadata: any | null): FocalLengthResolution {
        if (!metadata) return { value_mm: undefined, hint: null };

        // 1. USER EVIDENCE (highest trust) — an explicit focal-length hint. This is
        //    trusted evidence, not an assumption, so no hint is recorded.
        const explicit = Number(metadata.focal_length_hint_mm);
        if (Number.isFinite(explicit) && explicit > 0) {
            return { value_mm: explicit, hint: null };
        }

        const fl = metadata.focal_length;

        // 2. UNTRUSTED-FL HINT-PROVIDER SEAM. Providers own the trigger condition
        //    (the wide-field provider encapsulates the historical fl===50 +
        //    placeholder-lens discriminator) and self-log. First non-null wins;
        //    the delivered assumption REPLACES the nominal FL and is captured for
        //    the receipt. Flag-OFF / no-match ⇒ null ⇒ honest-absent fallthrough.
        const hint = queryFocalLengthHintProviders({
            exif_focal_length: fl,
            lens_string: (metadata.lens_model ?? '').toString().trim(),
            explicit_hint_mm: undefined,
        });
        if (hint) {
            return { value_mm: hint.value_mm, hint };
        }

        // 3. Trust the EXIF focal length (lens reported, non-default FL, or the
        //    honest-absent fallthrough when the seam declined).
        return { value_mm: fl, hint: null };
    }

    /**
     * Effective focal length (mm) for scale seeding — the scalar the historical
     * callers consume. Thin wrapper over resolveFocalLengthWithHint (byte-identical
     * decision); use resolveFocalLengthWithHint when you also need the assumption
     * record for the receipt. Returns undefined only when there is no metadata.
     */
    public static getEffectiveFocalLength(metadata: any | null): number | undefined {
        return OpticsManager.resolveFocalLengthWithHint(metadata).value_mm;
    }

    /**
     * Physics-recover the MEASURED focal length (mm) from a solved pixel scale:
     *
     *     FL_mm = 206.265 × pitch_µm / scale_arcsec_per_px
     *
     * The honest replacement for the fabricated prior — a value the sky itself
     * confirmed, available only POST-solve. Returns undefined when the inputs
     * are missing or non-positive (honest-or-absent; never a guess).
     */
    public static recoverFocalLengthFromScale(
        pixelScaleArcsecPerPx: number | null | undefined,
        pixelPitchUm: number | null | undefined
    ): number | undefined {
        if (!(pixelScaleArcsecPerPx && pixelScaleArcsecPerPx > 0)) return undefined;
        if (!(pixelPitchUm && pixelPitchUm > 0)) return undefined;
        return 206.265 * pixelPitchUm / pixelScaleArcsecPerPx;
    }

    /**
     * Apply distortion (ideal -> distorted).
     * Rd = Ru * (1 + k1*Ru^2 + k2*Ru^4 + k3*Ru^6) + Tangential
     */
    public static applyDistortion(
        x: number, 
        y: number, 
        width: number, 
        height: number, 
        profile: DistortionProfile
    ): Point2D {
        const cx = width / 2;
        const cy = height / 2;
        const r_ref = profile.r_ref || (width > 0 && height > 0 ? Math.sqrt(cx * cx + cy * cy) : 1.0);
        
        const xn = (x - cx) / r_ref;
        const yn = (y - cy) / r_ref;
        
        const r2 = xn * xn + yn * yn;
        
        // Radial Component
        const radial = 1 + profile.k1 * r2 + profile.k2 * (r2 ** 2) + (profile.k3 || 0) * (r2 ** 3);
        
        // Tangential Component (Decentering)
        const dx_tang = 2 * profile.p1 * xn * yn + profile.p2 * (r2 + 2 * xn * xn);
        const dy_tang = profile.p1 * (r2 + 2 * yn * yn) + 2 * profile.p2 * xn * yn;

        return {
            x: cx + (xn * radial + dx_tang) * r_ref,
            y: cy + (yn * radial + dy_tang) * r_ref
        };
    }

    /**
     * Remove distortion (distorted -> ideal).
     * Solved via Newton-Raphson iteration.
     */
    public static removeDistortion(
        x: number, 
        y: number, 
        width: number, 
        height: number, 
        profile: DistortionProfile
    ): Point2D {
        const cx = width / 2;
        const cy = height / 2;
        const r_ref = profile.r_ref || (width > 0 && height > 0 ? Math.sqrt(cx * cx + cy * cy) : 1.0);
        
        const x_dist = (x - cx) / r_ref;
        const y_dist = (y - cy) / r_ref;
        const rd = Math.sqrt(x_dist * x_dist + y_dist * y_dist);
        
        if (rd < 1e-9) return { x, y };

        // Newton-Raphson for radial inversion
        let ru = rd; 
        const { k1, k2, k3 } = profile;

        for (let i = 0; i < 10; i++) {
            const ru2 = ru * ru;
            const ru4 = ru2 * ru2;
            const ru6 = ru4 * ru2;
            
            const f = ru * (1 + k1 * ru2 + k2 * ru4 + (k3 || 0) * ru6) - rd;
            if (Math.abs(f) < 1e-7) break;
            
            const df = 1 + 3 * k1 * ru2 + 5 * k2 * ru4 + 7 * (k3 || 0) * ru6;
            ru = ru - f / df;
        }

        const scale = ru / rd;
        
        // Simplified tangential removal (p1, p2 are usually tiny)
        const r2 = ru * ru;
        const dx_tang = 2 * profile.p1 * x_dist * y_dist + profile.p2 * (r2 + 2 * x_dist * x_dist);
        const dy_tang = profile.p1 * (r2 + 2 * y_dist * y_dist) + 2 * profile.p2 * x_dist * y_dist;

        return {
            x: cx + (x_dist * scale - dx_tang) * r_ref,
            y: cy + (y_dist * scale - dy_tang) * r_ref
        };
    }

    /**
     * Least-squares solver for Brown-Conrady coefficients.
     * Maps ideal radii to measured radii.
     */
    public static solveDistortionPolynomial(
        idealRadii: number[], 
        measuredRadii: number[], 
        r_ref: number
    ): DistortionProfile {
        if (idealRadii.length < 6) return { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0, r_ref };

        let sum_x1y = 0, sum_x2y = 0, sum_x3y = 0;
        let sum_x1x1 = 0, sum_x1x2 = 0, sum_x1x3 = 0;
        let sum_x2x2 = 0, sum_x2x3 = 0, sum_x3x3 = 0;

        for (let i = 0; i < idealRadii.length; i++) {
            const ru = idealRadii[i] / r_ref;
            const rd = measuredRadii[i] / r_ref;
            const r2 = ru * ru;
            const r4 = r2 * r2;
            const r6 = r4 * r2;
            const y = (rd / ru) - 1;

            sum_x1y += r2 * y;
            sum_x2y += r4 * y;
            sum_x3y += r6 * y;
            sum_x1x1 += r2 * r2;
            sum_x1x2 += r2 * r4;
            sum_x1x3 += r2 * r6;
            sum_x2x2 += r4 * r4;
            sum_x2x3 += r4 * r6;
            sum_x3x3 += r6 * r6;
        }

        // 3x3 Solver for k1, k2, k3
        const result = this.solve3x3(
            [[sum_x1x1, sum_x1x2, sum_x1x3], [sum_x1x2, sum_x2x2, sum_x2x3], [sum_x1x3, sum_x2x3, sum_x3x3]],
            [sum_x1y, sum_x2y, sum_x3y]
        );

        return { k1: result[0], k2: result[1], k3: result[2], p1: 0, p2: 0, r_ref };
    }

    private static solve3x3(matrix: number[][], b: number[]): number[] {
        const det3 = (m: number[][]) => 
            m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
            m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
            m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

        const mainDet = det3(matrix);
        if (Math.abs(mainDet) < 1e-15) return [0, 0, 0];

        const res = [];
        for(let i=0; i<3; i++) {
            const mCopy = matrix.map(row => [...row]);
            for(let j=0; j<3; j++) mCopy[j][i] = b[j];
            res[i] = det3(mCopy) / mainDet;
        }
        return res;
    }

    // â”€â”€â”€ ATMOSPHERIC REFRACTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Calculates the refraction amount in arcseconds for a given apparent altitude.
     * Bennett (1982) approximation for standard pressure (1010 hPa) and temp (10Â°C).
     */
    public static calculateAtmosphericRefraction(altitudeDeg: number): number {
        const h = Math.max(0.01, altitudeDeg); // Avoid singularity at horizon
        const term = h + 7.31 / (h + 4.4);
        const rad = UnitConverter.degToRad(term);
        
        // R = 1 / tan(h + 7.31/(h+4.4)) arcmin
        const refractionArcMin = 1.0 / Math.tan(rad);
        return refractionArcMin * 60; // arcseconds
    }

    /**
     * Compute Differential Refraction: The shift in position between two points
     * due to the gradient of atmospheric density.
     */
    public static getDifferentialRefraction(alt1Deg: number, alt2Deg: number): number {
        const r1 = this.calculateAtmosphericRefraction(alt1Deg);
        const r2 = this.calculateAtmosphericRefraction(alt2Deg);
        return r1 - r2;
    }

    // â”€â”€â”€ FIELD OF VIEW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Get FOV from focal length and sensor dimension.
     * FOV = 2 * atan(dimension / (2 * focalLength))
     */
    public static getFov(focalLengthMm: number, sensorDimMm: number): number {
        if (focalLengthMm <= 0) return 0;
        const fovRad = 2 * Math.atan(sensorDimMm / (2 * focalLengthMm));
        return UnitConverter.radToDeg(fovRad);
    }

    // â”€â”€â”€ VIGNETTING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Calculate vignetting falloff factor at a point.
     * 1.0 = center brightness, < 1.0 = edge dimming.
     */
    public static getVignettingFactor(
        x: number, 
        y: number, 
        width: number, 
        height: number, 
        profile: VignetteProfile
    ): number {
        const cx = width / 2;
        const cy = height / 2;
        const r_max = Math.sqrt(cx * cx + cy * cy);
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy) / r_max;
        
        let factor = 0;
        for (let i = 0; i < profile.coeffs.length; i++) {
            factor += profile.coeffs[i] * Math.pow(r, i * 2); // Radial polynomial
        }

        return Math.max(0, Math.min(1.0, factor));
    }

    /**
     * Get the multiplicative correction factor (1 / falloff).
     */
    public static getVignetteCorrection(
        x: number, 
        y: number, 
        width: number, 
        height: number, 
        profile: VignetteProfile
    ): number {
        const factor = this.getVignettingFactor(x, y, width, height, profile);
        return factor > 0.01 ? 1.0 / factor : 1.0;
    }

    /**
     * Solves for vignetting coefficients.
     * @param radiiNorm - Normalized radii (0 to 1)
     * @param intensities - Relative intensities (1.0 = center)
     */
    public static solveVignettingProfile(radiiNorm: number[], intensities: number[]): VignetteProfile {
        if (radiiNorm.length < 5) return { coeffs: [1.0] };

        // Linear regression for intensity = 1 + k1*r^2
        let sum_xy = 0, sum_xx = 0;
        for (let i = 0; i < radiiNorm.length; i++) {
            const x = radiiNorm[i] ** 2;
            const y_offset = intensities[i] - 1.0;
            sum_xy += x * y_offset;
            sum_xx += x * x;
        }

        const k1 = sum_xx !== 0 ? sum_xy / sum_xx : 0;
        return { coeffs: [1.0, k1] };
    }

    // â”€â”€â”€ SPECTRAL ANALYSIS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Analyze spectral bias based on observed flux of calibration stars.
     */
    public static analyzeSpectralBias(observedFluxes: { r: number, g: number, b: number }[]) {
        if (observedFluxes.length === 0) return { r: 1, g: 1, b: 1 };
        
        let rSum = 0, gSum = 0, bSum = 0;
        for (const f of observedFluxes) {
            rSum += f.r;
            gSum += f.g;
            bSum += f.b;
        }
        
        const avgG = gSum / observedFluxes.length || 1;
        return {
            r: (rSum / observedFluxes.length) / avgG,
            g: 1.0,
            b: (bSum / observedFluxes.length) / avgG
        };
    }
    /**
     * Compare a spectral shift against a library of filter signatures.
     */
    public static matchFilterSignature(
        shift: { r: number, g: number, b: number },
        threshold: number,
        signatures: { type: string, r: number, g: number, b: number }[]
    ): { type: string, confidence: number } | null {
        let bestMatch = null;
        let minSDist = Infinity;

        for (const sig of signatures) {
            const dist = Math.sqrt(
                (shift.r - sig.r) ** 2 +
                (shift.g - sig.g) ** 2 +
                (shift.b - sig.b) ** 2
            );
            if (dist < threshold && dist < minSDist) {
                minSDist = dist;
                bestMatch = { type: sig.type, confidence: 1 - dist / threshold };
            }
        }

        return bestMatch;
    }
}

