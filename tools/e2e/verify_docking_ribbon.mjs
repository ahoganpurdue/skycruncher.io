// Minimal Playwright verification for the Phase-B docking ribbon (SPEC §6b).
//
// Loads the ALREADY-RUNNING dev server (does NOT spawn or kill vite), lets the
// page settle, and asserts — WITHOUT dispatching any synthetic events — that the
// viewport-fixed widget ribbon actually appears with its full chip palette. This
// is the live proof for the StrictMode-symmetry + mount-race fix: if the IO/RO
// triggers were dead, the ribbon would stay absent and this fails.
//
// Usage:  DOCK_URL=http://127.0.0.1:3272/?docking=1 node tools/e2e/verify_docking_ribbon.mjs
//   • DOCK_URL   — page to load (default http://127.0.0.1:3272/?docking=1)
//   • E2E_HEADED — set to run headed; default headless
//   • uses a FRESH browser context (empty localStorage) so first-run defaults
//     apply: ?docking=1 enables docking, the ribbon defaults EXPANDED.
//
// A real user-style scroll (scrollIntoViewIfNeeded) may be used ONLY to bring the
// surface into view — that is a genuine scroll, NOT a dispatched/synthetic event;
// the ribbon must then appear on its own via the mount triggers.

import { chromium } from 'playwright';

const URL = process.env.DOCK_URL || 'http://127.0.0.1:3272/?docking=1';
const MIN_CHIPS = 30;
const RIBBON = '[data-testid="widget-ribbon"]';
const SURFACE = '[data-testid="docking-surface"]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);

async function probeRibbon(page) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { present: false };
        const cs = getComputedStyle(el);
        const chips = el.querySelectorAll('[draggable="true"]').length;
        const r = el.getBoundingClientRect();
        return {
            present: true,
            position: cs.position,
            zIndex: cs.zIndex,
            bottom: cs.bottom,
            chips,
            rect: { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) },
            anchoredToBottom: Math.abs(r.bottom - window.innerHeight) < 2,
        };
    }, RIBBON);
}

async function main() {
    log(`launching system Chrome (headless=${!process.env.E2E_HEADED}) → ${URL}`);
    const browser = await chromium.launch({
        channel: process.env.E2E_BROWSER_CHANNEL || 'chrome',
        headless: !process.env.E2E_HEADED,
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => log(`[pageerror] ${e}`));

    let pass = false;
    let info = null;
    try {
        await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
        log('page load event fired; waiting 3s for the app + docking surface to settle');
        await sleep(3000);

        // Surface must exist (docking enabled). Bring it into view with a REAL
        // scroll (not a dispatched event) so the in-view gate has a chance to flip.
        const surface = await page.$(SURFACE);
        if (!surface) throw new Error(`docking surface (${SURFACE}) absent — is ?docking=1 in the URL?`);
        info = await probeRibbon(page);
        if (!info.present) {
            log('ribbon not present on plain load; scrolling the surface into view (real scroll, no synthetic events)');
            await surface.scrollIntoViewIfNeeded();
            await sleep(3000);
            info = await probeRibbon(page);
        }

        log(`ribbon probe: ${JSON.stringify(info)}`);
        if (!info.present) throw new Error('widget-ribbon NEVER appeared (present=false)');
        if (info.position !== 'fixed') throw new Error(`ribbon position is "${info.position}", expected "fixed"`);
        if (!info.anchoredToBottom) throw new Error(`ribbon not anchored to viewport bottom (rect=${JSON.stringify(info.rect)})`);
        if (!(info.chips >= MIN_CHIPS)) throw new Error(`only ${info.chips} draggable chips, expected ≥${MIN_CHIPS}`);

        pass = true;
        log(`PASS — ribbon present, position:fixed, anchoredToBottom, ${info.chips} draggable chips (≥${MIN_CHIPS})`);
    } catch (e) {
        log(`FAIL — ${e && e.message ? e.message : e}`);
    } finally {
        await context.close();
        await browser.close();   // closes only the browser we launched; the dev server is untouched
    }

    console.log(pass
        ? `\nRIBBON_VERIFY: PASS  ${JSON.stringify(info)}`
        : `\nRIBBON_VERIFY: FAIL  ${JSON.stringify(info)}`);
    process.exit(pass ? 0 : 1);
}

main().catch((e) => { log(`FATAL ${e}`); process.exit(1); });
