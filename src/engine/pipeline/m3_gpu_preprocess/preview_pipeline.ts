/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GPU-SIDE PREVIEW PIPELINE — Zero-Copy Downsample + JPEG Preview
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * [Module: M3] [Domain: MemoryResidency] WebGpuVram -> JsHeap (preview only)
 *
 * Eliminates the catastrophic O(N) main-thread Float32→Uint8 casting loop
 * by performing downsample + format conversion entirely on the GPU.
 *
 * The full-resolution Float32 buffer NEVER touches the JS heap.
 * Only the tiny preview buffer (~8MB for 4K) is read back to CPU.
 *
 * DESIGN:
 *   1. Takes the existing GPUBuffer (demosaic rgb output) as input
 *   2. Dispatches a compute shader to area-average + cast to Uint8 RGBA
 *   3. Reads back the preview-sized buffer
 *   4. Returns ImageData + generates JPEG preview URL
 *
 *   CPU fallback: If WebGPU is unavailable, falls back to the legacy
 *   main-thread loop (but only over the DOWNSAMPLED buffer).
 */

import { WebGPUContext } from '../../core/WebGPUContext';
import { PIPELINE_CONSTANTS } from '../constants/pipeline_config';
import type { ComputeRouteStamp } from './compute_routes';
import { computeRouteStamp } from './compute_routes';
import previewShaderSource from './shaders/preview_downsample.wgsl?raw';
import previewF32ShaderSource from './shaders/preview_downsample_f32.wgsl?raw';

// Cached pipeline to avoid recompilation across frames
let cachedPreviewPipeline: GPUComputePipeline | null = null;
let cachedPreviewLayout: GPUBindGroupLayout | null = null;
let cachedPreviewF32Pipeline: GPUComputePipeline | null = null;

export interface PreviewResult {
    /** Preview ImageData (at preview resolution, NOT full sensor resolution) */
    imageData: ImageData;
    /** JPEG blob URL for <img src="..."> rendering */
    previewUrl: string;
    /** Width of the preview */
    width: number;
    /** Height of the preview */
    height: number;
    /** [COMPUTE-ROUTE OBSERVABILITY] Honest stamp of which preview path ACTUALLY ran
     *  (webgpu downsample vs CPU fallback) + the decisive reason. Pure diagnostic. */
    route: ComputeRouteStamp;
}

/**
 * Calculate preview dimensions that fit within PREVIEW_MAX_DIM 
 * while maintaining aspect ratio.
 */
function calculatePreviewDimensions(srcW: number, srcH: number): { w: number; h: number } {
    const maxDim = PIPELINE_CONSTANTS.PREVIEW_MAX_DIM;
    if (srcW <= maxDim && srcH <= maxDim) {
        return { w: srcW, h: srcH };
    }
    const aspect = srcW / srcH;
    if (srcW > srcH) {
        return { w: maxDim, h: Math.round(maxDim / aspect) };
    } else {
        return { w: Math.round(maxDim * aspect), h: maxDim };
    }
}

/**
 * Generate a preview from a GPU-resident Float32 RGB buffer.
 * 
 * This is the PRIMARY path: downsample + cast happens entirely on the GPU.
 * Falls back to CPU if WebGPU dispatch fails.
 * 
 * @param rgbBuffer  - The GPUBuffer containing Float32 RGB data (3ch, from demosaic)
 * @param srcWidth   - Full sensor width
 * @param srcHeight  - Full sensor height
 * @param device     - Optional pre-initialized GPUDevice (avoids re-init)
 * @returns PreviewResult with ImageData and JPEG blob URL
 */
export async function generateGpuPreview(
    rgbBuffer: GPUBuffer,
    srcWidth: number,
    srcHeight: number,
    device?: GPUDevice | null,
): Promise<PreviewResult> {
    const gpu = device ?? await WebGPUContext.init();

    // [COMPUTE-ROUTE OBSERVABILITY] Why a CPU fallback happened (surfaced on the
    // fallback stamp so a silent GPU-preview degrade becomes visible).
    let fallbackReason = 'no_webgpu_device';
    if (gpu) {
        try {
            return await dispatchPreviewGPU(gpu, rgbBuffer, srcWidth, srcHeight);
        } catch (err) {
            fallbackReason = `gpu_dispatch_error_fallback:${err instanceof Error ? err.message : String(err)}`;
            console.warn('[Preview] GPU preview dispatch failed, falling back to CPU:', err);
        }
    }

    // CPU fallback: read back the full buffer and downsample on CPU
    const cpu = await generateCpuPreviewFromGpuBuffer(rgbBuffer, srcWidth, srcHeight, gpu);
    return { ...cpu, route: computeRouteStamp('preview', 'cpu', fallbackReason) };
}

/**
 * Generate a preview from a CPU-side Float32Array (e.g., after CPU demosaic fallback).
 * 
 * This is the FALLBACK path for when no GPU buffer exists.
 * Still downsamples first, then casts — never casts full-res.
 */
export async function generateCpuPreview(
    rgbData: Float32Array,
    srcWidth: number,
    srcHeight: number,
): Promise<PreviewResult> {
    const { w: dstW, h: dstH } = calculatePreviewDimensions(srcWidth, srcHeight);

    console.log(`[Preview] CPU downsample: ${srcWidth}x${srcHeight} → ${dstW}x${dstH}`);

    // Downsample + cast in a single pass (only over preview pixels)
    const rgba = new Uint8ClampedArray(dstW * dstH * 4);
    const scaleX = srcWidth / dstW;
    const scaleY = srcHeight / dstH;

    for (let dy = 0; dy < dstH; dy++) {
        const srcY = Math.floor(dy * scaleY);
        for (let dx = 0; dx < dstW; dx++) {
            const srcX = Math.floor(dx * scaleX);
            const srcIdx = (srcY * srcWidth + srcX) * 3;
            const dstIdx = (dy * dstW + dx) * 4;
            rgba[dstIdx]     = Math.round(Math.min(1, Math.max(0, rgbData[srcIdx])) * 255);
            rgba[dstIdx + 1] = Math.round(Math.min(1, Math.max(0, rgbData[srcIdx + 1])) * 255);
            rgba[dstIdx + 2] = Math.round(Math.min(1, Math.max(0, rgbData[srcIdx + 2])) * 255);
            rgba[dstIdx + 3] = 255;
        }
    }

    const imageData = new ImageData(rgba, dstW, dstH);
    const previewUrl = await imageDataToJpegUrl(imageData);

    return { imageData, previewUrl, width: dstW, height: dstH, route: computeRouteStamp('preview', 'cpu', 'cpu_downsample') };
}

// ─── GPU DISPATCH ──────────────────────────────────────────────────────────

async function dispatchPreviewGPU(
    device: GPUDevice,
    srcBuffer: GPUBuffer,
    srcWidth: number,
    srcHeight: number,
): Promise<PreviewResult> {
    const { w: dstW, h: dstH } = calculatePreviewDimensions(srcWidth, srcHeight);
    const previewPixels = dstW * dstH;

    console.log(`[Preview] GPU downsample: ${srcWidth}x${srcHeight} → ${dstW}x${dstH}`);

    // ── Pipeline (cached) ──
    if (!cachedPreviewPipeline) {
        const shaderModule = device.createShaderModule({
            label: 'preview_downsample',
            code: previewShaderSource
        });

        cachedPreviewLayout = device.createBindGroupLayout({
            label: 'preview_layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ]
        });

        cachedPreviewPipeline = device.createComputePipeline({
            label: 'preview_pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [cachedPreviewLayout] }),
            compute: {
                module: shaderModule,
                entryPoint: 'main'
            }
        });
    }

    // ── Buffers ──

    // Uniform: src_width, src_height, dst_width, dst_height (4 × u32 = 16 bytes)
    const uniformData = new Uint32Array([srcWidth, srcHeight, dstW, dstH]);
    const uniformBuffer = device.createBuffer({
        label: 'preview_uniforms',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // Output: packed u32 RGBA (1 u32 per pixel)
    const outputSize = previewPixels * 4; // bytes
    const outputBuffer = device.createBuffer({
        label: 'preview_output',
        size: outputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Staging buffer for CPU readback
    const stagingBuffer = device.createBuffer({
        label: 'preview_staging',
        size: outputSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // ── Bind Group ──
    const bindGroup = device.createBindGroup({
        layout: cachedPreviewLayout!,
        entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: { buffer: srcBuffer } },
            { binding: 2, resource: { buffer: outputBuffer } },
        ]
    });

    // ── Dispatch ──
    const encoder = device.createCommandEncoder({ label: 'preview_cmd' });
    const pass = encoder.beginComputePass({ label: 'preview_pass' });
    pass.setPipeline(cachedPreviewPipeline);
    pass.setBindGroup(0, bindGroup);

    const wgX = Math.ceil(dstW / 16);
    const wgY = Math.ceil(dstH / 16);
    pass.dispatchWorkgroups(wgX, wgY);
    pass.end();

    encoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputSize);
    device.queue.submit([encoder.finish()]);

    // ── Readback ──
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const mappedRange = stagingBuffer.getMappedRange();

    // Unpack the u32 RGBA into Uint8ClampedArray for ImageData
    const packedU32 = new Uint32Array(mappedRange.slice(0));
    const rgba = new Uint8ClampedArray(previewPixels * 4);
    for (let i = 0; i < previewPixels; i++) {
        const packed = packedU32[i];
        rgba[i * 4]     = packed & 0xFF;         // R
        rgba[i * 4 + 1] = (packed >> 8) & 0xFF;  // G
        rgba[i * 4 + 2] = (packed >> 16) & 0xFF; // B
        rgba[i * 4 + 3] = (packed >> 24) & 0xFF; // A
    }

    stagingBuffer.unmap();

    // Cleanup per-frame buffers
    uniformBuffer.destroy();
    outputBuffer.destroy();
    stagingBuffer.destroy();

    const imageData = new ImageData(rgba, dstW, dstH);
    const previewUrl = await imageDataToJpegUrl(imageData);

    console.log(`[Preview] GPU preview complete: ${dstW}x${dstH}`);

    return { imageData, previewUrl, width: dstW, height: dstH, route: computeRouteStamp('preview', 'webgpu', 'gpu_buffer_downsample') };
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

/**
 * Read back a GPU buffer and generate a CPU preview.
 * Used when GPU preview dispatch fails but we still have a GPU buffer.
 */
async function generateCpuPreviewFromGpuBuffer(
    rgbBuffer: GPUBuffer,
    srcWidth: number,
    srcHeight: number,
    device: GPUDevice | null,
): Promise<PreviewResult> {
    if (!device) {
        throw new Error('[Preview] Cannot read GPU buffer without device');
    }

    const bufferSize = srcWidth * srcHeight * 3 * 4; // Float32 × 3ch
    const stagingBuffer = device.createBuffer({
        label: 'preview_fallback_staging',
        size: bufferSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(rgbBuffer, 0, stagingBuffer, 0, bufferSize);
    device.queue.submit([encoder.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const rgbData = new Float32Array(stagingBuffer.getMappedRange().slice(0));
    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return generateCpuPreview(rgbData, srcWidth, srcHeight);
}

/**
 * Generate a high-fidelity Float32 preview from a GPU-resident Float32 RGB buffer.
 * 
 * Used for scientific metrics (Planckian checks) where 8-bit is insufficient.
 */
export async function generateGpuFloat32Preview(
    rgbBuffer: GPUBuffer,
    srcWidth: number,
    srcHeight: number,
    device?: GPUDevice | null,
): Promise<Float32Array> {
    const gpu = device ?? await WebGPUContext.init();
    if (!gpu) throw new Error('[Preview] WebGPU unavailable for Float32 preview');

    const { w: dstW, h: dstH } = calculatePreviewDimensions(srcWidth, srcHeight);
    const previewPixels = dstW * dstH;

    // ── Pipeline (cached) ──
    if (!cachedPreviewF32Pipeline) {
        const shaderModule = gpu.createShaderModule({
            label: 'preview_downsample_f32',
            code: previewF32ShaderSource
        });

        // Reuse layout if already created by the u32 pipeline
        if (!cachedPreviewLayout) {
            cachedPreviewLayout = gpu.createBindGroupLayout({
                label: 'preview_layout',
                entries: [
                    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                ]
            });
        }

        cachedPreviewF32Pipeline = gpu.createComputePipeline({
            label: 'preview_f32_pipeline',
            layout: gpu.createPipelineLayout({ bindGroupLayouts: [cachedPreviewLayout] }),
            compute: { module: shaderModule, entryPoint: 'main' }
        });
    }

    // ── Buffers ──
    const uniformData = new Uint32Array([srcWidth, srcHeight, dstW, dstH]);
    const uniformBuffer = gpu.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    gpu.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const outputSize = previewPixels * 3 * 4; // 3ch * 4 bytes/float
    const outputBuffer = gpu.createBuffer({
        size: outputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const stagingBuffer = gpu.createBuffer({
        size: outputSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // ── Bind Group ──
    const bindGroup = gpu.createBindGroup({
        layout: cachedPreviewLayout!,
        entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: { buffer: rgbBuffer } },
            { binding: 2, resource: { buffer: outputBuffer } },
        ]
    });

    // ── Dispatch ──
    const encoder = gpu.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(cachedPreviewF32Pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(dstW / 16), Math.ceil(dstH / 16));
    pass.end();

    encoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputSize);
    gpu.queue.submit([encoder.finish()]);

    // ── Readback ──
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(stagingBuffer.getMappedRange().slice(0));
    stagingBuffer.unmap();

    // Cleanup
    uniformBuffer.destroy();
    outputBuffer.destroy();
    stagingBuffer.destroy();

    return data;
}

/**
 * Convert ImageData to a JPEG blob URL via OffscreenCanvas.
 */
async function imageDataToJpegUrl(imageData: ImageData): Promise<string> {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[Preview] Failed to create OffscreenCanvas 2d context');
    ctx.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ 
        type: 'image/jpeg', 
        quality: PIPELINE_CONSTANTS.PREVIEW_JPEG_QUALITY 
    });
    const url = URL.createObjectURL(blob);
    console.log(`[Preview] JPEG generated (${(blob.size / 1024).toFixed(0)} KB)`);
    return url;
}
