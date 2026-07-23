/**
 * TESS detection DUMP (measurement lane — not a gate). Re-runs the REAL wizard
 * detection (step1..3, deterministic) on the WCS-stripped TESS blind frame and
 * dumps session.signal.clean_stars pixel centroids to a solverkit-format
 * detection file (test_results/tess_sip_prewarp_2026-07-11/tess_raw_dets.app.json).
 *
 * NO solve is run (detection is set in step2_Extract; the 190s solve is skipped).
 * Reuses today's 471-detection result rather than rebuilding a detector.
 *
 * Run: npx vitest run -c tools/api/api_harness.config.ts tools/api/tess_dump_dets.apispec.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRealWasm, makeFsAtlasLoader } from './headless_driver';
import { OrchestratorSession } from '@/engine/pipeline/orchestrator_session';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const OUT_DIR = path.join(REPO_ROOT, 'test_results', 'tess_sip_prewarp_2026-07-11');
const FRAME = 'D:/AstroLogic/intake/nasa_esa_1to1/tess_ext1_sci_blind.fits';

describe.skipIf(!process.env.TESS_DUMP)('tess detection dump', () => {
    it('re-detects and dumps clean_stars centroids', async () => {
        expect(fs.existsSync(FRAME), `frame missing ${FRAME}`).toBe(true);
        const buf = fs.readFileSync(FRAME);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        bootRealWasm();
        StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(ATLAS_ROOT));

        const session = new OrchestratorSession(ab, { generatePreviews: false });
        await session.step1_Load();
        await session.step2_Extract();
        await session.step3_Metrology();

        const sig: any = (session as any).signal ?? null;
        const stars: any[] = sig?.clean_stars ?? [];
        const det = stars
            .filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y))
            .map((s) => ({ x: s.x, y: s.y, flux: s.flux ?? 0, fwhm: s.fwhm ?? 0 }));

        // native dims as the pipeline sees them
        const meta: any = (session as any).metadata ?? (session as any).meta ?? {};
        const dump = {
            file: FRAME,
            source: 'OrchestratorSession step1..3 clean_stars (real wizard, deterministic)',
            width: meta.width ?? meta.nativeW ?? 2048,
            height: meta.height ?? meta.nativeH ?? 2048,
            scaleArcsecPerPx: null,
            n: det.length,
            anomalies: sig?.anomalies?.length ?? null,
            detections: det,
        };
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUT_DIR, 'tess_raw_dets.app.json'), JSON.stringify(dump, null, 1));
        // eslint-disable-next-line no-console
        console.log(`[tess_dump] clean_stars=${det.length} dims=${dump.width}x${dump.height} metaKeys=${Object.keys(meta).slice(0,20).join(',')}`);

        StarCatalogAdapter.setAtlasLoader(null);
        expect(det.length).toBeGreaterThan(100);
    });
});
