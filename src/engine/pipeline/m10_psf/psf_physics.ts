/**
 * ═══════════════════════════════════════════════════════════════════════════
 * M10 PSF PHYSICS — the immutable + form-exact predictors (PIXEL ledger seam)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure, deterministic, pixel-free celestial-mechanics + optics predictors that
 * the PSF-ATTRIBUTION stage compares against the MEASURED psf_field. NOTHING
 * here reads pixels or mutates a solve — these are closed-form calculations from
 * EXIF + solve geometry. The epistemic tiers (owner directive) are encoded in
 * the CALLER's labels, but the maths lives here:
 *
 *   • SIDEREAL DRIFT  — IMMUTABLE celestial mechanics. Given exposure + Dec +
 *     WCS orientation, the drift VECTOR is EXACT (noise-free). The attribution
 *     stage "tests-then-trusts": it CONFIRMS the calc against the measured
 *     elongation, then treats the confirmed drift component as ground truth.
 *   • DIFFRACTION     — CALCULATED floor (1.028·λ/D FWHM; per-channel chromatic).
 *   • SEEING          — APPROXIMATE (θ_zenith assumed; airmass-scaled).
 *   • REFRACTION      — APPROXIMATE (Bennett; revived DifferentialRefraction).
 *   • COMA            — FORM immutable (elongation ∝ field radius, oriented
 *     radially); MAGNITUDE per-lens → a 1-parameter FIT, never fabricated.
 *
 * INCUBATOR NOTE (LAW 4): the tools/adaptive/image_conditions.ts sandbox carries
 * parallel diffraction/seeing scalars (a RESEARCH lane). These are the standard
 * closed-form physics constants; this is the LIVE engine home. No pixel algorithm
 * is duplicated — only the textbook formulae, re-derived here in engine-native
 * arcsec units (grid-independent) so the comparison is binning-safe.
 *
 * FOLLOW-ON: drift-deblur — `driftPsfKernel` emits the EXACT motion-blur kernel
 * (line of `lengthPx` at `paDeg`). A future known-kernel deconvolution consumes
 * it; this module only DESCRIBES the kernel, it never deconvolves.
 */

// ─── constants ────────────────────────────────────────────────────────────────

/** Apparent sidereal rate: arcsec of sky swept per SECOND of time at the equator
 *  (360°·3600″ / 86164.0905 s ≈ 15.041″/s). Times cos(Dec) = the star's rate. */
export const SIDEREAL_RATE_ARCSEC_PER_SEC = 15.041;

/** Arcseconds per radian (206264.806…). */
export const ARCSEC_PER_RAD = 648000 / Math.PI;

/** Airy-disk FWHM coefficient: θ_FWHM ≈ 1.028·λ/D. */
export const DIFFRACTION_FWHM_COEFF = 1.028;
/** Rayleigh first-null coefficient: θ_Rayleigh = 1.22·λ/D (reported for reference). */
export const RAYLEIGH_COEFF = 1.22;

/** Representative passband centers (µm) for a chromatic diffraction floor. */
export const LAMBDA_UM = { r: 0.62, g: 0.55, b: 0.47 } as const;

/** Assumed zenith seeing (arcsec) — an APPROXIMATE amateur-site constant. */
export const DEFAULT_SEEING_ZENITH_ARCSEC = 2.0;

const DEG = Math.PI / 180;

// ─── small shared helpers ─────────────────────────────────────────────────────

/** Fold a position angle (deg) into [0,180) — a line has no head/tail. */
export function foldPa180(deg: number): number {
    return ((deg % 180) + 180) % 180;
}
/** Fold a full direction (deg) into [0,360). */
export function foldDeg360(deg: number): number {
    return ((deg % 360) + 360) % 360;
}
/** Smallest unsigned separation between two LINE angles (deg), in [0,90]. */
export function lineAngleSepDeg(a: number, b: number): number {
    let d = Math.abs(foldPa180(a) - foldPa180(b)) % 180;
    if (d > 90) d = 180 - d;
    return d;
}

// ─── sidereal drift (IMMUTABLE) ───────────────────────────────────────────────

/** Arc a star traces on the sky during the exposure (arcsec) for an UNTRACKED
 *  mount. `15.041″/s · cos(Dec) · t`. Exact given Dec + exposure. */
export function siderealTrailArcsec(decDeg: number, exposureSec: number): number {
    return SIDEREAL_RATE_ARCSEC_PER_SEC * Math.cos(decDeg * DEG) * exposureSec;
}

/** A 2×2 CD matrix in degrees/px (WCS convention: ξ=RA-tangent, η=Dec-tangent). */
export type Cd2x2 = [[number, number], [number, number]];

function cdDet(cd: Cd2x2): number {
    return cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
}
/** FULL pixel-space direction (deg, [0,360)) of increasing RA (constant Dec).
 *  Solve CD·[dx,dy]ᵀ = [1,0]ᵀ ⇒ [dx,dy] ∝ (cd11, −cd10)/det. The det SIGN is
 *  load-bearing for the full direction (it encodes parity/handedness); it cancels
 *  under the [0,180) line fold. This is the SIDEREAL-DRIFT direction. */
export function raAxisDirectionDeg(cd: Cd2x2): number {
    const sgn = cdDet(cd) < 0 ? -1 : 1;
    return foldDeg360(Math.atan2(-cd[1][0] * sgn, cd[1][1] * sgn) / DEG);
}
/** FULL pixel-space direction (deg, [0,360)) of increasing Dec (celestial North).
 *  Solve CD·[dx,dy]ᵀ = [0,1]ᵀ ⇒ [dx,dy] ∝ (−cd01, cd00)/det. Det-sign-aware. */
export function decAxisDirectionDeg(cd: Cd2x2): number {
    const sgn = cdDet(cd) < 0 ? -1 : 1;
    return foldDeg360(Math.atan2(cd[0][0] * sgn, -cd[0][1] * sgn) / DEG);
}
/** The sidereal-trail LINE PA (deg, [0,180)) — the drift axis, undirected. */
export function raAxisPaDeg(cd: Cd2x2): number {
    return foldPa180(raAxisDirectionDeg(cd));
}

/** Synthesize a CD (deg/px) from a solved scale + roll + parity — the honest
 *  fallback when no fitted `solution.wcs.cd` exists (mirrors generateReceiptWcs's
 *  synthesized branch; APPROXIMATE, parity folded into the reflection sign). */
export function synthesizeCd(pixelScaleArcsec: number, rotationDeg: number, parity: number): Cd2x2 {
    const s = pixelScaleArcsec / 3600; // deg/px
    const r = rotationDeg * DEG;
    const cosR = Math.cos(r), sinR = Math.sin(r);
    // parity < 0 → sky mirrored; flip the RA (ξ) row sign so handedness matches.
    const p = parity < 0 ? -1 : 1;
    return [
        [-p * s * cosR, p * s * sinR],
        [s * sinR, s * cosR],
    ];
}

// ─── diffraction (CALCULATED floor) ───────────────────────────────────────────

/** Diffraction-limited FWHM in ARCSEC: 1.028·λ/D. D = focal_length/FNumber.
 *  Grid-independent; the caller divides by pixel_scale to reach science-grid px. */
export function diffractionFwhmArcsec(focalLengthMm: number, fNumber: number, lambdaUm: number): number {
    const dMm = focalLengthMm / fNumber;                 // aperture diameter (mm)
    const lambdaMm = lambdaUm * 1e-3;
    return DIFFRACTION_FWHM_COEFF * (lambdaMm / dMm) * ARCSEC_PER_RAD;
}
/** Rayleigh first-null radius in ARCSEC: 1.22·λ/D (reported for reference). */
export function rayleighArcsec(focalLengthMm: number, fNumber: number, lambdaUm: number): number {
    const dMm = focalLengthMm / fNumber;
    return RAYLEIGH_COEFF * (lambdaUm * 1e-3 / dMm) * ARCSEC_PER_RAD;
}

// ─── seeing (APPROXIMATE) ─────────────────────────────────────────────────────

/** Airmass-scaled seeing (arcsec): θ_zenith·(sec z)^0.6. θ_zenith ASSUMED. */
export function seeingArcsec(airmass: number, thetaZenithArcsec = DEFAULT_SEEING_ZENITH_ARCSEC): number {
    return thetaZenithArcsec * Math.pow(Math.max(1, airmass), 0.6);
}

// ─── observing geometry (deterministic astronomy) ─────────────────────────────

/** Local hour angle (deg, [−180,180]) + altitude (deg) of a target. Standard
 *  LST/HA astronomy — NOT a detection reimplementation. */
export function targetGeometry(raHours: number, decDeg: number, latDeg: number, lonDeg: number, date: Date):
    { altitudeDeg: number; hourAngleDeg: number } {
    const JD = date.getTime() / 86400000 + 2440587.5;
    const D = JD - 2451545.0;
    const GMST = (280.46061837 + 360.98564736629 * D) % 360;
    const LST = ((GMST + lonDeg) % 360 + 360) % 360;
    let Hdeg = ((LST - raHours * 15) % 360 + 360) % 360;
    if (Hdeg > 180) Hdeg -= 360;                          // fold to [−180,180]
    const H = Hdeg * DEG, dr = decDeg * DEG, lr = latDeg * DEG;
    const sinAlt = Math.sin(dr) * Math.sin(lr) + Math.cos(dr) * Math.cos(lr) * Math.cos(H);
    return {
        altitudeDeg: Math.asin(Math.max(-1, Math.min(1, sinAlt))) / DEG,
        hourAngleDeg: Hdeg,
    };
}
/** Plane-parallel airmass (sec z) from altitude — APPROXIMATE below ~30°. */
export function airmassFromAltitude(altDeg: number): number {
    const z = (90 - altDeg) * DEG;
    return 1 / Math.max(0.05, Math.cos(z));
}
/** Parallactic angle q (deg): position angle of the ZENITH from the star,
 *  measured from celestial North through East. Standard formula. */
export function parallacticAngleDeg(hourAngleDeg: number, decDeg: number, latDeg: number): number {
    const H = hourAngleDeg * DEG, d = decDeg * DEG, l = latDeg * DEG;
    const q = Math.atan2(Math.sin(H), Math.tan(l) * Math.cos(d) - Math.sin(d) * Math.cos(H));
    return q / DEG;
}

/**
 * Map the zenith direction into IMAGE pixel space (deg, [0,360)) — APPROXIMATE.
 * The zenith sits at parallactic angle `q` from North toward East ON THE SKY;
 * this rotates the image-space North vector by ±q in the sense that carries it
 * toward the image-space East vector (handedness read from the CD matrix, so it
 * is parity-correct).
 */
export function zenithPaImageDeg(cd: Cd2x2, parallacticDeg: number): number {
    const north = decAxisDirectionDeg(cd);
    const east = raAxisDirectionDeg(cd);
    // signed rotation (deg) from North to East in image space, in (−180,180]
    let toEast = east - north;
    toEast = ((toEast % 360) + 360) % 360;
    if (toEast > 180) toEast -= 360;
    const sense = toEast >= 0 ? 1 : -1;                   // +1 CCW, −1 CW
    return foldDeg360(north + sense * parallacticDeg);
}

// ─── coma (FORM immutable, MAGNITUDE fitted) ──────────────────────────────────

/** A measured 3×3 region sample the coma fit consumes. */
export interface ComaRegionSample {
    /** Region-center pixel coords (native/science grid). */
    cx: number; cy: number;
    /** Measured median ellipticity in the region (null → skipped). */
    ellipticity: number | null;
    /** Measured median major-axis PA (deg, [0,180)) in the region (null → skip). */
    orientationDeg: number | null;
}

export interface ComaFit {
    /** Fitted coma coefficient k in e(r)=k·r (per px of field radius). Null when
     *  un-fittable. FITTED: form-exact, magnitude-empirical, per-lens. */
    coeffPerPx: number | null;
    /** Fraction of variance explained by the through-origin linear model. */
    rSquared: number | null;
    /** Median angular deviation (deg) of measured major-axis PA from the RADIAL
     *  direction (coma flares radially). Low ⇒ coma-consistent. */
    medianRadialDeviationDeg: number | null;
    /** Regions that fed the fit. */
    nRegions: number;
    /** True when the measured field matches the coma FORM (grows radially with
     *  radius AND is radially oriented) within tolerance. */
    patternConsistent: boolean;
}

/**
 * Fit the single coma coefficient constrained by the IMMUTABLE coma form
 * (ellipticity grows LINEARLY with field radius, major axis oriented RADIALLY
 * from the field center). A 1-parameter through-origin least-squares fit on the
 * measured region ellipticities — NEVER fabricated from EXIF (two same-spec
 * lenses differ; per-copy magnitude is accumulable later, like Brown-Conrady).
 */
export function fitComaCoefficient(
    regions: ComaRegionSample[], fieldW: number, fieldH: number,
    opts?: { radialTolDeg?: number; minRegions?: number }
): ComaFit {
    const radialTol = opts?.radialTolDeg ?? 30;
    const minRegions = opts?.minRegions ?? 4;
    const cx0 = fieldW / 2, cy0 = fieldH / 2;
    const maxR = Math.hypot(cx0, cy0) || 1;

    let sRR = 0, sRE = 0, sE = 0, sEE = 0, n = 0;
    const devs: number[] = [];
    const es: number[] = [];
    for (const rg of regions) {
        if (rg.ellipticity == null || !Number.isFinite(rg.ellipticity)) continue;
        const dx = rg.cx - cx0, dy = rg.cy - cy0;
        const r = Math.hypot(dx, dy) / maxR;              // normalized field radius [0,1]
        if (r < 1e-6) continue;                           // the center region has no radial axis
        sRR += r * r; sRE += r * rg.ellipticity;
        sE += rg.ellipticity; sEE += rg.ellipticity * rg.ellipticity;
        es.push(rg.ellipticity);
        n++;
        if (rg.orientationDeg != null && Number.isFinite(rg.orientationDeg)) {
            const radialPa = Math.atan2(dy, dx) / DEG;    // radial line PA
            devs.push(lineAngleSepDeg(rg.orientationDeg, radialPa));
        }
    }
    if (n < minRegions) {
        return { coeffPerPx: null, rSquared: null, medianRadialDeviationDeg: null, nRegions: n, patternConsistent: false };
    }
    const k = sRR > 0 ? sRE / sRR : null;                 // through-origin slope
    // R² of the through-origin model e≈k·r (vs mean model).
    let rSquared: number | null = null;
    if (k != null) {
        const meanE = sE / n;
        let ssRes = 0, ssTot = 0, i = 0;
        for (const rg of regions) {
            if (rg.ellipticity == null || !Number.isFinite(rg.ellipticity)) continue;
            const dx = rg.cx - cx0, dy = rg.cy - cy0;
            const r = Math.hypot(dx, dy) / maxR;
            if (r < 1e-6) continue;
            const pred = k * r;
            ssRes += (rg.ellipticity - pred) ** 2;
            ssTot += (rg.ellipticity - meanE) ** 2;
            i++;
        }
        rSquared = ssTot > 0 ? 1 - ssRes / ssTot : null;
    }
    devs.sort((a, b) => a - b);
    const medDev = devs.length ? devs[devs.length >> 1] : null;
    const patternConsistent = k != null && k > 0 && medDev != null && medDev <= radialTol && n >= minRegions;
    return {
        coeffPerPx: k != null ? +k.toFixed(6) : null,
        rSquared: rSquared != null ? +rSquared.toFixed(4) : null,
        medianRadialDeviationDeg: medDev != null ? +medDev.toFixed(2) : null,
        nRegions: n,
        patternConsistent,
    };
}

// ─── atmospheric dispersion (CELL ⑤ — chromatic refraction, APPROXIMATE) ──────

/**
 * Refractivity (n−1) of standard air at wavelength λ (µm) — Edlén/Cox dispersion
 * formula (σ = 1/λ µm⁻¹): (n−1)·1e6 = 64.328 + 29498.1/(146−σ²) + 255.4/(41−σ²).
 * Standard T/P; n−1 ≈ 2.78e-4 at 0.55µm. Grid-independent; used only for the
 * chromatic DIFFERENCE (blue vs red) so the absolute density factor cancels to
 * first order. APPROXIMATE.
 */
export function airRefractivity(lambdaUm: number): number {
    const s2 = (1 / lambdaUm) ** 2;
    return (64.328 + 29498.1 / (146 - s2) + 255.4 / (41 - s2)) * 1e-6;
}

/**
 * Atmospheric-dispersion elongation (arcsec) between a blue and a red wavelength
 * at target altitude `altDeg`: |n(λ_b)−n(λ_r)|·tan(z)·206265 (z = zenith angle).
 * This is the CHROMATIC single-star PSF stretch toward the zenith that
 * psf_attribution's achromatic Bennett model DEFERS. PREDICTOR ONLY, APPROXIMATE
 * (plane-parallel tan z; standard T/P). Clamped to a sane zenith-angle range.
 */
export function chromaticDispersionArcsec(
    altDeg: number, lambdaBlueUm = LAMBDA_UM.b, lambdaRedUm = LAMBDA_UM.r,
): number {
    const zRad = (90 - Math.max(0.1, Math.min(89.9, altDeg))) * DEG;
    const tanZ = Math.tan(zRad);
    const dN = Math.abs(airRefractivity(lambdaBlueUm) - airRefractivity(lambdaRedUm));
    return dN * tanZ * ARCSEC_PER_RAD;
}

// ─── local Jacobian shape de-projection (CELL ⑥ — pixel shape → sky angle) ─────

/** A 2×2 Jacobian ∂(sky-arcsec)/∂(pixel): rows = [∂ξ/∂x, ∂ξ/∂y], [∂η/∂x, ∂η/∂y]. */
export type Jac2x2 = [[number, number], [number, number]];

/** CD (deg/px) → local Jacobian in ARCSEC/px (× 3600). Linear WCS ⇒ position-
 *  independent; captures true scale + anisotropy + skew + rotation the scalar
 *  pixel_scale throws away. */
export function cdToJacobianArcsec(cd: Cd2x2): Jac2x2 {
    return [[cd[0][0] * 3600, cd[0][1] * 3600], [cd[1][0] * 3600, cd[1][1] * 3600]];
}

export interface SkyShape {
    fwhmMajArcsec: number;
    fwhmMinArcsec: number;
    /** Major-axis PA (deg, [0,180)) in the tangent-plane (ξ,η) frame. */
    orientationDeg: number;
    ellipticity: number;
}

/**
 * De-project a measured PIXEL-space PSF shape (major/minor FWHM px + major-axis
 * PA deg) into SKY angle via the local Jacobian J (arcsec/px): propagate the
 * shape covariance Σ_sky = J·Σ_px·Jᵀ and re-extract major/minor FWHM +
 * orientation + ellipticity in arcsec. This is the honest arcsec conversion the
 * scalar `pixel_scale` approximates (it assumes isotropic square pixels). Pure.
 */
export function deprojectShapeByJacobian(
    fwhmMajPx: number, fwhmMinPx: number, orientationDeg: number, J: Jac2x2,
): SkyShape {
    const FWc = 2 * Math.sqrt(2 * Math.log(2));
    const sMaj = fwhmMajPx / FWc, sMin = fwhmMinPx / FWc;
    const th = orientationDeg * DEG;
    const c = Math.cos(th), s = Math.sin(th);
    // Σ_px = R diag(sMaj², sMin²) Rᵀ  (R rotates the major axis to +x by θ)
    const a = sMaj * sMaj, b = sMin * sMin;
    const pxx = a * c * c + b * s * s;
    const pxy = (a - b) * c * s;
    const pyy = a * s * s + b * c * c;
    // Σ_sky = J Σ_px Jᵀ
    const [[j00, j01], [j10, j11]] = J;
    // M = J Σ_px
    const m00 = j00 * pxx + j01 * pxy;
    const m01 = j00 * pxy + j01 * pyy;
    const m10 = j10 * pxx + j11 * pxy;
    const m11 = j10 * pxy + j11 * pyy;
    // Σ_sky = M Jᵀ
    const sxx = m00 * j00 + m01 * j01;
    const sxy = m00 * j10 + m01 * j11;
    const syy = m10 * j10 + m11 * j11;
    // Eigenvalues of the 2×2 symmetric Σ_sky
    const tr = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc; // major variance
    const l2 = Math.max(0, tr / 2 - disc); // minor variance
    const sigMaj = Math.sqrt(Math.max(0, l1));
    const sigMin = Math.sqrt(l2);
    // Major eigenvector angle
    let paDeg = 0.5 * Math.atan2(2 * sxy, sxx - syy) / DEG;
    paDeg = ((paDeg % 180) + 180) % 180;
    return {
        fwhmMajArcsec: FWc * sigMaj,
        fwhmMinArcsec: FWc * sigMin,
        orientationDeg: paDeg,
        ellipticity: sigMaj > 0 ? 1 - sigMin / sigMaj : 0,
    };
}

// ─── drift PSF kernel (FOLLOW-ON seam) ────────────────────────────────────────

export interface DriftKernel {
    /** Motion-blur streak length (science-grid px) — the EXACT sidereal trail. */
    lengthPx: number;
    /** Streak position angle (deg, [0,180)) — the RA-axis line PA. */
    paDeg: number;
    /** Kernel model: a UNIFORM 1-D line (top-hat along the trail). */
    profile: 'UNIFORM_LINE';
    note: string;
}

/**
 * The EXACT drift point-spread kernel: a uniform line of `lengthPx` at `paDeg`.
 * FOLLOW-ON: drift-deblur — a future known-kernel deconvolution consumes THIS as
 * its deconvolution kernel. This function only DESCRIBES it; it never deblurs.
 */
export function driftPsfKernel(lengthPx: number, paDeg: number): DriftKernel {
    return {
        lengthPx: +lengthPx.toFixed(4),
        paDeg: +foldPa180(paDeg).toFixed(3),
        profile: 'UNIFORM_LINE',
        note: 'EXACT sidereal motion-blur kernel (uniform line). FOLLOW-ON: drift-deblur deconvolution consumes this kernel; not built here.',
    };
}
