// ═══════════════════════════════════════════════════════════════════════════
// DEMOSAIC REFERENCE + CFA-PARITY STUDY (headless, no browser)  — task #15
// ═══════════════════════════════════════════════════════════════════════════
//   node tools/rawlab/demosaic_reference.mjs [--file <p>]... [--out <json>]
//
// Evidence base for the decoder cutover. For the bundled CR2 + N corpus CR2s:
//   (a) SHIPPED path: libraw-wasm imageData() = dcraw_make_mem_image RGB16
//       document-mode dominant-channel mosaic (metadata_reaper convertMemImage-
//       ToRgb gray luminance L=(R+G+B)/65535 per site — a CFA mosaic in luma).
//   (b) There is NO raw-CFA accessor in the installed libraw-wasm (only
//       imageData/metadata/open — see inspect_libraw_api.mjs). The only CFA the
//       engine can obtain = the DOMINANT channel of the mem_image per Bayer
//       parity. This script reconstructs it and demosaics it with a
//       DETERMINISTIC INTEGER (fixed-point u16) bilinear kernel — the reference
//       a GPU port can reproduce bit-for-bit (floats cannot, per the 1-ULP study).
//
// Quantifies: dims-factor ambiguity, CFA pattern, empirical black/white levels
// (libraw-wasm exposes neither), the dominant-channel cross-leak (100 random
// px), and the period-2 row/checker parity artifact present in the SHIPPED
// mosaic luminance vs ABSENT in the integer-demosaiced reference.
//
// Reuses the audited decode + pattern rails from tools/psf/decode_cr2.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCR2, detectPattern, terminateDecodeWorkers } from '../psf/decode_cr2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const outArg = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : null; })();
const fileArgs = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--file') fileArgs.push(args[i + 1]);

const DEFAULT_FILES = [
    'public/demo/sample_observation.cr2',
    'Sample Files/challenge/DSLR Images - All Canon T6 Rokinon 14mm/IMG_1653.CR2',
    'Sample Files/challenge/DSLR Images - All Canon T6 Rokinon 14mm/IMG_1757.CR2',
    'Sample Files/challenge/DSLR Images - All Canon T6 Rokinon 14mm/IMG_1238.CR2',
    'Sample Files/rotating/CSM30803_5DMkIII_iso6400_15s.CR2',
];
const FILES = (fileArgs.length ? fileArgs : DEFAULT_FILES).map(f => path.resolve(ROOT, f));
const OUT = path.resolve(ROOT, outArg || 'test_results/cfa_parity_study_2026-07-09.json');

const PAT_NAMES = { R: 0, G: 1, B: 2 };
const patToName = (pat) => pat.map(c => 'RGB'[c]).join('');

// ── deterministic seeded PRNG (mulberry32) so the 100-px leak sample is stable ─
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── empirical black/white levels (libraw-wasm exposes NEITHER in metadata) ────
function levels(mem, w, h) {
    const n = w * h * 3;
    let mn = Infinity, mx = -Infinity;
    const samp = [];
    const step = Math.max(3, (Math.floor(n / 400000) * 3)); // stay on channel-0 phase? no: full
    for (let i = 0; i < n; i += 3) { // dominant+leak all channels via i, i+1, i+2
        for (let c = 0; c < 3; c++) {
            const v = mem[i + c];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        if (i % (997 * 3) === 0) samp.push(mem[i], mem[i + 1], mem[i + 2]);
    }
    samp.sort((a, b) => a - b);
    const q = (p) => samp[Math.min(samp.length - 1, Math.max(0, Math.floor(p * samp.length)))];
    return { min: mn, max: mx, p0001: q(0.0001), p50: q(0.5), p9999: q(0.9999), sampled: samp.length };
}

// ── cross-leak on 100 deterministic random pixels ─────────────────────────────
function crossLeak(mem, w, h, pat) {
    const rnd = mulberry32(0x5eed15);
    const nPx = 100;
    const leaks = [], sumOverDom = [], samples = [];
    let done = 0, tries = 0;
    while (done < nPx && tries < nPx * 50) {
        tries++;
        const x = Math.floor(rnd() * w), y = Math.floor(rnd() * h);
        const i = (y * w + x) * 3;
        const a = mem[i], b = mem[i + 1], c = mem[i + 2];
        const trip = [a, b, c];
        const dom = trip.indexOf(Math.max(a, b, c));
        const domV = trip[dom];
        if (domV <= 0) continue; // skip dead/black sites — leak ratio undefined
        const others = trip.filter((_, k) => k !== dom);
        const leak = Math.max(...others) / domV;
        const sum = a + b + c;
        leaks.push(leak);
        sumOverDom.push(sum / domV);
        if (samples.length < 12) samples.push({ x, y, parity: 'RGB'[pat[(y & 1) * 2 + (x & 1)]], rgb: [a, b, c], dom: 'RGB'[dom], leak: +leak.toFixed(5) });
        done++;
    }
    const med = (arr) => { const s = [...arr].sort((p, q) => p - q); return s[s.length >> 1]; };
    const mean = (arr) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
    const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    return {
        n: done,
        leak_median: +med(leaks).toFixed(5),
        leak_mean: +mean(leaks).toFixed(5),
        leak_p90: +pct(leaks, 0.9).toFixed(5),
        leak_max: +Math.max(...leaks).toFixed(5),
        sum_over_dominant_median: +med(sumOverDom).toFixed(5),
        samples,
    };
}

// ── DETERMINISTIC INTEGER (fixed-point u16) bilinear demosaic ─────────────────
// Reads ONLY the dominant channel per Bayer parity (the true photosite). Sums
// of <=4 u16 fit in u32; /2 and /4 are rounded integer shifts -> bit-identical
// on any integer engine (GPU port safe; floats are not, per the 1-ULP study).
function demosaicIntegerLuma(mem, w, h, pat) {
    const n = w * h;
    const R = new Uint16Array(n), G = new Uint16Array(n), B = new Uint16Array(n);
    const planes = [R, G, B];
    // scatter native photosite value (dominant channel) into its plane
    for (let y = 0; y < h; y++) {
        const row = y * w, pr = (y & 1) * 2;
        for (let x = 0; x < w; x++) {
            const c = pat[pr + (x & 1)];
            planes[c][row + x] = mem[(row + x) * 3 + c];
        }
    }
    const pR = pat.indexOf(0), pB = pat.indexOf(2);
    const ry = pR >> 1, rx = pR & 1, by = pB >> 1, bx = pB & 1;
    const clx = (x) => x < 0 ? 0 : (x >= w ? w - 1 : x);
    const cly = (y) => y < 0 ? 0 : (y >= h ? h - 1 : y);
    const d2 = (a, b) => (a + b + 1) >> 1;         // /2 rounded
    const d4 = (a, b, c, dd) => (a + b + c + dd + 2) >> 2; // /4 rounded

    // L_ref = R+G+B (matches the SHIPPED sum-of-channels luma, so the ONLY
    // difference between arms is the demosaic — isolates the CFA parity artifact)
    const Lref = new Uint32Array(n);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        const yu = cly(y - 1) * w, yd = cly(y + 1) * w;
        const yp = y & 1;
        for (let x = 0; x < w; x++) {
            const xp = x & 1;
            const c = pat[yp * 2 + xp];
            const xl = clx(x - 1), xr = clx(x + 1);
            let rr, gg, bb;
            // G plane
            if (c === 1) gg = G[row + x];
            else gg = d4(G[yu + x], G[yd + x], G[row + xl], G[row + xr]);
            // R plane
            if (yp === ry && xp === rx) rr = R[row + x];
            else if (yp === by && xp === bx) rr = d4(R[yu + xl], R[yu + xr], R[yd + xl], R[yd + xr]);
            else if (yp === ry) rr = d2(R[row + xl], R[row + xr]);
            else rr = d2(R[yu + x], R[yd + x]);
            // B plane
            if (yp === by && xp === bx) bb = B[row + x];
            else if (yp === ry && xp === rx) bb = d4(B[yu + xl], B[yu + xr], B[yd + xl], B[yd + xr]);
            else if (yp === by) bb = d2(B[row + xl], B[row + xr]);
            else bb = d2(B[yu + x], B[yd + x]);
            Lref[row + x] = rr + gg + bb;
        }
    }
    return Lref;
}

// ── parity metrics: checker (-1)^(x+y), rowParity (-1)^y, colParity (-1)^x ─────
// plus even/odd row means and the 4 RGGB 2x2 phase-class means. Scale-invariant
// (normalized by mean), so shipped vs reference luma weightings are comparable.
function parity(L, w, h) {
    let sum = 0, checker = 0, rowP = 0, colP = 0, n = 0;
    let evenR = 0, evenN = 0, oddR = 0, oddN = 0;
    const cls = [0, 0, 0, 0], clsN = [0, 0, 0, 0];
    for (let y = 0; y < h; y++) {
        const yodd = y & 1;
        for (let x = 0; x < w; x++) {
            const v = L[y * w + x];
            sum += v; n++;
            const s = (x + y) & 1 ? -v : v;
            checker += s;
            rowP += yodd ? -v : v;
            colP += (x & 1) ? -v : v;
            if (yodd) { oddR += v; oddN++; } else { evenR += v; evenN++; }
            const cidx = (x & 1) | (yodd << 1);
            cls[cidx] += v; clsN[cidx]++;
        }
    }
    const mean = sum / Math.max(1, n);
    return {
        mean: +mean.toFixed(3),
        checker: +(Math.abs(checker / n) / Math.max(1e-9, mean)).toExponential(4),
        rowParity: +(Math.abs(rowP / n) / Math.max(1e-9, mean)).toExponential(4),
        colParity: +(Math.abs(colP / n) / Math.max(1e-9, mean)).toExponential(4),
        evenRowMean: +(evenR / Math.max(1, evenN)).toFixed(2),
        oddRowMean: +(oddR / Math.max(1, oddN)).toFixed(2),
        phaseRGGB: cls.map((s, i) => +(s / Math.max(1, clsN[i])).toFixed(2)),
    };
}

async function processFile(fp) {
    const rel = path.relative(ROOT, fp);
    if (!fs.existsSync(fp)) return { file: rel, status: 'ABSENT' };
    const t0 = Date.now();
    console.log(`\n[study] decoding ${rel} ...`);
    const { w, h, rgb16: mem, meta } = await decodeCR2(fp);
    const { oneHot, pat, leakFraction } = detectPattern(mem, w, h);
    const lv = levels(mem, w, h);
    const cl = crossLeak(mem, w, h, pat);

    // SHIPPED luma = document-mode gray * 65535 = mem[3p]+mem[3p+1]+mem[3p+2]
    const n = w * h;
    const Lship = new Uint32Array(n);
    for (let p = 0; p < n; p++) { const i = p * 3; Lship[p] = mem[i] + mem[i + 1] + mem[i + 2]; }
    const Lref = demosaicIntegerLuma(mem, w, h, pat);

    const pShip = parity(Lship, w, h);
    const pRef = parity(Lref, w, h);
    const red = (a, b) => a > 0 ? +(((a - b) / a) * 100).toFixed(1) : null;

    const memLen = mem.length;
    // Enumerate alternate near-miss factorizations of mem/3 (the dims-two-ways trap)
    const N = memLen / 3;
    const altFactors = [];
    for (let d = -12; d <= 12; d++) {
        const ww = w + d;
        if (d !== 0 && ww > 16 && N % ww === 0) altFactors.push(`${ww}x${N / ww}`);
    }
    const result = {
        file: rel,
        status: 'OK',
        camera: `${meta?.camera_make || ''} ${meta?.camera_model || ''}`.trim(),
        active: { w, h },
        raw_sensor: {
            raw_width: meta?.raw_width, raw_height: meta?.raw_height,
            top_margin: meta?.top_margin, left_margin: meta?.left_margin,
        },
        mem: { elements: memLen, equals_w_h_3: memLen === w * h * 3 },
        dims_ambiguity: { pixels: N, chosen: `${w}x${h}`, alt_near_miss_factorizations: altFactors },
        cfa: { pattern: patToName(pat), pat, oneHot, leakFraction: +leakFraction.toFixed(5) },
        levels_empirical: lv,
        cross_leak_100px: cl,
        parity: {
            shipped_cfa_mosaic: pShip,
            integer_demosaic_reference: pRef,
            checker_reduction_pct: red(pShip.checker, pRef.checker),
            rowParity_reduction_pct: red(pShip.rowParity, pRef.rowParity),
            colParity_reduction_pct: red(pShip.colParity, pRef.colParity),
        },
        decode_ms: Date.now() - t0,
    };
    console.log(`  ${result.camera} active ${w}x${h} pat=${result.cfa.pattern} leak(med)=${cl.leak_median} black~${lv.min} white~${lv.max}`);
    console.log(`  parity checker  shipped=${pShip.checker} ref=${pRef.checker} (-${result.parity.checker_reduction_pct}%)`);
    console.log(`  parity rowParity shipped=${pShip.rowParity} ref=${pRef.rowParity} (-${result.parity.rowParity_reduction_pct}%)`);
    return result;
}

async function main() {
    console.log(`[study] ${FILES.length} target(s); out=${path.relative(ROOT, OUT)}`);
    const results = [];
    for (const fp of FILES) {
        try { results.push(await processFile(fp)); }
        catch (e) { console.error(`[study] ${path.relative(ROOT, fp)} FAILED: ${e.message}`); results.push({ file: path.relative(ROOT, fp), status: 'FAILED', error: e.message }); }
    }
    const doc = {
        study: 'cfa_parity_decoder_cutover',
        date: '2026-07-09',
        libraw_wasm_api: {
            module_exports: ['default'],
            instance_methods: ['imageData', 'metadata', 'open', 'runFn', 'waitForWorker', 'worker'],
            raw_cfa_accessor: null,
            raw_cfa_available: false,
            note: 'ONLY imageData() (dcraw_make_mem_image, document-mode via open{noInterpolation}) is exposed. No rawImageData()/bayerData()/raw_image. metadata() has NO black_level, white_level, cam_mul(WB), or cfa_pattern.',
        },
        decode_open_params: { noInterpolation: true, outputBps: 16, noAutoBright: true, useCameraWb: false, useAutoWb: false },
        cutover_contract: {
            'CFA u16 mosaic': 'NOT provided as raw. Reconstructable = dominant channel of mem_image per Bayer parity (this study).',
            'CFA pattern': 'NOT in metadata. Inferred by per-parity channel dominance (detectPattern).',
            'black level': 'NOT provided. Already subtracted by document mode (empirical min ~0).',
            'white/saturation level': 'NOT provided. Empirical max reported per file.',
            'white balance (cam_mul)': 'NOT provided. useCameraWb:false => no WB applied; multipliers unavailable.',
            'crop / active area': 'PROVIDED: raw_width/raw_height/top_margin/left_margin + active width/height.',
        },
        files: results,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
    console.log(`\n[study] wrote ${path.relative(ROOT, OUT)} (${results.filter(r => r.status === 'OK').length}/${results.length} OK)`);
    terminateDecodeWorkers();
    return 0;
}
const code = await main().catch(e => { console.error('[study] FATAL:', e); return 1; });
setTimeout(() => process.exit(code), 300);
