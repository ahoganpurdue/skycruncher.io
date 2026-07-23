// E2E: Canon 60Da raw Bayer FITS (NAXIS=2 CFA) through the wizard.
// Repro/verify harness for the "get_cfa_input_ptr on uninitialized WASM" crash
// in the native-Bayer detection lane (analyzeBayerNative -> binBayerToLuminance).
//
//   E2E_PORT=<fresh> node tools/e2e/run_wizard_carina.mjs
//
// Contract: step-3 native-Bayer detection must NOT crash and must detect stars.
// Steps 4/5 (scale + blind/deep solve) are BONUS signal — honest outcome either
// way. A page error mentioning get_cfa_input_ptr === the bug reproduced.
import path from 'node:path';
import fs from 'node:fs';
import { createRun, ROOT } from './lib.mjs';

const FIT = process.env.FIT_FILE
    ? path.resolve(process.env.FIT_FILE)
    : path.join(ROOT, 'Sample Files', 'rotating', 'carina60Da_180s_iso800_001.fit');
const HARD_KILL_MS = 12 * 60 * 1000;

const run = await createRun('carina');
const { page, log, step, sessionSnapshot, assert, finish, BASE } = run;

// The CFA crash is CAUGHT by SignalGraphStep's try/catch, so it surfaces as a
// browser console.error ("Extraction failed: ...get_cfa_input_ptr"), NOT an
// uncaught pageerror. Track both.
const cfaHits = [];
page.on('console', (msg) => {
    if (msg.type() === 'error' && /get_cfa_input_ptr|bin_bayer_to_luma/.test(msg.text())) cfaHits.push(msg.text());
});
const cfaCrash = () => cfaHits.length > 0 || run.summary.pageErrors.some(e => /get_cfa_input_ptr|bin_bayer_to_luma/.test(e));

const hardKill = setTimeout(async () => {
    log('[FATAL] hard kill');
    await finish(false, 'hard kill');
    process.exit(1);
}, HARD_KILL_MS);

try {
    assert(fs.existsSync(FIT), `Carina FITS missing at ${FIT}`);

    await step('00_prewarm', 120_000, async () => {
        await page.goto(BASE, { waitUntil: 'networkidle', timeout: 110_000 });
    });

    await step('01_upload_and_step1', 120_000, async () => {
        await page.setInputFiles('#astro-file-input', FIT);
        await page.getByTestId('step1-proceed').click({ timeout: 110_000 });
    });

    await step('02_context_form', 30_000, async () => {
        const snap = await sessionSnapshot();
        log(`[step2] format=${snap?.sourceFormat} camera=${snap?.metadata?.camera_model} ra_hint=${snap?.metadata?.ra_hint} dec_hint=${snap?.metadata?.dec_hint} fl=${snap?.metadata?.focal_length}`);
        await page.getByTestId('wizard-next-step').click();
    });

    // ── Step 3: NATIVE BAYER detection — the crash point.
    await step('03_star_detection', 420_000, async () => {
        await page.getByTestId('step3-start').click();
        // Race: detection completes (confirm actionable) vs a CFA crash page error.
        const doneP = page.getByTestId('step3-confirm').click({ trial: true, timeout: 410_000 }).then(() => 'done');
        const crashP = (async () => {
            while (!cfaCrash()) await new Promise(r => setTimeout(r, 500));
            return 'crash';
        })();
        doneP.catch(() => {});
        const outcome = await Promise.race([doneP, crashP]);
        if (outcome === 'crash') {
            throw new Error(`BUG REPRODUCED: native-Bayer detection crashed — ${cfaHits[0] || run.summary.pageErrors.find(e => /get_cfa_input_ptr|bin_bayer_to_luma/.test(e))}`);
        }
        const countText = await page.getByTestId('step3-star-count').textContent().catch(() => '');
        const count = parseInt((countText || '').replace(/[^\d]/g, ''), 10);
        const snap = await sessionSnapshot();
        log(`[step3] star count display: "${countText?.trim()}" -> ${count}; session.signal stars: ${snap?.signalStars}`);
        run.summary.detectedStars = snap?.signalStars ?? count;
        assert((count >= 20) || (snap?.signalStars >= 20),
            `expected >=20 detections on a 180s Carina sub (display=${count}, session=${snap?.signalStars})`);
        await page.getByTestId('step3-confirm').click();
    });

    log(`[run] DETECTION OK — stars: ${run.summary.detectedStars}`);

    // ── Step 4 (BONUS): scale lock — honest outcome.
    const step4ok = await step('04_scale', 60_000, async () => {
        try {
            await page.getByTestId('step4-start').click();
            await page.getByTestId('step4-confirm').click({ trial: true, timeout: 50_000 });
            const snap = await sessionSnapshot();
            log(`[step4] scaleLock=${snap?.scaleLock} status="${snap?.status}"`);
            await page.getByTestId('step4-confirm').click();
            return true;
        } catch (e) { log(`[step4] non-fatal: ${e.message}`); return false; }
    }).catch(() => false);

    // ── Step 5 (BONUS): solve attempt — honest outcome either way.
    if (step4ok) {
        await step('05_solve_attempt', 300_000, async () => {
            try {
                await page.getByTestId('step5-start').click();
                const successP = page.getByTestId('step5-confirm').click({ trial: true, timeout: 290_000 }).then(() => 'solved');
                const failureP = page.getByTestId('step5-failure').waitFor({ state: 'visible', timeout: 290_000 }).then(() => 'honest_failure');
                successP.catch(() => {}); failureP.catch(() => {});
                const o = await Promise.race([successP, failureP]).catch(() => 'timeout');
                const snap = await sessionSnapshot();
                run.summary.solveOutcome = o;
                if (o === 'solved') {
                    const s = snap?.solution;
                    log(`[step5] SOLVED: RA=${s?.ra_hours}h Dec=${s?.dec_degrees} scale=${s?.pixel_scale} matched=${s?.matched} conf=${s?.confidence}`);
                } else {
                    log(`[step5] ${o} (bonus — not required). status="${snap?.status}"`);
                }
            } catch (e) { log(`[step5] non-fatal: ${e.message}`); }
        }).catch(() => {});
    }

    assert(!cfaCrash(), `CFA crash page error present: ${run.summary.pageErrors.join(' | ')}`);
    clearTimeout(hardKill);
    await finish(true, `detected:${run.summary.detectedStars} solve:${run.summary.solveOutcome ?? 'n/a'}`);
    process.exit(0);
} catch (e) {
    log(`[run] FAILED: ${e && e.stack || e}`);
    clearTimeout(hardKill);
    await finish(false, String(e && e.message || e));
    process.exit(1);
}
