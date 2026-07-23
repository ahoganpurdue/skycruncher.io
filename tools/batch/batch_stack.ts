/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BATCH STACK STEP — the flag-gated dither/drizzle wiring (Node side)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * LAZY-IMPORTED by tools/batch/batch_engine.ts ONLY when
 * `isStackingEnabled()` (VITE_STACK_ENABLED, DEFAULT OFF) — the OFF arm never
 * loads this module, so the batch lane is byte-identical by construction when
 * the flag is off (see m11_stack/stack_flag.ts INERTNESS CONTRACT).
 *
 * Two halves:
 *   • captureFrame — right after a SOLVED verdict, spill the session's
 *     luminance science plane (getExportImage, the same measured frame the
 *     ASDF export ships) to a scratch .f32 file + record the fitted WCS from
 *     the receipt. Spill-to-disk keeps the batch memory envelope flat (a
 *     5202×3465 plane is 72 MB — eleven of them do NOT live in RAM).
 *   • runStackStep — after the batch loop, feed the spilled frames to the
 *     engine's stackSolvedFrames (src/engine/pipeline/m11_stack) and write
 *     the products: stack FITS (via the proven tools/stack/fits_io.mjs
 *     writer — its wcsCards eats the ENGINE-hours grid WCS and does the ×15
 *     itself, see the DE-DUPE SEAM note there) + the `kind:'stack'` receipt.
 *
 * NEVER-FATAL at the batch seam: the caller wraps both halves; a stacking
 * failure becomes an honest `{status:'error'}` ledger block, never a failed
 * batch (workbench_deposit precedent).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
    stackSolvedFrames,
    fittedWcsFromReceipt,
} from '@/engine/pipeline/m11_stack/stack_frames';
import {
    DEFAULT_DRIZZLE_PARAMS,
    type DrizzleParams,
    type StackFrameInput,
} from '@/engine/pipeline/m11_stack/drizzle_stack';
import { writeFitsPlanar, wcsCards } from '../stack/fits_io.mjs';

// ── capture ───────────────────────────────────────────────────────────────────

export interface CapturedFrame {
    id: string;
    file: string;
    planePath: string;
    planeSha256: string;
    width: number;
    height: number;
    /** receipt.wcs (FITS-degree keywords, SOURCE:'FITTED') — converted at stack time. */
    receiptWcs: any;
    timestamp: string | null;
    exposureS: number | null;
}

/** Minimal structural session surface (avoids importing OrchestratorSession —
 *  mocks in the hermetic tests supply exactly this). */
export interface StackCaptureSession {
    getExportImage(): { data: Float32Array; width: number; height: number; channels: 1 } | null;
}

/**
 * Spill one solved frame's luminance plane + WCS provenance to scratch.
 * Returns the capture record, or null with a reason when the frame is not
 * stackable (no science buffer / no fitted WCS / plane-vs-WCS grid mismatch)
 * — recorded honestly by the caller, never a throw.
 */
export function captureFrame(
    scratchDir: string,
    frameId: string,
    file: string,
    session: StackCaptureSession,
    receipt: any
): { captured: CapturedFrame | null; reason: string | null } {
    const img = session.getExportImage?.();
    if (!img) return { captured: null, reason: 'no science buffer on session (honest-absent)' };
    const wcs = receipt?.wcs;
    if (!wcs || wcs.SOURCE !== 'FITTED') {
        return { captured: null, reason: `no FITTED WCS on receipt (SOURCE=${wcs?.SOURCE ?? 'absent'})` };
    }
    // The fitted WCS lives on the FULL-RES image grid; a binned science buffer
    // would silently shear the registration — refuse (v1, honest).
    const metaW = receipt?.metadata?.width, metaH = receipt?.metadata?.height;
    if (typeof metaW === 'number' && typeof metaH === 'number' && (img.width !== metaW || img.height !== metaH)) {
        return { captured: null, reason: `science buffer ${img.width}x${img.height} != WCS grid ${metaW}x${metaH} (binned buffer) — v1 refuses` };
    }

    fs.mkdirSync(scratchDir, { recursive: true });
    const planePath = path.join(scratchDir, `${frameId}.f32`);
    const bytes = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    fs.writeFileSync(planePath, bytes);
    const planeSha256 = createHash('sha256').update(bytes).digest('hex');

    return {
        captured: {
            id: frameId,
            file,
            planePath,
            planeSha256,
            width: img.width,
            height: img.height,
            receiptWcs: wcs,
            timestamp: receipt?.metadata?.timestamp ?? null,
            exposureS: typeof receipt?.metadata?.exposure_time === 'number' ? receipt.metadata.exposure_time : null,
        },
        reason: null,
    };
}

// ── stack step ────────────────────────────────────────────────────────────────

export interface StackStepOptions {
    /** Where the FITS + stack receipt land (>10 MB products → D: per the
     *  storage law; callers pass the D: path, default is <outDir>/stack). */
    stackOutDir: string;
    params?: DrizzleParams;
    /** Delete the scratch .f32 planes after a successful stack (default false —
     *  the acceptance driver re-measures FWHM on the sub planes first). */
    cleanupScratch?: boolean;
}

export interface StackStepSummary {
    status: 'ok';
    fits: string;
    receipt_path: string;
    n_input: number;
    n_stacked: number;
    excluded: Array<{ id: string; reason: string }>;
    reference_frame: string;
    output: { width: number; height: number; scale_arcsec: number };
    coverage_max: number;
    dither_offsets_measured: Array<{ id: string; dx_px_ref: number; dy_px_ref: number; arcsec: number }>;
    params: DrizzleParams;
}

/** Drizzle the captured frames and write the stack products. Throws on any
 *  failure — the batch seam catches and records honestly. */
export async function runStackStep(
    captured: CapturedFrame[],
    opts: StackStepOptions
): Promise<StackStepSummary> {
    const params = opts.params ?? DEFAULT_DRIZZLE_PARAMS;

    const frames: StackFrameInput[] = captured.map((c) => ({
        id: c.id,
        frameSha: c.planeSha256,
        wcs: fittedWcsFromReceipt({ wcs: c.receiptWcs }),
        width: c.width,
        height: c.height,
        getPlane: () => {
            const buf = fs.readFileSync(c.planePath);
            return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        },
        timestamp: c.timestamp,
        exposureS: c.exposureS,
    }));

    const sourceOf = (id: string) => captured.find((c) => c.id === id)?.file ?? null;
    const product = await stackSolvedFrames(frames, { params, sourceOf });

    fs.mkdirSync(opts.stackOutDir, { recursive: true });
    const fitsPath = path.join(opts.stackOutDir, 'stack_drizzle_luminance.fits');
    // fits_io.wcsCards eats the ENGINE-hours grid WCS (flat cd) and converts
    // ×15 itself — the receipt's degree-space block is NOT fed here (DE-DUPE SEAM).
    const gridWcsFlat = {
        crval: product.grid.crval,
        crpix: product.grid.crpix,
        cd: [-product.grid.sdeg, 0, 0, product.grid.sdeg] as [number, number, number, number],
    };
    writeFitsPlanar(fitsPath, [product.plane], product.grid.width, product.grid.height, [
        ...wcsCards(gridWcsFlat),
        ['CREATOR', 'm11_stack drizzle v0.1.0'],
        ['NCOMBINE', product.stackedIds.length, 'frames drizzled'],
        ['STAKMODE', 'drizzle'],
        ['DRIZSCL', params.scaleFactor, 'output = reference scale / DRIZSCL'],
        ['PIXFRAC', params.pixfrac, 'Fruchter-Hook input pixel shrink'],
    ]);

    const receiptPath = path.join(opts.stackOutDir, 'stack_receipt.json');
    fs.writeFileSync(receiptPath, JSON.stringify(product.receipt, null, 2) + '\n');

    if (opts.cleanupScratch) {
        for (const c of captured) {
            try { fs.unlinkSync(c.planePath); } catch { /* scratch cleanup is best-effort */ }
        }
    }

    return {
        status: 'ok',
        fits: fitsPath,
        receipt_path: receiptPath,
        n_input: captured.length,
        n_stacked: product.stackedIds.length,
        excluded: product.excluded,
        reference_frame: product.referenceId,
        output: {
            width: product.grid.width,
            height: product.grid.height,
            scale_arcsec: product.grid.scaleArcsec,
        },
        coverage_max: product.coverageMax,
        dither_offsets_measured: product.offsets.map((o) => ({
            id: o.id, dx_px_ref: o.dxPx, dy_px_ref: o.dyPx, arcsec: o.arcsec,
        })),
        params,
    };
}
