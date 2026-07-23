#!/usr/bin/env node
// tools/packet/print_pdf.mjs
// -----------------------------------------------------------------------------
// Static PDF twin (+ optional full-page eyes-on screenshot) for processing
// packets. Loads each packet HTML via file:// in headless Chromium and prints
// it with backgrounds on. Interactive embeds (3D layer stacks) may print as
// static or blank frames — the PDF is the static companion, the HTML packet is
// the primary artifact.
//
// Usage:
//   node tools/packet/print_pdf.mjs --in <packet.html> [--in <...>] \
//        [--pdf-dir <dir>] [--shot-dir <dir>] [--format Letter] [--portrait]
//
// Defaults: PDF written next to the input (same basename, .pdf); screenshot
// only when --shot-dir is given (basename + _fullpage.png); Letter landscape.
// -----------------------------------------------------------------------------

import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

function parseArgs(argv) {
  const out = { inputs: [], format: 'Letter', landscape: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') out.inputs.push(argv[++i]);
    else if (a === '--pdf-dir') out.pdfDir = argv[++i];
    else if (a === '--shot-dir') out.shotDir = argv[++i];
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--portrait') out.landscape = false;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inputs.length) {
    console.log('Usage: node tools/packet/print_pdf.mjs --in <packet.html> [--in ...] [--pdf-dir <dir>] [--shot-dir <dir>]');
    process.exit(1);
  }

  // System Chrome, same pattern as tools/e2e/lib.mjs (no Playwright-managed
  // browser download on this box).
  const browser = await chromium.launch({
    channel: process.env.PACKET_BROWSER_CHANNEL || 'chrome',
  });
  const results = [];
  try {
    for (const input of args.inputs) {
      const inPath = resolve(input);
      if (!existsSync(inPath)) { results.push({ in: inPath, ok: false, error: 'input not found' }); continue; }
      const base = basename(inPath).replace(/\.html?$/i, '');
      const pdfDir = args.pdfDir ? resolve(args.pdfDir) : dirname(inPath);
      mkdirSync(pdfDir, { recursive: true });
      const pdfPath = join(pdfDir, `${base}.pdf`);

      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      try {
        await page.goto(pathToFileURL(inPath).href, { waitUntil: 'load', timeout: 120000 });
        // The packet builder marks images/iframes loading="lazy"; Chromium's
        // lazy margin never reaches content far below the fold during a
        // fullPage capture. Force everything eager, sweep the page, and wait
        // for every image to decode before capturing.
        await page.evaluate(async () => {
          document.querySelectorAll('img, iframe').forEach((el) => { el.loading = 'eager'; });
          const h = document.body.scrollHeight;
          for (let y = 0; y < h; y += 700) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 25));
          }
          window.scrollTo(0, 0);
          await Promise.all(Array.from(document.images).map((img) =>
            img.complete ? Promise.resolve() : new Promise((res) => { img.onload = img.onerror = res; })
          ));
        });
        await page.waitForTimeout(2000);

        let shotPath = null;
        if (args.shotDir) {
          const shotDir = resolve(args.shotDir);
          mkdirSync(shotDir, { recursive: true });
          shotPath = join(shotDir, `${base}_fullpage.png`);
          await page.screenshot({ path: shotPath, fullPage: true });
        }

        await page.pdf({
          path: pdfPath,
          format: args.format,
          landscape: args.landscape,
          printBackground: true,
          margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
        });
        results.push({ in: inPath, ok: true, pdf: pdfPath, screenshot: shotPath });
        console.error(`printed ${base}.pdf${shotPath ? ' + screenshot' : ''}`);
      } catch (e) {
        results.push({ in: inPath, ok: false, error: String(e && e.message || e) });
        console.error(`FAILED ${base}: ${e && e.message || e}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
  if (!results.every((r) => r.ok)) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
