// Unit tests for the BATCH ENGINE core (tools/batch/batch_engine.ts) — HERMETIC:
// a MOCK solveFn + readFile + clock are injected, so NO wasm / atlas / real FITS
// is touched and these run in the standard `npx vitest run` gate. They pin the
// three properties that make runBatch a trustworthy N-files→N-receipts engine:
//   • per-file fault ISOLATION — one thrown solve is an honest `error` row, the
//     rest of the batch still completes;
//   • process-global config DISCIPLINE — snapshot→solve→restore around EVERY
//     file, so a knob a solve mutates NEVER bleeds into the next file (the whole
//     reason the golden-equivalence-vs-fork-per-file test exists);
//   • the EVENT SEAM shape/order — the stream task #25's visual panel consumes.
//
// The REAL-wasm value equivalence (batch receipts === tools/api/run.mjs receipts)
// is proven separately by the golden-equivalence harness, not here.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBatch, type BatchStreamEvent, type BatchSolveFn } from '../../../tools/batch/batch_engine';
// Use the `@/` alias so this resolves to the SAME pipeline_config module instance
// batch_engine.ts mutates/restores (the specifier-family invariant headless_driver notes).
import { PIPELINE_CONSTANTS } from '@/engine/pipeline/constants/pipeline_config';

const ATLAS_ROOT = '/unused-by-mock';

function tmpOut(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'batch-utest-'));
}

describe('runBatch — batch engine core (mock solve)', () => {
    it('produces N honest rows with per-file isolation (solved / no_solve / error)', async () => {
        const out = tmpOut();
        const files = ['/corpus/good_a.fits', '/corpus/nosolve_b.fits', '/corpus/boom_c.fits', '/corpus/good_d.fits'];

        // The mock solve can't see the filename, so intent is threaded through the
        // readFile mock as the ArrayBuffer's byteLength (0=throw, 1=no-solve, 2=solve).
        const intentOf = (f: string) => (f.includes('boom') ? 0 : f.includes('nosolve') ? 1 : 2);
        const readFile = (f: string) => new ArrayBuffer(intentOf(f));
        const solve: BatchSolveFn = async (ab) => {
            const intent = ab.byteLength;
            if (intent === 0) throw new Error('decode exploded');
            const solution = intent === 1 ? null : { ra_hours: 11.34, dec_degrees: 22.1, pixel_scale: 3.67, stars_matched: 272, confidence: 0.83 };
            return { receipt: { version: '2.3.0', solution } as any, events: [], session: {} as any };
        };

        const { ledger, receipts } = await runBatch(files, { atlasRoot: ATLAS_ROOT, outDir: out, readFile, solveFn: solve, now: (() => { let t = 1000; return () => (t += 10); })() });

        expect(ledger.counts.total).toBe(4);
        expect(ledger.counts.solved).toBe(2);
        expect(ledger.counts.no_solve).toBe(1);
        expect(ledger.counts.errored).toBe(1);
        expect(ledger.results.map((r) => r.verdict)).toEqual(['solved', 'no_solve', 'error', 'solved']);

        const boom = ledger.results.find((r) => r.frameId === 'boom_c')!;
        expect(boom.ok).toBe(false);
        expect(boom.receiptPath).toBeNull();
        expect(boom.error).toContain('decode exploded');

        // Solved rows carry the comparable solution + a written receipt; receipts[]
        // holds every file that PRODUCED a receipt (2 solved + 1 no-solve — a
        // no-solve receipt is a real artifact); only the thrown boom_c has none.
        const good = ledger.results.find((r) => r.frameId === 'good_a')!;
        expect(good.solution?.stars_matched).toBe(272);
        expect(good.schema_version).toBe('2.3.0');
        expect(fs.existsSync(good.receiptPath!)).toBe(true);
        expect(receipts.length).toBe(3);

        // Ledger + per-file JSONL both landed on disk.
        expect(fs.existsSync(path.join(out, 'batch_summary.json'))).toBe(true);
        const jsonl = fs.readFileSync(path.join(out, 'batch_ledger.jsonl'), 'utf8').trim().split('\n');
        expect(jsonl.length).toBe(4);

        fs.rmSync(out, { recursive: true, force: true });
    });

    it('restores process-global config after EVERY file — no cross-file bleed', async () => {
        const out = tmpOut();
        const KEY = 'SOLVER_MIN_MATCHES';
        const original = (PIPELINE_CONSTANTS as unknown as Record<string, number>)[KEY];

        // A solve that DELIBERATELY corrupts a shared constant mid-solve. Without
        // snapshot/restore this would leak into the next file (and out of runBatch).
        const solve: BatchSolveFn = async () => {
            (PIPELINE_CONSTANTS as unknown as Record<string, number>)[KEY] = 999;
            return { receipt: { version: '2.3.0', solution: { ra_hours: 1, dec_degrees: 2, pixel_scale: 3, stars_matched: 9, confidence: 0.5 } } as any, events: [], session: {} as any };
        };

        await runBatch(['/c/x.fits', '/c/y.fits'], { atlasRoot: ATLAS_ROOT, outDir: out, readFile: () => new ArrayBuffer(2), solveFn: solve });

        // The corruption was undone after each file, so the constant is back to baseline.
        expect((PIPELINE_CONSTANTS as unknown as Record<string, number>)[KEY]).toBe(original);
        fs.rmSync(out, { recursive: true, force: true });
    });

    it('emits the documented event stream: batch_started → (file_started, …, file_completed)×N → batch_completed', async () => {
        const out = tmpOut();
        const events: BatchStreamEvent[] = [];
        const solve: BatchSolveFn = async (_ab, opts) => {
            // Forward a fake pipeline event to prove pass-through interleaving.
            (opts.onEvent as any)?.({ kind: 'run_started', mode: 'wizard', ts: 0, seq: 0 } as any);
            return { receipt: { version: '2.3.0', solution: { ra_hours: 1, dec_degrees: 2, pixel_scale: 3, stars_matched: 9, confidence: 0.5 } } as any, events: [], session: {} as any };
        };

        await runBatch(['/c/one.fits'], { atlasRoot: ATLAS_ROOT, outDir: out, readFile: () => new ArrayBuffer(2), solveFn: solve, onEvent: (e) => events.push(e), now: (() => { let t = 0; return () => (t += 1); })() });

        const kinds = events.map((e) => e.kind);
        expect(kinds).toEqual(['batch_started', 'file_started', 'run_started', 'file_completed', 'batch_completed']);
        const completed = events.find((e) => e.kind === 'file_completed') as Extract<BatchStreamEvent, { kind: 'file_completed' }>;
        expect(completed.verdict).toBe('solved');
        expect(completed.solution?.stars_matched).toBe(9);
        const done = events.find((e) => e.kind === 'batch_completed') as Extract<BatchStreamEvent, { kind: 'batch_completed' }>;
        expect(done.total).toBe(1);
        expect(done.solved).toBe(1);
        fs.rmSync(out, { recursive: true, force: true });
    });

    it('rejects concurrency ≠ 1 (sequential-only until singleton remediation)', async () => {
        await expect(
            runBatch(['/c/a.fits'], { atlasRoot: ATLAS_ROOT, concurrency: 4, readFile: () => new ArrayBuffer(2), solveFn: async () => ({ receipt: { version: '2.3.0', solution: null } as any, events: [], session: {} as any }) }),
        ).rejects.toThrow(/SEQUENTIAL-ONLY/);
    });

    it('resume skips files whose receipt is current under the config hash', async () => {
        const out = tmpOut();
        const solve: BatchSolveFn = async () => ({ receipt: { version: '2.3.0', solution: { ra_hours: 1, dec_degrees: 2, pixel_scale: 3, stars_matched: 9, confidence: 0.5 } } as any, events: [], session: {} as any });

        // First run: solve both, producing receipts + a checkpoint (ledger.frames).
        const first = await runBatch(['/c/p.fits', '/c/q.fits'], { atlasRoot: ATLAS_ROOT, outDir: out, readFile: () => new ArrayBuffer(2), solveFn: solve });
        expect(first.ledger.counts.total).toBe(2);

        // Second run WITH resume + the prior checkpoint: both receipts exist on disk
        // and the checkpoint hash matches → both are 'current' → nothing re-runs.
        const second = await runBatch(['/c/p.fits', '/c/q.fits'], {
            atlasRoot: ATLAS_ROOT,
            outDir: out,
            readFile: () => new ArrayBuffer(2),
            solveFn: solve,
            resume: true,
            checkpoint: first.ledger,
        });
        expect(second.ledger.counts.total).toBe(0);
        expect(second.ledger.counts.skipped).toBe(2);
        expect(second.ledger.skipped.every((s) => s.reason === 'resume-current')).toBe(true);
        fs.rmSync(out, { recursive: true, force: true });
    });
});
