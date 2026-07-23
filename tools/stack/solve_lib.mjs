// ═══════════════════════════════════════════════════════════════════════════
// STACK LANE — solve machinery (ported from the proven tools/corpus/run_corpus
// patterns: hinted solve, scale-gated verification, hybrid Gaia/HYG atlas rows)
// plus what registration needs beyond triage: N-point WCS refinement against
// matched stars, sky<->pixel transforms, and linear-image centroid/FWHM.
//
// COORDINATE CONVENTIONS (owner law — coordinate ledger):
//   - crval[0] is in HOURS everywhere internally (FITS export converts).
//   - cd is deg/px mapping (x - crpix) -> (xi, eta) in DEGREES.
//   - pixel coordinates are 0-based pixel centers, y = stored row index.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

export const D2R = Math.PI / 180;

// ── WASM ────────────────────────────────────────────────────────────────────
export async function initWasm(ROOT) {
    const w = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/engine/wasm_compute/pkg/wasm_compute.js`);
    w.initSync({ module: fs.readFileSync(path.join(ROOT, 'src/engine/wasm_compute/pkg/wasm_compute_bg.wasm')) });
    return w;
}

// ── atlas (hybrid row formats: Gaia rows ra in DEGREES, HYG rows ra in HOURS;
//    the mag_g/source_id discriminator is the corpus runner's, verbatim) ─────
export function loadAtlas(ROOT) {
    const norm = s => (s.mag_g !== undefined || s.source_id !== undefined)
        ? { raH: s.ra / 15, dec: s.dec, mag: s.mag_g ?? 99 }
        : { raH: s.ra, dec: s.dec, mag: s.mag ?? 99 };
    const L12 = [
        ...JSON.parse(fs.readFileSync(path.join(ROOT, 'public/atlas/level_1_anchors.json'), 'utf8')),
        ...JSON.parse(fs.readFileSync(path.join(ROOT, 'public/atlas/level_2_pattern.json'), 'utf8')),
    ].map(norm);
    const sectorCache = new Map();
    function loadSector(id) {
        if (!sectorCache.has(id)) {
            const p = path.join(ROOT, `public/atlas/sectors/level_3_sector_${id}.json`);
            sectorCache.set(id, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).map(norm) : []);
        }
        return sectorCache.get(id);
    }
    const sectorId = (raH, dec) => Math.min(5, Math.floor((Math.max(-90, Math.min(90, dec)) + 90) / 30)) * 6 + Math.min(5, Math.floor(((raH % 24) + 24) % 24 / 4));
    function regionStars(raH, dec, radiusDeg) {
        const ids = new Set([[0, 0], [radiusDeg, 0], [-radiusDeg, 0], [0, radiusDeg], [0, -radiusDeg]]
            .map(([dr, dd]) => sectorId(raH + dr / 15 / Math.max(0.2, Math.cos(dec * D2R)), Math.max(-89.9, Math.min(89.9, dec + dd)))));
        const deep = [...ids].flatMap(loadSector);
        const all = [...L12, ...deep];
        return all.filter(s => angSep(s.raH, s.dec, raH, dec) < radiusDeg);
    }
    return { regionStars };
}

// ── spherical / tangent-plane math ──────────────────────────────────────────
export function angSep(ra1h, dec1, ra2h, dec2) {
    const a1 = ra1h * 15 * D2R, a2 = ra2h * 15 * D2R, d1 = dec1 * D2R, d2 = dec2 * D2R;
    return Math.acos(Math.min(1, Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2))) / D2R;
}
export function gnomonic(raH, dec, ra0H, dec0) {
    const a = raH * 15 * D2R, a0 = ra0H * 15 * D2R, d = dec * D2R, d0 = dec0 * D2R;
    const c = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    if (c <= 1e-9) return { xi: NaN, eta: NaN };
    return { xi: Math.cos(d) * Math.sin(a - a0) / c / D2R, eta: (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / c / D2R };
}
export function inverseGnomonic(xi, eta, ra0H, dec0) {
    const x = xi * D2R, y = eta * D2R, a0 = ra0H * 15 * D2R, d0 = dec0 * D2R;
    const rho = Math.hypot(x, y), c = Math.atan(rho);
    if (rho < 1e-12) return { raH: ra0H, dec: dec0 };
    const dec = Math.asin(Math.cos(c) * Math.sin(d0) + (y * Math.sin(c) * Math.cos(d0)) / rho) / D2R;
    const ra = (a0 + Math.atan2(x * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - y * Math.sin(d0) * Math.sin(c))) / D2R / 15;
    return { raH: ((ra % 24) + 24) % 24, dec };
}

/** pixel -> sky through a WCS (crval[0] in hours). */
export function pixToSky(wcs, x, y) {
    const dx = x - wcs.crpix[0], dy = y - wcs.crpix[1];
    const xi = wcs.cd[0] * dx + wcs.cd[1] * dy, eta = wcs.cd[2] * dx + wcs.cd[3] * dy;
    return inverseGnomonic(xi, eta, wcs.crval[0], wcs.crval[1]);
}

/** sky -> pixel through a WCS. Returns {x, y} (NaN beyond the tangent hemisphere). */
export function skyToPix(wcs, raH, dec) {
    const g = gnomonic(raH, dec, wcs.crval[0], wcs.crval[1]);
    if (!Number.isFinite(g.xi)) return { x: NaN, y: NaN };
    const [a, b, c, d] = wcs.cd;
    const det = a * d - b * c;
    return {
        x: wcs.crpix[0] + (d * g.xi - b * g.eta) / det,
        y: wcs.crpix[1] + (-c * g.xi + a * g.eta) / det,
    };
}

export const scaleOf = cd => Math.sqrt(Math.abs(cd[0] * cd[3] - cd[1] * cd[2])) * 3600;

/**
 * Centroid-referenced CD fit + crval recovery (mirrors SkyTransform.fitWCS and
 * the corpus runner). N-point general: pix = [{x,y}], sky = [{xi,eta}] where
 * xi/eta are gnomonic about the tangent (ra0H, dec0).
 */
export function fitWCS(w, pix, sky, crpix, ra0H, dec0) {
    const n = pix.length;
    if (n < 3 || sky.length !== n) return null;
    let mx = 0, my = 0, mxi = 0, meta = 0;
    for (let i = 0; i < n; i++) { mx += pix[i].x; my += pix[i].y; mxi += sky[i].xi; meta += sky[i].eta; }
    mx /= n; my /= n; mxi /= n; meta /= n;
    const px = new Float64Array(n), py = new Float64Array(n), sx = new Float64Array(n), sy = new Float64Array(n);
    for (let i = 0; i < n; i++) { px[i] = pix[i].x; py[i] = pix[i].y; sx[i] = sky[i].xi - mxi; sy[i] = sky[i].eta - meta; }
    const cd = w.fit_wcs_bulk(px, py, sx, sy, mx, my);
    if (!cd || cd.length < 4) return null;
    const dxc = crpix[0] - mx, dyc = crpix[1] - my;
    const xiC = mxi + cd[0] * dxc + cd[1] * dyc, etaC = meta + cd[2] * dxc + cd[3] * dyc;
    const center = inverseGnomonic(xiC, etaC, ra0H, dec0);
    return { cd: [cd[0], cd[1], cd[2], cd[3]], crpix: [crpix[0], crpix[1]], crval: [center.raH, center.dec] };
}

// ── detection (corpus extractStars, verbatim thresholds/hygiene) ────────────
export function extractStars(w, lum, W, H) {
    const g = new Float32Array(lum.length);
    for (let i = 0; i < lum.length; i++) g[i] = Math.min(255, Math.round(Math.min(255, Math.pow(Math.max(0, lum[i]), 1 / 2.2) * 255))) / 255;
    // stats over NONZERO pixels (mosaic canvases park the frame in exact-zero)
    const sample = [];
    for (let i = 0; i < g.length; i += 997) { if (g[i] > 0) sample.push(g[i]); }
    if (sample.length < 100) for (let i = 0; i < g.length; i += 997) sample.push(g[i]);
    sample.sort((a, b) => a - b);
    const bg = sample[Math.floor(sample.length / 2)];
    const sigma = (sample[Math.floor(sample.length * 0.84)] - bg) || 0.01;
    const flat = w.extract_blobs(g, W, H, bg + 3.5 * sigma, bg);
    const raw = [];
    // blob layout: x, y, rawX, rawY, flux, peak, fwhm, circularity, theta, snr
    for (let i = 0; i < flat.length; i += 10) raw.push({ x: flat[i], y: flat[i + 1], flux: flat[i + 4], peak: flat[i + 5], fwhmBlob: flat[i + 6] });
    raw.sort((a, b) => b.flux - a.flux);
    const margin = 24;
    const stars = [];
    for (const s of raw) {
        if (s.x < margin || s.y < margin || s.x > W - margin || s.y > H - margin) continue;
        if (stars.some(k => Math.abs(k.x - s.x) < 4 && Math.abs(k.y - s.y) < 4)) continue;
        stars.push(s);
    }
    return stars;
}

/**
 * Refine centroids + moment-FWHM on the LINEAR image (extractStars centroids
 * come from the gamma-stretched detection image — good enough for quads, but
 * registration wants unbiased linear-flux centroids). Window r=6; local bg =
 * median of the window border ring. Mutates star objects: adds cx, cy, fwhmPx.
 */
export function refineCentroids(lum, W, H, stars, half = 6) {
    const border = [];
    for (const s of stars) {
        let x0 = Math.round(s.x), y0 = Math.round(s.y);
        let cx = s.x, cy = s.y, fwhm = NaN;
        for (let pass = 0; pass < 2; pass++) {
            x0 = Math.max(half, Math.min(W - 1 - half, Math.round(cx)));
            y0 = Math.max(half, Math.min(H - 1 - half, Math.round(cy)));
            border.length = 0;
            for (let d = -half; d <= half; d++) {
                border.push(lum[(y0 - half) * W + x0 + d], lum[(y0 + half) * W + x0 + d],
                    lum[(y0 + d) * W + x0 - half], lum[(y0 + d) * W + x0 + half]);
            }
            border.sort((a, b) => a - b);
            const bg = border[border.length >> 1];
            let sf = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
            for (let dy = -half; dy <= half; dy++) {
                for (let dx = -half; dx <= half; dx++) {
                    const v = lum[(y0 + dy) * W + x0 + dx] - bg;
                    if (!(v > 0)) continue;
                    sf += v; sx += dx * v; sy += dy * v;
                }
            }
            if (sf <= 0) break;
            cx = x0 + sx / sf; cy = y0 + sy / sf;
            if (pass === 1) {
                // second moments about the refined centroid
                let sf2 = 0, mxx = 0, myy = 0;
                for (let dy = -half; dy <= half; dy++) {
                    for (let dx = -half; dx <= half; dx++) {
                        const v = lum[(y0 + dy) * W + x0 + dx] - bg;
                        if (!(v > 0)) continue;
                        const rx = x0 + dx - cx, ry = y0 + dy - cy;
                        sf2 += v; mxx += rx * rx * v; myy += ry * ry * v;
                    }
                }
                if (sf2 > 0) fwhm = 2.3548 * Math.sqrt(Math.max(0, (mxx + myy) / (2 * sf2)));
            }
        }
        s.cx = cx; s.cy = cy; s.fwhmPx = fwhm;
    }
    return stars;
}

/** Median moment-FWHM (px) over the brightest usable stars. */
export function medianFwhm(stars, take = 80) {
    const f = stars.slice(0, take).map(s => s.fwhmPx).filter(v => Number.isFinite(v) && v > 0.3);
    if (!f.length) return NaN;
    f.sort((a, b) => a - b);
    return f[f.length >> 1];
}

// ── hinted solve (corpus triage core, parameterized) ────────────────────────
const SCALE_TOL = 0.25;
const DET_BUDGET = 30, CAT_BUDGET = 50;
const VERIFY_DET_CAP = 800, VERIFY_CAT_CAP = 4000;

/**
 * One hinted solve attempt. det must be sorted brightest-first with .x/.y.
 * gateScale (arcsec/px) enables the scale gate + consensus relaxation;
 * NaN runs the headerless lane (doubled bar unless pointingGate is supplied —
 * a cluster hint is itself a strong prior: a coincidence solution has no
 * reason to land its center inside the hinting cluster's join radius).
 */
export function solveAtHint(w, atlas, det, W, H, ra0H, dec0, workScale, gateScale, pointingGate = null) {
    const halfDiagDeg = Math.hypot(W, H) / 2 * workScale / 3600;
    const region = atlas.regionStars(ra0H, dec0, Math.max(1.5, halfDiagDeg * 2.5));
    if (region.length < 8) return { status: 'FAIL_FEW_CATALOG', region: region.length };
    const degPerPx = workScale / 3600;
    const catPix = region
        .map(s => ({ s, g: gnomonic(s.raH, s.dec, ra0H, dec0) }))
        .filter(o => Number.isFinite(o.g.xi))
        .map(o => ({ x: W / 2 + o.g.xi / degPerPx, y: H / 2 - o.g.eta / degPerPx, xi: o.g.xi, eta: o.g.eta, mag: o.s.mag }));
    const catSub = catPix
        .filter(p => Math.hypot(p.x - W / 2, p.y - H / 2) <= Math.hypot(W, H) / 2 * 1.2)
        .sort((a, b) => a.mag - b.mag).slice(0, CAT_BUDGET);
    if (catSub.length < 8) return { status: 'FAIL_FEW_CATALOG', region: region.length };

    const detTop = det.slice(0, DET_BUDGET);
    const res = w.solve_planar_local(
        new Float64Array(detTop.map(p => p.x)), new Float64Array(detTop.map(p => p.y)),
        new Float64Array(detTop.map((_, i) => i)),
        new Float64Array(catSub.map(p => p.x)), new Float64Array(catSub.map(p => p.y)),
        new Float64Array(catSub.map((_, i) => i)),
        new Float64Array([0.02, 0.05, 0.08, 0.1]), 50, undefined);

    const vDet = det.slice(0, VERIFY_DET_CAP);
    const vDetX = new Float64Array(vDet.map(p => p.x)), vDetY = new Float64Array(vDet.map(p => p.y));
    const vCat = [...region].sort((a, b) => a.mag - b.mag).slice(0, VERIFY_CAT_CAP);
    const catRa = new Float64Array(vCat.map(s => s.raH)), catDec = new Float64Array(vCat.map(s => s.dec));

    let best = null;
    const candStats = [];
    for (let c = 0; c < res.length / 9; c++) {
        const o = c * 9;
        const pix = [], sky = [];
        for (let k = 0; k < 4; k++) {
            const d = detTop[res[o + k]], q = catSub[res[o + 4 + k]];
            if (!d || !q) break;
            pix.push(d); sky.push({ xi: q.xi, eta: q.eta });
        }
        if (pix.length !== 4) continue;
        const wcs = fitWCS(w, pix, sky, [W / 2, H / 2], ra0H, dec0);
        if (!wcs) continue;
        const s = scaleOf(wcs.cd);
        if (Number.isFinite(gateScale) && Math.abs(s - gateScale) / gateScale > SCALE_TOL) {
            candStats.push({ c, scale: s, gated: true, matches: 0 });
            continue;
        }
        const v = w.verify_astrometric_lock(vDetX, vDetY, catRa, catDec,
            new Float64Array(wcs.cd), new Float64Array(wcs.crval), new Float64Array(wcs.crpix),
            Math.max(60, s * 10) / 3600);
        const matches = Math.round(v[2]);
        candStats.push({ c, scale: s, gated: false, matches, crval: wcs.crval });
        if (!best || matches > best.matches) best = { wcs, scale: s, matches, resid: +v[3].toFixed(2), cand: c };
    }
    // consensus among ungated top-10 (corpus rule)
    let consensus = 0;
    if (best) {
        const top = candStats.filter(k => !k.gated).sort((a, b) => b.matches - a.matches).slice(0, 10);
        consensus = top.filter(t =>
            t.crval &&
            Math.abs(t.scale - best.scale) / best.scale < 0.03 &&
            angSep(t.crval[0], t.crval[1], best.wcs.crval[0], best.wcs.crval[1]) < 0.1
        ).length;
    }
    // Acceptance ladder (corpus): scale-gated lane gets the consensus-relaxed
    // floor; headerless gets a DOUBLED bar — unless a pointing gate (cluster
    // prior) is active, in which case the base bar applies but the solution
    // must also land inside the gate radius. Physical scale bounds always.
    const nDet = Math.min(det.length, VERIFY_DET_CAP);
    const baseBar = Math.max(25, Math.round(nDet * 0.12));
    let bar;
    if (Number.isFinite(gateScale)) bar = (consensus >= 5) ? 20 : baseBar;
    else if (pointingGate) bar = baseBar;
    else bar = baseBar * 2;

    if (!best || best.matches < bar) return { status: 'FAIL_NO_LOCK', bestMatches: best?.matches ?? 0, bar, consensus, region: region.length };
    if (best.scale < 0.05 || best.scale > 100) return { status: 'FAIL_IMPLAUSIBLE_SCALE', rejectedScale: best.scale, bar, consensus };
    if (pointingGate && !Number.isFinite(gateScale)) {
        const off = angSep(best.wcs.crval[0], best.wcs.crval[1], pointingGate.raH, pointingGate.dec);
        if (off > pointingGate.radiusDeg) {
            return { status: 'FAIL_OFF_GATE', offsetDeg: +off.toFixed(3), gateRadiusDeg: pointingGate.radiusDeg, bestMatches: best.matches, bar, consensus };
        }
    }
    return { status: 'LOCK', wcs: best.wcs, scale: best.scale, matches: best.matches, resid: best.resid, consensus, bar, region: region.length };
}

/**
 * N-point WCS refinement: match anchors (sky positions: catalog stars or the
 * reference frame's detections mapped through its WCS) to detected centroids
 * over shrinking radii, re-fitting cd+crval each pass. Registration accuracy
 * lives or dies here — the 4-star quad WCS is a triage lock, not a resample-
 * grade mapping.
 * det: [{cx, cy, flux}] (refined linear centroids). anchors: [{raH, dec}].
 * Returns { wcs, n, rmsPx, rmsArcsec, pairs } or null if too few matches.
 */
export function refineWCS(w, det, anchors, wcs0, radiiPx = [10, 5, 3]) {
    let wcs = { cd: [...wcs0.cd], crpix: [...wcs0.crpix], crval: [...wcs0.crval] };
    let pairs = null;
    for (const r of radiiPx) {
        // project anchors -> pixels under current wcs
        const proj = anchors.map(a => skyToPix(wcs, a.raH, a.dec));
        // nearest-det match within r, unique by keeping the closer pair
        const byDet = new Map();
        for (let ai = 0; ai < anchors.length; ai++) {
            const p = proj[ai];
            if (!Number.isFinite(p.x)) continue;
            let bi = -1, bd = r * r;
            for (let di = 0; di < det.length; di++) {
                const dx = det[di].cx - p.x, dy = det[di].cy - p.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < bd) { bd = d2; bi = di; }
            }
            if (bi < 0) continue;
            const prev = byDet.get(bi);
            if (!prev || bd < prev.d2) byDet.set(bi, { ai, d2: bd });
        }
        if (byDet.size < 8) return pairs ? { wcs, ...rmsOf(wcs, pairs, anchors, det), pairs } : null;
        pairs = [...byDet.entries()].map(([di, { ai }]) => ({ di, ai }));
        // re-fit about the CURRENT crval tangent
        const pix = pairs.map(p => ({ x: det[p.di].cx, y: det[p.di].cy }));
        const sky = pairs.map(p => {
            const g = gnomonic(anchors[p.ai].raH, anchors[p.ai].dec, wcs.crval[0], wcs.crval[1]);
            return { xi: g.xi, eta: g.eta };
        });
        const fitted = fitWCS(w, pix, sky, wcs.crpix, wcs.crval[0], wcs.crval[1]);
        if (!fitted) return null;
        wcs = fitted;
    }
    return { wcs, ...rmsOf(wcs, pairs, anchors, det), pairs };
}

function rmsOf(wcs, pairs, anchors, det) {
    let s2 = 0;
    for (const p of pairs) {
        const q = skyToPix(wcs, anchors[p.ai].raH, anchors[p.ai].dec);
        const dx = det[p.di].cx - q.x, dy = det[p.di].cy - q.y;
        s2 += dx * dx + dy * dy;
    }
    const rmsPx = Math.sqrt(s2 / pairs.length);
    return { n: pairs.length, rmsPx: +rmsPx.toFixed(3), rmsArcsec: +(rmsPx * scaleOf(wcs.cd)).toFixed(3) };
}

/** Bounded all-sky hint ring grid (corpus CR2 pattern) for blind fallback. */
export function blindHintGrid(halfDiagDeg, maxHints = 160) {
    const step = Math.max(12, halfDiagDeg * 1.2);
    const hints = [[0, 90], [0, -90]];
    let ring = 0;
    for (let dec = -90 + step; dec < 90 - step / 2; dec += step, ring++) {
        const n = Math.max(1, Math.ceil(360 * Math.cos(dec * D2R) / step));
        for (let i = 0; i < n; i++) hints.push([((i + (ring % 2) * 0.5) * 24 / n) % 24, dec]);
    }
    return hints.slice(0, maxHints);
}
