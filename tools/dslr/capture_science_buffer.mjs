// ═══════════════════════════════════════════════════════════════════════════
// SCIENCE-BUFFER CAPTURE — extracts the LUMINANCE grid m4 detection operates on.
// Drives the REAL wizard steps 1-4, then serializes window.__astroSession's
// scienceBuffer (Float32 luminance, the solver's precision buffer = the binned
// science grid per signal_processor.ts:188/orchestrator_session.ts:394-396) to
// base64 so a downstream Node lane can run forced photometry on the PIXEL grid.
//   CR2_FILE="..." E2E_PORT=<p> node tools/dslr/capture_science_buffer.mjs
// Writes test_results/cr2_dets/<base>.scibuf.json (meta) + .scibuf.f32 (raw bytes)
// ═══════════════════════════════════════════════════════════════════════════
import path from 'node:path';
import fs from 'node:fs';
import { createRun, ROOT } from '../e2e/lib.mjs';

const CR2 = process.env.CR2_FILE
    ? path.resolve(process.env.CR2_FILE)
    : path.join(ROOT, 'public', 'demo', 'sample_observation.cr2');
const base = path.basename(CR2).replace(/\.[^.]+$/, '');
const HARD_KILL_MS = 15 * 60 * 1000;

const run = await createRun('scibuf');
const { page, log, finish } = run;
const step = run.step;
const hardKill = setTimeout(async () => { log('[FATAL] hard kill'); await finish(false, 'hard kill'); process.exit(1); }, HARD_KILL_MS);

try {
    if (!fs.existsSync(CR2)) throw new Error(`CR2 missing at ${CR2}`);
    await step('00_prewarm', 120_000, async () => {
        await page.goto(run.BASE, { waitUntil: 'networkidle', timeout: 110_000 });
    });
    await step('01_upload_and_step1', 200_000, async () => {
        await page.setInputFiles('#astro-file-input', CR2);
        await page.getByTestId('step1-proceed').click({ timeout: 190_000 });
    });
    await step('02_context_form', 20_000, async () => {
        await page.getByTestId('wizard-next-step').click();
    });
    await step('03_star_detection', 480_000, async () => {
        await page.getByTestId('step3-start').click();
        await page.getByTestId('step3-confirm').click({ trial: true, timeout: 470_000 });
        await page.getByTestId('step3-confirm').click();
    });
    await step('04_exif_scale_lock', 60_000, async () => {
        await page.getByTestId('step4-start').click();
        await page.getByTestId('step4-confirm').click({ trial: true, timeout: 50_000 });
        await page.getByTestId('step4-confirm').click();
    });

    // Extract the science buffer as base64 (chunked btoa to avoid arg-length blowup).
    const cap = await page.evaluate(() => {
        const s = window.__astroSession;
        if (!s) return { error: 'no __astroSession' };
        const sb = s.scienceBuffer;
        if (!sb) return { error: 'no scienceBuffer on session' };
        const f32 = sb instanceof Float32Array ? sb : new Float32Array(sb);
        const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
        let b64 = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) {
            b64 += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        }
        b64 = btoa(b64);
        const sc = s.scales || {};
        const dets = (s.signal && s.signal.clean_stars) ? s.signal.clean_stars : [];
        const fwhms = dets.map(d => d.fwhm).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
        return {
            length: f32.length,
            byteLength: f32.byteLength,
            b64,
            nativeW: sc.nativeW ?? null, nativeH: sc.nativeH ?? null,
            scienceW: sc.scienceW ?? null, scienceH: sc.scienceH ?? null,
            medianFwhmNative: fwhms.length ? fwhms[fwhms.length >> 1] : null,
            noise_floor: s.signal ? s.signal.noise_floor : null,
            cleanStars: dets.length,
        };
    });
    if (cap.error) throw new Error(cap.error);
    log(`[scibuf] length=${cap.length} nativeW=${cap.nativeW} scienceW=${cap.scienceW} medFwhm=${cap.medianFwhmNative}`);

    const outDir = path.join(ROOT, 'test_results', 'cr2_dets');
    fs.mkdirSync(outDir, { recursive: true });
    const rawPath = path.join(outDir, `${base}.scibuf.f32`);
    fs.writeFileSync(rawPath, Buffer.from(cap.b64, 'base64'));
    const meta = {
        base, file: path.relative(ROOT, CR2).replace(/\\/g, '/'),
        length: cap.length, byteLength: cap.byteLength,
        nativeW: cap.nativeW, nativeH: cap.nativeH, scienceW: cap.scienceW, scienceH: cap.scienceH,
        medianFwhmNative: cap.medianFwhmNative, noise_floor: cap.noise_floor, cleanStars: cap.cleanStars,
        rawFile: path.basename(rawPath),
    };
    const metaPath = path.join(outDir, `${base}.scibuf.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    log(`[scibuf] -> ${path.relative(ROOT, rawPath)} (${(cap.byteLength / 1e6).toFixed(1)}MB) + meta`);
    clearTimeout(hardKill);
    await finish(true, `captured science buffer for ${base}`);
    process.exit(0);
} catch (e) {
    log(`[scibuf] FAILED: ${e && e.stack || e}`);
    clearTimeout(hardKill);
    await finish(false, String(e && e.message || e));
    process.exit(1);
}
