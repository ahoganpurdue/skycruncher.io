#!/usr/bin/env node
// tools/recal/dump_detections.mjs
// ═══════════════════════════════════════════════════════════════════════════
// RECAL DECODE MODE — per-detection DUMP producer (decoder cutover #14)
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/recal/dump_detections.mjs <raw> [--sigmas=2.0,2.5,3.0]
//        [--arm=rawler|libraw] [--out=<dump.json>]
//
// Produces the recal's DECODE-mode input: it runs the REAL m4 detection on the
// rawler-decoded (or libraw-control) grid and emits every clean detection with
// its per-blob {x,y,snr,fwhm,sharpness,ellipticity} + frame meta, matching the
// RECAL_DESIGN.md §1 `--dump` schema. That dump feeds tools/recal/sweep_thresholds.mjs
// (DUMP mode) — the DECODE → DUMP handoff.
//
// It does NOT fork a second decode: the actual decode + m4 run happens inside
// tools/recal/dump_detections.labspec.ts via the SAME headless_driver +
// OrchestratorSession + VITE_DECODER_RAWLER seam that ab_live.mjs drives (m4
// imports the photometry stack, so it must run under vitest, not bare Node).
//
// ── HONESTY ──────────────────────────────────────────────────────────────────
// * The rawler arm runs ONLY here (fresh spawned vitest process — the flag never
//   leaks into a gate). No threshold is changed anywhere; this lane only MEASURES.
// * The engine's native sigma is a compiled literal; `--sigmas` above native are
//   recorded in the dump and realized as SNR floors DOWNSTREAM (sweep_thresholds),
//   not as true pixel-level sigma re-runs (RECAL_DESIGN §5). Honest by construction.
// * Exit nonzero only if the driver itself or the dump write fails.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const i = args.indexOf(`--${name}`); // space-separated form
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const positional = args.filter((a) => !a.startsWith('--'));

const TS = new Date().toISOString().replace(/[:.]/g, '-');
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const PKG_DIR = path.join(ROOT, 'src', 'engine', 'wasm_decode', 'pkg');
const log = (...a) => console.log('[dump_detections]', ...a);

// ── CALIBRATED A/B MODE (cutover #14): --calibrated <bin> + --light <raw> ──────
// Runs the REAL m4 (shared detectSignal stage) on the uncalibrated (raw decode)
// grid AND the full-calibrated (light−dark)/flat grid, in one labspec, and dumps
// the detection-count / bg-σ / hot-survivor deltas. Reuses the existing labspec
// seam (dump_detections.labspec.ts), NOT a second detector.
const CALIB_BIN = flag('calibrated');
if (CALIB_BIN) {
    const calBin = path.resolve(CALIB_BIN);
    const light = path.resolve(flag('light') ?? '');
    const darkMan = path.resolve(flag('dark-manifest') ?? path.join(ROOT, 'test_results', 'calib_cocoon', 'master_dark.manifest.json'));
    const out = path.resolve(flag('out') ?? path.join(ROOT, 'test_results', 'decoder_recal',
        `${path.basename(light).replace(/\W+/g, '_')}_calibAB_${TS}.json`));
    if (!fs.existsSync(calBin)) { console.error(`[dump_detections] FATAL: calibrated bin not found: ${calBin}`); process.exit(1); }
    if (!light || !fs.existsSync(light)) { console.error(`[dump_detections] FATAL: --light <raw> required and must exist (got: ${light})`); process.exit(1); }
    if (!fs.existsSync(path.join(PKG_DIR, 'wasm_decode.js'))) {
        console.error(`[dump_detections] FATAL: wasm_decode pkg not built at ${PKG_DIR}`); process.exit(1);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // NOTE: VITE_DECODER_RAWLER is deliberately NOT set — this A/B decodes pixels
    // via decode_util (its own wasm_decode init) and only uses step1_Load (metadata,
    // no decode). Setting the flag would risk a second wasm_decode init in step2's
    // rawler path; the harness never needs it.
    const env = { ...process.env, RECAL_CALIB_LIGHT: light, RECAL_CALIB_BIN: calBin, RECAL_CALIB_OUT: out, RECAL_CALIB_DARK_MANIFEST: darkMan };
    delete env.VITE_DECODER_RAWLER;
    log(`calibrated A/B · light=${path.basename(light)} · calibrated=${path.basename(calBin)} → real m4 (both states) under vitest…`);
    const r = spawnSync(process.execPath, [VITEST_BIN, 'run', '-c', 'tools/recal/dump_detections.config.ts', 'tools/recal/dump_detections.labspec.ts'], { cwd: ROOT, env, encoding: 'utf8', timeout: 1_200_000 });
    const logPath = out.replace(/\.json$/, '.vitest.log');
    fs.writeFileSync(logPath, (r.stdout ?? '') + '\n--- stderr ---\n' + (r.stderr ?? ''));
    if (!fs.existsSync(out)) {
        const tail = (r.stdout ?? '').split('\n').slice(-20).join('\n');
        console.error(`[dump_detections] FATAL: A/B dump not written (vitest exit ${r.status}). Tail:\n${tail}\nfull log: ${logPath}`);
        process.exit(1);
    }
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    log(`A/B written: ${out}`);
    log(`  uncalibrated: count=${doc.uncalibrated.detection_count} bgσ=${doc.uncalibrated.bg_sigma} hotSurv=${doc.uncalibrated.hot_class_survivors}`);
    log(`  calibrated  : count=${doc.calibrated.detection_count} bgσ=${doc.calibrated.bg_sigma} hotSurv=${doc.calibrated.hot_class_survivors}`);
    log(`  Δ           : count=${doc.delta.detection_count} bgσ=${doc.delta.bg_sigma} (${doc.delta.bg_sigma_pct}%) hotSurv=${doc.delta.hot_class_survivors}`);
    process.exit(0);
}

const FILE = path.resolve(positional[0] ?? flag('file') ?? path.join(ROOT, 'public', 'demo', 'sample_observation.cr2'));
const ARM = flag('arm', 'rawler') === 'libraw' ? 'libraw' : 'rawler';
const SIGMAS = flag('sigmas', '');
const OUT = path.resolve(flag('out') ?? path.join(
    ROOT, 'test_results', 'decoder_recal',
    `${path.basename(FILE).replace(/\W+/g, '_')}_${ARM}_${TS}.dump.json`));

if (!fs.existsSync(FILE)) { console.error(`[dump_detections] FATAL: input not found: ${FILE}`); process.exit(1); }
if (ARM === 'rawler' && !fs.existsSync(path.join(PKG_DIR, 'wasm_decode.js'))) {
    console.error(`[dump_detections] FATAL: wasm_decode pkg not built at ${PKG_DIR} — run: cd src/engine/wasm_decode && wasm-pack build --target web`);
    process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// TRUE pixel-sigma dimension (cutover #14, increment 3): --sigfactor / --sigma-base
// set the engine's TEST-ONLY RECAL_SIGFACTOR / RECAL_SIGMA_BASE overrides in the
// spawned process ONLY, so this dump runs m4 at a REAL pixel-level sigma (not a
// downstream SNR-floor approximation). Unset ⇒ the compiled defaults (2.0 / 3.0),
// byte-identical. The flag never leaks into a gate (fresh spawned process).
const SIGFACTOR = flag('sigfactor');
const SIGMA_BASE = flag('sigma-base');
const env = { ...process.env, RECAL_DUMP_FILE: FILE, RECAL_DUMP_OUT: OUT, RECAL_DUMP_ARM: ARM, RECAL_DUMP_SIGMAS: SIGMAS };
delete env.VITE_DECODER_RAWLER;                          // libraw control: flag absent
if (ARM === 'rawler') env.VITE_DECODER_RAWLER = '1';     // rawler arm: flag ON (this process only)
delete env.RECAL_SIGFACTOR; delete env.RECAL_SIGMA_BASE; // default = compiled literals
if (SIGFACTOR != null) env.RECAL_SIGFACTOR = String(SIGFACTOR);
if (SIGMA_BASE != null) env.RECAL_SIGMA_BASE = String(SIGMA_BASE);

log(`arm=${ARM} · ${path.basename(FILE)} · sigmas=[${SIGMAS || '(none)'}]${SIGFACTOR != null ? ` · RECAL_SIGFACTOR=${SIGFACTOR}` : ''}${SIGMA_BASE != null ? ` · RECAL_SIGMA_BASE=${SIGMA_BASE}` : ''} → running REAL m4 under vitest…`);
const r = spawnSync(process.execPath, [
    VITEST_BIN, 'run', '-c', 'tools/recal/dump_detections.config.ts', 'tools/recal/dump_detections.labspec.ts',
], { cwd: ROOT, env, encoding: 'utf8', timeout: 1_200_000 });

const logPath = OUT.replace(/\.dump\.json$/, '.vitest.log');
fs.writeFileSync(logPath, (r.stdout ?? '') + '\n--- stderr ---\n' + (r.stderr ?? ''));

if (!fs.existsSync(OUT)) {
    const tail = (r.stdout ?? '').split('\n').slice(-15).join('\n');
    console.error(`[dump_detections] FATAL: dump not written (vitest exit ${r.status}). Tail:\n${tail}\nfull log: ${logPath}`);
    process.exit(1);
}

const dump = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const m = dump.meta ?? {};
log(`dump written: ${OUT}`);
log(`  decoder=${m.decoder} · dims=${m.dims?.width}x${m.dims?.height} · pattern=${m.pattern ?? 'n/a'}`);
log(`  detections=${m.detection_count} · halted_at=${m.halted_at ?? 'none'}`);
log(`  culling_tally=${JSON.stringify(m.culling_tally)}`);
log(`  → feed to: node tools/recal/sweep_thresholds.mjs --dump=${path.relative(ROOT, OUT)} [--truth=<labels.json>]${SIGMAS ? ` --sigmas=${SIGMAS}` : ''}`);
process.exit(0);
