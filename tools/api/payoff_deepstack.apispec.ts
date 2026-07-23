/**
 * PAYOFF harness for the FITS 64-block-cap fix (NOT a sacred gate — .apispec.ts
 * suffix keeps it out of `npx vitest run`). Proves that deep-stack frames whose
 * long HISTORY headers previously overran MAX_HEADER_BLOCKS=64 now DECODE, and
 * drives the real wizard solve on IC443 to turn "should solve" into a measured
 * does/doesn't. Writes a findings JSON to test_results/.
 *
 * Run: npx vitest run -c tools/api/api_harness.config.ts tools/api/payoff_deepstack.apispec.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline, bootRealWasm, makeFsAtlasLoader } from './headless_driver';
import { OrchestratorSession } from '@/engine/pipeline/orchestrator_session';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROT = path.join(REPO_ROOT, 'Sample Files', 'rotating');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const OUT = path.join(REPO_ROOT, 'test_results', 'deepstack_payoff.json');

function readAb(p: string): ArrayBuffer {
    const buf = fs.readFileSync(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

// bitpix -32 (float) frames unblocked by FIX 1 alone.
const FLOAT_STACKS = ['ic443_13h_stacked.fit', 'orion_8h_stacked.fit', 'm27_12h_stacked.fit'];

describe('deep-stack decode + solve payoff', () => {
    const findings: any[] = [];

    it('IC443 13h stack: DECODES and drive the real wizard solve', async () => {
        const p = path.join(ROT, 'ic443_13h_stacked.fit');
        expect(fs.existsSync(p), `missing ${p}`).toBe(true);

        // Drive steps directly through step4 (Solve): step5_Calibrate throws a
        // guard when the solve yields no lock, which would mask the measured
        // does/doesn't-solve outcome we came here to record.
        bootRealWasm();
        StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(ATLAS_ROOT));
        let session: OrchestratorSession;
        try {
            session = new OrchestratorSession(readAb(p), { generatePreviews: false });
            await session.step1_Load();
            await session.step2_Extract();
            await session.step3_Metrology();
            await session.step4_Solve();
        } finally {
            StarCatalogAdapter.setAtlasLoader(null);
        }

        const stars = session.signal?.clean_stars.length ?? 0;
        const solved = !!session.solution;
        findings.push({
            frame: 'ic443_13h_stacked.fit', decoded: !!session.signal, stars,
            solved, ra_hours: session.solution?.ra_hours ?? null,
            pixel_scale: session.solution?.pixel_scale ?? null,
            matched: session.solution?.matched_stars?.length ?? null,
            status: session.status,
        });

        // The whole point of the fix: it now gets PAST ingest and extracts stars.
        expect(session.signal, 'IC443 failed to decode (signal null)').toBeTruthy();
        expect(stars, 'IC443 decoded but extracted zero stars').toBeGreaterThan(0);
        // Solve is a measured observation, not asserted — reported either way.
    });

    it('spot-check float stacks (orion_8h, m27) DECODE + extract stars', async () => {
        for (const f of FLOAT_STACKS.slice(1)) {
            const p = path.join(ROT, f);
            expect(fs.existsSync(p), `missing ${p}`).toBe(true);
            const { session } = await runWizardPipeline(readAb(p), { atlasRoot: ATLAS_ROOT });
            const stars = session.signal?.clean_stars.length ?? 0;
            findings.push({
                frame: f, decoded: !!session.signal, stars, solved: !!session.solution,
                ra_hours: session.solution?.ra_hours ?? null,
                matched: session.solution?.matched_stars?.length ?? null,
                status: session.status,
            });
            expect(session.signal, `${f} failed to decode`).toBeTruthy();
            expect(stars, `${f} decoded but extracted zero stars`).toBeGreaterThan(0);
        }
    });

    it('BITPIX=32 int32 stacks (pleiades, bubble) DECODE + extract stars', async () => {
        for (const f of ['pleiades_12h_stacked.fit', 'bubble_9h_stacked.fit']) {
            const p = path.join(ROT, f);
            expect(fs.existsSync(p), `missing ${p}`).toBe(true);
            bootRealWasm();
            StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(ATLAS_ROOT));
            let session: OrchestratorSession;
            try {
                session = new OrchestratorSession(readAb(p), { generatePreviews: false });
                await session.step1_Load();
                await session.step2_Extract();
                await session.step3_Metrology();
                await session.step4_Solve();
            } finally {
                StarCatalogAdapter.setAtlasLoader(null);
            }
            const stars = session.signal?.clean_stars.length ?? 0;
            findings.push({
                frame: f, bitpix: 32, decoded: !!session.signal, stars, solved: !!session.solution,
                ra_hours: session.solution?.ra_hours ?? null,
                matched: session.solution?.matched_stars?.length ?? null, status: session.status,
            });
            expect(session.signal, `${f} (int32) failed to decode`).toBeTruthy();
            expect(stars, `${f} (int32) decoded but extracted zero stars`).toBeGreaterThan(0);
        }
    });

    it('writes findings', () => {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(findings, null, 2));
        // eslint-disable-next-line no-console
        console.log('PAYOFF_FINDINGS ' + JSON.stringify(findings));
    });
});
