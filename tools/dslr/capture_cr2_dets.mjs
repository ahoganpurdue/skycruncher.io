// ═══════════════════════════════════════════════════════════════════════════
// CR2 REAL-DETECTION CAPTURE — the app's actual step-3 stars, for the harness
// ═══════════════════════════════════════════════════════════════════════════
//
//   CR2_FILE="Sample Files/corpus/.../IMG_1410.CR2" E2E_PORT=3021 \
//     node tools/dslr/capture_cr2_dets.mjs
//   (no CR2_FILE → bundled public/demo/sample_observation.cr2)
//
// Drives the REAL wizard through steps 1-4 (upload → context → detect → scale
// lock) and captures window.__astroSession.signal.clean_stars — the EXACT
// curated detection set the solver receives — plus scaleLock and the image
// dimensions. Writes the SAME JSON shape as dump_cr2_solveframe.mjs so the
// vitest solve harness reads either interchangeably. This removes the
// detection-reimplementation confound: the harness then solves on byte-identical
// input to the app (source:'app'), so peak-z calibrates to the app's ~+8σ.
//
// Slow (headless CPU demosaic + detection, minutes per frame) but ONE-TIME per
// frame — detections don't change, so solver iteration afterward runs at test
// speed on the cached JSON.

import path from 'node:path';
import fs from 'node:fs';
import { createRun, ROOT } from '../e2e/lib.mjs';
import { computePlanets } from './ephem.mjs';

const CR2 = process.env.CR2_FILE
    ? path.resolve(process.env.CR2_FILE)
    : path.join(ROOT, 'public', 'demo', 'sample_observation.cr2');
const base = path.basename(CR2).replace(/\.[^.]+$/, '');
const HARD_KILL_MS = 15 * 60 * 1000;

const run = await createRun('cr2cap');
const { page, log, step, finish } = run;
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

    // ── capture the real detections + scale + dims from the dev session ──
    const cap = await page.evaluate(() => {
        const s = window.__astroSession;
        if (!s) return { error: 'no __astroSession' };
        const sig = s.signal || {};
        const stars = (sig.clean_stars || sig.stars || []).map((d) => ({
            x: d.x, y: d.y, flux: d.flux, fwhm: d.fwhm, snr: d.snr,
            // thermal-noise shape stats (detection_cuts.ts; absent = not measured)
            sharpness: d.sharpness, mfw: d.moment_fwhm_px, mell: d.moment_ellipticity,
        }));
        // hunt for image dimensions across likely fields (the solver's imageData)
        const dimCandidates = {
            meta_wh: s.metadata ? [s.metadata.width, s.metadata.height] : null,
            sig_wh: [sig.width, sig.height],
            img_wh: [s.imageWidth, s.imageHeight],
            src_wh: s.source ? [s.source.width, s.source.height] : null,
            canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })(),
        };
        return {
            sessionKeys: Object.keys(s),
            signalKeys: Object.keys(sig),
            scaleLock: s.scaleLock,
            metadata: s.metadata ? {
                camera_model: s.metadata.camera_model, focal_length: s.metadata.focal_length,
                pixel_scale: s.metadata.pixel_scale, timestamp: s.metadata.timestamp,
                gps_lat: s.metadata.gps_lat, gps_lon: s.metadata.gps_lon,
                width: s.metadata.width, height: s.metadata.height,
            } : null,
            dimCandidates,
            starCount: stars.length,
            sampleStar: stars[0] || null,
            stars,
        };
    });

    if (cap.error) throw new Error(cap.error);
    log(`[cap] sessionKeys: ${cap.sessionKeys?.join(',')}`);
    log(`[cap] signalKeys: ${cap.signalKeys?.join(',')}`);
    log(`[cap] scaleLock=${cap.scaleLock} stars=${cap.starCount} sample=${JSON.stringify(cap.sampleStar)}`);
    log(`[cap] dimCandidates=${JSON.stringify(cap.dimCandidates)}`);

    // resolve width/height from the first sane candidate (else fall back to
    // libraw active area 5202x3464, logged so any mismatch is visible)
    const pickDim = () => {
        for (const v of Object.values(cap.dimCandidates)) {
            if (Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1]) && v[0] > 1000 && v[1] > 1000) return v;
        }
        return [5202, 3464];
    };
    const [width, height] = pickDim();
    const ts = cap.metadata?.timestamp || null;
    let planets = [];
    if (ts) { try { planets = computePlanets(new Date(ts)); } catch (e) { log(`[cap] ephem failed: ${e.message}`); } }

    const out = {
        file: path.relative(ROOT, CR2).replace(/\\/g, '/'),
        source: 'app',
        width, height,
        scaleArcsecPerPx: cap.scaleLock,
        focalLengthMm: cap.metadata?.focal_length ?? null,
        timestamp: ts,
        gps: (Number.isFinite(cap.metadata?.gps_lat)) ? [cap.metadata.gps_lat, cap.metadata.gps_lon] : null,
        metadata: cap.metadata,
        planets,
        detection: { kept: cap.stars.length, source: 'app.signal.clean_stars' },
        detections: cap.stars.map((d) => ({
            x: +(+d.x).toFixed(2), y: +(+d.y).toFixed(2),
            flux: +(+d.flux).toExponential(4), fwhm: +(+(d.fwhm ?? 0)).toFixed(2),
            snr: Number.isFinite(d.snr) ? +(+d.snr).toFixed(2) : undefined,
            // thermal-noise shape stats (absent = not measured)
            sharpness: Number.isFinite(d.sharpness) ? +(+d.sharpness).toFixed(4) : undefined,
            mfw: Number.isFinite(d.mfw) ? +(+d.mfw).toFixed(3) : undefined,
            mell: Number.isFinite(d.mell) ? +(+d.mell).toFixed(4) : undefined,
        })),
    };
    const outDir = path.join(ROOT, 'test_results', 'cr2_dets');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${base}.app.json`);
    fs.writeFileSync(outPath, JSON.stringify(out));
    log(`[cap] ${base}: ${out.detections.length} app dets, ${width}x${height}, scale=${out.scaleArcsecPerPx}"/px, planets=${planets.map(p => p.name + '@' + p.ra_hours + 'h').join(',')}`);
    log(`[cap] -> ${path.relative(ROOT, outPath)}`);

    clearTimeout(hardKill);
    await finish(true, `captured ${out.detections.length} dets`);
    process.exit(0);
} catch (e) {
    log(`[cap] FAILED: ${e && e.stack || e}`);
    clearTimeout(hardKill);
    await finish(false, String(e && e.message || e));
    process.exit(1);
}
