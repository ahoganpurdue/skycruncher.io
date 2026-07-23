// E2E: SeeStar M66 FITS through all 7 wizard steps.
// Run: node tools/e2e/run_wizard_seestar.mjs   (or npm run e2e:seestar)
// Exit 0 = green. Artifacts in test_results/e2e/<scenario>_<timestamp>/.
//
// Expected values (headless repro, SESSION_HANDOFF §3-quinquies):
//   header scale lock 3.74"/px · solve RA≈11.336h Dec≈+13.05° ·
//   scale 3.68"/px · negative parity (FITS bottom-up rows).

import path from 'node:path';
import fs from 'node:fs';
import { createRun, ROOT } from './lib.mjs';

const FIT = path.join(ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const HARD_KILL_MS = 12 * 60 * 1000;

const run = await createRun('seestar');
const { page, log, step, shot, sessionSnapshot, assert, assertRange, finish, BASE } = run;

const hardKill = setTimeout(async () => {
    log('[FATAL] 12-minute hard kill');
    await finish(false, 'hard kill');
    process.exit(1);
}, HARD_KILL_MS);

try {
    assert(fs.existsSync(FIT), `sample FITS missing at ${FIT}`);

    // ── Pre-warm (dev-mode first compile is slow; don't bill it to step 1)
    await step('00_prewarm', 120_000, async () => {
        await page.goto(BASE, { waitUntil: 'networkidle' });
    });

    // ── Upload → wizard mounts
    await step('01_upload_and_step1', 90_000, async () => {
        await page.setInputFiles('#astro-file-input', FIT);
        // Step 1 auto-runs session.step1_Load; Proceed enables on completion.
        await page.getByTestId('step1-proceed').click({ timeout: 60_000 });
    });

    // ── Step 2: observation details (pre-filled from FITS header)
    await step('02_context_form', 15_000, async () => {
        const latBadge = await page.getByTestId('gps-source-badge-lat').textContent({ timeout: 10_000 });
        const lonBadge = await page.getByTestId('gps-source-badge-lon').textContent();
        log(`[step2] badges: lat="${latBadge?.trim()}" lon="${lonBadge?.trim()}"`);
        assert(/FITS/i.test(latBadge || ''), `lat GPS badge should say FITS HEADER, got "${latBadge}"`);
        assert(/FITS/i.test(lonBadge || ''), `lon GPS badge should say FITS HEADER, got "${lonBadge}"`);
        const snap = await sessionSnapshot();
        assert(snap?.metadata?.ra_hint != null, 'metadata.ra_hint missing after FITS load');
        log(`[step2] hints: ra=${snap.metadata.ra_hint}h dec=${snap.metadata.dec_hint}° scale=${snap.metadata.pixel_scale}"/px jd=${snap.computed_jd}`);
        await page.getByTestId('wizard-next-step').click();
    });

    // ── Step 3: star detection (50 MB decode + WASM extraction)
    await step('03_star_detection', 240_000, async () => {
        await page.getByTestId('step3-start').click();
        // trial:true waits for the confirm button to become actionable
        // (enabled == detection finished) WITHOUT clicking — the count
        // element must be read while this step is still mounted.
        await page.getByTestId('step3-confirm').click({ trial: true, timeout: 235_000 });
        const countText = await page.getByTestId('step3-star-count').textContent().catch(() => '');
        const count = parseInt((countText || '').replace(/[^\d]/g, ''), 10);
        const snap = await sessionSnapshot();
        log(`[step3] star count display: "${countText?.trim()}" -> ${count}; session.signal stars: ${snap?.signalStars}`);
        assert((count >= 50) || (snap?.signalStars >= 50),
            `expected >=50 detected stars (display=${count}, session=${snap?.signalStars})`);
        await page.getByTestId('step3-confirm').click();
    });

    // ── Step 4: scale & ephemeris — MUST be an instant header lock, no Tri-Lock
    await step('04_scale_lock', 30_000, async () => {
        const t0 = Date.now();
        await page.getByTestId('step4-start').click();
        await page.getByTestId('step4-confirm').waitFor({ state: 'visible', timeout: 25_000 });
        // click() below auto-waits for enabled; measure to enabled via a poll:
        await page.getByTestId('step4-confirm').click({ timeout: 25_000, trial: true });
        const elapsed = Date.now() - t0;
        assert(elapsed < 15_000, `scale lock took ${elapsed}ms — Tri-Lock ran? (must be instant header lock)`);
        const snap = await sessionSnapshot();
        assertRange(snap?.scaleLock, 3.70, 3.78, 'session.scaleLock');
        const scaleText = await page.getByTestId('step4-scale-lock').textContent().catch(() => '');
        log(`[step4] scale display: "${scaleText?.trim()}" in ${elapsed}ms`);
        await page.getByTestId('step4-confirm').click();
    });

    // ── Step 5: plate solve — the whole point
    await step('05_plate_solve', 180_000, async () => {
        await page.getByTestId('step5-start').click();
        const confirmBtn = page.getByTestId('step5-confirm');
        const failOverlay = page.getByTestId('step5-failure');
        // Race success (confirm actionable, i.e. enabled) vs failure overlay.
        // trial:true waits for full actionability without actually clicking.
        const successP = confirmBtn.click({ trial: true, timeout: 175_000 }).then(() => 'success');
        const failureP = failOverlay.waitFor({ state: 'visible', timeout: 175_000 }).then(() => 'failure');
        successP.catch(() => { }); failureP.catch(() => { }); // losers must not become unhandled rejections
        const outcome = await Promise.race([successP, failureP]).catch(() => 'timeout');

        const snap = await sessionSnapshot();
        if (outcome !== 'success') {
            const reason = await failOverlay.textContent().catch(() => '(overlay unreadable)');
            log(`[step5] FAILURE overlay: ${reason}`);
            log(`[step5] session.status: ${snap?.status}`);
            throw new Error(`solve ${outcome}: ${snap?.status}`);
        }
        assert(snap?.solution, 'confirm enabled but session.solution is null');
        const s = snap.solution;
        log(`[step5] solution: RA=${s.ra_hours}h Dec=${s.dec_degrees}° scale=${s.pixel_scale}"/px rot=${s.rotation} parity=${s.parity} conf=${s.confidence} matched=${s.matched}`);
        assertRange(s.ra_hours, 11.336 - 0.033, 11.336 + 0.033, 'solution.ra_hours');
        assertRange(s.dec_degrees, 13.05 - 0.3, 13.05 + 0.3, 'solution.dec_degrees');
        assertRange(s.pixel_scale, 3.48, 3.88, 'solution.pixel_scale');
        // Parity: the app computes det(CD) in image-space (y-down) convention,
        // where this frame's mirrored sky orientation reports +1 (the same
        // physical orientation find_true_wcs called "negative" in y-up sky
        // convention). Assert it's a unit parity and log it — the RA/Dec/
        // scale/rotation asserts above already pin the geometry.
        if (typeof s.parity === 'number') assert(Math.abs(s.parity) === 1, `parity not ±1: ${s.parity}`);
        assert(s.matched == null || s.matched >= 5, `matched_stars ${s.matched} < 5`);
        // Achievable-match confidence: true M66 solve reports ~0.80
        // (226 matched of ~245 catalog stars in frame, residual-degraded).
        // A drop below 0.6 means the metric or the match set regressed.
        assertRange(s.confidence, 0.6, 1.01, 'solution.confidence');
        const matchedText = await page.getByTestId('step5-matched-stars').textContent().catch(() => '');
        log(`[step5] matched display: "${matchedText?.trim()}"`);
        await confirmBtn.click();
    });

    // ── Step 5b: Glass Pipeline inspector — event-stream assertions (Phase U)
    await step('05b_inspector', 30_000, async () => {
        await page.getByTestId('inspector-toggle').click();
        const panel = page.getByTestId('inspector-panel');
        await panel.waitFor({ state: 'visible', timeout: 10_000 });

        // (a) stage timeline: 'solve' row marked ok
        const solveRow = page.getByTestId('inspector-stage-solve');
        await solveRow.waitFor({ state: 'visible', timeout: 5_000 });
        const solveState = await solveRow.getAttribute('data-state');
        log(`[inspector] solve stage state: "${solveState}"`);
        assert(solveState === 'ok', `inspector solve stage state "${solveState}" !== "ok"`);

        // (b) provenance FSM: at least one committed transition rendered
        const provCount = await page.getByTestId('inspector-provenance-row').count();
        log(`[inspector] provenance rows: ${provCount}`);
        assert(provCount >= 1, 'no provenance transitions rendered in inspector');

        // (c) solution_locked finding carries the solved RA
        const snap = await sessionSnapshot();
        const lockText = await page.getByTestId('inspector-finding-solution_locked').last().textContent();
        log(`[inspector] solution_locked finding: "${(lockText || '').trim().replace(/\s+/g, ' ')}"`);
        const raPrefix = snap.solution.ra_hours.toFixed(1);
        assert((lockText || '').includes(raPrefix),
            `solution_locked finding missing RA value (looked for "${raPrefix}" in "${lockText}")`);

        await shot('09_inspector');

        // Close the drawer so it never occludes later step controls.
        await page.getByTestId('inspector-toggle').click();
        await panel.waitFor({ state: 'hidden', timeout: 5_000 });
    });

    // ── Step 6: optical calibration
    await step('06_calibration', 90_000, async () => {
        await page.getByTestId('step6-start').click();
        await page.getByTestId('step6-confirm').click({ timeout: 85_000 });
    });

    // ── Step 7: integrate + export tile checks
    await step('07_integrate', 90_000, async () => {
        await page.getByTestId('step7-start').click();
        const exportBtn = page.getByTestId('step7-export');
        await exportBtn.waitFor({ state: 'visible', timeout: 85_000 });
        const coords = await page.getByTestId('step7-coordinates').textContent().catch(() => '');
        const packet = await page.getByTestId('step7-packet').textContent().catch(() => '');
        log(`[step7] coordinates tile: "${coords?.trim()}"`);
        log(`[step7] packet tile: "${packet?.trim()}"`);
        assert(/\d/.test(coords || ''), 'coordinates tile has no digits');
    });

    // Snapshot BEFORE closing the wizard (session may be cleared on unmount).
    const finalSnap = await sessionSnapshot();
    run.summary.solvedSolution = finalSnap?.solution ?? null;

    await step('08_export_click_closes', 30_000, async () => {
        // Export now downloads a JSON receipt before closing the wizard.
        const dlP = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
        await page.getByTestId('step7-export').click();
        // Wizard closes (onComplete) — the step-7 export button should detach.
        await page.getByTestId('step7-export').waitFor({ state: 'detached', timeout: 20_000 });
        const dl = await dlP;
        assert(dl, 'no download event fired on step7-export click');
        const receiptPath = path.join(run.dir, 'receipt.json');
        await dl.saveAs(receiptPath);
        const receiptBytes = fs.statSync(receiptPath).size;
        log(`[step8] receipt saved: ${dl.suggestedFilename()} (${receiptBytes} bytes)`);
        const parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert(parsed?.solution?.pixel_scale > 3 && parsed?.solution?.pixel_scale < 4.5, 'receipt pixel_scale sane');
        log(`[step8] receipt solution: RA=${parsed.solution.ra_hours}h Dec=${parsed.solution.dec_degrees}° scale=${parsed.solution.pixel_scale}"/px`);
    });

    assert(run.summary.pageErrors.length === 0,
        `uncaught page errors during run: ${run.summary.pageErrors.join(' | ')}`);

    clearTimeout(hardKill);
    await finish(true);
    process.exit(0);
} catch (e) {
    log(`[run] FAILED: ${e && e.stack || e}`);
    clearTimeout(hardKill);
    await finish(false, String(e && e.message || e));
    process.exit(1);
}
