// Full headless E2E of the wizard solve stage using the REAL FITS file,
// REAL wasm extraction, and REAL atlas.
import fs from 'node:fs';
const root = 'k:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY';
const w = await import(`file:///${root}/src/engine/wasm_compute/pkg/wasm_compute.js`);
w.initSync({ module: fs.readFileSync(`${root}/src/engine/wasm_compute/pkg/wasm_compute_bg.wasm`) });
w.init_pipeline();

// ── 1. Decode FITS (BITPIX=16, BZERO=32768, planar RGB, big-endian) ──
const fit = fs.readFileSync(`${root}/Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit`);
let hdrEnd = 0, cards = {};
outer: for (let b = 0; ; b += 2880) {
    for (let i = b; i < b + 2880; i += 80) {
        const card = fit.subarray(i, i + 80).toString('latin1');
        const m = card.match(/^([A-Z0-9_-]+)\s*=\s*([^\/]+)/);
        if (m) cards[m[1]] = m[2].trim();
        if (card.startsWith('END')) { hdrEnd = b + 2880; break outer; }
    }
}
const W = +cards.NAXIS1, H = +cards.NAXIS2, NP = +(cards.NAXIS3 ?? 1), BZERO = +(cards.BZERO ?? 0);
console.log(`FITS: ${W}x${H}x${NP} BZERO=${BZERO} RA=${cards.RA} DEC=${cards.DEC}`);

const npix = W * H;
const plane = (k) => {
    const out = new Float32Array(npix);
    const off = hdrEnd + k * npix * 2;
    for (let i = 0; i < npix; i++) out[i] = (fit.readInt16BE(off + i * 2) + BZERO) / 65535;
    return out;
};
const R = plane(0), G = NP === 3 ? plane(1) : R, B = NP === 3 ? plane(2) : R;

// ── 2. Mimic app: luminance -> gamma 8-bit ImageData -> extractor luma ──
// session.luminanceToImageData: v = pow(lum,1/2.2)*255 (clamped);
// SourceExtractor luma of gray RGBA: (0.299+0.587+0.114)*v/255 = v/255.
const lum = new Float32Array(npix);
for (let i = 0; i < npix; i++) {
    const l = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    lum[i] = Math.min(255, Math.round(Math.min(255, Math.pow(Math.max(0, l), 1 / 2.2) * 255))) / 255;
}

// NOTE: FITS rows are stored bottom-up; the app's decoder may or may not flip.
// We extract on the raw row order (same as the app fed the solver).

// ── 3. Extract blobs with the real WASM (bg/sigma like the app) ──
const stats = w.compute_basic_stats ? null : null;
// estimate background: median + MAD via sample
const sample = [];
for (let i = 0; i < npix; i += 997) sample.push(lum[i]);
sample.sort((a, b) => a - b);
const bg = sample[Math.floor(sample.length / 2)];
const sigmaEst = (sample[Math.floor(sample.length * 0.84)] - bg) || 0.01;
const thresh = bg + 3.5 * sigmaEst;
console.log(`bg=${bg.toFixed(4)} sigma=${sigmaEst.toFixed(4)} thresh=${thresh.toFixed(4)}`);
const flat = w.extract_blobs(lum, W, H, thresh, bg);
const stars = [];
for (let i = 0; i < flat.length; i += 10) {
    stars.push({ x: flat[i], y: flat[i + 1], flux: flat[i + 4], fwhm: flat[i + 6] });
}
stars.sort((a, b) => b.flux - a.flux);
console.log(`extracted ${stars.length} blobs; top8: ${stars.slice(0, 8).map(s => `(${s.x.toFixed(0)},${s.y.toFixed(0)} f=${s.flux.toExponential(1)} w=${s.fwhm.toFixed(1)})`).join(' ')}`);

// ── 4. Catalog projection at header center ──
const norm = s => { const g = s.source_id !== undefined || s.mag_g !== undefined; return { raH: g ? s.ra / 15 : s.ra, dec: s.dec, mag: g ? s.mag_g : s.mag }; };
const atlas = [
    ...JSON.parse(fs.readFileSync(`${root}/public/atlas/level_1_anchors.json`, 'utf8')),
    ...JSON.parse(fs.readFileSync(`${root}/public/atlas/level_2_pattern.json`, 'utf8')),
    ...JSON.parse(fs.readFileSync(`${root}/public/atlas/sectors/level_3_sector_20.json`, 'utf8'))
].map(norm);
const RA0 = (+cards.RA) / 15, DEC0 = +cards.DEC, SCALE = 3.74, D2R = Math.PI / 180;
const gn = (raH, dec) => {
    const a = raH * 15 * D2R, a0 = RA0 * 15 * D2R, d = dec * D2R, d0 = DEC0 * D2R;
    const c = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    return { xi: Math.cos(d) * Math.sin(a - a0) / c / D2R, eta: (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / c / D2R };
};
const degPerPx = SCALE / 3600;
const cat = atlas.filter(s => { const g = gn(s.raH, s.dec); return Math.hypot(g.xi, g.eta) < 3.5; })
    .map(s => { const g = gn(s.raH, s.dec); return { x: W / 2 + g.xi / degPerPx, y: H / 2 - g.eta / degPerPx, mag: s.mag }; })
    .sort((a, b) => a.mag - b.mag);

// ── 5. Rotation/mirror/scale scan: det top30 vs catalog ──
const det = stars.slice(0, 30);
const cx = W / 2, cy = H / 2;
let best = { hits: 0 };
for (let deg = 0; deg < 360; deg += 0.5) {
    for (const mirror of [1, -1]) {
        const th = deg * D2R, cs = Math.cos(th), sn = Math.sin(th);
        let hits = 0;
        for (const p of det) {
            const rx = (p.x - cx), ry = (p.y - cy) * mirror;
            const tx = cx + rx * cs - ry * sn, ty = cy + rx * sn + ry * cs;
            let m = 1e9; for (const c of cat) { const d = Math.hypot(c.x - tx, c.y - ty); if (d < m) m = d; }
            if (m < 6) hits++;
        }
        if (hits > best.hits) best = { hits, deg, mirror };
    }
}
console.log(`best alignment: ${best.hits}/30 hits at rot=${best.deg} deg mirror=${best.mirror}`);
