// ═══════════════════════════════════════════════════════════════════════════
// DEEP-CATALOG FORCED PHOTOMETRY — depth-vs-signal on a solved frame
// ═══════════════════════════════════════════════════════════════════════════
// QUESTION (owner): what does catalog-forced photometry do with a GENUINELY
// DEEP catalog? The gate solve only ever matched G<=12.5; the sub-threshold
// regime (the thing forced photometry was designed for) has never been run.
//
// Drives tools/psf/forced_detect.forcedMeasure (the reference lane) at the
// pixel positions of a DEEP Gaia cone (G<=17), binned by magnitude, with a
// deterministic scrambled-null control. MEASURED numbers only.
//
// COORDINATE ledger: Gaia (ra,dec DEGREES) -> linear FITS WCS (CRVAL deg,
//   CRPIX 0-based, CD deg/px) -> optional fitted-distortion forward (SIP/TPS,
//   receipt convention (1); the export-boundary sign bug is FIXED @5a55315 so the
//   receipt block is directly usable) -> native pixel. PIXEL ledger: matched-
//   aperture forced photometry on the luminance grid (mean of the FITS RGB planes;
//   local annulus background so the luminance recipe is not load-bearing). No
//   resample; native grid only.
//
// GEOMETRY LADDER (--geometry auto|linear|sip|tps): 'auto' walks TPS→SIP→linear per
//   what the receipt carries; 'linear' forces the reproducible baseline arm. The
//   tier ACTUALLY used is recorded on the output (honest labeling). Paired arms
//   (auto vs linear) make the geometry-vs-confusion decomposition explicit —
//   see tools/deepcat/selftest_geometry.mjs for the sign/direction acceptance test.
//
// Usage: node tools/deepcat/deep_forced_photometry.mjs [--geometry auto] [--out ...]
import fs from 'node:fs';
import path from 'node:path';
import { decodeFITS } from '../psf/decode_fits.mjs';
import { forcedMeasure, projectStarsGeom, recoveryByMagnitude, angSepDeg } from '../psf/forced_detect.mjs';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const FIT = arg('--fit', 'Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const RECEIPT = arg('--receipt', 'test_results/api_runs/DSO_Stacked_738_M 66_60.0s_20260516_064736.receipt.json');
const CONE = arg('--cone', 'test_results/deep_cones/m66_G17_cone.csv');
const POSRMS = parseFloat(arg('--posrms', '2.0'));
const SNR_THR = parseFloat(arg('--snr', '2'));
const NULL_N = parseInt(arg('--nulln', '4000'), 10);
const LABEL = arg('--label', 'M66');
const GEOMETRY = arg('--geometry', 'auto'); // auto|linear|sip|tps

// ── deterministic PRNG (mulberry32, same as deep_verify) ─────────────────────
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── load frame -> luminance ──────────────────────────────────────────────────
const { w, h, rgb16, meta } = decodeFITS(path.join(ROOT, FIT));
const L = new Float32Array(w * h);
for (let i = 0; i < w * h; i++) L[i] = (rgb16[i * 3] + rgb16[i * 3 + 1] + rgb16[i * 3 + 2]) / 3;

// frame noise (strided median + MAD, prime stride) for the structured guard
{
    const s = [];
    for (let i = 0; i < L.length; i += 997) s.push(L[i]);
    s.sort((a, b) => a - b);
    const med = s[s.length >> 1];
    const dev = s.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    var SIGMA = Math.max(1.4826 * dev[dev.length >> 1], 1e-9);
    var BGMED = med;
}

// ── linear WCS from receipt (FITS deg convention) ────────────────────────────
const R = JSON.parse(fs.readFileSync(path.join(ROOT, RECEIPT), 'utf8'));
const wc = R.wcs;
const wcs = { crval: [wc.CRVAL1, wc.CRVAL2], crpix: [wc.CRPIX1, wc.CRPIX2], cd: [[wc.CD1_1, wc.CD1_2], [wc.CD2_1, wc.CD2_2]] };
const astrometry = R.solution?.astrometry ?? null; // { sip?, tps? } — fitted distortion
const fwhmPx = R.solution?.mean_fwhm_px ?? 2.3;
const centerRa = wc.CRVAL1, centerDec = wc.CRVAL2;

// ── deep cone CSV (source_id,ra,dec,phot_g_mean_mag,bp_rp) ────────────────────
const lines = fs.readFileSync(path.join(ROOT, CONE), 'utf8').trim().split(/\r?\n/);
const hdr = lines[0].split(',');
const iG = hdr.indexOf('phot_g_mean_mag'), iRa = hdr.indexOf('ra'), iDec = hdr.indexOf('dec'), iId = hdr.indexOf('source_id'), iBp = hdr.indexOf('bp_rp');
const stars = [];
for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    const mag = parseFloat(c[iG]); if (!Number.isFinite(mag)) continue;
    stars.push({ ra_deg: parseFloat(c[iRa]), dec_deg: parseFloat(c[iDec]), mag, bp_rp: c[iBp] ? parseFloat(c[iBp]) : null, gaia_id: c[iId] });
}

// ── project deep catalog into pixels (geometry ladder: auto=TPS>SIP>linear) ──
const projOut = projectStarsGeom({ stars, wcs, astrometry, geometry: GEOMETRY, w, h, margin: 12 });
const proj = projOut.projected;
const GEO_TIER = projOut.geometry; // the tier ACTUALLY used (honest)

// ── forced photometry at predicted positions ─────────────────────────────────
const predMeas = forcedMeasure({ L, w, h, positions: proj, fwhmPx, posRmsPx: POSRMS, snrThreshold: SNR_THR, sigmaPix: SIGMA });
const rApPx = predMeas.rApPx;

// ── scrambled null: uniform in-frame, SAME aperture ──────────────────────────
const rnd = mulberry32(0x5EE57A57);
const mrg = Math.ceil(rApPx) + 12;
const nullPos = [];
for (let i = 0; i < NULL_N; i++) nullPos.push({ x: mrg + rnd() * (w - 2 * mrg), y: mrg + rnd() * (h - 2 * mrg), mag: null });
const nullMeas = forcedMeasure({ L, w, h, positions: nullPos, fwhmPx, posRmsPx: POSRMS, snrThreshold: SNR_THR, sigmaPix: SIGMA });
const nullRes = nullMeas.results;
const nullAccept = nullRes.filter(r => r.accepted).length;
const nullFrac = nullAccept / nullRes.length;
// null flux distribution for a flux-z (robust, model-free significance)
const nf = nullRes.map(r => r.flux).sort((a, b) => a - b);
const nullMedFlux = nf[nf.length >> 1];
const nullMadFlux = 1.4826 * nf.map(v => Math.abs(v - nullMedFlux)).sort((a, b) => a - b)[nf.length >> 1] || 1e-9;
const nullSnr = nullRes.map(r => r.snr).sort((a, b) => a - b);

// binomial excess z of `obs` accepts out of `n` vs base rate p0
function excessZ(obs, n, p0) { p0 = Math.max(p0, 0.5 / Math.max(n, 1)); const d = Math.sqrt(n * p0 * (1 - p0)); return d > 0 ? (obs - n * p0) / d : 0; }
function quant(arr, q) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; }

// ── bin the predicted-position results by magnitude ──────────────────────────
const EDGES = [7, 10, 11, 12, 12.5, 13, 14, 15, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5];
function binlabel(m) { for (let i = 0; i < EDGES.length - 1; i++) if (m >= EDGES[i] && m < EDGES[i + 1]) return `${EDGES[i]}-${EDGES[i + 1]}`; return null; }
const bins = new Map();
for (const r of predMeas.results) {
    const lab = binlabel(r.mag); if (!lab) continue;
    let b = bins.get(lab); if (!b) { b = { label: lab, N: 0, accepted: 0, structured: 0, snr: [], fluxz: [] }; bins.set(lab, b); }
    b.N++; if (r.accepted) b.accepted++; if (r.structured) b.structured++;
    b.snr.push(r.snr); b.fluxz.push((r.flux - nullMedFlux) / nullMadFlux);
}
const binRows = EDGES.slice(0, -1).map((lo, i) => `${lo}-${EDGES[i + 1]}`).map(lab => {
    const b = bins.get(lab); if (!b) return { label: lab, N: 0 };
    const fzSig = b.fluxz.filter(z => z >= 3).length;
    return {
        label: lab, N: b.N,
        accepted: b.accepted, accFrac: +(b.accepted / b.N).toFixed(3),
        structured: b.structured,
        excessZvsNull: +excessZ(b.accepted, b.N, nullFrac).toFixed(2),
        snr_median: +quant(b.snr, 0.5).toFixed(2), snr_p25: +quant(b.snr, 0.25).toFixed(2), snr_p75: +quant(b.snr, 0.75).toFixed(2),
        fracSnr3: +(b.snr.filter(s => s >= 3).length / b.N).toFixed(3),
        fluxz_median: +quant(b.fluxz, 0.5).toFixed(2), fracFluxZ3: +(fzSig / b.N).toFixed(3),
    };
});

// ── per-star floor (m50) + ensemble excess-z (whole probed set vs null) ───────
const m50 = recoveryByMagnitude(
    predMeas.results.map((r) => ({ mag: r.mag, recovered: r.accepted })),
    { binWidth: 0.5, minPerBin: 5 },
);
const totAcc = predMeas.results.filter((r) => r.accepted).length;
const ensembleZ = +excessZ(totAcc, predMeas.results.length, nullFrac).toFixed(2);

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\n=== DEEP FORCED PHOTOMETRY — ${LABEL}  [geometry=${GEO_TIER}] ===`);
console.log(`frame ${w}x${h}  planes=${meta.planes}  fwhm=${fwhmPx.toFixed(2)}px  sigma=${SIGMA.toFixed(2)}  bgMed=${BGMED.toFixed(1)}`);
console.log(`geometry: requested=${GEOMETRY} used=${GEO_TIER}  sip=${projOut.convergence.sipPresent} tps=${projOut.convergence.tpsPresent}  fpIters<=${projOut.convergence.maxIters} convFail=${projOut.convergence.failures}`);
console.log(`cone stars=${stars.length}  projected in-frame=${proj.length}  probed=${predMeas.results.length}`);
console.log(`aperture: posRms=${POSRMS}px -> rAp=${rApPx.toFixed(2)}px (${(rApPx * (R.solution.pixel_scale)).toFixed(1)}")  snrThr=${SNR_THR}`);
console.log(`NULL: n=${nullRes.length}  accepted=${nullAccept} (frac=${nullFrac.toFixed(4)})  snr[med=${quant(nullSnr, 0.5).toFixed(2)} p95=${quant(nullSnr, 0.95).toFixed(2)}]  medFlux=${nullMedFlux.toFixed(1)} madFlux=${nullMadFlux.toFixed(1)}`);
console.log(`\nbin(G)      N   acc  accFrac  exZvNull  snrMed  frSNR>=3  fzMed  frFZ>=3  struct`);
for (const r of binRows) {
    if (!r.N) { console.log(`${r.label.padEnd(10)}  0   —`); continue; }
    console.log(`${r.label.padEnd(10)} ${String(r.N).padStart(3)}  ${String(r.accepted).padStart(3)}  ${r.accFrac.toFixed(3)}   ${String(r.excessZvsNull).padStart(7)}  ${String(r.snr_median).padStart(6)}  ${r.fracSnr3.toFixed(3)}    ${String(r.fluxz_median).padStart(5)}  ${r.fracFluxZ3.toFixed(3)}   ${r.structured}`);
}
console.log(`\nfloor: m50(limiting G)=${m50.limitingMag ?? 'none'}${m50.censored ? ' (censored — catalog ran out first)' : ''}  ensemble excess-z (all probed vs null)=${ensembleZ}σ  accepted=${totAcc}/${predMeas.results.length}`);

const out = {
    label: LABEL, frame: FIT, receipt: RECEIPT, cone: CONE,
    geometry: { requested: GEOMETRY, used: GEO_TIER, sipPresent: projOut.convergence.sipPresent, tpsPresent: projOut.convergence.tpsPresent, fpMaxIters: projOut.convergence.maxIters, fpConvFailures: projOut.convergence.failures },
    grid: { w, h, planes: meta.planes }, wcs, center: { ra_deg: centerRa, dec_deg: centerDec },
    pixel_scale_arcsec: R.solution.pixel_scale, fwhmPx, sigmaPix: SIGMA, bgMedian: BGMED,
    matched_depth: { note: 'gate solve matched-star magnitudes', min: 4.93, max: 12.48, median: 11.72 },
    aperture: { posRmsPx: POSRMS, rApPx, arcsec: rApPx * R.solution.pixel_scale, snrThreshold: SNR_THR },
    cone_stars: stars.length, projected_inframe: proj.length, probed: predMeas.results.length,
    floor: { m50_limitingMag: m50.limitingMag, censored: m50.censored, ensembleExcessZ: ensembleZ, accepted: totAcc },
    null: { n: nullRes.length, accepted: nullAccept, frac: nullFrac, medFlux: nullMedFlux, madFlux: nullMadFlux, snrMedian: quant(nullSnr, 0.5), snrP95: quant(nullSnr, 0.95) },
    bins: binRows,
};
export default out;
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].includes('deep_forced_photometry')) {
    const outPath = arg('--out', null);
    if (outPath) { fs.writeFileSync(path.join(ROOT, outPath), JSON.stringify(out, null, 2)); console.log(`\n-> ${outPath}`); }
}
