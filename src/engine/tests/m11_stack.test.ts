// ═══════════════════════════════════════════════════════════════════════════
// M11 STACK — dither/drizzle unit battery (HERMETIC: synthetic frames, the
// setup.ts wasm mock supplies the trig; no atlas, no real FITS, no decode).
// ═══════════════════════════════════════════════════════════════════════════
//
// Pins the properties that make the stacking lane trustworthy:
//   • FLAG SEMANTICS — VITE_STACK_ENABLED default OFF, call-time read;
//   • DITHER MEASUREMENT — known injected sub-pixel WCS offsets are recovered
//     from the fitted WCS alone (no separate registration estimator);
//   • DRIZZLE SHARPNESS — a point source drizzled from dithered subs measures
//     SHARPER (arcsec moment-FWHM, same measure both sides) than any single
//     sub: the task's acceptance oracle on exact synthetic data;
//   • DETERMINISM — identical inputs → bit-identical output plane;
//   • √N HONESTY — duplicate-sha and near-simultaneous inputs are excluded;
//   • BATCH WIRING — flag OFF ⇒ runBatch ledger/artifacts byte-identical (no
//     `stack` key, no stack dir, no module load); flag ON ⇒ the stack step is
//     REACHABLE end-to-end (FITS + kind:'stack' receipt on disk).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isStackingEnabled } from '@/engine/pipeline/m11_stack/stack_flag';
import {
    drizzleFrames,
    computeOutputGrid,
    measureDitherOffsets,
    measureMomentFwhm,
    pickReference,
    pixelScaleArcsec,
    skyToGridPix,
    type StackFrameInput,
} from '@/engine/pipeline/m11_stack/drizzle_stack';
import {
    stackSolvedFrames,
    screenCorrelatedInputs,
    fittedWcsFromReceipt,
} from '@/engine/pipeline/m11_stack/stack_frames';
import { runBatch, type BatchSolveFn } from '../../../tools/batch/batch_engine';

// ─── synthetic frame factory ────────────────────────────────────────────────
// Frames share crval/cd; crpix is shifted by (dx, dy) so the SAME sky point
// (the tangent point) lands at pixel (base + shift) — a pure sub-pixel dither
// encoded exactly the way real solves encode it: in the fitted WCS.

const SCALE_ARCSEC = 2.0;               // input scale "/px
const SDEG = SCALE_ARCSEC / 3600;
const W = 64, H = 64;
const BASE = 31.5;                      // star pixel in the unshifted frame
const SIGMA_PX = 0.8;                   // synthetic PSF sigma (input px)
const AMP = 1000, BG = 10;

function renderFrame(starX: number, starY: number, seed = 0): Float32Array {
    const plane = new Float32Array(W * H);
    const SS = 5; // 5×5 subpixel integration (pixel-integrated flux, like a sensor)
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let s = 0;
            for (let v = 0; v < SS; v++) {
                for (let u = 0; u < SS; u++) {
                    const px = x - 0.5 + (u + 0.5) / SS;
                    const py = y - 0.5 + (v + 0.5) / SS;
                    const r2 = (px - starX) * (px - starX) + (py - starY) * (py - starY);
                    s += Math.exp(-r2 / (2 * SIGMA_PX * SIGMA_PX));
                }
            }
            const i = y * W + x;
            // DETERMINISTIC pseudo-noise (amplitude 0.05 ≪ AMP): a truly
            // constant background has MAD σ = 0 → inverse-variance weight 0 →
            // the kernel honestly refuses the stack. Real frames always carry
            // noise; the synthetic ones must too for the weights to be real.
            const noise = 0.05 * Math.sin(12.9898 * (i + 1) + 78.233 * (seed + 1));
            plane[i] = BG + noise + AMP * (s / (SS * SS));
        }
    }
    return plane;
}

function makeFrame(id: string, dx: number, dy: number, tsOffsetS: number, seed = 0): StackFrameInput {
    const plane = renderFrame(BASE + dx, BASE + dy, seed);
    return {
        id,
        frameSha: `sha_${id}`,
        wcs: {
            crpix: [BASE + dx, BASE + dy],
            crval: [10, 45],            // tangent point = the star's sky position
            cd: [[-SDEG, 0], [0, SDEG]],
        },
        width: W,
        height: H,
        getPlane: () => plane,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, tsOffsetS)).toISOString(),
        exposureS: 240,
    };
}

const DITHERS: Array<[number, number]> = [[0, 0], [0.4, 0.7], [-0.3, 0.55], [0.25, -0.45]];
const PARAMS = { scaleFactor: 2, pixfrac: 0.5 };

/** Naive INTERPOLATION-based reference combine (what drizzle replaces): for a
 *  window around `star`, inverse-map each grid pixel → sky → frame pixel and
 *  bilinear-sample the background-subtracted frame; equal-weight mean. Same
 *  grid, same measure — only the resampling method differs. */
async function bilinearReferenceStack(
    frames: StackFrameInput[],
    grid: { crval: [number, number]; crpix: [number, number]; sdeg: number },
    star: { x: number; y: number },
    halfWin: number
): Promise<{ plane: Float32Array; w: number; h: number; x0: number; y0: number }> {
    const { SkyTransform } = await import('@/engine/core/SkyTransform');
    const x0 = Math.round(star.x) - halfWin - 16, y0 = Math.round(star.y) - halfWin - 16;
    const w = 2 * (halfWin + 16) + 1, h = w;
    const plane = new Float32Array(w * h);
    const bgOf: number[] = [];
    const planes: Float32Array[] = [];
    for (const f of frames) {
        const p = (await f.getPlane()) as Float32Array;
        planes.push(p);
        const sorted = Array.from(p).sort((a, b) => a - b);
        bgOf.push(sorted[sorted.length >> 1]);
    }
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            const gx = x0 + i, gy = y0 + j;
            const xi = -(gx - grid.crpix[0]) * grid.sdeg;
            const eta = (gy - grid.crpix[1]) * grid.sdeg;
            const sky = SkyTransform.inverseGnomonic(xi, eta, grid.crval[0], grid.crval[1]);
            let sum = 0, n = 0;
            for (let k = 0; k < frames.length; k++) {
                const f = frames[k];
                const g = SkyTransform.gnomonicProject(sky.ra_hours, sky.dec_degrees, f.wcs.crval[0], f.wcs.crval[1]);
                const [[a, b], [c, d]] = f.wcs.cd;
                const det = a * d - b * c;
                const fx = f.wcs.crpix[0] + (d * g.xi - b * g.eta) / det;
                const fy = f.wcs.crpix[1] + (-c * g.xi + a * g.eta) / det;
                if (!(fx >= 0 && fx <= f.width - 1.001 && fy >= 0 && fy <= f.height - 1.001)) continue;
                const ix = Math.floor(fx), iy = Math.floor(fy);
                const du = fx - ix, dv = fy - iy;
                const o = iy * f.width + ix;
                const p = planes[k];
                const v = p[o] * (1 - du) * (1 - dv) + p[o + 1] * du * (1 - dv)
                    + p[o + f.width] * (1 - du) * dv + p[o + f.width + 1] * du * dv;
                if (Number.isFinite(v)) { sum += v - bgOf[k]; n++; }
            }
            plane[j * w + i] = n > 0 ? sum / n : NaN;
        }
    }
    return { plane, w, h, x0, y0 };
}

function makeFrames(): StackFrameInput[] {
    return DITHERS.map(([dx, dy], k) => makeFrame(`f${k}`, dx, dy, k * 300, k));
}

// ─── flag semantics ─────────────────────────────────────────────────────────

describe('m11_stack — flag (VITE_STACK_ENABLED, DEFAULT OFF)', () => {
    const saved = process.env.VITE_STACK_ENABLED;
    afterEach(() => {
        if (saved === undefined) delete process.env.VITE_STACK_ENABLED;
        else process.env.VITE_STACK_ENABLED = saved;
    });

    it('is OFF by default and for explicit falsy values', () => {
        delete process.env.VITE_STACK_ENABLED;
        expect(isStackingEnabled()).toBe(false);
        process.env.VITE_STACK_ENABLED = '0';
        expect(isStackingEnabled()).toBe(false);
        process.env.VITE_STACK_ENABLED = 'false';
        expect(isStackingEnabled()).toBe(false);
        process.env.VITE_STACK_ENABLED = ''; // empty = not enabled
        expect(isStackingEnabled()).toBe(false);
    });

    it("turns ON only for '1' / 'true' (call-time read)", () => {
        process.env.VITE_STACK_ENABLED = '1';
        expect(isStackingEnabled()).toBe(true);
        process.env.VITE_STACK_ENABLED = 'true';
        expect(isStackingEnabled()).toBe(true);
        delete process.env.VITE_STACK_ENABLED;
        expect(isStackingEnabled()).toBe(false); // no caching
    });
});

// ─── dither measurement ─────────────────────────────────────────────────────

describe('m11_stack — dither offsets measured from fitted WCS', () => {
    it('recovers the injected sub-pixel shifts (no separate estimator)', () => {
        const frames = makeFrames();
        const ref = pickReference(frames);
        expect(ref.id).toBe('f0'); // same scale everywhere → deterministic first
        const offsets = measureDitherOffsets(frames, ref);
        for (let k = 0; k < DITHERS.length; k++) {
            const [dx, dy] = DITHERS[k];
            // crpix_k = base + shift ⇒ the frame center displaces by −shift in ref px
            expect(offsets[k].dxPx).toBeCloseTo(-dx, 3);
            expect(offsets[k].dyPx).toBeCloseTo(-dy, 3);
            const expArcsec = Math.hypot(dx, dy) * SCALE_ARCSEC;
            expect(offsets[k].arcsec).toBeCloseTo(expArcsec, 2);
        }
    });
});

// ─── drizzle: sharpness + determinism + flux placement ──────────────────────

describe('m11_stack — drizzle kernel (synthetic point source)', () => {
    // SHARPNESS ORACLES (physics-honest): drizzle can never deconvolve the
    // input pixel integration, so "sharper than a well-sampled single sub" is
    // NOT a true statement in exact second moments — the true claims are:
    //  (a) drizzle beats INTERPOLATION-based stacking (its residual kernel is
    //      box(pixfrac) instead of bilinear's triangle(2 px) — the actual
    //      Fruchter-Hook selling point), and
    //  (b) its broadening over a single sub is bounded by the documented
    //      pixfrac blur budget σ²_add ≤ (pixfrac·s_in)²/12.
    // Both are asserted below with the SAME moment measure on both sides.
    it('drizzle beats bilinear shift-and-add AND stays inside the kernel blur budget', async () => {
        // pixfrac 1.0 HERE (not the wiring default): with footprints exactly
        // tiling the output (side = spacing = 2 out-px) the coverage is
        // hole-free, so the second-moment accounting is exact — at pixfrac<1
        // the sparse deposit lattice leaves NaN holes whose moment bias would
        // have to be absorbed by a fudge margin (refused; LAW 2 smell).
        const SHARP_PARAMS = { scaleFactor: 2, pixfrac: 1.0 };
        const frames = makeFrames();
        const product = await stackSolvedFrames(frames, { params: SHARP_PARAMS });
        const grid = product.grid;

        // single-sub FWHM (native grid, LAW 1) — same measure as the stack side
        const subFwhmArcsec: number[] = [];
        for (let k = 0; k < frames.length; k++) {
            const [dx, dy] = DITHERS[k];
            const plane = await frames[k].getPlane();
            const m = measureMomentFwhm(plane as Float32Array, W, H, BASE + dx, BASE + dy, 8);
            expect(m).not.toBeNull();
            subFwhmArcsec.push(m!.fwhmPx * SCALE_ARCSEC);
        }

        // stack FWHM on the drizzled grid (scale = 1"/px at scaleFactor 2)
        expect(grid.scaleArcsec).toBeCloseTo(SCALE_ARCSEC / SHARP_PARAMS.scaleFactor, 12);
        const star = skyToGridPix(grid, 10, 45);
        const ms = measureMomentFwhm(product.plane, grid.width, grid.height, star.x, star.y, 16);
        expect(ms).not.toBeNull();
        const stackFwhmArcsec = ms!.fwhmPx * grid.scaleArcsec;

        // the star must land where the grid says the sky point is (<0.2 out-px)
        expect(Math.hypot(ms!.cx - star.x, ms!.cy - star.y)).toBeLessThan(0.2);

        // (a) reference: bilinear inverse-map shift-and-add onto the SAME grid
        const ref = await bilinearReferenceStack(frames, grid, star, 24);
        const mr = measureMomentFwhm(ref.plane, ref.w, ref.h, star.x - ref.x0, star.y - ref.y0, 16);
        expect(mr).not.toBeNull();
        const bilinearFwhmArcsec = mr!.fwhmPx * grid.scaleArcsec;
        expect(stackFwhmArcsec).toBeLessThan(bilinearFwhmArcsec);

        // (b) blur budget — BOTH documented kernel terms: the shrunken input
        // footprint box(pixfrac·s_in) and the output-cell integration
        // box(s_out); variance of box(w) = w²/12. +2% slack for the tiny
        // deterministic noise + window truncation, NOT for kernel physics.
        const budget = 2.3548 ** 2
            * ((SHARP_PARAMS.pixfrac * SCALE_ARCSEC) ** 2 + grid.scaleArcsec ** 2) / 12;
        const worstSub = Math.max(...subFwhmArcsec);
        expect(stackFwhmArcsec ** 2).toBeLessThanOrEqual(worstSub ** 2 + budget * 1.02);
    });

    it('is deterministic — double run produces bit-identical planes', async () => {
        const a = await stackSolvedFrames(makeFrames(), { params: PARAMS });
        const b = await stackSolvedFrames(makeFrames(), { params: PARAMS });
        expect(a.grid).toEqual(b.grid);
        expect(Buffer.from(a.plane.buffer).equals(Buffer.from(b.plane.buffer))).toBe(true);
        expect(Buffer.from(a.weightMap.buffer).equals(Buffer.from(b.weightMap.buffer))).toBe(true);
    });

    it('records MEASURED per-frame statistics and the receipt contract fields', async () => {
        const product = await stackSolvedFrames(makeFrames(), { params: PARAMS });
        const r = product.receipt as any;
        expect(r.kind).toBe('stack');
        expect(r.stack_schema_version).toBe('0.1.0');
        expect(r.inputs).toHaveLength(4);
        expect(r.inputs.every((i: any) => i.wcs_provenance === 'FITTED')).toBe(true);
        expect(r.drizzle.scale_factor).toBe(PARAMS.scaleFactor);
        expect(r.drizzle.pixfrac).toBe(PARAMS.pixfrac);
        expect(r.dither_offsets_measured).toHaveLength(4);
        expect(r.output.wcs.SOURCE).toBe('GRID');           // never laundered as FITTED
        // hours→degrees at the boundary: EXACT ×15 of the grid tangent (which
        // sits ~0.35" from the star: it is the mean of the DITHERED centers)
        const product2 = product as any;
        expect(r.output.wcs.CRVAL1).toBeCloseTo(product2.grid.crval[0] * 15, 10);
        expect(r.output.wcs.CRVAL1).toBeCloseTo(150, 2);
        expect(r.limitations.psf_mixing).toContain('v2');    // the carried caveat
        expect(r.correlated_input_accounting.policy).toContain('EXCLUDE');
        // measured background ≈ the injected BG on every frame
        for (const fsRow of r.frame_statistics) {
            expect(fsRow.background).toBeCloseTo(BG, 0);
            expect(fsRow.weight_inverse_variance).toBeGreaterThan(0);
            expect(fsRow.deposited_px).toBeGreaterThan(0);
        }
    });
});

// ─── √N honesty: correlated-input screening ─────────────────────────────────

describe('m11_stack — correlated-input screening', () => {
    it('excludes exact-duplicate shas and near-simultaneous captures', () => {
        const f0 = makeFrame('a', 0, 0, 0);
        const dup = { ...makeFrame('a_dup', 0.4, 0.7, 600), frameSha: 'sha_a' };
        const near = makeFrame('b_near', 0.2, 0.1, 30); // 30 s after f0
        const ok = makeFrame('c', -0.3, 0.55, 1200);
        const { kept, excluded } = screenCorrelatedInputs([f0, dup, near, ok]);
        expect(kept.map((f) => f.id)).toEqual(['a', 'c']);
        expect(excluded).toHaveLength(2);
        expect(excluded[0].reason).toContain('EXACT_DUPLICATE');
        expect(excluded[1].reason).toContain('SUSPECTED_CORRELATED');
    });

    it('refuses a stack with <2 independent frames', async () => {
        const f0 = makeFrame('a', 0, 0, 0);
        const dup = { ...makeFrame('a2', 0.4, 0.7, 600), frameSha: 'sha_a' };
        await expect(stackSolvedFrames([f0, dup], { params: PARAMS }))
            .rejects.toThrow(/independent frame/);
    });
});

// ─── receipt-WCS conversion (unit trap boundary) ────────────────────────────

describe('m11_stack — fittedWcsFromReceipt', () => {
    it('converts receipt degrees back to engine hours (inverse of generateReceiptWcs)', () => {
        const wcs = fittedWcsFromReceipt({
            wcs: {
                SOURCE: 'FITTED',
                CRPIX1: 100.25, CRPIX2: 200.5,
                CRVAL1: 150.0, CRVAL2: 45.0,   // degrees on the receipt
                CD1_1: -SDEG, CD1_2: 0, CD2_1: 0, CD2_2: SDEG,
            },
        });
        expect(wcs.crval[0]).toBeCloseTo(10, 12); // 150° = 10 h
        expect(wcs.crval[1]).toBe(45);
        expect(wcs.crpix).toEqual([100.25, 200.5]);
    });

    it('REFUSES a SYNTHESIZED WCS (only star-fitted frames enter a stack)', () => {
        expect(() => fittedWcsFromReceipt({ wcs: { SOURCE: 'SYNTHESIZED', CRVAL1: 1 } }))
            .toThrow(/SYNTHESIZED/);
        expect(() => fittedWcsFromReceipt({})).toThrow(/no WCS/);
    });
});

// ─── batch wiring: inertness OFF / reachability ON ──────────────────────────

function tmpOut(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'm11-stack-utest-'));
}

/** Mock solve that behaves like the real driver for the stack seam: a receipt
 *  with a FITTED degree-space WCS + a session exposing getExportImage. Frame
 *  index is threaded via readFile as byteLength−2. */
function makeStackingSolveMock(): BatchSolveFn {
    return async (ab) => {
        const k = ab.byteLength - 2;
        const [dx, dy] = DITHERS[k];
        const plane = renderFrame(BASE + dx, BASE + dy);
        const receipt = {
            version: '2.13.0',
            solution: { ra_hours: 10, dec_degrees: 45, pixel_scale: SCALE_ARCSEC, stars_matched: 50, confidence: 0.9 },
            wcs: {
                SOURCE: 'FITTED',
                CRPIX1: BASE + dx, CRPIX2: BASE + dy,
                CRVAL1: 150, CRVAL2: 45,
                CD1_1: -SDEG, CD1_2: 0, CD2_1: 0, CD2_2: SDEG,
            },
            metadata: {
                width: W, height: H,
                timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, k * 300)).toISOString(),
                exposure_time: 240,
            },
        };
        const session = {
            getExportImage: () => ({ data: plane, width: W, height: H, channels: 1 as const }),
        };
        return { receipt: receipt as any, events: [], session: session as any };
    };
}

describe('m11_stack — batch wiring (tools/batch/batch_engine.ts)', () => {
    const saved = process.env.VITE_STACK_ENABLED;
    beforeEach(() => { delete process.env.VITE_STACK_ENABLED; });
    afterEach(() => {
        if (saved === undefined) delete process.env.VITE_STACK_ENABLED;
        else process.env.VITE_STACK_ENABLED = saved;
    });

    it('flag OFF (default): ledger has NO stack key, no stack artifacts exist — inert', async () => {
        const out = tmpOut();
        const files = ['/c/f0.fits', '/c/f1.fits', '/c/f2.fits'];
        const readFile = (f: string) => new ArrayBuffer(2 + Number(f.match(/f(\d)/)![1]));
        const { ledger } = await runBatch(files, {
            atlasRoot: '/unused', outDir: out, readFile, solveFn: makeStackingSolveMock(),
        });
        expect(ledger.counts.solved).toBe(3);
        expect('stack' in ledger).toBe(false);
        expect(fs.existsSync(path.join(out, 'stack'))).toBe(false);
        // the serialized ledger carries no trace of the feature
        const summary = fs.readFileSync(path.join(out, 'batch_summary.json'), 'utf8');
        expect(summary.includes('"stack"')).toBe(false);
        fs.rmSync(out, { recursive: true, force: true });
    });

    it('flag ON: the stack step is REACHABLE — drizzled FITS + kind:stack receipt land on disk', async () => {
        process.env.VITE_STACK_ENABLED = '1';
        const out = tmpOut();
        const stackOut = path.join(out, 'stackprod');
        const files = ['/c/f0.fits', '/c/f1.fits', '/c/f2.fits', '/c/f3.fits'];
        const readFile = (f: string) => new ArrayBuffer(2 + Number(f.match(/f(\d)/)![1]));
        const { ledger } = await runBatch(files, {
            atlasRoot: '/unused', outDir: out, readFile, solveFn: makeStackingSolveMock(),
            stack: { params: PARAMS, outDir: stackOut, cleanupScratch: true },
        });
        expect(ledger.stack).toBeDefined();
        expect(ledger.stack!.status).toBe('ok');
        const ok = ledger.stack as Extract<NonNullable<typeof ledger.stack>, { status: 'ok' }>;
        expect(ok.n_stacked).toBe(4);
        expect(ok.output.scale_arcsec).toBeCloseTo(SCALE_ARCSEC / PARAMS.scaleFactor, 10);
        expect(fs.existsSync(ok.fits)).toBe(true);
        const receipt = JSON.parse(fs.readFileSync(ok.receipt_path, 'utf8'));
        expect(receipt.kind).toBe('stack');
        expect(receipt.dither_offsets_measured).toHaveLength(4);
        // measured offsets = −injected shifts (through the FULL wiring)
        for (let k = 0; k < DITHERS.length; k++) {
            const row = receipt.dither_offsets_measured.find((o: any) => o.id === `f${k}`);
            expect(row.dx_px_ref).toBeCloseTo(-DITHERS[k][0], 3);
            expect(row.dy_px_ref).toBeCloseTo(-DITHERS[k][1], 3);
        }
        fs.rmSync(out, { recursive: true, force: true });
    });

    it('flag ON but <2 solved frames: honest skipped block, batch unharmed', async () => {
        process.env.VITE_STACK_ENABLED = '1';
        const out = tmpOut();
        const { ledger } = await runBatch(['/c/f0.fits'], {
            atlasRoot: '/unused', outDir: out,
            readFile: () => new ArrayBuffer(2), solveFn: makeStackingSolveMock(),
        });
        expect(ledger.counts.solved).toBe(1);
        expect(ledger.stack!.status).toBe('skipped');
        fs.rmSync(out, { recursive: true, force: true });
    });
});
