#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// LIVE-STACK MOCK PROOF — end-to-end mechanics proof for live_stack.mjs
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/stack/live_stack_mockproof.mjs [--frames 4] [--session-dir <p>]
//
// Proves the FULL follower chain headlessly WITHOUT a telescope:
//   synthesize a watcher session (session.jsonl + frame FITS + Solve-Queue solve
//   sidecars, arriving ONE AT A TIME) → run live_stack --once per arrival →
//   the stacker re-stacks → a PNG sequence is banked as the demo-fallback evidence.
//
// ⚠ HONEST LABEL — MECHANICS-PROOF ONLY, NOT A SCIENCE CLAIM:
//   the arriving "frames" are DITHERED, RE-NOISED DUPLICATES of ONE Seestar master
//   (public/demo/seestar_m66_sample.fit). They are NOT independent sky exposures.
//   The stack visibly deepens and the added per-frame noise averages down — a
//   faithful demonstration of the register/combine/render PLUMBING — but the SNR
//   gain is against SYNTHETIC noise on identical signal, so it is NOT a real
//   integration-depth result. live_stack is run with --allow-correlated precisely
//   because the stacker (correctly) flags these as SUSPECTED_CORRELATED. For a real
//   depth demo, point a real Seestar at a target: independent subs → honest sqrt(N).
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openFits, readPlaneRaw, writeFitsPlanar } from './fits_io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function arg(k, d) { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; }
const N = Number(arg('--frames', '4'));
const SRC = arg('--fits', path.join(REPO_ROOT, 'public', 'demo', 'seestar_m66_sample.fit'));
const SESSION_DIR = arg('--session-dir', path.join('D:', 'AstroLogic', 'test_artifacts', 'livestack_mockproof', 'seestar_m66_mock01'));
const SOLVE_DIR = path.join(SESSION_DIR, 'solve');
const OUT_DIR = path.join(SESSION_DIR, 'stack');
const JOURNAL = path.join(SESSION_DIR, 'session.jsonl');

// M66 source header hints (so the stacker header-solves fast + correct — no blind).
const CARDS_BASE = {
  RA: 170.425003051758, DEC: 12.8419437408447, FOCALLEN: 160,
  XPIXSZ: 2.90000009536743, YPIXSZ: 2.90000009536743,
};
const EXPOSURE_S = 10;

// dithers (px) mimic a real Seestar dither pattern.
const DITHERS = [[0, 0], [2, -1], [-1, 2], [1, 1], [-2, 0], [0, -2], [3, -2], [-1, -1]];

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

function appendJournal(row) { fs.appendFileSync(JOURNAL, JSON.stringify(row) + '\n'); }

function main() {
  if (!fs.existsSync(SRC)) { console.error(`source FITS not found: ${SRC}`); process.exit(1); }
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(SOLVE_DIR, { recursive: true });

  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║ LIVE-STACK MOCK PROOF — MECHANICS ONLY (dithered dupes of 1 master) ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  console.log(`source : ${SRC}`);
  console.log(`session: ${SESSION_DIR}`);
  console.log(`frames : ${N}\n`);

  // read source planes once
  const f = openFits(SRC);
  const { W, H, NP } = f;
  const planes0 = [];
  for (let p = 0; p < NP; p++) planes0.push(readPlaneRaw(f, p));
  f.close();

  appendJournal({ event: 'session_start', session_id: path.basename(SESSION_DIR), host: 'mock', mode: 'drive', ts: new Date().toISOString() });

  const rnd = lcg(0xC0FFEE);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const summary = [];

  for (let k = 0; k < N; k++) {
    const [dx, dy] = DITHERS[k % DITHERS.length];
    const file = `frame_${String(k).padStart(4, '0')}.fits`;
    const dest = path.join(SESSION_DIR, file);

    // ── "watcher": land a dithered+renoised FITS (distinct file, valid WCS hints)
    const out = planes0.map((pl) => {
      const o = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sx = x - dx, sy = y - dy;
        let v = (sx >= 0 && sx < W && sy >= 0 && sy < H) ? pl[sy * W + sx] : 0;
        v += gauss() * 8;             // faint per-frame read noise (distinct + averages down)
        o[y * W + x] = v > 0 ? v : 0;
      }
      return o;
    });
    const dateObs = new Date(Date.now() + k * EXPOSURE_S * 1000).toISOString();
    writeFitsPlanar(dest, out, W, H, [
      ['RA', CARDS_BASE.RA, 'deg (source hint)'], ['DEC', CARDS_BASE.DEC, 'deg (source hint)'],
      ['FOCALLEN', CARDS_BASE.FOCALLEN, 'mm'], ['XPIXSZ', CARDS_BASE.XPIXSZ, 'um'], ['YPIXSZ', CARDS_BASE.YPIXSZ, 'um'],
      ['EXPTIME', EXPOSURE_S, 'commanded exposure seconds'], ['DATE-OBS', dateObs, 'UTC'],
      ['FRAMESRC', 'live_stack_mockproof', 'MECHANICS PROOF: dithered dup'],
    ]);

    // ── "watcher journal": append the frame row (bound contract shape)
    appendJournal({
      event: 'frame', status: 'ok', session_id: path.basename(SESSION_DIR), seq: k, frame_id: `mock-${k}`,
      file, path: dest, ts: dateObs, exposure_s: EXPOSURE_S, W, H, NP, bytes: fs.statSync(dest).size,
    });

    // ── "Solve Queue product": per-frame solve sidecar (accepted) — QueueSolveResult shape
    fs.writeFileSync(path.join(SOLVE_DIR, `${file}.solve.json`), JSON.stringify({
      accepted: true, frame: file, raHours: 11.34122957, decDeg: 13.05,
      scaleArcsecPerPx: 3.6783, matched: 225, confidence: 0.83,
      note: 'SIMULATED Solve-Queue product for the mechanics proof',
    }, null, 2));

    console.log(`── arrival ${k + 1}/${N}: ${file} (dither ${dx},${dy}) landed + journaled + solved ──`);

    // ── run the follower for ONE pass over everything solved so far
    const args = [
      path.join(HERE, 'live_stack.mjs'),
      '--session-dir', SESSION_DIR, '--solve-dir', SOLVE_DIR, '--out', OUT_DIR,
      '--once', '--min-frames', '2', '--allow-correlated',
    ];
    const res = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(res.stdout || '');
    if (res.status !== 0) { console.error(res.stderr || `live_stack exit ${res.status}`); }

    let man = null;
    try { man = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8')); } catch { /* first arrival: no stack yet */ }
    summary.push({ arrival: k + 1, file, stacked: man?.frames_stacked ?? 0, snr_gain: man?.snr?.gain_measured ?? null, integ_s: man?.integration_s ?? null, png: man?.outputs?.png ?? null });
  }

  appendJournal({ event: 'session_end', frames: N, ts: new Date().toISOString() });

  console.log('\n═══ SEQUENCE (demo-fallback evidence) ═══');
  const seqDir = path.join(OUT_DIR, 'sequence');
  const seq = fs.existsSync(seqDir) ? fs.readdirSync(seqDir).filter((x) => x.endsWith('.png')).sort() : [];
  for (const s of seq) console.log(`  ${path.join(seqDir, s)}`);
  console.log('\n═══ PER-ARRIVAL (mechanics proof — SNR gain is vs synthetic noise, not a depth claim) ═══');
  console.table(summary);
  console.log(`\nstable outputs (refresh in place — point any auto-reloading image viewer at the PNG):`);
  console.log(`  render : ${path.join(OUT_DIR, 'live_stack.png')}`);
  console.log(`  fits   : ${path.join(OUT_DIR, 'live_stack.fits')}`);
  console.log(`  manifest: ${path.join(OUT_DIR, 'manifest.json')}`);
  console.log(`  events  : ${path.join(OUT_DIR, 'live_stack_events.jsonl')}`);
}

main();
