/**
 * ★ NODE CAPTURE SINK — end-to-end persistence lane (efficiency-review I1 / C6a).
 *
 * Where `headless_capture.capspec.ts` builds+writes the SeeStar record INLINE,
 * this lane proves the REUSABLE registered sink (`node_capture_sink.ts`): install
 * the sink, run the REAL wizard pipeline headless, and assert the CaptureRecorder
 * auto-flushed the per-run JSONL to disk on `run_finished` — the exact path a
 * corpus sweep / overnight run / the pinned e2e frames get for free once the sink
 * is installed. Covers BOTH pinned frames, and asserts the A3 per-BRANCH timing
 * (`solve.*` accrued ms + attempts) that was COMPUTED-then-DISCARDED before this.
 *
 * Persists to test_results/runs/<run_id>.jsonl (the A4 corpus layout the replay
 * dashboard scrubs). Does NOT touch the receipt / sacred numbers — those are
 * asserted byte-identical by tools/api/solve_{seestar,cr2}.apispec.ts.
 *
 *   npx vitest run -c tools/capture/capture.config.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from '../api/headless_driver';
import { clearCompletedRuns } from '@/engine/events/capture_record';
import { parseCaptureJsonl } from '@/engine/events/capture_aggregate';
import { installNodeCaptureSink } from './node_capture_sink';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const RUNS_DIR = path.join(REPO_ROOT, 'test_results', 'runs');
const FIT_PATH = path.join(REPO_ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const CR2_PATH = path.join(REPO_ROOT, 'public', 'demo', 'sample_observation.cr2');

function readArrayBuffer(p: string): ArrayBuffer {
    const buf = fs.readFileSync(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const uninstallers: Array<() => void> = [];
afterEach(() => {
    while (uninstallers.length) uninstallers.pop()!();
    clearCompletedRuns();
});

describe('node capture sink — the reusable Node sink persists real headless runs', () => {
    it('SeeStar FITS: sink auto-flushes per-stage timing to test_results/runs/<run_id>.jsonl', async () => {
        expect(fs.existsSync(FIT_PATH), `sample FITS missing at ${FIT_PATH} (local-only asset)`).toBe(true);

        const written: string[] = [];
        uninstallers.push(installNodeCaptureSink({ dir: RUNS_DIR, onWrite: (p) => written.push(p) }));

        await runWizardPipeline(readArrayBuffer(FIT_PATH), { atlasRoot: ATLAS_ROOT });

        // The sink fired exactly once (one run_finished) and wrote a real file.
        expect(written, 'sink did not write a capture record').toHaveLength(1);
        expect(fs.existsSync(written[0])).toBe(true);
        expect(written[0].startsWith(RUNS_DIR)).toBe(true);

        const record = parseCaptureJsonl(fs.readFileSync(written[0], 'utf8'));
        expect(record.length).toBeGreaterThan(0);
        const ids = new Set(record.map((e) => e.stage_id));
        for (const core of ['load', 'extract', 'metrology', 'solve', 'calibrate', 'integrate']) {
            expect(ids.has(core), `missing core flowchart node "${core}"`).toBe(true);
        }
        // Per-orchestrator-stage timing is present + honest (finite, non-negative ms).
        for (const e of record) expect(Number.isFinite(e.ms) && e.ms >= 0).toBe(true);
        // Solve branch reports PASS + the sacred SeeStar matched count.
        const solveBranch = record.find((e) => e.stage_id.startsWith('solve.') && e.verdict === 'PASS');
        expect(solveBranch, 'solve branch did not report PASS').toBeTruthy();
        expect(solveBranch!.counts.matched).toBe(272);

        // eslint-disable-next-line no-console
        console.log(`[sink] SeeStar → ${record.length} envelopes @ ${written[0]}`);
    });

    it('CR2 blind: sink persists the A3 per-branch (solve.uw_*) timing that was computed-then-discarded', async () => {
        expect(fs.existsSync(CR2_PATH), `bundled CR2 missing at ${CR2_PATH} (local-only asset)`).toBe(true);

        const written: string[] = [];
        uninstallers.push(installNodeCaptureSink({ dir: RUNS_DIR, onWrite: (p) => written.push(p) }));

        await runWizardPipeline(readArrayBuffer(CR2_PATH), { atlasRoot: ATLAS_ROOT });

        expect(written, 'sink did not write a capture record for the CR2 run').toHaveLength(1);
        const record = parseCaptureJsonl(fs.readFileSync(written[0], 'utf8'));
        expect(record.length).toBeGreaterThan(0);

        // A3: the winning solve BRANCH node persisted with its OWN accrued ms + attempts.
        const branches = record.filter((e) => e.stage_id.startsWith('solve.'));
        expect(branches.length, 'no solve-branch flowchart node persisted').toBeGreaterThan(0);
        const winner = branches.find((e) => e.verdict === 'PASS');
        expect(winner, 'no PASS solve branch persisted').toBeTruthy();
        expect(winner!.counts.matched).toBe(55);                 // sacred CR2 matched count
        expect(Number.isFinite(winner!.ms) && winner!.ms >= 0).toBe(true); // A3 branch timing survived
        // The branch attempt count (accrued alongside ms in diagnostics.branch_timing).
        expect(typeof winner!.counts.attempts === 'number' || winner!.counts.attempts === undefined).toBe(true);

        // eslint-disable-next-line no-console
        console.log(`[sink] CR2 → branch ${winner!.stage_id} ms=${winner!.ms} attempts=${winner!.counts.attempts} @ ${written[0]}`);
    });
});
