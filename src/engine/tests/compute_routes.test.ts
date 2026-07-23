// ═══════════════════════════════════════════════════════════════════════════
// COMPUTE-ROUTE STAMPING (schema 2.16.0) — loud GPU-capable-seam observability
// ═══════════════════════════════════════════════════════════════════════════
// Proves the ONE thing that matters: every GPU-capable seam records what ACTUALLY
// ran (route + decisive reason), and the receipt surfaces it honest-or-absent.
// Silent CPU-degrade / invisible seam-skip die here (memory: gpu-test-coverage-gap;
// ledger row 448). Pure diagnostic — no SOLVE field is touched.
//
// The two SACRED headless lanes (FITS SeeStar + rawler CR2) additionally assert the
// live skip stamps end-to-end in tools/api/solve_seestar.apispec.ts + solve_cr2.apispec.ts
// (generatePreviews:false → preview=skipped; already-demosaiced payload → demosaic=skipped).

import { describe, it, expect, beforeEach } from 'vitest';
import { WebGPUContext } from '../core/WebGPUContext';
import { demosaicWebGPU } from '../pipeline/m3_gpu_preprocess/demosaic_pipeline';
import { computeRouteStamp, type ComputeRouteStamp } from '../pipeline/m3_gpu_preprocess/compute_routes';
import { preDemosaicReason } from '../pipeline/stages/ingest';
import { buildReceipt, buildFailureReceipt, buildComputeRoutesBlock } from '../pipeline/stages/package';

// ── WebGPUContext init-branch reason (specific, never generic) ─────────────────
describe('WebGPUContext.getLastInitReason — specific null-branch', () => {
    beforeEach(() => WebGPUContext.reset());

    it('under vitest (node env) init() returns null and reports the SPECIFIC branch', async () => {
        const device = await WebGPUContext.init();
        expect(device).toBeNull();
        // Node 24 defines a BARE `navigator` global with NO `.gpu`, so the honest
        // branch is 'no_navigator_gpu' (NOT 'no_navigator' — that fires only on a host
        // with no navigator at all). The reason is the SPECIFIC branch, never a
        // generic "no GPU" — exactly what a downstream compute-route reason needs.
        expect(WebGPUContext.getLastInitReason()).toBe('no_navigator_gpu');
    });

    it('reason is null before any init attempt (fresh reset)', () => {
        expect(WebGPUContext.getLastInitReason()).toBeNull();
    });
});

// ── demosaic seam: node yields a CPU route with the mapped reason (6a) ─────────
describe('demosaicWebGPU — records the compute route it ACTUALLY took', () => {
    beforeEach(() => WebGPUContext.reset());

    it('(6a) in the node env the demosaic falls back to CPU and stamps the honest reason', async () => {
        // 4×4 single-channel Bayer payload; no GPU device exists under vitest, so the
        // dispatch falls through to DemosaicEngine.demosaicBilinear (CPU).
        const w = 4, h = 4;
        const raw = new Uint16Array(w * h).fill(1000);
        const res = await demosaicWebGPU(raw, w, h, w);
        expect(res.route.seam).toBe('demosaic');
        expect(res.route.route).toBe('cpu');
        // reason maps the WebGPUContext init branch ('no_navigator_gpu') 1:1.
        expect(res.route.reason).toBe('no_navigator_gpu');
        // the seam still produced a valid demosaiced RGB (route is pure diagnostic).
        expect(res.data.length).toBe(w * h * 3);
    });
});

// ── ingest: pre-demosaiced SKIP reason names the producer honestly ────────────
describe('preDemosaicReason — honest producer of an already-demosaiced payload', () => {
    it('FITS stacks → pre_demosaiced_stacked', () => {
        expect(preDemosaicReason('FITS')).toBe('pre_demosaiced_stacked');
    });
    it('rawler-default RAW DSLR (CR2/NEF/ARW) → pre_demosaiced_rawler', () => {
        // default env: VITE_DECODER_RAWLER unset ⇒ rawler is the default arm.
        expect(preDemosaicReason('CR2')).toBe('pre_demosaiced_rawler');
        expect(preDemosaicReason('NEF')).toBe('pre_demosaiced_rawler');
        expect(preDemosaicReason('ARW')).toBe('pre_demosaiced_rawler');
    });
    it('RAF (X-Trans) is forced onto libraw → pre_demosaiced_libraw', () => {
        expect(preDemosaicReason('RAF')).toBe('pre_demosaiced_libraw');
    });
    it('browser-decoded inputs (JPEG/TIFF/UNKNOWN) → pre_demosaiced_browser', () => {
        expect(preDemosaicReason('JPEG')).toBe('pre_demosaiced_browser');
        expect(preDemosaicReason('TIFF')).toBe('pre_demosaiced_browser');
        expect(preDemosaicReason('UNKNOWN')).toBe('pre_demosaiced_browser');
    });
});

// ── block builder: verbatim copy, or honest-absent null ───────────────────────
describe('buildComputeRoutesBlock — honest-or-absent', () => {
    const stamps: ComputeRouteStamp[] = [
        computeRouteStamp('demosaic', 'skipped', 'pre_demosaiced_stacked'),
        computeRouteStamp('preview', 'skipped', 'previews_disabled'),
    ];

    it('returns the stamps verbatim (shallow-copied) when present', () => {
        const block = buildComputeRoutesBlock(stamps);
        expect(block).toEqual(stamps);
        // shallow copy — not the same array/object refs (pure diagnostic snapshot).
        expect(block).not.toBe(stamps);
        expect(block![0]).not.toBe(stamps[0]);
    });

    it('returns null for undefined or empty (honest-absent, LAW 3)', () => {
        expect(buildComputeRoutesBlock(undefined)).toBeNull();
        expect(buildComputeRoutesBlock([])).toBeNull();
    });
});

// ── receipts: block present when stamped, null when absent (6b/6c) ─────────────
describe('buildReceipt / buildFailureReceipt — compute_routes block', () => {
    const routes: ComputeRouteStamp[] = [
        computeRouteStamp('demosaic', 'skipped', 'pre_demosaiced_rawler'),
        computeRouteStamp('preview', 'skipped', 'previews_disabled'),
    ];

    function receiptInputs(computeRoutes?: ComputeRouteStamp[]): any {
        return {
            metadata: null, signal: null, solution: null, planets: [], hardware: null,
            forensics: null, scales: null, warnings: [], timestampTrusted: true,
            spcc: undefined, computeRoutes, imageWidth: 100, imageHeight: 100,
        };
    }
    function failureInputs(computeRoutes?: ComputeRouteStamp[]): any {
        return {
            metadata: null, signal: null, solveDiagnostics: null, stageTimings: null,
            stageReached: 'solve', stageOfDeath: 'solve', failReason: null,
            frameSha256: null, sourceFormat: 'CR2', warnings: [], timestampTrusted: true,
            decoderArm: 'rawler', computeRoutes, imageWidth: 100, imageHeight: 100,
        };
    }

    it('(6b) solved receipt carries the seam stamps when the run stamped them', () => {
        expect(buildReceipt(receiptInputs(routes)).compute_routes).toEqual(routes);
    });
    it('(6b) failure receipt carries the seam stamps too (a failed frame still banks routes)', () => {
        expect(buildFailureReceipt(failureInputs(routes)).compute_routes).toEqual(routes);
    });
    it('(6c) absence semantics — no stamps ⇒ compute_routes: null (both receipts)', () => {
        expect(buildReceipt(receiptInputs(undefined)).compute_routes).toBeNull();
        expect(buildReceipt(receiptInputs([])).compute_routes).toBeNull();
        expect(buildFailureReceipt(failureInputs(undefined)).compute_routes).toBeNull();
    });
    it('the block never perturbs the version stamp (additive only)', () => {
        expect(buildReceipt(receiptInputs(routes)).version).toBe('2.20.0');
    });
});
