#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// visual_ab_render.mjs — LOOK-AT-THE-DATA lane (owner-ordered, 2026-07-11)
// ═══════════════════════════════════════════════════════════════════════════
// Renders BOTH decoder arms (libraw control vs rawler rail) of the same CR2 to
// stretched PNGs + native-res crops + detection overlays, so a human/agent with
// vision can LOOK at what the demosaicer outputs. Pure PIXEL-ledger work.
//
//   node --max-old-space-size=6144 tools/rawlab/visual_ab_render.mjs
//
// Arms (exact pipeline payloads, not re-interpretations):
//   libraw : tools/psf/decode_cr2.mjs decodeCR2 → mem_image dominant-channel
//            RGB16 mosaic, ACTIVE area, black-subtracted, white-scaled.
//   rawler : src/engine/wasm_decode pkg decode_raw().rgb16_active() → integer
//            bilinear demosaic RGB16, ACTIVE area, raw ADU + pedestal.
//
// DOMAIN UNIFICATION (metadata-driven, stated in REPORT):
//   libraw v_lin = DN/65535                       (already (ADU-black)/(white-black))
//   rawler v_lin = (DN - black_c)/(white - black_c) per channel (meta levels)
// Residual background mismatch after unification is MEASURED and reported,
// never silently corrected.
//
// SHARED STRETCH (identical constants both arms — derived ONCE from the libraw
// arm's luma background): asinh stretch out = asinh((v-B0)/S)/asinh((1-B0)/S).
//
// Detections come from the EXISTING dumps (the same sets the divergence
// diagnosis used): test_results/cr2_dets/sample_observation.app.json (libraw,
// 2227) and test_results/cr2_dets/thesis001_rawler.json (rawler, 3414). No
// detection pass is re-run here (box law: Rust build owns the heavy lane).
//
// Overlay legend: libraw render → green marks (its 2227). rawler render →
// green = matched to a libraw det within MATCH_R px, red = rawler-only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { decodeCR2, terminateDecodeWorkers } from '../psf/decode_cr2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(ROOT, 'public', 'demo', 'sample_observation.cr2');
const OUT_SMALL = path.join(ROOT, 'test_results', 'decoder_visual_2026-07-11');
const OUT_BIG = 'D:\\SkyCruncher\\test_artifacts\\decoder_visual_2026-07-11';
const PKG_DIR = path.join(ROOT, 'src', 'engine', 'wasm_decode', 'pkg');
const DUMP_LIBRAW = path.join(ROOT, 'test_results', 'cr2_dets', 'sample_observation.app.json');
const DUMP_RAWLER = path.join(ROOT, 'test_results', 'cr2_dets', 'thesis001_rawler.json');
const MATCH_R = 6;          // px, arm-to-arm det matching radius
const STRETCH_S = 0.01;     // asinh softening (shared)
const CROP = 512;           // native-res crop size
const DOWN = 4;             // full-frame downscale factor for viewable renders

fs.mkdirSync(OUT_SMALL, { recursive: true });
fs.mkdirSync(OUT_BIG, { recursive: true });
const log = (...a) => console.log('[visual_ab]', ...a);
const summary = { file: FILE, generated: new Date().toISOString(), arms: {}, stretch: {}, crops: {}, det_match: {} };

// ── helpers ──────────────────────────────────────────────────────────────────
function writePNGrgb(p, rgb, w, h) { // rgb = Uint8Array w*h*3
    const png = new PNG({ width: w, height: h });
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
        png.data[i * 4] = rgb[j]; png.data[i * 4 + 1] = rgb[j + 1]; png.data[i * 4 + 2] = rgb[j + 2]; png.data[i * 4 + 3] = 255;
    }
    fs.writeFileSync(p, PNG.sync.write(png));
    log('wrote', p);
}
function median(arr) { const a = Float64Array.from(arr).sort(); return a[a.length >> 1]; }
function sampleBg(luma, w, h) { // background median + MAD-sigma over a sparse sample
    const s = [];
    for (let y = 50; y < h - 50; y += 37) for (let x = 50; x < w - 50; x += 41) s.push(luma[y * w + x]);
    const med = median(s);
    const dev = s.map(v => Math.abs(v - med));
    return { med, sigma: 1.4826 * median(dev), n: s.length };
}
function makeStretch(B0, S) {
    const denom = Math.asinh((1 - B0) / S);
    return (v) => {
        const t = Math.asinh(Math.max(0, v - B0) / S) / denom;
        return t >= 1 ? 255 : Math.round(t * 255);
    };
}

// ── ARM DECODE ───────────────────────────────────────────────────────────────
log('decoding rawler arm (wasm_decode)…');
const wasmMod = await import(pathToFileURL(path.join(PKG_DIR, 'wasm_decode.js')).href);
wasmMod.initSync({ module: fs.readFileSync(path.join(PKG_DIR, 'wasm_decode_bg.wasm')) });
const dec = wasmMod.decode_raw(new Uint8Array(fs.readFileSync(FILE)));
const rMeta = JSON.parse(dec.meta_json());
const RW = dec.active_w, RH = dec.active_h;
const rRGB16 = dec.rgb16_active();  // Uint16, RW*RH*3, raw ADU + pedestal
dec.free();
const rBlack = rMeta.blacklevel_bayer;             // bayer tile [c0,c1,c2,c3]
const rWhite = Array.isArray(rMeta.whitelevel) ? rMeta.whitelevel[0] : rMeta.whitelevel;
// per-RGB-channel black: map bayer tile → R/G/B via active pattern (G averaged)
const patA = rMeta.cfa_pattern_active; // e.g. 'GBRG'
const chBlack = [0, 0, 0], chN = [0, 0, 0];
for (let i = 0; i < 4; i++) {
    const c = 'RGB'.indexOf(patA[i] === 'G' ? 'G' : patA[i]);
    if (c >= 0) { chBlack[c] += rBlack[i]; chN[c]++; }
}
for (let c = 0; c < 3; c++) chBlack[c] = chN[c] ? chBlack[c] / chN[c] : rBlack[0];
summary.arms.rawler = {
    payload: 'rgb16_active (integer-bilinear demosaic, raw ADU + pedestal)',
    dims: `${RW}x${RH}`, full: `${rMeta.width}x${rMeta.height}`, active_area: rMeta.active_area,
    pattern_full: rMeta.cfa_pattern_full, pattern_active: patA,
    black_bayer: rBlack, black_rgb: chBlack, white: rWhite, wb: rMeta.wb_coeffs,
    linearization: '(DN - black_c) / (white - black_c) per channel',
};
log(`rawler: active ${RW}x${RH}, pattern ${patA}, black ${JSON.stringify(rBlack)}, white ${rWhite}`);

log('decoding libraw arm (mem_image control)…');
const lr = await decodeCR2(FILE);
terminateDecodeWorkers();
const LW = lr.w, LH = lr.h;
const lRGB16 = lr.rgb16; // Uint16, LW*LH*3, dominant-channel mosaic, black-sub, scaled
summary.arms.libraw = {
    payload: 'dcraw_make_mem_image RGB16 dominant-channel mosaic (black-subtracted, white-scaled)',
    dims: `${LW}x${LH}`, linearization: 'DN / 65535',
};
log(`libraw: ${LW}x${LH}`);

// ── LINEARIZE → per-arm luma (mean of channels; the artifact-honest proxy) ──
// libraw mem_image G-sites are [0,G,0] → mean(RGB) carries the 2px checkerboard
// exactly the way any CFA-weighted luma does. rawler is fully demosaiced.
function buildLuma(rgb16, w, h, lin) {
    const luma = new Float32Array(w * h);
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
        luma[i] = (lin(rgb16[j], 0) + lin(rgb16[j + 1], 1) + lin(rgb16[j + 2], 2)) / 3;
    }
    return luma;
}
const rInvRange = [0, 1, 2].map(c => 1 / (rWhite - chBlack[c]));
const rLin = (v, c) => Math.max(0, (v - chBlack[c]) * rInvRange[c]);
const lLin = (v) => v / 65535;
const rLuma = buildLuma(rRGB16, RW, RH, rLin);
const lLuma = buildLuma(lRGB16, LW, LH, (v) => lLin(v));

const lBg = sampleBg(lLuma, LW, LH);
const rBg = sampleBg(rLuma, RW, RH);
summary.arms.libraw.bg = lBg; summary.arms.rawler.bg = rBg;
summary.arms.bg_ratio_rawler_over_libraw = rBg.med / lBg.med;
log(`bg luma: libraw med=${lBg.med.toExponential(3)} σ=${lBg.sigma.toExponential(3)} · rawler med=${rBg.med.toExponential(3)} σ=${rBg.sigma.toExponential(3)} · ratio=${(rBg.med / lBg.med).toFixed(3)}`);

// shared stretch constants from the LIBRAW arm only
const B0 = Math.max(0, lBg.med - 2 * lBg.sigma);
const stretch = makeStretch(B0, STRETCH_S);
summary.stretch = { type: 'asinh', formula: 'asinh((v-B0)/S)/asinh((1-B0)/S)', B0, S: STRETCH_S, derived_from: 'libraw arm bg (med - 2σ)', applied: 'identically to both arms' };
log(`shared stretch: asinh B0=${B0.toExponential(3)} S=${STRETCH_S}`);

// ── stretched RGB renders (Uint8) per arm ────────────────────────────────────
function renderColor(rgb16, w, h, lin) {
    const out = new Uint8Array(w * h * 3);
    for (let j = 0; j < w * h * 3; j += 3) {
        out[j] = stretch(lin(rgb16[j], 0));
        out[j + 1] = stretch(lin(rgb16[j + 1], 1));
        out[j + 2] = stretch(lin(rgb16[j + 2], 2));
    }
    return out;
}
function renderLumaGray(luma, w, h) {
    const out = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { const v = stretch(luma[i]); out[i * 3] = v; out[i * 3 + 1] = v; out[i * 3 + 2] = v; }
    return out;
}
function downscaleLinearLuma(luma, w, h, f) {
    const dw = Math.floor(w / f), dh = Math.floor(h / f);
    const out = new Uint8Array(dw * dh * 3);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        let s = 0;
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += luma[(y * f + dy) * w + (x * f + dx)];
        const v = stretch(s / (f * f));
        const i = (y * dw + x) * 3; out[i] = v; out[i + 1] = v; out[i + 2] = v;
    }
    return { out, dw, dh };
}
function crop(rgbU8, w, _h, x0, y0, cw, ch) {
    const out = new Uint8Array(cw * ch * 3);
    for (let y = 0; y < ch; y++) {
        const src = ((y0 + y) * w + x0) * 3;
        out.set(rgbU8.subarray(src, src + cw * 3), y * cw * 3);
    }
    return out;
}
// mark drawing: circle + center dot, RGB color, onto a Uint8 rgb buffer
function drawMark(rgbU8, w, h, cx, cy, r, col) {
    const put = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const i = (y * w + x) * 3; rgbU8[i] = col[0]; rgbU8[i + 1] = col[1]; rgbU8[i + 2] = col[2];
    };
    const n = Math.max(16, Math.round(2 * Math.PI * r));
    for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n;
        put(Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a)));
    }
    put(Math.round(cx), Math.round(cy));
}

// ── detections + arm matching ────────────────────────────────────────────────
const lDets = JSON.parse(fs.readFileSync(DUMP_LIBRAW, 'utf8')).detections;
const rDets = JSON.parse(fs.readFileSync(DUMP_RAWLER, 'utf8')).detections;
// grid hash of libraw dets for NN matching
const cell = 32, grid = new Map();
lDets.forEach((d, i) => {
    const k = `${Math.floor(d.x / cell)},${Math.floor(d.y / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
});
const rMatched = new Array(rDets.length).fill(false);
for (let i = 0; i < rDets.length; i++) {
    const d = rDets[i];
    const gx = Math.floor(d.x / cell), gy = Math.floor(d.y / cell);
    let best = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
            const dd = (lDets[j].x - d.x) ** 2 + (lDets[j].y - d.y) ** 2;
            if (dd < best) best = dd;
        }
    }
    rMatched[i] = best <= MATCH_R * MATCH_R;
}
const nMatched = rMatched.filter(Boolean).length;
const rOnly = rDets.filter((_, i) => !rMatched[i]);
// where do rawler-only dets sit? edge proximity + local stretched luma
let edge32 = 0, onSignal = 0;
const sigThresh = rBg.med + 3 * rBg.sigma;
for (const d of rOnly) {
    if (d.x < 32 || d.y < 32 || d.x > RW - 32 || d.y > RH - 32) edge32++;
    const px = Math.min(RW - 1, Math.max(0, Math.round(d.x))), py = Math.min(RH - 1, Math.max(0, Math.round(d.y)));
    if (rLuma[py * RW + px] > sigThresh) onSignal++;
}
summary.det_match = {
    libraw_n: lDets.length, rawler_n: rDets.length, match_radius_px: MATCH_R,
    rawler_matched_to_libraw: nMatched, rawler_only: rOnly.length,
    rawler_only_within_32px_of_edge: edge32,
    rawler_only_center_pixel_above_bg3sigma: onSignal,
    note: 'grids differ by ≤1 row (5202x3465 vs 5202x3464); no offset correction applied to matching',
};
log(`det match: libraw ${lDets.length} · rawler ${rDets.length} · matched ${nMatched} · rawler-only ${rOnly.length} (edge32=${edge32}, above-3σ-at-center=${onSignal})`);

// ── crop window selection ────────────────────────────────────────────────────
function densestCell(dets, cs, w, h, exclude) {
    const counts = new Map();
    for (const d of dets) {
        const k = `${Math.floor(d.x / cs)},${Math.floor(d.y / cs)}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let bk = null, bc = -1;
    for (const [k, c] of counts) {
        const [gx, gy] = k.split(',').map(Number);
        const x0 = gx * cs, y0 = gy * cs;
        if (x0 < 64 || y0 < 64 || x0 + cs > w - 64 || y0 + cs > h - 64) continue;
        if (exclude && exclude(x0, y0)) continue;
        if (c > bc) { bc = c; bk = [x0, y0]; }
    }
    return { x0: bk[0], y0: bk[1], count: bc };
}
const centerWin = { x0: (LW >> 1) - CROP / 2, y0: (LH >> 1) - CROP / 2 };
const dense = densestCell(lDets, CROP, LW, LH, (x, y) => Math.abs(x - centerWin.x0) < CROP && Math.abs(y - centerWin.y0) < CROP);
const hotspot = densestCell(rOnly, CROP, RW, RH, null);
const cornerWin = { x0: 16, y0: 16 };
const windows = {
    center: { ...centerWin, why: 'frame center' },
    dense: { x0: dense.x0, y0: dense.y0, why: `densest libraw-det ${CROP}px cell (${dense.count} dets)` },
    corner: { ...cornerWin, why: 'top-left corner (border/edge behavior)' },
    rawler_hotspot: { x0: hotspot.x0, y0: hotspot.y0, why: `densest rawler-ONLY ${CROP}px cell (${hotspot.count} unmatched dets)` },
};
summary.crops = windows;
log('crop windows:', JSON.stringify(windows));

// ── render + write ───────────────────────────────────────────────────────────
for (const [armName, armData] of [['libraw', { rgb16: lRGB16, w: LW, h: LH, luma: lLuma, lin: (v) => lLin(v) }],
['rawler', { rgb16: rRGB16, w: RW, h: RH, luma: rLuma, lin: rLin }]]) {
    const { rgb16, w, h, luma, lin } = armData;
    const color = renderColor(rgb16, w, h, lin);
    const gray = renderLumaGray(luma, w, h);

    // full-res color + luma → D:
    writePNGrgb(path.join(OUT_BIG, `full_${armName}_color.png`), color, w, h);
    writePNGrgb(path.join(OUT_BIG, `full_${armName}_luma.png`), gray, w, h);

    // downscaled full-frame luma (viewable) + overlay version
    const ds = downscaleLinearLuma(luma, w, h, DOWN);
    writePNGrgb(path.join(OUT_SMALL, `full_${armName}_luma_ds${DOWN}.png`), ds.out, ds.dw, ds.dh);
    const dso = Uint8Array.from(ds.out);
    if (armName === 'libraw') {
        for (const d of lDets) drawMark(dso, ds.dw, ds.dh, d.x / DOWN, d.y / DOWN, 3, [0, 255, 0]);
    } else {
        rDets.forEach((d, i) => drawMark(dso, ds.dw, ds.dh, d.x / DOWN, d.y / DOWN, 3, rMatched[i] ? [0, 255, 0] : [255, 40, 40]));
    }
    writePNGrgb(path.join(OUT_SMALL, `full_${armName}_overlay_ds${DOWN}.png`), dso, ds.dw, ds.dh);

    // native-res crops: color + luma + overlay-on-luma
    for (const [wname, win] of Object.entries(windows)) {
        const x0 = Math.max(0, Math.min(w - CROP, Math.round(win.x0)));
        const y0 = Math.max(0, Math.min(h - CROP, Math.round(win.y0)));
        writePNGrgb(path.join(OUT_SMALL, `crop_${wname}_${armName}_color.png`), crop(color, w, h, x0, y0, CROP, CROP), CROP, CROP);
        const g = crop(gray, w, h, x0, y0, CROP, CROP);
        writePNGrgb(path.join(OUT_SMALL, `crop_${wname}_${armName}_luma.png`), g, CROP, CROP);
        const ov = Uint8Array.from(g);
        if (armName === 'libraw') {
            for (const d of lDets) {
                if (d.x >= x0 && d.x < x0 + CROP && d.y >= y0 && d.y < y0 + CROP) drawMark(ov, CROP, CROP, d.x - x0, d.y - y0, 8, [0, 255, 0]);
            }
        } else {
            rDets.forEach((d, i) => {
                if (d.x >= x0 && d.x < x0 + CROP && d.y >= y0 && d.y < y0 + CROP) drawMark(ov, CROP, CROP, d.x - x0, d.y - y0, 8, rMatched[i] ? [0, 255, 0] : [255, 40, 40]);
            });
        }
        writePNGrgb(path.join(OUT_SMALL, `crop_${wname}_${armName}_overlay.png`), ov, CROP, CROP);
    }
}

fs.writeFileSync(path.join(OUT_SMALL, 'render_summary.json'), JSON.stringify(summary, null, 2));
log('summary:', path.join(OUT_SMALL, 'render_summary.json'));
log('DONE');
