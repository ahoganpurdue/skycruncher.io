/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED STAGE HELPER: SOLVE-CONTEXT BUILDER (C1 orchestrator consolidation)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: COORDINATE (builds the solver's option contract — no pixel data).
 *
 * ONE implementation of two things that were previously duplicated (and had
 * silently diverged) between `orchestrator.ts` runPipeline and
 * `orchestrator_session.ts` OrchestratorSession.step4_Solve:
 *
 *   1. `resolveVerifyTuning` — the narrow-field verifyWCS relaxation math
 *      (fovDiag < 6 deg -> 4 anchor matches @ 0.5 achievable-match
 *      confidence). The FOV math and thresholds are shared; the CALLERS keep
 *      their own gates for now (the wizard applies it to any narrow field,
 *      the auto path additionally gates on isFits and logs) — gate
 *      unification is the solve-stage extraction, not this helper.
 *
 *   2. `buildSolveContext` — the canonical SolveContext shape (the session
 *      version is canonical, per docs/archive/CONSOLIDATION_DESIGN.md landmine #8):
 *      basePixelScale, scales, lensModel, focalLength, pixelPitchUm,
 *      trust-gated timestamp, observer, blindBudgetMs (default 90 000 ms —
 *      identical to the solver's own `?? 90_000` fallback), onBlindProgress,
 *      hints, config, logger. Callers may not invent extra keys.
 *
 * Pure functions only: no orchestrator state reach-back, no side effects.
 */

import type { SolveContext } from '../m6_plate_solve/solver_entry';
import type { SearchPriorModel } from '../m6_plate_solve/search_priors';
import type { DynamicPipelineConfig } from '../../diagnostics/telemetry_config';
import type { TelemetryLogger } from '../../diagnostics/telemetry_logger';

// ——— 1. NARROW-FIELD VERIFY TUNING ——————————————————————————————————————————

/** Field diagonal (deg) below which wide-field verify gates reject honest solves. */
export const NARROW_FIELD_FOV_DEG = 6;

export interface VerifyTuningResult {
    /** Field diagonal in degrees (dims x scale / 3600) — for caller logging. */
    fovDiagDeg: number;
    /**
     * Relaxed config when the field is narrow (< NARROW_FIELD_FOV_DEG):
     * 4 anchor matches @ 0.5 against ACHIEVABLE-match confidence (true ~2 deg
     * solves score ~63%, garbage ~9-15%; the old detections-based denominator
     * punished deep stacks). `undefined` on wide fields (keep caller default).
     */
    config?: DynamicPipelineConfig;
}

/**
 * Compute the narrow-field verifyWCS relaxation from image dimensions and
 * pixel scale. `widthPx`/`heightPx` must be in the SAME pixel space as
 * `scaleArcsecPx` (the wizard passes native dims x native scale; the auto
 * path passes its solve-buffer dims x solve scale — preserved behavior).
 */
export function resolveVerifyTuning(
    widthPx: number,
    heightPx: number,
    scaleArcsecPx: number,
    baseConfig: DynamicPipelineConfig
): VerifyTuningResult {
    const fovDiagDeg = (Math.hypot(widthPx, heightPx) * scaleArcsecPx) / 3600;
    if (fovDiagDeg < NARROW_FIELD_FOV_DEG) {
        return {
            fovDiagDeg,
            config: { ...baseConfig, verify_min_anchor_matches: 4, verify_min_confidence: 0.5 }
        };
    }
    return { fovDiagDeg };
}

// ——— 2. SOLVE-CONTEXT BUILDER ————————————————————————————————————————————————

export interface SolveContextParams {
    /**
     * Scale (arcsec/px) of the buffer BEING SOLVED. When the solve buffer is
     * binned relative to native, the caller must pre-multiply by
     * nativeW / solveW (Audit P4) — this builder does not know buffer shapes.
     */
    basePixelScale: number;
    /** ScaleManager frontend export (preview<->native mapping). */
    scales?: SolveContext['scales'];
    lensModel?: string;
    /** Effective focal length (mm) — wizard: OpticsManager.getEffectiveFocalLength. */
    focalLength?: number;
    /** Sensor pixel pitch (µm) — spherical chord scaling. */
    pixelPitchUm?: number;
    /**
     * Observation timestamp (ISO). MUST already be trust-gated by the caller:
     * an untrusted clock passes `undefined` so planetary anchors are never
     * placed from a camera-default date (poison, not help).
     */
    timestamp?: string;
    /** Observer site — spherical_global visibility gating; omit when GPS defaulted. */
    observer?: { lat: number; lon: number };
    /** Wall-clock cap for many-center blind sweeps. Default 90 000 ms (canonical). */
    blindBudgetMs?: number;
    /** Per-center narration for blind sweeps (Glass Pipeline socket). */
    onBlindProgress?: SolveContext['onBlindProgress'];
    /** RA/Dec hint (+ search radius). Absent = fully blind. `trusted` marks a
     *  GOTO/config pointing (not a zenith guess) — arms the A2 ultra-wide
     *  hint-seeded fine centers. */
    hints?: { ra_hours?: number; dec_degrees?: number; radius_deg?: number; trusted?: boolean };
    /** Solver config (e.g. narrow-field verify tuning). Absent = solver defaults. */
    config?: DynamicPipelineConfig;
    logger?: TelemetryLogger;
    /**
     * Explicit user lens hint for manual glass (NEXT_MOVES §8). Feeds the
     * lens-prior distortion resolver when the EXIF LensModel is a placeholder /
     * lying (e.g. the 14mm Rokinon gauntlet). Absent = EXIF ladder decides.
     */
    lensDistortionHint?: SolveContext['lensDistortionHint'];
    /**
     * SEARCH-ORDER PRIORS model (task #20 — lane ① search priors ONLY). Passed
     * straight through to SolveContext.searchPriors → the solver's reorder seam.
     * Absent/null = fully blind (identity, byte-identical). Only consumed when
     * PC.SOLVER_SEARCH_PRIORS is ON. Never a calibrated value, never a gate.
     */
    searchPriors?: SearchPriorModel | null;
    /**
     * Pre-RESOLVED lens-distortion prior (Optical-Workbench pooled prior —
     * SOLVER_WORKBENCH_PRIOR, default OFF). When set, autoSolvePlate uses it in
     * place of the EXIF/hint resolver ladder. Absent = resolver decides
     * (byte-identical to historical behavior).
     */
    lensDistortionResolution?: SolveContext['lensDistortionResolution'];
}

/**
 * Build the canonical SolveContext consumed by autoSolvePlate. ONE builder,
 * both pipelines — the option set can no longer fork.
 */
export function buildSolveContext(p: SolveContextParams): SolveContext {
    return {
        basePixelScale: p.basePixelScale,
        scales: p.scales,
        lensModel: p.lensModel,
        focalLength: p.focalLength,
        pixelPitchUm: p.pixelPitchUm,
        timestamp: p.timestamp,
        observer: p.observer,
        blindBudgetMs: p.blindBudgetMs ?? 90_000,
        onBlindProgress: p.onBlindProgress,
        hints: p.hints,
        config: p.config,
        logger: p.logger,
        lensDistortionHint: p.lensDistortionHint,
        searchPriors: p.searchPriors,
        lensDistortionResolution: p.lensDistortionResolution,
    };
}
