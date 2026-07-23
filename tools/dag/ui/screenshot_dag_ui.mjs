#!/usr/bin/env node
// ============================================================================
// tools/dag/ui/screenshot_dag_ui.mjs — eyes-on verification driver for the DAG
// collaboration space (house LAW: look at the app before calling UI work done).
//
// Drives a RUNNING serve_dag.mjs with playwright and banks PNGs of:
//   all three views (graph/matrix/procedure) · semantic zoom detail ·
//   connectivity isolation (hops + direction) · the empty-cell
//   proposed-connection annotation flow (posts ONE labeled test annotation to
//   the local ledger when --token is given; skipped otherwise).
//
// This is a DRIVER, not a gate: it never starts or stops the server (the
// caller owns that lifecycle) and it asserts nothing beyond element presence.
//
// Usage:
//   node tools/dag/ui/serve_dag.mjs --port 4323 &
//   node tools/dag/ui/screenshot_dag_ui.mjs --url http://127.0.0.1:4323 \
//        --out test_results/dag_ui2_screens [--token <X-Dag-Token>]
// ============================================================================
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
function opt(name, def) { const i = argv.indexOf('--' + name); return i === -1 ? def : argv[i + 1]; }
const URL0 = opt('url', 'http://127.0.0.1:4323');
const OUT = path.resolve(opt('out', 'test_results/dag_ui2_screens'));
const TOKEN = opt('token', '');
fs.mkdirSync(OUT, { recursive: true });

// system-Chrome channel, same as tools/e2e/lib.mjs (no ms-playwright download)
const browser = await chromium.launch({
  channel: process.env.E2E_BROWSER_CHANNEL || 'chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const shot = async (name) => {
  const p = path.join(OUT, name);
  await page.screenshot({ path: p });
  console.log('[shot]', p);
};

await page.goto(URL0, { waitUntil: 'networkidle' });
await page.waitForSelector('#graph-svg', { timeout: 20000 });

// ── 1 · graph view: layered layout at survey zoom ──────────────────────────
await shot('01_graph_layered_survey.png');

// ── 1b · clockdrive overlay strip (roadmap theses + proposals) ──────────────
// the strip is a top band of unanchored chips; zoom into it for legibility, then
// click a DEAD chip to show the struck rendering + its detail panel. Skipped
// honestly when no dag_clockdrive data exists in the checkout (no band drawn).
{
  const band = await page.locator('.cd-band').first().boundingBox().catch(() => null);
  if (band) {
    // click a DEAD chip at FIT zoom (chips are in-bounds here → reliably clickable;
    // zooming first can scroll the far-left chip under the rail in screen space)
    const dead = page.locator('.cd-chip.cd-dead').first();
    if (await dead.count()) {
      await dead.click();
      await page.waitForSelector('.cd-status-chip', { timeout: 5000 });
      await page.waitForTimeout(120);
      await shot('11_clockdrive_dead_detail.png');
    } else {
      console.log('[skip] no dead clockdrive chip present');
    }
    // now zoom into the strip for a legible overview shot (screenshot only); zoom
    // ABOUT the dead chip element (clamp x safely right of the rail) so the struck
    // chip stays framed as the camera zooms in
    const cbox = await page.locator('.cd-chip').first().boundingBox().catch(() => null);
    if (cbox) {
      // zoom about the chip's OWN centre (clamp x only enough to clear the rail edge
      // at ~250px so the wheel lands on the graph SVG, not the rail)
      const fx = Math.max(cbox.x + cbox.width / 2, 256), fy = cbox.y + cbox.height / 2;
      await page.mouse.move(fx, fy);
      for (let i = 0; i < 7; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(45); }
      await page.waitForTimeout(160);
      await shot('10_clockdrive_strip.png');
    }
    await page.locator('.zoom-ctl button[data-z="fit"]').click(); // restore camera for the rest of the flow
    await page.waitForTimeout(120);
  } else {
    console.log('[skip] no clockdrive band present (no dag_clockdrive data in this checkout)');
  }
}

// ── 2 · semantic zoom: detail cards past the zoom threshold ────────────────
// wheel-zoom AT a node so the detail cards are in frame (button zoom targets
// the viewport center, which can be empty world space at survey zoom)
const nb = await page.locator('.gnode').first().boundingBox();
await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
for (let i = 0; i < 7; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(40); }
await page.waitForTimeout(150);
await shot('02_graph_semantic_zoom_detail.png');
await page.locator('.zoom-ctl button[data-z="fit"]').click();

// ── 3 · matrix view (full), then connectivity isolation ────────────────────
await page.locator('#view-seg button[data-view="matrix"]').click();
await page.waitForSelector('#matrix-wrap svg');
await shot('03_matrix_full.png');
await page.locator('.mx-lab').nth(2).click();      // select a node via its label
await page.waitForSelector('#iso-btn');
await page.locator('#iso-btn').click();            // isolate: 1 hop, both
await page.waitForSelector('#iso-bar');
await shot('04_matrix_ego_isolation_1hop.png');
await page.locator('#iso-plus').click();           // widen to 2 hops
await page.locator('#iso-dir button[data-dir="downstream"]').click();
await page.waitForTimeout(120);
await page.locator('#view-seg button[data-view="graph"]').click(); // iso carries across views
await page.waitForTimeout(180);
await shot('05_graph_ego_isolation_2hop_downstream.png');
await page.locator('#iso-exit').click();

// ── 4 · empty-cell proposed-connection flow ─────────────────────────────────
await page.locator('#view-seg button[data-view="matrix"]').click();
await page.waitForSelector('.mx-catcher');
const cell = await page.evaluate(() => {
  // mirror of the matrix constants in dag_app.js (CELL/LABEL_W/TOP_H)
  const CELL = 16, LABEL_W = 240, TOP_H = 170;
  const svg = document.querySelector('#matrix-wrap svg');
  const filled = new Set([...svg.querySelectorAll('.mx-cell')]
    .map((r) => r.getAttribute('x') + ',' + r.getAttribute('y')));
  const n = Number(svg.querySelector('.mx-catcher').getAttribute('width')) / CELL;
  const rect = svg.getBoundingClientRect();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (r === c) continue;
      if (filled.has((LABEL_W + c * CELL + 1) + ',' + (TOP_H + r * CELL + 1))) continue;
      const x = rect.left + LABEL_W + c * CELL + CELL / 2;
      const y = rect.top + TOP_H + r * CELL + CELL / 2;
      if (x < innerWidth - 20 && y < innerHeight - 20) return { x, y };
    }
  }
  return null;
});
if (!cell) throw new Error('no visible empty matrix cell found');
await page.mouse.click(cell.x, cell.y);
await page.waitForSelector('.ann-form');
await shot('06_emptycell_proposed_form.png');
if (TOKEN) {
  await page.fill('.ann-form textarea', 'verification test annotation (UI-2 eyes-on driver): should these two connect?');
  await page.fill('.ann-form .tok', TOKEN);
  await page.locator('.ann-form .btn').click();
  // a successful post re-renders immediately (the annotation appears in the
  // panel and the ring badge lands on the cell) — wait on the badge, the
  // ledger→render round-trip proof, not on the transient form message
  await page.waitForSelector('.mx-proposed', { timeout: 10000 });
  await page.waitForTimeout(300);
  await shot('07_emptycell_posted_ring_badge.png');
} else {
  console.log('[skip] no --token given: the POST half of the flow was NOT exercised');
}

// ── 5 · procedure view ───────────────────────────────────────────────────────
await page.locator('#view-seg button[data-view="procedure"]').click();
await page.waitForSelector('.proc-step');
await shot('08_procedure_view.png');
await page.evaluate(() => { document.querySelector('#procedure-view').scrollTop = 1e9; });
await page.waitForTimeout(150);
await shot('09_procedure_footer_unwalked.png');

// ── 6 · curated step-map view (task #11: dual rendering from steps_map.json) ────
// Both renderings + honest states: list walk, an expanded RULED flag, file-type
// dimming, a selected step's panel, then the procedure-map graph + semantic zoom.
{
  await page.locator('#view-seg button[data-view="steps"]').click();
  const hasSteps = await page.locator('.step-card').first().isVisible().catch(() => false);
  if (!hasSteps) {
    console.log('[skip] curated step map absent in this checkout (steps view empty)');
  } else {
    // orphan banner (regen-drift safety) — shot when present (surfaced, never dropped)
    if (await page.locator('#orphan-banner .orphan-item').first().isVisible().catch(() => false)) {
      await shot('12_orphan_banner.png');
    } else {
      console.log('[skip] no orphan annotations in this checkout (healthy — banner hidden)');
    }
    await shot('13_steps_list.png');                                   // numbered nested walk
    await page.locator('.step-flag summary').first().click();          // expand a RULED flag note
    await page.waitForTimeout(120);
    await shot('14_steps_list_ruling_expanded.png');
    const ft = page.locator('#steps-ft .ftchip').first();              // file-type dim (one flow)
    if (await ft.count()) { await ft.click(); await page.waitForTimeout(120); await shot('15_steps_list_filetype_dim.png'); await ft.click(); }
    await page.locator('.step-title').first().click();                 // select a step → panel
    await page.waitForSelector('.p-flag, .p-why', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(120);
    await shot('16_steps_step_panel.png');
    await page.locator('#steps-mode-seg button[data-mode="graph"]').click(); // procedure map
    await page.waitForSelector('#steps-svg', { timeout: 10000 });
    await page.waitForTimeout(250);
    await shot('17_steps_graph_procedure_map.png');
    const sn = await page.locator('#steps-svg .snode').first().boundingBox().catch(() => null);
    if (sn) {
      await page.mouse.move(sn.x + sn.width / 2, sn.y + sn.height / 2);
      for (let i = 0; i < 7; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(40); }
      await page.waitForTimeout(150);
      await shot('18_steps_graph_semantic_zoom.png');
    }
  }
}

await browser.close();
console.log('[done] screenshots in', OUT);
