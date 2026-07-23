// ═══════════════════════════════════════════════════════════════════════════
// FITS SOLVE-FRAME DUMP — headless decode → detections in the CR2-dump shape
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/corpus/dump_fits_frame.mjs --file <path> [--out <path>]
//        [--topN 3000] [--sigma 3.5] [--maxmp 60]
//
// The overnight driver reads per-frame detection dumps as its input. The CR2
// lane already has them (tools/dslr/dump_cr2_solveframe.mjs → cr2_dets/*.json,
// {x,y,flux,fwhm}). This is the FITS counterpart so the driver treats CR2 and
// FITS uniformly: decode a SeeStar/community FITS via the STACK-lane reader
// (tools/stack/fits_io.mjs — plane reads, footprint-safe normalization), run the
// SAME extract_blobs source-extraction core the app's m4 SourceExtractor wraps
// (mirroring tools/corpus/run_corpus.mjs's FITS-proven extractStars), and write
// the identical solve-frame JSON shape the CR2 dumps use.
//
//   test_results/fits_dets/<id>.json
//     { file, source:'fits-extract', container:'FITS', width, height,
//       scaleArcsecPerPx (header optics, null if absent), focalLengthMm,
//       timestamp, gps:null, cohort, ground_truth, detection:{...},
//       detections: [{x,y,flux,fwhm}] (top-N by flux) }
//
// READ-ONLY w.r.t. the calibrated pipeline: no detection constant is authored
// here; this composes two shipped, verified modules (fits_io + extract_blobs).
//
// OOM GUARD: the corpus holds two super-stacks (Cygnus 374MP, M101 170MP) that
// OOM a headless full-frame decode. --maxmp bounds the decode; over-budget
// frames exit 3 (SKIP_OOM) writing nothing, so a batch loop never crashes on one.
// Exit codes: 0 ok · 2 decode/unsupported error (skip) · 3 OOM-skip.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFits, readLuminanceNormalized } from '../stack/fits_io.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FILE = path.resolve(ROOT, argVal('--file', ''));
const TOP_N = parseInt(argVal('--topN', '3000'), 10);
const SIGMA = parseFloat(argVal('--sigma', '3.5'));   // run_corpus FITS threshold
const MAX_MP = parseFloat(argVal('--maxmp', '60'));    // OOM guard (super-stacks skip)
const OUT = argVal('--out', '');

if (!FILE || !fs.existsSync(FILE)) { console.error(`[fits-dump] FILE NOT FOUND: ${FILE}`); process.exit(2); }

// ── WASM (source extractor core — the same extract_blobs m4/SourceExtractor use)
const w = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/engine/wasm_compute/pkg/wasm_compute.js`);
w.initSync({ module: fs.readFileSync(path.join(ROOT, 'src/engine/wasm_compute/pkg/wasm_compute_bg.wasm')) });

// ── App-equivalent preview transform + extraction (mirrors run_corpus.extractStars,
//    the FITS-proven headless path) — plus fwhm capture (extract_blobs stride 10).
function extractStars(lum, W, H) {
    const g = new Float32Array(lum.length);
    for (let i = 0; i < lum.length; i++) g[i] = Math.min(255, Math.round(Math.min(255, Math.pow(Math.max(0, lum[i]), 1 / 2.2) * 255))) / 255;
    // Stats over NONZERO pixels: mosaic "maxcanvas" exports park the image in a
    // sea of exact-zero canvas that drags global median/sigma to nonsense.
    const sample = [];
    for (let i = 0; i < g.length; i += 997) { if (g[i] > 0) sample.push(g[i]); }
    if (sample.length < 100) for (let i = 0; i < g.length; i += 997) sample.push(g[i]);
    sample.sort((a, b) => a - b);
    const bg = sample[Math.floor(sample.length / 2)];
    const sigma = (sample[Math.floor(sample.length * 0.84)] - bg) || 0.01;
    const flat = w.extract_blobs(g, W, H, bg + SIGMA * sigma, bg);
    const raw = [];
    for (let i = 0; i < flat.length; i += 10) raw.push({ x: flat[i], y: flat[i + 1], flux: flat[i + 4], fwhm: flat[i + 6] });
    const rawCount = raw.length;
    raw.sort((a, b) => b.flux - a.flux);
    // Minimal hygiene standing in for the app's morphology pass: edge artifacts
    // routinely top the raw flux ranking and poison quad selection; near-dupes dilute.
    const margin = 24;
    const stars = [];
    for (const s of raw) {
        if (s.x < margin || s.y < margin || s.x > W - margin || s.y > H - margin) continue;
        if (stars.some(k => Math.abs(k.x - s.x) < 4 && Math.abs(k.y - s.y) < 4)) continue;
        stars.push(s);
        if (stars.length >= TOP_N) break;
    }
    return { stars, rawCount, bg, sigma };
}

function main() {
    const rel = path.relative(ROOT, FILE).replace(/\\/g, '/');
    let f;
    try { f = openFits(FILE); }
    catch (e) { console.error(`[fits-dump] DECODE_UNSUPPORTED ${rel}: ${e.message}`); return 2; }

    const { W, H, NP, cards } = f;
    const mp = (W * H) / 1e6;
    if (mp > MAX_MP) {
        f.close();
        console.error(`[fits-dump] SKIP_OOM ${rel}: ${mp.toFixed(1)}MP > ${MAX_MP}MP guard`);
        return 3;
    }
    console.log(`[fits-dump] ${rel}  ${W}x${H}x${NP} (${mp.toFixed(1)}MP)`);

    let lum;
    try { ({ lum } = readLuminanceNormalized(f)); }
    catch (e) { f.close(); console.error(`[fits-dump] DECODE_FAILED ${rel}: ${e.message}`); return 2; }
    finally { f.close(); }

    const { stars, rawCount, bg, sigma } = extractStars(lum, W, H);
    console.log(`[fits-dump] extract_blobs: ${rawCount} raw -> ${stars.length} kept (bg=${bg.toFixed(4)} sigma=${sigma.toFixed(4)} thr=${SIGMA}σ)`);

    // ── header optics + pointing (INTERNAL: crval[0] = HOURS; FITS card = degrees)
    const focal = +cards.FOCALLEN, pixsz = +cards.XPIXSZ;
    const scaleArcsecPerPx = (focal > 0 && pixsz > 0) ? +(206.265 * pixsz / focal).toFixed(4) : null;
    let ground_truth = null;
    const raCard = cards.CRVAL1 !== undefined ? +cards.CRVAL1 : (cards.RA !== undefined ? +cards.RA : undefined);
    const decCard = cards.CRVAL2 !== undefined ? +cards.CRVAL2 : (cards.DEC !== undefined ? +cards.DEC : undefined);
    if (Number.isFinite(raCard) && Number.isFinite(decCard) && !(raCard === 0 && decCard === 0)) {
        ground_truth = {
            source: cards.CRVAL1 !== undefined ? 'FITS_CRVAL' : 'FITS_RA_DEC',
            ra_h: +(raCard / 15).toFixed(4), dec: +decCard.toFixed(4),
            object: cards.OBJECT ?? null,
        };
    }
    const timestamp = cards['DATE-OBS'] ?? cards['DATE'] ?? null;

    const out = {
        file: rel,
        source: 'fits-extract',
        container: 'FITS',
        width: W, height: H, planes: NP,
        scaleArcsecPerPx,
        focalLengthMm: focal > 0 ? focal : null,
        timestamp,
        gps: null,
        ground_truth,
        header: { FOCALLEN: cards.FOCALLEN ?? null, XPIXSZ: cards.XPIXSZ ?? null, INSTRUME: cards.INSTRUME ?? cards.CREATOR ?? null, OBJECT: cards.OBJECT ?? null },
        detection: { raw_blobs: rawCount, kept: stars.length, bg: +bg.toFixed(6), sigma: +sigma.toFixed(6), sigmaThreshold: SIGMA, source: 'extract_blobs (m4 core)' },
        detections: stars.map(s => ({ x: +s.x.toFixed(2), y: +s.y.toFixed(2), flux: +(+s.flux).toExponential(4), fwhm: +(+(s.fwhm ?? 0)).toFixed(2) })),
    };

    const outPath = OUT
        ? path.resolve(ROOT, OUT)
        : path.join(ROOT, 'test_results', 'fits_dets', `${path.basename(FILE).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_')}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out));
    console.log(`[fits-dump] scale=${scaleArcsecPerPx ?? 'null'}"/px truth=${ground_truth ? `${ground_truth.ra_h}h ${ground_truth.dec}` : 'none'} -> ${path.relative(ROOT, outPath)} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
    return 0;
}

process.exit(main());
