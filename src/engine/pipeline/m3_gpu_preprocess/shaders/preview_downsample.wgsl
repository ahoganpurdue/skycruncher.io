// ═════════════════════════════════════════════════════════════════════════
// WGSL Compute Shader: GPU-Side Preview Downsample + Float32→Uint8 Cast
// ═════════════════════════════════════════════════════════════════════════
//
// [Module: M3] [Domain: MemoryResidency] WebGpuVram -> WebGpuVram
//
// Input:  Float32 RGB buffer (3 floats per pixel, 0.0–1.0 linear range)
//         from the demosaic stage output.
// Output: Uint8 RGBA buffer (4 bytes per pixel, packed as u32) at
//         preview resolution (area-average downsample).
//
// Workgroup: 16×16 threads
// Each thread computes ONE preview-space output pixel by averaging
// a rectangular region of source pixels determined by the scale factors.
//
// This shader eliminates the catastrophic O(N) main-thread loop that
// previously cast 24MP+ Float32 arrays to Uint8ClampedArray on the V8 heap.

struct Uniforms {
    src_width:  u32,
    src_height: u32,
    dst_width:  u32,
    dst_height: u32,
};

@group(0) @binding(0) var<uniform> params: Uniforms;
@group(0) @binding(1) var<storage, read> src_rgb: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst_rgba: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dx = gid.x;
    let dy = gid.y;

    if (dx >= params.dst_width || dy >= params.dst_height) {
        return;
    }

    // Compute the source region this preview pixel maps to
    let scale_x = f32(params.src_width)  / f32(params.dst_width);
    let scale_y = f32(params.src_height) / f32(params.dst_height);

    let src_x0 = u32(f32(dx) * scale_x);
    let src_y0 = u32(f32(dy) * scale_y);
    let src_x1 = min(u32(f32(dx + 1u) * scale_x), params.src_width);
    let src_y1 = min(u32(f32(dy + 1u) * scale_y), params.src_height);

    // Area-average the source pixels in this block
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

    // Prevent division by zero for edge pixels
    if (count < 1.0) {
        count = 1.0;
    }

    // Average and apply Gamma 2.2 + Exposure Boost for visibility
    let exposure_boost = 1.5;
    let avg_r = (sum_r / count) * exposure_boost;
    let avg_g = (sum_g / count) * exposure_boost;
    let avg_b = (sum_b / count) * exposure_boost;

    // Simple Gamma 2.2 approximation: pow(val, 1/2.2)
    let gamma = 0.4545; // 1.0 / 2.2
    let r = u32(clamp(pow(max(0.0, avg_r), gamma) * 255.0, 0.0, 255.0));
    let g = u32(clamp(pow(max(0.0, avg_g), gamma) * 255.0, 0.0, 255.0));
    let b = u32(clamp(pow(max(0.0, avg_b), gamma) * 255.0, 0.0, 255.0));
    let a = 255u;

    // Pack RGBA into a single u32 (little-endian: R in lowest byte)
    let packed = r | (g << 8u) | (b << 16u) | (a << 24u);

    let out_idx = dy * params.dst_width + dx;
    dst_rgba[out_idx] = packed;
}
