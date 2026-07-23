// Render the FITS luminance to PNG with detection markers for visual inspection.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..').replace(/\\/g, '/');
const w = await import(`file:///${root}/src/engine/wasm_compute/pkg/wasm_compute.js`);
w.initSync({ module: fs.readFileSync(`${root}/src/engine/wasm_compute/pkg/wasm_compute_bg.wasm`) });

const fit = fs.readFileSync(`${root}/Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit`);
let hdrEnd = 0;
outer: for (let b = 0; ; b += 2880) { for (let i = b; i < b + 2880; i += 80) { if (fit.subarray(i, i + 80).toString('latin1').startsWith('END')) { hdrEnd = b + 2880; break outer; } } }
const W = 2160, H = 3840, npix = W * H;
const plane = k => { const out = new Float32Array(npix); const off = hdrEnd + k * npix * 2; for (let i = 0; i < npix; i++) out[i] = (fit.readInt16BE(off + i * 2) + 32768) / 65535; return out; };
const R = plane(0), G = plane(1), B = plane(2);
const lum = new Float32Array(npix);
for (let i = 0; i < npix; i++) { const l = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i]; lum[i] = Math.min(255, Math.round(Math.min(255, Math.pow(Math.max(0, l), 1 / 2.2) * 255))) / 255; }

// extraction (same as app)
const sample = []; for (let i = 0; i < npix; i += 997) sample.push(lum[i]);
sample.sort((a, b) => a - b);
const bg = sample[Math.floor(sample.length / 2)], sg = (sample[Math.floor(sample.length * 0.84)] - bg) || 0.01;
const flat = w.extract_blobs(lum, W, H, bg + 3.5 * sg, bg);
const stars = []; for (let i = 0; i < flat.length; i += 10) stars.push({ x: flat[i], y: flat[i + 1], flux: flat[i + 4] });
stars.sort((a, b) => b.flux - a.flux);

// downscale 4x with strong stretch
const dw = W / 4, dh = H / 4;
const img = new Uint8Array(dw * dh * 3);
for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let m = 0;
    for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) m = Math.max(m, lum[(y * 4 + yy) * W + x * 4 + xx]);
    // hard stretch: bg..bg+10sigma -> 0..255
    const v = Math.max(0, Math.min(255, ((m - bg) / (10 * sg)) * 255));
    const o = (y * dw + x) * 3;
    img[o] = img[o + 1] = img[o + 2] = v;
}
// mark top-30 detections in red (5px crosses)
for (const s of stars.slice(0, 30)) {
    const x = Math.round(s.x / 4), y = Math.round(s.y / 4);
    for (let d = -6; d <= 6; d++) {
        for (const [px, py] of [[x + d, y], [x, y + d]]) {
            if (px >= 0 && px < dw && py >= 0 && py < dh && Math.abs(d) > 2) {
                const o = (py * dw + px) * 3; img[o] = 255; img[o + 1] = 40; img[o + 2] = 40;
            }
        }
    }
}
// minimal PNG encoder
function crc32(buf) { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } c = 0xFFFFFFFF; for (const b of buf) c = t[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(dw, 0); ihdr.writeUInt32BE(dh, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc(dh * (dw * 3 + 1));
for (let y = 0; y < dh; y++) { raw[y * (dw * 3 + 1)] = 0; Buffer.from(img.buffer, y * dw * 3, dw * 3).copy(raw, y * (dw * 3 + 1) + 1); }
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const out = process.argv[2] || 'fits_preview.png';
fs.writeFileSync(out, png);
console.log('wrote', out, `${dw}x${dh}`, 'stars:', stars.length);
