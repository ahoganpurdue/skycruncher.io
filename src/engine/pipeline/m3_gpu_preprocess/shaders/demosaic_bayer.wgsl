// ═════════════════════════════════════════════════════════════════════════
// WGSL Compute Shader: Bilinear Bayer (RGGB) Demosaic
// ═════════════════════════════════════════════════════════════════════════
//
// Input:  Packed u32 array containing Uint16 sensor values
//         (2 × Uint16 per u32, little-endian)
// Output: Float32 RGB interleaved (3 floats per pixel)
//
// Workgroup: 16×16 threads
// Each thread processes one pixel at (gx, gy).
// Border pixels (row/col 0 and last) are skipped (output = 0).
//
// Pattern assumes RGGB:
//   Even row, Even col → Red
//   Even row, Odd col  → Green (on Red row)
//   Odd row,  Even col → Green (on Blue row)
//   Odd row,  Odd col  → Blue

struct Uniforms {
    width:  u32,
    height: u32,
    stride: u32,
    _pad:   u32,
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

    // [CALIBRATION] Constants for typical RAW processing
    // TODO: Phase 4: Pass these via Uniforms from PhotometryManager
    const BLACK_LEVEL: f32 = 2048.0; 
    const WHITE_LEVEL: f32 = 16383.0; // Assume 14-bit sensor (Canon)
    const WB_R: f32 = 2.1; 
    const WB_G: f32 = 1.0; 
    const WB_B: f32 = 1.4;

    var r: f32 = 0.0;
    var g: f32 = 0.0;
    var b: f32 = 0.0;

    let isEvenRow = (gy & 1u) == 0u;
    let isEvenCol = (gx & 1u) == 0u;

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
    let normScale = 1.0 / (WHITE_LEVEL - BLACK_LEVEL);
    
    r = max(0.0, (r - BLACK_LEVEL) * normScale * WB_R);
    g = max(0.0, (g - BLACK_LEVEL) * normScale * WB_G);
    b = max(0.0, (b - BLACK_LEVEL) * normScale * WB_B);

    // Output index (tightly packed by width, 3 floats per pixel)
    let outIdx = (gy * params.width + gx) * 3u;
    
    rgb[outIdx]      = r;
    rgb[outIdx + 1u] = g;
    rgb[outIdx + 2u] = b;
}
