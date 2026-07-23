// Live Playwright verification for the Phase-C2 multi-widget popout workspace
// (DASHBOARD_DOCKING_SPEC §5b, feature 2). Loads the ALREADY-RUNNING dev server
// at the `#/popout?panel=<widgetId>` route and asserts — without dispatching any
// synthetic events — that the popout page mounts a FULL DockingSurface (its own
// dockview tree) WITH its own widget ribbon, seeded with the popped widget.
//
// The WebviewWindow itself (the real second OS window main opens) CANNOT be
// exercised headlessly — this proves only that the popout PAGE is a full docking
// workspace, which is the headless-observable half of feature 2. The tear-off
// gesture + cross-monitor drop + bounds persistence are owner-2-monitor-walkthrough
// items (see §5b "Verification").
//
// Usage:  POPOUT_URL=http://127.0.0.1:3288/#/popout?panel=solve_summary node tools/e2e/verify_popout_surface.mjs
//   • POPOUT_URL — page to load (default http://127.0.0.1:3288/#/popout?panel=solve_summary)
//   • E2E_HEADED — set to run headed; default headless
//   • uses a FRESH browser context (empty localStorage) so first-run defaults apply
//     (ribbon defaults EXPANDED; the popout surface seeds the popped widget).

import { chromium } from 'playwright';

const URL = process.env.POPOUT_URL || 'http://127.0.0.1:3288/#/popout?panel=solve_summary';
const MIN_CHIPS = 30;
const HOST = '[data-testid="popout-host"]';
const SURFACE = '[data-testid="docking-surface"]';
const RIBBON = '[data-testid="widget-ribbon"]';
const SEEDED_PANEL = '[data-testid="widget-panel-solve_summary"]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);

async function probe(page) {
    return page.evaluate((sel) => {
        const q = (s) => document.querySelector(s);
        const host = q(sel.HOST);
        const surface = q(sel.SURFACE);
        const ribbon = q(sel.RIBBON);
        const seeded = q(sel.SEEDED_PANEL);
        return {
            host: !!host,
            surface: !!surface,
            ribbon: !!ribbon,
            ribbonPosition: ribbon ? getComputedStyle(ribbon).position : null,
            chips: ribbon ? ribbon.querySelectorAll('[draggable="true"]').length : 0,
            seededPanel: !!seeded,
        };
    }, { HOST, SURFACE, RIBBON, SEEDED_PANEL });
}

async function main() {
    log(`launching Chrome (headless=${!process.env.E2E_HEADED}) → ${URL}`);
    const browser = await chromium.launch({
        channel: process.env.E2E_BROWSER_CHANNEL || 'chrome',
        headless: !process.env.E2E_HEADED,
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => log(`[pageerror] ${e}`));

    let pass = false;
    let info = null;
    try {
        await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
        log('page load fired; waiting 3.5s for the popout surface to settle');
        await sleep(3500);
        info = await probe(page);
        if (!info.surface) { await sleep(2500); info = await probe(page); }   // one retry for a slow first paint

        log(`popout probe: ${JSON.stringify(info)}`);
        if (!info.host) throw new Error('popout-host absent — is the #/popout route loading?');
        if (!info.surface) throw new Error('docking-surface absent — the popout is NOT a full docking workspace');
        if (!info.ribbon) throw new Error('widget-ribbon absent — the popout surface has no ribbon');
        if (info.ribbonPosition !== 'fixed') throw new Error(`ribbon position "${info.ribbonPosition}", expected "fixed"`);
        if (!(info.chips >= MIN_CHIPS)) throw new Error(`only ${info.chips} draggable chips, expected ≥${MIN_CHIPS}`);
        if (!info.seededPanel) throw new Error('seeded solve_summary panel absent — popout did not seed the popped widget');

        pass = true;
        log(`PASS — popout mounts a full DockingSurface + ribbon (${info.chips} chips) seeded with solve_summary`);
    } catch (e) {
        log(`FAIL — ${e && e.message ? e.message : e}`);
    } finally {
        await context.close();
        await browser.close();   // closes only the browser we launched; the dev server is untouched
    }

    console.log(pass
        ? `\nPOPOUT_VERIFY: PASS  ${JSON.stringify(info)}`
        : `\nPOPOUT_VERIFY: FAIL  ${JSON.stringify(info)}`);
    process.exit(pass ? 0 : 1);
}

main().catch((e) => { log(`FATAL ${e}`); process.exit(1); });
