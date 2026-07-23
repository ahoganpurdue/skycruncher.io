// ═══════════════════════════════════════════════════════════════════════════
// IMG_1410 FORCED APERTURE PHOTOMETRY IN RAW PIXELS
// Settles: are the 80 missing bright catalog stars RECOVERABLE (sub-threshold
// flux present in the luminance grid) or EXPOSURE-LIMITED (below the noise
// floor → needs a stack)?
//
// COORDINATE ledger: catalog (ra HOURS internally) → anchor-based UW sweep
//   projection (identical to solver_entry.ts:1034-1047, reproduced in
//   img1410_forced_radial.mjs) → NATIVE pixel px.
// PIXEL ledger: matched-aperture forced photometry (forced_detect.forcedMeasure)
//   on the SCIENCE luminance grid captured from the live session
//   (capture_science_buffer.mjs). Native px are mapped to science px via the
//   ScaleManager ratio (scienceW/nativeW). No resample.
//
// Null: the SAME aperture sampled at RNG scrambled in-frame positions →
//   median/MAD → per-star z = (flux - nullMed)/(1.4826*MAD_null).
//
// Usage: node tools/dslr/img1410_forced_photometry.mjs [ra0h dec0 theta parity]
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { forcedMeasure } from '../psf/forced_detect.mjs';

const ROOT = process.cwd();
const DUMP = 'test_results/cr2_dets/IMG_1410.app.json';
const SCIBUF_META = 'test_results/cr2_dets/IMG_1410.scibuf.json';
const MAG_LIMIT = 6.0;
const SCALE = 63.352821428571424; // arcsec/px native (from dump)
const argv = process.argv.slice(2);
const ra0 = parseFloat(argv[0] ?? '17.264');
const dec0 = parseFloat(argv[1] ?? '-22.5');
const thetaDeg = parseFloat(argv[2] ?? '147.2');
const parity = parseInt(argv[3] ?? '1', 10);
const D2R = Math.PI / 180, H2R = Math.PI / 12;

function gnomonic(raH, decD, ra0H, dec0D) {
    const ra = raH * H2R, dec = decD * D2R, r0 = ra0H * H2R, d0 = dec0D * D2R;
    const dra = ra - r0;
    const cosc = Math.sin(d0) * Math.sin(dec) + Math.cos(d0) * Math.cos(dec) * Math.cos(dra);
    if (cosc <= 0) return { xi: NaN, eta: NaN };
    const xi = Math.cos(dec) * Math.sin(dra) / cosc;
    const eta = (Math.cos(d0) * Math.sin(dec) - Math.sin(d0) * Math.cos(dec) * Math.cos(dra)) / cosc;
    return { xi: xi / D2R, eta: eta / D2R };
}
function angSep(raH, decD) {
    const a = decD * D2R, b = dec0 * D2R, d = (raH - ra0) * H2R;
    return Math.acos(Math.min(1, Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(d))) / D2R;
}

// ── load frame + detections ──
const dump = JSON.parse(fs.readFileSync(path.join(ROOT, DUMP), 'utf8'));
const W = dump.width, H = dump.height;
const dets = dump.detections.map(d => ({ x: d.x, y: d.y }));
const bright = [...dump.detections].sort((a, b) => b.flux - a.flux)[0];
const aCx = bright.x, aCy = bright.y;
const degPerPx = SCALE / 3600;
const ocx = W / 2, ocy = H / 2;

// detection lookup grid
const CELL = 128, GW = Math.ceil(W / CELL);
const grid = new Map();
for (const d of dets) { const k = Math.floor(d.y / CELL) * GW + Math.floor(d.x / CELL); (grid.get(k) || grid.set(k, []).get(k)).push(d); }
function nearestDet(px, py) {
    const cr = 3, gx = Math.floor(px / CELL), gy = Math.floor(py / CELL);
    let best = Infinity;
    for (let dy = -cr; dy <= cr; dy++) for (let dx = -cr; dx <= cr; dx++) {
        const b = grid.get((gy + dy) * GW + gx + dx); if (!b) continue;
        for (const d of b) { const r = Math.hypot(d.x - px, d.y - py); if (r < best) best = r; }
    }
    return best;
}

// ── catalog (bright mag_g<6, L1/L2 anchors) — identical to radial tool ──
let cat = [];
for (const f of ['level_1_anchors', 'level_2_pattern']) {
    const rows = JSON.parse(fs.readFileSync(path.join(ROOT, `public/atlas/${f}.json`), 'utf8'));
    for (const s of rows) {
        const mag = s.mag_g !== undefined ? s.mag_g : s.mag;
        if (!(mag < MAG_LIMIT)) continue;
        const raH = s.ra_deg !== undefined ? s.ra_deg / 15 : (s.source_id !== undefined || s.mag_g !== undefined ? s.ra / 15 : s.ra);
        const decD = s.dec_deg !== undefined ? s.dec_deg : s.dec;
        cat.push({ raH, decD, mag });
    }
}
const seen = new Set(); cat = cat.filter(s => { const k = `${s.raH.toFixed(4)},${s.decD.toFixed(4)}`; if (seen.has(k)) return false; seen.add(k); return true; });

// ── project in-frame bright stars at the verified WCS ──
const FETCH_DEG = 22.7;
const cT = Math.cos(thetaDeg * D2R), sT = Math.sin(thetaDeg * D2R);
const proj = [];
for (const s of cat) {
    if (angSep(s.raH, s.decD) > FETCH_DEG) continue;
    const { xi, eta } = gnomonic(s.raH, s.decD, ra0, dec0);
    if (Number.isNaN(xi)) continue;
    const ey = eta * parity;
    const px = aCx + (xi * cT - ey * sT) / degPerPx;
    const py = aCy + (xi * sT + ey * cT) / degPerPx;
    if (px < 0 || px >= W || py < 0 || py >= H) continue;
    proj.push({ px, py, mag: s.mag });
}
// classify detected (wide-net matched) vs missing
const base = 15.0;
for (const p of proj) {
    const r = Math.hypot(p.px - ocx, p.py - ocy);
    p.resid = nearestDet(p.px, p.py);
    p.widenetTol = Math.max(base, 0.035 * r);
    p.detected = p.resid <= p.widenetTol;
}
const missing = proj.filter(p => !p.detected);
const detected = proj.filter(p => p.detected);
console.log(`in-frame bright=${proj.length}  detected(widenet)=${detected.length}  missing=${missing.length}`);

// ── load science luminance buffer ──
if (!fs.existsSync(path.join(ROOT, SCIBUF_META))) {
    console.error(`\nMISSING: ${SCIBUF_META} — run capture_science_buffer.mjs first.`);
    process.exit(2);
}
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, SCIBUF_META), 'utf8'));
const rawBuf = fs.readFileSync(path.join(ROOT, 'test_results', 'cr2_dets', meta.rawFile));
const L = new Float32Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength / 4);
// The luminance grid m4 operates on is EITHER native (CR2 computeluminance path)
// OR binned science (Bayer-native path). Detect shape from the length so the
// native-px predictions map onto the correct grid.
let sw, sh, nx, ny;
if (L.length === meta.nativeW * meta.nativeH) {
    sw = meta.nativeW; sh = meta.nativeH; nx = 1; ny = 1; // native grid
} else if (L.length === meta.scienceW * meta.scienceH) {
    sw = meta.scienceW; sh = meta.scienceH; nx = sw / meta.nativeW; ny = sh / meta.nativeH; // binned
} else {
    console.error(`\nBUFFER SHAPE MISMATCH: L.length=${L.length} matches neither native(${meta.nativeW * meta.nativeH}) nor science(${meta.scienceW * meta.scienceH}). Cannot map safely.`);
    process.exit(3);
}
const fwhmSci = Math.max(1.5, (meta.medianFwhmNative ?? 6) * nx);
console.log(`lumBuffer ${sw}x${sh} (len=${L.length}, grid=${nx === 1 ? 'NATIVE' : 'BINNED'})  native->grid ratio=${nx.toFixed(4)}  fwhmGrid=${fwhmSci.toFixed(2)}px  noise_floor=${meta.noise_floor}`);

const toSci = (p) => ({ x: p.px * nx, y: p.py * ny, mag: p.mag });

// ── scrambled null: same aperture at RNG random in-frame science positions ──
const RNG = 3000;
const nullPos = [];
const mrg = Math.ceil(0.68 * fwhmSci) + 12;
let rs = 1234567;
const rand = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
for (let i = 0; i < RNG; i++) nullPos.push({ x: mrg + rand() * (sw - 2 * mrg), y: mrg + rand() * (sh - 2 * mrg) });
const nullMeas = forcedMeasure({ L, w: sw, h: sh, positions: nullPos, fwhmPx: fwhmSci, snrThreshold: 3 });
const nullFlux = nullMeas.results.map(r => r.flux).sort((a, b) => a - b);
const nullMed = nullFlux[nullFlux.length >> 1];
const nullMad = 1.4826 * nullFlux.map(v => Math.abs(v - nullMed)).sort((a, b) => a - b)[nullFlux.length >> 1];
console.log(`null: n=${nullFlux.length} rAp=${nullMeas.rApPx.toFixed(2)}px  medFlux=${nullMed.toFixed(1)}  MAD-sigma=${nullMad.toFixed(1)}`);

function analyze(label, list) {
    const pos = list.map(toSci);
    const m = forcedMeasure({ L, w: sw, h: sh, positions: pos, fwhmPx: fwhmSci, snrThreshold: 3 });
    // z over scrambled null
    const rows = m.results.map(r => ({ ...r, z: (r.flux - nullMed) / (nullMad || 1e-9) }));
    const sig = rows.filter(r => r.z >= 3);
    const sigSnr = rows.filter(r => r.snr >= 3);
    console.log(`\n[${label}] probed=${rows.length}/${list.length} (edge-skipped ${list.length - rows.length})`);
    console.log(`  z>=3 over null: ${sig.length}/${rows.length}   (localSNR>=3: ${sigSnr.length}/${rows.length})`);
    const zs = rows.map(r => r.z).sort((a, b) => a - b);
    console.log(`  z: min=${zs[0].toFixed(1)} median=${zs[zs.length >> 1].toFixed(1)} max=${zs[zs.length - 1].toFixed(1)}`);
    // magnitude stratification
    const bins = new Map();
    for (const r of rows) { const b = Math.floor(r.mag); const s = bins.get(b) || { n: 0, sig: 0 }; s.n++; if (r.z >= 3) s.sig++; bins.set(b, s); }
    console.log(`  by mag bin [mag): n / z>=3`);
    for (const k of [...bins.keys()].sort((a, b) => a - b)) { const s = bins.get(k); console.log(`    mag ${k}-${k + 1}: ${String(s.n).padStart(3)} / ${s.sig}`); }
    return { rows, sig };
}

const R_missing = analyze('MISSING (the 80)', missing);
const R_detected = analyze('DETECTED (the 39, sanity anchor)', detected);

// write artifact
const outDir = path.join(ROOT, 'test_results', 'cr2_dets');
const out = {
    wcs: { ra0, dec0, thetaDeg, parity, anchorPx: [aCx, aCy] },
    scienceBuffer: { w: sw, h: sh, ratio: nx, fwhmSci, noise_floor: meta.noise_floor },
    null: { n: nullFlux.length, rApPx: nullMeas.rApPx, medFlux: nullMed, madSigma: nullMad },
    counts: { inframe: proj.length, detected: detected.length, missing: missing.length },
    missing_probed: R_missing.rows.length, missing_significant_z3: R_missing.sig.length,
    detected_probed: R_detected.rows.length, detected_significant_z3: R_detected.sig.length,
    missing: R_missing.rows.map(r => ({ x: r.x, y: r.y, mag: r.mag, flux: r.flux, snr: r.snr, z: r.z })),
    detected: R_detected.rows.map(r => ({ x: r.x, y: r.y, mag: r.mag, flux: r.flux, snr: r.snr, z: r.z })),
};
const outPath = path.join(outDir, 'IMG_1410.forced_photometry.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\n-> ${path.relative(ROOT, outPath)}`);
