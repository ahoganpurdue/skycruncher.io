import { StarCatalogAdapter } from './star_catalog_adapter';
import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import { isRawlerDecoderEnabled } from '../m1_ingestion/rawler_decoder';
import { PlanetaryAnchor } from './planetary_adapter';
import { PlateSolution, MatchedStar, WCSTransform, DetectedStar, SolveResult, SolveDiagnostics, CatalogStar, HardwareProfile } from '../../types/Main_types';
import { TelemetryLogger } from '../../diagnostics/telemetry_logger';
import { TimeService } from '../../core/TimeService';
import { DynamicPipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../../diagnostics/telemetry_config';
import { SourceExtractor } from '../m4_signal_detect/source_extractor';
import { SolarSystem } from './solar_system';
import { ScaleMetadata } from '../../types/schema';
import { ScaleManager } from '../m2_hardware/scale_manager';
import { OpticsManager } from '../../core/optics_manager';
import { SkyTransform } from '../../core/SkyTransform';
import { UnitConverter } from '../../core/UnitConverter';
import { CELESTIAL_DB } from '../../core/celestial_data';
import { SolverStrategy, getSolverChain, OPTICAL_BUCKETS, getOpticalBucket } from './solver_strategies';
import { verifyPlanetaryDesignation } from './planetary_verification';

/**
 * PLATE SOLVER â€” Geometric Star-Pattern Matcher
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * WHAT IT DOES:
 * Given a photograph of the sky, determine EXACTLY what part of the
 * celestial sphere you are looking at. Returns the RA/Dec of the image
 * center, the rotation angle, and the pixel scale.
 *
 * HOW IT WORKS (Quad-Hash Algorithm):
 * 1. EXTRACT point sources from the image (SExtractor-like)
 * 2. Form geometric "quads" from the 4 brightest stars in each region
 * 3. Hash the quad geometry into a rotation/scale-invariant descriptor
 * 4. Match the descriptor against a pre-built index of known star quads
 * 5. With 2+ quad matches, compute the full affine WCS transformation
 * 6. Verify by checking if ALL detected stars land on known catalog stars
 *
 * reference:
 * Based on the algorithm described in:
 * Lang et al. (2010) "Astrometry.net: Blind Astrometric Calibration"
 * The Astronomical Journal, 139, 1782-1800.
 *
 * performance:
 * Pure TypeScript implementation - no WASM dependency.
 * Solves typical wide-field images (10-50 stars) in <500ms.
 * For dense fields (>200 stars), the quad search is bounded to the
 * brightest 80 sources to keep solve time under 2s.
 */

import { buildSpatialHash } from '../../types/schema';
import { STANDARD_STARS, findStarsInField } from './standard_stars';
import type { StandardStar } from './standard_stars';
import { runUwTightReverify, shouldAttemptTightReverify, type UwTightReverifyResult } from './uw_tight_reverify';
import { runUwTightReverifyDeep } from './uw_deep_evidence';
import { BRIGHT_STAR_ANCHORS } from './bright_star_anchors';
import {
    buildFineCenters, orientationDominance,
    type AnchorCenter,
} from './fine_center_lever';
import {
    orderCentersBySearchPriors,
    type SearchPriorModel,
} from './search_priors';
import {
    deepVerifyEscalation, luminanceFromImageData,
    projectCatalogToPixels, sampledBackgroundSigma,
    computeFrameFwhmPx, runForcedPhotometry,
} from './deep_verify';
import { confirmForcedSet, type FramePsfRef } from './forced_confirm';
import {
    makeBrownConradyDistortion, resolveLensDistortion,
    type LensDistortionModel, type LensDistortionResolution, type LensDistortionHint,
} from '../m2_hardware/lens_distortion';
// F2 (row 547): the in-engine SIP evaluation authority — probe projection
// composes it exactly as the rematch pass does (never re-derived; M7 history).
import { evalSipPoly } from '../m2_hardware/lens_distortion_rematch';

// ─── VERIFY NET RAIL (shared single source) ─────────────────────────────────
/**
 * Ultra-wide verify/sweep matching net constants — the SINGLE SOURCE for the
 * radius-scaled positional tolerance `tol(r) = max(baseNet, SLOPE · r)` used by
 * BOTH the UW anchored sweep (candidate scoring, this file) and verifyWCS's
 * ultra-wide TS matcher (this file). `WIDE_NET_SLOPE` was measured 0.035 by the
 * rotation brute-forcer that identified the Teapot stars (see the verifyWCS
 * "ULTRA-WIDE TS VERIFY" note).
 *
 * EXPORTED (owner-queue ④) so the headless incubator (tools/solverkit) can reuse
 * the EXACT app net rail rather than hand-copying the literal. Frozen; the value
 * is byte-identical to the prior inline literals it replaces — a pure
 * single-sourcing, zero behavior change (gated by the CR2 sacred solve).
 */
export const VERIFY_NET = Object.freeze({
    WIDE_NET_SLOPE: 0.035,
});

// â”€â”€â”€ TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Quads now imported from AstrometryEngine

export interface SolveContext {
    basePixelScale: number;
    scales?: ScaleMetadata;
    lensModel?: string;
    focalLength?: number;
    timestamp?: string;
    hints?: {
        ra_hours?: number;
        dec_degrees?: number;
        radius_deg?: number;
        /**
         * True ONLY for a TRUSTED pointing source (FITS-header GOTO / explicit
         * config) — never a zenith/azimuth GUESS. Arms the A2 hint-seeded fine
         * center grid (ultra-wide only). Absent/false ⇒ historical behavior.
         */
        trusted?: boolean;
    };
    logger?: TelemetryLogger;
    loggerCallback?: (msg: string) => void;
    config?: DynamicPipelineConfig;
    hardwareProfile?: HardwareProfile;
    /**
     * Explicit user lens hint for manual glass (NEXT_MOVES §8). Supplies a
     * distortion prior when the EXIF LensModel is a placeholder/lying (e.g. the
     * 14mm Rokinon gauntlet frames whose EXIF says 50mm / no lens). Absent by
     * default — the EXIF LensModel ladder decides otherwise.
     */
    lensDistortionHint?: LensDistortionHint | null;
    /**
     * Pre-RESOLVED lens-distortion prior injected by the caller (Optical-Workbench
     * pooled prior — SOLVER_WORKBENCH_PRIOR, default OFF). When present it takes
     * precedence over the EXIF/hint `resolveLensDistortion` ladder and seeds the
     * solve through the EXACT same `options.lensDistortionPrior` path a LENS_DB
     * nominal would (see autoSolvePlate). Absent/undefined ⇒ byte-identical to the
     * historical resolver-only behavior. Never fabricated: the session only sets it
     * from ≥3 agreeing same-rig deposits (provenance 'WORKBENCH_POOLED').
     */
    lensDistortionResolution?: LensDistortionResolution | null;
    /** Observer site — required for spherical_global's visibility gating. */
    observer?: { lat: number; lon: number };
    /** Sensor pixel pitch (µm) — spherical chord scaling; wizard sends it. */
    pixelPitchUm?: number;
    /** Wall-clock cap for many-center blind sweeps (default 90s). */
    blindBudgetMs?: number;
    /** Per-center narration for blind sweeps (Glass Pipeline socket). */
    onBlindProgress?: (centersTried: number, centersTotal: number, raHours: number, decDeg: number) => void;
    /**
     * SEARCH-ORDER PRIORS model (task #20 — lane ① search priors ONLY). A banked-
     * receipt-derived model handed down from the single orchestrator; forwarded
     * verbatim to SolverOptions.searchPriors below. Consumed only when
     * PC.SOLVER_SEARCH_PRIORS is ON, where it REORDERS the blind sweep (a stable
     * permutation — never prunes, never touches verify/thresholds/the math gate;
     * see search_priors.ts). Absent/null ⇒ identity (full sweep, byte-identical).
     */
    searchPriors?: SearchPriorModel | null;
}
const PC = PIPELINE_CONSTANTS;

/**
 * A3 per-branch timing accrual (flowchart honesty). Pure diagnostics write:
 * sums an ALREADY-MEASURED wall-ms sample for a solve branch (keyed by the
 * flowchart stage id) into `diagnostics.branch_timing`, bumping the attempt
 * count. Nothing in the solve reads branch_timing, so this is observation-only
 * (both pinned solves stay byte-identical). A branch never accrued stays ABSENT
 * (honest NOT MEASURED), never a fake 0ms. Fully non-fatal.
 */
function accrueBranchTiming(
    diagnostics: SolveDiagnostics | undefined,
    branchId: string,
    ms: number,
): void {
    try {
        if (!diagnostics) return;
        if (!diagnostics.branch_timing) diagnostics.branch_timing = {};
        const bt = diagnostics.branch_timing;
        let e = bt[branchId];
        if (!e) { e = { ms: 0, attempts: 0 }; bt[branchId] = e; }
        if (Number.isFinite(ms)) e.ms += ms;
        e.attempts += 1;
    } catch {
        // Instrumentation must never break the solve.
    }
}

// â”€â”€â”€ DISTORTION MODEL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Centralized in OpticsManager.ts. Default profile can be fetched via OpticsManager if needed.

// â”€â”€â”€ STAR EXTRACTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Logic moved to SourceExtractor.ts in the core directory.

// â”€â”€â”€ MAIN SOLVER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


/**
 * Solve the plate â€” identify the sky coordinates for an image.
 * Returns a SolveResult containing the solution and forensic diagnostics.
 */
export async function solvePlate(
    imageData: ImageData,
    pixelScale: number,
    hints?: { ra_hours?: number; dec_degrees?: number; radius_deg?: number; trusted?: boolean },
    timestamp?: string,
    options: SolverOptions = {}
): Promise<SolveResult> {
    const startTime = performance.now();
    const diagnostics: SolveDiagnostics = {
        solve_time_ms: 0,
        quads_detected: 0,
        quads_catalog: 0,
        matches_found: 0,
        verified_clusters: 0,
        peak_background_ratio: 0,
        rejection_reasons: [],
        forensics: [], // [NEW] Track candidate detail
        // A3: per-branch wall-ms accumulator (quad/wasm · UW sweep · UW escalation).
        // Filled by accrueBranchTiming from already-measured timings; read only by
        // the flowchart branch emitter. Empty ⇒ no branch attempted yet.
        branch_timing: {}
    };
    // Ensure catalog is loaded (Level 1 & 2)
    if (options.logger) {
        options.logger.logStage('solver', 'RUNNING');
    }

    await StarCatalogAdapter.getinstance().loadCatalog();

    // Use scale lock if provided
    const targetScale = options.scaleLock ?? pixelScale;
    const maxvariance = options.scaleLock ? PC.SOLVER_LOCKED_SCALE_variance : PC.SOLVER_MAX_SCALE_variance;

    // Sanity Check: Dead Frame Detection
    if (imageData.width < 50 || imageData.height < 50) {
        diagnostics.rejection_reasons.push('Dead Frame: Dimensions too small');
        return { success: false, diagnostics };
    }

    const threshold = options.detectionThreshold ?? PC.SOLVER_DEFAULT_SIGMA;

    // Step 0: Calculate Focus Regions from Planets if hints available
    let focusRegions: { x: number; y: number; radius: number }[] | undefined;
    if (options.focusPlanets && hints && hints.ra_hours !== undefined && hints.dec_degrees !== undefined) {
        focusRegions = [];
        const ra0 = hints.ra_hours;
        const dec0 = hints.dec_degrees;
        const cx = imageData.width / 2;
        const cy = imageData.height / 2;

        for (const p of options.focusPlanets) {
            const { xi, eta } = SkyTransform.gnomonicProject(p.ra_hours, p.dec_degrees, ra0, dec0);
            // xi/eta are in degrees. scale is arcsec/px.
            const xi_px = UnitConverter.degToArcsec(xi) / targetScale;
            const eta_px = UnitConverter.degToArcsec(eta) / targetScale;

            // Projection: North Up (Angle 0).
            // xi increases Left (Standard Astronomy). X increases right. -> x = cx - xi
            // eta increases Up. Y increases Down. -> y = cy - eta

            const x = cx - xi_px;
            const y = cy - eta_px;

            // Add if roughly in frame (with margin)
            if (x > -PC.SOLVER_FOCUS_REGION_MARGIN_PX && x < imageData.width + PC.SOLVER_FOCUS_REGION_MARGIN_PX && y > -PC.SOLVER_FOCUS_REGION_MARGIN_PX && y < imageData.height + PC.SOLVER_FOCUS_REGION_MARGIN_PX) {
                 focusRegions.push({ x, y, radius: Math.max(PC.SOLVER_FOCUS_REGION_MIN_RADIUS_PX, UnitConverter.degToArcsec(2) / targetScale) });
            }
        }
        if (focusRegions && focusRegions.length > 0) {
            console.log(`[PlateSolver] Using ${focusRegions.length} Planetary Focus Regions from hints.`);
        }
    }

    // 1. Extract Stars
    let rawExtraction: any = undefined;
    if (!options.detectedStars) {
        rawExtraction = await SourceExtractor.extractStars(
            imageData,
            options.detectionThreshold || PC.SOLVER_DEFAULT_SIGMA,
            undefined, // horizonVector
            undefined, // segmentationMasks
            {
                focusRegions: focusRegions as any,
                logger: options.logger,
                focalLengthMm: options.focalLengthMm
            }
        );
    }
    const rawObj = options.detectedStars || rawExtraction?.stars || [];
    const detected: DetectedStar[] = Array.isArray(rawObj) ? rawObj : (rawObj as any).stars;
    console.log(`[PlateSolver] Using ${detected.length} detected stars (${options.detectedStars ? 'caller-provided' : 'extracted'}).`);

    if (detected.length < PC.SOLVER_MIN_MATCHES) {
        diagnostics.rejection_reasons.push(`Insufficient Stars: ${detected.length} detected, need ${PC.SOLVER_MIN_MATCHES}`);
        return { success: false, diagnostics };
    }

    // ─── LENS-PRIOR DISTORTION (NEXT_MOVES §8) ───────────────────────────────
    // For a CONFIDENTLY-resolved lens, pre-un-distort the MATCHING detection
    // coordinates (COORDINATE ledger) so a barrel/"mustache" frame's asterism
    // code lines up with the rectilinear catalog projection BEFORE quad/code
    // formation and the anchored sweep. The ORIGINAL native pixel coords are
    // kept for photometry (deep-verify/harvest sample native pixels). When no
    // prior resolves (options.lensDistortionPrior null — e.g. the bundled CR2's
    // 'Unknown Lens' / lying-50mm EXIF), this is a NO-OP and the whole path is
    // byte-identical by construction.
    let lensDistModel: LensDistortionModel | null = null;
    let lensMatchCoords: WeakMap<DetectedStar, { x: number; y: number }> | null = null;
    const lensPrior = options.lensDistortionPrior ?? null;
    if (lensPrior && (lensPrior.k1 !== 0 || lensPrior.k2 !== 0)) {
        lensDistModel = makeBrownConradyDistortion(lensPrior.k1, lensPrior.k2, imageData.width, imageData.height);
        lensMatchCoords = new WeakMap();
        const u: [number, number] = [0, 0];
        for (const d of detected) {
            if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
            lensDistModel.toCorrected(d.x, d.y, u);
            lensMatchCoords.set(d, { x: u[0], y: u[1] });
        }
        console.log(`[PlateSolver] [LENS-PRIOR] ACTIVE: ${lensPrior.lensModel} (${lensPrior.provenance}, k1=${lensPrior.k1}, k2=${lensPrior.k2}, f=${lensPrior.focalLength}mm) — un-distorting MATCHING coords for ${detected.length} detections (photometry keeps native).`);
    } else {
        console.log('[PlateSolver] [LENS-PRIOR] NONE (no resolvable lens) — matching coords are native; byte-identical path.');
    }

    // Step 2: Compute approximate FOV from image dimensions and pixel scale
    const fovW = (imageData.width * targetScale) / 3600;  // degrees
    const fovH = (imageData.height * targetScale) / 3600;
    const searchRadius = Math.max(fovW, fovH) * 1.5;

    // Step 2: Ephemeris Handshake â€” Delegated to EphemerisEngine via SolarSystem
    // [FIX #4] No longer uses PlanetaryAdapter directly.
    let planets: PlanetaryAnchor[] = [];
    // SUN-VETO RETIRED (owner-ruled 2026-07-10: "if we match the stars with
    // confidence, we don't need to check if the sun is up. We can kill it.").
    // The ephemeris-derived sunPosition that was seeded here (and threaded into
    // trySolveAtCenter for the ultra-wide sun-proximity veto) is gone: the A5
    // evidence showed forced-photometry confirmation is the load-bearing
    // false-positive catcher, making the veto a redundant layer. History +
    // original spec: docs/NEXT_MOVES.md §6 (sun-veto case study). The pure
    // helper isSunVetoed (fine_center_lever.ts) is RETAINED with its unit
    // tests as a documented, unwired function.
    if (options.timestamp) {
        try {
            const observer = options.observer ?? { lat: 0, lon: 0 };
            const bodies = SolarSystem.getVisibleBodies(new Date(options.timestamp), observer.lat, observer.lon);
            // Horizon-filter anchors only when the observer site is real;
            // at the (0,0) fallback the altitudes are fiction.
            planets = SolarSystem.toAnchors(bodies, !!options.observer);
            console.log(`[PlateSolver] [EPHEMERIS] Injected ${planets.length} planetary anchors for ${options.timestamp}`);
        } catch (e) {
            console.warn('[PlateSolver] Failed to load planetary anchors:', e);
        }
    }

    // Step 2c: Planetary Lock (Pure Function â€” no mutation of detected[])
    // [FIX #3] Uses a Set<number> to track planet indices instead of mutating input.
    const planetaryStarIds = new Set<number>();
    const planetaryLabels = new Map<number, string>();

    if (hints && hints.ra_hours !== undefined && hints.dec_degrees !== undefined && planets.length > 0) {
        const ra0 = hints.ra_hours;
        const dec0 = hints.dec_degrees;
        const pxPerDeg = 3600 / targetScale;
        const cx = imageData.width / 2;
        const cy = imageData.height / 2;

        for (const p of planets) {
             const proj = SkyTransform.gnomonicProject(p.ra_hours, p.dec_degrees, ra0, dec0);
             const x = cx - proj.xi * pxPerDeg;
             const y = cy - proj.eta * pxPerDeg;
             
             // Check if in bounds
             if (x >= -PC.SOLVER_PLANET_LOCK_RADIUS_PX && x < imageData.width + PC.SOLVER_PLANET_LOCK_RADIUS_PX && y >= -PC.SOLVER_PLANET_LOCK_RADIUS_PX && y < imageData.height + PC.SOLVER_PLANET_LOCK_RADIUS_PX) {
                 // Find nearest detected star index
                 let nearestIdx = -1;
                 let minD = 9999;
                 for (let si = 0; si < detected.length; si++) {
                     const d = Math.sqrt((detected[si].x - x)**2 + (detected[si].y - y)**2);
                     if (d < minD) { minD = d; nearestIdx = si; }
                 }
                 
                 if (nearestIdx >= 0 && minD < PC.SOLVER_PLANET_LOCK_RADIUS_PX) {
                     planetaryStarIds.add(nearestIdx);
                     planetaryLabels.set(nearestIdx, p.name);
                 }
             }
        }
    }

    // Step 3: Determine search centers
    const searchCenters: { ra: number; dec: number; name?: string; lever?: boolean }[] = [];

    // Prioritize Planetary Hint if explicitly passed
    if (hints?.ra_hours !== undefined && hints?.dec_degrees !== undefined) {
        // 1. Always check the exact hint first
        searchCenters.push({ ra: hints.ra_hours, dec: hints.dec_degrees, name: 'Hint Center' });

        // 2. REGIONAL EXPANSION:
        // If the lens is wide (scale > 10"/px), the hint might be visible but off-center.
        // We typically capture 80-100 deg field. The center could be 40 deg away.
        // We should add all BRIGHT standard stars within the hint radius.
        const regionRadius = hints.radius_deg ?? searchRadius;

        // Ensure catalog is loaded for this region — gated by the sector-load
        // cap (B4): future wide-radius hint rungs (zenith 90 deg / azimuth
        // 30 deg) must not page in the full 338 MB deep atlas. Above the cap
        // the solve proceeds on the already-loaded L1/L2 anchor levels only.
        if (regionRadius <= PC.SECTOR_LOAD_MAX_RADIUS_DEG) {
            await StarCatalogAdapter.getinstance().ensureSectorLoaded(hints.ra_hours, hints.dec_degrees, regionRadius);
        } else {
            console.log(`[PlateSolver] Hint radius ${regionRadius} deg exceeds sector-load cap (${PC.SECTOR_LOAD_MAX_RADIUS_DEG}) - deep catalog skipped (L1/L2 only).`);
        }
        
        const regionalCandidates = StarCatalogAdapter.getinstance().getStars().filter(s => {
             // distance Check (Approx)
             const raDist = Math.abs(s.ra_hours - (hints.ra_hours || 0)) * 15;
             const decDist = Math.abs(s.dec_degrees - (hints.dec_degrees || 0));
             return (Math.sqrt(raDist*raDist + decDist*decDist) < regionRadius) && (s.magnitude_V < PC.SOLVER_BRIGHT_STAR_MAG_LIMIT);
        });
        
        console.log(`[PlateSolver] Regional Hint: Added ${regionalCandidates.length} bright stars around hint.`);
        regionalCandidates.forEach(s => searchCenters.push({ ra: s.ra_hours, dec: s.dec_degrees, name: s.name }));

        // ═══ A2: HINT-SEEDED FINE CENTERS (ultra-wide + TRUSTED hint only) ════
        // The ultra-wide anchored sweep PINS translation, so it only fires
        // within ~0.5° of the true center. A TRUSTED pointing (FITS GOTO /
        // explicit config — NOT a zenith/azimuth guess) is a strong center
        // prior: lay the same fine grid the anchor lever uses (±FINE_HALF_DEG @
        // FINE_STEP_DEG) AROUND THE HINT and try it FIRST, so forced-photometry
        // escalation on the resulting sub-threshold peak has a well-centered
        // candidate. Rotation still comes entirely from the sweep; NO gate is
        // changed (the sweep 4.5σ direct gate + the escalation excess gate are
        // untouched) — this only widens/tightens the center list.
        //
        // FIREWALL: gated on fovDiag > SOLVER_WIDE_PATCH_MIN_FOV_DEG (the SAME
        // ultra-wide gate as patchActive + the anchor fine-lever). SeeStar
        // (~1.3° diag) is FOV-gated OUT → byte-identical, and its trust does NOT
        // protect it (FOV does). CR2 solves BLIND (no hint → this whole branch
        // is skipped). So A2 arms ONLY for a future ultra-wide + trusted-hint
        // frame; both sacred solves are byte-identical by construction.
        const fovDiagDegHint = (targetScale && targetScale > 0)
            ? Math.hypot(imageData.width, imageData.height) * targetScale / 3600
            : 0;
        if (hints.trusted && fovDiagDegHint > PC.SOLVER_WIDE_PATCH_MIN_FOV_DEG) {
            const fineHint = buildFineCenters(
                [{ ra: hints.ra_hours, dec: hints.dec_degrees, name: 'TrustedHint', priority: -1 }],
                PC.SOLVER_UW_FINE_HALF_DEG,
                PC.SOLVER_UW_FINE_STEP_DEG,
                PC.SOLVER_UW_FINE_MAX_CENTERS,
                PC.SOLVER_UW_FINE_ANCHOR_DEDUP_DEG,
            );
            if (fineHint.length) {
                // Prepend (lever:true) so the trusted-hint neighborhood is swept
                // FIRST; winner-dominance still applies to these lever centers.
                searchCenters.unshift(...fineHint.map(f => ({ ra: f.ra, dec: f.dec, name: f.name, lever: true })));
                console.log(`[PlateSolver] [A2 HINT-FINE] Ultra-wide (${fovDiagDegHint.toFixed(0)}° diag) + TRUSTED hint: prepended ${fineHint.length} fine centers (±${PC.SOLVER_UW_FINE_HALF_DEG}° @ ${PC.SOLVER_UW_FINE_STEP_DEG}°) around the hint for the anchored sweep + forced-photometry escalation.`);
            }
        }
        // ═══ end A2 ════════════════════════════════════════════════════════════

    } else {
        // Without hints: search around dynamic catalog anchors (Level 1)
        // Use the loaded catalog (which we ensured is loaded above)
        // Filter for bright stars (approx Mag < 3.5) to keep search time reasonable (~100-200 stars)
        const candidates = StarCatalogAdapter.getinstance().getStars().filter(s => s.magnitude_V < PC.SOLVER_BRIGHT_STAR_MAG_LIMIT);
        
        // Fallback to hardcoded list if catalog is empty (e.g. load failed)
        const starSource = candidates.length > 0 ? candidates : STANDARD_STARS;
        
        // Merge stars and planets for search centers
        // SEARCH CENTER POLLUTION FIX: Only use planets that are actually
        // ABOVE the horizon — but only when we KNOW the horizon. Without an
        // observer the altitudes were computed at a fictional (0,0), which
        // altitude-gated Jupiter out of the beach-frame sweep while it was
        // the brightest object in the image. Planet RA/Dec stay valid
        // regardless of site (parallax is negligible beyond the Moon).
        const visiblePlanets = options.observer
            ? planets.filter(p => (p as any).altitude === undefined || (p as any).altitude > 0)
            : planets;
        // Planets FIRST: D5 pruning keeps earliest entries, and a mag -2.6
        // planet is a better anchor than any star near it.
        const sourceList = [...visiblePlanets, ...starSource];

        for (const s of sourceList) {
            if (s.name === 'Sol') continue; // Skip the Sun
            searchCenters.push({ ra: s.ra_hours, dec: s.dec_degrees, name: s.name });
        }

        // D5 CENTER PRUNING (perf notes): when the scale prior gives us the
        // FOV, adjacent hypotheses inside ~quarter-FOV of each other test the
        // same sky — a 91-deg ultra-wide frame needs ~30 well-spaced centers,
        // not 169. Thin greedily (list is brightest-first, so survivors are
        // the best anchors). No-op for narrow FOV (minSep floors at 2 deg,
        // matching the natural bright-star spacing).
        const fovDiagDegPrior = (targetScale && targetScale > 0)
            ? Math.hypot(imageData.width, imageData.height) * targetScale / 3600
            : 0;
        // PATCH COUPLING: when ultra-wide patch matching is active (see
        // trySolveAtCenter), each hypothesis only examines a patch-radius
        // disk — centers spaced wider than that leave coverage holes where
        // the true center overlaps NO hypothesis patch. Cap separation at
        // the patch radius; below the patch threshold quarter-FOV stands.
        const patchSepCap = fovDiagDegPrior > PC.SOLVER_WIDE_PATCH_MIN_FOV_DEG
            ? PC.SOLVER_WIDE_PATCH_RADIUS_DEG
            : Infinity;
        const minSepDeg = Math.max(2, Math.min(fovDiagDegPrior / 4, patchSepCap));
        if (fovDiagDegPrior > 10 && searchCenters.length > 20) {
            const thinned: typeof searchCenters = [];
            for (const c of searchCenters) {
                const clash = thinned.some(t => {
                    const dra = Math.abs(t.ra - c.ra) * 15 * Math.cos((c.dec * Math.PI) / 180);
                    const ddec = Math.abs(t.dec - c.dec);
                    return Math.hypot(dra, ddec) < minSepDeg;
                });
                if (!clash) thinned.push(c);
            }
            console.log(`[PlateSolver] D5 pruning: ${searchCenters.length} -> ${thinned.length} centers (min separation ${minSepDeg.toFixed(1)} deg for ${fovDiagDegPrior.toFixed(0)} deg FOV).`);
            searchCenters.length = 0;
            searchCenters.push(...thinned);
        }
    }

    // External priors lead the sweep and survive pruning (see SolverOptions).
    if (options.extraSearchCenters?.length) {
        searchCenters.unshift(...options.extraSearchCenters.map(c => ({
            ra: c.ra, dec: c.dec, name: c.name ?? 'PRIOR',
        })));
        console.log(`[PlateSolver] Injected ${options.extraSearchCenters.length} external search-center prior(s) at the front of the sweep.`);
    }

    // ═══ FINE-CENTER LEVER (ultra-wide bright-anchor refinement) ══════════════
    // The anchored sweep pins translation, so it only fires within ~0.5° of the
    // true anchor and the D5-pruned/single-ephemeris blind list routinely misses
    // by more. Around each bright anchor — planets (real ephemeris) + injected
    // priors + the bundled classic bright-star list (Gaia saturates at mag_g
    // 1.94) — lay a fine local grid.
    //
    // PLACEMENT (THESIS-002): on the DEFAULT/libraw arm these fine centers are
    // APPENDED (a fallback) — the coarse sweep runs unmolested first, so a frame
    // that already solves coarsely (the bundled CR2 locks on a catalog anchor) is
    // byte-identical and never pays the fine-grid cost. On the RAWLER arm (or
    // explicit SOLVER_UW_FINE_PROMOTE) they are PREPENDED: rawler's detection
    // density makes the coarse sweep budget-die at ~67/530 centers before any
    // appended center is reached (divergence diagnosis 2026-07-10), while the
    // fine centers are the ones that verifiably lock (+5.7σ). Ultra-wide ONLY:
    // narrow fields (SeeStar) skip this entirely. Lever centers carry lever:true
    // so the sweep applies winner-dominance to them; nothing here changes any gate.
    const fovDiagDegLever = (targetScale && targetScale > 0)
        ? Math.hypot(imageData.width, imageData.height) * targetScale / 3600
        : 0;
    if (fovDiagDegLever > PC.SOLVER_WIDE_PATCH_MIN_FOV_DEG) {
        const anchors: AnchorCenter[] = [];
        // Planets first, BRIGHTEST first (a mag −2.6 Jupiter is a better landscape
        // anchor than a mag +1 Mars, and leads the fine budget).
        [...planets]
            .filter(p => p.name !== 'Sol')
            .sort((a, b) => (a.magnitude_V ?? 99) - (b.magnitude_V ?? 99))
            .forEach(p => anchors.push({ ra: p.ra_hours, dec: p.dec_degrees, name: p.name, priority: 0 }));
        // Injected priors next (harness planet dumps / user targets arrive here).
        for (const c of options.extraSearchCenters ?? []) {
            anchors.push({ ra: c.ra, dec: c.dec, name: c.name ?? 'PRIOR', priority: 1 });
        }
        // Bundled classic bright stars (absent from Gaia at the bright end),
        // brightness-ordered, after the planets/priors.
        BRIGHT_STAR_ANCHORS.forEach((s, i) =>
            anchors.push({ ra: s.ra_hours, dec: s.dec_degrees, name: s.name, priority: 2 + i / 1000 }));

        const fine = buildFineCenters(
            anchors,
            PC.SOLVER_UW_FINE_HALF_DEG,
            PC.SOLVER_UW_FINE_STEP_DEG,
            PC.SOLVER_UW_FINE_MAX_CENTERS,
            PC.SOLVER_UW_FINE_ANCHOR_DEDUP_DEG,
        );
        if (fine.length) {
            const fineCenters = fine.map(f => ({ ra: f.ra, dec: f.dec, name: f.name, lever: true }));
            const promoteFine = PC.SOLVER_UW_FINE_PROMOTE || isRawlerDecoderEnabled();
            if (promoteFine) {
                searchCenters.unshift(...fineCenters);
                console.log(`[PlateSolver] [FINE-CENTERS] Ultra-wide (${fovDiagDegLever.toFixed(0)}° diag): PROMOTED ${fine.length} fine centers (±${PC.SOLVER_UW_FINE_HALF_DEG}° @ ${PC.SOLVER_UW_FINE_STEP_DEG}°) around ${new Set(fine.map(f => f.name)).size} bright anchors, ahead of the coarse sweep (THESIS-002 rawler reach).`);
            } else {
                searchCenters.push(...fineCenters);
                console.log(`[PlateSolver] [FINE-CENTERS] Ultra-wide (${fovDiagDegLever.toFixed(0)}° diag): appended ${fine.length} fine fallback centers (±${PC.SOLVER_UW_FINE_HALF_DEG}° @ ${PC.SOLVER_UW_FINE_STEP_DEG}°) around ${new Set(fine.map(f => f.name)).size} bright anchors, after the coarse sweep.`);
            }
        }
    }
    // ═══ end FINE-CENTER LEVER ════════════════════════════════════════════════

    // ═══ SEARCH-ORDER PRIORS (task #20 — lane ① search priors ONLY) — EXPERIMENTAL ══
    // Reorder the FINAL sweep list so centers nearest banked-receipt priors are
    // visited first (~95% of solve wall-time is this sweep; the pinned UW solves
    // lock at the LAST anchor — front-loading a likely center is pure wall-time
    // recovery). REORDER ONLY: a stable permutation, nothing pruned, the search
    // SPACE is unchanged, and NO gate/threshold/verify step is touched. Gated by
    // PC.SOLVER_SEARCH_PRIORS (env/config, default OFF) — flag OFF ⇒ this block is
    // skipped entirely ⇒ bit-identical (both pinned e2e byte-identical). Prior-miss
    // (absent/empty/unmatched model) ⇒ identity → the full sweep runs unchanged.
    if (PC.SOLVER_SEARCH_PRIORS && options.searchPriors && options.searchPriors.regions?.length) {
        const prior = orderCentersBySearchPriors(searchCenters, options.searchPriors);
        if (prior.engaged && prior.moved > 0) {
            searchCenters.length = 0;
            searchCenters.push(...prior.ordered);
            const src = options.searchPriors.source ?? 'banked-receipts';
            const lead = prior.leaderLabel ? ` (leader: ${prior.leaderLabel})` : '';
            console.log(`[PlateSolver] [SEARCH-PRIORS] EXPERIMENTAL: reordered ${searchCenters.length} centers by ${options.searchPriors.regions.length} banked prior region(s) from ${src} — ${prior.scored} matched, ${prior.moved} moved${lead}. Reorder only; search space unchanged.`);
        } else {
            console.log(`[PlateSolver] [SEARCH-PRIORS] EXPERIMENTAL: ${options.searchPriors.regions.length} prior region(s) supplied but no center matched (prior-miss) — full sweep order unchanged.`);
        }
    }
    // ═══ end SEARCH-ORDER PRIORS ══════════════════════════════════════════════════

    // --- SEARCH LOOP ---
    const quadtolerance = options.quadtolerance ?? PC.SOLVER_QUAD_tolerance_DEFAULT;

    // Phase 3: Strategy Dispatcher
    const pitchMm = options.pixelPitchUm ? options.pixelPitchUm / 1000 : 0.0039; // Canon Rebel T6 baseline
    // FL for strategy selection: caller value, else physics-recovered from the
    // target scale (206265·pitch/scale, folded as 3600/scale·pitchMm), else the
    // named wide-field PRIOR of last resort (see OpticsManager — never a bare
    // "14mm Rokinon" magic literal).
    const focalLength = options.focalLengthMm || (targetScale ? (3600 / targetScale) * pitchMm : OpticsManager.WIDE_FIELD_FL_PRIOR_MM);
    // RIDGE PARK (owner-delegated, 2026-07-10; ultracode held-#2): 'ridge_directed'
    // is DORMANT — its matcher only runs when options.directedAnchor is set, and no
    // app path ever sets it (no setter exists — the former dev-only setter in
    // src/engine/tools/verify_pipeline.ts was removed in the 2026-07-21 dead-code sweep).
    // Left in the chain it silently fell through to solve_planar_local while the
    // winning-strategy label still claimed "via ridge_directed" on every FL>200mm
    // solve (false label, LAW-3). Parked OUT of the live chain until the CD-sign
    // bug is fixed AND directedAnchor is plumbed from the orchestrators (ROADMAP
    // C8a: ridge rotation's 2nd row is the sign-negation of the CD convention →
    // mirrored-Dec WCS rejected by verify; CLAUDE.md LIVE/DEAD ledger). The
    // implementation is RETAINED, not deleted: solver_ridge.rs, the ridge branch
    // in trySolveAtCenter, and solver_strategies.ts are untouched.
    const strategyChain = getLiveStrategyChain(focalLength);

    // BLIND TIME BUDGET: a many-center sweep (~165 centers x ~1-2s) runs for
    // minutes — the wizard must reach an HONEST terminal state, never sit in
    // "Solving blind..." past the budget (first CR2 run: 290s and counting).
    // Hinted solves (<=3 centers) are never budget-cut.
    const isBlindSweep = searchCenters.length > 3;
    const blindDeadline = isBlindSweep ? Date.now() + (options.blindBudgetMs ?? 90_000) : Infinity;
    let centersTried = 0;

    for (const strategy of strategyChain) {
        console.log(`[PlateSolver] [STRATEGY] Strategy: ${strategy} (Attempting...)`);
        centersTried = 0; // per-strategy count (log read "200/169" when accumulated across the chain)

        // Helper to run the solve loop for a specific strategy
        const runSolveLoop = async (stars: DetectedStar[]): Promise<SolveResult> => {
            for (const center of searchCenters) {
                if (Date.now() > blindDeadline) {
                    const msg = `Blind budget exhausted after ${centersTried}/${searchCenters.length} centers (${Math.round((options.blindBudgetMs ?? 90_000) / 1000)}s)`;
                    console.warn(`[PlateSolver] [BUDGET] ${msg}`);
                    if (!diagnostics.rejection_reasons.includes(msg)) diagnostics.rejection_reasons.push(msg);
                    return { success: false, diagnostics };
                }
                centersTried++;
                // Reserved Glass-Pipeline socket: narrate the sweep.
                options.onBlindProgress?.(centersTried, searchCenters.length, center.ra, center.dec);
                // DEEP CATALOG for the leading ultra-wide hypotheses: L1/L2
                // holds only ~15 stars in a 6-deg quad patch — starvation.
                // Level-3 sectors (to mag ~9) exist and load in the hint
                // path; page them in for the first few blind centers
                // (planets + brightest anchors lead the list). 9 deg is
                // under the sector-load cap.
                // ULTRA-WIDE CATALOG DECOUPLING (v2 cost fix): the ultra-wide
                // anchored sweep AND its verify match only the BRIGHT catalog
                // (mag < SOLVER_UW_VERIFY_MAG_LIMIT = 6). The ENTIRE all-sky
                // mag<6 set lives in level_1_anchors (4497 rows, mag 1.94–6.08),
                // loaded ONCE at startup. The per-center ensureSectorLoaded(9°)
                // that used to run here paged Level-3 sectors (mag 6.8–14.7) —
                // stars the sweep/verify FILTER OUT — costing ~30 s of I/O per
                // center (blind budget starved at ~3 centers in 90 s) and
                // inflating catalogProjected. It only ever fed the quad matcher,
                // which is structurally starved for ultra-wide anyway. So the
                // sweep is byte-identical WITHOUT the paging, just fast: skip it
                // for ultra-wide. Deep L3 stays available on the hinted path
                // (Step-3 above) and could be deferred to a promising center's
                // deep-verify if a future path needs it. Narrow/normal blind
                // fields never entered this branch (FOV-gated).
                //
                // (no per-center L3 paging for ultra-wide sweep centers)
                let result: SolveResult;
                try {
                    result = await trySolveAtCenter(
                        stars, imageData, center.ra, center.dec,
                        searchRadius, targetScale, imageData.width, imageData.height,
                        {
                            ...options,
                            strategy, // Pass strategy to trySolveAtCenter
                            focusPlanets: planets,
                            quadtolerance,
                            maxvariance,
                            planetaryStarIds,
                            // Lever-generated speculative center → winner-dominance
                            // applies in the sweep; base centers unaffected.
                            leverCenter: (center as any).lever === true,
                            // (sun-veto wiring retired 2026-07-10 — owner ruling; see §backstops note above)
                            // Blind deadline so top-N anchor hypotheses (NEXT_MOVES
                            // §2a) don't start extra sweeps past the budget.
                            blindDeadline,
                            // Lens-prior un-distortion (NEXT_MOVES §8): the model +
                            // precomputed undistorted matching coords, shared across
                            // all centers. Null → no-op, byte-identical.
                            lensDistModel,
                            lensMatchCoords,
                        },
                        diagnostics
                    );
                } catch (err) {
                    // A WASM panic ("RuntimeError: unreachable") in one strategy must not
                    // abort the whole solve - record it and try the next center/strategy.
                    console.warn(`[PlateSolver] [PANIC] Strategy ${strategy} threw at RA ${center.ra.toFixed(2)}:`, err);
                    diagnostics.rejection_reasons.push(`${strategy} panicked: ${err instanceof Error ? err.message : String(err)}`);
                    continue;
                }

                if (result.success && result.solution && result.solution.confidence! > PC.SOLVER_MIN_LOCK_confidence) {
                    console.log(`[PlateSolver] [LOCK] Astrometric Lock Verified at RA ${center.ra.toFixed(2)} via ${strategy}.`);
                    result.solution.search_debug = { stars_extracted: detected.length, matches_tried: 1, passes_run: [strategy] } as any;
                    return result;
                } else if (result.success && result.solution && (result.solution.matched_stars?.length ?? 0) >= PC.SOLVER_LOCK_MATCH_COUNT_FLOOR) {
                    // Owner-confirmed 2026-07-12: a verifyWCS-passed lock whose frame-wide
                    // confidence deflated (deep/mosaic denominator) is accepted on verified
                    // match count alone — see SOLVER_LOCK_MATCH_COUNT_FLOOR evidence note.
                    console.log(`[PlateSolver] [LOCK] Match-count floor acceptance at RA ${center.ra.toFixed(2)} via ${strategy}: ${result.solution.matched_stars!.length} verified matches >= ${PC.SOLVER_LOCK_MATCH_COUNT_FLOOR} (confidence ${result.solution.confidence?.toFixed(4)} below ${PC.SOLVER_MIN_LOCK_confidence} floor).`);
                    result.solution.search_debug = { stars_extracted: detected.length, matches_tried: 1, passes_run: [strategy] } as any;
                    return result;
                } else if (result.success && result.solution) {
                    // A verifyWCS-passed lock at/below the calibrated SOLVER_MIN_LOCK_confidence
                    // floor must be RECORDED, never silently dropped — failure receipts read
                    // rejection_reasons, and a dropped-but-verified lock is a different outcome
                    // than no lock at all. The floor itself is calibrated (orchestrator-owned).
                    console.warn(`[PlateSolver] [DROP] Verified lock at RA ${center.ra.toFixed(2)} via ${strategy} dropped: confidence ${result.solution.confidence?.toFixed(4)} <= floor ${PC.SOLVER_MIN_LOCK_confidence}, matches ${result.solution.matched_stars?.length ?? 0} < ${PC.SOLVER_LOCK_MATCH_COUNT_FLOOR}.`);
                    diagnostics.rejection_reasons.push(`confidence_floor_drop: verified lock via ${strategy} at RA ${center.ra.toFixed(2)} confidence=${result.solution.confidence?.toFixed(4)} <= ${PC.SOLVER_MIN_LOCK_confidence}, matches=${result.solution.matched_stars?.length ?? 0} < ${PC.SOLVER_LOCK_MATCH_COUNT_FLOOR}`);
                    // [SOLVE_FAILURE_DIAGNOSTICS] Retain the BEST (most-matches) verified-
                    // but-dropped candidate so a NO-SOLVE run can run a MEASURED diagnostic
                    // (bc_measure) on its REAL provisional matched pairs. Diagnostic-only —
                    // buildReceipt (the solved product) never reads diagnostics, so keeping
                    // this even on a run that later locks is byte-identical (proven by the
                    // pinned e2e). NEVER re-enters the solve.
                    const nmMatches = result.solution.matched_stars?.length ?? 0;
                    if (!diagnostics.best_near_miss || nmMatches > diagnostics.best_near_miss.matched) {
                        diagnostics.best_near_miss = {
                            confidence: result.solution.confidence ?? null,
                            matched: nmMatches,
                            solution: result.solution,
                        };
                    }
                }
            }
            return { success: false, diagnostics };
        };

        const result = await runSolveLoop(detected);
        if (result.success) {
            diagnostics.solve_time_ms = performance.now() - startTime;
            return result;
        }
    }

    diagnostics.solve_time_ms = performance.now() - startTime;
    return { success: false, diagnostics };
}

// â”€â”€â”€ SOLVER OPTIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface SolverOptions {
    detectionThreshold?: number; // Sigma threshold (default 3.0)
    focusRegions?: { x: number; y: number; radius: number }[];
    focusPlanets?: PlanetaryAnchor[]; // Use these to verify geometry
    quadtolerance?: number; // Override for wide-angle distortion (default 0.03)
    scaleLock?: number; // Physical scale confirmed by Metrology
    logger?: TelemetryLogger;
    loggerCallback?: (msg: string) => void;
    focalLengthMm?: number;
    pixelPitchUm?: number; // Explicit sensor pixel pitch mapping
    detectedStars?: DetectedStar[] | { stars: DetectedStar[]; planets?: DetectedStar[]; anomalies?: DetectedStar[] };
    observer?: { lat: number; lon: number };
    timestamp?: string; // Observation time for planetary ephemeris
    /** Wall-clock cap for many-center blind sweeps (default 90s). */
    blindBudgetMs?: number;
    /** Per-center narration for blind sweeps (Glass Pipeline socket). */
    onBlindProgress?: (centersTried: number, centersTotal: number, raHours: number, decDeg: number) => void;
    /**
     * External search-center PRIORS, tried FIRST and never pruned. Sky positions
     * (ra hours, dec deg) to seed the blind sweep with — a user-supplied target,
     * a corrected planetary ephemeris (the built-in Kepler path is a known-weak
     * ledger item), or a diagnostic center injected by the headless harness.
     * These do not replace the normal center generation; they lead it.
     */
    extraSearchCenters?: { ra: number; dec: number; name?: string }[];
    /**
     * SEARCH-ORDER PRIORS (task #20 — lane ① search priors ONLY). A banked-receipt-
     * derived model of sky regions the solver has historically locked near. When
     * PC.SOLVER_SEARCH_PRIORS is ON (env/config, default OFF), the final blind-sweep
     * center list is REORDERED so centers nearest high-weight priors are visited
     * first — a stable permutation (nothing pruned, search space unchanged) that
     * never touches verification / thresholds / the math gate (see search_priors.ts).
     * Absent, empty, or unmatched ⇒ identity (full sweep, unchanged). Flag OFF ⇒ this
     * field is ignored entirely and the sweep is bit-identical.
     */
    searchPriors?: SearchPriorModel | null;
    /**
     * Internal: this center was generated by the ultra-wide fine-center lever
     * (a speculative grid point around a bright anchor). Set per-center by the
     * search loop — winner-dominance in the anchored sweep applies only to these,
     * so the base sweep stays byte-identical. Not a public knob.
     */
    leverCenter?: boolean;
    // (sunPosition / daytimeConfirmed options RETIRED 2026-07-10 with the
    // sun-proximity veto — owner ruling; docs/NEXT_MOVES.md §6 history. The
    // tools/dslr sun_veto_img1414.uwspec.ts harness that injected them is now
    // historical evidence, not a live seam.)
    iterativetolerances?: number[]; // Custom progression (e.g. [0.01, 0.03, 0.05])
    maxvariance?: number; // Max scale variance allowed
    directedAnchor?: { 
        x: number; 
        y: number; 
        ra_hours: number; 
        dec_degrees: number 
    };
    planetaryStarIds?: Set<number>;
    scales?: any; // ScaleManager reference
    strategy?: SolverStrategy;
    hardwareProfile?: HardwareProfile;
    /** Optional verifyWCS threshold overrides (narrow-FOV tuning). Absent = wide-field defaults. */
    verifyTuning?: {
        minAnchorMatches?: number;
        minConfidence?: number;
        denseFieldCutoff?: number;
    };
    /**
     * Lens-prior distortion (NEXT_MOVES §8). When set to a resolved profile,
     * solvePlate un-distorts the MATCHING detection coordinates (sweep sGrid +
     * quad detX/detY, consistently, before code formation) so a barrel-warped
     * ("mustache") frame's asterism code lines up with the rectilinear catalog.
     * Null/absent → identity → byte-identical. Photometry keeps native coords.
     */
    lensDistortionPrior?: LensDistortionResolution | null;
    /** Free-text/keyed user lens hint (resolved to lensDistortionPrior by autoSolvePlate). */
    lensDistortionHint?: LensDistortionHint | null;
    /**
     * INTERNAL (solvePlate → trySolveAtCenter): the Brown-Conrady coordinate
     * model + the precomputed undistorted MATCHING coords for `detected`. Never
     * set by external callers; derived from lensDistortionPrior. Null → no-op.
     */
    lensDistModel?: LensDistortionModel | null;
    lensMatchCoords?: WeakMap<DetectedStar, { x: number; y: number }> | null;
    /**
     * Internal (search loop → trySolveAtCenter): absolute Date.now() deadline for
     * the blind sweep, so a center does not START extra top-N anchor hypotheses
     * (NEXT_MOVES §2a) once the budget is spent. Infinity/absent → no cap. Not a
     * public knob.
     */
    blindDeadline?: number;
}

/**
 * NEXT_MOVES §2a top-N anchor ranking. Returns the `n` highest-flux candidates,
 * flux-descending. Element [0] is the exact former flux-argmax: V8's Array.sort
 * is stable and the comparator is strict, so among equal-flux ties the
 * first-in-original-order element leads — identical to the old
 * `.reduce((best, s) => flux(s) > flux(best) ? s : best)` argmax. Hence n=1 (and
 * candidate #0 at any n) is byte-identical. Exported pure for unit testing.
 */
export function rankAnchorsByFlux<T extends { flux?: number }>(candidates: T[], n: number): T[] {
    return [...candidates]
        .sort((a, b) => (b.flux || 0) - (a.flux || 0))
        .slice(0, Math.max(1, n));
}

/**
 * Attempt to solve the plate assuming the image is centered near (ra0, dec0).
 */
async function trySolveAtCenter(
    detected: DetectedStar[],
    imageData: ImageData,
    ra0: number,
    dec0: number,
    searchRadius: number,
    pixelScale: number,
    imageW: number,
    imageH: number,
    options: SolverOptions,
    diagnostics: SolveDiagnostics
): Promise<SolveResult> {
    const quadtolerance = options.quadtolerance ?? PC.SOLVER_QUAD_tolerance_DEFAULT;
    const maxvariance = options.maxvariance ?? PC.SOLVER_MAX_SCALE_variance;
    const extraStars: StandardStar[] = options.focusPlanets?.map(p => ({
        ra_hours: p.ra_hours,
        dec_degrees: p.dec_degrees,
        name: p.name,
        gaia_id: `PLANET_${p.name.toUpperCase()}`,
        magnitude_V: 0,
        color_index_BV: 0,
        spectral_type: 'Solar',
        temperature_K: 5778,
        pmra: 0,
        pmdec: 0,
        rv_kms: 0,
        expected_xy: { x: 0.33, y: 0.33 },
        constellation: ''
    })) || [];

    // Calculate target JD for temporal proper motion propagation
    const targetJd = options.timestamp ? TimeService.toJulianDate(new Date(options.timestamp)) : TimeService.toJulianDate(new Date());

    // [PHASE B] ULTRA-WIDE CENTRAL-PATCH MATCHING (see pipeline_config for the
    // geometry). Quad matching runs on a similarity model that only holds near
    // the tangent point; restrict det + catalog quad sets to a central patch
    // and shrink the catalog fetch accordingly (a 137-deg fetch per center was
    // paging the whole sky). Verification still uses the full gnomonic model,
    // so a central lock generalizes to the frame.
    const fovDiagDeg = Math.hypot(imageW, imageH) * pixelScale / 3600;
    const patchActive = Number.isFinite(fovDiagDeg) && fovDiagDeg > PC.SOLVER_WIDE_PATCH_MIN_FOV_DEG;
    const patchRadiusPx = patchActive ? PC.SOLVER_WIDE_PATCH_RADIUS_DEG * 3600 / pixelScale : Infinity;
    // LENS-PRIOR MATCHING COORDS (NEXT_MOVES §8): mX/mY return the UN-DISTORTED
    // position of a detection for MATCHING geometry (anchor projection origin,
    // sweep sGrid, quad detX/detY, the patch-radius filter). When no prior is
    // active (lensMatchCoords null), they return the native x/y EXACTLY, so the
    // whole path is byte-identical. Photometry/verify keep native coords.
    const lensDistModel = options.lensDistModel ?? null;
    const lensMatch = options.lensMatchCoords ?? null;
    const mX = (s: DetectedStar): number => lensMatch?.get(s)?.x ?? s.x;
    const mY = (s: DetectedStar): number => lensMatch?.get(s)?.y ?? s.y;
    // Sky-weighted patch center: on nightscape frames the geometric center
    // often sits on FOREGROUND (the bundled beach frame centers on a
    // lifeguard tower — its lights topped the quad flux ranking). The median
    // detection position tracks the dense star field and resists bright
    // foreground clusters. Det and catalog filters share this pixel point so
    // both patches cover the same hypothesized sky region.
    // SKY-COMPONENT DETECTION from the density grid. Genuine sky is one big
    // connected region of star-bearing cells; foreground junk (tower-light
    // clumps, campfires, the LP-dome noise wall at x<=172 on the beach
    // frame) forms small disconnected islands. Take the largest 4-connected
    // component of dense cells as "the sky": the quad pool is restricted to
    // it, and the patch centers on ITS centroid (owner request: intelligently
    // drop detections sitting in isolated pockets far from dense star data).
    let patchCx = imageW / 2, patchCy = imageH / 2;
    // Anchor-identification state: true when the patch is centered ON the
    // brightest hygiene-passing detection (the "this detection IS the object
    // at ra0/dec0" hypothesis) — the anchored rotation sweep below needs it.
    let anchorModeActive = false;
    // TOP-N anchor hypotheses (NEXT_MOVES §2a): the flux-ranked hygiene-passing
    // detections, candidate #0 == the former argmax. The anchored sweep below
    // tries #1/#2 only when #0 does not lock. Empty unless anchor mode engages.
    let sweepAnchorCandidates: DetectedStar[] = [];
    let skyCells: Set<number> | null = null;
    const GRID = 32;
    const cellW = imageW / GRID, cellH = imageH / GRID;
    const cellOf = (x: number, y: number) =>
        Math.min(GRID - 1, Math.max(0, Math.floor(y / cellH))) * GRID +
        Math.min(GRID - 1, Math.max(0, Math.floor(x / cellW)));
    if (patchActive && detected.length >= 8) {
        const counts = new Map<number, number>();
        for (const d of detected) {
            const c = cellOf(d.x, d.y);
            counts.set(c, (counts.get(c) ?? 0) + 1);
        }
        // STARLIKE density band, floor AND ceiling. Measured on the beach
        // frame: real sky runs ~1-5 detections per cell (162x108px cells),
        // while the light-pollution noise dome packs dozens per cell — with
        // only a floor, the junk wall WAS the largest component and the quad
        // pool got restricted to pure garbage (det top8 all in the LP dome).
        // Real star fields have bounded density; noise gradients do not.
        const dense = new Set<number>();
        for (const [c, n] of counts) if (n >= 1 && n <= 12) dense.add(c);
        // Largest 4-connected component via flood fill.
        const seen = new Set<number>();
        let largest: number[] = [];
        for (const start of dense) {
            if (seen.has(start)) continue;
            const comp: number[] = [];
            const stack = [start];
            seen.add(start);
            while (stack.length) {
                const c = stack.pop()!;
                comp.push(c);
                const cx = c % GRID, cy = Math.floor(c / GRID);
                for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
                    if (nx < 0 || nx >= GRID || ny < 0 || ny >= GRID) continue;
                    const nc = ny * GRID + nx;
                    if (dense.has(nc) && !seen.has(nc)) { seen.add(nc); stack.push(nc); }
                }
            }
            if (comp.length > largest.length) largest = comp;
        }
        if (largest.length >= 8) {
            skyCells = new Set(largest);
            let sx = 0, sy = 0;
            for (const c of largest) { sx += (c % GRID) + 0.5; sy += Math.floor(c / GRID) + 0.5; }
            patchCx = (sx / largest.length) * cellW;
            patchCy = (sy / largest.length) * cellH;
            console.log(`[PlateSolver] [SKY] Largest dense component: ${largest.length}/${dense.size} cells; quad pool restricted to it.`);
            // ANCHOR IDENTIFICATION: center the patch ON the brightest
            // hygiene-passing detection instead of the density centroid.
            // The hypothesis becomes "this detection IS the bright object
            // near (ra0,dec0)" — translation known, only rotation/scale
            // free: the exact geometry the ground-truth brute-forcer
            // validated (8/16 bright stars via a Jupiter pin). The density
            // centroid drifted 467px from Jupiter and a 6-deg patch never
            // reached it.
            // The anchor must be a compact bright object in NORMAL sky, not
            // the brightest pixel of a light-pollution dome: the beach frame
            // has two flux-130 objects — Jupiter, and the city-glow hotspot
            // sitting in a sea of hundreds of gradient-noise detections.
            // Test the 3x3 cell neighbourhood: a planet's bloom cluster is
            // tens of detections; the dome is hundreds.
            const meanPerCell = detected.length / (GRID * GRID);
            const neighbourhoodCap = Math.max(40, 5 * 9 * meanPerCell);
            const neighbourhoodCount = (s: { x: number; y: number }) => {
                const gx = Math.min(GRID - 1, Math.max(0, Math.floor(s.x / cellW)));
                const gy = Math.min(GRID - 1, Math.max(0, Math.floor(s.y / cellH)));
                let n = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    if (gx + dx < 0 || gx + dx >= GRID || gy + dy < 0 || gy + dy >= GRID) continue;
                    n += counts.get((gy + dy) * GRID + gx + dx) ?? 0;
                }
                return n;
            };
            // TOP-N ANCHOR CANDIDATES (NEXT_MOVES §2a): rank the hygiene-passing
            // detections by flux and keep the top SOLVER_UW_ANCHOR_CANDIDATES as
            // alternative anchor hypotheses. Candidate [0] is the exact former
            // flux-argmax (rankAnchorsByFlux preserves it at index 0), so the patch
            // center + the downstream quad pool stay byte-identical; the anchored
            // sweep below tries #1/#2 only when #0 fails to lock. Engage anchor mode
            // only when the brightest candidate has positive flux — matching the old
            // reduce, whose null seed left anchor mode OFF if nothing out-fluxed 0.
            const anchorCandidates = rankAnchorsByFlux(
                detected
                    .filter(s => Number.isFinite(s.x) && Number.isFinite(s.y))
                    .filter(s => s.fwhm === undefined || (s.fwhm >= 1.0 && s.fwhm <= 40))
                    .filter(s => neighbourhoodCount(s) <= neighbourhoodCap),
                PC.SOLVER_UW_ANCHOR_CANDIDATES,
            );
            if (anchorCandidates.length > 0 && (anchorCandidates[0].flux || 0) > 0) {
                patchCx = anchorCandidates[0].x;
                patchCy = anchorCandidates[0].y;
                anchorModeActive = true;
                sweepAnchorCandidates = anchorCandidates;
            }
        } else {
            // Sparse frame: fall back to plain occupancy centroid, no cull.
            let sx = 0, sy = 0, n = 0;
            for (const [c] of counts) { sx += (c % GRID) + 0.5; sy += Math.floor(c / GRID) + 0.5; n++; }
            if (n > 0) { patchCx = (sx / n) * cellW; patchCy = (sy / n) * cellH; }
        }
    }
    // LENS-PRIOR (NEXT_MOVES §8): move the patch/projection ORIGIN into the same
    // UN-DISTORTED space as the sGrid + detX/detY, so catalog (projected
    // rectilinearly relative to this origin) and the undistorted detections
    // share one frame. For the brightAnchor branch this equals mX/mY of that
    // detection (identical fixed-point evaluation); for the centroid branches it
    // maps the point consistently. NO-OP (byte-identical) when no prior active.
    if (lensDistModel) {
        const uc: [number, number] = [0, 0];
        lensDistModel.toCorrected(patchCx, patchCy, uc);
        patchCx = uc[0];
        patchCy = uc[1];
    }
    // Fetch 1.5x the patch so the verify anchor (capped to the patch radius
    // in verifyWCS) stays covered even when the fitted crpix lands
    // off-center — PLUS the patch-center offset from the image center: the
    // hypothesis pins (ra0,dec0) to the image center, so a sky-shifted patch
    // samples catalog that far from the fetch origin.
    const patchOffsetDeg = Math.hypot(patchCx - imageW / 2, patchCy - imageH / 2) * pixelScale / 3600;
    const fetchRadiusDeg = patchActive
        ? Math.min(searchRadius, PC.SOLVER_WIDE_PATCH_RADIUS_DEG * 1.5 + patchOffsetDeg)
        : searchRadius;
    if (patchActive) {
        console.log(`[PlateSolver] [PATCH] Ultra-wide field (${fovDiagDeg.toFixed(0)} deg diag): central-patch matching, radius ${PC.SOLVER_WIDE_PATCH_RADIUS_DEG} deg (${patchRadiusPx.toFixed(0)}px), center (${patchCx.toFixed(0)}, ${patchCy.toFixed(0)})${Math.hypot(patchCx - imageW / 2, patchCy - imageH / 2) > 50 ? ' [sky-shifted]' : ''}, catalog fetch ${fetchRadiusDeg.toFixed(1)} deg.`);
    }

    // Get catalog stars in this region
    let catalogStars = await StarCatalogAdapter.getinstance().findStarsInField(ra0, dec0, fetchRadiusDeg, targetJd);
    
    // Inject extra stars (Planets) if they are in the field
    if (extraStars.length > 0) {
        // Simple bounding box check for planets
        const injected = extraStars.filter(s => {
            const dRA = Math.abs(s.ra_hours - ra0);
            const dDec = Math.abs(s.dec_degrees - dec0);
            // Rough check
            return dDec < searchRadius && (dRA * 15 * Math.cos(dec0 * Math.PI / 180)) < searchRadius;
        });
        catalogStars = [...catalogStars, ...injected];
    }

    if (catalogStars.length < 4) {
        diagnostics.rejection_reasons.push(`Insufficient Catalog Stars: ${catalogStars.length}`);
        return { success: false, diagnostics };
    }

    // Project catalog stars onto tangent plane (degrees from center)
    const catalogProjected = catalogStars
        .map(s => ({
            ...SkyTransform.gnomonicProject(s.ra_hours, s.dec_degrees, ra0, dec0),
            star: s,
        }))
        .filter(c => !Number.isNaN(c.xi) && !Number.isNaN(c.eta));

    // Scale catalog tangent-plane positions to approximate pixel positions
    // so we can compare quad geometry with detected stars. In ultra-wide
    // anchor mode the projection ORIGIN is the brightest detection, not the
    // image center: the hypothesis "that detection IS the object at
    // (ra0,dec0)" puts catalog-Jupiter exactly on det-Jupiter, so det and
    // catalog quad pools cover the same sky by construction (quad codes are
    // translation-invariant; only the POOL alignment needs this).
    const projOriginX = patchActive ? patchCx : imageW / 2;
    const projOriginY = patchActive ? patchCy : imageH / 2;
    let catalogPixels: { x: number, y: number, star: typeof catalogStars[0] }[] = [];

    if (options.scales && options.scales.degreeToScaledCanvas) {
        // Use ScaleManager's resolution-aware conversion if available
        catalogPixels = catalogProjected.map(c => ({
            x: projOriginX + options.scales!.degreeToScaledCanvas(c.xi),
            y: projOriginY - options.scales!.degreeToScaledCanvas(c.eta), // Flip Y
            star: c.star
        }));
    } else {
        // Fallback for isolated unit tests without full ScaleManager context
        const degPerPx = pixelScale / 3600;
        catalogPixels = catalogProjected.map(c => ({
            x: projOriginX + c.xi / degPerPx,
            y: projOriginY - c.eta / degPerPx,
            star: c.star
        }));
    }

    // ═══ [ULTRA-WIDE ANCHORED SWEEP] ══════════════════════════════════════
    // Candidate generation for the ultra-wide anchor hypothesis. Quad hashing
    // is structurally starved here (known-answer forensics on the bundled
    // CR2: the top-50-by-mag catalog pool cuts at ~mag 5.6 while the top-30
    // detections in the 6-deg patch are mag ~6-9.5 stars — the pools share
    // ONLY the anchor itself, so a true quad can never form at any hash
    // tolerance). But the anchor hypothesis pins translation ("this bright
    // detection IS the object at ra0/dec0") and metrology pins scale, leaving
    // rotation x parity: brute-force them directly against the BRIGHT catalog
    // (mag < SOLVER_UW_VERIFY_MAG_LIMIT) with the radius-scaled distortion
    // net — the exact methodology that ground-truthed this frame. The sweep's
    // own 1440-orientation score distribution is the significance null; only
    // a many-sigma peak is handed to the full verifyWCS stack (which applies
    // its independent bright-excess, scale and confidence gates).
    if (patchActive && anchorModeActive && (options.strategy || 'planar_local') === 'planar_local') {
        const degPerPx = pixelScale / 3600;
        const brightCat = catalogProjected.filter(c => (c.star.magnitude_V ?? 99) < PC.SOLVER_UW_VERIFY_MAG_LIMIT);
        if (brightCat.length >= 12) {
            // Detection lookup grid over the full frame. ANCHOR-INDEPENDENT — built
            // ONCE and shared by every top-N anchor hypothesis (NEXT_MOVES §2a).
            const sCell = 128;
            const sGw = Math.ceil(imageW / sCell);
            const sGrid = new Map<number, { x: number; y: number }[]>();
            for (const d of detected) {
                if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
                // Lens-prior: index the UN-DISTORTED matching coords (mX/mY). No
                // prior → mX/mY == native x/y and we store {x,y} the sweep reads
                // identically → byte-identical.
                const gx = mX(d), gy = mY(d);
                const key = Math.floor(gy / sCell) * sGw + Math.floor(gx / sCell);
                const b = sGrid.get(key);
                if (b) b.push({ x: gx, y: gy }); else sGrid.set(key, [{ x: gx, y: gy }]);
            }
            const baseNetPx = Math.min(PC.SOLVER_MAX_VERIFY_RADIUS_ARCSEC, Math.max(PC.SOLVER_VERIFICATION_RADIUS_ARCSEC, pixelScale * 15)) / pixelScale;
            const WIDE_NET_SLOPE = VERIFY_NET.WIDE_NET_SLOPE; // matches the verifyWCS ultra-wide net
            const ocx = options.hardwareProfile?.optical_center?.x ?? imageW / 2;
            const ocy = options.hardwareProfile?.optical_center?.y ?? imageH / 2;
            const hasDetNear = (px: number, py: number, tol: number): boolean => {
                const cr = Math.max(1, Math.ceil(tol / sCell));
                const gx = Math.floor(px / sCell), gy = Math.floor(py / sCell);
                const tolSq = tol * tol;
                for (let dy = -cr; dy <= cr; dy++) for (let dx = -cr; dx <= cr; dx++) {
                    const b = sGrid.get((gy + dy) * sGw + gx + dx);
                    if (!b) continue;
                    for (const d of b) {
                        if ((d.x - px) ** 2 + (d.y - py) ** 2 <= tolSq) return true;
                    }
                }
                return false;
            };
            // scoreOrientation now takes the anchor origin (aCx, aCy) so the sweep
            // runs per candidate. For candidate #0, aCx/aCy == patchCx/patchCy, so
            // the scores are byte-identical to the pre-§2a single-argmax sweep.
            const scoreOrientation = (thetaDeg: number, par: number, aCx: number, aCy: number): number => {
                const th = thetaDeg * Math.PI / 180;
                const cT = Math.cos(th), sT = Math.sin(th);
                let m = 0;
                for (const c of brightCat) {
                    const ey = c.eta * par;
                    const px = aCx + (c.xi * cT - ey * sT) / degPerPx;
                    const py = aCy + (c.xi * sT + ey * cT) / degPerPx;
                    if (px < 0 || px >= imageW || py < 0 || py >= imageH) continue;
                    const tol = Math.max(baseNetPx, WIDE_NET_SLOPE * Math.hypot(px - ocx, py - ocy));
                    if (hasDetNear(px, py, tol)) m++;
                }
                return m;
            };
            const leverCenter = options.leverCenter === true;
            // TOP-N ANCHOR HYPOTHESES (NEXT_MOVES §2a). Candidate #0's undistorted
            // coords are already in patchCx/patchCy (byte-identical); #1/#2 undistort
            // the same way (identity when no lens prior). The loop tries each anchor
            // in flux order and RETURNS on the FIRST verified lock — so a frame that
            // locks on #0 (incl. the bundled CR2 at +7.1σ) never runs #1/#2 and stays
            // byte-identical. Anchor #0 also preserves the lever winner-dominance
            // abort exactly; #1/#2 merely yield to the next candidate on rejection.
            const undistortAnchor = (x: number, y: number): { cx: number; cy: number } => {
                if (!lensDistModel) return { cx: x, cy: y };
                const uc: [number, number] = [0, 0];
                lensDistModel.toCorrected(x, y, uc);
                return { cx: uc[0], cy: uc[1] };
            };
            const anchorHyps = sweepAnchorCandidates.map((s, i) =>
                i === 0 ? { cx: patchCx, cy: patchCy } : undistortAnchor(s.x, s.y));
            for (let ai = 0; ai < anchorHyps.length; ai++) {
                // Budget: don't START extra anchor hypotheses once the blind
                // deadline is spent (the per-center check upstream already gated #0).
                if (ai > 0 && Date.now() > (options.blindDeadline ?? Infinity)) {
                    console.log(`[PlateSolver] [UW-SWEEP] Blind budget reached — skipping anchor candidates ${ai + 1}..${anchorHyps.length} at ${ra0.toFixed(3)}h/${dec0.toFixed(2)}.`);
                    break;
                }
                const aCx = anchorHyps[ai].cx, aCy = anchorHyps[ai].cy;
                const sweepT0 = Date.now();
                // Coarse sweep, 0.5 deg step, both parities; the ensemble is the null.
                // For LEVER centers, retain the per-orientation scores so winner-
                // dominance can measure how far the peak beats its best distant
                // runner-up (base centers skip the array — byte-identical, no alloc).
                const sweepScores: { theta: number; parity: number; m: number }[] = [];
                let sum = 0, sumSq = 0, n = 0;
                let peak = { theta: 0, parity: 1, m: -1 };
                for (const par of [1, -1]) {
                    for (let th = 0; th < 360; th += 0.5) {
                        const m = scoreOrientation(th, par, aCx, aCy);
                        sum += m; sumSq += m * m; n++;
                        if (leverCenter || PC.SOLVER_UW_LOG_TOP_PEAKS > 0) sweepScores.push({ theta: th, parity: par, m });
                        if (m > peak.m) peak = { theta: th, parity: par, m };
                    }
                }
                const nullMean = sum / n;
                const nullStd = Math.sqrt(Math.max(1e-9, sumSq / n - nullMean * nullMean)) || 1;
                const peakZ = (peak.m - nullMean) / nullStd;
                const sweepMs = Date.now() - sweepT0;
                // A3: record this anchored-sweep attempt (real wall-ms, even when it
                // loses to quad/escalation downstream) for the flowchart branch box.
                accrueBranchTiming(diagnostics, 'solve.uw_sweep', sweepMs);
                // Forensic: record EVERY center/anchor sweep peak (pass or fail) so the
                // sub-threshold distribution is inspectable — a true center peaking
                // just under the gate reads very differently from a frame with no
                // structure anywhere, and only the full record distinguishes them.
                diagnostics.forensics?.push({
                    candidate_idx: -2, quad_error: peakZ, inferred_scale: pixelScale,
                    status: 'UW_SWEEP_PEAK',
                    uw_peak: {
                        z: +peakZ.toFixed(2), theta: peak.theta, parity: peak.parity, m: peak.m,
                        brightCat: brightCat.length, nullMean: +nullMean.toFixed(1), nullStd: +nullStd.toFixed(2),
                        ra0: +ra0.toFixed(3), dec0: +dec0.toFixed(2), anchorIdx: ai,
                    },
                } as any);
                // [SWEEP-PEAK-WCS · campaign diagnostic, PC.SOLVER_UW_LOG_TOP_PEAKS>0]
                // Emit the top-N DISTINCT sweep peaks (full candidate WCS + sweep-z) on
                // EVERY anchor, BEFORE the accept/reject — wide dense fields that never
                // clear the sweep gate still leave rankable candidate pointings on disk.
                // verify-σ per peak = the adjacent verifyWCS log line (matchIndex=rank,
                // diagnostics=undefined ⇒ ZERO solve side effects). Flag 0 ⇒ dead code.
                if (PC.SOLVER_UW_LOG_TOP_PEAKS > 0 && sweepScores.length > 0) {
                    const ranked = [...sweepScores].sort((a, b) => b.m - a.m);
                    const picked: { theta: number; parity: number; m: number }[] = [];
                    for (const c of ranked) {
                        if (picked.length >= PC.SOLVER_UW_LOG_TOP_PEAKS) break;
                        const clash = picked.some(p => {
                            if (p.parity !== c.parity) return false;
                            let d = Math.abs(p.theta - c.theta) % 360; if (d > 180) d = 360 - d;
                            return d < 5;
                        });
                        if (!clash) picked.push(c);
                    }
                    for (let i = 0; i < picked.length; i++) {
                        const pk = picked[i];
                        const pz = (pk.m - nullMean) / nullStd;
                        const pThR = pk.theta * Math.PI / 180;
                        const pcd: [[number, number], [number, number]] = [
                            [degPerPx * Math.cos(pThR), degPerPx * Math.sin(pThR)],
                            [-degPerPx * pk.parity * Math.sin(pThR), degPerPx * pk.parity * Math.cos(pThR)],
                        ];
                        console.log(`[PlateSolver] [SWEEP-PEAK-WCS rank=${i}] anchor#${ai} sweepZ=${pz.toFixed(2)} crval=[RA ${ra0.toFixed(6)}h, Dec ${dec0.toFixed(6)}deg] crpix=[${aCx.toFixed(2)}, ${aCy.toFixed(2)}] cd_degpx=[[${pcd[0][0].toExponential(6)}, ${pcd[0][1].toExponential(6)}], [${pcd[1][0].toExponential(6)}, ${pcd[1][1].toExponential(6)}]] parity=${pk.parity} theta=${pk.theta.toFixed(2)}deg m=${pk.m} — verify-σ ↓ (verifyWCS idx ${i})`);
                        await verifyWCS({ crpix: [aCx, aCy], crval: [ra0, dec0], cd: pcd }, detected, catalogStars, imageData, imageW, imageH, ra0, dec0, maxvariance, options, pixelScale, i, undefined);
                    }
                }
                if (peakZ >= PC.SOLVER_UW_SWEEP_MIN_Z) {
                    // WINNER-DOMINANCE (lever centers only): a real anchored solve
                    // has ONE dominant rotation; a chance alignment shows several
                    // comparable orientations. Require the peak to beat its best
                    // angularly-distant runner-up by SOLVER_UW_DOMINANCE_MARGIN_Z
                    // sweep-sigma before this speculative center may verify. This
                    // ADDS evidence for the lever's own centers; the base sweep gate
                    // (SOLVER_UW_SWEEP_MIN_Z) is untouched and non-lever centers are
                    // byte-identical.
                    if (leverCenter) {
                        const dom = orientationDominance(
                            sweepScores, peak, nullMean, nullStd,
                            PC.SOLVER_UW_DOMINANCE_MIN_SEP_DEG, PC.SOLVER_UW_DOMINANCE_MARGIN_Z,
                        );
                        if (!dom.dominant) {
                            console.log(`[PlateSolver] [UW-SWEEP] Lever center ${ra0.toFixed(3)}h/${dec0.toFixed(2)} anchor#${ai} peak +${peakZ.toFixed(1)}σ NOT dominant (runner-up +${dom.runnerUpZ.toFixed(1)}σ, margin ${(peakZ - dom.runnerUpZ).toFixed(1)} < ${PC.SOLVER_UW_DOMINANCE_MARGIN_Z}) — winner-dominance rejects, not verifying.`);
                            diagnostics.forensics?.push({
                                candidate_idx: -2, quad_error: peakZ, inferred_scale: pixelScale,
                                status: 'UW_DOMINANCE_REJECT',
                                uw_peak: { z: +peakZ.toFixed(2), theta: peak.theta, parity: peak.parity, m: peak.m, runnerUpZ: +dom.runnerUpZ.toFixed(2), ra0: +ra0.toFixed(3), dec0: +dec0.toFixed(2), anchorIdx: ai },
                            } as any);
                            // Anchor #0 preserves the pre-§2a abort (byte-identical);
                            // a non-dominant alternative anchor yields to the next.
                            if (ai === 0) return { success: false, diagnostics };
                            continue;
                        }
                    }
                    // Fine refine around the peak.
                    let best = { ...peak };
                    for (let th = peak.theta - 1.5; th <= peak.theta + 1.5; th += 0.1) {
                        const m = scoreOrientation(th, peak.parity, aCx, aCy);
                        if (m > best.m) best = { theta: th, parity: peak.parity, m };
                    }
                    console.log(`[PlateSolver] [UW-SWEEP] Anchored rotation sweep peak (anchor#${ai}): theta=${best.theta.toFixed(1)} deg parity=${best.parity} (${best.m}/${brightCat.length} bright matches, +${peakZ.toFixed(1)} sigma vs sweep null ${nullMean.toFixed(1)}±${nullStd.toFixed(1)}) in ${sweepMs.toFixed(0)}ms — verifying.`);
                    // CD in the sweep's own convention: pixel = anchor +
                    // R(theta)*diag(1,parity)*(xi,eta)/degPerPx  =>
                    // CD = degPerPx * [[cos, sin], [-p*sin, p*cos]] (deg/px).
                    // (createWCSTransform's rotation/parity convention differs —
                    // constructing CD directly avoids that latent mismatch.)
                    const thR = best.theta * Math.PI / 180;
                    const sweepWCS: WCSTransform = {
                        crpix: [aCx, aCy],
                        crval: [ra0, dec0],
                        cd: [
                            [degPerPx * Math.cos(thR), degPerPx * Math.sin(thR)],
                            [-degPerPx * best.parity * Math.sin(thR), degPerPx * best.parity * Math.cos(thR)],
                        ],
                    };
                    // [BELT-AND-BRACES] Full candidate WCS to the log BEFORE verify, so a
                    // verified-but-dropped near-miss (or a future crash class inside the
                    // sweep) still leaves a RECONSTRUCTABLE WCS on disk when no receipt
                    // survives. Pure log — zero solve effect (both pinned solves byte-identical).
                    console.log(`[PlateSolver] [BEST-CANDIDATE-WCS] anchor#${ai} crval=[RA ${sweepWCS.crval[0].toFixed(6)}h, Dec ${sweepWCS.crval[1].toFixed(6)}deg] crpix=[${sweepWCS.crpix[0].toFixed(2)}, ${sweepWCS.crpix[1].toFixed(2)}] cd_degpx=[[${sweepWCS.cd[0][0].toExponential(6)}, ${sweepWCS.cd[0][1].toExponential(6)}], [${sweepWCS.cd[1][0].toExponential(6)}, ${sweepWCS.cd[1][1].toExponential(6)}]] parity=${best.parity} theta=${best.theta.toFixed(2)}deg`);
                    const verified = await verifyWCS(sweepWCS, detected, catalogStars, imageData, imageW, imageH, ra0, dec0, maxvariance, options, pixelScale, 0, diagnostics);
                    if (verified) {
                        console.log(`[PlateSolver] [LOCK] Geometry locked via anchored rotation sweep (anchor#${ai})!`);
                        diagnostics.forensics?.push({ candidate_idx: -1, quad_error: 0, inferred_scale: pixelScale, status: 'SUCCESS_UW_SWEEP' } as any);
                        return { success: true, solution: verified, diagnostics };
                    }
                    console.log(`[PlateSolver] [UW-SWEEP] Peak orientation (anchor#${ai}) rejected by verifyWCS — trying next anchor / quad matching.`);
                    continue;
                } else if (peakZ >= PC.SOLVER_UW_ESCALATE_MIN_Z) {
                    console.log(`[PlateSolver] [UW-SWEEP] Sub-threshold peak (anchor#${ai}) theta=${peak.theta.toFixed(1)} parity=${peak.parity} (+${peakZ.toFixed(1)} sigma < ${PC.SOLVER_UW_SWEEP_MIN_Z}) in ${sweepMs.toFixed(0)}ms.`);
                    // ═══ [DEEP-VERIFY ESCALATION] (NEXT_MOVES §7·5a) ═══════════
                    // Instead of dying, a [3.0, 4.5σ) peak earns ONE extra
                    // evidence tier: catalog-forced photometry at deep-catalog
                    // positions predicted by the candidate WCS (stars the sweep
                    // never used — it matches mag<6, the probes are mag 6-10),
                    // nulled ON-FRAME at seeded scrambled positions. Only a
                    // +10σ-class binomial excess (truth gains it; junk collapses)
                    // lets the candidate proceed — and then it STILL runs the
                    // full normal verify chain below. The calibrated 4.5σ direct
                    // gate above is untouched; this only ADDS evidence. The
                    // per-solve escalation budget is shared across ALL anchors.
                    const escRun = ((diagnostics as any).uw_escalations_run ?? 0) as number;
                    const havePixels = !!imageData?.data && imageData.data.length >= imageW * imageH * 4;
                    if (escRun >= PC.SOLVER_UW_ESCALATE_MAX_PER_SOLVE) {
                        console.log(`[PlateSolver] [UW-ESCALATE] Skipped (per-solve escalation budget ${PC.SOLVER_UW_ESCALATE_MAX_PER_SOLVE} exhausted).`);
                    } else if (!havePixels) {
                        // Honest skip: no pixel buffer here (headless harness feeds
                        // detections only) — forced photometry has nothing to measure.
                        console.log('[PlateSolver] [UW-ESCALATE] Skipped (no pixel buffer available for forced photometry).');
                    } else {
                        (diagnostics as any).uw_escalations_run = escRun + 1;
                        const escT0 = Date.now();
                        // Fine refine around the peak (same refinement the ≥4.5
                        // branch applies) so probes project through the best WCS.
                        let escBest = { ...peak };
                        for (let th = peak.theta - 1.5; th <= peak.theta + 1.5; th += 0.1) {
                            const m = scoreOrientation(th, peak.parity, aCx, aCy);
                            if (m > escBest.m) escBest = { theta: th, parity: peak.parity, m };
                        }
                        const escThR = escBest.theta * Math.PI / 180;
                        const escWCS: WCSTransform = {
                            crpix: [aCx, aCy],
                            crval: [ra0, dec0],
                            cd: [
                                [degPerPx * Math.cos(escThR), degPerPx * Math.sin(escThR)],
                                [-degPerPx * escBest.parity * Math.sin(escThR), degPerPx * escBest.parity * Math.cos(escThR)],
                            ],
                        };
                        // Deep catalog for the candidate region (the blind UW path
                        // deliberately skips L3 paging; the escalation pages it for
                        // THIS center only — the hint-path pattern).
                        await StarCatalogAdapter.getinstance().ensureSectorLoaded(ra0, dec0, PC.SOLVER_WIDE_VERIFY_ANCHOR_DEG);
                        const escRows = (await StarCatalogAdapter.getinstance().findStarsInField(ra0, dec0, PC.SOLVER_WIDE_VERIFY_ANCHOR_DEG, targetJd))
                            .filter(s => (s.magnitude_V ?? 99) >= PC.SOLVER_UW_ESCALATE_MAG_MIN && (s.magnitude_V ?? 99) <= PC.SOLVER_UW_ESCALATE_MAG_MAX)
                            .sort((a, b) => (a.magnitude_V ?? 99) - (b.magnitude_V ?? 99));
                        const escPatch = { x: aCx, y: aCy, r: patchRadiusPx };
                        const escPredicted = projectCatalogToPixels({
                            stars: escRows, wcs: escWCS, w: imageW, h: imageH, withinRadiusPx: escPatch,
                        }).slice(0, PC.SOLVER_UW_ESCALATE_MAX_POSITIONS);
                        const escL = luminanceFromImageData(imageData);
                        // Aperture FWHM via the shared single-source helper (A1) —
                        // identical to the harvest lane; no silent divergence.
                        const escFwhmPx = computeFrameFwhmPx(detected);
                        const escNoise = sampledBackgroundSigma(escL);
                        // WIRING_SPEC R3 (NEXT_MOVES §8): under an active lens prior the
                        // candidate WCS lives in UN-DISTORTED matching space, but forced
                        // photometry samples NATIVE pixels. Re-project the predicted probe
                        // positions AND the null patch center through the SAME Brown-Conrady
                        // forward model (toNative) the BC-rematch pass uses so the apertures
                        // land on the right native pixels. No-op when no prior (byte-identical).
                        let escProbes = escPredicted;
                        let escNullPatch = escPatch;
                        if (options.lensDistModel) {
                            const lm = options.lensDistModel;
                            escProbes = reprojectProbesToNative(escPredicted, lm);
                            const nt: [number, number] = [0, 0];
                            lm.toNative(escPatch.x, escPatch.y, nt);
                            escNullPatch = { x: nt[0], y: nt[1], r: escPatch.r };
                            console.log(`[PlateSolver] [UW-ESCALATE] Re-projecting ${escProbes.length} probe positions + null patch to native via toNative (lens prior ${lm.model} k1=${lm.k1} k2=${lm.k2}).`);
                        }
                        const esc = deepVerifyEscalation({
                            L: escL, w: imageW, h: imageH,
                            predicted: escProbes,
                            fwhmPx: escFwhmPx,
                            posRmsPx: PC.SOLVER_UW_ESCALATE_POS_RMS_PX,
                            sigmaPix: escNoise.sigma,
                            snrThreshold: PC.SOLVER_UW_ESCALATE_SNR_THRESHOLD,
                            withinRadiusPx: escNullPatch,
                        });
                        const escMs = Date.now() - escT0;
                        // A3: record this deep-verify escalation attempt (real ms,
                        // win or lose) for the flowchart branch box.
                        accrueBranchTiming(diagnostics, 'solve.uw_escalation', escMs);
                        diagnostics.forensics?.push({
                            candidate_idx: -2, quad_error: peakZ, inferred_scale: pixelScale,
                            status: 'UW_ESCALATION',
                            uw_escalation: esc ? {
                                sweepZ: +peakZ.toFixed(2), theta: escBest.theta, parity: escBest.parity,
                                excessZ: +esc.excessZ.toFixed(2),
                                predAccepted: esc.predAccepted, nPred: esc.nPred,
                                nullAccepted: esc.nullAccepted, nNull: esc.nNull,
                                predFrac: +esc.predFrac.toFixed(3), nullFrac: +esc.nullFrac.toFixed(4),
                                structured: esc.predStructured, rApPx: +esc.rApPx.toFixed(2),
                                fwhmPx: +escFwhmPx.toFixed(2), probesInPatch: escPredicted.length,
                                ra0: +ra0.toFixed(3), dec0: +dec0.toFixed(2), ms: escMs, anchorIdx: ai,
                            } : { sweepZ: +peakZ.toFixed(2), insufficientProbes: escPredicted.length, ra0: +ra0.toFixed(3), dec0: +dec0.toFixed(2), ms: escMs, anchorIdx: ai },
                        } as any);
                        if (!esc) {
                            console.log(`[PlateSolver] [UW-ESCALATE] Not enough forced-photometry probes (${escPredicted.length} in patch) — escalation inconclusive (NOT MEASURED), candidate stays sub-threshold.`);
                        } else {
                            console.log(`[PlateSolver] [UW-ESCALATE] Forced photometry at ${esc.nPred} predicted deep-star positions: ${esc.predAccepted} accepted (${(100 * esc.predFrac).toFixed(1)}%) vs scrambled null ${esc.nullAccepted}/${esc.nNull} (${(100 * esc.nullFrac).toFixed(1)}%) → excess ${esc.excessZ >= 0 ? '+' : ''}${esc.excessZ.toFixed(1)}σ (gate ${PC.SOLVER_UW_ESCALATE_MIN_EXCESS_Z}σ) in ${escMs}ms.`);
                            if (esc.excessZ >= PC.SOLVER_UW_ESCALATE_MIN_EXCESS_Z) {
                                console.log(`[PlateSolver] [UW-ESCALATE] Escalation evidence PASSED — handing candidate to the normal verify chain.`);
                                const escVerified = await verifyWCS(escWCS, detected, catalogStars, imageData, imageW, imageH, ra0, dec0, maxvariance, options, pixelScale, 0, diagnostics);
                                if (escVerified) {
                                    console.log('[PlateSolver] [LOCK] Geometry locked via deep-verify escalation (sub-threshold sweep peak + catalog-forced photometry)!');
                                    diagnostics.forensics?.push({ candidate_idx: -1, quad_error: 0, inferred_scale: pixelScale, status: 'SUCCESS_UW_ESCALATED' } as any);
                                    return { success: true, solution: escVerified, diagnostics };
                                }
                                console.log('[PlateSolver] [UW-ESCALATE] Escalated candidate rejected by verifyWCS — falling through.');
                            } else {
                                console.log('[PlateSolver] [UW-ESCALATE] Escalation excess below gate — junk collapses, candidate stays rejected.');
                            }
                        }
                    }
                    // ═══ end [DEEP-VERIFY ESCALATION] ══════════════════════════
                }
            }
        }
    }
    // ═══ end [ULTRA-WIDE ANCHORED SWEEP] ══════════════════════════════════

    // [NEW] WASM-based Geometric Quad Matcher
    // Prepare flattened tracking arrays for WASM iteration
    // [PHASE 1] CATALOG ASYMMETRY FIX: Strictly sort by flux descending
    const pSet = options.planetaryStarIds || new Set<number>();
    const detStarsPreTrail = detected
        .filter((_, i) => !pSet.has(i))
        .filter(s => Number.isFinite(s.x) && Number.isFinite(s.y)) // NaN coords panic the WASM solvers
        // Hot-pixel hygiene: single-pixel spikes (fwhm < 1px) top the flux
        // ranking on uncooled high-ISO DSLR frames and poison the quad
        // geometry; blown blobs (fwhm > 40px) are clouds/foreground. Stars
        // without a measured fwhm pass (caller-provided sets may omit it).
        .filter(s => s.fwhm === undefined || (s.fwhm >= 1.0 && s.fwhm <= 40))
        // Ultra-wide patch: quads built from edge stars violate the similarity
        // model (gnomonic sec^2 scale growth) — keep quad stars central. Radius
        // measured in the lens-prior matching frame (mX/mY vs the undistorted
        // patch origin); native + native when no prior → byte-identical.
        .filter(s => !patchActive || Math.hypot(mX(s) - patchCx, mY(s) - patchCy) <= patchRadiusPx)
        .sort((a, b) => (b.flux || 0) - (a.flux || 0))
        // Sky-component cull: quad stars must come from the connected dense
        // region (foreground lights live in isolated density islands) —
        // EXCEPT the brightest few. A saturated planet blooms into a cluster
        // of detections whose grid cell exceeds the junk-density ceiling: the
        // 6-deg run silently dropped Jupiter (flux 130 vs next 5.0), the best
        // anchor in the frame. Top-flux detections already survived the fwhm
        // and trail filters; noise-density statistics do not apply to them.
        .filter((s, idx) => idx < 8 || !skyCells || skyCells.has(cellOf(s.x, s.y)));

    // AIRCRAFT/SATELLITE TRAIL REJECTION. Strobe dashes are bright, compact
    // point sources that OUT-FLUX real stars on wide-field frames (the beach
    // frame's quad pool was Jupiter + plane dashes), and they are collinear
    // with near-regular spacing — a signature genuine star fields do not
    // produce. Scan the quad candidate pool for >=4 points within 2.5px of a
    // common line with consecutive spacings within 3.5x (tolerates one missed
    // dash), and drop the members before quad selection. Verification is
    // unaffected (it sees all detections).
    const trailPool = detStarsPreTrail.slice(0, 60);
    const trailMembers = new Set<number>();
    for (let i = 0; i < trailPool.length; i++) {
        for (let j = i + 1; j < trailPool.length; j++) {
            if (trailMembers.has(i) || trailMembers.has(j)) continue;
            const ax = trailPool[i].x, ay = trailPool[i].y;
            const dxl = trailPool[j].x - ax, dyl = trailPool[j].y - ay;
            const len = Math.hypot(dxl, dyl);
            if (len < 30) continue;
            const ux = dxl / len, uy = dyl / len;
            const members: { k: number; t: number }[] = [];
            for (let k = 0; k < trailPool.length; k++) {
                if (trailMembers.has(k)) continue;
                const px = trailPool[k].x - ax, py = trailPool[k].y - ay;
                if (Math.abs(px * uy - py * ux) <= 2.5) members.push({ k, t: px * ux + py * uy });
            }
            if (members.length >= 4) {
                members.sort((a, b) => a.t - b.t);
                let minGap = Infinity, maxGap = 0;
                for (let g = 1; g < members.length; g++) {
                    const gap = members[g].t - members[g - 1].t;
                    minGap = Math.min(minGap, gap); maxGap = Math.max(maxGap, gap);
                }
                if (minGap > 5 && maxGap / minGap < 3.5) {
                    members.forEach(m => trailMembers.add(m.k));
                }
            }
        }
    }
    if (trailMembers.size > 0) {
        console.log(`[PlateSolver] [TRAIL] Rejected ${trailMembers.size} collinear strobe/trail detections from the quad pool.`);
    }
    const detStars = trailPool
        .filter((_, idx) => !trailMembers.has(idx))
        .concat(detStarsPreTrail.slice(60))
        .slice(0, PC.SOLVER_MAX_DET_STARS);

    const detX = new Float64Array(detStars.length);
    const detY = new Float64Array(detStars.length);
    const detIds = new Float64Array(detStars.length);
    for (let i = 0; i < detStars.length; i++) {
        // Lens-prior: the WASM quad matcher receives UN-DISTORTED matching coords
        // (mX/mY) so codes align with the rectilinear catalog quads (catX/catY,
        // projected about the undistorted patch origin). detIds still maps by
        // object identity to the ORIGINAL detected[] (native coords for
        // photometry). No prior → mX/mY == native → byte-identical.
        detX[i] = mX(detStars[i]);
        detY[i] = mY(detStars[i]);
        detIds[i] = detected.indexOf(detStars[i]); // Original index in the full detected array
    }

    // [PHASE 1] CATALOG ASYMMETRY FIX: Strictly sort by magnitude ascending.
    // FIELD FILTER: this attempt hypothesizes the image is centered at ra0/dec0,
    // so only catalog stars within ~1.2x the frame half-diagonal of the center
    // can appear in the image (any rotation). Region-wide stars outside that
    // circle waste the quad budget and flood the matcher with false pairs.
    // Offset hypotheses are handled by the searchCenters loop, not here.
    const halfDiagPx = Math.hypot(imageW, imageH) / 2;
    // Ultra-wide patch caps the catalog quad field to match the det patch.
    const fieldRadiusPx = Math.min(halfDiagPx * 1.2, patchRadiusPx);
    // Quad count is C(n,4): 50 stars = 230k catalog quads (fast); 100 = 3.9M (minutes).
    const CAT_QUAD_BUDGET = 50;
    const catSubset = catalogPixels
        .map((p, i) => ({ ...p, originalIndex: i }))
        .filter(p => ((p.x - patchCx) ** 2 + (p.y - patchCy) ** 2) <= fieldRadiusPx ** 2)
        .sort((a, b) => (a.star.magnitude_V ?? 99) - (b.star.magnitude_V ?? 99))
        .slice(0, CAT_QUAD_BUDGET);

    const catX = new Float64Array(catSubset.length);
    const catY = new Float64Array(catSubset.length);
    const catIds = new Float64Array(catSubset.length);
    for (let i = 0; i < catSubset.length; i++) {
        catX[i] = catSubset[i].x;
        catY[i] = catSubset[i].y;
        catIds[i] = (catSubset[i] as any).originalIndex ?? i; // Index into catalogPixels
    }

    // ── DIAGNOSTIC DUMP ─────────────────────────────────────────────
    const inFrame = catalogPixels.filter(p => p.x >= 0 && p.x < imageW && p.y >= 0 && p.y < imageH).length;
    const fmt = (v: number) => Math.round(v * 10) / 10;
    console.log(
        `[PlateSolver] trySolveAtCenter(${options.strategy || 'planar_local'}) @ RA ${ra0.toFixed(3)}h Dec ${dec0.toFixed(2)}: ` +
        `${detStars.length} det stars (of ${detected.length}), ${catalogStars.length} catalog in region ` +
        `(${catSubset.length} used, ${inFrame} inside ${imageW}x${imageH} frame), scale ${pixelScale.toFixed(2)}"/px, radius ${searchRadius} deg`
    );
    console.log(`[PlateSolver]   det top8: ${detStars.slice(0, 8).map(s => `(${fmt(s.x)},${fmt(s.y)} f=${(s.flux||0).toExponential(1)} w=${fmt(s.fwhm||0)})`).join(' ')}`);
    console.log(`[PlateSolver]   cat top8: ${catSubset.slice(0, 8).map(c => `(${fmt(c.x)},${fmt(c.y)} m=${fmt((c.star.magnitude_V ?? 99))})`).join(' ')}`);

    // Implement Iterative tolerance Search
    let tolerances = options.iterativetolerances;
    if (!tolerances) {
        if (quadtolerance >= 0.10) {
            tolerances = [0.02, 0.05, 0.08, quadtolerance];
        } else if (quadtolerance > 0.03) {
            tolerances = [0.01, 0.03, quadtolerance];
        } else {
            tolerances = [0.01, 0.02, 0.03]; // Tightened from 0.03
        }
    }
    let matches: { detectedIdx: [number, number, number, number]; catalogIdx: any; error?: number }[] = [];

    // --- FORENSIC HEURISTIC (DE-DUPLICATED) ---
    // Legacy Ridge logic removed. Handled by strategy switch below.

    // THE CORE FIX: Verification Loop is now inside the tolerance Expansion Loop.
    // [WASM MIGRATION]: Replaced JS quad hashing and $O(N)$ matcher with a single synchronous call.
    const wasm = await import('@/engine/wasm_compute/pkg/wasm_compute');
    await wasm.default(); // Initialize WASM memory
    const wasmStartTime = performance.now();
    
    let flatMatches: Float64Array;

    const strategy = options.strategy || 'planar_local';
    // Real pitch when the caller supplies it; the 3.9um literal was wrong even
    // for its namesake (Rebel T6 is 4.30um) — a 10% chord error vs 1% hash
    // buckets meant near-zero hash hits for spherical (audit P2.4).
    const PIXEL_PITCH_MM = options.pixelPitchUm ? options.pixelPitchUm / 1000 : 0.0039;

    const cx = options.hardwareProfile?.optical_center?.x ?? imageW / 2;
    const cy = options.hardwareProfile?.optical_center?.y ?? imageH / 2;

    if (strategy === 'spherical_global') {
        // HONEST GUARD (audit P2): without a known observer the Rust side
        // gates its visible-star set by altitude at lat/lon 0,0 "now" —
        // conceptually undefined, and the uncapped quad build can hang on
        // wide fields. Skip with a recorded reason until the Rust cap +
        // observer plumbing land together.
        if (!options.observer) {
            console.log('[PlateSolver] [STRATEGY] spherical_global skipped: no observer location (visibility gating undefined without it).');
            diagnostics.rejection_reasons.push('spherical_global skipped: no observer');
            return { success: false, diagnostics };
        }
        const focal = options.focalLengthMm || 50;
        const lat = options.observer?.lat || 0;
        const lon = options.observer?.lon || 0;
        const jd = TimeService.toJulianDate(options.timestamp || new Date());
        flatMatches = (wasm as any).solve_spherical_global(
            detX, detY, focal, PIXEL_PITCH_MM, cx, cy, lat, lon, jd, quadtolerance
        );
    } else if (strategy === 'ridge_directed' && options.directedAnchor) {
        // Ridge scanner assumes gnomonic-projected catalog positions
        const catXi = new Float64Array(catSubset.map(c => catalogProjected[c.originalIndex].xi * (3600 / pixelScale)));
        const catEta = new Float64Array(catSubset.map(c => catalogProjected[c.originalIndex].eta * (3600 / pixelScale)));
        
        flatMatches = (wasm as any).solve_ridge_directed(
            detX, detY, catXi, catEta, 
            options.directedAnchor.x, options.directedAnchor.y,
            2.0, 5.0, 0.5, 30.0 // coarse_step, fine_range, fine_step, match_radius_px
        );
    } else {
        // Default: Planar Local (Tool B)
        // NOTE: the Rust max_stars param clamps BOTH input arrays. The det side
        // is already sliced to SOLVER_MAX_DET_STARS above; pass the larger cat
        // budget so the catalog side is not re-clamped to 30 (which starves the
        // in-frame overlap when the search region is much wider than the frame).
        flatMatches = (wasm as any).solve_planar_local(
            detX, detY, detIds,
            catX, catY, catIds,
            new Float64Array(tolerances),
            Math.max(PC.SOLVER_MAX_DET_STARS, PC.SOLVER_MAX_CAT_STARS),
            options.loggerCallback
        );
    }

    const wasmTimeMs = performance.now() - wasmStartTime;
    // A3: record this WASM quad-matcher attempt (real ms, win or lose) for the
    // flowchart branch box. Bucketed per trySolveAtCenter call across the sweep.
    accrueBranchTiming(diagnostics, 'solve.quad_wasm', wasmTimeMs);
    if (wasmTimeMs > 3000) {
        console.warn(`[PlateSolver] WASM ${strategy} took ${wasmTimeMs.toFixed(0)}ms — consider reducing star counts or checking input quality.`);
    }

    // ═══ [__ForTest][UW-DEBUG] ultra-wide known-answer harness hooks ═════
    // Dev-global-gated instrumentation for the ultra-wide CR2 investigation
    // (driven by test_results/tmp_uw_capture.mjs via Playwright). Inert unless
    // a capture script sets the globals. Safe to delete wholesale.
    //   __UW_DUMP {ra_hours, dec_degrees}: stash exact matcher inputs +
    //       candidates for offline forensics into __UW_DUMPED.
    //   __UW_INJECT_WCS {crpix, crval, cd, ...gate}: run the REAL verifyWCS
    //       with an externally constructed WCS against production inputs.
    {
        const uwDbg: any = globalThis as any;
        const uwHere = (hook: any) => hook && patchActive
            && Math.abs(ra0 - hook.ra_hours) < 0.05 && Math.abs(dec0 - hook.dec_degrees) < 0.3;
        if (uwHere(uwDbg.__UW_DUMP) && strategy === 'planar_local' && !uwDbg.__UW_DUMPED) {
            uwDbg.__UW_DUMPED = {
                ra0, dec0, pixelScale, imageW, imageH, patchCx, patchCy, patchRadiusPx, tolerances,
                detected: detected.map(d => ({ x: d.x, y: d.y, flux: d.flux, fwhm: d.fwhm })),
                detPool: Array.from(detIds),
                catPool: Array.from(catIds),
                catalogPixels: catalogPixels.map(cp => ({
                    x: cp.x, y: cp.y, ra_hours: cp.star.ra_hours, dec_degrees: cp.star.dec_degrees,
                    mag: cp.star.magnitude_V, gaia_id: (cp.star as any).gaia_id, name: cp.star.name })),
                catalogStars: catalogStars.map(st => ({
                    ra_hours: st.ra_hours, dec_degrees: st.dec_degrees,
                    magnitude_V: st.magnitude_V, gaia_id: (st as any).gaia_id, name: st.name })),
                flatMatches: Array.from(flatMatches),
            };
            console.log(`[PlateSolver] [UW-DUMP] captured @ RA ${ra0.toFixed(3)}h Dec ${dec0.toFixed(2)}: ${detected.length} det, ${catalogStars.length} cat, ${flatMatches.length / 9} candidates.`);
        }
        if (uwHere(uwDbg.__UW_INJECT_WCS) && !uwDbg.__UW_INJECT_RESULT) {
            const inj = uwDbg.__UW_INJECT_WCS;
            const injWcs: WCSTransform = { crpix: inj.crpix, crval: inj.crval, cd: inj.cd };
            console.log(`[PlateSolver] [UW-INJECT] running verifyWCS with injected WCS at RA ${ra0.toFixed(3)}h Dec ${dec0.toFixed(2)}...`);
            const injVerified = await verifyWCS(injWcs, detected, catalogStars, imageData, imageW, imageH, ra0, dec0, maxvariance, options, pixelScale, 0, diagnostics);
            uwDbg.__UW_INJECT_RESULT = injVerified ? {
                pass: true, ra_hours: injVerified.ra_hours, dec_degrees: injVerified.dec_degrees,
                pixel_scale: injVerified.pixel_scale, rotation: injVerified.rotation,
                parity: injVerified.parity, confidence: injVerified.confidence, num_stars: injVerified.num_stars,
            } : { pass: false };
            console.log(`[PlateSolver] [UW-INJECT] verdict: ${injVerified ? 'PASS' : 'FAIL'} ${JSON.stringify(uwDbg.__UW_INJECT_RESULT)}`);
        }
    }
    // ═══ end [__ForTest][UW-DEBUG] ═══════════════════════════════════════

    // Handle Ridge Results specifically (not quads)
    if (strategy === 'ridge_directed' && flatMatches.length === 3) {
        const [rotation, parity, consensus] = Array.from(flatMatches);
        if (consensus >= PC.SOLVER_MIN_RIDGE_CONSENSUS) {
             const solution = {
                 ra: ra0 * 15, dec: dec0, ra_hours: ra0, dec_degrees: dec0,
                 pixel_scale: pixelScale, rotation, parity,
                 wcs: SkyTransform.createWCSTransform(ra0, dec0, pixelScale, rotation, parity, [options.directedAnchor!.x, options.directedAnchor!.y]),
                 num_stars: consensus
             };
             const verified = await verifyWCS(solution.wcs, detected, catalogStars, imageData, imageW, imageH, ra0, dec0, maxvariance, options, pixelScale);
             if (verified) return { success: true, solution: verified, diagnostics };
        }
        return { success: false, diagnostics };
    }

    if (strategy === 'spherical_global') {
        for (let i = 0; i < flatMatches.length; i += 13) {
            const dIdxs = [flatMatches[i], flatMatches[i+1], flatMatches[i+2], flatMatches[i+3]];
            const raDecs = [
                { ra: flatMatches[i+4] * (12.0 / Math.PI), dec: flatMatches[i+5] * (180.0 / Math.PI) },
                { ra: flatMatches[i+6] * (12.0 / Math.PI), dec: flatMatches[i+7] * (180.0 / Math.PI) },
                { ra: flatMatches[i+8] * (12.0 / Math.PI), dec: flatMatches[i+9] * (180.0 / Math.PI) },
                { ra: flatMatches[i+10] * (12.0 / Math.PI), dec: flatMatches[i+11] * (180.0 / Math.PI) }
            ];
            
            // For spherical results, we store the absolute celestial data directly
            matches.push({
                detectedIdx: dIdxs as [number, number, number, number],
                catalogIdx: raDecs as any, // Specialized format for spherical
                error: flatMatches[i+12]
            });
        }
    } else {
        for (let i = 0; i < flatMatches.length; i += 9) {
            const d0 = flatMatches[i];
            const d1 = flatMatches[i+1];
            const d2 = flatMatches[i+2];
            const d3 = flatMatches[i+3];

            const cx0 = flatMatches[i+4];
            const cx1 = flatMatches[i+5];
            const cx2 = flatMatches[i+6];
            const cx3 = flatMatches[i+7];

            // catIds carry originalIndex into catalogPixels/catalogProjected
            // (assigned pre-sort — see catSubset construction). The old mapCat
            // indexed catSubset (the 50-star budget list) with these REGION-wide
            // indices: cIdx<50 returned a different, brighter star's gaia_id and
            // skyPairs got the wrong sky position (consistent ~6x scale blowup;
            // every candidate died at the scale gate). Keep the index numeric —
            // the skyPairs lookup below resolves catalogProjected[cIdx] directly.
            const mapCat = (cIdx: number) => cIdx;

            matches.push({
                detectedIdx: [d0, d1, d2, d3],
                catalogIdx: [mapCat(cx0), mapCat(cx1), mapCat(cx2), mapCat(cx3)],
                error: flatMatches[i+8]
            });
        }
    }

    if (matches.length < 1) {
        console.warn(`[PlateSolver]   ${strategy}: WASM matcher returned 0 candidate quads in ${wasmTimeMs.toFixed(1)}ms (tolerances tried: ${tolerances.join(', ')}).`);
        diagnostics.rejection_reasons.push('No WASM Quad Matches');
        return { success: false, diagnostics };
    }

    console.log(`[PlateSolver] WASM Match Loop: Found ${matches.length} candidates in ${(wasmTimeMs).toFixed(2)}ms. Best Error: ${matches[0].error?.toFixed(6)}`);

    if (options.directedAnchor) {
        matches = matches.filter(m => {
            const s0 = detected[m.detectedIdx[0]];
            const s1 = detected[m.detectedIdx[1]];
            const s2 = detected[m.detectedIdx[2]];
            const s3 = detected[m.detectedIdx[3]];
            const dAnchor = (s: DetectedStar) => Math.sqrt((s.x - options.directedAnchor!.x)**2 + (s.y - options.directedAnchor!.y)**2);
            return dAnchor(s0) < PC.SOLVER_ANCHOR_PROXIMITY_PX || dAnchor(s1) < PC.SOLVER_ANCHOR_PROXIMITY_PX || dAnchor(s2) < PC.SOLVER_ANCHOR_PROXIMITY_PX || dAnchor(s3) < PC.SOLVER_ANCHOR_PROXIMITY_PX;
        });
    }


    // Ultra-wide verification runs in TS (radius-scaled net) and costs more
    // per candidate than the WASM loop — cap the candidate list there. True
    // candidates rank early by quad error; the deep tail is noise.
    const MAX_MATCH_ATTEMPTS = patchActive
        ? Math.min(40, PC.SOLVER_MAX_MATCH_ATTEMPTS)
        : PC.SOLVER_MAX_MATCH_ATTEMPTS;

    matches.sort((a, b) => (a.error || 0) - (b.error || 0));
    const candidates = matches.slice(0, MAX_MATCH_ATTEMPTS);
        
        for (let idx = 0; idx < candidates.length; idx++) {
            const match = candidates[idx];
            const pixelPairs: { x: number; y: number }[] = [];
            const skyPairs: { xi: number; eta: number }[] = [];

            for (let i = 0; i < 4; i++) {
                const dIdx = match.detectedIdx[i];
                const cVal = match.catalogIdx[i];
                
                pixelPairs.push({ x: (detected as any)[dIdx].x, y: (detected as any)[dIdx].y });
                
                if (strategy === 'spherical_global') {
                    // cVal is { ra: number, dec: number }
                    const star = cVal as any as { ra: number, dec: number };
                    // For fitting, we need xi/eta. Use first star as center.
                    const r0 = (match.catalogIdx[0] as any).ra;
                    const d0 = (match.catalogIdx[0] as any).dec;
                    const proj = SkyTransform.gnomonicProject(star.ra, star.dec, r0, d0);
                    skyPairs.push({ xi: proj.xi, eta: proj.eta });
                    // Update RA/Dec 0 for WCS fit
                    (match as any).fit_center = { ra: r0, dec: d0 };
                } else if (typeof cVal === 'number') {
                    skyPairs.push({ xi: catalogProjected[cVal].xi, eta: catalogProjected[cVal].eta });
                } else {
                    // Find by gaia_id in catalogProjected
                    const catHit = catalogProjected.find(cp => cp.star.gaia_id === cVal);
                    if (catHit) {
                        skyPairs.push({ xi: catHit.xi, eta: catHit.eta });
                    } else {
                        // Skip if missing
                        continue;
                    }
                }
            }

            if (pixelPairs.length < 4) continue;

            // Fit WCS from the matched quad
            const crpix: [number, number] = [imageW / 2, imageH / 2];
            const fitRA = (match as any).fit_center?.ra ?? ra0;
            const fitDec = (match as any).fit_center?.dec ?? dec0;

            // â”€â”€ PHASE 1: SCALE GATE â”€â”€
            const quadWCS = SkyTransform.fitWCS(pixelPairs.slice(0,3), skyPairs.slice(0,3), crpix, fitRA, fitDec);
            const quadScale = SkyTransform.pixelScaleFromCD(quadWCS?.cd || [[0,0],[0,0]]);
            
            // Log forensic attempt
            const forensicEntry = {
                candidate_idx: idx,
                quad_error: match.error,
                inferred_scale: quadScale,
                status: 'SOLVING'
            };

            if (options.scaleLock && quadScale > 0) {
                const error = Math.abs(quadScale - pixelScale) / pixelScale;
                const limit = maxvariance * (pixelScale > 10 ? 2.5 : 1.5);
                if (error > limit) {
                    if (idx < 5) console.log(`[PlateSolver] Forensic: Candidate ${idx} rejected by Scale Gate: Inferred ${quadScale.toFixed(2)}"/px vs Expected ${pixelScale.toFixed(2)}"/px (Error: ${(error*100).toFixed(1)}%)`);
                    diagnostics.forensics?.push({ ...forensicEntry, status: 'REJECTED_SCALE_GATE', error: (error*100).toFixed(1) + '%' });
                    continue; // culled immediately
                }
            }

            const wcs = SkyTransform.fitWCS(pixelPairs, skyPairs, crpix, fitRA, fitDec);
            if (!wcs) {
                diagnostics.forensics?.push({ ...forensicEntry, status: 'REJECTED_FIT_FAILED' });
                continue;
            }

            const verified = await verifyWCS(wcs, detected, catalogStars, imageData, imageW, imageH, fitRA, fitDec, maxvariance, options, pixelScale, idx, diagnostics);
            if (verified) {
                diagnostics.forensics?.push({ ...forensicEntry, status: 'SUCCESS' });
                console.log(`[PlateSolver] [LOCK] Geometry Locked via WASM match!`);
                return { success: true, solution: verified, diagnostics };
            } else {
                if (idx < 3) console.log(`[PlateSolver]   Candidate ${idx} (quad err ${match.error?.toExponential(2)}, inferred ${quadScale.toFixed(2)}"/px) rejected by verifyWCS.`);
                diagnostics.forensics?.push({ ...forensicEntry, status: 'REJECTED_VERIFY_FAILED' });
            }
        }

    console.log(`[PlateSolver] [FAIL] All ${candidates.length} WASM candidates failed verification. Search exhausted.`);
    return { success: false, diagnostics };
}

/**
 * Verification threshold selection for verifyWCS — pure and unit-testable.
 * Defaults reproduce the historical wide-field behavior exactly:
 *   quad-lock -> 4 matches @ 1%; sparse (<cutoff) -> 3 @ 40%; dense -> 5 @ 60%.
 * Optional tuning only relaxes the dense-field branch (quad-lock and sparse
 * branches are intentionally untouched).
 */
export function resolveVerifyThresholds(
    isQuadLock: boolean,
    detectedCount: number,
    tuning?: { minAnchorMatches?: number; minConfidence?: number; denseFieldCutoff?: number }
): { minAnchorMatches: number; minConfidence: number } {
    const cutoff = tuning?.denseFieldCutoff ?? 20;
    const minAnchorMatches = isQuadLock ? 4 : (detectedCount < cutoff ? 3 : (tuning?.minAnchorMatches ?? 5));
    const minConfidence = isQuadLock ? 0.01 : (detectedCount < cutoff ? 0.4 : (tuning?.minConfidence ?? 0.6));
    return { minAnchorMatches, minConfidence };
}

/** * Verify a WCS candidate and promote it to a full PlateSolution.
 * This is the shared 'judge' for both quad-matches and ridge-matches.
 */
async function verifyWCS(
    wcs: WCSTransform,
    detected: DetectedStar[],
    catalogStars: StandardStar[],
    imageData: ImageData,
    imageW: number,
    imageH: number,
    ra0: number,
    dec0: number,
    maxvariance: number,
    options: SolverOptions,
    expectedScale?: number,
    matchIndex?: number,
    diagnostics?: SolveDiagnostics,
    tweakDepth: number = 0
): Promise<PlateSolution | null> {
    const matchedStars: MatchedStar[] = [];
    
    // Safety: silence logs for lower-confidence candidates during blind search
    const silenceLogs = matchIndex !== undefined && matchIndex >= 20;
    
    // FLAW #4 FIX: Runaway Verification Radius
    // Use the expected ground-truth scale (if known) to define the search net.
    // Otherwise, false quads with crazy scales (e.g., 7000"/px) will cast a 20-degree net,
    // catch every star by accident, and falsely report a 100% lock!
    const safeScale = expectedScale || SkyTransform.pixelScaleFromCD(wcs.cd);
    // [FIX 5] Cap the dynamic search radius to prevent hallucinations from inflating confidence
    const dynamicVerifyRadiusArcsec = Math.min(PC.SOLVER_MAX_VERIFY_RADIUS_ARCSEC, Math.max(PC.SOLVER_VERIFICATION_RADIUS_ARCSEC, safeScale * 15.0));
    const verifyRadius = dynamicVerifyRadiusArcsec / 3600; // degrees

    // 1. OPTICAL AXIS (Dictates distortion manifold)
    const opticalCenterX = options.hardwareProfile?.optical_center?.x ?? imageW / 2;
    const opticalCenterY = options.hardwareProfile?.optical_center?.y ?? imageH / 2;

    // 2. PROJECTION ORIGIN (The geometric lock point, e.g. Jupiter)
    const projCenterX = wcs.crpix[0];
    const projCenterY = wcs.crpix[1];

    // Ultra-wide fields cap the anchor to the central-patch radius: the quad
    // fit only saw central stars, the catalog fetch only covered ~1.5x the
    // patch, and real lens distortion at 40+ deg off-axis exceeds the verify
    // net anyway. Judge the lock where the model and the data both exist.
    let innerRadiusPx = Math.min(imageW, imageH) * PC.SOLVER_VERIFY_INNER_RADIUS_FRAC;
    const verifyFovDiagDeg = Math.hypot(imageW, imageH) * safeScale / 3600;
    if (Number.isFinite(verifyFovDiagDeg) && verifyFovDiagDeg > PC.SOLVER_WIDE_PATCH_MIN_FOV_DEG) {
        innerRadiusPx = Math.min(innerRadiusPx, PC.SOLVER_WIDE_VERIFY_ANCHOR_DEG * 3600 / safeScale);
    }

    // [SCHEMA A · COORDINATE ledger] Optional 2D residual vector (det − predicted,
    // pixel space) captured alongside the scalar residual. Additive: residual_arcsec
    // is UNCHANGED (still the caller's scalar), so the sacred solve stays byte-
    // identical; the vector is a pure observation the step-6 quiver / refraction
    // vertical consume. Parity is derived downstream through the WCS — never asserted.
    const pushMatch = (det: DetectedStar, cat: StandardStar, residualArcsec: number, residualVec?: { dx: number; dy: number }) => {
        matchedStars.push({
            detected: { ...det },
            catalog: {
                ra: cat.ra_hours * 15,
                dec: cat.dec_degrees,
                mag: cat.magnitude_V,
                bv: cat.color_index_BV,
                ra_hours: cat.ra_hours,
                dec_degrees: cat.dec_degrees,
                name: cat.name,
                gaia_id: cat.gaia_id,
                magnitude_V: cat.magnitude_V,
                band: cat.band, // [SCHEMA B] carry the per-row catalog band tag
                spectral_signature: (cat as any).spectral_signature
            },
            residual_arcsec: residualArcsec,
            ...(residualVec && Number.isFinite(residualVec.dx) && Number.isFinite(residualVec.dy)
                ? { residual: { dx: residualVec.dx, dy: residualVec.dy } }
                : {}),
        });
    };

    const ultraWide = Number.isFinite(verifyFovDiagDeg) && verifyFovDiagDeg > PC.SOLVER_WIDE_PATCH_MIN_FOV_DEG;
    let uwExpectedChance = 0;
    let uwChanceVar = 0;       // Σ p(1-p): Bernoulli variance of the chance model
    let uwInFrameBright = 0;   // bright verify rows landing in frame (scales the unique floor)
    let uwSigmaValue = 0;      // excess sigma, reused for the ultra-wide confidence
    if (ultraWide) {
        // [ULTRA-WIDE TS VERIFY] Consumer wide lenses carry radial distortion
        // that grows with distance from the OPTICAL AXIS — ground-truthed on
        // the 14mm beach frame: true matches sit at 12-48px native where the
        // fixed net is 15px, so the WASM verifier (single radius) fails
        // genuine solves. Match in TS with a radius-scaled net:
        //   tol(r_optical) = max(fixed net, SLOPE * r_optical)
        // SLOPE 0.035 measured by the rotation brute-forcer that identified
        // the Teapot stars. All downstream gates (anchor confidence, sparse
        // guard, scale boundaries, variance, tweak) apply unchanged.
        const WIDE_NET_SLOPE = VERIFY_NET.WIDE_NET_SLOPE;
        const baseNetPx = dynamicVerifyRadiusArcsec / Math.max(1e-6, safeScale);
        const cdDetV = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0];
        if (Math.abs(cdDetV) < 1e-18) return null;
        const invV = [
            [wcs.cd[1][1] / cdDetV, -wcs.cd[0][1] / cdDetV],
            [-wcs.cd[1][0] / cdDetV, wcs.cd[0][0] / cdDetV],
        ];
        // Spatial grid over detections: match candidates live within tol of a
        // predicted position; cell size >= max plausible tol keeps the probe
        // to 9 cells.
        const cell = Math.max(64, Math.ceil(WIDE_NET_SLOPE * Math.hypot(imageW, imageH) / 2));
        const grid = new Map<number, number[]>();
        const gw = Math.ceil(imageW / cell);
        for (let i = 0; i < detected.length; i++) {
            const gx = Math.floor(detected[i].x / cell), gy = Math.floor(detected[i].y / cell);
            const key = gy * gw + gx;
            const bucket = grid.get(key);
            if (bucket) bucket.push(i); else grid.set(key, [i]);
        }
        // Cheap angular prescreen before the trig-heavy projection: only
        // catalog stars within the frame half-diagonal of crval can land in
        // frame. Without this, 200 candidates x full catalog x 118 centers
        // of synchronous projection blocked the main thread for minutes.
        const halfDiagDeg = verifyFovDiagDeg / 2 + 2;
        const cosDec0 = Math.cos((wcs.crval[1] * Math.PI) / 180);
        let dbgPrescreen = 0, dbgInFrame = 0, dbgNearest = Infinity;
        // BRIGHT COMPLETENESS SUBSET (SOLVER_UW_VERIFY_MAG_LIMIT). Known-answer
        // injection of the brute-forced ground-truth WCS proved the previous
        // "brightest 3x detections" subset (6681 rows to mag ~10.2 here)
        // statistically BLIND: the TRUE WCS scored -7.5 sigma / z=-0.2 vs
        // decoy rotations, because chance matches on thousands of mag 10+
        // deep-sector rows (~2.7px mean spacing in the patch) drown the real
        // signal. An ultra-wide rig detects only the bright end completely;
        // at mag<6.0 the same WCS separates from decoys at z=+6.4..+7.4
        // (test_results/tmp_uw_magcut_sweep.mjs). Count-capped for safety on
        // Milky-Way-core fetches.
        let verifyCat: StandardStar[] = catalogStars
            .filter(s => (s.magnitude_V ?? 99) < PC.SOLVER_UW_VERIFY_MAG_LIMIT);
        const verifyCatCap = 500;
        if (verifyCat.length > verifyCatCap) {
            verifyCat = verifyCat
                .sort((a, b) => (a.magnitude_V ?? 99) - (b.magnitude_V ?? 99))
                .slice(0, verifyCatCap);
        }
        // Chance-match budget: with radius-scaled nets a dense catalog
        // matches ~20% of noise by accident (measured: 189-292 "matches" on
        // garbage candidates). Accumulate the Poisson expectation per star;
        // acceptance below demands a many-sigma EXCESS over it.

        for (const cat of verifyCat) {
            const dDec = Math.abs(cat.dec_degrees - wcs.crval[1]);
            if (dDec > halfDiagDeg) continue;
            let dRaH = Math.abs(cat.ra_hours - wcs.crval[0]);
            if (dRaH > 12) dRaH = 24 - dRaH;
            if (dRaH * 15 * cosDec0 > halfDiagDeg) continue;
            dbgPrescreen++;
            const p = SkyTransform.gnomonicProject(cat.ra_hours, cat.dec_degrees, wcs.crval[0], wcs.crval[1]);
            if (!Number.isFinite(p.xi) || !Number.isFinite(p.eta)) continue;
            const px = wcs.crpix[0] + invV[0][0] * p.xi + invV[0][1] * p.eta;
            const py = wcs.crpix[1] + invV[1][0] * p.xi + invV[1][1] * p.eta;
            if (px < 0 || px >= imageW || py < 0 || py >= imageH) continue;
            dbgInFrame++;
            const rOptical = Math.hypot(px - opticalCenterX, py - opticalCenterY);
            const tol = Math.max(baseNetPx, WIDE_NET_SLOPE * rOptical);
            let bestIdx = -1, bestD = tol;
            // [SCHEMA A] signed residual components (det − predicted, px) for the
            // winning candidate. hypot(bestDx,bestDy) === bestD by construction, so
            // the receipt's residual_arcsec (bestD·safeScale) equals hypot·scale exactly.
            let bestDx = 0, bestDy = 0;
            let localCount = 0;
            const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const bucket = grid.get((gy + dy) * gw + gx + dx);
                if (!bucket) continue;
                localCount += bucket.length;
                for (const i of bucket) {
                    const ddx = detected[i].x - px, ddy = detected[i].y - py;
                    const d = Math.hypot(ddx, ddy);
                    if (d < bestD) { bestD = d; bestIdx = i; bestDx = ddx; bestDy = ddy; }
                    if (d < dbgNearest) dbgNearest = d;
                }
            }
            // LOCAL chance budget: detections are anything but uniform on
            // nightscapes (sky dense, foreground empty) — a global-density
            // null model overestimated chance 2x and scored garbage at -10
            // sigma. The 3x3 probe neighbourhood measures the local rate the
            // matcher actually samples from.
            const localDensity = localCount / (9 * cell * cell);
            // P(>=1 detection within tol) under the local Poisson null is
            // 1-e^-lambda, NOT min(1, lambda): the raw rate overstates chance
            // by 25%+ at lambda ~0.2-1 (routine with radius-scaled nets),
            // which buried EVERY candidate — ground truth included — below
            // zero sigma. Variance of a Bernoulli sum is Σ p(1-p), not Σ p.
            const uwLambda = localDensity * Math.PI * tol * tol;
            const uwPChance = 1 - Math.exp(-uwLambda);
            uwExpectedChance += uwPChance;
            uwChanceVar += uwPChance * (1 - uwPChance);
            if (bestIdx >= 0) pushMatch(detected[bestIdx], cat, bestD * safeScale, { dx: bestDx, dy: bestDy });
        }
        uwInFrameBright = dbgInFrame;
        if (!silenceLogs && (matchIndex ?? 0) <= 2) {
            console.log(`[PlateSolver] [TSVERIFY] funnel: ${catalogStars.length} cat -> ${verifyCat.length} bright -> ${dbgPrescreen} prescreen -> ${dbgInFrame} in-frame -> ${matchedStars.length} matched (baseNet ${baseNetPx.toFixed(1)}px, nearest miss ${Number.isFinite(dbgNearest) ? dbgNearest.toFixed(1) : 'n/a'}px, crval ${wcs.crval[0].toFixed(3)}h ${wcs.crval[1].toFixed(2)}, crpix ${wcs.crpix[0].toFixed(0)},${wcs.crpix[1].toFixed(0)})`);
        }
    } else {
        // WASM Verification Loop (narrow/normal fields — historical path)
        const wasm = await import('@/engine/wasm_compute/pkg/wasm_compute');
        await wasm.default();

        const detX = new Float64Array(detected.map(d => d.x));
        const detY = new Float64Array(detected.map(d => d.y));
        const catRa = new Float64Array(catalogStars.map(s => s.ra_hours));
        const catDec = new Float64Array(catalogStars.map(s => s.dec_degrees));
        const wasmCd = new Float64Array([wcs.cd[0][0], wcs.cd[0][1], wcs.cd[1][0], wcs.cd[1][1]]);

        const wasmResults = wasm.verify_astrometric_lock(
            detX, detY, catRa, catDec,
            wasmCd,
            new Float64Array([wcs.crval[0], wcs.crval[1]]),
            new Float64Array([wcs.crpix[0], wcs.crpix[1]]),
            verifyRadius
        ) as any as Float64Array;

        // [SCHEMA A · COORDINATE ledger] Recover the 2D residual vector (det −
        // predicted, px) for the WASM narrow path by re-projecting the matched
        // catalog star through the SAME solved WCS (gnomonic + inverse CD —
        // identical to deep_verify.projectCatalogToPixels). NO Rust ABI change
        // (internals owner-gated); residual_arcsec stays the wasm scalar UNCHANGED,
        // so the sacred solve is byte-identical.
        //   MEASURED DIVERGENCE (M66, 272 stars): the wasm scalar residual is a
        //   LINEAR small-angle sky-space approximation (solver_verification.rs:46-74
        //   deprojects det→sky with center cos(dec), no gnomonic tangent term), so it
        //   is EDGE-INFLATED. The gnomonic pixel-space vector here is the CORRECT
        //   astrometric residual: the two AGREE at field center (<0.3″) and diverge
        //   toward the corner (up to ~31″ at r≈2170px) — a documented projection-model
        //   difference, NOT a bug. Both are emitted (spec inc 3: "emit BOTH and
        //   document, never overwrite the wasm number"); the refraction vertical
        //   consumes the gnomonic vector.
        const cdDetW = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0];
        const canReproject = Math.abs(cdDetW) > 1e-18;
        const matchedCount = Math.round(wasmResults[2]);
        for (let i = 0; i < matchedCount; i++) {
            const offset = 4 + i * 3;
            const dIdx = Math.round(wasmResults[offset]);
            const cIdx = Math.round(wasmResults[offset + 1]);
            let residualVec: { dx: number; dy: number } | undefined;
            if (canReproject) {
                const cat = catalogStars[cIdx];
                const p = SkyTransform.gnomonicProject(cat.ra_hours, cat.dec_degrees, wcs.crval[0], wcs.crval[1]);
                if (Number.isFinite(p.xi) && Number.isFinite(p.eta)) {
                    const px = wcs.crpix[0] + (wcs.cd[1][1] * p.xi - wcs.cd[0][1] * p.eta) / cdDetW;
                    const py = wcs.crpix[1] + (-wcs.cd[1][0] * p.xi + wcs.cd[0][0] * p.eta) / cdDetW;
                    residualVec = { dx: detected[dIdx].x - px, dy: detected[dIdx].y - py };
                }
            }
            pushMatch(detected[dIdx], catalogStars[cIdx], wasmResults[offset + 2], residualVec);
        }
    }

    // FLAW #3 FIX: ANCHOR-CENTRIC LOCK VERIFICATION
    // We judge the lock density around the Tangent Point (Jupiter), NOT the optical center.
    const anchorMatches = matchedStars.filter(m => {
        const r = Math.sqrt((m.detected.x - projCenterX) ** 2 + (m.detected.y - projCenterY) ** 2);
        return r < innerRadiusPx;
    });

    const anchorDetections = detected.filter(d => {
        const r = Math.sqrt((d.x - projCenterX) ** 2 + (d.y - projCenterY) ** 2);
        return r < innerRadiusPx;
    });

    // ACHIEVABLE-MATCH CONFIDENCE. The naive metric (matches / ALL anchor
    // detections) punishes deep images: detections below the catalog mag
    // limit (faint stars, galaxy knots on long stacks) can never match, so
    // a PERFECT solve on a deep stack capped at ~40% and tripped the gate.
    // Denominator = min(anchor detections, catalog stars whose projected
    // position lands in the anchor region) — i.e. matches vs what is
    // achievable. Shallow images (detections < catalog) are unchanged.
    let catalogInAnchor = 0;
    let catalogInFrame = 0;
    const cdDet = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0];
    if (Math.abs(cdDet) > 1e-18) {
        const inv = [
            [wcs.cd[1][1] / cdDet, -wcs.cd[0][1] / cdDet],
            [-wcs.cd[1][0] / cdDet, wcs.cd[0][0] / cdDet],
        ];
        for (const s of catalogStars) {
            const p = SkyTransform.gnomonicProject(s.ra_hours, s.dec_degrees, wcs.crval[0], wcs.crval[1]);
            if (!Number.isFinite(p.xi) || !Number.isFinite(p.eta)) continue;
            const px = wcs.crpix[0] + inv[0][0] * p.xi + inv[0][1] * p.eta;
            const py = wcs.crpix[1] + inv[1][0] * p.xi + inv[1][1] * p.eta;
            if (px < 0 || px >= imageW || py < 0 || py >= imageH) continue;
            catalogInFrame++;
            const r = Math.sqrt((px - projCenterX) ** 2 + (py - projCenterY) ** 2);
            if (r < innerRadiusPx) catalogInAnchor++;
        }
    }
    const achievable = Math.max(1, catalogInAnchor > 0
        ? Math.min(anchorDetections.length, catalogInAnchor)
        : anchorDetections.length);
    // UNIQUE catalog stars: the verifier matches per-detection, so in sparse
    // narrow fields several detections can claim the same catalog star —
    // 7 matches over 6 achievable printed a 116.7% "confidence" on the S50
    // M51 field. Probabilities do not get to exceed 1.
    const catKey = (m: MatchedStar) => (m.catalog as any).gaia_id ?? `${m.catalog.ra_hours},${m.catalog.dec_degrees}`;
    const uniqueAnchorMatches = new Set(anchorMatches.map(catKey)).size;
    const anchorconfidence = Math.min(1, uniqueAnchorMatches / achievable);
    
    // QUAD-CENTRIC LOCK
    // Thresholds resolved via the pure helper; options.verifyTuning (narrow-FOV
    // knobs) only relaxes the dense-field branch. Absent = historical behavior.
    const isQuadLock = anchorMatches.length === 4;
    const { minAnchorMatches, minConfidence: minconfidence } =
        resolveVerifyThresholds(isQuadLock, detected.length, options.verifyTuning);

    if (ultraWide) {
        // ULTRA-WIDE ACCEPTANCE: statistical excess over the chance-match
        // budget, frame-wide. The anchor-disk gate is foreground-sensitive
        // on nightscapes (crpix sits wherever the quad landed — on the
        // beach frame that was the lifeguard tower) and the radius-scaled
        // net makes raw counts meaningless (garbage candidates "match" 200+
        // stars by chance). Poisson excess is region-free and
        // self-calibrating: garbage = ~0 sigma, a true solve = many sigma.
        const uwCatKey = (m: MatchedStar) => (m.catalog as any).gaia_id ?? `${m.catalog.ra_hours},${m.catalog.dec_degrees}`;
        const uwUnique = new Set(matchedStars.map(uwCatKey)).size;
        const uwSigma = (matchedStars.length - uwExpectedChance) / Math.max(1, Math.sqrt(uwChanceVar));
        uwSigmaValue = uwSigma;
        const UW_MIN_SIGMA = 5;
        // Unique floor scales with the bright rows actually in frame: the
        // fixed 30 was sized for the retired 6k-row verify soup; the bright
        // subset is ~100-150 rows of which a true solve matches ~40%.
        const UW_MIN_UNIQUE = Math.max(12, Math.min(30, Math.round(0.12 * uwInFrameBright)));
        // -- UW FIT-TIGHT-REVERIFY ESCALATION TIER (LAW 2: adds evidence, never lowers the bar) --
        // Split gating: SOLVER_UW_FIT_REVERIFY (default ON) runs the fit + tight
        // re-match as a verdict-NEUTRAL DIAGNOSTIC and logs tight-sigma/k1k2; only
        // SOLVER_UW_TIGHT_ACCEPT (default OFF, orchestrator-only flip after an FP
        // audit) lets a tight-sigma>=bar candidate become a solution. Pin-safe by
        // construction: SeeStar is narrow (never ultra-wide); CR2 passes the wide
        // gate (never enters this FAIL branch) -> both sacreds are byte-identical
        // regardless of either flag. Fail-soft: a diagnostic never breaks a solve.
        let uwTierAccepted = false;
        const uwWideFail = (uwSigma < UW_MIN_SIGMA || uwUnique < UW_MIN_UNIQUE);
        if (uwWideFail) {
            let uwTier: UwTightReverifyResult | null = null;
            try {
                if (shouldAttemptTightReverify(PC.SOLVER_UW_FIT_REVERIFY, uwSigma, PC.SOLVER_UW_TIGHT_REVERIFY_FLOOR_Z)) {
                    const uwInnerFrac = PC.SOLVER_UW_TIGHT_INNER ? PC.SOLVER_UW_TIGHT_INNER_FRAC : 0;
                    if (PC.SOLVER_UW_TIGHT_DEEP) {
                        // Variant A: page a sampled atlas pattern for a DEEP fit-evidence set
                        // (the >16deg field otherwise skips deep-sector paging entirely).
                        const uwBaseNetPx = dynamicVerifyRadiusArcsec / Math.max(1e-6, safeScale);
                        const deepEv = await runUwTightReverifyDeep({
                            wcs, detected, imageW, imageH, safeScale,
                            baseNetPx: uwBaseNetPx, wideSlope: VERIFY_NET.WIDE_NET_SLOPE,
                            opticalCenterX, opticalCenterY,
                            pageDeg: PC.SECTOR_LOAD_MAX_RADIUS_DEG,
                            deepCatCap: PC.SOLVER_UW_TIGHT_DEEP_CAT_CAP,
                            config: {
                                tightNetPx: PC.SOLVER_UW_TIGHT_NET_PX,
                                acceptSigma: PC.SOLVER_UW_TIGHT_ACCEPT_SIGMA,
                                minUnique: UW_MIN_UNIQUE,
                                magLimit: PC.SOLVER_UW_TIGHT_DEEP_MAG,
                                verifyCatCap: PC.SOLVER_UW_TIGHT_DEEP_CAT_CAP,
                                innerFrac: uwInnerFrac,
                                opticalCenterX, opticalCenterY,
                            },
                        });
                        uwTier = deepEv ? deepEv.result : null;
                        if (deepEv && !silenceLogs) console.log(`[PlateSolver] [UW-DEEP-EVIDENCE] (idx ${matchIndex ?? 'RIDGE'}) paged ${deepEv.pagedPositions} positions -> deep cat ${deepEv.deepCatCount}, deep wide-matches ${deepEv.deepMatchCount}.`);
                    } else {
                        uwTier = runUwTightReverify({
                            wcs, catalogStars, detected, imageW, imageH, safeScale,
                            wideMatches: matchedStars,
                            config: {
                                tightNetPx: PC.SOLVER_UW_TIGHT_NET_PX,
                                acceptSigma: PC.SOLVER_UW_TIGHT_ACCEPT_SIGMA,
                                minUnique: UW_MIN_UNIQUE,
                                magLimit: PC.SOLVER_UW_VERIFY_MAG_LIMIT,
                                verifyCatCap: 500,
                                innerFrac: uwInnerFrac,
                                opticalCenterX, opticalCenterY,
                            },
                        });
                    }
                }
            } catch (e) {
                uwTier = null; // FAIL-SOFT: a diagnostic must never break a solve
                if (!silenceLogs) console.log(`[PlateSolver] [UW-FIT-REVERIFY] (idx ${matchIndex ?? 'RIDGE'}) errored, treated as declined: ${(e as any)?.message ?? e}`);
            }
            if (uwTier && !silenceLogs) {
                if (uwTier.declined) {
                    console.log(`[PlateSolver] [UW-FIT-REVERIFY] (idx ${matchIndex ?? 'RIDGE'}) DECLINED: ${uwTier.declineReason} (wide ${uwSigma >= 0 ? '+' : ''}${uwSigma.toFixed(1)} sigma).`);
                } else {
                    console.log(`[PlateSolver] [UW-FIT-REVERIFY] (idx ${matchIndex ?? 'RIDGE'}) [${uwTier.mode}${uwTier.innerFracUsed != null ? ' frac ' + uwTier.innerFracUsed.toFixed(2) : ''}] wide ${uwSigma >= 0 ? '+' : ''}${uwSigma.toFixed(1)} sigma -> tight ${uwTier.tightSigma >= 0 ? '+' : ''}${uwTier.tightSigma.toFixed(1)} sigma @${PC.SOLVER_UW_TIGHT_NET_PX}px: ${uwTier.tightMatches} matches / ${uwTier.tightUnique} unique vs ${uwTier.tightExpectedChance.toFixed(0)} chance; fit k1=${uwTier.k1.toFixed(4)} k2=${uwTier.k2 == null ? 'n/a' : uwTier.k2.toFixed(4)} on ${uwTier.fitUsed}/${uwTier.fitPairs} pairs. accept-bar +${PC.SOLVER_UW_TIGHT_ACCEPT_SIGMA} sigma & ${UW_MIN_UNIQUE} unique -> ${uwTier.accepted ? 'MET' : 'not met'}${PC.SOLVER_UW_TIGHT_ACCEPT ? '' : ' [ACCEPT OFF: diagnostic only]'}.`);
                }
            }
            if (PC.SOLVER_UW_TIGHT_ACCEPT && uwTier && uwTier.accepted) {
                // ACCEPT: adopt the tight (distortion-corrected) match set and proceed
                // EXACTLY as a normal verify pass would; the post-solve refit/SIP chain
                // re-fits geometry downstream (the fitted BC is not wired any further).
                matchedStars.length = 0;
                for (const m of uwTier.matches) matchedStars.push(m);
                uwSigmaValue = uwTier.tightSigma;
                uwTierAccepted = true;
                console.log(`[PlateSolver] [VERIFIED-UW-TIGHT] (idx ${matchIndex ?? 'RIDGE'}) LOCK via uw_tight_reverify: tight +${uwTier.tightSigma.toFixed(1)} sigma >= ${PC.SOLVER_UW_TIGHT_ACCEPT_SIGMA}, ${uwTier.tightMatches} tight matches / ${uwTier.tightUnique} unique (k1=${uwTier.k1.toFixed(4)}, k2=${uwTier.k2 == null ? 'n/a' : uwTier.k2.toFixed(4)}). solved_via=uw_tight_reverify.`);
                diagnostics?.forensics?.push({
                    candidate_idx: matchIndex ?? -3, quad_error: uwTier.tightSigma, inferred_scale: expectedScale,
                    status: 'UW_TIGHT_REVERIFY_PASS',
                    uw_verify: { sigma: +uwTier.tightSigma.toFixed(2), matches: uwTier.tightMatches, unique: uwTier.tightUnique, ra0: +wcs.crval[0].toFixed(3), dec0: +wcs.crval[1].toFixed(2) },
                } as any);
            }
        }
        if (uwWideFail && !uwTierAccepted) {
            if (!silenceLogs) {
                console.log(`[PlateSolver] verifyWCS FAIL-UW (idx ${matchIndex ?? 'RIDGE'}): ${matchedStars.length} matches vs ${uwExpectedChance.toFixed(0)} chance (${uwSigma >= 0 ? '+' : ''}${uwSigma.toFixed(1)} sigma, ${uwUnique} unique). Need +${UW_MIN_SIGMA} sigma & ${UW_MIN_UNIQUE} unique.`);
            }
            return null;
        }
        // SUN-VETO RETIRED HERE (owner-ruled 2026-07-10: "if we match the stars
        // with confidence, we don't need to check if the sun is up. We can kill
        // it."). This block used to reject a statistically-passing ultra-wide
        // center within SOLVER_UW_SUN_VETO_DEG (40°) of the ephemeris Sun, with
        // a daytime-confirmed bypass. Retired as a redundant veto layer: the A5
        // evidence run showed catalog-forced-photometry confirmation
        // (deep_verify/forced_confirm) is the load-bearing false-positive
        // catcher; a chance lock at a day-side pointing dies there on pixel
        // evidence rather than on an ephemeris side-channel. Full history +
        // false-positive case study: docs/NEXT_MOVES.md §6. Retained, unwired:
        // isSunVetoed (fine_center_lever.ts) + its unit tests; the tools/dslr
        // sun_veto_img1414.uwspec.ts harness is historical evidence.
        if (!uwTierAccepted) {
            console.log(`[PlateSolver] [VERIFIED-UW] ${matchedStars.length} matches vs ${uwExpectedChance.toFixed(0)} expected by chance: +${uwSigma.toFixed(1)} sigma excess, ${uwUnique} unique catalog stars.`);
            // Forensic: attribute each UW verify PASS to its center, so a candidate
            // that clears the gate at an astronomically-impossible pointing (a
            // day-side planet anchor) is inspectable — the evidence base that
            // originally motivated (and now replaces) the retired sun-proximity veto.
            diagnostics?.forensics?.push({
                candidate_idx: matchIndex ?? -3, quad_error: uwSigma, inferred_scale: expectedScale,
                status: 'UW_VERIFY_PASS',
                uw_verify: { sigma: +uwSigma.toFixed(2), matches: matchedStars.length, unique: uwUnique, ra0: +wcs.crval[0].toFixed(3), dec0: +wcs.crval[1].toFixed(2) },
            } as any);
        }
    } else if (anchorMatches.length < minAnchorMatches || anchorconfidence < minconfidence) {
        // [TWEAK] astrometry.net-style refinement pass. A raw quad WCS is fit
        // from 4 stars; a few percent of scale/rotation error displaces stars
        // 10 deg from the quad by tens of px — outside the verify net — so a
        // TRUE candidate can gate-fail with a partial match set (observed:
        // ultra-wide CR2, 13 unique matches vs ~2 expected by chance, ~7
        // sigma). When the partial matches are statistically significant,
        // refit the WCS on ALL of them (far better lever arm than the quad)
        // and re-verify once. Acceptance still requires the full confidence
        // + scale gates on the refitted solution — iteration, not inflation.
        const TWEAK_MIN_UNIQUE = 8;      // ~4 sigma above the ~2-match chance floor
        const TWEAK_MIN_CONF = 0.15;
        const TWEAK_MAX_DEPTH = 2;
        if (
            tweakDepth < TWEAK_MAX_DEPTH &&
            anchorMatches.length >= minAnchorMatches &&
            uniqueAnchorMatches >= TWEAK_MIN_UNIQUE &&
            anchorconfidence >= TWEAK_MIN_CONF
        ) {
            const tweakPairs = matchedStars
                .map(m => ({
                    pixel: { x: m.detected.x, y: m.detected.y },
                    sky: SkyTransform.gnomonicProject(m.catalog.ra_hours!, m.catalog.dec_degrees!, ra0, dec0),
                }))
                .filter(p => Number.isFinite(p.sky.xi) && Number.isFinite(p.sky.eta));
            if (tweakPairs.length >= 5) {
                const tweakCrpix: [number, number] = [projCenterX, projCenterY];
                const tweaked = SkyTransform.fitWCS(
                    tweakPairs.map(p => p.pixel),
                    tweakPairs.map(p => p.sky),
                    tweakCrpix, ra0, dec0
                );
                if (tweaked) {
                    if (!silenceLogs) {
                        console.log(`[PlateSolver] [TWEAK] Near-miss (idx ${matchIndex ?? 'RIDGE'}, depth ${tweakDepth}): ${uniqueAnchorMatches} unique matches at ${(anchorconfidence*100).toFixed(1)}% — refitting on ${tweakPairs.length} partial matches, re-verifying.`);
                    }
                    return verifyWCS(tweaked, detected, catalogStars, imageData, imageW, imageH, ra0, dec0, maxvariance, options, expectedScale, matchIndex, diagnostics, tweakDepth + 1);
                }
            }
        }
        if (!silenceLogs) {
            // Truth discriminator for near-misses: random matches inside the
            // verify net average ~half the net radius; real matches under
            // mild distortion sit far tighter. Inner/outer split separates
            // "true center, distortion-limited edges" from uniform noise.
            const medResid = anchorMatches.length
                ? [...anchorMatches].sort((a, b) => a.residual_arcsec - b.residual_arcsec)[Math.floor(anchorMatches.length / 2)].residual_arcsec
                : 0;
            const innerHalf = anchorMatches.filter(m => Math.hypot(m.detected.x - projCenterX, m.detected.y - projCenterY) < innerRadiusPx / 2).length;
            console.log(`[PlateSolver] verifyWCS FAIL (idx ${matchIndex ?? 'RIDGE'}): ${anchorMatches.length}/${achievable} achievable matches (${anchorDetections.length} det, ${catalogInAnchor} cat in anchor; Conf: ${(anchorconfidence*100).toFixed(1)}%). Need ${minAnchorMatches} at ${minconfidence*100}%. [medResid ${medResid.toFixed(0)}" | ${innerHalf} inner / ${anchorMatches.length - innerHalf} outer]`);
        }
        return null;
    }

    if (!ultraWide) {
        console.log(`[PlateSolver] [VERIFIED] Sky fingerprint verified: ${anchorMatches.length} stars matched around origin (confidence: ${(anchorconfidence*100).toFixed(1)}%).`);
    }

    // Implied per-star scale sanity: sky radius / pixel radius about the
    // PROJECTION POINT. CRITICAL: measure sky offsets about the candidate's
    // own crval, NOT the search hint (ra0). The centroid-aware fitWCS
    // legitimately recovers crval offset from the hint (FITS headers store
    // the OBJECT position, not the frame center) — measuring about ra0 adds
    // that constant offset to every star's rDeg, so a TRUE solution implied
    // ~|offset|*3600/rPx (23"/px on the M66 sample) and died at the scale
    // boundary. Same translation-blindness class as the old fit_wcs_bulk bug.
    const scaleRefRaH = wcs.crval[0];
    const scaleRefDecD = wcs.crval[1];
    const impliedScales: number[] = [];
    for (const m of matchedStars) {
        const dx = m.detected.x - projCenterX;
        const dy = m.detected.y - projCenterY;
        const rPx = Math.sqrt(dx*dx + dy*dy);
        const proj = SkyTransform.gnomonicProject(m.catalog.ra_hours!, m.catalog.dec_degrees!, scaleRefRaH, scaleRefDecD);
        if (Number.isNaN(proj.xi) || Number.isNaN(proj.eta)) continue;
        const rDeg = Math.sqrt(proj.xi*proj.xi + proj.eta*proj.eta);
        if (rPx > 10) impliedScales.push((rDeg * 3600) / rPx);
    }

    if (impliedScales.length > 5) {
        const avgScale = impliedScales.reduce((a, b) => a + b, 0) / impliedScales.length;
        
        const variance = impliedScales.reduce((sq, n) => sq + Math.pow(n - avgScale, 2), 0) / impliedScales.length;
        const cv = Math.sqrt(variance) / avgScale;

        const perfectLock = (anchorconfidence > 0.95 && anchorMatches.length >= 5);

        // Ultra-wide match sets carry ~half chance contamination by design
        // (the sigma gate above accounts for it): the MEDIAN implied scale
        // resists it where the mean does not, and the CV variance gate is
        // meaningless there (superseded by the excess-sigma test).
        const sortedScales = [...impliedScales].sort((a, b) => a - b);
        const scaleStat = ultraWide
            ? sortedScales[Math.floor(sortedScales.length / 2)]
            : avgScale;

        // REFACTOR #7: ENFORCE SCALE BOUNDARIES
        if (expectedScale) {
            const scaleError = Math.abs(scaleStat - expectedScale) / expectedScale;

            const errorMult = expectedScale > 10 ? 2.5 : 1.5;
            const maxScaleError = maxvariance * errorMult;

            if (scaleError > maxScaleError) {
                if (!silenceLogs) console.warn(`[PlateSolver] [REJECT] Scale Boundary Breach: ${scaleStat.toFixed(1)}"/px (Expected ${expectedScale.toFixed(1)}"/px). Error: ${(scaleError*100).toFixed(1)}% > ${(maxScaleError*100).toFixed(1)}% limit.`);
                return null;
            }
        }

        if (!perfectLock && !ultraWide) {
            const effectiveMaxVar = maxvariance;
            if (cv > effectiveMaxVar) {
                if (!silenceLogs) console.warn(`[PlateSolver] Rejected: Scale variance too high (CV: ${(cv*100).toFixed(1)}% > ${(effectiveMaxVar*100).toFixed(1)}%).`);
                return null;
            }
        } else if (perfectLock) {
             console.log(`[PlateSolver] [LOCK] High-confidence Lock: Bypassing field-variance check (CV was ${(cv*100).toFixed(1)}%).`);
        }
    }

    // Refine WCS.
    // CRITICAL: filter pixel/sky as PAIRS — filtering only the sky side
    // desynchronizes the arrays (fitWCS reads skyStars[i] for every
    // pixelStars[i]: crash on length mismatch, silent mis-pairing on
    // interior drops). Non-finite projections occur when a matched star
    // is unprojectable about (ra0,dec0) — routine for far-off candidates.
    // Ultra-wide: refit on the TIGHT half of the matches only (residuals at
    // or below the median). Chance matches are uniform across the net while
    // true matches concentrate near zero — the tight half is a poor-man's
    // RANSAC inlier set. Narrow fields keep every match (chance rate ~0).
    let fitSource = matchedStars;
    if (ultraWide && matchedStars.length >= 20) {
        const medResidual = [...matchedStars]
            .sort((a, b) => a.residual_arcsec - b.residual_arcsec)[Math.floor(matchedStars.length / 2)].residual_arcsec;
        fitSource = matchedStars.filter(m => m.residual_arcsec <= medResidual);
    }
    const fitPairs = fitSource
        .map(m => ({
            pixel: { x: m.detected.x, y: m.detected.y },
            sky: SkyTransform.gnomonicProject(m.catalog.ra_hours!, m.catalog.dec_degrees!, ra0, dec0),
        }))
        .filter(p => Number.isFinite(p.sky.xi) && Number.isFinite(p.sky.eta));

    if (fitPairs.length < 3) return null; // Not enough valid stars for a fit
    const allPixel = fitPairs.map(p => p.pixel);
    const allSky = fitPairs.map(p => p.sky);
    
    // CRITICAL: Refit the matrix using the true Projection Origin, NOT the Optical Center
    const crpix: [number, number] = [projCenterX, projCenterY];
    const finalWCS = SkyTransform.fitWCS(allPixel, allSky, crpix, ra0, dec0) || wcs;

    const ps = SkyTransform.pixelScaleFromCD(finalWCS.cd);
    const rotation = SkyTransform.rotationFromCD(finalWCS.cd);
    
    // [FIX 4] Invoke planetary color verification to filter out strobes/anomalies
    const verifiedMatches = verifyPlanetaryDesignation(matchedStars, imageData, ps);
    
    // We still return the true geometric center of the photo to the UI for metadata
    const centerSky = SkyTransform.pixelToSky(opticalCenterX, opticalCenterY, finalWCS);

    // ACHIEVABLE-match confidence, frame-wide (same principle as the anchor
    // gate above): matched stars over the catalog stars actually available
    // in the frame — not over all detections (deep stacks detect far past
    // the catalog mag limit, which deflated this to ~0.35 and forced a 0.45
    // floor crutch; that floor is retired). True M66 solve: 226/245 ≈ 0.92.
    const achievableFrame = Math.max(1, catalogInFrame > 0
        ? Math.min(detected.length, catalogInFrame)
        : Math.min(detected.length, catalogStars.length));
    // Unique catalog stars for the same reason as the anchor gate above.
    const uniqueFrameMatches = new Set(verifiedMatches.map(m => (m.catalog as any).gaia_id ?? `${m.catalog.ra_hours},${m.catalog.dec_degrees}`)).size;
    const matchRatio = Math.min(1, uniqueFrameMatches / achievableFrame);
    const avgResidual = verifiedMatches.reduce((s, m) => s + m.residual_arcsec, 0) / verifiedMatches.length;

    // Ultra-wide confidence comes from the statistical excess, not the
    // narrow-field ratio formula: at 63"/px the residuals (px-scale * scale)
    // dwarf the 120" constant (term goes NEGATIVE) and matchRatio divides the
    // bright match set by the full catalog-in-frame count (~0.02) — a
    // verified true solve would be rejected downstream by the
    // SOLVER_MIN_LOCK_confidence gate. +5 sigma (the acceptance floor) maps
    // to 0.5, saturating at 1.
    const confidence = ultraWide
        ? Math.min(1, 0.1 * uwSigmaValue)
        : Math.min(1, matchRatio * (1 - avgResidual / PC.SOLVER_VERIFICATION_RADIUS_ARCSEC));

    const detTerm = finalWCS.cd[0][0] * finalWCS.cd[1][1] - finalWCS.cd[0][1] * finalWCS.cd[1][0];
    const parity = detTerm < 0 ? -1 : 1;

    return {
        ra: centerSky.ra_hours * 15,
        dec: centerSky.dec_degrees,
        ra_hours: centerSky.ra_hours,
        dec_degrees: centerSky.dec_degrees,
        rotation,
        rotation_deg: rotation,
        pixel_scale: ps,
        fov_width_deg: (imageW * ps) / 3600,
        fov_height_deg: (imageH * ps) / 3600,
        parity,
        spatial_hash: buildSpatialHash(centerSky.ra_hours, centerSky.dec_degrees),
        // `odds` DELETED 2026-07-10 (owner: "delete … out of ethos"): it was
        // `confidence×1e9` — a synthetic rescale of the heuristic [0,1]
        // confidence masquerading as an astrometry.net-style odds ratio (LAW-3).
        // Write-only: never serialized into receipts, zero readers in src/, UI,
        // tools, or apispecs. A real Bayesian log-odds implementation lives in
        // tools/solverkit/bayesian_logodds.mjs if a consumer ever needs one.
        confidence,
        num_stars: verifiedMatches.length,
        wcs: finalWCS,
        matched_stars: verifiedMatches,
        diagnostics: diagnostics ? {
            avg_fwhm: avgResidual, // Using avgResidual as a proxy for lock quality
            stars_matched: verifiedMatches.length,
            solve_time_ms: diagnostics.solve_time_ms
        } : undefined
    };
}

/**
 * Re-project forced-photometry probe positions from the solve's UN-DISTORTED
 * (lens-corrected) matching space into NATIVE pixel space via the Brown-Conrady
 * forward model, so forced photometry samples the correct native pixels when a
 * lens-distortion prior is active. Reuses the EXACT `toNative` transform the
 * BC-rematch pass uses (lens_distortion.ts:75-105). Pure; 1:1 (length preserved);
 * spreads through any extra probe fields (mag/gaia_id). WIRING_SPEC R3.
 */
function reprojectProbesToNative<T extends { x: number; y: number }>(
    positions: T[],
    model: LensDistortionModel,
): T[] {
    const nt: [number, number] = [0, 0];
    return positions.map((p) => {
        model.toNative(p.x, p.y, nt);
        return { ...p, x: nt[0], y: nt[1] };
    });
}

/**
 * Single-source resolution of "which lens-distortion prior shaped this solve".
 * Mirrors autoSolvePlate's ladder EXACTLY (caller-injected resolution wins over
 * the EXIF/hint LENS_DB resolver) so the post-solve confirmation step (which runs
 * in the SESSION, a different file) can re-derive the identical prior and
 * re-project its probes through toNative. Returns null when no prior resolves
 * (the default, and always on the pinned reference solves → byte-identical).
 */
export function resolveLensDistortionForContext(ctx: {
    lensModel?: string;
    focalLength?: number;
    lensDistortionResolution?: LensDistortionResolution | null;
    lensDistortionHint?: LensDistortionHint | null;
}): LensDistortionResolution | null {
    return ctx.lensDistortionResolution
        ?? resolveLensDistortion(
            { lens_model: ctx.lensModel, focal_length: ctx.focalLength },
            ctx.lensDistortionHint ?? null,
        )
        ?? null;
}


/**
 * POST-SOLVE DEEP HARVEST (NEXT_MOVES §7·5b) — after a confirmed lock,
 * catalog-forced photometry at deep-catalog predicted positions harvests
 * real stars blind detection missed (named-star overlays, SIP/TPS anchors,
 * limiting-mag statistics downstream). Additive and fail-soft: any error or
 * missing input (no pixels, no WCS, no catalog) → null, solution untouched.
 * Results are CATALOG_FORCED on solution.deep_forced — never mixed into
 * blind detections or matched_stars (provenance law).
 */
/**
 * Deep-catalog rows for the CONFIRM lane (harvest + confirmation). Flag-gated
 * SOURCE (VITE_CATALOG_G15U, default OFF): ON → g15u Gaia-only `stars.arrow` cone
 * read (desktop + headless; retires the ensureSectorLoaded full-sector paging
 * class); OFF, or ON but g15u absent/failed → the legacy hybrid dec-band path
 * (ensureSectorLoaded + findStarsInField), BYTE-IDENTICAL to the historical line
 * (owner never-delete cold path). Rows are mag-filtered (≤ magLimit) + mag-sorted
 * either way, and shaped for projectCatalogToPixels + the neighbor lane.
 */
async function fetchDeepCatalogRows(
    adapter: StarCatalogAdapter,
    raHours: number, decDeg: number, fovR: number, jd: number, magLimit: number,
): Promise<{ ra_hours: number; dec_degrees: number; magnitude_V?: number; gaia_id?: string }[]> {
    if (StarCatalogAdapter.isG15uCatalogSourceEnabled()) {
        const g15u = await adapter.queryDeepCatalogG15u(raHours, decDeg, fovR, magLimit);
        if (g15u) return g15u; // already ≤ magLimit + mag-sorted at the g15u boundary
    }
    if (fovR <= PC.SECTOR_LOAD_MAX_RADIUS_DEG) {
        await adapter.ensureSectorLoaded(raHours, decDeg, fovR);
    }
    return (await adapter.findStarsInField(raHours, decDeg, fovR, jd))
        .filter(s => (s.magnitude_V ?? 99) <= magLimit)
        .sort((a, b) => (a.magnitude_V ?? 99) - (b.magnitude_V ?? 99));
}

async function runPostSolveDeepHarvest(
    imageData: ImageData,
    solution: PlateSolution,
    detected: DetectedStar[],
    timestamp?: string | number | Date,
    lensDistModel: LensDistortionModel | null = null,
): Promise<PlateSolution['deep_forced'] | null> {
    const wcs = solution.wcs as WCSTransform | undefined;
    if (!wcs?.crpix || !wcs?.crval || !wcs?.cd) return null;
    if (!imageData?.data || imageData.data.length < imageData.width * imageData.height * 4) return null;

    const jd = TimeService.toJulianDate(timestamp ? new Date(timestamp) : new Date());
    const fovR = Math.max(solution.fov_width_deg || 0, solution.fov_height_deg || 0) / 2 * 1.2;
    if (!(fovR > 0)) return null;
    const adapter = StarCatalogAdapter.getinstance();
    const rows = await fetchDeepCatalogRows(
        adapter, solution.ra_hours, solution.dec_degrees, fovR, jd, PC.SOLVER_DEEP_HARVEST_MAG_MAX,
    );
    let positions = projectCatalogToPixels({
        stars: rows, wcs, w: imageData.width, h: imageData.height,
    }).slice(0, PC.SOLVER_DEEP_HARVEST_MAX_POSITIONS);
    if (positions.length === 0) return null;
    // WIRING_SPEC R3: an active lens prior puts the solved WCS in UN-DISTORTED
    // matching space; the harvest reads NATIVE luminance. Re-project the predicted
    // positions through the BC forward model (toNative) so apertures land on the
    // right native pixels — replacing the former honest-skip. No-op when null.
    if (lensDistModel) {
        positions = reprojectProbesToNative(positions, lensDistModel);
        console.log(`[DeepHarvest] Re-projecting ${positions.length} predicted positions to native via toNative (lens prior ${lensDistModel.model} k1=${lensDistModel.k1} k2=${lensDistModel.k2}).`);
    }

    const L = luminanceFromImageData(imageData);
    // Shared forced-photometry composition (A1): the SAME grid → noise → fwhm →
    // aperture → measure sequence the solve-side escalation uses. Byte-identical
    // to the prior inline copy (sampledBackgroundSigma(L).sigma, median-fwhm).
    const { rApPx, results, fwhmPx } = runForcedPhotometry({
        L, w: imageData.width, h: imageData.height, positions, detected,
        // B3: dedicated candidate SNR floor (default == 2, so byte-identical
        // to the prior SOLVER_UW_ESCALATE_SNR_THRESHOLD; decoupled to tune the
        // densification bar without touching the solve-side escalation gate).
        snrThreshold: PC.SOLVER_DEEP_HARVEST_SNR_THRESHOLD,
    });
    const accepted = results.filter(r => r.accepted);
    console.log(`[DeepHarvest] CATALOG_FORCED photometry at ${results.length} predicted positions: ${accepted.length} accepted (snr>=${PC.SOLVER_DEEP_HARVEST_SNR_THRESHOLD}), ${results.filter(r => r.structured).length} structured-background.`);
    return {
        provenance: 'CATALOG_FORCED',
        probed: results.length,
        accepted: accepted.length,
        structured: results.filter(r => r.structured).length,
        rApPx,
        fwhmPx,
        snrThreshold: PC.SOLVER_DEEP_HARVEST_SNR_THRESHOLD,
        // Honest provenance (B2): today the harvest reads the 8-bit RGBA
        // luminance (autoSolvePlate is handed only ImageData — the raw/science
        // float buffer was released after ingest), so faint SNR carries ~4-7%
        // cross-channel leak + quantization. Native-grade plumbing is the
        // tracked follow-up; until then the payload is labelled APPROXIMATE.
        approximate: true,
        grid: 'RGBA_LUMINANCE_8BIT',
        // 0.01 px / 4-sig-fig precision: honest for aperture-level (r_ap >= 2 px)
        // measurements, and keeps the receipt from ballooning (the solution is
        // embedded in several receipt sections).
        stars: accepted.map(r => ({
            x: +r.x.toFixed(2), y: +r.y.toFixed(2), mag: r.mag, gaia_id: r.gaia_id,
            snr: +r.snr.toFixed(2), flux: +r.flux.toExponential(4),
        })),
    };
}

// PHASE-2 note (2026-07-22): the CONFIRM_FDR_SHADOW flag GRADUATED — FDR is
// always computed inside confirmForcedSet and the BY step-up is the set-level
// decision authority. The flag reader that lived here was removed with it.

/**
 * POST-SOLVE CONFIRMATION (forced_confirm, FP wave C5) — promote CATALOG_FORCED
 * candidates to CATALOG_FORCED_CONFIRMED on a SEPARATE solution.deep_confirmed
 * field. Runs in the SESSION post-solve (after psf_field) where the measured
 * frame PSF + the native Float32 science luminance both survive; NEVER inside
 * autoSolvePlate (which has neither). Additive, fail-soft, honest-or-absent:
 * writes ONLY deep_confirmed — never confidence/matched_stars/WCS/ra_hours.
 *
 * B2 fidelity: measures on the native Float32 science luminance (never the 8-bit
 * solve buffer) — but that buffer is a luminance COMBINATION, not a single/
 * dominant channel, so the COLOR test is NOT_MEASURED and the grid is labelled
 * NATIVE_FLOAT_LUMINANCE (honest, not native-color-grade).
 *
 * The scienceBuffer grid MUST equal the WCS's pixel grid (solveW/solveH) — the
 * caller passes the science-buffer's own dims. Deterministic (seeded).
 */
export async function runPostSolveConfirmation(i: {
    /** Native Float32 science luminance (the solve/WCS pixel grid). */
    scienceBuffer: Float32Array;
    /** scienceBuffer grid dims (== solveW/solveH — NOT necessarily native dims). */
    width: number;
    height: number;
    solution: PlateSolution;
    /** Detection set — only the median fwhm is read (sets the aperture). */
    detected: { fwhm?: number }[];
    /** Measured frame PSF (from psf_field) — null ⇒ shape NOT_MEASURED. */
    framePsf: FramePsfRef | null;
    timestamp?: string | number | Date;
    /**
     * WIRING_SPEC R3: the (k1,k2) of the lens-distortion prior that shaped the
     * solve's WCS, or null/absent when no prior was active. When set, predicted
     * catalog positions (which come out in the UN-DISTORTED matching space) are
     * re-projected to NATIVE pixels via toNative before sampling the science
     * buffer. The model is rebuilt on THIS call's (width,height) grid so it is
     * grid-correct regardless of native-vs-binned science buffers.
     */
    lensDistortion?: { k1: number; k2: number } | null;
    /**
     * F2 (adversarial review row 547, owner GO): the fitted SIP from THIS solve's
     * own chain — composed into probe projection as linear + evalSipPoly(a|b,u,v),
     * MIRRORING lens_distortion_rematch_pass.ts:259-261 exactly (the in-engine
     * convention authority; the M7 sign history forbids re-derivation here).
     * Null/absent ⇒ linear(+BC) only — the pre-F2 behavior.
     */
    sip?: { a: number[][]; b: number[][] } | null;
    /**
     * F2: the MEASURED Brown-Conrady from the chain (bcMeasured) — PREFERRED over
     * the nominal prior for the toNative re-projection when finite+nonzero. The
     * prior remains the fallback so prior-only rigs keep their exact behavior.
     */
    bcMeasured?: { k1: number; k2: number } | null;
}): Promise<PlateSolution['deep_confirmed'] | null> {
    const { scienceBuffer, width, height, solution } = i;
    const wcs = solution.wcs as WCSTransform | undefined;
    if (!wcs?.crpix || !wcs?.crval || !wcs?.cd) return null;

    const absent = (reason: string): PlateSolution['deep_confirmed'] => ({
        provenance: 'CATALOG_FORCED_CONFIRMED',
        examined: 0, confirmed: 0, setExcessZ: null, setGatePassed: false,
        approximate: false, grid: 'NATIVE_FLOAT_LUMINANCE',
        framePsf: null, confirmed_stars: [], not_measured: reason,
    });

    if (!scienceBuffer || scienceBuffer.length !== width * height) {
        return absent(`No coherent native science buffer at post-solve (len ${scienceBuffer?.length ?? 0} != ${width}×${height}) — confirmation NOT MEASURED.`);
    }
    // F2 (row 547): the toNative re-projection now prefers the chain's own
    // MEASURED BC over the nominal prior (which remains the fallback — a
    // prior-only rig is byte-identical to the pre-F2 line). Provenance recorded.
    const bcSrc =
        (i.bcMeasured && Number.isFinite(i.bcMeasured.k1) && Number.isFinite(i.bcMeasured.k2)
            && (i.bcMeasured.k1 !== 0 || i.bcMeasured.k2 !== 0))
            ? { k1: i.bcMeasured.k1, k2: i.bcMeasured.k2, src: 'BC_MEASURED' as const }
            : (i.lensDistortion && (i.lensDistortion.k1 !== 0 || i.lensDistortion.k2 !== 0))
                ? { k1: i.lensDistortion.k1, k2: i.lensDistortion.k2, src: 'BC_PRIOR' as const }
                : null;
    const confirmLensModel = bcSrc
        ? makeBrownConradyDistortion(bcSrc.k1, bcSrc.k2, width, height)
        : null;

    const jd = TimeService.toJulianDate(i.timestamp ? new Date(i.timestamp) : new Date());
    const fovR = Math.max(solution.fov_width_deg || 0, solution.fov_height_deg || 0) / 2 * 1.2;
    if (!(fovR > 0)) return null;
    const adapter = StarCatalogAdapter.getinstance();
    const rows = await fetchDeepCatalogRows(
        adapter, solution.ra_hours, solution.dec_degrees, fovR, jd, PC.SOLVER_DEEP_HARVEST_MAG_MAX,
    );
    // ── PROBE PROJECTION (F2, row 547): linear WCS → +fitted SIP → toNative(BC)
    // — the chain's own best distortion knowledge now positions the apertures.
    // SIP composition mirrors lens_distortion_rematch_pass.ts:259-261 verbatim.
    let projected = projectCatalogToPixels({ stars: rows, wcs, w: width, h: height });
    const sipUsed = !!(i.sip?.a && i.sip?.b);
    if (sipUsed) {
        const cx0 = wcs.crpix[0], cy0 = wcs.crpix[1];
        projected = projected.map(p => {
            const u = p.x - cx0, v = p.y - cy0;
            return { ...p, x: p.x + evalSipPoly(i.sip!.a, u, v), y: p.y + evalSipPoly(i.sip!.b, u, v) };
        });
    }
    if (confirmLensModel) {
        projected = reprojectProbesToNative(projected, confirmLensModel);
    }
    // ── F3 MATCHED-STAR EXCLUSION (row 547): the WCS was least-squares fit
    // THROUGH the matched stars' pixels — they are fit anchors, not admissible
    // confirmation evidence. Exclude by DETECTED-position coincidence (native
    // space, where detections live); coordinate-based deliberately — ID-only
    // exclusion is exactly F1's failure mode. Radius mirrors deep_verify's
    // aperture formula (max(2, 0.68·medianFWHM)).
    const fwSorted = i.detected.map(d => d.fwhm)
        .filter((f): f is number => Number.isFinite(f as number)).sort((a, b) => a - b);
    const exclR = Math.max(2, 0.68 * (fwSorted.length ? fwSorted[Math.floor(fwSorted.length / 2)] : 3));
    const matchedXY = (solution.matched_stars ?? [])
        .map(m => (m as { detected?: { x: number; y: number } }).detected)
        .filter((d): d is { x: number; y: number } =>
            !!d && Number.isFinite(d.x) && Number.isFinite(d.y));
    const projectedBeforeExclusion = projected.length;
    if (matchedXY.length > 0) {
        projected = projected.filter(p =>
            !matchedXY.some(d => Math.hypot(p.x - d.x, p.y - d.y) <= exclR));
    }
    const matchedExcluded = projectedBeforeExclusion - projected.length;
    const positions = projected.slice(0, PC.SOLVER_DEEP_HARVEST_MAX_POSITIONS);
    if (positions.length === 0) return absent('No in-frame catalog positions after matched-star exclusion — confirmation NOT MEASURED.');
    console.log(`[DeepConfirm] Probe projection LINEAR${sipUsed ? '+SIP' : ''}${bcSrc ? `+${bcSrc.src}(k1=${bcSrc.k1} k2=${bcSrc.k2})` : ''}; ${matchedExcluded} matched fit-anchors excluded (r<=${exclR.toFixed(1)}px), ${positions.length} probe targets.`);

    // Native-grade forced photometry (shared composition, science-luminance grid).
    const { rApPx, results, fwhmPx, sigmaPix } = runForcedPhotometry({
        L: scienceBuffer, w: width, h: height, positions, detected: i.detected,
        snrThreshold: PC.SOLVER_DEEP_HARVEST_SNR_THRESHOLD,
    });
    const candidates = results.filter(r => r.accepted);
    // F3 FAMILY (row 547): the FDR step-up's population = EVERY probed target
    // (accepted or not; structured → p=1 inside confirmForcedSet), fixed BEFORE
    // the tested statistic can select survivors.
    const family = results.map(r => ({ x: r.x, y: r.y, snr: r.snr, structured: !!r.structured }));

    const framePsf: FramePsfRef = i.framePsf ?? { fwhmPx: null, source: 'NOT_MEASURED' };

    const set = confirmForcedSet({
        candidates, catalog: positions, family,
        L: scienceBuffer, w: width, h: height,
        rApPx, sigmaPix, fwhmPx, framePsf,
        approximate: false, // native Float32 luminance (color still NOT_MEASURED — no channels)
        seed: 0x0CF17A11,
        config: {
            setExcessGateZ: PC.SOLVER_CONFIRM_SET_EXCESS_Z,
            maxCandidates: PC.SOLVER_DEEP_HARVEST_MAX_POSITIONS,
            snrFloor: PC.SOLVER_DEEP_HARVEST_SNR_THRESHOLD,
            snrConfirmFloor: PC.SOLVER_CONFIRM_SNR_FLOOR,
            snrConfirmFloorApprox: PC.SOLVER_CONFIRM_SNR_FLOOR_APPROX,
            shapeMinSnr: PC.SOLVER_CONFIRM_SHAPE_MIN_SNR,
            shapeFwhmTolFrac: PC.SOLVER_CONFIRM_SHAPE_FWHM_TOL_FRAC,
            localNullK: PC.SOLVER_CONFIRM_LOCAL_NULL_K,
            setNullDraws: PC.SOLVER_CONFIRM_SET_NULL_DRAWS,
        },
        // PHASE-2 (2026-07-22): FDR is always computed inside confirmForcedSet and
        // the BY step-up IS the set-level decision (flag graduated + removed).
    });

    console.log(`[DeepConfirm] CATALOG_FORCED_CONFIRMED: ${set.confirmed}/${set.examined} candidates confirmed (FDR ${set.fdr ? `${set.fdr.method} q=${set.fdr.q}: ${set.fdr.n_confirmed_fdr}/${set.fdr.examined} step-up confirms` : 'n/a'}; setExcessZ ${set.setExcessZ != null ? set.setExcessZ.toFixed(1) : 'n/a'}σ REPORTED [z-gate retired 2026-07-22], null-confirm rate ${set.nullConfirmRate != null ? (100 * set.nullConfirmRate).toFixed(2) : 'n/a'}%, gate ${set.setGatePassed ? 'PASSED' : 'COLLAPSED→0'}) on native Float32 luminance, framePsf=${framePsf.source} fwhm=${framePsf.fwhmPx?.toFixed(2) ?? 'n/a'}px${framePsf.undersampled ? ' (undersampled→shape NOT_MEASURED)' : ''}.`);

    return {
        provenance: 'CATALOG_FORCED_CONFIRMED',
        examined: set.examined,
        confirmed: set.confirmed,
        setExcessZ: set.setExcessZ != null ? +set.setExcessZ.toFixed(2) : null,
        setGatePassed: set.setGatePassed,
        // 2.19.0 (F2/F3, row 547) — honest family + projection provenance:
        probed: results.length,
        matched_excluded: matchedExcluded,
        projection: `LINEAR${sipUsed ? '+SIP' : ''}${bcSrc ? `+${bcSrc.src}` : ''}`,
        approximate: false,
        grid: 'NATIVE_FLOAT_LUMINANCE',
        framePsf: {
            fwhmPx: framePsf.fwhmPx,
            ellipticity: framePsf.ellipticity ?? null,
            source: framePsf.source,
        },
        confirmed_stars: set.confirmed_stars.map(cs => ({
            x: +cs.m.x.toFixed(2), y: +cs.m.y.toFixed(2), mag: cs.m.mag, gaia_id: cs.m.gaia_id,
            snr: +cs.m.snr.toFixed(2), flux: +cs.m.flux.toExponential(4),
            confidence: +cs.result.confidence.toFixed(3),
            tests: cs.result.tests,
        })),
        not_measured: set.notMeasured,
        // PHASE-2 (schema 2.17.0): the FDR decision block rides the receipt
        // always (null only on the N<10 floor — honest absence, never fabricated).
        fdr: set.fdr,
    };
}

/**
 * Smart Plate Solver Facade (The "Manager")
 */
export async function autoSolvePlate(
    imageData: ImageData,
    context: SolveContext,
    existingStars?: DetectedStar[]
): Promise<SolveResult> {
    const config = context.config || DEFAULT_PIPELINE_CONFIG;
    const logger = context.logger;

    // 1. Extract Stars (if not already provided)
    let stars = existingStars;
    if (!stars) {
        const ext = await SourceExtractor.extractStars(imageData, config.solver_sigma, undefined, undefined, {
            focusRegions: context.hints?.ra_hours ? [] : undefined,
            logger,
            focalLengthMm: context.focalLength
        });
        stars = ext.stars;
    }

    if (stars.length < 4) {
        return { 
            success: false, 
            diagnostics: { 
                solve_time_ms: 0, 
                matches_found: 0, 
                quads_detected: 0, 
                quads_catalog: 0, 
                verified_clusters: 0, 
                peak_background_ratio: 0, 
                rejection_reasons: ['Insufficient stars'] 
            } 
        };
    }

    // 2. Resolve Scale
    const effectiveScale = context.basePixelScale || (36.0 / (context.focalLength || 50)) * (206265 / 3600);

    // 2b. LENS-PRIOR DISTORTION (NEXT_MOVES §8): resolve a distortion profile
    // ONLY from a trusted, non-placeholder EXIF LensModel (context.lensModel) or
    // an explicit user hint (context.lensDistortionHint). Keys on the lens
    // MODEL, never on the focal-length value — so the bundled CR2's lying-50mm /
    // 'Unknown Lens' EXIF resolves to NULL (no-op, byte-identical). Photometry
    // keeps native coords; only the MATCHING coords get un-distorted downstream.
    // A caller-injected pooled prior (SOLVER_WORKBENCH_PRIOR, default OFF) wins over
    // the EXIF/hint ladder and seeds the solve through the identical downstream path
    // (options.lensDistortionPrior). When absent (the default, and ALWAYS on the
    // pinned reference solves — flag OFF / fresh store), this is byte-identical to
    // the historical resolver-only line.
    const lensDistortionPrior = resolveLensDistortionForContext(context);

    // 3. Solve (Attempt 1: Contextual)
    const result = await solvePlate(
        imageData,
        effectiveScale,
        context.hints,
        context.timestamp,
        {
            detectionThreshold: config.solver_sigma,
            quadtolerance: 0.1,
            logger: logger,
            focalLengthMm: context.focalLength,
            hardwareProfile: context.hardwareProfile,
            lensDistortionPrior,
            // Audit P2.3: these were silently dropped — the positional
            // timestamp param is dead code; the body reads options.* only.
            timestamp: context.timestamp,
            observer: context.observer,
            pixelPitchUm: context.pixelPitchUm,
            blindBudgetMs: context.blindBudgetMs,
            onBlindProgress: context.onBlindProgress,
            // Forward the stars we already have (caller-provided or the
            // extraction above). Without this, solvePlate RE-extracts from
            // the 8-bit ImageData — on dark calibrated stacks the float
            // detections quantize to noise (1187 junk blobs vs 587 real
            // stars on the M66 sample) and quad matching degenerates.
            detectedStars: stars,
            // Forward optional verifyWCS tuning from the dynamic config
            // (all-undefined object == historical thresholds).
            verifyTuning: {
                minAnchorMatches: config.verify_min_anchor_matches,
                minConfidence: config.verify_min_confidence,
                denseFieldCutoff: config.verify_dense_field_cutoff
            },
            // SEARCH-ORDER PRIORS (task #20). Forward the orchestrator-supplied
            // model to the reorder seam. Undefined/null by default ⇒ the seam's
            // guard (PC.SOLVER_SEARCH_PRIORS && options.searchPriors) short-circuits
            // ⇒ bit-identical (both pinned e2e byte-identical).
            searchPriors: context.searchPriors
        }
    );

    // POST-SOLVE DEEP HARVEST (§7·5b): additive, fail-soft, CATALOG_FORCED.
    if (result.success && result.solution) {
        try {
            // WIRING_SPEC R3: an active lens prior (k1/k2 != 0) puts the solved WCS
            // in UN-DISTORTED space — build the BC forward model so the harvest
            // re-projects predicted positions to native via toNative (instead of
            // honest-skipping). Null on the bundled CR2 (lying-EXIF → null prior)
            // ⇒ byte-identical.
            const harvestLensModel = (lensDistortionPrior &&
                (lensDistortionPrior.k1 !== 0 || lensDistortionPrior.k2 !== 0))
                ? makeBrownConradyDistortion(lensDistortionPrior.k1, lensDistortionPrior.k2, imageData.width, imageData.height)
                : null;
            const harvest = await runPostSolveDeepHarvest(imageData, result.solution, stars, context.timestamp, harvestLensModel);
            if (harvest) result.solution.deep_forced = harvest;
        } catch (e) {
            console.warn('[DeepHarvest] post-solve forced photometry failed (solution unaffected):', e);
        }
    }

    return result;
}


/**
 * The strategy chain the solve loop ACTUALLY runs — getSolverChain minus the
 * parked 'ridge_directed' entry (RIDGE PARK, owner-delegated 2026-07-10;
 * ultracode held-#2). Exported as the testable seam so the park is a gated
 * regression: ridge re-enters the live chain only by deleting the filter here,
 * together with the C8a CD-sign fix + directedAnchor plumbing (ROADMAP).
 */
export function getLiveStrategyChain(focalLengthMm: number): SolverStrategy[] {
    return getSolverChain(focalLengthMm).filter(s => s !== 'ridge_directed');
}
