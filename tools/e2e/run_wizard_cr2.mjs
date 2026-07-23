// E2E: bundled Canon CR2 through the wizard — the DSLR scenario on the SAME
// harness lib as SeeStar (one harness, many scenarios).
//
//   node tools/e2e/run_wizard_cr2.mjs
//
// Ground truth (tools/dslr/inspect_cr2_exif.mjs): Canon Rebel T6, dummy-50mm
// EXIF -> OpticsManager 14mm override -> 63.35"/px EXIF_OPTICS lock expected.
// June 2019, NO GPS (observer location absent — null, no fabricated default), 5184x3456, target unknown
// (the "M42" label is wrong — summer frame).
//
// SMOKE SEMANTICS (v1): steps 1-4 must genuinely work (decode, EXIF badges,
// detection, EXIF scale lock WITHOUT Tri-Lock). Step 5 is ultra-wide BLIND
// solve — Phase B's actual work — so EITHER a sane solution OR an honest
// failure overlay counts as scenario PASS. Crashes, hangs, or a dishonest
// state (neither solution nor failure surfaced) fail the run.
import path from 'node:path';
import fs from 'node:fs';
import { createRun, ROOT } from './lib.mjs';

// CR2_FILE overrides the bundled sample (owner corpus triage). Tight
// scale-lock assertions only apply to the bundled sample — its 63.35"/px
// comes from the known dummy-50mm -> 14mm override; arbitrary files assert
// the honest-outcome contract only.
const CR2 = process.env.CR2_FILE
    ? path.resolve(process.env.CR2_FILE)
    : path.join(ROOT, 'public', 'demo', 'sample_observation.cr2');
const IS_BUNDLED_SAMPLE = !process.env.CR2_FILE;
const HARD_KILL_MS = 15 * 60 * 1000;

const run = await createRun('cr2');
const { page, log, step, sessionSnapshot, assert, assertRange, finish } = run;

const hardKill = setTimeout(async () => {
    log('[FATAL] hard kill');
    await finish(false, 'hard kill');
    process.exit(1);
}, HARD_KILL_MS);

try {
    assert(fs.existsSync(CR2), `bundled CR2 missing at ${CR2}`);

    await step('00_prewarm', 120_000, async () => {
        // Cold vite start + dep optimization can exceed Playwright's default
        // 30s goto timeout — give the first render the full step budget.
        await page.goto(run.BASE, { waitUntil: 'networkidle', timeout: 110_000 });
    });

    // ── Upload: LibRaw-wasm decode of a 22MB CR2 (budget generous)
    await step('01_upload_and_step1', 180_000, async () => {
        await page.setInputFiles('#astro-file-input', CR2);
        await page.getByTestId('step1-proceed').click({ timeout: 170_000 });
    });

    // ── Step 2: EXIF time (green), DEFAULT GPS (amber) — honesty badges
    await step('02_context_form', 20_000, async () => {
        const timeBadge = await page.getByTestId('time-source-badge').textContent({ timeout: 10_000 }).catch(() => '');
        const latBadge = await page.getByTestId('gps-source-badge-lat').textContent().catch(() => '');
        log(`[step2] time badge="${timeBadge?.trim()}" gps badge="${latBadge?.trim()}"`);
        assert(/EXIF/i.test(timeBadge || ''), `time badge should be EXIF, got "${timeBadge}"`);
        assert(!/FITS|EXIF/i.test(latBadge || ''), `gps badge should be DEFAULT-ish (no GPS in file), got "${latBadge}"`);
        const snap = await sessionSnapshot();
        log(`[step2] camera=${snap?.metadata?.camera_model} fl=${snap?.metadata?.focal_length}`);
        await page.getByTestId('wizard-next-step').click();
    });

    // ── Step 3: DSLR Bayer detection — headless = CPU demosaic fallback (slow)
    await step('03_star_detection', 420_000, async () => {
        await page.getByTestId('step3-start').click();
        await page.getByTestId('step3-confirm').click({ trial: true, timeout: 410_000 });
        const snap = await sessionSnapshot();
        log(`[step3] session stars: ${snap?.signalStars}`);
        assert((snap?.signalStars ?? 0) >= 10, `expected >=10 detections on a real night frame, got ${snap?.signalStars}`);
        await page.getByTestId('step3-confirm').click();
    });

    // ── Step 4: EXIF_OPTICS scale lock — the trust ladder's middle rung.
    // MUST be fast (no ~15s Tri-Lock) and land at the 14mm-override scale.
    await step('04_exif_scale_lock', 45_000, async () => {
        const t0 = Date.now();
        await page.getByTestId('step4-start').click();
        await page.getByTestId('step4-confirm').click({ trial: true, timeout: 40_000 });
        const elapsed = Date.now() - t0;
        const snap = await sessionSnapshot();
        log(`[step4] scaleLock=${snap?.scaleLock} in ${elapsed}ms; status="${snap?.status}"`);
        if (IS_BUNDLED_SAMPLE) {
            assertRange(snap?.scaleLock, 61, 66, 'session.scaleLock (63.35 expected via 14mm override)');
            assert(elapsed < 20_000, `scale lock took ${elapsed}ms — Tri-Lock ran? EXIF rung should be instant-ish`);
        } else {
            assert(Number.isFinite(snap?.scaleLock) && snap.scaleLock > 0, `no scale lock produced (got ${snap?.scaleLock})`);
        }
        await page.getByTestId('step4-confirm').click();
    });

    // ── Step 5: ultra-wide BLIND solve — honest outcome either way
    const outcome = await step('05_blind_solve_attempt', 420_000, async () => { // ceiling > engine budget (360s, D-uw-rawler-budget-360) — the harness must never kill a solve the engine still owns
        await page.getByTestId('step5-start').click();
        const successP = page.getByTestId('step5-confirm').click({ trial: true, timeout: 290_000 }).then(() => 'solved');
        const failureP = page.getByTestId('step5-failure').waitFor({ state: 'visible', timeout: 290_000 }).then(() => 'honest_failure');
        successP.catch(() => { }); failureP.catch(() => { });
        const o = await Promise.race([successP, failureP]).catch(() => 'timeout');
        const snap = await sessionSnapshot();
        if (o === 'solved') {
            const s = snap?.solution;
            log(`[step5] BLIND SOLVED: RA=${s?.ra_hours}h Dec=${s?.dec_degrees} scale=${s?.pixel_scale} matched=${s?.matched} conf=${s?.confidence}`);
            assert(s, 'confirm enabled but no solution');
            if (IS_BUNDLED_SAMPLE) {
                assertRange(s.pixel_scale, 63.35 * 0.7, 63.35 * 1.3, 'blind solution scale sanity');
            } else {
                assertRange(s.pixel_scale, 1, 120, 'blind solution scale physically plausible for a DSLR');
            }
            assert((s.matched ?? 0) >= 8, `matched ${s.matched} < 8`);
        } else if (o === 'honest_failure') {
            const reason = await page.getByTestId('step5-failure').textContent().catch(() => '');
            log(`[step5] HONEST FAILURE (acceptable for smoke v1): ${reason?.trim()?.slice(0, 160)}`);
            log(`[step5] status: ${snap?.status}`);
        } else {
            throw new Error(`dishonest terminal state: neither solution nor failure surfaced (status: ${snap?.status})`);
        }
        run.summary.blindOutcome = o;
        return o;
    });

    // ── Step 6: forensic calibration — the POST-SOLVE chain that populates
    // solution.bc_rematch (psf_field → psf_attribution → measured-BC →
    // bc_rematch → forced_confirm; orchestrator_session.step5_Calibrate). The
    // blind-solve step above (step5) pins the CENTER-HEAVY acquisition solve;
    // this step reaches the PRIMARY measured-Brown-Conrady two-pass edge-star
    // densification rail (landed cbc55b4) so its full-frame rematch OUTCOME
    // (on this frame: guard KEPT_ORIGINAL) can be pinned by ADDITION. Only
    // meaningful on a real solve.
    if (outcome === 'solved' && IS_BUNDLED_SAMPLE) {
        await step('06_bc_rematch_pin', 300_000, async () => {
            // Advance out of the blind-solve step (trial-clicked above) into the
            // calibration step, then run it. step6-confirm (Finalize) is disabled
            // until calibration finished (hasRun && !loading), so trial-waiting on
            // it means solution.bc_rematch is populated.
            await page.getByTestId('step5-confirm').click();
            await page.getByTestId('step6-start').click();
            await page.getByTestId('step6-confirm').click({ trial: true, timeout: 290_000 });
            // lib.mjs sessionSnapshot is scalar-only and omits bc_rematch by
            // design — read the block directly off the dev-exposed session
            // (drop the heavy per-star recovered_stars array).
            const bc = await page.evaluate(() => {
                const s = window.__astroSession;
                const b = s && s.solution && s.solution.bc_rematch;
                if (!b) return null;
                const { recovered_stars, ...rest } = b;
                return { ...rest, recovered_stars_len: recovered_stars ? recovered_stars.length : null };
            });
            log(`[step6] bc_rematch: ${JSON.stringify(bc)}`);
            run.summary.bcRematch = bc;

            // ── PINNED REFERENCE (bc_rematch, REBASELINED 2026-07-11 at the decoder
            // cutover ceremony — rawler is now the DEFAULT arm; deterministic
            // run-to-run, values measured twice tonight: 06:25Z flag-ON run +
            // ceremony rebaseline). The measured-BC two-pass edge-star densification
            // rail (cbc55b4) RUNS on the bundled CR2 but its structural never-worse
            // guard KEEPS THE ORIGINAL on the rawler arm too: the BC-corrected
            // re-match does not beat the blind solve's RMS (537.8008" → 616.8437" is
            // WORSE), so applied=false and the solve above stays exactly the pinned
            // 79-matched rawler acquisition. Pinning the KEPT_ORIGINAL outcome +
            // before/after counts + before/after RMS locks this behavior (by ADDITION
            // — the step5 acquisition pins above are untouched). Exact equality
            // (count) + exact float repr (RMS). COLD PATH: VITE_DECODER_RAWLER=0
            // restores the pre-cutover libraw pins (26/26, 410.0983"→487.2165").
            assert(bc, 'bc_rematch absent from session.solution after calibration');
            assert(bc.attempted === true, `bc_rematch.attempted ${bc.attempted} !== true`);
            assert(bc.guard === 'KEPT_ORIGINAL', `bc_rematch.guard "${bc.guard}" !== "KEPT_ORIGINAL"`);
            assert(bc.applied === false, `bc_rematch.applied ${bc.applied} !== false`);
            assert(bc.matched_before === 56, `bc_rematch.matched_before ${bc.matched_before} !== 56`);
            assert(bc.matched_after === 56, `bc_rematch.matched_after ${bc.matched_after} !== 56`);
            assert(bc.rms_before_arcsec === 537.8008, `bc_rematch.rms_before_arcsec ${bc.rms_before_arcsec} !== 537.8008`);
            assert(bc.rms_after_arcsec === 616.8437, `bc_rematch.rms_after_arcsec ${bc.rms_after_arcsec} !== 616.8437`);
            log('[step6] bc_rematch PINNED: KEPT_ORIGINAL, matched 56→56, rms 537.8008"→616.8437" (guard held, rawler arm)');
        });
    }

    log(`[run] CR2 smoke complete — blind outcome: ${outcome}`);
    assert(run.summary.pageErrors.length === 0,
        `uncaught page errors: ${run.summary.pageErrors.join(' | ')}`);

    clearTimeout(hardKill);
    await finish(true, `blind:${outcome}`);
    process.exit(0);
} catch (e) {
    log(`[run] FAILED: ${e && e.stack || e}`);
    clearTimeout(hardKill);
    await finish(false, String(e && e.message || e));
    process.exit(1);
}
