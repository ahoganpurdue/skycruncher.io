#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// M4b MINI-INDEX GENERATOR — tiny synthetic release via the REAL index builder
// ═══════════════════════════════════════════════════════════════════════════
// Builds a small all-synthetic release with the PRODUCTION writer
// (rest-integration/tools/quadindex/build_quad_index.mjs: buildQuadIndex +
// serializeIndex — the exact on-disk contract the M1 reader strict-validates),
// plus rendered detection sets:
//   detections_positive.json   — catalog stars projected through the TRUTH TAN
//                                pose (exact, no noise), shuffled order
//   detections_scrambled.json  — same star count, positions seeded-uniform
//   detections_scrambled_big.json — 600 uniform detections (cancellation load)
//   truth.json                 — the truth pose (decimals + f64 bit patterns)
//
// The 15-band g15u annulus ladder is used so the manifest passes the reader's
// EXPECTED_BANDS validation; the synthetic star density populates only the
// mid/wide bands (empty bands are a legal, validated release state).
//
// Deterministic: mulberry32 seeds, no wall-clock in outputs.
// cwd-independent (absolute paths via import.meta.url).
// Regenerate: node crates/conformance/mini_index/gen_mini_index.mjs
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// rest-integration is a sibling checkout of the repo; override via SKYCRUNCHER_REST_CHECKOUT
const REST = process.env.SKYCRUNCHER_REST_CHECKOUT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '../rest-integration');
const { buildQuadIndex, serializeIndex } = await import(
    pathToFileURL(path.join(REST, 'tools/quadindex/build_quad_index.mjs')).href);
const { gnomonic } = await import(
    pathToFileURL(path.join(REST, 'tools/solverkit/band_hash.mjs')).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '../../solver-core/tests/fixtures/mini_index');
const RELEASE = 'mini-synth-g15u-1';

// ── deterministic PRNG (mulberry32 — repo standard) ─────────────────────────
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const _f64 = new Float64Array(1); const _b64 = new BigUint64Array(_f64.buffer);
const f64hex = (x) => { _f64[0] = x; return '0x' + _b64[0].toString(16).padStart(16, '0'); };

// ── synthetic sky: 500 stars over RA [40,80] × Dec [−15,25] ────────────────
const rng = mulberry32(0xA57C0);
const N_STARS = 300;
const stars = [];
for (let i = 0; i < N_STARS; i++) {
    const ra = 40 + rng() * 40;
    // uniform on the sphere within the dec band: sample sin(dec)
    const sLo = Math.sin(-15 * Math.PI / 180), sHi = Math.sin(25 * Math.PI / 180);
    const dec = Math.asin(sLo + rng() * (sHi - sLo)) * 180 / Math.PI;
    const mag = 3 + 9 * Math.sqrt(rng()); // brighter rarer
    stars.push({ ra_deg: ra, dec_deg: dec, mag, source_id: BigInt(100000 + i) });
}
stars.sort((a, b) => a.mag - b.mag); // catalogStars contract: g-ascending

// ── build the index with the REAL builder over the g15u annulus ladder ─────
const EDGES = []; // 0.25·√2^k, k=0..15 (the g15u 15-band ladder)
for (let k = 0; k <= 15; k++) EDGES.push(0.25 * Math.pow(Math.SQRT2, k));
const DEPTHS = new Array(15).fill(20); // every synthetic star qualifies
const idx = buildQuadIndex(
    { stars, release: 'mini-synthetic-sky' },
    { bands: EDGES, depths: DEPTHS, neighbors: 12, interior: 8, quadsPerPair: 6, quadCap: 6000, nbins: 128 },
);
fs.rmSync(path.join(OUT_DIR, RELEASE), { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const manifest = serializeIndex(idx, OUT_DIR, RELEASE, { batchRows: 128 });
console.log(`release ${RELEASE}: ${manifest.totals.quads} quads, ${manifest.totals.stars} stars, ${manifest.totals.bytes} bytes`);
for (const b of manifest.bands) if (b.nQuads > 0) console.log(`  band ${b.index} [${b.loDeg.toFixed(2)}, ${b.hiDeg.toFixed(2)}): ${b.nQuads} quads`);

// ── truth pose (engine convention: crpix = frame center 0-based, y-down px) ─
const W = 1200, H = 900;
const S_ASEC = 60.0;                    // 60″/px → 20°×15° frame, radius > 5° (wide gather path)
const S = S_ASEC / 3600;                // deg/px
const ROT = 25.0 * Math.PI / 180;
const PARITY = 1;                       // engine convention: parity 1 ⇔ det(CD) < 0
const SIGMA = PARITY === 1 ? -1 : 1;
const CRVAL = { ra: 61.3, dec: 6.2 };
const CD = [
    [S * Math.cos(ROT), SIGMA * S * -Math.sin(ROT)],
    [S * Math.sin(ROT), SIGMA * S * Math.cos(ROT)],
];
const CRPIX = { x: W / 2, y: H / 2 };
const DET = CD[0][0] * CD[1][1] - CD[0][1] * CD[1][0];

// sky → px through the truth TAN (band_hash gnomonic = the engine's convention)
function skyToPx(ra, dec) {
    const t = gnomonic(ra, dec, CRVAL.ra, CRVAL.dec);
    if (!t) return null;
    const xi = t.x, eta = t.y;
    const dx = (xi * CD[1][1] - eta * CD[0][1]) / DET;
    const dy = (eta * CD[0][0] - xi * CD[1][0]) / DET;
    return { x: CRPIX.x + dx, y: CRPIX.y + dy };
}

// ── positive detections: catalog stars in-frame, exact positions, shuffled ──
const dets = [];
for (const s of stars) {
    const p = skyToPx(s.ra_deg, s.dec_deg);
    if (!p || p.x < 4 || p.x >= W - 4 || p.y < 4 || p.y >= H - 4) continue;
    const flux = Math.pow(10, -0.4 * (s.mag - 15));
    dets.push({
        id: dets.length, x: p.x, y: p.y, flux,
        peak_value: Math.min(0.22, flux * 1e-3), fwhm: 3.1, snr: 25.0,
        true_source_id: Number(s.source_id), true_mag: s.mag,
    });
}
// shuffle (deterministic) so pool order ≠ catalog order
const shuf = mulberry32(0xBEEF);
for (let i = dets.length - 1; i > 0; i--) {
    const j = Math.floor(shuf() * (i + 1));
    [dets[i], dets[j]] = [dets[j], dets[i]];
}
console.log(`positive detections in-frame: ${dets.length}`);

function writeDetections(name, rows) {
    fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify({
        frame: name.replace(/\.json$/, ''), source: 'gen_mini_index.mjs synthetic', count: rows.length,
        detections: rows,
    }, null, 1));
}
writeDetections('detections_positive.json', dets);

// ── scrambled negatives: seeded-uniform positions, same brightness ladder ───
function scrambled(seed, n) {
    const r = mulberry32(seed);
    const rows = [];
    for (let i = 0; i < n; i++) {
        rows.push({
            id: i, x: 4 + r() * (W - 8), y: 4 + r() * (H - 8),
            flux: Math.pow(10, -0.4 * (3 + 9 * Math.sqrt(r()) - 15)),
            peak_value: 0.01 + r() * 0.2, fwhm: 3.1, snr: 25.0,
        });
    }
    return rows;
}
writeDetections('detections_scrambled.json', scrambled(0x5C4A, dets.length));
writeDetections('detections_scrambled_big.json', scrambled(0x5C4B, 600));

// ── truth pose record (decimals for bounds asserts; bits for exactness work) ─
fs.writeFileSync(path.join(OUT_DIR, 'truth.json'), JSON.stringify({
    release: RELEASE,
    w: W, h: H,
    crval_ra_deg: CRVAL.ra, crval_dec_deg: CRVAL.dec,
    scale_asec_px: S_ASEC, rot_deg: 25.0, parity: PARITY, parity_sign: SIGMA,
    cd: CD,
    bits: {
        crval_ra: f64hex(CRVAL.ra), crval_dec: f64hex(CRVAL.dec),
        cd00: f64hex(CD[0][0]), cd01: f64hex(CD[0][1]),
        cd10: f64hex(CD[1][0]), cd11: f64hex(CD[1][1]),
    },
}, null, 2));
console.log(`fixtures → ${OUT_DIR}`);
