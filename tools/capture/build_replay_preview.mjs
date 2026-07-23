/**
 * ★ REPLAY DASHBOARD — static preview generator (owner eyeball, no boot).
 *
 * Reads the newest REAL headless capture record (test_results/runs/*.jsonl,
 * written by tools/capture/headless_capture.capspec.ts) and emits a single
 * self-contained HTML file that scrubs it: split panes, widget-swap slots, and
 * a speed-scrubbing time slider (0.25× slow-mo … 16× sped-up). The scrub math
 * here is a faithful vanilla-JS mirror of src/.../replay/replay_state.ts — this
 * is a REVIEW artifact under the gitignored test_results/, NOT shipped app code
 * (the app uses the typed module), so the mirror is allowed.
 *
 *   node tools/capture/build_replay_preview.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS_DIR = path.join(REPO_ROOT, 'test_results', 'runs');
const OUT_DIR = path.join(REPO_ROOT, 'test_results', 'widget_review');
const OUT = path.join(OUT_DIR, 'replay_dashboard_preview.html');

function newestJsonl() {
    if (!fs.existsSync(RUNS_DIR)) return null;
    const files = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f, m: fs.statSync(path.join(RUNS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
    return files[0] ? path.join(RUNS_DIR, files[0].f) : null;
}

const src = newestJsonl();
if (!src) {
    console.error('[preview] no test_results/runs/*.jsonl — run: npx vitest run -c tools/capture/capture.config.ts');
    process.exit(1);
}
const envelopes = fs.readFileSync(src, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
console.log(`[preview] embedding ${envelopes.length} envelopes from ${path.basename(src)}`);

const DATA = JSON.stringify(envelopes);

const HTML = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Replay Dashboard — Preview</title>
<style>
:root{
  --space-950:#05060a;--space-900:#0a0c12;--space-850:#0e1118;--space-800:#131722;--space-750:#191e2b;--space-700:#212736;
  --line-subtle:#1c2230;--line:#2a3245;--line-strong:#3d4763;
  --text-primary:#e8ecf4;--text-secondary:#9aa5bd;--text-muted:#6a7792;--text-faint:#3d4763;
  --accent-300:#7dd3fc;--accent-400:#38bdf8;--accent-500:#0ea5e9;--accent-600:#0284c7;
  --solve:#34d399;--warn:#fbbf24;--danger:#f87171;--pending:#5d6880;--data:#c7d5f0;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at 50% -10%,#151a26 0%,var(--space-950) 60%);color:var(--text-primary);
  font-family:'Inter',system-ui,-apple-system,sans-serif;font-size:14px;padding:20px;min-height:100vh}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:15px;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin:0 0 2px;
  background:linear-gradient(90deg,#fff,var(--accent-400));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:var(--text-muted);font-size:11px;font-family:'JetBrains Mono',ui-monospace,monospace;margin-bottom:14px}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.dash{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:rgba(10,12,18,.7)}
.bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line);background:rgba(10,12,18,.8)}
.bar .t{color:var(--text-secondary);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase}
select,button,input{font-family:inherit}
select{background:var(--space-800);border:1px solid var(--line);border-radius:6px;color:var(--text-primary);font-size:11px;padding:3px 6px}
.grow{flex:1}
.panes{display:flex;gap:6px;padding:8px;min-height:320px;background:rgba(5,6,10,.4)}
.pane{flex:1;min-width:0;display:flex;flex-direction:column;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--space-850)}
.pane>header{display:flex;align-items:center;gap:6px;padding:5px 8px;background:rgba(10,12,18,.7);border-bottom:1px solid var(--line)}
.pane>header .title{font-size:10px;font-family:'JetBrains Mono',monospace;color:var(--text-secondary);text-transform:uppercase;letter-spacing:1px}
.pane .body{flex:1;overflow:auto;padding:12px}
.divider{width:4px;background:var(--line);border-radius:2px;flex:0 0 auto}
.progress{height:4px;border-radius:2px;background:var(--space-850);overflow:hidden;margin:6px 0 12px}
.progress>i{display:block;height:100%;background:var(--accent-500);transition:width .08s linear}
.stage{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.stage .name{width:130px;flex:0 0 auto;font-family:'JetBrains Mono',monospace;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{position:relative;flex:1;height:8px;border-radius:4px;background:var(--space-800);overflow:hidden}
.track>i{position:absolute;top:0;height:100%;border-radius:4px}
.stage .meta{width:120px;flex:0 0 auto;text-align:right;font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--text-muted)}
.pending .name{color:var(--text-faint)} .active .name{color:var(--accent-300)} .complete .name{color:var(--text-secondary)}
.legend{display:flex;gap:14px;font-size:10px;font-family:'JetBrains Mono',monospace;color:var(--text-muted);margin-top:6px}
.kv{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line-subtle);font-family:'JetBrains Mono',monospace;font-size:12px}
.kv .k{color:var(--text-muted)} .kv .v{color:var(--data)}
.nm{color:var(--text-muted);font-family:'JetBrains Mono',monospace;font-size:11px;text-align:center;padding:24px 0}
.slider{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;border-top:1px solid var(--line);background:rgba(10,12,18,.6)}
.btn{background:var(--accent-600);color:#fff;border:none;border-radius:6px;padding:5px 11px;font-size:12px;font-weight:700;cursor:pointer}
.btn:hover{background:var(--accent-500)}
.btn.ghost{background:var(--space-800);color:var(--text-secondary)}
input[type=range]{flex:1;min-width:160px;accent-color:var(--accent-500)}
.speeds{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.speeds button{background:var(--space-800);color:var(--text-secondary);border:none;padding:4px 9px;font-size:10px;font-family:'JetBrains Mono',monospace;cursor:pointer}
.speeds button[aria-pressed=true]{background:var(--accent-600);color:#fff}
.readout{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted);min-width:120px;text-align:right}
.note{font-size:11px;color:var(--text-muted);margin-top:12px;font-family:'JetBrains Mono',monospace;line-height:1.6}
.pulse{animation:p 1s ease-in-out infinite}@keyframes p{50%{opacity:.4}}
</style></head>
<body><div class="wrap">
<h1>Replay Dashboard — Preview</h1>
<div class="sub">Real headless SeeStar run · scrub the time slider · split panes + widget-swap slots · slow-mo &amp; sped-up playback</div>

<div class="dash">
  <div class="bar">
    <span class="t">Replay Dashboard</span>
    <span class="grow"></span>
    <span class="mono" style="font-size:10px;color:var(--text-faint)">2 panes · static preview</span>
  </div>
  <div class="bar">
    <span class="t" style="letter-spacing:1px">Run</span>
    <select id="runsel"></select>
    <span class="mono" style="font-size:10px;color:var(--solve)">PAST</span>
    <span class="grow"></span>
    <span class="mono" style="font-size:10px;color:var(--text-faint)">(in the app: LIVE current run + drag-drop runs/*.jsonl)</span>
  </div>

  <div class="panes">
    <div class="pane">
      <header><span class="title" id="p0title">Replay Timeline</span><span class="grow"></span>
        <select class="swap" data-pane="0"><option value="timeline">Replay Timeline</option><option value="table">Stage Table</option><option value="summary">Solve Summary</option></select>
      </header>
      <div class="body" id="pane0"></div>
    </div>
    <div class="divider"></div>
    <div class="pane">
      <header><span class="title" id="p1title">Solve Summary</span><span class="grow"></span>
        <select class="swap" data-pane="1"><option value="summary">Solve Summary</option><option value="timeline">Replay Timeline</option><option value="table">Stage Table</option></select>
      </header>
      <div class="body" id="pane1"></div>
    </div>
  </div>

  <div class="slider">
    <button class="btn" id="play">▶</button>
    <button class="btn ghost" id="restart">⏮</button>
    <input type="range" id="scrub" min="0" max="1000" value="0">
    <span class="readout" id="readout">0.00s / 0.00s</span>
    <span class="speeds" id="speeds">
      <button data-s="0.25">0.25×</button><button data-s="1" aria-pressed="true">1×</button><button data-s="4">4×</button><button data-s="16">16×</button>
    </span>
  </div>
</div>

<div class="note">
  Honest-or-absent: a stage with no events at time t is <b style="color:var(--pending)">pending</b> (grey) — never a fabricated timing.
  Verdicts / counts appear only once a stage <b style="color:var(--solve)">completes</b>. The scrub math is the pure
  <span style="color:var(--data)">deriveReplayFrame(envelopes,&nbsp;t)</span> mirrored from the app's typed module.
</div>

<script>
const ENVELOPES = ${DATA};
const SPEEDS = [0.25,1,4,16];
function bounds(evs){if(!evs.length)return{tStart:0,tEnd:0,totalMs:0};let a=Infinity,b=-Infinity;for(const e of evs){if(e.t_start<a)a=e.t_start;if(e.t_end>b)b=e.t_end;}return{tStart:a,tEnd:b,totalMs:Math.max(0,b-a)};}
function phaseAt(e,t){if(t<e.t_start)return'pending';if(t>=e.t_end)return'complete';return'active';}
function clamp(t,B){if(B.tEnd<=B.tStart)return B.tStart;return Math.min(B.tEnd,Math.max(B.tStart,t));}
function derive(evs,t){const B=bounds(evs);const s=clamp(t,B);
  const stages=evs.map(e=>{const ph=phaseAt(e,s);const c=ph==='complete';return{id:e.stage_id,seq:e.seq,phase:ph,tStart:e.t_start,tEnd:e.t_end,
    verdict:c?e.verdict:null,ms:c?e.ms:null,ok:c?e.ok:null,counts:c?e.counts:{},warnings:c?e.warnings:[]};}).sort((x,y)=>(x.tStart-y.tStart)||(x.seq-y.seq));
  let comp=0,act=0,pend=0;for(const st of stages){if(st.phase==='complete')comp++;else if(st.phase==='active')act++;else pend++;}
  return{t:s,tStart:B.tStart,tEnd:B.tEnd,totalMs:B.totalMs,elapsedMs:Math.max(0,s-B.tStart),stages,recordSlice:evs.filter(e=>e.t_end<=s),
    completeCount:comp,activeCount:act,pendingCount:pend,runId:(evs.find(e=>e.run_id)||{}).run_id||null,frameSha:(evs.slice().reverse().find(e=>e.frame_sha)||{}).frame_sha||null};}
const B=bounds(ENVELOPES);let scrubT=B.tStart,playing=false,speed=1,panes=['timeline','summary'];
const PHASE={pending:{dot:'var(--pending)',bar:'var(--space-700)'},active:{dot:'var(--accent-400)',bar:'var(--accent-500)'},complete:{dot:'var(--solve)',bar:'rgba(52,211,153,.6)'}};
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function renderTimeline(f){const span=Math.max(1,f.totalMs);let h='<div class="mono" style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted)"><span>REPLAY · '+(f.elapsedMs/1000).toFixed(2)+'s / '+(f.totalMs/1000).toFixed(2)+'s</span><span><b style="color:var(--solve)">'+f.completeCount+'✓</b> <b style="color:var(--accent-300)">'+f.activeCount+'●</b> <b style="color:var(--text-faint)">'+f.pendingCount+'○</b></span></div>';
  h+='<div class="progress"><i style="width:'+(f.totalMs>0?f.elapsedMs/f.totalMs*100:100)+'%"></i></div>';
  for(const st of f.stages){const p=PHASE[st.phase];const failed=st.phase==='complete'&&st.ok===false;const left=(st.tStart-f.tStart)/span*100;const w=Math.max(.8,(st.tEnd-st.tStart)/span*100);
    const matched=st.counts.matched!=null?st.counts.matched:(st.counts.n_stars!=null?st.counts.n_stars:null);
    const meta=st.phase==='complete'?((st.ms!=null?Math.round(st.ms):'·')+'ms'+(matched!=null?' · '+matched:'')):st.phase==='active'?'running…':'—';
    h+='<div class="stage '+st.phase+'"><span class="dot'+(st.phase==='active'?' pulse':'')+'" style="background:'+(failed?'var(--danger)':p.dot)+'"></span>'+
      '<span class="name" title="'+esc(st.id)+'">'+esc(st.id)+'</span>'+
      '<span class="track"><i style="left:'+left+'%;width:'+w+'%;background:'+(failed?'var(--danger)':p.bar)+'"></i></span>'+
      '<span class="meta">'+meta+'</span></div>';}
  h+='<div class="legend"><span>● <span style="color:var(--pending)">pending</span></span><span>● <span style="color:var(--accent-300)">active</span></span><span>● <span style="color:var(--solve)">complete</span></span></div>';
  return h;}
function renderTable(f){let h='<table style="width:100%;border-collapse:collapse;font-family:JetBrains Mono,monospace;font-size:10px">'+
  '<tr style="color:var(--text-muted);text-align:left"><th style="padding:3px">stage</th><th>phase</th><th>verdict</th><th style="text-align:right">ms</th></tr>';
  for(const st of f.stages){const col=st.phase==='complete'?'var(--solve)':st.phase==='active'?'var(--accent-300)':'var(--text-faint)';
    h+='<tr style="border-top:1px solid var(--line-subtle)"><td style="padding:3px;color:var(--text-secondary)">'+esc(st.id)+'</td>'+
      '<td style="color:'+col+'">'+st.phase+'</td><td style="color:var(--data)">'+(st.verdict!=null?st.verdict:'—')+'</td>'+
      '<td style="text-align:right;color:var(--text-muted)">'+(st.ms!=null?Math.round(st.ms):'—')+'</td></tr>';}
  return h+'</table>';}
function renderSummary(f){const solve=f.recordSlice.find(e=>e.stage_id.indexOf('solve.')===0&&e.verdict==='PASS');
  const spcc=f.recordSlice.find(e=>e.stage_id==='spcc');const bc=f.recordSlice.find(e=>e.stage_id==='bc_measure');
  if(!solve)return '<div class="nm">NOT MEASURED<br><span style="font-size:9px">(solve not yet complete at t='+(f.elapsedMs/1000).toFixed(2)+'s)</span></div>';
  const rows=[['Matched stars',solve.counts.matched!=null?solve.counts.matched:'—'],['SPCC stars',spcc?spcc.counts.n_stars:'NOT MEASURED'],
    ['BC pairs used',bc?bc.counts.n_used:'NOT MEASURED'],['Stages complete',f.completeCount+' / '+f.stages.length],
    ['Elapsed',(f.elapsedMs/1000).toFixed(2)+'s'],['Frame sha',(f.frameSha||'—').slice(0,16)+'…']];
  return rows.map(r=>'<div class="kv"><span class="k">'+r[0]+'</span><span class="v">'+r[1]+'</span></div>').join('');}
const RENDER={timeline:renderTimeline,table:renderTable,summary:renderSummary};
const TITLE={timeline:'Replay Timeline',table:'Stage Table',summary:'Solve Summary'};
function draw(){const f=derive(ENVELOPES,scrubT);
  document.getElementById('pane0').innerHTML=RENDER[panes[0]](f);
  document.getElementById('pane1').innerHTML=RENDER[panes[1]](f);
  document.getElementById('p0title').textContent=TITLE[panes[0]];
  document.getElementById('p1title').textContent=TITLE[panes[1]];
  const sc=document.getElementById('scrub');sc.value=f.totalMs>0?(f.elapsedMs/f.totalMs*1000):0;
  document.getElementById('readout').textContent=(f.elapsedMs/1000).toFixed(2)+'s / '+(f.totalMs/1000).toFixed(2)+'s';
  document.getElementById('play').textContent=playing?'❚❚':(scrubT>=B.tEnd?'↻':'▶');}
let raf=0,last=0;
function tick(now){const dt=now-last;last=now;scrubT+=dt*speed;if(scrubT>=B.tEnd){scrubT=B.tEnd;playing=false;draw();return;}draw();raf=requestAnimationFrame(tick);}
function play(){if(scrubT>=B.tEnd)scrubT=B.tStart;playing=true;last=performance.now();raf=requestAnimationFrame(tick);draw();}
function pause(){playing=false;cancelAnimationFrame(raf);draw();}
document.getElementById('play').onclick=()=>playing?pause():play();
document.getElementById('restart').onclick=()=>{pause();scrubT=B.tStart;draw();};
document.getElementById('scrub').oninput=e=>{pause();scrubT=B.tStart+(e.target.value/1000)*B.totalMs;draw();};
document.querySelectorAll('#speeds button').forEach(b=>b.onclick=()=>{speed=parseFloat(b.dataset.s);document.querySelectorAll('#speeds button').forEach(x=>x.setAttribute('aria-pressed',x===b));draw();});
document.querySelectorAll('.swap').forEach(s=>s.onchange=()=>{panes[+s.dataset.pane]=s.value;draw();});
const rs=document.getElementById('runsel');const o=document.createElement('option');const bb=bounds(ENVELOPES);
o.textContent='['+((ENVELOPES.find(e=>e.run_id)||{}).run_id||'run')+'] '+ENVELOPES.length+' stages · '+(bb.totalMs/1000).toFixed(2)+'s';rs.appendChild(o);
draw();
</script>
</div></body></html>`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, HTML, 'utf8');
console.log(`[preview] wrote ${OUT} (${(HTML.length / 1024).toFixed(1)} KB, self-contained)`);
