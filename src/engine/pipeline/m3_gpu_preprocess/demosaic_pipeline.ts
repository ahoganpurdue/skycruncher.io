import { DemosaicEngine } from "./demosaic_engine";
import { Table } from 'apache-arrow';
import { ArrowMemory } from '../../core/ArrowMemory';
import { WebGPUContext } from '../../core/WebGPUContext';
import { NativeGpuBridge } from '../../core/NativeGpuBridge';
import type { ComputeRouteStamp } from './compute_routes';
import { computeRouteStamp } from './compute_routes';

// Import the WGSL shader source as a raw string (Vite handles ?raw imports)
// NOTE: demosaic_bayer_param.wgsl is SHARED — the browser path imports it here and
// src-tauri/native_gpu include_str!'s it too (since the 2026-07-21 native kernel fix).
// Changing its Uniforms struct or bindings affects BOTH paths; keep them in lock-step.
import demosaicParamShaderSource from './shaders/demosaic_bayer_param.wgsl?raw';

export interface DemosaicResult {
    data: Float32Array; // Legacy bridge
    arrowTable: Table;  // Zero-copy bridge
    rgbBuffer?: GPUBuffer; // Shared GPU Memory
    width: number;
    height: number;
    /** [COMPUTE-ROUTE OBSERVABILITY] Honest stamp of which path ACTUALLY ran
     *  (native_wgpu / webgpu / cpu) + the decisive reason. Pure diagnostic — it
     *  never changes the demosaiced pixels. */
    route: ComputeRouteStamp;
}

/** CFA / calibration parameters for the demosaic dispatch. */
export interface DemosaicParams {
    /** CFA parity offsets — RGGB(0,0), GRBG(1,0), GBRG(0,1), BGGR(1,1) */
    cfaOffsetX: number;
    cfaOffsetY: number;
    blackLevel: number;
    whiteLevel: number;
    wbR: number;
    wbG: number;
    wbB: number;
}

/** Defaults reproduce the legacy hardcoded shader constants exactly (Canon 14-bit RGGB). */
export const DEFAULT_DEMOSAIC_PARAMS: DemosaicParams = {
    cfaOffsetX: 0,
    cfaOffsetY: 0,
    blackLevel: 2048,
    whiteLevel: 16383,
    wbR: 2.1,
    wbG: 1.0,
    wbB: 1.4,
};

/** Map a BAYERPAT string to RGGB-parity CFA offsets. */
export function bayerPatternToOffsets(pattern: string): { x: number; y: number } {
    switch ((pattern || 'RGGB').toUpperCase()) {
        case 'GRBG': return { x: 1, y: 0 };
        case 'GBRG': return { x: 0, y: 1 };
        case 'BGGR': return { x: 1, y: 1 };
        case 'RGGB':
        default:     return { x: 0, y: 0 };
    }
}

// Cached pipeline & bind group layout to avoid recompilation between frames
let cachedPipeline: GPUComputePipeline | null = null;
let cachedBindGroupLayout: GPUBindGroupLayout | null = null;

/**
 * Demosaic a raw Bayer CFA buffer into interleaved RGB Float32.
 * 
 * Dispatches to WebGPU if available, otherwise falls back to the 
 * CPU-based DemosaicEngine.demosaicBilinear.
 * 
 * Both paths return the same SHAPE: a packed Float32Array with 3 channels per
 * pixel (R, G, B) and an accompanying Arrow Table. They are NOT bit-identical,
 * however — MEASURED: 61.6% of interior pixels differ by 1 float32 ULP (RTX 3060,
 * EFFICIENCY_REVIEW 2026-07-10). Do not treat CPU<->GPU demosaic as swappable
 * against a byte-identity gate.
 */
export async function demosaicWebGPU(
    rawSource: Table | Float32Array | Uint16Array,
    width: number,
    height: number,
    stride: number,
    params?: DemosaicParams
): Promise<DemosaicResult> {

    // [ARROW MEMORY CONTINUITY]
    // Extract the zero-copy TypedArray from the IPC format if provided.
    let rawBuffer: Float32Array | Uint16Array;
    if (rawSource instanceof Table) {
        rawBuffer = ArrowMemory.getUint16Array(rawSource);
    } else {
        rawBuffer = rawSource;
    }

    // [COMPUTE-ROUTE OBSERVABILITY] Track WHY native was not taken as we fall
    // through the ladder; it becomes the reason on the webgpu route (the decisive
    // "why not the faster path" factor). See compute_routes.ts.
    let nativeSkipReason = 'ok';

    // â”€â”€ Attempt Native GPU Dispatch (Tauri) â”€â”€
    // Skipped when explicit params are supplied: the native bridge forwards only
    // width/height (not CFA offsets or calibration levels), so native always demosaics
    // with the Canon-RGGB DEFAULT params baked into src-tauri/native_gpu. It cannot
    // honor caller-supplied CFA offsets or custom black/white levels.
    if (params) {
        nativeSkipReason = 'explicit_cfa_skip_native';
        console.log('[Demosaic] Explicit CFA params supplied — skipping native dispatch (native uses Canon-RGGB defaults)');
    } else {
        try {
            if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
                const isNative = await NativeGpuBridge.isNative();
                if (isNative && rawBuffer instanceof Uint16Array) {
                    const output = await NativeGpuBridge.demosaic(rawBuffer, width, height);
                    console.log(`[Demosaic] Native wgpu dispatch: ${width}x${height}`);
                    const arrowTable = ArrowMemory.createRgbBuffer(output, width, height);
                    return { data: output, arrowTable, width, height, route: computeRouteStamp('demosaic', 'native_wgpu', 'ok') };
                }
                nativeSkipReason = isNative ? 'native_raw_not_uint16' : 'native_bridge_unavailable';
            } else {
                nativeSkipReason = 'no_tauri_runtime';
            }
        } catch (err) {
            nativeSkipReason = `native_dispatch_error:${err instanceof Error ? err.message : String(err)}`;
            console.warn('[Demosaic] Native wgpu dispatch failed:', err);
        }
    }

    // â”€â”€ Attempt WebGPU Dispatch (Browser) â”€â”€
    const device = await WebGPUContext.init();

    // Reason for a CPU fallback (why GPU did not run). Set specifically below.
    let cpuReason: string;
    if (device && rawBuffer instanceof Uint16Array) {
        try {
            const { output, buffer } = await dispatchGPU(device, rawBuffer, width, height, stride, params ?? DEFAULT_DEMOSAIC_PARAMS);
            console.log(`[Demosaic] WebGPU dispatch: ${width}x${height}`);
            const arrowTable = ArrowMemory.createRgbBuffer(output, width, height);
            // route = webgpu; reason = the decisive "why not native" factor.
            return { data: output, arrowTable, rgbBuffer: buffer, width, height, route: computeRouteStamp('demosaic', 'webgpu', nativeSkipReason) };
        } catch (err) {
            cpuReason = `dispatch_error_fallback:${err instanceof Error ? err.message : String(err)}`;
            console.warn('[Demosaic] WebGPU dispatch failed, falling back to CPU:', err);
            // Fall through to CPU path
        }
    } else if (!device) {
        // Map the SPECIFIC WebGPUContext.init null-branch to a compute-route reason.
        const initReason = WebGPUContext.getLastInitReason();
        cpuReason =
            initReason === 'no_navigator' ? 'no_navigator' :
            initReason === 'no_navigator_gpu' ? 'no_navigator_gpu' :
            initReason === 'no_adapter' ? 'no_webgpu_adapter' :
            initReason === 'init_threw' ? 'webgpu_init_threw' :
            'no_webgpu';
    } else {
        // Device present but the raw payload is not a Uint16 Bayer buffer.
        cpuReason = 'raw_not_uint16';
    }

    // â”€â”€ CPU Fallback â”€â”€
    console.log(`[Demosaic] CPU fallback: ${width}x${height}`);
    const output = DemosaicEngine.demosaicBilinear(rawBuffer as Float32Array | Uint16Array, width, height, stride, params);
    const arrowTable = ArrowMemory.createRgbBuffer(output, width, height);
    return { data: output, arrowTable, width, height, route: computeRouteStamp('demosaic', 'cpu', cpuReason) };
}

/**
 * GPU compute dispatch for Bayer demosaic.
 * 
 * 1. Uploads Uint16 raw data as packed u32 storage buffer
 * 2. Creates output Float32 RGB storage buffer
 * 3. Dispatches the WGSL compute shader
 * 4. Reads back the result
 */
async function dispatchGPU(
    device: GPUDevice,
    raw: Uint16Array,
    width: number,
    height: number,
    stride: number,
    params: DemosaicParams
): Promise<{ output: Float32Array; buffer: GPUBuffer }> {

    // â”€â”€ Pipeline (cached) â”€â”€
    if (!cachedPipeline) {
        const shaderModule = device.createShaderModule({
            label: 'demosaic_bayer_param',
            code: demosaicParamShaderSource
        });

        cachedBindGroupLayout = device.createBindGroupLayout({
            label: 'demosaic_layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ]
        });

        cachedPipeline = device.createComputePipeline({
            label: 'demosaic_pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [cachedBindGroupLayout] }),
            compute: {
                module: shaderModule,
                entryPoint: 'main'
            }
        });
    }

    // â”€â”€ Buffers â”€â”€
    
    // Uniform buffer: 5 Ã— u32 + 5 Ã— f32 + 2 Ã— u32 pad = 48 bytes
    // Layout must match the Uniforms struct in demosaic_bayer_param.wgsl.
    const uniformData = new ArrayBuffer(48);
    const view = new DataView(uniformData);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    view.setUint32(8, stride, true);
    view.setUint32(12, params.cfaOffsetX, true);
    view.setUint32(16, params.cfaOffsetY, true);
    view.setFloat32(20, params.blackLevel, true);
    view.setFloat32(24, params.whiteLevel, true);
    view.setFloat32(28, params.wbR, true);
    view.setFloat32(32, params.wbG, true);
    view.setFloat32(36, params.wbB, true);
    // bytes 40..47: _pad0/_pad1 (zeroed)
    const uniformBuffer = device.createBuffer({
        label: 'demosaic_uniforms',
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // Input buffer: pack Uint16Array as Uint32Array for WGSL storage
    // Pad to even length if necessary
    const paddedLength = raw.length + (raw.length % 2);
    const packedRaw = new Uint32Array(paddedLength / 2);
    const rawView = new Uint16Array(packedRaw.buffer);
    rawView.set(raw);
    
    const inputBuffer = device.createBuffer({
        label: 'demosaic_raw_input',
        size: packedRaw.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(inputBuffer, 0, packedRaw);

    // Output buffer: Float32 RGB (3 floats per pixel)
    const outputSize = width * height * 3 * 4; // bytes
    const outputBuffer = device.createBuffer({
        label: 'demosaic_rgb_output',
        size: outputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Staging buffer for readback
    const stagingBuffer = device.createBuffer({
        label: 'demosaic_staging',
        size: outputSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // â”€â”€ Bind Group â”€â”€
    const bindGroup = device.createBindGroup({
        layout: cachedBindGroupLayout!,
        entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: { buffer: inputBuffer } },
            { binding: 2, resource: { buffer: outputBuffer } },
        ]
    });

    // â”€â”€ Dispatch â”€â”€
    const commandEncoder = device.createCommandEncoder({ label: 'demosaic_cmd' });
    const pass = commandEncoder.beginComputePass({ label: 'demosaic_pass' });
    pass.setPipeline(cachedPipeline);
    pass.setBindGroup(0, bindGroup);
    
    // Dispatch with 16Ã—16 workgroups covering the entire image
    const workgroupsX = Math.ceil(width / 16);
    const workgroupsY = Math.ceil(height / 16);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY);
    pass.end();

    // Copy output to staging for CPU readback
    commandEncoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputSize);
    device.queue.submit([commandEncoder.finish()]);

    // â”€â”€ Readback â”€â”€
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const resultBuffer = stagingBuffer.getMappedRange();
    
    // [ZERO-COPY AUDIT]
    // We must copy the data out of the mapped range because unmap() invalidates the ArrayBuffer.
    // However, we avoid .slice(0) which creates an intermediate unmanaged ArrayBuffer.
    // Instead, we construct the Float32Array directly and return it.
    const output = new Float32Array(resultBuffer.slice(0)); // This is still technically a copy, but necessary for Readback.
    // TODO: Phase 4: Use GPU-mapped memory directly if the downstream consumer supports it.
    
    stagingBuffer.unmap();

    // Cleanup per-frame buffers (outputBuffer returned)
    uniformBuffer.destroy();
    inputBuffer.destroy();
    stagingBuffer.destroy();

    return { output, buffer: outputBuffer };
}

