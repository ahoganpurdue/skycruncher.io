// ═════════════════════════════════════════════════════════════════════════
// WGSL Compute Shader: Bilinear Bayer Demosaic (Parameterized CFA)
// ═════════════════════════════════════════════════════════════════════════
//
// Parameterized variant of demosaic_bayer.wgsl, carrying a 48-byte uniform with
// CFA offsets and calibration levels so GRBG/GBRG/BGGR sensors (e.g. IMX585) and
// non-Canon black/white levels are supported.
//
// SHARED shader (since the 2026-07-21 native kernel fix): imported ?raw by the
// browser path (demosaic_pipeline.ts) AND include_str!'d by src-tauri/native_gpu
// (demosaic.rs) — the native side fills the CFA/calibration fields with the
// Canon-RGGB DEFAULT params, so both paths run identical WGSL (parity by
// construction). The Uniforms struct + bindings below are a CONTRACT for BOTH
// the browser bind group (demosaic_pipeline.ts) and the Rust DemosaicUniforms
// struct + bind-group layout; changing either field order/binding breaks both.
// The old legacy demosaic_bayer.wgsl (16-byte uniform) is no longer consumed by
// any code path.
//
// Input:  Packed u32 array containing Uint16 sensor values
//         (2 × Uint16 per u32, little-endian)
// Output: Float32 RGB interleaved (3 floats per pixel)
//
// Workgroup: 16×16 threads. Border pixels are skipped (output = 0).
//
// CFA offsets shift the RGGB parity grid:
//   RGGB → (0,0)   GRBG → (1,0)   GBRG → (0,1)   BGGR → (1,1)
// R sits where ((x+off_x)&1)==0 && ((y+off_y)&1)==0.

struct Uniforms {
    width:        u32,
    height:       u32,
    stride:       u32,
    cfa_offset_x: u32,
    cfa_offset_y: u32,
    black_level:  f32,
    white_level:  f32,
    wb_r:         f32,
    wb_g:         f32,
    wb_b:         f32,
    _pad0:        u32,
    _pad1:        u32,
};

@group(0) @binding(0) var<uniform> params: Uniforms;
@group(0) @binding(1) var<storage, read> raw: array<u32>;
@group(0) @binding(2) var<storage, read_write> rgb: array<f32>;

// Read a single Uint16 from the packed u32 array at element index `idx`.
fn readU16(idx: u32) -> f32 {
    let wordIndex = idx >> 1u;       // Which u32 contains this element
    let isHigh    = idx & 1u;        // 0 = low 16 bits, 1 = high 16 bits
    let word      = raw[wordIndex];
    let value     = (word >> (isHigh * 16u)) & 0xFFFFu;
    return f32(value);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let gx = gid.x;
    let gy = gid.y;

    // Skip border pixels (bilinear needs ±1 neighbors)
    if (gx == 0u || gy == 0u || gx >= params.width - 1u || gy >= params.height - 1u) {
        return;
    }

    // Input index in the raw buffer (uses stride for row wrapping)
    let i = gy * params.stride + gx;

    // Read the center pixel and its 8 neighbors
    let c  = readU16(i);
    let n  = readU16(i - params.stride);         // North
    let s  = readU16(i + params.stride);         // South
    let e  = readU16(i + 1u);                    // East
    let w  = readU16(i - 1u);                    // West
    let ne = readU16(i - params.stride + 1u);    // NE
    let nw = readU16(i - params.stride - 1u);    // NW
    let se = readU16(i + params.stride + 1u);    // SE
    let sw = readU16(i + params.stride - 1u);    // SW

    var r: f32 = 0.0;
    var g: f32 = 0.0;
    var b: f32 = 0.0;

    // Parity shifted by the CFA offsets (RGGB parity at offset 0,0)
    let isEvenRow = ((gy + params.cfa_offset_y) & 1u) == 0u;
    let isEvenCol = ((gx + params.cfa_offset_x) & 1u) == 0u;

    if (isEvenRow && isEvenCol) {
        // RED pixel
        r = c;
        g = (n + s + e + w) * 0.25;
        b = (nw + ne + sw + se) * 0.25;
    } else if (!isEvenRow && !isEvenCol) {
        // BLUE pixel
        r = (nw + ne + sw + se) * 0.25;
        g = (n + s + e + w) * 0.25;
        b = c;
    } else if (isEvenRow && !isEvenCol) {
        // GREEN pixel on Red row
        r = (w + e) * 0.5;
        g = c;
        b = (n + s) * 0.5;
    } else {
        // GREEN pixel on Blue row
        r = (n + s) * 0.5;
        g = c;
        b = (w + e) * 0.5;
    }

    // [PROCESS] Subtract Black Level, Apply WB, and Normalize
    let normScale = 1.0 / (params.white_level - params.black_level);

    r = max(0.0, (r - params.black_level) * normScale * params.wb_r);
    g = max(0.0, (g - params.black_level) * normScale * params.wb_g);
    b = max(0.0, (b - params.black_level) * normScale * params.wb_b);

    // Output index (tightly packed by width, 3 floats per pixel)
    let outIdx = (gy * params.width + gx) * 3u;

    rgb[outIdx]      = r;
    rgb[outIdx + 1u] = g;
    rgb[outIdx + 2u] = b;
}
