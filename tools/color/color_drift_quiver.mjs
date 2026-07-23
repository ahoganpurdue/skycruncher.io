#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// color_drift_quiver.mjs — per-star COLOR-DRIFT quiver diagnostic
// ═══════════════════════════════════════════════════════════════════════════
// Owner-requested (2026-07-12): the step-6-lens-quiver's colour cousin. Per
// matched star, show the DRIFT between the star's MEASURED instrumental colour
// and the colour its CATALOG BP-RP predicts, placed on the frame as a vertical
// arrow — a diagnostic for colour-space / black-level problems.
//
// DRIFT CONSTRUCTION (stated honestly in every plot subtitle):
//   instColor      = −2.5·log10(flux_b / flux_r)        (SPCC lane convention)
//   instColor_pred = a·catBpRp + b                       (robust σ-clip OLS,
//                    the SAME fitColorRegression machinery SPCC uses, fit with
//                    x=catBpRp y=instColor so it PREDICTS instrumental colour
//                    from catalog colour)
//   drift (Δcolor) = instColor − instColor_pred          (the fit RESIDUAL)
//   sign: drift>0 ⇒ measured REDDER than predicted (arrow UP); <0 ⇒ BLUER (DOWN)
// Raw measured−catalog is NOT unit-comparable (different photometric systems);
// the residual from the per-arm linear fit IS. Everything rides the
// CR2_DEMOSAIC_APPROX lane (demosaiced Bayer, no filter-curve ref) → APPROXIMATE.
//
// ─── INPUT CONTRACT (generalises beyond the bundled CR2) ──────────────────────
//   default (no --stars/--receipt): spawns tools/color/color_drift_extract
//     for BOTH decoder arms serially (rawler_default, libraw_cold) on the
//     bundled CR2, banks per-star JSON, then renders. HEAVY (~3 min/arm).
//   --stars <rawler.json> [libraw.json] : render from pre-extracted per-star
//     JSON (schema color_drift_extract.v1) — cheap, for iterating on the plot.
//   --file <raw> : override the RAW frame the default extraction runs on.
//   --receipt <path> : FUTURE — a solved-frame receipt carrying per-star SPCC
//     records. Contract: the receipt must expose an array of matched stars each
//     with {detected:{x,y}, flux_r, flux_g, flux_b, catalog:{bv}} OR a
//     pre-computed spcc.stars[] block with the same fields + native (x,y). When
//     that lands (engine SPCC retains fullRGB on non-FITS, orchestrator task),
//     wire it here: read stars, skip extraction, single-panel render. Emits an
//     honest ABSENT today (no such block on the CR2 receipt — receipt.spcc=null).
//
// OUTPUT: test_results/color_drift_quiver_<ts>/
//   DSCF_CR2_color_drift_rawler.png / _libraw.png / _sidebyside.png
//   color_drift_residuals.json  (per-arm fit + per-star drift)
//
// UI-WIDGET PORT (future, separate task): the render primitives already live in
// the widget registry family (WebGL renderlab/quiver.mjs is the GPU twin). A
// browser widget would consume color_drift_residuals.json through the widget
// registry seam (src/ui widgets) — NOT this lane's job (tools/ + test_results/
// writes only). This lane is the incubator (LAW 4).
//
// EVIDENCE-ONLY: reports what was MEASURED; null/absent = honest absence.
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    makeCanvas, blend, fillRect, drawText, textWidth, drawRing, encodePng,
    TEXT, DIM, SHADOW, INFO, PASS, WARN, FAIL,
} from '../validation/visual/bubble_tiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const HEAD = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? '?';
const log = (...a) => console.log('[color-drift]', ...a);

const TS = new Date().toISOString().replace(/[:.]/g, '-');
const OUTDIR = argVal('--out');            // reuse an existing dir (else fresh timestamped)
const SUFFIX = argVal('--suffix') ?? '';   // appended to output basenames (e.g. _v2)
const WORK = OUTDIR ? path.resolve(OUTDIR) : path.join(ROOT, 'test_results', `color_drift_quiver_${TS}`);

// ─── palette (RENDER layer; not tied to value polarity) ───────────────────────
const BG = [12, 14, 22];
const PANEL = [19, 22, 32];
const GRID = [46, 52, 66];
const REDDER = [242, 120, 92];   // measured redder than predicted (arrow UP)
const BLUER = [96, 158, 242];    // measured bluer than predicted (arrow DOWN)
const AXIS = [120, 130, 148];

// ─── math: ported EXACTLY from src/.../spcc_calibrator.ts fitColorRegression ──
// (REUSE, not reinvent — the drift basis must match the SPCC fit machinery).
function fitColorRegression(samples, opts = {}) {
    const sigmaClip = opts.sigmaClip ?? 2.5;
    const maxIter = opts.maxIter ?? 3;
    const minStars = opts.minStars ?? 8;
    let active = samples.slice();
    let slope = 1, intercept = 0;
    for (let iter = 0; iter < maxIter; iter++) {
        if (active.length < minStars) return { valid: false, slope: 1, intercept: 0, r2: 0, rmse: 0, n_used: active.length };
        const n = active.length;
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const s of active) { sx += s.x; sy += s.y; sxx += s.x * s.x; sxy += s.x * s.y; }
        const denom = n * sxx - sx * sx;
        if (Math.abs(denom) < 1e-12) return { valid: false, slope: 1, intercept: 0, r2: 0, rmse: 0, n_used: n };
        slope = (n * sxy - sx * sy) / denom;
        intercept = (sy - slope * sx) / n;
        const residuals = active.map(s => s.y - (slope * s.x + intercept));
        const sigma = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / n);
        if (sigma <= 1e-12) break;
        const kept = active.filter((_, i) => Math.abs(residuals[i]) <= sigmaClip * sigma);
        if (kept.length === active.length) break;
        active = kept;
    }
    if (active.length < minStars) return { valid: false, slope: 1, intercept: 0, r2: 0, rmse: 0, n_used: active.length };
    const n = active.length;
    const meanY = active.reduce((a, s) => a + s.y, 0) / n;
    let ssRes = 0, ssTot = 0;
    for (const s of active) { const r = s.y - (slope * s.x + intercept); ssRes += r * r; ssTot += (s.y - meanY) ** 2; }
    const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : 0;
    const rmse = Math.sqrt(ssRes / n);
    return { valid: true, slope, intercept, r2, rmse, n_used: n };
}

function quantile(sorted, q) {
    if (sorted.length === 0) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function niceNum(x) {
    const nice = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];
    for (const v of nice) if (v >= x) return v;
    return Math.ceil(x);
}
const fmt = (v, d = 3) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : 'NULL');

// ─── analysis: one arm's per-star extract → fit + per-star drift ──────────────
function analyzeArm(ex) {
    const stars = (ex.stars ?? []).map(s => ({ ...s }));
    // usable = has instColor AND catalog colour (the SPCC colorSample criterion)
    const usable = stars.filter(s => Number.isFinite(s.instColor) && Number.isFinite(s.catBpRp));

    // SPCC-convention fit (banked r² annotation): catBpRp = slope·instColor + b
    const fitSPCC = fitColorRegression(usable.map(s => ({ x: s.instColor, y: s.catBpRp })));
    // Drift-basis fit: instColor = a·catBpRp + b  (predict instrumental FROM catalog)
    const fitPred = fitColorRegression(usable.map(s => ({ x: s.catBpRp, y: s.instColor })));

    const cx = ex.optical_center?.x ?? ex.width / 2;
    const cy = ex.optical_center?.y ?? ex.height / 2;
    const rCorner = Math.hypot(ex.width / 2, ex.height / 2);

    const drifts = usable.map(s => {
        const pred = fitPred.valid ? fitPred.slope * s.catBpRp + fitPred.intercept : NaN;
        const drift = s.instColor - pred;
        const r_px = Math.hypot(s.x - cx, s.y - cy);
        return { ...s, pred, drift, r_px, r_norm: r_px / rCorner };
    }).filter(d => Number.isFinite(d.drift));

    // drift stats over all usable (mean ± σ)
    const dv = drifts.map(d => d.drift);
    const mean = dv.reduce((a, b) => a + b, 0) / (dv.length || 1);
    const sd = Math.sqrt(dv.reduce((a, b) => a + (b - mean) ** 2, 0) / (dv.length || 1));

    // radial trend: OLS drift = m·r_norm + c, slope + standard error
    let radSlope = null, radSlopeSE = null, radIntercept = null;
    if (drifts.length >= 3) {
        const n = drifts.length;
        const mr = drifts.reduce((a, d) => a + d.r_norm, 0) / n;
        const md = drifts.reduce((a, d) => a + d.drift, 0) / n;
        let sxx = 0, sxy = 0;
        for (const d of drifts) { sxx += (d.r_norm - mr) ** 2; sxy += (d.r_norm - mr) * (d.drift - md); }
        if (sxx > 1e-12) {
            radSlope = sxy / sxx;
            radIntercept = md - radSlope * mr;
            let ssRes = 0;
            for (const d of drifts) { const r = d.drift - (radSlope * d.r_norm + radIntercept); ssRes += r * r; }
            const s2 = n > 2 ? ssRes / (n - 2) : 0;
            radSlopeSE = Math.sqrt(s2 / sxx);
        }
    }

    // ── DRIFT vs STAR BRIGHTNESS (the hypothesis discriminant) ────────────────
    // Instrumental magnitude = −2.5·log10(sum flux RGB), arbitrary zeropoint;
    // fainter star ⇒ LARGER magnitude. Two hypotheses for the rawler colour
    // chaos predict DIFFERENT shapes here:
    //   unsubtracted black-level pedestal ⇒ |drift| GROWS toward the FAINT end
    //     (flux ratios dragged toward the pedestal ratio as signal → pedestal);
    //   channel-sampling / CFA-phase bug ⇒ chaos at ALL brightnesses equally.
    for (const d of drifts) {
        const sumF = (Number.isFinite(d.flux_r) ? d.flux_r : 0) + (Number.isFinite(d.flux_g) ? d.flux_g : 0) + (Number.isFinite(d.flux_b) ? d.flux_b : 0);
        d.mInst = sumF > 0 ? -2.5 * Math.log10(sumF) : null;
    }
    const bright = drifts.filter(d => Number.isFinite(d.mInst));
    // signed drift-vs-magnitude OLS (slope ± SE)
    let brSlope = null, brSlopeSE = null, brIntercept = null;
    if (bright.length >= 3) {
        const n = bright.length;
        const mx = bright.reduce((a, d) => a + d.mInst, 0) / n;
        const my = bright.reduce((a, d) => a + d.drift, 0) / n;
        let sxx = 0, sxy = 0;
        for (const d of bright) { sxx += (d.mInst - mx) ** 2; sxy += (d.mInst - mx) * (d.drift - my); }
        if (sxx > 1e-12) {
            brSlope = sxy / sxx; brIntercept = my - brSlope * mx;
            let ssRes = 0; for (const d of bright) { const r = d.drift - (brSlope * d.mInst + brIntercept); ssRes += r * r; }
            brSlopeSE = Math.sqrt((n > 2 ? ssRes / (n - 2) : 0) / sxx);
        }
    }
    // equal-count magnitude bins → |drift| DISPERSION vs brightness (bright→faint)
    const sortedB = bright.slice().sort((a, b) => a.mInst - b.mInst);
    const nbin = Math.min(5, Math.max(2, Math.floor(sortedB.length / 6)));
    const bright_bins = [];
    for (let k = 0; sortedB.length >= 4 && k < nbin; k++) {
        const lo = Math.floor(k * sortedB.length / nbin), hi = Math.floor((k + 1) * sortedB.length / nbin);
        const seg = sortedB.slice(lo, hi);
        if (seg.length === 0) continue;
        const mmid = seg.reduce((a, d) => a + d.mInst, 0) / seg.length;
        const dm = seg.reduce((a, d) => a + d.drift, 0) / seg.length;
        const dsd = Math.sqrt(seg.reduce((a, d) => a + (d.drift - dm) ** 2, 0) / seg.length);
        bright_bins.push({ mag_mid: mmid, mean_drift: dm, sd_drift: dsd, n: seg.length });
    }
    const sdBright = bright_bins.length ? bright_bins[0].sd_drift : null;               // brightest bin
    const sdFaint = bright_bins.length ? bright_bins[bright_bins.length - 1].sd_drift : null; // faintest bin
    const dispRatio = (sdBright && sdBright > 1e-9) ? sdFaint / sdBright : null;
    // heuristic signature verdict (NOT a gate — a read for the black-level surgeon)
    let signature = 'NOT MEASURED';
    if (dispRatio !== null && brSlopeSE !== null) {
        const slopeSig = Math.abs(brSlope) > 2 * brSlopeSE;
        if (dispRatio >= 1.8 || (slopeSig && dispRatio >= 1.4)) signature = 'FAINT-END GROWTH (PEDESTAL-LIKE)';
        else if (dispRatio <= 1.35 && !slopeSig) signature = 'FLAT VS BRIGHTNESS (CFA/PHASE-LIKE)';
        else signature = 'AMBIGUOUS';
    }

    return {
        arm: ex.arm, source_tag: ex.source_tag, width: ex.width, height: ex.height,
        optical_center: { x: cx, y: cy }, opt_center_note: ex.optical_center?.note ?? null,
        matched_count: ex.matched_count, matched_with_catcolor: ex.matched_with_catcolor,
        n_usable: usable.length, n_drift: drifts.length,
        solve: ex.solve,
        fit_spcc: fitSPCC,       // banked-convention r² (catBpRp = f(instColor))
        fit_pred: fitPred,       // drift basis (instColor = f(catBpRp))
        drift_mean: mean, drift_sd: sd,
        radial_slope: radSlope, radial_slope_se: radSlopeSE, radial_intercept: radIntercept,
        n_bright: bright.length,
        brightness_slope: brSlope, brightness_slope_se: brSlopeSE, brightness_intercept: brIntercept,
        bright_bins, sd_bright: sdBright, sd_faint: sdFaint, disp_ratio: dispRatio, signature,
        drifts,
    };
}

// ─── drawing helpers on the bubble_tiles canvas ───────────────────────────────
function line(c, x0, y0, x1, y1, col, a = 1) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
        blend(c, x0, y0, col[0], col[1], col[2], a);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
    }
}
function panelBox(c, x, y, w, h) {
    fillRect(c, x, y, w, h, PANEL[0], PANEL[1], PANEL[2], 255);
    // hairline border
    line(c, x, y, x + w, y, GRID, 1); line(c, x, y + h, x + w, y + h, GRID, 1);
    line(c, x, y, x, y + h, GRID, 1); line(c, x + w, y, x + w, y + h, GRID, 1);
}
function filledDot(c, x, y, r, col, a = 1) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) blend(c, x + dx, y + dy, col[0], col[1], col[2], a);
}
// vertical arrow: from (x,y0) to (x,y1); arrowhead at (x,y1)
function vArrow(c, x, y0, y1, col, a = 1) {
    line(c, x, y0, x, y1, col, a);
    const up = y1 < y0;
    const hy = up ? y1 + 4 : y1 - 4;
    line(c, x, y1, x - 3, hy, col, a);
    line(c, x, y1, x + 3, hy, col, a);
}

// ─── one arm → one figure canvas ──────────────────────────────────────────────
// `scales` = shared axis scales so both arms render identically (task #3).
function renderArm(A, scales) {
    const W = 1280, H = 1230;
    const c = makeCanvas(W, H);
    fillRect(c, 0, 0, W, H, BG[0], BG[1], BG[2], 255);

    // ── header ──
    drawText(c, `COLOR DRIFT  ${A.arm}`, 32, 22, 3, TEXT, 1);
    drawText(c, `${A.source_tag}  (APPROXIMATE)`, 32, 52, 2, WARN, 1);
    // right-aligned n + r²
    const hdrR = `N=${A.n_drift}  SPCC-FIT-R2=${fmt(A.fit_spcc.r2, 4)}`;
    drawText(c, hdrR, W - 32 - textWidth(hdrR, 2), 30, 2, INFO, 1);
    const hdrR2 = `SOLVE RA=${fmt(A.solve?.ra_hours, 3)}H  SCALE=${fmt(A.solve?.pixel_scale, 2)}"/PX  MATCHED=${A.solve?.stars_matched ?? '?'}`;
    drawText(c, hdrR2, W - 32 - textWidth(hdrR2, 1) * 2, 58, 1, DIM, 1);

    // subtitle: the construction, stated honestly
    drawText(c, `DRIFT = MEASURED INSTCOLOR (-2.5LOG10 FLUXB/FLUXR) - PREDICTED FROM CATALOG BP-RP (A*BPRP+B, SIGMA-CLIP OLS)`, 32, 84, 1, DIM, 1);

    // ── main quiver panel (frame-shaped) ──
    const qx = 40, qy = 110, qw = 720;
    const qh = Math.round(qw * (A.height / A.width));   // preserve frame aspect
    panelBox(c, qx, qy, qw, qh);
    drawText(c, `FRAME ${A.width}X${A.height}PX  ARROW UP=REDDER  DOWN=BLUER`, qx + 6, qy + 6, 1, DIM, 1);

    // optical-center cross (APPROXIMATE)
    const ocx = qx + (A.optical_center.x / A.width) * qw;
    const ocy = qy + (A.optical_center.y / A.height) * qh;
    line(c, ocx - 6, ocy, ocx + 6, ocy, AXIS, 0.7); line(c, ocx, ocy - 6, ocx, ocy + 6, AXIS, 0.7);

    const maxLen = qh * 0.16;
    for (const d of A.drifts) {
        const px = qx + (d.x / A.width) * qw;
        const py = qy + (d.y / A.height) * qh;
        const rawLen = Math.abs(d.drift) * scales.lenPerMag;
        const len = Math.min(rawLen, maxLen);
        const clamped = rawLen > maxLen;
        const col = d.drift >= 0 ? REDDER : BLUER;
        const y1 = d.drift >= 0 ? py - len : py + len;   // redder ⇒ up (screen -y)
        vArrow(c, px, py, y1, col, clamped ? 1 : 0.9);
        filledDot(c, Math.round(px), Math.round(py), 1, TEXT, 0.85);
    }

    // reference arrow legend (below panel)
    const lgy = qy + qh + 26;
    const refLen = scales.refMag * scales.lenPerMag;
    drawText(c, `REFERENCE:`, qx, lgy - 6, 1, DIM, 1);
    vArrow(c, qx + 74, lgy + 8, lgy + 8 - refLen, REDDER, 1);
    drawText(c, `${fmt(scales.refMag, 2)} MAG`, qx + 84, lgy, 1, TEXT, 1);
    drawText(c, `(ARROWS CLAMPED AT ${fmt(scales.driftCap, 2)} MAG)`, qx, lgy + 26, 1, DIM, 1);

    // ── companion panel A: drift vs radial distance ──
    const rx = 800, ry = 110, rw = 440, rh = 340;
    panelBox(c, rx, ry, rw, rh);
    drawText(c, `DRIFT VS RADIAL DIST (CHROMATIC-VIGNETTE)`, rx + 6, ry + 6, 1, DIM, 1);
    const rpx0 = rx + 44, rpy0 = ry + 28, rpw = rw - 60, rph = rh - 60;
    // axes: x = r_norm 0..1, y = drift -cap..+cap
    const X = (rn) => rpx0 + rn * rpw;
    const Yr = (dr) => rpy0 + (1 - (dr + scales.driftCap) / (2 * scales.driftCap)) * rph;
    line(c, rpx0, Yr(0), rpx0 + rpw, Yr(0), AXIS, 0.6);   // zero line
    line(c, rpx0, rpy0, rpx0, rpy0 + rph, AXIS, 0.6);     // y axis
    line(c, rpx0, rpy0 + rph, rpx0 + rpw, rpy0 + rph, AXIS, 0.6); // x axis
    drawText(c, `+${fmt(scales.driftCap, 2)}`, rx + 4, rpy0 - 3, 1, DIM, 1);
    drawText(c, `-${fmt(scales.driftCap, 2)}`, rx + 4, rpy0 + rph - 6, 1, DIM, 1);
    drawText(c, `0`, X(0) - 3, rpy0 + rph + 6, 1, DIM, 1);
    drawText(c, `CORNER`, X(1) - 34, rpy0 + rph + 6, 1, DIM, 1);
    for (const d of A.drifts) {
        const yy = Yr(Math.max(-scales.driftCap, Math.min(scales.driftCap, d.drift)));
        filledDot(c, Math.round(X(d.r_norm)), Math.round(yy), 2, d.drift >= 0 ? REDDER : BLUER, 0.8);
    }
    if (A.radial_slope !== null) {
        const y0 = A.radial_intercept, y1 = A.radial_slope * 1 + A.radial_intercept;
        line(c, X(0), Yr(Math.max(-scales.driftCap, Math.min(scales.driftCap, y0))),
               X(1), Yr(Math.max(-scales.driftCap, Math.min(scales.driftCap, y1))), WARN, 0.9);
        drawText(c, `SLOPE=${fmt(A.radial_slope, 3)} +-${fmt(A.radial_slope_se, 3)} MAG/RAD`, rpx0 + 4, rpy0 + rph - 14, 1, WARN, 1);
    } else {
        drawText(c, `SLOPE: NOT MEASURED (N<3)`, rpx0 + 4, rpy0 + rph - 14, 1, DIM, 1);
    }

    // ── companion panel B: drift histogram ──
    const hx = 800, hy = 480, hw = 440, hh = 340;
    panelBox(c, hx, hy, hw, hh);
    drawText(c, `DRIFT HISTOGRAM`, hx + 6, hy + 6, 1, DIM, 1);
    const hpx0 = hx + 30, hpy0 = hy + 28, hpw = hw - 46, hph = hh - 64;
    const nb = scales.histBins.length - 1;
    const counts = new Array(nb).fill(0);
    let under = 0, over = 0;
    for (const d of A.drifts) {
        if (d.drift < scales.histBins[0]) { under++; continue; }
        if (d.drift >= scales.histBins[nb]) { over++; continue; }
        let b = Math.floor((d.drift - scales.histBins[0]) / (scales.histBins[nb] - scales.histBins[0]) * nb);
        if (b < 0) b = 0; if (b >= nb) b = nb - 1;
        counts[b]++;
    }
    const cmax = Math.max(1, scales.histCountMax);
    const bw = hpw / nb;
    // zero line
    const zx = hpx0 + (0 - scales.histBins[0]) / (scales.histBins[nb] - scales.histBins[0]) * hpw;
    line(c, zx, hpy0, zx, hpy0 + hph, AXIS, 0.5);
    for (let b = 0; b < nb; b++) {
        const bh = (counts[b] / cmax) * hph;
        const bx = hpx0 + b * bw;
        const mid = (scales.histBins[b] + scales.histBins[b + 1]) / 2;
        const col = mid >= 0 ? REDDER : BLUER;
        fillRect(c, Math.round(bx), Math.round(hpy0 + hph - bh), Math.max(1, Math.round(bw) - 1), Math.round(bh), col[0], col[1], col[2], 200);
    }
    line(c, hpx0, hpy0 + hph, hpx0 + hpw, hpy0 + hph, AXIS, 0.6);
    drawText(c, `${fmt(scales.histBins[0], 2)}`, hpx0 - 6, hpy0 + hph + 6, 1, DIM, 1);
    drawText(c, `${fmt(scales.histBins[nb], 2)} MAG`, hpx0 + hpw - 40, hpy0 + hph + 6, 1, DIM, 1);
    // mean ± σ marker
    const mx = hpx0 + (A.drift_mean - scales.histBins[0]) / (scales.histBins[nb] - scales.histBins[0]) * hpw;
    line(c, mx, hpy0, mx, hpy0 + hph, PASS, 0.9);
    drawText(c, `MEAN=${fmt(A.drift_mean, 3)} +-${fmt(A.drift_sd, 3)} SD MAG`, hpx0 + 4, hpy0 + 4, 1, PASS, 1);
    if (under || over) drawText(c, `OFF-SCALE: ${under}< ${over}>`, hpx0 + 4, hpy0 + 18, 1, DIM, 1);

    // ── companion panel C (DECISION PANEL): drift vs star brightness ──
    const gx = 40, gy = 850, gw = 1200, gh = 290;
    panelBox(c, gx, gy, gw, gh);
    drawText(c, `DRIFT VS STAR BRIGHTNESS  ·  X = INSTRUMENTAL MAG (-2.5LOG10 SUM FLUX RGB, ARB ZEROPOINT)  ·  BRIGHT <-- --> FAINT`, gx + 6, gy + 6, 1, DIM, 1);
    const bpx0 = gx + 56, bpy0 = gy + 30, bpw = gw - 84, bph = gh - 74;
    const magSpan = (scales.magMax - scales.magMin) || 1;
    const Xb = (m) => bpx0 + (m - scales.magMin) / magSpan * bpw;
    const Yb = (dr) => bpy0 + (1 - (dr + scales.driftCap) / (2 * scales.driftCap)) * bph;
    // axes + zero line
    line(c, bpx0, Yb(0), bpx0 + bpw, Yb(0), AXIS, 0.6);
    line(c, bpx0, bpy0, bpx0, bpy0 + bph, AXIS, 0.6);
    line(c, bpx0, bpy0 + bph, bpx0 + bpw, bpy0 + bph, AXIS, 0.6);
    drawText(c, `+${fmt(scales.driftCap, 2)}`, gx + 6, bpy0 - 3, 1, DIM, 1);
    drawText(c, `-${fmt(scales.driftCap, 2)}`, gx + 6, bpy0 + bph - 6, 1, DIM, 1);
    drawText(c, `BRIGHT (${fmt(scales.magMin, 1)})`, bpx0, bpy0 + bph + 6, 1, DIM, 1);
    const flabel = `FAINT (${fmt(scales.magMax, 1)}) MAG`;
    drawText(c, flabel, bpx0 + bpw - textWidth(flabel, 1), bpy0 + bph + 6, 1, DIM, 1);
    // scatter
    for (const d of A.drifts) {
        if (!Number.isFinite(d.mInst)) continue;
        const yy = Yb(Math.max(-scales.driftCap, Math.min(scales.driftCap, d.drift)));
        filledDot(c, Math.round(Xb(d.mInst)), Math.round(yy), 2, d.drift >= 0 ? REDDER : BLUER, 0.75);
    }
    // signed fit line
    if (A.brightness_slope !== null) {
        const y0 = A.brightness_slope * scales.magMin + A.brightness_intercept;
        const y1 = A.brightness_slope * scales.magMax + A.brightness_intercept;
        line(c, Xb(scales.magMin), Yb(Math.max(-scales.driftCap, Math.min(scales.driftCap, y0))),
               Xb(scales.magMax), Yb(Math.max(-scales.driftCap, Math.min(scales.driftCap, y1))), WARN, 0.9);
    }
    // per-bin |drift| dispersion as ±SD error bars (the discriminant, drawn white)
    for (const b of (A.bright_bins ?? [])) {
        const x = Xb(b.mag_mid);
        const yc = Yb(Math.max(-scales.driftCap, Math.min(scales.driftCap, b.mean_drift)));
        const yHi = Yb(Math.max(-scales.driftCap, Math.min(scales.driftCap, b.mean_drift + b.sd_drift)));
        const yLo = Yb(Math.max(-scales.driftCap, Math.min(scales.driftCap, b.mean_drift - b.sd_drift)));
        line(c, x, yHi, x, yLo, TEXT, 0.95);
        line(c, x - 4, yHi, x + 4, yHi, TEXT, 0.95);
        line(c, x - 4, yLo, x + 4, yLo, TEXT, 0.95);
        filledDot(c, Math.round(x), Math.round(yc), 2, TEXT, 1);
        drawText(c, `SD${fmt(b.sd_drift, 2)}`, x - 16, yLo + 6, 1, DIM, 1);
    }
    // annotations
    const bslope = A.brightness_slope !== null ? `${fmt(A.brightness_slope, 3)} +-${fmt(A.brightness_slope_se, 3)}` : 'NOT MEASURED';
    drawText(c, `DRIFT-VS-MAG SLOPE = ${bslope} MAG/MAG   ·   ABS-DRIFT SD: BRIGHT=${fmt(A.sd_bright, 3)} FAINT=${fmt(A.sd_faint, 3)} (RATIO=${fmt(A.disp_ratio, 2)})`, bpx0 + 4, bpy0 + 4, 1, INFO, 1);
    const sigCol = A.signature.startsWith('FAINT') ? WARN : (A.signature.startsWith('FLAT') ? PASS : DIM);
    drawText(c, `SIGNATURE (HEURISTIC): ${A.signature}`, bpx0 + 4, bpy0 + 18, 1, sigCol, 1);

    // ── footer: honest-or-absent counts ──
    const fy = 1170;
    line(c, 32, fy - 8, W - 32, fy - 8, GRID, 0.8);
    const catMiss = A.matched_count - A.matched_with_catcolor;
    drawText(c, `${A.matched_with_catcolor} OF ${A.matched_count} MATCHED STARS HAVE CATALOG BP-RP  (${catMiss} OMITTED, NO COLOR)  ·  ${A.n_drift} DREW ARROWS (USABLE PHOTOMETRY)`, 32, fy, 1, DIM, 1);
    drawText(c, `SPCC FIT (CATBPRP=SLOPE*INSTCOLOR+B): SLOPE=${fmt(A.fit_spcc.slope, 4)} R2=${fmt(A.fit_spcc.r2, 4)} N=${A.fit_spcc.n_used}   ·   PRED FIT (INSTCOLOR=A*BPRP+B): A=${fmt(A.fit_pred.slope, 4)} R2=${fmt(A.fit_pred.r2, 4)}`, 32, fy + 16, 1, DIM, 1);
    drawText(c, `CR2_DEMOSAIC_APPROX · OPTICAL CENTER = FRAME CENTER (APPROX) · GENERATED BY TOOLS/COLOR/COLOR_DRIFT_QUIVER.MJS AT ${HEAD}`, 32, fy + 32, 1, DIM, 1);

    return c;
}

function blit(dst, src, ox, oy) {
    for (let y = 0; y < src.h; y++) {
        for (let x = 0; x < src.w; x++) {
            const si = (y * src.w + x) * 4, di = ((oy + y) * dst.w + (ox + x)) * 4;
            dst.px[di] = src.px[si]; dst.px[di + 1] = src.px[si + 1]; dst.px[di + 2] = src.px[si + 2]; dst.px[di + 3] = 255;
        }
    }
}

// ─── extraction driver (spawn the vitest labspec, one arm at a time) ──────────
function extractArm(arm, file, outJson) {
    const env = { ...process.env, DRIFT_CR2_FILE: file, DRIFT_CR2_OUT: outJson };
    delete env.VITE_DECODER_RAWLER;
    if (arm === 'libraw_cold') env.VITE_DECODER_RAWLER = '0';
    log(`extract '${arm}' — spawning solve + per-star photometry (serial, one heavy lane at a time)…`);
    const t0 = Date.now();
    const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const r = spawnSync(process.execPath,
        [VITEST_BIN, 'run', '-c', 'tools/color/color_drift_extract.config.ts'],
        { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(path.join(WORK, `extract_${arm}.vitest.log`), (r.stdout ?? '') + '\n--- stderr ---\n' + (r.stderr ?? ''));
    log(`extract '${arm}' done in ${((Date.now() - t0) / 1000).toFixed(1)}s (exit ${r.status})`);
    if (!fs.existsSync(outJson)) {
        const tail = ((r.stdout ?? '') + (r.stderr ?? '')).slice(-2000);
        throw new Error(`extract '${arm}' produced no record:\n${tail}`);
    }
    return JSON.parse(fs.readFileSync(outJson, 'utf8'));
}

// ─── main ─────────────────────────────────────────────────────────────────────
function main() {
    fs.mkdirSync(WORK, { recursive: true });
    const receipt = argVal('--receipt');
    if (receipt) {
        // FUTURE contract — CR2 receipts carry receipt.spcc=null today.
        const rec = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        const spcc = rec?.spcc ?? rec?.solution?.spcc ?? null;
        if (!spcc || !Array.isArray(spcc.stars)) {
            console.error(`[color-drift] ABSENT: receipt ${receipt} carries no per-star SPCC block (spcc=${JSON.stringify(rec?.spcc)}). CR2 receipts are spcc=null (FITS-only gate). Use the default extraction path or --stars.`);
            process.exit(2);
        }
        // (wire-up point when the block exists; shape documented in the header)
        console.error('[color-drift] receipt path is a documented FUTURE contract; no per-star SPCC block present yet.');
        process.exit(2);
    }

    let exRawler, exLibraw;
    const starsArg = argVal('--stars');
    if (starsArg) {
        exRawler = JSON.parse(fs.readFileSync(starsArg, 'utf8'));
        const second = args[args.indexOf('--stars') + 2];
        if (second && !second.startsWith('--')) exLibraw = JSON.parse(fs.readFileSync(second, 'utf8'));
        log(`rendering from pre-extracted stars: ${path.basename(starsArg)}${exLibraw ? ' + ' + path.basename(second) : ''}`);
    } else {
        const file = path.resolve(argVal('--file') ?? path.join(ROOT, 'public', 'demo', 'sample_observation.cr2'));
        if (!fs.existsSync(file)) { console.error(`[color-drift] input frame ABSENT: ${file}`); process.exit(1); }
        exRawler = extractArm('rawler_default', file, path.join(WORK, 'stars_rawler_default.json'));
        try { exLibraw = extractArm('libraw_cold', file, path.join(WORK, 'stars_libraw_cold.json')); }
        catch (e) { log('WARN cold arm:', String(e.message).slice(0, 300)); exLibraw = null; }
    }

    const arms = [analyzeArm(exRawler)];
    if (exLibraw) arms.push(analyzeArm(exLibraw));

    // ── shared scales across arms (task #3: same axes/scales) ──
    const allAbsDrift = arms.flatMap(a => a.drifts.map(d => Math.abs(d.drift))).sort((x, y) => x - y);
    const allDrift = arms.flatMap(a => a.drifts.map(d => d.drift)).sort((x, y) => x - y);
    const driftCap = niceNum(quantile(allAbsDrift, 0.97) || 0.1);
    const refMag = niceNum(driftCap * 0.5);
    const lenPerMag = (0.16 * Math.round(720 * (arms[0].height / arms[0].width))) / driftCap;
    // histogram bins shared
    const nb = 25;
    const histBins = Array.from({ length: nb + 1 }, (_, i) => -driftCap + (2 * driftCap) * i / nb);
    // shared count-max: compute per-arm max bin count
    let histCountMax = 1;
    for (const a of arms) {
        const cnt = new Array(nb).fill(0);
        for (const d of a.drifts) {
            if (d.drift < histBins[0] || d.drift >= histBins[nb]) continue;
            let b = Math.floor((d.drift - histBins[0]) / (2 * driftCap) * nb);
            if (b < 0) b = 0; if (b >= nb) b = nb - 1; cnt[b]++;
        }
        histCountMax = Math.max(histCountMax, ...cnt);
    }
    // shared instrumental-magnitude x-axis (brightness panel) across arms
    const allMag = arms.flatMap(a => a.drifts.filter(d => Number.isFinite(d.mInst)).map(d => d.mInst)).sort((x, y) => x - y);
    const magMin = allMag.length ? allMag[0] : 0;
    const magMax = allMag.length ? allMag[allMag.length - 1] : 1;
    const scales = { driftCap, refMag, lenPerMag, histBins, histCountMax, magMin, magMax };

    // ── render + write ──
    const canvases = {};
    const nameMap = { rawler_default: 'rawler', libraw_cold: 'libraw' };
    for (const a of arms) {
        const c = renderArm(a, scales);
        const short = nameMap[a.arm] ?? a.arm;
        const p = path.join(WORK, `DSCF_CR2_color_drift_${short}${SUFFIX}.png`);
        fs.writeFileSync(p, encodePng(c));
        canvases[short] = c;
        log('wrote', path.relative(ROOT, p));
    }

    // side-by-side (only when both arms present)
    if (canvases.rawler && canvases.libraw) {
        const a = canvases.rawler, b = canvases.libraw;
        const gap = 24, bannerH = 44;
        const combo = makeCanvas(a.w + b.w + gap, bannerH + a.h);
        fillRect(combo, 0, 0, combo.w, combo.h, BG[0], BG[1], BG[2], 255);
        drawText(combo, `COLOR-DRIFT SIDE-BY-SIDE  ·  RAWLER (DEFAULT) VS LIBRAW (COLD)  ·  SAME AXES/SCALES  ·  CR2_DEMOSAIC_APPROX (APPROXIMATE)`, 24, 14, 2, TEXT, 1);
        blit(combo, a, 0, bannerH);
        blit(combo, b, a.w + gap, bannerH);
        const p = path.join(WORK, `DSCF_CR2_color_drift_sidebyside${SUFFIX}.png`);
        fs.writeFileSync(p, encodePng(combo));
        log('wrote', path.relative(ROOT, p));
    }

    // per-star residual JSON
    const residuals = {
        schema: 'color_drift_residuals.v1',
        generated_at: new Date().toISOString(), head: HEAD,
        construction: 'drift = instColor(-2.5log10(fluxB/fluxR)) - (a*catBpRp+b); fit = fitColorRegression (sigma-clip OLS, x=catBpRp y=instColor); SPCC-convention r2 also reported (catBpRp=slope*instColor+b)',
        source_tag: 'CR2_DEMOSAIC_APPROX', approximate: true,
        scales: { driftCap, refMag, histBins, magMin, magMax },
        brightness_discriminant: 'drift-vs-instrumental-mag: pedestal ⇒ |drift| grows toward FAINT; CFA/phase ⇒ flat. disp_ratio = sd(faintest bin)/sd(brightest bin). signature is a HEURISTIC read, not a gate.',
        arms: arms.map(a => ({
            arm: a.arm, width: a.width, height: a.height, optical_center: a.optical_center, opt_center_note: a.opt_center_note,
            matched_count: a.matched_count, matched_with_catcolor: a.matched_with_catcolor, n_usable: a.n_usable, n_drift: a.n_drift,
            solve: a.solve, fit_spcc: a.fit_spcc, fit_pred: a.fit_pred,
            drift_mean: a.drift_mean, drift_sd: a.drift_sd,
            radial_slope: a.radial_slope, radial_slope_se: a.radial_slope_se, radial_intercept: a.radial_intercept,
            n_bright: a.n_bright,
            brightness_slope: a.brightness_slope, brightness_slope_se: a.brightness_slope_se, brightness_intercept: a.brightness_intercept,
            bright_bins: a.bright_bins, sd_bright: a.sd_bright, sd_faint: a.sd_faint, disp_ratio: a.disp_ratio, signature: a.signature,
            stars: a.drifts.map(d => ({
                i: d.i, x: d.x, y: d.y, r_norm: +d.r_norm.toFixed(5),
                flux_r: d.flux_r, flux_g: d.flux_g, flux_b: d.flux_b,
                catBpRp: d.catBpRp, instColor: +d.instColor.toFixed(5),
                mInst: Number.isFinite(d.mInst) ? +d.mInst.toFixed(5) : null,
                pred: +d.pred.toFixed(5), drift: +d.drift.toFixed(5),
            })),
        })),
    };
    fs.writeFileSync(path.join(WORK, `color_drift_residuals${SUFFIX}.json`), JSON.stringify(residuals, null, 2));
    log('wrote', path.relative(ROOT, path.join(WORK, `color_drift_residuals${SUFFIX}.json`)));

    // ── console summary ──
    console.log('\n[color-drift] SUMMARY');
    for (const a of arms) {
        console.log(`  ${a.arm}: n_drift=${a.n_drift}  SPCC-r2=${fmt(a.fit_spcc.r2, 4)}  drift mean=${fmt(a.drift_mean, 3)}±${fmt(a.drift_sd, 3)}  radial-slope=${fmt(a.radial_slope, 3)}±${fmt(a.radial_slope_se, 3)} mag/rad  instColor-range=[${fmt(Math.min(...a.drifts.map(d => d.instColor)), 2)},${fmt(Math.max(...a.drifts.map(d => d.instColor)), 2)}]`);
        console.log(`    BRIGHTNESS: slope=${fmt(a.brightness_slope, 3)}±${fmt(a.brightness_slope_se, 3)} mag/mag  |drift|SD bright=${fmt(a.sd_bright, 3)} faint=${fmt(a.sd_faint, 3)} ratio=${fmt(a.disp_ratio, 2)}  ⇒ SIGNATURE: ${a.signature}`);
    }
    console.log('  outputs in', path.relative(ROOT, WORK));
}

main();
