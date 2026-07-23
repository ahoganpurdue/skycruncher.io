// UI-wave visual capture: drives the SeeStar wizard flow and screenshots the
// new "nerd data" surfaces (step-3 culling inspector, step-6 instrument
// charts + residual quiver, M10 PSF panel strip/tiles/region grid) into
// test_results/ui_wave/. Also records the measured cost of each visual lane
// (chart geometry ms, PSF measure-only vs full-diagnostics wall time) so the
// owner's performance-gating decision is evidence-backed.
//
// Run: E2E_PORT=<port> node tools/e2e/capture_ui_wave.mjs
// NOT a gate — a reporting artifact producer. Reuses the e2e driver.

import path from 'node:path';
import fs from 'node:fs';
import { createRun, ROOT } from './lib.mjs';

const FIT = path.join(ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const OUT = path.join(ROOT, 'test_results', 'ui_wave');
fs.mkdirSync(OUT, { recursive: true });

const run = await createRun('ui_wave');
const { page, log, step, assert, finish } = run;

const save = async (name, locator = null) => {
    const file = path.join(OUT, `${name}.png`);
    if (locator) await locator.screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: false });
    log(`[capture] ${file}`);
};

const costs = {};

try {
    assert(fs.existsSync(FIT), `sample FITS missing at ${FIT}`);

    await step('00_prewarm', 120_000, async () => {
        await page.goto(run.BASE, { waitUntil: 'networkidle' });
    });

    await step('01_to_step3', 300_000, async () => {
        await page.setInputFiles('#astro-file-input', FIT);
        await page.getByTestId('step1-proceed').click({ timeout: 60_000 });
        await page.getByTestId('wizard-next-step').click();
        await page.getByTestId('step3-start').click();
        await page.getByTestId('step3-confirm').click({ trial: true, timeout: 235_000 });
    });

    await step('02_capture_culling_inspector', 30_000, async () => {
        const inspector = page.getByTestId('step3-culling-inspector');
        await inspector.waitFor({ state: 'visible', timeout: 10_000 });
        const rows = await inspector.locator('button').allTextContents();
        log(`[culling] rows: ${JSON.stringify(rows)}`);
        // trust gate: at least one row must show a non-zero count
        assert(rows.some(r => /[1-9]\d*/.test(r)), 'culling inspector still shows all zeros');
        await save('step3_culling_inspector', inspector);
        await save('step3_full');
    });

    await step('03_to_step6', 300_000, async () => {
        await page.getByTestId('step3-confirm').click();
        await page.getByTestId('step4-start').click();
        await page.getByTestId('step4-confirm').click({ timeout: 25_000 });
        await page.getByTestId('step5-start').click();
        await page.getByTestId('step5-confirm').click({ timeout: 175_000 });
        await page.getByTestId('step6-start').click();
        await page.getByTestId('step6-confirm').click({ trial: true, timeout: 85_000 });
    });

    await step('04_capture_step6_charts', 60_000, async () => {
        // charts render lazily post-profile in manual mode
        await page.getByTestId('step6-distortion-chart').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => { });
        const quiver = page.getByTestId('step6-residual-quiver');
        const hasQuiver = await quiver.isVisible().catch(() => false);
        log(`[step6] quiver visible: ${hasQuiver}`);
        await save('step6_full');
        if (hasQuiver) await save('step6_residual_quiver', quiver);
        const distortion = page.getByTestId('step6-distortion-chart');
        if (await distortion.isVisible().catch(() => false)) await save('step6_distortion_chart', distortion);
    });

    await step('05_psf_measure_only_cost', 300_000, async () => {
        // measured cost baseline: measurement-only lane via the session hook
        const r = await page.evaluate(async () => {
            const s = window.__astroSession;
            const t0 = Date.now();
            const rep = await s.runPsfDiagnostics({ deconvolve: false });
            return { ms: Date.now() - t0, n: rep.nMeasured, fwhm: rep.fwhmMedianPx, timings: rep.timings };
        });
        costs.psf_measure_only = r;
        log(`[cost] PSF measure-only: ${r.ms}ms (${r.n} stars, median FWHM ${r.fwhm?.toFixed?.(2)}px) timings=${JSON.stringify(r.timings)}`);
    });

    await step('06_psf_full_panel', 600_000, async () => {
        await page.getByTestId('step6-psf-toggle').click();
        const t0 = Date.now();
        // panel already holds the measure-only report -> click the visual lane
        const fullBtn = page.getByTestId('step6-psf-run-full');
        const runBtn = page.getByTestId('step6-psf-run');
        if (await fullBtn.isVisible().catch(() => false)) await fullBtn.click();
        else await runBtn.click();
        await page.getByTestId('step6-psf-strip').waitFor({ state: 'visible', timeout: 300_000 });
        costs.psf_full_ms = Date.now() - t0;
        log(`[cost] PSF full diagnostics (UI wall): ${costs.psf_full_ms}ms`);

        const stats = await page.getByTestId('step6-psf-stats').textContent();
        log(`[psf] stats: ${stats?.trim()}`);
        await save('step6_psf_panel', page.getByTestId('step6-psf-panel'));
        await save('step6_psf_strip', page.getByTestId('step6-psf-strip'));
        const tiles = page.getByTestId('step6-psf-tiles');
        if (await tiles.isVisible().catch(() => false)) await save('step6_psf_tiles', tiles);
        await save('step6_with_psf_full');
    });

    run.summary.costs = costs;
    fs.writeFileSync(path.join(OUT, 'costs.json'), JSON.stringify(costs, null, 2));
    await finish(true);
    process.exit(0);
} catch (e) {
    log(`[run] FAILED: ${e && e.stack || e}`);
    await finish(false, String(e && e.message || e));
    process.exit(1);
}
