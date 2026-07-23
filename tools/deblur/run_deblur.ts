// @ts-nocheck
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DRIFT-DEBLUR CLI — thin FITS-lane driver (LAW-4: incubator + thin driver)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Applies the known-kernel sidereal-drift deblur to a FITS plane, given the
 * EXACT drift kernel (length + PA) that the engine's psf_attribution stage
 * COMPUTED for the frame. Auto-detects bright sources for the preservation
 * proof, deconvolves, writes the deblurred FITS, and prints the additive
 * `deblur` receipt block (proof + epistemic classification).
 *
 * RUNNER: like the other engine-importing tools/*.ts drivers (tools/asdf,
 * tools/validation), this reuses the engine deconvolution graph and therefore
 * runs under the repo's TS runner (vitest/vite-node), not plain `node`. The
 * rigorous capability proof is the fixture src/engine/tests/drift_deblur.test.ts.
 *
 * PRESENCE GATING happens UPSTREAM: the caller supplies the kernel only when
 * psf_attribution returned CONFIRMED_PRESENT. The kernel is CALCULATED (celestial
 * mechanics), so a passing proof → VERIFIED_PRESERVING. Nothing here touches the
 * solve/measurement — it is a PIXEL/render op on the native grid.
 *
 * Usage:
 *   vite-node tools/deblur/run_deblur.ts <input.fits> --length <px> --pa <deg> \
 *       [--plane 0] [--iters 30] [--enable] [--out <path>] [--json]
 *   (--enable is required to actually run — the lane is DEFAULT-OFF.)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFits, readPlaneRaw, writeFitsPlanar } from '../stack/fits_io.mjs';
import { findMaxima, measureStar, pixelNoiseSigma } from '../../src/engine/pipeline/m10_psf/psf_core';
import { driftPsfKernel } from '../../src/engine/pipeline/m10_psf/psf_physics';
import { runDriftDeblur, serializeDeblurBlock, type SourcePos } from './drift_deblur';

function parseArgs(argv: string[]) {
    const a: any = { input: null, length: null, pa: null, plane: 0, iters: 30, enable: false, out: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--length') a.length = +argv[++i];
        else if (t === '--pa') a.pa = +argv[++i];
        else if (t === '--plane') a.plane = +argv[++i];
        else if (t === '--iters') a.iters = +argv[++i];
        else if (t === '--enable') a.enable = true;
        else if (t === '--out') a.out = argv[++i];
        else if (t === '--json') a.json = true;
        else if (!a.input) a.input = t;
    }
    return a;
}

/** Detect the brightest well-measured sources for the preservation proof. */
function detectSources(plane: Float32Array, w: number, h: number, sigmaN: number, cap = 60): SourcePos[] {
    const thr = 6 * sigmaN + medianOf(plane);
    const peaks = findMaxima(plane, w, h, thr, 4000, 12);
    const out: SourcePos[] = [];
    for (const p of peaks) {
        const m = measureStar(plane, w, h, p.x, p.y, sigmaN, 9);
        if (m && Number.isFinite(m.fwhmMaj) && m.fwhmMaj > 1 && m.fwhmMaj < 40) {
            out.push({ x: m.cx, y: m.cy });
            if (out.length >= cap) break;
        }
    }
    return out;
}

function medianOf(a: Float32Array): number {
    const step = Math.max(1, Math.floor(a.length / 50000));
    const s: number[] = [];
    for (let i = 0; i < a.length; i += step) s.push(a[i]);
    s.sort((x, y) => x - y);
    return s[s.length >> 1] ?? 0;
}

async function main() {
    const a = parseArgs(process.argv.slice(2));
    if (!a.input || a.length == null || a.pa == null) {
        console.error('usage: vite-node tools/deblur/run_deblur.ts <input.fits> --length <px> --pa <deg> [--plane 0] [--iters 30] [--enable] [--out <path>] [--json]');
        process.exit(2);
    }
    const f = openFits(a.input);
    const { W, H } = f;
    const plane = Float32Array.from(readPlaneRaw(f, Math.min(a.plane, f.NP - 1)));
    f.close();

    const sigmaN = pixelNoiseSigma(plane);
    const sources = detectSources(plane, W, H, sigmaN);
    const driftKernel = driftPsfKernel(a.length, a.pa);   // the EXACT calculated kernel

    const { report, deblurred } = await runDriftDeblur({
        plane, width: W, height: H,
        presence: 'CONFIRMED_PRESENT',   // gated upstream by psf_attribution
        driftKernel, sources, enabled: a.enable, iters: a.iters, sigmaDamp: sigmaN,
    });

    const block = serializeDeblurBlock(report);
    if (report.applied && deblurred) {
        const outPath = a.out || a.input.replace(/\.(fits?|fit)$/i, '') + '.deblurred.fits';
        writeFitsPlanar(outPath, [deblurred], W, H, [
            ['HISTORY', 'SkyCruncher drift-deblur (known-kernel sidereal RL, PIXEL ledger)'],
            ['DBLRLEN', a.length, 'drift kernel length px'],
            ['DBLRPA', a.pa, 'drift kernel PA deg'],
            ['DBLREPST', report.epistemic_type || 'NULL', 'epistemic classification'],
        ]);
        if (a.json) console.log(JSON.stringify({ input: a.input, output: outPath, sources: sources.length, deblur: block }, null, 2));
        else {
            console.log(`deblurred → ${outPath}  (${W}x${H}, ${sources.length} proof sources)`);
            console.log(`  epistemic: ${report.epistemic_type}  (${report.label})`);
            const p = report.preservation_proof!;
            console.log(`  flux_ratio=${p.flux_conservation.value} centroid_shift=${p.astrometric_invariance.value}px reconv=${p.reconvolution_residual.value} forced=${p.forced_photometry_recheck.value}σ`);
        }
    } else {
        if (a.json) console.log(JSON.stringify({ input: a.input, deblur: block, reason: report.reason }, null, 2));
        else console.log(`no deblur — ${report.reason}`);
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('DEBLUR_FAIL:', e.message); process.exit(1); });
