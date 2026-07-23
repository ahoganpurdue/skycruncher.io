#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// TOOLCHEST API — harvest.mjs : minimal batch loop over run.mjs
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/api/harvest.mjs <frame-list> <out-dir> [--deadline-minutes N]
//
// <frame-list> = a text file, one FITS path per line (blank lines and lines
// starting with '#' are ignored). Each frame is solved by forking tools/api/run.mjs
// EXACTLY as the ad-hoc 2026-07-16 harvest loop did — full canonical receipt banked
// to <out-dir>/<base>.receipt.json, one projection line appended to
// <out-dir>/harvest_log.txt. This is the committed, corrected replacement for that
// throwaway wrapper (which passed a NON-EXISTENT select key
// `solution.matched_stars_count`; the real field is `solution.stars_matched`).
//
// Resumable: a frame whose receipt already exists is SKIPped, so a killed run
// resumes without re-solving. Stops cleanly at the optional deadline (never
// interrupts an in-flight solve — the deadline only gates STARTING a new frame).
// A crash leaves run.mjs's <base>.crash.json (LAW 3), logged as CRASH here.
// Boring by design: no deps beyond node stdlib, no parallelism.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundedTail } from './crash_record.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_MJS = path.join(HERE, 'run.mjs');
// Correct receipt field paths (the ad-hoc loop's key did not exist).
const SELECT = 'solution.ra_hours,solution.pixel_scale,solution.stars_matched,solution.confidence';

function die(msg) { process.stderr.write(`[api/harvest] ${msg}\n`); process.exit(1); }

function parseArgs(argv) {
  const a = { deadlineMinutes: null, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--deadline-minutes') a.deadlineMinutes = Number(argv[++i]);
    else if (t.startsWith('--')) die(`unknown flag: ${t}`);
    else a._.push(t);
  }
  return a;
}

const a = parseArgs(process.argv.slice(2));
const [listArg, outArg] = a._;
if (!listArg || !outArg) die('usage: node tools/api/harvest.mjs <frame-list> <out-dir> [--deadline-minutes N]');
if (!fs.existsSync(listArg)) die(`frame-list not found: ${listArg}`);
if (a.deadlineMinutes != null && !(a.deadlineMinutes > 0)) die(`--deadline-minutes must be a positive number`);

const outDir = path.resolve(outArg);
fs.mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, 'harvest_log.txt');

const frames = fs.readFileSync(listArg, 'utf8')
  .split(/\r?\n/).map((s) => s.trim())
  .filter((s) => s && !s.startsWith('#'));

const startMs = Date.now();
const deadlineMs = a.deadlineMinutes != null ? startMs + a.deadlineMinutes * 60_000 : Infinity;

function log(line) {
  const stamped = `${new Date().toISOString()}\t${line}`;
  fs.appendFileSync(logPath, stamped + '\n', 'utf8');
  process.stdout.write(stamped + '\n');
}

// Mirror run.mjs's receipt naming so a skip check matches what run.mjs would write.
const receiptOf = (frame) => path.join(outDir, path.basename(frame).replace(/\.(fit|fits|fts)$/i, '') + '.receipt.json');

const tally = { solved: 0, no_solve: 0, crash: 0, skip: 0 };
log(`START harvest\tframes=${frames.length}\tout=${outDir}\tdeadline=${a.deadlineMinutes != null ? a.deadlineMinutes + 'min' : 'none'}`);

for (let i = 0; i < frames.length; i++) {
  const frame = frames[i];
  const tag = `[${i + 1}/${frames.length}] ${path.basename(frame)}`;

  if (fs.existsSync(receiptOf(frame))) { tally.skip++; log(`SKIP banked\t${tag}\treceipt exists`); continue; }
  if (Date.now() >= deadlineMs) { log(`DEADLINE reached\tstopping before ${tag} (${i} of ${frames.length} started)`); break; }

  const res = spawnSync(process.execPath, [RUN_MJS, '--out', outDir, '--select', SELECT, frame], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

  if (res.status === 0) {
    tally.solved++;
    let p = {};
    try { p = JSON.parse((res.stdout || '').trim().split(/\r?\n/).pop() || '{}'); } catch { /* leave empty */ }
    log(`SOLVED\t${tag}\tmatched=${p['solution.stars_matched'] ?? '?'}\tra=${p['solution.ra_hours'] ?? '?'}\tscale=${p['solution.pixel_scale'] ?? '?'}\tconf=${p['solution.confidence'] ?? '?'}`);
  } else if (res.status === 2) {
    tally.no_solve++;
    log(`NO_SOLVE\t${tag}\t(honest scientific no-solve; receipt banked)`);
  } else {
    tally.crash++;
    const crashName = path.basename(frame).replace(/\.(fit|fits|fts)$/i, '') + '.crash.json';
    // run.mjs writes <base>.crash.json for a PIPELINE crash; an arg/validation
    // die (bad path, non-FITS) exits before the solve with no crash record —
    // forward a one-line stderr tail so that case is not silently opaque.
    const detail = fs.existsSync(path.join(outDir, crashName))
      ? `(see ${crashName})`
      : `(no crash record — run.mjs died pre-solve: ${boundedTail(res.stderr, 240).replace(/\s+/g, ' ').trim()})`;
    log(`CRASH\t${tag}\texit=${res.status}\tsignal=${res.signal ?? 'none'}\terror=${res.error?.code ?? 'none'}\t${detail}`);
  }
}

log(`DONE\tsolved=${tally.solved}\tno_solve=${tally.no_solve}\tcrash=${tally.crash}\tskip=${tally.skip}\telapsed=${((Date.now() - startMs) / 1000).toFixed(1)}s`);
// Exit non-zero only if EVERY attempted frame crashed (a batch-level infra alarm);
// individual no-solves/crashes are recorded, not fatal to the loop.
const attempted = tally.solved + tally.no_solve + tally.crash;
const exitCode = attempted > 0 && tally.crash === attempted ? 1 : 0;

// ── downstream: auto-drain new receipts to R2 (end-of-batch, NEVER-FATAL) ────
// Solves are the product; the R2 upload is downstream. This runs the shared drain
// (tools/results/drain_to_r2.mjs) over just-banked receipts so new solves flow to
// R2 automatically, WITHOUT per-frame network coupling. A drain failure (missing
// creds, network, etc.) is LOGGED but NEVER changes this batch's exit code or the
// solve byte-behavior above — the solve loop has already completed. Disable via
// RESULTS_DRAIN_DISABLE=1. The catch-all standalone drain (over all roots) is the
// branch-agnostic backstop for any receipts a harvest instance can't reach.
if (process.env.RESULTS_DRAIN_DISABLE !== '1') {
  try {
    // Default = this checkout's drain. A checkout without the results lane (e.g. the
    // rest-integration solve checkout) can point at main's drain by ABSOLUTE path
    // via RESULTS_DRAIN_MJS — the drain is cwd-independent, so one implementation
    // serves every branch without cherry-picking the lane.
    const drainMjs = process.env.RESULTS_DRAIN_MJS || path.join(HERE, '..', 'results', 'drain_to_r2.mjs');
    if (!fs.existsSync(drainMjs)) {
      log(`DRAIN_SKIPPED\tdrain tool not present at ${drainMjs}`);
    } else {
      const d = spawnSync(process.execPath, [drainMjs, '--roots', outDir], { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
      if (d.status === 0) {
        let s = {}; try { s = JSON.parse((d.stdout || '').trim().split(/\r?\n/).pop() || '{}'); } catch { /* leave empty */ }
        log(`DRAIN\tstatus=${s.status ?? 'ok'}\tnew_receipts=${s.new_receipts ?? '?'}\tuploaded=${s.uploaded ?? s.objects_written ?? 0}`);
      } else {
        log(`DRAIN_SKIPPED\texit=${d.status ?? 'null'}\tsignal=${d.signal ?? 'none'}\t(downstream upload failed; batch outcome unaffected)`);
      }
    }
  } catch (e) {
    log(`DRAIN_SKIPPED\terror=${String((e && e.message) || e).slice(0, 160)}\t(downstream upload failed; batch outcome unaffected)`);
  }
}

process.exit(exitCode);
