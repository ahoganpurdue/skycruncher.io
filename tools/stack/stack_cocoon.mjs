#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/stack/stack_cocoon.mjs — Cocoon A/B/C stack + render deliverable
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/stack/stack_cocoon.mjs                 # n=25 (decode all lights)
//   node tools/stack/stack_cocoon.mjs --from-calibrated  # n=7 decoder-free appetizer
//
// Builds THREE stacks from the Cocoon lights and renders one high-res image per
// variant (owner deliverable). PIXEL ledger throughout; COORDINATE math confined
// to the WCS→affine registration transform (LAW 1).
//
//   Stack A : lights, NO calibration                  (raw decoded CFA)
//   Stack B : lights, master-DARK subtracted only     (raw − dark)
//   Stack C : FULL calibration (dark + flat)          ((raw − dark)/flat, floored)
//
// masterDark is exposure-matched (240s) ⇒ carries the bias pedestal ⇒ subtracted
// WHOLE (never bias-then-dark) — the documented convention (calibrate_light.mjs).
//
// DEFAULT (n=25): decode every light on the rawler full-frame CFA grid, forward-
// calibrate to A/B/C, demosaic on the native grid, register (oracle truth WCS for
// the 12 solved lights; index-interpolated WCS for the 13 unsolved — mount drift
// is smooth+monotonic across the solved subset, every unsolved frame is bracketed),
// cross-correlation dither snap, sigma-clip mean stack (disk-tiled — 25 RGB frames
// exceed RAM). --from-calibrated reproduces the n=7 appetizer decoder-free by
// inverting calibrate_light full mode on the 7 pre-built _full.bin.
//
// Renders are AESTHETIC (background-neutralized + linked-MTF STF stretch); the FITS
// payload stays LINEAR (no stretch, no WB) — the science product. Correlated-input
// exclusion is a no-op here (25 independent subs, one session, no re-used frames).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { decodeCfa } from '../calib/decode_util.mjs';
import { demosaicActiveRGB } from '../calib/demosaic.mjs';
import { writeFitsPlanar, wcsCards } from './fits_io.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FROM_CAL = process.argv.includes('--from-calibrated');
const D_BIN = process.env.CALIB_BIN_DIR || 'D:/AstroLogic/test_artifacts/calib_cocoon';
const CAL_DIR = path.join(D_BIN, 'calibrated');
const CORPUS = path.join(ROOT, 'Sample Files', 'corpus', 'cocoon_60da', 'lights');
const OUT_BIN = process.env.COCOON_OUT_DIR || 'D:/AstroLogic/test_artifacts/cocoon_stacks';
const TMP = path.join(OUT_BIN, 'tmp');
const OUT_JSON = path.join(ROOT, 'test_results', 'cocoon_stacks');
const TRUTH = path.join(ROOT, 'test_results', 'recal_2026-07-10', 'truth_wcs.json');
const FLAT_FLOOR = 0.05, CLIP_K = 3, CLIP_ITERS = 2;
const LUM = [0.2126, 0.7152, 0.0722];
const STF_TARGET = 0.15;                 // STF background target (darker → more contrast)
const log = (...a) => console.log('[stack_cocoon]', ...a);

fs.mkdirSync(OUT_BIN, { recursive: true });
fs.mkdirSync(OUT_JSON, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const load32 = (p) => { const b = fs.readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const idxOf = (id) => { const m = id.match(/L_(\d+)/); return m ? +m[1] : NaN; };

// ── geometry + pattern (from a calibrated manifest — all lights share the grid)
const man0 = JSON.parse(fs.readFileSync(path.join(CAL_DIR, fs.readdirSync(CAL_DIR).find((f) => /_full\.manifest\.json$/.test(f))), 'utf8'));
const FW = man0.dims.width, FH = man0.dims.height;
const AA = man0.active_area, AW = AA.w, AH = AA.h, APX = AW * AH;
const PATTERN = man0.cfa_pattern_full;
const CX = (AW - 1) / 2, CY = (AH - 1) / 2;

// ── truth WCS + the light set ───────────────────────────────────────────────
const truth = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
const wcsByFrame = new Map(truth.map((e) => [e.frame, e.wcs]));

let lights;   // { id, orig, srcDecode?|srcFull?, wcs, solved }
if (FROM_CAL) {
    const fullBins = fs.readdirSync(CAL_DIR).filter((f) => /_full\.bin$/.test(f)).sort();
    lights = fullBins.map((fb) => {
        const man = JSON.parse(fs.readFileSync(path.join(CAL_DIR, fb.replace(/\.bin$/, '.manifest.json')), 'utf8'));
        return { id: man.light.replace(/\.CR2$/i, ''), orig: man.light, srcFull: path.join(CAL_DIR, fb), wcs: wcsByFrame.get(man.light), solved: true };
    }).filter((l) => l.wcs);
} else {
    const cr2s = fs.readdirSync(CORPUS).filter((f) => /\.CR2$/i.test(f)).sort();
    // solved subset (index-sorted) drives interpolation of the unsolved WCS
    const solved = cr2s.filter((f) => wcsByFrame.has(f)).map((f) => ({ idx: idxOf(f), wcs: wcsByFrame.get(f) })).sort((a, b) => a.idx - b.idx);
    const interp = (idx) => {
        if (idx <= solved[0].idx) return { ...solved[0].wcs };
        if (idx >= solved[solved.length - 1].idx) return { ...solved[solved.length - 1].wcs };
        let lo = solved[0], hi = solved[solved.length - 1];
        for (let i = 0; i < solved.length - 1; i++) if (solved[i].idx <= idx && solved[i + 1].idx >= idx) { lo = solved[i]; hi = solved[i + 1]; break; }
        const f = (idx - lo.idx) / (hi.idx - lo.idx), L = (a, b) => a + f * (b - a);
        return { ra_hours: L(lo.wcs.ra_hours, hi.wcs.ra_hours), dec_deg: L(lo.wcs.dec_deg, hi.wcs.dec_deg), scale_arcsec_px: L(lo.wcs.scale_arcsec_px, hi.wcs.scale_arcsec_px), rotation_deg: L(lo.wcs.rotation_deg, hi.wcs.rotation_deg), parity: -1 };
    };
    lights = cr2s.map((f) => { const solvedHit = wcsByFrame.has(f); return { id: f.replace(/\.CR2$/i, ''), orig: f, srcDecode: path.join(CORPUS, f), wcs: solvedHit ? wcsByFrame.get(f) : interp(idxOf(f)), solved: solvedHit }; });
}
lights.sort((a, b) => idxOf(a.id) - idxOf(b.id));
const REF = lights.find((l) => l.solved) || lights[0];
const N = lights.length;
log(`${FROM_CAL ? 'FROM-CALIBRATED n=' + N : 'DECODE n=' + N} · grid ${FW}x${FH} active ${AW}x${AH} ${PATTERN}`);
log(`ref=${REF.id} RA=${REF.wcs.ra_hours.toFixed(5)}h dec=${REF.wcs.dec_deg.toFixed(5)} scale=${REF.wcs.scale_arcsec_px.toFixed(4)} rot=${REF.wcs.rotation_deg.toFixed(3)} · solved ${lights.filter((l) => l.solved).length}/${N}`);

// ── WCS → CD (deg/px) + per-frame affine into ref active grid ───────────────
const DEG = Math.PI / 180;
function cdOf(w) { const s = w.scale_arcsec_px / 3600, th = w.rotation_deg * DEG, p = w.parity, c = Math.cos(th), sn = Math.sin(th); return [s * p * c, -s * sn, s * p * sn, s * c]; }
function inv2(m) { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d]; }
const CD_REF = cdOf(REF.wcs), raRef = REF.wcs.ra_hours * 15, decRef = REF.wcs.dec_deg, cosDecRef = Math.cos(decRef * DEG);
function affineToFrame(w) {
    const A = inv2(cdOf(w)), B = CD_REF;
    const xi0 = (w.ra_hours * 15 - raRef) * cosDecRef, eta0 = (w.dec_deg - decRef);
    const M = [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
    const off = [A[0] * xi0 + A[1] * eta0, A[2] * xi0 + A[3] * eta0];
    return { M, t: [CX - off[0] - (M[0] * CX + M[1] * CY), CY - off[1] - (M[2] * CX + M[3] * CY)] };
}

// ── CFA producer per variant ────────────────────────────────────────────────
const dark = load32(path.join(D_BIN, 'master_dark.bin'));
const flat = load32(path.join(D_BIN, 'master_flat.bin'));
async function cfaFor(light, variant, buf) {
    if (FROM_CAL) {                                   // invert calibrate_light full mode
        const full = load32(light.srcFull);
        for (let i = 0; i < full.length; i++) { const b = flat[i] < FLAT_FLOOR ? full[i] : full[i] * flat[i]; buf[i] = variant === 'C' ? full[i] : variant === 'B' ? b : b + dark[i]; }
        return;
    }
    const d = await decodeCfa(light.srcDecode);       // forward-calibrate from raw
    const raw = d.cfa;
    for (let i = 0; i < raw.length; i++) {
        if (variant === 'A') buf[i] = raw[i];
        else { const sub = raw[i] - dark[i]; buf[i] = variant === 'B' ? sub : (flat[i] < FLAT_FLOOR ? sub : sub / flat[i]); }
    }
}

// ── warp demosaiced interleaved RGB → ref active grid (bilinear, NaN outside) ─
function warp(rgb, aff) {
    const { M, t } = aff, out = new Float32Array(APX * 3);
    for (let yo = 0; yo < AH; yo++) for (let xo = 0; xo < AW; xo++) {
        const xf = M[0] * xo + M[1] * yo + t[0], yf = M[2] * xo + M[3] * yo + t[1], oi = (yo * AW + xo) * 3;
        if (xf < 0 || yf < 0 || xf > AW - 1 || yf > AH - 1) { out[oi] = out[oi + 1] = out[oi + 2] = NaN; continue; }
        const x0 = xf | 0, y0 = yf | 0, x1 = x0 + 1 < AW ? x0 + 1 : x0, y1 = y0 + 1 < AH ? y0 + 1 : y0;
        const fx = xf - x0, fy = yf - y0, w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const i00 = (y0 * AW + x0) * 3, i10 = (y0 * AW + x1) * 3, i01 = (y1 * AW + x0) * 3, i11 = (y1 * AW + x1) * 3;
        for (let c = 0; c < 3; c++) out[oi + c] = rgb[i00 + c] * w00 + rgb[i10 + c] * w10 + rgb[i01 + c] * w01 + rgb[i11 + c] * w11;
    }
    return out;
}
function lumaI(rgb) { const L = new Float32Array(APX); for (let i = 0; i < APX; i++) L[i] = LUM[0] * rgb[i * 3] + LUM[1] * rgb[i * 3 + 1] + LUM[2] * rgb[i * 3 + 2]; return L; }
function decimate(L, f) { const dw = (AW / f) | 0, dh = (AH / f) | 0, o = new Float32Array(dw * dh); for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { let s = 0, n = 0; for (let j = 0; j < f; j++) for (let k = 0; k < f; k++) { const v = L[(y * f + j) * AW + (x * f + k)]; if (v === v) { s += v; n++; } } o[y * dw + x] = n ? s / n : NaN; } return { d: o, dw, dh }; }
function medSubClip(a) { const s = []; const st = a.length > 1e6 ? 11 : 1; for (let i = 0; i < a.length; i += st) { const v = a[i]; if (v === v) s.push(v); } s.sort((x, y) => x - y); const m = s[s.length >> 1] || 0, o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) { const v = a[i] - m; o[i] = v === v && v > 0 ? v : 0; } return o; }
// integer shift search over the WHOLE field (strided; a=ref,b=frame), radius R
// around (cx,cy). Whole-field (not a center crop) so the dense star field drives
// the peak, NOT the diffuse nebula at frame center (that biased earlier shifts).
function corrPeak(a, b, w, h, cx, cy, R, sk) {
    let best = -Infinity, bx = cx, by = cy;
    for (let dy = cy - R; dy <= cy + R; dy++) for (let dx = cx - R; dx <= cx + R; dx++) {
        const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy), x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
        let s = 0; for (let y = y0; y < y1; y += sk) { const ra = y * w, rb = (y + dy) * w; for (let x = x0; x < x1; x += sk) s += a[ra + x] * b[rb + x + dx]; }
        if (s > best) { best = s; bx = dx; by = dy; }
    }
    return { dx: bx, dy: by };
}
function coarseT(refL, frmL) {                       // coarse translation bootstrap (ref→frm), decimated
    const rD = decimate(refL, 4), fD = decimate(frmL, 4);
    const c = corrPeak(medSubClip(rD.d), medSubClip(fD.d), rD.dw, rD.dh, 0, 0, 16, 1); // ±64px, 4px steps
    return [c.dx * 4, c.dy * 4];
}

// ── STAR-BASED registration (detect centroids → match to ref → fit affine) ──
// Robust to WCS/interpolation error: minimizes actual star-position residuals,
// so stacked stars stay tight (WCS+translation-only smeared the 13 interp frames).
function detectStars(L) {
    const { med, sig } = robustBg(L), thr = med + 10 * sig, at = (x, y) => L[y * AW + x], cand = [];
    for (let y = 6; y < AH - 6; y++) for (let x = 6; x < AW - 6; x++) {
        const v = at(x, y); if (v < thr) continue;
        if (v < at(x - 1, y) || v < at(x + 1, y) || v < at(x, y - 1) || v < at(x, y + 1) || v < at(x - 1, y - 1) || v < at(x + 1, y + 1) || v < at(x - 1, y + 1) || v < at(x + 1, y - 1)) continue;
        let sw = 0, sx = 0, sy = 0; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { let w = at(x + dx, y + dy) - med; if (w < 0) w = 0; sw += w; sx += w * dx; sy += w * dy; }
        if (sw <= 0) continue; cand.push({ x: x + sx / sw, y: y + sy / sw, flux: sw });
    }
    cand.sort((a, b) => b.flux - a.flux);
    const kept = [], R2 = 144;                        // reject blends within 12px of a brighter star
    for (const c of cand) { let ok = true; for (const k of kept) { const dx = c.x - k.x, dy = c.y - k.y; if (dx * dx + dy * dy < R2) { ok = false; break; } } if (ok) kept.push(c); if (kept.length >= 600) break; }
    return kept;
}
function solve3(A, b) {                               // 3×3 solve (partial pivot); null if singular
    const m = [[...A[0], b[0]], [...A[1], b[1]], [...A[2], b[2]]];
    for (let i = 0; i < 3; i++) {
        let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
        if (Math.abs(m[p][i]) < 1e-12) return null; [m[i], m[p]] = [m[p], m[i]];
        for (let r = 0; r < 3; r++) if (r !== i) { const f = m[r][i] / m[i][i]; for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c]; }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}
function fitAffineToRef(refStars, frmStars, t0) {     // fit frm = M·ref + t (ref→frm), iterative NN + LSQ
    let M = [1, 0, 0, 1], t = [t0[0], t0[1]], nmatch = 0, resid = null;
    // wide→tight radii: stars here are ~170px apart, so a wide first pass is unambiguous
    // and rescues frames whose coarse bootstrap or dither offset exceeds a tight radius.
    for (const rad of [40, 18, 9, 5, 3]) {
        const r2 = rad * rad, pairs = [];
        for (const rs of refStars) {
            const px = M[0] * rs.x + M[1] * rs.y + t[0], py = M[2] * rs.x + M[3] * rs.y + t[1];
            let best = null, bd = r2; for (const fs of frmStars) { const dx = fs.x - px, dy = fs.y - py, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = fs; } }
            if (best) pairs.push([rs, best]);
        }
        if (pairs.length < 6) break;
        const fit3 = (gF) => { let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, Sn = 0, Sfx = 0, Sfy = 0, Sf = 0; for (const [rs, fs] of pairs) { const rx = rs.x, ry = rs.y, f = gF(fs); Sxx += rx * rx; Sxy += rx * ry; Sx += rx; Syy += ry * ry; Sy += ry; Sn++; Sfx += f * rx; Sfy += f * ry; Sf += f; } return solve3([[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, Sn]], [Sfx, Sfy, Sf]); };
        const ax = fit3((fs) => fs.x), ay = fit3((fs) => fs.y); if (!ax || !ay) break;
        M = [ax[0], ax[1], ay[0], ay[1]]; t = [ax[2], ay[2]]; nmatch = pairs.length;
        let sd = 0; for (const [rs, fs] of pairs) { const px = M[0] * rs.x + M[1] * rs.y + t[0], py = M[2] * rs.x + M[3] * rs.y + t[1]; sd += Math.hypot(fs.x - px, fs.y - py); } resid = sd / pairs.length;
    }
    return { M, t, nmatch, resid };
}

// ── stats on stacked luma ───────────────────────────────────────────────────
function robustBg(L) { const s = []; for (let i = 0; i < L.length; i += 7) { const v = L[i]; if (v === v) s.push(v); } s.sort((a, b) => a - b); let med = s[s.length >> 1], sig = 1e9; for (let it = 0; it < 4; it++) { const lo = med - 3 * sig, hi = med + 3 * sig, k = []; for (const v of s) if (v >= lo && v <= hi) k.push(v); const kk = k.length ? k : s; med = kk[kk.length >> 1]; let a = 0; for (const v of kk) a += (v - med) * (v - med); sig = Math.sqrt(a / kk.length); } return { med, sig }; }
function statRow(L, cov) {
    const { med, sig } = robustBg(L), at = (x, y) => L[y * AW + x];
    const hotThr = med + 16 * sig; let hot = 0;
    for (let y = 1; y < AH - 1; y++) for (let x = 1; x < AW - 1; x++) { const v = at(x, y); if (!(v > hotThr)) continue; const nmax = Math.max(at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)); if (nmax < med + 0.5 * (v - med)) hot++; }
    const thr = med + 5 * sig, seen = new Uint8Array(APX), stack = new Int32Array(1 << 16); let det = 0; const peaks = [];
    for (let i = 0; i < APX; i++) {
        if (seen[i] || !(L[i] > thr) || cov[i] === 0) { seen[i] = 1; continue; }
        let sp = 0, area = 0, peak = -Infinity, px = 0, py = 0; stack[sp++] = i; seen[i] = 1;
        while (sp > 0 && area < 200000) { const j = stack[--sp], jx = j % AW, jy = (j / AW) | 0, jv = L[j]; area++; if (jv > peak) { peak = jv; px = jx; py = jy; } const nb = [j - 1, j + 1, j - AW, j + AW]; for (const k of nb) { if (k < 0 || k >= APX) continue; if (Math.abs((k % AW) - jx) > 1) continue; if (!seen[k] && L[k] > thr && cov[k] > 0) { seen[k] = 1; if (sp < stack.length) stack[sp++] = k; } } }
        if (area >= 3 && peak > thr) { det++; if (peaks.length < 6000) peaks.push({ x: px, y: py, peak }); }
    }
    peaks.sort((a, b) => b.peak - a.peak); const fwhms = [];
    for (const p of peaks.slice(0, 400)) { const r = 6; let sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0, bad = false; for (let dy = -r; dy <= r; dy++) { for (let dx = -r; dx <= r; dx++) { const xx = p.x + dx, yy = p.y + dy; if (xx < 0 || yy < 0 || xx >= AW || yy >= AH) { bad = true; break; } let w = at(xx, yy) - med; if (w < 0) w = 0; sw += w; sx += w * dx; sy += w * dy; sxx += w * dx * dx; syy += w * dy * dy; } if (bad) break; } if (bad || sw <= 0) continue; const mx = sx / sw, my = sy / sw, s2 = ((sxx / sw - mx * mx) + (syy / sw - my * my)) / 2; if (s2 <= 0) continue; const fw = 2.3548 * Math.sqrt(s2); if (fw > 1 && fw < 12) fwhms.push(fw); }
    fwhms.sort((a, b) => a - b);
    return { bg_median: +med.toFixed(2), bg_sigma: +sig.toFixed(3), hot_px_survivors: hot, detections_5sigma: det, fwhm_px_median: fwhms.length ? +fwhms[fwhms.length >> 1].toFixed(3) : null, fwhm_n: fwhms.length };
}

// ── render: background-neutralize + linked-MTF STF stretch → RGBA8 ──────────
function mtf(x, m) { if (x <= 0) return 0; if (x >= 1) return 1; return ((m - 1) * x) / ((2 * m - 1) * x - m); }
function sampleSorted(ch) { const s = []; for (let i = 0; i < ch.length; i += 5) { const v = ch[i]; if (v === v) s.push(v); } s.sort((a, b) => a - b); return s; }
function stfRGBA(out) {
    const lo = [], hi = [], x0 = [];
    for (let c = 0; c < 3; c++) { const s = sampleSorted(out[c]), m = s[s.length >> 1]; const mad = (() => { const d = s.map((v) => Math.abs(v - m)).sort((a, b) => a - b); return d[d.length >> 1]; })(); const c0 = m - 2.8 * 1.4826 * mad, h = s[Math.floor(0.9997 * s.length)]; lo.push(c0); hi.push(h > c0 ? h : c0 + 1); x0.push((m - c0) / (hi[c] - c0)); }
    const x0m = (x0[0] + x0[1] + x0[2]) / 3, t = STF_TARGET, mid = Math.max(0.001, Math.min(0.5, (x0m * (1 - t)) / (x0m * (1 - 2 * t) + t)));
    const rgba = Buffer.alloc(APX * 4);
    for (let i = 0; i < APX; i++) { for (let c = 0; c < 3; c++) { let v = out[c][i]; if (v !== v) v = lo[c]; let n = (v - lo[c]) / (hi[c] - lo[c]); n = n < 0 ? 0 : n > 1 ? 1 : n; rgba[i * 4 + c] = Math.round(255 * mtf(n, mid)); } rgba[i * 4 + 3] = 255; }
    return { rgba, mid: +mid.toFixed(4) };
}
function writePNG(p, rgba, w, h) { const png = new PNG({ width: w, height: h }); rgba.copy(png.data); fs.writeFileSync(p, PNG.sync.write(png)); }
function thumb(rgba, w, h, tw) { const f = Math.max(1, Math.round(w / tw)), dw = (w / f) | 0, dh = (h / f) | 0, o = Buffer.alloc(dw * dh * 4); for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { let r = 0, g = 0, b = 0, n = 0; for (let j = 0; j < f; j++) for (let k = 0; k < f; k++) { const si = ((y * f + j) * w + (x * f + k)) * 4; r += rgba[si]; g += rgba[si + 1]; b += rgba[si + 2]; n++; } const di = (y * dw + x) * 4; o[di] = r / n; o[di + 1] = g / n; o[di + 2] = b / n; o[di + 3] = 255; } return { buf: o, w: dw, h: dh }; }

// ── disk-tiled sigma-clip mean combine of N interleaved-RGB reg files ────────
function combineTiled(files) {
    const out = [new Float32Array(APX), new Float32Array(APX), new Float32Array(APX)], cov = new Uint8Array(APX);
    const fds = files.map((f) => fs.openSync(f, 'r'));
    const ROWS = 256, stride = AW * 3 * 4, vals = new Float64Array(files.length);
    const bufs = files.map(() => Buffer.alloc(ROWS * stride));
    try {
        for (let y0 = 0; y0 < AH; y0 += ROWS) {
            const rows = Math.min(ROWS, AH - y0);
            for (let f = 0; f < fds.length; f++) { let off = 0, need = rows * stride; while (off < need) off += fs.readSync(fds[f], bufs[f], off, need - off, y0 * stride + off); }
            const views = bufs.map((b) => new Float32Array(b.buffer, b.byteOffset, rows * AW * 3));
            for (let r = 0; r < rows; r++) for (let x = 0; x < AW; x++) {
                const gi = (y0 + r) * AW + x, li = (r * AW + x) * 3;
                for (let c = 0; c < 3; c++) {
                    let n = 0; for (let f = 0; f < views.length; f++) { const v = views[f][li + c]; if (v === v) vals[n++] = v; }
                    if (c === 0) cov[gi] = n;
                    if (n === 0) { out[c][gi] = 0; continue; }
                    let lo = -Infinity, hi = Infinity, mean = 0;
                    for (let it = 0; it <= CLIP_ITERS; it++) { let s = 0, m = 0; for (let k = 0; k < n; k++) { const v = vals[k]; if (v >= lo && v <= hi) { s += v; m++; } } mean = m ? s / m : 0; if (it === CLIP_ITERS || m < 3) break; let sd = 0; for (let k = 0; k < n; k++) { const v = vals[k]; if (v >= lo && v <= hi) { const d = v - mean; sd += d * d; } } const sg = Math.sqrt(sd / m); lo = mean - CLIP_K * sg; hi = mean + CLIP_K * sg; }
                    out[c][gi] = mean;
                }
            }
        }
    } finally { fds.forEach((fd) => fs.closeSync(fd)); }
    return { out, cov };
}

// ═══ main ═══════════════════════════════════════════════════════════════════
const t0 = Date.now();
const results = {}, shiftLog = {};

for (const variant of ['A', 'B', 'C']) {
    const label = variant === 'A' ? 'no-calibration' : variant === 'B' ? 'dark-only' : 'full-calibration';
    log(`── Stack ${variant} (${label}) ──`);
    const vTmp = path.join(TMP, variant); fs.mkdirSync(vTmp, { recursive: true });
    const cfa = new Float32Array(FW * FH), regFiles = [], regs = []; let refStars = null, refL = null;
    for (let li = 0; li < N; li++) {
        const L = lights[li];
        await cfaFor(L, variant, cfa);
        const { rgb } = demosaicActiveRGB(cfa, FW, FH, AA, PATTERN);
        const luma = lumaI(rgb);
        let reg, rec;
        if (refStars === null) {                       // reference: identity (output grid = ref active grid)
            refStars = detectStars(luma); refL = luma; reg = rgb;
            rec = { id: L.id, solved: L.solved, ref: true, nstars: refStars.length };
        } else {
            const stars = detectStars(luma);
            const tCoarse = coarseT(refL, luma);
            let aff = fitAffineToRef(refStars, stars, tCoarse);
            let fallback = false;
            if (aff.nmatch < 8 || aff.resid == null || aff.resid > 2.5) { aff = { M: [1, 0, 0, 1], t: tCoarse }; fallback = true; } // coarse-translation fallback (catches the dither; WCS affine does not)
            reg = warp(rgb, aff);
            rec = { id: L.id, solved: L.solved, nstars: stars.length, nmatch: aff.nmatch ?? null, resid_px: aff.resid != null ? +aff.resid.toFixed(3) : null, tx: +aff.t[0].toFixed(2), ty: +aff.t[1].toFixed(2), fallback };
        }
        regs.push(rec);
        const rf = path.join(vTmp, `${String(li).padStart(2, '0')}.rgb32`);
        fs.writeFileSync(rf, Buffer.from(reg.buffer, reg.byteOffset, reg.byteLength)); regFiles.push(rf);
        if (li % 5 === 0 || li === N - 1) log(`  ${L.id}${L.solved ? '' : '*'} (${li + 1}/${N}) ${rec.ref ? 'REF nstars=' + rec.nstars : `nmatch=${rec.nmatch} resid=${rec.resid_px}px${rec.fallback ? ' FALLBACK' : ''}`}`);
    }
    shiftLog[variant] = regs;
    const fb = regs.filter((s) => s.fallback).length;
    const mResid = regs.filter((s) => s.resid_px != null).map((s) => s.resid_px).sort((a, b) => a - b);
    log(`  registered ${N} frames (${fb} WCS-fallback; median resid ${mResid.length ? mResid[mResid.length >> 1] : 'n/a'}px); combining (disk-tiled)…`);
    const { out, cov } = combineTiled(regFiles);
    regFiles.forEach((f) => fs.rmSync(f, { force: true }));
    const luma = lumaI(interleave(out)); const stats = statRow(luma, cov);
    let full = 0; for (let i = 0; i < APX; i++) if (cov[i] === N) full++; stats.coverage_full_pct = +(100 * full / APX).toFixed(2);
    log(`  stats bgσ=${stats.bg_sigma} hot=${stats.hot_px_survivors} det5σ=${stats.detections_5sigma} fwhm=${stats.fwhm_px_median} cov100%=${stats.coverage_full_pct}%`);

    const fitsPath = path.join(OUT_BIN, `cocoon_stack_${variant}_${label}.fits`);
    writeFitsPlanar(fitsPath, out, AW, AH, [
        ...wcsCards({ crval: [REF.wcs.ra_hours, REF.wcs.dec_deg], crpix: [CX, CY], cd: CD_REF }),
        ['OBJECT', 'IC5146 Cocoon Nebula'], ['STACKVAR', variant, label], ['NCOMBINE', N, 'sub-frames'],
        ['EXPTIME', N * 240, 'total integration s'], ['COMBINE', 'SIGCLIP', `k=${CLIP_K} it=${CLIP_ITERS}`],
        ['BUNIT', 'ADU', 'linear; dark-subtracted for B/C'], ['ORIGIN', 'tools/stack/stack_cocoon.mjs'],
    ]);
    const { rgba, mid } = stfRGBA(out);
    const pngPath = path.join(OUT_BIN, `cocoon_stack_${variant}_${label}_RENDER.png`); writePNG(pngPath, rgba, AW, AH);
    const th = thumb(rgba, AW, AH, 400); const thumbPath = path.join(OUT_BIN, `cocoon_stack_${variant}_${label}_thumb.png`); writePNG(thumbPath, th.buf, th.w, th.h);
    log(`  wrote ${path.basename(pngPath)} (${AW}x${AH}) mtf=${mid} + thumb ${th.w}x${th.h} + fits`);
    results[variant] = { label, n: N, stats, mtf: mid, fits: fitsPath, render: pngPath, thumb: thumbPath, thumb_dims: `${th.w}x${th.h}` };
}

function interleave(planes) { const o = new Float32Array(APX * 3); for (let i = 0; i < APX; i++) { o[i * 3] = planes[0][i]; o[i * 3 + 1] = planes[1][i]; o[i * 3 + 2] = planes[2][i]; } return o; }

// ── deltas + manifest ───────────────────────────────────────────────────────
const dl = (a, b, k) => { const x = results[a].stats[k], y = results[b].stats[k]; if (x == null || y == null) return null; return { from: x, to: y, abs: +(y - x).toFixed(3), pct: x ? +(100 * (y - x) / x).toFixed(2) : null }; };
const axes = ['bg_sigma', 'hot_px_survivors', 'detections_5sigma', 'fwhm_px_median', 'bg_median'];
const deltas = { 'A->B': {}, 'B->C': {}, 'A->C': {} };
for (const k of axes) for (const p of ['A->B', 'B->C', 'A->C']) deltas[p][k] = dl(p[0], p[3], k);

const manifest = {
    producer: 'tools/stack/stack_cocoon.mjs', mode: FROM_CAL ? 'from-calibrated(n=7 appetizer)' : 'decode(n=25)',
    produced_at: new Date().toISOString(), target: 'IC5146 Cocoon Nebula (60Da + WO Z73, CLS-CCD)',
    n_subs: N, n_solved: lights.filter((l) => l.solved).length, subs: lights.map((l) => ({ id: l.id, solved: l.solved })), reference: REF.id,
    grid: { full: `${FW}x${FH}`, active: `${AW}x${AH}`, pattern: PATTERN }, crpix: [CX, CY], integration_s: N * 240,
    registration: 'STAR-BASED: detect ≤600 star centroids/frame → coarse xcorr bootstrap → iterative NN match to reference → least-squares affine fit (rotation+scale+translation) → single warp into ref grid. WCS affine (oracle for 12 solved, index-interpolated for 13 unsolved) is the fallback if <8 matches or resid>3px.',
    calibration: FROM_CAL ? 'A/B/C reconstructed by inverting calibrate_light full mode (7 pre-built _full.bin)' : 'A=raw decoded CFA; B=raw−masterDark; C=(raw−masterDark)/masterFlat (floor 0.05). masterDark exposure-matched 240s (carries bias pedestal, subtracted whole).',
    combine: `sigma-clip mean k=${CLIP_K} iters=${CLIP_ITERS} (${FROM_CAL ? 'disk-tiled' : 'disk-tiled'})`,
    render: `AESTHETIC: per-channel shadow-clip neutralization + linked-MTF STF (target ${STF_TARGET}); FITS payload stays LINEAR`,
    masters: { dark: '237d306f7df5cff83f680f9fa1769238', flat: '5dccc1ede773a7e3771769f311fd8c47', bias: '92245a55423f21b9571c91e53637dd60' },
    variants: results, deltas, registration_log: shiftLog, elapsed_s: +((Date.now() - t0) / 1000).toFixed(1),
};
const mpath = path.join(OUT_JSON, FROM_CAL ? 'stacks_manifest_n7.json' : 'stacks_manifest.json');
fs.writeFileSync(mpath, JSON.stringify(manifest, null, 2));
try { fs.rmdirSync(TMP, { recursive: true }); } catch { /* best-effort */ }
log(`DONE ${manifest.elapsed_s}s → ${mpath}`);
console.log(JSON.stringify({ n: N, variants: Object.fromEntries(['A', 'B', 'C'].map((k) => [k, results[k].stats])), deltas }, null, 2));
