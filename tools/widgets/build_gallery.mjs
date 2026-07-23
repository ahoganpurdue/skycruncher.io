#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// WIDGET REVIEW GALLERY — build_gallery.mjs : thin CLI over the gallery spec
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/widgets/build_gallery.mjs [receipt.json]
//
// Renders EVERY registered widget once (server-side, real receipt data) into a
// single self-contained HTML page at test_results/widget_review/gallery.html.
// Defaults to the headless M66 receipt if no path is given.
//
// Like tools/api/run.mjs, a plain .mjs cannot resolve the engine `@/` alias nor
// transpile the widget .tsx, so the render runs under vitest (gallery.config.ts
// + build_gallery.galleryspec.ts) — the proven headless mechanism. This wrapper
// owns arg parsing, env threading, and the exit code / provenance print.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const CONFIG = 'tools/widgets/gallery.config.ts';
const OUT_HTML = path.join(ROOT, 'test_results', 'widget_review', 'gallery.html');
const OUT_PROV = path.join(ROOT, 'test_results', 'widget_review', 'gallery_provenance.json');

const receiptArg = process.argv.slice(2).find(a => !a.startsWith('-'));
const env = { ...process.env };
if (receiptArg) env.GALLERY_RECEIPT = path.resolve(receiptArg);

const res = spawnSync(process.execPath, [VITEST_BIN, 'run', '-c', CONFIG], {
    cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'],
});

if (res.status !== 0 || !fs.existsSync(OUT_HTML)) {
    process.stderr.write(`[gallery] build failed (vitest exit ${res.status}); no page at ${OUT_HTML}\n`);
    process.exit(res.status || 1);
}

let prov = null;
try { prov = JSON.parse(fs.readFileSync(OUT_PROV, 'utf8')); } catch { /* optional */ }

process.stdout.write(`\n[gallery] wrote ${OUT_HTML}\n`);
if (prov) {
    process.stdout.write(`[gallery] receipt: ${prov.receipt}\n`);
    process.stdout.write(`[gallery] ${prov.real}/${prov.total} widgets REAL · ${prov.absent} NOT MEASURED\n`);
    const byStatus = { REAL: [], ABSENT: [] };
    for (const w of prov.widgets) (byStatus[w.status] ?? (byStatus[w.status] = [])).push(w.id);
    process.stdout.write(`[gallery] REAL:   ${byStatus.REAL.join(', ')}\n`);
    process.stdout.write(`[gallery] ABSENT: ${byStatus.ABSENT.join(', ')}\n`);
}
process.exit(0);
