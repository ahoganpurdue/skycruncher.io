// surface.mjs — DEMO 3 geometry: isometric displaced-grid-mesh surfaces,
// GPU-native. One shared N×N grid mesh; the vertex shader pulls a per-stage
// height field (|displacement| px, pre-normalized to that stage's OWN peak —
// see cascade.mjs) from a storage buffer and displaces z. Four stages render
// as a 2×2 pane layout via setViewport/setScissorRect in the lab's single
// render pass; the shared orbit camera (drag to rotate, wheel to zoom) keeps
// the panes visually comparable while each keeps its honest per-stage scale.
//
// The renderer draws NOTHING for an absent stage — the DOM NOT MEASURED tile
// is the display (LAW 3), never a synthetic surface.

const FILL_HEIGHT = 0.38; // z span of a peak-height sample, in grid units

const WGSL = /* wgsl */ `
// Vertex pulling: vertex_index (via the index buffer) -> grid (ix, iy) ->
// storage-buffer height. No vertex buffers.

struct U {
  row0 : vec4<f32>,     // world->view rotation rows (orbit camera, f64-composed on CPU)
  row1 : vec4<f32>,
  row2 : vec4<f32>,
  params : vec4<f32>,   // pane aspect (w/h), zoom, height scale, grid N
};

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var<storage, read> hts : array<f32>; // N*N heights in [0,1]

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) t : f32,      // normalized height (color ramp driver)
  @location(1) shade : f32,  // slope shading (display depth cue only)
};

fn hAt(ix : i32, iy : i32, n : i32) -> f32 {
  let cx = u32(clamp(ix, 0, n - 1));
  let cy = u32(clamp(iy, 0, n - 1));
  return hts[cy * u32(n) + cx];
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  let n = i32(u.params.w);
  let ix = i32(vi) % n;
  let iy = i32(vi) / n;
  let h = hAt(ix, iy, n);
  let span = 1.0 / f32(n - 1);
  let hs = u.params.z;
  // Grid maps the receipt frame: ix -> image x (left..right), iy -> image y
  // (image row 0 at the far edge under the default camera; y-down source).
  let p = vec3<f32>(f32(ix) * span - 0.5, 0.5 - f32(iy) * span, h * hs);

  // Central-difference slope -> lambert-ish shade. Display cue only; the
  // DATA is the height, annotated per pane with its real peak px.
  let dhx = (hAt(ix + 1, iy, n) - hAt(ix - 1, iy, n)) * hs / (2.0 * span);
  let dhy = (hAt(ix, iy + 1, n) - hAt(ix, iy - 1, n)) * hs / (2.0 * span);
  let nrm = normalize(vec3<f32>(-dhx, dhy, 1.0));
  let lightDir = normalize(vec3<f32>(0.4, 0.3, 0.85));
  let shade = 0.55 + 0.45 * max(dot(nrm, lightDir), 0.0);

  // Orbit view rotation + orthographic (isometric-style) projection. Ortho
  // depth is an affine map of view z: |p| <= ~0.81, so depth stays in (0,1).
  let v = vec3<f32>(dot(u.row0.xyz, p), dot(u.row1.xyz, p), dot(u.row2.xyz, p));
  var out : VSOut;
  out.pos = vec4<f32>(v.x * u.params.y / u.params.x, v.y * u.params.y, 0.5 + v.z * 0.3, 1.0);
  out.t = h;
  out.shade = shade;
  return out;
}

// Height ramp on the tokens.css instrument hues: line-strong slate (calm
// floor) -> accent-400 cyan -> warn amber -> danger red (the same earned-
// status ramp the quiver demo uses).
fn ramp(t : f32) -> vec3<f32> {
  let slate = vec3<f32>(0.24, 0.28, 0.39); // --line-strong
  let cyan  = vec3<f32>(0.22, 0.74, 0.97); // --accent-400
  let amber = vec3<f32>(0.98, 0.75, 0.14); // --warn
  let red   = vec3<f32>(0.97, 0.44, 0.44); // --danger
  let a = mix(slate, cyan, smoothstep(0.02, 0.30, t));
  let b = mix(a, amber, smoothstep(0.30, 0.65, t));
  return mix(b, red, smoothstep(0.65, 0.95, t));
}

@fragment
fn fs_fill(in : VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(ramp(in.t) * in.shade, 1.0);
}

@fragment
fn fs_wire(in : VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(min(ramp(in.t) * 1.25 + vec3<f32>(0.05), vec3<f32>(1.0)), 1.0);
}
`;

/** Triangle-list + line-list index sets for an n×n grid. */
function buildIndices(n) {
  const quads = (n - 1) * (n - 1);
  const tri = new Uint32Array(quads * 6);
  let k = 0;
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const i0 = y * n + x;
      const i1 = i0 + 1;
      const i2 = i0 + n;
      const i3 = i2 + 1;
      tri[k++] = i0; tri[k++] = i2; tri[k++] = i1;
      tri[k++] = i1; tri[k++] = i2; tri[k++] = i3;
    }
  }
  const lines = new Uint32Array(2 * (2 * n * (n - 1)));
  k = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n - 1; x++) {
      const i = y * n + x;
      lines[k++] = i; lines[k++] = i + 1;
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n - 1; y++) {
      const i = y * n + x;
      lines[k++] = i; lines[k++] = i + n;
    }
  }
  return { tri, lines };
}

export class SurfaceRenderer {
  constructor(device, format, gridN = 96) {
    this.device = device;
    this.n = 0;
    this.stages = [null, null, null, null]; // { buffer, bindGroup } | null
    this.showFill = true;
    this.showWire = true;

    // Orbit camera: isometric-style default (yaw −45°, pitch ~35.3°).
    this.yaw = -Math.PI / 4;
    this.pitch = 0.6155;
    this.zoomLevel = 1.3;

    this.uniform = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformCpu = new Float32Array(16);

    // Explicit layout so fill and wire pipelines share the SAME bind groups
    // (layout:'auto' would mint incompatible layouts per pipeline).
    this.bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
    const module = device.createShaderModule({ code: WGSL });

    const depth = (write, bias) => ({
      format: 'depth24plus',
      depthWriteEnabled: write,
      depthCompare: write ? 'less' : 'less-equal',
      // Positive bias pushes the FILL slightly deeper so the coincident
      // wireframe wins the depth test cleanly (bias is triangle-only in
      // WebGPU, hence on the fill pipeline, not the lines).
      depthBias: bias,
      depthBiasSlopeScale: bias > 0 ? 1.0 : 0.0,
    });

    this.fillPipeline = device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs_fill', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depth(true, 2),
    });
    this.wirePipeline = device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs_wire', targets: [{ format }] },
      primitive: { topology: 'line-list' },
      depthStencil: depth(false, 0),
    });

    this.depthTex = null;
    this.depthW = 0;
    this.depthH = 0;

    this.setGrid(gridN);
  }

  /** Rebuild grid geometry at n×n. Invalidates all stage height buffers —
   *  the caller re-supplies heights via setStage afterwards. */
  setGrid(n) {
    if (n === this.n) return;
    this.n = n;
    const { tri, lines } = buildIndices(n);
    if (this.triBuf) this.triBuf.destroy();
    if (this.lineBuf) this.lineBuf.destroy();
    this.triBuf = this.device.createBuffer({
      size: tri.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.triBuf, 0, tri);
    this.lineBuf = this.device.createBuffer({
      size: lines.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.lineBuf, 0, lines);
    this.triCount = tri.length;
    this.lineCount = lines.length;
    for (let i = 0; i < 4; i++) this.clearStage(i);
  }

  /** Upload a stage's normalized height field (Float32Array of n*n). */
  setStage(i, heights) {
    this.clearStage(i);
    if (heights.length !== this.n * this.n) {
      throw new Error(`setStage(${i}): ${heights.length} heights for a ${this.n}x${this.n} grid`);
    }
    const buffer = this.device.createBuffer({
      size: heights.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, heights);
    const bindGroup = this.device.createBindGroup({
      layout: this.bgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer } },
      ],
    });
    this.stages[i] = { buffer, bindGroup };
  }

  /** Drop a stage — its pane draws nothing (the DOM shows NOT MEASURED). */
  clearStage(i) {
    if (this.stages[i]) this.stages[i].buffer.destroy();
    this.stages[i] = null;
  }

  /* ── camera ─────────────────────────────────────────────────────────── */

  orbit(dxPx, dyPx) {
    this.yaw -= dxPx * 0.005;
    this.pitch = Math.max(0.08, Math.min(1.55, this.pitch + dyPx * 0.005));
  }

  zoomBy(factor) {
    this.zoomLevel = Math.max(0.3, Math.min(8, this.zoomLevel * factor));
  }

  /** 2×2 pane rects in device px: [x, y, w, h] × 4, with a 2 px gutter. */
  paneRects(w, h) {
    const gap = 2;
    const pw = Math.max(1, Math.floor((w - gap) / 2));
    const ph = Math.max(1, Math.floor((h - gap) / 2));
    return [
      [0, 0, pw, ph],
      [pw + gap, 0, Math.max(1, w - pw - gap), ph],
      [0, ph + gap, pw, Math.max(1, h - ph - gap)],
      [pw + gap, ph + gap, Math.max(1, w - pw - gap), Math.max(1, h - ph - gap)],
    ];
  }

  /** Per-frame: compose the orbit basis (f64 CPU trig) and upload uniforms. */
  update(w, h) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // Camera direction d = (cp·cy, cp·sy, sp); view rows:
    //   right = (−sy, cy, 0), up = (−sp·cy, −sp·sy, cp), fwd = −d.
    const rows = [
      [-sy, cy, 0],
      [-sp * cy, -sp * sy, cp],
      [-cp * cy, -cp * sy, -sp],
    ];
    const u = this.uniformCpu;
    for (let r = 0; r < 3; r++) {
      u[r * 4] = rows[r][0];
      u[r * 4 + 1] = rows[r][1];
      u[r * 4 + 2] = rows[r][2];
      u[r * 4 + 3] = 0;
    }
    const [, , pw, ph] = this.paneRects(w, h)[0];
    u[12] = pw / ph;          // pane aspect
    u[13] = this.zoomLevel;   // ortho zoom
    u[14] = FILL_HEIGHT;      // height scale
    u[15] = this.n;           // grid N
    this.device.queue.writeBuffer(this.uniform, 0, u);
  }

  /** Depth attachment for the lab's render pass (created/resized lazily). */
  depthAttachment(w, h) {
    if (!this.depthTex || this.depthW !== w || this.depthH !== h) {
      if (this.depthTex) this.depthTex.destroy();
      this.depthTex = this.device.createTexture({
        size: { width: w, height: h },
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.depthW = w;
      this.depthH = h;
      this.depthView = this.depthTex.createView();
    }
    return {
      view: this.depthView,
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'discard',
    };
  }

  /** Encode the 2×2 pane draws. Absent stages draw nothing. */
  draw(pass, w, h) {
    const rects = this.paneRects(w, h);
    for (let i = 0; i < 4; i++) {
      const st = this.stages[i];
      if (!st) continue;
      const [x, y, pw, ph] = rects[i];
      pass.setViewport(x, y, pw, ph, 0, 1);
      pass.setScissorRect(x, y, pw, ph);
      pass.setBindGroup(0, st.bindGroup);
      if (this.showFill) {
        pass.setPipeline(this.fillPipeline);
        pass.setIndexBuffer(this.triBuf, 'uint32');
        pass.drawIndexed(this.triCount);
      }
      if (this.showWire || !this.showFill) { // never both off — wire is the floor
        pass.setPipeline(this.wirePipeline);
        pass.setIndexBuffer(this.lineBuf, 'uint32');
        pass.drawIndexed(this.lineCount);
      }
    }
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.setScissorRect(0, 0, w, h);
  }
}
