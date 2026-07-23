/**
 * no_solve_receipt.test.ts — task #16 (graceful no-solve failure receipt).
 *
 * Pins the honest FAILURE receipt that a NO-SOLVE headless run banks instead of
 * throwing at the step5 calibrate guard. buildFailureReceipt is a PURE function
 * (no wasm / no session), so these run scoped + fast. The properties asserted:
 *
 *   1. DISCRIMINATOR — `kind:'no_solve'` + `solution:null`, so the batch engine
 *      (`solutionOf` → null → verdict 'no_solve') and run.mjs (`solution != null`
 *      → exit 2) read it as a no-solve, never a fabricated success.
 *   2. MEASURED DATA carried — detection + culling COUNTS (culling_stats), the
 *      solve ladder's own diagnostics incl. branch_timing (quad/uw_sweep/
 *      uw_escalation attempts), per-stage timings, frame sha, ingest metadata.
 *   3. HONEST-OR-ABSENT (LAW 3) — every block a solved receipt would carry
 *      (wcs/psf/spcc/hardware/…) is explicit null; nothing is fabricated; a
 *      null signal / null diagnostics yields null blocks (never zero-filled), and
 *      the builder NEVER throws on absent inputs.
 *   4. JSON round-trips through the canonical serializer (the batch/run.mjs
 *      consumers read it back from disk).
 */
import { describe, it, expect } from 'vitest';
import { buildFailureReceipt, type FailureReceiptInputs } from '../pipeline/stages/package';
import { RECEIPT_SCHEMA_VERSION } from '../pipeline/stages/schema_versions';
import { serializeReceipt } from '../pipeline/stages/receipt_serializer';
import type { SignalPacket, SolveDiagnostics } from '../types/Main_types';

/** A structurally-valid signal packet with N clean stars + M anomalies. */
function makeSignal(nClean: number, nAnom: number, nPlanet: number): SignalPacket {
    return {
        clean_stars: Array.from({ length: nClean }, (_, i) => ({ x: i, y: i })),
        anomalies: Array.from({ length: nAnom }, (_, i) => ({ x: i, y: i })),
        planet_candidates: Array.from({ length: nPlanet }, (_, i) => ({ x: i, y: i })),
        culling_tally: { SATURATED: 3, EDGE: 2 } as SignalPacket['culling_tally'],
        background_level: 512.5,
        noise_floor: 7.25,
    } as unknown as SignalPacket;
}

/** A full solve-ladder diagnostics object (all three branch keys attempted). */
function makeDiagnostics(): SolveDiagnostics {
    return {
        solve_time_ms: 12345,
        quads_detected: 40,
        quads_catalog: 900,
        matches_found: 3,
        verified_clusters: 0,
        peak_background_ratio: 4.2,
        rejection_reasons: ['scale never locked', 'centers exhausted'],
        reflection_detected: false,
        center_lock_verified: false,
        branch_timing: {
            'solve.quad_wasm': { ms: 4000, attempts: 12 },
            'solve.uw_sweep': { ms: 8000, attempts: 155 },
            'solve.uw_escalation': { ms: 1200, attempts: 3 },
        },
    };
}

function makeInputs(over: Partial<FailureReceiptInputs> = {}): FailureReceiptInputs {
    return {
        metadata: { camera_model: 'Canon EOS 60Da', source_provenance: null } as any,
        signal: makeSignal(21, 4, 1),
        solveDiagnostics: makeDiagnostics(),
        stageTimings: {
            v: 1, run_id: 'session_1', frame_sha: 'abc', source_format: 'CR2',
            decoder_arm: 'rawler', ok: false, n_stages: 4, total_ms: 190000,
            stages: { load: 5, extract: 5060, metrology: 1, solve: 125830 },
        },
        stageReached: 'solve',
        stageOfDeath: 'solve',
        failReason: 'Plate solve failed - no geometric lock. (centers exhausted)',
        frameSha256: 'a'.repeat(64),
        sourceFormat: 'CR2',
        warnings: ['catalog sector 12 slow'],
        timestampTrusted: false,
        decoderArm: 'rawler',
        imageWidth: 5202,
        imageHeight: 3464,
        ...over,
    };
}

describe('buildFailureReceipt (task #16 — graceful no-solve receipt)', () => {
    it('is discriminated as a no-solve: kind + null solution + schema version', () => {
        const r = buildFailureReceipt(makeInputs());
        expect(r.kind).toBe('no_solve');
        expect(r.solution).toBeNull();
        expect(r.version).toBe(RECEIPT_SCHEMA_VERSION);
    });

    it('carries the stage-of-death + honest fail reason', () => {
        const r = buildFailureReceipt(makeInputs());
        expect(r.failure.stage_reached).toBe('solve');
        expect(r.failure.stage_of_death).toBe('solve');
        expect(r.failure.reason).toMatch(/no geometric lock/);
        // error is null on a clean no-lock (only set when a stage THREW).
        expect(r.failure.error).toBeNull();
    });

    it('carries frame sha + ingest metadata + source format + dims', () => {
        const r = buildFailureReceipt(makeInputs());
        expect(r.frame_sha256).toBe('a'.repeat(64));
        expect(r.metadata.camera_model).toBe('Canon EOS 60Da');
        expect(r.source_format).toBe('CR2');
        expect(r.image_width).toBe(5202);
        expect(r.image_height).toBe(3464);
    });

    it('reduces the signal packet to detection + culling COUNTS (not typed arrays)', () => {
        const r = buildFailureReceipt(makeInputs());
        expect(r.detection).toEqual({
            clean_stars: 21,
            anomalies: 4,
            planet_candidates: 1,
            culling_tally: { SATURATED: 3, EDGE: 2 },
            background_level: 512.5,
            noise_floor: 7.25,
        });
    });

    it('carries what the solve ladder ATTEMPTED incl. branch_timing (quad/uw_sweep/escalation)', () => {
        const r = buildFailureReceipt(makeInputs());
        expect(r.solve_attempts.quads_detected).toBe(40);
        expect(r.solve_attempts.matches_found).toBe(3);
        expect(r.solve_attempts.rejection_reasons).toEqual(['scale never locked', 'centers exhausted']);
        expect(r.solve_attempts.branch_timing['solve.uw_sweep']).toEqual({ ms: 8000, attempts: 155 });
        expect(r.solve_attempts.branch_timing['solve.uw_escalation'].attempts).toBe(3);
    });

    it('carries per-stage timings + pipeline provenance (decoder arm)', () => {
        const r = buildFailureReceipt(makeInputs());
        expect(r.stage_timings.stages.solve).toBe(125830);
        expect(r.stage_timings.ok).toBe(false);
        expect(r.pipeline_provenance.decoder_arm).toBe('rawler');
    });

    it('honest-or-absent: every solved-receipt block is explicit null (LAW 3)', () => {
        const r = buildFailureReceipt(makeInputs());
        for (const key of [
            'wcs', 'spcc', 'psf_field', 'psf_attribution', 'lens_distortion_measured',
            'optics_hints', 'deep_confirmed', 'confirm_status', 'solve_provenance',
            'user_annotations', 'hardware', 'forensics',
            // [schema 2.14.0] rawler_calibration is null here (this frame's metadata
            // carries none); user_target_hint + nebulosity_layer are always null on
            // the no-solve product (no successful assisted solve / no producer).
            'rawler_calibration', 'user_target_hint', 'nebulosity_layer',
        ]) {
            expect(r[key], `${key} must be null`).toBeNull();
        }
        expect(r.planets).toEqual([]);
        expect(typeof r.export_date).toBe('string');
    });

    it('does NOT throw and emits null blocks when signal + diagnostics are absent', () => {
        const r = buildFailureReceipt(makeInputs({ signal: null, solveDiagnostics: null, metadata: null }));
        expect(r.detection).toBeNull();          // null-on-absence, never zero-filled
        expect(r.solve_attempts).toBeNull();
        expect(r.metadata).toBeNull();
        expect(r.source_provenance).toBeNull();
        expect(r.solution).toBeNull();
        expect(r.kind).toBe('no_solve');
    });

    it('sets failure.error ONLY when a stage threw (errorMessage supplied)', () => {
        const r = buildFailureReceipt(makeInputs({ errorMessage: 'No pixel buffer available for Plate Solving.' }));
        expect(r.failure.error).toBe('No pixel buffer available for Plate Solving.');
    });

    it('round-trips through the canonical serializer with solution still null', () => {
        // The batch engine / run.mjs read the receipt back from disk; solution===null
        // must survive so their no-solve verdict/exit is reached.
        const parsed = JSON.parse(serializeReceipt(buildFailureReceipt(makeInputs())));
        expect(parsed.kind).toBe('no_solve');
        expect(parsed.solution).toBeNull();
        expect(parsed.detection.clean_stars).toBe(21);
        expect(parsed.solve_attempts.branch_timing['solve.uw_sweep'].attempts).toBe(155);
    });
});
