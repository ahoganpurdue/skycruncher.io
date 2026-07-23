// ═══════════════════════════════════════════════════════════════════════════
// OVERNIGHT VERIFICATION PIPELINE — the deterministic, zero-AI driver
// (authoritative spec: docs/OVERNIGHT_PIPELINE.md)
// ═══════════════════════════════════════════════════════════════════════════
//
// A plain Node orchestrator that runs the corpus through the whole chain
// UNATTENDED. It COMPOSES tools that already exist (it rebuilds none of them):
//
//   1. Ingest   — resolve each frame's source via corpus_manifest.json (the
//                 stale `corpus/…` paths are remapped to real `challenge/…` +
//                 `rotating/…`), confirm the detection dump (test_results/cr2_dets).
//   2. Truth    — probe `astrometry_truth.mjs --check-install`; if GREEN, cross-
//                 check each frame for an `astrometry_net` truth label, else
//                 NO_TRUTH (honest-absent). AUTO-SWITCHES ON when the install
//                 lands — no code change. (This driver CALLS astrometry_truth,
//                 it never edits it — a concurrent agent owns that file.)
//   3. Solve    — invoke the CR2 sweep binding (tools/validation/run_cr2_sweep.ts)
//                 OFF/ON; it appends to the `uw_anchor_topN` ledger via the
//                 harness ledger API.
//   4. Grade    — check_graduation + grade_tools (per image-type cohort).
//   5. Render   — tools/validation/visual/contact_sheet.mjs → the tagged PNG.
//   6. Knob-tune / Harvest — STUB (logged "deferred"); clean seams per the doc.
//
// NON-NEGOTIABLE PROPERTIES (all deterministic — no Date.now()/random in control
// flow; timestamps are DATA fields only):
//   • Idempotent — a frame whose artifacts exist + are current (frame+config
//     hash) is skipped; a second full run is a no-op (checkpoint byte-identical).
//   • Resumable  — a per-run checkpoint (test_results/overnight/checkpoint.json,
//     gitignored) written incrementally; kill+restart resumes, never restarts.
//   • OOM-gated  — frames over the MP ceiling (Cygnus 374MP / M101 170MP) are
//     skipped (never decoded), logged, never crash the run.
//   • Bounded+logged — per-stage timing + a failure-taxonomy field per frame; a
//     fatal in one frame is caught and the run continues.
//
// USAGE:
//   node tools/overnight/run_pipeline.mjs                # nightly: rotation slice
//   node tools/overnight/run_pipeline.mjs --dry-run      # plan only, no execution
//   node tools/overnight/run_pipeline.mjs --limit 5      # first 5 of the rotation
//   node tools/overnight/run_pipeline.mjs --frames IMG_1653,IMG_1410
//   node tools/overnight/run_pipeline.mjs --force        # re-run even if current
//   node tools/overnight/run_pipeline.mjs --truth-mode off|auto|on   (default auto)
//   node tools/overnight/run_pipeline.mjs --mp-ceiling 120 --budget 90000
//
// This file's lane is ONLY the driver + rotation helper. It touches NO
// calibrated code and edits none of the tools it composes.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_CONFIG, FAILURE, configHash, frameIdOf, computePlan,
  decideTruthAction, classifySolve, isCr2SolveApplicable, isFitsSolveApplicable,
  reconcileFitsTruth, decideIntakeAction, canClearRaw,
} from './rotation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MANIFEST = path.join(ROOT, 'test_results', 'corpus_manifest.json');
const DETS_DIR = path.join(ROOT, 'test_results', 'cr2_dets');
const RAW_DIR = path.join(ROOT, 'test_results', 'validation', '_cr2_raw');
const FITS_RAW_DIR = path.join(ROOT, 'test_results', 'validation', '_fits_raw');
const VISUALS_DIR = path.join(ROOT, 'test_results', 'validation', 'visuals');
const LEDGER_FILE = path.join(ROOT, 'test_results', 'validation', 'uw_anchor_topN.jsonl');
const FITS_LEDGER_FILE = path.join(ROOT, 'test_results', 'validation', 'fits_solve.jsonl');
// The FITS solve-vs-truth rail writes each frame's truth adjudication (label lookup
// + center comparison, GOLD/COARSE) to THIS merge-detail file, NOT into the raw arm
// JSON. The driver must read the verdict from HERE (see reconcileFitsTruth).
const FITS_DETAIL_FILE = path.join(ROOT, 'test_results', 'validation', 'fits_trials_detail.json');
const FITS_CANDIDATE = 'fits_solve';
const OUT_DIR = path.join(ROOT, 'test_results', 'overnight');
const CHECKPOINT = path.join(OUT_DIR, 'checkpoint.json');
const REPORT = path.join(OUT_DIR, 'last_run_report.json');
// The intake fetcher's default source-config (gitignored; operator provides it).
// Auto-invoke is OPT-IN via --intake — presence of this file alone never fetches.
const DEFAULT_INTAKE_CONFIG = path.join(HERE, 'intake_sources.json');

// ── tiny arg parser ───────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  const flags = new Set(['dry-run', 'force', 'intake', 'intake-dry-run']);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      if (flags.has(k)) a[k] = true;
      else a[k] = argv[++i];
    } else a._.push(t);
  }
  return a;
}

// ── dump resolution via the manifest (cr2_dets/*.app.json OR fits_dets/*.json) ─
// The manifest's dump_available/dump_path already point each frame at the RIGHT
// cohort dir (CR2 → cr2_dets, FITS → fits_dets); resolving THROUGH it is what
// makes an oracle-solvable FITS frame ELIGIBLE instead of a false "no-dump". The
// legacy cr2_dets/<id>.app.json fallback keeps any frame absent from the map
// (or a manifest without the enriched fields) byte-identical to the old CR2 path.
function buildDumpMap(manifest) {
  const map = new Map();
  for (const im of manifest.images) {
    map.set(frameIdOf(im.path).toLowerCase(), {
      available: !!im.dump_available,
      abs: im.dump_path ? path.join(ROOT, im.dump_path) : null,
    });
  }
  return map;
}
function resolveDump(id, dumpMap) {
  const e = dumpMap.get(id.toLowerCase());
  if (e && e.available && e.abs && fs.existsSync(e.abs)) return e.abs;
  const legacy = path.join(DETS_DIR, `${id}.app.json`); // historical CR2 convention
  return fs.existsSync(legacy) ? legacy : null;
}
function buildTypeMap(manifest) {
  const map = new Map();
  for (const im of manifest.images) map.set(frameIdOf(im.path).toLowerCase(), im.image_type ?? 'UNKNOWN');
  return map;
}
// Per-frame KNOWN pixel scale (arcsec/px) → threaded into the Truth stage as a
// bounded solve-field search prior. Honest-absent: a frame without a measured
// pixel_scale maps to null (the truth solve runs BLIND, byte-identical).
function buildScaleMap(manifest) {
  const map = new Map();
  for (const im of manifest.images) {
    const ps = Number(im.pixel_scale);
    map.set(frameIdOf(im.path).toLowerCase(), Number.isFinite(ps) && ps > 0 ? ps : null);
  }
  return map;
}

// ── on-disk artifact predicates ──────────────────────────────────────────────
function solvePresent(id) {
  return fs.existsSync(path.join(RAW_DIR, 'anchor1', `${id}.json`)) &&
         fs.existsSync(path.join(RAW_DIR, 'anchor3', `${id}.json`));
}
// FITS solve present: arm0 raw exists (arm1 is the identity seam; arm0 is
// authoritative). Written by fits_binding.fitspec keyed by the FITS basename.
function fitsSolvePresent(id) {
  return fs.existsSync(path.join(FITS_RAW_DIR, 'arm0', `${id}.json`));
}
function readFitsArm(arm, id) {
  const p = path.join(FITS_RAW_DIR, `arm${arm}`, `${id}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
// Load the FITS-rail merge detail → Map<frame, { verdict, tier }>. This is where
// the truth adjudication (labels.json GOLD/COARSE) actually lands; the raw arm JSON
// carries NO truth field. Missing/unparseable ⇒ empty map (honest-absent).
function readFitsTruthDetail() {
  if (!fs.existsSync(FITS_DETAIL_FILE)) return new Map();
  try {
    const d = JSON.parse(fs.readFileSync(FITS_DETAIL_FILE, 'utf8'));
    const m = new Map();
    for (const f of d.frames ?? []) m.set(f.frame, { verdict: f.truth_verdict ?? null, tier: f.truth_tier ?? null });
    return m;
  } catch { return new Map(); }
}
// Load the FITS-rail forced-photometry (THIRD column) detail → Map<frame, block>.
// Sibling of readFitsTruthDetail: the confirmation verdict the engine already computes
// (deep_confirmed) lands in the merge detail's per-frame forced_photometry block. This
// is a REPORT-ONLY, NON-GATING signal (calibrated N=1 SeeStar-only) — never a gate.
// Missing/unparseable ⇒ empty map (honest-absent).
function readFitsForcedDetail() {
  if (!fs.existsSync(FITS_DETAIL_FILE)) return new Map();
  try {
    const d = JSON.parse(fs.readFileSync(FITS_DETAIL_FILE, 'utf8'));
    const m = new Map();
    for (const f of d.frames ?? []) if (f.forced_photometry) m.set(f.frame, f.forced_photometry);
    return m;
  } catch { return new Map(); }
}
// Apply the FITS-rail truth verdict to a per-frame record (surfaces the GOLD/COARSE
// label verdict the raw arm JSON lacks; clears a stale oracle `no-truth` taxonomy).
function applyFitsTruth(rec, raw, detailMap) {
  const railDetail = detailMap.get(rec.id)
    ?? (raw?.truth ? { verdict: raw.truth.verdict ?? null, tier: raw.truth.tier ?? null } : null);
  const rc = reconcileFitsTruth(rec.truth_verdict ?? null, rec.taxonomy, railDetail);
  rec.truth_verdict = rc.verdict;
  rec.truth_tier = rc.tier;
  rec.taxonomy = rc.taxonomy;
}
// Attach the forced-photometry (THIRD column) verdict to a per-frame record. REPORT-ONLY,
// NON-GATING: never touches taxonomy/truth_verdict/lock. Honest-absent (null) when the
// frame carries no confirmation block (non-locked / unconfirmable frames). The engine's
// deep_confirmed gate is calibrated N=1 SeeStar-only → surfaced as SIGNAL, flagged as such.
function applyFitsForced(rec, forcedMap) {
  const fp = forcedMap.get(rec.id) ?? null;
  rec.forced_verdict = fp?.verdict ?? null;
  rec.forced_photometry = fp;   // { verdict, setExcessZ, confirmed, examined, setGatePassed } | null
}
function renderPresent(id) {
  const both = fs.existsSync(path.join(VISUALS_DIR, `${id}__BOTH.png`));
  const pair = fs.existsSync(path.join(VISUALS_DIR, `${id}__OFF.png`)) &&
               fs.existsSync(path.join(VISUALS_DIR, `${id}__ON.png`));
  const fits = fs.existsSync(path.join(VISUALS_DIR, `${id}__FITS.png`)); // FITS render lane
  return both || pair || fits;
}
function readRawArm(arm, id) {
  const p = path.join(RAW_DIR, arm, `${id}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
function renderPngs(id) {
  const names = [`${id}__BOTH.png`, `${id}__OFF.png`, `${id}__ON.png`, `${id}__FITS.png`];
  return names.filter((n) => fs.existsSync(path.join(VISUALS_DIR, n)));
}

// ── source resolution (manifest; the stale corpus/ paths → challenge/rotating) ─
function buildPathMap(manifest) {
  const map = new Map();
  for (const im of manifest.images) map.set(frameIdOf(im.path).toLowerCase(), path.join(ROOT, im.path));
  return map;
}
function resolveSource(id, pathMap) {
  let p = pathMap.get(id.toLowerCase());
  if (p && fs.existsSync(p)) return p;
  const stem = id.replace(/_iso\d+.*$/i, '');
  p = pathMap.get(stem.toLowerCase());
  if (p && fs.existsSync(p)) return p;
  return null;
}

// ── checkpoint I/O (atomic; deterministic content) ───────────────────────────
function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT)) return null;
  try { return JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')); } catch { return null; }
}
function stableStr(obj) { return JSON.stringify(obj, null, 2); }
function writeCheckpointIfChanged(cp) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const next = stableStr(cp);
  const prev = fs.existsSync(CHECKPOINT) ? fs.readFileSync(CHECKPOINT, 'utf8') : null;
  if (prev === next) return false; // no-op: leave the file byte-identical
  const tmp = CHECKPOINT + '.tmp';
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, CHECKPOINT);
  return true;
}

// ── subprocess helpers (compose the existing tools) ──────────────────────────
function node(scriptRel, args, extraEnv = {}, timeout = 0) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(ROOT, scriptRel), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: timeout || undefined,
    env: { ...process.env, ...extraEnv },
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '',
           error: res.error ? String(res.error.code || res.error.message) : null,
           ms: Date.now() - started };
}

// ── STAGE 0: intake (opt-in unattended ingestion) ─────────────────────────────
// Compose fetch_intake.mjs as a subprocess so its SIGNED-provenance path (outbound
// identity headers + inbound HMAC-signed ledger sidecars) is preserved verbatim —
// this driver reimplements NONE of it, it only decides WHEN to call it. Returns a
// structured summary for the run report (honest: exit code + the fetcher's own
// summary lines, never a fabricated count).
function runIntake({ configPath, dryRun }) {
  const args = [];
  if (configPath) args.push('--config', configPath);
  if (dryRun) args.push('--dry-run');
  const r = node('tools/overnight/fetch_intake.mjs', args, {}, 0);
  const lines = (r.stdout || '').trim().split('\n');
  // Surface the fetcher's plan/summary lines (planned pulls + the final fetched tally).
  const summary = lines.filter((l) => /planned pulls|fetched \d|dry-run|ledger →/i.test(l)).slice(-6);
  return { exit: r.code, ms: r.ms, dry_run: !!dryRun, config: configPath, summary, error: r.error };
}

// ── HARVEST-BEFORE-CLEAR: disk-backed wrapper over the pure canClearRaw gate ───
// Any future clear/rotation path MUST call this before touching a raw frame. Today
// NOTHING deletes raw (verified) → this is a PRE-EMPTIVE guard + a per-frame green
// light in the report; it NEVER deletes. Durable-artifact predicates:
//   • detection dump resolves (cr2_dets / fits_dets via the manifest, or legacy)
//   • the checkpoint ledger carries a processed (complete|partial) entry for it
// The dossier stub is intentionally NOT required (see canClearRaw).
function canClearRawFrame(id, { dumpMap, checkpoint }) {
  const hasDetectionDump = resolveDump(id, dumpMap) != null;
  const entry = checkpoint?.frames?.[id];
  const hasLedgerEntry = !!entry && (entry.status === 'complete' || entry.status === 'partial');
  return canClearRaw(id, { hasDetectionDump, hasLedgerEntry });
}

const BINDING_CONFIG = 'tools/validation/cr2_binding.config.ts';

// ── STAGE 2: truth (auto-switch on astrometry.net) ───────────────────────────
function probeTruthInstall() {
  const r = node('tools/overnight/astrometry_truth.mjs', ['--check-install'], {}, 45000);
  return { green: r.code === 0, detail: (r.stdout || r.stderr || '').trim().split('\n').slice(0, 6) };
}
function runTruth(frameAbs, id, cpulimit, pixelScale) {
  const args = [frameAbs, '--frame-id', id, '--cross-check', '--json', '--cpulimit', String(cpulimit)];
  // Bounded scale PRIOR: pass the manifest's known pixel scale so solve-field's
  // blind search skips the wrong scales. Absent ⇒ omitted ⇒ a BLIND solve. A hint
  // only accelerates the search; solve-field's quad-hash verify stays sole arbiter.
  const ps = Number(pixelScale);
  const hinted = Number.isFinite(ps) && ps > 0;
  if (hinted) args.push('--pixel-scale', String(ps));
  // WALL budget for the 2-PASS oracle: astrometry_truth may run solve-field TWICE
  // (LITE pass-1 → on a genuine no-solve, HEAVY pass-2), and EACH pass has its own
  // internal spawn timeout of (cpulimit + 60)s. A flat (cpulimit + 90)s wall
  // guillotined pass-2 on RICH-SLOW fields (e.g. Andromeda M31 died at exactly the
  // 210s cap while genuinely solvable) — so the wrapper must outlast BOTH passes:
  // 2·(cpulimit + 60) + headroom for node/WSL relay + JSON parse. This is a wrapper
  // WALL only — it never touches solve-field's own --cpulimit or the LITE/HEAVY cfgs.
  const r = node('tools/overnight/astrometry_truth.mjs', args, {}, (2 * cpulimit + 180) * 1000);
  let parsed = null;
  try { const s = r.stdout.indexOf('{'); if (s >= 0) parsed = JSON.parse(r.stdout.slice(s)); } catch { /* honest-absent */ }
  const solved = !!(parsed && parsed.solved);
  const verdict = parsed?.cross_check?.verdict ?? (solved ? 'SOLVED_NO_CROSSCHECK' : 'NO_SOLVE');
  const scaleHint = parsed?.scale_hint ?? { used: hinted, source: hinted ? 'pixel-scale' : 'none' };
  return { code: r.code, solved, verdict, ms: r.ms, scaleHint };
}

// ── STAGE 3: solve A/B via the existing CR2 binding + the sweep's merge ───────
// COMPOSITION NOTE: run_cr2_sweep.ts spawns its arm vitest via `npx.cmd` with
// {shell:false}, which cannot launch a .cmd on this Windows box (the arm exits
// null → it silently only re-merges stale raw). So the driver drives the SAME
// committed binding config (cr2_binding.config.ts) by invoking vitest's JS entry
// directly with node (no shell) and the SAME env contract the wrapper documents
// (SOLVER_UW_ANCHOR_CANDIDATES, CR2_DUMPS, CR2_BUDGET_MS, CR2_OUTDIR), then
// delegates the ledger build to the wrapper's own `--merge-only` (pure Node,
// works). We reimplement NO solve/merge logic — only the arm-spawn glue, and
// only because the wrapper's spawn is Windows-broken.
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
function runArmBinding(arm, dumpRelPaths, budgetMs) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [VITEST_BIN, 'run', '-c', BINDING_CONFIG], {
    cwd: ROOT, encoding: 'utf8', timeout: undefined,
    env: {
      ...process.env,
      SOLVER_UW_ANCHOR_CANDIDATES: String(arm),
      CR2_DUMPS: dumpRelPaths.join(','),
      CR2_BUDGET_MS: String(budgetMs),
      CR2_OUTDIR: RAW_DIR,
    },
  });
  return { code: res.status, ms: Date.now() - started };
}
/** Build the uw_anchor_topN ledger from all raw arm results (the wrapper's merge). */
function mergeLedger() {
  return node('tools/validation/run_cr2_sweep.ts', ['--merge-only'], {}, 180000);
}

// ── STAGE 3 (FITS): solve A/B via the fits_binding config + the fits sweep merge ─
// The FITS rail drives the REAL narrow wizard solve (runWizardPipeline) and grades
// it against oracle truth. SOLVER_FITS_VALIDATION_ARM is an IDENTITY seam (0≡1 →
// byte-identical solve), so both arms exercise the seam and the value is the OFF-arm
// truth verdict, not a lever win. Same Windows-safe direct-vitest spawn as the CR2
// route (run_fits_sweep.ts's own arm spawn is npx.cmd {shell:false}, broken here).
const FITS_BINDING_CONFIG = 'tools/validation/fits_binding.config.ts';
function runFitsArmBinding(arm, dumpRelPaths) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [VITEST_BIN, 'run', '-c', FITS_BINDING_CONFIG], {
    cwd: ROOT, encoding: 'utf8', timeout: undefined,
    env: {
      ...process.env,
      SOLVER_FITS_VALIDATION_ARM: String(arm),
      FITS_DUMPS: dumpRelPaths.join(','),
      FITS_OUTDIR: FITS_RAW_DIR,
    },
  });
  return { code: res.status, ms: Date.now() - started };
}
/** Build the fits_solve truth-adjudicated ledger from the raw arm results. */
function mergeFitsLedger() {
  return node('tools/validation/run_fits_sweep.ts', ['--merge-only'], {}, 180000);
}
/** Map a FITS raw arm result → a per-frame solve record (locked + truth + psf). */
function classifyFitsSolve(raw) {
  if (!raw) return { taxonomy: FAILURE.SOLVE_FAIL, reason: 'missing FITS arm', solved: null };
  if (raw.threw) return { taxonomy: FAILURE.SOLVE_FAIL, reason: `arm threw: ${raw.threw}`, solved: { locked: !!raw.locked } };
  const psf = raw.provenance?.psf_attribution ?? null;
  return {
    taxonomy: FAILURE.OK,
    reason: '',
    solved: {
      locked: !!raw.locked, ra: raw.ra ?? null, dec: raw.dec ?? null,
      scale: raw.pixel_scale_arcsec ?? null, matched: raw.matched ?? 0, ms: raw.wall_ms ?? null,
      psf_tracking: psf?.tracking?.inference ?? null,
    },
  };
}

// ── STAGE 5: render — CR2 via the A/B contact sheet, FITS via the FITS lane ───
// contact_sheet.mjs is the CR2 A/B-arm visualiser (enumerated from _cr2_raw,
// SKIPs any frame lacking both arm outcomes), so it cannot render a FITS frame;
// FITS frames go through the sibling FITS render lane instead (no _cr2_raw / no
// ledger contamination — see fits_contact_sheet.mjs header).
function runRender(id) {
  return node('tools/validation/visual/contact_sheet.mjs', [id], {}, 0);
}
function runFitsRender(id, truthVerdict, truthMs) {
  const args = [id];
  if (truthVerdict) args.push('--truth', truthVerdict);
  if (truthMs != null) args.push('--truth-ms', String(truthMs));
  return node('tools/overnight/fits_contact_sheet.mjs', args, {}, 180000);
}

// ── STAGE 4: grade (cohort read; pure) ────────────────────────────────────────
function runGrade(candidate) {
  const grad = node('tools/validation/check_graduation.ts', [candidate], {}, 60000);
  const tools = node('tools/validation/grade_tools.ts', ['--candidate', candidate], {}, 60000);
  return {
    graduation: grad.stdout.trim().split('\n'),
    grade_tools: tools.stdout.trim().split('\n'),
  };
}

// ── the run ───────────────────────────────────────────────────────────────────
function main() {
  const started = Date.now();
  const a = parseArgs(process.argv.slice(2));
  const dryRun = !!a['dry-run'];
  const limit = a.limit != null ? parseInt(a.limit, 10) : undefined;
  const frames = a.frames ? String(a.frames).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const force = a.force ? true : undefined;
  const truthMode = a['truth-mode'] ?? 'auto';   // off | auto | on
  const truthCpulimit = a['truth-cpulimit'] != null ? parseInt(a['truth-cpulimit'], 10) : 120;

  // ── STAGE 0: intake (opt-in unattended ingestion at loop START) ─────────────
  // OPT-IN via --intake (a bare/dev run never surprise-fetches, even with an
  // intake_sources.json present). --intake-config overrides the source-config;
  // --intake-dry-run resolves the plan without downloading. Skipped on a pipeline
  // --dry-run (fetching is execution). Signed-provenance path is preserved (subprocess).
  const intakeConfigPath = a['intake-config'] ? path.resolve(a['intake-config']) : DEFAULT_INTAKE_CONFIG;
  const intakeDecision = decideIntakeAction({
    enabled: !!a.intake, configPath: intakeConfigPath, configExists: fs.existsSync(intakeConfigPath),
  });
  let intake = null;
  if (a.intake && !dryRun) {
    if (intakeDecision.run) {
      console.log('═══ STAGE 0 intake (loop start) ═══');
      intake = runIntake({ configPath: intakeConfigPath, dryRun: !!a['intake-dry-run'] });
      console.log(`  fetch_intake exit=${intake.exit} ${(intake.ms / 1000).toFixed(0)}s  (config ${path.relative(ROOT, intakeConfigPath)})`);
      for (const l of intake.summary) console.log(`    ${l}`);
      console.log('  NOTE: new frames need a manifest regen to become eligible (see fetch_intake next-steps).\n');
    } else {
      intake = { skipped: true, reason: intakeDecision.reason, config: intakeConfigPath };
      console.log(`  intake requested but ${intakeDecision.reason} (${path.relative(ROOT, intakeConfigPath)}) — no-op (no surprise-fetch).\n`);
    }
  }

  const config = {
    ...DEFAULT_CONFIG,
    candidate: a.candidate ?? DEFAULT_CONFIG.candidate,
    budget_ms: a.budget != null ? parseInt(a.budget, 10) : DEFAULT_CONFIG.budget_ms,
    mp_ceiling: a['mp-ceiling'] != null ? parseFloat(a['mp-ceiling']) : DEFAULT_CONFIG.mp_ceiling,
  };
  const hash = configHash(config);

  if (!fs.existsSync(MANIFEST)) { console.error(`manifest not found: ${MANIFEST}`); process.exit(1); }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const pathMap = buildPathMap(manifest);
  const dumpMap = buildDumpMap(manifest);
  const typeMap = buildTypeMap(manifest);
  const scaleMap = buildScaleMap(manifest);
  const checkpoint = loadCheckpoint();

  // manifest-aware planner predicates (injected into the pure planner):
  //  • hasDump           → dump resolves via manifest dump_path (CR2 or FITS cohort)
  //  • isCr2             → does the CR2 A/B anchor-lever solve apply to this frame?
  //  • artifactsPresent  → CR2: solve arms + render; FITS: render PNG (solve is n/a)
  const hasDump = (id) => resolveDump(id, dumpMap) != null;
  const isCr2 = (id) => isCr2SolveApplicable(typeMap.get(id.toLowerCase()));
  const isFits = (id) => isFitsSolveApplicable(typeMap.get(id.toLowerCase()));
  //  • artifactsPresent  → CR2: solve arms + render; FITS: solve raw + render; else: render
  const artifactsPresent = (id) =>
    isCr2(id) ? (solvePresent(id) && renderPresent(id))
    : isFits(id) ? (fitsSolvePresent(id) && renderPresent(id))
    : renderPresent(id);

  const plan = computePlan({
    manifestImages: manifest.images, checkpoint, config, hasDump, artifactsPresent,
    opts: { limit, frames, force },
  });

  // taxonomy tally over the whole corpus (honest-or-absent picture)
  const skipTally = {};
  for (const s of plan.skipped) skipTally[s.taxonomy] = (skipTally[s.taxonomy] ?? 0) + 1;

  console.log('═══ OVERNIGHT PIPELINE — plan ═══');
  console.log(`  config hash    : ${hash}   run #${plan.runIndex}   truth-mode=${truthMode}`);
  console.log(`  corpus images  : ${manifest.images.length}`);
  console.log(`  eligible       : ${plan.eligible.length}  (dump + ≤${config.mp_ceiling}MP)`);
  console.log(`  skipped        : ${plan.skipped.length}  ${JSON.stringify(skipTally)}`);
  console.log(`  status buckets : ` +
    ['never', 'stale', 'current'].map((s) => `${s}=${plan.eligible.filter((e) => e.status === s).length}`).join('  '));
  console.log(`  TO RUN         : ${plan.toRun.length}${limit != null ? ` (--limit ${limit})` : ''}`);
  if (plan.toRun.length) console.log(`    ${plan.toRun.join(', ')}`);

  if (dryRun) {
    console.log('\n  [--dry-run] plan only; no execution.');
    const rep = { generated_at: new Date().toISOString(), dry_run: true, config_hash: hash,
      run_index: plan.runIndex, intake: intake ?? null, eligible: plan.eligible.length, skipped: plan.skipped,
      to_run: plan.toRun, skip_tally: skipTally };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(REPORT, stableStr(rep), 'utf8');
    console.log(`  report → ${REPORT}`);
    process.exit(0);
  }

  // Build the next checkpoint from the prior one (adopt current frames so the
  // rotation state + idempotency survive). `putFrame` compares SUBSTANTIVE
  // content (ignoring last_run_index) so an unchanged frame never churns — a
  // pure no-op leaves the file byte-identical (run_index only advances on work).
  const cp = checkpoint && checkpoint.frames
    ? JSON.parse(JSON.stringify(checkpoint))
    : { schema: DEFAULT_CONFIG.schema, config_hash: hash, run_index: 0, frames: {} };
  cp.config_hash = hash;
  let mutated = false;
  function putFrame(id, entry) {
    const prev = cp.frames[id];
    if (prev) {
      const a = { ...prev }; const b = { ...entry };
      delete a.last_run_index; delete b.last_run_index;
      if (JSON.stringify(a) === JSON.stringify(b)) return; // unchanged → keep prior (no churn)
    }
    cp.frames[id] = { ...entry, last_run_index: plan.runIndex };
    mutated = true;
  }

  const perFrame = [];

  // ── adopt already-current eligible frames (idempotent; no tools invoked) ────
  // Only frames WITHOUT a current-config entry get an adopted placeholder; a
  // frame that was really run before (real stage detail) is left untouched.
  for (const e of plan.eligible) {
    if (e.status === 'current' && !plan.toRun.includes(e.id)) {
      const existing = cp.frames[e.id];
      if (existing && existing.config_hash === hash) continue;
      putFrame(e.id, {
        config_hash: hash, status: 'complete',
        image_type: e.image_type, failure_taxonomy: FAILURE.OK, adopted: true,
        stages: { ingest: 'adopted', truth: 'n/a', solve: 'adopted', render: 'adopted', knob: 'deferred' },
      });
    }
  }
  // record corpus-wide skips (OOM / no-dump) in the checkpoint (honest picture)
  for (const s of plan.skipped) {
    putFrame(s.id, {
      config_hash: hash, status: 'skipped',
      image_type: s.image_type, megapixels: s.megapixels,
      failure_taxonomy: s.taxonomy, skip_reason: s.skip_reason,
    });
  }

  if (plan.toRun.length === 0) {
    if (mutated) cp.run_index = plan.runIndex;
    const changed = writeCheckpointIfChanged(cp);
    console.log(`\n  nothing to run — ${changed ? 'checkpoint updated (adopted pre-existing artifacts)' : 'NO-OP (checkpoint byte-identical)'}.`);
    writeReport({ started, hash, plan, truthMode, skipTally, perFrame, grade: null, intake, noop: !changed });
    process.exit(0);
  }

  // ── STAGE 2 probe (once) ────────────────────────────────────────────────────
  let install = { green: false, detail: ['(truth-mode off)'] };
  if (truthMode !== 'off') { install = probeTruthInstall(); }
  console.log(`\n  truth install  : ${install.green ? 'GREEN (astrometry.net reachable)' : 'ABSENT → NO_TRUTH'}`);

  // ── STAGES 1+2 per frame (ingest + truth) ───────────────────────────────────
  for (const id of plan.toRun) {
    const rec = { id, taxonomy: FAILURE.OK, stages: {}, timings_ms: {} };
    try {
      // 1. ingest
      const t0 = Date.now();
      const src = resolveSource(id, pathMap);
      const dump = hasDump(id);
      rec.stages.ingest = { source: src ? path.relative(ROOT, src) : null, dump };
      rec.timings_ms.ingest = Date.now() - t0;
      if (!src) { rec.taxonomy = FAILURE.NO_DUMP; rec.stages.ingest.note = 'source unresolved'; }
      // 2. truth
      const cached = cp.frames[id]?.truth_verdict ?? null;
      const action = decideTruthAction(install.green, truthMode, cached);
      if (action === 'use' && src) {
        const ps = scaleMap.get(id.toLowerCase()) ?? null;   // known pixel scale → bounded prior (null ⇒ blind)
        const tr = runTruth(src, id, truthCpulimit, ps);
        rec.stages.truth = { action, verdict: tr.verdict, solved: tr.solved, scale_hint: tr.scaleHint };
        rec.timings_ms.truth = tr.ms;
        rec.truth_verdict = tr.verdict;
        if (!tr.solved) rec.taxonomy = rec.taxonomy === FAILURE.OK ? FAILURE.NO_TRUTH : rec.taxonomy;
      } else if (action === 'cached') {
        rec.stages.truth = { action, verdict: cached }; rec.truth_verdict = cached;
      } else {
        rec.stages.truth = { action: 'no-truth', verdict: 'NO_TRUTH' };
        if (rec.taxonomy === FAILURE.OK) rec.taxonomy = FAILURE.NO_TRUTH;
      }
    } catch (e) {
      rec.taxonomy = FAILURE.SOLVE_FAIL; rec.error = String(e?.message || e);
    }
    perFrame.push(rec);
  }

  // ── STAGE 3: solve A/B — CR2 anchor-lever + FITS solve-vs-truth rail ──────────
  // Frames that are NEITHER a CR2 nor a FITS solve target (JPG_DERIVED / REJMAP
  // artifacts) mark their solve stage n/a up front: skipped honestly, never a
  // failure, never a fabricated solve. CR2 and FITS each read their OWN cohort dirs
  // (cr2_dets/_cr2_raw vs fits_dets/_fits_raw) so the two rails never cross-contaminate.
  for (const rec of perFrame) {
    if (!isCr2(rec.id) && !isFits(rec.id)) rec.stages.solve = { na: true, reason: 'skipped:not-a-solve-target' };
  }
  const cr2ToRun = plan.toRun.filter((id) => isCr2(id));
  if (cr2ToRun.length === 0) {
    console.log('\n  STAGE 3 solve  : no CR2 frames in this slice — solve-A/B n/a (FITS truth+render only).');
  } else {
    const needSolve = cr2ToRun.filter((id) => force || !solvePresent(id));
    if (needSolve.length) {
      const dumps = needSolve.map((id) => `test_results/cr2_dets/${id}.app.json`);
      console.log(`\n  STAGE 3 solve  : ${needSolve.length} CR2 frame(s) → binding OFF(anchor#${config.arms.off}) + ON(anchor#${config.arms.on}) + merge`);
      console.log(`    ${needSolve.join(', ')}`);
      const armOff = runArmBinding(config.arms.off, dumps, config.budget_ms);
      const armOn = runArmBinding(config.arms.on, dumps, config.budget_ms);
      const mg = mergeLedger();
      const solveMs = armOff.ms + armOn.ms;
      console.log(`    OFF exit=${armOff.code} ${(armOff.ms / 1000).toFixed(0)}s · ON exit=${armOn.code} ${(armOn.ms / 1000).toFixed(0)}s · merge exit=${mg.code}`);
      for (const rec of perFrame) {
        if (!isCr2(rec.id) || !plan.toRun.includes(rec.id)) continue;
        const off = readRawArm('anchor1', rec.id), on = readRawArm('anchor3', rec.id);
        const cs = classifySolve(off, on);
        rec.stages.solve = { off: cs.off, on: cs.on, ledger: fs.existsSync(LEDGER_FILE), ms: solveMs };
        if (cs.taxonomy !== FAILURE.OK) rec.taxonomy = cs.taxonomy;
      }
    } else {
      console.log('\n  STAGE 3 solve  : all CR2 target frames already solved (raw present) — skip sweep.');
      for (const rec of perFrame) {
        if (!isCr2(rec.id)) continue;
        const off = readRawArm('anchor1', rec.id), on = readRawArm('anchor3', rec.id);
        const cs = classifySolve(off, on);
        rec.stages.solve = { off: cs.off, on: cs.on, ledger: fs.existsSync(LEDGER_FILE), reused: true };
        if (cs.taxonomy !== FAILURE.OK && rec.taxonomy === FAILURE.OK) rec.taxonomy = cs.taxonomy;
      }
    }
  }

  // ── STAGE 3 (FITS): solve-vs-truth rail — the REAL narrow wizard solve ───────
  // A FITS frame past the isFits gate runs the fits_binding OFF(arm0)/ON(arm1) +
  // fits merge (truth-adjudicated ledger + PSF-attribution adjudication). Identity
  // seam → both arms byte-identical; the value is the per-frame TRUTH verdict.
  const fitsToRun = plan.toRun.filter((id) => isFits(id));
  if (fitsToRun.length === 0) {
    if (cr2ToRun.length === 0) console.log('\n  STAGE 3 FITS   : no FITS frames in this slice — FITS solve-A/B n/a.');
  } else {
    const needFits = fitsToRun.filter((id) => force || !fitsSolvePresent(id));
    if (needFits.length) {
      const dumps = needFits.map((id) => path.relative(ROOT, resolveDump(id, dumpMap)).split(path.sep).join('/'));
      console.log(`\n  STAGE 3 FITS   : ${needFits.length} FITS frame(s) → fits_binding OFF(arm0) + ON(arm1) + merge (real wizard solve vs truth)`);
      console.log(`    ${needFits.join(', ')}`);
      const armOff = runFitsArmBinding(0, dumps);
      const armOn = runFitsArmBinding(1, dumps);
      const mg = mergeFitsLedger();
      const fitsMs = armOff.ms + armOn.ms;
      console.log(`    OFF(arm0) exit=${armOff.code} ${(armOff.ms / 1000).toFixed(0)}s · ON(arm1) exit=${armOn.code} ${(armOn.ms / 1000).toFixed(0)}s · merge exit=${mg.code}`);
      const fitsTruth = readFitsTruthDetail();   // merge just wrote it — the label verdicts live here
      const fitsForced = readFitsForcedDetail(); // THIRD column: forced-photometry confirmation (report-only)
      for (const rec of perFrame) {
        if (!isFits(rec.id) || !plan.toRun.includes(rec.id)) continue;
        const raw = readFitsArm(0, rec.id) ?? readFitsArm(1, rec.id);
        const cs = classifyFitsSolve(raw);
        rec.stages.solve = { fits: cs.solved, ledger: fs.existsSync(FITS_LEDGER_FILE), ms: fitsMs };
        if (cs.taxonomy !== FAILURE.OK && rec.taxonomy === FAILURE.OK) rec.taxonomy = cs.taxonomy;
        applyFitsTruth(rec, raw, fitsTruth);   // surface the GOLD/COARSE label verdict (bug fix)
        applyFitsForced(rec, fitsForced);      // surface the forced-photometry verdict (report-only, NON-GATING)
      }
    } else {
      console.log('\n  STAGE 3 FITS   : all FITS target frames already solved (raw present) — skip sweep.');
      const fitsTruth = readFitsTruthDetail();   // reuse the merge detail from when these frames were solved
      const fitsForced = readFitsForcedDetail(); // THIRD column: forced-photometry confirmation (report-only)
      for (const rec of perFrame) {
        if (!isFits(rec.id)) continue;
        const raw = readFitsArm(0, rec.id) ?? readFitsArm(1, rec.id);
        const cs = classifyFitsSolve(raw);
        rec.stages.solve = { fits: cs.solved, ledger: fs.existsSync(FITS_LEDGER_FILE), reused: true };
        if (cs.taxonomy !== FAILURE.OK && rec.taxonomy === FAILURE.OK) rec.taxonomy = cs.taxonomy;
        applyFitsTruth(rec, raw, fitsTruth);   // surface the GOLD/COARSE label verdict (bug fix)
        applyFitsForced(rec, fitsForced);      // surface the forced-photometry verdict (report-only, NON-GATING)
      }
    }
  }

  // ── STAGE 5: render (per frame; skip if PNG current) ────────────────────────
  console.log('\n  STAGE 5 render :');
  for (const rec of perFrame) {
    if (rec.taxonomy === FAILURE.SOLVE_FAIL) { rec.stages.render = { skipped: 'solve-fail' }; continue; }
    if (!force && renderPresent(rec.id)) { rec.stages.render = { reused: true, pngs: renderPngs(rec.id) }; continue; }
    const rr = isCr2(rec.id) ? runRender(rec.id) : runFitsRender(rec.id, rec.truth_verdict, rec.timings_ms.truth);
    rec.timings_ms.render = rr.ms;
    if (rr.code === 0 && renderPresent(rec.id)) {
      rec.stages.render = { pngs: renderPngs(rec.id) };
      console.log(`    ${rec.id}: ${renderPngs(rec.id).join(', ')}`);
    } else {
      rec.stages.render = { failed: true };
      if (rec.taxonomy === FAILURE.OK || rec.taxonomy === FAILURE.NO_TRUTH) rec.taxonomy = FAILURE.RENDER_FAIL;
      console.log(`    ${rec.id}: RENDER_FAIL (exit ${rr.code})`);
    }
  }

  // ── STAGE 6: knob-tune / harvest — STUB (clean seams per the doc) ────────────
  console.log('\n  STAGE 6 knob-tune/harvest : deferred (recommender-only sandbox; harvest-before-clear gate) — NOT WIRED.');
  for (const rec of perFrame) rec.stages.knob = 'deferred';

  // ── commit per-frame results into the checkpoint ────────────────────────────
  for (const rec of perFrame) {
    const complete = rec.taxonomy === FAILURE.OK || rec.taxonomy === FAILURE.NO_TRUTH;
    putFrame(rec.id, {
      config_hash: hash,
      status: complete ? 'complete' : 'partial',
      image_type: typeMap.get(rec.id.toLowerCase()) ?? 'UNKNOWN', failure_taxonomy: rec.taxonomy,
      truth_verdict: rec.truth_verdict ?? null,
      truth_tier: rec.truth_tier ?? null,   // GOLD vs COARSE — recorded so tiers are never conflated
      stages: rec.stages, timings_ms: rec.timings_ms,
    });
  }

  // ── HARVEST-BEFORE-CLEAR green light (report-only; NEVER deletes a raw frame) ─
  // Owner directive: "harvest + verify → safe-to-clear green light, NEVER auto-delete."
  // Nothing in the rig clears raw today, so this is a PRE-EMPTIVE guard: every future
  // clear/rotation path MUST consult canClearRawFrame first. Here we only SURFACE the
  // per-frame green light (safe_to_clear + any missing durable artifacts) into the report.
  for (const rec of perFrame) {
    rec.safe_to_clear = canClearRawFrame(rec.id, { dumpMap, checkpoint: cp });
  }

  // ── STAGE 4: grade (cohort read) — the config candidate AND the FITS candidate ─
  // The CR2 lever (config.candidate) grades on its cohort; the FITS solve-vs-truth
  // rail (fits_solve) grades on the FITS cohorts. Grading BOTH is what turns FITS
  // from "gets a label" into "our solver is scored against truth" in the report.
  console.log('\n  STAGE 4 grade  :');
  const grade = runGrade(config.candidate);
  for (const line of grade.graduation) console.log(`    ${line}`);
  const fitsGrade = runGrade(FITS_CANDIDATE);
  console.log(`  ── fits_solve (solver-vs-truth) ──`);
  for (const line of fitsGrade.graduation) console.log(`    ${line}`);

  if (mutated) cp.run_index = plan.runIndex;
  writeCheckpointIfChanged(cp);
  console.log(`\n  checkpoint → ${CHECKPOINT}`);
  writeReport({ started, hash, plan, truthMode, skipTally, perFrame, grade: { ...grade, fits_solve: fitsGrade }, install, intake, noop: false });
  console.log(`  report     → ${REPORT}`);

  // ── final summary ───────────────────────────────────────────────────────────
  const taxTally = {};
  for (const r of perFrame) taxTally[r.taxonomy] = (taxTally[r.taxonomy] ?? 0) + 1;
  console.log('\n═══ SUMMARY ═══');
  console.log(`  ran ${perFrame.length} frame(s)   taxonomy ${JSON.stringify(taxTally)}   corpus-skips ${JSON.stringify(skipTally)}`);
  console.log(`  elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

function writeReport({ started, hash, plan, truthMode, skipTally, perFrame, grade, install, intake, noop }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const taxTally = {};
  for (const r of perFrame) taxTally[r.taxonomy] = (taxTally[r.taxonomy] ?? 0) + 1;
  const rep = {
    generated_at: new Date().toISOString(),        // DATA field (report only, not an idempotency key)
    config_hash: hash, run_index: plan.runIndex, truth_mode: truthMode,
    noop: !!noop,
    intake: intake ?? null,                        // STAGE 0 fetch summary (null when not requested)
    install: install ?? null,
    eligible: plan.eligible.length,
    corpus_skip_tally: skipTally,
    corpus_skips: plan.skipped,
    ran_taxonomy_tally: taxTally,
    frames: perFrame,
    grade: grade ?? null,
    elapsed_s: (Date.now() - started) / 1000,
  };
  fs.writeFileSync(REPORT, stableStr(rep), 'utf8');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error('FATAL', e?.stack || String(e)); process.exit(1); }
}

export { buildDumpMap, resolveDump, buildTypeMap, buildScaleMap, solvePresent, renderPresent, renderPngs, resolveSource, buildPathMap, readFitsTruthDetail, readFitsForcedDetail, readFitsArm, canClearRawFrame, runIntake };
