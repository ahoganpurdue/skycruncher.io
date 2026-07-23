/**
 * COCOON 60Da — 11-sub dither/drizzle ACCEPTANCE through the REAL wiring.
 *
 *   npx vitest run -c tools/stack/cocoon_drizzle.config.ts
 *
 * Drives the FULL flag-gated path end-to-end on real data: runBatch (the real
 * calibrated wizard per frame, rawler default arm, IC 5146 pointing hint) over
 * 11 dithered 240 s Cocoon subs → per-frame receipts with fitted WCS → the
 * VITE_STACK_ENABLED step (batch_engine → batch_stack → m11_stack) → drizzled
 * FITS + kind:'stack' receipt. Then MEASURES (same moment machinery both
 * sides, tools/stack/solve_lib): reference-sub FWHM vs stack FWHM, and reports
 * output dims / effective scale / per-frame measured dither offsets.
 *
 * Outputs land on D: (storage law — the drizzled plane is ~290 MB):
 *   D:\AstroLogic\test_artifacts\cocoon_drizzle_2026-07-12\
 * A compact acceptance_summary.json (MEASURED numbers only) is written next to
 * the products. Scratch sub-planes are deleted AFTER the FWHM measurement.
 *
 * MEASUREMENT ONLY on the solve side: no engine file is touched; the pointing
 * hint mirrors tools/api/cocoon_rawler_hint.corpspec.ts (owner-named target
 * IC 5146 — a NAME, not a measurement).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBatch } from '../batch/batch_engine';
// @ts-ignore — tools-lane .mjs helpers (not in the tsc graph; vitest transpiles)
import { openFits, readPlaneRaw } from './fits_io.mjs';
// @ts-ignore — same-lane detection/measurement helpers (proven on the M51 stack)
import { extractStars, refineCentroids, medianFwhm } from './solve_lib.mjs';
import * as wasmNs from '@/engine/wasm_compute/pkg/wasm_compute';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Atlas sectors are LOCAL-ONLY (338 MB) and live in the MAIN checkout — agent
// worktrees deliberately do not junction them for a batch lane run.
const MAIN_CHECKOUT = REPO_ROOT;
const ATLAS_ROOT = fs.existsSync(path.join(REPO_ROOT, 'public', 'atlas', 'sectors'))
    ? path.join(REPO_ROOT, 'public')
    : path.join(MAIN_CHECKOUT, 'public');

const LIGHTS_DIR = 'D:\\SkyCruncher\\SampleFiles\\corpus\\cocoon_60da\\lights';
const OUT_DIR = 'D:\\SkyCruncher\\test_artifacts\\cocoon_drizzle_2026-07-12';
const STACK_OUT = path.join(OUT_DIR, 'stack');

// The same 11 subs the 2026-07-12 hinted run solved 11/11 (L_0020..L_0030).
const FRAMES = [
    'L_0020_ISO800_240s__18C.CR2', 'L_0021_ISO800_240s__17C.CR2', 'L_0022_ISO800_240s__18C.CR2',
    'L_0023_ISO800_240s__16C.CR2', 'L_0024_ISO800_240s__16C.CR2', 'L_0025_ISO800_240s__19C.CR2',
    'L_0026_ISO800_240s__17C.CR2', 'L_0027_ISO800_240s__19C.CR2', 'L_0028_ISO800_240s__19C.CR2',
    'L_0029_ISO800_240s__19C.CR2', 'L_0030_ISO800_240s__18C.CR2',
].map((f) => path.join(LIGHTS_DIR, f));

// IC 5146 pointing + FL hint (mirrors cocoon_rawler_hint.corpspec.ts).
const COCOON_HINT = { ra_hint: 21.891, dec_hint: 47.267, focal_length_hint_mm: 430 };

const DRIZZLE = { scaleFactor: 2, pixfrac: 0.8 };

/** Normalize a plane to [0,1] over its finite range (the incubator's stack-
 *  validation transform) so extractStars sees its expected domain. */
function normalizePlane(plane: Float32Array): Float32Array {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < plane.length; i++) {
        const v = plane[i];
        if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    const inv = 1 / (hi - lo);
    const out = new Float32Array(plane.length);
    for (let i = 0; i < plane.length; i++) {
        const v = plane[i];
        out[i] = Number.isFinite(v) ? (v - lo) * inv : 0;
    }
    return out;
}

/** Median moment-FWHM (px) of the brightest detected stars — the SAME measure
 *  for sub and stack (solve_lib extractStars → refineCentroids → medianFwhm). */
function measureFwhmPx(plane: Float32Array, W: number, H: number): { fwhmPx: number; nStars: number } {
    const lum = normalizePlane(plane);
    const det = extractStars(wasmNs, lum, W, H);
    refineCentroids(lum, W, H, det.slice(0, 400));
    const refined = det.slice(0, 400).filter((s: any) => Number.isFinite(s.cx));
    return { fwhmPx: medianFwhm(refined), nStars: det.length };
}

describe('Cocoon 11-sub drizzle acceptance (flag ON, real pipeline)', () => {
    it('solves the subs, drizzles them through the wired batch step, and measures the product', async () => {
        for (const f of FRAMES) expect(fs.existsSync(f), `missing sub ${f}`).toBe(true);
        process.env.VITE_STACK_ENABLED = '1'; // THE switch under test (call-time read)

        const t0 = Date.now();
        const { ledger } = await runBatch(FRAMES, {
            atlasRoot: ATLAS_ROOT,
            outDir: OUT_DIR,
            overrides: COCOON_HINT as any,
            stack: { params: DRIZZLE, outDir: STACK_OUT, cleanupScratch: false },
        });
        const solveWallS = (Date.now() - t0) / 1000;

        // ── the wiring must have fired ────────────────────────────────────────
        expect(ledger.counts.solved).toBeGreaterThanOrEqual(2);
        expect(ledger.stack).toBeDefined();
        expect(ledger.stack!.status).toBe('ok');
        const stack = ledger.stack as Extract<NonNullable<typeof ledger.stack>, { status: 'ok' }>;
        expect(fs.existsSync(stack.fits)).toBe(true);
        const receipt = JSON.parse(fs.readFileSync(stack.receipt_path, 'utf8'));
        expect(receipt.kind).toBe('stack');
        expect(receipt.output.wcs.SOURCE).toBe('GRID');

        // ── MEASURE: stack FWHM (drizzled grid) vs reference-sub FWHM (native) ─
        const f = openFits(stack.fits);
        const stackPlane = readPlaneRaw(f, 0);
        f.close();
        const stackM = measureFwhmPx(stackPlane, receipt.output.width, receipt.output.height);
        const stackFwhmArcsec = stackM.fwhmPx * receipt.output.scale_arcsec;

        const refId = stack.reference_frame;
        const refInput = receipt.inputs.find((i: any) => i.id === refId);
        const refPlanePath = path.join(STACK_OUT, 'scratch', `${refId}.f32`);
        expect(fs.existsSync(refPlanePath)).toBe(true);
        const refBuf = fs.readFileSync(refPlanePath);
        const refPlane = new Float32Array(refBuf.buffer, refBuf.byteOffset, refBuf.byteLength / 4);
        const refM = measureFwhmPx(refPlane, refInput.width, refInput.height);
        const refFwhmArcsec = refM.fwhmPx * refInput.scale_arcsec;

        // pipeline-side per-sub FWHM (matched stars) as the secondary witness
        const perSubPipelineFwhm = ledger.results
            .filter((r) => r.verdict === 'solved')
            .map((r) => {
                const rec = JSON.parse(fs.readFileSync(r.receiptPath!, 'utf8'));
                return {
                    id: r.frameId,
                    mean_fwhm_px: rec.solution?.mean_fwhm_px ?? null,
                    pixel_scale: rec.solution?.pixel_scale ?? null,
                    fwhm_arcsec: rec.solution?.mean_fwhm_px != null && rec.solution?.pixel_scale != null
                        ? rec.solution.mean_fwhm_px * rec.solution.pixel_scale
                        : null,
                };
            });

        const summary = {
            when: new Date().toISOString(),
            solved: ledger.counts.solved,
            no_solve: ledger.counts.no_solve,
            errored: ledger.counts.errored,
            solve_plus_stack_wall_s: +solveWallS.toFixed(1),
            drizzle_params: DRIZZLE,
            n_stacked: stack.n_stacked,
            excluded: stack.excluded,
            reference_frame: refId,
            output: stack.output,
            coverage_max: stack.coverage_max,
            dither_offsets_measured: stack.dither_offsets_measured,
            fwhm_comparison_same_measure: {
                measure: 'solve_lib extractStars→refineCentroids moment-FWHM, median of brightest ≤400',
                reference_sub: {
                    id: refId, fwhm_px: +refM.fwhmPx.toFixed(3),
                    scale_arcsec: refInput.scale_arcsec, fwhm_arcsec: +refFwhmArcsec.toFixed(3),
                    stars_detected: refM.nStars,
                },
                stack: {
                    fwhm_px: +stackM.fwhmPx.toFixed(3),
                    scale_arcsec: receipt.output.scale_arcsec, fwhm_arcsec: +stackFwhmArcsec.toFixed(3),
                    stars_detected: stackM.nStars,
                },
            },
            per_sub_pipeline_fwhm: perSubPipelineFwhm,
            fits: stack.fits,
            stack_receipt: stack.receipt_path,
        };
        fs.writeFileSync(path.join(OUT_DIR, 'acceptance_summary.json'), JSON.stringify(summary, null, 2));
        console.log('[acceptance]', JSON.stringify(summary, null, 2));

        // measured sanity (direction of the FWHM delta is REPORTED, not asserted
        // — real seeing-limited data; honest numbers land in the summary)
        expect(stack.output.scale_arcsec).toBeCloseTo(refInput.scale_arcsec / DRIZZLE.scaleFactor, 6);
        expect(Number.isFinite(stackFwhmArcsec)).toBe(true);
        expect(Number.isFinite(refFwhmArcsec)).toBe(true);
        expect(stack.dither_offsets_measured.length).toBe(stack.n_stacked);

        // reclaim the ~800 MB of scratch sub-planes now that measurement is done
        fs.rmSync(path.join(STACK_OUT, 'scratch'), { recursive: true, force: true });
    });
});
