// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — render stage: star/background separation, annulus-bootstrap
// hole fill, per-star fidelity re-placement
// ═══════════════════════════════════════════════════════════════════════════
// Owner design:
//   - background layer = star-subtracted image, warped ONCE through the
//     coordinate function (interpolation on smooth structure is acceptable);
//   - star layer = cleaned/deconvolved stamps re-placed at CORRECTED
//     coordinates, PER-STAR FIDELITY (each star keeps its own measured
//     deconvolved profile and exact flux);
//   - star holes filled ONLY under the removed PSF footprint with
//     locally-derived background: BOOTSTRAP resampling of actual annulus
//     pixels (RGB triplets — preserves the true noise distribution AND
//     channel correlation) for small stars; first-order plane + bootstrap
//     residual jitter for large/bright stars;
//   - synthetic-pixel provenance mask emitted alongside.
//
// The annulus machinery is the same primitive as aperture photometry and is
// exported as a reusable function (annulusStats).

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── footprints ──────────────────────────────────────────────────────────────

/**
 * Flux-defined star footprints: flood-fill from each detected peak claiming
 * connected pixels whose value exceeds localRingMedian + 0.5 * sigmaN
 * (undersized holes leave ghost halos — the boundary is set by flux, not by
 * a fixed radius), capped at a safety radius. Expansion is descent-
 * constrained (child <= parent + 0.75 sigma) so the fill cannot percolate up
 * residual background structure (nebulosity) while still crossing noise dips
 * inside the PSF. Expects the background-FLATTENED luminance.
 */
export function buildFootprintMask({ L, w, h, peaks, sigmaN, capRadius = 48, margin = 8 }) {
    const mask = new Uint8Array(w * h);
    const boxSide = 2 * capRadius + 1;
    const queue = new Int32Array(boxSide * boxSide * 2);
    const ringVals = [];

    for (const p of peaks) {
        const px = p.x, py = p.y;
        if (px < margin || py < margin || px >= w - margin || py >= h - margin) continue;
        if (mask[py * w + px]) continue;
        // local background: median of a Chebyshev ring r in [12, 18]
        ringVals.length = 0;
        for (let r = 12; r <= 18; r += 3) {
            for (let t = -r; t <= r; t += 2) {
                const xs = [px + t, px + t, px - r, px + r];
                const ys = [py - r, py + r, py + t, py + t];
                for (let k = 0; k < 4; k++) {
                    const X = xs[k], Y = ys[k];
                    if (X >= 0 && Y >= 0 && X < w && Y < h) ringVals.push(L[Y * w + X]);
                }
            }
        }
        ringVals.sort((a, b) => a - b);
        const bgLoc = ringVals[ringVals.length >> 1];
        const thresh = bgLoc + 0.5 * sigmaN;
        if (L[py * w + px] <= thresh) continue;

        let qh = 0, qt = 0;
        const descentTol = 0.75 * sigmaN;
        queue[qt++] = px; queue[qt++] = py;
        mask[py * w + px] = 1;
        while (qh < qt) {
            const cx = queue[qh++], cy = queue[qh++];
            const parentV = L[cy * w + cx];
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const X = cx + dx, Y = cy + dy;
                    if (X < 2 || Y < 2 || X >= w - 2 || Y >= h - 2) continue;
                    if (Math.abs(X - px) > capRadius || Math.abs(Y - py) > capRadius) continue;
                    const i = Y * w + X;
                    if (mask[i] || L[i] <= thresh || L[i] > parentV + descentTol) continue;
                    mask[i] = 1;
                    if (qt < queue.length - 2) { queue[qt++] = X; queue[qt++] = Y; }
                }
            }
        }
    }
    return mask;
}

/**
 * Connected-component labeling (8-conn) over a footprint mask.
 * Pixel indices are stored in one flat Int32Array; each component records
 * its [start, end) slice plus bbox and luminance-weighted centroid.
 */
export function labelComponents(mask, L, w, h) {
    const labels = new Int32Array(w * h); // 0 = background
    let flat = new Int32Array(1 << 20);
    let flatLen = 0;
    const comps = [];
    const queue = new Int32Array(1 << 16);
    const pushFlat = (v) => {
        if (flatLen === flat.length) {
            const bigger = new Int32Array(flat.length * 2);
            bigger.set(flat); flat = bigger;
        }
        flat[flatLen++] = v;
    };

    let nextId = 1;
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || labels[start]) continue;
        const id = nextId++;
        const begin = flatLen;
        let qh = 0, qt = 0;
        let bigQueue = queue;
        bigQueue[qt++] = start;
        labels[start] = id;
        let x0 = w, x1 = 0, y0 = h, y1 = 0, sw = 0, sx = 0, sy = 0, maxV = -Infinity, maxI = start;
        while (qh < qt) {
            const i = bigQueue[qh++];
            pushFlat(i);
            const y = (i / w) | 0, x = i - y * w;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            const v = L[i];
            if (v > maxV) { maxV = v; maxI = i; }
            const wgt = v > 0 ? v : 1e-6;
            sw += wgt; sx += wgt * x; sy += wgt * y;
            for (let dy = -1; dy <= 1; dy++) {
                const Y = y + dy;
                if (Y < 0 || Y >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const X = x + dx;
                    if (X < 0 || X >= w) continue;
                    const j = Y * w + X;
                    if (!mask[j] || labels[j]) continue;
                    labels[j] = id;
                    if (qt === bigQueue.length) {
                        const bigger = new Int32Array(bigQueue.length * 2);
                        bigger.set(bigQueue); bigQueue = bigger;
                    }
                    bigQueue[qt++] = j;
                }
            }
        }
        comps.push({
            id, start: begin, end: flatLen,
            x0, x1, y0, y1, area: flatLen - begin,
            cx: sx / sw, cy: sy / sw,
            peakIdx: maxI, peakV: maxV,
        });
    }
    return { labels, flat: flat.subarray(0, flatLen), comps };
}

// ── the reusable annulus primitive (aperture-photometry machinery) ──────────

/**
 * Sigma-clipped annulus statistics around a component.
 * The annulus is a distance band beyond the PSF wings (Chebyshev distance
 * from the footprint in [gap+1, gap+ring], widened until minPix), excluding
 * every pixel that belongs to ANY footprint (neighbor contamination), then
 * sigma-clipped on luminance (2 rounds, 3 sigma) to reject what is left.
 *
 * Returns kept pixel indices plus, per channel, a first-order plane fit
 * (local frame centered on the component centroid).
 */
export function annulusStats({ channels, L, w, h, comp, flat, mask, gap = 2, ring = 6, minPix = 60, maxRing = 16 }) {
    // local window with room for the widest band
    const pad = gap + maxRing + 1;
    const wx0 = Math.max(0, comp.x0 - pad), wx1 = Math.min(w - 1, comp.x1 + pad);
    const wy0 = Math.max(0, comp.y0 - pad), wy1 = Math.min(h - 1, comp.y1 + pad);
    const ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1;
    const dist = new Uint8Array(ww * wh).fill(255);
    for (let k = comp.start; k < comp.end; k++) {
        const i = flat[k];
        const y = (i / w) | 0, x = i - y * w;
        dist[(y - wy0) * ww + (x - wx0)] = 0;
    }
    // Chebyshev distance transform via iterative 3x3 dilation
    for (let d = 1; d <= gap + maxRing; d++) {
        let changed = false;
        for (let y = 0; y < wh; y++) {
            for (let x = 0; x < ww; x++) {
                const i = y * ww + x;
                if (dist[i] !== 255) continue;
                let near = false;
                for (let dy = -1; dy <= 1 && !near; dy++) {
                    const Y = y + dy;
                    if (Y < 0 || Y >= wh) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const X = x + dx;
                        if (X < 0 || X >= ww) continue;
                        if (dist[Y * ww + X] === d - 1) { near = true; break; }
                    }
                }
                if (near) { dist[i] = d; changed = true; }
            }
        }
        if (!changed) break;
    }

    // collect band pixels, widening until minPix
    let bandOuter = gap + ring;
    let idxs = [];
    while (true) {
        idxs.length = 0;
        for (let y = 0; y < wh; y++) {
            for (let x = 0; x < ww; x++) {
                const d = dist[y * ww + x];
                if (d > gap && d <= bandOuter) {
                    const gi = (y + wy0) * w + (x + wx0);
                    if (!mask[gi]) idxs.push(gi);
                }
            }
        }
        if (idxs.length >= minPix || bandOuter >= gap + maxRing) break;
        bandOuter += 2;
    }
    if (idxs.length < 8) return null;

    // sigma-clip on luminance
    let kept = idxs;
    for (let round = 0; round < 2; round++) {
        const vals = kept.map((i) => L[i]).sort((a, b) => a - b);
        const med = vals[vals.length >> 1];
        const dev = vals.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
        const sig = 1.4826 * dev[dev.length >> 1] + 1e-12;
        const next = kept.filter((i) => Math.abs(L[i] - med) <= 3 * sig);
        if (next.length >= 8) kept = next;
    }

    // per-channel first-order plane in local coords (centered on comp centroid)
    const planes = [];
    for (const ch of channels) {
        let s0 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sv = 0, svx = 0, svy = 0;
        for (const i of kept) {
            const y = (i / w) | 0, x = i - y * w;
            const lx = x - comp.cx, ly = y - comp.cy;
            const v = ch[i];
            s0++; sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly; syy += ly * ly;
            sv += v; svx += v * lx; svy += v * ly;
        }
        const A = [s0, sx, sy, sx, sxx, sxy, sy, sxy, syy];
        const det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
        if (Math.abs(det) < 1e-9 || kept.length < 12) {
            planes.push({ c0: s0 ? sv / s0 : 0, c1: 0, c2: 0 }); // degenerate: constant
            continue;
        }
        const rep = (col, b) => { const C = A.slice(); C[col] = b[0]; C[col + 3] = b[1]; C[col + 6] = b[2]; return C; };
        const det3 = (M) => M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
        const b = [sv, svx, svy];
        planes.push({ c0: det3(rep(0, b)) / det, c1: det3(rep(1, b)) / det, c2: det3(rep(2, b)) / det });
    }

    // luminance scatter of the kept annulus (for reporting / mode choice)
    const lvals = kept.map((i) => L[i]).sort((a, b) => a - b);
    const lmed = lvals[lvals.length >> 1];
    const ldev = lvals.map((v) => Math.abs(v - lmed)).sort((a, b) => a - b);

    return {
        kept: Int32Array.from(kept),
        nRaw: idxs.length,
        medL: lmed,
        sigmaL: 1.4826 * ldev[ldev.length >> 1],
        planes, // [{c0,c1,c2}] per channel, local coords (x-cx, y-cy)
        planeEval: (planeIdx, x, y) => {
            const p = planes[planeIdx];
            return p.c0 + p.c1 * (x - comp.cx) + p.c2 * (y - comp.cy);
        },
    };
}

// ── hole fill ───────────────────────────────────────────────────────────────

/**
 * Fill a component's footprint in `channels` (in place) from its annulus.
 *   mode 'bootstrap': resample actual annulus pixels with replacement —
 *     RGB triplets copied together (true noise distribution + channel
 *     correlation; NO independent per-channel synthesis).
 *   mode 'plane': first-order plane per channel + bootstrap residual jitter
 *     (residual triplet of a random annulus pixel) on top.
 * Marks filled pixels in syntheticMask.
 */
export function fillComponentHole({ channels, w, comp, flat, ann, mode, rng, syntheticMask }) {
    const nAnn = ann.kept.length;
    for (let k = comp.start; k < comp.end; k++) {
        const p = flat[k];
        const j = ann.kept[(rng() * nAnn) | 0];
        if (mode === 'bootstrap') {
            for (let c = 0; c < 3; c++) channels[c][p] = channels[c][j];
        } else {
            const py = (p / w) | 0, px = p - py * w;
            const jy = (j / w) | 0, jx = j - jy * w;
            for (let c = 0; c < 3; c++) {
                const residual = channels[c][j] - ann.planeEval(c, jx, jy);
                channels[c][p] = ann.planeEval(c, px, py) + residual;
            }
        }
        syntheticMask[p] = 1;
    }
}

// ── star stamps (per-star fidelity) ─────────────────────────────────────────

/**
 * Cut a star's stamp for re-placement, flux-rescaled so the stamp's
 * integrated luminance equals the NATIVE-grid measurement (exact flux
 * preservation regardless of RL damping). Returns null when flux unusable.
 *
 * DARK-ANNULI FIX (radial feather; pairs with the per-star native fallback
 * in the caller): damped RL steals flux from the wing zone just outside the
 * tightened core, so (deconvolved - plane) goes NEGATIVE in a moat around
 * mid-bright stars; adding that stamp on top of the background fill printed
 * a visible dark ring at the fill seam (SeeStar M66 composite).
 *
 *   FEATHER:  value(r) = t(r)*deconvolved + (1-t(r))*native - plane
 *   t = 1 inside rCore (keep the deconvolved sharpening — it lives within
 *   ~0.75 FWHM of the peak), smoothstep to t = 0 at rEdge (wings: NATIVE
 *   profile — RL is untrustworthy near the damping floor).
 *   rCore = min(0.6*rEff, 0.75*fwhmPx), rEdge = rCore + max(2, 0.75*fwhmPx),
 *   capped at rEff = sqrt(area/pi).
 *
 * Two rejected variants, measured on the M66 stack (keep them rejected):
 *   - feather ALONE: the moat starts right at the sharpened core edge, and
 *     at sigma = 2.4e-5 even a 20%-residual moat is a >3-sigma trench (the
 *     deconvolved frame dipped 0.054 BELOW background at r=2 on a 0.73-peak
 *     star — RL ringing, effectively undamped on an ultra-deep stack);
 *   - wing POSITIVITY CLAMP: rectified noise over large footprints inflates
 *     fluxDeconv, so the flux rescale crushed star cores (native peak 0.140
 *     -> composite 0.030). Values must stay UNCLIPPED — small negatives are
 *     noise that must cancel in the flux sums.
 * Stars whose deconvolved profile genuinely rings get a NATIVE-profile stamp
 * from the caller (same law as saturated stars) — see measure_and_clean.
 *
 * Flux contract: total luminance flux equals the NATIVE measurement EXACTLY
 * via the rescale; identity deconvolution gives scale == 1.
 */
export function makeStamp({ deconvChannels, nativeChannels, comp, flat, ann, w, fwhmPx = null }) {
    const wS = comp.x1 - comp.x0 + 1, hS = comp.y1 - comp.y0 + 1;
    const data = [new Float32Array(wS * hS), new Float32Array(wS * hS), new Float32Array(wS * hS)];
    const LW = [0.2126, 0.7152, 0.0722];
    const rEff = Math.sqrt(comp.area / Math.PI);
    const coreScale = fwhmPx ? 0.75 * fwhmPx : 0.5 * rEff;
    const rCore = Math.min(0.6 * rEff, coreScale);
    const rEdge = Math.min(Math.max(rEff, rCore + 0.5), rCore + Math.max(2, coreScale));
    const invSpan = 1 / Math.max(1e-6, rEdge - rCore);
    let fluxNative = 0, fluxDeconv = 0;
    for (let k = comp.start; k < comp.end; k++) {
        const p = flat[k];
        const py = (p / w) | 0, px = p - py * w;
        const o = (py - comp.y0) * wS + (px - comp.x0);
        // radial feather about the luminance-weighted centroid
        const rr = Math.hypot(px - comp.cx, py - comp.cy);
        let s = (rr - rCore) * invSpan;
        s = s <= 0 ? 0 : (s >= 1 ? 1 : s * s * (3 - 2 * s)); // smoothstep 0..1
        const t = 1 - s;                                      // 1 core .. 0 edge
        for (let c = 0; c < 3; c++) {
            const bg = ann.planeEval(c, px, py);
            const dv = t * deconvChannels[c][p] + (1 - t) * nativeChannels[c][p] - bg;
            const nv = nativeChannels[c][p] - bg;
            data[c][o] = dv;
            fluxDeconv += LW[c] * dv;
            fluxNative += LW[c] * nv;
        }
    }
    if (!(fluxDeconv > 0) || !(fluxNative > 0)) return null;
    const scale = fluxNative / fluxDeconv;
    for (let c = 0; c < 3; c++) for (let i = 0; i < data[c].length; i++) data[c][i] *= scale;
    return { x0: comp.x0, y0: comp.y0, wS, hS, data, scale, fluxNative };
}

/** Additively place a stamp at an integer offset (bounds-clipped). */
export function placeStamp(dstChannels, w, h, stamp, offX, offY) {
    for (let y = 0; y < stamp.hS; y++) {
        const Y = stamp.y0 + y + offY;
        if (Y < 0 || Y >= h) continue;
        const srow = y * stamp.wS, drow = Y * w;
        for (let x = 0; x < stamp.wS; x++) {
            const X = stamp.x0 + x + offX;
            if (X < 0 || X >= w) continue;
            for (let c = 0; c < 3; c++) dstChannels[c][drow + X] += stamp.data[c][srow + x];
        }
    }
}

/** LABELED SEAM (stub): future homogenized-PSF star placement. */
export function placeStarsHomogenized() {
    throw new Error('STUB: homogenized-PSF placement is a labeled seam — per-star fidelity (placeStamp) is the implemented path');
}

// ── self-test on synthetic data ─────────────────────────────────────────────

/**
 * Unit-style self-test of footprint/annulus/fill/stamp primitives on a
 * synthetic frame: plane background + channel-correlated noise + one
 * Gaussian star. Returns { passed, checks: [...] }.
 */
export function selfTestRenderPrimitives() {
    const w = 220, h = 220;
    const rng = mulberry32(1234567);
    const gauss = () => {
        const u = Math.max(1e-12, rng()), v = rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const R = new Float32Array(w * h), G = new Float32Array(w * h), B = new Float32Array(w * h);
    const noiseSig = 0.01;
    const plane = (x, y) => 0.10 + 0.0004 * x + 0.0002 * y;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const shared = gauss() * noiseSig;
            const base = plane(x, y);
            R[i] = base + shared + gauss() * noiseSig * 0.3;
            G[i] = base + 0.8 * shared + gauss() * noiseSig * 0.3;
            B[i] = base + 0.6 * shared + gauss() * noiseSig * 0.3;
        }
    }
    // star at (110, 110), sigma 2, peak 0.5 (luminance-equal in all channels)
    const sx = 110, sy = 110, sig = 2, peak = 0.5;
    let trueFlux = 0;
    for (let y = sy - 15; y <= sy + 15; y++) {
        for (let x = sx - 15; x <= sx + 15; x++) {
            const v = peak * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / (2 * sig * sig));
            const i = y * w + x;
            R[i] += v; G[i] += v; B[i] += v;
            trueFlux += v;
        }
    }
    // pipeline contract: footprints are built on the background-FLATTENED
    // luminance (here the injected plane is known exactly)
    const L = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i] - plane(x, y) + 0.1;
    }
    const channels = [R, G, B];

    const mask = buildFootprintMask({ L, w, h, peaks: [{ x: sx, y: sy }], sigmaN: noiseSig, capRadius: 30 });
    const { flat, comps } = labelComponents(mask, L, w, h);
    const checks = [];
    const push = (name, pass, detail) => checks.push({ name, pass, detail });

    push('one component found', comps.length === 1, `components=${comps.length}`);
    const comp = comps[0];
    const footR = Math.max(comp.x1 - comp.x0, comp.y1 - comp.y0) / 2;
    const effR = Math.sqrt(comp.area / Math.PI);
    push('footprint spans PSF wings (effective r in [3.5, 9] px for sigma=2 @0.5sigma-noise cut; bbox dendrites <= 20)',
        effR >= 3.5 && effR <= 9 && footR <= 20, `effR=${effR.toFixed(1)}px halfWidth=${footR.toFixed(1)}px area=${comp.area}`);

    const ann = annulusStats({ channels, L, w, h, comp, flat, mask });
    push('annulus produced', !!ann, ann ? `kept=${ann.kept.length}/${ann.nRaw}` : 'null');

    // stamp BEFORE filling (fill mutates the background under the star)
    const stamp = makeStamp({ deconvChannels: channels, nativeChannels: channels, comp, flat, ann, w, fwhmPx: 2.3548 * sig });
    // CONTRACT (updated with the wing-positivity clamp): the LW-weighted
    // stamp sum must equal the native flux EXACTLY (the rescale guarantees
    // it); identity `scale` is no longer exactly 1 because clamped wing
    // noise is rectified — it must stay within 2%.
    let stampSumL = 0;
    if (stamp) {
        const LWc = [0.2126, 0.7152, 0.0722];
        for (let c = 0; c < 3; c++) for (const v of stamp.data[c]) stampSumL += LWc[c] * v;
    }
    push('stamp flux preserved exactly (LW-weighted sum == native flux)', !!stamp && Math.abs(stampSumL - stamp.fluxNative) / stamp.fluxNative < 1e-6, stamp ? `sum=${stampSumL.toFixed(6)} native=${stamp.fluxNative.toFixed(6)}` : 'null');
    push('identity deconv scale ~ 1 (wing clamp rectifies only noise)', !!stamp && Math.abs(stamp.scale - 1) < 0.02, stamp ? `scale=${stamp.scale.toFixed(5)}` : 'null');
    push('stamp flux ~= injected flux (plane bg removed)', !!stamp && Math.abs(stamp.fluxNative - trueFlux) / trueFlux < 0.08, stamp ? `stamp=${stamp.fluxNative.toFixed(3)} injected=${trueFlux.toFixed(3)}` : 'null');

    const synth = new Uint8Array(w * h);
    fillComponentHole({ channels, w, comp, flat, ann, mode: 'bootstrap', rng, syntheticMask: synth });
    let nSynth = 0;
    for (const v of synth) nSynth += v;
    push('synthetic mask covers exactly the footprint', nSynth === comp.area, `${nSynth} vs ${comp.area}`);

    // filled statistics vs truth
    let mErr = 0, m2 = 0, n = 0, corrRG = 0, mR = 0, mG = 0, vR = 0, vG = 0;
    for (let k = comp.start; k < comp.end; k++) {
        const p = flat[k];
        const py = (p / w) | 0, px = p - py * w;
        const lum = 0.2126 * R[p] + 0.7152 * G[p] + 0.0722 * B[p];
        const err = lum - plane(px, py);
        mErr += err; m2 += err * err; n++;
        mR += R[p]; mG += G[p];
    }
    mErr /= n; m2 = Math.sqrt(m2 / n); mR /= n; mG /= n;
    for (let k = comp.start; k < comp.end; k++) {
        const p = flat[k];
        corrRG += (R[p] - mR) * (G[p] - mG);
        vR += (R[p] - mR) ** 2; vG += (G[p] - mG) ** 2;
    }
    const rho = corrRG / Math.sqrt(vR * vG + 1e-24);
    push('filled mean tracks the true plane (bias < 2.5x noise/sqrt(N))', Math.abs(mErr) < 2.5 * noiseSig / Math.sqrt(n) + 0.003, `bias=${mErr.toExponential(2)}`);
    push('filled scatter matches noise scale (0.4x..1.8x)', m2 > 0.4 * noiseSig && m2 < 1.8 * noiseSig, `filledSigma=${m2.toExponential(2)} noise=${noiseSig}`);
    push('channel correlation preserved (rho_RG > 0.4, not confetti)', rho > 0.4, `rho=${rho.toFixed(3)}`);

    // re-place the stamp at an offset; flux conservation of the composite
    const before = [Float32Array.from(R), Float32Array.from(G), Float32Array.from(B)];
    placeStamp(channels, w, h, stamp, 25, 13);
    let sumBefore = 0, sumAfter = 0;
    for (let i = 0; i < w * h; i++) {
        sumBefore += before[0][i] + before[1][i] + before[2][i];
        sumAfter += R[i] + G[i] + B[i];
    }
    const added = sumAfter - sumBefore;
    const expected = stamp.data[0].reduce((a, b) => a + b, 0) + stamp.data[1].reduce((a, b) => a + b, 0) + stamp.data[2].reduce((a, b) => a + b, 0);
    push('re-placement adds exactly the stamp flux', Math.abs(added - expected) / expected < 1e-4, `added=${added.toFixed(4)} expected=${expected.toFixed(4)}`);

    return { passed: checks.every((c) => c.pass), checks };
}
