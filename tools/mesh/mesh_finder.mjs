// ═══════════════════════════════════════════════════════════════════════════
// MESH LANE — quad-mesh cascade finder (research incubator, LAW-4, tools/ only)
// ═══════════════════════════════════════════════════════════════════════════
// PROTOTYPE of the owner "quad-mesh cascade detection" idea
// (memory: quad-mesh-cascade-detection-idea): after an anchored accept, a
// catalog star whose LOCAL neighbourhood is already matched can have its image
// position PREDICTED from local geometry (3+ matched neighbours = local affine,
// 6 DOF, absorbs local shear/distortion). Verify the prediction by forced
// photometry on the native buffer; accept -> add to the matched set -> the
// frontier grows. BFS from the anchors. The question this lane MEASURES:
// does that cascade actually MULTIPLY verified matches on real (banked) frames?
//
// NOTHING here feeds a solve. Banked buffers + banked receipts only. Every
// derived quantity is forced-photometry-verified and labelled with provenance.
// This CONSUMES the mesh_legB primitives (forced_detect, g15u_stars) — it does
// not duplicate the harvest leg; it adds the LOCAL-GEOMETRY prediction layer
// that leg-B (global-WCS harvest) does not have.
//
// KEY DESIGN CHOICE (honesty): the cascade predicts each 4th-star position ONLY
// from its matched local neighbours' MEASURED image positions via a local
// affine — it NEVER consults the global WCS for prediction. The seed anchors are
// the only tie to image space; everything else propagates through the mesh. This
// is what makes it a real test of "grow from anchors", not a re-run of global
// forced harvest. The global WCS is used only to (a) build the catalog geometry
// (tangent-plane coords, distortion-free) and (b) a diagnostic baseline the mesh
// is compared against (affine-vs-linear residual by radius).

import { tanForward, forcedMeasure } from '../psf/forced_detect.mjs';
import { solveLinear } from '../psf/imaging.mjs';

const D2R = Math.PI / 180;

// ── tangent-plane geometry ──────────────────────────────────────────────────
// Every catalog star gets (xi, eta) = gnomonic standard coords (deg) about the
// field centre (crval). This is the DISTORTION-FREE catalog geometry the quad
// mesh lives in. Local affine (xi,eta)->(x,y) then absorbs whatever the optics
// did to that patch.
export function attachTangent(stars, crvalRaDeg, crvalDecDeg) {
    const out = [];
    for (const s of stars) {
        const p = tanForward(s.ra_deg, s.dec_deg, crvalRaDeg, crvalDecDeg);
        if (!p) continue;
        out.push({ ...s, xi: p.xi, eta: p.eta });
    }
    return out;
}

// ── uniform grid over tangent-plane coords for kNN ──────────────────────────
function buildTanGrid(items, cellDeg) {
    const map = new Map();
    for (let i = 0; i < items.length; i++) {
        const gx = Math.floor(items[i].xi / cellDeg);
        const gy = Math.floor(items[i].eta / cellDeg);
        const k = gx * 1000003 + gy;
        let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i);
    }
    return { map, cell: cellDeg, items };
}
// K nearest items to (xi,eta), searching expanding rings until >= want found or
// maxReach exhausted. Returns [{idx, d2}] sorted ascending, length <= want.
function kNearest(grid, xi, eta, want, maxReach = 12) {
    const { map, cell, items } = grid;
    const gx = Math.floor(xi / cell), gy = Math.floor(eta / cell);
    const found = [];
    let reach = 1;
    while (reach <= maxReach) {
        found.length = 0;
        for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
            const a = map.get((gx + dx) * 1000003 + (gy + dy)); if (!a) continue;
            for (const pi of a) {
                const it = items[pi];
                const d2 = (it.xi - xi) ** 2 + (it.eta - eta) ** 2;
                found.push({ idx: pi, d2 });
            }
        }
        if (found.length >= want || reach === maxReach) break;
        reach++;
    }
    found.sort((a, b) => a.d2 - b.d2);
    return found.slice(0, want);
}

// ── local affine fit  (xi,eta) -> (x,y)  weighted least squares ─────────────
// Solves two independent 3-param systems [a b c] and [d e f] with weights w_i.
// Returns { A:{ax,bx,cx, ay,by,cy}, rms, n } or null if degenerate.
export function fitLocalAffine(src, dst, w) {
    const n = src.length;
    if (n < 3) return null;
    // normal equations for [c1 c2 c3] minimizing sum w*(c1*xi + c2*eta + c3 - t)^2
    function solve3(target) {
        const M = new Float64Array(9); const b = new Float64Array(3);
        for (let i = 0; i < n; i++) {
            const xi = src[i].xi, eta = src[i].eta, t = target[i], wi = w[i];
            const g = [xi, eta, 1];
            for (let r = 0; r < 3; r++) { b[r] += wi * g[r] * t; for (let c = 0; c < 3; c++) M[r * 3 + c] += wi * g[r] * g[c]; }
        }
        return solveLinear(M, b, 3);
    }
    const tx = dst.map((d) => d.x), ty = dst.map((d) => d.y);
    const cx = solve3(tx), cy = solve3(ty);
    if (!cx || !cy) return null;
    const A = { ax: cx[0], bx: cx[1], cx: cx[2], ay: cy[0], by: cy[1], cy: cy[2] };
    // in-sample RMS (px)
    let se = 0, sw = 0;
    for (let i = 0; i < n; i++) {
        const px = A.ax * src[i].xi + A.bx * src[i].eta + A.cx;
        const py = A.ay * src[i].xi + A.by * src[i].eta + A.cy;
        se += w[i] * ((px - dst[i].x) ** 2 + (py - dst[i].y) ** 2); sw += w[i];
    }
    return { A, rms: Math.sqrt(se / Math.max(1e-9, sw) / 2), n };
}
function applyAffine(A, xi, eta) { return [A.ax * xi + A.bx * eta + A.cx, A.ay * xi + A.by * eta + A.cy]; }

// ── flux-weighted centroid + local background (re-anchor measured position) ──
function localBg(L, w, h, cx, cy) {
    const vals = []; const x0 = Math.round(cx), y0 = Math.round(cy);
    for (let r = 8; r <= 12; r += 2) for (let t = -r; t <= r; t += 2)
        for (const [X, Y] of [[x0 + t, y0 - r], [x0 + t, y0 + r], [x0 - r, y0 + t], [x0 + r, y0 + t]])
            if (X >= 0 && Y >= 0 && X < w && Y < h) vals.push(L[Y * w + X]);
    if (vals.length < 8) return null; vals.sort((a, b) => a - b); return vals[vals.length >> 1];
}
function fluxCentroid(L, w, h, cx, cy, bg, sigma, R = 6) {
    let sw = 0, sx = 0, sy = 0; const x0 = Math.round(cx), y0 = Math.round(cy);
    for (let dy = -R; dy <= R; dy++) { const Y = y0 + dy; if (Y < 1 || Y >= h - 1) continue; for (let dx = -R; dx <= R; dx++) { const X = x0 + dx; if (X < 1 || X >= w - 1) continue; const v = L[Y * w + X] - bg; if (v > 1.5 * sigma) { sw += v; sx += v * X; sy += v * Y; } } }
    return sw > 0 ? { x: sx / sw, y: sy / sw } : null;
}
export function pixelNoiseSigma(L, maxN = 200000) {
    const step = Math.max(1, Math.floor(L.length / maxN)); const d = [];
    for (let i = 0; i + 1 < L.length; i += step) d.push(Math.abs(L[i + 1] - L[i]));
    d.sort((a, b) => a - b); return Math.max(1e-8, 1.4826 * d[d.length >> 1] / Math.SQRT2);
}

// ═══════════════════════════════════════════════════════════════════════════
// CASCADE
// ═══════════════════════════════════════════════════════════════════════════
// catalog : [{ id, ra_deg, dec_deg, mag, xi, eta }]  (attachTangent applied)
// seed    : [{ id, x, y }]   measured image positions of the anchor matches
// L,w,h   : native luminance buffer
// params  : { kNear, kMin, snrThreshold, centTol, maxIters, minAffineNeighbors,
//             posRmsFloor, maxReanchor }
// Returns { matches, iterations, params, sigmaPix }
//   matches: Map id -> { id, mag, xi, eta, x, y, source:'seed'|'mesh', iter,
//                        pred_x, pred_y, snr, affine_rms, n_neighbors, reanchor_px, r_norm }
export function runCascade({ catalog, seed, L, w, h, cx, cy, params = {} }) {
    const P = {
        kNear: 8, kMin: 3, snrThreshold: 5, centTol: 4, maxIters: 12,
        posRmsFloor: 1.5, maxReanchor: 6, cellDeg: 0.04, ...params,
    };
    const sigmaPix = pixelNoiseSigma(L);
    const hd = Math.hypot(cx, cy);
    const rNorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;

    const byId = new Map(catalog.map((s) => [s.id, s]));
    const matches = new Map();
    for (const s of seed) {
        const c = byId.get(s.id); if (!c) continue;
        matches.set(s.id, { id: s.id, mag: c.mag, xi: c.xi, eta: c.eta, x: s.x, y: s.y, source: 'seed', iter: 0, r_norm: +rNorm(s.x, s.y).toFixed(4) });
    }
    const iterations = [];
    const unmatched = catalog.filter((s) => !matches.has(s.id));

    for (let iter = 1; iter <= P.maxIters; iter++) {
        // index the CURRENT matched set in tangent-plane
        const matchedArr = [...matches.values()];
        const mGrid = buildTanGrid(matchedArr, P.cellDeg);
        const added = [];
        let considered = 0, predicted = 0, rejByGate = 0, rejByCent = 0, rejByAffine = 0;

        const stillUnmatched = [];
        for (const cand of unmatched) {
            if (matches.has(cand.id)) continue;
            const knn = kNearest(mGrid, cand.xi, cand.eta, P.kNear);
            if (knn.length < P.kMin) { stillUnmatched.push(cand); continue; }
            considered++;
            const src = knn.map((k) => matchedArr[k.idx]);
            const dst = src.map((s) => ({ x: s.x, y: s.y }));
            const wts = knn.map((k) => 1 / (k.d2 + 1e-9));
            const aff = fitLocalAffine(src, dst, wts);
            if (!aff) { rejByAffine++; stillUnmatched.push(cand); continue; }
            predicted++;
            const [px, py] = applyAffine(aff.A, cand.xi, cand.eta);
            // aperture matched to local model uncertainty (documented posRms mechanism)
            const posRms = Math.max(P.posRmsFloor, aff.rms);
            const fm = forcedMeasure({ L, w, h, positions: [{ x: px, y: py, mag: cand.mag, gaia_id: cand.id }], fwhmPx: 4, posRmsPx: posRms, snrThreshold: P.snrThreshold, sigmaPix });
            const r = fm.results[0];
            if (!r || !r.accepted) { rejByGate++; stillUnmatched.push(cand); continue; }
            // re-anchor to the measured flux centroid; confusion guard = centroid
            // must sit near the prediction (never lock onto a distant neighbour)
            const bg = localBg(L, w, h, px, py);
            const cen = bg == null ? null : fluxCentroid(L, w, h, px, py, bg, sigmaPix, Math.ceil(posRms) + 2);
            if (!cen) { rejByCent++; stillUnmatched.push(cand); continue; }
            const reanchor = Math.hypot(cen.x - px, cen.y - py);
            if (reanchor > Math.min(P.maxReanchor, posRms + P.centTol)) { rejByCent++; stillUnmatched.push(cand); continue; }
            added.push({
                id: cand.id, mag: cand.mag, xi: cand.xi, eta: cand.eta, x: cen.x, y: cen.y,
                source: 'mesh', iter, pred_x: +px.toFixed(2), pred_y: +py.toFixed(2), snr: +r.snr.toFixed(2),
                affine_rms: +aff.rms.toFixed(2), n_neighbors: knn.length, reanchor_px: +reanchor.toFixed(2), r_norm: +rNorm(cen.x, cen.y).toFixed(4),
            });
        }
        for (const a of added) matches.set(a.id, a);
        unmatched.length = 0; for (const s of stillUnmatched) if (!matches.has(s.id)) unmatched.push(s);
        iterations.push({ iter, considered, predicted, added: added.length, matched_after: matches.size, rej_gate: rejByGate, rej_centroid: rejByCent, rej_affine: rejByAffine });
        if (added.length === 0) break;
    }
    return { matches, iterations, params: P, sigmaPix };
}

// ── scoring against an independent banked reference of real star positions ──
// reference : [{ x, y }] (e.g. iterbc densified accepted positions, BC-corrected,
//   built by a SEPARATE lane). A mesh completion is CORROBORATED if a reference
//   position sits within tol px of its measured centroid. Honest caveats:
//   the reference is itself forced-harvest (no shape gate) and center-cropped —
//   so buckets outside reference coverage are reported separately, not as false.
export function scoreAgainstReference(meshMatches, reference, { tol = 3 } = {}) {
    // grid the reference for fast lookup
    const CELL = 32;
    const map = new Map();
    reference.forEach((r, i) => { const k = (Math.floor(r.x / CELL)) * 100003 + Math.floor(r.y / CELL); let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i); });
    const near = (x, y) => {
        const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL); let best = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = map.get((gx + dx) * 100003 + (gy + dy)); if (!a) continue; for (const i of a) { const d = Math.hypot(reference[i].x - x, reference[i].y - y); if (d < best) best = d; } }
        return best;
    };
    let corrob = 0, uncorrob = 0;
    const rows = [];
    for (const m of meshMatches) {
        const d = near(m.x, m.y);
        const ok = d <= tol;
        if (ok) corrob++; else uncorrob++;
        rows.push({ id: m.id, r_norm: m.r_norm, nearest_ref_px: Number.isFinite(d) ? +d.toFixed(2) : null, corroborated: ok });
    }
    return { corroborated: corrob, uncorroborated: uncorrob, total: meshMatches.length, corrob_frac: meshMatches.length ? +(corrob / meshMatches.length).toFixed(4) : null, rows };
}
