#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/calib/build_masters.mjs — 4-class master frame builder (cutover #14)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/calib/build_masters.mjs [--corpus <dir>] [--out <dir>]
//        [--probe-only] [--limit <n>]
//
// Ledger: PIXEL. All masters live on the FULL-frame CFA grid (raw ADU + black
// pedestal), f32, written as .bin + manifest.json.
//
// FIRST ACTION (mission-mandated): decode 3 flats and report pixel means to
// settle RIG_TRUTH's pending "flats vs dark" question with real luminance. If
// the flats read near black level (i.e. they are actually darks), the flat leg
// collapses — the script halts and prints the SendMessage-to-'main' verdict.
//
// Masters (per DARK_CALIBRATION_POLICY + owner spec):
//  · master bias  = per-pixel MEDIAN of the bias frames (1/8000s, zero-light)
//  · master dark  = per-pixel MEDIAN of the matched-exposure darks (240s).
//                   CONVENTION: exposure-matched ⇒ the dark INCLUDES the bias
//                   pedestal; it is applied WHOLE (light − masterDark), never
//                   bias-then-dark. Documented in the manifest.
//  · master flat  = per-pixel MEDIAN of {(flat − masterBias) then per-PHASE
//                   normalize to unit mean}. The 4 Bayer phases (RGGB tile
//                   positions) are normalized INDEPENDENTLY so the flat carries
//                   no colour/phase shift — only vignette + PRNU + dust.
//
// Black levels are MEASURED from rawler meta (blacklevel_bayer), never assumed.

import fs from 'node:fs';
import path from 'node:path';
import {
    ROOT, BIN_DIR, JSON_DIR, decodeCfa, listClass, perPhaseMean, perPixelMedian,
    phaseColors, md5OfF32, stdOf,
} from './decode_util.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const CORPUS = path.resolve(flag('corpus') ?? path.join(ROOT, 'Sample Files', 'corpus', 'cocoon_60da'));
// JSON (manifests, probe, summary) → test_results; large .bin masters → D: (owner storage directive)
const OUT = path.resolve(flag('out') ?? JSON_DIR);
const BIN_OUT = path.resolve(flag('bin-out') ?? BIN_DIR);
const PROBE_ONLY = has('probe-only');
const LIMIT = flag('limit') ? parseInt(flag('limit'), 10) : Infinity;
const log = (...a) => console.log('[build_masters]', ...a);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(BIN_OUT, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// FIRST ACTION — flats-vs-dark probe (3 flats, real pixel means)
// ─────────────────────────────────────────────────────────────────────────────
async function probeFlats() {
    const flats = listClass(CORPUS, 'flats').slice(0, 3);
    if (flats.length === 0) throw new Error(`no flats found under ${CORPUS}/flats`);
    log(`FLATS PROBE — decoding ${flats.length} flats to settle genuine-vs-dark…`);
    // Zero-light reference: decode ONE bias frame → the genuine/dark discriminator
    // is data-driven (illuminated ⇔ flat mean far outside the bias distribution),
    // not an arbitrary full-well fraction. A short-exposure DARK sits INSIDE the
    // bias distribution (negligible dark current at 1/1000s); a genuine flat sits
    // hundreds of ADU / tens of σ above it.
    const biasProbe = listClass(CORPUS, 'bias').slice(0, 1);
    let biasRef = null;
    if (biasProbe.length) {
        const bd = await decodeCfa(biasProbe[0]);
        let bs = 0; for (let i = 0; i < bd.cfa.length; i++) bs += bd.cfa[i];
        const bmean = bs / bd.cfa.length;
        const bsig = stdOf(bd.cfa, bmean);
        const bphase = perPhaseMean(bd.cfa, bd.width, bd.height);
        const bspread = Math.max(...bphase) - Math.min(...bphase);
        biasRef = { file: path.basename(biasProbe[0]), mean: +bmean.toFixed(2), sigma: +bsig.toFixed(2), perPhaseMean: bphase.map((v) => +v.toFixed(1)), phaseSpread: +bspread.toFixed(1) };
        log(`  bias reference ${biasRef.file}: mean=${bmean.toFixed(1)} σ=${bsig.toFixed(2)} perPhase=${JSON.stringify(biasRef.perPhaseMean)} phaseSpread=${bspread.toFixed(1)}`);
    }
    const rows = [];
    for (const fp of flats) {
        const d = await decodeCfa(fp);
        const pm = perPhaseMean(d.cfa, d.width, d.height);
        // overall mean
        let sum = 0; for (let i = 0; i < d.cfa.length; i++) sum += d.cfa[i];
        const mean = sum / d.cfa.length;
        const blackMean = (d.blacklevelBayer ?? []).reduce((s, v) => s + v, 0) / Math.max(1, (d.blacklevelBayer ?? []).length);
        const white = Array.isArray(d.whitelevel) ? d.whitelevel[0] : d.whitelevel;
        rows.push({
            file: path.basename(fp), mean, blackMean, white,
            perPhaseMean: pm.map((v) => +v.toFixed(1)),
            colors: phaseColors(d.pattern),
            aboveBlack: +(mean - blackMean).toFixed(1),
            fracOfWell: +((mean - blackMean) / Math.max(1, white - blackMean)).toFixed(4),
            dims: `${d.width}x${d.height}`, pattern: d.pattern, decodeMs: d.decodeMs,
        });
        log(`  ${path.basename(fp)}: mean=${mean.toFixed(1)} black~${blackMean.toFixed(1)} white~${white} aboveBlack=${(mean - blackMean).toFixed(1)} frac_well=${rows[rows.length - 1].fracOfWell} phases=${JSON.stringify(rows[rows.length - 1].perPhaseMean)} (${rows[rows.length - 1].colors.join('')})`);
    }
    // VERDICT (two distinct questions, reported separately):
    //  (1) GENUINE vs DARK — physical: illuminated ⇔ flat mean lies far outside
    //      the zero-light bias distribution (mean ≫ biasMean + N·biasSigma). A
    //      short-exposure dark sits INSIDE that distribution.
    //  (2) QUALITY — thin vs well-exposed = fraction of full well (a genuine flat
    //      can still be THIN, which caps flat-field/PRNU SNR; reported, not fatal).
    const meanAbove = rows.reduce((s, r) => s + r.aboveBlack, 0) / rows.length;
    const meanFrac = rows.reduce((s, r) => s + r.fracOfWell, 0) / rows.length;
    const flatMean = rows.reduce((s, r) => s + r.mean, 0) / rows.length;
    // DECISIVE PHYSICAL DISCRIMINATOR: light through a Bayer CFA produces per-
    // phase COLOUR structure (G≠R≠B); a bias/dark frame has none (all phases at
    // the pedestal ± FPN). So compare the flats' per-phase spread to the bias's.
    const flatPhaseMean = [0, 1, 2, 3].map((p) => rows.reduce((s, r) => s + r.perPhaseMean[p], 0) / rows.length);
    const flatPhaseSpread = Math.max(...flatPhaseMean) - Math.min(...flatPhaseMean);
    const biasPhaseSpread = biasRef ? biasRef.phaseSpread : 0;
    const dcOffset = biasRef ? (flatMean - biasRef.mean) : meanAbove;
    // GENUINE ⇔ a real DC signal above the pedestal AND clear colour structure
    // (phase spread far exceeding the bias's). Both are impossible for a dark.
    const colorStructure = flatPhaseSpread > Math.max(30, 3 * biasPhaseSpread);
    const hasDcSignal = dcOffset > 100;
    const genuine = hasDcSignal && colorStructure;
    const thin = meanFrac < 0.10;
    const verdict = {
        genuine, thin,
        meanAboveBlack: +meanAbove.toFixed(1), meanFracOfWell: +meanFrac.toFixed(4),
        flat_mean_adu: +flatMean.toFixed(1),
        dc_offset_above_bias_adu: +dcOffset.toFixed(1),
        flat_per_phase_mean: flatPhaseMean.map((v) => +v.toFixed(1)),
        flat_phase_spread_adu: +flatPhaseSpread.toFixed(1),
        bias_phase_spread_adu: +biasPhaseSpread.toFixed(1),
        color_structure_present: colorStructure,
        bias_reference: biasRef,
        rule: 'GENUINE ⇔ DC offset > 100 ADU above bias pedestal AND per-phase colour spread > max(30, 3×bias phase spread) [light through the CFA carries colour; a dark cannot]. QUALITY: thin ⇔ < 10% full well.',
        frames: rows,
    };
    fs.writeFileSync(path.join(OUT, 'flats_probe.json'), JSON.stringify(verdict, null, 2));
    log(`FLATS VERDICT: ${genuine ? 'GENUINE (illuminated)' : 'DARK — flat leg COLLAPSES'}${genuine && thin ? ' but THIN' : ''} · dcOffset=${dcOffset.toFixed(1)} ADU · colorSpread=${flatPhaseSpread.toFixed(1)} vs bias ${biasPhaseSpread.toFixed(1)} · fracWell=${meanFrac.toFixed(4)}`);
    return verdict;
}

// ─────────────────────────────────────────────────────────────────────────────
// master builders
// ─────────────────────────────────────────────────────────────────────────────
async function decodeClass(cls, limit) {
    const files = listClass(CORPUS, cls).slice(0, limit);
    if (files.length === 0) throw new Error(`no frames under ${CORPUS}/${cls}`);
    log(`decoding ${files.length} ${cls} frames on the full-frame CFA grid…`);
    const frames = [];
    let geom = null;
    for (const fp of files) {
        const d = await decodeCfa(fp);
        if (!geom) geom = { width: d.width, height: d.height, pattern: d.pattern, blacklevelBayer: d.blacklevelBayer, whitelevel: d.whitelevel, activeArea: d.activeArea };
        else if (d.width !== geom.width || d.height !== geom.height || d.pattern !== geom.pattern) {
            throw new Error(`geometry drift in ${cls}: ${path.basename(fp)} ${d.width}x${d.height}/${d.pattern} vs ${geom.width}x${geom.height}/${geom.pattern}`);
        }
        frames.push(d.cfa);
    }
    return { frames, geom, files: files.map((f) => path.basename(f)) };
}

function writeMaster(name, f32, geom, extra) {
    const bin = path.join(BIN_OUT, `${name}.bin`);
    fs.writeFileSync(bin, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
    const manifest = {
        name, file: `${name}.bin`,
        bin_path: bin, // absolute D: location (owner storage directive) — loaders read this
        dtype: 'f32', endianness: 'LE-host',
        dims: { width: geom.width, height: geom.height },
        length: f32.length,
        grid: 'FULL-frame CFA (incl. optical-black borders), cpp=1, index=y*W+x',
        cfa_pattern_full: geom.pattern,
        cfa_phase_colors: phaseColors(geom.pattern),
        active_area: geom.activeArea,
        units: 'raw ADU (14-bit domain, black pedestal INCLUDED unless noted)',
        blacklevel_bayer_measured: geom.blacklevelBayer,
        whitelevel_measured: geom.whitelevel,
        md5: md5OfF32(f32),
        ...extra,
    };
    fs.writeFileSync(path.join(OUT, `${name}.manifest.json`), JSON.stringify(manifest, null, 2));
    log(`wrote ${name}.bin (${(f32.byteLength / 1e6).toFixed(1)}MB) md5=${manifest.md5} method=${extra.method}`);
    return manifest;
}

// fixed-pattern (row/col) structure of a master — banding/amp signature
function fixedPatternStats(buf, width, height) {
    const rowMean = new Float64Array(height);
    const colMean = new Float64Array(width);
    for (let y = 0; y < height; y++) {
        let s = 0; const row = y * width;
        for (let x = 0; x < width; x++) { s += buf[row + x]; colMean[x] += buf[row + x]; }
        rowMean[y] = s / width;
    }
    for (let x = 0; x < width; x++) colMean[x] /= height;
    const stdArr = (a) => { let m = 0; for (const v of a) m += v; m /= a.length; let s = 0; for (const v of a) s += (v - m) * (v - m); return Math.sqrt(s / a.length); };
    return { row_mean_std_adu: +stdArr(rowMean).toFixed(3), col_mean_std_adu: +stdArr(colMean).toFixed(3) };
}

async function main() {
    const started = Date.now();
    const probe = await probeFlats();
    if (PROBE_ONLY) { log('probe-only: done.'); return 0; }
    if (!probe.genuine) {
        log('════════════════════════════════════════════════════════════════');
        log('HALT: flats read as DARK — flat leg collapses. SendMessage to main:');
        log(`  "cocoon flats probe: DARK (meanFracOfWell=${probe.meanFracOfWell}, meanAboveBlack=${probe.meanAboveBlack} ADU). Flat leg cannot be built; bias+dark masters only. Direction?"`);
        log('════════════════════════════════════════════════════════════════');
        fs.writeFileSync(path.join(OUT, 'HALT_flats_dark.txt'), JSON.stringify(probe, null, 2));
        return 2;
    }

    // ── BIAS master (median) ──
    const bias = await decodeClass('bias', LIMIT);
    const W = bias.geom.width, H = bias.geom.height, LEN = W * H;
    const masterBias = perPixelMedian(bias.frames, LEN);
    bias.frames.length = 0; // free
    let biasMean = 0; for (let i = 0; i < LEN; i++) biasMean += masterBias[i]; biasMean /= LEN;
    const biasSigma = stdOf(masterBias, biasMean);
    const biasFP = fixedPatternStats(masterBias, W, H);
    const biasBlackMean = (bias.geom.blacklevelBayer ?? []).reduce((s, v) => s + v, 0) / Math.max(1, (bias.geom.blacklevelBayer ?? []).length);
    const biasManifest = writeMaster('master_bias', masterBias, bias.geom, {
        method: 'per-pixel median', N: bias.files.length, source_frames: bias.files,
        exposure: '1/8000s (zero-light)', includes_pedestal: true,
        validation: {
            bias_mean_adu: +biasMean.toFixed(3), bias_sigma_adu: +biasSigma.toFixed(3),
            measured_black_mean_adu: +biasBlackMean.toFixed(3),
            bias_mean_minus_black: +(biasMean - biasBlackMean).toFixed(3),
            fixed_pattern: biasFP,
        },
    });

    // ── DARK master (median, exposure-matched → includes bias) ──
    const dark = await decodeClass('darks', LIMIT);
    if (dark.geom.width !== W || dark.geom.height !== H) throw new Error('dark geometry != bias geometry');
    const masterDark = perPixelMedian(dark.frames, LEN);
    dark.frames.length = 0;
    let darkMean = 0; for (let i = 0; i < LEN; i++) darkMean += masterDark[i]; darkMean /= LEN;
    // dark current = dark − bias (both include pedestal; difference isolates it)
    let dcSum = 0; for (let i = 0; i < LEN; i++) dcSum += (masterDark[i] - masterBias[i]);
    const darkCurrentMean = dcSum / LEN;
    // hot-pixel census: pixels whose dark signal exceeds bias mean by K·biasSigma.
    // K=6 mirrors the engine's DETECT_HOTPIXEL_NSIGMA (RECAL_DESIGN §2, cited) —
    // the same spike bar the pipeline uses; this is a census, not a new constant.
    const K = 6;
    const hotThresh = biasMean + K * biasSigma;
    let hot = 0, hot10 = 0; const hotThresh10 = biasMean + 10 * biasSigma;
    for (let i = 0; i < LEN; i++) { if (masterDark[i] > hotThresh) hot++; if (masterDark[i] > hotThresh10) hot10++; }
    const mp = LEN / 1e6;
    const darkManifest = writeMaster('master_dark', masterDark, dark.geom, {
        method: 'per-pixel median', N: dark.files.length, source_frames: dark.files,
        exposure: '240s (exposure-matched to lights)',
        convention: 'EXPOSURE-MATCHED ⇒ dark INCLUDES bias pedestal; applied WHOLE (light − masterDark), NOT bias-then-dark',
        includes_pedestal: true,
        validation: {
            dark_mean_adu: +darkMean.toFixed(3),
            dark_current_mean_adu: +darkCurrentMean.toFixed(4),
            dark_current_note: 'mean(masterDark − masterBias); isolates thermal signal over the pedestal',
            hot_pixel_census: {
                threshold_rule: `biasMean + K·biasSigma (K=${K}, mirrors DETECT_HOTPIXEL_NSIGMA)`,
                threshold_adu_6sigma: +hotThresh.toFixed(2),
                count_over_6sigma: hot, per_mp_6sigma: +(hot / mp).toFixed(2),
                count_over_10sigma: hot10, per_mp_10sigma: +(hot10 / mp).toFixed(2),
            },
        },
    });

    // ── FLAT master (bias-sub each, per-phase normalize, median) ──
    const flat = await decodeClass('flats', LIMIT);
    if (flat.geom.width !== W || flat.geom.height !== H) throw new Error('flat geometry != bias geometry');
    // per-frame per-phase mean AFTER bias subtraction (for normalization)
    const phaseMeansPerFrame = flat.frames.map((fr) => {
        const sum = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
        for (let y = 0; y < H; y++) {
            const row = y * W, pr = (y & 1) << 1;
            for (let x = 0; x < W; x++) { const p = pr | (x & 1); sum[p] += (fr[row + x] - masterBias[row + x]); cnt[p]++; }
        }
        return sum.map((s, i) => (cnt[i] ? s / cnt[i] : 1));
    });
    // precompute phase for each index? cheaper to recompute inline in transform.
    // transform: normalized = (flat − bias) / phaseMean[frame][phase]
    const masterFlat = perPixelMedian(flat.frames, LEN, (v, i, f) => {
        const x = i % W, y = (i / W) | 0;
        const p = ((y & 1) << 1) | (x & 1);
        const denom = phaseMeansPerFrame[f][p] || 1;
        return (v - masterBias[i]) / denom;
    });
    flat.frames.length = 0;
    const flatPhaseMean = perPhaseMean(masterFlat, W, H); // should be ≈ 1 per phase
    // vignette: center vs corner ratio per phase (32px probe boxes). CORNERS ARE
    // SAMPLED IN THE ACTIVE AREA (inset 60px) — the OB border reads ≈0 in a bias-
    // subtracted flat and would falsely inflate the vignette if sampled.
    const aa = flat.geom.activeArea ?? { x: 0, y: 0, w: W, h: H };
    const boxMean = (cx, cy) => {
        const out = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
        for (let y = cy - 16; y < cy + 16; y++) for (let x = cx - 16; x < cx + 16; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const p = ((y & 1) << 1) | (x & 1); out[p] += masterFlat[y * W + x]; cnt[p]++;
        }
        return out.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
    };
    const cxc = aa.x + (aa.w >> 1), cyc = aa.y + (aa.h >> 1), inset = 60;
    const center = boxMean(cxc, cyc);
    const corners = [
        boxMean(aa.x + inset, aa.y + inset), boxMean(aa.x + aa.w - inset, aa.y + inset),
        boxMean(aa.x + inset, aa.y + aa.h - inset), boxMean(aa.x + aa.w - inset, aa.y + aa.h - inset),
    ];
    const cornerAvg = [0, 1, 2, 3].map((p) => corners.reduce((s, c) => s + c[p], 0) / corners.length);
    const vignettePerPhase = [0, 1, 2, 3].map((p) => ({
        phase: p, color: phaseColors(flat.geom.pattern)[p],
        center: +center[p].toFixed(4), corner_avg: +cornerAvg[p].toFixed(4),
        corner_over_center: +(cornerAvg[p] / (center[p] || 1)).toFixed(4),
    }));
    const flatManifest = writeMaster('master_flat', masterFlat, flat.geom, {
        method: 'median of {(flat − masterBias), per-phase-normalized to unit mean}',
        N: flat.files.length, source_frames: flat.files,
        exposure: '1/1000s (illuminated)',
        normalization: 'per Bayer PHASE (4 RGGB tile positions) independently → no colour/phase shift; master mean ≈ 1 per phase',
        includes_pedestal: false,
        apply_as: 'divisor: calibrated = (light − masterDark) / masterFlat',
        validation: {
            flat_phase_mean: flatPhaseMean.map((v) => +v.toFixed(5)),
            vignette_per_phase: vignettePerPhase,
        },
    });

    const summary = {
        produced_at: new Date().toISOString(),
        corpus: path.relative(ROOT, CORPUS), out: path.relative(ROOT, OUT),
        dims: { width: W, height: H, length: LEN, megapixels: +mp.toFixed(2) },
        flats_probe: probe,
        masters: { bias: biasManifest, dark: darkManifest, flat: flatManifest },
        elapsed_s: +((Date.now() - started) / 1000).toFixed(1),
    };
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(summary, null, 2));
    log(`ALL MASTERS BUILT in ${summary.elapsed_s}s → ${path.relative(ROOT, OUT)}/manifest.json`);
    log(`  bias mean=${biasMean.toFixed(1)} σ=${biasSigma.toFixed(2)} · dark current=${darkCurrentMean.toFixed(3)} ADU · hot@6σ=${(hot / mp).toFixed(1)}/MP · flat phaseMean=${flatPhaseMean.map((v) => v.toFixed(3)).join(',')}`);
    return 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error('[build_masters] FATAL:', e); process.exit(1); });
