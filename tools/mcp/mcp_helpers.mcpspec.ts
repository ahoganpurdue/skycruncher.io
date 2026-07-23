// ═══════════════════════════════════════════════════════════════════════════
// tools/mcp — env-switched helper spec (driven by tools/mcp/server.mjs)
// ═══════════════════════════════════════════════════════════════════════════
//
// (invoked by tools/mcp/server.mjs; runs under vitest for the `@/` alias + TSX
//  transpile — a plain .mjs cannot import the registry .tsx nor react-dom/server.
//  Same proven mechanism as tools/api/run.mjs + tools/widgets/build_gallery.mjs.)
//
// One `it`, three ops selected by MCP_HELPER_OP:
//   • profiles       → pool the workbench deposit log per rig via the ENGINE's
//                      recomputeRigProfile (NO duplicated pooling math, LAW 4).
//   • list_widgets   → the registry inventory (id/title/intent/tier + LIVE-vs-
//                      SCAFFOLD status + a REAL/ABSENT data probe on M66).
//   • render_widget  → SSR ONE registry widget with REAL receipt data into a
//                      self-contained HTML (honest NOT MEASURED when the selector
//                      returns null — that render IS the correct output, never an
//                      error). server.mjs then screenshots it via Playwright.
//
// Outputs go to the *_OUT paths the server passes; this spec's own assertion is
// only "the artifact landed".

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WIDGETS } from '../../src/engine/ui/widgets/registry';
import { SCAFFOLD_WIDGETS } from '../../src/engine/ui/widgets/widgets/ScaffoldWidgets';
import { recomputeRigProfile, type ObservationDeposit } from '../../src/engine/pipeline/m2_hardware/workbench_store';
import { makeNodeJsonlStorage } from '../workbench/node_storage';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OP = process.env.MCP_HELPER_OP;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SCAFFOLD_IDS = new Set(SCAFFOLD_WIDGETS.map(w => w.id));

// ── token extraction (mirror of build_gallery.galleryspec.ts — presentation CSS
//    only, not logic; the widgets reference these instrument tokens via var()). ──
function extractTokens(): string {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'index.css'), 'utf8');
  const lines = css.match(/--[\w-]+:\s*[^;]+;/g) ?? [];
  return `:root{\n${[...new Set(lines)].map(l => '  ' + l).join('\n')}\n}`;
}

// ── minimal Tailwind-utility shim (mirror of galleryspec; review-artifact CSS) ──
const UTILITY_SHIM = `
*{box-sizing:border-box}
body{margin:0;background:var(--color-space-950);color:var(--color-text-primary);font-family:var(--font-sans)}
.font-mono{font-family:var(--font-mono)}
.uppercase{text-transform:uppercase}
.font-bold{font-weight:700}
.tracking-widest{letter-spacing:.1em}.tracking-wider{letter-spacing:.05em}
.text-center{text-align:center}.text-right{text-align:right}
.text-text-muted{color:var(--color-text-muted)}.text-text-faint{color:var(--color-text-faint)}
.text-text-secondary{color:var(--color-text-secondary)}.text-text-primary{color:var(--color-text-primary)}
.text-data{color:var(--color-data)}.text-warn{color:var(--color-warn)}
.flex{display:flex}.inline-flex{display:inline-flex}.flex-col{flex-direction:column}.flex-wrap{flex-wrap:wrap}
.flex-1{flex:1 1 0%}.shrink-0{flex-shrink:0}.items-center{align-items:center}.items-baseline{align-items:baseline}
.justify-between{justify-content:space-between}
.grid{display:grid}.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.gap-1{gap:.25rem}.gap-1\\.5{gap:.375rem}.gap-2{gap:.5rem}.gap-3{gap:.75rem}.gap-4{gap:1rem}
.gap-x-4{column-gap:1rem}.gap-x-5{column-gap:1.25rem}.gap-x-6{column-gap:1.5rem}.gap-y-1{row-gap:.25rem}.gap-y-3{row-gap:.75rem}
.mb-1{margin-bottom:.25rem}.mt-1{margin-top:.25rem}.mr-1{margin-right:.25rem}
.p-2{padding:.5rem}.p-3{padding:.75rem}.p-4{padding:1rem}.py-3{padding-top:.75rem;padding-bottom:.75rem}.py-6{padding-top:1.5rem;padding-bottom:1.5rem}
.px-1\\.5{padding-left:.375rem;padding-right:.375rem}.px-3{padding-left:.75rem;padding-right:.75rem}.py-0\\.5{padding-top:.125rem;padding-bottom:.125rem}.py-1\\.5{padding-top:.375rem;padding-bottom:.375rem}
.rounded{border-radius:.25rem}.rounded-sm{border-radius:.125rem}.rounded-lg{border-radius:.5rem}.rounded-xl{border-radius:.75rem}
.border{border-width:1px;border-style:solid}.border-line{border-color:var(--color-line)}
.overflow-hidden{overflow:hidden}
.h-4{height:1rem}.h-full{height:100%}.h-auto{height:auto}.w-full{width:100%}.w-20{width:5rem}.w-28{width:7rem}.w-64{width:16rem}
.bg-space-800{background:var(--color-space-800)}
.select-none{user-select:none}
.text-sm{font-size:.875rem}
.text-\\[9px\\]{font-size:9px}.text-\\[9\\.5px\\]{font-size:9.5px}.text-\\[10px\\]{font-size:10px}.text-\\[11px\\]{font-size:11px}
svg{max-width:100%;height:auto}
`;

function writeJson(p: string, obj: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

// ── op: profiles ─────────────────────────────────────────────────────────────
function opProfiles() {
  const dir = process.env.WORKBENCH_DIR!;
  const out = process.env.MCP_PROFILES_OUT!;
  const storage = makeNodeJsonlStorage(dir);
  const all = storage.list() as ObservationDeposit[];
  const byRig = new Map<string, ObservationDeposit[]>();
  for (const d of all) {
    const arr = byRig.get(d.rig_key) ?? [];
    arr.push(d);
    byRig.set(d.rig_key, arr);
  }
  const profiles = [...byRig.values()].map(rows => recomputeRigProfile(rows)).filter(Boolean);
  writeJson(out, profiles);
  expect(fs.existsSync(out)).toBe(true);
}

// ── op: list_widgets ─────────────────────────────────────────────────────────
function opListWidgets() {
  const out = process.env.MCP_WIDGETS_OUT!;
  // Optional data probe: which widgets yield REAL data on a reference receipt.
  let probe: any = null;
  const probePath = process.env.MCP_LIST_RECEIPT;
  if (probePath && fs.existsSync(probePath)) {
    try { probe = JSON.parse(fs.readFileSync(probePath, 'utf8')); } catch { probe = null; }
  }
  const inventory = WIDGETS.map(w => {
    let dataStatus: 'REAL' | 'ABSENT' | 'NOT_PROBED' = 'NOT_PROBED';
    if (probe) {
      try { dataStatus = w.dataSelector(probe, undefined) == null ? 'ABSENT' : 'REAL'; }
      catch { dataStatus = 'ABSENT'; }
    }
    return {
      id: w.id,
      title: w.title,
      intent: w.intent,
      weightTier: w.weightTier,
      status: SCAFFOLD_IDS.has(w.id) ? 'SCAFFOLD' : 'LIVE',
      data_on_reference: dataStatus,
    };
  });
  writeJson(out, { probe_receipt: probePath ? path.basename(probePath) : null, widgets: inventory });
  expect(fs.existsSync(out)).toBe(true);
}

// ── op: render_widget ────────────────────────────────────────────────────────
function opRenderWidget() {
  const receiptPath = process.env.MCP_RENDER_RECEIPT!;
  const widgetId = process.env.MCP_RENDER_WIDGET_ID!;
  const htmlOut = process.env.MCP_RENDER_HTML_OUT!;
  const metaOut = process.env.MCP_RENDER_META_OUT!;
  const width = Math.max(240, Math.min(2000, parseInt(process.env.MCP_RENDER_WIDTH || '900', 10) || 900));

  const w = WIDGETS.find(x => x.id === widgetId);
  if (!w) {
    writeJson(metaOut, { ok: false, reason: `unknown widget id: ${widgetId}`, known_ids: WIDGETS.map(x => x.id) });
    return; // honest error surfaced by the server; no HTML written
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));

  let data: unknown = null;
  try { data = w.dataSelector(receipt, undefined); } catch { data = null; }
  const status: 'REAL' | 'ABSENT' = data == null ? 'ABSENT' : 'REAL';

  const NOT_MEASURED = `<div style="padding:48px 24px;text-align:center">
    <div style="font-family:var(--font-mono);font-size:16px;font-weight:700;letter-spacing:.08em;color:var(--color-warn)">NOT MEASURED</div>
    <div style="font-family:var(--font-mono);font-size:11px;color:var(--color-text-muted);margin-top:6px">this measurement is absent on this frame — honest-or-absent (LAW 3)</div>
  </div>`;
  const body = data == null
    ? NOT_MEASURED
    : renderToStaticMarkup(React.createElement(w.render as any, { data }));

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(w.title)} — SkyCruncher widget</title>
<style>
${extractTokens()}
${UTILITY_SHIM}
body{padding:0}
#capture{width:${width}px;background:var(--color-space-850);border:1px solid var(--color-line);border-radius:12px;padding:16px;margin:0}
.whead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}
.wtitle{font-family:var(--font-mono);font-size:13px;color:var(--color-text-primary)}
.wtier{font-family:var(--font-mono);font-size:9px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:.12em;margin-left:8px}
.wstatus{font-family:var(--font-mono);font-size:9px;font-weight:700;letter-spacing:.1em;padding:2px 6px;border-radius:4px}
.wstatus-REAL{color:var(--color-space-950);background:var(--color-solve)}
.wstatus-ABSENT{color:var(--color-text-muted);border:1px solid var(--color-line)}
.wintent{font-family:var(--font-sans);font-size:11.5px;line-height:1.5;color:var(--color-text-secondary);margin-bottom:8px}
.wbody{padding-top:8px;border-top:1px solid var(--color-line-subtle)}
</style></head>
<body><div id="capture">
  <div class="whead"><div><span class="wtitle">${esc(w.title)}</span><span class="wtier">${esc(w.weightTier)}</span></div><span class="wstatus wstatus-${status}">${status}</span></div>
  <div class="wintent">${esc(w.intent)}</div>
  <div class="wbody">${body}</div>
</div></body></html>`;

  fs.mkdirSync(path.dirname(htmlOut), { recursive: true });
  fs.writeFileSync(htmlOut, html, 'utf8');
  writeJson(metaOut, {
    ok: true, id: w.id, title: w.title, weightTier: w.weightTier, intent: w.intent,
    status, width, receipt: path.basename(receiptPath),
    is_scaffold: SCAFFOLD_IDS.has(w.id),
  });
  expect(fs.existsSync(htmlOut)).toBe(true);
}

describe('tools/mcp helper', () => {
  it(`runs op=${OP}`, () => {
    switch (OP) {
      case 'profiles': return opProfiles();
      case 'list_widgets': return opListWidgets();
      case 'render_widget': return opRenderWidget();
      default: throw new Error(`MCP_HELPER_OP must be profiles|list_widgets|render_widget (got ${OP})`);
    }
  });
});
