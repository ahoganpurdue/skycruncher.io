#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// gauntlet_rawler.mjs — gauntlet re-run on the NEW DEFAULT (rawler) arm
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/rawlab/gauntlet_rawler.mjs [--ab-libraw]
//
// Runs each gauntlet frame through the REAL app pipeline (runWizardPipeline via
// gauntlet_run.labspec.ts), DEFAULT arm (VITE_DECODER_RAWLER unset = rawler,
// post-cutover @56cf96d). SERIALIZED — one heavy solve lane at a time.
//
// The 6-frame gauntlet (tools/solverkit/eval_bands.mjs runGauntlet):
//   sample_observation (control, bundled), IMG_1410, IMG_1414, IMG_1653,
//   IMG_1757 (solverkit-rail ORACLE TRUE_POSITIVE), CSM30803_5DMkIII (5D3).
// The 5D3 raw is ABSENT locally (only a cached .app.json exists) → reported ABSENT.
//
// BASELINE FRAMING (honest): the "1/6" baseline is the solverkit ANCHORLESS
// band-index lost-in-space rail — a SEPARATE rail that never re-accepts through
// the app gate. This run measures the app's ANCHORED UW solver. Through the app
// pipeline the historical gauntlet-CR2 baseline is 0 blind solves (only the
// bundled control solves). A NEW app solve here is real news.
//
// --ab-libraw: if a NON-control frame newly solves, ALSO run it on the libraw
// cold arm to attribute the win to the decoder (targeted, bounded A/B).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const AB_LIBRAW = args.includes('--ab-libraw');
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const OUTDIR = path.join(ROOT, 'test_results', 'gauntlet_rawler_2026-07-11');
const RUNDIR = path.join(OUTDIR, `run_${TS}`);
fs.mkdirSync(RUNDIR, { recursive: true });

const CHALLENGE = path.join(ROOT, 'Sample Files', 'challenge', 'DSLR Images - All Canon T6 Rokinon 14mm');
// [name, absolute-path-or-null, class]
const FRAMES = [
    ['sample_observation', path.join(ROOT, 'public', 'demo', 'sample_observation.cr2'), 'CONTROL (bundled; must solve)'],
    ['IMG_1410', path.join(CHALLENGE, 'IMG_1410.CR2'), 'CLEAN (Jun-3)'],
    ['IMG_1414', path.join(CHALLENGE, 'IMG_1414.CR2'), 'CLEAN (Jun-3) — FALSE-POSITIVE case study'],
    ['IMG_1653', path.join(CHALLENGE, 'IMG_1653.CR2'), 'FOREGROUND'],
    ['IMG_1757', path.join(CHALLENGE, 'IMG_1757.CR2'), 'NOISY (Altair) — solverkit-rail ORACLE TRUE_POSITIVE'],
    ['CSM30803_5DMkIII', null, '5D3 (raw ABSENT — cached .app.json only)'],
];

const log = (...a) => console.log('[gauntlet]', ...a);

function runFrame(name, file, arm /* 'rawler'|'libraw' */) {
    const outJson = path.join(RUNDIR, `${name}.${arm}.json`);
    const env = { ...process.env, RAWLAB_GAUNTLET_FILE: file, RAWLAB_GAUNTLET_OUT: outJson };
    delete env.VITE_DECODER_RAWLER;            // default = rawler
    if (arm === 'libraw') env.VITE_DECODER_RAWLER = '0';
    const t0 = Date.now();
    const r = spawnSync(process.execPath,
        [VITEST_BIN, 'run', '-c', 'tools/rawlab/ab_pipeline.config.ts', 'tools/rawlab/gauntlet_run.labspec.ts'],
        { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(path.join(RUNDIR, `${name}.${arm}.vitest.log`), (r.stdout ?? '') + '\n--- stderr ---\n' + (r.stderr ?? ''));
    const wall = ((Date.now() - t0) / 1000).toFixed(0);
    if (!fs.existsSync(outJson)) {
        const tail = ((r.stdout ?? '') + (r.stderr ?? '')).slice(-1500);
        log(`${name} [${arm}]: NO RECORD (exit ${r.status}, ${wall}s) — spawn failure`);
        return { name, arm, spec_exit: r.status, record: null, error: tail };
    }
    const rec = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    log(`${name} [${arm}]: ${rec.blindOutcome} ${rec.solve?.solved ? `RA=${rec.solve.ra_hours}h scale=${rec.solve.pixel_scale} matched=${rec.solve.stars_matched}` : ''} (${wall}s wall, det=${rec.detection?.clean_stars ?? '?'})`);
    return { name, arm, spec_exit: r.status, record: rec };
}

const results = [];
for (const [name, file, klass] of FRAMES) {
    if (!file || !fs.existsSync(file)) {
        log(`${name}: ABSENT (${file ? 'file missing: ' + file : 'no local raw'})`);
        results.push({ name, klass, absent: true, note: klass });
        continue;
    }
    log(`── ${name} (${klass}) — default rawler arm ──`);
    const rawler = runFrame(name, file, 'rawler');
    const entry = { name, klass, file, rawler: rawler.record, rawler_exit: rawler.spec_exit, rawler_error: rawler.error ?? null };
    // Targeted A/B only if a NON-control frame newly solves.
    if (AB_LIBRAW && name !== 'sample_observation' && rawler.record?.solve?.solved) {
        log(`   ↳ ${name} newly SOLVED on rawler — running libraw cold arm to attribute…`);
        const lib = runFrame(name, file, 'libraw');
        entry.libraw = lib.record;
        entry.libraw_exit = lib.spec_exit;
    }
    results.push(entry);
}

// ── Tally ──
const solved = results.filter((e) => !e.absent && e.rawler?.solve?.solved);
const controlSolved = results.find((e) => e.name === 'sample_observation')?.rawler?.solve?.solved ?? false;
const nonControlSolved = solved.filter((e) => e.name !== 'sample_observation');

const measurements = {
    generated_at: new Date().toISOString(),
    arm: 'rawler_default (post-cutover @56cf96d)',
    baseline_note: 'solverkit anchorless band-index rail = 1/6 (IMG_1757 only). This run = the app ANCHORED UW solver, a different rail; app-pipeline gauntlet-CR2 baseline = 0 blind solves (control aside).',
    frames_run: results.filter((e) => !e.absent).length,
    frames_absent: results.filter((e) => e.absent).map((e) => e.name),
    control_solved: controlSolved,
    non_control_solved: nonControlSolved.map((e) => e.name),
    n_over_6: `${solved.length}/6 solved (incl. control) · ${nonControlSolved.length} NEW non-control app solves`,
    results,
};
fs.writeFileSync(path.join(OUTDIR, 'measurements.json'), JSON.stringify(measurements, null, 2));
fs.writeFileSync(path.join(RUNDIR, 'measurements.json'), JSON.stringify(measurements, null, 2));

log('');
log('════════ GAUNTLET TALLY (app pipeline, rawler default) ════════');
log(`control (sample_observation) solved: ${controlSolved}`);
log(`NEW non-control app solves: ${nonControlSolved.length ? nonControlSolved.map((e) => e.name).join(', ') : 'NONE'}`);
log(`absent: ${measurements.frames_absent.join(', ') || 'none'}`);
log(`artifacts: ${path.relative(ROOT, path.join(OUTDIR, 'measurements.json'))}`);
process.exit(0);
