// ═══════════════════════════════════════════════════════════════════════════
// IMG_1410 NEIGHBORHOOD-PEAK FORCED PHOTOMETRY (position-error aware)
//
// WHY neighborhood, not point: the linear/anchor WCS mispredicts by 15-100px
// (14mm barrel distortion; verified in img1410_forced_radial.mjs — residual
// grows with radius). A 2px aperture at the exact predicted position lands on
// blank sky even for the 39 stars that WERE detected (validated: 3/39 point-
// forced significant). So we search the per-star position-error ENVELOPE
// (radius = the solver's own wide-net tolerance, 15..80px) for the peak
// matched-filter response, and calibrate a per-star scrambled null with the
// SAME search radius (deep_verify.ts runForcedPhotometry philosophy).
//
// COORDINATE ledger: catalog (RA hours) → anchor UW projection → NATIVE px.
// PIXEL ledger: 5x5-core matched filter over a local ring background, on the
//   NATIVE luminance grid captured from the live session. Summed-area tables
//   make each candidate O(1). No resample.
//
// Statistic: neighborhoodPeakSNR = max over candidate centers of
//   snr = sqrt(Ncore)*(coreMean - bgMean)/bgSigma.
// Recoverable if realPeak beats the 99th pct of its scrambled null (p<0.01).
//
// Usage: node tools/dslr/img1410_neighborhood_photometry.mjs [ra0 dec0 th par]
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DUMP = 'test_results/cr2_dets/IMG_1410.app.json';
const META = 'test_results/cr2_dets/IMG_1410.scibuf.json';
const MAG_LIMIT = 6.0;
const SCALE = 63.352821428571424;
const argv = process.argv.slice(2);
const ra0 = parseFloat(argv[0] ?? '17.264'), dec0 = parseFloat(argv[1] ?? '-22.5');
const thetaDeg = parseFloat(argv[2] ?? '147.2'), parity = parseInt(argv[3] ?? '1', 10);
const D2R = Math.PI / 180, H2R = Math.PI / 12;

function gnomonic(raH, decD) {
    const ra = raH * H2R, dec = decD * D2R, r0 = ra0 * H2R, d0 = dec0 * D2R, dra = ra - r0;
    const cosc = Math.sin(d0) * Math.sin(dec) + Math.cos(d0) * Math.cos(dec) * Math.cos(dra);
    if (cosc <= 0) return null;
    return { xi: Math.cos(dec) * Math.sin(dra) / cosc / D2R, eta: (Math.cos(d0) * Math.sin(dec) - Math.sin(d0) * Math.cos(dec) * Math.cos(dra)) / cosc / D2R };
}
function angSep(raH, decD) {
    const a = decD * D2R, b = dec0 * D2R, d = (raH - ra0) * H2R;
    return Math.acos(Math.min(1, Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(d))) / D2R;
}

// ── frame + detections ──
const dump = JSON.parse(fs.readFileSync(path.join(ROOT, DUMP), 'utf8'));
const W = dump.width, H = dump.height, degPerPx = SCALE / 3600;
const dets = dump.detections.map(d => ({ x: d.x, y: d.y }));
const bright = [...dump.detections].sort((a, b) => b.flux - a.flux)[0];
const aCx = bright.x, aCy = bright.y, ocx = W / 2, ocy = H / 2;
const CELL = 128, GW = Math.ceil(W / CELL), grid = new Map();
for (const d of dets) { const k = Math.floor(d.y / CELL) * GW + Math.floor(d.x / CELL); (grid.get(k) || grid.set(k, []).get(k)).push(d); }
function nearestDet(px, py) {
    const cr = 3, gx = Math.floor(px / CELL), gy = Math.floor(py / CELL); let best = Infinity;
    for (let dy = -cr; dy <= cr; dy++) for (let dx = -cr; dx <= cr; dx++) { const b = grid.get((gy + dy) * GW + gx + dx); if (!b) continue; for (const d of b) { const r = Math.hypot(d.x - px, d.y - py); if (r < best) best = r; } }
    return best;
}

// ── catalog ──
let cat = [];
for (const f of ['level_1_anchors', 'level_2_pattern']) {
    for (const s of JSON.parse(fs.readFileSync(path.join(ROOT, `public/atlas/${f}.json`), 'utf8'))) {
        const mag = s.mag_g !== undefined ? s.mag_g : s.mag;
        if (!(mag < MAG_LIMIT)) continue;
        const raH = s.ra_deg !== undefined ? s.ra_deg / 15 : (s.source_id !== undefined || s.mag_g !== undefined ? s.ra / 15 : s.ra);
        cat.push({ raH, decD: s.dec_deg !== undefined ? s.dec_deg : s.dec, mag });
    }
}
const seen = new Set(); cat = cat.filter(s => { const k = `${s.raH.toFixed(4)},${s.decD.toFixed(4)}`; if (seen.has(k)) return false; seen.add(k); return true; });

// ── project + classify ──
const cT = Math.cos(thetaDeg * D2R), sT = Math.sin(thetaDeg * D2R), FETCH_DEG = 22.7, base = 15;
const proj = [];
for (const s of cat) {
    if (angSep(s.raH, s.decD) > FETCH_DEG) continue;
    const g = gnomonic(s.raH, s.decD); if (!g) continue;
    const ey = g.eta * parity;
    const px = aCx + (g.xi * cT - ey * sT) / degPerPx, py = aCy + (g.xi * sT + ey * cT) / degPerPx;
    if (px < 0 || px >= W || py < 0 || py >= H) continue;
    const r = Math.hypot(px - ocx, py - ocy), tol = Math.max(base, 0.035 * r);
    proj.push({ px, py, mag: s.mag, tol, detected: nearestDet(px, py) <= tol });
}
const missing = proj.filter(p => !p.detected), detected = proj.filter(p => p.detected);
console.log(`in-frame=${proj.length} detected=${detected.length} missing=${missing.length}`);

// ── load native luminance buffer + build SAT (sum) and SAT2 (sum of squares) ──
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, META), 'utf8'));
const raw = fs.readFileSync(path.join(ROOT, 'test_results', 'cr2_dets', meta.rawFile));
const L = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
if (L.length !== W * H) { console.error(`buffer len ${L.length} != W*H ${W * H}`); process.exit(3); }
console.log(`buffer ${W}x${H} native; building SAT...`);
// SAT with (W+1)*(H+1) padding; Float64
const SW = W + 1;
const S = new Float64Array(SW * (H + 1)), S2 = new Float64Array(SW * (H + 1));
for (let y = 0; y < H; y++) {
    let rs = 0, rs2 = 0;
    const rowAbove = y * SW, rowCur = (y + 1) * SW;
    for (let x = 0; x < W; x++) {
        const v = L[y * W + x]; rs += v; rs2 += v * v;
        S[rowCur + x + 1] = S[rowAbove + x + 1] + rs;
        S2[rowCur + x + 1] = S2[rowAbove + x + 1] + rs2;
    }
}
// box sum over [x0,x1)x[y0,y1) via SAT (x1,y1 exclusive), clamped
function boxSum(sat, x0, y0, x1, y1) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
    return sat[y1 * SW + x1] - sat[y0 * SW + x1] - sat[y1 * SW + x0] + sat[y0 * SW + x0];
}
const CORE = 2;   // 5x5 core (half=2), matched to ~1.6px FWHM
const RING = 20;  // 41x41 background ring outer half
// matched-filter SNR at integer center (cx,cy)
function mfSNR(cx, cy) {
    const cx0 = cx - CORE, cy0 = cy - CORE, cx1 = cx + CORE + 1, cy1 = cy + CORE + 1;
    const cn = (Math.min(W, cx1) - Math.max(0, cx0)) * (Math.min(H, cy1) - Math.max(0, cy0));
    if (cn < 9) return -1e9;
    const coreSum = boxSum(S, cx0, cy0, cx1, cy1);
    // ring = big box minus core box
    const bx0 = cx - RING, by0 = cy - RING, bx1 = cx + RING + 1, by1 = cy + RING + 1;
    const bigSum = boxSum(S, bx0, by0, bx1, by1), bigSum2 = boxSum(S2, bx0, by0, bx1, by1);
    const bn = (Math.min(W, bx1) - Math.max(0, bx0)) * (Math.min(H, by1) - Math.max(0, by0));
    const ringSum = bigSum - coreSum, ringSum2 = bigSum2 - (boxSum(S2, cx0, cy0, cx1, cy1)), ringN = bn - cn;
    if (ringN < 50) return -1e9;
    const bgMean = ringSum / ringN;
    let bgVar = ringSum2 / ringN - bgMean * bgMean; if (bgVar < 1e-12) bgVar = 1e-12;
    const bgSig = Math.sqrt(bgVar);
    const coreMean = coreSum / cn;
    return Math.sqrt(cn) * (coreMean - bgMean) / bgSig;
}
// peak matched-filter SNR over a radius-R neighborhood (step 2px)
function peakSNR(px, py, R) {
    const cx = Math.round(px), cy = Math.round(py); let peak = -1e9;
    const step = 2, RR = R * R;
    for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) {
        if (dx * dx + dy * dy > RR) continue;
        const s = mfSNR(cx + dx, cy + dy); if (s > peak) peak = s;
    }
    return peak;
}

// deterministic RNG
let rs = 987654321; const rand = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
const NULLN = 200;
function evalSet(label, list) {
    const rows = [];
    for (const p of list) {
        const R = Math.max(15, Math.min(80, Math.round(p.tol)));
        const real = peakSNR(p.px, p.py, R);
        const nulls = [];
        for (let j = 0; j < NULLN; j++) {
            const rx = R + 5 + rand() * (W - 2 * R - 10), ry = R + 5 + rand() * (H - 2 * R - 10);
            nulls.push(peakSNR(rx, ry, R));
        }
        nulls.sort((a, b) => a - b);
        const p99 = nulls[Math.floor(0.99 * NULLN)];
        const nmed = nulls[NULLN >> 1];
        const nmad = 1.4826 * nulls.map(v => Math.abs(v - nmed)).sort((a, b) => a - b)[NULLN >> 1];
        const above = nulls.filter(v => v >= real).length;
        rows.push({ px: p.px, py: p.py, mag: p.mag, R, realPeak: real, nullMed: nmed, nullP99: p99, z: (real - nmed) / (nmad || 1e-9), pval: (above + 1) / (NULLN + 1), sig: real > p99 });
    }
    const sig = rows.filter(r => r.sig);
    console.log(`\n[${label}] n=${rows.length}  recoverable(realPeak>null p99): ${sig.length}/${rows.length}`);
    const zs = rows.map(r => r.z).sort((a, b) => a - b);
    console.log(`  realPeakSNR: min=${Math.min(...rows.map(r => r.realPeak)).toFixed(1)} med=${rows.map(r => r.realPeak).sort((a, b) => a - b)[rows.length >> 1].toFixed(1)} max=${Math.max(...rows.map(r => r.realPeak)).toFixed(1)}`);
    console.log(`  z-vs-null: min=${zs[0].toFixed(1)} med=${zs[zs.length >> 1].toFixed(1)} max=${zs[zs.length - 1].toFixed(1)}`);
    const bins = new Map();
    for (const r of rows) { const b = Math.floor(r.mag); const s = bins.get(b) || { n: 0, sig: 0 }; s.n++; if (r.sig) s.sig++; bins.set(b, s); }
    console.log(`  by mag [mag): n / recoverable`);
    for (const k of [...bins.keys()].sort((a, b) => a - b)) { const s = bins.get(k); console.log(`    ${k}-${k + 1}: ${String(s.n).padStart(3)} / ${s.sig}`); }
    return rows;
}

const Rmiss = evalSet('MISSING (the 80)', missing);
const Rdet = evalSet('DETECTED (39, sanity anchor)', detected);

const out = {
    wcs: { ra0, dec0, thetaDeg, parity, anchorPx: [aCx, aCy] },
    method: { core: 2 * CORE + 1, ringHalf: RING, searchStep: 2, nullN: NULLN, stat: 'sqrt(Ncore)*(coreMean-bgMean)/bgSigma, neighborhood peak' },
    counts: { inframe: proj.length, detected: detected.length, missing: missing.length },
    missing_recoverable: Rmiss.filter(r => r.sig).length, detected_recoverable: Rdet.filter(r => r.sig).length,
    missing: Rmiss, detected: Rdet,
};
const outPath = path.join(ROOT, 'test_results', 'cr2_dets', 'IMG_1410.neighborhood_photometry.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\n-> ${path.relative(ROOT, outPath)}`);
