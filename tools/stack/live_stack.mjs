#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// LIVE STACK FOLLOWER — wires the existing v1 stacker into the live Alpaca flow
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/stack/live_stack.mjs --session-dir <watcher-session-dir> [flags]
//
// As a Seestar observing session runs, alpaca_watcher.mjs lands each frame as a
// FITS into <session-dir>/ and appends a `frame` row to session.jsonl; the Solve
// Queue solves each. This follower watches that session and, every time a NEW
// ACCEPTED (solved) frame appears, RE-RUNS the existing solve-first stacker
// (tools/stack/stack.mjs) over all accepted frames of the session, then publishes
// stable-named products so the demo shows the stack visibly DEEPEN as N grows:
//   <out>/live_stack.png    — STF render (refreshes in place; point a viewer here)
//   <out>/live_stack.fits   — the current stacked float32 FITS (output-grid WCS)
//   <out>/manifest.json     — honest tally: N, integration, excluded+reasons,
//                             measured SNR gain vs sqrt(N) (honest-or-absent)
//   <out>/live_stack_events.jsonl — one row per pass (dashboard/telemetry feed)
//   <out>/sequence/pass_NNNN.png  — banked PNG sequence (demo-fallback evidence)
//
// ZERO NEW STACKING SCIENCE: this is pure plumbing. All registration, combine,
// drizzle, correlated-input exclusion, SNR/FWHM validation and STF rendering are
// performed by the UNTOUCHED tools/stack/stack.mjs. v0 does a FULL re-stack per
// arrival (N is small in a demo session); the incremental-update optimization
// (accumulate into a running mean, skip already-registered frames) is future work.
//
// ACCEPTANCE GATE (which frames feed the stack):
//   • --solve-dir given → a frame is accepted only when a per-frame solve product
//     <frameBasename>.solve.json exists with { "accepted": true } (the Solve
//     Queue's output — see QueueSolveResult in solve_queue/queue_state.ts). This
//     lets the app's real solve gate the stack and avoids re-solving guesswork.
//   • no --solve-dir → the stacker's OWN solve is the gate: every landed frame is
//     handed to stack.mjs, which solves/registers each and honestly EXCLUDES any it
//     cannot lock or that it flags correlated (reasons surface in the manifest).
//
// INPUT CONTRACTS BOUND (read-only; both are stable disk formats):
//   • Watcher journal  <session-dir>/session.jsonl — append-only JSONL; rows
//     { event:"frame", status:"ok", file, path, seq, frame_id, exposure_s, ... }
//     (tools/intake/alpaca/alpaca_watcher.mjs).
//   • Stacker report   <pass-dir>/report_stack.json — clusters[], results[]
//     (members[].corrNote, validation.snr.gainMeasured, outputs{fits,render,coverage}),
//     excluded[], unsolved[] (tools/stack/stack.mjs).
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STACKER = path.join(HERE, 'stack.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    sessionDir: null, solveDir: null, out: null, once: false, pollMs: 2000,
    minFrames: 2, allowCorrelated: false, stackerArgs: '', stacker: DEFAULT_STACKER,
    maxPasses: Infinity, verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case '--session-dir': a.sessionDir = argv[++i]; break;
      case '--solve-dir': a.solveDir = argv[++i]; break;
      case '--out': a.out = argv[++i]; break;
      case '--once': a.once = true; break;
      case '--poll-ms': a.pollMs = Number(argv[++i]); break;
      case '--min-frames': a.minFrames = Number(argv[++i]); break;
      case '--allow-correlated': a.allowCorrelated = true; break;
      case '--stacker-args': a.stackerArgs = argv[++i]; break;
      case '--stacker': a.stacker = argv[++i]; break;
      case '--max-passes': a.maxPasses = Number(argv[++i]); break;
      case '--verbose': a.verbose = true; break;
      case '-h': case '--help': a.help = true; break;
      default: console.error(`unknown arg: ${t}`); process.exit(2);
    }
  }
  return a;
}

function help() {
  console.log(`live_stack.mjs — live-session stack follower (wires the v1 stacker)

  node tools/stack/live_stack.mjs --session-dir <dir> [flags]

  --session-dir <p>   REQUIRED. watcher session dir (session.jsonl + frame_*.fits)
  --solve-dir <p>     dir of <frameBasename>.solve.json acceptance sidecars (Solve
                      Queue products); omit to let the stacker's own solve gate.
  --out <p>           output dir (default <session-dir>/stack)
  --once              single pass over current journal state, then exit
  --poll-ms <n>       follow poll cadence (default 2000)
  --min-frames <n>    minimum accepted frames before the first stack (default 2)
  --allow-correlated  forward to stack.mjs (same-session / mechanics-proof demos)
  --stacker-args "…"  extra args forwarded verbatim to stack.mjs (e.g. "--drizzle 2")
  --max-passes <n>    stop after N stacks (default: unbounded)
  --verbose`);
}

// ── watcher journal reader (bound contract) ─────────────────────────────────
// Returns { sessionId, frames:[{file,path,seq,frameId,exposureS}], ended }.
export function readJournal(sessionDir) {
  const jp = path.join(sessionDir, 'session.jsonl');
  const out = { sessionId: path.basename(sessionDir), frames: [], ended: false };
  if (!fs.existsSync(jp)) return out;
  const seen = new Set();
  for (const line of fs.readFileSync(jp, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.event === 'session_start' && row.session_id) out.sessionId = row.session_id;
    if (row.event === 'session_end') out.ended = true;
    if (row.event === 'frame' && row.status === 'ok' && row.file) {
      if (seen.has(row.file)) continue;
      seen.add(row.file);
      // path may be absolute (watcher default) or we resolve into the session dir.
      const fpath = row.path && fs.existsSync(row.path) ? row.path : path.join(sessionDir, row.file);
      out.frames.push({
        file: row.file, path: fpath, seq: Number.isInteger(row.seq) ? row.seq : out.frames.length,
        frameId: row.frame_id ?? null, exposureS: Number.isFinite(row.exposure_s) ? row.exposure_s : null,
      });
    }
  }
  return out;
}

// ── acceptance gate: Solve Queue product sidecar (optional) ─────────────────
// <solveDir>/<frameBasename>.solve.json ← { accepted:true, raHours, decDeg,
// scaleArcsecPerPx, matched, confidence } (mirrors QueueSolveResult; the queue
// carries every field already — emitting this sidecar is a thin app-side follow-up).
export function acceptedSolve(solveDir, file) {
  const base = file.replace(/\.[^.]+$/, '');
  for (const cand of [`${file}.solve.json`, `${base}.solve.json`]) {
    const p = path.join(solveDir, cand);
    if (fs.existsSync(p)) {
      try {
        const s = JSON.parse(fs.readFileSync(p, 'utf8'));
        return s.accepted === true ? s : null;
      } catch { return null; }
    }
  }
  return null;
}

// ── minimal FITS EXPTIME reader (dependency-free header scan) ────────────────
function readExptime(fpath) {
  try {
    const fd = fs.openSync(fpath, 'r');
    try {
      const buf = Buffer.alloc(2880);
      for (let block = 0; block < 8; block++) {
        const n = fs.readSync(fd, buf, 0, 2880, block * 2880);
        if (n <= 0) break;
        const txt = buf.toString('latin1', 0, n);
        for (let c = 0; c + 80 <= txt.length; c += 80) {
          const card = txt.slice(c, c + 80);
          const key = card.slice(0, 8).trim();
          if (key === 'EXPTIME' || key === 'EXPOSURE') {
            const v = parseFloat(card.slice(10).split('/')[0]);
            if (Number.isFinite(v)) return v;
          }
          if (key === 'END') return null;
        }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* absent */ }
  return null;
}

// ── stage accepted frames (hardlink, copy fallback) into a clean input dir ───
function stageFrames(frames, inputDir) {
  fs.rmSync(inputDir, { recursive: true, force: true });
  fs.mkdirSync(inputDir, { recursive: true });
  for (const fr of frames) {
    const dest = path.join(inputDir, fr.file);
    try { fs.linkSync(fr.path, dest); }
    catch { fs.copyFileSync(fr.path, dest); }   // EXDEV (cross-volume) fallback
  }
}

// ── run the UNTOUCHED stacker over the staged frames ────────────────────────
function runStacker(opts, inputDir, passDir) {
  const args = ['--dir', inputDir, '--out', passDir];
  if (opts.allowCorrelated) args.push('--allow-correlated');
  if (opts.stackerArgs.trim()) args.push(...opts.stackerArgs.trim().split(/\s+/));
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [opts.stacker, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const wallMs = Date.now() - t0;
  const log = (res.stdout || '') + (res.stderr || '');
  try { fs.writeFileSync(path.join(passDir, 'stacker_stdout.log'), log); } catch { /* best-effort */ }
  return { ok: res.status === 0, wallMs, log, status: res.status };
}

// ── choose the primary (target) cluster from the stacker report ─────────────
export function primaryResult(report) {
  const produced = (report.results || []).filter((r) => r.outputs && r.outputs.fits);
  if (!produced.length) return null;
  // most stackable members wins; tie-break by catalog matches of the reference.
  produced.sort((a, b) => (b.members?.length ?? 0) - (a.members?.length ?? 0));
  return produced[0];
}

// resolve a stacker report path (relative-to-repo-root, backslashes) OR fall back
// to the known name in the pass dir.
function resolveOutput(passDir, reportPath, clusterIdx, kind) {
  const nameByKind = { fits: 'rgb.fits', render: 'render.png', coverage: 'coverage.png' };
  const fallback = path.join(passDir, `stack_cluster${clusterIdx}_${nameByKind[kind]}`);
  if (fs.existsSync(fallback)) return fallback;
  if (reportPath) {
    const norm = reportPath.replace(/\\/g, path.sep);
    const base = path.join(passDir, path.basename(norm));
    if (fs.existsSync(base)) return base;
  }
  return null;
}

// ── one pass: stage → stack → publish stable products + honest manifest ─────
function runPass(opts, ctx, accepted) {
  ctx.passIndex += 1;
  const passIdx = ctx.passIndex;
  const inputDir = path.join(opts.out, '_input');
  const passDir = path.join(opts.out, 'passes', `pass_${String(passIdx).padStart(4, '0')}`);
  fs.mkdirSync(passDir, { recursive: true });

  stageFrames(accepted, inputDir);
  const run = runStacker(opts, inputDir, passDir);

  const reportPath = path.join(passDir, 'report_stack.json');
  let report = null;
  if (fs.existsSync(reportPath)) { try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* malformed */ } }

  const acceptedFiles = accepted.map((f) => f.file);
  const exptimeByFile = new Map(accepted.map((f) => [f.file, f.exposureS ?? readExptime(f.path)]));

  const manifest = {
    schema: 'skycruncher.livestack.manifest/1',
    produced_at: new Date().toISOString(),
    session_id: ctx.sessionId,
    pass_index: passIdx,
    stacker: path.relative(process.cwd(), opts.stacker).replace(/\\/g, '/'),
    stacker_wall_s: +(run.wallMs / 1000).toFixed(1),
    stacker_ok: run.ok,
    acceptance_mode: opts.solveDir ? 'pre-solved (Solve Queue sidecars)' : 'stacker-solve (stacker is the gate)',
    frames_accepted: acceptedFiles.length,
    frames_accepted_files: acceptedFiles,
    frames_stacked: 0,
    frames_excluded: 0,
    excluded: [],
    integration_s: null,
    scale_arcsec_px: null,
    target: null,
    snr: null,
    fwhm: null,
    outputs: { png: null, fits: null, coverage: null },
    honest_notes: [],
  };

  if (opts.allowCorrelated) {
    manifest.honest_notes.push('--allow-correlated: correlated-input exclusion was DISABLED. If the accepted frames are not independent sky exposures (e.g. dithered duplicates of one master), the SNR/integration figures are a mechanics demonstration, NOT a real integration-depth claim.');
  }

  const result = report ? primaryResult(report) : null;
  if (result) {
    const stackedMembers = result.members || [];
    manifest.frames_stacked = stackedMembers.length;
    manifest.scale_arcsec_px = result.validation?.outScale ?? null;
    manifest.target = result.centroid ? { raHours: result.centroid.raHours, decDeg: result.centroid.decDeg } : null;
    // honest integration = sum of EXPTIME over the frames that actually stacked
    let integ = 0, haveAll = true;
    for (const m of stackedMembers) { const e = exptimeByFile.get(m.file); if (Number.isFinite(e)) integ += e; else haveAll = false; }
    manifest.integration_s = haveAll ? integ : (integ || null);
    if (!haveAll) manifest.honest_notes.push('integration_s is a lower bound — EXPTIME was unreadable for at least one stacked frame.');
    // SNR / FWHM straight from the stacker's own honest validation block
    const v = result.validation || {};
    if (v.snr) manifest.snr = {
      gain_measured: v.snr.gainMeasured, gain_expected_if_independent: v.snr.gainExpected,
      sqrt_n_effective: v.snr.sqrtNEffective, n_effective: v.snr.nEffective, note: v.snr.note,
    };
    if (v.fwhm) manifest.fwhm = { stack_arcsec: v.fwhm.stackArcsec, best_frame_arcsec: v.fwhm.bestFrameArcsec };
    // correlated members → surface honestly
    for (const m of stackedMembers) if (m.corrNote) manifest.honest_notes.push(`${m.file}: ${m.corrNote}`);
    // publish stable-named products (copy so a viewer can auto-refresh one path)
    const fitsSrc = resolveOutput(passDir, result.outputs?.fits, result.cluster, 'fits');
    const renderSrc = resolveOutput(passDir, result.outputs?.render, result.cluster, 'render');
    const covSrc = resolveOutput(passDir, result.outputs?.coverage, result.cluster, 'coverage');
    if (renderSrc) { const d = path.join(opts.out, 'live_stack.png'); fs.copyFileSync(renderSrc, d); manifest.outputs.png = d; }
    if (fitsSrc) { const d = path.join(opts.out, 'live_stack.fits'); fs.copyFileSync(fitsSrc, d); manifest.outputs.fits = d; }
    if (covSrc) { const d = path.join(opts.out, 'live_stack_coverage.png'); fs.copyFileSync(covSrc, d); manifest.outputs.coverage = d; }
    // bank the PNG sequence (demo-fallback evidence)
    if (renderSrc) { const seqDir = path.join(opts.out, 'sequence'); fs.mkdirSync(seqDir, { recursive: true }); fs.copyFileSync(renderSrc, path.join(seqDir, `pass_${String(passIdx).padStart(4, '0')}_n${manifest.frames_stacked}.png`)); }
  } else {
    manifest.honest_notes.push(report
      ? 'No stackable cluster produced this pass (fewer than 2 frames solved to a shared pointing, or all excluded). This is honest — the stack does not deepen until independent solved frames agree.'
      : 'Stacker produced no report (see passes/*/stacker_stdout.log).');
  }

  // excluded / unsolved reasons (bound contract)
  const excluded = [];
  for (const e of (report?.excluded || [])) excluded.push(typeof e === 'string' ? e : (e.reason || e.file || JSON.stringify(e)));
  for (const u of (report?.unsolved || [])) excluded.push(`unsolved: ${typeof u === 'string' ? u : JSON.stringify(u)}`);
  manifest.excluded = excluded;
  manifest.frames_excluded = Math.max(0, acceptedFiles.length - manifest.frames_stacked);
  manifest.report = path.relative(opts.out, reportPath).replace(/\\/g, '/');

  fs.writeFileSync(path.join(opts.out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // per-pass telemetry row (dashboard/live feed)
  fs.appendFileSync(path.join(opts.out, 'live_stack_events.jsonl'), JSON.stringify({
    ts: manifest.produced_at, pass: passIdx, accepted: manifest.frames_accepted, stacked: manifest.frames_stacked,
    integration_s: manifest.integration_s, snr_gain: manifest.snr?.gain_measured ?? null,
    scale: manifest.scale_arcsec_px, png: manifest.outputs.png, ok: run.ok,
  }) + '\n');

  console.log(`[pass ${passIdx}] accepted=${manifest.frames_accepted} stacked=${manifest.frames_stacked}` +
    (manifest.snr ? ` snrGain=${manifest.snr.gain_measured}x (sqrtNeff=${manifest.snr.sqrt_n_effective})` : '') +
    ` integ=${manifest.integration_s ?? '-'}s wall=${manifest.stacker_wall_s}s` +
    (manifest.outputs.png ? ` → ${path.basename(manifest.outputs.png)}` : ' → (no stack yet)'));
  return manifest;
}

// ── follow loop ──────────────────────────────────────────────────────────────
export async function follow(opts) {
  if (!opts.sessionDir) throw new Error('--session-dir is required');
  opts.out = opts.out || path.join(opts.sessionDir, 'stack');
  fs.mkdirSync(opts.out, { recursive: true });
  const ctx = { passIndex: 0, sessionId: path.basename(opts.sessionDir), lastKey: null };

  console.log(`live_stack: following ${opts.sessionDir}` +
    (opts.solveDir ? ` (solve gate: ${opts.solveDir})` : ' (stacker-solve gate)') +
    ` → ${opts.out}`);

  for (;;) {
    const jour = readJournal(opts.sessionDir);
    ctx.sessionId = jour.sessionId;
    // accepted = landed frames that (if a solve-dir is set) carry an accepted sidecar
    const accepted = [];
    for (const fr of jour.frames) {
      if (!fs.existsSync(fr.path)) continue;
      if (opts.solveDir) { const s = acceptedSolve(opts.solveDir, fr.file); if (!s) continue; }
      accepted.push(fr);
    }
    accepted.sort((a, b) => a.seq - b.seq);
    const key = accepted.map((f) => f.file).join('|');

    if (accepted.length >= opts.minFrames && key !== ctx.lastKey) {
      ctx.lastKey = key;
      runPass(opts, ctx, accepted);
      if (ctx.passIndex >= opts.maxPasses) { console.log('live_stack: max-passes reached, stopping.'); break; }
    } else if (opts.verbose) {
      console.log(`(waiting: ${accepted.length} accepted, need ${opts.minFrames}${jour.ended ? ', session ended' : ''})`);
    }

    if (opts.once) { if (key === ctx.lastKey || accepted.length < opts.minFrames) break; }
    if (jour.ended && key === ctx.lastKey) { console.log('live_stack: session ended and stack is current, stopping.'); break; }
    await sleep(opts.pollMs);
  }
  return { passes: ctx.passIndex, out: opts.out };
}

// ── CLI entry ────────────────────────────────────────────────────────────────
async function mainCli() {
  const opts = parseArgs(process.argv);
  if (opts.help) { help(); return; }
  await follow(opts);
}

const isMain = (() => { try { return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href; } catch { return false; } })();
if (isMain) mainCli().catch((e) => { console.error('live_stack fatal:', e); process.exit(1); });
