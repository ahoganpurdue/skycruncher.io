// starfield.mjs — instanced point-sprite starfield: WGSL vertex pulling from a
// storage buffer, gnomonic projection about the view center computed in-shader.
//
// PRECISION NOTE (display-only, deliberate):
// The starplate release stores ra/dec as f64 (docs/STARPLATES_SPEC.md §3.2),
// and the spec's sub-mas precision claims are about CELL-LOCAL frames — they
// do NOT transfer to a naive global f32 ra/dec (f32 near ra=360° quantizes at
// ~0.08 arcsec, and worse after trig). This lab therefore keeps CPU-side f64:
//   1. world unit vectors are computed once in f64 from the f64 columns;
//   2. the GPU buffer stores each star as an f32 unit vector expressed in a
//      frame anchored at the current "buffer center" (center-relative);
//   3. per frame, a small delta rotation (buffer frame -> live view frame,
//      composed in f64 on the CPU) is uploaded as uniforms;
//   4. when the view drifts > RECENTER_DEG from the buffer center, the buffer
//      is rebuilt in f64 and re-anchored.
// Near the view center the f32 error is ~|v|·2^-24 ≈ 0.02 arcsec — far below
// a display pixel at any zoom this lab allows. This is a rendering technique
// demo, NOT a claim of astrometric fidelity; science paths keep f64.

const DEG = Math.PI / 180;
const RECENTER_DEG = 25;
const COS_RECENTER = Math.cos(RECENTER_DEG * DEG);
const FLOATS_PER_STAR = 5; // x, y, z (buffer-frame unit vec), g_mag, bp_rp

const WGSL = /* wgsl */ `
// Starfield: one 4-vertex triangle-strip quad per star instance.
// No vertex buffers — everything is pulled from the storage buffer by
// instance_index (vertex pulling).

struct Uniforms {
  row0 : vec4<f32>,      // delta rotation rows: buffer frame -> view frame
  row1 : vec4<f32>,      // (view frame: x = east, y = north, z = view axis)
  row2 : vec4<f32>,
  viewport : vec2<f32>,  // canvas size, device px
  scalePx : f32,         // px per tangent-plane unit (zoom)
  magRef : f32,          // faint anchor magnitude (data-derived max g_mag)
  sizeGain : f32,
  alphaGain : f32,
  _pad0 : f32,
  _pad1 : f32,
};

@group(0) @binding(0) var<uniform> u : Uniforms;
// Flat f32 array, 5 per star: x, y, z, g_mag, bp_rp.
@group(0) @binding(1) var<storage, read> stars : array<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) tint : vec3<f32>,
  @location(2) alpha : f32,
};

// ILLUSTRATIVE bp_rp -> tint ramp (blackbody-ish gradient for legibility;
// NOT photometric — the UI labels it as such).
fn tintFor(bpRp : f32) -> vec3<f32> {
  let blue  = vec3<f32>(0.62, 0.75, 1.00); // hot,  bp_rp <~ 0
  let white = vec3<f32>(0.92, 0.94, 1.00);
  let amber = vec3<f32>(1.00, 0.82, 0.55);
  let red   = vec3<f32>(1.00, 0.60, 0.36); // cool, bp_rp >~ 2.9
  let a = mix(blue, white, smoothstep(-0.2, 0.7, bpRp));
  let b = mix(a, amber, smoothstep(0.7, 1.7, bpRp));
  return mix(b, red, smoothstep(1.7, 2.9, bpRp));
}

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VSOut {
  var out : VSOut;
  let base = ii * ${FLOATS_PER_STAR}u;
  let p = vec3<f32>(stars[base], stars[base + 1u], stars[base + 2u]);
  let gMag = stars[base + 3u];
  let bpRp = stars[base + 4u];

  // Rotate the buffer-frame unit vector into the live view frame.
  let v = vec3<f32>(dot(u.row0.xyz, p), dot(u.row1.xyz, p), dot(u.row2.xyz, p));

  // Cull the hemisphere behind the tangent plane (>~87 deg off-axis).
  if (v.z < 0.05) {
    out.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0); // outside clip volume -> dropped
    return out;
  }

  // Gnomonic (TAN) projection about the view axis, right here in-shader.
  let tangent = vec2<f32>(v.x / v.z, v.y / v.z);

  // Magnitude -> size + alpha, log scaling (rel > 0 means brighter).
  let rel = u.magRef - gMag;
  let sizePx = clamp(u.sizeGain * pow(10.0, 0.15 * rel), 0.75, 22.0);
  let alpha  = clamp(u.alphaGain * pow(10.0, 0.28 * rel), 0.04, 1.0);

  // Quad corner from vertex_index (triangle-strip): (-1,-1)(1,-1)(-1,1)(1,1).
  let corner = vec2<f32>(f32(vi & 1u) * 2.0 - 1.0, f32((vi >> 1u) & 1u) * 2.0 - 1.0);
  let px = tangent * u.scalePx + corner * sizePx;
  out.pos = vec4<f32>(px * 2.0 / u.viewport, 0.0, 1.0);
  out.uv = corner;
  out.tint = tintFor(bpRp);
  out.alpha = alpha;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let d2 = dot(in.uv, in.uv);
  if (d2 > 1.0) { discard; }
  // Soft gaussian-ish PSF; additive blending over the space background.
  let a = in.alpha * exp(-2.8 * d2);
  return vec4<f32>(in.tint * a, a);
}
`;

/** Orthonormal basis at (ra, dec): east / north / forward, all f64. */
function basis(raDeg, decDeg) {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const cr = Math.cos(ra), sr = Math.sin(ra);
  const cd = Math.cos(dec), sd = Math.sin(dec);
  return {
    e: [-sr, cr, 0],                 // east  (+ra)
    n: [-sd * cr, -sd * sr, cd],     // north (+dec)
    f: [cd * cr, cd * sr, sd],       // forward (view axis)
  };
}

export class StarfieldRenderer {
  /**
   * @param {GPUDevice} device
   * @param {GPUTextureFormat} format
   * @param {object} plate  result of loadStarplate()
   */
  constructor(device, format, plate) {
    this.device = device;
    this.rows = plate.rows;
    this.gMag = plate.gMag;
    this.bpRp = plate.bpRp;
    this.lastRecenterMs = null;
    this.bufferCenter = null;

    // World unit vectors, f64, computed once from the f64 columns.
    const n = plate.rows;
    this.wx = new Float64Array(n);
    this.wy = new Float64Array(n);
    this.wz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const ra = plate.raDeg[i] * DEG;
      const dec = plate.decDeg[i] * DEG;
      const cd = Math.cos(dec);
      this.wx[i] = cd * Math.cos(ra);
      this.wy[i] = cd * Math.sin(ra);
      this.wz[i] = Math.sin(dec);
    }

    // Data-derived faint anchor (honest: measured, not assumed).
    let magRef = -Infinity;
    for (let i = 0; i < n; i++) if (plate.gMag[i] > magRef) magRef = plate.gMag[i];
    this.magRef = magRef;

    this.cpu = new Float32Array(n * FLOATS_PER_STAR);
    this.storage = device.createBuffer({
      size: this.cpu.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.uniform = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformCpu = new Float32Array(20);

    const module = device.createShaderModule({ code: WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{
          format,
          blend: { // additive — stars accumulate light on the dark field
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-strip' },
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: this.storage } },
      ],
    });
  }

  /** Rebuild the storage buffer in a frame anchored at (raDeg, decDeg). f64 CPU pass. */
  recenter(raDeg, decDeg) {
    const t0 = performance.now();
    const { e, n, f } = basis(raDeg, decDeg);
    const { wx, wy, wz, gMag, bpRp, cpu } = this;
    for (let i = 0, j = 0; i < this.rows; i++, j += FLOATS_PER_STAR) {
      const x = wx[i], y = wy[i], z = wz[i];
      cpu[j]     = e[0] * x + e[1] * y + e[2] * z;
      cpu[j + 1] = n[0] * x + n[1] * y + n[2] * z;
      cpu[j + 2] = f[0] * x + f[1] * y + f[2] * z;
      cpu[j + 3] = gMag[i];
      cpu[j + 4] = bpRp[i];
    }
    this.device.queue.writeBuffer(this.storage, 0, cpu);
    this.bufferCenter = { raDeg, decDeg, basis: { e, n, f } };
    this.lastRecenterMs = performance.now() - t0;
  }

  /**
   * Per-frame: recenter if drifted, then upload the delta rotation + zoom.
   * @param {{raDeg:number, decDeg:number}} view
   * @param {number} scalePx  px per tangent-plane unit
   * @param {number} w @param {number} h  canvas device px
   */
  updateView(view, scalePx, w, h) {
    const vb = basis(view.raDeg, view.decDeg);
    if (this.bufferCenter) {
      const bf = this.bufferCenter.basis.f;
      const cosDist = vb.f[0] * bf[0] + vb.f[1] * bf[1] + vb.f[2] * bf[2];
      if (cosDist < COS_RECENTER) this.recenter(view.raDeg, view.decDeg);
    } else {
      this.recenter(view.raDeg, view.decDeg);
    }

    // M = V · Bᵀ (f64): rotates buffer-frame vectors into the view frame.
    const B = this.bufferCenter.basis;
    const V = vb;
    const rowsV = [V.e, V.n, V.f];
    const rowsB = [B.e, B.n, B.f];
    const u = this.uniformCpu;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        u[r * 4 + c] =
          rowsV[r][0] * rowsB[c][0] + rowsV[r][1] * rowsB[c][1] + rowsV[r][2] * rowsB[c][2];
      }
      u[r * 4 + 3] = 0;
    }
    u[12] = w; u[13] = h;
    u[14] = scalePx;
    u[15] = this.magRef;
    u[16] = 1.1;   // sizeGain
    u[17] = 0.16;  // alphaGain
    u[18] = 0; u[19] = 0;
    this.device.queue.writeBuffer(this.uniform, 0, u);
  }

  /** Encode the instanced draw: 4 strip vertices × rows instances. */
  draw(pass) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(4, this.rows);
  }
}
