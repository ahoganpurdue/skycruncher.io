// Packaged-app CDP repro: attach to the INSTALLED SkyCruncher v1.0.0 desktop app
// (Tauri v2 + WebView2) over the DevTools protocol, instrument console+network,
// and drive the SeeStar demo FITS through the wizard to observe the packaged
// solve path live. NOTHING here spawns a vite server or a browser — it connects
// to an already-running WebView2 that was launched with
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
//
// NOTE: window.__astroSession is DEV-ONLY (usePipelineFSM.ts:31, gated on
// import.meta.env.DEV) — it is UNDEFINED in the packaged build. So this driver
// reads solution state from the DOM (data-testid survives prod) + the exported
// receipt, never from the dev session hook.
//
// Run: node tools/repro/packaged_app_cdp.mjs
// Writes: test_results/packaged_app_diag/{console.jsonl,network.jsonl,summary.json,*.png}

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIT = path.join(ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9223';
const OUT = path.join(ROOT, 'test_results', 'packaged_app_diag');
fs.mkdirSync(OUT, { recursive: true });

const consoleStream = fs.createWriteStream(path.join(OUT, 'console.jsonl'));
const networkStream = fs.createWriteStream(path.join(OUT, 'network.jsonl'));
const summary = { started: new Date().toISOString(), cdp: CDP, fit: FIT, phases: [], atlas: [], starplates: [], errors: [], notes: [], dom: {}, pass: false };

let phase = 'connect';
const t0 = Date.now();
const now = () => Date.now() - t0;
const log = (line) => { const m = `${(now() / 1000).toFixed(1)}s [${phase}] ${line}`; console.log(m); };
const jc = (obj) => consoleStream.write(JSON.stringify({ t: now(), phase, ...obj }) + '\n');
const jn = (obj) => networkStream.write(JSON.stringify({ t: now(), phase, ...obj }) + '\n');

const HARD_KILL_MS = 8 * 60 * 1000;
const hardKill = setTimeout(() => { log('[FATAL] 8-minute hard kill'); flushAndExit(2, 'hard kill'); }, HARD_KILL_MS);

function flushAndExit(code, note) {
    if (note) summary.note = note;
    summary.finished = new Date().toISOString();
    try { fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2)); } catch { }
    try { consoleStream.end(); } catch { }
    try { networkStream.end(); } catch { }
    clearTimeout(hardKill);
    setTimeout(() => process.exit(code), 300);
}

function attach(page) {
    page.on('console', (msg) => {
        let loc = '';
        try { const l = msg.location(); loc = l && l.url ? `${l.url}:${l.lineNumber}` : ''; } catch { }
        const rec = { type: msg.type(), text: msg.text().slice(0, 2000), loc };
        jc(rec);
        if (msg.type() === 'error' || msg.type() === 'warning') {
            log(`console.${msg.type()}: ${rec.text.slice(0, 300)}`);
            if (msg.type() === 'error') summary.errors.push({ t: now(), phase, text: rec.text.slice(0, 500) });
        }
    });
    page.on('pageerror', (err) => { const s = String(err && err.stack || err).slice(0, 1000); jc({ type: 'pageerror', text: s }); summary.errors.push({ t: now(), phase, pageerror: s.slice(0, 500) }); log(`pageerror: ${s.slice(0, 300)}`); });
    page.on('request', (req) => { jn({ kind: 'request', method: req.method(), url: req.url().slice(0, 500), resourceType: req.resourceType() }); });
    page.on('requestfailed', (req) => {
        const url = req.url();
        const rec = { kind: 'requestfailed', method: req.method(), url: url.slice(0, 500), resourceType: req.resourceType(), failure: (req.failure() && req.failure().errorText) || null };
        jn(rec);
        if (/atlas|starplates|sector|anchor/i.test(url)) log(`REQ-FAILED ${rec.failure} ${url.slice(0, 200)}`);
    });
    page.on('response', (resp) => {
        const url = resp.url();
        const h = resp.headers();
        const rec = { kind: 'response', status: resp.status(), url: url.slice(0, 500), resourceType: resp.request().resourceType(), contentType: h['content-type'] || null, contentLength: h['content-length'] ? Number(h['content-length']) : null };
        jn(rec);
        if (/\/atlas\/|anchor|sector/i.test(url)) { const a = { t: now(), phase, status: rec.status, len: rec.contentLength, url }; summary.atlas.push(a); log(`ATLAS ${rec.status} len=${rec.contentLength} ${url.slice(0, 160)}`); }
        if (/starplates|t0\.bin|t1\.bin|band_index/i.test(url)) { const a = { t: now(), phase, status: rec.status, len: rec.contentLength, url }; summary.starplates.push(a); log(`STARPLATES ${rec.status} len=${rec.contentLength} ${url.slice(0, 160)}`); }
    });
}

async function poll(fn, timeoutMs, intervalMs = 1000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { } await new Promise(r => setTimeout(r, intervalMs)); }
    return null;
}
const txt = async (page, testid) => { try { return (await page.getByTestId(testid).first().textContent({ timeout: 2000 }))?.trim() || ''; } catch { return ''; } };

try {
    log(`connecting to ${CDP} ...`);
    const browser = await chromium.connectOverCDP(CDP, { timeout: 20000 });
    const contexts = browser.contexts();
    log(`contexts: ${contexts.length}`);
    let page = null;
    for (const ctx of contexts) {
        for (const p of ctx.pages()) {
            log(`  page url=${p.url()}`);
            if (!/devtools/i.test(p.url())) page = page || p;
        }
    }
    if (!page) { const ctx = contexts[0] || await browser.newContext(); page = ctx.pages()[0] || await ctx.newPage(); }
    summary.appUrl = page.url();
    log(`selected page: ${page.url()}`);
    try { await page.context().grantPermissions([]); } catch { }
    // Ensure downloads are accepted where supported.
    attach(page);

    // ── Reload to capture the FULL app-load network/console sequence cleanly.
    phase = 'app_load';
    log('reloading app to capture cold load...');
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { log(`reload note: ${e.message}`); summary.notes.push('reload failed: ' + e.message); }
    await new Promise(r => setTimeout(r, 4000));
    try { await page.screenshot({ path: path.join(OUT, '00_app_load.png') }); } catch { }
    summary.dom.hasFileInput = await page.locator('#astro-file-input').count().catch(() => 0);
    summary.dom.sessionHookPresent = await page.evaluate(() => typeof window.__astroSession !== 'undefined').catch(() => null);
    log(`file input present=${summary.dom.hasFileInput} __astroSession present=${summary.dom.sessionHookPresent}`);

    const markPhase = (name, ok, extra) => { summary.phases.push({ name, ok, t: now(), ...extra }); };

    // ── Upload + step 1
    phase = 'upload_step1';
    // Raw CDP DOM.setFileInputFiles — Playwright's setInputFiles wrapper hangs
    // over CDP-to-WebView2 (actionability wait never resolves); the raw call
    // dispatches input+change events that React's onChange picks up.
    log('setFileInputFiles (raw CDP) ...');
    let fileSet = false;
    try {
        const client = await page.context().newCDPSession(page);
        const doc = await client.send('DOM.getDocument', { depth: 0 });
        const q = await client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#astro-file-input' });
        if (!q.nodeId) throw new Error('querySelector returned nodeId 0');
        await client.send('DOM.setFileInputFiles', { files: [FIT], nodeId: q.nodeId });
        fileSet = true;
        log('raw CDP setFileInputFiles OK');
    } catch (e) {
        log(`raw CDP setFileInputFiles failed: ${e.message}; falling back to Playwright wrapper`);
        try { await page.setInputFiles('#astro-file-input', FIT, { timeout: 20000 }); fileSet = true; } catch (e2) { log(`wrapper fallback failed: ${e2.message}`); }
    }
    if (!fileSet) { markPhase('upload_step1', false, { reason: 'could not set file input' }); throw new Error('could not set file input via CDP or wrapper'); }
    const proceed = await poll(async () => { const b = page.getByTestId('step1-proceed'); return (await b.count()) && await b.isEnabled().catch(() => false) ? b : null; }, 90000);
    if (!proceed) { markPhase('upload_step1', false, { reason: 'step1-proceed never enabled' }); throw new Error('step1-proceed never became enabled'); }
    await proceed.click({ timeout: 15000 });
    markPhase('upload_step1', true);
    try { await page.screenshot({ path: path.join(OUT, '01_step1.png') }); } catch { }

    // ── Step 2 context form
    phase = 'step2_context';
    summary.dom.latBadge = await txt(page, 'gps-source-badge-lat');
    summary.dom.lonBadge = await txt(page, 'gps-source-badge-lon');
    log(`gps badges lat="${summary.dom.latBadge}" lon="${summary.dom.lonBadge}"`);
    const next2 = await poll(async () => { const b = page.getByTestId('wizard-next-step'); return (await b.count()) ? b : null; }, 20000);
    if (next2) await next2.click({ timeout: 10000 }).catch(e => log('next2 click: ' + e.message));
    markPhase('step2_context', !!next2);

    // ── Step 3 detection
    phase = 'step3_detect';
    const s3start = await poll(async () => { const b = page.getByTestId('step3-start'); return (await b.count()) ? b : null; }, 15000);
    if (s3start) await s3start.click({ timeout: 10000 }).catch(e => log('s3 start: ' + e.message));
    // wait for confirm actionable
    const s3confirm = await poll(async () => { const b = page.getByTestId('step3-confirm'); return (await b.count()) && await b.isEnabled().catch(() => false) ? b : null; }, 240000, 2000);
    summary.dom.starCount = await txt(page, 'step3-star-count');
    log(`star count display: "${summary.dom.starCount}"`);
    if (!s3confirm) { markPhase('step3_detect', false, { reason: 'step3-confirm never enabled', starCount: summary.dom.starCount }); throw new Error('detection never produced actionable confirm'); }
    await s3confirm.click({ timeout: 10000 });
    markPhase('step3_detect', true, { starCount: summary.dom.starCount });
    try { await page.screenshot({ path: path.join(OUT, '03_detect.png') }); } catch { }

    // ── Step 4 scale lock
    phase = 'step4_scale';
    const s4start = await poll(async () => { const b = page.getByTestId('step4-start'); return (await b.count()) ? b : null; }, 15000);
    if (s4start) await s4start.click({ timeout: 10000 }).catch(e => log('s4 start: ' + e.message));
    const s4confirm = await poll(async () => { const b = page.getByTestId('step4-confirm'); return (await b.count()) && await b.isEnabled().catch(() => false) ? b : null; }, 40000, 1000);
    summary.dom.scaleLock = await txt(page, 'step4-scale-lock');
    log(`scale display: "${summary.dom.scaleLock}"`);
    if (s4confirm) await s4confirm.click({ timeout: 10000 });
    markPhase('step4_scale', !!s4confirm, { scaleLock: summary.dom.scaleLock });

    // ── Step 5 plate solve — the whole point. Up to 5 minutes.
    phase = 'step5_solve';
    const s5start = await poll(async () => { const b = page.getByTestId('step5-start'); return (await b.count()) ? b : null; }, 15000);
    if (!s5start) { markPhase('step5_solve', false, { reason: 'step5-start never appeared' }); throw new Error('step5-start never appeared'); }
    const solveT0 = now();
    await s5start.click({ timeout: 10000 });
    log('plate solve started, up to 300s...');
    const SOLVE_MS = 300000;
    const outcome = await poll(async () => {
        const conf = page.getByTestId('step5-confirm');
        const fail = page.getByTestId('step5-failure');
        if ((await fail.count()) && await fail.isVisible().catch(() => false)) return 'failure';
        if ((await conf.count()) && await conf.isEnabled().catch(() => false)) return 'success';
        return null;
    }, SOLVE_MS, 2000);
    const solveMs = now() - solveT0;
    summary.solveOutcome = outcome || 'timeout';
    summary.solveMs = solveMs;
    summary.dom.matchedStars = await txt(page, 'step5-matched-stars');
    summary.dom.step5Failure = await txt(page, 'step5-failure');
    log(`solve outcome=${summary.solveOutcome} in ${(solveMs / 1000).toFixed(1)}s matched="${summary.dom.matchedStars}" failure="${summary.dom.step5Failure}"`);
    try { await page.screenshot({ path: path.join(OUT, '05_solve.png') }); } catch { }

    if (outcome === 'success') {
        markPhase('step5_solve', true, { solveMs, matched: summary.dom.matchedStars });
        await page.getByTestId('step5-confirm').click({ timeout: 10000 }).catch(e => log('s5 confirm: ' + e.message));
        // Step 6 calibration (best-effort)
        phase = 'step6_calib';
        const s6start = await poll(async () => { const b = page.getByTestId('step6-start'); return (await b.count()) ? b : null; }, 15000);
        if (s6start) await s6start.click({ timeout: 10000 }).catch(() => { });
        const s6confirm = await poll(async () => { const b = page.getByTestId('step6-confirm'); return (await b.count()) && await b.isEnabled().catch(() => false) ? b : null; }, 90000, 2000);
        if (s6confirm) await s6confirm.click({ timeout: 10000 }).catch(() => { });
        markPhase('step6_calib', !!s6confirm);
        // Step 7 integrate + coordinates + export receipt
        phase = 'step7_export';
        const s7start = await poll(async () => { const b = page.getByTestId('step7-start'); return (await b.count()) ? b : null; }, 15000);
        if (s7start) await s7start.click({ timeout: 10000 }).catch(() => { });
        const exportBtn = await poll(async () => { const b = page.getByTestId('step7-export'); return (await b.count()) ? b : null; }, 90000, 2000);
        summary.dom.coordinates = await txt(page, 'step7-coordinates');
        summary.dom.packet = await txt(page, 'step7-packet');
        log(`coordinates tile: "${summary.dom.coordinates}" packet: "${summary.dom.packet}"`);
        try { await page.screenshot({ path: path.join(OUT, '07_integrate.png') }); } catch { }
        if (exportBtn) {
            const dlP = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
            await exportBtn.click({ timeout: 10000 }).catch(e => log('export click: ' + e.message));
            const dl = await dlP;
            if (dl) {
                const receiptPath = path.join(OUT, 'receipt.json');
                await dl.saveAs(receiptPath).catch(e => log('saveAs: ' + e.message));
                try {
                    const parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
                    const sol = parsed.solution || {};
                    summary.receipt = { ra_hours: sol.ra_hours, dec_degrees: sol.dec_degrees, pixel_scale: sol.pixel_scale, rotation: sol.rotation, parity: sol.parity, confidence: sol.confidence, matched: sol.matched_stars ? sol.matched_stars.length : sol.matched, schema: parsed.schema_version };
                    log(`RECEIPT solution: RA=${sol.ra_hours}h scale=${sol.pixel_scale} conf=${sol.confidence} matched=${summary.receipt.matched}`);
                } catch (e) { log('receipt parse failed: ' + e.message); summary.notes.push('receipt parse: ' + e.message); }
            } else { summary.notes.push('no download event fired on export'); log('no download event fired'); }
        }
        markPhase('step7_export', !!exportBtn, { coordinates: summary.dom.coordinates });
        summary.pass = true;
    } else {
        markPhase('step5_solve', false, { solveMs, outcome: summary.solveOutcome, failure: summary.dom.step5Failure });
    }

    phase = 'done';
    flushAndExit(summary.pass ? 0 : 1, `solve=${summary.solveOutcome}`);
} catch (e) {
    log(`FATAL: ${e && e.stack || e}`);
    summary.fatal = String(e && e.message || e);
    try { const pgs = (await chromium.connectOverCDP(CDP).then(b => b.contexts()[0]?.pages()[0]).catch(() => null)); if (pgs) await pgs.screenshot({ path: path.join(OUT, 'FATAL.png') }).catch(() => { }); } catch { }
    flushAndExit(1, summary.fatal);
}
