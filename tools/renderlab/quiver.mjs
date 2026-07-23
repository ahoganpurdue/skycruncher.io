// quiver.mjs — SYNTHETIC residual quiver: instanced GPU line segments.
//
// Purpose: let the owner feel where GPU rendering beats the current SVG
// quiver. N is slider-driven (100 → 100,000 segments); the HUD reports the
// real measured draw/frame time at each N. The field is SYNTHETIC and
// labeled as such in the UI — a deterministic pseudo-random distortion-like
// pattern (radial cubic term + swirl + smooth waves + noise), NOT real
// solver residuals.

const FLOATS_PER_ARROW = 4; // anchor x, anchor y (0..1 viewport fractions), dx, dy (px)

const WGSL = /* wgsl */ `
// One line-list segment per instance, vertex-pulled from the storage buffer.
// vertex_index 0 = tail (dim), 1 = head (bright) — the alpha gradient shows
// direction without arrowhead geometry.

struct Uniforms {
  viewport : vec2<f32>, // canvas size, device px
  lenScale : f32,       // residual length multiplier
  alphaGain : f32,
};

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var<storage, read> arrows : array<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) col : vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VSOut {
  let base = ii * ${FLOATS_PER_ARROW}u;
  var px = vec2<f32>(arrows[base], arrows[base + 1u]) * u.viewport;
  let d = vec2<f32>(arrows[base + 2u], arrows[base + 3u]) * u.lenScale;

  var alpha = 0.20 * u.alphaGain;                 // tail
  if (vi == 1u) { px += d; alpha = 0.95 * u.alphaGain; } // head

  // Magnitude ramp: calm cyan -> warn amber -> danger red (token hues).
  let t = clamp(length(d) / 26.0, 0.0, 1.0);
  let cyan  = vec3<f32>(0.22, 0.74, 0.97);
  let amber = vec3<f32>(0.98, 0.75, 0.14);
  let red   = vec3<f32>(0.97, 0.44, 0.44);
  let warmed = mix(cyan, amber, smoothstep(0.25, 0.60, t));
  let col = mix(warmed, red, smoothstep(0.60, 0.95, t));

  var out : VSOut;
  out.pos = vec4<f32>(
    px.x / u.viewport.x * 2.0 - 1.0,
    1.0 - px.y / u.viewport.y * 2.0,
    0.0, 1.0
  );
  out.col = vec4<f32>(col, alpha);
  return out;
}

@fragment
fn fs(@location(0) col : vec4<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(col.rgb * col.a, col.a); // premultiplied
}
`;

/** Deterministic PRNG (mulberry32) — same N always yields the same field. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class QuiverRenderer {
  constructor(device, format) {
    this.device = device;
    this.count = 0;
    this.storage = null;
    this.bindGroup = null;
    this.lastGenMs = null;

    this.uniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformCpu = new Float32Array(4);

    const module = device.createShaderModule({ code: WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{
          format,
          blend: { // premultiplied over
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'line-list' },
    });
  }

  /** Regenerate the SYNTHETIC field at a new N (measured; HUD shows gen ms). */
  regenerate(n) {
    const t0 = performance.now();
    const rand = mulberry32(0xc0ffee ^ n);
    const data = new Float32Array(n * FLOATS_PER_ARROW);
    for (let i = 0; i < n; i++) {
      const x = rand();
      const y = rand();
      // Distortion-like synthetic residual (px):
      const rx = x - 0.5, ry = y - 0.5;
      const r2 = rx * rx + ry * ry;
      const radial = 34.0 * r2;                      // cubic-ish radial growth
      let dx = radial * rx + (-ry) * 9.0;            // + tangential swirl
      let dy = radial * ry + (rx) * 9.0;
      dx += 5.0 * Math.sin(6.28318 * (2.0 * x + 1.3 * y));   // smooth wave
      dy += 5.0 * Math.sin(6.28318 * (1.7 * y - 0.9 * x) + 1.1);
      dx += (rand() - 0.5) * 4.0;                    // measurement noise
      dy += (rand() - 0.5) * 4.0;
      const j = i * FLOATS_PER_ARROW;
      data[j] = x;
      data[j + 1] = y;
      data[j + 2] = dx;
      data[j + 3] = dy;
    }

    if (this.storage) this.storage.destroy();
    this.storage = this.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.storage, 0, data);
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: this.storage } },
      ],
    });
    this.count = n;
    this.lastGenMs = performance.now() - t0;
  }

  /** Per-frame uniforms. */
  update(w, h) {
    const u = this.uniformCpu;
    u[0] = w; u[1] = h;
    u[2] = 1.0;  // lenScale
    u[3] = 1.0;  // alphaGain
    this.device.queue.writeBuffer(this.uniform, 0, u);
  }

  /** Encode the instanced draw: 2 line vertices × count instances. */
  draw(pass) {
    if (!this.bindGroup || this.count === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(2, this.count);
  }
}
