#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// VIGNETTE → MASTER-FLAT FITS EMITTER (tools/calib interchange lane)
// ═══════════════════════════════════════════════════════════════════════════
// Turns a vignette model — either our internal a2/a4 per-band map (from
// m10_psf/vignette_map.ts, serialized) OR an ingested lensfun "pa" breakpoint
// (from m2_hardware/lensfun_ingestor.ts) — into a STANDARD master-flat FITS that
// any other program (PixInsight / Siril / NINA flats workflow) can consume. It is
// the bidirectional-interchange emit half of PSF_RENDER_PROGRAM_AUDIT item 9.
//
// The flat is the radial TRANSMISSION map, BITPIX=-32, normalized to EXACTLY 1.0
// at the optical center (a light frame is FLATTENED by dividing by this). We write
// NO WCS — just image planes + FLAT/provenance header cards — so the RA-HOURS
// conversion trap in tools/stack/fits_io.mjs (wcsCards, the ×15 boundary) is never
// touched. Tier APPROXIMATE: this is a book/fit PRIOR, not a light-box master flat.
//
// LAW 1: PIXEL-plane / prior data plumbing only; no measurement path is touched;
// nothing here is wired into a consumer (the per-star 4-way application rides the
// trusted-fit gate). The byte machinery reuses the shipped, verified
// tools/stack/fits_io.mjs writer (LAW 4 — no FITS writer in two places).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFitsPlanar } from '../stack/fits_io.mjs';
import { renderFlatPlane, bandsFromVignetteMap, bandFromLensfunPA } from './vignette_eval.mjs';

/**
 * Build the FLAT + provenance header cards. Standard flat keywords the common
 * tools recognize, plus HISTORY provenance describing the source model, the
 * normalization, and the APPROXIMATE tier (honest-or-absent — no fake calibration
 * claim). HISTORY cards go through the fits_io writer's bare-card path.
 */
function flatCards({ bands, center, halfDiagPx, provenance }) {
    const kind = bands[0].model.kind;
    const keyword = [
        ['IMAGETYP', 'Master Flat', 'synthetic vignette flat (normalized)'],
        ['BUNIT', 'relative', 'transmission, 1.0 at optical center'],
        ['CALTIER', 'APPROXIMATE', 'book/fit prior — NOT a measured light-box flat'],
        ['VIGMODEL', kind === 'pa' ? 'lensfun-pa' : 'gain-a2a4', 'source vignette model family'],
        ['CENTERX', center.cx, 'optical center x (0-based px)'],
        ['CENTERY', center.cy, 'optical center y (0-based px)'],
        ['HALFDIAG', halfDiagPx, 'r-normalization length (px); r=1 at corner'],
        ['NPLANE', bands.length, 'number of emitted bands'],
    ];
    const hist = [
        `SkyCruncher tools/calib/emit_vignette_flat.mjs @ ${new Date().toISOString()}`,
        'Master flat = radial TRANSMISSION, normalized to 1.0 at the optical center.',
        'r normalized to half-diagonal (r=1 at image corner) — hugin/lensfun/vignette_map convention.',
        'Tier APPROXIMATE: book/fit prior, NOT a measured light-box master flat.',
    ];
    for (const b of bands) {
        if (b.model.kind === 'pa') {
            hist.push(`band ${b.name}: lensfun-pa att(r)=1+k1*r2+k2*r4+k3*r6 flat=att`
                + ` k1=${b.model.k1} k2=${b.model.k2} k3=${b.model.k3}`);
        } else {
            hist.push(`band ${b.name}: gain(r)=1+a2*r2+a4*r4 flat=1/gain`
                + ` a2=${b.model.a2} a4=${b.model.a4}`);
        }
    }
    if (provenance) for (const line of [].concat(provenance)) hist.push(String(line));
    return [...keyword, ...hist.map((h) => ['HISTORY', h])];
}

/**
 * Emit the flat planes + cards for a spec (no file I/O — the testable core).
 * @param {{ w:number, h:number, bands:{name:string,model:object}[],
 *           center?:{cx:number,cy:number}, halfDiagPx?:number,
 *           provenance?:string|string[] }} spec
 * @returns {{ planes: Float32Array[], cards: any[][], center: {cx:number,cy:number}, halfDiagPx: number }}
 */
export function emitVignetteFlat(spec) {
    const { w, h } = spec;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
        throw new Error(`emitVignetteFlat: bad dims ${w}x${h}`);
    }
    if (!Array.isArray(spec.bands) || spec.bands.length === 0) {
        throw new Error('emitVignetteFlat: spec.bands must be a non-empty array');
    }
    const cx = spec.center ? spec.center.cx : (w - 1) / 2;
    const cy = spec.center ? spec.center.cy : (h - 1) / 2;
    const center = { cx, cy };
    const halfDiagPx = spec.halfDiagPx || Math.hypot(cx, cy);
    const planes = spec.bands.map((b) => renderFlatPlane({ w, h, model: b.model, center, halfDiagPx }));
    const cards = flatCards({ bands: spec.bands, center, halfDiagPx, provenance: spec.provenance });
    return { planes, cards, center, halfDiagPx };
}

/**
 * Emit + write a master-flat FITS to `outPath`. Returns a small manifest.
 * @param {string} outPath
 * @param {Parameters<typeof emitVignetteFlat>[0]} spec
 */
export function writeVignetteFlat(outPath, spec) {
    const { planes, cards, center, halfDiagPx } = emitVignetteFlat(spec);
    writeFitsPlanar(outPath, planes, spec.w, spec.h, cards);
    return { outPath, planeCount: planes.length, center, halfDiagPx };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
// Usage:
//   node tools/calib/emit_vignette_flat.mjs --model <model.json> --out <flat.fits>
//                                           [--width N --height N] [--bands rgb|luma]
//
// model.json is one of:
//   { "source":"vignette_map", "map": <serializeVignetteMap output>, "width":W, "height":H }
//   { "source":"lensfun_pa",   "breakpoint": {k1,k2,k3}, "width":W, "height":H }
// (a top-level --width/--height overrides the JSON dims; --bands selects rgb vs luma
//  for a vignette_map source.)

function parseArgv(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) { o[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    }
    return o;
}

/** Build the emit spec from a parsed model.json + CLI overrides. */
export function specFromModelJson(model, opts = {}) {
    const w = Number(opts.width ?? model.width ?? model.w);
    const h = Number(opts.height ?? model.height ?? model.h);
    if (!Number.isInteger(w) || !Number.isInteger(h)) {
        throw new Error('emit CLI: width/height required (via --width/--height or model.json)');
    }
    let bands;
    let provenance;
    if (model.source === 'lensfun_pa') {
        const bp = model.breakpoint ?? model;
        bands = bandFromLensfunPA(bp, model.name ?? 'pa');
        provenance = `source: lensfun_pa ${model.lens ?? ''} focal=${bp.focal ?? '?'} aperture=${bp.aperture ?? '?'}`.trim();
    } else if (model.source === 'vignette_map' || model.r) {
        const map = model.map ?? model;
        bands = bandsFromVignetteMap(map, (opts.bands ?? 'rgb') === 'luma' ? 'luma' : 'rgb');
        provenance = `source: vignette_map grid_n=${map.grid_n ?? map.gridN ?? '?'}`;
    } else {
        throw new Error(`emit CLI: unknown model.source "${model.source}"`);
    }
    const center = model.center
        ? { cx: model.center.cx, cy: model.center.cy }
        : undefined;
    const halfDiagPx = model.half_diag_px ?? model.halfDiagPx;
    return { w, h, bands, center, halfDiagPx, provenance };
}

function main() {
    const opts = parseArgv(process.argv.slice(2));
    if (!opts.model || !opts.out) {
        console.error('usage: emit_vignette_flat.mjs --model <model.json> --out <flat.fits> [--width N --height N] [--bands rgb|luma]');
        process.exit(2);
    }
    const model = JSON.parse(fs.readFileSync(opts.model, 'utf8'));
    const spec = specFromModelJson(model, opts);
    const res = writeVignetteFlat(path.resolve(opts.out), spec);
    console.log(`[emit_vignette_flat] wrote ${res.outPath}: ${res.planeCount} plane(s), `
        + `${spec.w}x${spec.h}, center=(${res.center.cx},${res.center.cy}), halfDiag=${res.halfDiagPx.toFixed(2)}px`);
}

// Run main() only when invoked directly (not on import from a test).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
