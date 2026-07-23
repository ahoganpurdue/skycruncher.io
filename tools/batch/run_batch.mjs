#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// BATCH ENGINE — run_batch.mjs : thin CLI over the runBatch engine    task #24
// ═══════════════════════════════════════════════════════════════════════════
//
//   node tools/batch/run_batch.mjs [--out <dir>] [--config '<json>'] \
//        [--resume] [--checkpoint <batch_summary.json>] <fits...>
//
// Runs the REAL calibrated FITS wizard over N files IN ONE PROCESS and writes,
// under <out|test_results/batch>/:
//   • <frameId>.receipt.json   — canonical receipt bytes per file (byte-identical
//                                to a single tools/api/run.mjs solve)
//   • batch_ledger.jsonl       — one honest row per file as it completes (stream)
//   • batch_summary.json       — the full BatchLedger (counts + per-file rows)
//
// A plain .mjs cannot resolve the engine's `@/` alias, boot the compiled wasm, or
// run runWizardPipeline + snapshot/restore in ONE process, so — exactly like
// tools/api/run.mjs — this CLI forks ONE vitest process (run_batch.config.ts →
// run_batch.runspec.ts → the runBatch engine). run_batch.mjs owns arg parsing,
// the summary projection, and the exit code.
//
// EXIT CODES: 0 = batch completed, 0 errors · 3 = completed but ≥1 file errored ·
//             1 = infra failure (vitest fork failed / no summary written).
// A per-file no-solve is a valid OUTCOME (counted, never an error). FITS lane only.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const RUN_CONFIG = 'tools/batch/run_batch.config.ts';
const DEFAULT_OUT = path.join(ROOT, 'test_results', 'batch');

function die(msg, code = 1) {
    process.stderr.write(`[batch/run] ${msg}\n`);
    process.exit(code);
}

function parseArgs(argv) {
    const a = { out: null, config: null, resume: false, checkpoint: null, _: [] };
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (t === '--out') a.out = argv[++i];
        else if (t === '--config') a.config = argv[++i];
        else if (t === '--resume') a.resume = true;
        else if (t === '--checkpoint') a.checkpoint = argv[++i];
        else if (t.startsWith('--')) die(`unknown flag: ${t}`);
        else a._.push(t);
    }
    return a;
}

const a = parseArgs(process.argv.slice(2));
if (a._.length === 0) die('usage: node tools/batch/run_batch.mjs [--out <dir>] [--config <json>] [--resume] [--checkpoint <f>] <fits...>');

const files = a._.map((f) => path.resolve(f));
for (const f of files) {
    if (!fs.existsSync(f)) die(`input not found: ${f}`);
    if (!/\.(fit|fits|fts)$/i.test(f)) die(`FITS lane only — not a .fit/.fits/.fts file: ${f}`);
}

// Validate --config JSON here so a typo fails LOUD before we fork the batch.
let configJson = null;
if (a.config != null) {
    let parsed;
    try {
        parsed = JSON.parse(a.config);
    } catch (e) {
        die(`--config is not valid JSON: ${e.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        die('--config must be a JSON object (the idempotency knob set)');
    }
    configJson = JSON.stringify(parsed);
}

const outDir = a.out ? path.resolve(a.out) : DEFAULT_OUT;
fs.mkdirSync(outDir, { recursive: true });
const summaryPath = path.join(outDir, 'batch_summary.json');
// Clear a stale summary so a fork failure can never be mistaken for a fresh run.
try {
    fs.rmSync(summaryPath, { force: true });
} catch {
    /* best-effort */
}

// Run the REAL pipeline over all files under ONE vitest process — captured (NOT
// inherited) so our stdout stays projection-only; vitest output → stderr on failure.
const res = spawnSync(process.execPath, [VITEST_BIN, 'run', '-c', RUN_CONFIG], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 1_800_000,
    env: {
        ...process.env,
        BATCH_FILES: JSON.stringify(files),
        BATCH_OUT: outDir,
        ...(configJson ? { BATCH_CONFIG: configJson } : {}),
        ...(a.resume ? { BATCH_RESUME: '1' } : {}),
        ...(a.checkpoint ? { BATCH_CHECKPOINT: path.resolve(a.checkpoint) } : {}),
    },
});
if (res.status !== 0 || !fs.existsSync(summaryPath)) {
    process.stderr.write((res.stdout || '') + (res.stderr || '') + '\n');
    die(`batch run failed (vitest exit ${res.status}); no summary at ${summaryPath}`);
}

let ledger;
try {
    ledger = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
} catch (e) {
    die(`could not parse summary ${summaryPath}: ${e.message}`);
}

const c = ledger.counts;
process.stderr.write(
    `[batch/run] ${path.relative(ROOT, summaryPath)} — ${c.total} run: ` +
        `${c.solved} solved · ${c.no_solve} no-solve · ${c.errored} error · ${c.skipped} skipped\n`,
);
// stdout = machine-readable summary ONLY (per-file verdicts + solve fields).
const projection = {
    counts: c,
    results: (ledger.results || []).map((r) => ({ frameId: r.frameId, verdict: r.verdict, solution: r.solution })),
};
process.stdout.write(JSON.stringify(projection) + '\n');
process.exit(c.errored > 0 ? 3 : 0);
