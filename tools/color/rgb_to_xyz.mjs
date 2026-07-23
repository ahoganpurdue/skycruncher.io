// ═══════════════════════════════════════════════════════════════════════════
// COLOR INCUBATOR — CAMERA-RGB → XYZ/sRGB MATRIX PATH (prototype)
// ═══════════════════════════════════════════════════════════════════════════
// Tier-1 §3.1 of docs/COLOR_MATH_PROGRAM.md. Demonstrates the foundational gap:
// the pipeline treats camera-native science RGB as if it were sRGB (identity
// color matrix), silently mis-projecting color. This driver renders the SAME
// decoded CR2 two ways and measures the difference:
//   BEFORE  = camera-native RGB interpreted directly as linear sRGB (identity)
//   AFTER   = camera RGB → linear sRGB via the body's forward matrix (rgb_cam,
//             dcraw cam_xyz_coeff from the LibRaw/adobe_coeff ColorMatrix2)
// Isolation: BOTH share the same D65 white balance (preMul, implied by the
// matrix) and the same hue-exact tone curve. The ONLY difference is the 3×3
// chromatic rotation → the isolated effect of the color matrix.
//
// LEDGER: pure PIXEL work (render), no WCS/coordinate touch. Reuses the psf
// lane's verified libraw decode (dominant-channel demosaic) + PNG writer.
//
// HONESTY: the libraw mem_image carries a ~4–7% dominant-channel cross-leak and
// a 2px CFA-luminance checkerboard; both contaminate color ratios. This driver
// MEASURES the leak fraction on the actual frame and reports it as the expected
// color-contamination magnitude rather than pretending it away.
//
// Usage:  node tools/color/rgb_to_xyz.mjs <file.cr2> [--body "Canon EOS 60Da"] [--outw 1400]
// Output: test_results/color_incubator/<stem>_{before,after}.png + _matrix_stats.json
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCR2, detectPattern, cfaChannelStats, fixHotPixelsCFA, demosaicBilinear, splitRGB, terminateDecodeWorkers } from '../psf/decode_cr2.mjs';
import { writePNG } from '../psf/imaging.mjs';
import { resolveMatrix, buildTransforms, NO_MATRIX_BODIES } from './camera_matrices.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'test_results', 'color_incubator');

// ─── small helpers ────────────────────────────────────────────────────────────
function medianSample(arr, maxN = 200000) {
    const step = Math.max(1, Math.floor(arr.length / maxN));
    const s = [];
    for (let i = 0; i < arr.length; i += step) s.push(arr[i]);
    s.sort((a, b) => a - b);
    return { med: s[s.length >> 1], p: (q) => s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * q)))] };
}
function apply3(M, r, g, b) {
    return [M[0][0] * r + M[0][1] * g + M[0][2] * b,
            M[1][0] * r + M[1][1] * g + M[1][2] * b,
            M[2][0] * r + M[2][1] * g + M[2][2] * b];
}
function chroma(r, g, b) { const s = r + g + b; return s > 1e-12 ? [r / s, g / s, b / s] : [0, 0, 0]; }

// ─── hue-exact tone render (shared curve; PNG is for QA, stats carry the truth) ─
// Box-downscale linear planes, then luminance-only asinh stretch with chroma
// scaled by Ls/L (hue preserved exactly). Per-image auto-normalization isolates
// CHROMA in the PNG; the true luminance/exposure change from the matrix is
// reported numerically in the stats block, not baked into the picture.
function renderHueExact(R, G, B, w, h, outW) {
    const scale = outW / w, ow = outW, oh = Math.max(1, Math.round(h * scale));
    const aR = new Float64Array(ow * oh), aG = new Float64Array(ow * oh), aB = new Float64Array(ow * oh), cnt = new Float64Array(ow * oh);
    for (let y = 0; y < h; y++) {
        const oy = Math.min(oh - 1, Math.floor(y * scale)), row = y * w, orow = oy * ow;
        for (let x = 0; x < w; x++) {
            const o = orow + Math.min(ow - 1, Math.floor(x * scale));
            aR[o] += R[row + x]; aG[o] += G[row + x]; aB[o] += B[row + x]; cnt[o]++;
        }
    }
    const n = ow * oh, L = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const c = cnt[i] || 1; aR[i] /= c; aG[i] /= c; aB[i] /= c;
        L[i] = 0.2126 * aR[i] + 0.7152 * aG[i] + 0.0722 * aB[i];
    }
    const { med, p } = medianSample(L);
    const bp = med, wp = Math.max(p(0.9995) - bp, 1e-6), a = 40;
    const bytes = new Uint8Array(n * 3), den = Math.asinh(a);
    for (let i = 0; i < n; i++) {
        const Ld = Math.max(0, L[i] - bp);
        const Ls = Math.asinh((Ld / wp) * a) / den;         // display luminance [0,1]
        const ratio = L[i] > 1e-9 ? Ls / L[i] : 0;          // hue-exact chroma scale
        const enc = (v) => Math.max(0, Math.min(255, Math.round(255 * Math.pow(Math.min(1, Math.max(0, v * ratio)), 1 / 2.2))));
        bytes[i * 3] = enc(aR[i]); bytes[i * 3 + 1] = enc(aG[i]); bytes[i * 3 + 2] = enc(aB[i]);
    }
    return { bytes, ow, oh };
}

// ─── bright-star detection + aperture color (native linear grid) ───────────────
function detectStars(G, w, h, maxN = 400) {
    const { med, p } = medianSample(G);
    const sig = Math.max(1e-6, (p(0.84) - med));            // ~1σ from percentile
    const thr = med + 12 * sig, R2 = 2;
    const found = [];
    for (let y = 8; y < h - 8; y += 1) {
        for (let x = 8; x < w - 8; x += 1) {
            const v = G[y * w + x];
            if (v < thr) continue;
            let isMax = true;
            for (let dy = -R2; dy <= R2 && isMax; dy++) for (let dx = -R2; dx <= R2; dx++) {
                if (dx === 0 && dy === 0) continue;
                if (G[(y + dy) * w + (x + dx)] > v) { isMax = false; break; }
            }
            if (isMax) found.push({ x, y, peak: v });
        }
    }
    found.sort((a, b) => b.peak - a.peak);
    return found.slice(0, maxN);
}
function apertureColor(R, G, B, w, h, sx, sy, rad = 2) {
    let r = 0, g = 0, b = 0;
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        const i = (sy + dy) * w + (sx + dx); r += R[i]; g += G[i]; b += B[i];
    }
    return [r, g, b];
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    const file = args.find(a => !a.startsWith('--'));
    if (!file) { console.error('usage: rgb_to_xyz.mjs <file.cr2> [--body "..."] [--outw N]'); process.exit(1); }
    const bodyOverride = args.includes('--body') ? args[args.indexOf('--body') + 1] : null;
    const outW = args.includes('--outw') ? parseInt(args[args.indexOf('--outw') + 1], 10) : 1400;
    const filePath = path.resolve(file);
    const stem = path.basename(filePath).replace(/\.[^.]+$/, '');

    console.log(`[decode] ${filePath}`);
    let { w, h, rgb16, meta } = await decodeCR2(filePath);
    const make = meta?.make || meta?.camera_make || meta?.normalizedMake || '';
    const model = bodyOverride || meta?.model || meta?.camera_model || meta?.normalizedModel || '';
    console.log(`[decode] ${w}x${h}  make="${make}" model="${model}"`);

    // CFA handling + leak measurement (the color-contamination magnitude)
    let det = detectPattern(rgb16, w, h);
    // Exact-meta-match recovery: when Bayer detection fails, the near-degenerate
    // stride tie-break (seen on portrait 60Da singles: coherence 413.3 vs 411.1)
    // may have picked a near-miss factorization over the EXACT meta match, shearing
    // the frame. decode_cr2's own rule is "exact meta match must beat a near-miss";
    // enforce it here when the pattern is not one-hot. (mem_image is a flat
    // interleaved buffer — only the w,h INTERPRETATION changes, not the bytes.)
    if (!det.oneHot && meta?.width && meta?.height && meta.width * meta.height * 3 === rgb16.length && (w !== meta.width || h !== meta.height)) {
        const alt = detectPattern(rgb16, meta.width, meta.height);
        console.log(`[decode] pattern failed at ${w}x${h} (leak=${det.leakFraction.toFixed(3)}); retry exact-meta ${meta.width}x${meta.height} leak=${alt.leakFraction.toFixed(3)} oneHot=${alt.oneHot}`);
        if (alt.oneHot || alt.leakFraction < det.leakFraction) { w = meta.width; h = meta.height; det = alt; }
    }
    let R, G, B;
    if (det.oneHot) {
        const stats = cfaChannelStats(rgb16, w, h, det.pat);
        const hot = fixHotPixelsCFA(rgb16, w, h, det.pat, stats);
        [R, G, B] = demosaicBilinear(rgb16, w, h, det.pat);
        console.log(`[cfa] oneHot pat=[${det.pat}] leakFraction=${det.leakFraction.toFixed(4)} hotFixed=${hot.count}`);
    } else {
        [R, G, B] = splitRGB(rgb16, w, h);
        console.log(`[cfa] NOT one-hot (leak=${det.leakFraction.toFixed(4)}) — split as demosaiced payload`);
    }

    // resolve forward matrix (explicit --body wins over EXIF make/model)
    const mx = bodyOverride ? resolveMatrix('', bodyOverride) : resolveMatrix(make, model);
    if (!mx) {
        const noMatrix = Object.entries(NO_MATRIX_BODIES).find(([k]) => `${make} ${model}`.toLowerCase().includes(k.toLowerCase()));
        console.error(`[matrix] NO MATRIX for make="${make}" model="${model}"` + (noMatrix ? ` — ${noMatrix[1]}` : ' — not in table; pass --body'));
        terminateDecodeWorkers();
        process.exit(2);
    }
    const T = buildTransforms(mx.colorMatrix2);
    console.log(`[matrix] ${mx.key} verified=${mx.verified} preMul=[${T.preMul.map(v => v.toFixed(3))}]`);

    // ── shared white balance (full preMul preserves the matrix neutral point) ──
    const preMul = T.preMul;
    const n = w * h;
    const Rw = new Float32Array(n), Gw = new Float32Array(n), Bw = new Float32Array(n);   // WB'd (BEFORE planes)
    const Ra = new Float32Array(n), Ga = new Float32Array(n), Ba = new Float32Array(n);   // WB'd + matrix (AFTER planes)
    for (let i = 0; i < n; i++) {
        const r = R[i] * preMul[0], g = G[i] * preMul[1], b = B[i] * preMul[2];
        Rw[i] = r; Gw[i] = g; Bw[i] = b;
        const [ar, ag, ab] = apply3(T.cam2srgb, r, g, b);
        Ra[i] = ar; Ga[i] = ag; Ba[i] = ab;
    }

    // ── stats: sky background chromaticity (linear domain) ──
    const skyBefore = [medianSample(Rw).med, medianSample(Gw).med, medianSample(Bw).med];
    const skyAfter = [medianSample(Ra).med, medianSample(Ga).med, medianSample(Ba).med];
    const skyChromaBefore = chroma(...skyBefore), skyChromaAfter = chroma(...skyAfter);

    // ── stats: star colors ──
    const stars = detectStars(G, w, h);
    const starRows = [];
    for (const s of stars) {
        const cb = apertureColor(Rw, Gw, Bw, w, h, s.x, s.y);   // BEFORE (WB'd, identity)
        const ca = apply3(T.cam2srgb, cb[0], cb[1], cb[2]);      // AFTER (matrix)
        const chB = chroma(...cb), chA = chroma(ceil0(ca[0]), ceil0(ca[1]), ceil0(ca[2]));
        starRows.push({ x: s.x, y: s.y, chromaBefore: chB, chromaAfter: chA,
            dr: chA[0] - chB[0], dg: chA[1] - chB[1], db: chA[2] - chB[2] });
    }
    const aggChroma = (key, i) => median1(starRows.map(r => r[key][i]));
    const meanAbsL2 = starRows.length
        ? starRows.reduce((a, r) => a + Math.hypot(r.dr, r.dg, r.db), 0) / starRows.length : null;

    // ── render both PNGs (disk+path only; never inline bytes) ──
    const before = renderHueExact(Rw, Gw, Bw, w, h, outW);
    const after = renderHueExact(Ra, Ga, Ba, w, h, outW);
    const beforePng = path.join(OUT_DIR, `${stem}_before_srgb_assumed.png`);
    const afterPng = path.join(OUT_DIR, `${stem}_after_matrix.png`);
    writePNG(beforePng, before.bytes, before.ow, before.oh);
    writePNG(afterPng, after.bytes, after.ow, after.oh);

    const stats = {
        generated: new Date().toISOString(),
        file: path.relative(ROOT, filePath),
        dims: { w, h }, outW,
        body: { make, model, resolved_key: mx.key, matrix_verified: mx.verified, provenance: mx.provenance },
        colorMatrix2: mx.colorMatrix2,
        transforms: { preMul: T.preMul, cam2srgb_linear: T.cam2srgb, cam2xyz_D65: T.cam2xyz },
        cfa: { oneHot: det.oneHot, pattern: det.pat, leak_fraction: det.leakFraction,
            leak_note: 'dominant-channel cross-leak + 2px CFA checkerboard contaminate color ratios by ~this fraction; deep-red/blue star colors most affected. Rawler integer-demosaic cutover (memory decoder-cutover) is the fix.' },
        white_balance_note: 'D65 preMul (from the matrix) applied identically to BEFORE and AFTER; only cam2srgb differs. srgbToXYZ (colormath.ts) NOT used — this path builds cam->linear-sRGB directly, avoiding the sRGB-primary/0..255 assumption.',
        sky_background_linear: { before_rgb: skyBefore, after_rgb: skyAfter,
            chroma_before: skyChromaBefore, chroma_after: skyChromaAfter,
            chroma_shift: [skyChromaAfter[0] - skyChromaBefore[0], skyChromaAfter[1] - skyChromaBefore[1], skyChromaAfter[2] - skyChromaBefore[2]] },
        stars: {
            n: starRows.length,
            median_chroma_before: [aggChroma('chromaBefore', 0), aggChroma('chromaBefore', 1), aggChroma('chromaBefore', 2)],
            median_chroma_after: [aggChroma('chromaAfter', 0), aggChroma('chromaAfter', 1), aggChroma('chromaAfter', 2)],
            median_chroma_shift: [median1(starRows.map(r => r.dr)), median1(starRows.map(r => r.dg)), median1(starRows.map(r => r.db))],
            mean_abs_chroma_shift_L2: meanAbsL2,
        },
        artifacts: { before_png: path.relative(ROOT, beforePng), after_png: path.relative(ROOT, afterPng) },
    };

    const outJson = path.join(OUT_DIR, `${stem}_matrix_stats.json`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(outJson, JSON.stringify(stats, null, 2));

    console.log('=== MATRIX PATH ===');
    console.log(`  sky chroma  before rgb=[${skyChromaBefore.map(v => v.toFixed(3))}] after=[${skyChromaAfter.map(v => v.toFixed(3))}]`);
    console.log(`  star median chroma shift (r,g,b)=[${stats.stars.median_chroma_shift.map(v => v.toFixed(4))}]  meanAbsL2=${(stats.stars.mean_abs_chroma_shift_L2 || 0).toFixed(4)}  nStars=${starRows.length}`);
    console.log(`  CFA leak fraction=${det.leakFraction.toFixed(4)} (expected color contamination magnitude)`);
    console.log(`  wrote ${path.relative(ROOT, beforePng)}`);
    console.log(`  wrote ${path.relative(ROOT, afterPng)}`);
    console.log(`  wrote ${path.relative(ROOT, outJson)}`);
    terminateDecodeWorkers();
}

function ceil0(v) { return v < 0 ? 0 : v; }
function median1(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }

main().catch(e => { console.error(e); terminateDecodeWorkers(); process.exit(1); });
