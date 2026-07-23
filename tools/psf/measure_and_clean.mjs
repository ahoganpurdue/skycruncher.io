// ═══════════════════════════════════════════════════════════════════════════
// PSF MEASUREMENT + IMAGE CLEANUP LANE — single entry point
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/psf/measure_and_clean.mjs --file <path.CR2>
//        [--astrometry <file.json>]   solve socket: replaces APPROXIMATE_PROFILE
//        [--iters N]                  RL iterations (default 10)
//        [--rl-scale auto|1|2]        RL grid scale (default auto)
//        [--out <dir>]                default test_results/psf
//        [--cache]                    cache the raw decode for fast re-runs
//        [--selftest]                 run render-primitive self-test and exit
//
// PIPELINE (coordinate/pixel manipulations strictly separated):
//   pixel lane:  decode -> CFA hot-pixel repair -> bilinear demosaic ->
//                vignette gain (multiplicative, FIRST) -> poly background
//                flatten (additive) -> damped RL deconvolution (native grid)
//   coord lane:  Brown-Conrady k1/k2 as forward/inverse COORDINATE functions;
//                star positions get corrected coordinates (numbers move,
//                pixels don't)
//   render:      star/background separation — annulus-bootstrap hole fill,
//                background layer warped ONCE through the coordinate
//                function, per-star fidelity stamps re-placed at corrected
//                coordinates. No plate solve required anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    decodeCR2, terminateDecodeWorkers, detectPattern, cfaChannelStats,
    fixHotPixelsCFA, demosaicBilinear, splitRGB,
} from './decode_cr2.mjs';
import { decodeFITS } from './decode_fits.mjs';
import {
    sortedSample, pctOf, robustStats, bilinearSample, cellMedians,
    fitPoly2D, evalPoly2D, polyTerms2D, makeStretch, downscaleRGB, cropRGB,
    drawPolyline, writePNG, writeMaskPNG,
} from './imaging.mjs';
import {
    SOLVE_SOCKET_CONTRACT, APPROXIMATE_PROFILE, getCorrections,
    fitVignetteFromFrame, applyVignette,
} from './corrections.mjs';
import {
    findMaxima, buildNeighborIndex, hasNeighborWithin, measureStar,
    buildEmpiricalKernel, truncateKernel, upsampleKernel2x, regionGrid3x3, medianOf,
} from './psf.mjs';
import {
    ConvPool, sabFloat32, upsample2x, downsample2x, richardsonLucy, dilateMask,
} from './deconv.mjs';
import {
    mulberry32, buildFootprintMask, labelComponents, annulusStats,
    fillComponentHole, makeStamp, placeStamp, selfTestRenderPrimitives,
} from './render_stage.mjs';
import {
    regionMatrixFromCells, fitRegionPlane, tiltVerdict, renderSurfacePNG,
} from './flatness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FILE = path.resolve(ROOT, argVal('--file', 'Sample Files/corpus/DSLR Images - All Canon T6 Rokinon 14mm/IMG_1653.CR2'));
const ASTROMETRY = argVal('--astrometry', null);
const ITERS = parseInt(argVal('--iters', '12'), 10);
const RL_SCALE_FLAG = argVal('--rl-scale', 'auto');
const OUT_DIR = path.resolve(ROOT, argVal('--out', 'test_results/psf'));
const USE_CACHE = args.includes('--cache');

const REGION_NAMES = ['top-left', 'top-center', 'top-right', 'mid-left', 'center', 'mid-right', 'bottom-left', 'bottom-center', 'bottom-right'];
const LW = [0.2126, 0.7152, 0.0722];

const timings = {};
let tStage = Date.now();
function stage(label) {
    const now = Date.now();
    if (stage.last) timings[stage.last] = now - tStage;
    stage.last = label;
    tStage = now;
    if (label) console.log(`\n== ${label} ==`);
}

function luminanceOf(R, G, B) {
    const L = new Float32Array(R.length);
    for (let i = 0; i < R.length; i++) L[i] = LW[0] * R[i] + LW[1] * G[i] + LW[2] * B[i];
    return L;
}

/** Pixel-to-pixel noise sigma via horizontal-difference MAD (structure-immune). */
function pixelNoiseSigma(L, maxN = 200000) {
    const step = Math.max(1, Math.floor(L.length / maxN));
    const d = [];
    for (let i = 0; i + 1 < L.length; i += step) d.push(Math.abs(L[i + 1] - L[i]));
    d.sort((a, b) => a - b);
    return Math.max(1e-8, 1.4826 * d[d.length >> 1] / Math.SQRT2);
}

/**
 * Low-order polynomial background flatten (in place). Returns model stats.
 * DEFAULT DEG = 2 (measured on this corpus, 2026-07): the background's job is
 * the light-pollution dome + vignette-residual falloff, and a paraboloid is
 * the least order that does it. Deg-3's cubic freedom measurably chases the
 * broad galactic-band ridge — on the beach CR2 the band region's median
 * excess over its row-mates survived at only ~5% under deg-3 vs ~45% under
 * deg-2 — while deg-2 simultaneously IMPROVED sky flatness (R sky-rows tilt
 * z 2.2 -> 1.4). Deg-1 badly undercorrects the dome (z ~ 6). See
 * report.region_flatness for the per-run audit.
 */
function flattenBackground(ch, w, h, deg = 2) {
    const cells = cellMedians(ch, w, h, 64, 3);
    const n = cells.med.length;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        xs[i] = (cells.cx[i] - w / 2) / (w / 2);
        ys[i] = (cells.cy[i] - h / 2) / (h / 2);
    }
    let fit = fitPoly2D(xs, ys, cells.med, null, deg);
    if (!fit) return null;
    // one robust reclip
    const res = new Float64Array(n);
    let ss = 0;
    for (let i = 0; i < n; i++) { res[i] = cells.med[i] - evalPoly2D(fit, xs[i], ys[i]); ss += res[i] * res[i]; }
    const sig = Math.sqrt(ss / n);
    const use = new Uint8Array(n);
    for (let i = 0; i < n; i++) use[i] = Math.abs(res[i]) <= 2.5 * sig ? 1 : 0;
    const refit = fitPoly2D(xs, ys, cells.med, use, deg);
    if (refit) fit = refit;

    // model at cell centers -> pedestal + amplitude
    const mv = new Float64Array(n);
    for (let i = 0; i < n; i++) mv[i] = evalPoly2D(fit, xs[i], ys[i]);
    const sortedMv = Float64Array.from(mv).sort();
    const pedestal = sortedMv[n >> 1];
    const amplitude = sortedMv[n - 1] - sortedMv[0];

    // subtract (model - pedestal): group terms (any deg <= 3) by x-power for row eval
    const cf = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]; // cf[ix][iy]
    fit.terms.forEach(([ix, iy], t) => { cf[ix][iy] = fit.coef[t]; });
    const cx2 = w / 2, cy2 = h / 2;
    for (let y = 0; y < h; y++) {
        const Y = (y - cy2) / cy2;
        const A0 = cf[0][0] + Y * (cf[0][1] + Y * (cf[0][2] + Y * cf[0][3]));
        const A1 = cf[1][0] + Y * (cf[1][1] + Y * cf[1][2]);
        const A2 = cf[2][0] + Y * cf[2][1];
        const A3 = cf[3][0];
        const row = y * w;
        for (let x = 0; x < w; x++) {
            const X = (x - cx2) / cx2;
            ch[row + x] -= (A0 + X * (A1 + X * (A2 + X * A3))) - pedestal;
        }
    }
    return { coefficients: Array.from(fit.coef, (v) => +v.toPrecision(6)), terms: fit.terms, pedestal, amplitude, fit };
}

/** Box-downscale one linear plane (for render-space warping). */
function downscaleLinear(ch, w, h, outW) {
    const scale = outW / w;
    const ow = outW, oh = Math.max(1, Math.round(h * scale));
    const acc = new Float64Array(ow * oh), cnt = new Float64Array(ow * oh);
    for (let y = 0; y < h; y++) {
        const oy = Math.min(oh - 1, Math.floor(y * scale));
        const row = y * w, orow = oy * ow;
        for (let x = 0; x < w; x++) {
            const o = orow + Math.min(ow - 1, Math.floor(x * scale));
            acc[o] += ch[row + x]; cnt[o]++;
        }
    }
    const out = new Float32Array(ow * oh);
    for (let i = 0; i < ow * oh; i++) out[i] = acc[i] / (cnt[i] || 1);
    return { plane: out, ow, oh, scale };
}

function stretchByte(v, lo, hi, ig) {
    let s = (v - lo) / (hi - lo);
    if (s <= 0) return 0;
    if (s >= 1) return 255;
    return Math.round(255 * Math.pow(s, ig));
}

/** 1:1 crop rendered THROUGH the coordinate function (corrected geometry). */
function warpCrop(channels, w, h, coordFn, x0, y0, size, stretch) {
    const bytes = new Uint8Array(size * size * 3);
    const ig = 1 / stretch.gamma;
    const pt = [0, 0];
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            coordFn.toNative(x0 + x, y0 + y, pt);
            const o = (y * size + x) * 3;
            for (let c = 0; c < 3; c++) {
                bytes[o + c] = stretchByte(bilinearSample(channels[c], w, h, pt[0], pt[1]), stretch.lo[c], stretch.hi[c], ig);
            }
        }
    }
    return bytes;
}

/** Overlay reference grids on a downscaled canvas. */
function overlayGrids(bytes, ow, oh, w, h, coordFn, { curved, straight }) {
    const scale = ow / w;
    const pt = [0, 0];
    const lines = [];
    for (let i = 1; i <= 7; i++) {
        lines.push({ vertical: true, at: (i * w) / 8 });
        if ((i * h) / 8 < h) lines.push({ vertical: false, at: (i * h) / 8 });
    }
    for (const ln of lines) {
        if (straight) {
            const pts = ln.vertical
                ? [[ln.at * scale, 0], [ln.at * scale, oh - 1]]
                : [[0, ln.at * scale], [ow - 1, ln.at * scale]];
            drawPolyline(bytes, ow, oh, pts, straight.rgb, straight.alpha);
        }
        if (curved) {
            const pts = [];
            const steps = 64;
            for (let s = 0; s <= steps; s++) {
                const xc = ln.vertical ? ln.at : (s * (w - 1)) / steps;
                const yc = ln.vertical ? (s * (h - 1)) / steps : ln.at;
                coordFn.toNative(xc, yc, pt);
                pts.push([pt[0] * scale, pt[1] * scale]);
            }
            drawPolyline(bytes, ow, oh, pts, curved.rgb, curved.alpha);
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════
async function main() {
    if (args.includes('--selftest')) {
        const st = selfTestRenderPrimitives();
        for (const c of st.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  [${c.detail}]`);
        console.log(st.passed ? '\nSELF-TEST PASSED' : '\nSELF-TEST FAILED');
        return st.passed ? 0 : 1;
    }

    if (!fs.existsSync(FILE)) { console.error(`FILE NOT FOUND: ${FILE}`); return 1; }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const report = {
        tool: 'tools/psf/measure_and_clean.mjs',
        file: path.relative(ROOT, FILE),
        generated: new Date().toISOString(),
        architecture: {
            pixel_lane: 'CFA hot-pixel repair -> bilinear demosaic -> vignette gain (multiplicative, first) -> deg-2 polynomial background flatten -> damped Richardson-Lucy on the NATIVE grid',
            coordinate_lane: 'Brown-Conrady k1/k2 as forward/inverse coordinate transforms applied to star POSITIONS; pixels untouched until the single render-stage warp',
            render_stage: 'star/background separation: annulus-bootstrap hole fill, background warped once through the coordinate function, per-star fidelity stamps re-placed at corrected coordinates',
        },
        solve_socket: { contract: SOLVE_SOCKET_CONTRACT, astrometry_input: ASTROMETRY, active_source: null },
    };

    // ── render-primitive self-test (fast, synthetic) ──
    stage('self-test (render primitives, synthetic)');
    const st = selfTestRenderPrimitives();
    for (const c of st.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  [${c.detail}]`);
    report.render_selftest = { passed: st.passed, checks: st.checks };
    if (!st.passed) console.warn('  WARNING: continuing despite self-test failure');

    // ── 1. decode (dispatch by extension: CR2 via libraw-wasm, FITS native) ──
    const IS_FITS = /\.(fits?|fts)$/i.test(FILE);
    stage(IS_FITS ? 'decode FITS (single-HDU, planar-aware)' : 'decode CR2 (libraw-wasm, worker-shim bridge)');
    let w, h, rgb16, meta = null;
    const CACHE_MAGIC = 0x50534632; // 'PSF2' — v2: dims verified via outward-search inferDims
    const cacheFile = path.join(OUT_DIR, `.decode_cache_${path.basename(FILE)}.bin`);
    let cacheHit = false;
    if (USE_CACHE && fs.existsSync(cacheFile)) {
        const buf = fs.readFileSync(cacheFile);
        if (buf.length > 12 && buf.readUInt32LE(0) === CACHE_MAGIC) {
            w = buf.readUInt32LE(4); h = buf.readUInt32LE(8);
            if (w * h * 3 * 2 === buf.length - 12) {
                rgb16 = new Uint16Array(buf.buffer.slice(12), 0, w * h * 3);
                cacheHit = true;
                console.log(`  cache hit: ${w}x${h} (${cacheFile})`);
            }
        }
        if (!cacheHit) console.log('  stale/invalid cache ignored — re-decoding');
    }
    if (!cacheHit) {
        const dec = IS_FITS ? decodeFITS(FILE) : await decodeCR2(FILE);
        ({ w, h, rgb16, meta } = dec);
        console.log(`  decoded ${w}x${h} (meta says ${meta?.width}x${meta?.height}), ${rgb16.length} u16 elements`);
        if (IS_FITS) console.log(`  FITS: bitpix ${meta.bitpix}, ${meta.planes} plane(s)${meta.planar ? ' (planar RGB -> interleaved)' : ' (mono -> replicated RGB)'}, bzero ${meta.bzero}`);
        if (USE_CACHE) {
            const buf = Buffer.alloc(12 + rgb16.length * 2);
            buf.writeUInt32LE(CACHE_MAGIC, 0);
            buf.writeUInt32LE(w, 4); buf.writeUInt32LE(h, 8);
            Buffer.from(rgb16.buffer, rgb16.byteOffset, rgb16.length * 2).copy(buf, 12);
            fs.writeFileSync(cacheFile, buf);
            console.log(`  cache written: ${cacheFile}`);
        }
    }
    const nPix = w * h;
    report.decoded = {
        width: w, height: h,
        payload: IS_FITS
            ? (meta
                ? `FITS bitpix ${meta.bitpix} ${meta.planar ? 'planar RGB' : 'mono'} -> interleaved Uint16 x3`
                : 'FITS (decode cache hit — layout details in the cache-writing run)')
            : 'libraw-wasm mem_image, interleaved Uint16 x3',
    };

    // ── 2. layout + hot pixels (CFA level, BEFORE any interpolation) ──
    stage('CFA layout + hot-pixel repair');
    const layout = detectPattern(rgb16, w, h);
    console.log(`  mosaic payload: ${layout.oneHot}, pattern ${layout.pat.map((c) => 'RGB'[c]).join('')}, cross-leak ${(100 * layout.leakFraction).toFixed(1)}% (discarded — only the pattern channel is read)`);
    let beforeRGB, work, hot;
    if (layout.oneHot) {
        const cfaStats = cfaChannelStats(rgb16, w, h, layout.pat);
        console.log(`  CFA channel med/sigma: ${cfaStats.map((s, i) => `${'RGB'[i]}=${s.med}/${s.sigma.toFixed(0)}`).join('  ')}`);
        beforeRGB = demosaicBilinear(rgb16, w, h, layout.pat); // as-found (hot pixels intact)
        hot = fixHotPixelsCFA(rgb16, w, h, layout.pat, cfaStats);
        work = demosaicBilinear(rgb16, w, h, layout.pat);
        report.decoded.demosaic = 'bilinear (in-tool), linear camera-native, no WB/color matrix';
        report.decoded.mosaic_pattern = layout.pat.map((c) => 'RGB'[c]).join('');
        report.decoded.cross_leak_fraction = +layout.leakFraction.toFixed(4);
    } else {
        console.log('  payload already demosaiced — splitting planes, RGB-level hot-pixel repair');
        beforeRGB = splitRGB(rgb16, w, h);
        work = beforeRGB.map((ch) => Float32Array.from(ch));
        hot = { count: 0, perChannel: [0, 0, 0] };
        for (let c = 0; c < 3; c++) {
            const ch = work[c];
            const { med, sigma } = robustStats(ch);
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    const vs = ch[i] - med;
                    if (vs < 10 * sigma) continue;
                    let nmax = -Infinity;
                    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                        if (!dx && !dy) continue;
                        const ns = ch[i + dy * w + dx] - med;
                        if (ns > nmax) nmax = ns;
                    }
                    if (vs > 8 * Math.max(nmax, 3 * sigma)) {
                        const nb = [];
                        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (dx || dy) nb.push(ch[i + dy * w + dx]); }
                        nb.sort((a, b) => a - b);
                        ch[i] = (nb[3] + nb[4]) / 2;
                        hot.count++; hot.perChannel[c]++;
                    }
                }
            }
        }
        report.decoded.demosaic = 'payload was already demosaiced';
    }
    console.log(`  hot pixels repaired: ${hot.count} (R=${hot.perChannel[0]} G=${hot.perChannel[1]} B=${hot.perChannel[2]})`);
    if (hot.count > 0.001 * nPix) {
        // a healthy sensor has tens-to-thousands of hot photosites, not millions —
        // a runaway count means the payload layout is misread; refuse to continue
        console.error(`  FATAL: hot-pixel count ${hot.count} exceeds 0.1% of frame — payload layout misread, aborting before garbage propagates`);
        return 1;
    }
    report.hot_pixels = hot;

    // display stretch is ALWAYS derived from the BEFORE image (honest comparison)
    const stretch = makeStretch(beforeRGB);
    report.display_stretch = { percentiles: [stretch.loP, stretch.hiP], lo: stretch.lo, hi: stretch.hi, gamma: stretch.gamma, source: 'BEFORE image statistics, applied identically to all outputs' };

    // saturation mask (pre-vignette values), dilated — RL freeze + fill-mode choice
    stage('saturation mask');
    let globalMax = 0;
    for (let i = 0; i < nPix; i += 7) {
        const m = Math.max(work[0][i], work[1][i], work[2][i]);
        if (m > globalMax) globalMax = m;
    }
    const satLevel = 0.85 * globalMax;
    let satRaw = new Uint8Array(nPix);
    let nSat = 0;
    for (let i = 0; i < nPix; i++) {
        if (work[0][i] >= satLevel || work[1][i] >= satLevel || work[2][i] >= satLevel) { satRaw[i] = 1; nSat++; }
    }
    const satMask = dilateMask(satRaw, w, h, 8);
    satRaw = null;
    console.log(`  saturation level ${satLevel.toFixed(4)} (0.85 x observed max ${globalMax.toFixed(4)}), ${nSat} px, dilated r=8`);
    report.saturation = { level: +satLevel.toFixed(5), observedMax: +globalMax.toFixed(5), rawPixels: nSat };

    // ── 2b. region-flatness audit, BEFORE corrections (star-masked medians) ──
    // 4x3 grid, per channel, LINEAR. The AFTER twin (post vignette+background,
    // pre-deconv) plus a tilt-projection verdict answers the seesaw/inversion
    // question with numbers — see tools/psf/flatness.mjs.
    stage('region flatness audit — BEFORE corrections (4x3 star-masked medians)');
    const FLAT_NX = 4, FLAT_NY = 3;
    const SKY_ROWS = [0, 1]; // top 2/3 — on landscape frames the bottom row is foreground
    const cellsBefore = work.map((ch) => cellMedians(ch, w, h, 64, 3));
    const flatBefore = cellsBefore.map((cells) => regionMatrixFromCells(cells, w, h, FLAT_NX, FLAT_NY));
    const sigmaPixChBefore = work.map((ch) => pixelNoiseSigma(ch));
    const fmtFlat = (m) => Array.from({ length: m.ny }, (_, gy) =>
        '[' + Array.from({ length: m.nx }, (_, gx) => m.med[gy * m.nx + gx].toExponential(2)).join(' ') + ']').join(' ');
    for (let c = 0; c < 3; c++) console.log(`  ${'RGB'[c]} region medians: ${fmtFlat(flatBefore[c])}  (pixel sigma ${sigmaPixChBefore[c].toExponential(2)})`);

    // ── 3. corrections seam (vignette = pixel lane; distortion = coordinate lane) ──
    stage('lens corrections (getCorrections seam)');
    const cellsPreVig = cellsBefore[1]; // G channel sky grid, pre-vignette (shared with the audit)
    const corrections = getCorrections({
        astrometryPath: ASTROMETRY, w, h,
        measureVignette: () => fitVignetteFromFrame(cellsPreVig, w, h),
    });
    report.solve_socket.active_source = corrections.source;
    const vig = corrections.vignette;
    const coordFn = corrections.distortion;
    console.log(`  vignette: gain(r) = 1 + ${vig.a2} r^2 + ${vig.a4} r^4   [${vig.provenance}]`);
    if (vig.frameFit) {
        console.log(`    frame fit: corner/center sky ${vig.frameFit.cornerCenterRatioBefore.toFixed(3)} (${vig.frameFit.stopsBefore.toFixed(2)} stops) -> ${vig.frameFit.cornerCenterRatioAfter.toFixed(3)} after (${vig.frameFit.stopsAfter.toFixed(2)} stops residual)`);
        console.log(`    fit rms ${vig.frameFit.fitRms.toExponential(3)} vs APPROXIMATE_PROFILE(0.7,0.6) rms ${vig.frameFit.profileRms.toExponential(3)}${vig.frameFit.atGridBound ? '  [WARNING: at grid bound]' : ''}`);
    }
    console.log(`  distortion: ${coordFn.model} k1=${coordFn.k1} k2=${coordFn.k2}  [${coordFn.provenance}] — COORDINATE FUNCTION ONLY (no pixel warp before PSF measurement)`);
    console.log(`  corner coordinate shift: ${coordFn.shiftAt(1).toFixed(1)} px at half-diagonal ${coordFn.halfDiagPx.toFixed(0)} px`);
    report.lens_corrections = {
        vignette: {
            model: 'gain(r) = 1 + a2 r^2 + a4 r^4, r normalized to half-diagonal, optical center = frame center (assumption)',
            a2: vig.a2, a4: vig.a4, provenance: vig.provenance,
            profile_seed: APPROXIMATE_PROFILE.vignette,
            frame_fit: vig.frameFit ? {
                corner_center_sky_ratio_before: +vig.frameFit.cornerCenterRatioBefore.toFixed(4),
                corner_center_sky_ratio_after: +vig.frameFit.cornerCenterRatioAfter.toFixed(4),
                falloff_stops_before: +vig.frameFit.stopsBefore.toFixed(3),
                residual_falloff_stops_after: +vig.frameFit.stopsAfter.toFixed(3),
                fit_rms: vig.frameFit.fitRms, approximate_profile_rms: vig.frameFit.profileRms,
                at_grid_bound: vig.frameFit.atGridBound,
            } : null,
        },
        distortion: {
            model: coordFn.model, k1: coordFn.k1, k2: coordFn.k2, provenance: coordFn.provenance,
            r_normalization: 'half-diagonal', optical_center: 'frame center (assumption)',
            corner_shift_px: +coordFn.shiftAt(1).toFixed(1),
            applied_as: 'COORDINATE FUNCTION on star positions + single render-stage background warp (never a pre-measurement pixel resample)',
        },
    };

    // lens-correction visuals: BEFORE bytes must be baked pre-vignette
    stage('lens visual (before) render');
    const lensBefore = downscaleRGB(work[0], work[1], work[2], w, h, 1400, stretch);
    overlayGrids(lensBefore.bytes, lensBefore.ow, lensBefore.oh, w, h, coordFn, {
        straight: { rgb: [70, 190, 215], alpha: 0.55 },
        curved: { rgb: [255, 150, 40], alpha: 0.85 },
    });
    const lensCornerBefore = cropRGB(work[0], work[1], work[2], w, h, 40, 40, 400, stretch);

    // vignette gain — PIXEL lane, multiplicative, before any additive background work
    stage('apply vignette gain');
    applyVignette(work, w, h, vig.a2, vig.a4);

    // lens-correction visuals: AFTER (vignette-corrected pixels; geometry shown
    // via the coordinate function — warp performed in RENDER space only)
    stage('lens visual (after) render');
    {
        const smalls = work.map((ch) => downscaleLinear(ch, w, h, 1400));
        const { ow, oh, scale } = smalls[0];
        const bytes = new Uint8Array(ow * oh * 3);
        const ig = 1 / stretch.gamma;
        const pt = [0, 0];
        for (let y = 0; y < oh; y++) {
            for (let x = 0; x < ow; x++) {
                coordFn.toNative((x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5, pt);
                const sx = (pt[0] + 0.5) * scale - 0.5, sy = (pt[1] + 0.5) * scale - 0.5;
                const o = (y * ow + x) * 3;
                for (let c = 0; c < 3; c++) {
                    bytes[o + c] = stretchByte(bilinearSample(smalls[c].plane, ow, oh, sx, sy), stretch.lo[c], stretch.hi[c], ig);
                }
            }
        }
        overlayGrids(bytes, ow, oh, w, h, coordFn, { straight: { rgb: [255, 150, 40], alpha: 0.85 } });
        writePNG(path.join(OUT_DIR, 'lens_corrections_after.png'), bytes, ow, oh);
    }
    writePNG(path.join(OUT_DIR, 'lens_corrections_before.png'), lensBefore.bytes, lensBefore.ow, lensBefore.oh);
    writePNG(path.join(OUT_DIR, 'lens_corner_before.png'), lensCornerBefore.bytes, 400, 400);
    writePNG(path.join(OUT_DIR, 'lens_corner_after.png'), warpCrop(work, w, h, coordFn, 40, 40, 400, stretch), 400, 400);

    // ── 4. background flatten (additive, after multiplicative vignette) ──
    stage('background model (deg-2 polynomial per channel)');
    report.background = {
        degree: 2,
        degree_rationale: 'least order that models the LP dome + falloff residual; deg-3 cubic freedom chases the broad galactic band (band excess survival ~5% vs ~45% at deg-2 on the beach CR2) without improving flatness — see region_flatness audit',
        grid: '64 px cell medians, one 2.5-sigma reclip',
        channels: [],
    };
    const bgFits = [];
    for (let c = 0; c < 3; c++) {
        const bg = flattenBackground(work[c], w, h, 2);
        bgFits.push(bg.fit);
        report.background.channels.push({
            channel: 'RGB'[c],
            pedestal: +bg.pedestal.toPrecision(5),
            gradient_amplitude: +bg.amplitude.toPrecision(5),
            gradient_vs_pedestal: +(bg.amplitude / bg.pedestal).toFixed(3),
            coefficients: bg.coefficients,
        });
        console.log(`  ${'RGB'[c]}: pedestal ${bg.pedestal.toFixed(5)}, gradient amplitude ${bg.amplitude.toFixed(5)} (${(100 * bg.amplitude / bg.pedestal).toFixed(0)}% of pedestal)`);
    }
    const clean = work; // flattened in place; NATIVE grid, untouched by any warp

    // ── 4b. region-flatness audit, AFTER vignette+background (pre-deconv) ──
    stage('region flatness audit — AFTER vignette+background (pre-deconv)');
    const flatAfter = clean.map((ch) => regionMatrixFromCells(cellMedians(ch, w, h, 64, 3), w, h, FLAT_NX, FLAT_NY));
    const sigmaPixChAfter = clean.map((ch) => pixelNoiseSigma(ch));
    const matOut = (m) => Array.from({ length: m.ny }, (_, gy) =>
        Array.from({ length: m.nx }, (_, gx) => +m.med[gy * m.nx + gx].toPrecision(5)));
    const sigOut = (m) => Array.from({ length: m.ny }, (_, gy) =>
        Array.from({ length: m.nx }, (_, gx) => +m.sigmaMed[gy * m.nx + gx].toPrecision(3)));
    report.region_flatness = {
        method: '4x3 star-masked region medians, LINEAR: 64-px cell medians (step-3 sampling — point sources cannot move a cell median) + one 2.5-sigma region-level cell clip; BEFORE = post hot-pixel/demosaic, pre-vignette; AFTER = post vignette+background, pre-deconvolution',
        grid: { nx: FLAT_NX, ny: FLAT_NY },
        tilt_definition: 'LS plane c0 + c1*X + c2*Y over region centers, X/Y in [-1,1]; proj = AFTER tilt projected on the BEFORE tilt unit direction; sigma from region-median scatter around the plane (dof = n-3)',
        verdict_rule: '|proj| <= 2 sigma -> A_FLAT_WITHIN_NOISE; proj < -2 sigma -> B_INVERTED (went past flat); proj > +2 sigma -> UNDERCORRECTED_RESIDUAL_GRADIENT',
        sky_rows_note: `rows ${SKY_ROWS.join(',')} (top 2/3) — on landscape frames the bottom row is foreground, so the sky-rows verdict is the light-pollution verdict of record; the full-grid verdict includes foreground regions`,
        channels: [],
    };
    for (let c = 0; c < 3; c++) {
        const fitB = fitRegionPlane(flatBefore[c]);
        const fitA = fitRegionPlane(flatAfter[c]);
        const fitBs = fitRegionPlane(flatBefore[c], SKY_ROWS);
        const fitAs = fitRegionPlane(flatAfter[c], SKY_ROWS);
        const vFull = tiltVerdict(fitB, fitA);
        const vSky = tiltVerdict(fitBs, fitAs);
        const tiltOut = (fit, v) => ({
            before_tilt: [+fitB.c1.toPrecision(4), +fitB.c2.toPrecision(4)],
            after_tilt: [+fit.c1.toPrecision(4), +fit.c2.toPrecision(4)],
            proj_after_on_before_dir: +v.proj.toPrecision(4),
            sigma_proj: +v.sigmaProj.toPrecision(3),
            z: +v.z.toFixed(2),
            before_tilt_z: +v.beforeTiltZ.toFixed(2),
            before_pp_amplitude: +v.beforePP.toPrecision(4),
            after_pp_amplitude: +v.afterPP.toPrecision(4),
            after_pp_vs_pixel_noise: +(v.afterPP / sigmaPixChAfter[c]).toFixed(2),
            after_pp_vs_before_pp: +(v.afterPP / Math.max(1e-30, v.beforePP)).toFixed(4),
            // ultra-clean stacks make the region-scatter sigma microscopic, so a
            // z > 2 can flag residuals far below pixel noise — practically flat
            residual_pp_below_pixel_noise: v.afterPP < sigmaPixChAfter[c],
            verdict: v.verdict,
        });
        report.region_flatness.channels.push({
            channel: 'RGB'[c],
            pixel_noise_sigma_before: +sigmaPixChBefore[c].toPrecision(4),
            pixel_noise_sigma_after: +sigmaPixChAfter[c].toPrecision(4),
            before_matrix: matOut(flatBefore[c]),
            before_sigma_med: sigOut(flatBefore[c]),
            after_matrix: matOut(flatAfter[c]),
            after_sigma_med: sigOut(flatAfter[c]),
            tilt_full_grid: { ...tiltOut(fitA, vFull), after_tilt: [+fitA.c1.toPrecision(4), +fitA.c2.toPrecision(4)], before_tilt: [+fitB.c1.toPrecision(4), +fitB.c2.toPrecision(4)] },
            tilt_sky_rows: { ...tiltOut(fitAs, vSky), after_tilt: [+fitAs.c1.toPrecision(4), +fitAs.c2.toPrecision(4)], before_tilt: [+fitBs.c1.toPrecision(4), +fitBs.c2.toPrecision(4)] },
        });
        console.log(`  ${'RGB'[c]} after medians: ${fmtFlat(flatAfter[c])}`);
        console.log(`    sky-rows tilt: before (${fitBs.c1.toExponential(2)}, ${fitBs.c2.toExponential(2)}) -> after (${fitAs.c1.toExponential(2)}, ${fitAs.c2.toExponential(2)}), proj ${vSky.proj.toExponential(2)} (z=${vSky.z.toFixed(1)})  VERDICT: ${vSky.verdict}`);
        console.log(`    full-grid tilt: proj ${vFull.proj.toExponential(2)} (z=${vFull.z.toFixed(1)})  VERDICT: ${vFull.verdict}`);
    }

    // ── 4c. correction surfaces — auditable "what was divided / subtracted" ──
    stage('correction surfaces (vignette gain + background model renders)');
    const vigSurf = renderSurfacePNG(path.join(OUT_DIR, 'correction_vignette_gain.png'), (x, y) => {
        const cxs = (w - 1) / 2, cys = (h - 1) / 2;
        const r2 = ((x - cxs) * (x - cxs) + (y - cys) * (y - cys)) / (cxs * cxs + cys * cys);
        return 1 + vig.a2 * r2 + vig.a4 * r2 * r2;
    }, w, h, 420);
    console.log(`  vignette gain surface: ${vigSurf.flat ? 'FLAT (gain = 1 everywhere)' : `1.0 .. ${vigSurf.max.toFixed(3)}`} -> correction_vignette_gain.png`);
    const bgSurf = [];
    for (let c = 0; c < 3; c++) {
        const s = renderSurfacePNG(path.join(OUT_DIR, `correction_bg_model_${'RGB'[c]}.png`),
            (x, y) => evalPoly2D(bgFits[c], (x - w / 2) / (w / 2), (y - h / 2) / (h / 2)), w, h, 420);
        bgSurf.push(s);
        console.log(`  ${'RGB'[c]} background model surface: ${s.min.toExponential(3)} .. ${s.max.toExponential(3)} (pedestal ${report.background.channels[c].pedestal}) -> correction_bg_model_${'RGB'[c]}.png`);
    }
    report.correction_surfaces = {
        note: 'small grayscale renders of the fitted correction fields, each normalized to its own min..max — the vignette gain is what pixel values were MULTIPLIED by, the background model (minus pedestal) is what was SUBTRACTED',
        vignette_gain: { file: 'correction_vignette_gain.png', min: +vigSurf.min.toPrecision(5), max: +vigSurf.max.toPrecision(5) },
        background_model: bgSurf.map((s, c) => ({
            channel: 'RGB'[c], file: `correction_bg_model_${'RGB'[c]}.png`,
            min: +s.min.toPrecision(5), max: +s.max.toPrecision(5),
            pedestal: report.background.channels[c].pedestal,
        })),
    };

    // ── 5. detection + PSF measurement (NATIVE grid) ──
    stage('star detection + PSF measurement (native grid)');
    const L = luminanceOf(clean[0], clean[1], clean[2]);
    const { med: pedL } = robustStats(L);
    const sigmaPix = pixelNoiseSigma(L);
    console.log(`  luminance pedestal ${pedL.toFixed(5)}, pixel noise sigma ${sigmaPix.toExponential(3)}`);
    const peaks5 = findMaxima(L, w, h, pedL + 5 * sigmaPix, 60000, 8);
    const peaks3 = findMaxima(L, w, h, pedL + 3 * sigmaPix, 150000, 8);
    const nIdx = buildNeighborIndex(peaks3, 12);
    console.log(`  local maxima: ${peaks5.length} @5sigma, ${peaks3.length} @3sigma (crowding reference)`);

    // ── 5a. galactic-band preservation check (region_flatness follow-up) ──
    // Detection-density map (3-sigma maxima per 4x3 region) distinguishes
    // dense-star REAL glow (Milky Way band) from smooth directional LP. The
    // densest sky-row region is the band candidate; its median EXCESS over
    // its row-mates must survive the corrections (the background poly must
    // not flatten real glow to the pedestal). AFTER excess is divided by the
    // vignette gain at the region center so the comparison is gain-fair.
    {
        const dens = new Int32Array(FLAT_NX * FLAT_NY);
        for (const p of peaks3) {
            dens[Math.min(FLAT_NY - 1, Math.floor((p.y / h) * FLAT_NY)) * FLAT_NX
                + Math.min(FLAT_NX - 1, Math.floor((p.x / w) * FLAT_NX))]++;
        }
        let glowReg = -1, glowD = -1;
        const skyDens = [];
        for (const gy of SKY_ROWS) {
            for (let gx = 0; gx < FLAT_NX; gx++) {
                const r = gy * FLAT_NX + gx;
                skyDens.push(dens[r]);
                if (dens[r] > glowD) { glowD = dens[r]; glowReg = r; }
            }
        }
        // DENSITY GATE: the candidate only counts as a REAL band when its
        // detection density clearly exceeds the sky-row norm. Below the gate
        // the excess is smooth directional LP and flattening it is CORRECT
        // (measured: M66 field contrast 1.15x = no band; beach CR2 galactic
        // band 5.9x = band).
        const densMedian = medianOf(skyDens);
        const densContrast = glowD / Math.max(1, densMedian);
        const bandIsReal = densContrast >= 1.5;
        const gy0 = Math.floor(glowReg / FLAT_NX), gx0 = glowReg % FLAT_NX;
        const rcx = (gx0 + 0.5) * w / FLAT_NX, rcy = (gy0 + 0.5) * h / FLAT_NY;
        const ccx = (w - 1) / 2, ccy = (h - 1) / 2;
        const rr2 = ((rcx - ccx) ** 2 + (rcy - ccy) ** 2) / (ccx * ccx + ccy * ccy);
        const gainReg = 1 + vig.a2 * rr2 + vig.a4 * rr2 * rr2;
        const excess = (m) => {
            const others = [];
            for (let gx = 0; gx < FLAT_NX; gx++) if (gx !== gx0) others.push(m.med[gy0 * FLAT_NX + gx]);
            return m.med[glowReg] - medianOf(others);
        };
        const chans = [];
        for (let c = 0; c < 3; c++) {
            const excB = excess(flatBefore[c]);
            const excAraw = excess(flatAfter[c]);
            const excA = excAraw / gainReg;
            const sigComb = Math.hypot(flatBefore[c].sigmaMed[glowReg], flatAfter[c].sigmaMed[glowReg] / gainReg);
            // The row-mate excess mixes band glow with the LP dome's own
            // directional component, and the LP part SHOULD be removed — full
            // survival of the raw excess is not expected. Criterion: a clearly
            // significant positive excess must remain.
            const preserved = !bandIsReal || excB <= 2 * sigComb
                ? null // no real band / no significant excess -> nothing to preserve
                : (excA > Math.max(2 * sigComb, 0.15 * excB));
            chans.push({
                channel: 'RGB'[c],
                band_median_before: +flatBefore[c].med[glowReg].toPrecision(5),
                band_median_after: +flatAfter[c].med[glowReg].toPrecision(5),
                excess_before: +excB.toPrecision(4),
                excess_after_gain_adjusted: +excA.toPrecision(4),
                excess_after_raw: +excAraw.toPrecision(4),
                survival_fraction: excB > 0 ? +(excA / excB).toFixed(3) : null,
                sigma: +sigComb.toPrecision(3),
                preserved,
            });
            console.log(`  galactic band ${'RGB'[c]}: excess vs row-mates ${excB.toExponential(2)} -> ${excA.toExponential(2)} (gain-adj, ${excB > 0 ? (100 * excA / excB).toFixed(0) : '--'}% survival)  ${preserved === null ? '(no distinct band — excess is directional LP, flattening is correct)' : preserved ? 'PRESERVED' : 'FLATTENED — real glow eaten'}`);
        }
        // The band is SIGNAL: when real, the LP-flatness verdict of record is
        // the sky-rows tilt EXCLUDING the band region.
        if (bandIsReal) {
            for (let c = 0; c < 3; c++) {
                const fitBx = fitRegionPlane(flatBefore[c], SKY_ROWS, [glowReg]);
                const fitAx = fitRegionPlane(flatAfter[c], SKY_ROWS, [glowReg]);
                const vX = tiltVerdict(fitBx, fitAx);
                report.region_flatness.channels[c].tilt_sky_rows_excluding_band = {
                    excluded_region: { row: gy0, col: gx0 },
                    note: 'verdict of record for LP flatness when a real band is detected — the band is signal, not background tilt',
                    before_tilt: [+fitBx.c1.toPrecision(4), +fitBx.c2.toPrecision(4)],
                    after_tilt: [+fitAx.c1.toPrecision(4), +fitAx.c2.toPrecision(4)],
                    proj_after_on_before_dir: +vX.proj.toPrecision(4),
                    sigma_proj: +vX.sigmaProj.toPrecision(3),
                    z: +vX.z.toFixed(2),
                    verdict: vX.verdict,
                };
                console.log(`  LP verdict of record (sky rows minus band) ${'RGB'[c]}: proj ${vX.proj.toExponential(2)} (z=${vX.z.toFixed(1)})  ${vX.verdict}`);
            }
        }
        report.region_flatness.galactic_band = {
            method: 'densest 3-sigma-detection sky-row region = band candidate, REAL only if density >= 1.5x the median sky-row region density (dense-star real glow vs smooth directional LP); excess = region median minus median of its row-mates, BEFORE vs AFTER (AFTER divided by vignette gain at region center); preserved = a clearly significant positive excess remains (> max(2 sigma, 15% of before)) — full survival is not expected because the raw excess mixes band glow with the LP dome directional component',
            detection_density_map: Array.from({ length: FLAT_NY }, (_, gy) =>
                Array.from({ length: FLAT_NX }, (_, gx) => dens[gy * FLAT_NX + gx])),
            band_region: { row: gy0, col: gx0, detections: glowD, density_contrast: +densContrast.toFixed(2), distinct_band: bandIsReal, vignette_gain_at_center: +gainReg.toFixed(4) },
            channels: chans,
        };
        console.log(`  detection density (4x3): ${report.region_flatness.galactic_band.detection_density_map.map((r) => `[${r.join(' ')}]`).join(' ')}  -> candidate row ${gy0} col ${gx0}, contrast ${densContrast.toFixed(2)}x -> ${bandIsReal ? 'DISTINCT BAND' : 'no distinct band'}`);
    }

    const pt = [0, 0];
    let rejected;
    const measureSet = (boxR, fwhmCap) => {
        const out = [];
        rejected = { crowded: 0, saturated: 0, fwhmRange: 0, faint: 0, edge: 0, failed: 0 };
        const margin = boxR + 13;
        for (const p of peaks5) {
            if (out.length >= 300) break;
            if (p.x < margin || p.y < margin || p.x >= w - margin || p.y >= h - margin) { rejected.edge++; continue; }
            // saturation: any masked pixel in the 3x3 core
            let sat = false;
            for (let dy = -1; dy <= 1 && !sat; dy++) for (let dx = -1; dx <= 1; dx++) if (satMask[(p.y + dy) * w + p.x + dx]) { sat = true; break; }
            if (sat) { rejected.saturated++; continue; }
            if (hasNeighborWithinSelfTolerant(nIdx, p.x, p.y, 12)) { rejected.crowded++; continue; }
            const m = measureStar(L, w, h, p.x, p.y, sigmaPix, boxR);
            if (!m) { rejected.failed++; continue; }
            if (m.peakAboveBg < 8 * sigmaPix) { rejected.faint++; continue; }
            if (m.fwhmMaj < 1.5 || m.fwhmMaj > fwhmCap || m.fwhmMin < 1.0) { rejected.fwhmRange++; continue; }
            coordFn.toCorrected(m.cx, m.cy, pt);
            m.xCorrected = pt[0]; m.yCorrected = pt[1];
            out.push(m);
        }
        return out;
    };
    // ADAPTIVE WINDOW: a 15x15 cutout truncates the moments (and the kernel
    // wings) once FWHM exceeds ~4.5 px — this Rokinon wide open is soft, so
    // re-measure with a 19x19 window when the quick pass says the PSF is fat.
    let boxR = 7;
    let measured = measureSet(boxR, 8);
    let fwhmMed = measured.length ? medianOf(measured.map((s) => s.fwhmMaj)) : 0;
    if (measured.length >= 20 && fwhmMed > 4.5) {
        boxR = 9;
        measured = measureSet(boxR, 12); // wider cap: soft corner stars must stay in the per-region stats
        fwhmMed = medianOf(measured.map((s) => s.fwhmMaj));
        console.log(`  adaptive window: median FWHM ${fwhmMed.toFixed(2)} px -> re-measured with ${2 * boxR + 1}x${2 * boxR + 1} cutouts, FWHM cap 12`);
    }
    console.log(`  measured set: ${measured.length} bright unsaturated isolated stars  (rejected: ${JSON.stringify(rejected)})`);
    if (measured.length < 20) {
        console.error('  FATAL: too few usable stars for PSF measurement');
        return 1;
    }

    // ── 5b. catalog-forced deep detection (CATALOG_FORCED tier) ──
    // With a solved WCS the catalog says where sub-threshold stars MUST be;
    // forced aperture photometry at those fixed positions carries no
    // position-search trials penalty, so ~2 sigma is an honest bar. Every
    // result is provenance-tagged CATALOG_FORCED (see forced_detect.mjs).
    let forcedSeeds = [];
    if (corrections.wcs && !args.includes('--no-forced')) {
        stage('catalog-forced deep detection (CATALOG_FORCED tier)');
        const { loadAtlasRegion, projectStars, forcedMeasure, recoveryByMagnitude } =
            await import('./forced_detect.mjs');
        const wcs = corrections.wcs;
        const scaleDeg = Math.sqrt(Math.abs(wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0]));
        const radiusDeg = coordFn.halfDiagPx * scaleDeg + 0.5;
        // ultra-wide guard: a >25 deg radius spans dozens of sectors; beyond
        // mag 10 forced photometry on 60"/px pixels is hopeless anyway
        const magLimit = radiusDeg > 25 ? 10 : Infinity;
        const t0f = Date.now();
        const { stars, sectorsLoaded } = loadAtlasRegion({
            root: ROOT, raDeg: wcs.crval[0], decDeg: wcs.crval[1], radiusDeg, magLimit,
        });
        console.log(`  atlas region: ${stars.length} stars within ${radiusDeg.toFixed(1)} deg (sectors [${sectorsLoaded.join(',')}]${Number.isFinite(magLimit) ? `, mag<=${magLimit} ultra-wide guard` : ''}) in ${Date.now() - t0f} ms`);
        const projStars = projectStars({ stars, wcs, coordFn, w, h });
        // position uncertainty of the astrometric model, from the converter's
        // own fit diagnostics (radial post-fit rms + unmodeled tangential rms)
        let posRms = 2;
        try {
            const f = JSON.parse(fs.readFileSync(ASTROMETRY, 'utf8'))?.distortion?.fit;
            posRms = Math.max(2, Math.hypot(f?.radial_rms_after_px ?? 0, f?.tangential_rms_px ?? 0));
        } catch { /* scalar/receipt-less astrometry: keep default */ }
        const { rApPx, results } = forcedMeasure({
            L, w, h, positions: projStars, fwhmPx: fwhmMed, posRmsPx: posRms,
            snrThreshold: 2, sigmaPix,
        });
        // blind coverage: catalog positions already holding a 5-sigma maximum
        const idx5 = buildNeighborIndex(peaks5, 16);
        const matchR = Math.max(1.5 * fwhmMed, posRms);
        let nBlind = 0, nStructured = 0;
        const recoveryEntries = [];
        const forcedOnly = [];
        for (const r of results) {
            const blind = hasNeighborWithin(idx5, r.x, r.y, matchR, -1);
            if (blind) nBlind++;
            else if (r.accepted) forcedOnly.push(r);
            if (r.structured && !blind) nStructured++;
            recoveryEntries.push({ mag: r.mag, recovered: blind || r.accepted });
        }
        const rec = recoveryByMagnitude(recoveryEntries);
        const catalogDepth = projStars.length ? Math.max(...projStars.map((s) => s.mag).filter(Number.isFinite)) : null;
        console.log(`  projected in frame: ${projStars.length} catalog stars (depth mag ${catalogDepth?.toFixed(1)}); aperture r=${rApPx.toFixed(1)} px (posRms ${posRms.toFixed(1)} px), threshold 2.0 sigma`);
        console.log(`  probed ${results.length}: blind-covered(5sigma) ${nBlind}, forced-only accepted ${forcedOnly.length}, structured-bg refusals ${nStructured}, rejected ${results.length - nBlind - forcedOnly.length - nStructured}`);
        console.log(`  limiting magnitude (>=50% recovery): ${rec.limitingMag ?? 'n/a'}${rec.censored ? ' (CENSORED by catalog depth — frame goes deeper than the atlas here)' : ''}`);
        // seeds for the render-stage lift set (deduped integer positions)
        const seedKeys = new Set();
        for (const r of forcedOnly) {
            const sx = Math.round(r.x), sy = Math.round(r.y);
            const key = sy * w + sx;
            if (seedKeys.has(key)) continue;
            seedKeys.add(key);
            forcedSeeds.push({ x: sx, y: sy, v: L[key], provenance: 'CATALOG_FORCED' });
        }
        report.forced_detection = {
            provenance: 'CATALOG_FORCED — aperture flux measured at catalog-predicted positions under the solved WCS; these are NOT blind discoveries and must never be laundered into detections',
            atlas: {
                stars_in_region: stars.length,
                sectors_loaded: sectorsLoaded,
                mag_limit_applied: Number.isFinite(magLimit) ? magLimit : null,
                projected_in_frame: projStars.length,
                catalog_depth_in_frame_mag: catalogDepth != null ? +catalogDepth.toFixed(2) : null,
            },
            aperture_radius_px: +rApPx.toFixed(2),
            position_rms_px: +posRms.toFixed(2),
            snr_threshold: 2,
            probed: results.length,
            blind_covered_5sigma: nBlind,
            forced_accepted_total: results.filter((r) => r.accepted).length,
            forced_only_accepted: forcedOnly.length,
            structured_background_refusals: nStructured,
            limiting_magnitude_50pct: rec.limitingMag,
            limiting_mag_censored_by_catalog_depth: rec.censored,
            recovery_bins: rec.bins,
            forced_only_stars: forcedOnly.slice(0, 300).map((r) => ({
                x: +r.x.toFixed(1), y: +r.y.toFixed(1), mag: r.mag, gaia_id: r.gaia_id,
                bp_rp: r.bp_rp, snr: +r.snr.toFixed(2), provenance: r.provenance,
            })),
        };
    } else if (!corrections.wcs) {
        console.log('\n  (forced-detection tier skipped: no solved WCS in the corrections source)');
    }

    // ── 6. empirical PSF kernel (size follows the measurement window) ──
    stage('empirical PSF kernel');
    const kSize = 2 * boxR + 1;
    const kernelStars = measured.filter((s) => Math.abs(s.fwhmMaj - fwhmMed) < 0.35 * fwhmMed).slice(0, 50);
    const kernelEmp = buildEmpiricalKernel(L, w, h, kernelStars, kSize);
    if (!kernelEmp) { console.error('  FATAL: kernel stack failed'); return 1; }
    console.log(`  stacked ${kernelEmp.nStars} registered ${kSize}x${kSize} cutouts (field-averaged; corner PSFs differ — see region map)`);

    // ── 7. damped Richardson-Lucy on the NATIVE grid ──
    stage('Richardson-Lucy deconvolution');
    let rlScale = RL_SCALE_FLAG === 'auto' ? (fwhmMed < 3.2 ? 2 : 1) : parseInt(RL_SCALE_FLAG, 10);
    let rlKernel = rlScale === 2 ? upsampleKernel2x(kernelEmp.k, kSize) : { k: Float64Array.from(kernelEmp.k), size: kSize };
    rlKernel = truncateKernel(rlKernel.k, rlKernel.size, 0.002);
    if (rlScale === 2 && rlKernel.size > 25) {
        console.log(`  2x kernel too large (${rlKernel.size}px) — falling back to native-res RL`);
        rlScale = 1;
        rlKernel = truncateKernel(kernelEmp.k, kSize, 0.002);
    }
    console.log(`  scale ${rlScale}x (median FWHM ${fwhmMed.toFixed(2)} px), kernel ${rlKernel.size}x${rlKernel.size}, ${ITERS} iterations`);

    let obs, rlW, rlH, rlMask;
    if (rlScale === 2) {
        const up = upsample2x(L, w, h);
        obs = up.arr; rlW = up.w; rlH = up.h;
        rlMask = new Uint8Array(rlW * rlH);
        for (let y = 0; y < rlH; y++) {
            const src = (y >> 1) * w, dst = y * rlW;
            for (let x = 0; x < rlW; x++) rlMask[dst + x] = satMask[src + (x >> 1)];
        }
    } else {
        obs = sabFloat32(nPix); obs.set(L);
        rlW = w; rlH = h; rlMask = satMask;
    }
    const sigmaDampRL = pixelNoiseSigma(obs);
    const pool = new ConvPool();
    console.log(`  conv pool: ${pool.size} workers, damping below 1.5 x ${sigmaDampRL.toExponential(2)}, saturated cores frozen`);
    const t0rl = Date.now();
    const est = await richardsonLucy({ obs, w: rlW, h: rlH, kernel: rlKernel, iters: ITERS, sigmaDamp: sigmaDampRL, mask: rlMask, pool, log: (s) => console.log(s) });
    await pool.destroy();
    const Ldec = rlScale === 2 ? downsample2x(est, rlW, rlH) : Float32Array.from(est);
    console.log(`  RL total: ${((Date.now() - t0rl) / 1000).toFixed(1)} s`);
    obs = null; rlMask = null;

    // luminance-ratio transfer to RGB (chrominance preserved)
    const eps = Math.max(1e-6, 0.5 * sigmaPix);
    const deconv = [new Float32Array(nPix), new Float32Array(nPix), new Float32Array(nPix)];
    for (let i = 0; i < nPix; i++) {
        let r = (Ldec[i] + eps) / (L[i] + eps);
        if (r < 0) r = 0; else if (r > 6) r = 6;
        deconv[0][i] = clean[0][i] * r;
        deconv[1][i] = clean[1][i] * r;
        deconv[2][i] = clean[2][i] * r;
    }

    // ── 8. after-FWHM on the SAME star set ──
    stage('post-deconvolution PSF re-measurement');
    const sigmaPixAfter = pixelNoiseSigma(Ldec);
    let improved = 0, pairs = 0;
    for (const s of measured) {
        // re-find the local max within +-3 px
        let bx = Math.round(s.cx), by = Math.round(s.cy), bv = -Infinity;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
            const X = Math.round(s.cx) + dx, Y = Math.round(s.cy) + dy;
            const v = Ldec[Y * w + X];
            if (v > bv) { bv = v; bx = X; by = Y; }
        }
        const m = measureStar(Ldec, w, h, bx, by, sigmaPixAfter, boxR);
        if (m) {
            s.fwhmMajAfter = m.fwhmMaj; s.fwhmMinAfter = m.fwhmMin; s.ellipticityAfter = m.ellipticity;
            pairs++;
            if (m.fwhmMaj < s.fwhmMaj) improved++;
        }
    }
    const fwhmMedAfter = medianOf(measured.filter((s) => s.fwhmMajAfter).map((s) => s.fwhmMajAfter));
    console.log(`  FWHM(maj) median: ${fwhmMed.toFixed(2)} -> ${fwhmMedAfter.toFixed(2)} px  (${pairs} remeasured, ${(100 * improved / Math.max(1, pairs)).toFixed(0)}% improved)`);
    console.log(`  background pixel noise: ${sigmaPix.toExponential(2)} -> ${sigmaPixAfter.toExponential(2)} (x${(sigmaPixAfter / sigmaPix).toFixed(2)})`);

    // ringing probe (dark moat < -3 sigma). Probe positions are chosen LATER,
    // from saturated star components that were actually LIFTED — the raw
    // brightest saturated maxima are tower beacons in this corpus, and the
    // moat criterion is meaningless on structured content. Run on the RL
    // luminance AND on the final composite (native-profile stamps there must
    // come back clean).
    const probeRinging = (Lsrc, pts, sigma) => {
        let hits = 0, probed = 0;
        for (const [px, py] of pts) {
            if (px < 24 || py < 24 || px >= w - 24 || py >= h - 24) continue;
            probed++;
            const ring = [], ann = [];
            for (let dy = -20; dy <= 20; dy++) for (let dx = -20; dx <= 20; dx++) {
                const r = Math.hypot(dx, dy);
                const v = Lsrc[(py + dy) * w + px + dx];
                if (r >= 4 && r <= 10) ring.push(v);
                else if (r >= 14 && r <= 20) ann.push(v);
            }
            ann.sort((a, b) => a - b);
            const annMed = ann[ann.length >> 1];
            if (Math.min(...ring) < annMed - 3 * sigma) hits++;
        }
        return { probed, hits };
    };

    // ── 9. render stage: star/background separation ──
    stage('render stage: footprints + annulus fill + re-placement');
    // CATALOG_FORCED seeds extend the lift set: a catalog-predicted star that
    // passed the 2-sigma forced tier gets a chance to grow a footprint; if it
    // is too faint to clear the flux-defined boundary it simply stays in the
    // background layer (no fabricated lift).
    const renderPeaks = forcedSeeds.length ? peaks5.concat(forcedSeeds) : peaks5;
    const fpMask = buildFootprintMask({ L, w, h, peaks: renderPeaks, sigmaN: sigmaPix, capRadius: 48 });
    const { labels, flat, comps } = labelComponents(fpMask, L, w, h);
    // provenance: components holding a blind 5-sigma peak are BLIND; those
    // reachable only through a forced seed are CATALOG_FORCED
    const blindCompIds = new Set();
    for (const p of peaks5) { const id = labels[p.y * w + p.x]; if (id) blindCompIds.add(id); }
    const forcedCompIds = new Set();
    for (const s of forcedSeeds) {
        const id = labels[s.y * w + s.x];
        if (id && !blindCompIds.has(id)) forcedCompIds.add(id);
    }
    let maskPx = 0;
    for (const v of fpMask) maskPx += v;
    console.log(`  footprints: ${comps.length} components, ${maskPx} px (${(100 * maskPx / nPix).toFixed(2)}% of frame)`);

    const bgLayer = clean.map((ch) => Float32Array.from(ch));
    const syntheticMask = new Uint8Array(nPix);
    const rng = mulberry32(0xA57501);
    const stamps = [];
    const satStarProbes = [];
    const brightStarProbes = []; // NON-saturated lifted stars — deconvolved stamps, the population where the dark-annuli artifact lived
    const stats = { lifted: 0, liftedCatalogForced: 0, bootstrapFill: 0, planeFill: 0, nativeProfileStamps: 0, ringFallbackStamps: 0, skippedNoAnnulus: 0, skippedNoFlux: 0, skippedGiant: 0, skippedStructured: 0 };
    let subpixSum = 0, subpixMax = 0;
    for (const comp of comps) {
        if (comp.area > 20000) { stats.skippedGiant++; continue; }
        const ann = annulusStats({ channels: bgLayer, L, w, h, comp, flat, mask: fpMask });
        if (!ann) { stats.skippedNoAnnulus++; continue; }
        // STRUCTURED-BACKGROUND GUARD: lifting a point source assumes its
        // annulus is noise-like sky. On man-made structure / foliage (tower
        // lattice glints in this corpus) the annulus scatter explodes and any
        // fill reads as smudge — leave such components in the background
        // layer, which warps rigidly with the scene instead.
        if (ann.sigmaL > 3 * sigmaPix) { stats.skippedStructured++; continue; }
        // Saturated cores were FROZEN during RL, but their surroundings can
        // still carry restoration moats — stamp saturated stars with their
        // NATIVE profile (flux-exact by construction) instead of the
        // deconvolved one so no ringing enters the composite.
        const isSat = satMask[comp.peakIdx] === 1;
        // PER-STAR RINGING FALLBACK (dark-annuli fix, measured on M66): on
        // ultra-deep stacks RL is effectively undamped (damping floor 1.5x a
        // tiny sigma) and rings violently around bright compact stars — the
        // deconvolved luminance dipped 0.054 BELOW background at r=2 on a
        // 0.73-peak star (a >2000-sigma trench no feather can hide). A star
        // whose deconvolved profile drops more than 3 sigma below its native
        // profile anywhere in the footprint gets the NATIVE stamp (same law
        // as saturated stars); deconvolved stamps remain for the majority
        // where RL stayed artifact-free. Flux is exact either way.
        let rings = false;
        if (!isSat) {
            const bar = -3 * sigmaPix;
            for (let k = comp.start; k < comp.end; k++) {
                const p = flat[k];
                if (Ldec[p] - L[p] < bar) { rings = true; break; }
            }
        }
        const useNative = isSat || rings;
        const stamp = makeStamp({ deconvChannels: useNative ? clean : deconv, nativeChannels: clean, comp, flat, ann, w, fwhmPx: fwhmMed });
        if (!stamp) { stats.skippedNoFlux++; continue; }
        if (isSat) stats.nativeProfileStamps++;
        if (rings) stats.ringFallbackStamps = (stats.ringFallbackStamps || 0) + 1;
        const mode = (comp.area >= 140 || isSat) ? 'plane' : 'bootstrap';
        fillComponentHole({ channels: bgLayer, w, comp, flat, ann, mode, rng, syntheticMask });
        if (mode === 'plane') stats.planeFill++; else stats.bootstrapFill++;
        coordFn.toCorrected(comp.cx, comp.cy, pt);
        const offX = Math.round(pt[0] - comp.cx), offY = Math.round(pt[1] - comp.cy);
        const frac = Math.hypot(pt[0] - comp.cx - offX, pt[1] - comp.cy - offY);
        subpixSum += frac; subpixMax = Math.max(subpixMax, frac);
        stamps.push({ stamp, offX, offY });
        if (isSat) {
            // ringing-probe candidates: LIFTED saturated sky stars — the only
            // places where deconvolved/star-lane output meets the composite
            satStarProbes.push({
                peakV: comp.peakV,
                native: [Math.round(comp.cx), Math.round(comp.cy)],
                corrected: [Math.round(comp.cx) + offX, Math.round(comp.cy) + offY],
            });
        } else {
            // dark-annuli metric: bright NON-saturated lifted stars carry the
            // deconvolved stamps — where the moat/fill-seam ring showed up
            brightStarProbes.push({
                peakV: comp.peakV,
                native: [Math.round(comp.cx), Math.round(comp.cy)],
                corrected: [Math.round(comp.cx) + offX, Math.round(comp.cy) + offY],
            });
        }
        stats.lifted++;
        if (forcedCompIds.has(comp.id)) stats.liftedCatalogForced++;
    }
    let synthPx = 0;
    for (const v of syntheticMask) synthPx += v;
    console.log(`  lifted ${stats.lifted} stars (${stats.bootstrapFill} bootstrap fills, ${stats.planeFill} plane+jitter fills, ${stats.nativeProfileStamps} saturated->native profile, ${stats.ringFallbackStamps || 0} RL-ringing->native fallback; skipped: structured=${stats.skippedStructured} annulus=${stats.skippedNoAnnulus} flux=${stats.skippedNoFlux} giant=${stats.skippedGiant})`);
    if (forcedSeeds.length) console.log(`  CATALOG_FORCED provenance: ${forcedCompIds.size} forced-only components grew footprints, ${stats.liftedCatalogForced} lifted (of ${forcedSeeds.length} forced seeds)`);
    console.log(`  synthetic (reconstructed) pixels: ${synthPx} = ${(100 * synthPx / nPix).toFixed(2)}% of frame`);

    // single background warp through the coordinate function
    stage('background warp (single resample) + star re-placement');
    const after = [new Float32Array(nPix), new Float32Array(nPix), new Float32Array(nPix)];
    const synthWarped = new Uint8Array(nPix);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            coordFn.toNative(x, y, pt);
            const i = row + x;
            after[0][i] = bilinearSample(bgLayer[0], w, h, pt[0], pt[1]);
            after[1][i] = bilinearSample(bgLayer[1], w, h, pt[0], pt[1]);
            after[2][i] = bilinearSample(bgLayer[2], w, h, pt[0], pt[1]);
            const nx = Math.round(pt[0]), ny = Math.round(pt[1]);
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && syntheticMask[ny * w + nx]) synthWarped[i] = 1;
        }
    }
    for (const { stamp, offX, offY } of stamps) placeStamp(after, w, h, stamp, offX, offY);
    console.log(`  placed ${stamps.length} stamps at corrected coordinates (integer offsets; mean subpixel residual ${(subpixSum / Math.max(1, stamps.length)).toFixed(3)} px)`);

    // ringing probes at the 20 brightest LIFTED saturated sky stars:
    // RL luminance (moats expected — damped RL around frozen cores) vs the
    // FINAL composite (native-profile stamps: must come back clean)
    satStarProbes.sort((a, b) => b.peakV - a.peakV);
    const probeSet = satStarProbes.slice(0, 20);
    const Lcomp = luminanceOf(after[0], after[1], after[2]);
    const sigmaComp = pixelNoiseSigma(Lcomp);
    // NATIVE BASELINE first: on this corpus the ring criterion also trips on
    // as-found content (dark mast pixels under tower-top beacons, photon
    // noise near blown cores). The artifact metric is ADDED hits vs baseline.
    const ringNative = probeRinging(L, probeSet.map((s) => s.native), sigmaPix);
    const ringDeconv = probeRinging(Ldec, probeSet.map((s) => s.native), sigmaPixAfter);
    const ringComposite = probeRinging(Lcomp, probeSet.map((s) => s.corrected), sigmaComp);
    console.log(`  ringing probe (lifted saturated stars): native baseline ${ringNative.hits}/${ringNative.probed} -> RL luminance ${ringDeconv.hits}/${ringDeconv.probed} -> final composite ${ringComposite.hits}/${ringComposite.probed} (native-profile stamps)`);
    // dark-annuli probe: 20 brightest NON-saturated lifted stars (feathered
    // deconvolved stamps) — composite must not exceed the native baseline
    brightStarProbes.sort((a, b) => b.peakV - a.peakV);
    const brightSet = brightStarProbes.slice(0, 20);
    const ringNativeBright = probeRinging(L, brightSet.map((s) => s.native), sigmaPix);
    const ringCompositeBright = probeRinging(Lcomp, brightSet.map((s) => s.corrected), sigmaComp);
    // equal-bar variant: the composite's GLOBAL sigma is lower than native
    // (RL smooths faint regions), which hands the composite a stricter 3-sigma
    // criterion for the same physical annulus noise — judge both at the
    // native frame's sigma for an apples-to-apples artifact count
    const ringCompositeBrightEq = probeRinging(Lcomp, brightSet.map((s) => s.corrected), sigmaPix);
    console.log(`  ringing probe (bright non-saturated lifted stars): native baseline ${ringNativeBright.hits}/${ringNativeBright.probed} -> final composite ${ringCompositeBright.hits}/${ringCompositeBright.probed} (own sigma) / ${ringCompositeBrightEq.hits}/${ringCompositeBrightEq.probed} (equal native-sigma bar)`);
    if (args.includes('--debug-rings')) {
        // radial medians around the 5 brightest probed stars: native vs composite
        const prof = (Lsrc, cxp, cyp) => {
            const bins = Array.from({ length: 21 }, () => []);
            for (let dy = -20; dy <= 20; dy++) for (let dx = -20; dx <= 20; dx++) {
                const r = Math.round(Math.hypot(dx, dy));
                if (r > 20) continue;
                const X = cxp + dx, Y = cyp + dy;
                if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
                bins[r].push(Lsrc[Y * w + X]);
            }
            return bins.map((b) => { b.sort((p, q) => p - q); return b.length ? +b[b.length >> 1].toExponential(4) : null; });
        };
        for (const s of brightSet.slice(0, 5)) {
            console.log(`  [debug-rings] star @native(${s.native}) corrected(${s.corrected}) peakV=${s.peakV.toExponential(3)}`);
            console.log(`    native   : ${prof(L, s.native[0], s.native[1]).join(' ')}`);
            console.log(`    composite: ${prof(Lcomp, s.corrected[0], s.corrected[1]).join(' ')}`);
        }
        console.log(`  [debug-rings] sigmaPix=${sigmaPix.toExponential(3)} sigmaComp=${sigmaComp.toExponential(3)}`);
    }

    // ── 10. outputs ──
    stage('output renders');
    const beforeSmall = downscaleRGB(beforeRGB[0], beforeRGB[1], beforeRGB[2], w, h, 1400, stretch);
    writePNG(path.join(OUT_DIR, 'before.png'), beforeSmall.bytes, beforeSmall.ow, beforeSmall.oh);
    const afterSmall = downscaleRGB(after[0], after[1], after[2], w, h, 1400, stretch);
    writePNG(path.join(OUT_DIR, 'after.png'), afterSmall.bytes, afterSmall.ow, afterSmall.oh);

    // star-dense 400 px 1:1 crop (window chosen in CORRECTED space).
    // Density is counted over the VETTED star set — raw maxima cluster on
    // foreground structure (tower lattices, foliage) and would steer the
    // crop away from the sky.
    const corrPts = measured.map((s) => [s.xCorrected, s.yCorrected]);
    let bestWin = { x: w / 2 - 200, y: h / 2 - 200, n: -1 };
    for (let wy = 50; wy + 400 < h - 50; wy += 100) {
        for (let wx = 50; wx + 400 < w - 50; wx += 100) {
            let cnt = 0;
            for (const [X, Y] of corrPts) if (X >= wx && X < wx + 400 && Y >= wy && Y < wy + 400) cnt++;
            if (cnt > bestWin.n) bestWin = { x: wx, y: wy, n: cnt };
        }
    }
    console.log(`  star-dense crop window: (${bestWin.x}, ${bestWin.y}) with ${bestWin.n} detections (corrected coords)`);
    const cropAfter = cropRGB(after[0], after[1], after[2], w, h, bestWin.x, bestWin.y, 400, stretch);
    writePNG(path.join(OUT_DIR, 'crop_after.png'), cropAfter.bytes, 400, 400);
    // crop_before: as-found pixels sampled THROUGH the same coordinate function so geometry aligns
    writePNG(path.join(OUT_DIR, 'crop_before.png'), warpCrop(beforeRGB, w, h, coordFn, bestWin.x, bestWin.y, 400, stretch), 400, 400);
    writeMaskPNG(path.join(OUT_DIR, 'synthetic_mask.png'), synthWarped, w, h, 1400);

    // ── 11. report ──
    stage('report');
    const fld = (list, f) => {
        const v = list.map((s) => s[f]).filter(Number.isFinite);
        return v.length ? +medianOf(v).toFixed(3) : null;
    };
    const withAfter = measured.filter((s) => Number.isFinite(s.fwhmMajAfter));
    report.detection = {
        maxima_5sigma: peaks5.length, maxima_3sigma: peaks3.length,
        luminance_pedestal: +pedL.toPrecision(5), pixel_noise_sigma: +sigmaPix.toPrecision(4),
        measured_stars: measured.length, rejected,
    };
    report.psf = {
        measured_on: 'NATIVE untouched pixel grid (no resampling before measurement)',
        method: `second moments above 1.5-sigma isophote in ${kSize}x${kSize} cutouts (adaptive window), principal-axis FWHM`,
        cutout_size: kSize,
        global_before: {
            fwhm_major_median: fld(measured, 'fwhmMaj'), fwhm_minor_median: fld(measured, 'fwhmMin'),
            ellipticity_median: fld(measured, 'ellipticity'),
            fwhm_major_p10: +pctOf(Float64Array.from(measured.map((s) => s.fwhmMaj)).sort(), 0.1).toFixed(3),
            fwhm_major_p90: +pctOf(Float64Array.from(measured.map((s) => s.fwhmMaj)).sort(), 0.9).toFixed(3),
        },
        global_after: {
            fwhm_major_median: fld(withAfter, 'fwhmMajAfter'), fwhm_minor_median: fld(withAfter, 'fwhmMinAfter'),
            ellipticity_median: fld(withAfter, 'ellipticityAfter'),
            improved_fraction: +(improved / Math.max(1, pairs)).toFixed(3),
        },
        regions_3x3: REGION_NAMES.map((name, i) => ({
            region: name,
            before: regionGrid3x3(measured, w, h, 'fwhmMaj')[i],
            after: regionGrid3x3(withAfter, w, h, 'fwhmMajAfter')[i],
            ellipticity_before: regionGrid3x3(measured, w, h, 'ellipticity')[i].median,
        })),
        kernel_stars: kernelEmp.nStars,
        kernel_size: kSize,
        mean_psf_kernel: Array.from({ length: kSize }, (_, j) => Array.from({ length: kSize }, (_, i) => +kernelEmp.k[j * kSize + i].toFixed(6))),
        noise_sigma_before: +sigmaPix.toPrecision(4),
        noise_sigma_after: +sigmaPixAfter.toPrecision(4),
        ringing_probe: {
            criterion: 'ring r in [4,10] dips below local annulus median - 3 sigma, probed at the 20 brightest LIFTED saturated sky stars (tower beacons excluded by the structured guard)',
            native_baseline: { probed: ringNative.probed, dark_moat_hits: ringNative.hits },
            deconvolved_luminance: { probed: ringDeconv.probed, dark_moat_hits: ringDeconv.hits },
            final_composite: { probed: ringComposite.probed, dark_moat_hits: ringComposite.hits },
            note: 'saturated stars are stamped with native profiles; the artifact metric is composite hits ABOVE the native baseline (the ring criterion also trips on as-found structure/noise near blown cores)',
            bright_nonsaturated: {
                criterion: 'same ring criterion at the 20 brightest NON-saturated lifted stars — the population where the dark-annuli artifact lived',
                native_baseline: { probed: ringNativeBright.probed, dark_moat_hits: ringNativeBright.hits },
                final_composite: { probed: ringCompositeBright.probed, dark_moat_hits: ringCompositeBright.hits },
                final_composite_equal_native_sigma_bar: { probed: ringCompositeBrightEq.probed, dark_moat_hits: ringCompositeBrightEq.hits },
                equal_bar_note: 'the composite global sigma is lower than native (RL smooths faint regions), so its own-sigma criterion is stricter for identical annulus noise; the equal-bar row is the apples-to-apples artifact count',
            },
        },
    };
    report.richardson_lucy = {
        grid_scale: rlScale, iterations: ITERS, kernel_size: rlKernel.size,
        damping: 'updates pulled to 1 below 1.5 x noise sigma (smoothstep), ratio clamp [0.25, 4]',
        saturated_core_freeze: true,
        applied_to: 'luminance; RGB via luminance-ratio transfer (chrominance preserved)',
    };
    report.render_stage = {
        implemented: [
            'flux-defined footprints (descent-constrained flood fill > local bg + 0.5 sigma, cap r=48)',
            'annulus sigma-clipped stats (reusable aperture-photometry primitive: render_stage.annulusStats)',
            'bootstrap RGB-triplet hole fill (small stars) — true noise distribution + channel correlation',
            'first-order plane + bootstrap residual jitter fill (large/bright stars)',
            'structured-background guard: components whose annulus is not noise-like sky (>3x frame noise) stay in the background layer — foreground structure is never lifted/filled',
            'saturated stars stamped with NATIVE profile (RL moats around frozen cores never reach the composite)',
            'single background warp through the coordinate function',
            'per-star fidelity stamp re-placement at corrected coordinates, exact luminance flux preserved',
        ],
        stubs: [
            'homogenized-PSF placement (render_stage.placeStarsHomogenized — labeled seam)',
            'sub-pixel stamp placement (stamps land on integer offsets; mean residual below)',
            'tps distortion input (contract reserved, not implemented)',
        ],
        components: comps.length, ...stats,
        forced_seed_positions: forcedSeeds.length,
        forced_components_grown: forcedCompIds.size,
        subpixel_residual_mean_px: +(subpixSum / Math.max(1, stamps.length)).toFixed(3),
        subpixel_residual_max_px: +subpixMax.toFixed(3),
        synthetic_pixels: synthPx,
        synthetic_pixels_pct: +(100 * synthPx / nPix).toFixed(3),
        trust_story: `${(100 * synthPx / nPix).toFixed(2)}% of background pixels are statistically reconstructed from their own annuli; star pixels are re-placed original photons (deconvolved, flux-preserved); everything else is original photons through one bilinear warp.`,
        note_nebulosity: 'stars on nebulosity are handled by annulus locality; structured filaments UNDER large plane-filled stars are approximated by the plane — honestly unrecoverable',
    };
    report.star_table = measured.map((s) => ({
        x_native: +s.cx.toFixed(2), y_native: +s.cy.toFixed(2),
        x_corrected: +s.xCorrected.toFixed(2), y_corrected: +s.yCorrected.toFixed(2),
        flux: +s.flux.toPrecision(4), peak: +s.peak.toPrecision(4),
        fwhm_maj: +s.fwhmMaj.toFixed(3), fwhm_min: +s.fwhmMin.toFixed(3),
        ellipticity: +s.ellipticity.toFixed(3), theta_deg: +s.thetaDeg.toFixed(1),
        fwhm_maj_after: Number.isFinite(s.fwhmMajAfter) ? +s.fwhmMajAfter.toFixed(3) : null,
        fwhm_min_after: Number.isFinite(s.fwhmMinAfter) ? +s.fwhmMinAfter.toFixed(3) : null,
    }));
    stage(null);
    report.timings_ms = timings;
    report.outputs = ['before.png', 'after.png', 'crop_before.png', 'crop_after.png',
        'lens_corrections_before.png', 'lens_corrections_after.png',
        'lens_corner_before.png', 'lens_corner_after.png', 'synthetic_mask.png',
        'correction_vignette_gain.png', 'correction_bg_model_R.png',
        'correction_bg_model_G.png', 'correction_bg_model_B.png', 'psf_report.json']
        .map((f) => path.join(path.relative(ROOT, OUT_DIR), f));
    fs.writeFileSync(path.join(OUT_DIR, 'psf_report.json'), JSON.stringify(report, null, 2));

    console.log('\n== 3x3 region FWHM(maj) median, before -> after ==');
    for (let gy = 0; gy < 3; gy++) {
        const cells = [];
        for (let gx = 0; gx < 3; gx++) {
            const r = report.psf.regions_3x3[gy * 3 + gx];
            cells.push(`${r.before.median ?? '—'} -> ${r.after.median ?? '—'} (n=${r.before.n})`);
        }
        console.log('  ' + cells.join('   |   '));
    }
    console.log(`\nDONE. Outputs in ${OUT_DIR}`);
    return 0;
}

/** neighbor check that tolerates the point being its own entry in the index. */
function hasNeighborWithinSelfTolerant(idx, x, y, r) {
    const { map, cellSize, points } = idx;
    const gx = x / cellSize | 0, gy = y / cellSize | 0;
    const reach = Math.ceil(r / cellSize);
    for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
            const arr = map.get((gx + dx) * 100000 + (gy + dy));
            if (!arr) continue;
            for (const i of arr) {
                const p = points[i];
                const d2 = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
                if (d2 < r * r && d2 > 2.25) return true; // > 1.5 px: not itself
            }
        }
    }
    return false;
}

const code = await main().catch((err) => { console.error('FATAL:', err); return 1; });
terminateDecodeWorkers();
setTimeout(() => process.exit(code), 250);
