// Render a FITS RGB cube through the preview stretch to PNG — headless
// eyeball-verification of what ImageProcessor.float32ToImageDataAutoStretch
// produces, plus experimental variants for tuning.
//
//   node tools/repro/render_stretch.mjs <file.fits> [out.png] [--mode current|colorpreserve]
//
// Modes:
//   current       — mirrors ImageProcessor today (neutralize + per-channel linked MTF, B=0.25)
//   colorpreserve — proposed: neutralize + LUMINANCE-referenced MTF (B=0.15),
//                   chroma scaled by Ls/L (hue-exact), background desaturation
//                   below ~2x sky level (kills rainbow speckle), highlight
//                   rolloff to white for saturated star cores.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const file = args[0];
if (!file) { console.error('usage: render_stretch.mjs <file.fits> [out.png] [--mode current|colorpreserve]'); process.exit(2); }
const outPath = args[1] && !args[1].startsWith('--') ? args[1] : `stretch_${path.basename(file).replace(/\W+/g, '_')}.png`;
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'colorpreserve';

// ── decode (int16+BZERO and float32, big-endian, NAXIS=3) ───────────────────
const buf = fs.readFileSync(file);
let hdrEnd = 0; const cards = {};
outer: for (let b = 0; b < buf.length; b += 2880) {
    for (let i = b; i < b + 2880; i += 80) {
        const card = buf.subarray(i, i + 80).toString('latin1');
        const m = card.match(/^([A-Z0-9_-]+)\s*=\s*('.*?'|[^\/]+)/);
        if (m) cards[m[1]] = m[2].replace(/'/g, '').trim();
        if (card.startsWith('END')) { hdrEnd = b + 2880; break outer; }
    }
}
const W = +cards.NAXIS1, H = +cards.NAXIS2, NP = +(cards.NAXIS3 ?? 1), BZERO = +(cards.BZERO ?? 0), BITPIX = +(cards.BITPIX ?? 16);
if (NP !== 3) { console.error(`need an RGB cube (NAXIS3=3), got ${W}x${H}x${NP}`); process.exit(2); }
const npix = W * H;
function readPlane(k) {
    const out = new Float32Array(npix);
    if (BITPIX === -32) {
        for (let i = 0; i < npix; i++) out[i] = buf.readFloatBE(hdrEnd + (k * npix + i) * 4);
    } else {
        for (let i = 0; i < npix; i++) out[i] = (buf.readInt16BE(hdrEnd + (k * npix + i) * 2) + BZERO) / 65535;
    }
    return out;
}
let R = readPlane(0), G = readPlane(1), B = readPlane(2);
if (BITPIX === -32) { // range-normalize like the app decoder
    let lo = Infinity, hi = -Infinity;
    for (const p of [R, G, B]) for (let i = 0; i < npix; i += 37) { const v = p[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    const inv = 1 / (hi - lo);
    for (const p of [R, G, B]) for (let i = 0; i < npix; i++) { const v = p[i]; p[i] = Number.isFinite(v) ? Math.min(1, Math.max(0, (v - lo) * inv)) : 0; }
}

// ── shared stats: neutralization gains + stretch params ─────────────────────
const sub = a => { const s = []; for (let i = 0; i < npix; i += 101) s.push(a[i]); return s.sort((x, y) => x - y); };
const median = a => a[Math.floor(a.length / 2)];
// v2 calibration (app parity): SUBTRACTIVE background neutralization to a
// common pedestal + HIGHLIGHT white balance from the star ensemble
// (98th percentile, saturation-excluded). Pure background GAINS tinted
// highlights violet (Hungary B x4.36 applied to star cores).
const sortedCh = [sub(R), sub(G), sub(B)];
const meds = sortedCh.map(median);
const pedestal = Math.min(...meds);
const hi = sortedCh.map(s => { let e = s.length - 1; while (e > 0 && s[e] >= 0.95) e--; return s[Math.floor(e * 0.98)]; });
const span = hi.map((h, c) => Math.max(1e-6, h - meds[c]));
const spanRef = Math.max(...span);
const gain = span.map(s => Math.min(8, Math.max(0.25, spanRef / s)));
const cal = (v, c) => Math.max(0, pedestal + (v - meds[c]) * gain[c]);
console.log(`medians ${meds.map(m => m.toFixed(5)).join('/')} | hi98 ${hi.map(h => h.toFixed(4)).join('/')} | star-WB gains ${gain.map(g => g.toFixed(3)).join('/')}`);

const lumAt = i => 0.2126 * cal(R[i], 0) + 0.7152 * cal(G[i], 1) + 0.0722 * cal(B[i], 2);
const lsam = []; for (let i = 0; i < npix; i += 101) lsam.push(lumAt(i));
lsam.sort((a, b) => a - b);
const lmed = median(lsam);
const dev = lsam.map(v => Math.abs(v - lmed)).sort((a, b) => a - b);
const madn = 1.4826 * median(dev);
const c0 = Math.min(Math.max(lmed - 2.8 * madn, 0), 1);
const range = 1 - c0;
const mnorm = (lmed - c0) / range;
const Btar = mode === 'current' ? 0.25 : 0.15;
const M = (mnorm * (Btar - 1)) / (2 * Btar * mnorm - Btar - mnorm);
const mtf = x => x <= 0 ? 0 : x >= 1 ? 1 : ((M - 1) * x) / ((2 * M - 1) * x - M);
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
console.log(`lum median=${lmed.toFixed(5)} madn=${madn.toFixed(5)} c0=${c0.toFixed(5)} mnorm=${mnorm.toFixed(5)} M=${M.toFixed(5)} target=${Btar} mode=${mode}`);

// ── render (2x downsample mean, color) ──────────────────────────────────────
const DS = Math.max(1, Math.round(Math.max(W, H) / 1400));
const dw = Math.floor(W / DS), dh = Math.floor(H / DS);
const img = new Uint8Array(dw * dh * 3);
for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
        let r = 0, g = 0, b = 0;
        for (let yy = 0; yy < DS; yy++) for (let xx = 0; xx < DS; xx++) {
            const i = (y * DS + yy) * W + (x * DS + xx);
            r += cal(R[i], 0); g += cal(G[i], 1); b += cal(B[i], 2);
        }
        const n = DS * DS; r /= n; g /= n; b /= n;
        let or_, og, ob;
        if (mode === 'current') {
            or_ = mtf((r - c0) / range); og = mtf((g - c0) / range); ob = mtf((b - c0) / range);
        } else {
            const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const Ls = mtf((L - c0) / range);
            const ratio = L > 1e-9 ? Ls / L : 0;
            // hue-exact chroma scaling
            let cr = r * ratio, cg = g * ratio, cb = b * ratio;
            // background desaturation: below ~2.2x the stretched sky level the
            // "color" is chroma noise — fade to neutral luminance
            const w1 = smoothstep(Btar * 0.85, Btar * 2.2, Ls);
            // highlight rolloff: saturated cores clip toward white, not neon
            const w2 = smoothstep(0.85, 1.0, Ls);
            or_ = cr + w1 * 0 + (1 - w1) * (Ls - cr); og = cg + (1 - w1) * (Ls - cg); ob = cb + (1 - w1) * (Ls - cb);
            or_ = or_ + w2 * (Ls - or_); og = og + w2 * (Ls - og); ob = ob + w2 * (Ls - ob);
        }
        const o = (y * dw + x) * 3;
        img[o] = Math.max(0, Math.min(255, or_ * 255));
        img[o + 1] = Math.max(0, Math.min(255, og * 255));
        img[o + 2] = Math.max(0, Math.min(255, ob * 255));
    }
}

// ── minimal PNG encoder (from render_fits.mjs) ──────────────────────────────
function crc32(b) { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } c = 0xFFFFFFFF; for (const x of b) c = t[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(dw, 0); ihdr.writeUInt32BE(dh, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc(dh * (dw * 3 + 1));
for (let y = 0; y < dh; y++) { raw[y * (dw * 3 + 1)] = 0; Buffer.from(img.buffer, y * dw * 3, dw * 3).copy(raw, y * (dw * 3 + 1) + 1); }
fs.writeFileSync(outPath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', outPath, `${dw}x${dh}`);
