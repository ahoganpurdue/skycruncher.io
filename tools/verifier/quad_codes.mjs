// ═══════════════════════════════════════════════════════════════════════════
// GEOMETRIC VERIFIER — QUAD CODE PRIMITIVES (pure geometry, no I/O)
// ═══════════════════════════════════════════════════════════════════════════
// astrometry.net-style similarity-invariant 4-star codes, built by the SAME
// recipe on two point pools that live in the SAME pixel frame:
//   pool D = brightest-N frame detections (native pixel space)
//   pool C = brightest-M catalog stars PROJECTED through the candidate WCS
// A code match between a D-quad and a C-quad implies a similarity transform
// D->C; for the TRUE WCS that transform is ~identity (catalog is already in
// the frame's own pixel space), while a CHANCE code collision carries a
// random transform. Gating on near-identity therefore suppresses chance
// multiplicatively — the anti-proximity, anti-flooding core of this verifier
// (design constraints from test_results/night_run_2026-07-13/MORNING_REPORT.md
// and superpixel/truth_test/truth_test_findings.json).
//
// Quad construction (both pools, identical recipe — junk detections add codes
// but cannot remove a genuine one):
//   for every point pair (A,B) with sep in [sepMin, sepMax]:
//     interior = points inside the circle with diameter AB (cap: brightest
//     `capInterior`); every interior 2-subset (C,D) forms one quad.
//   code: map A->0, B->1 in the complex plane (z = (p-A)/(B-A));
//         code = [Cx, Cy, Dx, Dy] with C/D ordered by x, and the A/B
//         orientation fixed by requiring Cx+Dx <= 1 (astrometry.net canon).
//   NO mirror canonicalisation: both pools share one pixel frame, so parity is
//   consistent for a true WCS and a wrong-parity candidate honestly scores 0.
//
// Determinism: no randomness here; callers use common.rng (mulberry32) for the
// scrambled null.

/**
 * Build similarity-invariant quad codes from a point pool.
 * @param pts [{x,y,w}] w = brightness weight (flux or -mag), higher = brighter
 * @param opts {sepMin, sepMax, capInterior}
 * @returns {codes: Float64Array(n*4), quads: Int32Array(n*4)} indices into pts
 */
export function buildQuadCodes(pts, { sepMin, sepMax, capInterior = 6 } = {}) {
    const n = pts.length;
    const codes = [];
    const quads = [];
    const sepMin2 = sepMin * sepMin, sepMax2 = sepMax * sepMax;
    for (let i = 0; i < n; i++) {
        const A = pts[i];
        for (let j = i + 1; j < n; j++) {
            const B = pts[j];
            const dx = B.x - A.x, dy = B.y - A.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < sepMin2 || d2 > sepMax2) continue;
            // interior of the circle with diameter AB
            const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
            const r2 = d2 / 4;
            const interior = [];
            for (let k = 0; k < n; k++) {
                if (k === i || k === j) continue;
                const P = pts[k];
                const ex = P.x - mx, ey = P.y - my;
                if (ex * ex + ey * ey <= r2) interior.push(k);
            }
            if (interior.length < 2) continue;
            if (interior.length > capInterior) {
                interior.sort((a, b) => pts[b].w - pts[a].w);
                interior.length = capInterior;
            }
            // complex basis: z(p) = (p - A) / (B - A)
            const inv = 1 / d2; // 1/|B-A|^2
            const zx = (p) => ((p.x - A.x) * dx + (p.y - A.y) * dy) * inv;
            const zy = (p) => ((p.y - A.y) * dx - (p.x - A.x) * dy) * inv;
            for (let u = 0; u < interior.length; u++) {
                for (let v = u + 1; v < interior.length; v++) {
                    let ci = interior[u], di = interior[v];
                    let cx = zx(pts[ci]), cy = zy(pts[ci]);
                    let dx2 = zx(pts[di]), dy2 = zy(pts[di]);
                    let ai = i, bi = j;
                    // canon 1: A/B orientation — require cx+dx <= 1 (else swap A,B: z -> 1-z)
                    if (cx + dx2 > 1) {
                        ai = j; bi = i;
                        cx = 1 - cx; cy = -cy; dx2 = 1 - dx2; dy2 = -dy2;
                    }
                    // canon 2: order C,D by code x
                    if (dx2 < cx) {
                        [cx, dx2] = [dx2, cx]; [cy, dy2] = [dy2, cy]; [ci, di] = [di, ci];
                    }
                    codes.push(cx, cy, dx2, dy2);
                    quads.push(ai, bi, ci, di);
                }
            }
        }
    }
    return { codes: Float64Array.from(codes), quads: Int32Array.from(quads), count: quads.length / 4 };
}

/** 4D grid hash of codes with cell = tol (query checks 3^4 neighbor cells). */
export function hashCodes(codeSet, tol) {
    const m = new Map();
    const nc = codeSet.count;
    const inv = 1 / tol;
    for (let q = 0; q < nc; q++) {
        const o = q * 4;
        const k = key4(
            Math.floor(codeSet.codes[o] * inv), Math.floor(codeSet.codes[o + 1] * inv),
            Math.floor(codeSet.codes[o + 2] * inv), Math.floor(codeSet.codes[o + 3] * inv));
        let b = m.get(k); if (!b) { b = []; m.set(k, b); } b.push(q);
    }
    return { map: m, tol, codeSet };
}
// codes live in ~[-0.5, 1.5]: offset to keep cell indices positive, pack base-4096
function key4(a, b, c, d) {
    return (((a + 2048) * 4096 + (b + 2048)) * 4096 + (c + 2048)) * 4096 + (d + 2048);
}

/**
 * Match det codes against a hashed cat code set; for every code pair within
 * `tol` (4D Euclidean), compute the implied det->cat similarity from the A,B
 * baseline and gate on near-identity. Returns passing matches.
 * @param det {codes,quads} + detPts   @param catHash from hashCodes + catPts
 * @param g gates {maxLogScale, maxRotDeg, maxTransPx}
 */
export function matchAndGate(detSet, detPts, catHash, catPts, g) {
    const { map, tol, codeSet: catSet } = catHash;
    const tol2 = tol * tol;
    const inv = 1 / tol;
    const out = [];
    const nd = detSet.count;
    const maxRotRad = g.maxRotDeg * Math.PI / 180;
    for (let q = 0; q < nd; q++) {
        const o = q * 4;
        const c0 = detSet.codes[o], c1 = detSet.codes[o + 1], c2 = detSet.codes[o + 2], c3 = detSet.codes[o + 3];
        const i0 = Math.floor(c0 * inv), i1 = Math.floor(c1 * inv), i2 = Math.floor(c2 * inv), i3 = Math.floor(c3 * inv);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) for (let d = -1; d <= 1; d++) {
            const bucket = map.get(key4(i0 + a, i1 + b, i2 + c, i3 + d));
            if (!bucket) continue;
            for (const p of bucket) {
                const po = p * 4;
                const e0 = catSet.codes[po] - c0, e1 = catSet.codes[po + 1] - c1,
                    e2 = catSet.codes[po + 2] - c2, e3 = catSet.codes[po + 3] - c3;
                const d4 = e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3;
                if (d4 > tol2) continue;
                // implied similarity from the A,B baselines
                const dA = detPts[detSet.quads[o]], dB = detPts[detSet.quads[o + 1]];
                const cA = catPts[catSet.quads[po]], cB = catPts[catSet.quads[po + 1]];
                const vdx = dB.x - dA.x, vdy = dB.y - dA.y;
                const vcx = cB.x - cA.x, vcy = cB.y - cA.y;
                const ld = Math.hypot(vdx, vdy), lc = Math.hypot(vcx, vcy);
                if (ld === 0 || lc === 0) continue;
                const logS = Math.log(lc / ld);
                if (Math.abs(logS) > g.maxLogScale) continue;
                let rot = Math.atan2(vcy, vcx) - Math.atan2(vdy, vdx);
                if (rot > Math.PI) rot -= 2 * Math.PI;
                if (rot < -Math.PI) rot += 2 * Math.PI;
                if (Math.abs(rot) > maxRotRad) continue;
                // centroid translation (scale~1, rot~0 => direct diff is the translation)
                let dcx = 0, dcy = 0, ccx = 0, ccy = 0;
                for (let t = 0; t < 4; t++) {
                    const dp = detPts[detSet.quads[o + t]], cp = catPts[catSet.quads[po + t]];
                    dcx += dp.x; dcy += dp.y; ccx += cp.x; ccy += cp.y;
                }
                const trans = Math.hypot((ccx - dcx) / 4, (ccy - dcy) / 4);
                if (trans > g.maxTransPx) continue;
                out.push({
                    detIdx: [detSet.quads[o], detSet.quads[o + 1], detSet.quads[o + 2], detSet.quads[o + 3]],
                    catIdx: [catSet.quads[po], catSet.quads[po + 1], catSet.quads[po + 2], catSet.quads[po + 3]],
                    codeDist: Math.sqrt(d4), logScale: logS, rotDeg: rot * 180 / Math.PI, transPx: trans,
                });
            }
        }
    }
    return out;
}

/**
 * Reduce gated matches to the two headline counts:
 *  anchored  = distinct DETECTIONS participating in >=1 passing quad
 *  passQuads = distinct det-quad identities that passed (dedup: one det quad
 *              matching several cat quads counts once — no combinatorial reuse)
 */
export function summarizeMatches(matches) {
    const stars = new Set(), quads = new Set();
    for (const m of matches) {
        const q = m.detIdx.slice().sort((a, b) => a - b).join(',');
        quads.add(q);
        for (const i of m.detIdx) stars.add(i);
    }
    return { anchored: stars.size, passQuads: quads.size, rawMatches: matches.length };
}
