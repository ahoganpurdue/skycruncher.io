/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED STAGE: SOLVE — hint resolution + solve entry (C1 consolidation)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: COORDINATE (hints, WCS, solver options — pixel buffers pass through
 * untouched to the solver).
 *
 * Two responsibilities:
 *
 *   1. `resolveWizardHints` — the wizard's adoption of the shared hint
 *      resolver ladder (docs/archive/CONSOLIDATION_DESIGN.md divergence #1, the B3 gap):
 *      FITS-header pointing -> zenith fallback -> blind. Gates the zenith
 *      rung on a REAL observer site (EXIF/FITS GPS) AND a trusted clock —
 *      a zenith hint computed from defaulted GPS or an unset camera clock
 *      points at the wrong hemisphere and would exclude the true center
 *      from a radius-limited search. When no rung fires, the session's
 *      historical blind path ({ radius_deg: 180 }) is preserved VERBATIM.
 *      The resolver's wide rungs (zenith 90 deg) respect
 *      SECTOR_LOAD_MAX_RADIUS_DEG solver-side (the B4 gate in solvePlate
 *      skips deep-sector paging above the cap).
 *
 *   2. `runSolve` — the single entry point wrapping autoSolvePlate: context
 *      built by the shared builder (stages/solve_context), pre-detected
 *      stars forwarded on the ONE `existingStars` parameter (landmine #3).
 *      Verification (verifyWCS) lives inside the solver and is tuned via
 *      the shared resolveVerifyTuning helper.
 *
 * NOTE (contract correction vs design doc): `focusPlanets` is NOT part of
 * the solveContext contract — no orchestrator passes it. Planetary anchors
 * are injected inside solvePlate from the trust-gated timestamp + observer.
 */

import { autoSolvePlate } from '../m6_plate_solve/solver_entry';
import { isGreenfieldSolverEnabled, solveViaGreenfield } from './greenfield_seam';
import { isTauriRuntime } from '../../../desktop/updater';
import { resolveEffectiveHints } from '../m6_plate_solve/hint_resolver';
import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import { computeRaDecFromAltAz } from '../m5_coordinate_flatten/zenith';
import { buildSolveContext, type SolveContextParams } from './solve_context';
import type { DetectedStar, SolveResult } from '../../types/Main_types';
import type { HardMetadata, SoftMetadata } from '../../types/schema';
import type { PipelineEventBus } from '../../events/pipeline_events';

// ——— 1. WIZARD HINT RESOLUTION (divergence #1 adoption) —————————————————————

/**
 * Explicit user target hint from the upload surface (TargetHintInput →
 * MainUpload → MainApp → the session). RA is in HOURS, Dec in DEGREES — the
 * catalog/hint convention. The UI's azimuth-mode sentinel (`ra === -1`, with
 * `dec` carrying azimuth degrees) is NOT a sky coordinate and is deliberately
 * NOT forwarded as one — resolving azimuth needs the soft-azimuth rung (a real
 * observer site + trusted clock), tracked as a separate follow-up.
 */
export interface CallerTargetHint {
    /** RA in HOURS (catalog/hint convention). `-1` is the UI azimuth-mode sentinel. */
    ra: number;
    /** Dec in DEGREES. */
    dec: number;
    /** Display label (logging/telemetry only). */
    label?: string;
}

export interface WizardHintResolution {
    /** Solver-shaped hints — EXACTLY the historical session shape at runtime. */
    hints: { ra_hours?: number; dec_degrees?: number; radius_deg: number; trusted?: boolean };
    /** Which rung produced the hint (status copy / telemetry). */
    source: 'CONFIG' | 'FITS_HEADER' | 'ZENITH' | 'BLIND';
}

/**
 * Resolve solver hints for the wizard path via the shared resolver ladder.
 *
 * When the user supplied an explicit target hint on upload it enters the
 * resolver's CONFIG rung ("explicit caller hints always win"). It is a search
 * PRIOR only — never a calibrated value, never written to LENS_DB. Absent a
 * caller hint (the DEFAULT path, taken by EVERY pinned reference solve),
 * `configHints` stays `undefined`, so the resolver output is byte-identical to
 * the historical FITS-header → zenith → blind ladder (same null checks, same
 * HINT_FITS_HEADER_RADIUS).
 */
export function resolveWizardHints(
    metadata: HardMetadata | null,
    gpsTrusted: boolean,
    timestampTrusted: boolean,
    callerHint?: CallerTargetHint | null
): WizardHintResolution {
    // A real, finite RA/Dec target hint enters the CONFIG rung. The azimuth-mode
    // sentinel (ra === -1) is NOT a coordinate — guarded out so it can never be
    // forwarded as a literal RA of -1h (which would poison the search center).
    const configHints =
        callerHint &&
        callerHint.ra !== -1 &&
        Number.isFinite(callerHint.ra) &&
        Number.isFinite(callerHint.dec)
            ? { ra_hours: callerHint.ra, dec_degrees: callerHint.dec }
            : undefined;

    const resolved = resolveEffectiveHints(
        configHints,
        metadata,
        {} as SoftMetadata,
        { computeRaDecFromAltAz }
    );

    if (resolved?.source === 'CONFIG') {
        return {
            hints: {
                ra_hours: resolved.ra_hours,
                dec_degrees: resolved.dec_degrees,
                // config.hints carry no radius of their own; a user coordinate
                // hint takes the shared coordinate-hint radius (as SOFT_COORD does).
                radius_deg: resolved.radius_deg ?? PIPELINE_CONSTANTS.HINT_COORDINATE_RADIUS,
                // An explicit user pointing is TRUSTED (like a FITS GOTO) — arms
                // the ultra-wide hint-seeded fine centers (A2). Still a search
                // prior, not a measurement.
                trusted: true
            },
            source: 'CONFIG'
        };
    }

    if (resolved?.source === 'FITS_HEADER') {
        return {
            hints: {
                ra_hours: resolved.ra_hours,
                dec_degrees: resolved.dec_degrees,
                radius_deg: resolved.radius_deg!,
                // A2: a FITS-header GOTO is a TRUSTED pointing (not a guess) —
                // arms the ultra-wide hint-seeded fine centers. Zenith/blind stay
                // untrusted. (SeeStar is FITS-trusted but FOV-gated out of A2.)
                trusted: true
            },
            source: 'FITS_HEADER'
        };
    }

    if (resolved?.source === 'ZENITH' && gpsTrusted && timestampTrusted) {
        return {
            hints: {
                ra_hours: resolved.ra_hours,
                dec_degrees: resolved.dec_degrees,
                radius_deg: resolved.radius_deg!
            },
            source: 'ZENITH'
        };
    }

    // The session's blind path, preserved verbatim.
    return { hints: { radius_deg: 180 }, source: 'BLIND' };
}

// ——— 2. SOLVE ENTRY ——————————————————————————————————————————————————————————

/**
 * Solve-runtime BRANCH nodes for the flowchart. `solvePlate` collapses three
 * runtimes into one call — the WASM quad matcher (narrow/normal fields), the
 * ultra-wide TS anchored sweep, and the TS deep-verify escalation rung. These
 * are the stable per-branch stage ids the flowchart boxes separately; on any
 * solved run EXACTLY ONE fires (the runtime that produced the lock).
 */
const SOLVE_BRANCH_LABELS: Record<string, string> = {
    'solve.quad_wasm': 'Solve · WASM Quad Matcher',
    'solve.uw_sweep': 'Solve · Ultra-Wide Anchored Sweep',
    'solve.uw_escalation': 'Solve · Deep-Verify Escalation',
};

/**
 * Emit the solve BRANCH events, one per ATTEMPTED branch (LAW: events emit inside
 * stages, not orchestrators — this runs in the solve STAGE). The branch is read
 * back from the solver's own forensics (`SUCCESS_UW_SWEEP` / `SUCCESS_UW_ESCALATED`,
 * else quad) — a pure READ of the returned diagnostics, so the solver internals
 * (and the pinned solve numbers) are untouched. A3: emit ONE envelope per branch
 * actually ATTEMPTED (from `diagnostics.branch_timing` — accrued wall-ms + attempts
 * per branch, INCLUDING losers). The WINNER (forensics `SUCCESS_UW_*` / quad) is
 * ok=true/PASS with its OWN branch ms; an attempted-but-lost branch is ok=false/FAIL
 * with its REAL accumulated ms (no longer winner-only NOT MEASURED); a branch never
 * attempted emits nothing (honest NOT MEASURED). Winner falls back to the whole-solve
 * time only if it accrued no sample.
 * Fully non-fatal.
 */
export function emitSolveBranch(events: PipelineEventBus, result: SolveResult): void {
    try {
        const d = result.diagnostics;
        const forensics: Array<{ status?: unknown }> = Array.isArray(d?.forensics) ? d.forensics : [];
        const statuses = forensics.map(f => String(f?.status ?? ''));

        // Which branch produced the winning lock (the one painted PASS).
        let winner: string | null = null;
        if (statuses.includes('SUCCESS_UW_ESCALATED')) winner = 'solve.uw_escalation';
        else if (statuses.includes('SUCCESS_UW_SWEEP')) winner = 'solve.uw_sweep';
        else if (result.success && result.solution) winner = 'solve.quad_wasm';

        const timing = (d?.branch_timing ?? {}) as Record<string, { ms: number; attempts: number }>;
        const matched = result.solution?.matched_stars?.length ?? d?.matches_found ?? 0;

        // One envelope per branch ACTUALLY ATTEMPTED (accrued a sample), plus the
        // winner as a floor. Canonical order → deterministic output.
        const attempted = new Set<string>(Object.keys(timing));
        if (winner) attempted.add(winner);
        const CANON = ['solve.quad_wasm', 'solve.uw_sweep', 'solve.uw_escalation'];
        const ordered = [
            ...CANON.filter(b => attempted.has(b)),
            ...[...attempted].filter(b => !CANON.includes(b)),
        ];

        for (const branch of ordered) {
            const t = timing[branch];
            const isWinner = branch === winner;
            // Branch's OWN accumulated ms; the winner falls back to the whole-solve
            // time only if — unexpectedly — it accrued no sample. Losers carry their
            // real attempt time (no longer winner-only NOT MEASURED).
            const ms = t && Number.isFinite(t.ms)
                ? t.ms
                : (isWinner && Number.isFinite(d?.solve_time_ms) ? d.solve_time_ms : 0);
            const counts: Record<string, number> = {};
            if (t) counts.attempts = t.attempts;
            if (isWinner) counts.matched = matched;
            events.emit({ kind: 'stage_started', stage: branch, label: SOLVE_BRANCH_LABELS[branch] ?? branch });
            events.emit({
                kind: 'stage_finished', stage: branch, ok: isWinner, ms,
                verdict: isWinner ? 'PASS' : 'FAIL', counts,
                payloadRef: isWinner ? 'solution' : null,
            });
        }
    } catch {
        // Instrumentation must never break the solve.
    }
}

/**
 * The ONE solver entry for both pipelines: builds the canonical context and
 * invokes the smart facade. `existingStars` is the shared curated-detection
 * forwarding parameter (landmine #3) — absent means the solver re-extracts.
 * `events` (optional) receives the per-branch flowchart node event (additive).
 */
export async function runSolve(
    imageData: ImageData,
    params: SolveContextParams,
    existingStars?: DetectedStar[],
    events?: PipelineEventBus,
): Promise<SolveResult> {
    // Flag-gated desktop seam: when VITE_SOLVER_GREENFIELD=1 AND running under Tauri,
    // the native greenfield solver (solve_greenfield command) replaces the legacy solve.
    // Default OFF and the browser ALWAYS take the legacy call below — EXACTLY as today,
    // so the pinned reference solves (seestar / cr2 e2e) ride on it untouched.
    let result: SolveResult;
    if (isGreenfieldSolverEnabled() && isTauriRuntime()) {
        // Two-flow scale hint (VITE_SOLVER_SCALE_HINT, DEFAULT OFF). The trust context
        // (focal/pitch/lens) travels in `params`; the seam gates on it + the flag, so
        // flag-off or an untrusted/absent prior sends no window ⇒ byte-identical.
        result = await solveViaGreenfield(imageData, existingStars, params.blindBudgetMs, {
            solveScaleArcsecPx: params.basePixelScale,
            focalLengthMm: params.focalLength,
            pixelPitchUm: params.pixelPitchUm,
            lensModel: params.lensModel,
        });
    } else {
        result = await autoSolvePlate(imageData, buildSolveContext(params), existingStars);
    }
    if (events) emitSolveBranch(events, result);
    return result;
}
