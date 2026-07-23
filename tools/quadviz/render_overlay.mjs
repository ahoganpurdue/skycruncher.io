#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/quadviz/render_overlay.mjs — per-iteration overlay renderer v0
// ═══════════════════════════════════════════════════════════════════════════
// Owner directive 2026-07-18 (docs/local/QUADVIZ_ITERATION_PNG_SPEC_2026-07-18.md):
// when the iterative quad-matching + harvest loop runs, emit a full-resolution PNG
// per iteration showing (a) the quad lines behind the accepted pose and (b) the
// test stars highlighted, so the owner can SEE when the harvest starts picking up
// noise. The loop does not exist yet; this v0 proves the VISUAL LANGUAGE on
// SINGLE-frame, single-record banked data.
//
// RENDER-plane only (LAW 1): overlays are drawn ON an aesthetic STF-stretched
// render of the frame — never raw linear luma — and this tool consumes banked
// records and feeds NOTHING back into any solve/WCS/science product.
//
// UNITS / PARITY discipline (v0 choice): every position we draw is a RECORDED
// PIXEL coordinate taken verbatim from a banked record (matched_stars.x/y,
// quad detPts.x/y) — we do NOT reproject. That sidesteps both the crval-hours-
// vs-degrees trap (receipt WCS crval[0] is RA-HOURS; quad/incubator records are
// RA-DEGREES) and the image-space y-down parity sign: the pixels were produced
// by the same read of the same frame, so they land where the render puts them.
// The --wcs block is read for LEGEND PROVENANCE ONLY. Reprojection is a v0
// non-goal (see the honest-limitations note in the handoff).
//
// Decode lanes reused as-is (no new heavy deps):
//   FITS  -> tools/stack/fits_io.mjs   (readLuminanceNormalized — the exact luma
//            the solver reads)
//   CR2   -> tools/psf/decode_cr2.mjs  (dominant-channel RGB16 trap documented
//            in-file; Bayer demosaic mirrors tools/color/rgb_to_xyz.mjs)
// Drawing + STF + PNG encode reused from tools/validation/visual/bubble_tiles.mjs
// (RGBA canvas, 5x7 font, ring markers, asinh stretch, deflate-9 PNG).
//
//   node tools/quadviz/render_overlay.mjs \
//        --image <raw/fits path> --wcs <source json> \
//        [--quads <records json>] [--forced <receipt.json>] --out <png path>
//
import fs from 'node:fs';
import path from 'node:path';
import {
    decodeCR2, detectPattern, demosaicBilinear, splitRGB,
    cfaChannelStats, fixHotPixelsCFA, terminateDecodeWorkers,
} from '../psf/decode_cr2.mjs';
import { openFits, readLuminanceNormalized } from '../stack/fits_io.mjs';
import {
    makeCanvas, blend, fillRect, drawText, textWidth, drawRing, stretch, grayToCanvas, encodePng,
} from '../validation/visual/bubble_tiles.mjs';

// ── args ─────────────────────────────────────────────────────────────────────
const A = process.argv.slice(2);
const arg = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d; };
const IMAGE = arg('--image');
const WCS = arg('--wcs');
const QUADS = arg('--quads', null);
const FORCED = arg('--forced', null);
const OUT = arg('--out');
if (!IMAGE || !WCS || !OUT) {
    console.error('usage: --image <raw/fits> --wcs <source.json> [--quads <records.json>] [--forced <receipt.json>] --out <png>');
    process.exit(2);
}
const log = (...a) => console.log('[quadviz]', ...a);

// ── colors ────────────────────────────────────────────────────────────────────
const COL = {
    matched: [80, 240, 160],   // green — matched catalog star (recorded pixel)
    forcedAcc: [255, 210, 60], // gold — forced/deep-forced accepted
    forcedLow: [230, 90, 90],  // red  — forced tested but below-bound
    quad: [235, 90, 235],      // magenta — det-quad polyline (winning cluster)
    quadVtx: [255, 255, 255],  // white — quad vertices
    panel: [10, 12, 20],
    text: [235, 238, 245],
    dim: [150, 158, 172],
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. AESTHETIC BACKGROUND — luma plane -> STF stretch -> grayscale canvas
// ═══════════════════════════════════════════════════════════════════════════
function lumaFromCR2(dec) {
    const { w, h, rgb16, meta } = dec;
    let det = detectPattern(rgb16, w, h);
    let W = w, H = h;
    // exact-meta-match recovery (portrait tie-break shear guard, mirrors rgb_to_xyz.mjs)
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
    // Honest v0 limitation: X-Trans RAF needs an X-Trans-aware demosaic
    // (decode_cr2's Bayer path would checkerboard). Not wired in v0.
    throw new Error(`DECODE_UNSUPPORTED (v0): ${ext} — v0 supports .fit/.fits/.fts and .cr2 (Bayer). ` +
        `X-Trans .RAF and other raws are a v0 non-goal.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. RECORD PARSERS (tolerant of the several banked shapes)
// ═══════════════════════════════════════════════════════════════════════════
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

/** matched_stars from a receipt/source json (recorded pixel x/y). */
function markersFromWcsSource(src) {
    const ms = src?.solution?.matched_stars || src?.matched_stars || [];
    return ms.filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y)).map((s) => ({
        x: s.x, y: s.y, flux: s.flux, mag: s.mag,
        klass: 'matched', sig: null,
    }));
}

/** forced / deep-forced per-star block -> markers with an accept/below class. */
function markersFromForced(rec) {
    // Search the receipt for a per-star forced list carrying pixel positions.
    const blocks = [rec?.deep_forced, rec?.forced, rec?.forced_confirm, rec?.deep_confirmed,
        rec?.solution?.deep_forced, rec?.solution?.forced_confirm];
    for (const b of blocks) {
        if (!b) continue;
        const arr = Array.isArray(b) ? b : (b.stars || b.per_star || b.candidates || b.tested);
        if (!Array.isArray(arr) || !arr.length) continue;
        const out = [];
        for (const s of arr) {
            const x = s.x ?? s.px ?? s.pixel_x, y = s.y ?? s.py ?? s.pixel_y;
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const sig = s.sigma ?? s.snr ?? s.significance ?? s.z ?? null;
            const accepted = s.accepted ?? s.confirmed ?? s.detected ?? (sig != null ? sig >= 3 : null);
            out.push({ x, y, flux: s.flux, mag: s.mag, sig, klass: accepted === false ? 'forcedLow' : 'forcedAcc' });
        }
        if (out.length) return out;
    }
    return null; // no per-star pixel block found
}

/** Winning-cluster det-quads from a quad_gen/solve_blind/proxy record. */
function extractQuads(j) {
    let cluster = j.winning_cluster || j.winning ||
        (Array.isArray(j.clusters) ? j.clusters[0] : null) || j;
    let members = cluster.members || cluster.quads ||
        (Array.isArray(cluster) ? cluster : null);
    if (!members && Array.isArray(j)) members = j; // flat array of quads
    if (!Array.isArray(members)) members = [];
    const quads = [];
    for (const m of members) {
        const raw = m.detPts || m.pts || m.points || m.quad || (Array.isArray(m) ? m : null);
        if (!Array.isArray(raw) || raw.length < 4) continue;
        const pts = raw.slice(0, 4).map((p) => Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y });
        if (pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) quads.push(pts);
    }
    return {
        quads,
        votes: cluster.votes ?? null,
        iteration: j.iteration ?? cluster.iteration ?? null,
        bound: j.bound ?? cluster.bound ?? null,
        provenance: j.provenance || cluster.provenance || null,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. DRAW HELPERS (thick line + sized ring; over the RGBA canvas)
// ═══════════════════════════════════════════════════════════════════════════
function thickLine(c, x0, y0, x1, y1, col, r, a = 0.95) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= n; s++) {
        const x = x0 + (x1 - x0) * s / n, y = y0 + (y1 - y0) * s / n;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy <= r * r) blend(c, Math.round(x) + dx, Math.round(y) + dy, col[0], col[1], col[2], a);
        }
    }
}
function ringThick(c, cx, cy, rad, col, a, w) {
    for (let k = 0; k < w; k++) drawRing(c, cx, cy, Math.max(1, rad - k), col, a);
}
function dot(c, cx, cy, r, col, a = 1) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
        if (dx * dx + dy * dy <= r * r) blend(c, Math.round(cx) + dx, Math.round(cy) + dy, col[0], col[1], col[2], a);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
    const t0 = Date.now();
    const bg = await loadBackground(IMAGE);
    const { W, H } = bg;

    // aesthetic STF grayscale background
    const gray = stretch(bg.lum, { asinh: 14, lo: 0.30, hi: 0.9985 });
    const c = grayToCanvas(gray, W, H);
    log(`background stretched ${W}x${H}`);

    // scale-aware overlay sizing
    const baseR = Math.max(4, Math.round(Math.min(W, H) / 300));
    const strokeR = Math.max(1, Math.round(Math.min(W, H) / 1100));

    // ── markers ────────────────────────────────────────────────────────────
    const wcsSrc = readJson(WCS);
    let markers = [];
    let markerLabel = '';
    if (FORCED) {
        const fr = readJson(FORCED);
        const fm = markersFromForced(fr);
        if (fm) {
            markers = fm;
            const acc = fm.filter((m) => m.klass === 'forcedAcc').length;
            markerLabel = `FORCED n=${fm.length} (acc ${acc} / low ${fm.length - acc})`;
        } else {
            log('--forced: no per-star pixel block found; falling back to matched_stars');
        }
    }
    if (!markers.length) {
        markers = markersFromWcsSource(wcsSrc);
        markerLabel = `MATCHED n=${markers.length}`;
    }
    // significance/flux -> radius (brighter/higher-sig = larger)
    const fluxes = markers.map((m) => m.flux).filter(Number.isFinite);
    const fMax = fluxes.length ? Math.max(...fluxes) : 1;
    for (const m of markers) {
        const f = Number.isFinite(m.flux) ? m.flux / (fMax || 1) : 0.4;
        const rad = Math.round(baseR * (0.7 + 0.9 * Math.sqrt(f)));
        const a = m.klass === 'forcedLow' ? 0.72 : 0.92;
        ringThick(c, m.x, m.y, rad, COL[m.klass] || COL.matched, a, strokeR + 1);
    }
    log(`markers drawn: ${markerLabel}`);

    // ── quad polylines ───────────────────────────────────────────────────────
    let quadInfo = null;
    if (QUADS) {
        quadInfo = extractQuads(readJson(QUADS));
        for (const q of quadInfo.quads) {
            for (let i = 0; i < 4; i++) {
                const p = q[i], nxt = q[(i + 1) % 4];
                thickLine(c, p.x, p.y, nxt.x, nxt.y, COL.quad, strokeR + 1, 0.92);
            }
            for (const p of q) dot(c, p.x, p.y, strokeR + 2, COL.quadVtx, 1);
        }
        log(`quads drawn: ${quadInfo.quads.length}${quadInfo.provenance ? ' (' + quadInfo.provenance + ')' : ''}`);
    }

    // ── corner legend ──────────────────────────────────────────────────────────
    const wcsBlk = wcsSrc.wcs || wcsSrc.solution?.wcs || {};
    const crval1 = Number(wcsBlk.CRVAL1), crval2 = Number(wcsBlk.CRVAL2);
    const scaleAsec = (Number.isFinite(Number(wcsBlk.CD1_1)) && Number.isFinite(Number(wcsBlk.CD2_1)))
        ? Math.hypot(Number(wcsBlk.CD1_1), Number(wcsBlk.CD2_1)) * 3600 : NaN;
    const lines = [
        'QUADVIZ V0 - SINGLE-FRAME OVERLAY (RENDER PLANE)',
        `IMAGE: ${path.basename(IMAGE)}  ${W}X${H}  ${bg.kind}`,
        `WCS: ${path.basename(WCS)}` + (Number.isFinite(crval1)
            ? `  CRVAL ${crval1.toFixed(4)},${crval2.toFixed(4)} DEG  SCALE ${Number.isFinite(scaleAsec) ? scaleAsec.toFixed(3) : '?'}"/PX`
            : '  (NO WCS BLOCK)'),
        `MARKERS: ${markerLabel}`,
        quadInfo ? `QUADS: ${path.basename(QUADS)}  N=${quadInfo.quads.length}` +
            (quadInfo.votes != null ? `  VOTES=${quadInfo.votes}` : '') : 'QUADS: NONE',
        quadInfo?.provenance ? `  ${quadInfo.provenance}` : null,
        `ITER: ${quadInfo?.iteration ?? 'N/A (SINGLE-RECORD V0)'}   BOUND: ${quadInfo?.bound ?? 'N/A'}`,
        'POSITIONS: RECORDED PIXELS (NO REPROJECTION)',
    ].filter(Boolean);

    const ts = Math.max(2, Math.round(Math.min(W, H) / 520));  // font scale
    const lh = 8 * ts + 6;
    const pad = 6 * ts;
    const boxW = Math.min(W - 2 * pad, Math.max(...lines.map((l) => textWidth(l, ts))) + 2 * pad);
    const boxH = lines.length * lh + pad;
    fillRect(c, pad, pad, boxW, boxH, COL.panel[0], COL.panel[1], COL.panel[2], 205);
    // color-key swatches drawn as small filled squares next to their legend rows
    let ly = pad + Math.round(pad / 2);
    for (const l of lines) {
        const isProv = l.startsWith('  ');
        drawText(c, l, pad + Math.round(pad / 2), ly, ts, isProv ? COL.dim : COL.text, 1, false);
        ly += lh;
    }

    // ── encode ───────────────────────────────────────────────────────────────
    const png = encodePng(c);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, png);
    log(`wrote ${OUT}  (${(png.length / 1e6).toFixed(2)} MB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

    // sidecar provenance JSON (honest audit trail; never inlines bytes)
    const sidecar = {
        tool: 'tools/quadviz/render_overlay.mjs', version: 'v0',
        generated: new Date().toISOString(),
        render_plane_only: true, reprojection: false, positions: 'recorded pixels',
        inputs: { image: IMAGE, wcs: WCS, quads: QUADS, forced: FORCED },
        frame: { W, H, kind: bg.kind },
        markers: { label: markerLabel, count: markers.length },
        quads: quadInfo ? { count: quadInfo.quads.length, votes: quadInfo.votes, provenance: quadInfo.provenance } : null,
        out: OUT, bytes: png.length,
    };
    fs.writeFileSync(OUT.replace(/\.png$/i, '.quadviz.json'), JSON.stringify(sidecar, null, 2));

    terminateDecodeWorkers();
})().catch((e) => { console.error('[quadviz] FATAL:', e.message); terminateDecodeWorkers(); process.exit(1); });
