import { WebGPUContext } from '../../core/WebGPUContext';
import { OpticsManager, DistortionProfile } from '../../core/optics_manager';

import reconstructShaderSource from '../m3_gpu_preprocess/shaders/reconstruct.wgsl?raw';

let cachedPipeline: GPUComputePipeline | null = null;
let cachedBindGroupLayout: GPUBindGroupLayout | null = null;

export async function reconstructImageWebGPU(
    imageData: ImageData,
    profile: DistortionProfile
): Promise<ImageData | null> {
    const device = await WebGPUContext.init();
    if (!device) {
        console.warn('[Reconstruct] WebGPU not available. Skipping GPU final reconstruction.');
        return null;
    }

    const { width, height } = imageData;

    if (!cachedPipeline) {
        const shaderModule = device.createShaderModule({
            label: 'reconstruct_shader',
            code: reconstructShaderSource
        });

        cachedBindGroupLayout = device.createBindGroupLayout({
            label: 'reconstruct_layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { format: 'rgba8unorm', access: 'write-only' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ]
        });

        cachedPipeline = device.createComputePipeline({
            label: 'reconstruct_pipeline',
            layout: device.createPipelineLayout({
                bindGroupLayouts: [cachedBindGroupLayout]
            }),
            compute: {
                module: shaderModule,
                entryPoint: 'main',
            }
        });
    }

    // Prepare Uniform Buffer
    const uniformData = new Float32Array([
        profile.k1,
        profile.k2,
        profile.k3 || 0,
        profile.p1,
        profile.p2,
        profile.r_ref || Math.sqrt((width / 2) ** 2 + (height / 2) ** 2),
        width / 2.0,
        height / 2.0,
    ]);
    const uniformBuffer = device.createBuffer({
        size: uniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // Prepare Source Texture
    const srcTexture = device.createTexture({
        size: [width, height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    device.queue.writeTexture(
        { texture: srcTexture },
        imageData.data,
        { bytesPerRow: width * 4, rowsPerImage: height },
        [width, height, 1]
    );

    // Sampler
    const sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
    });

    // Destination Storage Texture
    const dstTexture = device.createTexture({
        size: [width, height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC
    });

    // Output Buffer to read back
    const outputBuffer = device.createBuffer({
        size: width * height * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = device.createBindGroup({
        layout: cachedBindGroupLayout!,
        entries: [
            { binding: 0, resource: srcTexture.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: dstTexture.createView() },
            { binding: 3, resource: { buffer: uniformBuffer } },
        ]
    });

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(cachedPipeline);
    passEncoder.setBindGroup(0, bindGroup);
    
    // dispatch workgroups (16x16 threads per block)
    const workgroupCountX = Math.ceil(width / 16);
    const workgroupCountY = Math.ceil(height / 16);
    passEncoder.dispatchWorkgroups(workgroupCountX, workgroupCountY);
    passEncoder.end();

    // Copy texture to buffer
    commandEncoder.copyTextureToBuffer(
        { texture: dstTexture },
        { buffer: outputBuffer, bytesPerRow: width * 4, rowsPerImage: height },
        [width, height, 1]
    );

    device.queue.submit([commandEncoder.finish()]);

    // Await completion
    await outputBuffer.mapAsync(GPUMapMode.READ);
    
    const arrayBuffer = outputBuffer.getMappedRange();
    const outClamped = new Uint8ClampedArray(new Uint8Array(arrayBuffer));
    // Must create a new ImageData from a copied array because the mapped range will be unmapped
    const finalImageData = new ImageData(new Uint8ClampedArray(outClamped), width, height);
    
    outputBuffer.unmap();
    
    // Cleanup
    srcTexture.destroy();
    dstTexture.destroy();
    uniformBuffer.destroy();
    outputBuffer.destroy();

    return finalImageData;
}

