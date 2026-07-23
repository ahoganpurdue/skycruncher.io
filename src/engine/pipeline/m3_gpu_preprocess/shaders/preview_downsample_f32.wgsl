// ═════════════════════════════════════════════════════════════════════════
// WGSL Compute Shader: GPU-Side Preview Downsample (Float32 Output)
// ═════════════════════════════════════════════════════════════════════════
//
// [Module: M3] [Domain: MemoryResidency] WebGpuVram -> WebGpuVram
//
// Input:  Float32 RGB buffer (3 floats per pixel, 0.0–1.0 linear range)
// Output: Float32 RGB buffer (3 floats per pixel) at preview resolution.
//
// Used for "Planckian color checks" and "Science Buffers" where 
// 8-bit precision is insufficient but full resolution is too heavy.

struct Uniforms {
    src_width:  u32,
    src_height: u32,
    dst_width:  u32,
    dst_height: u32,
};

@group(0) @binding(0) var<uniform> params: Uniforms;
@group(0) @binding(1) var<storage, read> src_rgb: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst_rgb: array<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dx = gid.x;
    let dy = gid.y;

    if (dx >= params.dst_width || dy >= params.dst_height) {
        return;
    }

    // Compute range of source pixels
    let scale_x = f32(params.src_width)  / f32(params.dst_width);
    let scale_y = f32(params.src_height) / f32(params.dst_height);

    let src_x0 = u32(f32(dx) * scale_x);
    let src_y0 = u32(f32(dy) * scale_y);
    let src_x1 = min(u32(f32(dx + 1u) * scale_x), params.src_width);
    let src_y1 = min(u32(f32(dy + 1u) * scale_y), params.src_height);

    var sum_r: f32 = 0.0;
    var sum_g: f32 = 0.0;
    var sum_b: f32 = 0.0;
    var count: f32 = 0.0;

    for (var sy = src_y0; sy < src_y1; sy = sy + 1u) {
        for (var sx = src_x0; sx < src_x1; sx = sx + 1u) {
            let idx = (sy * params.src_width + sx) * 3u;
            sum_r += src_rgb[idx];
            sum_g += src_rgb[idx + 1u];
            sum_b += src_rgb[idx + 2u];
            count += 1.0;
        }
    }

    if (count < 1.0) {
        count = 1.0;
    }

    let out_idx = (dy * params.dst_width + dx) * 3u;
    dst_rgb[out_idx]      = sum_r / count;
    dst_rgb[out_idx + 1u] = sum_g / count;
    dst_rgb[out_idx + 2u] = sum_b / count;
}
