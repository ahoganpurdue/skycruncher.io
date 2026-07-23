/**
 * COCOON L_0020 detection DUMP (probe lane — NOT a gate). Re-runs the REAL wizard
 * detection (step1..3, deterministic; NO solve) on the Cocoon GOLD frame and dumps
 * session.signal.clean_stars centroids (x/y + rawX/rawY native + flux) to
 * D:/AstroLogic/test_artifacts/cocoon_probe_2026-07-18/l0020_engine_dets.json.
 *
 * This is the SAME wizard detector that produced the banked api clean_stars the W2
 * incubator consumed for its 18/25. Rawler-default decode (W5 arm parity).
 *
 * Run: COCOON_DUMP=1 VITE_DECODER_RAWLER=1 npx vitest run -c tools/api/api_harness.config.ts tools/api/cocoon_dump_dets.apispec.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootRealWasm, makeFsAtlasLoader } from './headless_driver';
import { OrchestratorSession } from '@/engine/pipeline/orchestrator_session';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';

const ATLAS_ROOT = path.resolve(process.cwd(), 'public');
const OUT_DIR = 'D:/AstroLogic/test_artifacts/cocoon_probe_2026-07-18';
const FRAME = process.env.COCOON_FRAME
    ?? 'D:/AstroLogic/intake/staging_cocoon/COCOON NEBULA/L_0020_ISO800_240s__18C.CR2';

describe.skipIf(!process.env.COCOON_DUMP)('cocoon L_0020 detection dump', () => {
    it('re-detects and dumps clean_stars centroids (no solve)', async () => {
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
        const sample0 = stars.length ? Object.keys(stars[0]) : [];
        const det = stars.map((s) => ({
            x: s.x, y: s.y,
            rawX: s.rawX, rawY: s.rawY,
            flux: s.flux ?? 0, fwhm: s.fwhm ?? 0,
        }));

        const meta: any = (session as any).metadata ?? (session as any).meta ?? {};
        const dump = {
            file: FRAME,
            decoder: process.env.VITE_DECODER_RAWLER === '1' ? 'rawler' : 'default',
            source: 'OrchestratorSession step1..3 clean_stars (real wizard, deterministic, no solve)',
            image_width: (session as any).imageWidth ?? meta.width ?? null,
            image_height: (session as any).imageHeight ?? meta.height ?? null,
            meta_width: meta.width ?? null, meta_height: meta.height ?? null,
            clean_star_field_keys: sample0,
            n: det.length,
            anomalies: sig?.anomalies?.length ?? null,
            detections: det,
        };
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUT_DIR, 'l0020_engine_dets.json'), JSON.stringify(dump));
        // eslint-disable-next-line no-console
        console.log(`[cocoon_dump] clean_stars=${det.length} dims=${dump.image_width}x${dump.image_height} fields=${sample0.join(',')}`);
    });
});
