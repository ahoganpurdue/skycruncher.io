struct DistortionProfile {
    k1: f32,
    k2: f32,
    k3: f32,
    p1: f32,
    p2: f32,
    r_ref: f32,
    cx: f32,
    cy: f32,
}

@group(0) @binding(0) var src_texture: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst_texture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> profile: DistortionProfile;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dim = textureDimensions(dst_texture);
    if (global_id.x >= dim.x || global_id.y >= dim.y) {
        return;
    }
    
    let fx = f32(global_id.x);
    let fy = f32(global_id.y);
    
    let xn = (fx - profile.cx) / profile.r_ref;
    let yn = (fy - profile.cy) / profile.r_ref;
    let r2 = xn * xn + yn * yn;
    
    let r4 = r2 * r2;
    let r6 = r4 * r2;
    
    let radial = 1.0 + profile.k1 * r2 + profile.k2 * r4 + profile.k3 * r6;
    let dx_tang = 2.0 * profile.p1 * xn * yn + profile.p2 * (r2 + 2.0 * xn * xn);
    let dy_tang = profile.p1 * (r2 + 2.0 * yn * yn) + 2.0 * profile.p2 * xn * yn;
    
    let srcX = profile.cx + (xn * radial + dx_tang) * profile.r_ref;
    let srcY = profile.cy + (yn * radial + dy_tang) * profile.r_ref;
    
    let srcDim = textureDimensions(src_texture);
    // Since we're using a sampler, UV should be normalized, but wait!
    // textureSampleLevel requires normalized coordinates [0.0, 1.0] when used with a sampler
    let uv = vec2<f32>(srcX / f32(srcDim.x), srcY / f32(srcDim.y));
    
    var color = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    // Add anti-aliasing edge bounds check to avoid clamping bleeding if out of bounds
    if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
        color = textureSampleLevel(src_texture, samp, uv, 0.0);
    }
    
    textureStore(dst_texture, vec2<i32>(global_id.xy), color);
}
