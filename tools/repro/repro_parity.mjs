// Parity regression for solve_planar_local: synthetic detections built from
// the catalog at the known M66 solution, tested in BOTH orientations.
// Direct parity has always worked; MIRRORED parity (y -> H-y; negative parity,
// i.e. every real FITS bottom-up frame) previously produced only coincidence
// matches because the hash-bin walk ignored the mirrored code (see
// solver_planar.rs PARITY FIX). Exit 0 only when both orientations yield a
// low-error candidate whose top match fits the true scale.
import fs from 'node:fs';
const root = 'k:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY';
const w = await import(`file:///${root}/src/engine/wasm_compute/pkg/wasm_compute.js`);
w.initSync({ module: fs.readFileSync(`${root}/src/engine/wasm_compute/pkg/wasm_compute_bg.wasm`) });

const anchors = JSON.parse(fs.readFileSync(`${root}/public/atlas/level_1_anchors.json`, 'utf8'));
const pattern = JSON.parse(fs.readFileSync(`${root}/public/atlas/level_2_pattern.json`, 'utf8'));
const deep = JSON.parse(fs.readFileSync(`${root}/public/atlas/sectors/level_3_sector_20.json`, 'utf8'));
const atlas = [...anchors, ...pattern, ...deep].map(s => ({ raH: s.ra / 15, dec: s.dec, mag: s.mag_g ?? s.mag }));

const RA0 = 170.425 / 15, DEC0 = 12.8419, SCALE = 3.74, W = 2160, H = 3840;
const D2R = Math.PI / 180;
const gn = (raH, dec) => {
    const a = raH * 15 * D2R, a0 = RA0 * 15 * D2R, d = dec * D2R, d0 = DEC0 * D2R;
    const c = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    return { xi: Math.cos(d) * Math.sin(a - a0) / c / D2R, eta: (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / c / D2R };
};
const degPerPx = SCALE / 3600;
const catPix = atlas
    .map(s => ({ g: gn(s.raH, s.dec), mag: s.mag }))
    .filter(({ g }) => Number.isFinite(g.xi) && Math.hypot(g.xi, g.eta) < 3.0)
    .map(({ g, mag }) => ({ x: W / 2 + g.xi / degPerPx, y: H / 2 - g.eta / degPerPx, mag }))
    .sort((a, b) => a.mag - b.mag);

const inFrame = catPix.filter(p => p.x >= 0 && p.x < W && p.y >= 0 && p.y < H);
console.log(`region stars=${catPix.length}, in-frame=${inFrame.length}`);

// cat side mimics trySolveAtCenter: field circle 1.2x half-diagonal, brightest 50
const halfDiag = Math.hypot(W, H) / 2;
const catSubset = catPix
    .filter(p => Math.hypot(p.x - W / 2, p.y - H / 2) <= halfDiag * 1.2)
    .slice(0, 50);
const catX = new Float64Array(catSubset.map(p => p.x));
const catY = new Float64Array(catSubset.map(p => p.y));
const catIds = new Float64Array(catSubset.map((_, i) => i));
const tolerances = new Float64Array([0.02, 0.05, 0.08, 0.1]);

let allPass = true;
for (const mode of ['direct', 'mirrored']) {
    // det = 30 brightest in-frame stars + 0.5px noise, y-flipped in mirror mode
    const det = inFrame.slice(0, 30).map(p => ({
        x: p.x + (Math.random() - 0.5),
        y: (mode === 'mirrored' ? H - p.y : p.y) + (Math.random() - 0.5),
    }));
    const detX = new Float64Array(det.map(p => p.x));
    const detY = new Float64Array(det.map(p => p.y));
    const detIds = new Float64Array(det.map((_, i) => i));

    const t = Date.now();
    const res = w.solve_planar_local(detX, detY, detIds, catX, catY, catIds, tolerances, 50, undefined);
    const nCand = res.length / 9;
    const bestErr = nCand ? res[8] : NaN;

    // Check the best candidate's correspondence: det i <-> catSubset j should
    // be the same physical star (det was BUILT from inFrame == catSubset head).
    let correct = 0;
    if (nCand) {
        for (let k = 0; k < 4; k++) {
            const dIdx = Math.round(res[k]);       // index into det (== inFrame order)
            const cIdx = Math.round(res[4 + k]);   // index into catSubset
            const truth = inFrame[dIdx];
            const got = catSubset[cIdx];
            if (truth && got && Math.hypot(truth.x - got.x, truth.y - got.y) < 1.5) correct++;
        }
    }
    const pass = nCand > 0 && bestErr < 1e-4 && correct === 4;
    allPass &&= pass;
    console.log(`${mode.padEnd(8)}: candidates=${nCand} bestErr=${nCand ? bestErr.toExponential(2) : '-'} correctCorrespondence=${correct}/4 [${pass ? 'PASS' : 'FAIL'}] (${Date.now() - t}ms)`);
}
process.exit(allPass ? 0 : 1);
