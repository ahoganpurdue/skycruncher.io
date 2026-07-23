/**
 * -----------------------------------------------------------------
 * ORCHESTRATOR SESSION - Pipeline Execution State
 * -----------------------------------------------------------------
 */

import { HardMetadata, SignalPacket, SolarBody, HardwareProfile, PlateSolution, SignalPoint, ForensicMetrics, SolveResult, SolveDiagnostics } from '@/engine/types/Main_types';
import { parseExif, detectMagicFormatSync } from './m1_ingestion/metadata_reaper';
import { isDemoTierFormat } from './m1_ingestion/format_registry';
import { PIPELINE_CONSTANTS, recordExperimentalMarker } from './constants/pipeline_config';
import { isRawlerDecoderEnabled, summarizeRawlerCalibration } from './m1_ingestion/rawler_decoder';
import { TelemetryLogger } from '../diagnostics/telemetry_logger';
import { DEFAULT_PIPELINE_CONFIG } from '../diagnostics/telemetry_config';
import { ScaleManager } from './m2_hardware/scale_manager';
import { ImageProcessor } from '../core/ImageProcessor';
import { resolveColorTransform, describeColorMode, type ColorTransform } from '../core/camera_color_matrix';
import { makeImageData } from '../core/image_data_like';
import { TimeService } from '../core/TimeService';
import { SkyTransform } from '../core/SkyTransform';
import { UnitConverter } from '../core/UnitConverter';
import { 
    createBlankManifest, PhotographyData, MemoryResidency, StarCount, StarRepresentation, 
    AstronomicalLocation, CoordinateSystem, QualityMetrics 
} from '../types/manifest';
import type { PipelineManifest } from '../types/manifest';
import { ManifestTransaction } from './manifest_transaction';
import { OpticsManager } from '../core/optics_manager';
import type { OpticsHint } from '../core/optics_hint_provider';
import { resolveVerifyTuning, type SolveContextParams } from './stages/solve_context';
import { detectSignal, isNativeBayer, selectCuratedStars } from './stages/detect';
import { reduceToLuminance, LUMA_REC709, LUMA_EQUAL } from './m4_signal_detect/luminance_reduce';
import { resolveScaleLock, resolveGuestList } from './stages/metrology';
import { resolveWizardHints, runSolve, type CallerTargetHint, type WizardHintResolution } from './stages/solve';
import { StarCatalogAdapter } from './m6_plate_solve/star_catalog_adapter';
import { applyAstrometricRefinement, generateHardwareProfile } from './stages/calibrate';
import { runSpcc, surfaceSpccPerStar } from './stages/science';
import { buildReceipt, buildFailureReceipt, buildFailureDiagnosticsBlock } from './stages/package';
import type { StageTimingSummary } from '../events/stage_timing_summary';
import type { UserAnnotations } from './stages/user_annotations';
import type { HorizonCorrectionRecord } from './m4_signal_detect/horizon_editor';
import { depositFromReceipt, currentWorkbenchStorage } from './stages/workbench_deposit';
import { deriveRigKey, poolWorkbenchPrior, resolveIdentityProfile, type ObservationDeposit } from './m2_hardware/workbench_store';
import { resolveLensDistortion, type LensDistortionResolution, type IdentityDistortionProfile } from './m2_hardware/lens_distortion';
import { deriveTrainHashFromMetadata, isRegisteredTrainIdentity } from './m2_hardware/optical_train';
import { decodeScienceFrame } from './stages/ingest';
import { runPsfStage, type PsfReport, type PsfStageOptions } from './m10_psf/psf_stage';
import { runPsfCharacterization } from './stages/psf_characterize';
import type { PsfFieldReport } from './m10_psf/psf_field';
import { runPsfAttribution, type PsfAttributionReport } from './stages/psf_attribution';
import { runFinalAstrometry, type FinalAstrometryReport } from './stages/final_astrometry';
import { measureBrownConradyFromSolution, type MeasuredDistortion } from './m2_hardware/lens_distortion_refit';
import { runBcRematchPass, type BcRematchReceipt } from './m2_hardware/lens_distortion_rematch_pass';
import { runPostSolveConfirmation, resolveLensDistortionForContext } from './m6_plate_solve/solver_entry';
import { loadSearchPriorModel } from './m6_plate_solve/search_priors_loader';
import type { SearchPriorModel } from './m6_plate_solve/search_priors';
import type { FramePsfRef } from './m6_plate_solve/forced_confirm';
import { generateGpuPreview, generateCpuPreview, generateGpuFloat32Preview } from './m3_gpu_preprocess/preview_pipeline';
import { type ComputeRouteStamp, computeRouteStamp } from './m3_gpu_preprocess/compute_routes';
import { PipelineEventBus, type StageVerdict } from '../events/pipeline_events';
import { CaptureRecorder, sha256Hex } from '../events/capture_record';
import { STEP_META } from '../ui/wizard_steps';
import { getOklabRenderPref } from '../ui/render_prefs';
import { detectCorrectedView, selectRenderWarp, type CorrectedViewInfo, type CorrectedViewSource, type RenderWarpSelection } from '../ui/corrected_view';
import type { RenderWarp, RenderAdmission } from '../core/ImageProcessor';
import { SEAM_CAPTURE_ENABLED, captureSeam, type SeamSessionView } from './seam_capture';

/**
 * Behavioral feature flag read at call time (mirrors pipeline_config's
 * envIntOverride pattern): a Node/headless/test env var of the SAME NAME set to a
 * non-zero int turns the flag ON; in the browser `process` is undefined ⇒ always
 * OFF (default). Read per-call (not module-load) so tests can toggle it. Byte-
 * identical when the env var is unset — these two flags default OFF.
 */
function envFlagOn(key: string): boolean {
    try {
        if (typeof process !== 'undefined' && process.env && process.env[key] != null) {
            const v = parseInt(String(process.env[key]), 10);
            return Number.isFinite(v) && v !== 0;
        }
    } catch { /* no process (browser) → OFF */ }
    return false;
}

/** Rung-3 read-back: seed the solve with a pooled same-rig distortion prior. Default OFF. */
export const SOLVER_WORKBENCH_PRIOR_FLAG = 'SOLVER_WORKBENCH_PRIOR';
/**
 * Rung-0 read-back: seed the solve with an optical-train IDENTITY measured profile
 * (SHA256(camera+lens+filter) match to a previously-calibrated setup — Feb-2026
 * spec). Default OFF: deposits exist under MODEL_ONLY from prior runs, so pin-
 * safety must be PROVEN with a populated store before graduation, not assumed.
 * envFlagOn mirrors pipeline_config's envIntOverride (non-zero int = ON).
 */
export const SOLVER_IDENTITY_PROFILE_FLAG = 'SOLVER_IDENTITY_PROFILE';
/** Bank a measured diagnostic block into the NO-SOLVE receipt. Default OFF. */
export const SOLVE_FAILURE_DIAGNOSTICS_FLAG = 'SOLVE_FAILURE_DIAGNOSTICS';

export type SessionState = 'IDLE' | 'LOADING' | 'EXTRACTING' | 'ALIGNING' | 'SOLVING' | 'CALIBRATING' | 'INTEGRATING' | 'COMPLETE' | 'FAILED' | 'BUSY';

// ═══════════════════════════════════════════════════════════════════════════
// PRE-DETECTION PIXEL TRANSFORM (PIXEL-ledger seam; honest-or-absent)
// ═══════════════════════════════════════════════════════════════════════════
//
// An OPTIONAL caller hook applied in step2 AFTER decode + luminance/preview
// derivation and BEFORE detectSignal — the one place a caller may reshape the
// DETECTION-INPUT pixels (e.g. a nebulosity/background LIFT so a bright diffuse
// band cannot flood detection). It NEVER touches WCS / matched_stars / the
// solver — it only reshapes the pixels detection thresholds against. Absent
// (undefined/null) ⇒ this seam is dead code and every pinned reference solve is
// byte-identical. When the hook returns a `marker`, the run is stamped
// experimental in the receipt (config_overrides.<name>) via the config-override
// surface, so a lifted run can never be mistaken for a calibrated one.

/** Decoded detection buffers handed to a pre-detection transform (read-only view). */
export interface PreDetectFrame {
    /** Full-res luminance Float32 (w*h) — the luminance-path detection input. */
    scienceBuffer: Float32Array;
    /** Preview-sized RGB Float32 (masking support), or null. */
    previewFloat32: Float32Array | null;
    /** Full-res linear RGB Float32 (interleaved, w*h*3) — for per-channel work. */
    fullRGB: Float32Array;
    width: number;
    height: number;
    previewWidth: number;
    previewHeight: number;
}

/** What a pre-detection transform hands back. Omitted buffers keep the originals. */
export interface PreDetectResult {
    /** Replacement luminance detection buffer (same w*h), or omit to keep the original. */
    scienceBuffer?: Float32Array;
    /** Replacement preview RGB buffer (same layout as the input), or omit to keep it. */
    previewFloat32?: Float32Array;
    /** Self-description stamped into the receipt's config_overrides (experimental marker). */
    marker?: { name: string; descriptor: Record<string, unknown> };
}

export type PreDetectTransform = (frame: PreDetectFrame) => PreDetectResult | null | void;

/**
 * DEFAULT-OFF feature flag: parity-guarded detection luminance for LibRaw
 * CFA-mosaic frames (see computeluminance). A per-site single-colour "RGB"
 * (LibRaw noInterpolation) reduced by Rec.709 weights imprints a 2px period-2
 * checkerboard on the detection buffer (MEASURED on the bundled CR2: parity
 * amplitude 0.604 -> 0.035 under equal weights, a 94.3% reduction). Because it
 * changes CR2 detections it can move the blind-solve matched count, so it ships
 * OFF (both sacred e2e stay byte-identical). For the A/B measurement ONLY, the
 * flag honors the env override VITE_CFA_LUMA_PARITY_FIX=1 (reaches the browser
 * through vite's env exposure; unset/absent = false, so the default path is
 * bit-identical). Promotion to default-ON is an owner decision. FITS/JPEG are
 * never affected (cfaMosaicLuma is set only by the LibRaw mem_image path).
 */
const CFA_LUMA_PARITY_FIX = (() => {
    try {
        const v = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_CFA_LUMA_PARITY_FIX;
        return v === '1' || v === 'true';
    } catch {
        return false; // plain-Node path (no import.meta.env) — default OFF
    }
})();

/**
 * Human labels for Glass Pipeline stage events, sourced from the wizard step
 * copy (wizard_steps.ts is pure data — no import cycle back into the engine).
 * Stage ids are the stable event contract; labels are display copy.
 */
const STAGE_LABELS: Record<string, string> = {
    load: STEP_META[0].title,       // Load & Inspect
    extract: STEP_META[2].title,    // Star Detection
    metrology: STEP_META[3].title,  // Scale & Ephemeris
    solve: STEP_META[4].title,      // Plate Solve
    calibrate: STEP_META[5].title,  // Optical Calibration
    integrate: STEP_META[6].title,  // Export
    psf: 'PSF Diagnostics',         // M10 — optional, user-requested deconv panel
    psf_field: 'PSF Field',         // M10 — shared post-solve characterization
    psf_attribution: 'PSF Attribution', // M10 — physics decomposition of the measured field
    // Post-solve sub-stages (flowchart nodes) — previously un-evented (recon G4).
    m7_refine: 'Astrometric Refinement (SIP)',
    render_apply_sip: 'Render · SIP Undistort',
    spcc: 'Photometric Color Calibration (SPCC)',
    bc_measure: 'Measured Distortion (Brown-Conrady)',
    bc_rematch: 'BC Rematch (edge-star densification)',
    forced_confirm: 'Forced-Photometry Confirmation',
    final_astrometry: 'Final Astrometry (refined WCS product)'
};

export class OrchestratorSession {
    public state: SessionState = 'IDLE';
    public status: string = '';
    public currentStep: number = 0;
    public manifest: PipelineManifest;
    private tx: ManifestTransaction;
    /**
     * Phase U (Glass Pipeline): typed event stream. ADDITIVE — the status
     * strings / polling above remain the legacy UI contract until migration.
     */
    public readonly events = new PipelineEventBus();
    /**
     * ★ Dashboard/flowchart substrate: persists the event bus per run into the
     * per-stage capture record (in-memory export in the browser; Node file sink
     * when one is registered). Purely a bus subscriber — additive + non-fatal.
     */
    public readonly capture: CaptureRecorder;
    
    // --- DATA STORES ---
    
    public metadata: HardMetadata | null = null;
    public planets: SolarBody[] = []; // This seems to be a public output, keep it public

    public imageWidth: number = 0;
    public imageHeight: number = 0;
    public timestamp: Date = new Date();
    /** False when timestamp is a wall-clock fallback (no header time) — ephemeris results untrusted. */
    public timestampTrusted: boolean = true;
    /** Honest degradation notices for the UI (Glass Pipeline renders these; populated from load/extract steps). */
    public warnings: string[] = [];
    public location: { lat: number; lon: number } | null = null;
    
    private scienceBuffer: Float32Array | null = null;
    private previewFloat32: Float32Array | null = null; // Persisted for Solver
    // SOLVE-buffer dims (native or binned) captured at solve time. The fitted
    // WCS crpix + SIP coefficients live in THIS coordinate space; the render-
    // layer SIP undistort needs it to map solve px → preview px.
    private solveW = 0;
    private solveH = 0;
    /**
     * [SPCC] Full-res linear RGB frame, retained for FITS inputs ONLY
     * (C1 divergence-#6 fix): SPCC aperture photometry consumes it after
     * the solve. DSLR/JPEG inputs keep the historical early discard.
     */
    private scienceRgb: { data: Float32Array; width: number; height: number } | null = null;
    /** [SPCC] Receipt-ready calibration block — undefined when SPCC did not run. */
    /** SPCC block (measured color calibration + fidelity report) — public so the
     *  dashboard/report can surface it honestly (NOT MEASURED where absent). */
    public spccBlock: import('./m9_export/serializer').SpccBlock | undefined;
    /** [SCHEMA B] SPCC per-star photometry surfaced for the receipt photometry block
     *  (undefined when SPCC did not run). */
    private spccStars: import('./stages/science').SpccPerStar[] | undefined;
    public signal: SignalPacket | null = null;
    public guestList: SolarBody[] = [];
    public scaleLock: number | null = null;
    /** Labelled focal-length ASSUMPTIONS that seeded the scale lock (from the
     *  untrusted-FL hint-provider seam via resolveScaleLock). Empty on a trusted
     *  FL / FITS-header lock. Rides out to the receipt (`optics_hints`); NEVER a
     *  measurement (each is assumed:true). */
    public opticsHints: OpticsHint[] = [];
    /** [PROVENANCE §7] The hint-resolution rung that seeded the winning search
     *  (CONFIG / FITS_HEADER / ZENITH / BLIND), captured at solve time and carried
     *  to the receipt as `solve_provenance.solved_via`. null until a solve is
     *  attempted (honest-absent — never a guessed 'blind'). */
    private hintSource: WizardHintResolution['source'] | null = null;
    /** [TESTIMONY] Observer-supplied free-text annotations, applied from the export
     *  UI (typed, provenance:'user') or from an EXPLICITLY-confirmed MCP draft
     *  (provenance:'mcp_assisted'). String-only — NEVER parsed into the solve
     *  (structurally separate from SoftMetadata). Rides out to the receipt
     *  (`user_annotations`); null until the user applies notes (honest-or-absent),
     *  so both pinned reference solves keep it null → byte-identical receipts. */
    public userAnnotations: UserAnnotations | null = null;
    /** [TESTIMONY] Observer-corrected horizon envelope from the step-3 interactive
     *  editor. A SEPARATE object from the automatic detection-envelope estimate
     *  (m4_signal_detect/horizon_envelope.ts) — the auto estimate is NEVER
     *  overwritten. Carries {auto snapshot, node-level deltas, corrected polyline}
     *  (horizon_editor.ts). null until the observer edits (honest-or-absent), so
     *  the pinned reference solves keep it null → byte-identical. Detection-culling-
     *  ADJACENT but NOT yet wired into culling (consumer seam deferred) and NOT yet
     *  emitted to the receipt (additive horizon_correction block + schema bump
     *  deferred) — recorded testimony only, never fed to the solve. */
    public horizonCorrection: HorizonCorrectionRecord | null = null;
    public solution: PlateSolution | null = null;
    /** The solve ladder's OWN diagnostics from the LAST solve attempt (quads/matches/
     *  rejection_reasons/branch_timing). Retained EXISTING stage output (runSolve already
     *  computes it) — captured so a NO-SOLVE run can bank an honest failure receipt
     *  (exportFailurePacket). NEVER read by buildReceipt/exportPacket, so the solved-path
     *  receipt is byte-identical. null until step4 runs / when the solve threw pre-diagnostics. */
    public solveDiagnostics: SolveDiagnostics | null = null;
    public hardwareProfile: HardwareProfile | null = null;
    public forensics: ForensicMetrics | null = null;
    public environment: QualityMetrics | null = null;
    /** M10 PSF diagnostics — populated ONLY by runPsfDiagnostics (optional, user-requested). */
    public psfReport: PsfReport | null = null;
    /** M10 PSF FIELD — spatially-varying PSF map at solved positions, populated
     *  by the shared post-solve characterization stage (step5). Null until then. */
    public psfField: PsfFieldReport | null = null;
    /** M10 PSF ATTRIBUTION — decomposition of the measured PSF into physically-
     *  calculable systematics {drift/diffraction/seeing/refraction/coma} + residual,
     *  populated by the shared post-solve attribution stage (step5). Additive +
     *  READ-ONLY w.r.t. psfField/solution. Null until then. */
    public psfAttribution: PsfAttributionReport | null = null;
    /** [schema 2.20.0] FINAL ASTROMETRY — the step-6 TERMINAL data-fidelity refit
     *  (a SECOND provenance-tagged WCS: PSF centroids + differential refraction +
     *  SNR weighting), COORDINATE ledger. A PRODUCT: additive + READ-ONLY w.r.t.
     *  psfField/solution; never feeds solve/confirm. Null until the terminal
     *  stage runs / honest-absent. */
    public finalAstrometry: FinalAstrometryReport | null = null;
    /** M2 MEASURED per-capture Brown-Conrady — fitted from the solver-verified
     *  matched pairs (COORDINATE ledger). Always-on OBSERVATION populated by the
     *  post-solve bc_measure step; additive + READ-ONLY w.r.t. the solution.
     *  Null until then / no WCS. Distinct from the APPROXIMATE library prior. */
    public bcMeasured: MeasuredDistortion | null = null;
    /** M2 PRIMARY BC REMATCH — two-pass edge-star densification driven by the
     *  measured BC (COORDINATE ledger). Populated by the post-solve rematch pass
     *  (step5). On APPLIED it densifies solution.matched_stars + refits SIP; on
     *  KEPT_ORIGINAL the solution is byte-identical. Additive receipt; null until
     *  the pass runs / no measured BC. */
    public bcRematch: BcRematchReceipt | null = null;

    // VISUALS
    public previewUrl: string | null = null;
    /** [RENDER PLANE] The un-corrected (warp-free) preview URL, cached BEFORE the
     *  applied-science corrected render overwrites `previewUrl`. Null when no
     *  correction was applied — honest-or-absent: the FinalImageView "Applied
     *  science / Original" toggle then has nothing to swap to and shows the
     *  display-stretch-only note. Never a receipt/measurement value. */
    public previewUrlOriginal: string | null = null;
    /** [RENDER PLANE] Which per-frame-fitted distortion model the corrected preview
     *  actually applied (null = none qualified → warp-free STF shown). Drives the
     *  FinalImageView toggle + caption. Pure display metadata — never written to any
     *  receipt, never a gated/measured value. */
    public renderWarpApplied: { source: CorrectedViewSource; label: string; rms_arcsec: number | null } | null = null;
    /** [RENDER PLANE] Set when a per-frame model was SELECTED but the render admission
     *  gate REFUSED it (would extrapolate into garbage outside its fit support — the
     *  beach case). previewUrl then stays the ORIGINAL; FinalImageView shows the honest
     *  "distortion model not valid across this frame" note with the reason + metrics.
     *  Pure display metadata — never a receipt/measured value. Null = not refused. */
    public renderWarpRefused: { source: CorrectedViewSource; reason: RenderAdmission['reason']; metrics: RenderAdmission['metrics'] } | null = null;
    /** DERIVED camera-matrix color transform for the preview render (PIXEL ledger),
     *  or null when no body forward matrix resolves -> empirical luminance fallback.
     *  Resolved once from camera_model; NEVER touches the solve/WCS (COORDINATE ledger). */
    private _previewColorTransform: ColorTransform | null | undefined = undefined;
    /** Honest label for the preview color MODE (UI/report surface; COLOR_MATH_PROGRAM 4.2 labeling law). */
    public previewColorInfo: { mode: 'MATRIX' | 'LUMINANCE'; label: string; body: string | null } | null = null;
    /** Resolve (once) the preview DERIVED color transform + honest label from the camera model. */
    private getPreviewColorTransform(): ColorTransform | null {
        if (this._previewColorTransform === undefined) {
            const model = this.metadata?.camera_model ?? null;
            this._previewColorTransform = resolveColorTransform(model);
            this.previewColorInfo = describeColorMode(model);
        }
        return this._previewColorTransform;
    }

    /**
     * Render-layer preview options (DEFAULT-OFF flags; PIXEL ledger, render-only).
     * `oklab` routes the auto-stretch through the OkLCh path — flag off ⇒ preview
     * bytes are identical to the pre-Oklab STF v2 render.
     */
    private getRenderOpts(): { oklab?: boolean } {
        return { oklab: getOklabRenderPref() };
    }

    /**
     * CORRECTED VIEW availability (render plane, LAW 3). Pure probe of the fitted
     * distortion on the current solution — the wizard toggle reads this to decide
     * between the active pill and the honest "NOT AVAILABLE" disabled state.
     */
    public getCorrectedViewInfo(): CorrectedViewInfo {
        // Availability = a per-frame model is SELECTED *and* it passes the render
        // ADMISSION gate (valid across the frame, not extrapolating into garbage).
        // A selected-but-refused model reports unavailable with the honest reason,
        // matching what the render will actually do (show the original).
        const prep = this.prepareWarp();
        if (!prep) return detectCorrectedView(null); // no per-frame model → NOT AVAILABLE
        if (!prep.admission.admitted) {
            return { available: false, source: null, label: `DISTORTION MODEL NOT VALID ACROSS FRAME (${prep.admission.reason}) — NOT AVAILABLE` };
        }
        return detectCorrectedView(this.solution, this.bcMeasured);
    }

    /**
     * CORRECTED VIEW render (RENDER PLANE ONLY — consumes both ledgers, feeds
     * NEITHER). Re-renders the CURRENT preview float buffer through the ONE arbitrated,
     * ADMITTED inverse warp so measured distortion is visually removed, returning a
     * FRESH preview data URL. Null on honest absence (no qualifying model, model
     * REFUSED by the admission gate, no preview, or a render error). Pure — mutates
     * nothing. Never invoked during the solve, so the pinned solves stay byte-identical.
     */
    public renderCorrectedPreviewUrl(): string | null {
        const prep = this.prepareWarp();
        if (!prep || !prep.admission.admitted) return null;
        return this.renderFromPrep(prep)?.url ?? null;
    }

    /**
     * RENDER PLANE — SELECT the warp (ladder), BUILD its descriptor + solve-px crpix +
     * fit RMS, and run the ADMISSION gate (valid across the frame?). Pure over the
     * solution + measured-BC fit + solve dims (NO preview buffer needed) so the pill
     * probe, the on-demand render, and the solve stage all share ONE verdict. Null =
     * no per-frame model qualifies. Never mutates anything.
     */
    private prepareWarp(): { selection: RenderWarpSelection; warp: RenderWarp; crpixSolveX: number; crpixSolveY: number; admission: RenderAdmission } | null {
        if (!(this.solution?.wcs?.crpix && this.solveW > 0 && this.solveH > 0)) return null;
        const selection = selectRenderWarp(this.solution, this.bcMeasured);
        if (!selection) return null;
        const scale = this.solution.pixel_scale || 1;
        let warp: RenderWarp | null = null;
        let crpixSolveX = 0;
        let crpixSolveY = 0;
        let fitRmsPx = Infinity;
        if (selection.source === 'SIP' && this.solution.astrometry?.sip) {
            const sip = this.solution.astrometry.sip;
            warp = { kind: 'sip', sip: { a: sip.a, b: sip.b } };
            crpixSolveX = this.solution.wcs.crpix[0];
            crpixSolveY = this.solution.wcs.crpix[1];
            fitRmsPx = Number.isFinite(this.solution.astrometry.rms_arcsec) ? this.solution.astrometry.rms_arcsec / scale : Infinity;
        } else if (selection.source === 'TPS' && this.solution.astrometry?.tps) {
            const tps = this.solution.astrometry.tps;
            warp = {
                kind: 'tps',
                un: tps.control_points.map(p => p[0]),
                vn: tps.control_points.map(p => p[1]),
                weightsX: tps.weights_x,
                weightsY: tps.weights_y,
                affineX: tps.affine.dx,
                affineY: tps.affine.dy,
                tpsScale: tps.scale,
            };
            crpixSolveX = tps.crpix[0];
            crpixSolveY = tps.crpix[1];
            fitRmsPx = Number.isFinite(tps.rms_after_arcsec) ? tps.rms_after_arcsec / scale : Infinity;
        } else if (selection.source === 'BC_MEASURED' && this.bcMeasured) {
            warp = { kind: 'bc', k1: this.bcMeasured.k1, k2: this.bcMeasured.k2 ?? 0, solveW: this.solveW, solveH: this.solveH };
            // crpix unused for the frame-center BC model.
            fitRmsPx = (this.bcMeasured as any).rms_2d_px ?? Infinity;
        }
        if (!warp) return null;
        const matchedXY = (this.solution.matched_stars ?? [])
            .filter(m => Number.isFinite(m.detected?.x) && Number.isFinite(m.detected?.y))
            .map(m => ({ x: m.detected.x, y: m.detected.y }));
        const admission = ImageProcessor.admitRenderWarp(warp, matchedXY, crpixSolveX, crpixSolveY, this.solveW, this.solveH, fitRmsPx);
        return { selection, warp, crpixSolveX, crpixSolveY, admission };
    }

    /**
     * RENDER PLANE (LAW 1, ONE warp) — render the preview float buffer through the
     * already-prepared+ADMITTED warp. Null when the preview isn't available or on any
     * render failure (honest absence). Pure output: mutates nothing (the solve stage
     * caches previewUrlOriginal + swaps previewUrl itself). Engine-internal convention
     * only — never the FITS-export negation (export/sip_convention.ts).
     */
    private renderFromPrep(prep: { selection: RenderWarpSelection; warp: RenderWarp; crpixSolveX: number; crpixSolveY: number }): { url: string; selection: RenderWarpSelection } | null {
        if (!(this.generatePreviews && this.previewFloat32 && this.scales && this.solveW > 0)) return null;
        try {
            const pW = this.scales.previewW;
            const pH = this.scales.previewH;
            const coordScale = pW / this.solveW; // solve px → preview px (isotropic)
            const crpixPreviewX = prep.crpixSolveX * coordScale;
            const crpixPreviewY = prep.crpixSolveY * coordScale;
            const undistorted = ImageProcessor.applyRenderWarp(
                this.previewFloat32, pW, pH, prep.warp, crpixPreviewX, crpixPreviewY, coordScale,
            );
            const imageData = ImageProcessor.float32ToImageDataAutoStretch(
                undistorted, pW, pH, this.getPreviewColorTransform(), null, this.getRenderOpts()
            );
            return { url: ImageProcessor.createPreviewUrl(imageData), selection: prep.selection };
        } catch {
            return null; // honest absence on any render failure — caller keeps the un-warped preview.
        }
    }

    public hardware: HardwareProfile | null = null;
    public scales: ScaleManager | null = null;

    private rawBuffer: ArrayBuffer | null;
    /** Magic-byte format of the source file ('FITS', 'CR2', 'JPEG', ...) - set in step1_Load. */
    public sourceFormat: string = 'UNKNOWN';
    /** True iff step 1 routed this frame through the RAW-sensor decode (rawler/libraw)
     *  — i.e. a raw sensor format that is NOT FITS (FITS goes to the pure-TS decoder,
     *  demo-tier JPEG/TIFF are already-rendered). Set in step1_Load. Drives the receipt's
     *  pipeline_provenance.decoder_arm so it is the ARM ACTUALLY USED, never a flag-only
     *  guess (honest-or-absent: false ⇒ decoder_arm=null). */
    private rawSensorDecode: boolean = false;
    /** [COMPUTE-ROUTE OBSERVABILITY · schema 2.16.0] Honest stamps of which compute
     *  path each GPU-capable seam (demosaic / preview) ACTUALLY took this run. Merged
     *  from the ingest demosaic stamp + the step2 preview-seam choice; surfaced in the
     *  receipt's `compute_routes` block (and the failure receipt). Pure diagnostic. */
    private computeRoutes: ComputeRouteStamp[] = [];
    public logger: TelemetryLogger;

    /**
     * Toolchest API seam (I1.2): `generatePreviews: false` skips ONLY the
     * browser preview artifacts (GPU preview / auto-stretch ImageData /
     * object-URL) — `previewUrl` stays null. NOT skipped: previewFloat32,
     * which is a DETECTION INPUT (stages/detect passes it to
     * analyzeWithMasking). Default true = wizard behavior, byte-identical.
     */
    private readonly generatePreviews: boolean;

    /**
     * Explicit user target hint from the upload surface (TargetHintInput), or
     * null. Forwarded to the CONFIG rung of the hint resolver at solve time
     * (search PRIOR only — never a measurement, never a LENS_DB write). The
     * DEFAULT path (no hint) leaves this null and is byte-identical to the
     * historical FITS-header → zenith → blind ladder.
     */
    private readonly callerHint: CallerTargetHint | null;

    /**
     * SEARCH-ORDER PRIORS model (task #20 — lane ① search priors ONLY).
     * `injectedSearchPriors` is what a caller handed the session (undefined =
     * "not provided" → fall back to the env-path load); `searchPriorModel` is the
     * resolved value, memoized at first solve (undefined = not yet resolved).
     * Default is null everywhere → the reorder seam is identity → byte-identical.
     */
    private readonly injectedSearchPriors: SearchPriorModel | null | undefined;
    private searchPriorModel: SearchPriorModel | null | undefined = undefined;
    /**
     * WIRING_SPEC R3: the (k1,k2) of the lens-distortion prior that shaped the
     * solve's WCS (all routes: EXIF/hint LENS_DB, or the injected workbench-pooled
     * resolution), captured at solve time so the post-solve forced-confirm step can
     * re-project its probes through toNative. Null when no prior was active (the
     * default, and always on the pinned reference solves → byte-identical).
     */
    private activeLensDistortion: { k1: number; k2: number } | null = null;
    /**
     * OPTIONAL pre-detection pixel transform (PIXEL-ledger seam). Applied in
     * step2 after decode + luminance/preview derivation and BEFORE detectSignal.
     * null (the default, every gate path) ⇒ dead code, byte-identical solve.
     */
    private readonly preDetectTransform: PreDetectTransform | null;

    constructor(fileBuffer: ArrayBuffer, opts?: { generatePreviews?: boolean; callerHint?: CallerTargetHint | null; searchPriors?: SearchPriorModel | null; preDetectTransform?: PreDetectTransform | null }) {
        this.generatePreviews = opts?.generatePreviews ?? true;
        this.callerHint = opts?.callerHint ?? null;
        this.injectedSearchPriors = opts?.searchPriors;
        this.preDetectTransform = opts?.preDetectTransform ?? null;
        this.rawBuffer = fileBuffer;
        const sessionId = `session_${Date.now()}`;
        this.logger = new TelemetryLogger(sessionId, {
            vanguardSigma: 3.0,
            deepScanSigma: 5.0,
            maxFwhm: 10,
            minCircularity: 0.5,
            planetarytolerancePx: 30
        });
        this.manifest = createBlankManifest(sessionId);
        // Provenance FSM feed: every committed manifest transition becomes a
        // provenance_changed event (the transaction filters out no-op sets).
        this.tx = new ManifestTransaction(this.manifest, this.logger, (changes, stageName) => {
            for (const c of changes) {
                this.events.emit({ kind: 'provenance_changed', key: c.key, from: c.from, to: c.to, stage: stageName });
            }
        });

        // ── ★ Glass-Pipeline capture record (dashboard/flowchart substrate) ──
        // Promote the session id to the run_id and stamp it on EVERY event; the
        // recorder subscribes now so it captures the whole run from run_started.
        this.events.setRunContext({ runId: sessionId });
        this.capture = new CaptureRecorder(this.events);
        // Content SHA-256 of the source frame = the flowchart's cross-run dedup
        // key. Computed OFF the ingest hot path (async digest, never blocks
        // decode) and back-filled onto the bus + capture record when it resolves.
        // Events + capture record ONLY — the receipt / source_provenance is
        // untouched, so the pinned reference solves stay byte-identical.
        if (fileBuffer) {
            // Arm the capture recorder's write-race barrier with THIS digest so
            // the run_finished flush cannot persist a record before frame_sha
            // (the dedup / integrity key) is settled. The digest still never
            // blocks decode (off the ingest hot path); only the instrumentation
            // flush waits. `.catch` keeps it honest-absent (null) AND resolves so
            // the barrier settles on either fate.
            const frameShaDigest = sha256Hex(fileBuffer)
                .then(sha => { this.events.setRunContext({ frameSha: sha }); })
                .catch(() => { /* honest-absent: frame_sha stays null */ });
            this.capture.awaitFrameSha(frameShaDigest);
        }
    }

    /**
     * TEARDOWN — release the heavy retained image buffers + preview blob URL this
     * session holds, for session REPLACEMENT (a NEW image starting). App-shell
     * lifecycle only; idempotent.
     *
     * BYTE-IDENTITY (LAW 2): dispose runs ONLY on the OUTGOING session at
     * replacement time — never during an in-flight solve, always after the
     * receipt is built — so no pinned solve number can move (both sacred
     * reference solves prove this: they never call dispose mid-run). It nulls
     * memory the receipt does not read (raw pixel buffers) and revokes a blob URL.
     *
     * WHY IT EXISTS (measured): a full-frame CR2 decode transiently allocates
     * ~355 MB (rgb Float32 + arrow) and a COMPLETED session RETAINS ~216 MB
     * (`scienceRgb`) plus the science/preview Float32 buffers. If an outgoing
     * session's buffers coexist with the next image's decode — GC is lazy and the
     * app footprint is far larger after a solve — the second large-RAW decode can
     * exceed a constrained webview's (Tauri/WebView2) memory budget and fail
     * ("can't run another image"). Dropping these references BEFORE the next
     * decode keeps the second decode's peak ≈ the first's (the known-good case).
     * Pure memory hygiene: nulls only unreferenced-after-teardown buffers.
     */
    public dispose(): void {
        // Heavy full-frame Float32 buffers (the dominant retained footprint).
        this.scienceBuffer = null;
        this.previewFloat32 = null;
        this.scienceRgb = null;
        // rawBuffer is already released after step 2 by design; null defensively.
        this.rawBuffer = null;
        // Revoke the preview object URL so its backing blob is reclaimable
        // (no-op in Node / when already revoked / non-blob).
        if (this.previewUrl && this.previewUrl.startsWith('blob:')) {
            try { URL.revokeObjectURL(this.previewUrl); } catch { /* Node / already revoked */ }
        }
        this.previewUrl = null;
    }

    /** Record an honest degradation notice: pushes to `warnings` AND emits the bus event. */
    private warn(message: string, stage?: string): void {
        this.warnings.push(message);
        this.events.emit({ kind: 'warning', message, stage });
    }

    /**
     * Wrap a step with stage_started / stage_finished events (wall-clock ms;
     * error message captured on throw). Optional `summarize` maps the stage's
     * result to the capture-record fields {verdict, counts, payloadRef} for the
     * flowchart — it runs inside a guard so a summarizer bug can never break
     * emission or the pipeline (honest-absent on throw).
     */
    private async withStage<T>(
        stage: string,
        fn: () => Promise<T>,
        summarize?: (out: T) => { verdict?: StageVerdict | null; counts?: Record<string, number>; payloadRef?: string | null }
    ): Promise<T> {
        this.events.emit({ kind: 'stage_started', stage, label: STAGE_LABELS[stage] ?? stage });
        const start = Date.now();
        try {
            const out = await fn();
            if (SEAM_CAPTURE_ENABLED) await captureSeam(stage, out, this as unknown as SeamSessionView);
            let summary: { verdict?: StageVerdict | null; counts?: Record<string, number>; payloadRef?: string | null } | undefined;
            if (summarize) {
                try { summary = summarize(out); } catch { summary = undefined; }
            }
            this.events.emit({ kind: 'stage_finished', stage, ok: true, ms: Date.now() - start, ...summary });
            return out;
        } catch (err) {
            this.events.emit({
                kind: 'stage_finished',
                stage,
                ok: false,
                ms: Date.now() - start,
                verdict: 'FAIL',
                error: err instanceof Error ? err.message : String(err)
            });
            throw err;
        }
    }

    public async step1_Load(): Promise<HardMetadata> {
        this.events.emit({
            kind: 'run_started',
            mode: 'wizard',
            sourceFormat: this.rawBuffer ? detectMagicFormatSync(this.rawBuffer) : undefined
        });
        return this.withStage('load', () => this.step1_LoadInner());
    }

    private async step1_LoadInner(): Promise<HardMetadata> {
        this.logger.logStage('ingest', 'RUNNING');
        this.state = 'LOADING';
        this.currentStep = 1;
        this.status = "Initializing buffer hooks...";
        
        if (!this.rawBuffer) throw new Error("RAW Buffer released prematurely");
        
        this.sourceFormat = detectMagicFormatSync(this.rawBuffer);
        const isFits = this.sourceFormat === 'FITS';
        this.status = isFits ? "Reading FITS headers..." : "Reading EXIF metadata...";
        console.log(`[Session] Step 1: Reading ${isFits ? 'FITS headers' : 'EXIF metadata'} from ${this.rawBuffer.byteLength} bytes...`);
        const result = await parseExif(this.rawBuffer);

        this.status = "Validating image signal...";
        this.metadata = result.hard;

        // Populate environment JD so the FSM step-5 gate (JD_VALIDATED) can pass.
        // Without this, `session.environment` is never set and the wizard blocks forever.
        if (this.metadata?.timestamp) {
            this.environment = {
                exif_drift_seconds: 0,
                ...(this.environment ?? {}),
                computed_jd: TimeService.toJulianDate(this.metadata.timestamp),
            };
        }


        if (!result.isRaw) {
            console.warn("[Session] Warning: File is not a RAW/FITS sensor format.");
            this.status = "Warning: Non-sensor file (JPEG/TIFF) detected.";
        } else {
            this.status = "Ingestion Complete.";
        }

        // [PROVENANCE] A rawler/libraw raw-sensor decode runs ONLY for a raw sensor
        // format that is NOT FITS (FITS → pure-TS FITS decoder; demo-tier JPEG/TIFF →
        // browser decode, result.isRaw=false). This authoritative flag feeds the
        // receipt's pipeline_provenance.decoder_arm so it reflects the arm ACTUALLY
        // used, never guessed from VITE_DECODER_RAWLER alone.
        this.rawSensorDecode = result.isRaw && this.sourceFormat !== 'FITS';

        // [DEMO TIER · LAW 3] A registered demo-tier input (phone JPEG /
        // photographic TIFF) ingests + solves for real, but its pixels are
        // 8-bit gamma-encoded sRGB, not linear sensor counts — so the
        // radiometry is APPROXIMATE and any capture time/GPS ride stripped
        // EXIF. Emit ONE honest degradation notice (surfaced in the Glass
        // Pipeline UI AND the receipt `warnings[]`). Guarded on the registry
        // tier, so science formats (FITS/CR2) never see it — the pinned
        // reference solves stay byte-identical.
        if (isDemoTierFormat(this.sourceFormat)) {
            this.warn(
                `DEMO-TIER input (${this.sourceFormat}): an already-rendered 8-bit, gamma-encoded, white-balanced image — the plate solve (detection + astrometry geometry) is real, but photometry and color calibration are APPROXIMATE (not calibrated science) and any capture time / GPS ride stripped EXIF (often absent / untrusted).`,
                'ingest'
            );
        }

        if (result.format === 'FITS') {
            console.log(`[Session] FITS metadata: RA=${this.metadata.ra_hint}h, Dec=${this.metadata.dec_hint}°, ` +
                `Scale=${this.metadata.pixel_scale}"/px, GPS=${this.metadata.gps_source}`);
        }
        
        this.state = 'IDLE';
        this.tx.set('dataSource', result.isRaw ? PhotographyData.Raw : PhotographyData.Tiff);
        this.tx.commit('step1');
        this.logger.logStage('ingest', 'SUCCESS', { metadata: this.metadata! });
        return this.metadata!;
    }

    // --- STEP 2: SIGNAL EXTRACTION (Signal vs Noise) ---
    public async step2_Extract(overrides?: Partial<HardMetadata>): Promise<SignalPacket> {
        return this.withStage('extract', () => this.step2_ExtractInner(overrides));
    }

    private async step2_ExtractInner(overrides?: Partial<HardMetadata>): Promise<SignalPacket> {
        this.logger.logStage('signal', 'RUNNING');
        this.state = 'EXTRACTING';
        this.currentStep = 2;
        if (overrides && this.metadata) {
            this.metadata = { ...this.metadata, ...overrides };
        }

        if (!this.rawBuffer) throw new Error("RAW Buffer missing (released after step 2)");

        // 1. Ingest (Load Sensor/Image Data) — SHARED ingest stage
        // (stages/ingest): cache-first decode + double-jeopardy demosaic
        // check. The stage BORROWS rawBuffer and retains nothing; this
        // session releases it below (which is why step-1 re-entry is
        // forbidden — divergence #10 ownership contract).
        this.status = "Loading image data...";
        const frame = await decodeScienceFrame(
            this.rawBuffer,
            this.sourceFormat,
            this.metadata?.timestamp,
            (s) => { this.status = s; }
        );
        const rawSensor = frame.rawSensor;
        const fullRGB: Float32Array = frame.fullRGB;
        const finalWidth: number = frame.width;
        const finalHeight: number = frame.height;
        const rgbBuffer: GPUBuffer | undefined = frame.rgbBuffer;

        // [COMPUTE-ROUTE OBSERVABILITY] Merge the ingest demosaic seam stamp (the
        // route the WebGPU demosaic ACTUALLY took, or a 'skipped' stamp when the
        // payload was already demosaiced). The preview seam stamps itself below.
        // step-1/2 re-entry is forbidden by design, so this collects exactly once.
        this.computeRoutes.push(...frame.computeRoutes);

        this.imageWidth = finalWidth;
        this.imageHeight = finalHeight;

        // Sync dimensions back to metadata for UI use
        if (this.metadata) {
            this.metadata.width = finalWidth;
            this.metadata.height = finalHeight;
        }

        // [PROVENANCE · schema 2.14.0] Persist the LEAN rawler decode calibration
        // (WB / black+white levels / CFA pattern / optical-black stats) onto
        // HardMetadata so it survives the raw-buffer release and reaches the receipt's
        // `rawler_calibration` block. Present ONLY on a cache-miss rawler decode
        // (frame.rawSensor.rawler is undefined on the libraw cold path, FITS, demo-tier,
        // and on a Bayer-cache HIT) — honest-or-absent, never fabricated. Pure record:
        // summarizeRawlerCalibration drops the heavy raw OB pixel buffers (stats only)
        // and applies NO calibration to pixels (LAW 2), so the solve stays byte-identical.
        if (this.metadata && frame.rawSensor?.rawler) {
            this.metadata.rawler_calibration = summarizeRawlerCalibration(frame.rawSensor.rawler);
        }

        // [SPCC] Retain the full-res linear RGB for FITS inputs (divergence
        // #6 fix — the wizard used to discard it here, which is exactly why
        // SPCC never ran on this path). For stacked FITS this is a retained
        // reference to the decoder's own Float32 buffer, not a copy; the
        // DSLR/JPEG memory envelope is unchanged (still discarded).
        if (this.sourceFormat === 'FITS') {
            this.scienceRgb = { data: fullRGB, width: finalWidth, height: finalHeight };
        }

        this.tx.set('memoryState', MemoryResidency.WebGpuVram);
        this.tx.commit('step2_scales');

        // Initialize Scale Manager (Source of Truth for all coordinate spaces)
        this.scales = new ScaleManager(finalWidth, finalHeight, PIPELINE_CONSTANTS.PREVIEW_MAX_DIM);

        this.tx.set('memoryState', MemoryResidency.WebGpuVram);
        // Step 2 continues... don't commit until a meaningful boundary or end of step if desired.

        // Time provenance: a missing header timestamp must NOT silently
        // become "now" — that poisons the ephemeris guest list, alt/az and
        // any airmass work with wall-clock time months/hours off, while
        // LOOKING valid. The plate solve itself is time-independent
        // (RA/Dec hints + catalog matching need no clock), so degrade
        // loudly: keep the fallback for ephemeris features but record it.
        if (this.metadata?.timestamp) {
            this.timestamp = new Date(this.metadata.timestamp);
            // Unset-camera-clock forensics: dates before the CR2 format
            // existed (2004), dates in the future, and the classic dead-
            // battery reset signature (Jan 1, 00:0x) are all real-world
            // common on DSLRs (manual lenses, travel, stored bodies). A
            // bogus-but-present timestamp is WORSE than a missing one: it
            // silently places planetary anchors ~degrees-to-quadrants off.
            const tsYear = this.timestamp.getUTCFullYear();
            const tsImpossible = tsYear < 2004 || this.timestamp.getTime() > Date.now() + 2 * 86_400_000;
            const tsResetSignature = this.timestamp.getUTCMonth() === 0 && this.timestamp.getUTCDate() === 1 && this.timestamp.getUTCHours() === 0;
            if (tsImpossible || tsResetSignature) {
                this.timestampTrusted = false;
                this.warn(`Capture timestamp ${this.timestamp.toISOString()} looks like an unset camera clock${tsImpossible ? '' : ' (Jan-1 midnight reset signature)'} — planet/ephemeris features disabled for this run; the star solve is unaffected.`, 'extract');
                console.warn('[Session] TIME DEGRADED: implausible header timestamp', this.timestamp.toISOString());
            } else {
                this.timestampTrusted = true;
            }
        } else {
            this.timestamp = new Date();
            this.timestampTrusted = false;
            this.warn('No capture timestamp in file metadata — using processing wall-clock time. Ephemeris/planet overlays and alt-az results are unreliable; the plate solve is unaffected.', 'extract');
            console.warn('[Session] TIME DEGRADED: no header timestamp; ephemeris features are using wall-clock time.');
        }
        // EXIF/FITS sources always carry real (non-null) coordinates; absent GPS
        // resolves to a null location (no fabricated default — honest-or-absent).
        this.location = (this.metadata!.gps_source === 'EXIF' || this.metadata!.gps_source === 'FITS')
            ? { lat: this.metadata!.gps_lat!, lon: this.metadata!.gps_lon! }
            : null;

        if (this.metadata && this.metadata.gps_source !== 'EXIF' && this.metadata.gps_source !== 'FITS') {
            console.warn("[Session] No valid EXIF/FITS GPS found. Zenith correction will use defaults unless overridden.");
        }

        // 2. Metrology Buffer (luminance Float32)
        this.status = "Computing science buffers...";
        this.scienceBuffer = this.computeluminance(fullRGB, rawSensor?.cfaMosaicLuma);

        // [NATIVE OPTIMIZATION] If we have a native sensor profile, we can run Bayer-first detection
        // But for now, we continue with the scienceBuffer generated from fullRGB.

        // 4. Generate early 4K Preview Buffer (Processed RGB)
        // [VISUAL PROGRESS] We generate the preview NOW so the UI updates
        // even if the AI step below is slow or fails.
        this.status = "Generating processed preview...";
        if (rgbBuffer) {
            if (this.generatePreviews) {
                const gpuPreview = await generateGpuPreview(rgbBuffer, this.imageWidth, this.imageHeight);
                this.previewUrl = gpuPreview.previewUrl;
                // [COMPUTE-ROUTE OBSERVABILITY] The preview path ACTUALLY taken
                // (webgpu downsample vs an internal CPU fallback) — read from the
                // preview producer, not guessed.
                this.computeRoutes.push(gpuPreview.route);
                console.log(`[Session] Early GPU preview generated: ${this.previewUrl.substring(0, 30)}...`);
            } else {
                // Previews disabled (headless / I1.2 generatePreviews:false): the
                // GPU-buffer preview compute step did NOT run — stamp it loud.
                this.computeRoutes.push(computeRouteStamp('preview', 'skipped', 'previews_disabled'));
            }
        } else {
            const pW = this.scales!.previewW;
            const pH = this.scales!.previewH;
            // previewFloat32 is a DETECTION INPUT (stages/detect ->
            // analyzeWithMasking) — it runs regardless of generatePreviews.
            this.previewFloat32 = this.generatePreviewFloat32(fullRGB, this.imageWidth, this.imageHeight, pW, pH);
            if (this.generatePreviews) {
                // STF auto-stretch: calibrated deep-sky stacks are near-black
                // under plain gamma (median ~0.004) — the user must SEE their
                // image. Linked midtones stretch preserves star/galaxy color.
                const previewImageData = ImageProcessor.float32ToImageDataAutoStretch(this.previewFloat32, pW, pH, this.getPreviewColorTransform(), null, this.getRenderOpts());
                this.previewUrl = ImageProcessor.createPreviewUrl(previewImageData);
                // [COMPUTE-ROUTE OBSERVABILITY] No GPU buffer → the visible preview
                // was produced on the CPU (ImageProcessor auto-stretch path).
                this.computeRoutes.push(computeRouteStamp('preview', 'cpu', 'cpu_autostretch_no_gpu_buffer'));
            } else {
                // Previews disabled AND no GPU buffer — the preview compute step did
                // not run. Stamp the skip honestly (previewFloat32 above is a
                // detection input, NOT a rendered preview).
                this.computeRoutes.push(computeRouteStamp('preview', 'skipped', 'previews_disabled'));
            }
        }

        // ── PRE-DETECTION PIXEL TRANSFORM (PIXEL-ledger seam; honest-or-absent) ──
        // The one place a caller may reshape the DETECTION-INPUT pixels before
        // detectSignal — e.g. a nebulosity/background LIFT so a bright diffuse band
        // cannot flood detection. COPY-FOR-DETECTION contract (the SAME discipline
        // the thermal/hot-pixel pre-pass uses — signal_processor.ts / hot_pixel_map
        // .ts): the transform reshapes buffers that feed ONLY detectSignal;
        // this.scienceBuffer / this.previewFloat32 stay the ORIGINAL science pixels,
        // so downstream science (SPCC peek, forced-photometry confirmation, PSF) reads
        // UNCONTAMINATED luminance. Absent (every gate path) ⇒ detect* ARE the science
        // buffers and the solve is byte-identical. A returned `marker` stamps the run
        // experimental via the config-override surface (receipt config_overrides.
        // <name>); the hook never touches WCS / matched_stars / the solver.
        let detectScienceBuffer: Float32Array = this.scienceBuffer!;
        let detectPreviewFloat32: Float32Array | null = this.previewFloat32;
        if (this.preDetectTransform) {
            const res = this.preDetectTransform({
                scienceBuffer: this.scienceBuffer!,
                previewFloat32: this.previewFloat32,
                fullRGB,
                width: this.imageWidth,
                height: this.imageHeight,
                previewWidth: this.scales?.previewW ?? this.imageWidth,
                previewHeight: this.scales?.previewH ?? this.imageHeight,
            });
            if (res) {
                if (res.scienceBuffer) detectScienceBuffer = res.scienceBuffer;
                if (res.previewFloat32) detectPreviewFloat32 = res.previewFloat32;
                if (res.marker) recordExperimentalMarker(res.marker.name, res.marker.descriptor);
                console.log(`[Session] Pre-detection transform applied${res.marker ? ` (${res.marker.name})` : ''} — detection-only copy; science buffers untouched.`);
            }
        }

        // 6. Detect Signal (Stars) with 3-Pass Masking & Morphological Filtering
        // — SHARED detect stage (stages/detect): the Bayer-native vs
        // luminance branch lives in ONE place; the status string reuses the
        // same predicate so UI copy can't drift from the dispatch.
        this.status = isNativeBayer(rawSensor)
            ? "Analyzing signal (Native Bayer/Morphological)..."
            : "Analyzing signal (luminance detection)...";
        this.signal = await detectSignal({
            rawSensor,
            scienceBuffer: detectScienceBuffer,
            previewFloat32: detectPreviewFloat32,
            width: this.imageWidth,
            height: this.imageHeight,
            logger: this.logger,
            scales: this.scales || undefined,
            focalLength: this.metadata?.focal_length,
            metadata: this.metadata
        });

        // Redundant call removed - handled by SignalProcessor
        
        if (this.signal && this.signal.clean_stars.length > 0) {
            this.tx.set('starCount', StarCount.DeepSkyPass);
            this.tx.set('starRepresentation', StarRepresentation.Centroid);
            this.tx.commit('step2_signal');
        }
        
        if (!this.signal) throw new Error("Signal analysis failed.");

        // [NATIVE OPTIMIZATION] If SignalProcessor gave us a high-fidelity binned buffer (science Layer),
        // we use it as our primary scienceBuffer for precision Plate Solving.
        if (this.signal.scienceBuffer) {
            console.log(`[Session] Adopting binned science Buffer (${Math.floor(this.imageWidth/2)}x${Math.floor(this.imageHeight/2)}) from SignalProcessor.`);
            this.scienceBuffer = this.signal.scienceBuffer;
        }

        // 5. SPECTRAL PEEKING (The 2.5 Buffer LUT)
        // Sample exact sensor values for the stars before trashing the RAW/RGB
        this.status = "Peeking spectral data...";
        this.peekSpectralData(fullRGB, this.signal);

        // 6. DISCARD heavy buffers
        this.rawBuffer = null; 


        // 6.2 UI VISUALS (Final Sync)
        // Already handled earlier in step2_Extract for visual progress.
        // We only re-run if rgbBuffer was somehow lost (unlikely).
        if (this.generatePreviews && !this.previewUrl) {
            if (rgbBuffer) {
                const gpuPreview = await generateGpuPreview(rgbBuffer, this.imageWidth, this.imageHeight);
                this.previewUrl = gpuPreview.previewUrl;
            } else if (this.previewFloat32) {
                const pW = this.scales!.previewW;
                const pH = this.scales!.previewH;
                const previewImageData = ImageProcessor.float32ToImageDataAutoStretch(this.previewFloat32, pW, pH, this.getPreviewColorTransform(), null, this.getRenderOpts());
                this.previewUrl = ImageProcessor.createPreviewUrl(previewImageData);
            }
        }

        // 7. DISCARD heavy buffers
        this.rawBuffer = null; 
        // fullRGB will be GC'd when this function scope ends.
        
        this.state = 'IDLE';
        this.logger.logStage('signal', 'SUCCESS', {
            star_count: this.signal?.clean_stars.length,
            anomaly_count: this.signal?.anomalies.length
        });
        this.events.emit({
            kind: 'finding',
            finding: {
                kind: 'stars_detected',
                count: this.signal?.clean_stars.length ?? 0,
                anomalies: this.signal?.anomalies.length ?? 0
            }
        });
        return this.signal!;
    }

    /**
     * STEP 3: METROLOGY (The Ruler)
     * Solves for True Pixel Scale (Agnostic) and identifies Ephemeris Guest List.
     */
    public async step3_Metrology(): Promise<number | null> {
        return this.withStage('metrology', () => this.step3_MetrologyInner());
    }

    private async step3_MetrologyInner(): Promise<number | null> {
        if (!this.signal) throw new Error("Extract signal before Metrology.");
        this.logger.logStage('verification', 'RUNNING');
        this.state = 'BUSY';

        // 1. Solve True Pixel Scale — SHARED metrology stage (stages/metrology),
        //    trust ladder: header optics (FITS) -> EXIF optics + sensor DB
        //    (DSLR) -> blind Tri-Lock. Status strings produced by the stage.
        const lock = await resolveScaleLock(
            this.metadata,
            this.signal.clean_stars,
            (s) => { this.status = s; },
            this.events
        );
        this.scaleLock = lock.scaleLock;
        // Capture any labelled FL assumptions (wide-field prior) for the receipt.
        this.opticsHints = lock.opticsHints;
        if (this.scaleLock != null && this.scaleLock > 0) {
            this.events.emit({
                kind: 'finding',
                finding: { kind: 'scale_locked', arcsecPerPx: this.scaleLock, source: lock.source }
            });
        }

        // 2. Retrieve Ephemeris Guest List (Planets/Moons/Satellites)
        // Requires BOTH a trusted clock and a real site: a camera-default
        // timestamp (unset clock) computes a guest list for the wrong sky.
        // (SHARED gate — stages/metrology, landmine #7.)
        this.status = "Retrieving ephemeris...";
        this.guestList = await resolveGuestList(this.timestamp, this.timestampTrusted, this.location);

        this.state = 'IDLE';
        this.logger.logStage('verification', 'SUCCESS', { scale: this.scaleLock });
        return this.scaleLock;
    }

    /**
     * STEP 4: PLATE SOLVING (The Navigator)
     * Solves for True Pixel Scale (Agnostic) and identifies Ephemeris Guest List.
     */
    public async step4_Solve(): Promise<PlateSolution | null> {
        return this.withStage('solve', () => this.step4_SolveInner());
    }

    private async step4_SolveInner(): Promise<PlateSolution | null> {
        if (!this.signal) throw new Error("Extract signal before Metrology.");
        this.logger.logStage('solver', 'RUNNING');
        this.status = "Solving plate (Astrometry)...";

        // REPAIR 3: Create a valid ImageData object from your High-Res science Buffer
        // The solver needs a high-fidelity reference for precision, not the visual 4K preview.
        let solveBuffer: ImageData;
        let solveW: number;
        let solveH: number;

        if (this.scienceBuffer) {
            // Determine dimensions (Full or Binned)
            const isBinned = this.scienceBuffer.length === (Math.floor(this.imageWidth/2) * Math.floor(this.imageHeight/2));
            solveW = isBinned ? Math.floor(this.imageWidth/2) : this.imageWidth;
            solveH = isBinned ? Math.floor(this.imageHeight/2) : this.imageHeight;
            
            console.log(`[Session] Plate Solver using science Buffer (${solveW}x${solveH})`);
            // scienceBuffer is LUMINANCE (w*h), not interleaved RGB (w*h*3) -
            // ImageProcessor.float32ToImageData reads RGB triplets and would
            // spatially mangle the image (garbage stars -> failed/panicking solve).
            solveBuffer = this.luminanceToImageData(this.scienceBuffer, solveW, solveH);
        } else if (this.previewFloat32) {
             console.warn("[Session] science buffer missing for solver. Falling back to Preview...");
             solveW = this.scales!.previewW;
             solveH = this.scales!.previewH;
             solveBuffer = this.float32ToImageData(this.previewFloat32, solveW, solveH);
        } else {
             throw new Error("No pixel buffer available for Plate Solving.");
        }
        // Persist for the render-layer SIP undistort (solve-space → preview-space scale).
        this.solveW = solveW;
        this.solveH = solveH;

        // Hint resolution — SHARED resolver ladder adopted (stages/solve,
        // divergence #1 / the B3 gap): FITS header -> zenith (REAL GPS +
        // trusted clock only) -> blind 180 (historical path, verbatim).
        const hintResolution = resolveWizardHints(this.metadata, this.location != null, this.timestampTrusted, this.callerHint);
        const hints = hintResolution.hints;
        // [PROVENANCE §7] Capture the search-prior category for the receipt's
        // solve_provenance.solved_via (pure record; does NOT affect the solve).
        this.hintSource = hintResolution.source;

        // Audit P4: if the fallback solve buffer is BINNED (science buffer
        // absent), the effective scale doubles — expectedScale must match the
        // buffer actually being solved or verify rejects every truth.
        const nativeScale = this.scaleLock || this.metadata!.pixel_scale || 2.0;
        const basePixelScale = nativeScale * (this.imageWidth > 0 && solveW > 0 ? this.imageWidth / solveW : 1);

        // Narrow-field verify tuning — SHARED implementation (stages/solve_context):
        // wide-field defaults (5 anchors @ 60%) reject honest solves on ~2 deg fields.
        // FOV computed from NATIVE dims x native scale (buffer-independent).
        const solverConfig = resolveVerifyTuning(
            this.imageWidth, this.imageHeight, nativeScale, DEFAULT_PIPELINE_CONFIG
        ).config;

        // SEARCH-ORDER PRIORS (task #20 — lane ① search priors ONLY). Resolve the
        // model once per session: a caller-injected model wins; otherwise load from
        // the env path (Node/headless only — the browser's path is always '' → null).
        // Never fatal (loader returns null on any failure). Null ⇒ the solver's
        // reorder seam is identity ⇒ full sweep, byte-identical (both pinned e2e).
        if (this.searchPriorModel === undefined) {
            this.searchPriorModel = this.injectedSearchPriors !== undefined
                ? this.injectedSearchPriors
                : await loadSearchPriorModel(
                    PIPELINE_CONSTANTS.SOLVER_SEARCH_PRIORS,
                    PIPELINE_CONSTANTS.SOLVER_SEARCH_PRIORS_MODEL_PATH,
                );
        }

        const solveContext: SolveContextParams = {
            basePixelScale,
            scales: this.scales?.getFrontendExport(),
            lensModel: this.metadata?.lens_model,
            focalLength: OpticsManager.getEffectiveFocalLength(this.metadata),
            pixelPitchUm: this.metadata?.pixel_pitch_um,
            // Untrusted clock => no timestamp to the solver: planetary anchor
            // injection with a camera-default date places phantom "bright
            // stars" degrees-to-quadrants off (poison, not help). PM
            // propagation loses nothing measurable (bright quad stars drift
            // <3 arcsec over decades; the verify net is 15px).
            timestamp: this.timestampTrusted ? this.timestamp.toISOString() : undefined,
            // Observer site (spherical_global visibility gating) — null when
            // GPS is defaulted; the solver honestly skips spherical then.
            observer: this.location ?? undefined,
            // Blind sweeps must terminate honestly and narrate themselves
            // (first CR2 run sat in "Solving blind..." past 290s). THESIS-002:
            // the rawler arm gets the declared operational ceiling (its detection
            // density costs ~1.3s/center); the libraw arm keeps 90_000 bit-for-bit.
            blindBudgetMs: isRawlerDecoderEnabled() ? PIPELINE_CONSTANTS.SOLVER_UW_RAWLER_BLIND_BUDGET_MS : 90_000,
            onBlindProgress: (tried: number, total: number, raH: number, decD: number) => {
                this.status = `Solving blind... center ${tried}/${total} (RA ${raH.toFixed(1)}h)`;
                this.events.emit({
                    kind: 'finding',
                    finding: { kind: 'blind_search_progress', centersTried: tried, centersTotal: total, raHours: raH, decDeg: decD }
                } as any);
            },
            hints: hints,
            config: solverConfig,
            // Reorder-only search prior (null ⇒ full blind sweep, byte-identical).
            searchPriors: this.searchPriorModel ?? null,
        };

        // [RUNG-0 READ-BACK · SOLVER_IDENTITY_PROFILE, default OFF] Optical-train
        // fingerprint: when the frame's SHA256(camera+lens+filter) train hash resolves
        // to a MEASURED store profile (a previously-calibrated setup), seed the solve
        // with it DIRECTLY and skip the generic LENS_DB nominal (Feb spec). This is the
        // TOP rung — it wins over the ≥3 auto-pool below. Never fatal; sets nothing
        // unless the store holds a matching measured profile — so flag-OFF or any
        // unrecognized/uncalibrated train is byte-identical to no prior.
        if (envFlagOn(SOLVER_IDENTITY_PROFILE_FLAG)) {
            const identityPrior = await this.maybeBuildIdentityPrior();
            if (identityPrior) {
                solveContext.lensDistortionResolution = identityPrior;
                console.log(`[Session] [IDENTITY-PROFILE] Seeding solve with identity-keyed measured distortion prior (k1=${identityPrior.k1}, k2=${identityPrior.k2}, source=measured:identity).`);
            }
        }

        // [RUNG-3 READ-BACK · SOLVER_WORKBENCH_PRIOR, default OFF] Seed the solve's
        // lens-distortion prior from ≥3 agreeing same-rig Optical-Workbench deposits
        // (poolWorkbenchPrior gate). Never fatal; sets nothing unless the pooling gate
        // passes — so flag-OFF, a fresh store, or any rig without qualifying deposits
        // is byte-identical to no prior (the pinned reference solves stay bit-identical).
        // Skipped when rung-0 identity already seeded a prior (identity outranks pooled).
        if (!solveContext.lensDistortionResolution && envFlagOn(SOLVER_WORKBENCH_PRIOR_FLAG)) {
            const pooledPrior = await this.maybeBuildWorkbenchPrior();
            if (pooledPrior) {
                solveContext.lensDistortionResolution = pooledPrior;
                console.log(`[Session] [WORKBENCH-PRIOR] Seeding solve with pooled same-rig distortion prior (k1=${pooledPrior.k1}, k2=${pooledPrior.k2}, source=workbench_pooled).`);
            }
        }

        // WIRING_SPEC R3: capture the resolved lens-distortion prior that shapes
        // THIS solve's WCS (single-source with autoSolvePlate's ladder) so the
        // post-solve forced-confirm step re-projects its probes to native via
        // toNative. Null (no prior) ⇒ confirm is byte-identical to today.
        const activePrior = resolveLensDistortionForContext(solveContext);
        this.activeLensDistortion = (activePrior && (activePrior.k1 !== 0 || activePrior.k2 !== 0))
            ? { k1: activePrior.k1, k2: activePrior.k2 }
            : null;

        this.status = hints.ra_hours != null
            ? (hintResolution.source === 'CONFIG'
                ? `Solving with target hint (RA ${hints.ra_hours.toFixed(2)}h)...`
                : hintResolution.source === 'ZENITH'
                    ? `Solving with zenith hint (RA ${hints.ra_hours.toFixed(2)}h)...`
                    : `Solving with header hint (RA ${hints.ra_hours.toFixed(2)}h)...`)
            : "Solving blind...";

        // Forward the curated detections from step2/3 (float-precision,
        // user-culled) instead of letting the solver re-extract from the
        // 8-bit solveBuffer. Same native pixel space as solveBuffer when
        // the science buffer is unbinned; guard binned fallback paths.
        // (SHARED curation helper — stages/detect, landmine #3.)
        const curatedStars = selectCuratedStars(this.scienceBuffer, this.imageWidth, this.imageHeight, this.signal);
        if (curatedStars) console.log(`[Session] Forwarding ${curatedStars.length} curated stars to solver (skipping re-extraction).`);

        let failReasons = '';
        let result: SolveResult | null = null;
        // Catalog-health surfacing (LAW 3): the star-catalog adapter used to
        // swallow atlas/sector load failures to the console and return silently,
        // so a catalog failure made the solve fail INVISIBLY (a bare no-lock).
        // Record a fresh health snapshot and route the adapter's REAL failures
        // (atlas never loaded, sector network/parse errors, queried-before-load)
        // through `warn()` — which pushes an honest degradation notice to
        // `this.warnings` (the documented Glass Pipeline UI channel) AND emits the
        // bus `warning` the inspector renders. Behaviorally INERT on healthy
        // solves (no REAL failure ⇒ nothing recorded/emitted), which the pinned
        // e2e byte-identity proves. Sink cleared in `finally`.
        const catalog = StarCatalogAdapter.getinstance();
        catalog.resetHealth();
        StarCatalogAdapter.setHealthSink((e) => this.warn(e.message, e.stage));
        try {
            result = await runSolve(solveBuffer, solveContext, curatedStars, this.events);
            this.solution = (result && result.success && result.solution) ? result.solution : null;
            if (!this.solution && result?.diagnostics?.rejection_reasons?.length) {
                failReasons = ` (${result.diagnostics.rejection_reasons.slice(0, 3).join('; ')})`;
                console.warn('[Session] Solve rejection reasons:', result.diagnostics.rejection_reasons);
            }
        } catch (err) {
            console.error('[Session] Plate solve threw:', err);
            this.solution = null;
            failReasons = err instanceof Error ? ` (${err.message})` : '';
        } finally {
            StarCatalogAdapter.setHealthSink(null);
        }
        // Retain the solve ladder's OWN diagnostics (quads/matches/rejection_reasons/
        // branch_timing) so a NO-SOLVE run can bank an honest failure receipt. This is
        // EXISTING stage output that was previously discarded — not new instrumentation.
        // buildReceipt/exportPacket never read this field, so the solved path is
        // byte-identical. null when the solve threw before diagnostics were assembled.
        this.solveDiagnostics = result?.diagnostics ?? null;
        if (!this.solution) this.status = `Plate solve failed - no geometric lock.${failReasons}`;

        // Glass Pipeline: replay the per-candidate forensics table as events
        // (read-only view of existing solver diagnostics — "why was candidate
        // 3 rejected" becomes visible without touching solver internals).
        const forensics = result?.diagnostics?.forensics;
        if (Array.isArray(forensics)) {
            for (const f of forensics) {
                this.events.emit({
                    kind: 'finding',
                    finding: {
                        kind: 'solve_candidate',
                        idx: typeof f?.candidate_idx === 'number' ? f.candidate_idx : -1,
                        quadError: typeof f?.quad_error === 'number' ? f.quad_error : undefined,
                        inferredScale: typeof f?.inferred_scale === 'number' ? f.inferred_scale : undefined,
                        status: String(f?.status ?? 'UNKNOWN')
                    }
                });
            }
        }

        // 4b. EPHEMERIS HANDSHAKE (The Digital Contract)
        if (this.solution && this.guestList.length > 0) {
            this.status = "Verifying planetary alignment...";
            this.solution = this.performEphemerisHandshake(this.solution, this.guestList);
        }

        this.state = 'IDLE';
        if (this.solution) {
            this.tx.set('astronomicalLoc', AstronomicalLocation.Finalized);
            this.tx.set('coordinateSystem', CoordinateSystem.Wcs);
            this.tx.commit('step4_solve');
            this.events.emit({
                kind: 'finding',
                finding: {
                    kind: 'solution_locked',
                    raHours: this.solution.ra_hours,
                    decDeg: this.solution.dec_degrees,
                    scale: this.solution.pixel_scale,
                    rotationDeg: this.solution.rotation_deg ?? this.solution.rotation ?? 0,
                    matched: this.solution.matched_stars?.length ?? this.solution.diagnostics?.stars_matched ?? 0,
                    confidence: this.solution.confidence
                }
            });
        }
        this.logger.logStage('solver', this.solution ? 'SUCCESS' : 'FAILED', { solution: this.solution });
        return this.solution;
    }

    /**
     * Projects Ephemeris Guest List into Pixel Space using the solved WCS.
     * Calculates residuals to verify the solution ("The Handshake").
     */
    private performEphemerisHandshake(sol: PlateSolution, guests: SolarBody[]): PlateSolution {
        const verifiedGuests = guests.map(body => {
            // 1. Gnomonic Projection (Sky -> Tangent Plane)
            const { xi, eta } = SkyTransform.gnomonicProject(
                body.ra, 
                body.dec, 
                sol.ra_hours, 
                sol.dec_degrees
            );
            
            // xi/eta are in degrees. scale is arcsec/px.
            const xi_px = UnitConverter.degToArcsec(xi) / sol.pixel_scale;
            const eta_px = UnitConverter.degToArcsec(eta) / sol.pixel_scale;
            
            const cd = sol.wcs.cd;
            const det = cd[0][0]*cd[1][1] - cd[0][1]*cd[1][0];
            
            if (Math.abs(det) < 1e-12) return body; // Singular WCS

            // Inverse CD matrix
            const invCD11 =  cd[1][1] / det;
            const invCD12 = -cd[0][1] / det;
            const invCD21 = -cd[1][0] / det;
            const invCD22 =  cd[0][0] / det;

            const dx = invCD11 * xi + invCD12 * eta;
            const dy = invCD21 * xi + invCD22 * eta;

            const pixelX = sol.wcs.crpix[0] + dx;
            const pixelY = sol.wcs.crpix[1] + dy;

            // 3. Measure Residual (distance to nearest detected bright star)
            let bestDist = 9999;
            let matchedSignal = null;
            const searchR = 50; 
            
            if (this.signal) {
                for (const star of this.signal.clean_stars) {
                    if (Math.abs(star.x - pixelX) > searchR) continue;
                    if (Math.abs(star.y - pixelY) > searchR) continue;
                    const d = Math.sqrt(Math.pow(star.x - pixelX, 2) + Math.pow(star.y - pixelY, 2));
                    if (d < bestDist) {
                        bestDist = d;
                        matchedSignal = star;
                    }
                }
            }

            return {
                ...body,
                pixel_x: pixelX,
                pixel_y: pixelY,
                residual_pixels: bestDist < 50 ? bestDist : undefined,
                locked: bestDist < 20 // High confidence lock
            };
        });

        const locks = verifiedGuests.filter(g => g.locked);
        const rms = locks.length > 0 
            ? Math.sqrt(locks.reduce((sum, g) => sum + (g.residual_pixels||0)**2, 0) / locks.length)
            : 0;

        // Honest logging: zero locks means no body landed in-frame — an RMS of
        // "0.00px" there would read as a perfect verification, not an empty one.
        if (locks.length === 0) {
            console.log(`[Handshake] No solar-system bodies within frame (${guests.length} candidates checked) - handshake N/A.`);
        } else {
            console.log(`[Handshake] Verified ${locks.length}/${guests.length} bodies. RMS: ${rms.toFixed(2)}px`);
        }

        // Land the handshake output on the session: `planets` is what MainApp
        // and exportPacket() read — it was never populated (always []), so the
        // verified guest list silently evaporated.
        this.planets = verifiedGuests;

        return {
            ...sol,
            planetary_matches: verifiedGuests,
            handshake_rms: rms
        };
    }

    private gnomonicProject(raH: number, decD: number, ra0H: number, dec0D: number) {
        return SkyTransform.gnomonicProject(raH, decD, ra0H, dec0D);
    }

    private peekSpectralData(rgb: Float32Array, packet: SignalPacket) {
        const sample = (p: SignalPoint) => {
            const ix = Math.floor(p.x);
            const iy = Math.floor(p.y);
            const idx = (iy * this.imageWidth + ix) * 3;
            
            if (idx >= 0 && idx < rgb.length - 2) {
                const r = rgb[idx];
                const g = rgb[idx+1];
                const b = rgb[idx+2];
                p.peak_rgb = [r, g, b];
                
                if (g > 0) {
                    p.measured_bv = Math.log10(b / g) * 0.5; // Heuristic
                }
            }
        };

        packet.clean_stars.forEach(sample);
        packet.anomalies.forEach(sample);
    }

    public async step5_Calibrate(): Promise<HardwareProfile> {
        return this.withStage('calibrate', () => this.step5_CalibrateInner());
    }

    private async step5_CalibrateInner(): Promise<HardwareProfile> {
        this.logger.logStage('calibration', 'RUNNING');
        this.state = 'CALIBRATING';
        this.currentStep = 5;
        
        if (!this.solution || !this.metadata || !this.signal) {
            throw new Error("Step 4 (Solve) must be complete before calibration.");
        }

        console.log(`[Session] Step 5: Running Forensic Hardware Profiling...`);
        this.status = "Generating hardware report...";

        // SHARED calibrate stage (stages/calibrate): spectral-forensics
        // measurement mapping + HardwareProfiler report. (This input was
        // historically an EMPTY ARRAY — the solved matched stars carry the
        // peeked per-channel peaks + catalog color the profiler needs.)
        this.hardwareProfile = generateHardwareProfile(this.solution, this.metadata, this.signal);

        this.hardware = this.hardwareProfile;

        // M7 astrometric refinement: residual RMS + SIP polynomial fit,
        // landed on the solution by the SHARED calibrate stage (non-fatal
        // on analyzer failure). Wrapped as a flowchart node (recon G4).
        const analysis = await this.withStage(
            'm7_refine',
            async () => applyAstrometricRefinement(this.solution!),
            (a) => ({
                verdict: a?.sip_coefficients ? 'APPLIED' : (a?.distortion_pattern_detected ? 'PASS' : 'NOT_MEASURED'),
                payloadRef: a?.sip_coefficients ? 'astrometry' : null,
            })
        );
        if (analysis?.distortion_pattern_detected) {
            console.log(`[Session] M7 residual analysis: RMS=${analysis.rms_arcsec.toFixed(2)}" — SIP ${analysis.sip_coefficients ? 'fitted' : 'not fitted (needs >20 matches)'}.`);
        }

        // APPLIED-SCIENCE RENDER (PIXEL ledger, render-only, DEFAULT ON via
        // RENDER_APPLIED_SCIENCE && the legacy RENDER_APPLY_SIP kill-switch):
        // re-render the wizard preview through the ONE arbitrated inverse warp
        // (SIP|TPS|measured-BC selection ladder) so the measured distortion is
        // actually removed from the pixels the user sees — the display becomes the
        // representation of the measurements. Caches the un-corrected URL as
        // previewUrlOriginal for the FinalImageView "Applied science / Original"
        // toggle, and records which model applied for the caption. HONEST-OR-ABSENT:
        // a no-op when no qualifying per-frame-fitted model exists (SeeStar → no
        // SIP/TPS/BC → warp-free STF, byte-identical). Headless generatePreviews=false
        // makes it a hard no-op on every gate lane. Never touches WCS / matched_stars
        // / the solve numbers / any receipt (all finalized above).
        // Flowchart node id kept `render_apply_sip` (stable across the replay NOT-YET
        // registry + flowchart) even though the umbrella now governs SIP+TPS+BC.
        await this.withStage('render_apply_sip', async () => {
            if (!(PIPELINE_CONSTANTS.RENDER_APPLIED_SCIENCE && PIPELINE_CONSTANTS.RENDER_APPLY_SIP)) {
                return { applied: false };
            }
            const prep = this.prepareWarp();
            if (!prep) return { applied: false }; // no per-frame model → honest no-op (original shown)
            // RENDER ADMISSION GATE (mirrors the TPS-gate philosophy: a model renders
            // ONLY where it is valid across the frame). A selected-but-REFUSED model
            // (extrapolates into garbage outside its fit support — the beach case)
            // shows the ORIGINAL and records the honest reason for the UI. Never silent.
            if (!prep.admission.admitted) {
                this.renderWarpRefused = { source: prep.selection.source, reason: prep.admission.reason, metrics: prep.admission.metrics };
                const mx = prep.admission.metrics;
                console.log(`[Session] RENDER_APPLIED_SCIENCE: ${prep.selection.source} REFUSED (${prep.admission.reason}) — showing original. coverage=${(mx.hull_coverage * 100).toFixed(1)}% cornerRatio=${mx.corner_ratio.toFixed(1)}x maxCorner=${mx.max_corner_px.toFixed(0)}px rms=${mx.rms_px.toFixed(2)}px.`);
                return { applied: false };
            }
            const rendered = this.renderFromPrep(prep);
            if (!rendered) return { applied: false };
            // Cache the un-corrected preview BEFORE overwriting (the toggle target).
            this.previewUrlOriginal = this.previewUrl;
            this.previewUrl = rendered.url;
            this.renderWarpApplied = {
                source: rendered.selection.source,
                label: rendered.selection.label,
                rms_arcsec: rendered.selection.rms_arcsec,
            };
            console.log(`[Session] RENDER_APPLIED_SCIENCE: preview re-rendered through ${rendered.selection.source} inverse warp (ADMITTED: coverage=${(prep.admission.metrics.hull_coverage * 100).toFixed(1)}% cornerRatio=${prep.admission.metrics.corner_ratio.toFixed(1)}x).`);
            return { applied: true };
        }, (r) => ({ verdict: r.applied ? 'APPLIED' : 'SKIP', payloadRef: null }));

        // [SPCC] SHARED science stage (stages/science) — divergence #6 fix:
        // the wizard now runs real SPCC on FITS inputs (visible in the
        // receipt's `spcc` block). Matched detections are NATIVE-space here
        // (unbinned science buffer), so scales=null (1:1 mapping); air mass
        // is 1.0 (the wizard computes no atmospherics — same fallback as
        // the auto path without a derived air mass).
        const spcc = await this.withStage('spcc', async () => runSpcc(
            this.solution!.matched_stars ?? [],
            this.scienceRgb,
            null,
            this.metadata?.exposure_time || 1,
            this.sourceFormat === 'FITS',
            1.0,
            (msg) => console.log(`[Session] ${msg}`),
            // CELL ④ — camera model for the QE-throughput divide-out (inert unless
            // VITE_SPCC_QE_THROUGHPUT is ON; byte-identical off).
            this.metadata?.camera_model ?? null,
        ), (r) => ({
            // SPCC runs on FITS inputs only — a null block is an honest SKIP, not a failure.
            verdict: r.block ? 'PASS' : 'SKIP',
            counts: (r.block ? { n_stars: r.block.n_stars } : {}) as Record<string, number>,
            payloadRef: r.block ? 'spcc' : null,
        }));
        this.spccBlock = spcc.block;
        // [SCHEMA B] surface SPCC per-star photometry (index-aligned with the matched
        // stars passed above) for the receipt photometry block — pure surfacing.
        this.spccStars = spcc.cal
            ? surfaceSpccPerStar(spcc.cal, this.solution.matched_stars ?? [])
            : undefined;
        if (spcc.block) {
            console.log(`[Session] SPCC ${spcc.block.source}: slope=${spcc.block.color_slope.toFixed(3)} r2=${spcc.block.color_r2.toFixed(3)} zp=${spcc.block.zeropoint.toFixed(2)} (${spcc.block.n_stars} usable stars, ${this.spccStars?.length ?? 0} per-star surfaced).`);
        }

        // [SPCC-WB §3.2] RENDER-LANE white-balance application (PIXEL ledger). When
        // the TLS gains passed their quality gate AND the apply flag is on, re-render
        // the preview through the catalog-derived WB (replacing the star-ensemble-
        // white heuristic). APPLIED only in the render — the solve/PSF/forced-
        // photometry chain reads LINEAR UNSCALED data, so both pinned solves stay
        // byte-identical. Never fatal; SKIP (honest fallback to the empirical WB
        // already in previewUrl) when the gate refused / flag off / no preview.
        await this.withStage('spcc_render_gains', async () => {
            const g = spcc.cal?.gains;
            if (!(g && g.applied && this.generatePreviews && this.previewFloat32 && this.scales)) {
                return { applied: false };
            }
            try {
                const previewImageData = ImageProcessor.float32ToImageDataAutoStretch(
                    this.previewFloat32, this.scales.previewW, this.scales.previewH,
                    this.getPreviewColorTransform(),
                    { gains: g.gains, applied: true },
                    this.getRenderOpts(),
                );
                this.previewUrl = ImageProcessor.createPreviewUrl(previewImageData);
                console.log(`[Session] SPCC-WB applied to preview: gains=[${g.gains.map(v => v.toFixed(3)).join(', ')}] (TLS, N=${g.nStars}, r2=${g.r2.toFixed(3)}).`);
                return { applied: true };
            } catch (err) {
                this.warn(`SPCC-WB render skipped (${err instanceof Error ? err.message : String(err)}) — preview unchanged.`, 'render');
                return { applied: false };
            }
        }, (r) => ({ verdict: r.applied ? 'APPLIED' : 'SKIP', payloadRef: null }));

        // SHARED PSF characterization stage (stages/psf_characterize) — post-
        // solve, pre-export; PIXEL ledger, additive to the receipt only. Runs
        // for BOTH consumers (wizard here + headless via the same step5).
        // Independently orderable w.r.t. the post-solve forced-photometry
        // harvest. NEVER fatal: any failure degrades to psfField=null (the
        // solve numbers / sacred coordinate ledger are untouched either way).
        try {
            this.psfField = await this.withStage('psf_field', async () => runPsfCharacterization({
                scienceBuffer: this.scienceBuffer,
                width: this.imageWidth,
                height: this.imageHeight,
                solution: this.solution,
                events: this.events
            }));
            if (this.psfField) {
                console.log(`[Session] PSF field (${this.psfField.method}, ${this.psfField.grid}): ${this.psfField.nFit} stars, FWHM median ${this.psfField.fwhmMedianMajPx?.toFixed(2) ?? 'n/a'}px, ellipticity ${this.psfField.ellipticityMedian?.toFixed(2) ?? 'n/a'}.`);
            }
        } catch (err) {
            this.psfField = null;
            this.warn(`PSF characterization skipped (${err instanceof Error ? err.message : String(err)}) — solve unaffected.`, 'psf_field');
        }

        // SHARED PSF ATTRIBUTION stage (stages/psf_attribution) — runs AFTER
        // psf_field because it READS the measured field (the arbiter) and
        // decomposes it into physically-calculable systematics {sidereal drift /
        // diffraction / seeing / differential refraction / coma} + residual.
        // Physics INFORMS + GUIDES, never OVERRIDES: it mutates NOTHING (not
        // psfField, not the solve) — purely additive to the receipt. NEVER fatal.
        try {
            this.psfAttribution = await this.withStage('psf_attribution', async () => runPsfAttribution({
                psfField: this.psfField,
                solution: this.solution,
                metadata: this.metadata,
                imageWidth: this.imageWidth,
                imageHeight: this.imageHeight,
                timestampTrusted: this.timestampTrusted,
                events: this.events
            }));
            if (this.psfAttribution) {
                const d = this.psfAttribution.drift;
                console.log(`[Session] PSF attribution: drift ${d.presence} (calc ${d.calculatedPx?.toFixed(2) ?? 'n/a'}px @ PA ${d.paDeg?.toFixed(1) ?? 'n/a'}°), tracking ${this.psfAttribution.tracking.inference} (${this.psfAttribution.tracking.tier}).`);
            }
        } catch (err) {
            this.psfAttribution = null;
            this.warn(`PSF attribution skipped (${err instanceof Error ? err.message : String(err)}) — solve unaffected.`, 'psf_attribution');
        }

        // MEASURED per-capture BROWN-CONRADY (m2_hardware/lens_distortion_refit,
        // COORDINATE ledger) — ALWAYS-ON observation. Fits this capture's own
        // distortion from the solver-verified matched pairs and records it into
        // the receipt (`lens_distortion_measured`, labeled MEASURED). Pure
        // observation: reads solution.matched_stars + solution.wcs, mutates
        // NOTHING (not the WCS, not matched_stars, not confidence) — so the
        // sacred coordinate ledger is byte-identical whether this runs or not.
        // Honest-or-absent: null when no WCS; a `not_measured` report when
        // coverage is too thin to fit. NEVER fatal.
        try {
            // Flowchart node (recon G4): measured Brown-Conrady observation.
            this.bcMeasured = await this.withStage(
                'bc_measure',
                async () => measureBrownConradyFromSolution(this.solution!, this.imageWidth, this.imageHeight),
                (m) => ({
                    verdict: (m && !m.not_measured) ? 'PASS' : 'NOT_MEASURED',
                    counts: ((m && !m.not_measured) ? { n_used: m.n_used, n_pairs: m.n_pairs } : {}) as Record<string, number>,
                    payloadRef: (m && !m.not_measured) ? 'lens_distortion_measured' : null,
                })
            );
            if (this.bcMeasured && !this.bcMeasured.not_measured) {
                console.log(`[Session] Measured Brown-Conrady: k1=${this.bcMeasured.k1} k2=${this.bcMeasured.k2 ?? 'n/a'} (${this.bcMeasured.n_used}/${this.bcMeasured.n_pairs} pairs, 2D rms ${this.bcMeasured.rms_2d_px}px vs baseline ${this.bcMeasured.baseline_rms_2d_px ?? 'n/a'}px, terms [${this.bcMeasured.terms.join(',')}], ${this.bcMeasured.mustache.verdict}).`);
            } else if (this.bcMeasured?.not_measured) {
                console.log(`[Session] Measured Brown-Conrady: NOT MEASURED — ${this.bcMeasured.not_measured}.`);
            }
        } catch (err) {
            this.bcMeasured = null;
            this.warn(`Measured Brown-Conrady skipped (${err instanceof Error ? err.message : String(err)}) — solve unaffected.`, 'calibrate');
        }

        // PRIMARY BC REMATCH (m2_hardware/lens_distortion_rematch_pass, COORDINATE
        // ledger) — owner ruling 2026-07-08: measured-BC application PROMOTED to
        // PRIMARY-by-default. Consumes this.bcMeasured; when the fit passed its
        // coverage gates it BC-corrects the FULL detection set's matching coords,
        // re-matches against the catalog to recover edge stars, RE-RUNS the M7 SIP
        // refinement on the densified set, culls under the SAME acceptance the
        // originals cleared, and forced-photometry existence-checks the survivors.
        // NEVER-WORSE structural guard: applies the densified solution ONLY if it
        // has strictly more matches AND no worse post-chain RMS — else the
        // solution is byte-identical (well-corrected narrow FITS recover nothing
        // and KEEP → the sacred SeeStar solve stays bit-identical). Fail-soft.
        this.bcRematch = null;
        if (this.solution) {
            try {
                const dets = [
                    ...(this.signal?.clean_stars ?? []),
                    ...(this.signal?.anomalies ?? []),
                ].map(s => ({ x: s.x, y: s.y, fwhm: s.fwhm }));
                this.bcRematch = await this.withStage('bc_rematch', async () => runBcRematchPass({
                    solution: this.solution!,
                    bcMeasured: this.bcMeasured,
                    detections: dets,
                    scienceBuffer: this.scienceBuffer ?? null,
                    imageWidth: this.imageWidth,
                    imageHeight: this.imageHeight,
                    timestamp: this.timestampTrusted ? this.timestamp.toISOString() : undefined,
                    log: (m) => console.log(`[Session] ${m}`),
                }));
                if (this.bcRematch) this.solution.bc_rematch = this.bcRematch;
            } catch (err) {
                this.bcRematch = null;
                this.warn(`BC rematch skipped (${err instanceof Error ? err.message : String(err)}) — solve unaffected.`, 'calibrate');
            }
        }

        // POST-SOLVE CONFIRMATION (forced_confirm, FP wave C5) — runs AFTER
        // psf_field so it consumes the MEASURED frame PSF for the shape test.
        // SESSION-PATH-ONLY (like psf_field; the auto orchestrator is out of
        // scope). Additive + fail-soft + honest-or-absent: writes ONLY
        // this.solution.deep_confirmed; the sacred coordinate ledger (WCS /
        // matched_stars / confidence) is untouched on every branch. Measures on
        // the native Float32 science luminance (never the 8-bit solve buffer).
        if (this.scienceBuffer && this.solution) {
            try {
                const sb = this.scienceBuffer;
                // Grid disambiguation — identical predicate to runPsfCharacterization:
                // the science buffer (and thus the WCS grid) is native or 2×-binned.
                const isBinned = sb.length === (Math.floor(this.imageWidth / 2) * Math.floor(this.imageHeight / 2))
                    && sb.length !== this.imageWidth * this.imageHeight;
                const bw = isBinned ? Math.floor(this.imageWidth / 2) : this.imageWidth;
                const bh = isBinned ? Math.floor(this.imageHeight / 2) : this.imageHeight;
                // Frame-PSF reference from the measured psf_field (same grid).
                const framePsf: FramePsfRef | null = (this.psfField && this.psfField.fwhmMedianMajPx != null) ? {
                    fwhmPx: this.psfField.fwhmMedianMajPx,
                    ellipticity: this.psfField.ellipticityMedian,
                    source: this.psfField.method,
                    undersampled: this.psfField.fwhmMedianMajPx < PIPELINE_CONSTANTS.SOLVER_CONFIRM_UNDERSAMPLED_FWHM_PX,
                } : null;
                const confirmed = await this.withStage('forced_confirm', async () => runPostSolveConfirmation({
                    scienceBuffer: sb, width: bw, height: bh,
                    solution: this.solution!,
                    detected: (this.solution!.matched_stars ?? []).map(m => ({ fwhm: m.detected?.fwhm })),
                    framePsf,
                    timestamp: this.timestampTrusted ? this.timestamp.toISOString() : undefined,
                    // WIRING_SPEC R3: pass the active prior's (k1,k2) so confirmation
                    // re-projects its probes to native via toNative (built on the bw/bh
                    // grid inside). Null when no prior ⇒ byte-identical (pinned solves).
                    lensDistortion: this.activeLensDistortion,
                    // F2 (row 547): hand the chain's OWN best distortion knowledge to
                    // probe projection — the fitted SIP + the measured BC (prior stays
                    // the fallback inside). Both existed here all along, unpassed.
                    sip: this.solution!.astrometry?.sip ?? null,
                    bcMeasured: (this.bcMeasured && !this.bcMeasured.not_measured
                        && Number.isFinite(this.bcMeasured.k1))
                        ? { k1: this.bcMeasured.k1, k2: this.bcMeasured.k2 ?? 0 }
                        : null,
                }));
                if (confirmed) this.solution.deep_confirmed = confirmed;
            } catch (err) {
                this.warn(`Forced confirmation skipped (${err instanceof Error ? err.message : String(err)}) — solve unaffected.`, 'forced_confirm');
            }
        }

        // FINAL ASTROMETRY (stages/final_astrometry, COORDINATE ledger) — the
        // step-6 TERMINAL data-fidelity refit. Runs LAST in the post-solve region
        // (reads the finalized solution + the measured psf_field) and emits a
        // SECOND, provenance-tagged WCS re-fit with PSF-fit centroids +
        // differential refraction (gated on trusted clock + real GPS, honest-skip
        // otherwise) + SNR-honest weighting. A PRODUCT: mutates NOTHING (not the
        // WCS, not matched_stars, not confirm) — additive to the receipt only, so
        // the sacred coordinate ledger stays byte-identical. NEVER fatal.
        try {
            this.finalAstrometry = await this.withStage('final_astrometry', async () => runFinalAstrometry({
                solution: this.solution,
                psfField: this.psfField,
                metadata: this.metadata,
                timestampTrusted: this.timestampTrusted,
                imageWidth: this.imageWidth,
                imageHeight: this.imageHeight,
                events: this.events,
            }));
            if (this.finalAstrometry) {
                const fa = this.finalAstrometry;
                console.log(`[Session] Final astrometry (${fa.provenance}): ${fa.nPsfCentroids}/${fa.nStars} PSF centroids, refraction ${fa.refraction.applied ? 'APPLIED' : 'skipped'}, RMS ${fa.rms.linearArcsec ?? 'n/a'}"→${fa.rms.refinedArcsec ?? 'n/a'}" (${fa.weighting.method}, improved ${fa.improved}).`);
            }
        } catch (err) {
            this.finalAstrometry = null;
            this.warn(`Final astrometry skipped (${err instanceof Error ? err.message : String(err)}) — solve unaffected.`, 'final_astrometry');
        }

        this.state = 'IDLE';
        this.tx.commit('step5_calibrate');
        this.logger.logStage('calibration', 'SUCCESS', { profile: this.hardwareProfile });
        this.status = "Calculating forensic telemetry...";
        this.calculateForensics();
        return this.hardwareProfile!;
    }

    /**
     * [RUNG-3 READ-BACK · SOLVER_WORKBENCH_PRIOR] Query the Optical-Workbench store
     * for THIS rig's deposits and, when ≥3 agree (poolWorkbenchPrior's conservative
     * sign+magnitude gate), build a WORKBENCH_POOLED distortion prior shaped exactly
     * like resolveLensDistortion's output so it seeds the solve through the identical
     * `context.lensDistortionResolution → options.lensDistortionPrior` path a LENS_DB
     * nominal would. Never throws; returns null on any absence (no store / no deposits
     * / evidence too thin). Reads the SAME storage the deposit hook writes
     * (currentWorkbenchStorage); a browser that has not yet resolved a backend returns
     * null (honest skip — this flag is a Node/headless lever).
     */
    private async maybeBuildWorkbenchPrior(): Promise<LensDistortionResolution | null> {
        try {
            const storage = currentWorkbenchStorage();
            if (!storage) return null;
            const rig = deriveRigKey(this.metadata);
            const deposits = (await Promise.resolve(storage.list(rig.key))) as ObservationDeposit[];
            const pooled = poolWorkbenchPrior(deposits);
            if (!pooled) return null;
            const lensStr = (this.metadata?.lens_model ?? 'UNKNOWN').toString();
            const fl = OpticsManager.getEffectiveFocalLength(this.metadata) || 0;
            console.log(`[Session] [WORKBENCH-PRIOR] Pooled ${pooled.n} agreeing same-rig deposits (epoch ${pooled.epoch}, k1 rel-dispersion ${(pooled.k1_rel_dispersion * 100).toFixed(0)}%): k1=${pooled.k1}, k2=${pooled.k2} (k2_fitted=${pooled.k2_fitted}).`);
            return {
                k1: pooled.k1,
                k2: pooled.k2,
                coeffs: { k1: pooled.k1, k2: pooled.k2, k3: 0, p1: 0, p2: 0 },
                provenance: 'WORKBENCH_POOLED',
                lensKey: 'WORKBENCH_POOLED',
                lensModel: lensStr,
                focalLength: fl,
            };
        } catch (err) {
            this.warn(`Workbench prior read-back skipped (${err instanceof Error ? err.message : String(err)}) — solve unaffected.`, 'solve');
            return null;
        }
    }

    /**
     * [RUNG-0 READ-BACK · SOLVER_IDENTITY_PROFILE] Optical-train fingerprint lookup.
     * Compute the frame's SHA256(camera+lens+filter) train hash, then ask the store
     * for the MEASURED profile keyed to that exact train (resolveIdentityProfile). A
     * REGISTERED placeholder identity is trusted at a single measured deposit;
     * otherwise the ≥3 auto-pool gate applies. The resolved profile is stamped
     * `measured:identity` by resolveLensDistortion (rung-0) so it flows through the
     * identical `context.lensDistortionResolution → options.lensDistortionPrior`
     * seam a LENS_DB nominal would, but SKIPS the LENS_DB/EXIF lookups. Never throws;
     * returns null on any absence (no store / no train identity / no matching
     * measured profile). Reads ALL deposits (a train hash spans rig_key tiers).
     */
    private async maybeBuildIdentityPrior(): Promise<LensDistortionResolution | null> {
        try {
            const storage = currentWorkbenchStorage();
            if (!storage) return null;
            const trainHash = deriveTrainHashFromMetadata(this.metadata);
            if (!trainHash) return null;
            const deposits = (await Promise.resolve(storage.list())) as ObservationDeposit[];
            const placeholderTier = isRegisteredTrainIdentity(trainHash);
            const profile = resolveIdentityProfile(deposits, trainHash, { placeholderTier });
            if (!profile) return null;
            const lensStr = (this.metadata?.lens_model ?? 'UNKNOWN').toString();
            const fl = OpticsManager.getEffectiveFocalLength(this.metadata) || 0;
            const identity: IdentityDistortionProfile = {
                k1: profile.k1,
                k2: profile.k2,
                trainHash: profile.train_hash,
                lensModel: lensStr,
                focalLength: fl,
            };
            console.log(`[Session] [IDENTITY-PROFILE] Optical-train ${trainHash.slice(0, 12)}… matched a MEASURED profile (tier=${profile.tier}, n=${profile.n}, epoch=${profile.epoch}, k1=${profile.k1}, k2=${profile.k2}) — skipping generic LENS_DB.`);
            // resolveLensDistortion stamps provenance 'measured:identity' at rung-0.
            return resolveLensDistortion(this.metadata, null, identity);
        } catch (err) {
            this.warn(`Identity profile read-back skipped (${err instanceof Error ? err.message : String(err)}) — solve unaffected.`, 'solve');
            return null;
        }
    }

    private calculateForensics() {
        if (!this.signal) return;

        const stars = this.signal.clean_stars;
        const anomalies = this.signal.anomalies;

        const ratio = anomalies.length > 0 ? stars.length / anomalies.length : stars.length;
        const interference = anomalies.length > stars.length;

        const starsWithBV = stars.filter((s: SignalPoint) => s.measured_bv !== undefined);
        const bvMean = starsWithBV.length > 0 
            ? starsWithBV.reduce((sum: number, s: SignalPoint) => sum + s.measured_bv!, 0) / starsWithBV.length
            : 0;

        const fwhmMean = stars.length > 0
            ? stars.reduce((sum: number, s: SignalPoint) => sum + s.fwhm, 0) / stars.length
            : 0;

        const counts = { satellites: 0, hot_pixels: 0, terrestrial: 0 };
        anomalies.forEach((a: SignalPoint) => {
            if (a.peak_value > 0.9 && a.fwhm < 1.5) counts.hot_pixels++;
            else if (a.ellipticity > 0.7) counts.satellites++;
            else counts.terrestrial++;
        });

        const midY = (this.scales?.nativeH || this.imageHeight) / 2;
        const topStars = stars.filter((s: SignalPoint) => s.y < midY);
        const bottomStars = stars.filter((s: SignalPoint) => s.y >= midY);
        const topFlux = topStars.length > 0 ? topStars.reduce((sum: number, s: SignalPoint) => sum + s.flux, 0) / topStars.length : 1;
        const bottomFlux = bottomStars.length > 0 ? bottomStars.reduce((sum: number, s: SignalPoint) => sum + s.flux, 0) / bottomStars.length : 1;
        const extinction = Math.max(0, (topFlux - bottomFlux) / topFlux);

        let dx = 0, dy = 0;
        if (this.solution?.wcs?.crpix) {
            dx = this.solution.wcs.crpix[0] - ((this.scales?.nativeW || this.imageWidth) / 2);
            dy = this.solution.wcs.crpix[1] - ((this.scales?.nativeH || this.imageHeight) / 2);
        }

        this.forensics = {
            star_anomaly_ratio: ratio,
            interference_flag: interference,
            global_bv_mean: bvMean,
            mean_fwhm: fwhmMean,
            rms_truth_score: this.solution?.handshake_rms || 0,
            snr_noise_floor: this.signal.noise_floor,
            optical_center_offset: { dx, dy },
            extinction_gradient: extinction,
            anomaly_counts: counts
        };

        console.log(`[Forensics] Ratio: ${ratio.toFixed(2)}, Extinction: ${(extinction*100).toFixed(1)}%, Center Offset: ${dx.toFixed(1)},${dy.toFixed(1)}`);
    }

    /**
     * OPTIONAL M10 PSF DIAGNOSTICS — never part of the step chain. Called
     * only from the step-6 PSF panel on explicit user request; its absence
     * changes nothing in any scenario (sacred E2E contract).
     *
     * Pixel ledger: measures on the science buffer's own grid (native, or
     * 2x2-binned when the Bayer-native path produced a binned buffer) —
     * FWHM numbers are in THAT grid's pixels and the report says which.
     */
    public async runPsfDiagnostics(options?: PsfStageOptions): Promise<PsfReport> {
        if (!this.scienceBuffer) throw new Error('PSF diagnostics require the science buffer (run extraction first).');
        const isBinned = this.scienceBuffer.length === (Math.floor(this.imageWidth / 2) * Math.floor(this.imageHeight / 2))
            && this.scienceBuffer.length !== this.imageWidth * this.imageHeight;
        const bw = isBinned ? Math.floor(this.imageWidth / 2) : this.imageWidth;
        const bh = isBinned ? Math.floor(this.imageHeight / 2) : this.imageHeight;
        if (this.scienceBuffer.length !== bw * bh) {
            throw new Error(`PSF diagnostics: science buffer length ${this.scienceBuffer.length} matches neither native nor binned dims.`);
        }
        const report = await this.withStage('psf', () => runPsfStage({
            lum: this.scienceBuffer!,
            width: bw,
            height: bh,
            options: {
                ...options,
                onProgress: (s) => { this.status = s; options?.onProgress?.(s); }
            },
            events: this.events
        }));
        report.grid = isBinned ? 'SCIENCE_BINNED2X' : 'SCIENCE_NATIVE';
        this.psfReport = report;
        return report;
    }

    public async step6_Integrate(): Promise<any> {
        const packet = await this.withStage('integrate', () => this.step6_IntegrateInner());
        this.events.emit({ kind: 'run_finished', ok: true });
        return packet;
    }

    private async step6_IntegrateInner(): Promise<any> {
        this.state = 'INTEGRATING';
        this.currentStep = 6;
        const packet = this.exportPacket();
        this.events.emit({
            kind: 'finding',
            finding: { kind: 'packet_built', stars: this.signal?.clean_stars.length ?? 0 }
        });
        this.state = 'COMPLETE';
        return packet;
    }

    /** [TESTIMONY] Apply observer annotations onto the session so the next
     *  exportPacket() carries them (user_annotations block). Pass the normalized
     *  block (from buildUserAnnotations) or null to clear. String-only testimony —
     *  this NEVER touches the solve/detection/verification state; it only rides out
     *  to the receipt. The UI confirm is the sole gate that promotes an MCP draft. */
    public setUserAnnotations(annotations: UserAnnotations | null): void {
        this.userAnnotations = annotations;
    }

    /** [TESTIMONY] Apply the observer's horizon correction onto the session. Pass
     *  the built record (buildHorizonCorrection) or null to clear it. This is
     *  RECORDED TESTIMONY: it NEVER mutates the automatic estimate and (tonight)
     *  does not feed culling, detection, verification, or the solve. */
    public setHorizonCorrection(rec: HorizonCorrectionRecord | null): void {
        this.horizonCorrection = rec;
    }

    public exportPacket(): any {
        // SHARED package stage (stages/package): receipt v2.2.x assembly —
        // fitted WCS (never re-synthesized when a fit exists), sentinel-
        // filtered residuals, matched-star list, spcc block, warnings[] +
        // timestamp_trusted provenance. Pure function; the session only
        // supplies its state.
        const packet = buildReceipt({
            metadata: this.metadata,
            signal: this.signal,
            solution: this.solution,
            planets: this.planets,
            hardware: this.hardware,
            forensics: this.forensics,
            scales: this.scales?.getFrontendExport(),
            warnings: this.warnings,
            timestampTrusted: this.timestampTrusted,
            spcc: this.spccBlock,
            spccStars: this.spccStars,
            psfField: this.psfField,
            psfAttribution: this.psfAttribution,
            // [schema 2.20.0] step-6 TERMINAL refit → receipt final_astrometry (a
            // SECOND provenance-tagged WCS; PRODUCT, never overwrites the solve WCS).
            finalAstrometry: this.finalAstrometry,
            bcMeasured: this.bcMeasured,
            opticsHints: this.opticsHints,
            // [PROVENANCE §7] Search-prior category → solve_provenance.solved_via.
            // No failed_attempts producer in the Monday slice (no escalation loop).
            hintSource: this.hintSource,
            // [HINT · schema 2.14.0] The explicit caller target hint VALUE →
            // receipt user_target_hint, surfaced ONLY when it seeded the solve
            // (hintSource==='CONFIG'). null on every blind / no-hint solve.
            callerHint: this.callerHint,
            userAnnotations: this.userAnnotations,
            // [PROVENANCE · schema 2.13.0] The RAW decoder arm that ACTUALLY produced
            // this frame's pixels → receipt pipeline_provenance.decoder_arm. Honest:
            // null when no raw decode ran (FITS / demo-tier), else the live flag arm.
            decoderArm: this.rawSensorDecode ? (isRawlerDecoderEnabled() ? 'rawler' : 'libraw') : null,
            // [COMPUTE-ROUTE OBSERVABILITY · schema 2.16.0] Honest seam route stamps
            // (demosaic + preview) accumulated this run → receipt compute_routes block.
            computeRoutes: this.computeRoutes,
            imageWidth: this.imageWidth,
            imageHeight: this.imageHeight
        });
        // [Optical Workbench] post-package collection hook — DEFAULT ON,
        // never-fatal, ZERO receipt mutation (pure side-channel observation:
        // extracts a compact per-rig deposit from the FINISHED receipt). A
        // storage failure/absence can never fail a solve or perturb the receipt,
        // so the sacred solve stays byte-identical. Persists only when a storage
        // backend is present (browser IndexedDB/localStorage auto, or an injected
        // headless Node store); a no-op otherwise (e.g. the api-smoke gate env).
        depositFromReceipt(packet);
        return packet;
    }

    /**
     * [ANALYTICS FLYWHEEL · headless-entry-scoped] Assemble an honest NO-SOLVE
     * failure receipt from the state reached before the solve produced a geometric
     * lock (or a stage threw). SEPARATE from exportPacket() and NEVER called on the
     * success path — so solved receipts stay byte-identical by construction, and the
     * step5 calibrate guard (which throws when this.solution is null) is UNCHANGED.
     *
     * The BROWSER wizard path never calls this (the UI gates step5 on a solve); the
     * headless driver (runWizardPipeline) calls it BEFORE step5 on a no-solve so a
     * failed frame still banks data instead of vanishing. Gathers the honest session
     * state (mirrors exportPacket's decoder-arm derivation); the caller supplies only
     * the facts it uniquely holds (the event-folded stage timings + the frame sha).
     */
    public exportFailurePacket(opts?: {
        stageReached?: string;
        stageOfDeath?: string;
        stageTimings?: StageTimingSummary | null;
        frameSha256?: string | null;
        errorMessage?: string | null;
    }): any {
        // [SOLVE_FAILURE_DIAGNOSTICS · default OFF] Turn every refusal into a learning
        // artifact: bank a MEASURED record of the closest the solve came (best sub-
        // threshold sweep σ + a verified-but-dropped near-miss with bc_measure on its
        // real matched pairs). Flag-gated; null when OFF (byte-identical no-solve receipt).
        const failureDiagnostics = envFlagOn(SOLVE_FAILURE_DIAGNOSTICS_FLAG)
            ? buildFailureDiagnosticsBlock(this.solveDiagnostics, this.imageWidth, this.imageHeight)
            : null;
        return buildFailureReceipt({
            metadata: this.metadata,
            signal: this.signal,
            solveDiagnostics: this.solveDiagnostics,
            failureDiagnostics,
            stageTimings: opts?.stageTimings ?? null,
            stageReached: opts?.stageReached ?? 'solve',
            stageOfDeath: opts?.stageOfDeath ?? 'solve',
            failReason: this.status || null,
            frameSha256: opts?.frameSha256 ?? null,
            sourceFormat: this.sourceFormat,
            warnings: this.warnings,
            timestampTrusted: this.timestampTrusted,
            // Honest decoder arm — mirrors exportPacket exactly: null when no raw decode
            // ran (FITS-native / demo-tier), else the live flag arm. Never a flag-only guess.
            decoderArm: this.rawSensorDecode ? (isRawlerDecoderEnabled() ? 'rawler' : 'libraw') : null,
            // [COMPUTE-ROUTE OBSERVABILITY · schema 2.16.0] A failed frame still banks
            // which compute path each GPU-capable seam took (or null when none reached).
            computeRoutes: this.computeRoutes,
            errorMessage: opts?.errorMessage ?? null,
            imageWidth: this.imageWidth,
            imageHeight: this.imageHeight,
        });
    }

    /**
     * The measured science frame for science-format export (ASDF ndarray).
     * Returns the luminance science buffer on ITS OWN grid — native, or
     * 2×2-binned when the Bayer-native path produced a binned buffer (same
     * binning discriminant as runPsfDiagnostics). channels:1 (mono luminance),
     * datatype float32. Null when no science buffer exists (honest-or-absent).
     */
    public getExportImage(): { data: Float32Array; width: number; height: number; channels: 1 } | null {
        if (!this.scienceBuffer) return null;
        const isBinned = this.scienceBuffer.length === (Math.floor(this.imageWidth / 2) * Math.floor(this.imageHeight / 2))
            && this.scienceBuffer.length !== this.imageWidth * this.imageHeight;
        const width = isBinned ? Math.floor(this.imageWidth / 2) : this.imageWidth;
        const height = isBinned ? Math.floor(this.imageHeight / 2) : this.imageHeight;
        if (this.scienceBuffer.length !== width * height) return null;
        return { data: this.scienceBuffer, width, height, channels: 1 };
    }

    public getCrop(centerX: number, centerY: number, size: number = 512): ImageData | null {
        if (!this.scienceBuffer) return null;
        return ImageProcessor.getCrop(
            this.scienceBuffer, 
            this.imageWidth, 
            this.imageHeight, 
            centerX, 
            centerY, 
            size, 
            this.scales || undefined
        );
    }

    // ── HELPERS ──
    private computeluminance(rgb: Float32Array, cfaMosaicLuma?: boolean): Float32Array {
        const pixelCount = rgb.length / 3;
        if (!this.scienceBuffer || this.scienceBuffer.length !== pixelCount) {
            console.log(`[Orchestrator] Allocating science buffer: ${pixelCount} pixels.`);
            this.scienceBuffer = new Float32Array(pixelCount);
        }
        const lum = this.scienceBuffer;
        // Parity-guarded reduction: a LibRaw CFA-mosaic "RGB" (each pixel one
        // dominant CFA colour) reduced by Rec.709 weights imprints a 2px
        // period-2 checkerboard on detection (0.72G vs 0.07B per site). Equal
        // channel weights recover the smooth per-site value. Gated OFF by
        // default (moves CR2 detections -> the blind matched count); genuine
        // RGB (FITS/JPEG) never sets cfaMosaicLuma so it always uses Rec.709.
        const equalWeight = CFA_LUMA_PARITY_FIX && !!cfaMosaicLuma;
        if (equalWeight) console.log('[Orchestrator] computeluminance: CFA-mosaic parity-guard ON (equal channel weights).');
        reduceToLuminance(rgb, equalWeight ? LUMA_EQUAL : LUMA_REC709, lum);
        let nanCount = 0;
        for (let i = 0; i < pixelCount; i++) if (isNaN(lum[i])) nanCount++;
        if (nanCount > 0) {
            console.error(`[Orchestrator] CRITICAL: computeluminance detected ${nanCount} NaNs in source RGB buffer (${((nanCount/pixelCount)*100).toFixed(2)}%).`);
        } else {
            console.log(`[Orchestrator] computeluminance: Clean buffer (${pixelCount} pixels).`);
        }
        return lum;
    }

    private generatePreviewFloat32(rgb: Float32Array, srcW: number, srcH: number, destW: number, destH: number): Float32Array {
        const destSize = destW * destH * 3;
        if (!this.previewFloat32 || this.previewFloat32.length !== destSize) {
            console.log(`[Orchestrator] Allocating preview buffer: ${destSize} units.`);
            this.previewFloat32 = new Float32Array(destSize);
        }
        const data = this.previewFloat32;
        const scaleX = srcW / destW;
        const scaleY = srcH / destH;
        for (let dy = 0; dy < destH; dy++) {
            for (let dx = 0; dx < destW; dx++) {
                const sx = Math.floor(dx * scaleX);
                const sy = Math.floor(dy * scaleY);
                const sIdx = (sy * srcW + sx) * 3;
                const dIdx = (dy * destW + dx) * 3;
                data[dIdx]   = rgb[sIdx];
                data[dIdx+1] = rgb[sIdx+1];
                data[dIdx+2] = rgb[sIdx+2];
            }
        }
        return data;
    }

    private float32ToImageData(float32: Float32Array, w: number, h: number): ImageData {
        return ImageProcessor.float32ToImageData(float32, w, h);
    }

    /** Convert a single-channel luminance Float32 buffer (w*h) to grayscale ImageData. */
    private luminanceToImageData(lum: Float32Array, w: number, h: number): ImageData {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            const v = Math.min(255, Math.pow(Math.max(0, lum[i] || 0), 1 / 2.2) * 255);
            const dIdx = i * 4;
            data[dIdx] = v;
            data[dIdx + 1] = v;
            data[dIdx + 2] = v;
            data[dIdx + 3] = 255;
        }
        // makeImageData: real ImageData in the browser (byte-identical);
        // structural stand-in in Node (I1.3 — this is the only ImageData
        // construction on the headless critical path, step4 solve buffer).
        return makeImageData(data, w, h);
    }

    private createPreviewUrl(data: ImageData): string {
        return ImageProcessor.createPreviewUrl(data);
    }

}
// force-recheck
