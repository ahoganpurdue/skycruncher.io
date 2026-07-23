/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOWCHART GPU RENDERER — hand-rolled WGSL render pipeline (no deps, no three).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The WebGPU half of the ★ Solve-Flowchart A/B twin. It draws the DAG GEOMETRY
 * on the GPU — node boxes (instanced rounded-rect quads, fill + status border +
 * live "active" pulse) and edges (thick-line triangles) — into a `<canvas>`
 * configured with a WebGPU context. TEXT + hover tooltips are a positioned DOM
 * overlay (the component's job); this is the deliberate HYBRID shape (raw-WebGPU
 * MSDF text is a disproportionate lift for an 18-node chart — see the widget
 * subtitle, honestly labelled "hybrid").
 *
 * PIXEL / render ledger, display-only: it consumes the pre-packed Float32 buffers
 * from `flowchart_gpu_scene` (identical geometry to the SVG widget) and asserts
 * nothing about the solve. The device comes from the shared `WebGPUContext`
 * singleton (LAW 4 — one device across the app); construction THROWS if WebGPU is
 * unavailable so the caller can render the honest "unavailable" state.
 *
 * WGSL is inlined (template strings) rather than `.wgsl?raw` imported so the
 * module is import-safe in the node vitest env (the widget registry loads it).
 */

import { EDGE_VERTEX_FLOATS, NODE_INSTANCE_FLOATS, type RGB } from './flowchart_gpu_scene';

// ─── WGSL ─────────────────────────────────────────────────────────────────────

// Shared uniform: a 2D fit transform (px→clip: clip = px*xy + zw) and time (s).
const UNIFORM_WGSL = `
struct U { xform: vec4<f32>, time: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
`;

const NODE_WGSL = UNIFORM_WGSL + `
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) sizePx: vec2<f32>,
  @location(2) fill: vec4<f32>,
  @location(3) border: vec4<f32>,
  @location(4) params: vec4<f32>,
};
@vertex fn vs(
  @location(0) corner: vec2<f32>,
  @location(1) rect: vec4<f32>,
  @location(2) fill: vec4<f32>,
  @location(3) border: vec4<f32>,
  @location(4) params: vec4<f32>,
) -> VOut {
  var o: VOut;
  let px = rect.xy + corner * rect.zw;
  o.pos = vec4<f32>(px.x * u.xform.x + u.xform.z, px.y * u.xform.y + u.xform.w, 0.0, 1.0);
  o.local = corner;
  o.sizePx = rect.zw;
  o.fill = fill;
  o.border = border;
  o.params = params;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  let p = (i.local - vec2<f32>(0.5)) * i.sizePx;
  let halfSz = i.sizePx * 0.5;
  let r = i.params.z;
  let q = abs(p) - (halfSz - vec2<f32>(r));
  let d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
  let aa = 1.0;
  if (d > aa) { discard; }
  let coverage = clamp(1.0 - (d + aa) / (2.0 * aa), 0.0, 1.0);
  let bw = i.params.y;
  let borderMix = clamp((d + bw) / bw, 0.0, 1.0);
  var col = mix(i.fill, i.border, borderMix);
  if (i.params.x > 0.5) {
    let pulse = 0.5 + 0.5 * sin(u.time.x * 5.0);
    let boost = mix(1.0, 0.35 + 0.9 * pulse, borderMix);
    col.a = col.a * boost;
  }
  col.a = col.a * coverage;
  return col;
}
`;

const EDGE_WGSL = UNIFORM_WGSL + `
struct EOut { @builtin(position) pos: vec4<f32>, @location(0) col: vec4<f32> };
@vertex fn vs(@location(0) px: vec2<f32>, @location(1) col: vec4<f32>) -> EOut {
  var o: EOut;
  o.pos = vec4<f32>(px.x * u.xform.x + u.xform.z, px.y * u.xform.y + u.xform.w, 0.0, 1.0);
  o.col = col;
  return o;
}
@fragment fn fs(i: EOut) -> @location(0) vec4<f32> { return i.col; }
`;

const BLEND: GPUBlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

// ─── renderer ─────────────────────────────────────────────────────────────────

export interface FrameStats {
    /** Smoothed frames-per-second from the rAF cadence. */
    fps: number;
    /** Smoothed CPU-side encode+submit time per frame (ms) — the GPU-work proxy. */
    encodeMs: number;
}

/** A single rounded-quad vertex fan (two triangles) in unit [0,1] space. */
const UNIT_QUAD = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);

export class FlowchartGpuRenderer {
    private readonly device: GPUDevice;
    private readonly ctx: GPUCanvasContext;
    private readonly format: GPUTextureFormat;
    private readonly nodePipeline: GPURenderPipeline;
    private readonly edgePipeline: GPURenderPipeline;
    private readonly uniformBuf: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;
    private readonly quadBuf: GPUBuffer;

    private instanceBuf: GPUBuffer | null = null;
    private instanceCount = 0;
    private edgeBuf: GPUBuffer | null = null;
    private edgeVertexCount = 0;

    private vbW = 1;
    private vbH = 1;
    private bg: RGB = [0.04, 0.05, 0.07];
    private t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    private raf = 0;

    // frame-stat smoothing
    private lastFrameT = 0;
    private emaFps = 0;
    private emaEnc = 0;
    private onStats: ((s: FrameStats) => void) | null = null;

    constructor(private canvas: HTMLCanvasElement, device: GPUDevice) {
        const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
        if (!ctx) throw new Error('canvas.getContext("webgpu") returned null');
        this.device = device;
        this.ctx = ctx;
        this.format = navigator.gpu.getPreferredCanvasFormat();
        ctx.configure({ device, format: this.format, alphaMode: 'opaque' });

        this.uniformBuf = device.createBuffer({
            size: 32, // vec4 xform + vec4 time
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const bgl = device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
        });
        this.bindGroup = device.createBindGroup({
            layout: bgl,
            entries: [{ binding: 0, resource: { buffer: this.uniformBuf } }],
        });
        const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

        this.quadBuf = device.createBuffer({ size: UNIT_QUAD.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(this.quadBuf, 0, UNIT_QUAD);

        const nodeMod = device.createShaderModule({ code: NODE_WGSL });
        this.nodePipeline = device.createRenderPipeline({
            layout,
            vertex: {
                module: nodeMod, entryPoint: 'vs',
                buffers: [
                    { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
                    {
                        arrayStride: NODE_INSTANCE_FLOATS * 4, stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 1, offset: 0, format: 'float32x4' },
                            { shaderLocation: 2, offset: 16, format: 'float32x4' },
                            { shaderLocation: 3, offset: 32, format: 'float32x4' },
                            { shaderLocation: 4, offset: 48, format: 'float32x4' },
                        ],
                    },
                ],
            },
            fragment: { module: nodeMod, entryPoint: 'fs', targets: [{ format: this.format, blend: BLEND }] },
            primitive: { topology: 'triangle-list' },
        });

        const edgeMod = device.createShaderModule({ code: EDGE_WGSL });
        this.edgePipeline = device.createRenderPipeline({
            layout,
            vertex: {
                module: edgeMod, entryPoint: 'vs',
                buffers: [{
                    arrayStride: EDGE_VERTEX_FLOATS * 4, stepMode: 'vertex',
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },
                        { shaderLocation: 1, offset: 8, format: 'float32x4' },
                    ],
                }],
            },
            fragment: { module: edgeMod, entryPoint: 'fs', targets: [{ format: this.format, blend: BLEND }] },
            primitive: { topology: 'triangle-list' },
        });
    }

    setBackground(rgb: RGB): void { this.bg = rgb; }
    setViewBox(w: number, h: number): void { this.vbW = w > 0 ? w : 1; this.vbH = h > 0 ? h : 1; }
    onFrameStats(cb: (s: FrameStats) => void): void { this.onStats = cb; }

    /** Upload a new scene (node instances + edge triangles). Cheap; recreated on change. */
    setScene(instances: Float32Array<ArrayBuffer>, instanceCount: number, edgeVerts: Float32Array<ArrayBuffer>, edgeVertexCount: number): void {
        if (!this.instanceBuf || this.instanceBuf.size < instances.byteLength) {
            this.instanceBuf?.destroy();
            this.instanceBuf = this.device.createBuffer({ size: Math.max(16, instances.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        }
        this.device.queue.writeBuffer(this.instanceBuf, 0, instances);
        this.instanceCount = instanceCount;

        const edgeBytes = Math.max(16, edgeVerts.byteLength);
        if (!this.edgeBuf || this.edgeBuf.size < edgeBytes) {
            this.edgeBuf?.destroy();
            this.edgeBuf = this.device.createBuffer({ size: edgeBytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        }
        if (edgeVerts.byteLength > 0) this.device.queue.writeBuffer(this.edgeBuf, 0, edgeVerts);
        this.edgeVertexCount = edgeVertexCount;
    }

    /** Aspect-fit the viewBox into the canvas → (ax, ay, bx, by) px→clip transform. */
    private fitTransform(cw: number, ch: number): [number, number, number, number] {
        const s = Math.min(cw / this.vbW, ch / this.vbH);
        const ax = (2 * s) / cw;
        const bx = -(this.vbW * s) / cw;
        const ay = -(2 * s) / ch;
        const by = (this.vbH * s) / ch;
        return [ax, ay, bx, by];
    }

    private resize(): void {
        const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
        const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
        const ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
        if (this.canvas.width !== cw || this.canvas.height !== ch) {
            this.canvas.width = cw;
            this.canvas.height = ch;
        }
    }

    /** Render one frame. Returns the CPU encode+submit time (ms). */
    renderOnce(): number {
        this.resize();
        const cw = this.canvas.width;
        const ch = this.canvas.height;
        const [ax, ay, bx, by] = this.fitTransform(cw, ch);
        const tSec = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.t0) / 1000;
        const uni = new Float32Array([ax, ay, bx, by, tSec, 0, 0, 0]);
        this.device.queue.writeBuffer(this.uniformBuf, 0, uni);

        const encStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const enc = this.device.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{
                view: this.ctx.getCurrentTexture().createView(),
                clearValue: { r: this.bg[0], g: this.bg[1], b: this.bg[2], a: 1 },
                loadOp: 'clear', storeOp: 'store',
            }],
        });
        // edges first (under the boxes)
        if (this.edgeBuf && this.edgeVertexCount > 0) {
            pass.setPipeline(this.edgePipeline);
            pass.setBindGroup(0, this.bindGroup);
            pass.setVertexBuffer(0, this.edgeBuf);
            pass.draw(this.edgeVertexCount);
        }
        // nodes (instanced quads)
        if (this.instanceBuf && this.instanceCount > 0) {
            pass.setPipeline(this.nodePipeline);
            pass.setBindGroup(0, this.bindGroup);
            pass.setVertexBuffer(0, this.quadBuf);
            pass.setVertexBuffer(1, this.instanceBuf);
            pass.draw(6, this.instanceCount);
        }
        pass.end();
        this.device.queue.submit([enc.finish()]);
        const encEnd = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return encEnd - encStart;
    }

    /** Start the rAF render loop, reporting smoothed FPS + encode-ms via onFrameStats. */
    start(): void {
        if (this.raf) return;
        const loop = () => {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const enc = this.renderOnce();
            if (this.lastFrameT) {
                const dt = now - this.lastFrameT;
                const fps = dt > 0 ? 1000 / dt : 0;
                this.emaFps = this.emaFps ? this.emaFps * 0.9 + fps * 0.1 : fps;
                this.emaEnc = this.emaEnc ? this.emaEnc * 0.9 + enc * 0.1 : enc;
                this.onStats?.({ fps: this.emaFps, encodeMs: this.emaEnc });
            }
            this.lastFrameT = now;
            this.raf = requestAnimationFrame(loop);
        };
        this.raf = requestAnimationFrame(loop);
    }

    stop(): void {
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
    }

    dispose(): void {
        this.stop();
        this.instanceBuf?.destroy();
        this.edgeBuf?.destroy();
        this.quadBuf.destroy();
        this.uniformBuf.destroy();
        try { this.ctx.unconfigure(); } catch { /* already gone */ }
    }
}
