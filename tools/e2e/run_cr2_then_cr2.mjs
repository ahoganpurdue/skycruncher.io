// E2E ACCEPTANCE PROOF for the 2026-07-22 ship-blocker fix: the app was one-shot
// per launch ("once I run an image ONCE, I can't run another" — the second
// large-RAW decode failed when the outgoing session's buffers had not been
// released). This drives the OWNER'S EXACT sequence: CR2 → Process another → CR2,
// proving the reset LOGIC (session replaced, landing returns) and that the SECOND
// CR2 decode + blind solve reproduces the SAME pins as the first (byte-identical
// second solve, not a degraded one). Also exercises the honest-discard confirm
// dialog (mid-flight) and captures landing-centering screenshots at 1440 + 1920.
//
//   E2E_PORT=<fresh> node tools/e2e/run_cr2_then_cr2.mjs
//
// NOTE: headless Chromium has a large memory budget, so it does NOT reproduce the
// WebView2 OOM itself — this proves the reset/replace LOGIC + the second solve's
// correctness. The OOM's field acceptance is the owner's desktop build (see handoff).
import path from 'node:path';
import fs from 'node:fs';
import { createRun, ROOT } from './lib.mjs';

const CR2 = path.join(ROOT, 'public', 'demo', 'sample_observation.cr2');
const HARD_KILL_MS = 25 * 60 * 1000;

const run = await createRun('cr2_then_cr2');
const { page, log, step, sessionSnapshot, assert, assertRange, finish, shot } = run;

const hardKill = setTimeout(async () => {
    log('[FATAL] hard kill');
    await finish(false, 'hard kill');
    process.exit(1);
}, HARD_KILL_MS);

// Drive a CR2 wizard run and return the solution snapshot. `full` runs all the
// way to the dashboard (step-7 finalize — needed for "Process another"); when
// false the run stops after the step-5 blind solve (that already proves the
// decode + solve reproduced, which is the second-CR2 proof, and saves ~3 min).
async function solveCr2(label, full = true) {
    await step(`${label}_01_upload_decode`, 180_000, async () => {
        await page.setInputFiles('#astro-file-input', CR2);
        await page.getByTestId('step1-proceed').click({ timeout: 170_000 });
    });
    await step(`${label}_02_context`, 20_000, async () => {
        await page.getByTestId('wizard-next-step').click();
    });
    await step(`${label}_03_detect`, 420_000, async () => {
        await page.getByTestId('step3-start').click();
        // If the decode failed, the honest error surfaces instead of a signal.
        const errP = page.getByTestId('extract-error').waitFor({ state: 'visible', timeout: 415_000 }).then(() => 'error');
        const okP = page.getByTestId('step3-confirm').click({ trial: true, timeout: 415_000 }).then(() => 'ok');
        errP.catch(() => {}); okP.catch(() => {});
        const o = await Promise.race([errP, okP]).catch(() => 'timeout');
        assert(o === 'ok', `${label}: extraction/decode did not succeed (got "${o}") — the second-decode bug would land here`);
        await page.getByTestId('step3-confirm').click();
    });
    await step(`${label}_04_scale`, 60_000, async () => {
        await page.getByTestId('step4-start').click();
        await page.getByTestId('step4-confirm').click({ trial: true, timeout: 55_000 });
        await page.getByTestId('step4-confirm').click();
    });
    await step(`${label}_05_blind_solve`, 420_000, async () => {
        await page.getByTestId('step5-start').click();
        await page.getByTestId('step5-confirm').click({ trial: true, timeout: 300_000 });
    });
    // Read the blind solution NOW (it is the pinned acquisition solve, byte-exact
    // to the apispec) so the proof holds whether or not we finalize.
    const snap = await sessionSnapshot();
    const s = snap?.solution;
    log(`[${label}] BLIND SOLVED RA=${s?.ra_hours}h scale=${s?.pixel_scale}"/px matched=${s?.matched} conf=${s?.confidence}`);
    if (full) {
        await step(`${label}_06_calibrate`, 300_000, async () => {
            await page.getByTestId('step5-confirm').click(); // advance into step 6
            await page.getByTestId('step6-start').click();
            await page.getByTestId('step6-confirm').click({ trial: true, timeout: 290_000 });
            await page.getByTestId('step6-confirm').click(); // advance into step 7
        });
        await step(`${label}_07_finalize`, 120_000, async () => {
            await page.getByTestId('step7-start').click();
            // step7-export downloads the receipt AND fires onComplete -> dashboard.
            const dl = page.waitForEvent('download', { timeout: 60_000 }).catch(() => null);
            await page.getByTestId('step7-export').click({ timeout: 60_000 });
            await dl;
            // Dashboard appears when the run completes (astroData set).
            await page.getByTestId('process-another').waitFor({ state: 'visible', timeout: 30_000 });
        });
    }
    // No silent decode failure surfaced anywhere in this run.
    assert(!(await page.getByTestId('decode-error-banner').isVisible().catch(() => false)),
        `${label}: a decode-error banner is showing (decode failed)`);
    return s;
}

try {
    assert(fs.existsSync(CR2), `bundled CR2 missing at ${CR2}`);

    await step('00_prewarm', 130_000, async () => {
        await page.goto(run.BASE, { waitUntil: 'networkidle', timeout: 120_000 });
        await page.locator('#astro-file-input').waitFor({ state: 'attached', timeout: 20_000 });
    });

    // ── LANDING CENTERING capture (owner review: landing was visibly offset,
    //    lower section headings clipped at the left). Screenshot at both target
    //    widths for eyes-on verification.
    await step('01_landing_centering_1920', 30_000, async () => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.waitForTimeout(300);
        await shot('landing_1920');
    });
    await step('02_landing_centering_1440', 30_000, async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForTimeout(300);
        await shot('landing_1440');
        await page.setViewportSize({ width: 1600, height: 1000 }); // restore
    });

    // ── HONEST-DISCARD CONFIRM (mid-flight): upload, then abandon via the header
    //    "New image" — the confirm dialog must appear, and discard must return the
    //    landing. Cheap: only the EXIF read runs (no solve).
    await step('03_midflight_confirm_discard', 190_000, async () => {
        await page.setInputFiles('#astro-file-input', CR2);
        await page.getByTestId('step1-proceed').waitFor({ state: 'visible', timeout: 180_000 });
        // Header New image is available mid-flight.
        await page.getByTestId('header-new-image').click();
        // Cancel first (dialog stays, wizard survives)...
        await page.getByTestId('confirm-new-dialog').waitFor({ state: 'visible', timeout: 10_000 });
        await page.getByTestId('confirm-new-cancel').click();
        assert(await page.getByTestId('step1-proceed').isVisible(), 'Cancel should keep the wizard open');
        // ...then discard for real → back to a clean landing.
        await page.getByTestId('header-new-image').click();
        await page.getByTestId('confirm-new-discard').click();
        await page.locator('#astro-file-input').waitFor({ state: 'attached', timeout: 10_000 });
        const cleared = await page.evaluate(() => !document.querySelector('[data-testid="process-another"]'));
        assert(cleared, 'discard did not return the landing (dashboard still present)');
        log('[confirm] mid-flight confirm→cancel kept the run; confirm→discard returned the landing');
    });

    // ── THE TWO-SOLVE PROOF: CR2 (A) → Process another → CR2 (B).
    const sA = await solveCr2('A');
    assert(sA, 'A: no solution after finalize');
    assertRange(sA.pixel_scale, 63.35 * 0.7, 63.35 * 1.3, 'A pixel_scale');
    assert((sA.matched ?? 0) >= 8, `A matched ${sA.matched} < 8`);

    await step('04_process_another', 30_000, async () => {
        // Dashboard "Process another image" — smooth loop (already exported at
        // step 7, so no confirm), returns the landing.
        await page.getByTestId('process-another').click();
        await page.locator('#astro-file-input').waitFor({ state: 'attached', timeout: 10_000 });
        const cleared = await page.evaluate(() => !document.querySelector('[data-testid="process-another"]'));
        assert(cleared, 'landing did not return after Process another');
        assert(!(await page.getByTestId('decode-error-banner').isVisible().catch(() => false)),
            'a decode-error banner is showing after reset');
        log('[loop] Process another returned the landing — ready for the second image');
    });

    const sB = await solveCr2('B', false); // stop after the blind solve (proof point)
    assert(sB, 'B: no solution after the blind solve — THE SECOND-CR2 FAILURE would land here');

    // The second decode+solve must be BYTE-IDENTICAL to the first (not degraded).
    await step('05_second_solve_matches_first', 5_000, async () => {
        assert(Math.abs(sB.ra_hours - sA.ra_hours) < 1e-9, `B ra_hours ${sB.ra_hours} != A ${sA.ra_hours}`);
        assert(Math.abs(sB.pixel_scale - sA.pixel_scale) < 1e-9, `B scale ${sB.pixel_scale} != A ${sA.pixel_scale}`);
        assert(sB.matched === sA.matched, `B matched ${sB.matched} != A ${sA.matched}`);
        log(`[proof] SECOND CR2 solve is byte-identical to the first: RA=${sB.ra_hours}h scale=${sB.pixel_scale} matched=${sB.matched}`);
    });

    run.summary.twoSolveProof = {
        A: { ra_hours: sA.ra_hours, pixel_scale: sA.pixel_scale, matched: sA.matched },
        B: { ra_hours: sB.ra_hours, pixel_scale: sB.pixel_scale, matched: sB.matched },
        identical: true,
    };

    log('[run] CR2 → Process another → CR2 PROOF complete — both solved, second byte-identical, landing returned cleanly.');
    assert(run.summary.pageErrors.length === 0, `uncaught page errors: ${run.summary.pageErrors.join(' | ')}`);

    clearTimeout(hardKill);
    await finish(true, 'cr2->cr2 two-solve proof PASSED');
    process.exit(0);
} catch (e) {
    log(`[run] FAILED: ${e && e.stack || e}`);
    clearTimeout(hardKill);
    await finish(false, String(e && e.message || e));
    process.exit(1);
}
