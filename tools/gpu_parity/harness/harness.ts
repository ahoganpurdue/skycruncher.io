// GPU/CPU demosaic parity harness (browser side).
//
// Imports the REAL src demosaic paths — no reimplementation. The two incumbents
// are the units under test:
//   * GPU: demosaicWebGPU(...) -> dispatchGPU (WGSL demosaic_bayer_param.wgsl)
//   * CPU: DemosaicEngine.demosaicBilinear(...)   (float64-intermediate)
//
// Exposes window.__runParity(payload) -> { gpuUsed, adapter, cpuB64, gpuB64,
// len, width, height }. The Node runner (run_parity.mjs) drives this via
// Playwright real Chrome (channel 'chrome', headless) and does all ULP /
// histogram / decision-stat math on the returned Float32 buffers.

import { demosaicWebGPU, DEFAULT_DEMOSAIC_PARAMS } from '@/engine/pipeline/m3_gpu_preprocess/demosaic_pipeline';
import type { DemosaicParams } from '@/engine/pipeline/m3_gpu_preprocess/demosaic_pipeline';
import { DemosaicEngine } from '@/engine/pipeline/m3_gpu_preprocess/demosaic_engine';

const statusEl = document.getElementById('status');
const setStatus = (s: string) => { if (statusEl) statusEl.textContent = s; };

// Base64-encode an ArrayBuffer in chunks (avoids String.fromCharCode arg-limit
// blowups on ~1MB buffers). Node reconstructs Float32Array from this.
function bufToB64(ab: ArrayBufferLike): string {
  const bytes = new Uint8Array(ab);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Probe adapter identity independently of WebGPUContext so we can record the
// GPU name even if the dispatch is cached. Best-effort.
async function probeAdapter(): Promise<any> {
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) return { available: false, reason: 'navigator.gpu undefined' };
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, reason: 'requestAdapter returned null' };
    let info: any = {};
    try {
      if (adapter.info) info = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description };
      else if (adapter.requestAdapterInfo) { const ai = await adapter.requestAdapterInfo(); info = { vendor: ai.vendor, architecture: ai.architecture, device: ai.device, description: ai.description }; }
    } catch (e) { info = { probe_error: String(e) }; }
    return {
      available: true,
      info,
      isFallbackAdapter: !!adapter.isFallbackAdapter,
      features: Array.from(adapter.features || []).slice(0, 60),
      limits: { maxBufferSize: adapter.limits?.maxBufferSize, maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize },
    };
  } catch (e) {
    return { available: false, reason: String(e) };
  }
}

interface ParityPayload {
  raw: number[];          // Uint16 mosaic values (length width*height)
  width: number;
  height: number;
  stride: number;
  params?: DemosaicParams;
}

(window as any).__runParity = async (payload: ParityPayload) => {
  const { raw, width, height, stride } = payload;
  const params = payload.params ?? DEFAULT_DEMOSAIC_PARAMS;
  const rawU16 = Uint16Array.from(raw);

  // ── GPU path (real dispatch). Explicit params -> skips the Tauri-native
  // branch and runs the browser WebGPU compute shader. rgbBuffer is set ONLY
  // on a successful GPU dispatch, so it doubles as our "GPU actually ran" flag.
  const gpuRes = await demosaicWebGPU(rawU16, width, height, stride, params);
  const gpuUsed = gpuRes.rgbBuffer !== undefined;
  const gpuData = gpuRes.data as Float32Array;

  // ── CPU path (real incumbent). Same Uint16 input, same params.
  const cpuData = DemosaicEngine.demosaicBilinear(rawU16, width, height, stride, params);

  const adapter = await probeAdapter();

  return {
    gpuUsed,
    adapter,
    width, height,
    len: cpuData.length,
    cpuB64: bufToB64(cpuData.buffer),
    gpuB64: bufToB64(gpuData.buffer),
  };
};

// Signal readiness for the runner to poll.
probeAdapter().then((a) => {
  (window as any).__adapterInfo = a;
  (window as any).__harnessReady = true;
  setStatus(`ready — gpu.available=${a.available} device=${a?.info?.device ?? a?.info?.description ?? '?'} fallback=${a?.isFallbackAdapter}`);
}).catch((e) => {
  (window as any).__harnessReady = true;
  setStatus('ready (adapter probe failed: ' + String(e) + ')');
});
