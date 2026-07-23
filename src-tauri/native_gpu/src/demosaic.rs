use wgpu::util::DeviceExt;
use crate::NativeGpuContext;

/// Uniform block for `demosaic_bayer_param.wgsl` (48 bytes, 12 × 4-byte fields).
///
/// Byte-for-byte identical to the browser path's uniform (demosaic_pipeline.ts
/// `dispatchGPU`): width/height/stride + CFA parity offsets + calibration levels.
/// The native path fills the CFA/calibration fields with the Canon-RGGB
/// `DEFAULT_DEMOSAIC_PARAMS` — the exact values the legacy `demosaic_bayer.wgsl`
/// hardcoded — so native and browser run the SAME shader with the SAME constants
/// (parity by construction). `#[repr(C)]` with all-4-byte fields gives the exact
/// std140-compatible 48-byte layout the shader's `Uniforms` struct declares.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct DemosaicUniforms {
    width: u32,
    height: u32,
    stride: u32,
    cfa_offset_x: u32,
    cfa_offset_y: u32,
    black_level: f32,
    white_level: f32,
    wb_r: f32,
    wb_g: f32,
    wb_b: f32,
    _pad0: u32,
    _pad1: u32,
}

pub struct DemosaicPipeline {
    pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
}

impl DemosaicPipeline {
    pub fn new(ctx: &NativeGpuContext) -> Self {
        // RETARGETED 2026-07-21 (native demosaic kernel fix) to the PARAMETERIZED
        // shader the browser path uses (demosaic_bayer_param.wgsl). The legacy
        // demosaic_bayer.wgsl declared uniform@0 + storage(read) raw@1 +
        // storage(read_write) rgb@2 with an RGB w·h·3 output, but this Rust layout
        // declared two storage buffers (no uniform) and an RGBA w·h·4 output — so
        // wgpu rejected the pipeline at creation and the kernel could never run
        // (test_results/desktop_rail_2026-07-21/native_pipeline_diagnosis.md). Using
        // the SAME WGSL as the browser makes native/browser demosaic parity a matter
        // of backend float determinism only, not algorithm divergence.
        let shader_src = include_str!("../../../src/engine/pipeline/m3_gpu_preprocess/shaders/demosaic_bayer_param.wgsl");
        let shader = ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Demosaic Shader"),
            source: wgpu::ShaderSource::Wgsl(shader_src.into()),
        });

        let bind_group_layout = ctx.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Demosaic Bind Group Layout"),
            entries: &[
                // binding 0: Uniforms { width, height, stride, cfa_offset_x/y, black/white, wb_r/g/b, pad }
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // binding 1: raw Bayer mosaic (u32-packed u16 LE), read-only storage
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // binding 2: interleaved RGB f32 output (w·h·3), read-write storage
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let pipeline_layout = ctx.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Demosaic Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = ctx.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Demosaic Pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        Self {
            pipeline,
            bind_group_layout,
        }
    }

    /// Returns interleaved RGB f32 (`width * height * 3`, channel c at
    /// `(y*width + x)*3 + c`) — the shape the shader writes and the JS
    /// `ArrowMemory.createRgbBuffer` consumer expects (LAW 7 `tauri_native_ipc`).
    pub async fn run(
        &self,
        ctx: &NativeGpuContext,
        input: &[u16],
        width: u32,
        height: u32,
    ) -> Result<Vec<f32>, String> {
        // Uniform: dims + tightly-packed row stride (= width, single-channel mosaic)
        // + the Canon-RGGB DEFAULT_DEMOSAIC_PARAMS the legacy native shader baked in.
        let uniforms = DemosaicUniforms {
            width,
            height,
            stride: width,
            cfa_offset_x: 0,
            cfa_offset_y: 0,
            black_level: 2048.0,
            white_level: 16383.0,
            wb_r: 2.1,
            wb_g: 1.0,
            wb_b: 1.4,
            _pad0: 0,
            _pad1: 0,
        };
        let uniform_buffer = ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Demosaic Uniform Buffer"),
            contents: bytemuck::bytes_of(&uniforms),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let input_buffer = ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Demosaic Input Buffer"),
            contents: bytemuck::cast_slice(input),
            usage: wgpu::BufferUsages::STORAGE,
        });

        // RGB interleaved (3 floats per pixel) — matches the shader's outIdx stride.
        let output_size = (width * height * 3 * std::mem::size_of::<f32>() as u32) as wgpu::BufferAddress;
        let output_buffer = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Demosaic Output Buffer"),
            size: output_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });

        let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Demosaic Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: input_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: output_buffer.as_entire_binding(),
                },
            ],
        });

        let mut encoder = ctx.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Demosaic Encoder"),
        });

        {
            let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Demosaic Compute Pass"),
                timestamp_writes: None,
            });
            cpass.set_pipeline(&self.pipeline);
            cpass.set_bind_group(0, &bind_group, &[]);
            cpass.dispatch_workgroups((width + 15) / 16, (height + 15) / 16, 1);
        }

        let staging_buffer = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Demosaic Staging Buffer"),
            size: output_size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        encoder.copy_buffer_to_buffer(&output_buffer, 0, &staging_buffer, 0, output_size);
        ctx.queue.submit(Some(encoder.finish()));

        let buffer_slice = staging_buffer.slice(..);
        let (sender, receiver) = std::sync::mpsc::channel();
        buffer_slice.map_async(wgpu::MapMode::Read, move |v| sender.send(v).unwrap());

        ctx.device.poll(wgpu::Maintain::Wait);

        if let Ok(Ok(())) = receiver.recv() {
            let data = buffer_slice.get_mapped_range();
            let result = bytemuck::cast_slice(&data).to_vec();
            drop(data);
            staging_buffer.unmap();
            Ok(result)
        } else {
            Err("[M3] GPU demosaic compute shader failed to map staging buffer".into())
        }
    }
}
