// E2E variant: bundled Canon CR2 through steps 1-5 (same assertions as
// run_wizard_cr2.mjs) PLUS a packet capture — the receipt the seestar
// scenario gets from the step-7 export download, here pulled directly from
// the dev-exposed session via exportPacket() right after the solve confirms.
//
//   node tools/e2e/run_wizard_cr2_export.mjs        (E2E_PORT to pick a server)
//
// WHY a variant instead of extending run_wizard_cr2.mjs: the CR2 smoke
// scenario's contract is "honest outcome either way" (blind solve may fail);
// this run EXISTS to produce a receipt, so a failed/absent solution is a
// scenario failure here. Steps 6-7 (calibration/integration) are skipped —
// the fitted WCS + matched-star list are set at step 5 and exportPacket()
// is a pure builder over session state.
//
// Artifact: test_results/e2e/<stamp>/receipt.json (same DROPPED_KEYS
// filtering as src/engine/ui/utils/save_packet.ts).
import path from 'node:path';
import fs from 'node:fs';
import { createRun, ROOT } from './lib.mjs';

const CR2 = process.env.CR2_FILE
    ? path.resolve(process.env.CR2_FILE)
    : path.join(ROOT, 'public', 'demo', 'sample_observation.cr2');
const IS_BUNDLED_SAMPLE = !process.env.CR2_FILE;
const HARD_KILL_MS = 15 * 60 * 1000;

const run = await createRun('cr2export');
const { page, log, step, sessionSnapshot, assert, assertRange, finish } = run;

const hardKill = setTimeout(async () => {
    log('[FATAL] hard kill');
    await finish(false, 'hard kill');
    process.exit(1);
}, HARD_KILL_MS);

try {
    assert(fs.existsSync(CR2), `bundled CR2 missing at ${CR2}`);

    await step('00_prewarm', 120_000, async () => {
        await page.goto(run.BASE, { waitUntil: 'networkidle', timeout: 110_000 });
    });

    await step('01_upload_and_step1', 180_000, async () => {
        await page.setInputFiles('#astro-file-input', CR2);
        await page.getByTestId('step1-proceed').click({ timeout: 170_000 });
    });

    await step('02_context_form', 20_000, async () => {
        const timeBadge = await page.getByTestId('time-source-badge').textContent({ timeout: 10_000 }).catch(() => '');
        assert(/EXIF/i.test(timeBadge || ''), `time badge should be EXIF, got "${timeBadge}"`);
        await page.getByTestId('wizard-next-step').click();
    });

    await step('03_star_detection', 420_000, async () => {
        await page.getByTestId('step3-start').click();
        await page.getByTestId('step3-confirm').click({ trial: true, timeout: 410_000 });
        const snap = await sessionSnapshot();
        log(`[step3] session stars: ${snap?.signalStars}`);
        assert((snap?.signalStars ?? 0) >= 10, `expected >=10 detections, got ${snap?.signalStars}`);
        await page.getByTestId('step3-confirm').click();
    });

    await step('04_exif_scale_lock', 45_000, async () => {
        await page.getByTestId('step4-start').click();
        await page.getByTestId('step4-confirm').click({ trial: true, timeout: 40_000 });
        const snap = await sessionSnapshot();
        log(`[step4] scaleLock=${snap?.scaleLock}`);
        if (IS_BUNDLED_SAMPLE) assertRange(snap?.scaleLock, 61, 66, 'session.scaleLock');
        await page.getByTestId('step4-confirm').click();
    });

    // Step 5 MUST solve here (unlike the smoke scenario) — no receipt otherwise.
    await step('05_blind_solve', 420_000, async () => { // ceiling > engine budget (360s, D-uw-rawler-budget-360) — the harness must never kill a solve the engine still owns
        await page.getByTestId('step5-start').click();
        const successP = page.getByTestId('step5-confirm').click({ trial: true, timeout: 290_000 }).then(() => 'solved');
        const failureP = page.getByTestId('step5-failure').waitFor({ state: 'visible', timeout: 290_000 }).then(() => 'honest_failure');
        successP.catch(() => { }); failureP.catch(() => { });
        const o = await Promise.race([successP, failureP]).catch(() => 'timeout');
        const snap = await sessionSnapshot();
        assert(o === 'solved', `receipt run needs a solution; outcome=${o} status=${snap?.status}`);
        const s = snap?.solution;
        log(`[step5] SOLVED: RA=${s?.ra_hours}h Dec=${s?.dec_degrees} scale=${s?.pixel_scale} matched=${s?.matched} conf=${s?.confidence}`);
        if (IS_BUNDLED_SAMPLE) assertRange(s?.pixel_scale, 63.35 * 0.7, 63.35 * 1.3, 'blind solution scale sanity');
        assert((s?.matched ?? 0) >= 8, `matched ${s?.matched} < 8`);
        run.summary.blindOutcome = o;
    });

    // Packet capture — serialize IN THE PAGE with save_packet's DROPPED_KEYS
    // so typed arrays never cross the wire as index-keyed objects.
    await step('06_capture_packet', 60_000, async () => {
        const json = await page.evaluate(() => {
            const DROP = new Set(['scienceBuffer', 'segmentationMasks', 'horizonVector', 'anomaly_grid']);
            const s = window.__astroSession;
            if (!s || typeof s.exportPacket !== 'function') return null;
            return JSON.stringify(s.exportPacket(), (k, v) => (DROP.has(k) ? undefined : v));
        });
        assert(json, 'window.__astroSession.exportPacket unavailable');
        const receiptPath = path.join(run.dir, 'receipt.json');
        fs.writeFileSync(receiptPath, json);
        const parsed = JSON.parse(json);
        log(`[step6] receipt: ${(json.length / 1024).toFixed(0)} KB, version=${parsed.version}, ` +
            `matched_stars=${parsed.solution?.matched_stars?.length}, wcs SOURCE=${parsed.wcs?.SOURCE}`);
        assert(parsed.solution?.matched_stars?.length >= 8, 'receipt matched_stars < 8');
        assert(parsed.wcs && Number.isFinite(parsed.wcs.CRVAL1), 'receipt has no numeric WCS block');
        log(`[step6] saved: ${receiptPath}`);
    });

    assert(run.summary.pageErrors.length === 0,
        `uncaught page errors: ${run.summary.pageErrors.join(' | ')}`);

    clearTimeout(hardKill);
    await finish(true, 'receipt captured');
    process.exit(0);
} catch (e) {
    log(`[run] FAILED: ${e && e.stack || e}`);
    clearTimeout(hardKill);
    await finish(false, String(e && e.message || e));
    process.exit(1);
}
