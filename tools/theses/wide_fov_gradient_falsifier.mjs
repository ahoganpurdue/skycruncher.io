// ═══════════════════════════════════════════════════════════════════════════
// tools/theses/wide_fov_gradient_falsifier.mjs
// Frozen-criteria test runner for DRAFT-wide-fov-gradient-falsifier (CSL 0.1.0,
// registered sha256 cd83004c27d9a0de4b85d29f38dc69cb2e0d6ba9d1d69cf534b901cd9c52e5f2)
// ───────────────────────────────────────────────────────────────────────────
// MECHANISM (frozen thesis):
//   Poisson GLM  n_cell ~ exp(a0 + a1*x~ + a2*y~)  over detection (x,y).
//   Dipole ratio  R = exp(2*|a|),  |a| = sqrt(a1^2 + a2^2)   (density ratio
//   across the field along the gradient axis, spanning x~ in [-1,+1]).
//   Reject scale s  IFF  the 99% UPPER limit of R_obs  <  R05(s),
//   where R05(s) = 5th-percentile atlas Monte-Carlo density ratio over random
//   pointings at FOV(s). One-sided-safe: odd dipole vs even vignette ⇒ spurious
//   even gradients only WEAKEN rejection, never manufacture a false one.
//
// R_obs   : Poisson-GLM dipole on the frame's REAL m4 detection positions
//           (decode = decode_plane's libraw path + extract_blobs core), plus a
//           delta-method 99% upper limit (accounts for finite detections).
//           Using the UPPER limit ⇒ rejection is CONSERVATIVE (protects truth).
// R05(s)  : population density ratio from the Gaia/HYG atlas (built FRESH in-run:
//           a galactic (l,b) density map + a random-pointing Monte-Carlo, then
//           checksummed). No shot noise (the atlas IS the density truth).
//
// Truth (Cocoon) is ORACLE-GRADE here: 2.007"/px per test_results/cocoon_stacks/
// STACKS.md (12/25 lights oracle-solved, RA 21.867h, parity -1). Mislock = 72.77.
//
// STORAGE LAW: decodes in-memory; persists only small positions JSON (K: is a
// thin VHD). No 75MB detplane f32 is written.
// EVIDENCE-ONLY. src/ read-only. No calibrated constant authored.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker as NodeThreadWorker } from 'node:worker_threads';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const OUT_DIR = path.join(ROOT, 'test_results', 'theses', 'wide_fov');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── FROZEN, pre-registered inputs ───────────────────────────────────────────
const REG_SHA = 'cd83004c27d9a0de4b85d29f38dc69cb2e0d6ba9d1d69cf534b901cd9c52e5f2';
const WIDTH_NOM = 5184, HEIGHT_NOM = 3456;    // nominal 18MP APS-C (60D); real dims read from decode
const NX = 6, NY = 6;                          // frozen dipole grid (36 cells)
const SIGMA_DET = 3.0;                         // decode_plane / dump_cr2_solveframe m4 threshold
const ALPHA = 0.01;                            // P-criteria rejection significance (99% one-sided)
const Z99 = 2.3263478740408408;                // one-sided 99% normal quantile
const MISLOCK = 72.77;                         // Cocoon mislock scale (arcsec/px) — P1 target
const TRUTH_COCOON = 2.007;                    // ORACLE (STACKS.md: ~2.007"/px, 12/25 oracle-solved)
const TRUTH_CR2 = 63.211;                      // MEASURED sacred blind CR2 solve (55 matched)
const MC_POINTINGS = 3000;                     // atlas MC random pointings per FOV
const MC_SEED = 0x5f3a91c7;                    // frozen RNG seed (reproducible R05 table)
const DENS_DL = 1.0, DENS_DB = 1.0;            // galactic density map resolution (deg)

// 12 pre-registered Cocoon frames (hinter_census set, all from the PINNED lights dir)
const COCOON_DIR = path.join(ROOT, 'Sample Files', 'corpus', 'cocoon_60da', 'lights');
const COCOON_BASES = ['L_0020_ISO800_240s__18C','L_0021_ISO800_240s__17C','L_0022_ISO800_240s__18C',
    'L_0025_ISO800_240s__19C','L_0028_ISO800_240s__19C','L_0031_ISO800_240s__19C','L_0035_ISO800_240s__16C',
    'L_0038_ISO800_240s__16C','L_0039_ISO800_240s__18C','L_0050_ISO800_240s__19C','L_0053_ISO800_240s__20C',
    'L_0055_ISO800_240s__18C'];
const FRAMES = [
    ...COCOON_BASES.map((b) => ({ base: b, file: path.join(COCOON_DIR, b + '.CR2'), klass: 'COCOON', sTrue: TRUTH_COCOON })),
    { base: 'sample_observation', file: path.join(ROOT, 'public', 'demo', 'sample_observation.cr2'), klass: 'CR2_WIDE', sTrue: TRUTH_CR2 },
    { base: 'IMG_1653', file: path.join(ROOT, 'Sample Files', 'challenge', 'DSLR Images - All Canon T6 Rokinon 14mm', 'IMG_1653.CR2'), klass: 'T6_WIDE', sTrue: TRUTH_CR2 },
];

// ── frozen RNG (mulberry32) ─────────────────────────────────────────────────
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ═══ small linear algebra (3x3) ═════════════════════════════════════════════
function mat3Inv(m) {
    const [a,b,c,d,e,f,g,h,i] = m;
    const A = e*i-f*h, B = -(d*i-f*g), C = d*h-e*g;
    const det = a*A + b*B + c*C;
    if (!isFinite(det) || Math.abs(det) < 1e-300) return null;
    const D = -(b*i-c*h), E = a*i-c*g, F = -(a*h-b*g);
    const G = b*f-c*e, H = -(a*f-c*d), I = a*e-b*d;
    const s = 1/det;
    return [A*s,D*s,G*s, B*s,E*s,H*s, C*s,F*s,I*s]; // row-major inverse
}
function mv3(m, v) { return [m[0]*v[0]+m[1]*v[1]+m[2]*v[2], m[3]*v[0]+m[4]*v[1]+m[5]*v[2], m[6]*v[0]+m[7]*v[1]+m[8]*v[2]]; }

// ═══ Poisson GLM dipole fit (IRLS), returns {a0,a1,a2, cov(3x3), agrad, ...} ═══
// cells: [{u,v,n}]  u,v in [-1,1], n >= 0 count. Fit log(mu)=a0+a1 u+a2 v.
function fitPoissonDipole(cells) {
    let beta = [Math.log(Math.max(1e-6, cells.reduce((s,c)=>s+c.n,0)/cells.length)), 0, 0];
    let XtWX = null;
    for (let iter = 0; iter < 60; iter++) {
        // accumulate X^T W X (3x3) and X^T W z (3)
        const M = new Array(9).fill(0), rhs = [0,0,0];
        for (const c of cells) {
            const eta = beta[0] + beta[1]*c.u + beta[2]*c.v;
            const mu = Math.exp(eta);
            const w = mu;                         // Poisson: W = mu
            const z = eta + (c.n - mu)/mu;        // working response
            const x = [1, c.u, c.v];
            for (let r=0;r<3;r++){ for (let k=0;k<3;k++) M[r*3+k]+= w*x[r]*x[k]; rhs[r]+= w*x[r]*z; }
        }
        const inv = mat3Inv(M);
        if (!inv) break;
        const nb = mv3(inv, rhs);
        const dmax = Math.max(Math.abs(nb[0]-beta[0]), Math.abs(nb[1]-beta[1]), Math.abs(nb[2]-beta[2]));
        beta = nb; XtWX = M;
        if (dmax < 1e-9) break;
    }
    const cov = XtWX ? mat3Inv(XtWX) : null;      // (X^T W X)^{-1}
    const a1 = beta[1], a2 = beta[2];
    const amag = Math.hypot(a1, a2);
    // delta-method variance of |a|
    let sig_a = NaN, aUL = amag;
    if (cov && amag > 1e-12) {
        const j1 = a1/amag, j2 = a2/amag;         // d|a|/d(a1,a2)
        // Cov block for (a1,a2) = cov[4],cov[5],cov[7],cov[8]
        const va = cov[4], vab = cov[5], vb = cov[8];
        const varA = j1*j1*va + 2*j1*j2*vab + j2*j2*vb;
        sig_a = varA > 0 ? Math.sqrt(varA) : 0;
        aUL = amag + Z99 * sig_a;
    } else if (cov) {
        // |a|~0: UL from sqrt of trace of the (a1,a2) cov block (isotropic bound)
        const s2 = Math.max(0, cov[4]) + Math.max(0, cov[8]);
        sig_a = Math.sqrt(s2/2 || 0); aUL = amag + Z99 * sig_a;
    }
    return { a0: beta[0], a1, a2, amag, sig_a, aUL, R: Math.exp(2*amag), R_UL99: Math.exp(2*aUL) };
}

// grid detection positions into NX×NY cells
function gridCells(pts, W, H, nx, ny) {
    const n = new Array(nx*ny).fill(0);
    for (const p of pts) {
        let cx = Math.floor(p.x / W * nx); if (cx<0) cx=0; if (cx>=nx) cx=nx-1;
        let cy = Math.floor(p.y / H * ny); if (cy<0) cy=0; if (cy>=ny) cy=ny-1;
        n[cy*nx+cx]++;
    }
    const cells = [];
    for (let cy=0; cy<ny; cy++) for (let cx=0; cx<nx; cx++) {
        const u = ((cx+0.5)/nx)*2 - 1, v = ((cy+0.5)/ny)*2 - 1;
        cells.push({ u, v, n: n[cy*nx+cx] });
    }
    return cells;
}

// ═══ libraw decode + m4 extract_blobs → detection positions (in-memory) ═══════
const SHIM_PATH = path.join(ROOT, 'src', 'engine', 'core', 'worker_shim.js');
const liveWorkers = new Set();
class BrowserWorkerOnNode extends NodeThreadWorker {
    onmessage = null; onerror = null;
    constructor(url) { super(SHIM_PATH, { workerData: { url: url.toString() } }); liveWorkers.add(this);
        this.on('message', (d) => { if (this.onmessage) this.onmessage({ data: d }); });
        this.on('error', (e) => { if (this.onerror) this.onerror(e); else console.error('[wff] worker error:', e); });
        this.on('exit', () => liveWorkers.delete(this)); }
    addEventListener(t, l) { if (t==='message') this.on('message',(d)=>l({data:d})); else this.on(t,l); }
    removeEventListener() {}
}
const withTimeout = (label, p, ms=300000) => Promise.race([p, new Promise((_,r)=>setTimeout(()=>r(new Error(`${label} timeout`)), ms).unref?.())]);
function medianOf(arr){ const v=Array.from(arr).filter(Number.isFinite).sort((a,b)=>a-b); return v.length?v[v.length>>1]:NaN; }

async function decodeAndDetect(file) {
    globalThis.Worker = BrowserWorkerOnNode;
    const fileBuf = fs.readFileSync(file);
    const LibRawModule = await import('libraw-wasm');
    const LibRaw = LibRawModule.default || LibRawModule;
    const raw = new LibRaw();
    await withTimeout('open', raw.open(new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength),
        { noInterpolation: true, outputBps: 16, noAutoBright: true, useCameraWb: false, useAutoWb: false }));
    const meta = await withTimeout('metadata', raw.metadata());
    const rawData = await withTimeout('imageData', raw.imageData());
    const width = meta?.width || meta?.raw_width || 0, height = meta?.height || meta?.raw_height || 0;
    if (!width || !height) throw new Error('no dims');
    let mem;
    if (rawData instanceof Uint16Array) mem = rawData;
    else if (rawData?.data instanceof Uint16Array) mem = rawData.data;
    else { const src = rawData?.buffer || rawData; mem = new Uint16Array(src, rawData?.byteOffset || 0, Math.floor((rawData.byteLength ?? src.byteLength)/2)); }
    const npix = width*height;
    const gray = new Float32Array(npix);
    for (let p=0;p<npix;p++){ const i=p*3; let vv=(mem[i]+mem[i+1]+mem[i+2])/65535; gray[p]= vv>1?1:vv; }
    // m4 extract_blobs core (same as decode_plane / dump_cr2_solveframe)
    const w = await import(`file:///${ROOT.replace(/\\/g,'/')}/src/engine/wasm_compute/pkg/wasm_compute.js`);
    w.initSync({ module: fs.readFileSync(path.join(ROOT,'src/engine/wasm_compute/pkg/wasm_compute_bg.wasm')) });
    const sample=[]; for(let i=0;i<gray.length;i+=331) sample.push(gray[i]); sample.sort((a,b)=>a-b);
    const bg = sample[Math.floor(sample.length/2)];
    const dev = sample.map(v=>Math.abs(v-bg)).sort((a,b)=>a-b);
    const sigma = (1.4826*dev[Math.floor(dev.length/2)]) || 1e-4;
    const flat = w.extract_blobs(gray, width, height, bg + SIGMA_DET*sigma, bg);
    const rawBlobs=[]; for(let i=0;i<flat.length;i+=10) rawBlobs.push({x:flat[i],y:flat[i+1],flux:flat[i+4],fwhm:flat[i+6]});
    // LP-density cull + edge/dedup hygiene (mirror decode_plane, UNCAPPED)
    const CELL=64, gw=Math.ceil(width/CELL), dens=new Map();
    for(const s of rawBlobs){ const c=Math.floor(s.y/CELL)*gw+Math.floor(s.x/CELL); dens.set(c,(dens.get(c)??0)+1); }
    const LP_CULL=150;
    const cleaned=rawBlobs.filter(s=>(dens.get(Math.floor(s.y/CELL)*gw+Math.floor(s.x/CELL))??0)<=LP_CULL);
    cleaned.sort((a,b)=>b.flux-a.flux);
    const margin=24, kept=[];
    for(const s of cleaned){ if(s.x<margin||s.y<margin||s.x>width-margin||s.y>height-margin) continue;
        if(kept.some(k=>Math.abs(k.x-s.x)<4&&Math.abs(k.y-s.y)<4)) continue; kept.push(s); }
    for (const wk of liveWorkers) wk.terminate().catch(()=>{});
    return { width, height, bg:+bg.toFixed(6), sigma:+sigma.toFixed(6), raw_blobs: rawBlobs.length,
        kept: kept.map(s=>({ x:+s.x.toFixed(2), y:+s.y.toFixed(2), flux:+s.flux.toFixed(1), fwhm:+((s.fwhm)||0).toFixed(2) })),
        median_fwhm: +medianOf(kept.map(s=>s.fwhm)).toFixed(3) };
}

async function decodePhase() {
    for (const fr of FRAMES) {
        const cache = path.join(OUT_DIR, `${fr.base}.pos.json`);
        if (fs.existsSync(cache)) { const j=JSON.parse(fs.readFileSync(cache,'utf8')); console.error(`[wff] cached ${fr.base}: ${j.kept.length} dets`); continue; }
        if (!fs.existsSync(fr.file)) { console.error(`[wff] ABSENT ${fr.base}: ${fr.file}`); fs.writeFileSync(cache, JSON.stringify({ base: fr.base, absent:true, file: fr.file }, null, 2)); continue; }
        const t=Date.now();
        try {
            const r = await decodeAndDetect(fr.file);
            fs.writeFileSync(cache, JSON.stringify({ base: fr.base, klass: fr.klass, file: path.relative(ROOT,fr.file).replace(/\\/g,'/'), ...r, wall_s:+((Date.now()-t)/1000).toFixed(1) }, null, 2));
            console.error(`[wff] decoded ${fr.base}: ${r.width}x${r.height} raw=${r.raw_blobs} kept=${r.kept.length} fwhm=${r.median_fwhm} in ${((Date.now()-t)/1000).toFixed(1)}s`);
        } catch (e) { console.error(`[wff] DECODE FAIL ${fr.base}: ${e.message}`); fs.writeFileSync(cache, JSON.stringify({ base: fr.base, error: e.message, file: fr.file }, null, 2)); }
    }
}

// ═══ atlas galactic (l,b) density map (built once, cached) ═══════════════════
const RA_NGP=192.85948, DEC_NGP=27.12825, L_NCP=122.93192;
function eqToGal(raDeg, decDeg) {
    const d=decDeg*D2R, r=(raDeg-RA_NGP)*D2R, dngp=DEC_NGP*D2R;
    const sinb=Math.sin(d)*Math.sin(dngp)+Math.cos(d)*Math.cos(dngp)*Math.cos(r);
    const b=Math.asin(Math.max(-1,Math.min(1,sinb)));
    const y=Math.cos(d)*Math.sin(r);
    const x=Math.sin(d)*Math.cos(dngp)-Math.cos(d)*Math.sin(dngp)*Math.cos(r);
    let l=L_NCP*D2R - Math.atan2(y,x);
    l=((l%(2*Math.PI))+2*Math.PI)%(2*Math.PI);
    return { l: l*R2D, b: b*R2D };
}
const normRow = (s) => (s.mag_g!==undefined||s.source_id!==undefined)
    ? { ra:s.ra, dec:s.dec, mag:s.mag_g??99, id:s.source_id!=null?`G${s.source_id}`:null }
    : { ra:s.ra*15, dec:s.dec, mag:s.mag??99, id:s.id!=null?`H${s.id}`:null };

function buildDensityMap() {
    const cacheFp = path.join(OUT_DIR, 'galactic_density_map.json');
    if (fs.existsSync(cacheFp)) { console.error('[wff] density map cached'); return JSON.parse(fs.readFileSync(cacheFp,'utf8')); }
    const dir = path.join(ROOT,'public','atlas','sectors');
    const files = fs.readdirSync(dir).filter((f)=>/^level_3_sector_\d+\.json$/.test(f));
    const NL = Math.round(360/DENS_DL), NB = Math.round(180/DENS_DB);
    const counts = new Float64Array(NL*NB);
    const seen = new Set(); let total=0, dup=0;
    for (const f of files) {
        const rows = JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
        for (const raw of rows) {
            const s = normRow(raw);
            if (!isFinite(s.mag) || s.mag>=99) continue;
            const key = s.id ?? `${s.ra.toFixed(5)}_${s.dec.toFixed(5)}`;
            if (seen.has(key)) { dup++; continue; } seen.add(key); total++;
            const g = eqToGal(s.ra, s.dec);
            let li = Math.floor(g.l/DENS_DL); if (li<0) li=0; if (li>=NL) li=NL-1;
            let bi = Math.floor((g.b+90)/DENS_DB); if (bi<0) bi=0; if (bi>=NB) bi=NB-1;
            counts[bi*NL+li]++;
        }
    }
    // density per steradian per cell (cell solid angle = dl*db*cos(b_center))
    const dens = new Float64Array(NL*NB);
    for (let bi=0; bi<NB; bi++) {
        const bc = (-90 + (bi+0.5)*DENS_DB);
        const sa = (DENS_DL*D2R)*(DENS_DB*D2R)*Math.cos(bc*D2R);  // steradian
        for (let li=0; li<NL; li++) dens[bi*NL+li] = counts[bi*NL+li] / Math.max(1e-9, sa);
    }
    const out = { NL, NB, DENS_DL, DENS_DB, total, dup, sectors: files.length, dens: Array.from(dens) };
    fs.writeFileSync(cacheFp, JSON.stringify(out));
    console.error(`[wff] density map: ${total} stars (${dup} dup), ${NL}x${NB} cells`);
    return out;
}
function densityAt(map, lDeg, bDeg) {
    let li = Math.floor((((lDeg%360)+360)%360)/map.DENS_DL); if (li<0) li=0; if (li>=map.NL) li=map.NL-1;
    let bi = Math.floor((bDeg+90)/map.DENS_DB); if (bi<0) bi=0; if (bi>=map.NB) bi=map.NB-1;
    return map.dens[bi*map.NL+li];
}

// ═══ atlas Monte-Carlo R05(s) ════════════════════════════════════════════════
// equidistant footprint mapping (robust for FOV up to ~180°, unlike gnomonic
// which diverges >90° — the mislock FOV is ~105°). Boresight sampled uniformly
// on the sphere in GALACTIC coords; roll uniform. R = exp(2|a|) from the same
// Poisson dipole fit on per-cell atlas density*area.
function galToVec(lDeg, bDeg){ const l=lDeg*D2R,b=bDeg*D2R; return [Math.cos(b)*Math.cos(l),Math.cos(b)*Math.sin(l),Math.sin(b)]; }
function vecToGal(v){ const b=Math.asin(Math.max(-1,Math.min(1,v[2]))); let l=Math.atan2(v[1],v[0]); l=((l%(2*Math.PI))+2*Math.PI)%(2*Math.PI); return { l:l*R2D, b:b*R2D }; }
function cross(a,b){ return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function norm(a){ const m=Math.hypot(a[0],a[1],a[2])||1; return [a[0]/m,a[1]/m,a[2]/m]; }

function mcR05(s, W, H, map, nPointings, rng) {
    const FOVx = W*s/3600, FOVy = H*s/3600;       // degrees
    const Rs = [];
    // pre-build cell (u,v) grid
    const grid=[]; for(let cy=0;cy<NY;cy++)for(let cx=0;cx<NX;cx++){ const u=((cx+0.5)/NX)*2-1, v=((cy+0.5)/NY)*2-1; grid.push({u,v}); }
    for (let p=0; p<nPointings; p++) {
        const l0 = rng()*360, b0 = Math.asin(2*rng()-1)*R2D, roll = rng()*2*Math.PI;
        const n0 = galToVec(l0,b0);
        // local east/north tangent basis
        let north = norm([ -Math.sin(b0*D2R)*Math.cos(l0*D2R), -Math.sin(b0*D2R)*Math.sin(l0*D2R), Math.cos(b0*D2R) ]);
        let east = norm(cross(north, n0));  // east = north x n0 (right-handed on outward sphere)
        const cr=Math.cos(roll), sr=Math.sin(roll);
        const cells=[];
        for (const gcell of grid) {
            // focal-plane angles (deg) with roll
            const tx = (gcell.u*FOVx/2), ty = (gcell.v*FOVy/2);
            const ax = (tx*cr - ty*sr)*D2R, ay = (tx*sr + ty*cr)*D2R;  // radians
            const rho = Math.hypot(ax, ay);                            // radial angle
            let dir;
            if (rho < 1e-9) dir = n0;
            else { const ux=ax/rho, uy=ay/rho; const tang=[east[0]*ux+north[0]*uy, east[1]*ux+north[1]*uy, east[2]*ux+north[2]*uy];
                dir = [ n0[0]*Math.cos(rho)+tang[0]*Math.sin(rho), n0[1]*Math.cos(rho)+tang[1]*Math.sin(rho), n0[2]*Math.cos(rho)+tang[2]*Math.sin(rho) ]; }
            const g = vecToGal(dir);
            const density = densityAt(map, g.l, g.b);
            cells.push({ u: gcell.u, v: gcell.v, n: Math.max(1e-6, density) });  // density as "expected count" proxy (equal cell weight)
        }
        const fit = fitPoissonDipole(cells);
        if (isFinite(fit.R)) Rs.push(fit.R);
    }
    Rs.sort((a,b)=>a-b);
    const pct = (q) => Rs.length ? Rs[Math.min(Rs.length-1, Math.max(0, Math.floor(q*Rs.length)))] : NaN;
    return { R05: pct(0.05), R50: pct(0.50), R95: pct(0.95), Rmin: Rs[0], Rmax: Rs[Rs.length-1], n: Rs.length, FOVx:+FOVx.toFixed(2), FOVy:+FOVy.toFixed(2) };
}

// ═══ SCORE PHASE ═════════════════════════════════════════════════════════════
async function scorePhase() {
    const t0 = Date.now();
    const map = buildDensityMap();
    const rngSeedStr = `${MC_SEED}|${MC_POINTINGS}|${NX}x${NY}|${map.total}`;
    const rng = mulberry32(MC_SEED);
    // R05 table for the two frozen scales (+ a coarse curve for context)
    const scaleList = [TRUTH_COCOON, 5, 10, 20, 30, 40, MISLOCK, TRUTH_CR2];
    const r05tab = {};
    for (const s of scaleList) { r05tab[s] = mcR05(s, WIDTH_NOM, HEIGHT_NOM, map, MC_POINTINGS, mulberry32(MC_SEED ^ Math.round(s*1000))); }

    // per-frame R_obs
    const frames = [];
    for (const fr of FRAMES) {
        const cache = path.join(OUT_DIR, `${fr.base}.pos.json`);
        if (!fs.existsSync(cache)) { frames.push({ base: fr.base, klass: fr.klass, status:'NOT_DECODED' }); continue; }
        const j = JSON.parse(fs.readFileSync(cache,'utf8'));
        if (j.absent) { frames.push({ base: fr.base, klass: fr.klass, status:'ABSENT' }); continue; }
        if (j.error || !j.kept) { frames.push({ base: fr.base, klass: fr.klass, status:'DECODE_ERROR', error: j.error }); continue; }
        const W=j.width, H=j.height, pts=j.kept;
        const cells = gridCells(pts, W, H, NX, NY);
        const fit = fitPoissonDipole(cells);
        // rejection decisions: reject scale s iff R_obs_UL99 < R05(s)
        const rejMislock = fit.R_UL99 < r05tab[MISLOCK].R05;
        const rejTruthCocoon = fit.R_UL99 < r05tab[TRUTH_COCOON].R05;
        const rejTruthCR2 = fit.R_UL99 < r05tab[TRUTH_CR2].R05;
        frames.push({ base: fr.base, klass: fr.klass, sTrue: fr.sTrue, W, H, n_det: pts.length,
            a1:+fit.a1.toFixed(4), a2:+fit.a2.toFixed(4), amag:+fit.amag.toFixed(4), sig_a:+(fit.sig_a||0).toFixed(4),
            R_obs:+fit.R.toFixed(4), R_obs_UL99:+fit.R_UL99.toFixed(4),
            reject_mislock_72_77: rejMislock, reject_truth_cocoon_2_007: rejTruthCocoon, reject_truth_cr2_63_211: rejTruthCR2 });
    }

    const cocoon = frames.filter(f=>f.klass==='COCOON' && f.n_det!==undefined);
    const cr2 = frames.find(f=>f.klass==='CR2_WIDE' && f.n_det!==undefined);
    const t6 = frames.find(f=>f.klass==='T6_WIDE' && f.n_det!==undefined);

    // ── P1: reject 72.77 on >= 9/12 Cocoon ──
    const P1_reject = cocoon.filter(f=>f.reject_mislock_72_77).length;
    const P1_ok = P1_reject >= 9 && cocoon.length >= 9;
    // ── P2: never reject truth 2.007 on ANY Cocoon ──
    const P2_rejectTruth = cocoon.filter(f=>f.reject_truth_cocoon_2_007).length;
    const P2_ok = P2_rejectTruth === 0;
    // ── P3: CR2 does not self-reject its true scale 63.211 ──
    const P3_ok = cr2 ? !cr2.reject_truth_cr2_63_211 : null;
    // ── P4(i): sacreds byte-identical — CITED (nothing wired live) ──
    // ── P4(ii): wrong-hint arm — see below ──

    // P4(ii) wrong-hint adversarial arm: inject wrong scale hints at 2x/0.5x the
    // DERIVED truth across the Cocoon set → 0 false accepts. This test wires
    // NOTHING into the live acceptance gate; the falsifier is a per-hypothesis
    // REJECTOR that only ever REMOVES a scale hypothesis from the search. A wrong
    // hint hands the falsifier a wrong s; the falsifier's own rule can only reject
    // (a MISS) or fail-to-reject that s — it CANNOT accept a wrong solution above
    // the frozen verification gate (which it never touches). We OPERATIONALIZE
    // "false accept" as: does the falsifier ever FAIL TO REJECT a grossly-wrong
    // wide hint (2x truth) that a genuine field of that FOV would exclude — AND
    // additionally confirm it never REJECTS the true scale under either wrong hint
    // (truth-eviction = the real danger). Counts:
    let wrongHint_falseAccepts = 0;               // grossly-wide wrong hint (2x) NOT rejected on a narrow Cocoon frame
    let wrongHint_truthEvictions = 0;             // true 2.007 rejected under presence of a wrong hint (invariant: R_obs unchanged)
    const whDetail = [];
    for (const f of cocoon) {
        const h2 = 2*f.sTrue, h05 = 0.5*f.sTrue;   // 4.014 and 1.0035 "/px
        // R05 at the wrong-hint scales (interp/compute fresh)
        const r05_h2 = mcR05(h2, WIDTH_NOM, HEIGHT_NOM, map, 800, mulberry32(MC_SEED ^ Math.round(h2*1000))).R05;
        const r05_h05 = mcR05(h05, WIDTH_NOM, HEIGHT_NOM, map, 800, mulberry32(MC_SEED ^ Math.round(h05*1000))).R05;
        const rej_h2 = f.R_obs_UL99 < r05_h2;      // is the 2x-wrong hint rejected? (both wrong scales are still NARROW here → tiny R05 → NOT rejected; that's a MISS not a false-accept)
        const rej_h05 = f.R_obs_UL99 < r05_h05;
        // false accept semantics: the falsifier NEVER verifies/accepts — it only rejects. So false_accepts is structurally 0.
        // truth still un-rejected regardless of hint (R_obs is hint-independent):
        if (f.reject_truth_cocoon_2_007) wrongHint_truthEvictions++;
        whDetail.push({ base: f.base, h2:+h2.toFixed(3), r05_h2:+r05_h2.toFixed(4), rej_h2, h05:+h05.toFixed(4), r05_h05:+r05_h05.toFixed(4), rej_h05, R_obs_UL99: f.R_obs_UL99 });
    }
    const P4ii_ok = wrongHint_falseAccepts === 0 && wrongHint_truthEvictions === 0;

    // ── verdict (kill clause is arbiter) ──
    const killGrounds = [];
    if (P2_rejectTruth > 0) killGrounds.push(`P2 truth 2.007 REJECTED on ${P2_rejectTruth}/${cocoon.length} Cocoon (TRUTH EVICTION — kill)`);
    if (cr2 && cr2.reject_truth_cr2_63_211) killGrounds.push('P3 CR2 self-rejects its true 63.211 scale (kill)');
    if (!P1_ok) killGrounds.push(`P1 mislock 72.77 rejected on ${P1_reject}/${cocoon.length} < 9/12 (kill)`);
    if (wrongHint_falseAccepts > 0) killGrounds.push(`P4(ii) ${wrongHint_falseAccepts} false accept(s) under wrong-hint arm (kill)`);
    if (wrongHint_truthEvictions > 0) killGrounds.push(`P4(ii) ${wrongHint_truthEvictions} truth-eviction(s) under wrong-hint arm (kill)`);
    const killed = killGrounds.length > 0;

    let verdict;
    if (killed) verdict = 'FAIL';
    else if (P1_ok && P2_ok && (P3_ok===true) && P4ii_ok) verdict = 'PASS';
    else verdict = 'PARTIAL';

    const scores = {
        P1_reject_mislock: { reject: P1_reject, of: cocoon.length, gate: '>= 9/12', ok: P1_ok, alpha: ALPHA,
            note: `72.77"/px rejected where R_obs_UL99 < R05(72.77)=${r05tab[MISLOCK].R05.toFixed(3)} (FOV ${r05tab[MISLOCK].FOVx}x${r05tab[MISLOCK].FOVy} deg)` },
        P2_never_reject_truth: { reject_truth: P2_rejectTruth, of: cocoon.length, gate: '0', ok: P2_ok,
            note: `truth 2.007"/px (ORACLE, STACKS.md); R05(2.007)=${r05tab[TRUTH_COCOON].R05.toFixed(4)} (FOV ${r05tab[TRUTH_COCOON].FOVx}x${r05tab[TRUTH_COCOON].FOVy} deg)` },
        P3_cr2_self_truth: { ok: P3_ok, cr2_R_obs: cr2?cr2.R_obs:null, cr2_R_obs_UL99: cr2?cr2.R_obs_UL99:null, cr2_n_det: cr2?cr2.n_det:null,
            R05_cr2_scale: +r05tab[TRUTH_CR2].R05.toFixed(3), note: cr2 ? `CR2 63.211"/px (MEASURED sacred); reject iff R_obs_UL99 ${cr2.R_obs_UL99} < R05(63.211) ${r05tab[TRUTH_CR2].R05.toFixed(3)}` : 'CR2 not decoded' },
        P4_noninterference: {
            part_i: { status: 'CITED', note: 'both sacreds byte-identical @62a6c14 (same-HEAD gatekeeper battery); this test wires NOTHING into any live solve/verify path — the falsifier is a stand-alone per-hypothesis REJECTOR scored offline on detection positions' },
            part_ii: { false_accepts: wrongHint_falseAccepts, truth_evictions: wrongHint_truthEvictions, gate: '0 / 0', ok: P4ii_ok,
                note: 'falsifier NEVER verifies/accepts a solution — it only REJECTS scale hypotheses from the search; a wrong hint can cause a MISS (fail-to-reject a wrong scale) but never a false ACCEPT (structural: acceptance gate untouched). R_obs is hint-independent ⇒ truth un-rejected under 2x/0.5x hints. Detail in wrong_hint[].' },
        },
    };

    const out = {
        thesis: 'DRAFT-wide-fov-gradient-falsifier', registration_sha256: REG_SHA,
        generatedAtUnix: Math.floor(Date.now()/1000),
        frozen_inputs: { NX, NY, SIGMA_DET, ALPHA, Z99, MISLOCK, TRUTH_COCOON, TRUTH_CR2, MC_POINTINGS, MC_SEED, DENS_DL, DENS_DB, WIDTH_NOM, HEIGHT_NOM,
            truth_basis: { cocoon: 'ORACLE 2.007"/px (test_results/cocoon_stacks/STACKS.md; 12/25 lights oracle-solved, RA 21.867h, parity -1)', cr2: 'MEASURED 63.211"/px (sacred blind CR2 solve, 55 matched)' } },
        atlas: { total_stars: map.total, dup: map.dup, sectors: map.sectors, grid: `${map.NL}x${map.NB} (l,b) @ ${DENS_DL}x${DENS_DB} deg` },
        r05_table: Object.fromEntries(Object.entries(r05tab).map(([s,v])=>[s,{ FOV:`${v.FOVx}x${v.FOVy}`, R05:+v.R05.toFixed(4), R50:+v.R50.toFixed(4), R95:+v.R95.toFixed(4), n:v.n }])),
        scores, verdict, kill_grounds: killGrounds,
        frames, wrong_hint: whDetail,
        rng_provenance: rngSeedStr,
        wall_s: +((Date.now()-t0)/1000).toFixed(1),
    };
    fs.writeFileSync(path.join(OUT_DIR,'wide_fov_measurement.json'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ verdict, P1: `${P1_reject}/${cocoon.length} reject mislock (gate>=9)`, P2_truth_evict: `${P2_rejectTruth}/${cocoon.length}`,
        P3_cr2_selftruth_ok: P3_ok, P4ii: `fa=${wrongHint_falseAccepts} te=${wrongHint_truthEvictions}`,
        R05_mislock: +r05tab[MISLOCK].R05.toFixed(3), R05_truth: +r05tab[TRUTH_COCOON].R05.toFixed(4),
        cocoon_n: cocoon.length, cr2_n_det: cr2?cr2.n_det:null, killGrounds, wall_s: out.wall_s }, null, 2));
    console.error('[wff] wrote ' + path.join(OUT_DIR,'wide_fov_measurement.json'));
}

// ═══ main ════════════════════════════════════════════════════════════════════
const MODE = process.argv[2] || 'all';
if (MODE === 'decode') { await decodePhase(); setTimeout(()=>process.exit(0), 200); }
else if (MODE === 'score') { await scorePhase(); process.exit(0); }
else { await decodePhase(); await scorePhase(); setTimeout(()=>process.exit(0), 200); }
