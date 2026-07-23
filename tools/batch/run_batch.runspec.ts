// ═══════════════════════════════════════════════════════════════════════════
// tools/batch run_batch.mjs — the vitest-hosted engine entry (driven by
// run_batch.config.ts; not run directly)
// ═══════════════════════════════════════════════════════════════════════════
//
// A plain .mjs cannot resolve the engine's `@/` alias, boot the compiled wasm,
// or run runWizardPipeline + snapshot/restore in ONE process — so run_batch.mjs
// spawns vitest against THIS spec, passing the file list + outDir via env, and
// this spec calls runBatch (the real engine) to solve them all in this single
// process. Mirrors tools/api/solve_to_receipt.runspec.ts exactly.
//
// runBatch writes the receipts, the JSONL ledger, and batch_summary.json under
// BATCH_OUT; run_batch.mjs reads batch_summary.json back for its projection +
// exit code. FITS lane (headless_driver's scope); CR2/RAW headless is out of
// scope here.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBatch, type BatchStreamEvent } from './batch_engine';
import { configureWorkbench } from '@/engine/pipeline/stages/workbench_deposit';
import { makeNodeJsonlStorage } from '../workbench/node_storage';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(ROOT, 'public');

const FILES = process.env.BATCH_FILES; // JSON array of absolute file paths
const OUT = process.env.BATCH_OUT; // absolute output dir
const CONFIG = process.env.BATCH_CONFIG; // optional JSON idempotency config
const RESUME = process.env.BATCH_RESUME === '1';
const CHECKPOINT = process.env.BATCH_CHECKPOINT; // optional path to a prior batch_summary.json
// Mirror the api run.mjs runspec: inject the headless workbench store so the
// always-on post-package deposit hook persists a per-rig row (never-fatal; it
// cannot perturb the receipt bytes). Batch-scoped dir so it never clobbers the
// api-run workbench evidence.
const WORKBENCH_DIR = process.env.WORKBENCH_DIR || path.join(ROOT, 'test_results', 'batch', 'workbench');

describe('tools/batch run_batch.mjs — N files → N receipts (one process)', () => {
    it('runs the real wizard over the file list and writes receipts + ledger', async () => {
        if (!FILES || !OUT) throw new Error('BATCH_FILES and BATCH_OUT env vars are required (run via tools/batch/run_batch.mjs)');
        const files = JSON.parse(FILES) as string[];
        if (!Array.isArray(files) || files.length === 0) throw new Error('BATCH_FILES must be a non-empty JSON array of paths');

        configureWorkbench({ storage: makeNodeJsonlStorage(WORKBENCH_DIR) });

        let checkpoint: { frames?: Record<string, unknown>; run_index?: number } | null = null;
        if (CHECKPOINT && fs.existsSync(CHECKPOINT)) {
            checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));
        }

        const { ledger } = await runBatch(files, {
            atlasRoot: ATLAS_ROOT,
            outDir: OUT,
            config: CONFIG ? JSON.parse(CONFIG) : undefined,
            resume: RESUME,
            checkpoint,
            // Forward a compact trace to stderr — cheap live progress for a long batch.
            onEvent: (e: BatchStreamEvent) => {
                if (e.kind === 'file_completed') console.warn(`[batch] ${e.frameId}: ${e.verdict} (${e.ms}ms)`);
                else if (e.kind === 'file_failed') console.warn(`[batch] ${e.frameId}: ERROR ${e.error}`);
            },
        });

        // Data-dumper contract: assert only that the artifacts landed. Per-file
        // no-solves/errors are valid OUTCOMES graded by run_batch.mjs, not failures.
        expect(fs.existsSync(path.join(OUT, 'batch_summary.json'))).toBe(true);
        expect(ledger.results.length).toBe(ledger.counts.total);
    });
});
