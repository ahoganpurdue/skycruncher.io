/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED STAGE: PSF ATTRIBUTION — post-solve, pre-export (M10, PIXEL ledger)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Decomposes the MEASURED PSF field into {physically-explained} + {residual}.
 * It PREDICTS the physically-calculable PSF systematics from validated EXIF +
 * solve geometry, COMPARES them to the measured psf_field, and ATTRIBUTES the
 * measured elongation to named causes — WITHOUT ever overriding the measurement.
 *
 * ETHOS BOUNDARY (non-negotiable): physics INFORMS + GUIDES, never OVERRIDES.
 * The measured `psf_field` stays the arbiter. This stage READS it, predicts
 * physics, and compares. It NEVER mutates psf_field, matched_stars, the WCS, or
 * the solve. Purely ADDITIVE → the sacred solve regressions stay byte-identical
 * by construction. Every output is labeled by epistemic tier:
 *   CALCULATED  — immutable maths (sidereal drift vector, diffraction floor).
 *   CONFIRMED   — a CALCULATED quantity validated against the measurement
 *                 (test-then-trust): once confirmed, trusted as ground truth for
 *                 its component (the calc is noise-free; the measurement isn't).
 *   FITTED      — form immutable, magnitude fit from the measurement (coma).
 *   APPROXIMATE — assumed constants / approx models (seeing, refraction).
 *   INFERRED    — a deduction from the comparison (mount/tracking).
 *   NOT_MEASURED — inputs unavailable → honest absence, never a fabricated number.
 *
 * SCOPE — ATTRIBUTION only (measure → predict → explain → infer). This stage
 * does NOT seed the LM fit and does NOT deconvolve the image:
 *   FOLLOW-ON: fit-seeding — feeding the CALCULATED drift as the LM initial
 *     guess touches the measurement + the bit-identical receipt → a separate,
 *     gated change (not here).
 *   FOLLOW-ON: drift-deblur — the EXACT drift kernel (driftPsfKernel) is emitted
 *     as a clean seam for a future known-kernel deconvolution; not built here.
 */

import type { PsfFieldReport } from '../m10_psf/psf_field';
import type { HardMetadata } from '../../types/schema';
import type { PlateSolution } from '../../types/Main_types';
import type { PipelineEventBus } from '../../events/pipeline_events';
import { DifferentialRefractionCorrector } from '../m5_coordinate_flatten/differential_refraction_corrector';
import {
    LAMBDA_UM, siderealTrailArcsec, raAxisPaDeg, raAxisDirectionDeg, synthesizeCd,
    diffractionFwhmArcsec, rayleighArcsec, seeingArcsec, targetGeometry, airmassFromAltitude,
    parallacticAngleDeg, zenithPaImageDeg, fitComaCoefficient, driftPsfKernel,
    lineAngleSepDeg, chromaticDispersionArcsec, cdToJacobianArcsec, deprojectShapeByJacobian,
    type Cd2x2, type ComaFit, type DriftKernel,
} from '../m10_psf/psf_physics';
import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import {
    resolveLensDistortion, makeBrownConradyDistortion, type LensDistortionModel,
} from '../m2_hardware/lens_distortion';

// ─── tuning (attribution tolerances — NOT solve gates; these only label) ──────

/** Below this science-grid px, a predicted drift is below the measurement floor
 *  (can't be confirmed or refuted → presence NEGLIGIBLE, tracking indeterminate). */
const DRIFT_FLOOR_PX = 0.5;
/** Max line-angle deviation (deg) for the measured elongation to be "along" the
 *  drift axis (direction leg of the presence gate). */
const DRIFT_DIR_TOL_DEG = 22;
/** Fractional tolerance for the measured major FWHM to match sqrt(minor²+drift²)
 *  (magnitude leg of the presence gate). */
const DRIFT_MAG_TOL = 0.35;

export type AttrTier =
    | 'CALCULATED' | 'CONFIRMED' | 'FITTED' | 'APPROXIMATE' | 'INFERRED' | 'NOT_MEASURED';

export type DriftPresence = 'CONFIRMED_PRESENT' | 'NOT_CONFIRMED' | 'NEGLIGIBLE' | 'NOT_MEASURED';
export type TrackingInference =
    | 'UNTRACKED' | 'TRACKED' | 'INDETERMINATE' | 'NOT_MEASURED';

export interface PsfAttributionReport {
    ledger: 'PIXEL';
    /** Grid the px numbers live in (mirrors psf_field.grid). */
    grid: 'SCIENCE_NATIVE' | 'SCIENCE_BINNED2X' | null;
    /** Science-grid pixel scale used for every arcsec→px conversion. */
    pixelScaleArcsecPerPx: number | null;

    // ── MEASURED (from psf_field — the arbiter; copied, never mutated) ──
    measured: {
        majFwhmPx: number | null;
        minFwhmPx: number | null;
        ellipticity: number | null;
        orientationDeg: number | null;      // major-axis PA, [0,180)
        /** Anisotropic excess = maj − min (px); the elongation to attribute. */
        anisotropyPx: number | null;
        source: string;                      // psf_field.method
        nFit: number;
    };

    // ── SIDEREAL DRIFT (CALCULATED → CONFIRMED via test-then-trust) ──
    drift: {
        tier: AttrTier;
        presence: DriftPresence;
        /** EXACT trail length for an UNTRACKED mount (px, this grid). */
        calculatedPx: number | null;
        calculatedArcsec: number | null;
        /** RA-axis line PA (deg, [0,180)) — the drift direction. */
        paDeg: number | null;
        decDegUsed: number | null;
        exposureSec: number | null;
        directionSource: 'WCS_CD' | 'SYNTHESIZED' | null;
        // presence-gate evidence
        directionDeviationDeg: number | null;   // measured elong vs drift axis
        magnitudeRatio: number | null;          // measured anisotropy / calc drift
        /** Set ONLY when CONFIRMED_PRESENT: the exact drift, now trusted as
         *  ground truth for its component. */
        explainedPx: number | null;
        /** The non-drift core along the major axis: sqrt(maj²−drift²) (px). The
         *  residual physics can't attribute to drift (seeing/guiding/focus). */
        residualCorePx: number | null;
        /** EXACT motion-blur kernel seam (FOLLOW-ON: drift-deblur). */
        kernel: DriftKernel | null;
        note: string;
        notMeasured?: string;
    };

    // ── DIFFRACTION (CALCULATED floor; per-channel chromatic) ──
    diffraction: {
        tier: AttrTier;
        floorArcsec: { r: number; g: number; b: number } | null;
        floorPx: { r: number; g: number; b: number } | null;
        rayleighArcsecG: number | null;
        apertureDiameterMm: number | null;
        /** True when the measured minor FWHM is at/near the green floor (the PSF
         *  is optics/diffraction-limited on its short axis). */
        limitedGreen: boolean | null;
        note: string;
        notMeasured?: string;
    };

    // ── SEEING (APPROXIMATE) ──
    seeing: {
        tier: AttrTier;
        arcsec: number | null;
        px: number | null;
        airmass: number | null;
        thetaZenithAssumedArcsec: number;
        note: string;
        notMeasured?: string;
    };

    // ── DIFFERENTIAL REFRACTION (APPROXIMATE, gated on trusted clock + GPS) ──
    refraction: {
        tier: AttrTier;
        gatedOn: string;
        targetAltitudeDeg: number | null;
        airmass: number | null;
        /** R(alt+½FOVv) − R(alt−½FOVv): the plate stretch toward zenith across
         *  the field's vertical extent (APPROXIMATE, plate-level). */
        fieldDifferentialArcsec: number | null;
        fieldDifferentialPx: number | null;
        zenithParallacticDeg: number | null;    // sky frame (from North thru East)
        zenithPaImageDeg: number | null;        // image frame (APPROXIMATE)
        /** CELL ⑤ — chromatic atmospheric-DISPERSION PSF elongation (the single-
         *  star term the achromatic Bennett model DEFERS). A PREDICTED elongation
         *  VECTOR (magnitude + zenith-aligned direction), reported as an additive
         *  decomposition; NEVER mutates the measured shape. Null when the observing
         *  geometry is unavailable (same gate as the field differential). Optional
         *  (honest-or-absent additive field). */
        chromaticDispersion?: {
            tier: 'APPROXIMATE';
            magnitudeArcsec: number;
            magnitudePx: number | null;
            /** Elongation direction = the zenith line in image space (deg, [0,360)). */
            paImageDeg: number | null;
            lambdaBlueUm: number;
            lambdaRedUm: number;
            note: string;
        } | null;
        note: string;
        notMeasured?: string;
    };

    // ── COMA (FORM immutable, MAGNITUDE fitted) ──
    coma: {
        tier: AttrTier;
        fit: ComaFit | null;
        note: string;
        notMeasured?: string;
    };

    // ── FIELD ROTATION (DEFERRED — needs a mount type absent from EXIF) ──
    fieldRotation: {
        tier: 'NOT_MEASURED';
        note: string;
    };

    // ── DECOMPOSITION (measured_total = explained + residual) ──
    decomposition: {
        measuredMajPx: number | null;
        measuredMinPx: number | null;
        /** The exact drift, when CONFIRMED (else 0/null). */
        explainedDriftPx: number | null;
        /** Diffraction + seeing floors that populate the core (reference; not a
         *  subtraction — they're a floor, not an orthogonal component). */
        diffractionFloorPx: number | null;   // green
        seeingPx: number | null;
        /** Major-axis PSF with the exact drift removed in quadrature (the
         *  residual physics can't explain: seeing/guiding/focus/optics). */
        residualCorePx: number | null;
        note: string;
    };

    // ── MOUNT / TRACKING (INFERRED — no mount EXIF field exists) ──
    tracking: {
        tier: AttrTier;
        inference: TrackingInference;
        rationale: string;
    };

    // ── CELL ⑥ — SKY-DEPROJECTED PSF SHAPE (local Jacobian, additive) ──
    /** PSF shape converted to SKY angle via the local CD Jacobian (arcsec/px),
     *  reported ALONGSIDE the raw-pixel values. Populated ONLY when
     *  PSF_JACOBIAN_DEPROJECT is ON (default OFF ⇒ null ⇒ byte-identical). Never
     *  changes what forced_confirm's shape gate consumes (it keeps raw px). */
    skyDeprojected: {
        tier: 'APPROXIMATE';
        /** Which coordinate model supplied the Jacobian. */
        jacobianSource: 'WCS_CD' | 'SYNTHESIZED_CD';
        /** True when the solve carries SIP/TPS whose higher-order local-scale
         *  variation is NOT captured by the linear CD Jacobian (honest caveat). */
        higherOrderPresentUnused: boolean;
        fwhmMajArcsec: number | null;
        fwhmMinArcsec: number | null;
        orientationDeg: number | null;
        ellipticity: number | null;
        // raw-pixel companions (always reported alongside)
        fwhmMajPx: number | null;
        fwhmMinPx: number | null;
        orientationDegPx: number | null;
        ellipticityPx: number | null;
        /** The naive scalar-pixel_scale arcsec (isotropic) for comparison. */
        fwhmMajArcsecScalar: number | null;
        fwhmMinArcsecScalar: number | null;
        note: string;
    } | null;

    // ── CELL ④ — UNDISTORTED PSF CENTROIDS (additive; feeds future refits) ──
    /** Per-star native + undistorted (native→corrected) centroids. Populated when
     *  a distortion model is available (injected this-solve model, else the BC
     *  lens prior); undistorted fields null when no model resolves (honest).
     *  ALWAYS additive — no behavioral change; never touches the WCS/solve. */
    centroids: {
        modelProvenance: 'INJECTED_SOLVE' | 'BC_PRIOR' | 'SIP_PRESENT_UNAPPLIED' | 'NONE';
        modelKind: string;
        hasSolveSip: boolean;
        stars: Array<{ xNative: number; yNative: number; xUndist: number | null; yUndist: number | null }>;
        note: string;
    } | null;

    approximate: string[];
    notMeasured?: string;
}

// ─── inputs ───────────────────────────────────────────────────────────────────

export interface PsfAttributionInput {
    /** The MEASURED PSF field (the arbiter). Null → honest-absent report. */
    psfField: PsfFieldReport | null;
    solution: PlateSolution | null;
    metadata: HardMetadata | null;
    /** NATIVE image dims (for the binned-grid vertical-FOV calc). */
    imageWidth: number;
    imageHeight: number;
    /** False when the capture clock is a wall-clock fallback (gates refraction). */
    timestampTrusted: boolean;
    /** CELL ④ — OPTIONAL this-solve distortion model (native↔corrected). When
     *  present it takes priority over the BC lens prior for undistorted centroids.
     *  Absent (default) ⇒ psf_attribution resolves the BC prior itself, else
     *  records native only (honest). */
    distortionModel?: LensDistortionModel | null;
    events?: PipelineEventBus;
}

// ─── the stage ────────────────────────────────────────────────────────────────

function emptyReport(reason: string): PsfAttributionReport {
    return {
        ledger: 'PIXEL', grid: null, pixelScaleArcsecPerPx: null,
        measured: { majFwhmPx: null, minFwhmPx: null, ellipticity: null, orientationDeg: null, anisotropyPx: null, source: 'NOT_MEASURED', nFit: 0 },
        drift: {
            tier: 'NOT_MEASURED', presence: 'NOT_MEASURED', calculatedPx: null, calculatedArcsec: null,
            paDeg: null, decDegUsed: null, exposureSec: null, directionSource: null,
            directionDeviationDeg: null, magnitudeRatio: null, explainedPx: null, residualCorePx: null,
            kernel: null, note: 'Sidereal drift NOT ATTRIBUTED.', notMeasured: reason,
        },
        diffraction: { tier: 'NOT_MEASURED', floorArcsec: null, floorPx: null, rayleighArcsecG: null, apertureDiameterMm: null, limitedGreen: null, note: 'Diffraction floor NOT MEASURED.', notMeasured: reason },
        seeing: { tier: 'NOT_MEASURED', arcsec: null, px: null, airmass: null, thetaZenithAssumedArcsec: 2.0, note: 'Seeing NOT MEASURED.', notMeasured: reason },
        refraction: { tier: 'NOT_MEASURED', gatedOn: 'timestampTrusted && GPS present', targetAltitudeDeg: null, airmass: null, fieldDifferentialArcsec: null, fieldDifferentialPx: null, zenithParallacticDeg: null, zenithPaImageDeg: null, chromaticDispersion: null, note: 'Differential refraction NOT MEASURED.', notMeasured: reason },
        coma: { tier: 'NOT_MEASURED', fit: null, note: 'Coma NOT MEASURED.', notMeasured: reason },
        fieldRotation: { tier: 'NOT_MEASURED', note: 'Field rotation DEFERRED — requires a mount type (alt-az vs equatorial) absent from EXIF.' },
        decomposition: { measuredMajPx: null, measuredMinPx: null, explainedDriftPx: null, diffractionFloorPx: null, seeingPx: null, residualCorePx: null, note: reason },
        tracking: { tier: 'NOT_MEASURED', inference: 'NOT_MEASURED', rationale: reason },
        skyDeprojected: null,
        centroids: null,
        approximate: [],
        notMeasured: reason,
    };
}

/**
 * Run PSF attribution. Pure/sync; never throws on missing inputs — degrades to a
 * fully honest-absent report. NEVER mutates psfField / solution.
 */
export function runPsfAttribution(i: PsfAttributionInput): PsfAttributionReport {
    const psf = i.psfField;
    const sol = i.solution;
    if (!psf || !sol) return emptyReport('No measured PSF field or no solution — PSF attribution NOT MEASURED.');

    const approximate: string[] = [];
    const grid = psf.grid ?? null;
    const pixelScale = Number.isFinite(sol.pixel_scale) && sol.pixel_scale > 0 ? sol.pixel_scale : null;

    const majPx = psf.fwhmMedianMajPx;
    const minPx = psf.fwhmMedianMinPx;
    const ellip = psf.ellipticityMedian;
    const oriDeg = psf.orientationMedianDeg;
    const anisotropyPx = (majPx != null && minPx != null) ? +(majPx - minPx).toFixed(4) : null;

    const report = emptyReport('partial'); // reused shell; fields overwritten below
    delete report.notMeasured;
    report.grid = grid;
    report.pixelScaleArcsecPerPx = pixelScale;
    report.measured = {
        majFwhmPx: majPx, minFwhmPx: minPx, ellipticity: ellip, orientationDeg: oriDeg,
        anisotropyPx, source: psf.method, nFit: psf.nFit,
    };

    // ── EXIF (validated: 0 / DEFAULT means "unset", treated as absent) ──
    const meta = i.metadata;
    const exposureSec = meta?.exposure_time && meta.exposure_time > 0 ? meta.exposure_time : null;
    const fNumber = meta?.aperture && meta.aperture > 0 ? meta.aperture : null;
    const focalLengthMm = meta?.focal_length && meta.focal_length > 0 ? meta.focal_length : null;
    const decDeg = Number.isFinite(sol.dec_degrees) ? sol.dec_degrees : null;
    const raHours = Number.isFinite(sol.ra_hours) ? sol.ra_hours : null;

    // ── RA-axis / drift direction (from fitted CD, else synthesized) ──
    let cd: Cd2x2 | null = null;
    let dirSource: 'WCS_CD' | 'SYNTHESIZED' | null = null;
    const fittedCd = (sol as any).wcs?.cd;
    if (Array.isArray(fittedCd) && fittedCd.length === 2 && Array.isArray(fittedCd[0])) {
        cd = [[fittedCd[0][0], fittedCd[0][1]], [fittedCd[1][0], fittedCd[1][1]]] as Cd2x2;
        dirSource = 'WCS_CD';
    } else if (pixelScale != null) {
        cd = synthesizeCd(pixelScale, sol.rotation_deg ?? sol.rotation ?? 0, sol.parity ?? 1);
        dirSource = 'SYNTHESIZED';
        approximate.push('Drift direction synthesized from roll+scale+parity (no fitted WCS CD matrix).');
    }
    const driftPaDeg = cd ? raAxisPaDeg(cd) : null;

    // ═══ SIDEREAL DRIFT — CALCULATED, then test-then-trust ═══
    if (exposureSec != null && decDeg != null && pixelScale != null) {
        const arcsec = siderealTrailArcsec(decDeg, exposureSec);
        const calcPx = arcsec / pixelScale;
        report.drift.tier = 'CALCULATED';
        report.drift.calculatedArcsec = +arcsec.toFixed(4);
        report.drift.calculatedPx = +calcPx.toFixed(4);
        report.drift.paDeg = driftPaDeg != null ? +driftPaDeg.toFixed(3) : null;
        report.drift.decDegUsed = +decDeg.toFixed(4);
        report.drift.exposureSec = exposureSec;
        report.drift.directionSource = dirSource;
        report.drift.kernel = driftPaDeg != null ? driftPsfKernel(calcPx, driftPaDeg) : null;
        delete report.drift.notMeasured;

        // presence gate (test-then-trust)
        if (calcPx < DRIFT_FLOOR_PX) {
            report.drift.presence = 'NEGLIGIBLE';
            report.drift.note = `Calculated drift ${calcPx.toFixed(2)}px is below the ~${DRIFT_FLOOR_PX}px measurement floor — cannot be confirmed or refuted.`;
        } else if (majPx != null && minPx != null && oriDeg != null && driftPaDeg != null && anisotropyPx != null) {
            const dirDev = lineAngleSepDeg(oriDeg, driftPaDeg);
            const predMaj = Math.sqrt(minPx * minPx + calcPx * calcPx); // core⊗line quadrature
            const magOk = Math.abs(majPx - predMaj) / Math.max(majPx, 1e-6) <= DRIFT_MAG_TOL;
            const dirOk = dirDev <= DRIFT_DIR_TOL_DEG;
            report.drift.directionDeviationDeg = +dirDev.toFixed(2);
            report.drift.magnitudeRatio = +(anisotropyPx / calcPx).toFixed(3);
            if (dirOk && magOk) {
                // CONFIRMED: trust the EXACT calc as ground truth for its component.
                report.drift.presence = 'CONFIRMED_PRESENT';
                report.drift.tier = 'CONFIRMED';
                report.drift.explainedPx = +calcPx.toFixed(4);
                report.drift.residualCorePx = +Math.sqrt(Math.max(0, majPx * majPx - calcPx * calcPx)).toFixed(4);
                report.drift.note = 'Measured elongation matches the CALCULATED drift in magnitude AND direction — drift confirmed present and trusted as EXACT for its component (test-then-trust).';
            } else {
                report.drift.presence = 'NOT_CONFIRMED';
                report.drift.note = `Measured elongation does NOT match the calculated drift (dirΔ=${dirDev.toFixed(1)}°${dirOk ? '' : '>tol'}, majΔ ${magOk ? 'ok' : '>tol'}) — drift not confirmed; elongation attributed elsewhere (tracked/guiding/other).`;
            }
        } else {
            report.drift.presence = 'NOT_CONFIRMED';
            report.drift.note = 'Measured PSF has no usable elongation/orientation to test the calculated drift against.';
        }
    } else {
        report.drift.notMeasured = 'Exposure time / Dec / pixel scale unavailable — sidereal drift NOT CALCULABLE.';
    }

    // ═══ DIFFRACTION — CALCULATED floor (per-channel) ═══
    if (focalLengthMm != null && fNumber != null && pixelScale != null) {
        const arc = {
            r: diffractionFwhmArcsec(focalLengthMm, fNumber, LAMBDA_UM.r),
            g: diffractionFwhmArcsec(focalLengthMm, fNumber, LAMBDA_UM.g),
            b: diffractionFwhmArcsec(focalLengthMm, fNumber, LAMBDA_UM.b),
        };
        const px = { r: arc.r / pixelScale, g: arc.g / pixelScale, b: arc.b / pixelScale };
        report.diffraction.tier = 'CALCULATED';
        report.diffraction.floorArcsec = { r: +arc.r.toFixed(4), g: +arc.g.toFixed(4), b: +arc.b.toFixed(4) };
        report.diffraction.floorPx = { r: +px.r.toFixed(4), g: +px.g.toFixed(4), b: +px.b.toFixed(4) };
        report.diffraction.rayleighArcsecG = +rayleighArcsec(focalLengthMm, fNumber, LAMBDA_UM.g).toFixed(4);
        report.diffraction.apertureDiameterMm = +(focalLengthMm / fNumber).toFixed(3);
        report.diffraction.limitedGreen = (minPx != null) ? minPx <= px.g * 1.3 : null;
        report.diffraction.note = 'Diffraction-limited FWHM floor (1.028·λ/D), per channel. A lower bound on the measured PSF — never a subtraction.';
        delete report.diffraction.notMeasured;
    } else {
        report.diffraction.notMeasured = 'Focal length / aperture / scale unavailable — diffraction floor NOT MEASURED.';
    }

    // ═══ observing geometry (shared by seeing airmass + refraction) ═══
    const gpsReal = meta?.gps_source && meta.gps_source !== 'DEFAULT' &&
        Number.isFinite(meta?.gps_lat) && Number.isFinite(meta?.gps_lon);
    const clockReal = i.timestampTrusted && meta?.timestamp_source && meta.timestamp_source !== 'DEFAULT';
    let altDeg: number | null = null, hourAngleDeg: number | null = null, airmass: number | null = null;
    if (gpsReal && clockReal && raHours != null && decDeg != null && meta?.timestamp) {
        const geo = targetGeometry(raHours, decDeg, meta.gps_lat!, meta.gps_lon!, new Date(meta.timestamp));
        altDeg = +geo.altitudeDeg.toFixed(3);
        hourAngleDeg = +geo.hourAngleDeg.toFixed(3);
        airmass = altDeg > 3 ? +airmassFromAltitude(altDeg).toFixed(3) : null;
    }

    // ═══ SEEING — APPROXIMATE ═══
    if (pixelScale != null) {
        const secz = airmass ?? 1.0;
        const arc = seeingArcsec(secz);
        report.seeing.tier = 'APPROXIMATE';
        report.seeing.arcsec = +arc.toFixed(4);
        report.seeing.px = +(arc / pixelScale).toFixed(4);
        report.seeing.airmass = airmass;
        report.seeing.note = airmass != null
            ? 'Airmass-scaled seeing θ_zenith·(sec z)^0.6 with an ASSUMED θ_zenith (2.0″). APPROXIMATE.'
            : 'Seeing at ASSUMED θ_zenith (2.0″), airmass=1 (no observing geometry). APPROXIMATE.';
        delete report.seeing.notMeasured;
        approximate.push('Seeing uses an assumed 2.0″ zenith constant (θ_zenith not measured).');
    } else {
        report.seeing.notMeasured = 'No pixel scale — seeing NOT MEASURED.';
    }

    // ═══ DIFFERENTIAL REFRACTION — APPROXIMATE, gated ═══
    if (gpsReal && clockReal && altDeg != null && pixelScale != null) {
        const halfFovVdeg = (i.imageHeight / 2) * pixelScale / 3600;
        const altTop = Math.min(89.9, altDeg + halfFovVdeg);
        const altBot = Math.max(0.1, altDeg - halfFovVdeg);
        const diffArcsec = DifferentialRefractionCorrector.computeDifferential(altTop, altBot);
        const q = hourAngleDeg != null ? parallacticAngleDeg(hourAngleDeg, decDeg!, meta!.gps_lat!) : null;
        report.refraction.tier = 'APPROXIMATE';
        report.refraction.targetAltitudeDeg = altDeg;
        report.refraction.airmass = airmass;
        report.refraction.fieldDifferentialArcsec = +diffArcsec.toFixed(4);
        report.refraction.fieldDifferentialPx = +(diffArcsec / pixelScale).toFixed(4);
        report.refraction.zenithParallacticDeg = q != null ? +q.toFixed(3) : null;
        report.refraction.zenithPaImageDeg = (cd && q != null) ? +zenithPaImageDeg(cd, q).toFixed(3) : null;
        report.refraction.note = 'Field-level differential refraction (Bennett, revived DifferentialRefractionCorrector) — the plate stretch toward zenith across the frame. APPROXIMATE, PREDICTOR ONLY (never wired back into the solve). The single-star PSF-elongation term (atmospheric DISPERSION, chromatic) is now PREDICTED in `chromaticDispersion` (cell ⑤).';
        delete report.refraction.notMeasured;
        approximate.push('Differential refraction is a Bennett approximation at standard P/T; plate-level (not a single-star PSF term).');

        // ═══ CELL ⑤ — chromatic atmospheric-DISPERSION PSF elongation ═══
        // The single-star term the achromatic Bennett model defers: blue refracts
        // more than red, stretching each star along the zenith line. A PREDICTED
        // decomposition vector (magnitude + direction) — reported, NEVER applied to
        // the measured shape (the measurement stays the arbiter, LAW-1 fourth layer).
        const dispArc = chromaticDispersionArcsec(altDeg);
        report.refraction.chromaticDispersion = {
            tier: 'APPROXIMATE',
            magnitudeArcsec: +dispArc.toFixed(4),
            magnitudePx: pixelScale != null ? +(dispArc / pixelScale).toFixed(4) : null,
            paImageDeg: report.refraction.zenithPaImageDeg,
            lambdaBlueUm: LAMBDA_UM.b,
            lambdaRedUm: LAMBDA_UM.r,
            note: `Chromatic atmospheric dispersion (λ_b=${LAMBDA_UM.b}µm vs λ_r=${LAMBDA_UM.r}µm) ≈ |Δn|·tan(z)·206265 at alt ${altDeg.toFixed(1)}°, elongating the PSF along the zenith line (paImageDeg). PREDICTOR ONLY, additive decomposition — never mutates the measured shape. APPROXIMATE (plane-parallel, standard T/P).`,
        };
        approximate.push('Chromatic dispersion (cell ⑤) is a predicted PSF-elongation vector, never subtracted from the measurement.');
    } else {
        report.refraction.notMeasured = !clockReal
            ? 'Timestamp untrusted / DEFAULT — refraction gated OFF (bogus clock ⇒ bogus geometry).'
            : !gpsReal ? 'GPS DEFAULT/absent — refraction gated OFF.'
            : 'Observing geometry unavailable — refraction NOT MEASURED.';
    }

    // ═══ COMA — FORM immutable, MAGNITUDE fitted (1-param) ═══
    if (psf.regions && psf.regions.length === 9 && psf.nFit >= 4) {
        // region centers on the psf_field grid (row-major top-left → bottom-right)
        const gw = psf.width, gh = psf.height;
        const samples = psf.regions.map((rg, idx) => {
            const col = idx % 3, row = Math.floor(idx / 3);
            return {
                cx: (col + 0.5) * gw / 3,
                cy: (row + 0.5) * gh / 3,
                ellipticity: rg.ellipticityMedian,
                orientationDeg: rg.orientationMedianDeg,
            };
        });
        const fit = fitComaCoefficient(samples, gw, gh);
        report.coma.tier = 'FITTED';
        report.coma.fit = fit;
        report.coma.note = fit.patternConsistent
            ? 'Measured field matches the immutable coma FORM (ellipticity grows radially with field radius, oriented radially). Coefficient FITTED (form-exact, magnitude-empirical) — per-lens, accumulable per copy later (like Brown-Conrady). Never fabricated from EXIF.'
            : 'Coma FORM checked against the measured 3×3 field; pattern NOT consistent (elongation not radial/growing) — no coma coefficient asserted.';
        delete report.coma.notMeasured;
    } else {
        report.coma.notMeasured = 'Too few measured regions for a coma-form fit — NOT MEASURED.';
    }

    // ═══ DECOMPOSITION ═══
    report.decomposition = {
        measuredMajPx: majPx, measuredMinPx: minPx,
        explainedDriftPx: report.drift.presence === 'CONFIRMED_PRESENT' ? report.drift.explainedPx : null,
        diffractionFloorPx: report.diffraction.floorPx?.g ?? null,
        seeingPx: report.seeing.px,
        residualCorePx: report.drift.presence === 'CONFIRMED_PRESENT'
            ? report.drift.residualCorePx
            : majPx, // no confirmed drift ⇒ the whole measured PSF is the residual
        note: report.drift.presence === 'CONFIRMED_PRESENT'
            ? 'measured_major = exact_drift ⊗ residual_core (quadrature). The residual (seeing/guiding/focus/optics) is what physics cannot attribute to drift; the diffraction+seeing floors sit inside it.'
            : 'No confirmed drift — the measured PSF is reported wholly as residual (physics found no confirmable calculable component to remove).',
    };

    // ═══ MOUNT / TRACKING — INFERRED ═══
    report.tracking = inferTracking(report);

    // ═══ CELL ⑥ — SKY-DEPROJECTED PSF SHAPE (local Jacobian), FLAG-GATED ═══
    // Default OFF ⇒ skyDeprojected stays null ⇒ byte-identical. When ON, convert
    // the measured pixel shape to SKY angle through the local CD Jacobian
    // (arcsec/px) — captures the anisotropy/skew/rotation the scalar pixel_scale
    // drops — and report it ALONGSIDE the raw-px values. forced_confirm's shape
    // gate is UNTOUCHED (it keeps consuming raw px; a migration needs paired recal).
    if (PIPELINE_CONSTANTS.PSF_JACOBIAN_DEPROJECT && cd && majPx != null && minPx != null && oriDeg != null) {
        const J = cdToJacobianArcsec(cd);
        const sky = deprojectShapeByJacobian(majPx, minPx, oriDeg, J);
        const hasHi = !!((sol as any).astrometry?.sip || (sol as any).astrometry?.tps || (sol as any).wcs?.sip);
        report.skyDeprojected = {
            tier: 'APPROXIMATE',
            jacobianSource: dirSource === 'WCS_CD' ? 'WCS_CD' : 'SYNTHESIZED_CD',
            higherOrderPresentUnused: hasHi,
            fwhmMajArcsec: +sky.fwhmMajArcsec.toFixed(4),
            fwhmMinArcsec: +sky.fwhmMinArcsec.toFixed(4),
            orientationDeg: +sky.orientationDeg.toFixed(3),
            ellipticity: +sky.ellipticity.toFixed(4),
            fwhmMajPx: majPx, fwhmMinPx: minPx, orientationDegPx: oriDeg, ellipticityPx: ellip,
            fwhmMajArcsecScalar: pixelScale != null ? +(majPx * pixelScale).toFixed(4) : null,
            fwhmMinArcsecScalar: pixelScale != null ? +(minPx * pixelScale).toFixed(4) : null,
            note: `Sky-corrected PSF shape via the local ${dirSource === 'WCS_CD' ? 'fitted CD' : 'synthesized CD'} Jacobian (arcsec/px) — vs the isotropic scalar pixel_scale. Linear WCS ⇒ J spatially constant.${hasHi ? ' Solve carries SIP/TPS whose higher-order local-scale variation is NOT captured here (honest gap).' : ''} Reported ALONGSIDE raw px; forced_confirm keeps raw px.`,
        };
        approximate.push('Sky-deprojected PSF shape (cell ⑥) is reported alongside raw px; the shape gate still consumes raw px.');
    }

    // ═══ CELL ④ — UNDISTORTED PSF CENTROIDS (additive; feeds future refits) ═══
    // Record each measured star's native + undistorted (native→corrected) position
    // when a distortion model is available: the injected this-solve model first,
    // else the BC lens prior. No model (the pinned CR2's lying EXIF → null) ⇒
    // native only, honest. Purely additive — never touches the WCS/solve.
    if (psf.fits && psf.fits.length > 0) {
        const hasSolveSip = !!((sol as any).astrometry?.sip || (sol as any).astrometry?.tps || (sol as any).wcs?.sip);
        let model: LensDistortionModel | null = i.distortionModel ?? null;
        let provenance: 'INJECTED_SOLVE' | 'BC_PRIOR' | 'SIP_PRESENT_UNAPPLIED' | 'NONE' = model ? 'INJECTED_SOLVE' : 'NONE';
        if (!model) {
            const res = resolveLensDistortion(i.metadata as any, undefined);
            if (res && (res.k1 !== 0 || res.k2 !== 0)) {
                model = makeBrownConradyDistortion(res.k1, res.k2, i.imageWidth, i.imageHeight);
                provenance = 'BC_PRIOR';
            } else if (hasSolveSip) {
                provenance = 'SIP_PRESENT_UNAPPLIED';
            }
        }
        const cap = Math.min(psf.fits.length, 500);
        const out: [number, number] = [0, 0];
        report.centroids = {
            modelProvenance: provenance,
            modelKind: model ? model.model : (provenance === 'SIP_PRESENT_UNAPPLIED' ? 'sip/tps (no native→corrected applicator wired here)' : 'none'),
            hasSolveSip,
            stars: psf.fits.slice(0, cap).map(f => {
                let xu: number | null = null, yu: number | null = null;
                if (model) { model.toCorrected(f.x, f.y, out); xu = +out[0].toFixed(3); yu = +out[1].toFixed(3); }
                return { xNative: +f.x.toFixed(3), yNative: +f.y.toFixed(3), xUndist: xu, yUndist: yu };
            }),
            note: model
                ? `Undistorted (native→corrected) via the ${provenance === 'INJECTED_SOLVE' ? 'injected this-solve' : 'resolved BC lens prior'} model (${model.model}, k1=${model.k1}, k2=${model.k2}) — additive, feeds future refits; no behavioral change.`
                : provenance === 'SIP_PRESENT_UNAPPLIED'
                    ? 'This solve carries SIP/TPS but no native→corrected applicator is wired here — undistorted positions NOT computed (native recorded). Honest gap.'
                    : 'No distortion model resolvable (lying/absent EXIF lens, no injected model) — native positions only.',
        };
    }

    report.approximate = approximate;

    i.events?.emit({
        kind: 'finding',
        finding: {
            kind: 'psf_measured',
            nStars: psf.nFit,
            fwhmMedianPx: majPx != null ? +majPx.toFixed(3) : 0,
        },
    });

    return report;
}

/** Deduce the mount/tracking regime from the drift presence gate. INFERRED. */
function inferTracking(r: PsfAttributionReport): PsfAttributionReport['tracking'] {
    const d = r.drift;
    if (d.presence === 'NOT_MEASURED' || d.calculatedPx == null) {
        return { tier: 'NOT_MEASURED', inference: 'NOT_MEASURED', rationale: 'No calculable drift (missing exposure/Dec/scale) — tracking not inferable.' };
    }
    if (d.presence === 'NEGLIGIBLE') {
        return { tier: 'INFERRED', inference: 'INDETERMINATE', rationale: `Calculated drift (${d.calculatedPx}px) is below the measurement floor — untracked vs tracked is indistinguishable.` };
    }
    if (d.presence === 'CONFIRMED_PRESENT') {
        return { tier: 'INFERRED', inference: 'UNTRACKED', rationale: 'Measured elongation ≈ calculated static sidereal drift in magnitude AND direction ⇒ the mount did not track (INFERRED).' };
    }
    // NOT_CONFIRMED: measured elongation ≪ predicted drift ⇒ tracked; else other.
    const aniso = r.measured.anisotropyPx;
    if (aniso != null && aniso < 0.5 * d.calculatedPx) {
        return { tier: 'INFERRED', inference: 'TRACKED', rationale: `Measured elongation (${aniso}px) ≪ calculated static drift (${d.calculatedPx}px) ⇒ the mount tracked (INFERRED).` };
    }
    return { tier: 'INFERRED', inference: 'INDETERMINATE', rationale: 'Measured elongation is significant but does not match the calculated static drift (magnitude or direction) — an unmodeled source (guiding error / field rotation / optics); tracking indeterminate.' };
}

// ─── receipt serializer (mirrors serializePsfFieldBlock) ──────────────────────

/**
 * Compact, JSON-ready attribution block for the receipt. Every field is
 * honest-or-null and tier-labeled. Additive — never re-keys existing blocks.
 */
export function serializePsfAttributionBlock(r: PsfAttributionReport): Record<string, any> {
    return {
        ledger: r.ledger,
        grid: r.grid,
        pixel_scale_arcsec_px: r.pixelScaleArcsecPerPx,
        measured: r.measured,
        drift: r.drift,
        diffraction: r.diffraction,
        seeing: r.seeing,
        refraction: r.refraction,
        coma: r.coma,
        field_rotation: r.fieldRotation,
        decomposition: r.decomposition,
        tracking: r.tracking,
        // CELL ⑥/④ — additive, honest-or-absent (null by default → byte-identical).
        sky_deprojected: r.skyDeprojected,
        centroids: r.centroids,
        approximate: r.approximate,
        not_measured: r.notMeasured ?? null,
    };
}
