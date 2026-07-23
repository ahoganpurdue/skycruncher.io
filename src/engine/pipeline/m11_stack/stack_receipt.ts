/**
 * ═══════════════════════════════════════════════════════════════════════════
 * M11 STACK RECEIPT — the stack product's own receipt KIND ('stack')
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A stack is a DIFFERENT product from a solve: it gets its own receipt kind
 * (discriminated by `kind: 'stack'`, following the batch-verdict discriminator
 * precedent) and its OWN version rail (`stack_schema_version`) — the wizard
 * receipt's RECEIPT_SCHEMA_VERSION is deliberately NOT touched or bumped
 * (no collision with the staged solve-receipt train; a stack receipt can
 * never be mistaken for a solve receipt).
 *
 * Honest-or-absent (LAW 3): every field below is a MEASURED value, a verbatim
 * input-provenance record, or an explicit limitation statement. Nothing is
 * fabricated; absent measurements stay null.
 *
 * The output WCS carries SOURCE:'GRID' — a CONSTRUCTED tangent grid (exact by
 * construction, derived from N per-frame FITTED WCS), never laundered as
 * 'FITTED' (the export fits_writer refuses non-FITTED receipts by design; the
 * stack product ships through the stack lane's own writer).
 */

import type { DrizzleParams, DitherOffset, FrameDeposit, OutputGrid } from './drizzle_stack';

export const STACK_SCHEMA_VERSION = '0.1.0';

export interface StackInputRecord {
    id: string;
    /** Content sha of the stacked plane (or null, recorded honestly). */
    frame_sha: string | null;
    /** Path of the source frame / receipt when the caller knows it. */
    source: string | null;
    /** Always 'FITTED' for stacked inputs (enforced upstream). */
    wcs_provenance: 'FITTED';
    scale_arcsec: number;
    width: number;
    height: number;
    timestamp: string | null;
    exposure_s: number | null;
}

export interface StackExcludedRecord {
    id: string;
    reason: string;
}

export interface BuildStackReceiptArgs {
    inputs: StackInputRecord[];
    excluded: StackExcludedRecord[];
    referenceId: string;
    params: DrizzleParams;
    grid: OutputGrid;
    offsets: DitherOffset[];
    deposits: FrameDeposit[];
    /** Max contributor count observed in the coverage map (MEASURED). */
    coverageMax: number;
}

/** Assemble the `kind:'stack'` receipt. Pure — no I/O, no clock beyond the
 *  single created_utc stamp. */
export function buildStackReceipt(a: BuildStackReceiptArgs): Record<string, unknown> {
    const g = a.grid;
    return {
        kind: 'stack',
        stack_schema_version: STACK_SCHEMA_VERSION,
        created_utc: new Date().toISOString(),
        inputs: a.inputs,
        reference_frame: a.referenceId,
        drizzle: {
            kernel: 'turbo-square',
            scale_factor: a.params.scaleFactor,
            pixfrac: a.params.pixfrac,
            citation: 'Fruchter & Hook 2002, PASP 114, 144 — variable-pixel linear reconstruction',
        },
        /** MEASURED per-frame dither offsets (from the fitted per-frame WCS —
         *  no separate registration estimator in v1). */
        dither_offsets_measured: a.offsets.map((o) => ({
            id: o.id,
            dx_px_ref: o.dxPx,
            dy_px_ref: o.dyPx,
            arcsec: o.arcsec,
        })),
        /** MEASURED per-frame combine statistics. */
        frame_statistics: a.deposits.map((d) => ({
            id: d.id,
            background: d.background,
            sigma_mad: d.sigma,
            weight_inverse_variance: d.weight,
            deposited_px: d.depositedPx,
        })),
        output: {
            width: g.width,
            height: g.height,
            scale_arcsec: g.scaleArcsec,
            channels: 1,
            plane: 'LUMINANCE',
            coverage_max: a.coverageMax,
            // FITS-unit keywords for the CONSTRUCTED grid (CRVAL degrees, CRPIX
            // 0-based engine convention — the FITS writer adds its +1).
            wcs: {
                CTYPE1: 'RA---TAN',
                CTYPE2: 'DEC--TAN',
                CRVAL1: g.crval[0] * 15, // engine HOURS → FITS degrees, converted HERE once
                CRVAL2: g.crval[1],
                CRPIX1: g.crpix[0],
                CRPIX2: g.crpix[1],
                CD1_1: -g.sdeg,
                CD1_2: 0,
                CD2_1: 0,
                CD2_2: g.sdeg,
                SOURCE: 'GRID',
                COMMENT: 'Constructed output tangent grid (exact by construction, derived from N per-frame FITTED WCS) — NOT a star-fitted WCS.',
            },
        },
        photometric_normalization: {
            mode: 'BACKGROUND_SUBTRACT_ONLY',
            note: 'APPROXIMATE (v1): per-frame robust median background subtracted; cross-frame flux ratios assumed 1 (same-rig / same-exposure subs). Star-photometry flux normalization across rigs/exposures is a v2 item (exists in the tools/stack incubator).',
        },
        correlated_input_accounting: {
            policy: 'EXCLUDE_DUPLICATE_SHA_AND_NEAR_SIMULTANEOUS(<=60s)',
            excluded: a.excluded,
            note: 'Duplicated photons void every sqrt(N) independence claim — exact-duplicate planes and near-simultaneous captures (same lights, different products) are excluded from the combine and recorded here. Deeper cross-contamination between distinct upstream products cannot be ruled out; sqrt(N) expectations are upper bounds. (Carried from tools/stack.)',
        },
        limitations: {
            psf_mixing: 'APPROXIMATE (v1): frames combine by inverse-variance weight only — per-frame PSF widths mix in the output (coarse-seeing frames blend by weight). PSF-aware weighting is a known v2 item (carried from tools/stack).',
            registration: 'v1 registration = per-frame fitted WCS only (catalog-registered). The cross-frame re-fit against reference-frame star positions (cancels the shared-catalog error term) is a v2 refinement.',
        },
    };
}
