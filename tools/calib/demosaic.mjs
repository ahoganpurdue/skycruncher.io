// ═══════════════════════════════════════════════════════════════════════════
// tools/calib/demosaic.mjs — active-area integer-bilinear demosaic (CFA → RGB)
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors the wasm `rgb16_active()` contract (wasm_decode.d.ts): deterministic
// integer-bilinear demosaic over the ACTIVE AREA, CFA phase from ABSOLUTE full-
// frame coordinates, neighbour clamping at the active-area boundary so optical-
// black border values never bleed into science pixels. Rounded integer shifts
// (/2, /4) match the reference kernel in tools/rawlab/demosaic_reference.mjs.
//
// Needed because a CALIBRATED CFA grid (light − dark)/flat cannot be pushed back
// into the wasm to demosaic — so the calibration lane demosaics it JS-side with
// the SAME algorithm, then feeds the REAL m4. The uncalibrated arm uses the SAME
// demosaic (apples-to-apples A/B). Verified against wasm rgb16_active by
// ab_demosaic_check() below.
//
// Ledger: PIXEL.

const CH = { R: 0, G: 1, B: 2, E: 1 }; // RGBE → treat E as green (RGGB-family; 60D has no E)

/** channel index (0/1/2) at absolute full-frame coords, from the pattern string. */
function chAt(pattern, fx, fy) {
    const p = ((fy & 1) << 1) | (fx & 1);
    return CH[pattern[p]] ?? 1;
}

/**
 * Demosaic a full-frame CFA (single channel, Float32|Uint16) over the active
 * area → interleaved RGB Float32 (active_w*active_h*3), raw value domain (no
 * scaling). Phase is read at absolute full-frame coords; neighbours clamp at the
 * active-area boundary.
 */
export function demosaicActiveRGB(cfa, fullW, fullH, activeArea, pattern) {
    const aa = activeArea ?? { x: 0, y: 0, w: fullW, h: fullH };
    const ax0 = aa.x, ay0 = aa.y, aw = aa.w, ah = aa.h;
    const n = aw * ah;
    const R = new Float64Array(n), G = new Float64Array(n), B = new Float64Array(n);
    const planes = [R, G, B];
    const at = (fx, fy) => cfa[fy * fullW + fx];

    // scatter native photosite value into its plane (active coords)
    for (let ay = 0; ay < ah; ay++) {
        const fy = ay0 + ay;
        for (let ax = 0; ax < aw; ax++) {
            const fx = ax0 + ax;
            planes[chAt(pattern, fx, fy)][ay * aw + ax] = at(fx, fy);
        }
    }
    // active-area clamped neighbour access into a plane
    const clx = (ax) => (ax < 0 ? 0 : ax >= aw ? aw - 1 : ax);
    const cly = (ay) => (ay < 0 ? 0 : ay >= ah ? ah - 1 : ay);
    const P = (plane, ax, ay) => plane[cly(ay) * aw + clx(ax)];
    const d2 = (a, b) => Math.round((a + b) / 2);
    const d4 = (a, b, c, dd) => Math.round((a + b + c + dd) / 4);

    const out = new Float32Array(n * 3);
    for (let ay = 0; ay < ah; ay++) {
        const fy = ay0 + ay;
        for (let ax = 0; ax < aw; ax++) {
            const fx = ax0 + ax;
            const c = chAt(pattern, fx, fy);
            const i = ay * aw + ax;
            let rr, gg, bb;
            // G
            if (c === 1) gg = G[i];
            else gg = d4(P(G, ax, ay - 1), P(G, ax, ay + 1), P(G, ax - 1, ay), P(G, ax + 1, ay));
            // R
            if (c === 0) rr = R[i];
            else if (c === 2) rr = d4(P(R, ax - 1, ay - 1), P(R, ax + 1, ay - 1), P(R, ax - 1, ay + 1), P(R, ax + 1, ay + 1));
            else { // green site: R is horizontal or vertical neighbour depending on the R row
                const rHoriz = chAt(pattern, fx - 1, fy) === 0 || chAt(pattern, fx + 1, fy) === 0;
                rr = rHoriz ? d2(P(R, ax - 1, ay), P(R, ax + 1, ay)) : d2(P(R, ax, ay - 1), P(R, ax, ay + 1));
            }
            // B
            if (c === 2) bb = B[i];
            else if (c === 0) bb = d4(P(B, ax - 1, ay - 1), P(B, ax + 1, ay - 1), P(B, ax - 1, ay + 1), P(B, ax + 1, ay + 1));
            else {
                const bHoriz = chAt(pattern, fx - 1, fy) === 2 || chAt(pattern, fx + 1, fy) === 2;
                bb = bHoriz ? d2(P(B, ax - 1, ay), P(B, ax + 1, ay)) : d2(P(B, ax, ay - 1), P(B, ax, ay + 1));
            }
            out[i * 3] = rr; out[i * 3 + 1] = gg; out[i * 3 + 2] = bb;
        }
    }
    return { rgb: out, width: aw, height: ah };
}
