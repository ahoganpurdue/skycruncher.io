// ═══════════════════════════════════════════════════════════════════════════
// FORCED-PHOTOMETRY CONTROL at a KNOWN WCS  (instrument validation, NOT a solve)
// ═══════════════════════════════════════════════════════════════════════════
// Owner-ruled CONTROL (2026-07-13): does runPostSolveConfirmation() CONFIRM at
// known-truth on the X-Trans superpixel decodes AT ALL? Feed the astrometry.net
// ORACLE WCS as the solution, run OUR forced-photometry confirmation chain on OUR
// decode. If it confirms at perfect truth → the confirmation engine is validated on
// this population; the only recipe gap left is OUR-candidate-WCS capture. If it
// refuses at truth → the whole assisted recipe is dead regardless of whose WCS.
//
// EPISTEMIC RAIL: this is a CONTROL, never a solve claim. provenance is stamped
// 'CONTROL:oracle_wcs_instrument_validation'. It never enters the validation set,
// never pools with blind/assisted solves. The we-solve/oracle-confirms rail governs
// SOLVE CLAIMS; a control is not one.
//
// ENV:
//   FC_PLANE     absolute path to OUR decode plane (Float32 W*H, our superpixel bin)
//   FC_W, FC_H   plane dims (== the WCS pixel grid)
//   FC_WCS_FILE  path to JSON {crval_deg:[raDeg,decDeg], crpix1based:[cx,cy],
//                cd:[cd11,cd12,cd21,cd22], ra_center_deg, dec_center_deg}  (astrometry units)
//   FC_FWHM      nominal detection FWHM px (aperture); default 2.0
//   FC_OUT       output JSON path
//   CONFIRM_FDR_SHADOW=1  → FDR shadow banked alongside the primary set-excess gate
//
// UNIT TRAPS (auditor-mapped): internal wcs.crval[0] = RA HOURS (÷15 from FITS deg);
// crpix 0-based (CRPIX−1); cd stays deg/px (NO ÷15). lensDistActive:false REQUIRED
// (the oracle WCS is native-space, no BC prior — else the confirm returns absent).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRealWasm, makeFsAtlasLoader } from '../api/headless_driver';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';
import { runPostSolveConfirmation } from '@/engine/pipeline/m6_plate_solve/solver_entry';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLANE = process.env.FC_PLANE;
const W = +(process.env.FC_W || 0), H = +(process.env.FC_H || 0);
const WCS = process.env.FC_WCS_FILE ? JSON.parse(fs.readFileSync(process.env.FC_WCS_FILE, 'utf8')) : null;
const FWHM = +(process.env.FC_FWHM || 2.0);
const OUT = process.env.FC_OUT;
const FLIP_Y = process.env.FC_FLIP_Y === '1'; // parity debug: flip crpix2 + cd row-2 signs
const PROV = process.env.FC_PROVENANCE || 'CONTROL:oracle_wcs_instrument_validation';
const NOTE = process.env.FC_NOTE || 'Forced photometry at a known WCS on OUR superpixel decode.';

describe('forced-photometry CONTROL at known WCS (instrument validation, NOT a solve)', () => {
    it('confirms (or refuses) at the injected oracle WCS on OUR decode', async () => {
        if (!PLANE || !W || !H || !WCS || !OUT) throw new Error('FC_PLANE/FC_W/FC_H/FC_WCS_FILE/FC_OUT required');
        bootRealWasm();
        const PUB = path.join(ROOT, 'public');
        const atlasStat = { reqs: 0, hits: 0, firstMiss: '', firstHit: '' };
        StarCatalogAdapter.setAtlasLoader(async (p: string) => {
            atlasStat.reqs++;
            const full = path.join(PUB, p);
            try {
                const data = fs.readFileSync(full);
                atlasStat.hits++; if (!atlasStat.firstHit) atlasStat.firstHit = p;
                return new Response(new Uint8Array(data));
            } catch {
                if (!atlasStat.firstMiss) atlasStat.firstMiss = full;
                return new Response(null, { status: 404, statusText: 'Not Found (fs atlas loader)' });
            }
        });
        void makeFsAtlasLoader; // kept for reference

        const buf = fs.readFileSync(PLANE);
        const scienceBuffer = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        if (scienceBuffer.length !== W * H) throw new Error(`plane len ${scienceBuffer.length} != ${W}*${H}`);

        // astrometry.net (degrees, 1-based CRPIX) → internal (RA hours, 0-based crpix); cd deg/px unchanged.
        let crvalHours: number, crvalDec: number, crpix0: number[], raHours: number, decDeg: number;
        if (WCS.internal) {
            // OUR captured [BEST-CANDIDATE-WCS] — already internal (RA hours, 0-based crpix), feed verbatim.
            crvalHours = WCS.crval_hours_ra; crvalDec = WCS.crval_dec;
            crpix0 = [WCS.crpix0[0], WCS.crpix0[1]];
            raHours = WCS.ra_center_hours ?? crvalHours; decDeg = WCS.dec_center_deg ?? crvalDec;
        } else {
            crvalHours = WCS.crval_deg[0] / 15; crvalDec = WCS.crval_deg[1];
            crpix0 = [WCS.crpix1based[0] - 1, WCS.crpix1based[1] - 1];
            raHours = WCS.ra_center_deg / 15; decDeg = WCS.dec_center_deg;
        }
        // WCSTransform.cd is 2x2 nested [[cd11,cd12],[cd21,cd22]] (deg/px) — projectCatalogToPixels destructures rows.
        let cd: number[][] = WCS.internal
            ? [[WCS.cd[0][0], WCS.cd[0][1]], [WCS.cd[1][0], WCS.cd[1][1]]]
            : [[WCS.cd[0], WCS.cd[1]], [WCS.cd[2], WCS.cd[3]]];
        if (FLIP_Y) { crpix0 = [crpix0[0], (H - 1) - crpix0[1]]; cd = [[cd[0][0], cd[0][1]], [-cd[1][0], -cd[1][1]]]; }
        const detCd = Math.abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0]);
        const pixel_scale = Math.sqrt(detCd) * 3600;
        // raHours/decDeg computed above (internal-candidate vs oracle branch).
        const fov_width_deg = W * pixel_scale / 3600;
        const fov_height_deg = H * pixel_scale / 3600;

        const solution: any = {
            wcs: { crpix: crpix0, crval: [crvalHours, crvalDec], cd },
            ra_hours: raHours, dec_degrees: decDeg,
            fov_width_deg, fov_height_deg, pixel_scale,
            matched_stars: [], confidence: 1,
        };
        const detected = Array.from({ length: 50 }, () => ({ fwhm: FWHM }));

        // Pre-load atlas sectors TILING the (56°) field: runPostSolveConfirmation skips its
        // internal ensureSectorLoaded when fovR > SECTOR_LOAD_MAX_RADIUS_DEG (our wide field),
        // so with nothing pre-loaded findStarsInField returns 0. Tile small discs across it.
        const adapter = StarCatalogAdapter.getinstance();
        await adapter.loadCatalog(); // level_1/2 anchors → sets isLoaded (solver_entry.ts:218 does this in the real solve)
        const stepDeg = 8;
        let preloaded = 0;
        for (let dDec = -fov_height_deg / 2; dDec <= fov_height_deg / 2 + 1e-6; dDec += stepDeg) {
            const decP = decDeg + dDec;
            const cosd = Math.max(0.1, Math.cos(decP * Math.PI / 180));
            for (let dRA = -fov_width_deg / 2; dRA <= fov_width_deg / 2 + 1e-6; dRA += stepDeg) {
                const raP = raHours + (dRA / cosd) / 15;
                await adapter.ensureSectorLoaded(raP, decP, 6);
                preloaded++;
            }
        }
        const nRows = (await adapter.findStarsInField(raHours, decDeg, Math.max(fov_width_deg, fov_height_deg) / 2 * 1.2, 2451545)).length;
        console.log(`[FC-CONTROL] preloaded ${preloaded} discs; atlas reqs=${atlasStat.reqs} hits=${atlasStat.hits} firstHit=${atlasStat.firstHit} firstMiss=${atlasStat.firstMiss}; findStarsInField returns ${nRows} rows`);

        const deep = await runPostSolveConfirmation({
            scienceBuffer, width: W, height: H,
            solution, detected, framePsf: null, lensDistActive: false,
        });

        const out = {
            provenance: PROV,
            note: NOTE,
            plane: path.basename(PLANE), dims: `${W}x${H}`, flip_y: FLIP_Y,
            pixel_scale: +pixel_scale.toFixed(4), fov_deg: `${fov_width_deg.toFixed(1)}x${fov_height_deg.toFixed(1)}`,
            wcs_internal: { crval_ra_hours: +crvalHours.toFixed(6), crval_dec_deg: +crvalDec.toFixed(6), crpix0, cd },
            field_center: { ra_hours: +raHours.toFixed(6), dec_deg: +decDeg.toFixed(6) },
            aperture_fwhm_px: FWHM,
            deep_confirmed: deep,
        };
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
        console.log(`[FC-CONTROL] ${path.basename(PLANE)} flipY=${FLIP_Y} examined=${deep?.examined} confirmed=${deep?.confirmed} setExcessZ=${deep?.setExcessZ}σ gate=${deep?.setGatePassed ? 'PASSED' : 'COLLAPSED'} fdr=${deep?.fdr_shadow ? JSON.stringify(deep.fdr_shadow) : 'n/a'} not_measured=${deep?.not_measured ?? 'none'}`);
        expect(fs.existsSync(OUT)).toBe(true);
    });
});
