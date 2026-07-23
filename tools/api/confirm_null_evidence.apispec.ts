/**
 * FALSE-CONFIRM NULL EVIDENCE (FP wave C) — on a REAL frame (SeeStar M66), the
 * set-level confirmation gate must CONFIRM true catalog positions and COLLAPSE
 * to zero when the WCS is wrong (every predicted position is then off the real
 * stars, so every "confirmation" would be false by construction). This is the
 * proof the critique demanded: junk does NOT get stamped CONFIRMED.
 *
 * TRUE  = session.solution.deep_confirmed (produced in-pipeline at the fitted WCS).
 * WRONG = the SAME native science buffer + measured frame PSF, re-run with the
 *         fitted WCS shifted by a fixed pixel offset (crpix += 30) so the true
 *         catalog stars project ~30 px off their real pixels.
 *
 * Run: npx vitest run -c tools/api/api_harness.config.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from './headless_driver';
import { runPostSolveConfirmation } from '@/engine/pipeline/m6_plate_solve/solver_entry';
import type { FramePsfRef } from '@/engine/pipeline/m6_plate_solve/forced_confirm';
import { PIPELINE_CONSTANTS } from '@/engine/pipeline/constants/pipeline_config';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIT_PATH = path.join(REPO_ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');

describe('forced-confirm null evidence — true confirms, wrong-WCS collapses (SeeStar M66)', () => {
    it('confirms at the fitted WCS and collapses to ZERO at a wrong WCS', async () => {
        expect(fs.existsSync(FIT_PATH), `sample FITS missing at ${FIT_PATH} (local-only asset)`).toBe(true);
        const buf = fs.readFileSync(FIT_PATH);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        const { session } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });
        const s = session as any;
        const solution = session.solution!;
        expect(solution).toBeTruthy();

        // Sacred numbers stay exact WITH the confirmation stage live (additive).
        expect(solution.ra_hours).toBe(11.341267568475146);
        expect(solution.matched_stars?.length).toBe(265);

        // ── TRUE: the in-pipeline confirmation at the fitted WCS ──
        const trueDC = solution.deep_confirmed;
        expect(trueDC, 'deep_confirmed missing — confirmation stage did not run').toBeTruthy();
        console.log(`[NULL-EVIDENCE] TRUE  WCS: ${trueDC.confirmed}/${trueDC.examined} confirmed · setExcessZ ${trueDC.setExcessZ}σ · gate ${trueDC.setGatePassed ? 'PASSED' : 'COLLAPSED'} · grid ${trueDC.grid} · framePsf ${trueDC.framePsf?.source} fwhm=${trueDC.framePsf?.fwhmPx?.toFixed(2)}`);

        // ── WRONG: same native buffer + frame PSF, WCS shifted crpix += 30 px ──
        const sb: Float32Array = s.scienceBuffer;
        const isBinned = sb.length === (Math.floor(s.imageWidth / 2) * Math.floor(s.imageHeight / 2))
            && sb.length !== s.imageWidth * s.imageHeight;
        const bw = isBinned ? Math.floor(s.imageWidth / 2) : s.imageWidth;
        const bh = isBinned ? Math.floor(s.imageHeight / 2) : s.imageHeight;
        const framePsf: FramePsfRef | null = (s.psfField && s.psfField.fwhmMedianMajPx != null) ? {
            fwhmPx: s.psfField.fwhmMedianMajPx,
            ellipticity: s.psfField.ellipticityMedian,
            source: s.psfField.method,
            undersampled: s.psfField.fwhmMedianMajPx < PIPELINE_CONSTANTS.SOLVER_CONFIRM_UNDERSAMPLED_FWHM_PX,
        } : null;

        const wcs = solution.wcs;
        const detected = (solution.matched_stars ?? []).map((m: any) => ({ fwhm: m.detected?.fwhm }));
        // Sweep wrong-WCS crpix offsets to map the false-confirm margin: every
        // offset makes true catalog stars project off their real pixels, so
        // every confirmation would be false. The set gate must collapse ALL.
        const offsets = [18, 30, 45, 70, 120];
        let maxWrongExcess = -Infinity, maxWrongConfirmed = 0;
        for (const off of offsets) {
            const wrongSolution = { ...solution, wcs: { ...wcs, crpix: [wcs.crpix[0] + off, wcs.crpix[1] + off] } };
            const dc = await runPostSolveConfirmation({
                scienceBuffer: sb, width: bw, height: bh,
                solution: wrongSolution as any, detected, framePsf,
            });
            expect(dc).toBeTruthy();
            const z = dc!.setExcessZ ?? 0;
            maxWrongExcess = Math.max(maxWrongExcess, z);
            maxWrongConfirmed = Math.max(maxWrongConfirmed, dc!.confirmed);
            console.log(`[NULL-EVIDENCE] WRONG WCS crpix+${off}px: examined=${dc!.examined} confirmed=${dc!.confirmed} setExcessZ=${z}σ gate=${dc!.setGatePassed ? 'PASSED' : 'COLLAPSED'}`);
        }
        console.log(`[NULL-EVIDENCE] SUMMARY: TRUE excess ${trueDC.setExcessZ}σ (confirmed ${trueDC.confirmed}) · MAX wrong excess ${maxWrongExcess.toFixed(1)}σ (gate ${PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z}σ) · MAX wrong confirmed ${maxWrongConfirmed}`);

        // ── The proof ──
        expect(trueDC.setGatePassed).toBe(true);
        expect(trueDC.confirmed).toBe(29); // real OUT-OF-SAMPLE stars confirm (F3 family-honest rebaseline, row 549)
        expect(trueDC.setExcessZ).toBeGreaterThan(PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z);
        expect(maxWrongConfirmed).toBe(0);                    // EVERY wrong WCS → ZERO confirmed
    });
});
