/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WEBGL SURFACE — hand-rolled WebGL2 displacement-surface renderer (no deps).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A reusable surface-mesh engine shared by CascadeExplorer (correction stages)
 * and LensProfile3D (PSF FWHM / ellipticity / vignette). It renders an N×N
 * height field as a lit, ramp-coloured surface with:
 *   - drag-to-rotate (yaw/pitch) + wheel / pinch zoom,
 *   - a GPU morph between two fields (mix on the height attribute → the "money
 *     shot" animated step between cascade stages), and
 *   - derivative-based surface shading (WebGL2 dFdx/dFdy — no normal buffer, so
 *     the shading updates for free through the morph).
 *
 * Colours come entirely from the injected palette (design-system tokens); no
 * hardcoded hex. Pure render — it draws a numeric grid it is handed and asserts
 * nothing about pixels or coordinates.
 */

import type { CascadePalette, RGB } from './tokens';

// ─── tiny mat4 (column-major) ─────────────────────────────────────────────────

type Mat4 = Float32Array;

function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/** lookAt view matrix. */
function mat4LookAt(eye: number[], center: number[], up: number[]): Mat4 {
  const z = norm3(sub3(eye, center));
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  const m = mat4Identity();
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -dot3(x, eye);
  m[13] = -dot3(y, eye);
  m[14] = -dot3(z, eye);
  return m;
}

const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm3(a: number[]): number[] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

// ─── shaders (GLSL ES 3.00) ───────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 aXY;            // plane position in [-1,1]
in float aZA;           // normalized height, field A (0..1)
in float aZB;           // normalized height, field B (0..1)
uniform float uMorph;   // 0 → A, 1 → B
uniform float uZScale;  // vertical exaggeration
uniform mat4 uMVP;
out float vT;           // morphed normalized height (for the ramp)
out vec3 vWorld;
void main() {
  float z = mix(aZA, aZB, uMorph);
  vec3 world = vec3(aXY.x, z * uZScale, aXY.y);  // y is up (height)
  vT = z;
  vWorld = world;
  gl_Position = uMVP * vec4(world, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in float vT;
in vec3 vWorld;
uniform vec3 uRamp[5];
uniform vec3 uLightDir;
uniform float uAlpha;
out vec4 frag;
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  float i = floor(t);
  float f = t - i;
  int idx = int(i);
  vec3 a = uRamp[0]; vec3 b = uRamp[1];
  if (idx == 1) { a = uRamp[1]; b = uRamp[2]; }
  else if (idx == 2) { a = uRamp[2]; b = uRamp[3]; }
  else if (idx >= 3) { a = uRamp[3]; b = uRamp[4]; }
  return mix(a, b, f);
}
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float lambert = 0.42 + 0.58 * max(0.0, abs(dot(n, normalize(uLightDir))));
  vec3 base = ramp(vT);
  frag = vec4(base * lambert, uAlpha);
}`;

const LINE_VERT = `#version 300 es
in vec2 aXY;
in float aZA;
in float aZB;
uniform float uMorph;
uniform float uZScale;
uniform mat4 uMVP;
void main() {
  float z = mix(aZA, aZB, uMorph);
  gl_Position = uMVP * vec4(aXY.x, z * uZScale, aXY.y, 1.0);
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uAlpha;
out vec4 frag;
void main() { frag = vec4(uColor, uAlpha); }`;

// ─── field shape (mirror of cascade_math.DisplacementField, kept dep-free) ────

export interface SurfaceField {
  n: number;
  dz: Float32Array | number[];
  max: number;
}

interface CamState {
  yaw: number;
  pitch: number;
  radius: number;
}

/** Compile a shader or throw with the info log. */
function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader compile failed: ' + log);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('program link failed: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

/**
 * The reusable surface renderer. Construct with a canvas, then setGeometry once,
 * setPalette, setFields (A[/B]), and start(). Returns null-safe: if WebGL2 is
 * unavailable the constructor throws and the caller shows a fallback.
 */
export class SurfaceRenderer {
  readonly gl: WebGL2RenderingContext;
  private surfProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private xyBuf: WebGLBuffer;
  private zaBuf: WebGLBuffer;
  private zbBuf: WebGLBuffer;
  private triIdx: WebGLBuffer;
  private lineIdx: WebGLBuffer;
  private lineVao: WebGLVertexArrayObject;
  private nTri = 0;
  private nLine = 0;
  private n = 2;
  private palette: CascadePalette | null = null;
  private zRef = 1;
  private zScale = 0.5;
  private cam: CamState = { yaw: 0.7, pitch: 0.8, radius: 3.5 };
  /** Look-at height: aim slightly below the base so the (all-positive) surface
   *  sits vertically centred with bottom margin (no near-corner clipping). */
  private centerY = -0.15;
  private morph = 0;
  private raf = 0;
  private wireframe = true;
  private detachFns: Array<() => void> = [];

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.surfProg = link(gl, VERT, FRAG);
    this.lineProg = link(gl, LINE_VERT, LINE_FRAG);
    this.xyBuf = gl.createBuffer()!;
    this.zaBuf = gl.createBuffer()!;
    this.zbBuf = gl.createBuffer()!;
    this.triIdx = gl.createBuffer()!;
    this.lineIdx = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    this.lineVao = gl.createVertexArray()!;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  setPalette(p: CascadePalette): void {
    this.palette = p;
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
  }

  /** Vertical exaggeration of the normalized height (0..~1). */
  setZScale(z: number): void {
    this.zScale = z;
  }

  /** Build the N×N plane geometry + triangle / grid-line index buffers. */
  setGeometry(n: number): void {
    const gl = this.gl;
    this.n = n;
    const xy = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = (j * n + i) * 2;
        xy[k] = (i / (n - 1)) * 2 - 1;
        xy[k + 1] = (j / (n - 1)) * 2 - 1;
      }
    }
    // triangles
    const tris: number[] = [];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        tris.push(a, c, b, b, c, d);
      }
    }
    // grid lines (every other node to keep it readable)
    const lines: number[] = [];
    const step = Math.max(1, Math.round((n - 1) / 12));
    for (let j = 0; j < n; j += step) for (let i = 0; i < n - 1; i++) lines.push(j * n + i, j * n + i + 1);
    for (let i = 0; i < n; i += step) for (let j = 0; j < n - 1; j++) lines.push(j * n + i, (j + 1) * n + i);
    this.nTri = tris.length;
    this.nLine = lines.length;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.xyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, xy, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(tris), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(lines), gl.STATIC_DRAW);

    // Prime empty height buffers so the VAOs bind cleanly.
    const zeros = new Float32Array(n * n);
    for (const buf of [this.zaBuf, this.zbBuf]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, zeros, gl.DYNAMIC_DRAW);
    }
    this.bindVao(this.vao);
    this.bindVao(this.lineVao);
  }

  private bindVao(vao: WebGLVertexArrayObject): void {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.xyBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.zaBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.zbBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /**
   * Set the two morph endpoints (B defaults to A). `zRef` is the SHARED height
   * normalization (px) across all stages so surfaces stay comparable — a taller
   * surface is literally a larger displacement. Heights are uploaded as dz/zRef.
   */
  setFields(a: SurfaceField, b: SurfaceField | null, zRef: number): void {
    const gl = this.gl;
    this.zRef = zRef > 0 ? zRef : 1;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.zaBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.normalized(a), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.zbBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.normalized(b ?? a), gl.DYNAMIC_DRAW);
  }

  private normalized(f: SurfaceField): Float32Array {
    const out = new Float32Array(f.dz.length);
    const inv = 1 / this.zRef;
    for (let i = 0; i < f.dz.length; i++) out[i] = (f.dz[i] as number) * inv;
    return out;
  }

  setMorph(t: number): void {
    this.morph = Math.max(0, Math.min(1, t));
  }

  setCamera(yaw: number, pitch: number, radius: number): void {
    this.cam = { yaw, pitch, radius };
  }

  getCamera(): CamState {
    return { ...this.cam };
  }

  private mvp(): Mat4 {
    const { yaw, pitch, radius } = this.cam;
    const cp = Math.cos(pitch);
    const eye = [radius * cp * Math.sin(yaw), this.centerY + radius * Math.sin(pitch), radius * cp * Math.cos(yaw)];
    const view = mat4LookAt(eye, [0, this.centerY, 0], [0, 1, 0]);
    const w = this.canvas.width || 1;
    const h = this.canvas.height || 1;
    const proj = mat4Perspective(Math.PI / 4, w / h, 0.05, 100);
    return mat4Multiply(proj, view);
  }

  /** Render one frame. */
  render(): void {
    const gl = this.gl;
    const p = this.palette;
    if (!p) return;
    const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(p.background[0], p.background[1], p.background[2], 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const mvp = this.mvp();
    const ramp: number[] = [];
    for (const c of p.ramp) ramp.push(c[0], c[1], c[2]);

    // filled surface
    gl.useProgram(this.surfProg);
    this.setF(this.surfProg, 'uMorph', this.morph);
    this.setF(this.surfProg, 'uZScale', this.zScale);
    this.setF(this.surfProg, 'uAlpha', 0.96);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.surfProg, 'uMVP'), false, mvp);
    gl.uniform3fv(gl.getUniformLocation(this.surfProg, 'uRamp'), new Float32Array(ramp));
    gl.uniform3f(gl.getUniformLocation(this.surfProg, 'uLightDir'), 0.4, 0.85, 0.35);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.triIdx);
    gl.drawElements(gl.TRIANGLES, this.nTri, gl.UNSIGNED_INT, 0);

    // wireframe overlay
    if (this.wireframe) {
      gl.useProgram(this.lineProg);
      this.setF(this.lineProg, 'uMorph', this.morph);
      this.setF(this.lineProg, 'uZScale', this.zScale);
      this.setF(this.lineProg, 'uAlpha', 0.18);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uMVP'), false, mvp);
      const g = p.gridStrong;
      gl.uniform3f(gl.getUniformLocation(this.lineProg, 'uColor'), g[0], g[1], g[2]);
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIdx);
      gl.drawElements(gl.LINES, this.nLine, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }

  private setF(prog: WebGLProgram, name: string, v: number): void {
    this.gl.uniform1f(this.gl.getUniformLocation(prog, name), v);
  }

  /** RAF loop. */
  start(): void {
    if (this.raf) return;
    const loop = () => {
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Attach drag-to-rotate + wheel/pinch zoom to the canvas. */
  attachControls(): void {
    const el = this.canvas;
    let dragging = false;
    let lx = 0;
    let ly = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      this.cam.yaw -= dx * 0.008;
      this.cam.pitch = Math.max(-1.35, Math.min(1.45, this.cam.pitch + dy * 0.008));
    };
    const up = (e: PointerEvent) => {
      dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.cam.radius = Math.max(1.4, Math.min(8, this.cam.radius * (1 + Math.sign(e.deltaY) * 0.08)));
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    this.detachFns.push(() => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    });
  }

  dispose(): void {
    this.stop();
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    const gl = this.gl;
    gl.deleteBuffer(this.xyBuf);
    gl.deleteBuffer(this.zaBuf);
    gl.deleteBuffer(this.zbBuf);
    gl.deleteBuffer(this.triIdx);
    gl.deleteBuffer(this.lineIdx);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteProgram(this.surfProg);
    gl.deleteProgram(this.lineProg);
  }
}

/** Convenience: pack a palette ramp for a legend swatch (CSS rgb strings). */
export function rampToCss(ramp: RGB[]): string[] {
  return ramp.map((c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`);
}
