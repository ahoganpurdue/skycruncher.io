#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/quadviz/render_iterations.mjs — per-ITERATION overlay renderer (v0)
// ═══════════════════════════════════════════════════════════════════════════
// Owner directive 2026-07-18 (docs/local/QUADVIZ_ITERATION_PNG_SPEC_2026-07-18.md):
// when the iterative quad-matching + forced-harvest loop runs, emit a full-res PNG
// PER ITERATION showing the harvested/verified stars (by class) + the quad lines,
// so the owner can SEE when the harvest starts picking up noise. This is the
// SECOND half of the pipeline: it consumes the per-iteration RECORDS produced by
// the emitter (rest-integration tools/quadviz/emit_iteration_records.mjs, output
// = manifest.json + iter_NNN.json) and the source frame, and renders one overlay
// per iteration. The single-frame v0 is tools/quadviz/render_overlay.mjs; this
// tool is the multi-iteration wiring of the whole loop.
//
// RENDER-plane only (LAW 1): overlays are drawn ON an aesthetic STF-stretched
// render of the frame — never raw linear luma — and this tool consumes banked
// records and feeds NOTHING back into any solve/WCS/science product.
//
// UNITS / PARITY discipline: every position drawn is a RECORDED PIXEL coordinate
// taken verbatim from a banked record (stars[].x/y, quadLines points) — we do NOT
// reproject. That sidesteps both the crval-hours-vs-degrees trap and the
// image-space y-down parity sign: the pixels were produced by the same read of the
// same frame that the STF render reads. The --wcs receipt is read for LEGEND
// PROVENANCE + footer stats (matched, rms) ONLY.
//
// RADIAL COVERAGE (owner's outward-growth metric, made visible): each record
// carries radialCoverage.maxNormRadius + 5 annuli (half-diagonal-from-centre
// convention, per stages/iterative_bc_record.ts). We draw the annulus grid + a
// BRIGHT ring at maxNormRadius so "the verified set growing toward the corners"
// is a per-iteration visual, and stamp per-annulus counts in the footer.
//
// HONEST-OR-ABSENT: quadLines are empty until the quad_gen receipt block lands
// (2.29.0); rms/matched are ABSENT unless --wcs is given. Everything unmeasured is
// stamped "NOT MEASURED", never a fabricated number.
//
//   node tools/quadviz/render_iterations.mjs \
//        --records <manifest.json | run-dir | records.json> \
//        --image <raw/fits path> [--wcs <receipt.json>] \
//        [--out <dir>] [--prefix render_iter_]
//
import fs from 'node:fs';
import path from 'node:path';
import {
    decodeCR2, detectPattern, demosaicBilinear, splitRGB,
    cfaChannelStats, fixHotPixelsCFA, terminateDecodeWorkers,
} from '../psf/decode_cr2.mjs';
import { openFits, readLuminanceNormalized } from '../stack/fits_io.mjs';
import {
    blend, fillRect, drawText, textWidth, drawRing, stretch, grayToCanvas, encodePng,
} from '../validation/visual/bubble_tiles.mjs';

// ── args ─────────────────────────────────────────────────────────────────────
const A = process.argv.slice(2);
const arg = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d; };
const RECORDS = arg('--records');
const IMAGE = arg('--image');
const WCS = arg('--wcs', null);
let OUTDIR = arg('--out', null);
const PREFIX = arg('--prefix', 'render_iter_');
if (!RECORDS || !IMAGE) {
    console.error('usage: --records <manifest.json | run-dir | records.json> --image <raw/fits> [--wcs <receipt.json>] [--out <dir>] [--prefix render_iter_]');
    process.exit(2);
}
const log = (...a) => console.log('[quadviz-iter]', ...a);
const pad3 = (n) => String(n).padStart(3, '0');

// ── colours (semantic by harvest class; the "new" gold is the growth signal) ──
const COL = {
    new: [255, 210, 60],        // gold  — harvested THIS iteration (new-vs-prior-passes)
    redetected: [80, 240, 160], // green — verified but already seen a prior pass
    below_bound: [235, 90, 90],  // red   — forced-tested but refused at this depth (noise-floor probe)
    annulus: [88, 120, 178],     // dim blue — radial annulus grid (0.2..1.0 iso-r circles)
    maxRing: [120, 222, 255],    // bright cyan — MAX-VERIFIED coverage ring (outward-growth metric)
    quad: [235, 90, 235],        // magenta — det-quad polyline (winning cluster)
    quadVtx: [255, 255, 255],
    panel: [10, 12, 20],
    text: [235, 238, 245],
    dim: [150, 158, 172],
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. RECORD LOADING (emitter output format, tolerant)
// ═══════════════════════════════════════════════════════════════════════════
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

/** Pull the record array out of a tolerant set of container shapes (mirrors the
 *  emitter's extractRecords: bare array, or iterQuadvizRecords/records/
 *  solution.iterQuadvizRecords, or run_summary's iterations[]). */
function extractRecords(obj) {
    if (Array.isArray(obj)) return obj;
    for (const k of ['iterQuadvizRecords', 'records', 'iterations']) {
        if (obj && Array.isArray(obj[k])) return obj[k];
    }
    if (obj && obj.solution && Array.isArray(obj.solution.iterQuadvizRecords)) {
        return obj.solution.iterQuadvizRecords;
    }
    return null;
}

/**
 * Resolve --records into an ordered list of full iteration records.
 *   • a directory  → read manifest.json (emitter output) and load each iter file,
 *                    else glob iter_*.json in that dir.
 *   • a manifest.json → same, relative to its dir.
 *   • any other json → tolerant extract (array / container / run_summary).
 * Returns { records, source, manifest|null }.
 */
function loadRecords(spec) {
    const st = fs.existsSync(spec) ? fs.statSync(spec) : null;
    let dir = null, manifestPath = null;
    if (st && st.isDirectory()) {
        dir = spec;
        const m = path.join(dir, 'manifest.json');
        if (fs.existsSync(m)) manifestPath = m;
    } else if (st && st.isFile() && path.basename(spec).toLowerCase() === 'manifest.json') {
        dir = path.dirname(spec); manifestPath = spec;
    }

    if (manifestPath) {
        const manifest = readJson(manifestPath);
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        const records = files
            .map((f) => ({ ...readJson(path.join(dir, f.file)), _pass: f.pass }))
            .sort((a, b) => (a.pass ?? a._pass ?? 0) - (b.pass ?? b._pass ?? 0));
        return { records, source: manifestPath, manifest };
    }

    if (dir) {
        // no manifest — glob iter_*.json
        const iters = fs.readdirSync(dir)
            .filter((f) => /^iter_\d+\.json$/i.test(f))
            .sort();
        if (iters.length) {
            const records = iters.map((f) => readJson(path.join(dir, f)))
                .sort((a, b) => (a.pass ?? 0) - (b.pass ?? 0));
            return { records, source: dir, manifest: null };
        }
        throw new Error(`no manifest.json or iter_*.json found in directory: ${dir}`);
    }

    // bare records json (array / container / run_summary)
    const raw = readJson(spec);
    const recs = extractRecords(raw);
    if (!recs) {
        throw new Error('no quadviz records: expected a manifest.json / run-dir, a JSON array, ' +
            'or an object with iterQuadvizRecords / records / iterations.');
    }
    return {
        records: recs.slice().sort((a, b) => (a.pass ?? 0) - (b.pass ?? 0)),
        source: spec, manifest: null,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. AESTHETIC BACKGROUND — luma plane -> STF stretch -> grayscale (decode ONCE)
// ═══════════════════════════════════════════════════════════════════════════
function lumaFromCR2(dec) {
    const { w, h, rgb16, meta } = dec;
    let det = detectPattern(rgb16, w, h);
    let W = w, H = h;
    if (!det.oneHot && meta?.width && meta?.height && meta.width * meta.height * 3 === rgb16.length && (w !== meta.width || h !== meta.height)) {
        const alt = detectPattern(rgb16, meta.width, meta.height);
        if (alt.oneHot || alt.leakFraction < det.leakFraction) { W = meta.width; H = meta.height; det = alt; }
    }
    let R, G, B;
    if (det.oneHot) {
        const stats = cfaChannelStats(rgb16, W, H, det.pat);
        fixHotPixelsCFA(rgb16, W, H, det.pat, stats);
        [R, G, B] = demosaicBilinear(rgb16, W, H, det.pat);
        log(`cfa oneHot pat=[${det.pat}] leak=${det.leakFraction.toFixed(4)}`);
    } else {
        [R, G, B] = splitRGB(rgb16, W, H);
        log(`cfa NOT one-hot (leak=${det.leakFraction.toFixed(4)}) — split as demosaiced`);
    }
    const lum = new Float32Array(W * H);
    for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    return { lum, W, H };
}

async function loadBackground(imagePath) {
    const ext = path.extname(imagePath).toLowerCase();
    if (ext === '.fit' || ext === '.fits' || ext === '.fts') {
        const f = openFits(imagePath);
        const { W, H } = f;
        const { lum } = readLuminanceNormalized(f);
        f.close();
        log(`FITS ${W}x${H} (luma via readLuminanceNormalized)`);
        return { lum, W, H, kind: 'FITS' };
    }
    if (ext === '.cr2') {
        const dec = await decodeCR2(imagePath);
        const { lum, W, H } = lumaFromCR2(dec);
        log(`CR2 ${W}x${H} (Bayer demosaic -> luma)`);
        return { lum, W, H, kind: 'CR2' };
    }
    throw new Error(`DECODE_UNSUPPORTED (v0): ${ext} — v0 supports .fit/.fits/.fts and .cr2 (Bayer). ` +
        `X-Trans .RAF and other raws are a v0 non-goal.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. DRAW HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function ringThick(c, cx, cy, rad, col, a, w) {
    for (let k = 0; k < w; k++) drawRing(c, cx, cy, Math.max(1, rad - k), col, a);
}
function dot(c, cx, cy, r, col, a = 1) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
        if (dx * dx + dy * dy <= r * r) blend(c, Math.round(cx) + dx, Math.round(cy) + dy, col[0], col[1], col[2], a);
}
function plus(c, cx, cy, r, col, a, t) {
    for (let d = -r; d <= r; d++) for (let k = -t; k <= t; k++) {
        blend(c, Math.round(cx) + d, Math.round(cy) + k, col[0], col[1], col[2], a);
        blend(c, Math.round(cx) + k, Math.round(cy) + d, col[0], col[1], col[2], a);
    }
}
function thickLine(c, x0, y0, x1, y1, col, r, a = 0.95) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= n; s++) {
        const x = x0 + (x1 - x0) * s / n, y = y0 + (y1 - y0) * s / n;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
            if (dx * dx + dy * dy <= r * r) blend(c, Math.round(x) + dx, Math.round(y) + dy, col[0], col[1], col[2], a);
    }
}

/** Extract quad polylines from a record's quadLines[] (points: [[x,y],...]). */
function quadsFromRecord(r) {
    const out = [];
    for (const q of (r.quadLines ?? [])) {
        const pts = (q.points ?? q.pts ?? q).map((p) => Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y })
            .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (pts.length >= 3) out.push({ pts, label: q.label ?? null });
    }
    return out;
}

// robust significance -> [0,1] via log10 over a global percentile range
function pct(sorted, p) {
    if (!sorted.length) return NaN;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[i];
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
    const t0 = Date.now();
    const { records, source, manifest } = loadRecords(RECORDS);
    if (!records.length) throw new Error('records resolved to an empty set');
    log(`records: ${records.length} pass(es) from ${source}`);

    if (!OUTDIR) OUTDIR = path.dirname(path.resolve(source));
    fs.mkdirSync(OUTDIR, { recursive: true });

    // decode + stretch the frame ONCE; every iteration re-bakes a fresh canvas
    // from the same gray buffer (grayToCanvas is cheap; the decode is not).
    const bg = await loadBackground(IMAGE);
    const { W, H, lum, kind } = bg;
    const gray = stretch(lum, { asinh: 14, lo: 0.30, hi: 0.9985 });
    log(`background stretched ${W}x${H} (${kind}) — reused across ${records.length} iteration(s)`);

    // optional WCS receipt (legend provenance + footer stats)
    let recWcs = null, matchedN = null, rmsArcsec = null, crval1 = NaN, crval2 = NaN, scaleAsec = NaN;
    if (WCS) {
        recWcs = readJson(WCS);
        const sol = recWcs.solution ?? recWcs;
        matchedN = sol.stars_matched ?? (Array.isArray(sol.matched_stars) ? sol.matched_stars.length : null);
        rmsArcsec = Number.isFinite(sol.mean_residual_arcsec) ? sol.mean_residual_arcsec : null;
        const wblk = recWcs.wcs ?? sol.wcs ?? {};
        crval1 = Number(wblk.CRVAL1); crval2 = Number(wblk.CRVAL2);
        scaleAsec = (Number.isFinite(Number(wblk.CD1_1)) && Number.isFinite(Number(wblk.CD2_1)))
            ? Math.hypot(Number(wblk.CD1_1), Number(wblk.CD2_1)) * 3600
            : (Number.isFinite(sol.pixel_scale) ? sol.pixel_scale : NaN);
    }

    // geometry: half-diagonal-from-centre normalized radius (matches the record)
    const cx = (W - 1) / 2, cy = (H - 1) / 2, halfDiag = Math.hypot(cx, cy);

    // global significance range (log10) so star sizing is COMPARABLE across passes
    const allSig = [];
    for (const r of records) for (const s of (r.stars ?? [])) {
        if (Number.isFinite(s.significance) && s.significance > 0) allSig.push(Math.log10(s.significance));
    }
    allSig.sort((a, b) => a - b);
    const sigLo = pct(allSig, 0.05), sigHi = pct(allSig, 0.95);
    const sigRange = (Number.isFinite(sigLo) && Number.isFinite(sigHi) && sigHi > sigLo) ? [sigLo, sigHi] : null;
    const sigSaturated = allSig.length > 0 && !sigRange; // all equal-ish => saturated (honest null)

    // scale-aware sizing
    const baseR = Math.max(4, Math.round(Math.min(W, H) / 300));
    const strokeR = Math.max(1, Math.round(Math.min(W, H) / 1100));

    const rendered = [];
    for (let idx = 0; idx < records.length; idx++) {
        const r = records[idx];
        const pass = Number.isFinite(r.pass) ? r.pass : idx;
        const stars = r.stars ?? [];
        const cov = r.radialCoverage ?? {};
        const maxR = Number.isFinite(cov.maxNormRadius) ? cov.maxNormRadius : null;
        const counts = r.counts ?? { new: 0, redetected: 0, below_bound: 0, total: stars.length };
        const belowN = counts.below_bound ?? counts.belowBound ?? 0;

        const c = grayToCanvas(gray, W, H);

        // ── radial annulus grid (iso-normRadius circles at 0.2..1.0) ──────────
        const annuli = Array.isArray(cov.annuli) ? cov.annuli : [];
        for (const a of annuli) {
            drawRing(c, cx, cy, Math.round(a.hi * halfDiag), COL.annulus, 0.45);
        }
        // radius tick labels up the 12-o'clock spoke
        const ts0 = Math.max(2, Math.round(Math.min(W, H) / 700));
        for (const a of annuli) {
            const ry = Math.round(cy - a.hi * halfDiag);
            if (ry > 4) drawText(c, `R${a.hi.toFixed(1)}`, cx + 6, ry + 2, ts0, COL.annulus, 0.9, true);
        }

        // ── MAX-VERIFIED coverage ring (owner's outward-growth metric) ────────
        if (maxR != null) {
            ringThick(c, cx, cy, Math.round(maxR * halfDiag), COL.maxRing, 0.95, strokeR + 2);
            drawText(c, `MAX VERIFIED R=${maxR.toFixed(3)}`,
                cx + 8, Math.round(cy - maxR * halfDiag) - 10 * ts0, ts0 + 1, COL.maxRing, 1, true);
        }

        // ── stars by class (size by significance; new = gold + plus marker) ───
        for (const s of stars) {
            if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
            const col = COL[s.klass] || COL.redetected;
            let f = 0.5;
            if (sigRange && Number.isFinite(s.significance) && s.significance > 0) {
                f = Math.min(1, Math.max(0, (Math.log10(s.significance) - sigRange[0]) / (sigRange[1] - sigRange[0])));
            }
            const rad = Math.round(baseR * (0.7 + 0.9 * Math.sqrt(f)));
            const a = s.klass === 'below_bound' ? 0.7 : 0.92;
            ringThick(c, s.x, s.y, rad, col, a, strokeR + 1);
            if (s.klass === 'new') plus(c, s.x, s.y, rad + baseR, col, 0.95, strokeR); // spotlight the harvest
        }

        // ── quad polylines (ABSENT until quad_gen 2.29.0) ─────────────────────
        const quads = quadsFromRecord(r);
        for (const q of quads) {
            for (let i = 0; i < q.pts.length; i++) {
                const p = q.pts[i], nxt = q.pts[(i + 1) % q.pts.length];
                thickLine(c, p.x, p.y, nxt.x, nxt.y, COL.quad, strokeR + 1, 0.92);
            }
            for (const p of q.pts) dot(c, p.x, p.y, strokeR + 2, COL.quadVtx, 1);
        }

        // ── footer / legend panel ─────────────────────────────────────────────
        const conv = r.convergence ?? {};
        const annLines = annuli.map((a) =>
            `  R ${a.lo.toFixed(1)}-${a.hi.toFixed(1)}:  NEW ${a.new}  REDET ${a.redetected}  BELOW ${a.belowBound ?? a.below_bound ?? 0}`);
        const lines = [
            `QUADVIZ ITERATIONS - PASS ${pass} OF ${records.length} (RENDER PLANE)`,
            `IMAGE: ${path.basename(IMAGE)}  ${W}X${H}  ${kind}`,
            WCS ? `WCS: ${path.basename(WCS)}` + (Number.isFinite(crval1)
                ? `  CRVAL ${crval1.toFixed(4)},${crval2.toFixed(4)} DEG  SCALE ${Number.isFinite(scaleAsec) ? scaleAsec.toFixed(3) : '?'}"/PX`
                : '') : 'WCS: NOT PROVIDED',
            `BOUND: ${r.bound != null ? r.bound + ' SIGMA' : 'NOT MEASURED'}  (${r.boundProvenance ?? 'ABSENT'})`,
            `COUNTS: NEW ${counts.new}  REDET ${counts.redetected}  BELOW ${belowN}  TOTAL ${counts.total}`,
            `MAX VERIFIED R_NORM: ${maxR != null ? maxR.toFixed(4) : 'NOT MEASURED'}   EXPANDING: ${conv.stillExpanding ? 'YES' : 'NO'}`,
            'RADIAL COVERAGE (VERIFIED = NEW|REDET; BELOW = NOISE-FLOOR PROBE):',
            ...annLines,
            `PROJECTION: ${r.projectionModel ?? 'ABSENT'}   SIGNIFICANCE: ${r.significanceModel ?? 'ABSENT'}` + (sigSaturated ? ' (SNR SATURATED - SIZES UNIFORM)' : ''),
            `STOP: ${conv.stopReason ?? 'N/A'}${conv.stoppedWhileExpanding ? '  [STOPPED WHILE EXPANDING]' : ''}`,
            `SOLVE MATCHED: ${matchedN != null ? matchedN : 'NOT MEASURED'}   RESIDUAL RMS: ${rmsArcsec != null ? rmsArcsec.toFixed(3) + '"' : 'NOT MEASURED'}`,
            `QUADS: ${quads.length ? quads.length : 'NOT MEASURED (QUAD_GEN BLOCK LANDS 2.29.0)'}`,
            'KEY: GOLD=NEW  GREEN=REDETECTED  RED=BELOW-BOUND  CYAN=MAX-VERIFIED RING',
            'POSITIONS: RECORDED PIXELS (NO REPROJECTION)',
        ];

        const ts = Math.max(2, Math.round(Math.min(W, H) / 620));
        const lh = 8 * ts + 6;
        const pad = 6 * ts;
        const boxW = Math.min(W - 2 * pad, Math.max(...lines.map((l) => textWidth(l, ts))) + 2 * pad);
        const boxH = lines.length * lh + pad;
        fillRect(c, pad, pad, boxW, boxH, COL.panel[0], COL.panel[1], COL.panel[2], 210);
        let ly = pad + Math.round(pad / 2);
        for (const l of lines) {
            const isSub = l.startsWith('  ');
            drawText(c, l, pad + Math.round(pad / 2), ly, ts, isSub ? COL.dim : COL.text, 1, false);
            ly += lh;
        }

        // ── encode ─────────────────────────────────────────────────────────────
        const outPng = path.join(OUTDIR, `${PREFIX}${pad3(pass)}.png`);
        const png = encodePng(c);
        fs.writeFileSync(outPng, png);
        const sidecar = {
            tool: 'tools/quadviz/render_iterations.mjs', version: 'v0',
            generated: new Date().toISOString(),
            render_plane_only: true, reprojection: false, positions: 'recorded pixels',
            pass, bound: r.bound ?? null,
            counts, radialCoverage: { maxNormRadius: maxR, annuli },
            convergence: conv,
            starClasses: stars.reduce((m, s) => { m[s.klass] = (m[s.klass] || 0) + 1; return m; }, {}),
            quads: quads.length,
            sigSaturated,
            inputs: { records: source, image: IMAGE, wcs: WCS },
            solveContext: { matched: matchedN, rmsArcsec },
            frame: { W, H, kind }, out: outPng, bytes: png.length,
        };
        fs.writeFileSync(outPng.replace(/\.png$/i, '.quadviz.json'), JSON.stringify(sidecar, null, 2));
        log(`pass ${pass}: bound=${r.bound ?? 'NM'} new=${counts.new} redet=${counts.redetected} below=${belowN} maxR=${maxR != null ? maxR.toFixed(3) : 'NM'} -> ${path.basename(outPng)} (${(png.length / 1e6).toFixed(2)} MB)`);
        rendered.push({ pass, png: outPng, bytes: png.length, counts, maxNormRadius: maxR, bound: r.bound ?? null, stopReason: conv.stopReason ?? null });
    }

    // render-set manifest (index of the produced PNGs)
    const outManifest = {
        schema: 'quadviz_render_manifest/v0',
        tool: 'tools/quadviz/render_iterations.mjs',
        generated: new Date().toISOString(),
        recordsSource: source, image: IMAGE, wcs: WCS,
        frame: { W, H, kind }, count: rendered.length,
        sigSaturated,
        note: 'Per-iteration overlay PNG set (owner directive 2026-07-18). RENDER plane; ' +
            'consumes banked emitter records, feeds nothing back. NOT-MEASURED where absent.',
        renders: rendered,
    };
    const manPath = path.join(OUTDIR, `${PREFIX}render_manifest.json`);
    fs.writeFileSync(manPath, JSON.stringify(outManifest, null, 2));
    log(`wrote ${rendered.length} overlay(s) + manifest -> ${OUTDIR}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (sigSaturated) log('NOTE: significance SNR saturated across all passes — star sizes uniform (honest null; see run README).');

    terminateDecodeWorkers();
})().catch((e) => { console.error('[quadviz-iter] FATAL:', e.message); terminateDecodeWorkers(); process.exit(1); });
