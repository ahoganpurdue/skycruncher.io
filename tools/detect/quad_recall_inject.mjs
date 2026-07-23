// ═══════════════════════════════════════════════════════════════════════════
// QUAD-RECALL — pixel-level injection-recovery for the 2x2 box-sum quad channel
// ═══════════════════════════════════════════════════════════════════════════
// Frozen test runner for CSL thesis DRAFT-quad-sum-recall-m4 (registered
// pre-measurement; sha256 in the registry). PIXEL ledger only — this tool never
// touches WCS, never emits flux, authors NO calibrated constant. It builds ONLY
// the small 2x2 box-sum kernel delta the thesis requires (incubator pattern) and
// scores every P-criterion with MEASURED numbers via synthetic injection into the
// REAL decoded detplanes.
//
// MECHANISM UNDER TEST (thesis hypothesis): on undersampled DSLR frames (FWHM
// 1.4-1.6px) a corner-phase star's flux splits across a 2x2 block below the
// single-pixel threshold while total flux equals a detected center star. A 2x2
// box-sum matched channel (||k||=2) recovers it. k_S is EMPIRICALLY NO-OP-pinned
// so the quad channel's blank-sky FP density matches the single-pixel baseline
// BEFORE completeness is measured (Var[S]=4σ² is theoretical motivation only).
//
// INJECTION-RECOVERY DENOMINATOR (P1): recoverable := E[matched-SNR] =
// F·‖ePSF_sampled‖₂/σ ≥ z(1−p̄), p̄=1e-4 ⇒ z≈3.719 (phase-averaged sampled PSF).
// Completeness reported on the recoverable subset (denominator pinned by
// injection, not D19's collapsed N=1 in-frame null).
//
// P7 CFA-CONFOUND ARM (load-bearing): the detplane carries a strong period-2 CFA
// checkerboard AT THE SAME 2px period as the quad channel's phase-covariance
// signal. Two arms are run: OFF = raw detplane; ON = local per-parity-class
// DC-equalized detplane (headless proxy for VITE_CFA_LUMA_PARITY_FIX — see the
// thesis deviations log). A PASS is promotable only if ΔC_corner ≥ +0.05
// PERSISTS in the ON arm; else it caps at DIRECTIONAL-CFA-CONFOUNDED.
//
// Determinism: all randomness from the shared seeded mulberry32 (common.mjs rng)
// via Box-Muller. Same seed ⇒ byte-identical numbers.
//
//   node tools/detect/quad_recall_inject.mjs                 # all 3 frames, both arms
//   node tools/detect/quad_recall_inject.mjs --frame CSM30803 --ninj 2500
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng } from '../solverkit/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DETDIR = path.join(ROOT, 'test_results', 'cr2_dets');

// ── frozen thesis parameters ─────────────────────────────────────────────────
const Z_RECOVERABLE = 3.7190164854556804;   // Φ⁻¹(1 − 1e-4), the recoverable-SNR floor (p̄=1e-4)
// OPERATING POINT (equal-FAR ROC): both channels are pinned to a COMMON selective
// blank-sky false-alarm rate D_TARGET (per px). A raw k_pix=3σ single-pixel-local-
// max gives ~1e-2/px on these structured detplanes (~7× the shipped m4 density),
// so the baseline saturates and the mechanism cannot be surfaced. Pinning both
// channels to the shipped-selectivity FAR is the faithful operationalization of
// the thesis's P6 intent (quad density matches baseline) and the fair ROC point.
// 3e-4/px ≈ the shipped m4 baseline density on the Rokinon frames (~2.5e-4) and
// the sibling mf_test's pinned t*≈4.55σ. LOGGED as a measurement-design deviation.
const D_TARGET = 3.0e-4;                       // common blank-sky FAR both channels pin to (per px)
const R_TOL = 1.5;                            // recovery match tolerance (px)
const SNR_LO = 2, SNR_HI = 20;                // injected E[matched-SNR] range (log-uniform), P1
const CORNER_LO = 0.35, CORNER_HI = 0.65;     // corner-phase bin (both axes), P2
const CENTER_HALF = 0.15;                      // center-phase bin: |phase-0| or |phase-1| ≤ 0.15, P5
const STAMP = 24;                              // injection stamp size (px)
const SC = 12;                                 // injection center within stamp (px)
const DET_MARGIN = 5;                          // detection margin inside a stamp/tile
const TILE = 256;                              // empty-tile size for FP calibration
const EMPTY_TILE_MAXSIG = 6;                   // a tile/stamp is "empty" if its 99.5%ile < med + this·σ
const FP_MIN_PIXELS = 5_000_000;               // min blank px for a stable FP-density pin
const MC_PHASES = 256;                         // phases to average ‖ePSF‖₂

// per-frame FWHM (px): median_fwhm from detplane.json where measured; IMG_1410
// (median 0 / undefined) uses the mf_test_results kernel_fwhm 1.608 it was run at.
const FRAMES = {
    CSM30803: { base: 'CSM30803_5DMkIII_iso6400_15s', fwhm: 1.425, klass: 'undersampled' },
    IMG_1410: { base: 'IMG_1410', fwhm: 1.608, klass: 'undersampled' },
    IMG_1653: { base: 'IMG_1653', fwhm: 2.113, klass: 'well-sampled control' },
};

// ── helpers ──────────────────────────────────────────────────────────────────
function gaussianFrom(rand) { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
// standard-normal CDF via erf (Abramowitz-Stegun 7.1.26)
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function median(arr) { const a = Float64Array.from(arr).sort(); return a.length ? a[a.length >> 1] : NaN; }
function madSigma(arr) { const m = median(arr); const d = []; for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (Number.isFinite(v)) d.push(Math.abs(v - m)); } return median(d) / 0.6745; }
function percentile(arr, p) { const a = Float64Array.from(arr).filter(Number.isFinite).sort(); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN; }

function loadPlane(base) {
    const meta = JSON.parse(fs.readFileSync(path.join(DETDIR, `${base}.detplane.json`), 'utf8'));
    const raw = fs.readFileSync(path.join(DETDIR, meta.rawFile));
    const plane = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    return { plane, W: meta.width, H: meta.height, meta };
}

// ── the injected PSF: normalized pixel fractions of an isotropic Gaussian ─────
// exact per-pixel integral (separable erf), so Σ fractions ≈ 1. Center (cx,cy)
// in stamp coords; returns {frac, x0,y0, w,h, l2} where l2 = ‖fractions‖₂.
function psfFractions(cx, cy, sigma, half) {
    const x0 = Math.floor(cx) - half, y0 = Math.floor(cy) - half;
    const w = 2 * half + 1, h = 2 * half + 1;
    const cdfX = new Float64Array(w + 1), cdfY = new Float64Array(h + 1);
    for (let i = 0; i <= w; i++) cdfX[i] = normCdf(((x0 + i) - cx) / sigma);
    for (let j = 0; j <= h; j++) cdfY[j] = normCdf(((y0 + j) - cy) / sigma);
    const frac = new Float64Array(w * h); let sum = 0;
    for (let j = 0; j < h; j++) { const fy = cdfY[j + 1] - cdfY[j]; for (let i = 0; i < w; i++) { const f = (cdfX[i + 1] - cdfX[i]) * fy; frac[j * w + i] = f; sum += f; } }
    let l2 = 0; for (let t = 0; t < frac.length; t++) { frac[t] /= (sum || 1); l2 += frac[t] * frac[t]; }
    return { frac, x0, y0, w, h, l2: Math.sqrt(l2) };
}

// phase-averaged ‖ePSF‖₂ (matched-filter norm), the recoverable-SNR conversion
function phaseAvgL2(sigma, rand) {
    const half = Math.max(3, Math.ceil(4 * sigma));
    let s = 0; for (let i = 0; i < MC_PHASES; i++) { const cx = SC + rand(), cy = SC + rand(); s += psfFractions(cx, cy, sigma, half).l2; }
    return s / MC_PHASES;
}

// ── CFA-parity-ON proxy: subtract per-parity-class local mean, add block mean ──
// Equalizes the period-2 checkerboard DC using ABSOLUTE (X0+i, Y0+j) parity.
function parityEqualize(sub, w, h, X0, Y0) {
    const sums = [0, 0, 0, 0], cnts = [0, 0, 0, 0]; let tot = 0, tc = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const v = sub[j * w + i]; if (!Number.isFinite(v)) continue; const c = (((Y0 + j) & 1) << 1) | ((X0 + i) & 1); sums[c] += v; cnts[c]++; tot += v; tc++; }
    const gm = tot / (tc || 1); const cm = sums.map((s, k) => (cnts[k] ? s / cnts[k] : gm));
    const out = new Float64Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const v = sub[j * w + i]; const c = (((Y0 + j) & 1) << 1) | ((X0 + i) & 1); out[j * w + i] = Number.isFinite(v) ? v - cm[c] + gm : NaN; }
    return out;
}

// ── the two detectors on a small sub-array (stamp/tile), local-adaptive stats ──
// baseline: single-pixel (v−med)/σ ≥ k, strict 3×3 local max.
// quad: 2×2 box-sum (B−medB)/σB ≥ k, strict local max among the 8 box neighbours.
// Stats (med/σ, medB/σB) are computed on the SUPPLIED sub (the background — for
// injection the caller passes the pre-injection background stats). Returns peak
// lists in sub-array coords (baseline: integer px; quad: box top-left+0.5).
function baselinePeaks(sub, w, h, med, sig, k, margin) {
    const out = [];
    for (let y = margin; y < h - margin; y++) for (let x = margin; x < w - margin; x++) {
        const c = sub[y * w + x]; const snr = (c - med) / sig; if (!(snr >= k)) continue;
        if (c > sub[y * w + x - 1] && c >= sub[y * w + x + 1] && c > sub[(y - 1) * w + x] && c >= sub[(y + 1) * w + x] &&
            c > sub[(y - 1) * w + x - 1] && c > sub[(y - 1) * w + x + 1] && c >= sub[(y + 1) * w + x - 1] && c >= sub[(y + 1) * w + x + 1]) out.push({ x, y, snr });
    }
    return out;
}
function boxSumAt(sub, w, x, y) { return sub[y * w + x] + sub[y * w + x + 1] + sub[(y + 1) * w + x] + sub[(y + 1) * w + x + 1]; }
function quadPeaks(sub, w, h, medB, sigB, k, margin) {
    const out = [];
    for (let y = margin; y < h - margin - 1; y++) for (let x = margin; x < w - margin - 1; x++) {
        const B = boxSumAt(sub, w, x, y); const snr = (B - medB) / sigB; if (!(snr >= k)) continue;
        if (B > boxSumAt(sub, w, x - 1, y) && B >= boxSumAt(sub, w, x + 1, y) && B > boxSumAt(sub, w, x, y - 1) && B >= boxSumAt(sub, w, x, y + 1) &&
            B > boxSumAt(sub, w, x - 1, y - 1) && B > boxSumAt(sub, w, x + 1, y - 1) && B >= boxSumAt(sub, w, x - 1, y + 1) && B >= boxSumAt(sub, w, x + 1, y + 1)) out.push({ x: x + 0.5, y: y + 0.5, snr });
    }
    return out;
}
// box-sum plane stats over the interior of a sub-array
function boxStats(sub, w, h, margin) {
    const vals = [];
    for (let y = margin; y < h - margin - 1; y++) for (let x = margin; x < w - margin - 1; x++) vals.push(boxSumAt(sub, w, x, y));
    return { medB: median(vals), sigB: madSigma(vals) };
}
function subStats(sub, w, h, margin) {
    const vals = [];
    for (let y = margin; y < h - margin; y++) for (let x = margin; x < w - margin; x++) vals.push(sub[y * w + x]);
    return { med: median(vals), sig: madSigma(vals) };
}

// ── empty-tile finder: tiles whose 99.5%ile < med_global + EMPTY_TILE_MAXSIG·σ ──
function findEmptyTiles(plane, W, H, medG, sigG, minPixels) {
    const tiles = []; let px = 0; const thr = medG + EMPTY_TILE_MAXSIG * sigG;
    const inner = (TILE - 2 * DET_MARGIN - 1);
    for (let y0 = 0; y0 + TILE <= H && px < minPixels; y0 += TILE) {
        for (let x0 = 0; x0 + TILE <= W && px < minPixels; x0 += TILE) {
            const s = []; for (let j = 0; j < TILE; j += 2) for (let i = 0; i < TILE; i += 2) s.push(plane[(y0 + j) * W + (x0 + i)]);
            if (percentile(s, 0.995) < thr) { tiles.push({ x0, y0 }); px += inner * inner; }
        }
    }
    return { tiles, px };
}
function extractTile(plane, W, x0, y0, size) { const out = new Float64Array(size * size); for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) out[j * size + i] = plane[(y0 + j) * W + (x0 + i)]; return out; }
// synthetic clean-Gaussian tile (the mechanism's ASSUMED regime: white noise, no
// structure, no CFA) — the positive control that validates the detector and tests
// the derivative prediction (ΔC_corner >> ΔC_all) where it should hold if real.
function syntheticTile(size, med, sig, rand) { const out = new Float64Array(size * size); for (let t = 0; t < out.length; t++) out[t] = med + sig * gaussianFrom(rand); return out; }
// background provider: returns { sub, X0, Y0 } for a given index (real) or seed (clean)
function makeBg(bg, size, idxOrRand) {
    if (bg.mode === 'clean') { return { sub: syntheticTile(size, bg.medG, bg.sigG, idxOrRand), X0: 0, Y0: 0 }; }
    const o = bg.origins[idxOrRand % bg.origins.length];
    let sub = extractTile(bg.plane, bg.W, o.X, o.Y, size);
    if (bg.mode === 'real-ON') sub = parityEqualize(sub, size, size, o.X, o.Y);
    return { sub, X0: o.X, Y0: o.Y };
}

// count union (combined) baseline∪quad peaks, deduped within R_TOL
function combinedCount(bp, qp) {
    let n = bp.length;
    for (const q of qp) { let dup = false; for (const b of bp) { if (Math.hypot(q.x - b.x, q.y - b.y) <= R_TOL) { dup = true; break; } } if (!dup) n++; }
    return n;
}

// ── FP calibration: pin k_pix AND k_S to a COMMON blank-sky FAR = D_TARGET ─────
// (equal-FAR ROC). P6 NO-OP then reads as: with both pinned to the same target,
// the achieved quad/base density ratio ≈ 1 within ±5% (the pin's precision). P4
// FP_ratio = combined(base∪quad) blank density / baseline blank density.
function calibrateAndFP(bg, nTiles, seed) {
    const rand = rng((seed ^ 0x51ed270b) >>> 0);
    let area = 0;
    const tileData = [];
    for (let i = 0; i < nTiles; i++) {
        const { sub } = makeBg(bg, TILE, bg.mode === 'clean' ? rand : i);
        const { med, sig } = subStats(sub, TILE, TILE, DET_MARGIN);
        const { medB, sigB } = boxStats(sub, TILE, TILE, DET_MARGIN);
        const inner = (TILE - 2 * DET_MARGIN - 1); area += inner * inner;
        tileData.push({ sub, med, sig, medB, sigB });
    }
    const baseDensityAt = (k) => { let n = 0; for (const t of tileData) n += baselinePeaks(t.sub, TILE, TILE, t.med, t.sig, k, DET_MARGIN).length; return n / area; };
    const quadDensityAt = (k) => { let n = 0; for (const t of tileData) n += quadPeaks(t.sub, TILE, TILE, t.medB, t.sigB, k, DET_MARGIN).length; return n / area; };
    const pinTo = (densFn) => { let lo = 1.0, hi = 14.0, k = 5.0; for (let it = 0; it < 44; it++) { k = 0.5 * (lo + hi); const d = densFn(k); if (d > D_TARGET) lo = k; else hi = k; if (d > 0 && Math.abs(d - D_TARGET) / D_TARGET < 0.003) break; } return k; };
    const kPix = pinTo(baseDensityAt), kS = pinTo(quadDensityAt);
    const Dbase = baseDensityAt(kPix), Dquad = quadDensityAt(kS);
    let combFP = 0, baseFP = 0;
    for (const t of tileData) { const bp = baselinePeaks(t.sub, TILE, TILE, t.med, t.sig, kPix, DET_MARGIN); const qp = quadPeaks(t.sub, TILE, TILE, t.medB, t.sigB, kS, DET_MARGIN); baseFP += bp.length; combFP += combinedCount(bp, qp); }
    const Dcomb = combFP / area;
    return { kPix, kS, Dbase, Dquad, Dcomb, area, baseFP, D_target: D_TARGET, noop_ratio: Dquad / Dbase, fp_ratio: Dcomb / Dbase, within5: Math.abs(Dquad / Dbase - 1) <= 0.05 };
}

// ── injection-recovery: N_inj clean Gaussian stars into empty stamps ──────────
function injectRecover(bg, fwhm, pbarL2, sigG, kPix, kS, seed, nInj) {
    const rand = rng(seed >>> 0);
    const bgRand = rng((seed ^ 0x2545f491) >>> 0);   // separate stream for clean-bg noise
    const sigma = fwhm / 2.3548200450309493;
    const psfHalf = Math.max(3, Math.ceil(4 * sigma));
    // bins accumulate {recoverable count, recovered_base, recovered_comb}
    const mk = () => ({ nRec: 0, base: 0, comb: 0, nAll: 0, baseAll: 0, combAll: 0 });
    const bins = { corner: mk(), center: mk(), all: mk() };
    // SNR-stratified corner diagnostic (faint tail is where the mechanism lives)
    const snrEdges = [Z_RECOVERABLE, 5, 7, 10, 20];
    const snrStrata = snrEdges.slice(0, -1).map((lo, i) => ({ lo, hi: snrEdges[i + 1], n: 0, base: 0, comb: 0 }));
    for (let n = 0; n < nInj; n++) {
        const fx = rand(), fy = rand();
        const snrTarget = Math.exp(Math.log(SNR_LO) + rand() * (Math.log(SNR_HI) - Math.log(SNR_LO)));
        const F = snrTarget * sigG / pbarL2;   // total flux for this E[matched-SNR]
        const recoverable = snrTarget >= Z_RECOVERABLE;
        // background stamp (real raw / real parity-equalized / clean gaussian)
        const bgTile = makeBg(bg, STAMP, bg.mode === 'clean' ? bgRand : Math.floor(rand() * bg.origins.length));
        const bgSub = bgTile.sub;
        const { med, sig } = subStats(bgSub, STAMP, STAMP, DET_MARGIN);
        const { medB, sigB } = boxStats(bgSub, STAMP, STAMP, DET_MARGIN);
        // inject clean PSF at (SC+fx, SC+fy)
        const stamp = Float64Array.from(bgSub);
        const ps = psfFractions(SC + fx, SC + fy, sigma, psfHalf);
        for (let j = 0; j < ps.h; j++) { const yy = ps.y0 + j; if (yy < 0 || yy >= STAMP) continue; for (let i = 0; i < ps.w; i++) { const xx = ps.x0 + i; if (xx < 0 || xx >= STAMP) continue; stamp[yy * STAMP + xx] += F * ps.frac[j * ps.w + i]; } }
        // detect
        const bp = baselinePeaks(stamp, STAMP, STAMP, med, sig, kPix, DET_MARGIN);
        const qp = quadPeaks(stamp, STAMP, STAMP, medB, sigB, kS, DET_MARGIN);
        const tx = SC + fx, ty = SC + fy;
        const rBase = bp.some((p) => Math.hypot(p.x - tx, p.y - ty) <= R_TOL);
        const rQuad = qp.some((p) => Math.hypot(p.x - tx, p.y - ty) <= R_TOL);
        const rComb = rBase || rQuad;
        const isCorner = fx >= CORNER_LO && fx <= CORNER_HI && fy >= CORNER_LO && fy <= CORNER_HI;
        const isCenter = (Math.min(fx, 1 - fx) <= CENTER_HALF) && (Math.min(fy, 1 - fy) <= CENTER_HALF);
        for (const b of [bins.all, ...(isCorner ? [bins.corner] : []), ...(isCenter ? [bins.center] : [])]) {
            b.nAll++; if (rBase) b.baseAll++; if (rComb) b.combAll++;
            if (recoverable) { b.nRec++; if (rBase) b.base++; if (rComb) b.comb++; }
        }
        if (recoverable && isCorner) { for (const s of snrStrata) if (snrTarget >= s.lo && snrTarget < s.hi) { s.n++; if (rBase) s.base++; if (rComb) s.comb++; } }
    }
    const comp = (b) => ({ n: b.nRec, C_base: b.nRec ? b.base / b.nRec : null, C_comb: b.nRec ? b.comb / b.nRec : null, delta: b.nRec ? (b.comb - b.base) / b.nRec : null });
    return { corner: comp(bins.corner), center: comp(bins.center), all: comp(bins.all), cornerBySnr: snrStrata.map((s) => ({ lo: +s.lo.toFixed(2), hi: s.hi, n: s.n, C_base: s.n ? +(s.base / s.n).toFixed(3) : null, C_comb: s.n ? +(s.comb / s.n).toFixed(3) : null, delta: s.n ? +((s.comb - s.base) / s.n).toFixed(3) : null })) };
}

// ── run one frame: CLEAN control + real OFF + real ON ─────────────────────────
function runFrame(key, nInj) {
    const f = FRAMES[key];
    const { plane, W, H } = loadPlane(f.base);
    // global stats (stride sample)
    const gs = []; for (let i = 0; i < plane.length; i += 37) { const v = plane[i]; if (Number.isFinite(v)) gs.push(v); }
    const medG = median(gs), sigG = madSigma(gs);
    const seed = 20260711 + Object.keys(FRAMES).indexOf(key);
    const pbarL2 = phaseAvgL2(f.fwhm / 2.3548200450309493, rng(seed ^ 0x9e3779b9));
    const { tiles, px } = findEmptyTiles(plane, W, H, medG, sigG, FP_MIN_PIXELS);
    // stamp origins inside the empty tiles (for real arms)
    const origins = [];
    for (const { x0, y0 } of tiles) for (let dy = 0; dy + STAMP <= TILE; dy += STAMP) for (let dx = 0; dx + STAMP <= TILE; dx += STAMP) origins.push({ X: x0 + dx, Y: y0 + dy });
    const nTiles = tiles.length;
    const modes = {
        CLEAN: { mode: 'clean', medG, sigG },
        OFF: { mode: 'real-OFF', plane, W, origins },
        ON: { mode: 'real-ON', plane, W, origins },
    };
    const arms = {};
    for (const [name, bg] of Object.entries(modes)) {
        const armSeed = seed + (name === 'ON' ? 777 : name === 'CLEAN' ? 1313 : 0);
        const cal = calibrateAndFP(bg, nTiles, armSeed);
        const rec = injectRecover(bg, f.fwhm, pbarL2, sigG, cal.kPix, cal.kS, armSeed + 5, nInj);
        arms[name] = { cal, rec };
    }
    return { key, base: f.base, klass: f.klass, W, H, fwhm: f.fwhm, medG, sigG, pbarL2, emptyTiles: nTiles, blankPx: px, stampPool: origins.length, seed, nInj, arms };
}

function fmt(x, d = 4) { return x == null ? 'null' : (+x).toFixed(d); }
function main() {
    const argv = process.argv.slice(2);
    const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
    const nInj = parseInt(arg('--ninj', '2500'), 10);
    const only = arg('--frame', null);
    const keys = only ? [only] : Object.keys(FRAMES);
    const results = [];
    for (const key of keys) {
        process.stderr.write(`[quad_recall] ${key} …\n`);
        const r = runFrame(key, nInj);
        results.push(r);
        for (const arm of ['CLEAN', 'OFF', 'ON']) {
            const { cal, rec } = r.arms[arm];
            console.log(`\n[${key}/${arm}] fwhm=${r.fwhm} σ=${fmt(r.sigG, 5)} pbarL2=${fmt(r.pbarL2, 4)} emptyTiles=${r.emptyTiles} blankPx=${(r.blankPx / 1e6).toFixed(1)}M`);
            console.log(`  operating point: D_target=${cal.D_target.toExponential(1)}/px  k_pix=${fmt(cal.kPix, 3)}σ  k_S=${fmt(cal.kS, 3)}σ  (baseFP=${cal.baseFP})`);
            console.log(`  P6 NO-OP pin: Dbase=${cal.Dbase.toExponential(3)} Dquad=${cal.Dquad.toExponential(3)} Dquad/Dbase=${fmt(cal.noop_ratio, 4)} within5%=${cal.within5}`);
            console.log(`  P4 FP_ratio (combined/base blank density) = ${fmt(cal.fp_ratio, 4)}`);
            console.log(`  recall (recoverable subset SNR≥${fmt(Z_RECOVERABLE, 3)}):`);
            console.log(`    corner n=${rec.corner.n} C_base=${fmt(rec.corner.C_base, 3)} C_comb=${fmt(rec.corner.C_comb, 3)} ΔC_corner=${fmt(rec.corner.delta, 4)}`);
            console.log(`    all    n=${rec.all.n} C_base=${fmt(rec.all.C_base, 3)} C_comb=${fmt(rec.all.C_comb, 3)} ΔC_all=${fmt(rec.all.delta, 4)}`);
            console.log(`    center n=${rec.center.n} C_base=${fmt(rec.center.C_base, 3)} C_comb=${fmt(rec.center.C_comb, 3)} regress(base−comb)=${fmt(-rec.center.delta, 4)}`);
            console.log(`    corner-by-SNR: ${rec.cornerBySnr.map((s) => `[${s.lo},${s.hi})n${s.n}Δ${fmt(s.delta, 3)}`).join('  ')}`);
        }
    }
    const out = { tool: 'tools/detect/quad_recall_inject.mjs', thesis: 'DRAFT-quad-sum-recall-m4', generatedAtUnix: null, deterministic: true, params: { Z_RECOVERABLE, D_TARGET, R_TOL, SNR_LO, SNR_HI, CORNER: [CORNER_LO, CORNER_HI], CENTER_HALF, STAMP, TILE, FP_MIN_PIXELS, MC_PHASES, nInj }, frames: results.map((r) => ({ key: r.key, base: r.base, klass: r.klass, fwhm: r.fwhm, W: r.W, H: r.H, sigG: r.sigG, pbarL2: r.pbarL2, emptyTiles: r.emptyTiles, blankPx: r.blankPx, stampPool: r.stampPool, seed: r.seed, arms: r.arms })) };
    const outDir = path.join(ROOT, 'test_results', 'theses', 'quad_recall');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'quad_recall_measurement.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`\n[artifact] ${outPath}`);
}
main();
