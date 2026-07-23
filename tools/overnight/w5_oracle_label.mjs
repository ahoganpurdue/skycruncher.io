#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// W5 ORACLE-LABEL DRIVER — astrometry.net truth labels for the W5 frame set
// ═══════════════════════════════════════════════════════════════════════════
// Depth-matched arm (owner directive): labels each frame with the LITE/4100 index
// set (astrometry_lite.cfg = 4100 broad-all-sky + REPAIRED lite5200 scales 2-6).
// The corrupt heavy5200 is NEVER consulted (single-pass, no LITE→HEAVY escalation).
//
// Per frame:  decode (isolated child w5_decode_frame.mjs) → solver input
//               CR2 → 16-bit PGM → an-pnmtofits → FITS   (Canon 60Da / 5D3)
//               RAF → embedded preview JPEG               (Fuji X-Trans)
//             → solve-field (WSL) → .wcs → wcsinfo → truth-label JSON.
// Field center = wcsinfo ra_center/dec_center = pix2sky(IMAGEW/2,IMAGEH/2), NOT
// raw CRVAL (wide fields diverge). Scale = wcsinfo pixscale. Records the winning
// index + log-odds + matches + input form + scale-hint provenance.
//
// Writes ONLY under --out (default D:/AstroLogic/test_artifacts/w5_oracle_labels_2026-07-18):
//   <base>.wcs   <base>.label.json   <base>.solvelog.txt   LABELS.md
// Resumable: skips a frame whose <base>.label.json already exists (--force to redo).
//
//   node tools/overnight/w5_oracle_label.mjs --frames <file> [--out <dir>]
//        [--workers 2] [--cpulimit 200] [--downsample 2]
//        [--only cocoon|csm|raf] [--limit N] [--force]
//        [--scale-low L --scale-high H]   # override scale-hint band for this run
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECODE_CHILD = path.join(HERE, 'w5_decode_frame.mjs');
const WSL_DISTRO = 'Ubuntu-24.04';
const CFG = '/mnt/d/astrometry_indexes/astrometry_lite.cfg';
const CFG_DESC = 'astrometry_lite.cfg (4100 broad-all-sky + repaired lite5200 scales 2-6; heavy5200 NOT consulted)';

// class → known scale-hint band (arcsec/px). Cocoon scale is KNOWN from prior
// same-rig sibling solves (truth_seeding_2026-07-17: 2.0066"/px); a hint only
// ACCELERATES — solve-field's quad-hash verify stays the sole arbiter.
const CLASS_SCALE = { cocoon: [1.6, 2.5], csm: null, raf: null };
const RIG = {
  cocoon: 'Canon EOS 60D (60Da mod; Cocoon/IC5146 vignetting rig)',
  csm: 'Canon EOS 5D Mark III (Kalahari smattering)',
  raf: 'FUJIFILM X-Trans (contributed UW set)',
};

function parseArgs(argv) {
  const a = { _: [] };
  const flags = new Set(['force']);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { const k = t.slice(2); if (flags.has(k)) a[k] = true; else a[k] = argv[++i]; }
    else a._.push(t);
  }
  return a;
}
function toWsl(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p.replace(/\\/g, '/');
}
function classify(frame) {
  const b = path.basename(frame);
  if (/\.raf$/i.test(b)) return 'raf';
  if (/^CSM/i.test(b)) return 'csm';
  if (/^L_0/i.test(b)) return 'cocoon';
  return 'other';
}
function sha256(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } }

/** async spawn → { code, stdout, stderr } (never rejects; timeout kills the tree). */
function run(cmd, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    let timer = null, killed = false;
    if (timeoutMs > 0) timer = setTimeout(() => { killed = true; try { ch.kill('SIGKILL'); } catch {} }, timeoutMs);
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e), killed }); });
    ch.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout: out, stderr: err, killed }); });
  });
}
const wsl = (args, opts) => run('wsl', ['-d', WSL_DISTRO, '-e', ...args], opts);

function parseWcsinfo(txt) {
  const g = (k) => { const m = txt.match(new RegExp(`^${k}\\s+([-\\d.eE+]+)`, 'm')); return m ? Number(m[1]) : null; };
  return {
    ra_center: g('ra_center'), dec_center: g('dec_center'), pixscale: g('pixscale'),
    orientation: g('orientation'), parity: g('parity'),
    fieldw: g('fieldw'), fieldh: g('fieldh'), imagew: g('imagew'), imageh: g('imageh'),
  };
}
function parseSolvelog(txt) {
  const idx = txt.match(/solved with index (index-[\d-]+\.fits)/i);
  const lo = txt.match(/log-odds ratio ([\d.eE+]+).*?, (\d+) match(?:es)?, (\d+) conflict/i);
  return { index: idx ? idx[1] : null, log_odds: lo ? Number(lo[1]) : null,
           matches: lo ? Number(lo[2]) : null, conflicts: lo ? Number(lo[3]) : null };
}

async function processFrame(frame, opts) {
  const base = path.basename(frame).replace(/\.[^.]+$/, '');
  const cls = classify(frame);
  const labelPath = path.join(opts.out, `${base}.label.json`);
  if (!opts.force && fs.existsSync(labelPath)) {
    const prev = JSON.parse(fs.readFileSync(labelPath, 'utf8'));
    return { base, cls, skipped: true, solved: !!prev.solved, elapsed_s: prev.elapsed_s ?? 0,
             pixscale: prev.pixel_scale_arcsec, ra_h: prev.ra_hours, dec: prev.dec_degrees, index: prev.solved_with_index };
  }
  const started = Date.now();
  const tmp = path.join(opts.out, '_tmp');
  const tmpBase = path.join(tmp, base);
  fs.mkdirSync(tmp, { recursive: true });

  // scale band: CLI override > class-known > blind
  let band = null;
  if (opts.scaleLow != null && opts.scaleHigh != null) band = [opts.scaleLow, opts.scaleHigh];
  else if (CLASS_SCALE[cls]) band = CLASS_SCALE[cls];
  const scaleHint = band ? { used: true, source: (opts.scaleLow != null ? 'cli-override' : 'known-same-rig'), low: band[0], high: band[1], units: 'arcsecperpix' }
                         : { used: false };

  const cleanup = () => { for (const ext of ['.pgm', '.fits', '.jpg']) { try { fs.rmSync(`${tmpBase}${ext}`, { force: true }); } catch {} }
                          try { fs.rmSync(path.join(tmp, `work_${base}`), { recursive: true, force: true }); } catch {} };

  // ── 1. decode (isolated child) ──────────────────────────────────────────
  const dec = await run(process.execPath, [DECODE_CHILD, frame, tmpBase], { timeoutMs: 300000 });
  const okm = dec.stdout.match(/OK (pgm|jpg) (\d+) (\d+)/);
  if (dec.code !== 0 || !okm) {
    const note = `decode failed: ${(dec.stderr || dec.stdout).trim().split('\n').pop()}`;
    cleanup();
    return writeResult(frame, base, cls, opts, { solved: false, error: 'DECODE', note, scaleHint, elapsed_s: (Date.now() - started) / 1000 });
  }
  const inputKind = okm[1]; // 'pgm' → CR2 fits ; 'jpg' → RAF preview
  const decW = Number(okm[2]), decH = Number(okm[3]);

  // ── 2. solver input ─────────────────────────────────────────────────────
  let solveInputWin;
  let inputForm;
  if (inputKind === 'pgm') {
    const pgmWsl = toWsl(`${tmpBase}.pgm`), fitsWsl = toWsl(`${tmpBase}.fits`);
    const conv = await wsl(['an-pnmtofits', pgmWsl, fitsWsl], { timeoutMs: 120000 });
    if (conv.code !== 0 || !fs.existsSync(`${tmpBase}.fits`)) {
      cleanup();
      return writeResult(frame, base, cls, opts, { solved: false, error: 'PNM2FITS', note: (conv.stderr || '').trim().slice(0, 200), scaleHint, elapsed_s: (Date.now() - started) / 1000 });
    }
    solveInputWin = `${tmpBase}.fits`;
    inputForm = `decoded-fits (CR2 → native-res luminance PGM ${decW}x${decH} → an-pnmtofits)`;
  } else {
    solveInputWin = `${tmpBase}.jpg`;
    inputForm = `embedded-jpeg (RAF preview ${decW}x${decH})`;
  }

  // ── 3. solve-field (WSL, LITE cfg, single-pass, no heavy) ────────────────
  const wcsWin = `${tmpBase}.wcs`;
  const workWin = path.join(tmp, `work_${base}`);
  fs.mkdirSync(workWin, { recursive: true });
  const sfArgs = ['solve-field', toWsl(solveInputWin), '--overwrite', '--no-plots',
    '--dir', toWsl(workWin), '--wcs', toWsl(wcsWin),
    '--new-fits', 'none', '--corr', 'none', '--rdls', 'none', '--match', 'none', '--index-xyls', 'none',
    '--downsample', String(opts.downsample), '--cpulimit', String(opts.cpulimit), '--config', CFG];
  if (band) sfArgs.push('--scale-units', 'arcsecperpix', '--scale-low', String(band[0]), '--scale-high', String(band[1]));
  const sf = await wsl(sfArgs, { timeoutMs: opts.cpulimit * 1000 + 90000 });
  const solvelog = sf.stdout + '\n----STDERR----\n' + sf.stderr;
  fs.writeFileSync(path.join(opts.out, `${base}.solvelog.txt`), solvelog);
  const elapsed_s = (Date.now() - started) / 1000;

  if (!fs.existsSync(wcsWin)) {
    cleanup();
    return writeResult(frame, base, cls, opts, { solved: false, error: sf.killed ? 'TIMEOUT' : 'NO_SOLVE',
      note: 'solve-field produced no .wcs at LITE depth', inputForm, scaleHint, elapsed_s });
  }

  // ── 4. wcsinfo → field center + geometry ────────────────────────────────
  const wi = await wsl(['wcsinfo', toWsl(wcsWin)], { timeoutMs: 60000 });
  const info = parseWcsinfo(wi.stdout);
  const slog = parseSolvelog(sf.stdout);
  // bank the .wcs
  fs.copyFileSync(wcsWin, path.join(opts.out, `${base}.wcs`));
  cleanup();

  if (info.ra_center == null || info.dec_center == null) {
    return writeResult(frame, base, cls, opts, { solved: false, error: 'WCSINFO', note: 'wcs written but wcsinfo center missing', inputForm, scaleHint, elapsed_s, slog });
  }
  return writeResult(frame, base, cls, opts, {
    solved: true, inputForm, scaleHint, elapsed_s, slog, info,
    previewCaveat: inputKind === 'jpg'
      ? `solved the embedded JPEG preview at ${decW}x${decH}; pixel_scale is per-preview-pixel (NOT native sensor); field-center RA/Dec is resolution-independent`
      : undefined,
  });
}

function writeResult(frame, base, cls, opts, r) {
  const label = {
    frame_id: base, frame_path: frame, class: cls, rig: RIG[cls] || 'unknown',
    source: 'astrometry_net', oracle: `solve-field (WSL ${WSL_DISTRO})`,
    depth_arm: 'LITE/4100 (depth-matched)', cfg: CFG_DESC, cfg_path: CFG,
    input_form: r.inputForm || null, scale_hint: r.scaleHint,
    solved: !!r.solved, generated_at: new Date().toISOString(),
    content_sha256: sha256(frame),
  };
  if (r.solved) {
    Object.assign(label, {
      // FIELD CENTER (pix2sky of image midpoint), NOT raw CRVAL:
      ra_hours: r.info.ra_center / 15,
      dec_degrees: r.info.dec_center,
      ra_center_deg: r.info.ra_center,
      pixel_scale_arcsec: r.info.pixscale,
      rotation_deg: r.info.orientation,
      parity: r.info.parity,
      field_w_deg: r.info.fieldw, field_h_deg: r.info.fieldh,
      image_w: r.info.imagew, image_h: r.info.imageh,
      solved_with_index: r.slog?.index || null,
      log_odds: r.slog?.log_odds ?? null,
      matches: r.slog?.matches ?? null, conflicts: r.slog?.conflicts ?? null,
      elapsed_s: +r.elapsed_s.toFixed(1),
    });
    if (r.previewCaveat) label.preview_caveat = r.previewCaveat;
  } else {
    Object.assign(label, { error: r.error, note: r.note || null, elapsed_s: +(r.elapsed_s ?? 0).toFixed(1) });
  }
  fs.writeFileSync(path.join(opts.out, `${base}.label.json`), JSON.stringify(label, null, 2) + '\n');
  const tag = r.solved
    ? `SOLVED ${base} (${cls}) ${r.elapsed_s.toFixed(0)}s idx=${r.slog?.index} ra=${(r.info.ra_center / 15).toFixed(4)}h dec=${r.info.dec_center.toFixed(3)} scale=${r.info.pixscale?.toFixed(3)} m=${r.slog?.matches}`
    : `FAIL   ${base} (${cls}) ${r.error} ${((r.elapsed_s ?? 0)).toFixed(0)}s`;
  console.log(tag);
  return { base, cls, solved: !!r.solved, error: r.error, elapsed_s: r.elapsed_s ?? 0,
           pixscale: r.info?.pixscale, ra_h: r.solved ? r.info.ra_center / 15 : null, dec: r.info?.dec_center,
           index: r.slog?.index, matches: r.slog?.matches, inputForm: r.inputForm };
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const worker = async () => { for (;;) { const i = idx++; if (i >= items.length) break; results[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

function writeLabelsMd(out, rows) {
  const esc = (v) => (v == null ? '' : String(v));
  const lines = [
    '# W5 Oracle Labels — astrometry.net (LITE/4100 depth-matched arm)',
    '',
    `Generated ${new Date().toISOString()} · cfg = ${CFG_DESC}`,
    `Field center = wcsinfo ra_center/dec_center (pix2sky of image midpoint, NOT raw CRVAL).`,
    '',
    '| frame | class | solved | index | ra(h) | dec(deg) | scale("/px) | rot(deg) | par | matches | in | t(s) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${esc(r.base)} | ${esc(r.cls)} | ${r.solved ? 'YES' : 'NO(' + esc(r.error) + ')'} | ${esc(r.index)} | ${r.ra_h != null ? r.ra_h.toFixed(5) : ''} | ${r.dec != null ? r.dec.toFixed(4) : ''} | ${r.pixscale != null ? r.pixscale.toFixed(4) : ''} | ${r.rot != null ? r.rot.toFixed(2) : ''} | ${esc(r.parity)} | ${esc(r.matches)} | ${r.inputForm ? (r.inputForm.startsWith('embedded') ? 'jpg' : 'fits') : ''} | ${r.elapsed_s ? r.elapsed_s.toFixed(0) : ''} |`);
  }
  const byClass = {};
  for (const r of rows) { (byClass[r.cls] ||= { n: 0, s: 0 }).n++; if (r.solved) byClass[r.cls].s++; }
  lines.push('', '## Solved / total per class');
  for (const [c, v] of Object.entries(byClass)) lines.push(`- ${c}: ${v.s}/${v.n}`);
  const solved = rows.filter((r) => r.solved).length;
  lines.push('', `**Total: ${solved}/${rows.length} solved.**`, '');
  fs.writeFileSync(path.join(out, 'LABELS.md'), lines.join('\n'));
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.frames) { console.error('need --frames <file>'); process.exit(1); }
  const opts = {
    out: path.resolve(a.out || 'D:/AstroLogic/test_artifacts/w5_oracle_labels_2026-07-18'),
    workers: a.workers != null ? Number(a.workers) : 2,
    cpulimit: a.cpulimit != null ? Number(a.cpulimit) : 200,
    downsample: a.downsample != null ? Number(a.downsample) : 2,
    force: !!a.force,
    scaleLow: a['scale-low'] != null ? Number(a['scale-low']) : null,
    scaleHigh: a['scale-high'] != null ? Number(a['scale-high']) : null,
  };
  fs.mkdirSync(opts.out, { recursive: true });
  let frames = fs.readFileSync(a.frames, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (a.only) frames = frames.filter((f) => classify(f) === a.only);
  if (a.limit) frames = frames.slice(0, Number(a.limit));
  console.log(`W5 oracle-label: ${frames.length} frame(s), ${opts.workers} workers, cpulimit ${opts.cpulimit}s, out=${opts.out}`);

  const results = await pool(frames, opts.workers, (f) => processFrame(f, opts));

  // rebuild LABELS.md from ALL banked labels (so partial/resumed runs stay whole)
  const allRows = [];
  for (const f of fs.readdirSync(opts.out).filter((x) => x.endsWith('.label.json')).sort()) {
    const L = JSON.parse(fs.readFileSync(path.join(opts.out, f), 'utf8'));
    allRows.push({ base: L.frame_id, cls: L.class, solved: L.solved, error: L.error,
      index: L.solved_with_index, ra_h: L.ra_hours, dec: L.dec_degrees, pixscale: L.pixel_scale_arcsec,
      rot: L.rotation_deg, parity: L.parity, matches: L.matches, inputForm: L.input_form, elapsed_s: L.elapsed_s });
  }
  writeLabelsMd(opts.out, allRows);

  const solved = results.filter((r) => r?.solved).length;
  const skipped = results.filter((r) => r?.skipped).length;
  console.log(`\nDONE: ${solved}/${results.length} solved this run (${skipped} skipped/resumed). LABELS.md rebuilt over ${allRows.length} banked labels.`);
}
main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
