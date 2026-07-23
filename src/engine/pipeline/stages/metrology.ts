/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED STAGE: METROLOGY — scale lock via trust ladder (C1 consolidation)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: COORDINATE (produces arcsec/px scale + ephemeris guest list; never
 * touches pixel buffers beyond the Tri-Lock's read-only vanguard stars).
 *
 * The trust ladder (session ordering is canonical — docs/archive/CONSOLIDATION_DESIGN.md
 * landmine #9):
 *
 *   1. FITS_HEADER  — metadata.pixel_scale > 0 (header optics: XPIXSZ/FOCALLEN)
 *   2. EXIF_OPTICS  — resolveOpticsFromExif: EXIF focal length (through
 *                     OpticsManager.getEffectiveFocalLength, which owns the
 *                     'Unknown Lens' truthy-trap handling) x SENSOR_DB pitch
 *                     (most-specific findSensorByCamera match)
 *   3. TRIANGULATED — MetrologyService.solveScale blind Tri-Lock (last resort)
 *
 * NOTE (partial convergence — NEXT_MOVES §4): runPipeline's "Agnostic
 * Metrology" (Vector Consensus blind solve + geometric drift + vignette
 * derivation) is still a physics refiner unique to the auto path and is NOT
 * this ladder. But its SCALE DERIVATION now adopts the same effective-FL rung
 * this ladder uses (OpticsManager.getEffectiveFocalLength), fixing the
 * auto-path nominal-50mm CR2 mislock (was 17.7"/px, now the correct ~63.35 —
 * guarded by tools/e2e/run_auto_cr2.mjs). The Vector Consensus refiner itself
 * stays in orchestrator.ts until its own consolidation decision.
 *
 * Status strings are load-bearing UI contract — they are produced HERE and
 * delivered via the injected onStatus callback so the copy cannot fork.
 */

import { MetrologyService } from '../m7_astrometry/metrology';
import { OpticsManager } from '../../core/optics_manager';
import type { OpticsHint } from '../../core/optics_hint_provider';
import { resolveOpticsFromExif } from '../m2_hardware/optics_resolver';
import type { PipelineEventBus } from '../../events/pipeline_events';
import type { HardMetadata, SignalPoint, SolarBody } from '../../types/Main_types';

export type ScaleSource = 'FITS_HEADER' | 'EXIF_OPTICS' | 'TRIANGULATED';

export interface ScaleLockOutcome {
    /** Locked scale in arcsec/px (null when even the Tri-Lock failed). */
    scaleLock: number | null;
    /** Which rung of the trust ladder produced the lock. */
    source: ScaleSource;
    /**
     * Labelled focal-length ASSUMPTIONS that seeded the FL used for this lock
     * (empty on the FITS_HEADER rung, which never consults a focal length).
     * These ride out to the receipt (`optics_hints`) so the assumption is
     * receipt-visible instead of silent. NEVER a measurement (each is assumed:true).
     */
    opticsHints: OpticsHint[];
}

/** Emit each labelled optics assumption as a finding INSIDE the stage (never the orchestrator). */
function emitOpticsHints(hints: OpticsHint[], events?: Pick<PipelineEventBus, 'emit'>): void {
    if (!events) return;
    for (const h of hints) {
        events.emit({
            kind: 'finding',
            finding: {
                kind: 'optics_hint',
                source: h.source,
                valueMm: h.value_mm,
                assumed: h.assumed,
                reason: h.reason,
            },
        });
    }
}

/**
 * Resolve the true pixel scale, in trust order:
 * header optics (FITS) -> EXIF optics + sensor DB (DSLR) -> blind Tri-Lock.
 *
 * MUTATES `metadata` on the EXIF_OPTICS rung (persists pixel_scale and
 * pixel_pitch_um so downstream stages see a scale instead of a blind
 * default) — identical to the historical session behavior.
 */
export async function resolveScaleLock(
    metadata: HardMetadata | null,
    cleanStars: SignalPoint[],
    onStatus?: (status: string) => void,
    events?: Pick<PipelineEventBus, 'emit'>
): Promise<ScaleLockOutcome> {
    // [B2] EXIF-derived scale: geometry from EXIF focal length + sensor-DB
    // pitch replaces the ~15s blind Tri-Lock. EXIF FL is nominal, so this
    // seeds the solver without the FITS-header trust status.
    const exifOptics = (metadata && !(metadata.pixel_scale && metadata.pixel_scale > 0))
        ? resolveOpticsFromExif(metadata)
        : null;

    if (metadata?.pixel_scale && metadata.pixel_scale > 0) {
        // FITS header optics — no focal-length path consulted, so no assumption.
        onStatus?.(`Scale locked from header optics (${metadata.pixel_scale.toFixed(2)}"/px)`);
        return { scaleLock: metadata.pixel_scale, source: 'FITS_HEADER', opticsHints: [] };
    }

    if (exifOptics) {
        metadata!.pixel_scale = exifOptics.pixel_scale;
        metadata!.pixel_pitch_um = exifOptics.pixel_pitch_um;
        onStatus?.(`Scale locked from EXIF optics (${exifOptics.pixel_scale.toFixed(2)}"/px)`);
        // The FL used here may be a labelled assumption (wide-field prior) — record it.
        const opticsHints = exifOptics.hint ? [exifOptics.hint] : [];
        emitOpticsHints(opticsHints, events);
        return { scaleLock: exifOptics.pixel_scale, source: 'EXIF_OPTICS', opticsHints };
    }

    onStatus?.("Triangulating scale (Tri-Lock)...");
    const vanguard = cleanStars.slice(0, 10);
    // Hint-aware resolve so the Tri-Lock's seed FL is byte-identical while any
    // labelled assumption behind it is captured for the receipt.
    const fl = OpticsManager.resolveFocalLengthWithHint(metadata);
    const scaleLock = await MetrologyService.solveScale(
        vanguard,
        fl.value_mm,
        metadata?.pixel_pitch_um
    );
    const opticsHints = fl.hint ? [fl.hint] : [];
    emitOpticsHints(opticsHints, events);
    return { scaleLock, source: 'TRIANGULATED', opticsHints };
}

/**
 * Ephemeris guest list (planets/moons/satellites), gated on BOTH a trusted
 * clock and a real observer site (landmine #7): a camera-default timestamp
 * computes a guest list for the wrong sky — worse than none.
 */
export async function resolveGuestList(
    timestamp: Date,
    timestampTrusted: boolean,
    location: { lat: number; lon: number } | null
): Promise<SolarBody[]> {
    if (location && timestampTrusted) {
        return MetrologyService.getGuestList(timestamp, location.lat, location.lon);
    }
    if (location && !timestampTrusted) {
        console.warn('[Session] Ephemeris guest list skipped: capture timestamp untrusted.');
    }
    return [];
}
