/**
 * ★ CAPTURE-RECORD headless evidence lane (dashboard/flowchart wave 1).
 *
 * Runs the REAL wizard pipeline (SeeStar M66 FITS) in Node via the Toolchest
 * headless driver, builds the per-stage capture record from the emitted event
 * stream, and writes it to test_results/runs/<run_id>.jsonl — the on-disk
 * substrate the replay dashboard's time-slider scrubs. Also asserts the
 * envelope contract (run_id/frame_sha dedup key, honest verdicts, the new
 * solve-branch + post-solve flowchart nodes).
 *
 * This does NOT touch the receipt — the same run's sacred numbers are asserted
 * byte-identical by tools/api/solve_seestar.apispec.ts.
 *
 *   npx vitest run -c tools/capture/capture.config.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from '../api/headless_driver';
import { buildCaptureRecord, serializeCaptureRecordJsonl } from '@/engine/events/capture_record';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIT_PATH = path.join(REPO_ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const RUNS_DIR = path.join(REPO_ROOT, 'test_results', 'runs');

describe('capture record — headless SeeStar run persists a valid per-stage JSONL', () => {
    it('runs the real pipeline and writes test_results/runs/<run_id>.jsonl', async () => {
        expect(fs.existsSync(FIT_PATH), `sample FITS missing at ${FIT_PATH} (local-only asset)`).toBe(true);

        const buf = fs.readFileSync(FIT_PATH);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        const { events } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });

        const record = buildCaptureRecord(events);
        expect(record.length, 'no stage envelopes captured').toBeGreaterThan(0);

        const runId = record[0].run_id;
        expect(runId, 'run_id (promoted session id) not stamped on the record').toBeTruthy();

        // Dedup key present + a real SHA-256 (frame hashed off the hot path).
        const withSha = record.filter(e => typeof e.frame_sha === 'string' && /^[0-9a-f]{64}$/.test(e.frame_sha!));
        expect(withSha.length, 'no envelope carries a 64-hex frame_sha dedup key').toBeGreaterThan(0);

        // The core wizard stages are all boxed.
        const ids = new Set(record.map(e => e.stage_id));
        for (const core of ['load', 'extract', 'metrology', 'solve', 'calibrate', 'integrate']) {
            expect(ids.has(core), `missing core flowchart node "${core}"`).toBe(true);
        }
        // At least one solve-runtime branch node fired (this frame solves via WASM quad).
        const branchNodes = [...ids].filter(id => id.startsWith('solve.'));
        expect(branchNodes.length, 'no solve-branch flowchart node emitted').toBeGreaterThan(0);
        // New post-solve nodes from this wave are present.
        for (const node of ['m7_refine', 'bc_measure', 'spcc', 'render_apply_sip']) {
            expect(ids.has(node), `missing post-solve flowchart node "${node}"`).toBe(true);
        }

        // Envelope contract: every row carries the full key set + honest verdict.
        const KEYS = ['counts', 'frame_sha', 'ms', 'ok', 'payload_ref', 'run_id', 'seq', 'stage_id', 't_end', 't_start', 'verdict', 'warnings'].sort();
        for (const env of record) {
            expect(Object.keys(env).sort()).toEqual(KEYS);
            // honest-or-absent: verdict is a value or null, never undefined/placeholder.
            expect(env.verdict === null || typeof env.verdict === 'string').toBe(true);
            expect(env.t_end).toBeGreaterThanOrEqual(env.t_start);
        }

        // The solve node reports a PASS verdict + matched count (the sacred 272).
        const solveBranch = record.find(e => e.stage_id.startsWith('solve.') && e.verdict === 'PASS');
        expect(solveBranch, 'solve branch did not report PASS').toBeTruthy();
        expect(solveBranch!.counts.matched).toBe(272);

        // Persist the JSONL sidecar (the replay substrate).
        fs.mkdirSync(RUNS_DIR, { recursive: true });
        const outPath = path.join(RUNS_DIR, `${runId}.jsonl`);
        fs.writeFileSync(outPath, serializeCaptureRecordJsonl(record), 'utf8');
        expect(fs.existsSync(outPath)).toBe(true);

        // Round-trips (each line is a valid envelope object).
        const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean);
        expect(lines.length).toBe(record.length);
        expect(() => lines.forEach(l => JSON.parse(l))).not.toThrow();

        // eslint-disable-next-line no-console
        console.log(`[capture] wrote ${record.length} envelopes → ${outPath}`);
    });
});
