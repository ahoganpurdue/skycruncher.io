#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/run.mjs — single command-loaded entrypoint (SCAFFOLD, Stage 12)
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN.md §6: one deterministic command loads a declared suite, builds/
// loads its manifest, resolves env, (Stage 13) dispatches an executor, writes a
// sha-keyed ledger + receipts + summary, and exits. No agent, no poller.
//
//   node tools/testkit/run.mjs <suite> [--label QUIET-BASELINE|THROUGHPUT]
//        [--manifest-only] [--shard k/N] [--resume] [--select <files>]
//
// STAGE 12 SCOPE: descriptor load · env resolve · manifest build/load · label
//   enforcement · deterministic sharding · MANIFEST-ONLY write.
// STAGE 13 (WIRED, this file): the executor dispatch now iterates the resolved
//   executor's rows, hands each (row, env, paths) to lib/executors/<name>.mjs,
//   deposits a self-describing row per result (tools/db/deposit.mjs), and writes a
//   summary + RUN_DONE. ALL FIVE executors are REAL (solve_to_receipt · api_smoke ·
//   e2e_scenario · golden_vector · stage_replay — the last became real with the
//   seam wave, SEAM_CONTRACT v1 §5). Exit 3 is PRESERVED as the honest verdict for
//   a stage_replay run that resolves ZERO replayable rows (no capsules under
//   seams_root, or the suite requested only NOT-YET-REPLAYABLE stages) — never a
//   fabricated green. `--manifest-only` is UNCHANGED.
//
// SEAMS:
//   • DEPOSIT SEAM — each executor deposits through tools/db/deposit.mjs
//     (depositResult; run_label REQUIRED). run.mjs never writes the store by hand.
//   • EXECUTOR SEAM — tools/testkit/lib/executors/<name>.mjs. Each takes
//     (frame|scenario row, env, paths) → an outcome record + deposits one row.
//   • HEAVY-LANE LOCK — held by the SESSION that launches this run ("adopt at
//     spawn", tools/ops/heavy_lane_lock.mjs @6e26adb). run.mjs does NOT re-acquire
//     it: a second acquire under a different account would be refused and false-fail
//     the battery. The caller owns the lease.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEnv, assertLabel, hostBox, forbidColdPath } from './lib/env.mjs';
import { buildManifest, distribution } from './lib/manifest.mjs';
import { EXECUTORS, planRows, STAGE_REPLAY_NAME } from './lib/executors/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// §6 executors — all five REAL as of the seam wave (historical stub ledger kept
// for the exported shape; descriptions now state what each one DOES).
const STUB_EXECUTORS = {
  solve_to_receipt: 'drive the real headless wizard pipeline per frame → receipt (retires run_corpus.mjs duplicate solve loop)',
  stage_replay: 'replay one frozen seam capsule\'s stage against the post-stage capsule, IEEE-exact (SEAM_CONTRACT v1 §5)',
  e2e_scenario: 'wrap SeeStar/CR2 e2e runners (owns Vite prewarm + port alloc + Chrome channel) → sha-keyed row',
  golden_vector: 'wrap check_layout_contracts.mjs (LAW 7) → rows in the unified store',
  api_smoke: 'wrap the apispec harness → rows in the unified store',
};

function parseArgs(argv) {
  const opts = { suite: null, label: null, manifestOnly: false, shard: null, resume: false, select: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') opts.label = argv[++i];
    else if (a === '--manifest-only') opts.manifestOnly = true;
    else if (a === '--shard') opts.shard = argv[++i];
    else if (a === '--resume') opts.resume = true;
    else if (a === '--select') opts.select = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('-') && !opts.suite) opts.suite = a;
    else return { error: `unknown or misplaced argument: ${a}` };
  }
  return { opts };
}

// deterministic shard split by sorted frame-sha (§6: "sha conflict = investigate")
function applyShard(frames, shardSpec) {
  const m = /^(\d+)\/(\d+)$/.exec(shardSpec);
  if (!m) throw new Error(`--shard expects k/N (e.g. 1/4), got "${shardSpec}"`);
  const k = +m[1], N = +m[2];
  if (k < 1 || k > N) throw new Error(`--shard k must be 1..N, got ${k}/${N}`);
  const ordered = [...frames].sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  return ordered.filter((_, i) => (i % N) === (k - 1));
}

// DEPOSIT SEAM (documented; NOT invoked here). The day-lane wiring passes the
// written ledger + summary paths to tools/db/deposit.mjs, which keys rows by
// frame content-sha into the unified store. run.mjs deliberately does not import
// or call it (sibling surgeon owns the module) — this returns the contract only.
function depositSeam(paths) {
  return {
    module: 'tools/db/deposit.mjs',
    status: 'DEFERRED_TO_DAY_LANE',
    contract: 'deposit({ ledger, summary, label, box }) → sha-keyed rows; run.mjs never writes the store directly',
    would_deposit: paths,
  };
}

async function loadSuite(name, env) {
  const file = path.join(HERE, 'suites', `${name}.suite.json`);
  if (!fs.existsSync(file)) {
    const avail = fs.existsSync(path.join(HERE, 'suites'))
      ? fs.readdirSync(path.join(HERE, 'suites')).filter((f) => f.endsWith('.suite.json')).map((f) => f.replace('.suite.json', ''))
      : [];
    throw new Error(`no suite descriptor "${name}" at ${file}. available: ${avail.length ? avail.join(', ') : '(none)'}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main(argv) {
  const { opts, error } = parseArgs(argv);
  if (error) { console.error(`run: ${error}`); return 2; }
  if (opts.help || !opts.suite) {
    console.log('Usage: node tools/testkit/run.mjs <suite> [--label QUIET-BASELINE|THROUGHPUT] [--manifest-only] [--shard k/N] [--resume] [--select <files>]');
    console.log(`suites dir: ${path.join('tools', 'testkit', 'suites')}`);
    return opts.help ? 0 : 2;
  }

  const env = resolveEnv();
  let suite;
  try { suite = await loadSuite(opts.suite, env); }
  catch (e) { console.error(`run: ${e.message}`); return 2; }

  const label = opts.label ?? suite.default_label;
  try {
    assertLabel(label, env);
    forbidColdPath(env);
  } catch (e) { console.error(`run: ${e.message}`); return 2; }

  console.log(`[run] suite=${opts.suite} label=${label} lane=${suite.lane ?? 'heavy'} box=${env.platform}/${hostBox().box}`);

  // ── resolve the executor up front (drives whether a manifest is needed) ──────
  const wanted = suite.executor ?? 'solve_to_receipt';
  const ex = EXECUTORS[wanted];
  if (!ex) {
    console.error(`run: unknown executor "${wanted}". available: ${Object.keys(EXECUTORS).join(', ')}`);
    return 2;
  }
  const needFrames = ex.iterates === 'frames';

  // ── manifest build / load (only when the executor iterates frames, OR when
  //    --manifest-only is requested — the gate lanes don't enumerate the corpus) ─
  let manifest = null;
  if (needFrames || opts.manifestOnly) {
    const src = suite.manifest ?? {};
    let manifestCfg = { label, now: undefined };
    if (src.source === 'none') {
      console.error(`run: suite "${opts.suite}" declares manifest.source="none" (executor "${wanted}" iterates ${ex.iterates}); --manifest-only needs a frame-enumerating suite`);
      return 2;
    } else if (src.source === 'frames' && src.path) {
      const framesPath = path.isAbsolute(src.path) ? src.path : path.join(env.root, src.path);
      if (!fs.existsSync(framesPath)) { console.error(`run: manifest frames file not found: ${framesPath}`); return 2; }
      const prior = JSON.parse(fs.readFileSync(framesPath, 'utf8'));
      manifestCfg.frames = Array.isArray(prior) ? prior : prior.frames;
    } else {
      // default: enumerate the samples root (drive-literal-free — env resolves it)
      manifestCfg.samples = suite.manifest?.root ? path.join(env.root, suite.manifest.root) : env.samples;
      if (!fs.existsSync(manifestCfg.samples)) { console.error(`run: samples root not found: ${manifestCfg.samples} (set TESTKIT_SAMPLES)`); return 2; }
    }

    try { manifest = await buildManifest(manifestCfg); }
    catch (e) { console.error(`run: manifest build failed: ${e.message}`); return 2; }

    let frames = manifest.frames;
    if (opts.shard) { try { frames = applyShard(frames, opts.shard); } catch (e) { console.error(`run: ${e.message}`); return 2; } }

    console.log(`[manifest] ${manifest.n_frames} frames · ${JSON.stringify(manifest.distribution)}`);
    if (opts.shard) console.log(`[shard] ${opts.shard} → ${frames.length} frames (deterministic sha split)`);

    // MANIFEST-ONLY: the one fully-working scaffold mode. Writes + exits 0. (UNCHANGED)
    if (opts.manifestOnly) {
      const outDir = path.join(env.testResults, `testkit_${opts.suite}`);
      fs.mkdirSync(outDir, { recursive: true });
      const out = path.join(outDir, 'manifest.json');
      fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
      console.log(`[manifest-only] wrote ${out}`);
      return 0;
    }
    // hand the planner the sharded frame subset
    manifest = { ...manifest, frames };
  }

  // ── STAGE 13 dispatch: iterate the executor's rows, deposit, roll up ─────────
  const outDir = path.join(env.testResults, `testkit_${opts.suite}`);
  fs.mkdirSync(outDir, { recursive: true });
  const runId = `${opts.suite}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const artifactDir = path.join(env.artifactRoot, `testkit_${opts.suite}`);
  const paths = {
    label, runId, root: env.root, shardCount: 1,
    ledgerPath: path.join(outDir, 'ledger.jsonl'),
    receiptsDir: path.join(artifactDir, 'receipts'),
    logsDir: path.join(artifactDir, 'logs'),
  };

  const rows = planRows(wanted, { suite, manifest, env });
  console.log(`[dispatch] executor=${wanted} rows=${rows.length} ledger=${path.relative(env.root, paths.ledgerPath).replace(/\\/g, '/')}`);

  const results = [];
  let red = 0;
  for (let i = 0; i < rows.length; i++) {
    let r;
    try {
      r = await ex.run(rows[i], env, paths);
    } catch (e) {
      // an executor THROW is itself a red (infrastructure failure); never swallow it
      console.error(`[${i + 1}/${rows.length}] EXECUTOR THREW: ${(e && e.stack) || e}`);
      red++;
      results.push({ outcome: 'executor_error', red: true });
      continue;
    }
    if (r.red) red++;
    results.push({ outcome: r.outcome, red: !!r.red });
    console.log(`[${i + 1}/${rows.length}] ${r.summary}`);
  }

  // summary rollup + RUN_DONE marker (§6: writes a summary, stamps a label, exits)
  const byOutcome = results.reduce((a, r) => { a[r.outcome] = (a[r.outcome] || 0) + 1; return a; }, {});
  const summaryOut = {
    schema: 'testkit.run_summary.v1',
    suite: opts.suite, executor: wanted, label, run_id: runId,
    box: { host: hostBox().box, platform: env.platform },
    generated: new Date().toISOString(),
    n_rows: rows.length, red_count: red, by_outcome: byOutcome,
    ledger: path.relative(env.root, paths.ledgerPath).replace(/\\/g, '/'),
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summaryOut, null, 2));
  fs.writeFileSync(path.join(outDir, 'RUN_DONE'), `${new Date().toISOString()} ${wanted} red=${red}/${rows.length}\n`);
  console.log(`\n[run] ${wanted} DONE — ${JSON.stringify(byOutcome)} · red=${red}/${rows.length} · summary → ${path.relative(env.root, path.join(outDir, 'summary.json')).replace(/\\/g, '/')}`);
  if (red > 0) return 1;

  // ── honest zero-replayable exit (SEAM_CONTRACT §5 exit codes) ────────────────
  // A stage_replay run that replayed NOTHING (no capsule dirs under seams_root,
  // or every planned row was a NOT-YET-REPLAYABLE skip) must not report green:
  // exit 3 = honestly nothing-replayed (distinct from red=1 / usage=2). The
  // summary above still records the honest by_outcome tally.
  if (wanted === STAGE_REPLAY_NAME) {
    const replayed = results.filter((r) => r.outcome !== 'skip_not_replayable').length;
    if (replayed === 0) {
      console.error(rows.length === 0
        ? `[run] stage_replay: ZERO capsule rows resolved (no capsules under the suite's seams_root — run the capture lane first: tools/testkit/capture_golden_seams.mjs, HEAVY lane). Exit 3, never a fabricated green.`
        : `[run] stage_replay: all ${rows.length} rows were skip_not_replayable (suite requested only NOT-YET-REPLAYABLE stages). Exit 3, never a fabricated green.`);
      return 3;
    }
  }
  return 0;
}

const invokedDirect = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
  catch { return true; }
})();
if (invokedDirect) main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error('[run FATAL]', e); process.exit(1); });

export { parseArgs, applyShard, depositSeam, STUB_EXECUTORS, main };
