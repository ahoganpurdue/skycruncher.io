#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// POPULATION TIMING RUN — QUIET-BASELINE benchmark (2026-07-11)
// ═══════════════════════════════════════════════════════════════════════════
//
// Drives the on-box SampleFiles science-frame corpus through the REAL headless
// wizard pipeline, PROCESS-PER-FRAME (a fresh `node vitest run -c
// tools/api/run.config.ts` against the established solve_to_receipt.runspec.ts —
// the same mechanism run.mjs/overnight use, minus run.mjs's stale .fit-only CLI
// guard so CR2 rides the same path the solve_cr2 apispec proves works headless).
//
//   node tools/corpus/population_timing_run.mjs --manifest-only   # enumerate+sha only
//   node tools/corpus/population_timing_run.mjs                    # manifest-first, then run
//
// EVIDENCE-ONLY: per-frame wall measured by THIS runner; per-stage timings come
// from the driver's StageTimingSummary sidecar (SKYCRUNCHER_PERF_TIMINGS_PATH).
// A timed-out/killed frame yields honest_timeout (no fabricated stage numbers).
//
// Big artifacts (receipts, logs) → D:  ·  small manifest/ledger → test_results.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = 'K:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY';
const SAMPLES = 'D:/AstroLogic/SampleFiles';
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const RUN_CONFIG = 'tools/api/run.config.ts';
const LOCK = path.join(ROOT, 'tools', 'ops', 'heavy_lane_lock.mjs');

const D_RUN = 'D:/AstroLogic/test_artifacts/population_run_2026-07-11';
const RECEIPTS = path.join(D_RUN, 'receipts');
const LOGS = path.join(D_RUN, 'logs');
const TIMINGS = path.join(D_RUN, 'timings');
const TR_RUN = path.join(ROOT, 'test_results', 'population_run_2026-07-11');
const MANIFEST = path.join(TR_RUN, 'manifest.json');
const LEDGER = path.join(TR_RUN, 'ledger.jsonl');
const SNAPSHOTS = path.join(TR_RUN, 'box_load_snapshots.json');
const DONE_SENTINEL = path.join(TR_RUN, 'RUN_DONE');

const MANIFEST_ONLY = process.argv.includes('--manifest-only');

for (const d of [RECEIPTS, LOGS, TIMINGS, TR_RUN]) fs.mkdirSync(d, { recursive: true });

const FLAGS = [
  "CR2/DSLR frames carry NO color photometry: SPCC is FITS-gated (science.ts:118) — no channel gains, per-star fluxes, color fit, or zeropoint banked for non-FITS.",
  "Rawler per-frame calibration (WB coeffs, black/white levels, CFA pattern, optical-black dark stats) is computed but NOT persisted — receipt keeps only decoder_arm='rawler'.",
  "SPCC gains are decoder-independent (FITS/decoder_arm=null); cold-vs-default gain-delta rider does not affect banked SPCC.",
];

// ── enumeration ──────────────────────────────────────────────────────────────
// maxdepth 3 non-cocoon science frames + cocoon_60da/lights ONLY (NOT bias/darks/flats).
function walk(dir, depth, maxDepth, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walk(full, depth + 1, maxDepth, acc); }
    else if (/\.(cr2|fits|fit|fts)$/i.test(e.name)) acc.push(full);
  }
}
const MAX_READ = 2147483648;   // Node readFileSync hard limit (2 GiB); the runspec reads the whole file.
function sha256Stream(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', rej); s.on('data', (d) => h.update(d)); s.on('end', () => res(h.digest('hex')));
  });
}
async function enumerateFrames() {
  const acc = [];
  walk(SAMPLES, 1, 3, acc);                                   // maxdepth 3
  // cocoon lights are at depth 4 (corpus/cocoon_60da/lights/*.CR2) — add explicitly.
  const lightsDir = path.join(SAMPLES, 'corpus', 'cocoon_60da', 'lights');
  if (fs.existsSync(lightsDir)) {
    for (const e of fs.readdirSync(lightsDir, { withFileTypes: true })) {
      if (e.isFile() && /\.(cr2|fits|fit|fts)$/i.test(e.name)) acc.push(path.join(lightsDir, e.name));
    }
  }
  const seen = new Set();
  const frames = [];
  for (const abs of acc.sort()) {
    if (seen.has(abs)) continue; seen.add(abs);
    const rel = path.relative(SAMPLES, abs).replace(/\\/g, '/');
    const ext = path.extname(abs).toLowerCase();
    const format = ext === '.cr2' ? 'CR2' : 'FITS';
    const timeout = format === 'CR2' ? 300_000 : 120_000;    // 300s blind/CR2 · 120s FITS
    const size = fs.statSync(abs).size;
    const sha = await sha256Stream(abs);                     // streaming — handles >2GiB; bytes never enter agent context
    const oversize = size >= MAX_READ;                       // runspec readFileSync cannot ingest — honest skip
    const id = rel.replace(/[^A-Za-z0-9._-]/g, '_');
    frames.push({ id, rel, abs: abs.replace(/\\/g, '/'), format, ext, timeout, sha, size_bytes: size, oversize });
  }
  return frames;
}

// ── box-load snapshot ────────────────────────────────────────────────────────
function boxSnapshot(label) {
  const total = os.totalmem(), free = os.freemem();
  let nodeProcs = null, cpuLoadPct = null;
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    nodeProcs = ((r.stdout || '').match(/"node\.exe"/g) || []).length;
  } catch {}
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'],
      { encoding: 'utf8' });
    const v = parseFloat((r.stdout || '').trim()); if (!Number.isNaN(v)) cpuLoadPct = v;
  } catch {}
  return {
    label, ts: new Date().toISOString(),
    mem_total_gb: +(total / 1e9).toFixed(2), mem_free_gb: +(free / 1e9).toFixed(2),
    mem_used_pct: +(100 * (1 - free / total)).toFixed(1),
    cpu_load_pct: cpuLoadPct, node_proc_count: nodeProcs,
  };
}

function heartbeat() {
  try { spawnSync(process.execPath, [LOCK, 'heartbeat', 'A'], { encoding: 'utf8', timeout: 30_000 }); }
  catch {}
}

// ── per-frame processing ─────────────────────────────────────────────────────
async function runFrame(frame, idx, n) {
  const start = Date.now();
  if (frame.oversize) {                                       // > 2 GiB: runspec readFileSync would throw ERR_FS_FILE_TOO_LARGE
    const rec = {
      seq: idx + 1, id: frame.id, path: frame.rel, sha: frame.sha, size_bytes: frame.size_bytes,
      format: frame.format, decoder_arm: null, wall_ms: 0, outcome: 'skipped_too_large', exit_code: null,
      pid: null, timeout_budget_ms: frame.timeout, ra_hours: null, dec_degrees: null, pixel_scale: null,
      stars_matched: null, confidence: null, confirm_status: null, confirm_block: null,
      total_ms: null, n_stages: null, stages: null, run_ok: null, run_id: null,
      note: `size ${(frame.size_bytes / 1e9).toFixed(2)}GB >= 2GiB Node readFileSync limit; headless runspec cannot ingest`,
      receipt: null, log: null,
    };
    fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
    console.log(`[${idx + 1}/${n}] ${frame.format} ${frame.id} -> skipped_too_large (${(frame.size_bytes / 1e9).toFixed(2)}GB)`);
    return rec;
  }
  const receiptOut = path.join(RECEIPTS, `${frame.id}.receipt.json`);
  const logOut = path.join(LOGS, `${frame.id}.log`);
  const timingOut = path.join(TIMINGS, `${frame.id}.timing.jsonl`);
  try { if (fs.existsSync(receiptOut)) fs.rmSync(receiptOut); } catch {}
  try { if (fs.existsSync(timingOut)) fs.rmSync(timingOut); } catch {}
  const fd = fs.openSync(logOut, 'a');
  const child = spawn(process.execPath, [VITEST, 'run', '-c', RUN_CONFIG], {
    cwd: ROOT,
    stdio: ['ignore', fd, fd],                               // stream to disk — never buffer 28k-line blind logs
    env: {
      ...process.env,
      API_RUN_FITS: frame.abs,
      API_RUN_RECEIPT_OUT: receiptOut,
      SKYCRUNCHER_PERF_TIMINGS_PATH: timingOut,               // per-frame timing isolation (no join ambiguity)
    },
  });
  const pid = child.pid;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' }); } catch {}
  }, frame.timeout);
  const exitCode = await new Promise((res) => {
    child.on('exit', (c) => res(c));
    child.on('error', () => res(-1));
  });
  clearTimeout(timer);
  try { fs.closeSync(fd); } catch {}
  const wall = Date.now() - start;

  let outcome, ra = null, dec = null, scale = null, matched = null, conf = null;
  let confirmBlock = null, confirmStatus = null, timing = null;
  if (timedOut) {
    outcome = 'honest_timeout';
  } else if (fs.existsSync(receiptOut)) {
    let r = null;
    try { r = JSON.parse(fs.readFileSync(receiptOut, 'utf8')); } catch {}
    if (!r) { outcome = 'error_bad_receipt'; }
    else {
      const solved = r.solution != null;
      outcome = solved ? 'solved' : 'honest_failure';
      if (solved) {
        ra = r.solution.ra_hours ?? null; dec = r.solution.dec_degrees ?? null;
        scale = r.solution.pixel_scale ?? null; matched = r.solution.stars_matched ?? null;
        conf = r.solution.confidence ?? null;
      }
      confirmBlock = r.confirm_status ?? null;
      confirmStatus = confirmBlock?.status ?? null;
    }
  } else {
    outcome = exitCode === 0 ? 'error_no_receipt' : 'error';
  }
  if (fs.existsSync(timingOut)) {
    try {
      const lines = fs.readFileSync(timingOut, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) timing = JSON.parse(lines[lines.length - 1]);
    } catch {}
  }
  const rec = {
    seq: idx + 1, id: frame.id, path: frame.rel, sha: frame.sha, size_bytes: frame.size_bytes,
    format: frame.format, decoder_arm: timing?.decoder_arm ?? (frame.format === 'CR2' ? 'rawler' : null),
    wall_ms: wall, outcome, exit_code: exitCode, pid, timeout_budget_ms: frame.timeout,
    ra_hours: ra, dec_degrees: dec, pixel_scale: scale, stars_matched: matched, confidence: conf,
    confirm_status: confirmStatus, confirm_block: confirmBlock,
    total_ms: timing?.total_ms ?? null, n_stages: timing?.n_stages ?? null,
    stages: timing?.stages ?? null, run_ok: timing?.ok ?? null, run_id: timing?.run_id ?? null,
    receipt: fs.existsSync(receiptOut) ? path.relative(D_RUN, receiptOut).replace(/\\/g, '/') : null,
    log: path.relative(D_RUN, logOut).replace(/\\/g, '/'),
  };
  fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
  const st = rec.stages || {};
  console.log(`[${idx + 1}/${n}] ${frame.format} ${frame.id} -> ${outcome} wall=${(wall / 1000).toFixed(1)}s matched=${matched ?? '-'} conf=${confirmStatus ?? '-'} stages=${Object.keys(st).length}`);
  return rec;
}

// ── resume (owner mid-run scope change: skip remaining correlated cocoon set) ──
// Kill+relaunch path: reads the EXISTING manifest.json + ledger.jsonl (no re-sha,
// no completed work redone), appends skipped_correlated_set rows for remaining
// cocoon_60da frames, and runs every other not-yet-done frame exactly as before.
async function runResume() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const frames = manifest.frames;
  const done = new Set();
  if (fs.existsSync(LEDGER)) {
    for (const l of fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean)) {
      try { done.add(JSON.parse(l).id); } catch {}
    }
  }
  const nCocoonDone = [...done].filter((id) => /cocoon_60da/.test(id)).length;
  const COCOON_REASON = `correlated set (same rig/target/night); ${nCocoonDone}/25 sampled, all no-solve ~196s; owner-ruled skip mid-run 2026-07-12`;
  const snaps = [];
  if (manifest.box_load_snapshots_start) snaps.push(manifest.box_load_snapshots_start);
  snaps.push(boxSnapshot('resume'));
  let heartbeats = 0, ran = 0, skippedCocoon = 0;
  console.log(`[resume] ${done.size} frames already in ledger (${nCocoonDone} cocoon); processing remainder of ${frames.length}`);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (done.has(f.id)) continue;                              // already recorded — never redo
    heartbeat(); heartbeats++;
    if (/cocoon_60da/.test(f.id)) {
      const rec = {
        seq: i + 1, id: f.id, path: f.rel, sha: f.sha, size_bytes: f.size_bytes,
        format: f.format, decoder_arm: null, wall_ms: 0, outcome: 'skipped_correlated_set',
        exit_code: null, pid: null, timeout_budget_ms: f.timeout, ra_hours: null, dec_degrees: null,
        pixel_scale: null, stars_matched: null, confidence: null, confirm_status: null, confirm_block: null,
        total_ms: null, n_stages: null, stages: null, run_ok: null, run_id: null,
        reason: COCOON_REASON, receipt: 'ABSENT — owner-ruled correlated-set skip (mid-run scope change)', log: null,
      };
      fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
      skippedCocoon++;
      console.log(`[${i + 1}/${frames.length}] SKIP cocoon ${f.id}`);
      continue;
    }
    await runFrame(f, i, frames.length);
    ran++;
  }
  snaps.push(boxSnapshot('end'));
  fs.writeFileSync(SNAPSHOTS, JSON.stringify({ heartbeats, resumed: true, snapshots: snaps }, null, 2));
  fs.writeFileSync(DONE_SENTINEL, new Date().toISOString());
  console.log(`[RESUME DONE] ran=${ran} skipped_cocoon=${skippedCocoon} heartbeats=${heartbeats} (canonical summary written by post-processor)`);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes('--resume')) { await runResume(); return; }
  const runStart = Date.now();
  const frames = await enumerateFrames();
  const nCR2 = frames.filter((f) => f.format === 'CR2').length;
  const nFITS = frames.filter((f) => f.format === 'FITS').length;
  const nOversize = frames.filter((f) => f.oversize).length;

  const snaps = [boxSnapshot('start')];
  const manifest = {
    label: 'QUIET-BASELINE',
    run: 'population_run_2026-07-11',
    generated: new Date().toISOString(),
    box: os.hostname(),
    samples_root: SAMPLES,
    enumeration: 'maxdepth-3 science frames (.cr2/.fit/.fits/.fts) + corpus/cocoon_60da/lights ONLY (bias/darks/flats excluded)',
    decoder_default_arm: 'rawler (VITE_DECODER_RAWLER unset)',
    per_frame_timeout: { CR2: '300s', FITS: '120s' },
    runner: 'tools/corpus/population_timing_run.mjs — process-per-frame, serial, vitest run -c tools/api/run.config.ts (solve_to_receipt.runspec.ts)',
    n_frames: frames.length, n_CR2: nCR2, n_FITS: nFITS, n_oversize_skipped: nOversize,
    task_stated_count: 73,
    count_note: `Enumerated ${frames.length} science frames on disk (${nCR2} CR2 + ${nFITS} FITS); task stated 73. Difference = rotating/ and cocoon/lights grown since the estimate. Enumerated exactly per directive.`,
    MANDATORY_FLAGS: FLAGS,
    box_load_snapshots_start: snaps[0],
    frames,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`[manifest] wrote ${frames.length} frames (${nCR2} CR2 + ${nFITS} FITS) -> ${MANIFEST}`);
  if (MANIFEST_ONLY) { console.log('[manifest-only] done'); return; }

  try { if (fs.existsSync(DONE_SENTINEL)) fs.rmSync(DONE_SENTINEL); } catch {}
  fs.writeFileSync(LEDGER, '');                              // fresh ledger for this run
  const midIdx = Math.floor(frames.length / 2);
  let heartbeats = 0;
  for (let i = 0; i < frames.length; i++) {
    heartbeat(); heartbeats++;                               // heartbeat before EVERY frame (frames up to 5min, lease 15min)
    if (i === midIdx) snaps.push(boxSnapshot('mid'));
    await runFrame(frames[i], i, frames.length);
  }
  snaps.push(boxSnapshot('end'));
  fs.writeFileSync(SNAPSHOTS, JSON.stringify({ heartbeats, snapshots: snaps }, null, 2));

  // ── summary rollup ──────────────────────────────────────────────────────────
  const recs = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const by = (pred) => recs.filter(pred);
  const med = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const summarizeClass = (fmt) => {
    const cls = by((r) => r.format === fmt);
    const walls = cls.map((r) => r.wall_ms);
    const stageKeys = {};
    for (const r of cls) for (const [k, v] of Object.entries(r.stages || {})) (stageKeys[k] ??= []).push(v);
    const stageMed = {}; for (const [k, v] of Object.entries(stageKeys)) stageMed[k] = med(v);
    return {
      n: cls.length,
      solved: cls.filter((r) => r.outcome === 'solved').length,
      honest_failure: cls.filter((r) => r.outcome === 'honest_failure').length,
      honest_timeout: cls.filter((r) => r.outcome === 'honest_timeout').length,
      error: cls.filter((r) => String(r.outcome).startsWith('error')).length,
      wall_median_s: med(walls) != null ? +(med(walls) / 1000).toFixed(2) : null,
      wall_max_s: walls.length ? +(Math.max(...walls) / 1000).toFixed(2) : null,
      total_ms_median: med(cls.map((r) => r.total_ms).filter((x) => x != null)),
      stage_median_ms: stageMed,
    };
  };
  const slowest = [...recs].sort((a, b) => b.wall_ms - a.wall_ms).slice(0, 5)
    .map((r) => ({ id: r.id, format: r.format, outcome: r.outcome, wall_s: +(r.wall_ms / 1000).toFixed(1) }));
  const summary = {
    label: 'QUIET-BASELINE', run: 'population_run_2026-07-11', generated: new Date().toISOString(),
    total_wall_s: +((Date.now() - runStart) / 1000).toFixed(1),
    n_attempted: recs.length,
    solved: recs.filter((r) => r.outcome === 'solved').length,
    honest_failure: recs.filter((r) => r.outcome === 'honest_failure').length,
    honest_timeout: recs.filter((r) => r.outcome === 'honest_timeout').length,
    error: recs.filter((r) => String(r.outcome).startsWith('error')).length,
    confirmed: recs.filter((r) => r.confirm_status === 'CONFIRMED').length,
    heartbeats,
    by_class: { FITS: summarizeClass('FITS'), CR2: summarizeClass('CR2') },
    slowest_5: slowest,
    MANDATORY_FLAGS: FLAGS,
    box_load_snapshots: snaps,
  };
  fs.writeFileSync(path.join(TR_RUN, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(DONE_SENTINEL, new Date().toISOString());
  console.log(`[DONE] ${recs.length} frames · solved=${summary.solved} fail=${summary.honest_failure} timeout=${summary.honest_timeout} err=${summary.error} · wall=${summary.total_wall_s}s`);
}

main().catch((e) => { console.error('[population-run FATAL]', e); process.exit(1); });
