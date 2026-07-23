/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HINT RESOLVER — Effective Solver Hint Cascade (M6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure function extracted from the orchestrator's inline hint logic so the
 * priority order is testable in isolation:
 *
 *   1. config.hints        — explicit caller hints always win (existing semantics:
 *                            radius_deg may be absent and defaults downstream)
 *   2. FITS header RA/DEC  — GOTO-mount pointing solution (hard.ra_hint is
 *                            already in HOURS; the deg->hours division happens
 *                            in M1's fits_decoder)
 *   3. soft processing_hints — user's azimuth or approximate coordinates
 *   4. zenith fallback     — GPS + timestamp "straight up" guess
 *
 * The returned object is shape-compatible with the hint contract consumed by
 * solvePlate/autoSolvePlate ({ ra_hours, dec_degrees, radius_deg? }); `source`
 * is carried only for logging/telemetry.
 *
 * Alt/Az math is injected via `deps` to keep this module pure (no transitive
 * TimeService/WASM imports in unit tests).
 */

import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import type { HardMetadata, SoftMetadata } from '../../types/schema';

export type HintSource = 'CONFIG' | 'FITS_HEADER' | 'SOFT_COORD' | 'SOFT_AZIMUTH' | 'ZENITH';

export interface EffectiveHints {
    ra_hours: number;
    dec_degrees: number;
    /** Optional to preserve config.hints semantics (absent = solver-derived FOV radius). */
    radius_deg?: number;
    /** Which rung of the cascade produced the hint (logging only). */
    source: HintSource;
}

export interface HintResolverDeps {
    /** Alt/Az -> RA/Dec conversion (production: zenith.computeRaDecFromAltAz). */
    computeRaDecFromAltAz: (
        altitudeDeg: number,
        azimuthDeg: number,
        latDeg: number,
        lonDeg: number,
        timestamp: string
    ) => { ra: number; dec: number };
}

export function resolveEffectiveHints(
    configHints: { ra_hours: number; dec_degrees: number; radius_deg?: number } | undefined,
    hard: HardMetadata | null,
    soft: SoftMetadata,
    deps: HintResolverDeps
): EffectiveHints | undefined {
    // ── 1. Explicit config hints ─────────────────────────────────────────────
    if (configHints) {
        return { ...configHints, source: 'CONFIG' };
    }

    // ── 2. FITS header pointing solution (both coordinates required) ────────
    if (hard && hard.ra_hint != null && hard.dec_hint != null) {
        return {
            ra_hours: hard.ra_hint,
            dec_degrees: hard.dec_hint,
            radius_deg: PIPELINE_CONSTANTS.HINT_FITS_HEADER_RADIUS,
            source: 'FITS_HEADER'
        };
    }

    // ── 3. Soft processing hints (azimuth takes precedence — existing order) ─
    if (soft.processing_hints) {
        if (soft.processing_hints.azimuth !== undefined) {
            // Convert Azimuth to RA/Dec using assumed altitude (45 deg).
            // Requires a real observer location — absent GPS (null) can't be
            // resolved to a sky coordinate.
            const solved = (hard && hard.gps_lat != null && hard.gps_lon != null) ? deps.computeRaDecFromAltAz(
                PIPELINE_CONSTANTS.HINT_ASSUMED_ALTITUDE,
                soft.processing_hints.azimuth,
                hard.gps_lat,
                hard.gps_lon,
                hard.timestamp
            ) : null;
            if (solved) {
                console.log(`[Orchestrator] Resolved Azimuth Hint (${soft.processing_hints.azimuth} deg) to RA ${solved.ra.toFixed(2)}h / Dec ${solved.dec.toFixed(2)} deg`);
                return {
                    ra_hours: solved.ra,
                    dec_degrees: solved.dec,
                    radius_deg: PIPELINE_CONSTANTS.HINT_CARDINAL_RADIUS,
                    source: 'SOFT_AZIMUTH'
                };
            }
        } else if (soft.processing_hints.ra !== undefined && soft.processing_hints.dec !== undefined) {
            console.log(`[Orchestrator] Using Coordinate Hint: RA ${soft.processing_hints.ra.toFixed(2)}h / Dec ${soft.processing_hints.dec.toFixed(2)} deg`);
            return {
                ra_hours: soft.processing_hints.ra,
                dec_degrees: soft.processing_hints.dec,
                radius_deg: PIPELINE_CONSTANTS.HINT_COORDINATE_RADIUS,
                source: 'SOFT_COORD'
            };
        }
    }

    // ── 4. Smart Hint / Zenith fallback ──────────────────────────────────────
    // Needs a real observer location; absent GPS (null) yields no zenith guess.
    // (The wizard also gates ZENITH on gpsTrusted downstream, so DEFAULT-source
    // frames stay BLIND either way — this keeps the pinned solves byte-identical.)
    if (hard && hard.gps_lat != null && hard.gps_lon != null) {
        try {
            const z = deps.computeRaDecFromAltAz(90, 0, hard.gps_lat, hard.gps_lon, hard.timestamp);
            console.log(`[Orchestrator] Smart Hint (Zenith): RA ${z.ra.toFixed(2)}h / Dec ${z.dec.toFixed(2)} deg`);
            return {
                ra_hours: z.ra,
                dec_degrees: z.dec,
                radius_deg: PIPELINE_CONSTANTS.HINT_ZENITH_RADIUS,
                source: 'ZENITH'
            };
        } catch (e) {
            console.warn('[Orchestrator] Could not calculate Zenith hint:', e);
        }
    }

    return undefined;
}
