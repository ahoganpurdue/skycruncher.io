#!/usr/bin/env node
// tools/packet/build_packet.mjs
// -----------------------------------------------------------------------------
// Per-frame "processing packet" generator.
//
// Reads a JSON manifest describing a set of sections and emits ONE fully
// self-contained .html file: every image / JSON / HTML asset is inlined as a
// data URI, so the packet makes zero external network requests and can be
// opened, e-mailed, or archived as a single file.
//
// Presentation contract (hard rules, enforced here):
//   * Dark astronomy theme.
//   * Every panel states its provenance.
//   * NO internal file paths are ever visible in the rendered page. The machine
//     manifest is embedded in a hidden <script type="application/json"> block
//     (paths permitted there only). All visible text is path-redacted.
//   * A missing/absent artifact renders an HONEST empty slot
//     (NOT RUN / NOT MEASURED / IN PROGRESS) -- never fabricated content.
//
// Manifest shape (either form accepted):
//   A) a bare array of section objects, or
//   B) { title?, subtitle?, frame?, ethos?, sections: [ ... ] }
//
// Section object fields (all optional except a way to render something):
//   { section, title, status, caption, provenance,
//     artifact_path,                 // single asset (image | .json | .html)
//     images: [{ path, label }],     // gallery / before-after row
//     html,                          // inline HTML fragment (path-redacted)
//     text }                         // inline plain text
//
// Render precedence per section: images[] -> artifact_path -> html -> text ->
// honest-empty slot. If artifact_path is given but the file is absent, the slot
// degrades honestly using `status` (default "NOT RUN").
//
// Usage:
//   node tools/packet/build_packet.mjs --manifest <m.json> --out <out.html> \
//        [--copy <also.html> ...] [--title "..."]
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

// ---- CLI -------------------------------------------------------------------
function parseArgs(argv) {
  const out = { copy: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--copy') out.copy.push(argv[++i]);
    else if (a === '--title') out.title = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

// ---- utilities -------------------------------------------------------------
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.html': 'text/html', '.htm': 'text/html',
  '.json': 'application/json',
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Redact anything that looks like an absolute local path from VISIBLE text.
// Windows drive paths (D:\..., K:/...), UNC (\\host\...), and long POSIX paths.
function redactPaths(s) {
  if (s == null) return s;
  return String(s)
    .replace(/[A-Za-z]:[\\/][^\s"'<>|)]*/g, '‹local artifact›')
    .replace(/\\\\[^\s"'<>|)]+/g, '‹local artifact›')
    .replace(/(?:\/[\w.\- ]+){3,}\/[\w.\- ]+/g, '‹local artifact›');
}

function dataUri(path) {
  const ext = extname(path).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const b64 = readFileSync(path).toString('base64');
  return `data:${mime};base64,${b64}`;
}

function fileBytes(path) {
  try { return statSync(path).size; } catch { return 0; }
}

// ---- badge styling ---------------------------------------------------------
function badgeClass(status) {
  const s = String(status || '').toUpperCase();
  if (/NOT RUN|NOT MEASURED|ABSENT|MISSING|SKIP/.test(s)) return 'badge-empty';
  if (/IN PROGRESS|PENDING|RUNNING/.test(s)) return 'badge-progress';
  if (/REFUS|COVERAGE-LIMITED|NOT USABLE/.test(s)) return 'badge-progress';
  if (/APPROX/.test(s)) return 'badge-approx';
  return 'badge-ok';
}
function isEmptyStatus(status) {
  return /NOT RUN|NOT MEASURED|ABSENT|MISSING|SKIP/i.test(String(status || ''));
}

// ---- per-section renderer --------------------------------------------------
function renderSection(sec, idx) {
  const title = esc(redactPaths(sec.title || sec.section || `Section ${idx + 1}`));
  const status = sec.status || 'RUN';
  const badge = `<span class="badge ${badgeClass(status)}">${esc(status)}</span>`;
  const caption = sec.caption ? `<p class="caption">${esc(redactPaths(sec.caption))}</p>` : '';
  const provText = sec.provenance || 'Provenance not recorded';
  const prov = `<div class="prov"><span class="prov-k">Provenance</span> ${esc(redactPaths(provText))}</div>`;

  let body = '';
  let emptied = false;

  // 1) image gallery / before-after row
  if (Array.isArray(sec.images) && sec.images.length) {
    const cells = sec.images.map((im) => {
      if (im.path && existsSync(im.path) && IMAGE_EXT.has(extname(im.path).toLowerCase())) {
        return `<figure class="gcell"><img loading="lazy" src="${dataUri(im.path)}" alt="${esc(im.label || '')}"/>`
             + `<figcaption>${esc(redactPaths(im.label || ''))}</figcaption></figure>`;
      }
      return `<figure class="gcell gcell-empty"><div class="empty-mini">artifact not produced</div>`
           + `<figcaption>${esc(redactPaths(im.label || ''))}</figcaption></figure>`;
    }).join('');
    body = `<div class="gallery">${cells}</div>`;
  }
  // 2) single artifact by extension
  else if (sec.artifact_path && existsSync(sec.artifact_path)) {
    const ext = extname(sec.artifact_path).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      body = `<figure class="single"><img loading="lazy" src="${dataUri(sec.artifact_path)}" alt="${title}"/></figure>`;
    } else if (ext === '.html' || ext === '.htm') {
      // srcdoc, not a data: URI — Chromium blocks iframe navigation to URLs
      // over ~2MB (about:blank#blocked), which silently killed large inline
      // embeds. Attribute content has no such cap.
      const rawHtml = readFileSync(sec.artifact_path, 'utf8')
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      body = `<div class="frame-wrap"><iframe class="embed" loading="lazy" `
           + `sandbox="allow-scripts allow-same-origin allow-popups allow-pointer-lock" `
           + `srcdoc="${rawHtml}"></iframe></div>`
           + `<div class="frame-note">Interactive embed &mdash; drag / scroll to explore. Rendered entirely inline; no external requests.</div>`;
    } else if (ext === '.json') {
      let pretty = '';
      try { pretty = JSON.stringify(JSON.parse(readFileSync(sec.artifact_path, 'utf8')), null, 2); }
      catch { pretty = readFileSync(sec.artifact_path, 'utf8'); }
      body = `<pre class="jsonblock">${esc(redactPaths(pretty))}</pre>`;
    } else {
      body = `<pre class="jsonblock">${esc(redactPaths(readFileSync(sec.artifact_path, 'utf8').slice(0, 20000)))}</pre>`;
    }
  }
  // 3) inline HTML fragment
  else if (sec.html) {
    body = `<div class="fragment">${redactPaths(sec.html)}</div>`;
  }
  // 4) inline text
  else if (sec.text) {
    body = `<pre class="jsonblock">${esc(redactPaths(sec.text))}</pre>`;
  }

  // 5) honest-empty slot (no renderable content, or an explicitly empty status)
  if (!body || isEmptyStatus(status)) {
    if (!body) {
      emptied = true;
      const label = isEmptyStatus(status) ? esc(status) : 'NOT RUN';
      body = `<div class="empty-slot">`
           + `<div class="empty-badge">${label}</div>`
           + `<p>This stage did not produce an artifact for this frame. `
           + `The slot is shown empty on purpose &mdash; the instrument reports absence rather than inventing a result.</p>`
           + `</div>`;
    }
  }

  return `
  <section class="panel${emptied ? ' panel-empty' : ''}" id="sec-${idx}">
    <div class="panel-head">
      <h2>${title}</h2>
      ${badge}
    </div>
    ${caption}
    ${body}
    ${prov}
  </section>`;
}

// ---- page assembly ---------------------------------------------------------
function buildHtml(manifest, sections) {
  const title = manifest.title || 'Frame Processing Packet';
  const subtitle = manifest.subtitle || '';
  // Optional composite header status chip:
  //   manifest.status_chip = { parts: [{ text, kind: ok|progress|approx|empty }], note }
  const KIND_CLASS = { ok: 'badge-ok', progress: 'badge-progress', approx: 'badge-approx', empty: 'badge-empty' };
  const chip = manifest.status_chip;
  const chipHtml = (chip && Array.isArray(chip.parts) && chip.parts.length)
    ? `<div class="chips">`
      + chip.parts.map((p) => `<span class="badge ${KIND_CLASS[p.kind] || badgeClass(p.text)}">${esc(redactPaths(p.text))}</span>`).join('')
      + `</div>`
      + (chip.note ? `<div class="chip-note">${esc(redactPaths(chip.note))}</div>` : '')
    : '';
  const ethos = manifest.ethos
    || 'Evidence-only instrument report. Approximations are labeled APPROXIMATE; unmeasured quantities are labeled NOT MEASURED. Nothing on this page is invented.';
  const gen = new Date().toISOString().replace('T', ' ').replace(/\..*/, ' UTC');

  const nav = sections.map((s, i) =>
    `<a href="#sec-${i}">${esc(redactPaths(s.title || s.section || ('Section ' + (i + 1))))}</a>`
  ).join('');

  const panels = sections.map(renderSection).join('\n');

  // hidden machine manifest (paths permitted here only; never rendered)
  const hidden = `<script type="application/json" id="packet-manifest">`
    + JSON.stringify(manifest).replace(/</g, '\\u003c') + `</script>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(redactPaths(title))}</title>
<style>
  :root{
    --bg:#070a12; --bg2:#0c111d; --panel:#0f1524; --panel2:#131b2e;
    --edge:#1e2a44; --edge2:#2a3a5c; --ink:#e8eefc; --muted:#8ea0c4;
    --dim:#5f6f92; --accent:#6ea8ff; --accent2:#9b7bff; --good:#4fd39a;
    --warn:#ffcf5c; --empty:#7d8aa8; --star:#cfe0ff;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:
      radial-gradient(1200px 600px at 78% -8%, rgba(110,168,255,.10), transparent 60%),
      radial-gradient(900px 500px at 8% 4%, rgba(155,123,255,.08), transparent 55%),
      var(--bg);
    color:var(--ink);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .stars{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.5;
    background-image:
      radial-gradient(1px 1px at 20% 30%, #fff, transparent),
      radial-gradient(1px 1px at 70% 60%, #cfe0ff, transparent),
      radial-gradient(1px 1px at 40% 80%, #fff, transparent),
      radial-gradient(1px 1px at 85% 22%, #bcd, transparent),
      radial-gradient(1px 1px at 55% 15%, #fff, transparent),
      radial-gradient(1px 1px at 12% 70%, #dde, transparent);
    background-repeat:repeat;background-size:520px 520px;}
  .wrap{position:relative;z-index:1;max-width:1080px;margin:0 auto;padding:34px 22px 90px}
  header.hd{
    border:1px solid var(--edge);border-radius:16px;
    background:linear-gradient(180deg,var(--panel2),var(--panel));
    padding:26px 28px;margin-bottom:22px;
    box-shadow:0 20px 60px rgba(0,0,0,.35);
  }
  .kicker{letter-spacing:.28em;text-transform:uppercase;color:var(--accent);
    font-size:11px;font-weight:600;margin-bottom:10px}
  header.hd h1{margin:0 0 6px;font-size:30px;font-weight:700;letter-spacing:-.01em}
  header.hd .sub{color:var(--muted);font-size:15px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;align-items:center}
  .chips .badge{font-size:11.5px;text-transform:none;letter-spacing:.02em}
  .chip-note{color:var(--muted);font-size:12.5px;margin-top:8px;max-width:88ch}
  .meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:16px;
    color:var(--dim);font-size:12px}
  .meta b{color:var(--muted);font-weight:600}
  .ethos{margin-top:16px;padding:12px 14px;border-left:3px solid var(--accent2);
    background:rgba(155,123,255,.06);border-radius:0 8px 8px 0;
    color:var(--muted);font-size:13px}
  nav.toc{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 26px}
  nav.toc a{color:var(--star);text-decoration:none;font-size:12.5px;
    border:1px solid var(--edge);border-radius:999px;padding:5px 12px;
    background:var(--panel);transition:.15s}
  nav.toc a:hover{border-color:var(--accent);color:#fff;background:var(--panel2)}
  .panel{border:1px solid var(--edge);border-radius:14px;background:var(--panel);
    padding:20px 22px;margin:0 0 20px;box-shadow:0 8px 30px rgba(0,0,0,.25)}
  .panel-empty{border-style:dashed;background:var(--bg2)}
  .panel-head{display:flex;align-items:center;justify-content:space-between;gap:14px;
    margin-bottom:8px}
  .panel-head h2{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em}
  .badge{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
    padding:4px 10px;border-radius:999px;white-space:nowrap}
  .badge-ok{background:rgba(79,211,154,.14);color:var(--good);border:1px solid rgba(79,211,154,.35)}
  .badge-progress{background:rgba(255,207,92,.13);color:var(--warn);border:1px solid rgba(255,207,92,.35)}
  .badge-approx{background:rgba(110,168,255,.13);color:var(--accent);border:1px solid rgba(110,168,255,.35)}
  .badge-empty{background:rgba(125,138,168,.12);color:var(--empty);border:1px solid rgba(125,138,168,.3)}
  .caption{color:var(--muted);margin:2px 0 16px;font-size:14px}
  .single img,.gcell img{display:block;width:100%;height:auto;border-radius:10px;
    border:1px solid var(--edge2);background:#000}
  .gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
  .gcell{margin:0}
  .gcell figcaption,.single figcaption{margin-top:8px;color:var(--dim);font-size:12px;text-align:center}
  .gcell-empty{display:flex;flex-direction:column}
  .empty-mini{border:1px dashed var(--edge2);border-radius:10px;padding:38px 10px;
    text-align:center;color:var(--empty);font-size:12px;background:var(--bg2)}
  .frame-wrap{border:1px solid var(--edge2);border-radius:10px;overflow:hidden;background:#000}
  iframe.embed{display:block;width:100%;height:560px;border:0;background:#05070d}
  .frame-note{margin-top:8px;color:var(--dim);font-size:12px}
  .jsonblock{background:#05070d;border:1px solid var(--edge);border-radius:10px;
    padding:14px 16px;overflow-x:auto;color:#cbd7f5;font:12.5px/1.55 ui-monospace,
    SFMono-Regular,Menlo,Consolas,monospace;max-height:520px}
  .fragment{color:var(--ink)}
  .empty-slot{border:1px dashed var(--edge2);border-radius:12px;padding:26px 22px;
    text-align:center;background:var(--bg2)}
  .empty-badge{display:inline-block;font-weight:700;letter-spacing:.1em;
    color:var(--empty);border:1px solid var(--edge2);border-radius:999px;
    padding:5px 14px;margin-bottom:10px;font-size:12px}
  .empty-slot p{color:var(--muted);margin:0;max-width:56ch;margin-inline:auto;font-size:13.5px}
  .prov{margin-top:16px;padding-top:12px;border-top:1px solid var(--edge);
    color:var(--dim);font-size:12px}
  .prov-k{color:var(--muted);font-weight:600;letter-spacing:.04em;
    text-transform:uppercase;font-size:10.5px;margin-right:6px}
  /* fragment helpers (detection-chain visual etc.) */
  .chain{display:flex;flex-wrap:wrap;align-items:stretch;gap:10px;margin:6px 0 4px}
  .chain .node{flex:1 1 160px;border:1px solid var(--edge2);border-radius:10px;
    padding:12px 14px;background:linear-gradient(180deg,var(--panel2),var(--panel))}
  .chain .node .n{font-size:22px;font-weight:750;color:var(--star)}
  .chain .node .l{font-size:11.5px;color:var(--muted);margin-top:3px}
  .chain .node .s{font-size:11px;color:var(--dim);margin-top:6px}
  .chain .arrow{align-self:center;color:var(--accent);font-size:20px;flex:0 0 auto}
  .statline{color:var(--muted);font-size:13.5px;margin:14px 0 0}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:6px 18px;margin:2px 0 0}
  .kv dt{color:var(--muted);font-weight:600;font-size:12.5px}
  .kv dd{margin:0;color:var(--ink);font-size:13.5px}
  footer.ft{color:var(--dim);font-size:11.5px;text-align:center;margin-top:26px;
    padding-top:18px;border-top:1px solid var(--edge)}
  @media (max-width:640px){iframe.embed{height:420px}header.hd h1{font-size:24px}}
</style>
</head>
<body>
<div class="stars"></div>
<div class="wrap">
  <header class="hd">
    <div class="kicker">Processing Packet</div>
    <h1>${esc(redactPaths(title))}</h1>
    ${subtitle ? `<div class="sub">${esc(redactPaths(subtitle))}</div>` : ''}
    ${chipHtml}
    <div class="meta">
      ${(manifest.meta || []).map(m => `<span><b>${esc(m.k)}</b> ${esc(redactPaths(m.v))}</span>`).join('')}
      <span><b>Generated</b> ${esc(gen)}</span>
    </div>
    <div class="ethos">${esc(redactPaths(ethos))}</div>
  </header>
  <nav class="toc">${nav}</nav>
  ${panels}
  <footer class="ft">Self-contained instrument report &middot; all assets inlined &middot; no external requests</footer>
</div>
${hidden}
</body>
</html>`;
}

// ---- main ------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.manifest || !args.out) {
    console.log('Usage: node tools/packet/build_packet.mjs --manifest <m.json> --out <out.html> [--copy <also.html> ...] [--title "..."]');
    process.exit(args.help ? 0 : 1);
  }
  const manifestPath = resolve(args.manifest);
  if (!existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifest = Array.isArray(raw) ? { sections: raw } : raw;
  if (args.title) manifest.title = args.title;
  const sections = manifest.sections || [];
  if (!Array.isArray(sections) || !sections.length) {
    console.error('Manifest has no sections.');
    process.exit(1);
  }

  const html = buildHtml(manifest, sections);

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf8');
  const copies = [];
  for (const c of args.copy) {
    const cp = resolve(c);
    mkdirSync(dirname(cp), { recursive: true });
    copyFileSync(outPath, cp);
    copies.push(cp);
  }

  // honest build report (stdout only; never inside the page)
  const bytes = fileBytes(outPath);
  const built = sections.filter(s =>
    (Array.isArray(s.images) && s.images.some(im => im.path && existsSync(im.path)))
    || (s.artifact_path && existsSync(s.artifact_path))
    || s.html || s.text
  ).length;
  const empty = sections.length - built;
  console.log(JSON.stringify({
    ok: true,
    out: outPath,
    copies,
    bytes,
    mb: +(bytes / 1048576).toFixed(2),
    sections_total: sections.length,
    sections_built: built,
    sections_honest_empty: empty,
  }, null, 2));
}

main();
