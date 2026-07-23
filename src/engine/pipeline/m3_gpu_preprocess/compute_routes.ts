/**
 * ═══════════════════════════════════════════════════════════════════════════
 * COMPUTE-ROUTE STAMPING — loud observability for GPU-capable seams
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: PIXEL (records which compute path a PIXEL-ledger seam actually took).
 *
 * PROBLEM (memory: gpu-test-coverage-gap; ledger row 448): every GPU-capable
 * seam degrades to CPU SILENTLY. No rail records whether the demosaic ran on
 * native wgpu / browser WebGPU / a CPU fallback, and both sacred lanes skip the
 * demosaic entirely (already-demosaiced payloads) with no visible trace. A silent
 * CPU degrade or a silent skip is exactly the kind of invisible regression this
 * instrument is supposed to make loud.
 *
 * FIX: each GPU-capable seam records ONE honest stamp of what ACTUALLY ran — the
 * route it took and WHY — and those stamps ride into the receipt as an additive,
 * honest-or-absent `compute_routes` block (stages/package.ts buildReceipt). The
 * stamp NEVER changes what the seam computes; it is pure observation, so the
 * pinned reference solves stay byte-identical (a new additive block + the version
 * string are the only receipt deltas).
 *
 * These stamps are DIAGNOSTIC METADATA, never a measurement or a gate input.
 */

/** GPU-capable pipeline seams that record a route. */
export type ComputeSeam = 'demosaic' | 'preview';

/** What actually ran at the seam.
 *  • native_wgpu — Tauri native GPU dispatch (src-tauri/native_gpu)
 *  • webgpu      — browser WebGPU compute dispatch
 *  • cpu         — CPU fallback (no GPU device / dispatch failed / not GPU-eligible)
 *  • skipped     — the seam's compute step did not run at all (input already in the
 *                  target form, or the artifact was deliberately not produced) */
export type ComputeRoute = 'native_wgpu' | 'webgpu' | 'cpu' | 'skipped';

/** One honest record of a seam's compute route + the decisive reason. */
export interface ComputeRouteStamp {
    seam: ComputeSeam;
    route: ComputeRoute;
    /** The DECISIVE factor for this route (why this path, not the faster one) —
     *  e.g. 'ok', 'explicit_cfa_skip_native', 'no_tauri_runtime', 'no_navigator_gpu',
     *  'no_webgpu_adapter', 'dispatch_error_fallback:<msg>', 'pre_demosaiced_stacked',
     *  'previews_disabled'. A free-form honest string, never fabricated. */
    reason: string;
}

/** Tiny constructor (keeps the shape consistent across producers). */
export function computeRouteStamp(seam: ComputeSeam, route: ComputeRoute, reason: string): ComputeRouteStamp {
    return { seam, route, reason };
}
