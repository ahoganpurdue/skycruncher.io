/**
 * DESKTOP TEST RAIL v0 — the self-driving webview host (branch rail/desktop-v0).
 *
 * Boots at `#/testrail` inside the REAL Tauri app (tauri dev with
 * tauri.testrail.conf.json). Auto-runs two legs and streams every result to
 * tauri-dev STDOUT via @tauri-apps/plugin-log (the machine-evidence of record,
 * exactly the spike's pattern) so the Node runner (run_rail.mjs) needs no manual
 * interaction with the native WebView2 window.
 *
 *   LEG 1 — APP-SOLVE: drive the REAL webview→Rust seam solveViaGreenfield()
 *     (stages/greenfield_seam.ts) on the banked M66 SeeStar detections, and check
 *     solved_via=greenfield_rust + the pinned decision core (scale 3.679184978895153,
 *     matches 265). This is the leg that caught the walkthrough NaN-cross-JSON bug.
 *
 *   LEG 2 — NATIVE-GPU: invoke('demosaic_native') through the same webview with the
 *     gpu_parity synthetic RGGB Bayer fixtures, and compare the NATIVE wgpu output
 *     against the CPU (DemosaicEngine.demosaicBilinear) and browser-WebGPU
 *     (demosaicWebGPU) incumbents — the SAME ULP methodology as tools/gpu_parity.
 *     First-ever parity evidence for the native shader.
 *
 * NEVER MERGES to main. Pure measurement host; imports live src paths, reimplements
 * nothing. Input assets are served by vite from public/__testrail_tmp/ (staged by
 * run_rail.mjs, removed on exit).
 */

import React, { useEffect, useState } from 'react';
import { info as tauriInfo } from '@tauri-apps/plugin-log';
import { solveViaGreenfield } from '@/engine/pipeline/stages/greenfield_seam';
import { demosaicWebGPU, DEFAULT_DEMOSAIC_PARAMS } from '@/engine/pipeline/m3_gpu_preprocess/demosaic_pipeline';
import { DemosaicEngine } from '@/engine/pipeline/m3_gpu_preprocess/demosaic_engine';
import { NativeGpuBridge } from '@/engine/core/NativeGpuBridge';
import * as wasmCompute from '@/engine/wasm_compute/pkg/wasm_compute';
import type { DetectedStar } from '@/engine/types/Main_types';
import { compare, decisionProbe, rawStats } from './parity';

// ── pinned M66 reference (D:/AstroLogic/test_artifacts/greenfield_solver/PINNED_REFERENCE_SOLVES.json) ──
const M66_SCALE = 3.679184978895153;
const M66_MATCHES = 265;
const M66_RA_DEG = 170.11844356557404;
const M66_DEC_DEG = 13.048758677673888;
const M66_WIDTH = 2160;
const M66_HEIGHT = 3840;
const SCALE_REL_TOL = 1e-9; // JSON f64 round-trips exactly; decision core is byte-exact.

const ASSET_BASE = '/__testrail_tmp';
const M66_DETECTIONS_URL = `${ASSET_BASE}/M66_detections.json`;
const FIXTURES = [
    { name: 'gradient', file: 'gradient_256x256_rggb_u16le.bin', md5: '0f34bf2d07d38bd136875ad968e565ea' },
    { name: 'impulse', file: 'impulse_256x256_rggb_u16le.bin', md5: '1f55505cd1b5c6d3fdb62bcabaf906e5' },
    { name: 'noise', file: 'noise_256x256_rggb_u16le.bin', md5: '8c62ef3acf2c949513a749ccd0d4e653' },
];
const FIX_W = 256, FIX_H = 256, FIX_STRIDE = 256;

let STARTED = false; // StrictMode double-invoke guard

// ── stdout emit (plugin-log → Rust log::info! → tauri-dev stdout) ────────────────
async function emit(line: string): Promise<void> {
    try {
        await tauriInfo(`RAIL|${line}`);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`RAIL|LOGERR|${String(e)}|${line}`);
    }
}
function b64FromString(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
    return btoa(bin);
}
/** Emit a JSON payload as ordered base64 chunks the runner reassembles. */
async function emitPayload(kind: string, obj: unknown): Promise<void> {
    const b64 = b64FromString(JSON.stringify(obj));
    const CHUNK = 3500;
    const n = Math.max(1, Math.ceil(b64.length / CHUNK));
    for (let i = 0; i < n; i++) {
        await emit(`P|${kind}|${i}|${n}|${b64.slice(i * CHUNK, (i + 1) * CHUNK)}`);
    }
}

async function probeAdapter(): Promise<unknown> {
    try {
        const gpu = (navigator as unknown as { gpu?: { requestAdapter: (o: unknown) => Promise<unknown> } }).gpu;
        if (!gpu) return { available: false, reason: 'navigator.gpu undefined' };
        const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }) as
            | { info?: Record<string, unknown>; isFallbackAdapter?: boolean; features?: Iterable<string> }
            | null;
        if (!adapter) return { available: false, reason: 'requestAdapter returned null' };
        const info = adapter.info
            ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }
            : {};
        return { available: true, info, isFallbackAdapter: !!adapter.isFallbackAdapter, features: Array.from(adapter.features ?? []).slice(0, 40) };
    } catch (e) {
        return { available: false, reason: String(e) };
    }
}

// ── LEG 1: app-solve via the real greenfield seam ───────────────────────────────
async function runAppSolveLeg(): Promise<void> {
    await emit('LEG1|BEGIN app-solve (solveViaGreenfield on banked M66)');
    try {
        const res = await fetch(M66_DETECTIONS_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`fetch ${M66_DETECTIONS_URL} -> HTTP ${res.status}`);
        const j = await res.json() as { detections?: Array<Record<string, number>> };
        const arr = j.detections ?? [];
        if (arr.length === 0) throw new Error('no detections in banked M66 JSON');

        // Contract id = array index; the seam re-enumerates in submit order. All banked
        // rows have finite x/y/flux/fwhm, so the seam keeps all of them in file order —
        // the exact detection set the Rust cargo gate solves.
        const stars: DetectedStar[] = arr.map((d) => ({
            x: d.x, y: d.y,
            rawX: d.rawX ?? d.x, rawY: d.rawY ?? d.y,
            flux: d.flux, fwhm: d.fwhm,
            peak_adu: d.peak_value, snr: d.snr,
        }));
        await emit(`LEG1|loaded ${stars.length} detections; invoking solve_greenfield via webview seam…`);

        const stub = { width: M66_WIDTH, height: M66_HEIGHT } as unknown as ImageData;
        const t0 = performance.now();
        const solveResult = await solveViaGreenfield(stub, stars, undefined);
        const wallMs = +(performance.now() - t0).toFixed(1);

        const sol = solveResult.solution;
        const receipt = sol?.greenfield_receipt ?? null;
        const state = (receipt as { decision?: { result?: { state?: string } } } | null)?.decision?.result?.state ?? 'NO_SOLUTION';
        const solvedVia = sol?.solved_via ?? null;
        const scale = sol?.pixel_scale ?? null;
        const matches = sol?.num_stars ?? null;
        const raDeg = sol?.ra ?? null;
        const decDeg = sol?.dec ?? null;

        const scaleOk = scale != null && Math.abs((scale - M66_SCALE) / M66_SCALE) <= SCALE_REL_TOL;
        const matchesOk = matches === M66_MATCHES;
        const viaOk = solvedVia === 'greenfield_rust';
        const stateOk = state === 'Solved';
        const pass = !!(solveResult.success && scaleOk && matchesOk && viaOk && stateOk);

        const verdict = {
            leg: 'app_solve',
            pass,
            observed: { success: solveResult.success, solved_via: solvedVia, state, scale, matches, ra_deg: raDeg, dec_deg: decDeg, wall_ms_webview: wallMs, receipt_wall_ms: (receipt as { telemetry?: { wall_ms?: number } } | null)?.telemetry?.wall_ms ?? null },
            expected: { solved_via: 'greenfield_rust', state: 'Solved', scale: M66_SCALE, matches: M66_MATCHES, ra_deg: M66_RA_DEG, dec_deg: M66_DEC_DEG },
            checks: { success: solveResult.success, viaOk, stateOk, scaleOk, matchesOk },
            n_detections_submitted: stars.length,
            decision_digest: (receipt as { decision_digest?: string } | null)?.decision_digest ?? null,
        };
        await emitPayload('appsolve', verdict);
        if (receipt) await emitPayload('receipt', receipt);
        await emit(`LEG1|VERDICT ${pass ? 'PASS' : 'FAIL'} solved_via=${solvedVia} state=${state} scale=${scale} matches=${matches}`);
    } catch (e) {
        await emitPayload('appsolve', { leg: 'app_solve', pass: false, error: String((e as Error)?.stack ?? e) });
        await emit(`LEG1|VERDICT FAIL error=${String(e)}`);
    }
    await emit('LEG1|END');
}

// ── LEG 2: native GPU demosaic parity ───────────────────────────────────────────
async function runNativeGpuLeg(): Promise<void> {
    await emit('LEG2|BEGIN native-gpu demosaic parity (RGGB fixtures)');
    const adapter = await probeAdapter();
    await emitPayload('adapter', adapter);

    for (const fx of FIXTURES) {
        await emit(`LEG2|fixture ${fx.name}…`);
        const out: Record<string, unknown> = { name: fx.name, file: fx.file, md5: fx.md5, width: FIX_W, height: FIX_H };
        try {
            const binRes = await fetch(`${ASSET_BASE}/${fx.file}`, { cache: 'no-store' });
            if (!binRes.ok) throw new Error(`fetch ${fx.file} -> HTTP ${binRes.status}`);
            const bin = await binRes.arrayBuffer();
            if (bin.byteLength !== FIX_W * FIX_H * 2) throw new Error(`fixture ${fx.file} is ${bin.byteLength}B, expected ${FIX_W * FIX_H * 2}`);
            const rawU16 = new Uint16Array(bin);

            // CPU + browser-GPU incumbents (identical to tools/gpu_parity harness).
            const cpu = DemosaicEngine.demosaicBilinear(rawU16, FIX_W, FIX_H, FIX_STRIDE, DEFAULT_DEMOSAIC_PARAMS);
            const gpuRes = await demosaicWebGPU(rawU16, FIX_W, FIX_H, FIX_STRIDE, DEFAULT_DEMOSAIC_PARAMS);
            const gpuUsed = (gpuRes as { rgbBuffer?: unknown }).rgbBuffer !== undefined;
            const gpu = (gpuRes as { data: Float32Array }).data;
            out.browser_gpu_used = gpuUsed;

            // Cross-check: browser-GPU vs CPU reproduces the banked wt-gpuparity numbers.
            if (gpuUsed) out.browsergpu_vs_cpu = compare(gpu, cpu, FIX_W, FIX_H);

            // NATIVE path — invoke the real desktop wgpu kernel via the PRODUCTION
            // bridge (NativeGpuBridge.demosaic → invoke('demosaic_native')). Capture
            // whatever it does; the binding-layout question is the whole point.
            let nativeOk = false;
            try {
                // Native returns interleaved RGB (w·h·3) — the SAME shape as the CPU
                // and browser-GPU incumbents (since the 2026-07-21 native kernel fix),
                // so compare directly with no alpha drop.
                const nativeRgb = await NativeGpuBridge.demosaic(rawU16, FIX_W, FIX_H);
                out.native_raw_stats = rawStats(nativeRgb);
                out.native_len_expected_rgb = FIX_W * FIX_H * 3;
                const stats = out.native_raw_stats as { len: number; finite: number; zero: number };
                const looksUsable = stats.len === FIX_W * FIX_H * 3 && stats.finite > 0 && stats.zero < stats.len;
                out.native_looks_usable = looksUsable;
                if (stats.len === FIX_W * FIX_H * 3) {
                    out.native_vs_cpu = compare(nativeRgb, cpu, FIX_W, FIX_H);
                    out.native_vs_cpu_decision = decisionProbe(cpu, nativeRgb, FIX_W, FIX_H);
                    if (gpuUsed) out.native_vs_browsergpu = compare(nativeRgb, gpu, FIX_W, FIX_H);
                    nativeOk = true;
                }
            } catch (ne) {
                out.native_error = String((ne as Error)?.message ?? ne);
            }
            out.native_compared = nativeOk;
        } catch (e) {
            out.error = String((e as Error)?.stack ?? e);
        }
        await emitPayload(`native.${fx.name}`, out);
        await emit(`LEG2|fixture ${fx.name} done (native_compared=${out.native_compared === true} native_error=${out.native_error ?? 'none'})`);
    }
    await emit('LEG2|END');
}

/**
 * Instantiate the wasm_compute module (SkyTransform's backing). The minimal
 * #/testrail host does NOT boot MainApp, so the wasm-bindgen web-target glue is
 * never initialized on its own — mirrors source_extractor.ts::ensureWasmInitialized
 * (call the default init export). Without this, greenfield_seam's mapping throws
 * `Cannot read properties of undefined (reading 'rotation_from_cd')` on SkyTransform.
 */
async function ensureWasmCompute(): Promise<boolean> {
    try {
        const init = (wasmCompute as unknown as { default?: () => Promise<unknown> }).default;
        if (typeof init === 'function') await init();
        return typeof (wasmCompute as unknown as { rotation_from_cd?: unknown }).rotation_from_cd === 'function';
    } catch (e) {
        await emit(`wasm_compute init FAILED: ${String(e)}`);
        return false;
    }
}

async function runRail(): Promise<void> {
    await emit('BEGIN desktop test rail v0');
    const wasmOk = await ensureWasmCompute();
    await emit(`wasm_compute initialized: ${wasmOk}`);
    await runAppSolveLeg();
    await runNativeGpuLeg();
    await emit('END desktop test rail v0');
    await emit('DONE'); // final sentinel for the runner
}

export const TestRailHost: React.FC = () => {
    const [log, setLog] = useState<string[]>([]);
    useEffect(() => {
        if (STARTED) return;
        STARTED = true;
        const sink = (l: string) => setLog((prev) => [...prev, l]);
        void (async () => {
            try {
                await runRail();
            } catch (e) {
                await emit(`FATAL ${String((e as Error)?.stack ?? e)}`);
            }
            sink('rail sequence dispatched — see tauri-dev stdout (RAIL| lines) for the canonical record');
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
        <div style={{ minHeight: '100vh', background: '#05060a', color: '#e8ecf4', fontFamily: 'system-ui, sans-serif', padding: 24 }} data-testid="testrail-host">
            <h1 style={{ fontSize: 18, fontWeight: 800 }}>Desktop Test Rail v0</h1>
            <p style={{ fontSize: 12, color: '#9aa5bd', maxWidth: 780 }}>
                Auto-driving LEG 1 (app-solve via the greenfield webview seam) + LEG 2 (native wgpu demosaic parity).
                Every result streams to tauri-dev stdout as <code>RAIL|</code> lines.
            </p>
            <pre style={{ marginTop: 12, fontSize: 10.5, color: '#c7d5f0', whiteSpace: 'pre-wrap' }}>{log.join('\n')}</pre>
        </div>
    );
};

export default TestRailHost;
