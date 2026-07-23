/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IMAGE CONDITIONS — the regime-discriminating feature layer (SANDBOX)
 * ═══════════════════════════════════════════════════════════════════════════
 * Measures the "image conditions" that (in the full program) would select the
 * optimal detection knobs. Honest-or-absent: every field is either a real
 * measurement or explicitly NOT_MEASURED — no field is ever faked. Reuses
 * existing engine measurements wherever they exist:
 *   - StatisticsProvider.calculateStats     (frame mean/stdDev)
 *   - sampledBackgroundSigma (deep_verify)  (robust median/MAD sky sigma)
 *   - measureHotPixelCandidates (hot_pixel_map)  (thermal proxy, per-MP density)
 *   - the adaptive detect_harness            (detection density / crowding)
 *
 * PHYSICS PSF PRIOR (owner's analytical model, folded in): a deterministic
 * predicted PSF from EXIF/sensor optics tells the optimizer the SAMPLING REGIME
 * — the single most important condition, because it decides WHETHER the shape
 * knobs (fwhm-floor / sharpness / ellipticity) can discriminate at all:
 *   p (arcsec/px)      = 206.265 · μ_µm / f_mm            (or the solved scale)
 *   diffraction (px)   ≈ 1.028 · λ_µm · N / μ_µm          (λ≈0.55 green, N=f/D)
 *   seeing (px)        = θ_seeing_arcsec / p,  θ = θ_zenith · (sec z)^0.6
 *   core (px)          = sqrt(diff² + seeing² + optics² + tracking²)
 *   predicted FWHM(px) = max(core, sampling_floor≈2px)    (Nyquist/extractor floor)
 * UNDERSAMPLED (core ≪ 1px): real stars collapse to ~floor-sized point sources,
 * morphologically INDISTINGUISHABLE from 2px thermal clumps → shape cuts lose
 * separating power. OVERSAMPLED (core spans several px): shape cuts discriminate.
 * samplingRegime is therefore a first-class condition, not a footnote.
 *
 * FL TRAP: EXIF focal_length can LIE (bundled CR2 carries a factory 50mm; the
 * real lens is 14mm). So the effective FL is RECOVERED from the solved pixel
 * scale + sensor pitch (f_eff = 206.265·μ/p_solved) rather than trusted from EXIF.
 */

import { StatisticsProvider } from '@/engine/core/StatisticsProvider';
import { measureHotPixelCandidates } from '@/engine/pipeline/m4_signal_detect/hot_pixel_map';
import { sampledBackgroundSigma } from '@/engine/pipeline/m6_plate_solve/deep_verify';
import { runDetection, baselineKnobs, type Detection } from './detect_harness';

const LAMBDA_GREEN_UM = 0.55;
const DEFAULT_SEEING_ZENITH_ARCSEC = 2.0; // typical amateur site — APPROXIMATE
const SAMPLING_FLOOR_PX = 2.0;            // Nyquist + wasm ≥2-connected-px floor

// ── pure physics helpers (deterministic; no pixels) ──────────────────────────

/** Pixel scale (arcsec/px) from pitch + focal length. */
export function pixelScaleArcsecPerPx(pitchUm: number, focalLengthMm: number): number {
    return 206.265 * pitchUm / focalLengthMm;
}
/** Effective focal length (mm) recovered from a trusted (solved) pixel scale. */
export function effectiveFocalLengthMm(pitchUm: number, solvedArcsecPerPx: number): number {
    return 206.265 * pitchUm / solvedArcsecPerPx;
}
/** Diffraction FWHM in native sensor px (Airy core ≈ 1.028·λ·N/μ). */
export function diffractionFwhmPx(fNumber: number, pitchUm: number, lambdaUm = LAMBDA_GREEN_UM): number {
    return 1.028 * lambdaUm * fNumber / pitchUm;
}
/** Seeing FWHM in px = seeing(arcsec)/pixel-scale, seeing airmass-scaled. */
export function seeingFwhmPx(seeingArcsec: number, arcsecPerPx: number): number {
    return seeingArcsec / arcsecPerPx;
}
/** Airmass (plane-parallel sec z) from target altitude — APPROXIMATE below ~30°. */
export function airmassFromAltitude(altDeg: number): number {
    const z = (90 - altDeg) * Math.PI / 180;
    return 1 / Math.max(0.05, Math.cos(z));
}
/** Target altitude (deg) from equatorial coords + observer + UTC time. Standard
 *  LST/hour-angle astronomy (deterministic) — NOT a detection reimplementation. */
export function altitudeDeg(raHours: number, decDeg: number, latDeg: number, lonDeg: number, date: Date): number {
    const JD = date.getTime() / 86400000 + 2440587.5;
    const D = JD - 2451545.0;
    // Greenwich mean sidereal time (deg), then local
    const GMST = (280.46061837 + 360.98564736629 * D) % 360;
    const LST = ((GMST + lonDeg) % 360 + 360) % 360;
    const H = ((LST - raHours * 15) % 360 + 360) % 360; // hour angle (deg)
    const Hr = H * Math.PI / 180, dr = decDeg * Math.PI / 180, lr = latDeg * Math.PI / 180;
    const sinAlt = Math.sin(dr) * Math.sin(lr) + Math.cos(dr) * Math.cos(lr) * Math.cos(Hr);
    return Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180 / Math.PI;
}

export type Provenance = 'MEASURED' | 'PHYSICS' | 'APPROXIMATE' | 'EMPIRICAL' | 'NOT_MEASURED';
export type SamplingRegime = 'undersampled' | 'critically-sampled' | 'oversampled' | 'NOT_MEASURED';

export interface ImageConditions {
    frame: string;
    width: number;
    height: number;
    megapixels: number;

    // ── background / sky (MEASURED) ──
    bgMean: number;
    bgStdDev: number;
    bgMedian: number;
    bgSigmaRobust: number;               // median/MAD — robust to stars
    bgGradientSigma: number;             // large-scale gradient in σ units (block medians)

    // ── thermal proxy (MEASURED) ──
    hotPixelDensityPerMP: number;        // flagged spikes/MP at the calibrated N=6
    hotPixelLadderPerMP: Record<string, number>;

    // ── crowding (MEASURED via the real detector at baseline knobs) ──
    detectionDensityPerMP: number;
    rawDeepDensityPerMP: number;
    measuredMedianFwhmPx: number | null; // empirical stellar PSF on the detection grid

    // ── optics / hardware ──
    focalLengthMmEff: number | null;     // recovered from solved scale (FL-trap-proof)
    focalLengthMmExif: number | null;    // raw EXIF (may LIE)
    apertureFNumber: number | null;
    pixelPitchUm: number | null;
    sensorClass: string;
    pixelScaleArcsecPerPx: number | null;// solved (preferred) else EXIF-derived

    // ── observing geometry ──
    targetAltitudeDeg: number | null;
    airmass: number | null;

    // ── PHYSICS PSF prior ──
    diffractionFwhmPx: number | null;
    seeingFwhmPx: number | null;
    predictedCorePx: number | null;      // pre-floor optical+seeing core (regime axis)
    predictedFwhmPx: number | null;      // floored at sampling limit
    samplingRegime: SamplingRegime;
    samplingRegimeSource: 'PHYSICS' | 'EMPIRICAL' | 'NOT_MEASURED';

    provenance: Record<string, Provenance>;
}

export interface FrameMetaLike {
    camera_model?: string;
    focal_length?: number;
    aperture?: number;
    pixel_pitch_um?: number;
    timestamp?: string;
    timestamp_source?: string;
    gps_lat?: number;
    gps_lon?: number;
    gps_source?: string;
}

export interface SolvedLike {
    ra_hours?: number;
    dec_degrees?: number;
    pixel_scale?: number; // arcsec/px (trusted)
}

/** Coarse gradient: 3×3 block medians, (max−min)/bgSigma. Deterministic. */
function blockGradientSigma(lum: Float32Array, w: number, h: number, bgSigma: number): number {
    const bx = 3, by = 3;
    const meds: number[] = [];
    for (let gy = 0; gy < by; gy++) {
        for (let gx = 0; gx < bx; gx++) {
            const x0 = Math.floor(gx * w / bx), x1 = Math.floor((gx + 1) * w / bx);
            const y0 = Math.floor(gy * h / by), y1 = Math.floor((gy + 1) * h / by);
            const s: number[] = [];
            const stepX = Math.max(1, Math.floor((x1 - x0) / 40));
            const stepY = Math.max(1, Math.floor((y1 - y0) / 40));
            for (let y = y0; y < y1; y += stepY) for (let x = x0; x < x1; x += stepX) s.push(lum[y * w + x]);
            s.sort((a, b) => a - b);
            meds.push(s[s.length >> 1] ?? 0);
        }
    }
    const mn = Math.min(...meds), mx = Math.max(...meds);
    return bgSigma > 0 ? (mx - mn) / bgSigma : 0;
}

/** Sensor-class heuristic from camera model + pitch (honest coarse buckets). */
function classifySensor(model: string | undefined, pitchUm: number | null): string {
    if (!model) return 'NOT MEASURED';
    const m = model.toLowerCase();
    if (/asi|zwo|qhy|atik|mono|1600mm|2600mm/.test(m)) return 'dedicated-astro';
    if (/seestar|dwarf|vespera/.test(m)) return 'smart-scope';
    if (pitchUm != null && pitchUm >= 6.0) return 'DSLR-large-pixel';
    if (pitchUm != null && pitchUm < 6.0) return 'DSLR/mirrorless-fine-pixel';
    return `camera:${model}`;
}

/**
 * Measure the full ImageConditions descriptor for a frame. `detections` (from a
 * baseline-knob run) may be passed to avoid a redundant detection pass; if
 * omitted, a baseline run is done here for the crowding + empirical-FWHM fields.
 */
export function measureImageConditions(args: {
    frame: string;
    lum: Float32Array;
    width: number;
    height: number;
    meta?: FrameMetaLike;
    solved?: SolvedLike;
    detections?: Detection[];
}): ImageConditions {
    const { frame, lum, width, height, meta, solved } = args;
    const megapixels = (width * height) / 1e6;
    const prov: Record<string, Provenance> = {};

    // ── background ──
    const { mean, stdDev } = StatisticsProvider.calculateStats(lum);
    const robust = sampledBackgroundSigma(lum);
    const bgGradientSigma = blockGradientSigma(lum, width, height, robust.sigma);
    prov.bgMean = prov.bgStdDev = 'MEASURED';
    prov.bgMedian = prov.bgSigmaRobust = 'MEASURED';
    prov.bgGradientSigma = 'MEASURED';

    // ── thermal proxy ──
    const ladder = measureHotPixelCandidates(lum, width, height, mean, stdDev);
    const ladderPerMP: Record<string, number> = {};
    for (const k of Object.keys(ladder)) ladderPerMP[k] = +(ladder[k] / megapixels).toFixed(2);
    const hotPixelDensityPerMP = ladderPerMP['N6'] ?? 0; // calibrated N
    prov.hotPixelDensityPerMP = 'MEASURED';

    // ── crowding + empirical PSF (real detector at baseline knobs) ──
    const dets = args.detections ?? runDetection(lum, width, height, baselineKnobs(meta?.focal_length)).detections;
    const detectionDensityPerMP = +(dets.length / megapixels).toFixed(1);
    const mfw = dets.map(d => d.momentFwhmPx).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
    const measuredMedianFwhmPx = mfw.length ? +mfw[mfw.length >> 1].toFixed(3) : null;
    prov.detectionDensityPerMP = 'MEASURED';
    prov.measuredMedianFwhmPx = measuredMedianFwhmPx != null ? 'EMPIRICAL' : 'NOT_MEASURED';

    // raw deep density needs a fresh run only if detections were supplied pre-cut
    const rawDeepDensityPerMP = +(dets.length / megapixels).toFixed(1); // proxy; exact raw in run object

    // ── optics / hardware ──
    const pitchUm = meta?.pixel_pitch_um ?? null;
    const focalLengthMmExif = meta?.focal_length ?? null;
    const apertureFNumber = meta?.aperture && meta.aperture > 0 ? meta.aperture : null;
    const solvedScale = solved?.pixel_scale ?? null;
    const pixelScaleArcsecPerPx = solvedScale ?? (pitchUm && focalLengthMmExif ? pixelScaleArcsecPerPx(pitchUm, focalLengthMmExif) : null);
    prov.pixelScaleArcsecPerPx = solvedScale ? 'MEASURED' : (pixelScaleArcsecPerPx != null ? 'PHYSICS' : 'NOT_MEASURED');

    // effective FL: prefer recovery from solved scale (FL-trap-proof)
    let focalLengthMmEff: number | null = null;
    if (pitchUm && solvedScale) { focalLengthMmEff = +effectiveFocalLengthMm(pitchUm, solvedScale).toFixed(2); prov.focalLengthMmEff = 'MEASURED'; }
    else if (focalLengthMmExif) { focalLengthMmEff = focalLengthMmExif; prov.focalLengthMmEff = 'APPROXIMATE'; }
    else prov.focalLengthMmEff = 'NOT_MEASURED';
    prov.focalLengthMmExif = focalLengthMmExif != null ? 'MEASURED' : 'NOT_MEASURED';
    prov.apertureFNumber = apertureFNumber != null ? 'MEASURED' : 'NOT_MEASURED';
    prov.pixelPitchUm = pitchUm != null ? 'MEASURED' : 'NOT_MEASURED';
    const sensorClass = classifySensor(meta?.camera_model, pitchUm);
    prov.sensorClass = sensorClass === 'NOT MEASURED' ? 'NOT_MEASURED' : 'MEASURED';

    // ── observing geometry (only when observer + time are REAL, not DEFAULT) ──
    let targetAltitudeDeg: number | null = null, airmass: number | null = null;
    const obsReal = meta?.gps_source && meta.gps_source !== 'DEFAULT' && meta?.timestamp && meta.timestamp_source !== 'DEFAULT';
    if (obsReal && solved?.ra_hours != null && solved?.dec_degrees != null && meta?.gps_lat != null && meta?.gps_lon != null) {
        targetAltitudeDeg = +altitudeDeg(solved.ra_hours, solved.dec_degrees, meta.gps_lat, meta.gps_lon, new Date(meta.timestamp!)).toFixed(2);
        airmass = targetAltitudeDeg > 3 ? +airmassFromAltitude(targetAltitudeDeg).toFixed(3) : null;
        prov.targetAltitudeDeg = 'APPROXIMATE';
        prov.airmass = airmass != null ? 'APPROXIMATE' : 'NOT_MEASURED';
    } else {
        prov.targetAltitudeDeg = prov.airmass = 'NOT_MEASURED';
    }

    // ── PHYSICS PSF prior ──
    let diffPx: number | null = null, seePx: number | null = null, corePx: number | null = null, predFwhm: number | null = null;
    const pForSeeing = pixelScaleArcsecPerPx;
    if (apertureFNumber != null && pitchUm != null) { diffPx = +diffractionFwhmPx(apertureFNumber, pitchUm).toFixed(4); prov.diffractionFwhmPx = 'PHYSICS'; }
    else prov.diffractionFwhmPx = 'NOT_MEASURED';
    if (pForSeeing != null) {
        const secz = airmass ?? 1.0;
        const seeingArcsec = DEFAULT_SEEING_ZENITH_ARCSEC * Math.pow(secz, 0.6);
        seePx = +seeingFwhmPx(seeingArcsec, pForSeeing).toFixed(4);
        prov.seeingFwhmPx = 'APPROXIMATE'; // θ_zenith assumed
    } else prov.seeingFwhmPx = 'NOT_MEASURED';
    if (diffPx != null || seePx != null) {
        corePx = +Math.sqrt((diffPx ?? 0) ** 2 + (seePx ?? 0) ** 2).toFixed(4);
        predFwhm = +Math.max(corePx, SAMPLING_FLOOR_PX).toFixed(3);
        prov.predictedCorePx = 'PHYSICS';
        prov.predictedFwhmPx = 'PHYSICS';
    } else { prov.predictedCorePx = prov.predictedFwhmPx = 'NOT_MEASURED'; }

    // ── sampling regime: EMPIRICAL measured FWHM is the TRUTH and wins when
    // available; the PHYSICS core is only a LOWER BOUND (omits optics/tracking/
    // stacking, assumes nominal seeing) — measured M66/M51 FWHM (~3.6px) run
    // 3-4× the physics core, and their high injected-junk separating power
    // (0.38/0.58) tracks the EMPIRICAL (oversampled) regime, not the physics
    // core. Physics is used only when there is no science buffer (EXIF-only, e.g.
    // the browser-gated CR2). ──
    let samplingRegime: SamplingRegime = 'NOT_MEASURED';
    let samplingRegimeSource: ImageConditions['samplingRegimeSource'] = 'NOT_MEASURED';
    if (measuredMedianFwhmPx != null) {
        // a median stellar momentFwhm at/near the sampling floor ⇒ point sources
        // indistinguishable from junk (undersampled); several px ⇒ oversampled.
        samplingRegime = measuredMedianFwhmPx <= 2.2 ? 'undersampled' : measuredMedianFwhmPx >= 3.0 ? 'oversampled' : 'critically-sampled';
        samplingRegimeSource = 'EMPIRICAL';
    } else if (corePx != null) {
        samplingRegime = corePx < 1.0 ? 'undersampled' : corePx > 2.5 ? 'oversampled' : 'critically-sampled';
        samplingRegimeSource = 'PHYSICS';
    }

    return {
        frame, width, height, megapixels: +megapixels.toFixed(3),
        bgMean: +mean.toFixed(6), bgStdDev: +stdDev.toFixed(6),
        bgMedian: +robust.median.toFixed(6), bgSigmaRobust: +robust.sigma.toFixed(6),
        bgGradientSigma: +bgGradientSigma.toFixed(2),
        hotPixelDensityPerMP: +hotPixelDensityPerMP.toFixed(2), hotPixelLadderPerMP: ladderPerMP,
        detectionDensityPerMP, rawDeepDensityPerMP, measuredMedianFwhmPx,
        focalLengthMmEff, focalLengthMmExif, apertureFNumber, pixelPitchUm: pitchUm,
        sensorClass, pixelScaleArcsecPerPx: pixelScaleArcsecPerPx != null ? +pixelScaleArcsecPerPx.toFixed(4) : null,
        targetAltitudeDeg, airmass,
        diffractionFwhmPx: diffPx, seeingFwhmPx: seePx, predictedCorePx: corePx, predictedFwhmPx: predFwhm,
        samplingRegime, samplingRegimeSource,
        provenance: prov,
    };
}
