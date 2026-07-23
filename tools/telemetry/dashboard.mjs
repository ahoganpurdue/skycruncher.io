#!/usr/bin/env node
// tools/telemetry/dashboard.mjs
// Lightweight live view of the local OTel telemetry. Re-parses metrics.jsonl on
// every /data poll (the file is small) and serves a self-refreshing HTML page.
//   node tools/telemetry/dashboard.mjs            # -> http://127.0.0.1:4319
//   PORT=5000 node tools/telemetry/dashboard.mjs
// Port defaults to 4319 to stay clear of the OTel collector on 4318.

import { createServer } from 'node:http';
import { summarize, listSessions, DEFAULT_METRICS } from './summarize.mjs';
import { fleet } from './fleet.mjs';

// Parse ?sessions=a,b,c -> array (or null = all).
function sessionsParam(url) {
  const q = (url.split('?')[1] || '').split('&').find((p) => p.startsWith('sessions='));
  if (!q) return null;
  const v = decodeURIComponent(q.slice('sessions='.length)).trim();
  return v ? v.split(',').filter(Boolean) : null;
}

const PORT = Number(process.env.PORT || 4319);
const HOST = process.env.HOST || '127.0.0.1';
const METRICS = process.env.OTEL_METRICS || DEFAULT_METRICS;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SkyCruncher Telemetry</title>
<style>
  :root{color-scheme:light dark}
  body{font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:0;
    background:#0b0e14;color:#c8d0e0}
  header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid #1c2333}
  h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.02em}
  .dot{width:9px;height:9px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950}
  .dot.stale{background:#d29922;box-shadow:0 0 8px #d29922}
  .dot.dead{background:#f85149;box-shadow:0 0 8px #f85149}
  .sub{color:#5b6577;font-size:12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:20px}
  .card{background:#111725;border:1px solid #1c2333;border-radius:8px;padding:14px 16px}
  .card .lbl{color:#5b6577;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .card .val{font-size:26px;font-weight:600;margin-top:4px;color:#e6edf3}
  .card .val.cost{color:#58a6ff}
  section{padding:0 20px 20px}
  h2{font-size:12px;color:#5b6577;text-transform:uppercase;letter-spacing:.05em;margin:18px 0 8px}
  .bar{display:flex;align-items:center;gap:10px;margin:4px 0}
  .bar .name{width:150px;color:#8b98b0}
  .bar .track{flex:1;height:16px;background:#161b28;border-radius:4px;overflow:hidden}
  .bar .fill{height:100%;background:linear-gradient(90deg,#1f6feb,#58a6ff)}
  .bar .n{width:80px;text-align:right;color:#c8d0e0}
  .err{padding:20px;color:#f85149}
  footer{padding:12px 20px;color:#3d4759;font-size:11px;border-top:1px solid #1c2333}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;color:#5b6577;font-weight:500;padding:4px 8px;border-bottom:1px solid #1c2333;font-size:11px;text-transform:uppercase}
  td{padding:5px 8px;border-bottom:1px solid #141a26;vertical-align:top}
  .pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;background:#1c2333;color:#8b98b0}
  .pill.run{background:#123a1c;color:#3fb950}
  .run-dot{color:#3fb950}
  .over{color:#d29922}
  .tgt{color:#5b6577;font-size:11px}
  .res{color:#6b7688;font-size:11px}
  .split{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 2px}
  .split .s{background:#111725;border:1px solid #1c2333;border-radius:6px;padding:6px 12px;font-size:12px}
  .split .s b{color:#e6edf3;font-size:15px;display:block}
  .stale-note{color:#d29922;font-size:11px;margin-left:6px}
  #sessions{padding:12px 20px;border-bottom:1px solid #1c2333;background:#0d1119}
  .sbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .sbtn{cursor:pointer;background:#1c2333;border:1px solid #263041;color:#8b98b0;
    border-radius:5px;padding:2px 9px;font:inherit;font-size:11px}
  .sbtn:hover{color:#e6edf3;border-color:#3d4759}
  .slist{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .sitem{display:flex;align-items:center;gap:6px;background:#111725;border:1px solid #1c2333;
    border-radius:6px;padding:4px 9px;font-size:11.5px;cursor:pointer;user-select:none}
  .sitem.cur{border-color:#1f6feb}
  .sitem input{accent-color:#1f6feb;cursor:pointer}
  .sitem .sid{color:#c8d0e0;font-weight:600}
  .sitem .smeta{color:#5b6577}
  .sitem .curbadge{color:#58a6ff;font-size:10px}
  .cal .name{width:140px;color:#8b98b0}
  .cal .fill.warm{background:linear-gradient(90deg,#9e6a1f,#d29922)}
  .mdl{color:#7a86a0;font-size:11px}
</style></head><body>
<header><span class="dot" id="dot"></span><h1>SkyCruncher · Telemetry</h1>
  <span class="sub" id="upd">connecting…</span></header>
<div id="sessions"></div>
<div id="root"></div>
<section id="fleet"></section>
<footer>polls <code id="src"></code> every 2s · DELTA counters summed · fleet from agent_runs.jsonl + OTel · Ctrl-C to stop</footer>
<script>
const k=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(Math.round(n));
function bars(obj,fmt){
  const f=fmt||k;
  const ents=Object.entries(obj).sort((a,b)=>b[1]-a[1]); if(!ents.length)return '<div class="sub">none</div>';
  const max=Math.max(...ents.map(e=>e[1]))||1;
  return ents.map(([n,v])=>\`<div class="bar"><span class="name">\${n.replace('claude-','')}</span>
    <span class="track"><span class="fill" style="width:\${Math.max(2,100*v/max)}%"></span></span>
    <span class="n">\${f(v)}</span></div>\`).join('');
}
const mmss=s=>s==null?'—':Math.floor(s/60)+'m'+String(s%60).padStart(2,'0')+'s';
const mdl=m=>(m||'').replace('claude-','');
const esc=t=>(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
function ftok(t){return k(t.input+t.output+t.cacheRead+t.cacheCreation);}
const fmtDate=ms=>{if(!ms)return '—';const d=new Date(ms);const p=n=>String(n).padStart(2,'0');
  return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());};

// ---- session selection state ----
let SEL=null;           // Set of selected session ids (null until first /sessions load)
let SESS=[];            // last session list
function sessQuery(){   // '' = all; '__none__' matches nothing
  if(SEL===null)return '';
  if(SEL.size===0)return '?sessions=__none__';
  if(SEL.size===SESS.length)return '';           // all selected -> unfiltered
  return '?sessions='+encodeURIComponent([...SEL].join(','));
}
function refreshAll(){renderSessions();tick();fleetTick();}
window.togSess=id=>{SEL.has(id)?SEL.delete(id):SEL.add(id);refreshAll();};
window.selAll=()=>{SEL=new Set(SESS.map(s=>s.id));refreshAll();};
window.selNone=()=>{SEL=new Set();refreshAll();};
window.selCur=()=>{const c=SESS.find(s=>s.isCurrent);SEL=new Set(c?[c.id]:[]);refreshAll();};

async function renderSessions(){
  let list; try{ list=await (await fetch('/sessions')).json(); }catch(e){ return; }
  if(!Array.isArray(list))return;
  SESS=list;
  if(SEL===null)SEL=new Set(list.map(s=>s.id));   // default: all selected
  const items=list.map(s=>{
    const on=SEL.has(s.id);
    return \`<label class="sitem\${s.isCurrent?' cur':''}" onclick="togSess('\${s.id}');event.preventDefault()">
      <input type="checkbox" \${on?'checked':''}>
      <span class="sid">\${s.short}</span>
      <span class="smeta">\${fmtDate(s.startMs)} · \${k(s.tokens)}tok · $\${s.cost.toFixed(2)} · \${s.agents}a</span>
      \${s.isCurrent?'<span class="curbadge">● current</span>':''}</label>\`;
  }).join('');
  document.getElementById('sessions').innerHTML=
    \`<div class="sbar"><b class="sub" style="color:#8b98b0">SESSIONS (\${SEL.size}/\${list.length})</b>
       <button class="sbtn" onclick="selAll()">all</button>
       <button class="sbtn" onclick="selNone()">none</button>
       <button class="sbtn" onclick="selCur()">current only</button></div>
     <div class="slist">\${items}</div>\`;
}

async function tick(){
  let s; try{ s=await (await fetch('/data'+sessQuery())).json(); }catch(e){
    document.getElementById('dot').className='dot dead';
    document.getElementById('upd').textContent='server unreachable'; return; }
  document.getElementById('src').textContent=s.metricsPath||'';
  if(!s.ok){ document.getElementById('root').innerHTML='<div class="err">'+s.error+'</div>';
    document.getElementById('dot').className='dot dead'; return; }
  const age=s.updatedUnixMs?(Date.now()-s.updatedUnixMs)/1000:Infinity;
  document.getElementById('dot').className='dot'+(age<20?'':age<120?' stale':' dead');
  document.getElementById('upd').textContent=
    (s.updatedUnixMs?'updated '+Math.round(age)+'s ago':'no timestamp')
    +' · '+s.sessions+' sessions in view · '+s.exportLines+' exports';
  const cache=(s.cacheHitRate*100).toFixed(1);
  document.getElementById('root').innerHTML=\`
    <div class="grid">
      <div class="card"><div class="lbl">cost</div><div class="val cost">$\${s.costUSD.toFixed(4)}</div></div>
      <div class="card"><div class="lbl">tokens</div><div class="val">\${k(s.totalTokens)}</div></div>
      <div class="card"><div class="lbl">cache-hit</div><div class="val">\${cache}%</div></div>
      <div class="card"><div class="lbl">burn rate</div><div class="val">\${k(s.burnTokPerMin)}<span style="font-size:13px;color:#5b6577">/min</span></div></div>
      <div class="card"><div class="lbl">edits</div><div class="val">\${s.editDecisions.accept}<span style="font-size:13px;color:#5b6577"> ✓ \${s.editDecisions.reject?' / '+s.editDecisions.reject+' ✗':''}</span></div></div>
      <div class="card"><div class="lbl">commits</div><div class="val">\${s.commits}</div></div>
      <div class="card"><div class="lbl">lines +/-</div><div class="val">+\${k(s.linesAdded)} <span style="color:#f85149">-\${k(s.linesRemoved)}</span></div></div>
      <div class="card"><div class="lbl">active</div><div class="val">\${Math.round(s.activeTimeSec)}s</div></div>
    </div>
    <section><h2>cost by model</h2>\${bars(s.costByModel,v=>'$'+v.toFixed(2))}
      <h2>tokens by model</h2>\${bars(s.tokensByModel)}
      <h2>tokens by type</h2>\${bars(s.tokensByType)}</section>\`;
}

async function fleetTick(){
  let f; try{ f=await (await fetch('/fleet'+sessQuery())).json(); }catch(e){ return; }
  if(!f.ok){ document.getElementById('fleet').innerHTML='<h2>agents</h2><div class="sub">'+f.error+'</div>'; return; }
  const stale=f.snapshotAgeSec!=null&&f.snapshotAgeSec>90;
  const run=f.running.map(r=>{
    const kind=r.kind==='subagent'?'<span class="pill run">'+r.agentType+'</span>':'<span class="pill">shell</span>';
    const model=r.model?'<span class="mdl"> '+mdl(r.model)+'</span>':(r.kind==='subagent'?'<span class="mdl"> model?</span>':'');
    const bud=r.estSec?(' <span class="'+(r.overBudget?'over':'sub')+'">/ ~'+mmss(r.estSec)+(r.overBudget?' ⚠':'')+'</span>'):'';
    const tgt=r.target&&r.target.length?'<div class="tgt">↳ '+esc(r.target.join('  '))+'</div>':'';
    return '<tr><td><span class="run-dot">●</span> '+kind+model+'</td><td>'+mmss(r.elapsedSec)+bud+'</td><td>'+esc(r.description)+tgt+'</td></tr>';
  }).join('')||'<tr><td colspan="3" class="sub">'+(f.rosterShown?'none running':'roster hidden (current session unselected)')+'</td></tr>';
  const comp=f.completed.map(c=>{
    const over=c.durationSec>c.estSec;
    return '<tr><td><span class="pill">'+c.agentType+'</span> <span class="mdl">'+mdl(c.model)+'</span></td>'
      +'<td class="'+(over?'over':'')+'">'+mmss(c.durationSec)+' / '+mmss(c.estSec)+(over?' ⚠':'')+'</td>'
      +'<td>'+c.turns+'t · '+ftok(c.tokens)+'tok'+(c.effort?' · '+c.effort:'')+'</td>'
      +'<td class="res">'+esc(c.result)+'</td></tr>';
  }).join('')||'<tr><td colspan="4" class="sub">none yet</td></tr>';
  const cal=f.calibration.map(c=>{
    const warm=Math.abs(c.deltaPct)>50;
    const w=Math.min(100,Math.max(4,100*c.avgSec/(c.estSec||1)));
    return '<div class="bar cal"><span class="name">'+c.type+' <span class="mdl">n='+c.n+'</span></span>'
      +'<span class="track"><span class="fill'+(warm?' warm':'')+'" style="width:'+w+'%"></span></span>'
      +'<span class="n">'+mmss(c.avgSec)+' <span class="mdl">'+(c.deltaPct>0?'+':'')+c.deltaPct+'%</span></span></div>';
  }).join('')||'<div class="sub">no completed runs in view</div>';
  const sp=f.spend;
  document.getElementById('fleet').innerHTML=
    '<h2>agents · running ('+f.runningCount+')'
      +(stale?'<span class="stale-note">roster '+f.snapshotAgeSec+'s stale — updates when an agent stops</span>':'')+'</h2>'
    +'<table><tr><th>who</th><th>elapsed / budget</th><th>task &amp; target</th></tr>'+run+'</table>'
    +'<h2>live spend by source</h2><div class="split">'
      +'<div class="s">main<b>'+k(sp.main.tokens)+' · $'+sp.main.cost.toFixed(2)+'</b></div>'
      +'<div class="s">subagent<b>'+k(sp.subagent.tokens)+' · $'+sp.subagent.cost.toFixed(2)+'</b></div>'
      +'<div class="s">auxiliary<b>'+k(sp.auxiliary.tokens)+' · $'+sp.auxiliary.cost.toFixed(2)+'</b></div></div>'
    +'<h2>calibration · actual vs ~estimate (bar full = at budget)</h2>'+cal
    +'<h2>completed in view ('+f.completed.length+')</h2>'
    +'<table><tr><th>type · model</th><th>time / budget</th><th>spend</th><th>result</th></tr>'+comp+'</table>';
}
renderSessions(); tick(); fleetTick();
setInterval(tick,2000); setInterval(fleetTick,2000); setInterval(renderSessions,6000);
</script></body></html>`;

const server = createServer((req, res) => {
  const json = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  if (req.url && req.url.startsWith('/sessions')) {
    try { json(listSessions(METRICS)); } catch (e) { json({ ok: false, error: String(e) }); }
    return;
  }
  if (req.url && req.url.startsWith('/data')) {
    try { json(summarize(METRICS, sessionsParam(req.url))); } catch (e) { json({ ok: false, error: String(e) }); }
    return;
  }
  if (req.url && req.url.startsWith('/fleet')) {
    try { json(fleet(undefined, METRICS, sessionsParam(req.url))); }
    catch (e) { json({ ok: false, error: String(e && e.message || e) }); }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

server.listen(PORT, HOST, () => {
  console.log(`SkyCruncher telemetry dashboard -> http://${HOST}:${PORT}`);
  console.log(`  reading ${METRICS}`);
  console.log('  Ctrl-C to stop');
});
