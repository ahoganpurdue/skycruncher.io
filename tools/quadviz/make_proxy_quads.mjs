#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/quadviz/make_proxy_quads.mjs — v0 PROXY quad-record synthesizer
// ═══════════════════════════════════════════════════════════════════════════
// The per-iteration overlay renderer (render_overlay.mjs) draws det-quad
// polylines from a quad_gen/solve_blind "winning cluster" record. As of
// 2026-07-18 NO banked record carries that geometry: the winning-cluster member
// det-quad PIXEL coordinates live only transiently inside a live solve_blind /
// engine quad_gen run (they ride diagnostics.forensics only when the flag is on
// and a fail path is hit; the banked calibration/report artifacts carry counts,
// not points). This surgeon lane may run ONLY its own render CLI, so a live
// record cannot be produced here.
//
// To PROVE the quad-line visual language on real geometry without fabricating
// anything, this tool forms det-quads OFFLINE from a solved receipt's REAL
// matched-star pixel detections: each quad = a bright anchor detection + its
// three nearest detected neighbours (the same "local 4-tuple over detections"
// shape solve_blind enumerates). The points are genuine measured detections;
// only the CLUSTER SELECTION is a proxy. The output is stamped with an explicit
// provenance string that render_overlay.mjs prints into the legend, so nobody
// can mistake it for a live quad_gen winning cluster (honest-or-absent, LAW 3).
//
// Output shape is the exact contract render_overlay.mjs consumes, so when a
// live quad_gen record lands (receipt quad_gen block, 2.29.0) it drops in
// unchanged.
//
//   node tools/quadviz/make_proxy_quads.mjs --wcs <receipt.json> --out <quads.json> [--n 12]
//
import fs from 'node:fs';
import path from 'node:path';

const A = process.argv.slice(2);
const arg = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d; };
const WCS = arg('--wcs');
const OUT = arg('--out');
const NQUADS = parseInt(arg('--n', '12'), 10);
if (!WCS || !OUT) { console.error('usage: --wcs <receipt.json> --out <quads.json> [--n 12]'); process.exit(2); }

const src = JSON.parse(fs.readFileSync(WCS, 'utf8'));
const ms = (src?.solution?.matched_stars || src?.matched_stars || [])
    .filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y))
    .map((s) => ({ x: s.x, y: s.y, flux: Number.isFinite(s.flux) ? s.flux : 0 }));
if (ms.length < 4) { console.error(`need >=4 matched detections with pixel x/y (got ${ms.length})`); process.exit(1); }

// brightest detections first -> anchors
const byFlux = ms.slice().sort((a, b) => b.flux - a.flux);
const anchors = byFlux.slice(0, Math.min(NQUADS, byFlux.length));

const members = [];
const seen = new Set();
for (const anc of anchors) {
    // 3 nearest OTHER detections to this anchor
    const near = ms
        .filter((p) => p !== anc)
        .map((p) => ({ p, d: Math.hypot(p.x - anc.x, p.y - anc.y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map((o) => o.p);
    if (near.length < 3) continue;
    const quad = [anc, ...near];
    const key = quad.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).sort().join('|');
    if (seen.has(key)) continue; seen.add(key);
    members.push({ detPts: quad.map((p) => ({ x: p.x, y: p.y })), anchor_flux: anc.flux });
}

const out = {
    // NOTE: legend font (bubble_tiles FONT) has no ';' glyph — keep the honest
    // label to supported chars (A-Z 0-9 space - . : / ( ) " , =) so it stays legible.
    provenance: 'V0 PROXY - QUADS FORMED OFFLINE FROM BANKED MATCHED-STAR DETECTIONS - NOT A LIVE QUAD_GEN WINNING CLUSTER',
    source_receipt: path.basename(WCS),
    iteration: null,
    bound: null,
    winning_cluster: { votes: null, members },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`[make_proxy_quads] ${members.length} proxy det-quads from ${ms.length} detections -> ${OUT}`);
