/**
 * ★ SOLVE-FLOWCHART static preview generator (owner-eyeballs, no app boot).
 *
 * Reads the REAL capture records on disk (test_results/runs/*.jsonl, written by
 * headless_capture.capspec.ts), folds them with the SAME `aggregateCaptureRuns`
 * the widget uses, and emits a self-contained, INTERACTIVE HTML page
 * (test_results/widget_review/flowchart_preview.html) rendering the flowchart
 * from the shared pure `flowchart_model` — hover a box or arrow to see the real
 * captured data / timing / flow, exactly like the in-app widget.
 *
 * Not a gate test — lives in the isolated capture lane (capture.config.ts scopes
 * to *.capspec.ts). Run it explicitly:
 *   npx vitest run -c tools/capture/capture.config.ts tools/capture/render_flowchart_preview.capspec.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateCaptureRuns, parseCaptureJsonl } from '@/engine/events/capture_aggregate';
import {
    FLOW_NODES, FLOW_EDGES, NODE_BY_ID, RUNTIME_META, layoutDims, STATUS_COLOR_VAR,
    nodeBox, edgePathD, usedRuntimes, statFor, buildNodeTooltip, buildEdgeTooltip,
    type Orientation,
} from '@/engine/ui/widgets/widgets/flowchart_model';

// The static owner-preview mirrors the in-app DEFAULT (landscape dashboard pane):
// a horizontal left→right pipeline. Orientation is a pure layout parameter shared
// with the widget, so this preview can never drift from what ships.
const ORIENTATION: Orientation = 'horizontal';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS_DIR = path.join(REPO_ROOT, 'test_results', 'runs');
const OUT_DIR = path.join(REPO_ROOT, 'test_results', 'widget_review');
const OUT = path.join(OUT_DIR, 'flowchart_preview.html');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

describe('flowchart static preview', () => {
    it('renders the real capture record(s) into a self-contained HTML page', () => {
        // 1. Gather every capture record on disk.
        const files = fs.existsSync(RUNS_DIR)
            ? fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.jsonl'))
            : [];
        expect(files.length, `no capture record in ${RUNS_DIR} — run headless_capture.capspec.ts first`).toBeGreaterThan(0);
        const runs = files.map(f => parseCaptureJsonl(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8')));
        const agg = aggregateCaptureRuns(runs);

        // 2. Build SVG (mirrors the widget; geometry/colors/tooltips from the shared model).
        const cvar = (v: string) => `var(${v})`;
        const tips: Record<string, string> = {};

        const dims = layoutDims(ORIENTATION);

        const edgeSvg = FLOW_EDGES.map((e, i) => {
            const d = edgePathD(e, ORIENTATION);
            const dashed = NODE_BY_ID[e.to]?.optional ? ' stroke-dasharray="3 3"' : '';
            const t = buildEdgeTooltip(NODE_BY_ID[e.to], statFor(agg, e.to));
            tips[`edge:${i}`] =
                `<div class="tt-title">${esc(t.title)}</div>`
                + `<div class="tt-sec">timing (successful solves)</div><div class="tt-${t.measured ? 'val' : 'na'}">${esc(t.timing)}</div>`
                + `<div class="tt-sec">flow through this stage</div><div class="tt-${t.measured ? 'val' : 'na'}">${esc(t.flow)}</div>`;
            return `<g><path d="${d}" fill="none" stroke="${cvar('--color-line-strong')}" stroke-width="1.3"${dashed} marker-end="url(#fc-arrow)"/>`
                + `<path class="hit" data-tip="edge:${i}" d="${d}" fill="none" stroke="transparent" stroke-width="12"/></g>`;
        }).join('');

        const nodeSvg = FLOW_NODES.map(spec => {
            const b = nodeBox(spec, ORIENTATION);
            const rt = RUNTIME_META[spec.runtime];
            const stat = statFor(agg, spec.id);
            const measured = !!stat && stat.reached > 0;
            const failedHist = !!stat && stat.failed > 0 && stat.passed === 0;
            const borderVar = failedHist ? STATUS_COLOR_VAR.failed : rt.colorVar;
            const dotVar = failedHist ? STATUS_COLOR_VAR.failed : measured ? STATUS_COLOR_VAR.done : STATUS_COLOR_VAR.idle;
            const idleDash = spec.optional && !measured ? ' stroke-dasharray="4 3"' : '';
            const t = buildNodeTooltip(spec, stat);
            tips[`node:${spec.id}`] =
                `<div class="tt-title">${esc(t.title)} <span class="tt-rt">${esc(t.runtimeLabel)}${t.optional ? ' · opt' : ''}</span></div>`
                + `<div class="tt-note">${esc(spec.note)}</div>`
                + `<div class="tt-sec">data captured</div>`
                + t.captured.map(l => `<div class="tt-${/NOT MEASURED$/.test(l) ? 'na' : 'val'}">${esc(l)}</div>`).join('')
                + `<div class="tt-sec">enables widgets</div>`
                + t.enables.map(w => `<div class="tt-w">· ${esc(w)}</div>`).join('');
            return `<g class="node" data-tip="node:${spec.id}">`
                + `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5" fill="${cvar(rt.colorVar)}" fill-opacity="0.14" stroke="${cvar(borderVar)}" stroke-width="1.2"${idleDash}/>`
                + `<text x="${b.x + 8}" y="${b.cy + 3.5}" font-family="var(--font-mono)" font-size="9.5" fill="${cvar('--color-text-primary')}">${esc(spec.label)}</text>`
                + `<circle cx="${b.x + b.w - 8}" cy="${b.y + 8}" r="3" fill="${cvar(dotVar)}"/></g>`;
        }).join('');

        const legend = usedRuntimes().map(rt =>
            `<span class="lg"><span class="sw" style="background:${cvar(RUNTIME_META[rt].colorVar)}"></span>${esc(RUNTIME_META[rt].label)}</span>`
        ).join('')
            + `<span class="lg"><span class="dot" style="background:${cvar(STATUS_COLOR_VAR.done)}"></span>measured</span>`
            + `<span class="lg"><span class="dot" style="background:${cvar(STATUS_COLOR_VAR.idle)}"></span>not measured</span>`;

        const sample = `${agg.frame_count} frame(s) · ${agg.run_count} run(s), deduped by content hash`
            + (agg.unhashed_count ? ` · ${agg.unhashed_count} unhashed` : '')
            + ` · ${agg.successful_frames}/${agg.frame_count} ran to completion`;

        // 3. Self-contained HTML (CSS vars inlined; tiny hover JS; no external deps).
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Solve Flowchart — static preview</title>
<style>
:root{
 --color-space-950:#080b14;--color-space-900:#0d1220;--color-space-800:#141b2d;
 --color-line:#232b40;--color-line-strong:#3d4763;
 --color-text-primary:#e8ecf4;--color-text-secondary:#9aa5bd;--color-text-muted:#6a7792;--color-text-faint:#3d4763;
 --color-accent-400:#38bdf8;--color-solve:#34d399;--color-danger:#f87171;--color-data:#c7d5f0;
 --chart-cat-1:#38bdf8;--chart-cat-2:#fbbf24;--chart-cat-4:#a78bfa;--chart-cat-5:#f472b6;
 --font-mono:"JetBrains Mono","Cascadia Code","Consolas",ui-monospace,monospace;
}
body{margin:0;background:var(--color-space-950);color:var(--color-text-primary);font-family:var(--font-mono);padding:24px;}
.card{max-width:1180px;margin:0 auto;background:var(--color-space-900);border:1px solid var(--color-line);border-radius:14px;padding:18px;}
h1{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-text-muted);margin:0 0 4px;}
.sub{font-size:10px;color:var(--color-text-muted);margin-bottom:10px;}
.legend{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 12px;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-muted);}
.lg{display:inline-flex;align-items:center;gap:5px;}
.sw{width:11px;height:11px;border-radius:3px;display:inline-block;}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;}
.stage{position:relative;}
svg{width:100%;height:auto;}
.node,.hit{cursor:help;}
#tt{position:fixed;z-index:20;pointer-events:none;display:none;width:236px;background:var(--color-space-900);
 border:1px solid var(--color-line-strong);border-radius:7px;padding:9px 10px;box-shadow:0 6px 24px #0009;font-size:9px;}
.tt-title{font-size:10px;font-weight:700;color:var(--color-text-primary);}
.tt-rt{font-size:8px;color:var(--color-text-muted);font-weight:400;}
.tt-note{font-size:8.5px;color:var(--color-text-muted);font-style:italic;margin:2px 0;}
.tt-sec{font-size:7.5px;text-transform:uppercase;letter-spacing:.14em;color:var(--color-text-faint);margin:6px 0 2px;}
.tt-val{color:var(--color-data);} .tt-na{color:var(--color-text-faint);} .tt-w{color:var(--color-text-secondary);}
.foot{font-size:9px;color:var(--color-text-muted);margin-top:12px;line-height:1.5;}
</style></head><body><div class="card">
<h1>★ Solve Flowchart <span style="color:var(--color-text-faint)">— static preview (real capture record)</span></h1>
<div class="sub">${esc(sample)}</div>
<div class="legend">${legend}</div>
<div class="stage">
<svg viewBox="0 0 ${dims.width} ${dims.height}" role="img" aria-label="Solve pipeline flowchart (horizontal, left to right)">
<defs><marker id="fc-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${cvar('--color-line-strong')}"/></marker></defs>
${edgeSvg}
${nodeSvg}
</svg></div>
<div class="foot">Hover a box for its captured data + enabled widgets; hover an arrow for timing (fast→avg→slow successful solve) and pass/fail flow. Deduped per frame content-hash so repeat runs of one image count once. Unmeasured edges read <b>NOT MEASURED</b> — never a placeholder. This session's sample is local only; the in-app widget adds a live active-box highlight + a community/global tab (NOT CONNECTED, pending).</div>
</div>
<div id="tt"></div>
<script>
const TIP=${JSON.stringify(tips)};
const tt=document.getElementById('tt');
function show(e){const k=e.currentTarget.getAttribute('data-tip');if(!k||!TIP[k])return;tt.innerHTML=TIP[k];tt.style.display='block';move(e);}
function move(e){tt.style.left=Math.min(e.clientX+14,window.innerWidth-248)+'px';tt.style.top=(e.clientY+14)+'px';}
function hide(){tt.style.display='none';}
for(const el of document.querySelectorAll('[data-tip]')){el.addEventListener('mouseenter',show);el.addEventListener('mousemove',move);el.addEventListener('mouseleave',hide);}
</script></body></html>`;

        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(OUT, html, 'utf8');
        expect(fs.existsSync(OUT)).toBe(true);
        // The preview must carry REAL data, not a placeholder (the SeeStar sacred 272 match).
        expect(html).toContain('matched: 272');
        // eslint-disable-next-line no-console
        console.log(`[flowchart-preview] wrote ${OUT} (${agg.frame_count} frame, ${agg.run_count} run)`);
    });
});
