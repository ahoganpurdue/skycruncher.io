// Headless repro of the wizard plate-solve using the REAL wasm + REAL atlas.
// Synthetic detections are catalog stars projected at the KNOWN solution
// (FITS header: RA 170.425 deg = 11.3617h, Dec +12.842, scale 3.74"/px).
import fs from 'node:fs';
import { initSync, solve_planar_local, solve_spherical_global } from 'file:///k:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY/src/engine/wasm_compute/pkg/wasm_compute.js';

const root = 'k:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY';
initSync({ module: fs.readFileSync(`${root}/src/engine/wasm_compute/pkg/wasm_compute_bg.wasm`) });

const anchors = JSON.parse(fs.readFileSync(`${root}/public/atlas/level_1_anchors.json`, 'utf8'));
const pattern = JSON.parse(fs.readFileSync(`${root}/public/atlas/level_2_pattern.json`, 'utf8'));
const deep = JSON.parse(fs.readFileSync(`${root}/public/atlas/sectors/level_3_sector_20.json`, 'utf8'));
const atlas = [...anchors, ...pattern, ...deep].map(s => ({ raH: s.ra / 15, dec: s.dec, mag: s.mag_g }));

const RA0 = 170.425 / 15, DEC0 = 12.8419, SCALE = 3.74, W = 2160, H = 3840;
const D2R = Math.PI / 180;

function angSep(ra1h, dec1, ra2h, dec2) {
    const a1 = ra1h * 15 * D2R, a2 = ra2h * 15 * D2R, d1 = dec1 * D2R, d2 = dec2 * D2R;
    return Math.acos(Math.min(1, Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2))) / D2R;
}
function gnomonic(raH, dec, ra0H, dec0) {
    const a = raH * 15 * D2R, a0 = ra0H * 15 * D2R, d = dec * D2R, d0 = dec0 * D2R;
    const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
    return {
        xi: (Math.cos(d) * Math.sin(a - a0)) / cosc / D2R,
        eta: (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc / D2R
    };
}

// catalog region: 4 deg radius around the hint (== header truth here)
const region = atlas.filter(s => angSep(s.raH, s.dec, RA0, DEC0) < 4).sort((a, b) => a.mag - b.mag);
const degPerPx = SCALE / 3600;
const catPix = region.map(s => {
    const { xi, eta } = gnomonic(s.raH, s.dec, RA0, DEC0);
    return { x: W / 2 + xi / degPerPx, y: H / 2 - eta / degPerPx, mag: s.mag };
});
const inFrame = catPix.filter(p => p.x >= 0 && p.x < W && p.y >= 0 && p.y < H);
console.log(`atlas total=${atlas.length}, region(4deg)=${region.length}, in-frame=${inFrame.length}`);
console.log('in-frame mags:', inFrame.map(p => p.mag.toFixed(1)).join(' '));

// synthetic detections: in-frame catalog stars + 0.5px noise, brightest 30
const det = inFrame.slice(0, 30).map(p => ({ x: p.x + (Math.random() - 0.5), y: p.y + (Math.random() - 0.5) }));
const detX = new Float64Array(det.map(p => p.x)), detY = new Float64Array(det.map(p => p.y));
const detIds = new Float64Array(det.map((_, i) => i));

// mimic new trySolveAtCenter: radius filter to 1.2x half-diagonal, budget 50
const halfDiagPx = Math.hypot(W, H) / 2;
const catSubset = catPix
    .filter(p => ((p.x - W / 2) ** 2 + (p.y - H / 2) ** 2) <= (halfDiagPx * 1.2) ** 2)
    .slice(0, 50);
console.log(`catSubset after field filter: ${catSubset.length}`);
const catX = new Float64Array(catSubset.map(p => p.x)), catY = new Float64Array(catSubset.map(p => p.y));
const catIds = new Float64Array(catSubset.map((_, i) => i));
const tolerances = new Float64Array([0.02, 0.05, 0.08, 0.1]);

for (const budget of [50]) {
    const t = Date.now();
    const res = solve_planar_local(detX, detY, detIds, catX, catY, catIds, tolerances, budget, undefined);
    console.log(`solve_planar_local(max_stars=${budget}): ${res.length / 9} candidate quads in ${Date.now() - t}ms` +
        (res.length ? `, best err=${res[8].toExponential(2)}` : ''));
}

// reproduce the spherical panic
try {
    const t = Date.now();
    const res = solve_spherical_global(detX, detY, 160, 0.0029, W / 2, H / 2, 46.2184, -84.068, 2461176.663, 0.1);
    console.log(`solve_spherical_global: ${res.length / 13} candidates in ${Date.now() - t}ms`);
} catch (e) {
    console.log('solve_spherical_global PANIC reproduced:', e.message);
}
