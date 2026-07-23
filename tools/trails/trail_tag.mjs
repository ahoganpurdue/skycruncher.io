// tools/trails/trail_tag.mjs
// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC, TAGS-ONLY satellite/aircraft-trail tagger over the FULL
// detection list. LAW-4 incubator lane (tools/). NEVER mutates matched_stars,
// acceptance, or any pipeline state — it emits tags only. Consumption (a future
// labelled cull pass like TOPOGRAPHY, culling_reason='SATELLITE') is
// owner-gated and out of scope here.
//
// Per proposal §(a) (test_results/overnight_run_2026-07-10/trails_proposal_speculative.md):
//   S1 ELONGATION  — per-detection moment_ellipticity / (1−circularity) + theta,
//                    coherence with the candidate line (continuous-streak signal).
//   S2 COLLINEARITY — deterministic SEEDED RANSAC line over ALL centroids,
//                    inliers within σ_perp of a common line (≥k members).
//   S3 DASH PERIODICITY — reuse the minGap>5 / maxGap/minGap<3.5 SHAPE from
//                    solver_entry.ts:1381-1386 (reimplemented here; NO import of
//                    solver internals), robustened for the full contaminated list.
//
// Determinism: the ONLY randomness is an internal RANSAC PRNG seeded from the
// fixed constant RANSAC_SEED below. Same input → byte-identical tags.
//
// Output tag: { trail_id, member_indices, line_params:{theta,rho,sigma_perp,angle_deg},
//               spacing_regularity, confidence, signals:{...} }  — member_indices
// index into the INPUT detection array.
// ─────────────────────────────────────────────────────────────────────────────

export const RANSAC_SEED = 0x5EED1E7A; // fixed — determinism constant

export const DEFAULTS = Object.freeze({
    sigmaPerp: 2.5,          // perpendicular inlier band (px) — mirrors solver_entry:1377
    minInliers: 4,           // solver_entry:1379 (>=4)
    minSeedLen: 30,          // solver_entry:1371 (len<30 skip)
    minGap: 5,               // solver_entry:1386 (minGap>5) — S3
    gapRatioMax: 3.5,        // solver_entry:1386 (maxGap/minGap<3.5) — S3
    minSpanFrac: 0.05,       // trail must span >=5% of the frame diagonal (+abs floor)
    minSpanAbsPx: 60,
    elongE0: 0.6,            // S1: member counts as "elongated" above this ellipticity
    thetaAlignDeg: 20,       // S1: blob theta within this of the line angle (mod 180)
    elongFrac: 0.6,          // S1: fraction of members elongated+aligned to pass S1
    maxTrails: 12,
    ransacIters: 150000,     // random flux-weighted seeds
    topKExhaustive: 120,     // + exhaustive seeding over the top-K brightest points
    dedupThetaDeg: 1.5,      // candidate-line dedup buckets
    dedupRhoPx: 3.0,
});

// mulberry32 — tiny deterministic PRNG.
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function median(arr) {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Canonicalise a line from two points → { ox,oy, ux,uy, theta(∈[0,π)), rho }.
// rho = signed perpendicular offset of the ORIGIN from the line (for dedup).
function lineFromDir(ox, oy, ux, uy) {
    // Canonical direction: ux >= 0, and if ux==0 then uy >= 0 → unique theta∈[0,π).
    if (ux < 0 || (ux === 0 && uy < 0)) { ux = -ux; uy = -uy; }
    let theta = Math.atan2(uy, ux); // [0,π) after canonicalisation
    if (theta < 0) theta += Math.PI;
    const rho = oy * ux - ox * uy;  // origin perp offset (solver_entry sign convention)
    return { ox, oy, ux, uy, theta, rho };
}

// Total-least-squares (PCA) line fit through a set of points → refined direction
// about the centroid. Stabilises the seed line before final inlier collection.
function pcaLine(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) {
        const dx = p.x - mx, dy = p.y - my;
        sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    // principal eigenvector of [[sxx,sxy],[sxy,syy]]
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const l = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    let vx = sxy, vy = l - sxx;
    if (Math.abs(vx) < 1e-12 && Math.abs(vy) < 1e-12) { vx = 1; vy = 0; }
    const n = Math.hypot(vx, vy);
    return lineFromDir(mx, my, vx / n, vy / n);
}

function perpDist(line, px, py) {
    const dx = px - line.ox, dy = py - line.oy;
    return dx * line.uy - dy * line.ux; // solver_entry:1377 convention
}

function collectInliers(line, dets, sigmaPerp, claimed) {
    const idx = [];
    for (let k = 0; k < dets.length; k++) {
        if (claimed && claimed[k]) continue;
        if (Math.abs(perpDist(line, dets[k].x, dets[k].y)) <= sigmaPerp) idx.push(k);
    }
    return idx;
}

// S3 — dash periodicity. BYTE-FAITHFUL reimplementation of solver_entry.ts:
// 1381-1386 (minGap>5, maxGap/minGap<3.5) on the projected t-values — NO merge,
// NO regularisation (an earlier merge variant over-regularised random real-field
// spacings and made chance lines pass; the raw shape is the safety). Continuous
// streaks are handled by S1 (elongation), not S3, so S3 need not tolerate the
// intruders that dense continuous fragmentation would inject.
function s3Spacing(tvals, cfg) {
    const t = [...tvals].sort((a, b) => a - b);
    if (t.length < cfg.minInliers) return { pass: false, minGap: null, maxGap: null, ratio: null, nMerged: t.length };
    let minGap = Infinity, maxGap = 0;
    for (let i = 1; i < t.length; i++) {          // solver_entry:1382-1385
        const g = t[i] - t[i - 1];
        if (g < minGap) minGap = g;
        if (g > maxGap) maxGap = g;
    }
    const ratio = maxGap / minGap;
    const pass = t.length >= cfg.minInliers && minGap > cfg.minGap && ratio < cfg.gapRatioMax; // :1386
    return { pass, minGap, maxGap, ratio, nMerged: t.length };
}

// S1 — elongation coherence. Fraction of members that are elongated
// (ellipticity/moment_ellipticity ≥ e0) AND oriented along the line (theta
// within thetaAlignDeg, mod 180°).
function s1Elongation(members, dets, line, cfg) {
    const lineAngle = line.theta; // [0,π)
    let elong = 0, withTheta = 0;
    for (const k of members) {
        const d = dets[k];
        const ell = d.moment_ellipticity != null ? d.moment_ellipticity
            : (d.ellipticity != null ? d.ellipticity
                : (d.circularity != null ? 1 - d.circularity : null));
        if (ell == null || ell < cfg.elongE0) continue;
        elong++;
        if (d.theta == null) continue; // theta unknown → elongated but orientation unmeasured
        withTheta++;
        let a = d.theta % Math.PI; if (a < 0) a += Math.PI;
        let diff = Math.abs(a - lineAngle);
        diff = Math.min(diff, Math.PI - diff); // orientation is mod π
        if (diff <= cfg.thetaAlignDeg * Math.PI / 180) { /* aligned */ } else { elong--; }
    }
    const frac = members.length ? elong / members.length : 0;
    return { pass: frac >= cfg.elongFrac && members.length >= cfg.minInliers, frac, thetaAvailable: withTheta };
}

/**
 * Tag satellite/aircraft trails in a detection list.
 * @param {Array<{x:number,y:number,flux?:number,ellipticity?:number,moment_ellipticity?:number,circularity?:number,theta?:number,snr?:number}>} dets
 * @param {{width?:number,height?:number}} frame  — for the span floor (diag). If
 *        absent, diag is derived from the detection coordinate bounds.
 * @param {object} [options]  — overrides of DEFAULTS.
 * @returns {{trails:Array, cfg:object, diag:number}}
 */
export function tagTrails(dets, frame = {}, options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    const n = dets.length;
    if (n < cfg.minInliers) return { trails: [], cfg, diag: 0 };

    let diag;
    if (frame.width && frame.height) diag = Math.hypot(frame.width, frame.height);
    else {
        let xmn = Infinity, xmx = -Infinity, ymn = Infinity, ymx = -Infinity;
        for (const d of dets) { xmn = Math.min(xmn, d.x); xmx = Math.max(xmx, d.x); ymn = Math.min(ymn, d.y); ymx = Math.max(ymx, d.y); }
        diag = Math.hypot(xmx - xmn, ymx - ymn);
    }
    const minSpan = Math.max(cfg.minSpanFrac * diag, cfg.minSpanAbsPx);

    // Flux-weighted seed sampler (bright strobe dashes out-flux real stars —
    // solver_entry:1356). Cumulative weights = flux (>=eps), fixed-seed PRNG.
    const rng = mulberry32(cfg.ransacSeed != null ? cfg.ransacSeed : RANSAC_SEED);
    const cum = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += Math.max(1e-6, dets[i].flux || 1e-6); cum[i] = acc; }
    const total = acc;
    const pick = () => {
        const r = rng() * total;
        // binary search
        let lo = 0, hi = n - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
        return lo;
    };

    // Candidate-line pool, deduped by (theta bucket, rho bucket) keeping max inliers.
    const pool = new Map();
    const dTheta = cfg.dedupThetaDeg * Math.PI / 180;
    const consider = (i, j) => {
        const ax = dets[i].x, ay = dets[i].y;
        const dx = dets[j].x - ax, dy = dets[j].y - ay;
        const len = Math.hypot(dx, dy);
        if (len < cfg.minSeedLen) return;
        const line = lineFromDir(ax, ay, dx / len, dy / len);
        const inl = collectInliers(line, dets, cfg.sigmaPerp, null);
        if (inl.length < cfg.minInliers) return;
        const key = `${Math.round(line.theta / dTheta)}:${Math.round(line.rho / cfg.dedupRhoPx)}`;
        const prev = pool.get(key);
        if (!prev || inl.length > prev.count) pool.set(key, { count: inl.length, i, j });
    };

    // (a) exhaustive seeding over the top-K brightest — guarantees bright trails.
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (dets[b].flux || 0) - (dets[a].flux || 0));
    const K = Math.min(cfg.topKExhaustive, n);
    for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) consider(order[a], order[b]);
    // (b) flux-weighted random seeding for the rest.
    for (let it = 0; it < cfg.ransacIters; it++) {
        const i = pick(); let j = pick(); if (i === j) { j = (j + 1) % n; }
        consider(i, j);
    }

    // Rank candidates by inlier count; refine (PCA) and evaluate the trail gate.
    const cands = [...pool.values()].sort((a, b) => b.count - a.count);
    const claimed = new Uint8Array(n);
    const trails = [];
    for (const c of cands) {
        if (trails.length >= cfg.maxTrails) break;
        // rebuild seed line, collect inliers among UNCLAIMED, refine, recollect.
        const ax = dets[c.i].x, ay = dets[c.i].y;
        const dx = dets[c.j].x - ax, dy = dets[c.j].y - ay;
        const len = Math.hypot(dx, dy);
        if (len < cfg.minSeedLen) continue;
        let line = lineFromDir(ax, ay, dx / len, dy / len);
        let members = collectInliers(line, dets, cfg.sigmaPerp, claimed);
        if (members.length < cfg.minInliers) continue;
        line = pcaLine(members.map(k => dets[k]));
        members = collectInliers(line, dets, cfg.sigmaPerp, claimed);
        if (members.length < cfg.minInliers) continue;

        // project → t-values, span
        const tvals = members.map(k => (dets[k].x - line.ox) * line.ux + (dets[k].y - line.oy) * line.uy);
        const span = Math.max(...tvals) - Math.min(...tvals);
        if (span < minSpan) continue;

        const s3 = s3Spacing(tvals, cfg);   // dash evidence
        const s1 = s1Elongation(members, dets, line, cfg); // continuous evidence
        // TRAIL GATE: collinear (already) AND (dashed-regular OR continuous-elongated).
        if (!(s3.pass || s1.pass)) continue;

        // spacing_regularity ∈ [0,1]: 1 = perfectly uniform dashes.
        const spacingReg = s3.ratio != null && isFinite(s3.ratio)
            ? Math.max(0, Math.min(1, (cfg.gapRatioMax - s3.ratio) / (cfg.gapRatioMax - 1)))
            : 0;
        // confidence: blend of collinearity strength, spacing regularity, elongation.
        const spanFrac = Math.min(1, span / diag);
        const conf = Math.max(0, Math.min(1,
            0.35 * Math.min(1, members.length / 20) +
            0.30 * (s3.pass ? spacingReg : 0) +
            0.25 * s1.frac +
            0.10 * spanFrac));

        for (const k of members) claimed[k] = 1;
        trails.push({
            trail_id: trails.length,
            member_indices: members.slice().sort((a, b) => a - b),
            n_members: members.length,
            line_params: {
                theta: line.theta,
                angle_deg: line.theta * 180 / Math.PI,
                rho: line.rho,
                sigma_perp: cfg.sigmaPerp,
            },
            spacing_regularity: spacingReg,
            confidence: conf,
            signals: {
                s1_elongation_pass: s1.pass, s1_elong_frac: s1.frac, s1_theta_available: s1.thetaAvailable,
                s3_dash_pass: s3.pass, s3_minGap: s3.minGap, s3_maxGap: s3.maxGap, s3_ratio: s3.ratio, s3_n_merged: s3.nMerged,
                span_px: span, span_frac: spanFrac,
            },
        });
    }
    return { trails, cfg, diag };
}

// ── thin CLI: detection-dump JSON → trail-tag JSON ───────────────────────────
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('trail_tag.mjs')) {
    const fs = await import('node:fs');
    const inPath = process.argv[2];
    if (!inPath) { console.error('usage: node trail_tag.mjs <detections.json|receipt.json> [out.json]'); process.exit(2); }
    const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
    // accept: array | {detections:[...]} | receipt {signal:{clean_stars:[...]}}
    let dets = Array.isArray(raw) ? raw
        : raw.detections ? raw.detections
            : raw.signal?.clean_stars ? raw.signal.clean_stars
                : raw.solution?.clean_stars ? raw.solution.clean_stars : null;
    if (!dets) { console.error('no detection array found (expected array | .detections | .signal.clean_stars)'); process.exit(2); }
    const w = raw.width || raw.metadata?.width, h = raw.height || raw.metadata?.height;
    const res = tagTrails(dets, { width: w, height: h });
    const out = { input: inPath, n_detections: dets.length, diag: res.diag, n_trails: res.trails.length, trails: res.trails };
    const outPath = process.argv[3];
    if (outPath) { fs.writeFileSync(outPath, JSON.stringify(out, null, 2)); console.log(`wrote ${outPath}: ${res.trails.length} trail(s) over ${dets.length} detections`); }
    else console.log(JSON.stringify(out, null, 2));
}
