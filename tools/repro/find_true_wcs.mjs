// Find the TRUE field geometry: match real detections against a region-wide
// catalog with the (fixed) quad matcher, then fit a similarity transform from
// candidate quads and count inliers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..').replace(/\\/g, '/');
const w = await import(`file:///${root}/src/engine/wasm_compute/pkg/wasm_compute.js`);
w.initSync({ module: fs.readFileSync(`${root}/src/engine/wasm_compute/pkg/wasm_compute_bg.wasm`) });
w.init_pipeline();

// ── detections from the real FITS ──
const fit = fs.readFileSync(`${root}/Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit`);
let hdrEnd = 0;
outer: for (let b = 0; ; b += 2880) { for (let i = b; i < b + 2880; i += 80) { if (fit.subarray(i, i + 80).toString('latin1').startsWith('END')) { hdrEnd = b + 2880; break outer; } } }
const W = 2160, H = 3840, npix = W * H;
const plane = k => { const out = new Float32Array(npix); const off = hdrEnd + k * npix * 2; for (let i = 0; i < npix; i++) out[i] = (fit.readInt16BE(off + i * 2) + 32768) / 65535; return out; };
const R = plane(0), G = plane(1), B = plane(2);
const lum = new Float32Array(npix);
for (let i = 0; i < npix; i++) { const l = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i]; lum[i] = Math.min(255, Math.round(Math.min(255, Math.pow(Math.max(0, l), 1 / 2.2) * 255))) / 255; }
const sample = []; for (let i = 0; i < npix; i += 997) sample.push(lum[i]);
sample.sort((a, b) => a - b);
const bg = sample[Math.floor(sample.length / 2)], sg = (sample[Math.floor(sample.length * 0.84)] - bg) || 0.01;
const flat = w.extract_blobs(lum, W, H, bg + 3.5 * sg, bg);
const detAll = []; for (let i = 0; i < flat.length; i += 10) detAll.push({ x: flat[i], y: flat[i + 1], flux: flat[i + 4] });
detAll.sort((a, b) => b.flux - a.flux);
const det = detAll.slice(0, 40);

// ── region catalog: L1+L2 + HYG mag<11 within 4 deg of header center ──
const RA0 = 170.425003051758 / 15, DEC0 = 12.8419437408447, D2R = Math.PI / 180;
const gn = (raH, dec) => {
    const a = raH * 15 * D2R, a0 = RA0 * 15 * D2R, d = dec * D2R, d0 = DEC0 * D2R;
    const c = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    return { xi: Math.cos(d) * Math.sin(a - a0) / c / D2R, eta: (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / c / D2R };
};
const bright = [...JSON.parse(fs.readFileSync(`${root}/public/atlas/level_1_anchors.json`, 'utf8')), ...JSON.parse(fs.readFileSync(`${root}/public/atlas/level_2_pattern.json`, 'utf8'))]
    .map(s => ({ raH: s.ra / 15, dec: s.dec, mag: s.mag_g }));
const hyg = JSON.parse(fs.readFileSync(`${root}/public/atlas/sectors/sector_RA8-12_DEC0_to_30.json`, 'utf8'))
    .filter(s => s.mag < 11).map(s => ({ raH: s.ra, dec: s.dec, mag: s.mag }));
const cat = [...bright, ...hyg]
    .map(s => ({ ...gn(s.raH, s.dec), mag: s.mag }))
    .filter(g => Number.isFinite(g.xi) && Math.hypot(g.xi, g.eta) < 4)
    .sort((a, b) => a.mag - b.mag)
    .slice(0, 80)
    .map(g => ({ x: g.xi * 3600, y: -g.eta * 3600, xi: g.xi, eta: g.eta, mag: g.mag })); // arcsec plane, y flipped like solver
console.log(`det=${det.length} cat(region top80)=${cat.length}`);

const F = a => new Float64Array(a);
const dX = F(det.map(p => p.x)), dY = F(det.map(p => p.y)), dI = F(det.map((_, i) => i));
const cX = F(cat.map(p => p.x)), cY = F(cat.map(p => p.y)), cI = F(cat.map((_, i) => i));
const t0 = Date.now();
const res = w.solve_planar_local(dX, dY, dI, cX, cY, cI, new Float64Array([0.003, 0.006, 0.01, 0.02]), 80, undefined);
console.log(`matcher: ${res.length / 9} candidates in ${Date.now() - t0}ms`);

// fit 2D similarity (with mirror) from each candidate quad; count inliers
function fitSim(pix, sky) {
    // solve sky = s*Rot(pix) + t via least squares over 4 pts (allow mirror by trying y-flip)
    let best = null;
    for (const mir of [1, -1]) {
        const P = pix.map(p => [p.x, p.y * mir]);
        const n = P.length;
        let mpx = 0, mpy = 0, msx = 0, msy = 0;
        for (let i = 0; i < n; i++) { mpx += P[i][0]; mpy += P[i][1]; msx += sky[i][0]; msy += sky[i][1]; }
        mpx /= n; mpy /= n; msx /= n; msy /= n;
        let a = 0, b = 0, d = 0;
        for (let i = 0; i < n; i++) {
            const px = P[i][0] - mpx, py = P[i][1] - mpy, sx = sky[i][0] - msx, sy = sky[i][1] - msy;
            a += px * sx + py * sy; b += px * sy - py * sx; d += px * px + py * py;
        }
        const s = Math.hypot(a, b) / d, th = Math.atan2(b, a);
        let err = 0;
        for (let i = 0; i < n; i++) {
            const px = P[i][0] - mpx, py = P[i][1] - mpy;
            const ex = s * (px * Math.cos(th) - py * Math.sin(th)) - (sky[i][0] - msx);
            const ey = s * (px * Math.sin(th) + py * Math.cos(th)) - (sky[i][1] - msy);
            err += ex * ex + ey * ey;
        }
        const model = { s, th, mir, mpx, mpy, msx, msy, err };
        if (!best || err < best.err) best = model;
    }
    return best;
}
const apply = (m, p) => {
    const px = p.x - m.mpx, py = p.y * m.mir - m.mpy;
    return [m.s * (px * Math.cos(m.th) - py * Math.sin(m.th)) + m.msx, m.s * (px * Math.sin(m.th) + py * Math.cos(m.th)) + m.msy];
};

let bestOverall = null;
for (let i = 0; i < res.length; i += 9) {
    const dIdx = [res[i], res[i + 1], res[i + 2], res[i + 3]].map(Number);
    const cIdx = [res[i + 4], res[i + 5], res[i + 6], res[i + 7]].map(Number);
    const pix = dIdx.map(k => det[k]);
    const sky = cIdx.map(k => [cat[k].x, cat[k].y]);
    const m = fitSim(pix, sky);
    if (!m || m.err > 400) continue; // 20 arcsec quad residual cap
    // count inliers over all 40 dets
    let inliers = 0;
    for (const p of det) {
        const [sx, sy] = apply(m, p);
        let md = 1e9; for (const c of cat) { const dd = Math.hypot(c.x - sx, c.y - sy); if (dd < md) md = dd; }
        if (md < 15) inliers++; // 15 arcsec
    }
    if (!bestOverall || inliers > bestOverall.inliers) bestOverall = { inliers, m, quadErr: res[i + 8] };
}
if (bestOverall) {
    const { m, inliers } = bestOverall;
    // image center -> sky
    const [cxs, cys] = apply(m, { x: W / 2, y: H / 2 * (1) });
    console.log(`BEST MODEL: inliers=${inliers}/40 scale=${(m.s).toFixed(3)}"/px rot=${(m.th / D2R).toFixed(1)}deg mirror=${m.mir} quadErr=${bestOverall.quadErr.toExponential(2)}`);
    console.log(`image center offset from header center: dxi=${(cxs / 3600).toFixed(3)} deg, deta=${(-cys / 3600).toFixed(3)} deg`);
} else {
    console.log('no plausible model found');
}
