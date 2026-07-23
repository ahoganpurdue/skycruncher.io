/**
 * Real-pipeline ASDF export of the SeeStar M66 FITS — produces the SKYCRUNCHER-
 * dialect fixture the cross-dialect ingest proof reads (test_results/m66_export.asdf),
 * and round-trips the REAL receipt through the subset reader (stronger than the
 * asset-free fixture: 272 matched_stars, nested astrometry, the full native gwcs
 * chain the wizard emits).
 *
 *   npx vitest run -c tools/asdf/asdf_harness.config.ts
 *
 * The `.asdfspec.ts` suffix keeps this OUT of the sacred `npx vitest run` gate
 * (same trick as *.apispec.ts). Needs the local-only assets (Sample Files +
 * public/atlas/sectors + wasm pkg) and real wasm — hence the dedicated harness.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsdfExport } from './run_pipeline_export';
// @ts-expect-error — plain .mjs reader, no d.ts (tools lane)
import { readAsdfFile, isTagged, untag } from './asdf_reader.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIT_PATH = path.join(REPO_ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const OUT = path.join(REPO_ROOT, 'test_results', 'm66_export.asdf');

// Sacred SeeStar numbers (GATES.md) — the exported receipt must carry them.
const SACRED = { ra_hours: 11.341253475172621, matched: 272 } as const;

describe('ASDF real export — SeeStar M66 → SKYCRUNCHER-dialect fixture + reader round-trip', () => {
    it('runs the real wizard, writes ASDF, and the subset reader recovers the receipt + gwcs', async () => {
        expect(fs.existsSync(FIT_PATH), `sample FITS missing at ${FIT_PATH} (local-only)`).toBe(true);
        fs.mkdirSync(path.dirname(OUT), { recursive: true });

        const buf = fs.readFileSync(FIT_PATH);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        const { outPath, receipt } = await runAsdfExport(ab, { atlasRoot: ATLAS_ROOT, outPath: OUT });
        expect(receipt.solution.ra_hours).toBe(SACRED.ra_hours);
        expect(receipt.solution.stars_matched).toBe(SACRED.matched);

        // ── round-trip the REAL export through the subset reader ──
        const asdf = readAsdfFile(outPath);
        expect(asdf.standardVersion).toBe('1.6.0');
        expect(asdf.blocks.length).toBeGreaterThanOrEqual(1);

        // receipt fields recovered
        expect(asdf.tree.version).toBe(receipt.version);
        expect(asdf.tree.solution.ra_hours).toBe(SACRED.ra_hours);
        expect(asdf.tree.solution.stars_matched).toBe(SACRED.matched);
        // 272 matched_stars survive the block-sequence parse
        expect(Array.isArray(asdf.tree.solution.matched_stars)).toBe(true);
        expect(asdf.tree.solution.matched_stars.length).toBe(SACRED.matched);

        // native gwcs recovered + walkable
        expect(isTagged(asdf.tree.wcs)).toBe(true);
        expect(asdf.tree.wcs.__tag__).toContain('gwcs/wcs');
        expect(Array.isArray(untag(asdf.tree.wcs).steps)).toBe(true);

        // data block: shape + exact pixel bytes decode
        const nd = asdf.readNdarray(asdf.tree.data);
        expect(nd.shape.length).toBeGreaterThanOrEqual(2);
        expect(nd.dtype).toBeTruthy();

        console.log(`[m66-export] wrote ${outPath} — ${asdf.blocks.length} block(s), ` +
            `${asdf.tree.solution.matched_stars.length} matched stars, data ${nd.dtype} [${nd.shape.join(',')}]`);
    });
});
