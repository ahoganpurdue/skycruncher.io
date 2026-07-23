/**
 * DEEP-CONFIRM SET-GATE CALIBRATION SWEEP (readiness-map item D).
 * ══════════════════════════════════════════════════════════════════════════
 * ADD-EVIDENCE, READ-ONLY on the confirm modules. Does NOT change any gate.
 *
 * The set-level confirmation gate SOLVER_CONFIRM_SET_EXCESS_Z=15 was calibrated
 * on N=1 (SeeStar M66). This harness BROADENS the evidence: for every locally
 * available FITS frame that can actually exercise forced-confirm, it measures
 * the TRUE-WCS confirmed-set excess-Z (produced in-pipeline at the fitted WCS)
 * vs. the MAX wrong-WCS excess-Z across a sweep of crpix offsets (the scrambled
 * null — every offset projects the true catalog stars off their real pixels, so
 * every "confirmation" would be false). A gate at 15σ is validated iff on EVERY
 * qualifying frame TRUE ≫ 15σ ≫ MAX-WRONG.
 *
 * A frame QUALIFIES only if it (a) solves via the session path, (b) has a
 * coherent native science buffer post-solve, (c) has a measured (non-undersampled)
 * frame PSF, (d) runs with no active lens prior. Frames that honest-skip
 * (undersampled DSLR / no science buffer / no solve) are recorded as such —
 * that is itself calibration evidence (the gate is never exercised there).
 *
 * Writes test_results/deep_confirm_calibration.json (consumed by the report).
 * Run: npx vitest run -c tools/api/api_harness.config.ts tools/api/confirm_calibration.apispec.ts
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
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const GATE = PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z;

// Candidate frames: DIFFERENT targets are the gold. Order = control first.
interface FrameSpec { rel: string; target: string; note: string; }
const FRAMES: FrameSpec[] = [
    { rel: 'Sample Files/DSO_Stacked_738_M 66_60.0s_20260516_064736.fit', target: 'M66',  note: 'N=1 anchor (SeeStar S30, 160mm)' },
    { rel: 'Sample Files/corpus/M51/M51 IRCUT 150h.fit',                   target: 'M51',  note: 'DIFFERENT target — SeeStar S50 250mm, RA/DEC hint, well-sampled' },
    { rel: 'Sample Files/corpus/M51/M50_2X_Best20h_Zcom/M50_2X_Best20h_Zcom.fits', target: 'M51', note: 'DIFFERENT target — SeeStar S50 250mm 2x, larger canvas' },
    { rel: 'Sample Files/corpus/M51/M51_Top65%_Zcom/M51_Top65%_Zcom.fits', target: 'M51',  note: 'SeeStar S50, RA/DEC=0 in header (blind hint stripped)' },
    { rel: 'Sample Files/rotating/carina60Da_180s_iso800_001.fit',         target: 'Carina', note: 'DSLR (Canon 60D) single-channel wide field, no scale hint — expected honest-skip/no-solve' },
];

const OFFSETS = [18, 30, 45, 70, 120];

type FrameResult = Record<string, any>;
const results: FrameResult[] = [];

describe('deep-confirm set-gate calibration sweep (broaden N=1)', () => {
    for (const fr of FRAMES) {
        it(`${fr.target}: ${path.basename(fr.rel)}`, async () => {
            const abs = path.join(REPO_ROOT, fr.rel);
            const row: FrameResult = { frame: path.basename(fr.rel), target: fr.target, note: fr.note };
            if (!fs.existsSync(abs)) {
                row.status = 'MISSING_ASSET';
                results.push(row); console.log(`[CAL] ${fr.target}: MISSING ${abs}`); return;
            }
            const buf = fs.readFileSync(abs);
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

            let session: any, solution: any;
            try {
                const out = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });
                session = out.session; solution = out.session.solution;
            } catch (e) {
                row.status = 'PIPELINE_THREW'; row.error = String(e instanceof Error ? e.message : e);
                results.push(row); console.log(`[CAL] ${fr.target}: THREW ${row.error}`); return;
            }

            if (!solution || !solution.wcs) {
                row.status = 'NO_SOLVE';
                results.push(row); console.log(`[CAL] ${fr.target}: NO_SOLVE (no WCS)`); return;
            }
            row.ra_hours = solution.ra_hours;
            row.dec_deg = solution.dec_degrees;
            row.matched = solution.matched_stars?.length ?? 0;
            row.scale = solution.pixscale_arcsec ?? solution.scale_arcsec_per_px ?? null;

            // ── TRUE: in-pipeline confirmation at the fitted WCS ──
            const dc = solution.deep_confirmed;
            if (!dc) {
                row.status = 'SOLVED_NO_CONFIRM';
                results.push(row); console.log(`[CAL] ${fr.target}: SOLVED but deep_confirmed missing`); return;
            }
            row.trueExcessZ = dc.setExcessZ;
            row.trueConfirmed = dc.confirmed;
            row.trueExamined = dc.examined;
            row.trueGatePassed = dc.setGatePassed;
            row.trueGrid = dc.grid;
            row.framePsfSource = dc.framePsf?.source ?? null;
            row.framePsfFwhm = dc.framePsf?.fwhmPx ?? null;
            row.trueNotMeasured = dc.not_measured ?? null;

            // Determine qualification: measured, non-undersampled PSF + native buffer.
            const psfField = session.psfField;
            const undersampled = psfField?.fwhmMedianMajPx != null
                && psfField.fwhmMedianMajPx < PIPELINE_CONSTANTS.SOLVER_CONFIRM_UNDERSAMPLED_FWHM_PX;
            row.undersampled = !!undersampled;
            row.psfFwhmMedian = psfField?.fwhmMedianMajPx ?? null;

            // ── WRONG: same native buffer + frame PSF, crpix offset sweep ──
            const sb: Float32Array = session.scienceBuffer;
            if (!sb) {
                row.status = 'NO_SCIENCE_BUFFER';
                results.push(row); console.log(`[CAL] ${fr.target}: no native science buffer post-solve`); return;
            }
            const isBinned = sb.length === (Math.floor(session.imageWidth / 2) * Math.floor(session.imageHeight / 2))
                && sb.length !== session.imageWidth * session.imageHeight;
            const bw = isBinned ? Math.floor(session.imageWidth / 2) : session.imageWidth;
            const bh = isBinned ? Math.floor(session.imageHeight / 2) : session.imageHeight;
            const framePsf: FramePsfRef | null = (psfField && psfField.fwhmMedianMajPx != null) ? {
                fwhmPx: psfField.fwhmMedianMajPx,
                ellipticity: psfField.ellipticityMedian,
                source: psfField.method,
                undersampled: !!undersampled,
            } : null;
            const wcs = solution.wcs;
            const detected = (solution.matched_stars ?? []).map((m: any) => ({ fwhm: m.detected?.fwhm }));

            const sweep: any[] = [];
            let maxWrongExcess = -Infinity, maxWrongConfirmed = 0;
            for (const off of OFFSETS) {
                const wrongSolution = { ...solution, wcs: { ...wcs, crpix: [wcs.crpix[0] + off, wcs.crpix[1] + off] } };
                const w = await runPostSolveConfirmation({
                    scienceBuffer: sb, width: bw, height: bh,
                    solution: wrongSolution as any, detected, framePsf,
                });
                const z = w?.setExcessZ ?? null;
                const c = w?.confirmed ?? 0;
                sweep.push({ off, examined: w?.examined ?? 0, confirmed: c, excessZ: z, gate: w?.setGatePassed ?? false });
                if (z != null) maxWrongExcess = Math.max(maxWrongExcess, z);
                maxWrongConfirmed = Math.max(maxWrongConfirmed, c);
            }
            row.wrongSweep = sweep;
            row.maxWrongExcess = Number.isFinite(maxWrongExcess) ? maxWrongExcess : null;
            row.maxWrongConfirmed = maxWrongConfirmed;
            // Qualifies if it produced a real confirmed set at the true WCS.
            row.status = (row.trueConfirmed > 0 && row.trueGatePassed) ? 'QUALIFIED'
                : (row.trueNotMeasured ? 'HONEST_SKIP' : 'SOLVED_ZERO_CONFIRM');
            // Separation margins vs the 15σ gate.
            row.trueMarginAboveGate = (row.trueExcessZ != null) ? (row.trueExcessZ - GATE) : null;
            row.wrongMarginBelowGate = (row.maxWrongExcess != null) ? (GATE - row.maxWrongExcess) : null;

            results.push(row);
            console.log(`[CAL] ${fr.target} ${row.status}: TRUE ${row.trueExcessZ}σ (${row.trueConfirmed}/${row.trueExamined}, gate ${row.trueGatePassed ? 'PASS' : 'COLLAPSE'}) · MAX-WRONG ${row.maxWrongExcess?.toFixed?.(1) ?? 'n/a'}σ (${row.maxWrongConfirmed} confirmed) · psf ${row.framePsfSource} fwhm=${row.framePsfFwhm?.toFixed?.(2) ?? 'n/a'}${undersampled ? ' UNDERSAMPLED' : ''} · gate=${GATE}σ`);
        }, 480_000); // ceiling > 360s rawler blind budget (D-uw-rawler-budget-360) — harness never kills a solve the engine still owns
    }

    it('ZZ_writes JSON summary', () => {
        const outDir = path.join(REPO_ROOT, 'test_results');
        fs.mkdirSync(outDir, { recursive: true });
        const payload = { when: new Date().toISOString(), gate: GATE, offsets: OFFSETS, rows: results };
        fs.writeFileSync(path.join(outDir, 'deep_confirm_calibration.json'), JSON.stringify(payload, null, 2));
        console.log(`[CAL] wrote deep_confirm_calibration.json (${results.length} rows)`);
        expect(results.length).toBeGreaterThan(0);
    });
});
