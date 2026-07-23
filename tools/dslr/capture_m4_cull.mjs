// ═══════════════════════════════════════════════════════════════════════════
// M4 CULL CAPTURE — full signal packet (clean_stars + anomalies +
// planet_candidates + culling_tally) with per-item flux/peak/fwhm/circ/snr/reason.
// Drives the REAL wizard steps 1-4, reads window.__astroSession.signal.
//   CR2_FILE="..." E2E_PORT=<p> node tools/dslr/capture_m4_cull.mjs
// Writes test_results/cr2_dets/<base>.m4cull.json
// ═══════════════════════════════════════════════════════════════════════════
import path from 'node:path';
import fs from 'node:fs';
import { createRun, ROOT } from '../e2e/lib.mjs';

const CR2 = process.env.CR2_FILE
    ? path.resolve(process.env.CR2_FILE)
    : path.join(ROOT, 'public', 'demo', 'sample_observation.cr2');
const base = path.basename(CR2).replace(/\.[^.]+$/, '');
const HARD_KILL_MS = 15 * 60 * 1000;

const run = await createRun('m4cull');
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

    const cap = await page.evaluate(() => {
        const s = window.__astroSession;
        if (!s) return { error: 'no __astroSession' };
        const sig = s.signal || {};
        const pick = (d) => ({
            x: d.x, y: d.y, flux: d.flux, peak: d.peak_value, fwhm: d.fwhm,
            circ: d.circularity, snr: d.snr, reason: d.culling_reason ?? null,
            isPlanet: !!d.isPlanet,
        });
        return {
            signalKeys: Object.keys(sig),
            culling_tally: sig.culling_tally ?? null,
            counts: {
                clean: (sig.clean_stars || []).length,
                anomalies: (sig.anomalies || []).length,
                planets: (sig.planet_candidates || []).length,
            },
            clean_stars: (sig.clean_stars || []).map(pick),
            anomalies: (sig.anomalies || []).map(pick),
            planet_candidates: (sig.planet_candidates || []).map(pick),
            metadata: s.metadata ? { focal_length: s.metadata.focal_length, camera_model: s.metadata.camera_model } : null,
        };
    });
    if (cap.error) throw new Error(cap.error);
    log(`[m4] signalKeys: ${cap.signalKeys?.join(',')}`);
    log(`[m4] counts=${JSON.stringify(cap.counts)}`);
    log(`[m4] culling_tally=${JSON.stringify(cap.culling_tally)}`);

    const out = {
        file: path.relative(ROOT, CR2).replace(/\\/g, '/'),
        base, source: 'app', metadata: cap.metadata,
        culling_tally: cap.culling_tally, counts: cap.counts,
        clean_stars: cap.clean_stars, anomalies: cap.anomalies, planet_candidates: cap.planet_candidates,
    };
    const outDir = path.join(ROOT, 'test_results', 'cr2_dets');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${base}.m4cull.json`);
    fs.writeFileSync(outPath, JSON.stringify(out));
    log(`[m4] -> ${path.relative(ROOT, outPath)}`);
    clearTimeout(hardKill);
    await finish(true, `captured m4 cull for ${base}`);
    process.exit(0);
} catch (e) {
    log(`[m4] FAILED: ${e && e.stack || e}`);
    clearTimeout(hardKill);
    await finish(false, String(e && e.message || e));
    process.exit(1);
}
