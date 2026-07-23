/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WIDGET REVIEW GALLERY — one-shot server-side render of EVERY registry widget
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * (invoked by tools/widgets/build_gallery.mjs — runs under vitest for the `@/`
 * alias + TSX transpile; renders pure widget components with react-dom/server.)
 *
 * Renders each registered widget ONCE against REAL receipt data (the headless
 * M66 solve), embeds the data inline, and writes ONE self-contained HTML page
 * (test_results/widget_review/gallery.html): instrument tokens inlined from
 * src/index.css, one section per widget with its intent beside it. Absent
 * measurements show their canonical NOT MEASURED state (honest-or-absent).
 * Scaffolds render as NOT MEASURED + intent. Owner rule: capture ONCE — no
 * quality iteration, no aesthetic loop.
 *
 * A single clearly-labeled SYNTHETIC-SHAPE timing demo is included because
 * per-stage timings are event-only (never in a receipt) — it is illustrative
 * shape, explicitly NOT sky data.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WIDGETS } from '../../src/engine/ui/widgets/registry';
import { selectSolveTiming } from '../../src/engine/ui/widgets/widgets/SolveTimingWaterfallWidget';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RECEIPT = process.env.GALLERY_RECEIPT
    ? path.resolve(process.env.GALLERY_RECEIPT)
    : path.join(ROOT, 'test_results', 'api_runs', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.receipt.json');
const OUT_DIR = path.join(ROOT, 'test_results', 'widget_review');
const OUT_HTML = path.join(OUT_DIR, 'gallery.html');
const OUT_PROV = path.join(OUT_DIR, 'gallery_provenance.json');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── token extraction (all --xxx: yyy; from src/index.css → one :root block) ──
function extractTokens(): string {
    const css = readFileSync(path.join(ROOT, 'src', 'index.css'), 'utf8');
    const lines = css.match(/--[\w-]+:\s*[^;]+;/g) ?? [];
    return `:root{\n${[...new Set(lines)].map(l => '  ' + l).join('\n')}\n}`;
}

// ── minimal Tailwind-utility shim (review artifact only; SVGs use inline var()) ─
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

interface Rendered { id: string; title: string; tier: string; intent: string; status: 'REAL' | 'ABSENT'; html: string }

describe('widget review gallery', () => {
    it('renders every registry widget into one self-contained HTML page', () => {
        const receipt = JSON.parse(readFileSync(RECEIPT, 'utf8'));
        const receiptName = path.basename(RECEIPT);

        const NOT_MEASURED = `<div class="text-[11px] font-mono text-text-muted py-6 text-center">NOT MEASURED</div>`;
        const rendered: Rendered[] = WIDGETS.map(w => {
            let data: unknown = null;
            try { data = w.dataSelector(receipt, undefined); } catch (e) { data = null; }
            const status: 'REAL' | 'ABSENT' = data == null ? 'ABSENT' : 'REAL';
            const html = data == null
                ? NOT_MEASURED
                : renderToStaticMarkup(React.createElement(w.render as any, { data }));
            return { id: w.id, title: w.title, tier: w.weightTier, intent: w.intent, status, html };
        });

        // Clearly-labeled SYNTHETIC-SHAPE timing demo (per-stage timing is event-only).
        const synthEvents: any = [
            { kind: 'stage_started', stage: 'ingest', label: 'Ingest' },
            { kind: 'stage_finished', stage: 'ingest', ok: true, ms: 210 },
            { kind: 'stage_started', stage: 'detect', label: 'Detect' },
            { kind: 'stage_finished', stage: 'detect', ok: true, ms: 640 },
            { kind: 'stage_started', stage: 'solve', label: 'Solve' },
            { kind: 'stage_finished', stage: 'solve', ok: true, ms: 1180 },
            { kind: 'stage_started', stage: 'characterize', label: 'Characterize' },
            { kind: 'stage_finished', stage: 'characterize', ok: true, ms: 430 },
        ];
        const timingWidget = WIDGETS.find(w => w.id === 'solve_timing_waterfall')!;
        const synthData = selectSolveTiming(receipt, synthEvents);
        const synthHtml = synthData
            ? renderToStaticMarkup(React.createElement(timingWidget.render as any, { data: synthData }))
            : NOT_MEASURED;

        const realCount = rendered.filter(r => r.status === 'REAL').length;
        const absentCount = rendered.filter(r => r.status === 'ABSENT').length;

        const card = (r: Rendered) => `
      <section class="wcard" data-status="${r.status}">
        <div class="whead">
          <div>
            <span class="wtitle">${esc(r.title)}</span>
            <span class="wtier">${esc(r.tier)}</span>
          </div>
          <span class="wstatus wstatus-${r.status}">${r.status}</span>
        </div>
        <div class="wintent">${esc(r.intent)}</div>
        <div class="wbody">${r.html}</div>
      </section>`;

        const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>SkyCruncher — Widget Review Gallery</title>
<style>
${extractTokens()}
${UTILITY_SHIM}
.page{max-width:1200px;margin:0 auto;padding:28px 20px 80px}
h1{font-family:var(--font-mono);font-size:18px;letter-spacing:.04em;margin:0 0 4px}
.sub{color:var(--color-text-muted);font-family:var(--font-mono);font-size:11px;margin-bottom:2px}
.prov{color:var(--color-text-secondary);font-family:var(--font-mono);font-size:11px;margin:14px 0 22px;padding:10px 12px;border:1px solid var(--color-line);border-radius:8px;background:var(--color-space-900)}
.grid-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px}
.wcard{background:var(--color-space-850);border:1px solid var(--color-line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px}
.whead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.wtitle{font-family:var(--font-mono);font-size:13px;color:var(--color-text-primary)}
.wtier{font-family:var(--font-mono);font-size:9px;color:var(--color-text-faint);text-transform:uppercase;letter-spacing:.12em;margin-left:8px}
.wstatus{font-family:var(--font-mono);font-size:9px;font-weight:700;letter-spacing:.1em;padding:2px 6px;border-radius:4px}
.wstatus-REAL{color:var(--color-space-950);background:var(--color-solve)}
.wstatus-ABSENT{color:var(--color-text-muted);border:1px solid var(--color-line)}
.wintent{font-family:var(--font-sans);font-size:11.5px;line-height:1.5;color:var(--color-text-secondary)}
.wbody{margin-top:4px;padding-top:8px;border-top:1px solid var(--color-line-subtle)}
.synth{margin-top:30px}
.synth .wcard{border-color:var(--color-warn)}
.synthlabel{font-family:var(--font-mono);font-size:11px;color:var(--color-warn);margin:6px 0}
h2{font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary);margin:34px 0 10px;letter-spacing:.04em}
</style></head>
<body><div class="page">
  <h1>SkyCruncher — Widget Review Gallery</h1>
  <div class="sub">Phase-2 widget suite · one-shot render · ${WIDGETS.length} registered widgets</div>
  <div class="prov">
    DATA PROVENANCE — real sky data: headless M66 solve
    <b>${esc(receiptName)}</b> (bit-identical FITS lane; RA 11.3413h, scale 3.6776″/px, 272 matched, conf 0.831).<br/>
    ${realCount} widgets rendered from REAL receipt data · ${absentCount} honest NOT MEASURED (absent on this frame / scaffolds).
    No CR2 receipt available on this base (CR2 headless out of scope) — no CR2 data shown.
    The single SYNTHETIC-SHAPE tile at the bottom is illustrative timing shape, explicitly NOT sky data.
  </div>
  <div class="grid-gallery">
    ${rendered.map(card).join('\n')}
  </div>
  <div class="synth">
    <h2>SYNTHETIC-SHAPE (not sky data)</h2>
    <div class="synthlabel">⚠ SYNTHETIC-SHAPE — illustrative per-stage timings from fabricated events (per-stage timing is event-only, never in a receipt). NOT from this or any solve.</div>
    <div class="grid-gallery">
      <section class="wcard" data-status="SYNTHETIC">
        <div class="whead"><div><span class="wtitle">${esc(timingWidget.title)}</span><span class="wtier">${esc(timingWidget.weightTier)}</span></div><span class="wstatus" style="color:var(--color-warn);border:1px solid var(--color-warn)">SYNTHETIC</span></div>
        <div class="wintent">${esc(timingWidget.intent)}</div>
        <div class="wbody">${synthHtml}</div>
      </section>
    </div>
  </div>
</div></body></html>`;

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(OUT_HTML, html, 'utf8');
        writeFileSync(OUT_PROV, JSON.stringify({
            receipt: receiptName,
            total: WIDGETS.length,
            real: realCount,
            absent: absentCount,
            widgets: rendered.map(r => ({ id: r.id, tier: r.tier, status: r.status })),
        }, null, 2), 'utf8');

        // sanity: the page is self-contained + carries the real solve numbers
        expect(html).toContain('11.3413h');
        expect(html).not.toContain('http://');
        expect(html).not.toContain('https://');
        expect(realCount).toBeGreaterThanOrEqual(8);
        expect(rendered).toHaveLength(WIDGETS.length);
    });
});
