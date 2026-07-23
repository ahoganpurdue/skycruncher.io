#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   run_telemetry_watch.mjs — live headless-run telemetry watcher.

   Watches a corpus/batch run directory (produced by tools/parallel/run_batch.mjs,
   optionally wrapped by corpus_grad_run.mjs) and, every tick, derives a compact
   render-ready snapshot for the owner dashboard's Run Telemetry widget. Writes
   it ATOMICALLY (tmp + rename) to the dashboard data plane as run_telemetry.json,
   where serve.mjs auto-serves it at /data/run_telemetry.json (ZERO server
   restart — the passthrough route already exists).

   SOURCES (all READ-ONLY, read-share; never writes into the run dir):
     · <run>/driver.err.log         — append-only narrative:
         [grad-run] launching arm X (desc)
         [parallel] starting: N frame(s), P=K worker(s), out=...\ARM
         [parallel] (i/N) <jobId> → <verdict>  <sym>  <ms>ms  [K active]
         [grad-run] arm X: solved=.. no_solve=.. error=.. wall=..ms speedup=..
       PRIMARY source for per-frame verdicts + arm sequence/rollups. Small file,
       re-read whole each tick (it is NOT a receipt body).
     · <run>/<ARM>/*.receipt.json   — one per completed (solved|no_solve) frame
     · <run>/<ARM>/*.crash.json     — one per errored/timed-out frame
       Counted by FILENAME only (never opened — receipts are ~3 MB). Gives a
       filesystem-truth done count + last-finished mtime that is robust to a
       buggy driver rollup counter (arm A's OOM zeroed its rollup; the 8
       crash.json files + 8 log lines are the truth).
     · <run>/run_manifest.json      — launch sha, checkout, mode, arm sequence.
     · sibling run dirs             — best-effort recent-history strip.

   HONESTY (LAW 3): anything not derivable is emitted null and the widget
   renders "NOT MEASURED". In-flight frame NAMES are not derivable (the driver
   logs no per-frame START lines) — only an estimate (min(workers, pending)) is
   emitted, explicitly labelled.

   CRASH-PROOF: the whole tick body is wrapped; a malformed/partly-written file
   is caught per-file and the frame counts as pending. The watcher never dies on
   bad input.

   Usage:
     node tools/theses/dashboard/run_telemetry_watch.mjs \
       [--run-dir <dir>] [--interval-ms 5000] [--out <path>] [--once]
       [--no-history] [--history-every 12]
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// repo root = <root>/tools/theses/dashboard/run_telemetry_watch.mjs → up 3
const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_RUN_DIR = 'D:/AstroLogic/test_artifacts/corpus_grad_2026-07-18';
const DEFAULT_OUT = path.join(ROOT, 'test_results', 'theses', 'dashboard', 'run_telemetry.json');

const SCHEMA = 'run-telemetry/1';
const RECENT_MAX = 20;
const HISTORY_MAX = 8;

/* ── args ─────────────────────────────────────────────────────────────────── */
function parseArgs(argv) {
  const a = { runDir: DEFAULT_RUN_DIR, intervalMs: 5000, out: DEFAULT_OUT, once: false, history: true, historyEvery: 12 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--run-dir') a.runDir = argv[++i];
    else if (k === '--interval-ms') a.intervalMs = Math.max(1000, parseInt(argv[++i], 10) || 5000);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--once') a.once = true;
    else if (k === '--no-history') a.history = false;
    else if (k === '--history-every') a.historyEvery = Math.max(1, parseInt(argv[++i], 10) || 12);
  }
  a.runDir = path.resolve(a.runDir);
  a.out = path.resolve(a.out);
  return a;
}

/* ── safe read helpers (read-only, shared) ───────────────────────────────── */
function readTextSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }
function readdirSafe(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return null; } }
function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''; }

/* ── driver.err.log parser ─────────────────────────────────────────────────
   Returns { arms: Map(name→{desc, order, workers, total, launched, rolledUp,
   rollup, solved, no_solve, error, doneLog}), sequenceFromLog: [], recent: [] } */
function parseDriverLog(text) {
  const arms = new Map();
  const recent = [];
  const seq = [];
  if (!text) return { arms, seq, recent };
  const ensure = (name) => {
    if (!arms.has(name)) {
      arms.set(name, { name, desc: null, order: null, workers: null, total: null,
        launched: false, rolledUp: false, rollup: null, solved: 0, no_solve: 0, error: 0, doneLog: 0 });
    }
    return arms.get(name);
  };
  let curArm = null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    let m;
    // launching arm X (desc)
    if ((m = /^\[grad-run\] launching arm (\S+)\s*(?:\((.*)\))?\s*$/.exec(line))) {
      const arm = ensure(m[1]);
      arm.launched = true;
      if (m[2]) arm.desc = m[2];
      if (!seq.includes(m[1])) { seq.push(m[1]); arm.order = seq.length - 1; }
      curArm = m[1];
      continue;
    }
    // starting: N frame(s), P=K worker(s), out=...\ARM
    if ((m = /^\[parallel\] starting: (\d+) frame\(s\), P=(\d+) worker\(s\), out=(.*)$/.exec(line))) {
      const armName = baseName(m[3].trim());
      const arm = ensure(armName);
      arm.total = parseInt(m[1], 10);
      arm.workers = parseInt(m[2], 10);
      arm.launched = true;
      if (!seq.includes(armName)) { seq.push(armName); arm.order = seq.length - 1; }
      curArm = armName;
      continue;
    }
    // per-frame done: (i/N) jobId → verdict  sym  Nms  [K active]
    if ((m = /^\[parallel\] \((\d+)\/(\d+)\) (.+?) → (\w+)\b/.exec(line))) {
      const armName = curArm || 'unknown';
      const arm = ensure(armName);
      const verdict = m[4];
      const msM = /(\d+)ms\s*\[(\d+) active\]/.exec(line);
      const ms = msM ? parseInt(msM[1], 10) : null;
      arm.doneLog += 1;
      if (verdict === 'solved') arm.solved += 1;
      else if (verdict === 'no_solve') arm.no_solve += 1;
      else if (verdict === 'error') arm.error += 1;
      else arm.error += 0; // unknown verdicts don't inflate a bucket; still counted in doneLog
      recent.push({ arm: armName, frame: m[3], verdict, ms, index: parseInt(m[1], 10), total: parseInt(m[2], 10) });
      if (arm.total == null) arm.total = parseInt(m[2], 10);
      continue;
    }
    // arm rollup
    if ((m = /^\[grad-run\] arm (\S+): solved=(\d+) no_solve=(\d+) error=(\d+) wall=(\d+)ms(?:\s+speedup=(\S+))?/.exec(line))) {
      const arm = ensure(m[1]);
      arm.rolledUp = true;
      arm.rollup = { solved: +m[2], no_solve: +m[3], error: +m[4], wall_ms: +m[5], speedup: m[6] || null };
      continue;
    }
  }
  return { arms, seq, recent };
}

/* ── per-arm filesystem scan (cached by dir mtime) ──────────────────────────
   Only re-scans an arm dir when its mtime advanced. Returns
   { completed, crashed, lastFrame, lastVerdict, lastAtMs, dirMtimeMs }. */
const fsCache = new Map(); // arm → { dirMtimeMs, result }
function scanArmDir(runDir, arm) {
  const dir = path.join(runDir, arm);
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return null;
  const cached = fsCache.get(arm);
  if (cached && cached.dirMtimeMs === st.mtimeMs) return cached.result;
  const entries = readdirSafe(dir) || [];
  let completed = 0, crashed = 0;
  let lastFrame = null, lastVerdict = null, lastAtMs = null;
  for (const e of entries) {
    if (!e.isFile || !e.isFile()) continue;
    const n = e.name;
    let verdict = null;
    if (n.endsWith('.receipt.json')) { completed++; verdict = 'completed'; }
    else if (n.endsWith('.crash.json')) { crashed++; verdict = 'crashed'; }
    else continue;
    const fst = statSafe(path.join(dir, n));
    const mtime = fst ? fst.mtimeMs : 0;
    if (lastAtMs == null || mtime > lastAtMs) {
      lastAtMs = mtime;
      lastFrame = n.replace(/\.(receipt|crash)\.json$/, '');
      lastVerdict = verdict;
    }
  }
  const result = { completed, crashed, lastFrame, lastVerdict, lastAtMs, dirMtimeMs: st.mtimeMs };
  fsCache.set(arm, { dirMtimeMs: st.mtimeMs, result });
  return result;
}

/* ── recent-history strip (best-effort, cached) ─────────────────────────────*/
let historyCache = { tick: -1, data: [] };
function scanHistory(runDir, tick, every) {
  if (tick % every !== 0 && historyCache.tick >= 0) return historyCache.data;
  const parent = path.dirname(runDir);
  const out = [];
  try {
    const entries = readdirSafe(parent) || [];
    const cands = [];
    for (const e of entries) {
      if (!e.isDirectory || !e.isDirectory()) continue;
      const d = path.join(parent, e.name);
      const mp = path.join(d, 'run_manifest.json');
      const st = statSafe(mp);
      if (!st) continue;
      cands.push({ dir: d, name: e.name, mtimeMs: st.mtimeMs, isCurrent: path.resolve(d) === path.resolve(runDir) });
    }
    cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const c of cands.slice(0, HISTORY_MAX)) {
      const mf = readJsonSafe(path.join(c.dir, 'run_manifest.json')) || {};
      const logSt = statSafe(path.join(c.dir, 'driver.err.log'));
      out.push({
        name: c.name, is_current: c.isCurrent,
        launch_sha: mf.launch_sha || null, mode: mf.mode || null,
        generated_at: mf.generated_at || null,
        has_driver_log: !!logSt,
        manifest_mtime: c.mtimeMs ? new Date(c.mtimeMs).toISOString() : null,
      });
    }
  } catch { /* best-effort */ }
  historyCache = { tick, data: out };
  return out;
}

/* ── build the snapshot ─────────────────────────────────────────────────────*/
function buildSnapshot(args, tick) {
  const nowIso = new Date().toISOString();
  const runDir = args.runDir;
  const runSt = statSafe(runDir);
  if (!runSt || !runSt.isDirectory()) {
    return {
      schema: SCHEMA, generated_at: nowIso,
      watcher: { run_dir: runDir, interval_ms: args.intervalMs, tick },
      run: { available: false, note: `run dir not present: ${runDir}` },
      arms: [], recent_frames: [], history: args.history ? scanHistory(runDir, tick, args.historyEvery) : [],
    };
  }

  const manifest = readJsonSafe(path.join(runDir, 'run_manifest.json')) || {};
  const logText = readTextSafe(path.join(runDir, 'driver.err.log'));
  const parsed = parseDriverLog(logText);

  // arm sequence: manifest is authoritative, else log order
  let sequence = [];
  const seqStr = manifest.run_batch && manifest.run_batch.sequential;
  if (typeof seqStr === 'string') sequence = seqStr.split('→').map((s) => s.trim()).filter(Boolean);
  if (sequence.length === 0) sequence = parsed.seq.slice();
  // union with any arms that showed up only in the log
  for (const name of parsed.arms.keys()) if (!sequence.includes(name)) sequence.push(name);

  // current arm = last launched without rollup
  let currentArm = null;
  for (const name of sequence) {
    const a = parsed.arms.get(name);
    if (a && a.launched && !a.rolledUp) currentArm = name; // last such wins
  }
  const allRolled = sequence.length > 0 && sequence.every((n) => { const a = parsed.arms.get(n); return a && a.rolledUp; });

  const arms = [];
  let totalPerArm = null;
  for (const name of sequence) {
    const a = parsed.arms.get(name) || { name, launched: false, rolledUp: false, workers: null, total: null,
      solved: 0, no_solve: 0, error: 0, doneLog: 0, desc: null, rollup: null };
    const fsr = scanArmDir(runDir, name);
    const total = a.total != null ? a.total
      : (fsr ? null : null); // total only known from log; else null
    if (total != null && totalPerArm == null) totalPerArm = total;

    const completed = fsr ? fsr.completed : 0;   // receipts (solved|no_solve)
    const crashedFs = fsr ? fsr.crashed : 0;
    const doneFs = completed + crashedFs;
    const done = Math.max(a.doneLog, doneFs);
    const solved = a.solved;
    const noSolve = a.no_solve;
    const crashed = Math.max(a.error, crashedFs);
    const accounted = solved + noSolve + crashed;
    const pendingVerdict = Math.max(0, done - accounted);
    const pending = total != null ? Math.max(0, total - done) : null;

    let state = 'pending';
    if (a.rolledUp) state = 'done';
    else if (a.launched) state = 'running';
    else if (name === currentArm) state = 'running';

    const incomplete = state === 'done' && total != null && done < total;
    const inFlight = state === 'running' && a.workers != null && pending != null
      ? Math.min(a.workers, pending) : (state === 'running' ? null : 0);

    arms.push({
      arm: name,
      desc: a.desc || null,
      state,
      total,
      done,
      solved,
      failed: noSolve,           // no_solve = plate not solved (ran clean, no crash)
      crashed,
      pending_verdict: pendingVerdict,
      pending,
      in_flight_estimate: inFlight,
      workers: a.workers != null ? a.workers : null,
      last_finished_frame: fsr ? fsr.lastFrame : null,
      last_finished_verdict: fsr ? fsr.lastVerdict : null,
      last_finished_at: (fsr && fsr.lastAtMs) ? new Date(fsr.lastAtMs).toISOString() : null,
      driver_rollup: a.rollup,   // may DISAGREE with tallies (arm A OOM zeroed it) — shown as-is
      incomplete,
      note: incomplete ? 'driver rolled up but done < total (arm aborted mid-run — e.g. OOM)' : null,
    });
  }

  const startedAt = manifest.generated_at || null;
  const wallMs = startedAt ? (Date.now() - Date.parse(startedAt)) : null;

  const recent = parsed.recent.slice(-RECENT_MAX).reverse().map((r) => ({
    arm: r.arm, frame: r.frame, verdict: r.verdict, ms: r.ms,
  }));

  return {
    schema: SCHEMA,
    generated_at: nowIso,
    watcher: { run_dir: runDir, interval_ms: args.intervalMs, tick },
    run: {
      available: true,
      launch_sha: manifest.launch_sha || null,
      checkout: manifest.checkout || null,
      mode: manifest.mode || null,
      tool: manifest.tool || null,
      started_at: startedAt,
      wall_ms_so_far: wallMs,
      arms_sequence: sequence,
      current_arm: allRolled ? null : currentArm,
      run_complete: allRolled,
      total_frames_per_arm: totalPerArm,
    },
    arms,
    recent_frames: recent,
    history: args.history ? scanHistory(runDir, tick, args.historyEvery) : [],
  };
}

/* ── atomic write ───────────────────────────────────────────────────────────*/
function writeAtomic(outPath, obj) {
  const dir = path.dirname(outPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  const tmp = outPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, outPath);
}

/* ── main loop ──────────────────────────────────────────────────────────────*/
function tickOnce(args, tick) {
  let snap;
  try {
    snap = buildSnapshot(args, tick);
  } catch (err) {
    snap = {
      schema: SCHEMA, generated_at: new Date().toISOString(),
      watcher: { run_dir: args.runDir, interval_ms: args.intervalMs, tick },
      run: { available: false, note: 'watcher tick failed (recovered): ' + String(err && err.message || err) },
      arms: [], recent_frames: [], history: [],
    };
  }
  try { writeAtomic(args.out, snap); } catch (err) {
    process.stderr.write(`[run-telem] write failed: ${err.message}\n`);
  }
  return snap;
}

function main() {
  const args = parseArgs(process.argv);
  process.stdout.write(`[run-telem] watching ${args.runDir}\n[run-telem] → ${args.out} every ${args.intervalMs}ms\n`);
  let tick = 0;
  const first = tickOnce(args, tick);
  const cur = first.run && first.run.current_arm;
  process.stdout.write(`[run-telem] tick 0: available=${first.run && first.run.available} current_arm=${cur || 'none'} arms=${(first.arms || []).length}\n`);
  if (args.once) return;
  setInterval(() => { tick += 1; tickOnce(args, tick); }, args.intervalMs);
}

main();
