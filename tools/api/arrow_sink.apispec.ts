/**
 * Toolchest API headless smoke — ARROW TABLE SINK (Arrow Carrier program, #4).
 *
 * Drives the REAL SeeStar M66 wizard pipeline in Node with SKYCRUNCHER_ARROW_SINK
 * pointed at a temp dir, then re-reads the written `.arrow` files with the
 * package's OWN reader (readArrowFile) and asserts the table values match the
 * in-memory receipt EXACTLY (IEEE `toBe`). This proves the export's first
 * production touchpoint carries the receipt's tabular products losslessly to disk.
 *
 * The sink is env-gated and default OFF: the sacred SeeStar numbers asserted in
 * solve_seestar.apispec.ts stay byte-identical when the env is unset (the receipt
 * is untouched by the sink — the same run is used here, its solve numbers below
 * are the sacred values, unchanged).
 *
 * Run: npx vitest run -c tools/api/api_harness.config.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from './headless_driver';
import { readArrowFile } from '../../packages/toolchest/src/index';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIT_PATH = path.join(REPO_ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');

// Sacred SeeStar anchors (docs/GATES.md) — the sink reproduces these from disk.
const SACRED = {
    ra_hours: 11.341267568475146,
    dec_degrees: 13.048784954351197,
    pixel_scale: 3.6801611047133536,
    confidence: 0.7967181264113802,
    matched: 265,
} as const;

let priorEnv: string | undefined;
let tmpDir: string | null = null;

afterEach(() => {
    // Restore env so sibling apispecs (which assert the sink stays OFF) are clean.
    if (priorEnv === undefined) delete process.env.SKYCRUNCHER_ARROW_SINK;
    else process.env.SKYCRUNCHER_ARROW_SINK = priorEnv;
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
});

describe('tools/api headless smoke — Arrow table sink (SeeStar, exact vs receipt)', () => {
    it('writes the four .arrow products and round-trips them EXACTLY through the package reader', async () => {
        expect(fs.existsSync(FIT_PATH), `sample FITS missing at ${FIT_PATH} (local-only asset)`).toBe(true);

        priorEnv = process.env.SKYCRUNCHER_ARROW_SINK;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skycruncher-arrow-sink-'));
        process.env.SKYCRUNCHER_ARROW_SINK = tmpDir;

        const buf = fs.readFileSync(FIT_PATH);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        const { receipt, arrowDir } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });

        // ── the sink fired into a per-run subdir under the env dir ──
        expect(arrowDir, 'runWizardPipeline did not report an arrowDir').toBeTruthy();
        expect(arrowDir!.startsWith(tmpDir!)).toBe(true);
        // exactly one per-run subdir was created (runId__frameSha)
        const subdirs = fs.readdirSync(tmpDir!).filter((n) => fs.statSync(path.join(tmpDir!, n)).isDirectory());
        expect(subdirs.length).toBe(1);
        expect(path.join(tmpDir!, subdirs[0])).toBe(arrowDir);

        // ── the four tabular products + manifest are present on disk ──
        for (const name of ['matched_stars', 'detections', 'forced_confirmed', 'run_summary']) {
            expect(fs.existsSync(path.join(arrowDir!, `${name}.arrow`)), `${name}.arrow missing`).toBe(true);
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(arrowDir!, 'manifest.json'), 'utf8'));
        expect(manifest.source).toBe('headless');
        expect(manifest.receipt_schema_version).toBe(receipt.version);
        expect(manifest.frame_sha256_12).toMatch(/^[0-9a-f]{12}$/);
        expect(manifest.tables).toEqual(['matched_stars', 'detections', 'forced_confirmed', 'run_summary']);

        // ── read back with the PACKAGE's own reader and assert EXACT vs receipt ──
        const runSummary = await readArrowFile(path.join(arrowDir!, 'run_summary.arrow'));
        const matched = await readArrowFile(path.join(arrowDir!, 'matched_stars.arrow'));
        const detections = await readArrowFile(path.join(arrowDir!, 'detections.arrow'));
        const forced = await readArrowFile(path.join(arrowDir!, 'forced_confirmed.arrow'));

        // run_summary: single-row solve scalars — bit-exact against the receipt AND
        // the sacred anchors (proves the on-disk table is the real solve, not a stub).
        expect(runSummary.numRows).toBe(1);
        expect(runSummary.getChild('ra_hours')!.get(0)).toBe(receipt.solution.ra_hours);
        expect(runSummary.getChild('ra_hours')!.get(0)).toBe(SACRED.ra_hours);
        expect(runSummary.getChild('dec_degrees')!.get(0)).toBe(SACRED.dec_degrees);
        expect(runSummary.getChild('pixel_scale')!.get(0)).toBe(SACRED.pixel_scale);
        expect(runSummary.getChild('confidence')!.get(0)).toBe(SACRED.confidence);
        expect(runSummary.getChild('stars_matched')!.get(0)).toBe(SACRED.matched);
        expect(runSummary.getChild('confirm_status')!.get(0)).toBe(receipt.confirm_status.status);
        expect(runSummary.getChild('confirmed_count')!.get(0)).toBe(receipt.confirm_status.confirmed);
        expect(runSummary.getChild('confirm_n_targets')!.get(0)).toBe(receipt.confirm_status.nTargets);
        expect(runSummary.getChild('receipt_schema_version')!.get(0)).toBe(receipt.version);

        // matched_stars: row count = the solve's match count; spot-check EXACT per-star
        // values against the receipt array (position, catalog coords, residual).
        const ms = receipt.solution.matched_stars as Array<Record<string, number>>;
        expect(matched.numRows).toBe(ms.length);
        expect(matched.numRows).toBe(SACRED.matched);
        for (const i of [0, Math.floor(ms.length / 2), ms.length - 1]) {
            expect(matched.getChild('ra_deg')!.get(i)).toBe(ms[i].ra_deg);
            expect(matched.getChild('dec_deg')!.get(i)).toBe(ms[i].dec_deg);
            expect(matched.getChild('x')!.get(i)).toBe(ms[i].x);
            expect(matched.getChild('y')!.get(i)).toBe(ms[i].y);
            expect(matched.getChild('residual_arcsec')!.get(i)).toBe(ms[i].residual_arcsec);
        }

        // detections & forced_confirmed: honest row counts vs the receipt blocks.
        expect(detections.numRows).toBe((receipt.signal?.clean_stars ?? []).length);
        expect(forced.numRows).toBe((receipt.deep_confirmed?.confirmed_stars ?? []).length);
        expect(forced.numRows).toBe(receipt.confirm_status.confirmed);
    });
});
