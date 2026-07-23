// EMIT VIGNETTE FLAT — round-trip: model → FITS → read back → values match model.
// Exercises the shared evaluator (vignette_eval.mjs), the emitter
// (emit_vignette_flat.mjs), and the fits_io.mjs writer's new HISTORY-card path.
// Node env; vitest picks up *.test.mjs; tsc ignores it (tsconfig include=["src"]).

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openFits, readPlaneRaw, readFitsHeaderFd } from '../stack/fits_io.mjs';
import { transmissionAtR2, renderFlatPlane } from './vignette_eval.mjs';
import { emitVignetteFlat, writeVignetteFlat, specFromModelJson } from './emit_vignette_flat.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigflat-'));
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

// Odd dims → the geometric center ((w-1)/2,(h-1)/2) lands on an EXACT pixel, so
// the "1.0 at optical center" invariant is a bit-exact assertion.
const W = 65, H = 49;
const CX = (W - 1) / 2, CY = (H - 1) / 2;
const CENTER_IDX = CY * W + CX;

describe('vignette_eval — transmission formulas', () => {
    it('both model kinds are exactly 1.0 at the center (r²=0)', () => {
        expect(transmissionAtR2({ kind: 'gain', a2: 1.5, a4: -0.8 }, 0)).toBe(1);
        expect(transmissionAtR2({ kind: 'pa', k1: -1.02, k2: 0.08, k3: 0 }, 0)).toBe(1);
    });

    it('gain transmission = 1/gain; pa transmission = att directly', () => {
        expect(transmissionAtR2({ kind: 'gain', a2: 1, a4: 0 }, 0.5)).toBeCloseTo(1 / 1.5, 12);
        expect(transmissionAtR2({ kind: 'pa', k1: -1.02, k2: 0.08, k3: 0 }, 0.674)).toBeCloseTo(0.349, 3);
    });

    it('renderFlatPlane peaks at 1.0 at the center and falls off toward the corner', () => {
        const model = { kind: 'pa', k1: -1.02, k2: 0.08, k3: 0 };
        const plane = renderFlatPlane({ w: W, h: H, model });
        expect(plane[CENTER_IDX]).toBe(1);
        expect(plane[0]).toBeLessThan(1);            // corner < center
        expect(Math.max(...plane)).toBeCloseTo(1, 6); // center is the max
    });
});

describe('emit_vignette_flat — single-plane pa flat round-trip', () => {
    const model = { kind: 'pa', k1: -1.02, k2: 0.08, k3: 0 };
    const spec = { w: W, h: H, bands: [{ name: 'pa', model }], provenance: 'test: XF23mmF2 f/2 synthetic' };
    const out = path.join(TMP, 'flat_pa.fits');

    it('emits one -32 plane and reads back bit-identical to the model', () => {
        const { planes } = emitVignetteFlat(spec);
        expect(planes).toHaveLength(1);
        writeVignetteFlat(out, spec);

        const f = openFits(out);
        try {
            expect(f.BITPIX).toBe(-32);
            expect(f.W).toBe(W);
            expect(f.H).toBe(H);
            expect(f.NP).toBe(1);
            const back = readPlaneRaw(f, 0);
            // center bit-exact 1.0
            expect(back[CENTER_IDX]).toBe(1);
            // read-back is bit-identical to the emitted float32 plane at samples
            for (const idx of [0, CENTER_IDX, 12 * W + 7, 40 * W + 60, W * H - 1]) {
                expect(back[idx]).toBe(planes[0][idx]);
            }
            // ... and each matches the continuous model formula (float32 tol)
            const hd2 = (CX * CX + CY * CY);
            for (const [x, y] of [[0, 0], [64, 48], [10, 30], [50, 5]]) {
                const r2 = ((x - CX) ** 2 + (y - CY) ** 2) / hd2;
                expect(back[y * W + x]).toBeCloseTo(transmissionAtR2(model, r2), 5);
            }
        } finally { f.close(); }
    });

    it('writes standard FLAT keywords + HISTORY provenance cards', () => {
        const fd = fs.openSync(out, 'r');
        try {
            const { cards, hdrEnd } = readFitsHeaderFd(fd);
            expect(cards.IMAGETYP).toBe('Master Flat');
            expect(cards.CALTIER).toBe('APPROXIMATE');
            expect(cards.VIGMODEL).toBe('lensfun-pa');
            // HISTORY cards carry no "= value" so readFitsHeaderFd doesn't key them;
            // confirm they exist by scanning the raw header block.
            const raw = Buffer.alloc(hdrEnd);
            fs.readSync(fd, raw, 0, hdrEnd, 0);
            const text = raw.toString('latin1');
            expect(text).toContain('HISTORY ');
            expect(text).toContain('emit_vignette_flat.mjs');
            expect(text).toContain('half-diagonal');
        } finally { fs.closeSync(fd); }
    });
});

describe('emit_vignette_flat — 3-plane gain flat from a vignette_map shape', () => {
    // vignette_map-serialized shape: per-band {a2,a4}; flat = 1/gain per band.
    const map = {
        source: 'vignette_map',
        width: W, height: H,
        r: { a2: 1.4, a4: -0.6 },
        g: { a2: 1.2, a4: -0.5 },
        b: { a2: 1.6, a4: -0.7 },
        luma: { a2: 1.3, a4: -0.55 },
        grid_n: 16,
    };
    const out = path.join(TMP, 'flat_rgb.fits');

    it('emits 3 planes, each 1.0 at center, each = 1/gain', () => {
        const spec = specFromModelJson(map, { bands: 'rgb' });
        expect(spec.bands).toHaveLength(3);
        writeVignetteFlat(out, spec);

        const f = openFits(out);
        try {
            expect(f.NP).toBe(3);
            const gains = [
                { a2: 1.4, a4: -0.6 },
                { a2: 1.2, a4: -0.5 },
                { a2: 1.6, a4: -0.7 },
            ];
            const hd2 = (CX * CX + CY * CY);
            for (let p = 0; p < 3; p++) {
                const back = readPlaneRaw(f, p);
                expect(back[CENTER_IDX]).toBe(1);
                const x = 12, y = 8;
                const r2 = ((x - CX) ** 2 + (y - CY) ** 2) / hd2;
                const expected = 1 / (1 + gains[p].a2 * r2 + gains[p].a4 * r2 * r2);
                expect(back[y * W + x]).toBeCloseTo(expected, 5);
            }
        } finally { f.close(); }
    });

    it('a luma spec emits a single plane', () => {
        const spec = specFromModelJson(map, { bands: 'luma' });
        expect(spec.bands).toHaveLength(1);
        expect(spec.bands[0].name).toBe('luma');
    });
});
