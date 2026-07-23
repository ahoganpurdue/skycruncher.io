/**
 * ═══════════════════════════════════════════════════════════════════════════
 * M11 STACK — stackSolvedFrames: the session-level stacking entry point
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL (see drizzle_stack.ts header). The multi-frame API surface a
 * UI or the batch lane calls once N solved frames exist:
 *
 *     stackSolvedFrames(frames, { params }) → { grid, plane, … , receipt }
 *
 * Stacking is inherently MULTI-frame while the wizard is single-frame, so
 * this API lives at the session/batch level — the wiring that reaches it from
 * the real pipeline surface is tools/batch/batch_engine.ts (flag-gated,
 * DEFAULT OFF via stack_flag.isStackingEnabled; lazy-imported so the OFF arm
 * never loads this module).
 *
 * Pipeline of this function (all MEASURED, nothing fabricated):
 *   1. validate inputs + params (explicit — no silent defaults here);
 *   2. correlated-input screening: exact-duplicate plane shas and
 *      near-simultaneous (≤60 s) captures are EXCLUDED from the combine and
 *      recorded (√N honesty — carried from tools/stack);
 *   3. reference = finest pixel scale (deterministic tie-break);
 *   4. dither offsets measured from the per-frame FITTED WCS (free from the
 *      solves — no separate registration estimator in v1);
 *   5. output tangent grid (explicit scaleFactor), Fruchter-Hook drizzle;
 *   6. `kind:'stack'` receipt (stack_receipt.ts).
 */

import {
    drizzleFrames,
    computeOutputGrid,
    measureDitherOffsets,
    pickReference,
    pixelScaleArcsec,
    type DrizzleParams,
    type DrizzleResult,
    type OutputGrid,
    type StackFrameInput,
    type DitherOffset,
} from './drizzle_stack';
import { buildStackReceipt, type StackExcludedRecord, type StackInputRecord } from './stack_receipt';
import type { WCSTransform } from '../../types/Main_types';

export interface StackOptions {
    /** Drizzle parameters — explicit; import DEFAULT_DRIZZLE_PARAMS to use the
     *  documented Fruchter-Hook defaults. */
    params: DrizzleParams;
    /** Optional per-frame source labels (file/receipt path) for the receipt. */
    sourceOf?: (id: string) => string | null;
}

export interface StackProduct {
    grid: OutputGrid;
    /** Combined luminance plane (NaN = out-of-footprint). */
    plane: Float32Array;
    weightMap: Float32Array;
    coverage: Uint8Array;
    coverageMax: number;
    offsets: DitherOffset[];
    excluded: StackExcludedRecord[];
    stackedIds: string[];
    referenceId: string;
    result: DrizzleResult;
    /** The `kind:'stack'` receipt (stack_receipt.ts). */
    receipt: Record<string, unknown>;
}

/**
 * Convert a solve receipt's `wcs` block back to the ENGINE convention the
 * stack kernel eats. UNIT TRAP (single conversion point, the exact inverse of
 * stages/package.ts generateReceiptWcs): receipt CRVAL1 is DEGREES → engine
 * crval[0] is HOURS (÷15); CRPIX are engine 0-based already (the receipt
 * documents "engine pixel convention"). REFUSES a SYNTHESIZED WCS — only a
 * star-fitted WCS may register a frame into a science stack (honest-or-absent).
 */
export function fittedWcsFromReceipt(receipt: any): WCSTransform {
    const w = receipt?.wcs;
    if (!w) throw new Error('[m11_stack] receipt has no WCS — an unsolved frame cannot be stacked.');
    if (w.SOURCE !== 'FITTED') {
        throw new Error(
            `[m11_stack] receipt.wcs.SOURCE is ${JSON.stringify(w.SOURCE)} — only a FITTED WCS ` +
            `registers a frame into a stack (a SYNTHESIZED approximation is refused).`
        );
    }
    const nums = [w.CRPIX1, w.CRPIX2, w.CRVAL1, w.CRVAL2, w.CD1_1, w.CD1_2, w.CD2_1, w.CD2_2];
    if (!nums.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))) {
        throw new Error('[m11_stack] receipt.wcs carries non-finite keywords — refused.');
    }
    return {
        crpix: [w.CRPIX1, w.CRPIX2],
        crval: [w.CRVAL1 / 15, w.CRVAL2], // FITS degrees → engine HOURS
        cd: [[w.CD1_1, w.CD1_2], [w.CD2_1, w.CD2_2]],
    };
}

/** Parse an ISO timestamp to epoch ms, or null. */
function epochOf(ts: string | null): number | null {
    if (!ts) return null;
    const t = Date.parse(ts);
    return Number.isFinite(t) ? t : null;
}

/**
 * Correlated-input screening (√N honesty, ported policy from tools/stack):
 *  • identical frameSha → EXACT_DUPLICATE (keep the first, exclude the rest);
 *  • captures within 60 s of a kept frame → SUSPECTED_CORRELATED (a live-stack
 *    export vs a restack of the same lights cannot be independent photons).
 * Returns kept frames + honest exclusion records.
 */
export function screenCorrelatedInputs(
    frames: StackFrameInput[]
): { kept: StackFrameInput[]; excluded: StackExcludedRecord[] } {
    const kept: StackFrameInput[] = [];
    const excluded: StackExcludedRecord[] = [];
    const seenSha = new Map<string, string>();
    for (const f of frames) {
        if (f.frameSha && seenSha.has(f.frameSha)) {
            excluded.push({ id: f.id, reason: `EXACT_DUPLICATE of ${seenSha.get(f.frameSha)} (sha ${f.frameSha.slice(0, 10)})` });
            continue;
        }
        const tF = epochOf(f.timestamp);
        const near = tF !== null
            ? kept.find((k) => {
                const tK = epochOf(k.timestamp);
                return tK !== null && Math.abs(tK - tF) <= 60_000;
            })
            : undefined;
        if (near) {
            excluded.push({ id: f.id, reason: `SUSPECTED_CORRELATED: capture within 60s of ${near.id} — almost certainly the same lights` });
            continue;
        }
        if (f.frameSha) seenSha.set(f.frameSha, f.id);
        kept.push(f);
    }
    return { kept, excluded };
}

/**
 * Stack N solved frames into one drizzled product. Throws (never a silent
 * partial product) on: <2 stackable frames, bad params, plane/dim mismatch,
 * grid over the MP guard.
 */
export async function stackSolvedFrames(
    frames: StackFrameInput[],
    opts: StackOptions
): Promise<StackProduct> {
    const { params } = opts;
    if (!(params.scaleFactor > 0.25 && params.scaleFactor <= 4)) {
        throw new Error(`[m11_stack] scaleFactor ${params.scaleFactor} out of the sane (0.25, 4] range.`);
    }
    if (!(params.pixfrac > 0 && params.pixfrac <= 1)) {
        throw new Error(`[m11_stack] pixfrac ${params.pixfrac} out of (0, 1].`);
    }
    if (frames.length < 2) {
        throw new Error(`[m11_stack] stacking needs >=2 solved frames (got ${frames.length}).`);
    }

    const { kept, excluded } = screenCorrelatedInputs(frames);
    if (kept.length < 2) {
        throw new Error(
            `[m11_stack] only ${kept.length} independent frame(s) after correlated-input screening ` +
            `(${excluded.length} excluded) — refusing a fake-independence stack.`
        );
    }

    const ref = pickReference(kept);
    const offsets = measureDitherOffsets(kept, ref);
    const grid = computeOutputGrid(kept, ref, params);
    const result = await drizzleFrames(kept, grid, params);

    let coverageMax = 0;
    for (let i = 0; i < result.coverage.length; i++) {
        if (result.coverage[i] > coverageMax) coverageMax = result.coverage[i];
    }

    const inputs: StackInputRecord[] = kept.map((f) => ({
        id: f.id,
        frame_sha: f.frameSha,
        source: opts.sourceOf?.(f.id) ?? null,
        wcs_provenance: 'FITTED',
        scale_arcsec: pixelScaleArcsec(f.wcs),
        width: f.width,
        height: f.height,
        timestamp: f.timestamp,
        exposure_s: f.exposureS,
    }));

    const receipt = buildStackReceipt({
        inputs,
        excluded,
        referenceId: ref.id,
        params,
        grid,
        offsets,
        deposits: result.perFrame,
        coverageMax,
    });

    return {
        grid,
        plane: result.plane,
        weightMap: result.weightMap,
        coverage: result.coverage,
        coverageMax,
        offsets,
        excluded,
        stackedIds: kept.map((f) => f.id),
        referenceId: ref.id,
        result,
        receipt,
    };
}
