/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * SIGNAL PROCESSOR â€” The "Eye" of the Pipeline
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 *
 * RESPONSIBILITY:
 * Convert raw pixels into a categorized list of "Signal Points".
 * Distinguishes true stars from noise, hot pixels, cosmic rays, and satellites.
 *
 * ALGORITHM:
 * 1. Global Stats (Mean/StdDev) for noise floor.
 * 2. Thresholding (5-sigma).
 * 3. Blob Extraction (Connected Components).
 * 4. Metrology per Blob (FWHM, Circularity, Ellipticity, Theta).
 * 5. Categorization (Clean Star vs. Anomaly).
 */

import { Point, SignalPoint, SignalPacket, CullingReason } from '../../types/Main_types';
import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import { ScaleManager } from '../m2_hardware/scale_manager';
import { PhotometryManager } from '../m8_photometry/photometry_manager';
import { UnitConverter } from '../../core/UnitConverter';
import { DemosaicEngine } from '../m3_gpu_preprocess/demosaic_engine';
import { evaluateDetectionDensity, applyDensityCap } from './detection_guard';
import { computeBlobShapeStats, cullThermalBlobs, logShapeDistributions } from './detection_cuts';
import {
    fitVignetteFromDetectionLum,
    applyVignetteGainToLum,
    subtractBackgroundSurface,
} from './detection_flatten';

import { removeThermalArtifacts, measureHotPixelCandidates } from './hot_pixel_map';
import { SourceExtractor } from './source_extractor';
import { StatisticsProvider } from '../../core/StatisticsProvider';
import { TelemetryLogger } from '../../diagnostics/telemetry_logger';
import { computeHorizonEnvelope } from './horizon_envelope';
import { AtmosphericPhysics } from './AtmosphericPhysics';
import { CelestialStructures } from './CelestialStructures';
import { TerrestrialEnvironment, BackgroundSurfaceModeler } from './TerrestrialEnvironment';
import { SensorCalibrationManager } from '../../core/SensorCalibrationManager';

/**
 * TEST-ONLY pixel-sigma override (decoder-cutover #14 paired threshold-recal).
 * The two primary m4 sigma thresholds are compiled SOURCE LITERALS (sigFactor,
 * vanguard base) that a tools/ lane cannot sweep without an engine seam. Mirrors
 * the CFA-parity env-override precedent (VITE_CFA_LUMA_PARITY_FIX, 50d9a1a): read
 * at CALL time so tools/recal/sweep_thresholds can toggle per spawned run.
 *
 * BYTE-IDENTITY CONTRACT: when the env var is UNSET (every gate, browser, and
 * both pinned solves), this returns the EXACT default literal — the value is the
 * same double the code used before, so the solve is bit-identical by
 * construction. process.env is read FIRST (the recal runs in Node; RECAL_* is
 * intentionally NOT VITE_-prefixed, so it never leaks into a vite/browser build).
 * A non-finite or non-positive value falls back to the default (fail-safe).
 */
function recalSigma(name: string, dflt: number): number {
    try {
        let v: string | undefined;
        if (typeof process !== 'undefined') v = process.env?.[name];
        if (v === undefined) v = (import.meta as { env?: Record<string, string | undefined> }).env?.[name];
        if (v === undefined) return dflt;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : dflt;
    } catch {
        return dflt;
    }
}

export class SignalProcessor {
    private static recycledBuffer: Float32Array | null = null;

    /**
     * Analyze image buffer to find stars vs noise.
     * @param lum Float32 luminance buffer (0.0 - 1.0)
     * @param width Image Width
     * @param height Image Height
     */
    public static async analyze(lum: Float32Array, width: number, height: number): Promise<SignalPacket> {
        
        // 1. GLOBAL STATS (Fast sampling)
        const { mean, stdDev } = this.calculateStats(lum);
        const sigFactor = recalSigma('RECAL_SIGFACTOR', 2.0); // unset ⇒ 2.0 (byte-identical)
        const threshold = mean + (stdDev * sigFactor);
        console.log(`[SignalProcessor] analyze - Stats: Mean=${mean.toFixed(4)}, StdDev=${stdDev.toFixed(4)}, Threshold=${threshold.toFixed(4)} (Sigma=${sigFactor})`);

        // [ZERO-COPY AUDIT]
        // Use recycled buffer to prevent massive O(N) allocations for the blur pass.
        if (!this.recycledBuffer || this.recycledBuffer.length !== lum.length) {
            console.log(`[SignalProcessor] Allocating recycled buffer: ${lum.length} units.`);
            this.recycledBuffer = new Float32Array(lum.length);
        }
        const blurredLum = this.recycledBuffer;

        const kernel = [1/16, 2/16, 1/16, 2/16, 4/16, 2/16, 1/16, 2/16, 1/16];
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                let sum = 0;
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        sum += lum[(y + ky) * width + (x + kx)] * kernel[(ky + 1) * 3 + (kx + 1)];
                    }
                }
                blurredLum[y * width + x] = sum;
            }
        }

        // 2. CHUNKED EXTRACTION (Parallel Workers) vs WASM FAST-PATH
        // We now use WebAssembly for extraction which easily beats JS workers 
        // without the postMessage copying overhead.
        console.log(`[SignalProcessor] Executing WASM Metrology Pass...`);
        const blooms = await this.extractBlobs(blurredLum, width, height, threshold, mean, stdDev);
        console.log(`[SignalProcessor] Raw candidates found: ${blooms.length}`);
        
        // --- MORPHOLOGICAL PASS 1 ---
        let clean = blooms.filter(b => this.applyMorphologicalFilter(b, null, width, height, undefined).status === 'PASS').sort((a,b) => b.flux - a.flux);
        let anomaliesList = blooms.filter(b => this.applyMorphologicalFilter(b, null, width, height, undefined).status === 'ANOMALY');
        
        console.log(`[SignalProcessor] Filtering results - Clean: ${clean.length}, Anomalies: ${anomaliesList.length}, Rejected: ${blooms.length - clean.length - anomaliesList.length}`);
        
        // --- PHOTOMETRIC CALIBRATION (2D GAUSSIAN FITTING) ---
        const { PhotometryWorkerPool } = await import('../m8_photometry/photometry_worker_pool');
        const pool = PhotometryWorkerPool.getinstance();
        console.log(`[SignalProcessor] Executing Photometric Calibration (synchronous bulk 2D-Gaussian LM)...`);
        
        clean = await pool.refineStars(clean, lum, width, height);

        return {
            clean_stars: clean,
            anomalies: anomaliesList,
            background_level: mean,
            noise_floor: stdDev
        };
    }

    /**
     * NATIVE BAYER EXTRACTION (The "Pure" Eye)
     * Performs 2x2 average binning on the raw RGGB grid to create a high-SNR 
     * luminance proxy for detection without demosaic artifacts.
     */
    public static async analyzeBayerNative(
        bayer: Uint16Array,
        width: number,
        height: number,
        stride: number,
        logger: any, // TelemetryLogger
        scales?: ScaleManager,
        focalLength?: number,
        metadata?: any,
        horizonVector?: Uint16Array
    ): Promise<SignalPacket> {
        console.log(`[SignalProcessor] Native Bayer Analysis: ${width}x${height} (Stride: ${stride}) bitstream.`);
        
        // 1. Boundary Verification (NaN Safety)
        let nanCount = 0;
        const sampleCheck = 1000;
        for (let i = 0; i < Math.min(bayer.length, sampleCheck); i++) {
            if (isNaN(bayer[i])) nanCount++;
        }

        if (nanCount > 0) {
            console.error(`[SignalProcessor] CRITICAL: Found NaNs in the first ${sampleCheck} values of the Bayer buffer!`);
            throw new Error("Bayer bitstream is corrupted with NaNs at the boundary.");
        }

        const binW = scales ? scales.scienceW : Math.floor(width / 2);
        const binH = scales ? scales.scienceH : Math.floor(height / 2);

        // --- STEP 0: FORENSIC CALIBRATION ---
        // We MUST ingest the calibration strip BEFORE binning. 
        // This sets the correct black level in PhotometryManager so binBayerToLuminance 
        // doesn't clip data using default values.
        if (metadata?.sensorData?.calibrationStrip) {
            SensorCalibrationManager.setCalibrationStrip(metadata.sensorData.calibrationStrip);
            console.log(`[SignalProcessor] Forensic calibration applied BEFORE binning.`);
        }
        
        // --- STEP 1: CHROMATIC PROXY FOR TOPOGRAPHY ---
        // We need an RGB preview for the horizon logic to distinguish LP from Sky.
        // We demosaic a low-res version to keep it under 10ms.
        console.log(`[SignalProcessor] Generating Chromatic Proxy (Low-Res Demosaic)...`);
        const rgbProxy = DemosaicEngine.demosaicBilinear(bayer, width, height, stride || width);

        // --- CFA CLASSIFICATION (before binning; honest-or-absent verdict) ---
        // binBayerToLuminance hard-assumes a standard 2x2 CFA. Classify the raw
        // frame FIRST so we never silently mis-bin a mono sensor (ASI1600MM) or a
        // quad-Bayer sensor (2x2 same-colour super-cells). Detection is luminance-
        // only either way (correct); colour is measured downstream on the native
        // grid, so this routes the LUMINANCE derivation, not the colour path.
        const cfaBlack = PhotometryManager.getProfile().black_level;
        const cfaVerdict = DemosaicEngine.classifyCFA(bayer, width, height, stride || width, cfaBlack);
        console.log(`[SignalProcessor] CFA verdict: ${cfaVerdict.klass} (supported=${cfaVerdict.supported}) — ${cfaVerdict.reason}`);
        if (cfaVerdict.klass === 'quad-bayer') {
            // HONEST DEGRADATION: a naive 2x2 bin of a quad-Bayer sensor yields a
            // half-res COLOUR mosaic, not luminance. There is no quad-Bayer debinner
            // here, so we proceed on the best-effort 2x2 bin but flag it LOUD;
            // consumers read cfa_verdict.supported=false, and the fast-fail density
            // guard downstream will catch the mosaic if it explodes into noise.
            console.warn(`[SignalProcessor] QUAD-BAYER detected — 2x2 luminance binning is NOT valid for this sensor; detection proceeding FLAGGED-UNRELIABLE. ${cfaVerdict.reason}`);
        } else if (cfaVerdict.klass === 'mono') {
            // MONO: the WASM 2x2 kernel is an unweighted box SUM (no CFA colour
            // weighting), so binning a mono grid is a correct luminance downsample
            // — same code path, honestly labelled (not a "CFA" combine).
            console.log(`[SignalProcessor] MONO sensor — 2x2 box-average luminance (no CFA weighting applied).`);
        }

        // 2x2 bin. std-bayer -> true luminance; mono -> box-average luminance;
        // quad-bayer -> flagged best-effort proxy (see above).
        const { data: lum } = await DemosaicEngine.binBayerToluminance(
            bayer,
            stride || width,
            width,
            height,
            cfaBlack,
            PhotometryManager.getProfile().white_level
        );

        // Run the 3-Pass Masking logic on the blurred/Binned data
        const packet = await this.analyzeWithMasking(lum, rgbProxy, binW, binH, logger, focalLength, metadata, horizonVector);
        packet.scienceBuffer = lum; // [NATIVE OPTIMIZATION] Save binned buffer for Solver precision
        packet.cfa_verdict = cfaVerdict; // honest-or-absent: sensor mosaic verdict

        // RESTORE SENSOR COORDINATES (1:1 scale)
        SignalProcessor.restorePacketToNative(packet, scales);

        // The horizon was derived in binned science space; lift it to native
        // resolution so the UI overlay + receipts share the (restored) star
        // coordinate space. Same scaleManager mapping as the star restore.
        if (packet.horizonVector && scales) {
            const nvW = scales.nativeW;
            const nv = new Uint16Array(nvW);
            for (let nx = 0; nx < nvW; nx++) {
                const sx = Math.max(0, Math.min(binW - 1, Math.floor(nx * binW / nvW)));
                const nativePt = scales.scienceToNative(sx, packet.horizonVector[sx]);
                nv[nx] = Math.max(0, Math.min(scales.nativeH - 1, Math.round(nativePt.y)));
            }
            packet.horizonVector = nv;
        }

        console.log(`[SignalProcessor] Native Restore Complete: ${packet.clean_stars.length} stars.`);
        return packet;
    }

    /**
     * RESTORE SENSOR COORDINATES (science -> native un-binning).
     *
     * COORDINATE ledger: detections are measured on the 2x2-binned science
     * grid; every coordinate consumer downstream of detection (SignalGraphStep
     * overlay via nativeToCanvas, receipts) reads NATIVE sensor coordinates.
     * rawX/rawY archive the science-space position before scaling (forensic
     * traceability).
     *
     * [G4 fix] planet_candidates are restored too: they are drawn by the UI in
     * NATIVE coords exactly like clean_stars/anomalies (SignalGraphStep
     * nativeToCanvas), but were never un-binned — on 2x2-binned frames planets
     * rendered at ~half-scale positions.
     *
     * Idempotent per point: an ephemeris-confirmed planet can be the SAME
     * object in both clean_stars and planet_candidates (dual-membership — an
     * open owner design item; the taxonomy itself is NOT changed here), so
     * each SignalPoint is restored at most once no matter how many output
     * lists reference it.
     */
    public static restorePacketToNative(packet: SignalPacket, scales?: ScaleManager): void {
        const restored = new Set<SignalPoint>();
        const restore = (p: SignalPoint) => {
            if (restored.has(p)) return;
            restored.add(p);

            // [FIX] Archive science-space coordinates AS raw before any scaling
            p.rawX = p.x;
            p.rawY = p.y;

            if (scales) {
                // Ensure we use the scale manager for consistent mapping
                const native = scales.scienceToNative(p.x, p.y);
                p.x = native.x;
                p.y = native.y;
                // Scale FWHM correctly from binned to native
                p.fwhm *= (scales.nativeW / scales.scienceW);
            } else {
                // Fallback for 2x2 binning if scales is missing
                p.x *= 2;
                p.y *= 2;
                p.fwhm *= 2;
            }
        };

        packet.clean_stars.forEach(restore);
        packet.anomalies.forEach(restore);
        packet.planet_candidates?.forEach(restore);
    }

    /**
     * PASS-DRIVEN ANALYSIS (The 6-Phase Backbone)
     * Implements 3-Pass Dynamic Masking and Morphological Filtering.
     */
    public static async analyzeWithMasking(
        lum: Float32Array, 
        displayPreview: Float32Array | null, // 4K Display Buffer for memory efficiency
        width: number, 
        height: number,
        logger?: TelemetryLogger,
        focalLengthMm?: number,
        metadata?: any,
        horizonVector?: Uint16Array
    ): Promise<SignalPacket> {
        
        const { mean, stdDev } = this.calculateStats(lum);
        console.log(`[SignalProcessor] Stats - Mean: ${mean.toFixed(4)}, StdDev: ${stdDev.toFixed(4)}`);

        // TRUE culling tally (trust surface): counted at ASSIGNMENT time so it
        // includes hard-REJECTED candidates (dropped from every output list)
        // and planet-routed stars. The UI's per-reason counters read this —
        // counting anomalies[] alone under-reports both populations to zero.
        const cullingTally: Partial<Record<CullingReason, number>> = {};
        const tally = (reason: CullingReason | undefined) => {
            if (!reason || reason === 'NONE') return;
            cullingTally[reason] = (cullingTally[reason] || 0) + 1;
        };

        // --- THERMAL-ARTIFACT PRE-PASS (NEXT_MOVES §7) ---
        // Detection-support buffer only: master-dark subtraction when a dark
        // exists, statistical hot-pixel masking otherwise (copy-on-flag: zero
        // flags => detectLum === lum, byte-identical by construction). The
        // science buffer `lum` itself is NEVER modified — photometry,
        // Mie/Rayleigh and the background model keep reading the original grid.
        const hotPix = removeThermalArtifacts(
            lum, width, height, mean, stdDev, SensorCalibrationManager.getMasterDark()
        );
        const detectLum = hotPix.data;
        if (hotPix.method === 'MASTER_DARK') {
            console.log('[HotPixelMap] Master dark applied to the detection buffer.');
        } else if (hotPix.applied) {
            console.log(`[HotPixelMap] THERMAL-DOMINATED frame: ${hotPix.flagged} hot pixels masked before extraction (N=${PIPELINE_CONSTANTS.DETECT_HOTPIXEL_NSIGMA}σ spike over 8-neighbour median, neighbours at background, density >= ${PIPELINE_CONSTANTS.DETECT_HOTPIXEL_MIN_DENSITY_PER_MP}/MP).`);
        } else if (hotPix.flagged > 0) {
            console.log(`[HotPixelMap] ${hotPix.flagged} spike pixels measured but below the thermal-density gate (${PIPELINE_CONSTANTS.DETECT_HOTPIXEL_MIN_DENSITY_PER_MP}/MP) — buffer untouched.`);
        }
        // Calibration instrument: pixels that WOULD be flagged at an N ladder
        // (measured on the unmasked buffer; sets DETECT_HOTPIXEL_NSIGMA).
        console.log(`[HotPixelMap] candidate ladder ${JSON.stringify(measureHotPixelCandidates(lum, width, height, mean, stdDev))}`);

        // --- STEP 0.0: SENSOR CALIBRATION (Post-calibration backup) ---
        // Re-apply in case analyzeBayerNative wasn't called (isomorphic support)
        if (metadata?.sensorData?.calibrationStrip && SensorCalibrationManager.getBlackLevel() === 0) {
            SensorCalibrationManager.setCalibrationStrip(metadata.sensorData.calibrationStrip);
        }
        
        // Sample Sky Profile (Top visual area)
        if (displayPreview) {
            const topColor = this.sampleColor(displayPreview, width/2, height * 0.1, width, height);
            SensorCalibrationManager.setSkyProfile(topColor[0], topColor[1], topColor[2]);
        }

        // --- STEP 0: CONTEXTUAL ATMOSPHERIC PASS (Phase A: Atmosphere & Milky Way) ---
        const rayleigh = AtmosphericPhysics.detectRayleighGradient(lum, width, height);
        let milkyWayPoints = SourceExtractor.detectMilkyWay(lum, width, height, mean, stdDev);
        
        milkyWayPoints.sort((a, b) => b.brilliance - a.brilliance);
        // [TEMP] Placeholder horizon for MW logic until stars are extracted
        const tempHz = new Array(160).fill(0).map((_, i) => ({ x: i * (width/160), y: height * 0.8 }));

        // Legacy path traces the Milky Way against the height*0.8 placeholder
        // HERE (before the real terrain envelope exists). Item 4
        // (DETECT_MW_REAL_HORIZON): when the flag is ON and terrain evidence is
        // later found, we RE-TRACE against the measured silhouette below. Flag
        // OFF (and full-sky ON, where no terrain evidence exists) keeps this
        // placeholder trace — byte-identical.
        let mwCenterline = CelestialStructures.traceMilkyWayCenterline(milkyWayPoints, tempHz);
        let mwEllipses = CelestialStructures.generateMilkyWayEllipses(milkyWayPoints, tempHz);
        
        // --- PHASE 1: BACKGROUND SURFACE MODELING ---
        const bgModeler = new BackgroundSurfaceModeler();
        // We'll fit properly once we have the refined horizon and vanguard stars.

        if (milkyWayPoints.length > 50) {
            milkyWayPoints = milkyWayPoints.slice(0, 50);
        }

        // --- DETECTION-PLANE FLATTENING (EXPERIMENTAL — default-OFF, item 2) ---
        // OWNER TWO-PLANE LAW: this touches ONLY the detection-luminance COPY.
        // The science buffer `lum` stays NATIVE — photometry (pool.refineStars),
        // Mie/Rayleigh, the background model input, localBg and every receipt
        // measurement keep reading it. The render layer applies its OWN vignette
        // flatten on a SEPARATE copy (tools/rawlab/aesthetic_render.mjs) — same
        // physics, independent application, not doubling. Order: vignette gain
        // FIRST (here, before the surface fit + before extraction), then the
        // background-surface subtract on the deep pass (below). Flag OFF =>
        // detectFlat === detectLum and stats are reused => BYTE-IDENTICAL.
        let detectFlat = detectLum;
        let flattenStats = { mean, stdDev };
        if (PIPELINE_CONSTANTS.DETECT_APPLY_VIGNETTE_GAIN) {
            const vfit = fitVignetteFromDetectionLum(detectLum, width, height);
            if (vfit) {
                detectFlat = applyVignetteGainToLum(detectLum, width, height, vfit.a2, vfit.a4);
                flattenStats = this.calculateStats(detectFlat);
                console.warn(`[DetectionFlatten] EXPERIMENTAL vignette gain on DETECTION copy only: a2=${vfit.a2} a4=${vfit.a4} fitRms=${vfit.fitRms.toExponential(3)} cornerRatio ${vfit.cornerCenterRatioBefore.toFixed(3)}->${vfit.cornerCenterRatioAfter.toFixed(3)} (cells=${vfit.cells}${vfit.atGridBound ? ', AT-GRID-BOUND/APPROXIMATE' : ''}); bg ${mean.toFixed(4)}->${flattenStats.mean.toFixed(4)}. Science buffer NATIVE — photometry untouched.`);
            } else {
                console.warn('[DetectionFlatten] vignette gain SKIPPED: frame too sparse to fit honestly (honest-or-absent).');
            }
        }

        // --- VANGUARD THRESHOLD CALCULATION ---
        let sigmaCurrent = recalSigma('RECAL_SIGMA_BASE', 3.0); // unset ⇒ 3.0 (byte-identical)
        if (focalLengthMm) {
            const flFactor = 1.0 + Math.log10(focalLengthMm / 50 + 1);
            sigmaCurrent *= Math.max(0.6, Math.min(2.0, flFactor));
        }

        // Threshold + extraction stats track the detection buffer actually used
        // (flattenStats === {mean, stdDev} when the flag is off — byte-identical).
        let vanguardThreshold = flattenStats.mean + (flattenStats.stdDev * sigmaCurrent);
        if (vanguardThreshold > 0.95) vanguardThreshold = 0.95;

        console.log(`[SignalProcessor] Vanguard Threshold: ${vanguardThreshold.toFixed(4)} (sigma=${sigmaCurrent.toFixed(2)})`);

        // --- STEP 1: VANGUARD DETECTION ---
        // Extraction runs on the thermal-cleaned detection buffer; the per-blob
        // thermal cuts (detection_cuts.ts) then drop spike/junk blobs with
        // assignment-time tallies. Inert thresholds => both are pass-throughs.
        const vanguardRaw = await this.extractBlobs(detectFlat, width, height, vanguardThreshold, flattenStats.mean, flattenStats.stdDev, 'SignalProcessor.vanguard');
        const vanguardCandidates = cullThermalBlobs(vanguardRaw, (reason) => tally(reason));
        if (vanguardCandidates.length !== vanguardRaw.length) {
            console.log(`[DetectionCuts] vanguard: ${vanguardRaw.length - vanguardCandidates.length} thermal blobs cut (${vanguardCandidates.length} kept).`);
        }
        
        // --- STEP 1.1: REFINED HORIZON & BACKGROUND MODEL ---
        // EVIDENCE-BASED TOPOGRAPHY ONLY: a horizon exists only when terrain is
        // actually measured. An externally supplied horizonVector (future
        // boundary detector) wins; otherwise we DERIVE the terrain silhouette
        // from the vanguard detections via the detection-envelope method
        // (horizon_envelope.ts) — the horizon is written in the negative space
        // of the star field. That derivation is GATED on hasTerrainEvidence:
        // a full-sky frame (tracked telescope, no ground) yields no evidence,
        // so effectiveHorizonVector stays undefined, the background modeler
        // samples the full frame, and every TOPOGRAPHY cull below is skipped —
        // today's exact behavior, byte-identical by construction.
        let effectiveHorizonVector = horizonVector;
        if (!effectiveHorizonVector) {
            const envelope = computeHorizonEnvelope(vanguardCandidates, width, height);
            if (envelope.hasTerrainEvidence) {
                effectiveHorizonVector = this.envelopeToHorizonVector(envelope, width, height);
                console.log(`[SignalProcessor] Terrain evidence PRESENT (coverage=${envelope.coverage.toFixed(2)}) — deriving horizon from ${vanguardCandidates.length} vanguard detections; topography culling ENABLED.`);
            } else {
                console.log(`[SignalProcessor] No terrain evidence (coverage=${envelope.coverage.toFixed(2)}) — topography culling disabled (full-sky assumption).`);
            }
        }
        const hasMeasuredHorizon = !!effectiveHorizonVector;
        // gx-indexed silhouette (160 columns): fitSurface and the foreground
        // shielding gates below index this by column (floor(x / (width/160))).
        // Full-sky => a flat line at the frame bottom (no cull).
        const horizon = hasMeasuredHorizon
            ? this.horizonVectorToColumns(effectiveHorizonVector!, width)
            : new Array(160).fill(0).map((_, i) => ({ x: i * (width / 160), y: height }));

        // Fit the synthetic background surface to the sampled sky. When the
        // bg-surface flag is ON we fit on the (vignette-corrected) DETECTION copy
        // so the surface we subtract below is consistent with the buffer it is
        // subtracted from (owner order: vignette first, then background). Flag
        // OFF => fit on native `lum` exactly as before (byte-identical; the fit
        // result is unused when the flag is off — evaluate had zero callers).
        bgModeler.fitSurface(
            PIPELINE_CONSTANTS.DETECT_APPLY_BG_SURFACE ? detectFlat : lum,
            width, height, horizon, vanguardCandidates
        );

        // --- ITEM 4: DEFERRED MILKY-WAY TRACE (EXPERIMENTAL — default-OFF) ---
        // The legacy MW trace above ran against the height*0.8 placeholder before
        // any terrain was measured. When ON and terrain evidence exists, re-trace
        // against the MEASURED silhouette (`horizon`) so the ground-contamination
        // filter in trace/ellipses uses the real terrain, not a guess. Full-sky
        // frames (no terrain evidence) keep the placeholder trace — byte-identical.
        if (PIPELINE_CONSTANTS.DETECT_MW_REAL_HORIZON && hasMeasuredHorizon) {
            mwCenterline = CelestialStructures.traceMilkyWayCenterline(milkyWayPoints, horizon);
            mwEllipses = CelestialStructures.generateMilkyWayEllipses(milkyWayPoints, horizon);
            console.log('[SignalProcessor] MW trace RE-TRACED against the MEASURED terrain horizon (DETECT_MW_REAL_HORIZON=1).');
        }

        const vanguardStars: SignalPoint[] = [];
        const initialAnomalies: SignalPoint[] = [];

        for (const star of vanguardCandidates) {
            // [STRICT] Foreground Shielding: only with a MEASURED horizon
            const gx = Math.floor(star.x / (width / 160));
            const hzY = horizon[Math.min(159, Math.max(0, gx))].y;

            // Rejection zone starts 1px ABOVE the mask to ensure zero leakage
            if (hasMeasuredHorizon && star.y > hzY - 1) {
                star.culling_reason = 'TOPOGRAPHY';
                tally('TOPOGRAPHY');
                initialAnomalies.push(star);
                continue;
            }

            const filterResult = this.applyMorphologicalFilter(star, displayPreview, width, height, focalLengthMm);

            if (filterResult.status === 'REJECT') {
                star.culling_reason = filterResult.reason;
                tally(filterResult.reason);
                continue;
            }

            if (filterResult.status === 'ANOMALY') {
                star.culling_reason = filterResult.reason;
                tally(filterResult.reason);
                initialAnomalies.push(star);
            } else {
                vanguardStars.push(star);
            }
        }

        // --- STEP 2: DYNAMIC MASKING (Sky vs Ground) ---
        // Selective Vanguard: Only use high-confidence point sources for masking
        const maskingStars = vanguardStars.filter(s => s.circularity > 0.85 && s.snr > 100); // [STRICTER] Only huge stars carve voids
        const voidThreshold = mean + (stdDev * 1.5);
        let skyPolygon = (maskingStars.length > 5) ? this.carveVoids(maskingStars, voidThreshold, width, height) : []; 

        // --- ITEM 1: BACKGROUND-SURFACE SUBTRACT (EXPERIMENTAL — default-OFF) ---
        // The deg-2 surface was fit above (needs the vanguard stars + horizon),
        // so only the DEEP pass can consume it. Subtract it from the DETECTION
        // copy (vignette-corrected if that flag is also on) and recompute the
        // threshold stats on the flattened buffer — a surface-subtracted buffer
        // has its background near zero, so the old global mean would over-threshold.
        // Detection copy only; `lum` (science) is never touched.
        let detectDeep = detectFlat;
        let deepStats = flattenStats;
        if (PIPELINE_CONSTANTS.DETECT_APPLY_BG_SURFACE) {
            detectDeep = subtractBackgroundSurface(detectFlat, width, height, (x, y) => bgModeler.evaluate(x, y));
            deepStats = this.calculateStats(detectDeep);
            const c = bgModeler.coeffs();
            console.warn(`[DetectionFlatten] EXPERIMENTAL bg-surface subtracted from DEEP detection copy only: coeffs a=${c.a.toExponential(2)} b=${c.b.toExponential(2)} c=${c.c.toExponential(2)} d=${c.d.toExponential(2)} e=${c.e.toExponential(2)} f=${c.f.toExponential(2)}; deep bg ${flattenStats.mean.toFixed(4)}->${deepStats.mean.toFixed(4)}. Science buffer NATIVE.`);
        }

        // --- STEP 3: DEEP SCAN & REFINEMENT ---
        const deepSigma = 1.0; // [MAXIMUM FIDELITY] Down to 1.0 to find every possible photon source
        const deepThreshold = deepStats.mean + (deepStats.stdDev * deepSigma);
        console.log(`[SignalProcessor] Deep Scan Candidates Search... (Threshold: ${deepThreshold.toFixed(4)})`);
        console.log(`[SignalProcessor] Deep Scan Threshold: ${deepThreshold.toFixed(4)} (Fixed Sigma: ${deepSigma.toFixed(1)})`);

        const deepRaw = await this.extractBlobs(detectDeep, width, height, deepThreshold, deepStats.mean, deepStats.stdDev, 'SignalProcessor.deep');
        let deepCandidates = cullThermalBlobs(deepRaw, (reason) => tally(reason));
        if (deepCandidates.length !== deepRaw.length) {
            console.log(`[DetectionCuts] deep: ${deepRaw.length - deepCandidates.length} thermal blobs cut (${deepCandidates.length} kept).`);
        }
        console.log(`[SignalProcessor] Vanguard candidates: ${vanguardCandidates.length}, Deep candidates: ${deepCandidates.length}`);

        // --- FAST-FAIL DENSITY GUARD (dense / non-converging frame) ---
        // Both candidate counts are now known and NO expensive pass has run yet.
        // The next stages are O(deep x vanguard) (the dedup .some() scan) plus
        // fwhm^2-scaled per-star window scans — on a pathological frame they grind
        // for MINUTES (the ~470s silent hang). Bail LOUD + FAST here instead. The
        // predicate + calibration live in detection_guard (single source of truth,
        // unit-tested); Carina 60Da (9,613 deep/MP, 43k abs) is double-protected.
        const fastFail = evaluateDetectionDensity(
            deepCandidates.length, vanguardCandidates.length, width, height
        );
        if (fastFail) {
            // ITEM 3: density-guard regime (DETECT_DENSITY_GUARD_MODE). 0 = legacy
            // THROW (default). 1 = CAP: keep the top-N-by-flux deep candidates at
            // the density boundary and continue instead of bailing — bounds the
            // O(deep×vanguard) work to N. Does NOT move the calibrated guard
            // constants; only changes the action when they trip.
            if (PIPELINE_CONSTANTS.DETECT_DENSITY_GUARD_MODE === 1) {
                const cap = applyDensityCap(deepCandidates, width, height);
                for (const d of cap.dropped) {
                    d.culling_reason = 'HIGH_DENSITY';
                    tally('HIGH_DENSITY');
                }
                deepCandidates = cap.kept;
                console.warn(
                    `[SignalProcessor] DENSITY CAP engaged: kept ${cap.n} of ${cap.m} deep candidates ` +
                    `(${fastFail.deepDensityPerMP}/MP >= ${fastFail.thresholdPerMP}/MP on ${fastFail.detectionDims}, ` +
                    `${fastFail.megapixels} MP) — dropped ${cap.dropped.length} lowest-flux as HIGH_DENSITY. ` +
                    `EXPERIMENTAL cap mode (DETECT_DENSITY_GUARD_MODE=1); default is THROW.`
                );
            } else {
                console.error(`[SignalProcessor] FAST-FAIL: ${JSON.stringify(fastFail)}`);
                const err = new Error(
                    `Detection fast-fail: ${fastFail.deepCandidates} deep candidates ` +
                    `(${fastFail.deepDensityPerMP}/MP >= ${fastFail.thresholdPerMP}/MP) on a ` +
                    `${fastFail.detectionDims} (${fastFail.megapixels} MP) frame — ${fastFail.message}`
                );
                (err as any).diagnostic = fastFail;
                throw err;
            }
        }

        const finalStars: SignalPoint[] = [...vanguardStars];
        const finalAnomalies: SignalPoint[] = [...initialAnomalies];

        // Expansion Buffer for Micro-Refinement
        const expansionBuffer = 15; // Set to safe default instead of avgdistance dependency

        for (const star of deepCandidates) {
            // Deduplicate against vanguard (4px native)
            if (vanguardStars.some(v => Math.abs(v.x - star.x) < 4 && Math.abs(v.y - star.y) < 4)) {
                star.culling_reason = 'DEDUPLICATION';
                tally('DEDUPLICATION');
                finalAnomalies.push(star);
                continue;
            }

            // [STRICT] Foreground Shielding: only with a MEASURED horizon
            const gx = Math.floor(star.x / (width / 160));
            const hzY = horizon[Math.min(159, Math.max(0, gx))].y;

            if (hasMeasuredHorizon && star.y > hzY - 1) {
                star.culling_reason = 'TOPOGRAPHY';
                tally('TOPOGRAPHY');
                finalAnomalies.push(star);
                continue;
            }

            const filterResult = this.applyMorphologicalFilter(star, displayPreview, width, height, focalLengthMm);

            if (filterResult.status === 'REJECT') {
                star.culling_reason = filterResult.reason;
                tally(filterResult.reason);
                continue;
            }

            if (filterResult.status === 'ANOMALY') {
                star.culling_reason = filterResult.reason;
                tally(filterResult.reason);
                finalAnomalies.push(star);
            } else {
                finalStars.push(star);
            }
        }

        // --- NEW: SATELLITE/PLANE INTERVAL DETECTION ---
        // Analyze ALL candidates (Stars + Anomalies) to find trails
        const allCandidates = [...finalStars, ...finalAnomalies];
        const satelliteIntervals = this.detectLinearIntervalClusters(allCandidates);
        
        // --- NEW: EPHEMERIS-BASED PLANET IDENTIFICATION ---
        const ephemerisPlanets = await this.identifySolarBodies(finalStars, finalAnomalies, width, height, focalLengthMm, metadata);

        // --- NEW: SECOND-PASS ANOMALY CULLING (RANSAC, PLANETS, GLOW) ---
        console.log("[SignalProcessor] Filtering satellite trails and planets...");
        
        const culledStars: SignalPoint[] = [];
        const planetCandidates: SignalPoint[] = [];
        const culledAnomalies: SignalPoint[] = [...finalAnomalies];

        for (const s of finalStars) {
            // [AWARENESS] Atmospheric Scattering (Mie/Rayleigh)
            const mieIndex = AtmosphericPhysics.analyzeMieScattering(s, lum, width, height, mean);
            s.mie_index = mieIndex;
            
            const rayleighIndex = (rayleigh.top + rayleigh.bottom) / 2;
            s.rayleigh_index = rayleighIndex;

            // [GLOW REJECTION] DYNAMIC NOISE FLOOR
            const localBg = lum[Math.floor(s.y) * width + Math.floor(s.x)];

            // TODO(culling): these three gates cull the vast majority of REAL
            // stars on calibrated stacked FITS input and are DISABLED for now:
            // - BLACK FLOOR GUARD: a bias-subtracted stack sits at the black
            //   floor everywhere, so `localBg ~ blackFloor && snr < 15`
            //   matches nearly every faint star (hot pixels average out in
            //   stacks anyway).
            // - LIGHT_POLLUTION: culls stars sitting on galaxy halos / nebula
            //   glow (e.g. the Leo Triplet), not just skyglow.
            // - SATELLITE intervals: collinearity false-positives in dense
            //   fields cull chance-aligned real stars.
            // Re-enable once they are gated on actual format/exposure context.
            const ENABLE_AGGRESSIVE_CULLING = false;

            if (ENABLE_AGGRESSIVE_CULLING) {
                // [BLACK FLOOR GUARD] If the local background matches the forensic black floor,
                // this is likely sensor noise or a hot pixel, not a star.
                const forensicBlackF = SensorCalibrationManager.getBlackLevel() / 65535;
                if (localBg < (forensicBlackF + 0.001) && s.snr < 15) {
                    s.culling_reason = 'LOW_SNR';
                    tally('LOW_SNR');
                    culledAnomalies.push(s);
                    continue;
                }

                // If in a high-intensity background region, requires higher hurdle (Dynamic LP handling)
                if (localBg > (mean + stdDev * 2.0)) {
                    if (s.snr < 75 || s.circularity < 0.8) {
                        s.culling_reason = 'LIGHT_POLLUTION';
                        tally('LIGHT_POLLUTION');
                        culledAnomalies.push(s);
                        continue;
                    }
                }
            }

            if (ENABLE_AGGRESSIVE_CULLING && satelliteIntervals.has(s)) {
                s.culling_reason = 'SATELLITE';
                tally('SATELLITE');
                culledAnomalies.push(s);
            } else if ((s as any).isPlanet) {
                // [STRICT] Stiffened Planet Heuristic: Only allow if SNR is huge or ephemeris confirmed
                if (s.snr > 1200 || (s as any).locked) {
                    s.culling_reason = 'PLANET';
                    tally('PLANET');
                    planetCandidates.push(s);
                } else {
                    culledStars.push(s);
                }
            } else if (s.flux > 0.995 && s.peak_value > 0.995 && s.fwhm > 6.0 && s.circularity > 0.985) {
                // [STRICTER] Very bright and very circular
                s.culling_reason = 'PLANET';
                tally('PLANET');
                planetCandidates.push(s);
            } else {
                culledStars.push(s);
            }
        }
        
        // Add specific ephemeris planets if not already caught by heuristics
        for (const p of ephemerisPlanets) {
            if (!planetCandidates.includes(p)) {
                planetCandidates.push(p);
            }
        }

        // --- STEP 4: SPATIAL BINNING (Anomaly Density Mapping) ---
        const cellSize = 128;
        const gridW = Math.ceil(width / cellSize);
        const gridH = Math.ceil(height / cellSize);
        const anomalyGrid = new Uint32Array(gridW * gridH);

        for (const anomaly of culledAnomalies) {
            const gx = Math.floor(anomaly.x / cellSize);
            const gy = Math.floor(anomaly.y / cellSize);
            if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) {
                anomalyGrid[gy * gridW + gx]++;
            }
        }

        console.log(`[SignalProcessor] Post-Culling Stats: Clean=${culledStars.length}, Planets=${planetCandidates.length}, Anomalies=${culledAnomalies.length}`);
        console.log(`[SignalProcessor] Culling tally: ${Object.entries(cullingTally).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);

        return {
            clean_stars: culledStars.sort((a, b) => b.flux - a.flux),
            anomalies: culledAnomalies,
            planet_candidates: planetCandidates,
            culling_tally: cullingTally,
            background_level: mean,
            noise_floor: stdDev,
            sky_polygon: horizon,
            background_level_top: rayleigh.top,
            background_level_bottom: rayleigh.bottom,
            anomaly_grid: anomalyGrid,
            milky_way: milkyWayPoints,
            milky_way_ellipses: mwEllipses,
            milky_way_centerline: mwCenterline,
            // scattering_type intentionally ABSENT: nothing here attributes the
            // measured vertical brightness gradient to a scattering mechanism.
            // Emitting a hardcoded 'RAYLEIGH' was an unmeasured claim (LAW-3);
            // honest-or-absent means we omit the field until attribution exists.
            grid_w: gridW,
            grid_h: gridH,
            cell_size: cellSize,
            horizonVector: effectiveHorizonVector // measured/derived terrain silhouette (undefined = full-sky)
        };
    }

    /**
     * RANSAC-like Linear Detection for Satellites
     */
    private static detectLinearAnomalies(stars: SignalPoint[]): Set<SignalPoint> {
        const result = new Set<SignalPoint>();
        if (stars.length < 5) return result;

        // Optimized O(N^2) search space
        const grid = new SpatialLookup(stars, 300); // 300px broad phase

        for (let i = 0; i < stars.length; i++) {
            if (result.has(stars[i])) continue;
            const p1 = stars[i];
            
            // Limit search to neighbor buckets
            const line: SignalPoint[] = [p1];
            stars.forEach((p2, idx) => {
                if (idx > i && Math.abs(p1.x - p2.x) < 300 && Math.abs(p1.y - p2.y) < 300) {
                    line.push(p2);
                }
            });

            if (line.length >= 10) { 
                if (this.isLinear(line)) line.forEach(s => result.add(s));
            }
        }
        return result;
    }

    /**
     * SATELLITE INTERVAL DETECTOR (Strobe pattern detection)
     * Optimized [O(N^2)] using Spatial Hash Grid
     */
    private static detectLinearIntervalClusters(points: SignalPoint[]): Set<SignalPoint> {
        const satelliteSet = new Set<SignalPoint>();
        if (points.length < 3) return satelliteSet;

        // Prune candidates: Only check points with decent signal to avoid O(N^3) on noise
        const candidates = points.filter(p => p.snr > 12 || p.flux > 0.05);
        if (candidates.length > 3000) return satelliteSet; // Safety bail for ultra-dense fields

        const grid = new SpatialLookup(candidates, 64);
        const distTolerance = 12.0; 

        for (let i = 0; i < candidates.length; i++) {
            const p1 = candidates[i];
            if (satelliteSet.has(p1)) continue; // SKIP if already identified

            for (let j = i + 1; j < candidates.length; j++) {
                const p2 = candidates[j];
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                
                if (dist < 20 || dist > 800) continue; 

                const candidateString = [p1, p2];
                let curP = p2;

                while (candidateString.length < 15) { // Safety loop limit
                    const nextX = curP.x + dx;
                    const nextY = curP.y + dy;
                    
                    const nextP = grid.findNear(nextX, nextY, distTolerance, candidateString);

                    if (nextP) {
                        candidateString.push(nextP);
                        curP = nextP;
                    } else {
                        break;
                    }
                }

                if (candidateString.length >= 4) {
                    candidateString.forEach(p => satelliteSet.add(p));
                }
            }
        }
        return satelliteSet;
    }

    private static isLinear(points: SignalPoint[]): boolean {
        if (points.length < 4) return false;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        const n = points.length;
        for (const p of points) {
            sumX += p.x; sumY += p.y;
            sumXY += p.x * p.y; sumX2 += p.x * p.x;
        }
        const den = (n * sumX2 - sumX * sumX);
        if (Math.abs(den) < 1e-6) return false;
        const slope = (n * sumXY - sumX * sumY) / den;
        const intercept = (sumY - slope * sumX) / n;
        let maxError = 0;
        for (const p of points) {
            const err = Math.abs(p.y - (slope * p.x + intercept));
            if (err > maxError) maxError = err;
        }
        return maxError < 8.0; // Tightened from 15.0 to ensure strict linearity
    }

    /**
     * REPAIRED: Morphological Filter (The bouncer)
     * Returns the PASS status and a specific CullingReason if rejected.
     */
    private static applyMorphologicalFilter(p: SignalPoint, preview: Float32Array | null, w: number, h: number, focalLength?: number): { status: 'PASS' | 'ANOMALY' | 'REJECT', reason: CullingReason } {
        const distFromCenter = Math.sqrt(Math.pow(p.x - w/2, 2) + Math.pow(p.y - h/2, 2));
        const maxDist = Math.sqrt(Math.pow(w/2, 2) + Math.pow(h/2, 2));
        const normalizedDist = distFromCenter / maxDist; 

        // REJECT 1: Extreme Smallness (Noise/Jitter)
        if (p.flux < 0.05 && p.snr < 5) return { status: 'REJECT', reason: 'LOW_SNR' };
        if (p.fwhm < 0.40) return { status: 'REJECT', reason: 'CIRCULARITY' }; 

        // [RE-balanceD] Wide-Field Lenience (Sidereal Drift/Coma/Trails).
        // Drifted stars are LINEAR but have moderate length. Hot pixels are ROUND but TINY.
        const fl = focalLength || 50;
        const isWide = fl <= 35; 
        
        // 1. Hot Pixel Detection: Round, tiny, and bright
        // [ULTRA-LENIENT] Wide shots often have sub-pixel stars. 
        // Only kill if FWHM is physically impossible (< 0.6) AND perfectly circular.
        if (p.fwhm < 0.6 && p.circularity > 0.95) {
            if (p.snr > 300) return { status: 'ANOMALY', reason: 'LOW_SNR' }; // Hot pixel
            return { status: 'REJECT', reason: 'CIRCULARITY' }; 
        }

        // 2. Trail Rejection: Extremely long streaks (Satellites)
        if (p.circularity < 0.05 && p.fwhm > 50) return { status: 'ANOMALY', reason: 'SATELLITE' };

        // 3. Wide-Field Circularity Rejection: Only reject if extremely low SNR + weird shape
        const minCircularity = (isWide ? 0.01 : 0.04) - (normalizedDist * 0.01);
        if (p.circularity < minCircularity) {
            // Even if circularity is low, if it has decent SNR, it's a trailed star!
            return p.snr > 12 ? { status: 'PASS', reason: 'NONE' } : { status: 'REJECT', reason: 'CIRCULARITY' };
        }

        // ANOMALY 2: Extreme Bloat
        if (p.fwhm > 250) return { status: 'ANOMALY', reason: 'CIRCULARITY' }; 

        if (preview) {
             const color = this.sampleColor(preview, p.x, p.y, w, h);
             p.peak_rgb = color;
             
             // Calculate B-V Color Index: Standard photographic approximation B-V = -2.5 * log10(B/G)
             // Blue stars have negative values, Red stars positive.
             if (color[1] > 0 && color[2] > 0) {
                 p.measured_bv = -2.5 * Math.log10(color[2] / color[1]);
             }

             if (!this.isOnPlanckianLocus(color)) {
                // [GENTLE] Chromatic aberration is common. Only flag if it's a "blaze" of impossible color.
                return (p.snr > 180 && p.flux > 0.9) ? { status: 'ANOMALY', reason: 'COLOR_SNR' } : { status: 'PASS', reason: 'NONE' };
             }
        }

        return { status: 'PASS', reason: 'NONE' };
    }

    public static calculateStats(data: Float32Array) {
        return StatisticsProvider.calculateStats(data);
    }

    /**
     * Rasterise a horizon envelope (column-centred nodes) into the per-pixel
     * `Uint16Array horizonVector` the culler + UI consume (value = terrain y at
     * column x). Linear-interpolates between adjacent envelope nodes and clamps
     * to [0, height-1] so the Uint16 stays in-frame.
     */
    private static envelopeToHorizonVector(
        env: ReturnType<typeof computeHorizonEnvelope>,
        width: number,
        height: number
    ): Uint16Array {
        const vec = new Uint16Array(width);
        const pts = env.points;
        const n = pts.length;
        const clampY = (y: number) => Math.max(0, Math.min(height - 1, Math.round(y)));
        if (n === 0) { vec.fill(clampY(height - 1)); return vec; }
        if (n === 1) { vec.fill(clampY(pts[0].y)); return vec; }
        // Node i sits at column centre (i + 0.5) * (width / n).
        const colW = width / n;
        for (let x = 0; x < width; x++) {
            const f = x / colW - 0.5;         // fractional node index
            const base = Math.floor(f);
            const i0 = Math.max(0, Math.min(n - 1, base));
            const i1 = Math.max(0, Math.min(n - 1, base + 1));
            const t = Math.max(0, Math.min(1, f - base));
            vec[x] = clampY(pts[i0].y + (pts[i1].y - pts[i0].y) * t);
        }
        return vec;
    }

    /**
     * Sample a per-pixel horizonVector into the 160-column, gx-indexed
     * silhouette that `fitSurface` and the foreground-shielding gates read
     * (they index `horizon[floor(x / (width/160))]`). Mirrors the full-sky
     * fallback's shape so the measured path reuses the same tested indexing.
     */
    private static horizonVectorToColumns(vec: Uint16Array, width: number): Point[] {
        const cols: Point[] = new Array(160);
        const colW = width / 160;
        for (let i = 0; i < 160; i++) {
            const x = i * colW;
            const xi = Math.max(0, Math.min(vec.length - 1, Math.floor(x)));
            cols[i] = { x, y: vec[xi] };
        }
        return cols;
    }

    private static async extractBlobs(
        lum: Float32Array,
        w: number,
        h: number,
        thresh: number,
        bg: number,
        sigma: number,
        siteLabel?: string
    ): Promise<SignalPoint[]> {
        const wasmModule = await import('@/engine/wasm_compute/pkg/wasm_compute.js');
        const wasm = await wasmModule.default();

        // [SINGLE-COPY WASM HANDOFF]
        // Writing directly to the WASM heap avoids wasm-bindgen's TWO-copy slice
        // path, but it is NOT O(1): the heap VIEW is O(1), while .set(lum) is one
        // O(N) memcpy into linear memory (MEASURED: ~0.25 ms @ 8 MB -> ~12.8 ms
        // @ 216 MB, ~14-34 GB/s — test_results/arrow_serialization_walls_2026-07-11).
        const ptr = wasmModule.get_input_buffer_ptr(lum.length);
        const wasmHeap = new Float32Array(wasm.memory.buffer, ptr, lum.length);
        wasmHeap.set(lum);

        const rawData = wasmModule.extract_blobs_shared(ptr, w, h, thresh, bg);

        const blobs: SignalPoint[] = [];
        let blobIdCounter = 0;

        // Data format: [x, y, rawX, rawY, flux, peak, fwhm, circularity, theta, snr]
        for (let i = 0; i < rawData.length; i += 10) {
            // Thermal-noise shape statistics, measured TS-side on the same
            // detection buffer the blob was extracted from (detection_cuts.ts;
            // the WASM fwhm field clamps for tiny blobs — see module header).
            const shape = computeBlobShapeStats(
                lum, w, h, rawData[i], rawData[i+1], bg, rawData[i+5], rawData[i+4]
            );
            blobs.push({
                id: ++blobIdCounter,
                x: rawData[i],
                y: rawData[i+1],
                rawX: rawData[i+2],
                rawY: rawData[i+3],
                flux: rawData[i+4],
                peak: rawData[i+5],
                peak_value: rawData[i+5],
                fwhm: rawData[i+6],
                circularity: rawData[i+7],
                ellipticity: 1.0 - rawData[i+7],
                theta: rawData[i+8],
                snr: rawData[i+9],
                sharpness: shape.sharpness ?? undefined,
                moment_fwhm_px: shape.momentFwhmPx ?? undefined,
                moment_ellipticity: shape.momentEllipticity ?? undefined,
            });
        }

        // Calibration instrument: measured shape distributions per site.
        if (siteLabel) {
            logShapeDistributions(
                siteLabel,
                blobs.map(b => ({
                    sharpness: b.sharpness ?? null,
                    momentFwhmPx: b.moment_fwhm_px ?? null,
                    momentEllipticity: b.moment_ellipticity ?? null,
                })),
                blobs.map(b => b.fwhm)
            );
        }

        return blobs;
    }

    private static sampleColor(preview: Float32Array, x: number, y: number, fullW: number, fullH: number): [number, number, number] {
        // 1. Calculate the actual width of the preview buffer
        const previewPixelCount = preview.length / 3;
        const aspectRatio = fullW / fullH;
        const previewW = Math.sqrt(previewPixelCount * aspectRatio);
        const scale = previewW / fullW;

        // 2. Scale the star's X/Y down to the 4K buffer size
        const ix = Math.floor(x * scale);
        const iy = Math.floor(y * scale);
        const pW = Math.floor(previewW);
        const pH = Math.floor(previewPixelCount / pW);

        // 3. SECURE 2x2 MEAN SAMPLING (Avoid noise spikes)
        let r = 0, g = 0, b = 0, c = 0;
        for (let dy = 0; dy <= 1; dy++) {
            for (let dx = 0; dx <= 1; dx++) {
                const tx = ix + dx;
                const ty = iy + dy;
                if (tx >= 0 && tx < pW && ty >= 0 && ty < pH) {
                    const idx = (ty * pW + tx) * 3;
                    r += preview[idx];
                    g += preview[idx+1];
                    b += preview[idx+2];
                    c++;
                }
            }
        }
        
        if (c === 0) return [0, 0, 0];
        return [r/c, g/c, b/c];
    }

    private static analyzeMieScattering(star: SignalPoint, lum: Float32Array, width: number, height: number, mean: number): number {
        const radius = 6;
        let sum = 0;
        let count = 0;
        const vals: number[] = [];

        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = Math.floor(star.x + dx);
                const y = Math.floor(star.y + dy);
                if (x >= 0 && x < width && y >= 0 && y < height) {
                    const val = lum[y * width + x];
                    sum += val;
                    vals.push(val);
                    count++;
                }
            }
        }

        if (count === 0) return 0;
        const localMean = sum / count;
        let sqDiffSum = 0;
        vals.forEach(v => sqDiffSum += Math.pow(v - localMean, 2));
        const variance = sqDiffSum / count;
        const stdDev = Math.sqrt(variance);
        
        return stdDev / (mean + 0.001);
    }

    private static isOnPlanckianLocus(color: [number, number, number]): boolean {
        const [r, g, b] = color;
        
        // [FIX] Brightness Guard: If the pixel is very dim, spectral data is unreliable noise.
        const brightness = (r + g + b) / 3;
        if (brightness < 0.02) return true; // Assume pass for dim stars

        // Simple heuristic: Green LEDs or monochromatic noise are not stars.
        // Stars follow a R->W->B curve.
        // [RELAXED] Allowing significantly more green for Bayer patterns and noise.
        const isGreenLed = g > (r * 2.8) && g > (b * 2.8);
        if (isGreenLed) return false;

        const isMagenta = (r + b) > (g * 8.0);
        if (isMagenta) return false;

        return true;
    }

    /**
     * REPAIRED: Edge-Carve Sky Mask (The Cookie Cutter)
     */
    private static carveVoids(stars: SignalPoint[], threshold: number, w: number, h: number): Point[] {
        const gridW = 32;
        const gridH = 32;
        const cellW = w / gridW;
        const cellH = h / gridH;
        
        const occupancy = new Uint8Array(gridW * gridH);
        for (const star of stars) {
            const gx = Math.floor(star.x / cellW);
            const gy = Math.floor(star.y / cellH);
            if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) {
                occupancy[gy * gridW + gx] = 1;
            }
        }

        // Trace from bottom to top
        const ridgeline = new Int32Array(gridW).fill(0); // [FIX] Default to SKY (0) not -1
        for (let gx = 0; gx < gridW; gx++) {
            for (let gy = gridH - 1; gy >= 0; gy--) {
                if (occupancy[gy * gridW + gx] === 1) {
                    ridgeline[gx] = gy;
                    break;
                }
            }
        }

    // REPAIR 4: Close the Geometric Gap.
    // Ensure the polygon snaps flush to the right edge (w) of the image.
    const poly: Point[] = [{x: 0, y: 0}, {x: w, y: 0}];
    
    for (let gx = gridW - 1; gx >= 0; gx--) {
        const gy = ridgeline[gx];
        const px = (gx === gridW - 1) ? w : gx * cellW; // Snapping logic
        poly.push({ x: px, y: Math.min(h, (gy + 1) * cellH) });
    }
    
    poly.push({x: 0, y: h}, {x: 0, y: 0});
    return poly;
}

    private static isPointInPolygon(x: number, y: number, poly: Point[]): boolean {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    private static isPointInExpandedPolygon(x: number, y: number, poly: Point[], buffer: number): boolean {
        // Broad phase: Check distance to vertices (simplified)
        for (const p of poly) {
            const dx = p.x - x;
            const dy = p.y - y;
            if (Math.sqrt(dx*dx + dy*dy) < buffer) return true;
        }
        return false;
    }
    /**
     * Pixel scale (arcsec per DETECTION-grid pixel) for the ephemeris planet
     * match, derived from the MEASURED sensor pitch — never a fabricated
     * default (owner-ruled 2026-07-10; the previous code hardcoded 4um for
     * every sensor).
     *
     * COORDINATE ledger notes:
     * - `meta.pixel_pitch_um` is the NATIVE physical pitch (FITS header XPIXSZ
     *   at ingest, or EXIF+sensor-DB once metrology has run).
     * - Detections may live on a 2x2-binned science grid (analyzeBayerNative),
     *   so the native pitch is scaled by the native->detection bin factor
     *   (meta.width / detectionW — meta.width is synced to the native sensor
     *   width in step 2 before detection). When meta.width is absent the
     *   detection grid IS the native grid for every current caller (direct
     *   analyzeWithMasking, unbinned luminance), so the factor is identity —
     *   a coordinate-space fact, not a fabricated sensor property.
     *
     * Returns null when the pitch is absent/unmeasured — callers must skip the
     * positional match (honest degradation), never substitute a made-up pitch.
     */
    public static ephemerisMatchPixelScale(meta: any, detectionW: number, fl: number): number | null {
        const pitchUm = meta?.pixel_pitch_um;
        if (typeof pitchUm !== 'number' || !(pitchUm > 0) || !(fl > 0)) return null;
        const binFactor = (typeof meta?.width === 'number' && meta.width > 0 && detectionW > 0)
            ? meta.width / detectionW
            : 1;
        return 206265 * ((pitchUm * binFactor) / 1000 / fl); // arcsec / detection px
    }

    /**
     * Identifies solar system bodies using the Ephemeris engine and metadata hints.
     */
    private static async identifySolarBodies(stars: SignalPoint[], anomalies: SignalPoint[], w: number, h: number, fl?: number, meta?: any): Promise<SignalPoint[]> {
        const matches: SignalPoint[] = [];
        // gps_source === 'DEFAULT' is a truthy-but-fabricated fallback location
        // (metadata_reaper's assumed default); running the ephemeris against it
        // would produce PHANTOM planetary anchors. Mirror psf_attribution.ts's
        // gpsReal gate and require a real (non-DEFAULT) fix. Monotonic: adding
        // this predicate can only ever REDUCE what planets may match on.
        if (!meta?.timestamp || !meta?.gps_lat || !meta?.gps_lon || meta?.gps_source === 'DEFAULT') return matches;
        
        try {
            const date = new Date(meta.timestamp);
            const EphemerisModule = await import('../../core/EphemerisEngine');
            const allBodies = EphemerisModule.EphemerisEngine.calculateSolarSystem(date, meta.gps_lat, meta.gps_lon);
            
            // [STRICT] Only look for high-confidence visible objects (Major Planets + Moon)
            const MAJOR_BODIES = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'luna'];
            const visibleBodies = allBodies.filter(b => 
                MAJOR_BODIES.includes(b.id) && 
                (b.altitude ?? -90) > 0 && 
                b.mag < 6
            ); 

            if (meta.ra_hint !== undefined && meta.dec_hint !== undefined && fl) {
                // Pixel scale from the MEASURED sensor pitch (owner-ruled fix,
                // 2026-07-10): this was a hardcoded 0.004mm (4um) literal
                // applied to every sensor — SeeStar is 2.9um, a 5D3 6.25um —
                // scaling the predicted planet offset by up to ~1.5-2x and
                // pushing real bodies outside the 15px match gate below.
                const pixelScale = SignalProcessor.ephemerisMatchPixelScale(meta, w, fl);
                if (pixelScale === null) {
                    // HONEST DEGRADATION (no fabricated default): without a
                    // measured pixel pitch the arcsec offsets below cannot be
                    // projected into detection pixels. Skip the positional
                    // match and record why — mis-labelling a star as a planet
                    // from a made-up scale is worse than no label.
                    console.warn('[SignalProcessor] Ephemeris positional planet-match SKIPPED: metadata.pixel_pitch_um is absent/unmeasured (no fabricated pitch default — honest-or-absent).');
                    return matches;
                }

                for (const body of visibleBodies) {
                    const dRA = (body.ra - meta.ra_hint) * 15 * 3600 / pixelScale;
                    const dDec = (body.dec - meta.dec_hint) * 3600 / pixelScale;
                    
                    // [STRICT] Tighten search to 15px. If it's further, it's just a random star.
                    const match = stars.find(s => {
                        const dx = (s.x - w/2) - dRA;
                        const dy = (s.y - h/2) - dDec;
                        return Math.sqrt(dx*dx + dy*dy) < 15; 
                    });

                    if (match) {
                        (match as any).isPlanet = true;
                        (match as any).label = body.name;
                        matches.push(match);
                        console.log(`[SignalProcessor] Ephemeris MATCH: ${body.name} at (${match.x.toFixed(1)}, ${match.y.toFixed(1)})`);
                    }
                }
            }
        } catch (err) {
            console.error("[SignalProcessor] Ephemeris identification failed:", err);
        }
        return matches;
    }
}

/**
 * Spatial Hash Grid for O(1) coordinate lookups
 */
class SpatialLookup {
    private grid = new Map<string, SignalPoint[]>();
    private cellSize: number;

    constructor(points: SignalPoint[], cellSize: number) {
        this.cellSize = cellSize;
        for (const p of points) {
            const gx = Math.floor(p.x / cellSize);
            const gy = Math.floor(p.y / cellSize);
            const key = `${gx}_${gy}`;
            if (!this.grid.has(key)) this.grid.set(key, []);
            this.grid.get(key)!.push(p);
        }
    }

    findNear(x: number, y: number, tolerance: number, exclude: SignalPoint[]): SignalPoint | undefined {
        const gx = Math.floor(x / this.cellSize);
        const gy = Math.floor(y / this.cellSize);
        
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const key = `${gx + dx}_${gy + dy}`;
                const cell = this.grid.get(key);
                if (cell) {
                    const found = cell.find(p => 
                        !exclude.includes(p) &&
                        Math.abs(p.x - x) < tolerance && 
                        Math.abs(p.y - y) < tolerance
                    );
                    if (found) return found;
                }
            }
        }
        return undefined;
    }
}




