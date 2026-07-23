// ═══════════════════════════════════════════════════════════════════════════
// SOLVERKIT — BAND-HASH GEOMETRY (shared by the builder AND the solver)
// ═══════════════════════════════════════════════════════════════════════════
// The scale/rotation-invariant 4-star geometric hash (Lang, Hogg, Mierle,
// Blanton, Roweis 2010, AJ 139:1782 — astrometry.net's code) lives HERE ONCE so
// the index BUILDER and the lost-in-space SOLVER quantize identically (CLAUDE.md
// LAW 4: never the same math in two places — a coder/decoder mismatch is the
// classic quad-index bug). Pure geometry — no WASM, no I/O.
//
// Two-ledger note (CLAUDE.md LAW 1): everything here is COORDINATE math. The hash
// operates on a *plane* (either a sky-tangent plane for catalog quads or the
// detection pixel plane for image quads); both are gnomonic planes, so the same
// code function is correct on either — that is the whole point of the hash.

import { D2R } from './common.mjs';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ── unit vectors + great-circle distance (sky, degrees) ─────────────────────
export function unitVec(raDeg, decDeg) {
    const r = raDeg * D2R, d = decDeg * D2R, cd = Math.cos(d);
    return [cd * Math.cos(r), cd * Math.sin(r), Math.sin(d)];
}
export function dotDeg(u, v) {
    return Math.acos(clamp(u[0] * v[0] + u[1] * v[1] + u[2] * v[2], -1, 1)) / D2R;
}
/** Mean sky direction of a set of {ra_deg,dec_deg} (unit-vector mean; RA-wrap safe). */
export function meanRaDec(stars) {
    let x = 0, y = 0, z = 0;
    for (const s of stars) { const u = unitVec(s.ra_deg, s.dec_deg); x += u[0]; y += u[1]; z += u[2]; }
    const n = Math.hypot(x, y, z) || 1; x /= n; y /= n; z /= n;
    const dec = Math.asin(clamp(z, -1, 1)) / D2R;
    let ra = Math.atan2(y, x) / D2R; if (ra < 0) ra += 360;
    return { raDeg: ra, decDeg: dec };
}

// ── local gnomonic (tangent-plane) projection, degrees ──────────────────────
// Standard gnomonic about (ra0,dec0); returns null behind the tangent point.
export function gnomonic(raDeg, decDeg, ra0Deg, dec0Deg) {
    const ra = raDeg * D2R, dec = decDeg * D2R, ra0 = ra0Deg * D2R, dec0 = dec0Deg * D2R;
    const sd = Math.sin(dec), cd = Math.cos(dec), sd0 = Math.sin(dec0), cd0 = Math.cos(dec0);
    const dra = ra - ra0, cdra = Math.cos(dra), sdra = Math.sin(dra);
    const cosc = sd0 * sd + cd0 * cd * cdra;
    if (cosc <= 1e-6) return null;
    return { x: (cd * sdra) / cosc / D2R, y: (cd0 * sd - sd0 * cd * cdra) / cosc / D2R };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE HASH CODE (Lang 2010): 4 planar points → a scale/rotation-invariant code.
// A,B = the widest pair (the quad diagonal); map A→(0,0), B→(1,1); the other two
// stars' coords (Cx,Cy,Dx,Dy) in that frame ARE the code. Canonicalised under the
// A↔B and C↔D relabel symmetries so the SAME four stars ALWAYS hash identically,
// whatever order they arrive in — that identity is what makes a det quad findable
// against a catalog quad. Returns { code:[Cx,Cy,Dx,Dy], ids:[A,B,C,D] } (ids in
// canonical order so the caller can build a VERTEX-PRESERVED correspondence), or
// null if degenerate.
// ═══════════════════════════════════════════════════════════════════════════
export function quadCode(pts) {
    if (pts.length !== 4) return null;
    // 1) widest pair → A,B (planar; on a gnomonic plane this ≈ the widest sky pair)
    let iA = 0, iB = 1, best = -1;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
        const d2 = (pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2;
        if (d2 > best) { best = d2; iA = i; iB = j; }
    }
    if (best <= 0) return null;
    const A = pts[iA], B = pts[iB];
    const ABx = B.x - A.x, ABy = B.y - A.y, L2 = ABx * ABx + ABy * ABy;
    const others = [];
    for (let i = 0; i < 4; i++) if (i !== iA && i !== iB) others.push(i);
    // 2) code coords in the A→(0,0), B→(1,1) frame
    const codeOf = (P) => {
        const dx = P.x - A.x, dy = P.y - A.y;
        const x1 = (dx * ABx + dy * ABy) / L2;          // along AB, in units of |AB|
        const y1 = (-dx * ABy + dy * ABx) / L2;         // perp AB, in units of |AB|
        return [x1 - y1, x1 + y1];                       // rotate+scale so B→(1,1)
    };
    let cA = iA, cB = iB;
    let [cx, cy] = codeOf(pts[others[0]]);
    let [dx, dy] = codeOf(pts[others[1]]);
    let cC = others[0], cD = others[1];
    // 3a) C↔D order by x
    if (cx > dx) { [cx, cy, dx, dy] = [dx, dy, cx, cy]; [cC, cD] = [cD, cC]; }
    // 3b) A↔B fold: code→(1-code) when Cx+Dx>1 (removes the diagonal-endpoint swap)
    if (cx + dx > 1) {
        [cx, cy, dx, dy] = [1 - cx, 1 - cy, 1 - dx, 1 - dy];
        [cA, cB] = [cB, cA];
        if (cx > dx) { [cx, cy, dx, dy] = [dx, dy, cx, cy]; [cC, cD] = [cD, cC]; }
    }
    return { code: [cx, cy, dx, dy], ids: [pts[cA].id, pts[cB].id, pts[cC].id, pts[cD].id] };
}

// ── bucket quantisation ──────────────────────────────────────────────────────
// Interior code coords live in ≈[-0.5,1.5] (C,D inside the AB-circle). Quantise
// each of the 4 dims over that range into NBINS bins → a single integer key.
export const CODE_LO = -0.5, CODE_HI = 1.5;
export function codeBin(v, nbins) {
    return clamp(Math.floor(((v - CODE_LO) / (CODE_HI - CODE_LO)) * nbins), 0, nbins - 1);
}
export function bucketKey(code, nbins) {
    const b0 = codeBin(code[0], nbins), b1 = codeBin(code[1], nbins);
    const b2 = codeBin(code[2], nbins), b3 = codeBin(code[3], nbins);
    return ((b0 * nbins + b1) * nbins + b2) * nbins + b3;
}
/** The query bucket + all ±1 neighbours in each dim (3^4=81) to absorb quantisation. */
export function neighbourKeys(code, nbins) {
    const b = [codeBin(code[0], nbins), codeBin(code[1], nbins), codeBin(code[2], nbins), codeBin(code[3], nbins)];
    const out = [];
    for (let d0 = -1; d0 <= 1; d0++) for (let d1 = -1; d1 <= 1; d1++)
        for (let d2 = -1; d2 <= 1; d2++) for (let d3 = -1; d3 <= 1; d3++) {
            const k0 = b[0] + d0, k1 = b[1] + d1, k2 = b[2] + d2, k3 = b[3] + d3;
            if (k0 < 0 || k1 < 0 || k2 < 0 || k3 < 0 || k0 >= nbins || k1 >= nbins || k2 >= nbins || k3 >= nbins) continue;
            out.push(((k0 * nbins + k1) * nbins + k2) * nbins + k3);
        }
    return out;
}

// ── a coarse sky-cell index for neighbour queries during the build ──────────
export class SkyGrid {
    constructor(stars, cellDeg = 4) {
        this.cellDeg = cellDeg;
        this.map = new Map();                 // key -> [starIdx...]
        this.stars = stars;
        for (let i = 0; i < stars.length; i++) {
            const k = this._key(stars[i].ra_deg, stars[i].dec_deg);
            let b = this.map.get(k); if (!b) { b = []; this.map.set(k, b); } b.push(i);
        }
    }
    _key(ra, dec) { return Math.floor((dec + 90) / this.cellDeg) * 100000 + Math.floor((ra % 360) / this.cellDeg); }
    /** Indices of stars within radiusDeg of (raDeg,decDeg). Great-circle exact. */
    query(raDeg, decDeg, radiusDeg) {
        const u0 = unitVec(raDeg, decDeg);
        const decCells = Math.ceil(radiusDeg / this.cellDeg) + 1;
        const dc = Math.floor((decDeg + 90) / this.cellDeg);
        const out = [];
        for (let dd = -decCells; dd <= decCells; dd++) {
            const decc = dc + dd; if (decc < 0 || decc * this.cellDeg > 180) continue;
            const decAtRow = decc * this.cellDeg - 90;
            const cosd = Math.max(0.01, Math.cos((decAtRow + this.cellDeg / 2) * D2R));
            const raCells = Math.ceil(radiusDeg / (this.cellDeg * cosd)) + 1;
            const rc = Math.floor((raDeg % 360) / this.cellDeg);
            for (let dr = -raCells; dr <= raCells; dr++) {
                let rac = (rc + dr) % Math.ceil(360 / this.cellDeg);
                if (rac < 0) rac += Math.ceil(360 / this.cellDeg);
                const b = this.map.get(decc * 100000 + rac); if (!b) continue;
                for (const idx of b) {
                    if (dotDeg(u0, unitVec(this.stars[idx].ra_deg, this.stars[idx].dec_deg)) <= radiusDeg) out.push(idx);
                }
            }
        }
        return out;
    }
}
