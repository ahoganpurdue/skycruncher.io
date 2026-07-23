#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// CAPTURE CASCADE — standalone harness: render the 3D Flattening Cascade + Lens
// Profile widgets into a self-contained HTML (real receipt data, everything
// inline) and screenshot it via Playwright chromium.
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/widgets/capture_cascade.mjs [<receipt.json>]
//
// Default receipt = the M66 SeeStar solve (post-TPS: carries sip + tps; the
// Brown-Conrady stages are honest-absent for a telescope — the CORRECT thing to
// show). Produces:
//   test_results/widget_review/cascade/cascade_review.html   (self-contained)
//   test_results/widget_review/cascade/cascade_m66.png       (TPS stage, hero)
//   test_results/widget_review/cascade/cascade_stages.png    (SIP stage + greyed BC)
//   test_results/widget_review/cascade/lens_profile.png      (FWHM field surface)
//
// The inline JS carries a plain-JS MIRROR of src/.../cascade/cascade_math.ts
// (no bundler/tsx exists to import the TS into the HTML). The MATH is pinned by
// src/engine/tests/cascade_math.test.ts; the WebGL renderer mirrors
// webgl_surface.ts. Keep them in sync.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(ROOT, 'test_results', 'widget_review', 'cascade');
const RECEIPT_DEFAULT = path.join(
  OUT_DIR, 'receipts', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.receipt.json',
);
const GRID_N = 64;

// ─── plain-JS math mirror of cascade_math.ts (pinned by the vitest test) ──────

function tpsKernel(du, dv) {
  const r2 = du * du + dv * dv;
  if (r2 <= 0) return 0;
  return 0.5 * r2 * Math.log(r2);
}
function evalTpsField(u, v, un, vn, w, affine) {
  let s = affine[0] + affine[1] * u + affine[2] * v;
  for (let i = 0; i < un.length; i++) s += w[i] * tpsKernel(u - un[i], v - vn[i]);
  return s;
}
function polySum(coeff, u, v) {
  let s = 0, up = 1;
  for (let p = 0; p < coeff.length; p++) {
    const row = coeff[p];
    if (Array.isArray(row)) {
      let vq = 1;
      for (let q = 0; q < row.length; q++) {
        const c = row[q];
        if (typeof c === 'number' && Number.isFinite(c)) s += c * up * vq;
        vq *= v;
      }
    }
    up *= u;
  }
  return s;
}
function sipDisp(x, y, a, b, cx, cy) {
  const u = x - cx, v = y - cy;
  return [polySum(a, u, v), polySum(b, u, v)];
}
function tpsDisp(x, y, tps) {
  const u = x - tps.crpix[0], v = y - tps.crpix[1];
  const uN = u / tps.scale, vN = v / tps.scale;
  const un = tps.control_points.map((p) => p[0]);
  const vn = tps.control_points.map((p) => p[1]);
  return [
    evalTpsField(uN, vN, un, vn, tps.weights_x, tps.affine.dx),
    evalTpsField(uN, vN, un, vn, tps.weights_y, tps.affine.dy),
  ];
}
// Brown-Conrady native→corrected radial inverse (faithful mirror).
function bcDisp(x, y, k1, k2, w, h) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2, hd = Math.hypot(cx, cy), invHd = 1 / hd;
  const dx = (x - cx) * invHd, dy = (y - cy) * invHd;
  const rd = Math.hypot(dx, dy);
  let ru = rd;
  for (let i = 0; i < 10; i++) {
    const f = 1 + k1 * ru * ru + k2 * ru * ru * ru * ru;
    ru = f > 1e-6 ? rd / f : rd;
  }
  const s = rd > 1e-12 ? ru / rd : 1;
  return [cx + dx * s * hd - x, cy + dy * s * hd - y];
}
function buildField(n, w, h, fn) {
  const dz = new Array(n * n);
  let max = 0, sumSq = 0;
  for (let j = 0; j < n; j++) {
    const y = (j / (n - 1)) * (h - 1);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (w - 1);
      const [du, dv] = fn(x, y);
      const mag = Math.hypot(du, dv);
      dz[j * n + i] = mag;
      if (mag > max) max = mag;
      sumSq += mag * mag;
    }
  }
  return { dz, max, rms: Math.sqrt(sumSq / (n * n)) };
}
function vignetteGainAt(r, v1) { return 1 + v1 * r * r; }
function sample3x3(vals, fx, fy) {
  const cx = Math.max(0, Math.min(2, fx * 3 - 0.5)), cy = Math.max(0, Math.min(2, fy * 3 - 0.5));
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(2, x0 + 1), y1 = Math.min(2, y0 + 1);
  const tx = cx - x0, ty = cy - y0, at = (c, r) => vals[r * 3 + c];
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bot = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bot * ty;
}
function fillNulls(vals) {
  const present = vals.filter((v) => v != null);
  if (!present.length) return null;
  const med = [...present].sort((a, b) => a - b)[Math.floor(present.length / 2)];
  return vals.map((v) => (v != null ? v : med));
}

// ─── build the embedded model from a receipt ──────────────────────────────────

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function buildModel(receipt, label) {
  const width = num(receipt?.metadata?.width) ?? num(receipt?.scales?.sensor_width);
  const height = num(receipt?.metadata?.height) ?? num(receipt?.scales?.sensor_height);
  if (width == null || height == null) throw new Error('receipt has no frame geometry');
  const wcs = receipt.wcs ?? {};
  const cx = num(wcs.CRPIX1) ?? (width - 1) / 2, cy = num(wcs.CRPIX2) ?? (height - 1) / 2;
  const astro = receipt.solution?.astrometry ?? {};

  const readBc = (blk) => {
    if (!blk) return null;
    const k1 = num(blk.k1), k2 = num(blk.k2);
    if (k1 == null && k2 == null) return null;
    return { k1: k1 ?? 0, k2: k2 ?? 0 };
  };
  const nomBc = readBc(receipt.hardware?.lens_distortion_nominal ?? receipt.solution?.lens_distortion_nominal ?? receipt.hardware?.lens_prior);
  const measBc = readBc(receipt.solution?.lens_distortion_measured);
  const sip = astro.sip && Array.isArray(astro.sip.a) && Array.isArray(astro.sip.b) ? astro.sip : null;
  const tpsRaw = astro.tps;
  const tps = tpsRaw && Array.isArray(tpsRaw.control_points) && num(tpsRaw.scale) > 0
    ? { scale: tpsRaw.scale, crpix: Array.isArray(tpsRaw.crpix) ? tpsRaw.crpix : [cx, cy], control_points: tpsRaw.control_points, weights_x: tpsRaw.weights_x, weights_y: tpsRaw.weights_y, affine: tpsRaw.affine }
    : null;

  const specs = [
    { id: 'original', label: 'Original', present: true, reason: '', prov: 'identity (no correction)', field: buildField(GRID_N, width, height, () => [0, 0]) },
    { id: 'nominal_bc', label: 'Nominal BC', present: !!nomBc, reason: 'no trusted lens prior (LENS_DB) resolved', prov: nomBc ? `k1=${nomBc.k1}, k2=${nomBc.k2}` : 'NOT MEASURED', field: nomBc ? buildField(GRID_N, width, height, (x, y) => bcDisp(x, y, nomBc.k1, nomBc.k2, width, height)) : null },
    { id: 'measured_bc', label: 'Measured BC', present: !!measBc, reason: 'no per-copy Brown-Conrady refit on this frame', prov: measBc ? `k1=${measBc.k1}, k2=${measBc.k2}` : 'NOT MEASURED', field: measBc ? buildField(GRID_N, width, height, (x, y) => bcDisp(x, y, measBc.k1, measBc.k2, width, height)) : null },
    { id: 'sip', label: 'SIP', present: !!sip, reason: 'no SIP fit (well-corrected optics)', prov: sip ? `order ${sip.a_order ?? '?'}` : 'NOT MEASURED', field: sip ? buildField(GRID_N, width, height, (x, y) => sipDisp(x, y, sip.a, sip.b, cx, cy)) : null },
    { id: 'tps', label: 'TPS', present: !!tps, reason: 'no thin-plate-spline fit', prov: tps ? `${tps.control_points.length} pts` + (num(tpsRaw.rms_after_arcsec) != null ? ` · rms ${tpsRaw.rms_after_arcsec.toFixed(2)}"` : '') : 'NOT MEASURED', field: tps ? buildField(GRID_N, width, height, (x, y) => tpsDisp(x, y, tps)) : null },
  ];
  const zRef = Math.max(...specs.filter((s) => s.present && s.field).map((s) => s.field.max), 1e-9);
  const cascade = {
    label, width, height, zRef,
    stages: specs.map((s) => ({
      id: s.id, label: s.label, present: s.present, reason: s.reason, prov: s.prov,
      max: s.field ? s.field.max : 0, rms: s.field ? s.field.rms : 0,
      dzNorm: s.field ? s.field.dz.map((v) => +(v / zRef).toFixed(4)) : new Array(GRID_N * GRID_N).fill(0),
    })),
  };

  // lens profile
  const pf = receipt.psf_field;
  let lens = null;
  if (pf && pf.method !== 'NOT_MEASURED' && pf.fwhm_median_maj_px != null) {
    const regions = Array.isArray(pf.regions) ? pf.regions : [];
    const fwhm = fillNulls(Array.from({ length: 9 }, (_, i) => num(regions[i]?.fwhmMedianPx)));
    const ellip = fillNulls(Array.from({ length: 9 }, (_, i) => num(regions[i]?.ellipticityMedian)));
    const v1 = num(receipt.hardware?.vignette_v1);
    const cxp = (width - 1) / 2, cyp = (height - 1) / 2, hd = Math.hypot(cxp, cyp);
    const surfs = [
      fwhm && { id: 'fwhm', label: 'FWHM', unit: 'px', median: num(pf.fwhm_median_maj_px), note: 'coarse 3×3 region map, bilinear', field: buildField(GRID_N, width, height, (x, y) => [sample3x3(fwhm, x / (width - 1), y / (height - 1)), 0]) },
      ellip && { id: 'ellipticity', label: 'Ellipticity', unit: '', median: num(pf.ellipticity_median), note: 'coarse 3×3 region map, bilinear', field: buildField(GRID_N, width, height, (x, y) => [sample3x3(ellip, x / (width - 1), y / (height - 1)), 0]) },
      v1 != null && { id: 'vignette', label: 'Vignette', unit: '|I(r)−1|', median: v1, note: 'radial model I(r)=1+v₁r²', field: buildField(GRID_N, width, height, (x, y) => [Math.abs(vignetteGainAt(Math.hypot(x - cxp, y - cyp) / hd, v1) - 1), 0]) },
    ].filter(Boolean);
    lens = {
      method: String(pf.method), nFit: num(pf.n_fit) ?? 0,
      surfaces: surfs.map((s) => ({ id: s.id, label: s.label, unit: s.unit, median: s.median, note: s.note, max: s.field.max, rms: s.field.rms, dzNorm: s.field.dz.map((v) => +(v / (s.field.max || 1)).toFixed(4)) })),
    };
  }
  return { cascade, lens };
}

// ─── HTML template (self-contained: inline tokens + vanilla WebGL2 renderer) ──

function buildHtml(model) {
  const dataJson = JSON.stringify(model);
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Flattening Cascade — widget review</title>
<style>
:root{
  --color-space-950:#05060a; --color-space-900:#0a0c12; --color-space-850:#0e1118; --color-space-800:#131722;
  --color-line-subtle:#1c2230; --color-line:#2a3245; --color-line-strong:#3d4763;
  --color-text-primary:#e8ecf4; --color-text-secondary:#9aa5bd; --color-text-muted:#6a7792; --color-text-faint:#3d4763;
  --color-accent-400:#38bdf8; --color-accent-glow:#0ea5e91f; --color-data:#c7d5f0; --color-solve:#34d399; --color-warn:#fbbf24;
  --chart-seq-1:#0b2942; --chart-seq-2:#0e4a6e; --chart-seq-3:#0e7fb0; --chart-seq-4:#38bdf8; --chart-seq-5:#bae6fd; --chart-cat-4:#a78bfa;
  --font-mono:"JetBrains Mono","Cascadia Code","Consolas",ui-monospace,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--color-space-950);color:var(--color-text-primary);font-family:var(--font-mono);padding:22px;}
.wrap{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start;}
.widget{width:640px;background:var(--color-space-850);border:1px solid var(--color-line);border-radius:10px;padding:16px;}
.hdr{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:8px;}
.title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.16em;color:var(--color-text-muted);}
.meta{font-size:10px;color:var(--color-text-muted);}
.stage-canvas-wrap{position:relative;width:100%;height:360px;border:1px solid var(--color-line);border-radius:6px;overflow:hidden;background:var(--color-space-900);}
canvas{width:100%;height:100%;display:block;cursor:grab;}
.legend{position:absolute;right:8px;top:8px;display:flex;flex-direction:column;align-items:flex-end;gap:3px;pointer-events:none;}
.ramp{width:12px;height:96px;border-radius:3px;background:linear-gradient(to top,var(--chart-seq-1),var(--chart-seq-2),var(--chart-seq-3),var(--chart-seq-4),var(--chart-seq-5));}
.leg-lbl{font-size:9px;color:var(--color-text-muted);}
.nm{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;}
.nm-box{background:rgba(10,12,18,.72);border:1px solid var(--color-line);border-radius:6px;padding:8px 14px;text-align:center;}
.nm-title{color:var(--color-warn);font-size:14px;font-weight:700;letter-spacing:.08em;}
.nm-reason{color:var(--color-text-muted);font-size:10px;margin-top:4px;}
.readout{display:flex;flex-wrap:wrap;gap:4px 20px;font-size:11px;color:var(--color-text-muted);margin:8px 0;min-height:16px;}
.readout b{color:var(--color-data);font-weight:400;}
.tabs{display:flex;gap:4px;flex-wrap:wrap;}
.tab{font-size:10px;padding:4px 8px;border-radius:5px;border:1px solid var(--color-line);color:var(--color-text-muted);background:none;cursor:pointer;font-family:var(--font-mono);}
.tab.active{border-color:var(--color-accent-400);color:var(--color-data);background:var(--color-accent-glow);}
.tab.absent{color:var(--color-text-faint);opacity:.6;}
.tab .idx{color:var(--color-text-faint);margin-right:5px;}
.tab .empty{color:var(--color-warn);font-size:8px;vertical-align:top;margin-left:3px;}
.hint{font-size:9px;color:var(--color-text-muted);margin-top:6px;}
.warn{color:var(--color-warn);}
</style></head>
<body>
<div class="wrap">
  <div class="widget" id="cascadeWidget">
    <div class="hdr"><div class="title">Flattening Cascade — displacement surface</div><div class="meta" id="cascadeMeta"></div></div>
    <div class="stage-canvas-wrap"><canvas id="cascadeCanvas"></canvas>
      <div class="legend"><div class="ramp"></div><div class="leg-lbl">px</div></div>
      <div class="nm" id="cascadeNm" style="display:none"><div class="nm-box"><div class="nm-title">NOT MEASURED</div><div class="nm-reason" id="cascadeNmReason"></div></div></div>
    </div>
    <div class="readout" id="cascadeReadout"></div>
    <div class="tabs" id="cascadeTabs"></div>
    <div class="hint">drag to rotate · scroll to zoom · ∅ = NOT MEASURED · height &amp; colour = |displacement| (shared scale)</div>
  </div>

  <div class="widget" id="lensWidget">
    <div class="hdr"><div class="title">Lens Profile — optical field surface</div><div class="meta" id="lensMeta"></div></div>
    <div class="stage-canvas-wrap" style="height:320px"><canvas id="lensCanvas"></canvas>
      <div class="legend"><div class="ramp"></div><div class="leg-lbl" id="lensUnit"></div></div>
      <div class="nm" id="lensNm" style="display:none"><div class="nm-box"><div class="nm-title">NOT MEASURED</div><div class="nm-reason" id="lensNmReason"></div></div></div>
    </div>
    <div class="readout" id="lensReadout"></div>
    <div class="tabs" id="lensTabs"></div>
    <div class="hint">drag to rotate · scroll to zoom · ∅ = NOT MEASURED</div>
  </div>
</div>

<script>
const MODEL = ${dataJson};
const N = ${GRID_N};

// ── vanilla mirror of webgl_surface.ts (WebGL2) ──
const VERT=\`#version 300 es
in vec2 aXY; in float aZA; in float aZB; uniform float uMorph,uZScale; uniform mat4 uMVP; out float vT; out vec3 vWorld;
void main(){ float z=mix(aZA,aZB,uMorph); vec3 w=vec3(aXY.x,z*uZScale,aXY.y); vT=z; vWorld=w; gl_Position=uMVP*vec4(w,1.0);}\`;
const FRAG=\`#version 300 es
precision highp float; in float vT; in vec3 vWorld; uniform vec3 uRamp[5]; uniform vec3 uLightDir; uniform float uAlpha; out vec4 frag;
vec3 ramp(float t){t=clamp(t,0.0,1.0)*4.0; float i=floor(t); float f=t-i; int idx=int(i); vec3 a=uRamp[0],b=uRamp[1];
 if(idx==1){a=uRamp[1];b=uRamp[2];} else if(idx==2){a=uRamp[2];b=uRamp[3];} else if(idx>=3){a=uRamp[3];b=uRamp[4];} return mix(a,b,f);}
void main(){ vec3 n=normalize(cross(dFdx(vWorld),dFdy(vWorld))); float lam=0.42+0.58*max(0.0,abs(dot(n,normalize(uLightDir)))); frag=vec4(ramp(vT)*lam,uAlpha);}\`;
const LVERT=\`#version 300 es
in vec2 aXY; in float aZA; in float aZB; uniform float uMorph,uZScale; uniform mat4 uMVP;
void main(){ float z=mix(aZA,aZB,uMorph); gl_Position=uMVP*vec4(aXY.x,z*uZScale,aXY.y,1.0);}\`;
const LFRAG=\`#version 300 es
precision highp float; uniform vec3 uColor; uniform float uAlpha; out vec4 frag; void main(){ frag=vec4(uColor,uAlpha);}\`;

function hex(name){ const v=getComputedStyle(document.documentElement).getPropertyValue(name).trim()||'#888'; let h=v.replace('#',''); if(h.length===3)h=h.split('').map(c=>c+c).join(''); const n=parseInt(h.slice(0,6),16); return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255]; }
function palette(){ return { ramp:[hex('--chart-seq-1'),hex('--chart-seq-2'),hex('--chart-seq-3'),hex('--chart-seq-4'),hex('--chart-seq-5')], bg:hex('--color-space-900'), gridStrong:hex('--color-line-strong') }; }

function perspective(fovy,aspect,near,far){const f=1/Math.tan(fovy/2),nf=1/(near-far),m=new Float32Array(16);m[0]=f/aspect;m[5]=f;m[10]=(far+near)*nf;m[11]=-1;m[14]=2*far*near*nf;return m;}
function mul(a,b){const o=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];return o;}
function look(eye,ctr,up){const s3=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],d3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],c3=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],nn=a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];};
 const z=nn(s3(eye,ctr)),x=nn(c3(up,z)),y=c3(z,x),m=new Float32Array(16);m[15]=1;m[0]=x[0];m[4]=x[1];m[8]=x[2];m[1]=y[0];m[5]=y[1];m[9]=y[2];m[2]=z[0];m[6]=z[1];m[10]=z[2];m[12]=-d3(x,eye);m[13]=-d3(y,eye);m[14]=-d3(z,eye);return m;}

function compile(gl,t,s){const sh=gl.createShader(t);gl.shaderSource(sh,s);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(sh));return sh;}
function link(gl,vs,fs){const p=gl.createProgram();gl.attachShader(p,compile(gl,gl.VERTEX_SHADER,vs));gl.attachShader(p,compile(gl,gl.FRAGMENT_SHADER,fs));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));return p;}

class Surface{
  constructor(canvas){ const gl=canvas.getContext('webgl2',{antialias:true,alpha:true,premultipliedAlpha:false}); if(!gl)throw new Error('WebGL2 unavailable'); this.canvas=canvas; this.gl=gl; this.sp=link(gl,VERT,FRAG); this.lp=link(gl,LVERT,LFRAG);
    this.xy=gl.createBuffer();this.za=gl.createBuffer();this.zb=gl.createBuffer();this.ti=gl.createBuffer();this.li=gl.createBuffer();this.vao=gl.createVertexArray();
    this.cam={yaw:0.7,pitch:0.8,radius:3.5}; this.centerY=-0.15; this.morph=0; this.zScale=0.5; this.pal=palette();
    gl.enable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA); this.geom(N); this.controls();
  }
  geom(n){const gl=this.gl;this.n=n;const xy=new Float32Array(n*n*2);for(let j=0;j<n;j++)for(let i=0;i<n;i++){const k=(j*n+i)*2;xy[k]=(i/(n-1))*2-1;xy[k+1]=(j/(n-1))*2-1;}
    const tris=[];for(let j=0;j<n-1;j++)for(let i=0;i<n-1;i++){const a=j*n+i,b=a+1,c=a+n,d=c+1;tris.push(a,c,b,b,c,d);}
    const lines=[];const st=Math.max(1,Math.round((n-1)/12));for(let j=0;j<n;j+=st)for(let i=0;i<n-1;i++)lines.push(j*n+i,j*n+i+1);for(let i=0;i<n;i+=st)for(let j=0;j<n-1;j++)lines.push(j*n+i,(j+1)*n+i);
    this.nTri=tris.length;this.nLine=lines.length;
    gl.bindBuffer(gl.ARRAY_BUFFER,this.xy);gl.bufferData(gl.ARRAY_BUFFER,xy,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.ti);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(tris),gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.li);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(lines),gl.STATIC_DRAW);
    const z0=new Float32Array(n*n);for(const b of[this.za,this.zb]){gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,z0,gl.DYNAMIC_DRAW);}
    gl.bindVertexArray(this.vao);gl.bindBuffer(gl.ARRAY_BUFFER,this.xy);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.za);gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,1,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.zb);gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,1,gl.FLOAT,false,0,0);gl.bindVertexArray(null);
  }
  setFields(a,b){const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,this.za);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(a),gl.DYNAMIC_DRAW);gl.bindBuffer(gl.ARRAY_BUFFER,this.zb);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(b||a),gl.DYNAMIC_DRAW);}
  mvp(){const{yaw,pitch,radius}=this.cam,cp=Math.cos(pitch);const eye=[radius*cp*Math.sin(yaw),this.centerY+radius*Math.sin(pitch),radius*cp*Math.cos(yaw)];const v=look(eye,[0,this.centerY,0],[0,1,0]);const w=this.canvas.width||1,h=this.canvas.height||1;return mul(perspective(Math.PI/4,w/h,0.05,100),v);}
  render(){const gl=this.gl,p=this.pal;const dpr=Math.min(2,window.devicePixelRatio||1);const cw=Math.max(1,Math.round(this.canvas.clientWidth*dpr)),ch=Math.max(1,Math.round(this.canvas.clientHeight*dpr));if(this.canvas.width!==cw||this.canvas.height!==ch){this.canvas.width=cw;this.canvas.height=ch;}
    gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);gl.clearColor(p.bg[0],p.bg[1],p.bg[2],0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    const mvp=this.mvp();const ramp=[];for(const c of p.ramp)ramp.push(c[0],c[1],c[2]);
    gl.useProgram(this.sp);gl.uniform1f(gl.getUniformLocation(this.sp,'uMorph'),this.morph);gl.uniform1f(gl.getUniformLocation(this.sp,'uZScale'),this.zScale);gl.uniform1f(gl.getUniformLocation(this.sp,'uAlpha'),0.96);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.sp,'uMVP'),false,mvp);gl.uniform3fv(gl.getUniformLocation(this.sp,'uRamp'),new Float32Array(ramp));gl.uniform3f(gl.getUniformLocation(this.sp,'uLightDir'),0.4,0.85,0.35);
    gl.bindVertexArray(this.vao);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.ti);gl.drawElements(gl.TRIANGLES,this.nTri,gl.UNSIGNED_INT,0);
    gl.useProgram(this.lp);gl.uniform1f(gl.getUniformLocation(this.lp,'uMorph'),this.morph);gl.uniform1f(gl.getUniformLocation(this.lp,'uZScale'),this.zScale);gl.uniform1f(gl.getUniformLocation(this.lp,'uAlpha'),0.18);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lp,'uMVP'),false,mvp);const g=p.gridStrong;gl.uniform3f(gl.getUniformLocation(this.lp,'uColor'),g[0],g[1],g[2]);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.li);gl.drawElements(gl.LINES,this.nLine,gl.UNSIGNED_INT,0);gl.bindVertexArray(null);
  }
  start(){const loop=()=>{this.render();this._raf=requestAnimationFrame(loop);};this._raf=requestAnimationFrame(loop);}
  controls(){const el=this.canvas;let drag=false,lx=0,ly=0;el.addEventListener('pointerdown',e=>{drag=true;lx=e.clientX;ly=e.clientY;});
    el.addEventListener('pointermove',e=>{if(!drag)return;this.cam.yaw-=(e.clientX-lx)*0.008;this.cam.pitch=Math.max(-1.35,Math.min(1.45,this.cam.pitch+(e.clientY-ly)*0.008));lx=e.clientX;ly=e.clientY;});
    window.addEventListener('pointerup',()=>{drag=false;});el.addEventListener('wheel',e=>{e.preventDefault();this.cam.radius=Math.max(1.4,Math.min(8,this.cam.radius*(1+Math.sign(e.deltaY)*0.08)));},{passive:false});}
}

// ── wire the two widgets ──
function mountCascade(){
  const c=MODEL.cascade; const s=new Surface(document.getElementById('cascadeCanvas')); s.start();
  document.getElementById('cascadeMeta').textContent='grid '+N+'×'+N+' · '+c.width+'×'+c.height+'px';
  const tabsEl=document.getElementById('cascadeTabs'), nm=document.getElementById('cascadeNm'), nmR=document.getElementById('cascadeNmReason'), ro=document.getElementById('cascadeReadout');
  let active=c.stages.map((st,i)=>({st,i})).filter(x=>x.st.present).pop().i, prev=active;
  function draw(){const st=c.stages[active];
    if(st.present){nm.style.display='none';ro.innerHTML='<span>STAGE <b>'+st.label+'</b></span><span>MAX Δ <b>'+st.max.toFixed(3)+' px</b></span><span>RMS Δ <b>'+st.rms.toFixed(3)+' px</b></span><span>'+st.prov+'</span>';}
    else{nm.style.display='grid';nmR.textContent=st.reason;ro.innerHTML='<span class="warn">'+st.label+' — NOT MEASURED ('+st.reason+')</span>';}
    [...tabsEl.children].forEach((b,i)=>{b.className='tab'+(i===active?' active':'')+(c.stages[i].present?'':' absent');});
  }
  c.stages.forEach((st,i)=>{const b=document.createElement('button');b.className='tab';b.innerHTML='<span class="idx">'+i+'</span>'+st.label+(st.present?'':'<span class="empty">∅</span>');b.onclick=()=>{prev=active;active=i;morphTo(i);};tabsEl.appendChild(b);});
  function setStageImmediate(i){active=i;prev=i;s.setFields(c.stages[i].dzNorm,c.stages[i].dzNorm);s.morph=0;draw();}
  function morphTo(i){const from=c.stages[prev],to=c.stages[i];s.setFields(from.dzNorm,to.dzNorm);const t0=Date.now();const tick=()=>{const p=Math.min(1,(Date.now()-t0)/720);const e=p<0.5?2*p*p:1-Math.pow(-2*p+2,2)/2;s.morph=e;if(p<1)requestAnimationFrame(tick);else{s.setFields(to.dzNorm,to.dzNorm);s.morph=0;prev=i;}};requestAnimationFrame(tick);draw();}
  setStageImmediate(active);
  window.__cascade={setStage:setStageImmediate,morphTo,surface:s,count:c.stages.length};
}
function mountLens(){
  const L=MODEL.lens; const w=document.getElementById('lensWidget');
  if(!L||!L.surfaces.length){ w.style.display='none'; window.__lens={present:false}; return; }
  const s=new Surface(document.getElementById('lensCanvas')); s.start();
  document.getElementById('lensMeta').textContent=L.method+' · n='+L.nFit;
  const tabsEl=document.getElementById('lensTabs'), ro=document.getElementById('lensReadout'), unit=document.getElementById('lensUnit');
  const surfs=L.surfaces.concat([{id:'defects',label:'Defects',present:false,reason:'future — hot-pixel / defect mapping not yet implemented'}]);
  let active=0;
  function draw(){const st=surfs[active];unit.textContent=st.unit||'';
    if(st.present!==false && st.dzNorm){document.getElementById('lensNm').style.display='none';ro.innerHTML='<span>SURFACE <b>'+st.label+'</b></span><span>MEDIAN <b>'+(st.median!=null?st.median.toFixed(3):'—')+' '+st.unit+'</b></span><span>PEAK <b>'+st.max.toFixed(3)+' '+st.unit+'</b></span><span>'+st.note+'</span>';}
    else{document.getElementById('lensNm').style.display='grid';document.getElementById('lensNmReason').textContent=st.reason;ro.innerHTML='<span class="warn">'+st.label+' — NOT MEASURED ('+st.reason+')</span>';}
    [...tabsEl.children].forEach((b,i)=>{b.className='tab'+(i===active?' active':'')+((surfs[i].present===false)?' absent':'');});
  }
  surfs.forEach((st,i)=>{const b=document.createElement('button');b.className='tab';b.innerHTML=st.label+((st.present===false)?'<span class="empty">∅</span>':'');b.onclick=()=>setSurf(i);tabsEl.appendChild(b);});
  function setSurf(i){active=i;const st=surfs[i];if(st.dzNorm){s.setFields(st.dzNorm,st.dzNorm);}else{s.setFields(new Array(N*N).fill(0),new Array(N*N).fill(0));}s.morph=0;draw();}
  setSurf(0);
  window.__lens={present:true,setSurf,count:surfs.length};
}
try{ mountCascade(); mountLens(); window.__ready=true; }catch(e){ window.__err=String(e&&e.message||e); document.body.insertAdjacentHTML('beforeend','<pre style="color:#f87171">'+String(e)+'</pre>'); }
</script></body></html>`;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const receiptPath = process.argv[2] || RECEIPT_DEFAULT;
  if (!fs.existsSync(receiptPath)) { console.error('receipt not found:', receiptPath); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const label = path.basename(receiptPath).replace(/\.receipt\.json$/, '');
  const model = buildModel(receipt, label);

  // report the real per-stage numbers to stdout (honest provenance).
  console.log('[capture_cascade] receipt:', label);
  for (const st of model.cascade.stages) console.log(`  cascade ${st.label.padEnd(12)} present=${st.present} max=${st.max.toFixed(3)}px rms=${st.rms.toFixed(3)}px  (${st.prov})`);
  if (model.lens) for (const s of model.lens.surfaces) console.log(`  lens    ${s.label.padEnd(12)} peak=${s.max.toFixed(3)}${s.unit} median=${s.median != null ? s.median.toFixed(3) : '—'}`);
  else console.log('  lens    NOT MEASURED (no psf_field)');

  const html = buildHtml(model);
  const htmlPath = path.join(OUT_DIR, 'cascade_review.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('[capture_cascade] html →', htmlPath);

  const browser = await chromium.launch({
    channel: process.env.CAPTURE_BROWSER_CHANNEL || 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
  });
  const page = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 }).then((c) => c.newPage());
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page-error]', m.text()); });
  await page.goto('file://' + htmlPath.replace(/\\/g, '/'));
  await page.waitForFunction(() => window.__ready === true || window.__err, null, { timeout: 20000 });
  const err = await page.evaluate(() => window.__err || null);
  if (err) { console.error('[capture_cascade] page error:', err); await browser.close(); process.exit(1); }
  await page.waitForTimeout(500); // let the first frames + shading settle

  const shots = [];
  // 1. cascade hero — deepest present stage (TPS).
  const lastPresent = model.cascade.stages.map((s, i) => ({ s, i })).filter((x) => x.s.present).pop().i;
  await page.evaluate((i) => window.__cascade.setStage(i), lastPresent);
  await page.waitForTimeout(400);
  await page.locator('#cascadeWidget').screenshot({ path: path.join(OUT_DIR, 'cascade_m66.png') });
  shots.push('cascade_m66.png');

  // 2. cascade stages — SIP stage (shows greyed BC tabs + a different surface).
  const sipIdx = model.cascade.stages.findIndex((s) => s.id === 'sip' && s.present);
  if (sipIdx >= 0) { await page.evaluate((i) => window.__cascade.setStage(i), sipIdx); await page.waitForTimeout(400); }
  await page.locator('#cascadeWidget').screenshot({ path: path.join(OUT_DIR, 'cascade_stages.png') });
  shots.push('cascade_stages.png');

  // 3. lens profile — FWHM surface.
  const lensOk = await page.evaluate(() => window.__lens && window.__lens.present);
  if (lensOk) {
    await page.evaluate(() => window.__lens.setSurf(0));
    await page.waitForTimeout(400);
    await page.locator('#lensWidget').screenshot({ path: path.join(OUT_DIR, 'lens_profile.png') });
    shots.push('lens_profile.png');
  } else {
    console.log('[capture_cascade] lens NOT MEASURED — no lens_profile.png');
  }

  await browser.close();
  console.log('[capture_cascade] screenshots →', shots.join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
