// E2E REGRESSION RIG: wizard step-action buttons must stay ON-SCREEN at short
// laptop viewports. Walks all 7 wizard steps (bundled SeeStar M66 live-solve) at
// BOTH 1366×768 and 1280×720 and asserts every ENABLED primary step-action
// button's bounding box is fully inside the viewport — WITHOUT letting Playwright
// auto-scroll it into view first (real users don't auto-scroll; that is the whole
// defect — the Confirm buttons lived inside a step's scroll column with no
// affordance, reading as "buttons covered by text boxes, can't progress").
//
// Run:  E2E_PORT=<fresh> node tools/e2e/verify_wizard_viewport.mjs
// Exit 0 = every strict button on-screen at both sizes. Exit 1 = a regression.
//
// SCOPE (mirrors the fix): steps 1-6 progression buttons are PINNED (shrink-0
// action rows) → checked STRICTLY (must be in-viewport with no scroll). Step 7's
// export lives in a deliberately different compact scroll strip under the hero
// image (its own visible scrollbar) → checked as REACHABLE (in-viewport after
// scrolling its own container), never as pinned. This rig FAILS on the pre-fix
// tree (step 3/4/5 Confirm below the fold) and PASSES on the fixed tree.

import path from 'node:path';
import fs from 'node:fs';
import { createRun, ROOT } from './lib.mjs';

const FIT = path.join(ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const HARD_KILL_MS = 20 * 60 * 1000;
const EPS = 1; // sub-pixel rounding tolerance (CSS px)

// Viewports: the two the owner's demo laptop is likely to run at.
//   1366×768  — common physical laptop panel
//   1280×720  — 1920×1080 @150% DPI scaling, effective CSS px
const VIEWPORTS = [
    { w: 1366, h: 768 },
    { w: 1280, h: 720 },
];

const run = await createRun('wizard_viewport');
const { page, log, shot, sessionSnapshot, assert, finish, BASE } = run;

// Every measurement (pass or fail) is recorded here; strict failures are asserted
// at the very end so a single run reports the full picture across both viewports.
const results = [];

const hardKill = setTimeout(async () => {
    log('[FATAL] 20-minute hard kill');
    await finish(false, 'hard kill');
    process.exit(1);
}, HARD_KILL_MS);

/** Wait until a testid is visible AND enabled, WITHOUT scrolling it into view. */
async function waitEnabled(testid, timeout) {
    const loc = page.getByTestId(testid);
    await loc.waitFor({ state: 'visible', timeout });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await loc.isEnabled().catch(() => false)) return;
        await page.waitForTimeout(200);
    }
    throw new Error(`${testid} never became enabled within ${timeout}ms`);
}

/** Step 5 solve: succeed when confirm is enabled, throw if the failure overlay shows. */
async function waitSolveOrFail(okTestid, failTestid, timeout) {
    const okLoc = page.getByTestId(okTestid);
    const failLoc = page.getByTestId(failTestid);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await failLoc.isVisible().catch(() => false)) {
            const why = await failLoc.textContent().catch(() => '(overlay unreadable)');
            throw new Error(`${failTestid} appeared — solve failed: ${(why || '').trim().replace(/\s+/g, ' ')}`);
        }
        if ((await okLoc.isVisible().catch(() => false)) && (await okLoc.isEnabled().catch(() => false))) return;
        await page.waitForTimeout(300);
    }
    throw new Error(`${okTestid} never became enabled within ${timeout}ms`);
}

/**
 * Measure a button's viewport-relative box (getBoundingClientRect via Playwright —
 * NO scroll) and record whether it is fully inside the viewport. `strict` rows are
 * asserted at the end; non-strict rows are informational.
 */
async function measure(testid, vp, label, { strict }) {
    const loc = page.getByTestId(testid);
    await loc.waitFor({ state: 'visible', timeout: 15_000 });
    const enabled = await loc.isEnabled().catch(() => false);
    const box = await loc.boundingBox();
    let inViewport = false;
    if (box) {
        inViewport =
            box.x >= -EPS &&
            box.y >= -EPS &&
            box.x + box.width <= vp.w + EPS &&
            box.y + box.height <= vp.h + EPS;
    }
    const row = {
        viewport: `${vp.w}x${vp.h}`, label, testid, strict, enabled, inViewport,
        box: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), bottom: Math.round(box.y + box.height), right: Math.round(box.x + box.width) } : null,
    };
    results.push(row);
    log(`[measure ${row.viewport}] ${label} [${testid}] enabled=${enabled} inViewport=${inViewport} box=${box ? `(${row.box.x},${row.box.y} ${row.box.w}x${row.box.h}) bottom=${row.box.bottom}` : 'null'} (vp.h=${vp.h})`);
    return row;
}

/** Advance the wizard by clicking (Playwright auto-scrolls — advancing is fine). */
async function clickAdvance(testid) {
    await page.getByTestId(testid).click({ timeout: 30_000 });
}

async function walkAtViewport(vp) {
    log(`==================== VIEWPORT ${vp.w}x${vp.h} ====================`);
    await page.setViewportSize({ width: vp.w, height: vp.h });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.setInputFiles('#astro-file-input', FIT);

    // Step 1 — Ingestion → Proceed (pinned)
    await waitEnabled('step1-proceed', 90_000);
    await measure('step1-proceed', vp, 'Step 1 · Proceed to Context', { strict: true });
    await clickAdvance('step1-proceed');

    // Step 2 — Context form → Next Step (modal footer, pinned)
    await waitEnabled('wizard-next-step', 15_000);
    await measure('wizard-next-step', vp, 'Step 2 · Next Step', { strict: true });
    await clickAdvance('wizard-next-step');

    // Step 3 — Star detection → Confirm and Align (was below the fold pre-fix)
    await page.getByTestId('step3-start').click({ timeout: 30_000 });
    await waitEnabled('step3-confirm', 240_000);
    await measure('step3-confirm', vp, 'Step 3 · Confirm and Align', { strict: true });
    await shot(`vp_${vp.w}x${vp.h}_step3`);
    await clickAdvance('step3-confirm');

    // Step 4 — Scale & ephemeris → Confirm Alignment (was clipped pre-fix)
    await page.getByTestId('step4-start').click({ timeout: 30_000 });
    await waitEnabled('step4-confirm', 30_000);
    await measure('step4-confirm', vp, 'Step 4 · Confirm Alignment', { strict: true });
    await shot(`vp_${vp.w}x${vp.h}_step4`);
    await clickAdvance('step4-confirm');

    // Step 5 — Plate solve → Confirm Geometry
    await page.getByTestId('step5-start').click({ timeout: 30_000 });
    await waitSolveOrFail('step5-confirm', 'step5-failure', 180_000);
    await measure('step5-confirm', vp, 'Step 5 · Confirm Geometry', { strict: true });
    const snap = await sessionSnapshot();
    log(`[solve ${vp.w}x${vp.h}] RA=${snap?.solution?.ra_hours}h scale=${snap?.solution?.pixel_scale}"/px matched=${snap?.solution?.matched}`);
    await clickAdvance('step5-confirm');

    // Step 6 — Optical calibration → Finalize Profile
    await page.getByTestId('step6-start').click({ timeout: 30_000 });
    await waitEnabled('step6-confirm', 90_000);
    await measure('step6-confirm', vp, 'Step 6 · Finalize Profile', { strict: true });
    await clickAdvance('step6-confirm');

    // Step 7 — Integrate + Export. Export lives in a compact scroll strip by design
    // (its own visible scrollbar), so it is REACHABLE, not pinned: measure as-is
    // (informational), then confirm it comes fully on-screen after scrolling its
    // own container. Do NOT click export — that downloads + closes the wizard.
    await page.getByTestId('step7-start').click({ timeout: 30_000 });
    await page.getByTestId('step7-export').waitFor({ state: 'visible', timeout: 90_000 });
    await measure('step7-export', vp, 'Step 7 · Export (pre-scroll)', { strict: false });
    await page.getByTestId('step7-export').scrollIntoViewIfNeeded({ timeout: 15_000 });
    const reach = await measure('step7-export', vp, 'Step 7 · Export (reachable, post-scroll)', { strict: true });
    assert(reach.inViewport, `Step 7 export not reachable in ${vp.w}x${vp.h} even after scrolling its strip`);
    await shot(`vp_${vp.w}x${vp.h}_step7`);
}

try {
    assert(fs.existsSync(FIT), `sample FITS missing at ${FIT}`);

    // Prewarm: dev-mode first compile is slow; don't bill it to step 1.
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 120_000 });

    for (const vp of VIEWPORTS) {
        await walkAtViewport(vp);
    }

    // ── Verdict: every STRICT button must have been fully inside the viewport ──
    const strictFails = results.filter(r => r.strict && !r.inViewport);
    log('');
    log('──────────── SUMMARY (strict = pinned progression buttons) ────────────');
    for (const r of results) {
        const tag = r.strict ? (r.inViewport ? 'PASS' : 'FAIL') : (r.inViewport ? 'ok  ' : 'note');
        log(`  [${tag}] ${r.viewport}  ${r.label}  bottom=${r.box?.bottom ?? '—'}/${r.viewport.split('x')[1]}`);
    }
    run.summary.viewportResults = results;

    assert(strictFails.length === 0,
        `${strictFails.length} step-action button(s) BELOW THE FOLD: ` +
        strictFails.map(r => `${r.label}@${r.viewport} (bottom=${r.box?.bottom ?? 'null'} > ${r.viewport.split('x')[1]})`).join('; '));

    assert(run.summary.pageErrors.length === 0,
        `uncaught page errors during run: ${run.summary.pageErrors.join(' | ')}`);

    clearTimeout(hardKill);
    await finish(true);
    process.exit(0);
} catch (e) {
    log(`[run] FAILED: ${e && e.stack || e}`);
    run.summary.viewportResults = results;
    clearTimeout(hardKill);
    await finish(false, String(e && e.message || e));
    process.exit(1);
}
