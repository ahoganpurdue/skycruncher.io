/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED STAGE: FINAL ASTROMETRY — the step-6 TERMINAL data-fidelity refit
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: COORDINATE. Produces a SECOND, provenance-tagged WCS by re-fitting the
 * distortion model (SIP) on the evidence-gated matched set using three fidelity
 * upgrades over the solve's own refit, and emits it as an ADDITIVE receipt block.
 * It is a PRODUCT — it NEVER overwrites `solution.wcs` / `solution.astrometry`,
 * NEVER mutates matched_stars, and NEVER feeds back into the solve or the
 * confirmation gate (owner loop-closure ruling). The solve WCS remains the sole
 * authority the sacred e2e/apispec assert on; this block is purely observed.
 *
 * THE THREE FIDELITY UPGRADES (each handed EXPLICITLY, never re-derived — F2):
 *   (a) PSF-FIT CENTROIDS. The matched stars' detected pixel positions are
 *       replaced by the sub-pixel Levenberg-Marquardt centroids the psf_field
 *       stage already measured on the NATIVE grid (nearest-fit, small tolerance).
 *       A star with no nearby fit keeps its raw centroid (honest fallback).
 *   (b) DIFFERENTIAL REFRACTION, APPLIED AT COORDINATE LEVEL. Bennett (via
 *       DifferentialRefractionCorrector / OpticsManager), graduating from the
 *       reported-only predictor in psf_attribution.ts: the per-star apparent
 *       displacement toward zenith RELATIVE to the field centre is subtracted
 *       from the (refined) detected position before the fit, so the refined SIP
 *       models OPTICS with the atmospheric plate-stretch removed. GATED on a
 *       trusted clock AND a real site claim (GPS) — honest-skip otherwise (an
 *       unset clock ⇒ bogus geometry, the same trap family that gates planets).
 *   (c) SNR-HONEST WEIGHTING. The refit is weighted by each star's PSF amplitude
 *       (peak-above-background) — a constant-noise SNR proxy — so bright,
 *       well-determined centroids drive the model. Bounded (clamped dynamic
 *       range) so no single star runs away. APPROXIMATE, labelled.
 *
 * REUSE (LAW 4 — no re-implemented geometry/fit): the LINEAR projection is
 * `ResidualAnalyzer.skyToLinearPixel` (the F2-fixed catalog→pixel convention,
 * crval[0] HOURS / catalog RA DEGREES), the SIP fit is `ResidualAnalyzer.fitSip`
 * (the SAME least-squares fitter, extended with an optional weight vector), the
 * post-SIP residual + polynomial evaluation are `postSipResidualPx` / `evalSipPoly`
 * (mirrored from the bc_rematch pass — never a re-derived SIP sign), and the
 * observing geometry is the psf_physics helpers.
 *
 * Honest degradation: no solution / no fitted WCS / no measured PSF field / too
 * few matched stars → returns null (the receipt records `final_astrometry: null`,
 * never a fabricated WCS).
 */

import type { PlateSolution, MatchedStar } from '../../types/Main_types';
import type { HardMetadata } from '../../types/schema';
import type { PipelineEventBus } from '../../events/pipeline_events';
import type { PsfFieldReport } from '../m10_psf/psf_field';
import { ResidualAnalyzer, type SIPCoefficients } from '../m7_astrometry/residual_analyzer';
import { postSipResidualPx } from '../m2_hardware/lens_distortion_rematch';
import { DifferentialRefractionCorrector } from '../m5_coordinate_flatten/differential_refraction_corrector';
import {
    targetGeometry, parallacticAngleDeg, zenithPaImageDeg, type Cd2x2,
} from '../m10_psf/psf_physics';

// ─── tuning (fixed, NOT calibrated gates — the block never feeds the solve) ────

/** Min matched stars for a terminal refit (mirrors ResidualAnalyzer's SIP gate). */
const MIN_STARS = 20;
/** SIP fit order (mirrors ResidualAnalyzer.analyze's default). */
const DEFAULT_SIP_ORDER = 3;
/** A PSF fit within this many px of a matched detection is that star's centroid. */
const PSF_MATCH_TOL_PX = 3.0;
/** Bounded SNR-honest weight: amp/median clamped to this dynamic range. */
const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 10.0;

const DEG = Math.PI / 180;

// ─── contracts ────────────────────────────────────────────────────────────────

export interface FinalAstrometryRefraction {
    /** True iff the differential-refraction correction was APPLIED at the fit. */
    applied: boolean;
    tier: 'APPROXIMATE' | 'NOT_MEASURED';
    gatedOn: string;
    siteLatDeg: number | null;
    siteLonDeg: number | null;
    fieldCenterAltDeg: number | null;
    /** Median / max |per-star differential displacement removed| (px). */
    medianDisplacementPx: number | null;
    maxDisplacementPx: number | null;
    /** Zenith direction in image space (deg, [0,360)) — the displacement axis. */
    zenithPaImageDeg: number | null;
    /** Why the correction was NOT applied (honest-skip). Absent when applied. */
    notApplied?: string;
}

export interface FinalAstrometryReport {
    ledger: 'COORDINATE';
    /** This is a REFINED PRODUCT — never the solve WCS. */
    provenance: 'REFINED_FINAL_ASTROMETRY';
    /** Grid the pixel math lives in (mirrors psf_field.grid). */
    grid: 'SCIENCE_NATIVE' | 'SCIENCE_BINNED2X' | null;
    /** Matched stars entering the refit (sentinel-filtered). */
    nStars: number;
    /** How many adopted a PSF-fit (LM/moment) centroid vs kept the raw detection. */
    nPsfCentroids: number;
    psfCentroidSource: 'WASM_LM_GAUSSIAN' | 'MOMENT_FALLBACK' | 'NOT_MEASURED';
    sipOrder: number;
    /** Refined SIP (ENGINE-internal convention OBSERVED−IDEAL — the SAME the solve
     *  stores; the FITS export negates at the boundary via sip_convention.ts).
     *  Null when the fit refused (rank-deficient config). */
    sip: SIPCoefficients | null;
    /** The refined WCS — a SECOND product. Linear terms are the solve's (BC/SIP
     *  absorb residual distortion; a linear-WCS refit is a separate solver, out of
     *  scope) + the refined SIP. crval[0] in HOURS (engine convention). Null when
     *  the solve carried no usable linear WCS. */
    wcs: {
        crpix: [number, number];
        crval: [number, number];
        cd: [[number, number], [number, number]];
    } | null;
    /** Residual RMS (arcsec), unweighted + SNR-weighted, BEFORE (linear only) and
     *  AFTER (linear + refined SIP), all on the refined+refraction-corrected
     *  centroids. Plus the SOLVE's own mean residual for context (informational). */
    rms: {
        linearArcsec: number | null;
        refinedArcsec: number | null;
        weightedLinearArcsec: number | null;
        weightedRefinedArcsec: number | null;
        solveMeanResidualArcsec: number | null;
    };
    /** Evidence only (NEVER a gate that feeds the solve): refined RMS ≤ linear. */
    improved: boolean;
    weighting: {
        method: 'PSF_AMPLITUDE' | 'UNIFORM';
        note: string;
    };
    refraction: FinalAstrometryRefraction;
    approximate: string[];
    notMeasured?: string;
}

export interface FinalAstrometryInput {
    solution: PlateSolution | null;
    /** The MEASURED PSF field (LM/moment sub-pixel centroids + amplitudes). */
    psfField: PsfFieldReport | null;
    metadata: HardMetadata | null;
    /** False when the capture clock is a wall-clock fallback (gates refraction). */
    timestampTrusted: boolean;
    imageWidth: number;
    imageHeight: number;
    /** SIP fit order (default 3, mirrors ResidualAnalyzer). */
    sipOrder?: number;
    events?: PipelineEventBus;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function median(xs: number[]): number | null {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
}

/** Nearest PSF fit (x/y/amp) to (x,y) within tol; null when none. */
function nearestFit(
    fits: { x: number; y: number; amp: number }[], x: number, y: number, tol: number,
): { x: number; y: number; amp: number } | null {
    let best: { x: number; y: number; amp: number } | null = null;
    let bestD2 = tol * tol;
    for (const f of fits) {
        const dx = f.x - x, dy = f.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) { bestD2 = d2; best = f; }
    }
    return best;
}

// ─── the stage ────────────────────────────────────────────────────────────────

/**
 * Run the terminal astrometric refit. Pure/synchronous (CPU geometry + a
 * least-squares fit — headless-safe). Never throws on missing inputs; degrades
 * to a null report. NEVER mutates `solution` / `psfField`.
 */
export function runFinalAstrometry(i: FinalAstrometryInput): FinalAstrometryReport | null {
    const sol = i.solution;
    const psf = i.psfField;
    if (!sol) return null;
    const wcs = sol.wcs as { crpix?: [number, number]; crval?: [number, number]; cd?: [[number, number], [number, number]] } | undefined;
    if (!wcs?.crpix || !wcs?.crval || !wcs?.cd) return null;   // no fitted linear WCS
    if (!psf || !psf.fits || psf.fits.length === 0) return null; // no centroid basis
    const pixelScale = sol.pixel_scale;
    if (!(Number.isFinite(pixelScale) && pixelScale > 0)) return null;

    // Evidence-gated match set: the SAME sentinel filter every refit uses
    // (planetary-verification flags + non-finite residuals excluded).
    const matched: MatchedStar[] = (sol.matched_stars ?? []).filter(m =>
        Number.isFinite(m.residual_arcsec) && m.residual_arcsec < 999 &&
        !(m.catalog?.gaia_id || '').startsWith('planet_') &&
        Number.isFinite(m.detected?.x) && Number.isFinite(m.detected?.y),
    );
    if (matched.length < MIN_STARS) return null;

    const approximate: string[] = [];
    const crpix = wcs.crpix;
    const cd = wcs.cd as Cd2x2;
    const sipOrder = i.sipOrder ?? DEFAULT_SIP_ORDER;

    // ── (a) PSF-fit centroids: adopt each matched star's nearby LM centroid ──
    const fits = psf.fits.map(f => ({ x: f.x, y: f.y, amp: f.amp }));
    interface Refined { x: number; y: number; amp: number | null; ra: number; dec: number; ra_hours: number }
    const refined: Refined[] = [];
    let nPsf = 0;
    for (const m of matched) {
        const hit = nearestFit(fits, m.detected.x, m.detected.y, PSF_MATCH_TOL_PX);
        if (hit) nPsf++;
        refined.push({
            x: hit ? hit.x : m.detected.x,
            y: hit ? hit.y : m.detected.y,
            amp: hit && Number.isFinite(hit.amp) && hit.amp > 0 ? hit.amp : null,
            ra: m.catalog.ra, dec: m.catalog.dec,
            ra_hours: (m.catalog.ra_hours ?? m.catalog.ra / 15),
        });
    }
    const psfCentroidSource: FinalAstrometryReport['psfCentroidSource'] =
        psf.method === 'WASM_LM_GAUSSIAN' ? 'WASM_LM_GAUSSIAN'
            : psf.method === 'MOMENT_FALLBACK' ? 'MOMENT_FALLBACK' : 'NOT_MEASURED';
    if (nPsf < matched.length) {
        approximate.push(`${matched.length - nPsf}/${matched.length} matched stars had no PSF fit within ${PSF_MATCH_TOL_PX}px — kept their raw solve centroid (honest fallback).`);
    }

    // ── (b) Differential refraction (gated) applied at coordinate level ──
    const meta = i.metadata;
    const gpsReal = !!(meta?.gps_source && meta.gps_source !== 'DEFAULT' &&
        Number.isFinite(meta?.gps_lat) && Number.isFinite(meta?.gps_lon));
    const clockReal = !!(i.timestampTrusted && meta?.timestamp_source &&
        meta.timestamp_source !== 'DEFAULT' && meta?.timestamp);
    const refraction: FinalAstrometryRefraction = {
        applied: false,
        tier: 'NOT_MEASURED',
        gatedOn: 'timestampTrusted && real GPS site claim',
        siteLatDeg: null, siteLonDeg: null, fieldCenterAltDeg: null,
        medianDisplacementPx: null, maxDisplacementPx: null, zenithPaImageDeg: null,
    };
    if (gpsReal && clockReal) {
        const lat = meta!.gps_lat!, lon = meta!.gps_lon!;
        const date = new Date(meta!.timestamp!);
        const centre = targetGeometry(sol.ra_hours, sol.dec_degrees, lat, lon, date);
        const rCentre = DifferentialRefractionCorrector.computeRefractionOffset(centre.altitudeDeg);
        const q = parallacticAngleDeg(centre.hourAngleDeg, sol.dec_degrees, lat);
        const zenithDeg = zenithPaImageDeg(cd, q);
        const zx = Math.cos(zenithDeg * DEG), zy = Math.sin(zenithDeg * DEG);
        const disp: number[] = [];
        for (const r of refined) {
            const g = targetGeometry(r.ra_hours, r.dec, lat, lon, date);
            // ΔR (arcsec) relative to the field centre; a lower star (larger R) is
            // lifted MORE toward zenith, so its APPARENT (detected) position sits
            // farther toward zenith than centre — subtract that to recover the
            // refraction-corrected position the refined SIP then models.
            const dR = DifferentialRefractionCorrector.computeRefractionOffset(g.altitudeDeg) - rCentre;
            const dPx = dR / pixelScale;
            r.x -= dPx * zx;
            r.y -= dPx * zy;
            disp.push(Math.abs(dPx));
        }
        refraction.applied = true;
        refraction.tier = 'APPROXIMATE';
        refraction.siteLatDeg = +lat.toFixed(5);
        refraction.siteLonDeg = +lon.toFixed(5);
        refraction.fieldCenterAltDeg = +centre.altitudeDeg.toFixed(4);
        refraction.medianDisplacementPx = median(disp) != null ? +median(disp)!.toFixed(4) : null;
        refraction.maxDisplacementPx = disp.length ? +Math.max(...disp).toFixed(4) : null;
        refraction.zenithPaImageDeg = +zenithDeg.toFixed(3);
        approximate.push('Differential refraction (Bennett, standard P/T) subtracted at coordinate level relative to the field centre — APPROXIMATE; a PRODUCT, never fed back into the solve/confirm.');
    } else {
        refraction.notApplied = !clockReal
            ? 'Timestamp untrusted / DEFAULT — refraction gated OFF (bogus clock ⇒ bogus geometry).'
            : 'GPS DEFAULT/absent — no site claim, refraction gated OFF.';
    }

    // ── (c) SNR-honest weighting (bounded PSF-amplitude proxy) ──
    const usableAmps = refined.map(r => r.amp).filter((a): a is number => a != null);
    const medAmp = median(usableAmps);
    const useWeights = usableAmps.length >= Math.ceil(matched.length / 2) && medAmp != null && medAmp > 0;
    const weighting: FinalAstrometryReport['weighting'] = useWeights
        ? { method: 'PSF_AMPLITUDE', note: `Inverse-variance-style weighting by PSF amplitude (constant-noise SNR proxy), clamped to [${WEIGHT_MIN}, ${WEIGHT_MAX}]×median. APPROXIMATE.` }
        : { method: 'UNIFORM', note: 'Too few PSF amplitudes for a weighted fit — ordinary least squares (uniform weights).' };
    if (useWeights) approximate.push('SNR-honest weighting proxied by PSF-fit amplitude (constant frame-noise assumption); bounded dynamic range.');

    // ── build residual data points (mirror ResidualAnalyzer.analyze exactly) ──
    const points: { u: number; v: number; dx: number; dy: number }[] = [];
    const weights: number[] = [];
    let ssLin = 0, ssWLin = 0, wSum = 0;
    for (const r of refined) {
        const lp = ResidualAnalyzer.skyToLinearPixel(r.ra, r.dec, wcs);
        const dx = r.x - lp.x, dy = r.y - lp.y;
        const u = r.x - crpix[0], v = r.y - crpix[1];
        points.push({ u, v, dx, dy });
        const w = useWeights && r.amp != null
            ? Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, r.amp / medAmp!))
            : 1;
        weights.push(w);
        const rLinArc = Math.hypot(dx, dy) * pixelScale;
        ssLin += rLinArc * rLinArc;
        ssWLin += w * rLinArc * rLinArc; wSum += w;
    }
    const linearArcsec = points.length ? Math.sqrt(ssLin / points.length) : null;
    const weightedLinearArcsec = wSum > 0 ? Math.sqrt(ssWLin / wSum) : null;

    // ── refit SIP (weighted; the SAME fitter — LAW 4) ──
    const sip = ResidualAnalyzer.fitSip(points, sipOrder, useWeights ? weights : undefined);

    // ── refined residual (linear + refined SIP) on the same points ──
    let ssRef = 0, ssWRef = 0;
    for (let n = 0; n < refined.length; n++) {
        const r = refined[n];
        const lp = ResidualAnalyzer.skyToLinearPixel(r.ra, r.dec, wcs);
        const rArc = postSipResidualPx(
            r.x, r.y, lp.x, lp.y,
            sip ? { a: sip.a, b: sip.b } : null, crpix,
        ) * pixelScale;
        ssRef += rArc * rArc;
        ssWRef += weights[n] * rArc * rArc;
    }
    const refinedArcsec = refined.length ? Math.sqrt(ssRef / refined.length) : null;
    const weightedRefinedArcsec = wSum > 0 ? Math.sqrt(ssWRef / wSum) : null;

    // Solve's own mean residual (informational context — a different basis: raw
    // centroids + solve SIP; NOT the improvement comparison, which is like-for-like
    // refined-centroid linear vs refined below).
    const solveMean = matched.reduce((s, m) => s + m.residual_arcsec, 0) / matched.length;

    const improved = linearArcsec != null && refinedArcsec != null
        && refinedArcsec <= linearArcsec + 1e-9;

    return {
        ledger: 'COORDINATE',
        provenance: 'REFINED_FINAL_ASTROMETRY',
        grid: psf.grid ?? null,
        nStars: matched.length,
        nPsfCentroids: nPsf,
        psfCentroidSource,
        sipOrder,
        sip,
        wcs: {
            crpix: [wcs.crpix[0], wcs.crpix[1]],
            crval: [wcs.crval[0], wcs.crval[1]],
            cd: [[cd[0][0], cd[0][1]], [cd[1][0], cd[1][1]]],
        },
        rms: {
            linearArcsec: linearArcsec != null ? +linearArcsec.toFixed(5) : null,
            refinedArcsec: refinedArcsec != null ? +refinedArcsec.toFixed(5) : null,
            weightedLinearArcsec: weightedLinearArcsec != null ? +weightedLinearArcsec.toFixed(5) : null,
            weightedRefinedArcsec: weightedRefinedArcsec != null ? +weightedRefinedArcsec.toFixed(5) : null,
            solveMeanResidualArcsec: Number.isFinite(solveMean) ? +solveMean.toFixed(5) : null,
        },
        improved,
        weighting,
        refraction,
        approximate,
    };
}

// ─── receipt serializer (mirrors serializePsfFieldBlock) ──────────────────────

/**
 * Compact, JSON-ready `final_astrometry` block for the receipt. Additive,
 * honest-or-null; every number finite-or-null. save_packet replacer-safe (plain
 * arrays/scalars). NEVER re-keys existing blocks.
 */
export function serializeFinalAstrometryBlock(r: FinalAstrometryReport): Record<string, any> {
    return {
        ledger: r.ledger,
        provenance: r.provenance,
        grid: r.grid,
        n_stars: r.nStars,
        n_psf_centroids: r.nPsfCentroids,
        psf_centroid_source: r.psfCentroidSource,
        sip_order: r.sipOrder,
        // Refined SIP (engine-internal convention; FITS export negates at boundary).
        sip: r.sip ? { a_order: r.sip.a_order, b_order: r.sip.b_order, a: r.sip.a, b: r.sip.b } : null,
        wcs: r.wcs,
        rms: r.rms,
        improved: r.improved,
        weighting: r.weighting,
        refraction: r.refraction,
        approximate: r.approximate,
        not_measured: r.notMeasured ?? null,
    };
}
