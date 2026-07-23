/**
 * FDR-SHADOW CAPTURE (measurement-only, task 2026-07-12).
 *
 * Runs the two PINNED solves (SeeStar M66 FITS · bundled CR2) through the REAL
 * wizard pipeline in Node and DUMPS the full deep_confirmed block (which carries
 * the additive `fdr_shadow` sub-block iff CONFIRM_FDR_SHADOW=1) + confirm_status +
 * the sacred solution pins to test_results/fdr_shadow_2026-07-12/receipts/.
 *
 * ALSO runs the wrong-WCS null control (SeeStar crpix += {30,70}) via
 * runPostSolveConfirmation — with the flag on these produce fdr_shadow blocks on
 * SCRAMBLED positions (HARD GATE 1: controls must stay refused under FDR).
 *
 * Output filenames are tagged with the flag state so a flag-OFF run and a
 * flag-ON run write side-by-side files a downstream analyzer diffs for
 * byte-identity of every LEGACY field (LAW-2 phase-1 invariant).
 *
 * NOTHING here changes engine behaviour — it only READS the receipt and writes
 * to test_results/. Never asserts pins itself (the apispecs own that); it emits
 * evidence for the orchestrator's phase-2 rebaseline.
 *
 *   CONFIRM_FDR_SHADOW=1 npx vitest run -c tools/confirm/fdr_capture.config.ts
 */
import { describe, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from '../api/headless_driver';
import { runPostSolveConfirmation } from '@/engine/pipeline/m6_plate_solve/solver_entry';
import type { FramePsfRef } from '@/engine/pipeline/m6_plate_solve/forced_confirm';
import { PIPELINE_CONSTANTS } from '@/engine/pipeline/constants/pipeline_config';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIT_PATH = path.join(REPO_ROOT, 'Sample Files', 'DSO_Stacked_738_M 66_60.0s_20260516_064736.fit');
const CR2_PATH = path.join(REPO_ROOT, 'public', 'demo', 'sample_observation.cr2');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const OUT_DIR = path.join(REPO_ROOT, 'test_results', 'fdr_shadow_2026-07-12', 'receipts');

const FLAG = (process.env.CONFIRM_FDR_SHADOW === '1' || process.env.CONFIRM_FDR_SHADOW === 'true');
const TAG = FLAG ? 'flagON' : 'flagOFF';

fs.mkdirSync(OUT_DIR, { recursive: true });

function dump(name: string, obj: unknown) {
    const p = path.join(OUT_DIR, `${name}.${TAG}.json`);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[fdr-capture] wrote ${p}`);
}

/** Extract the fields the evidence table needs from a receipt. */
function summarize(frame: string, receipt: any, deep: any) {
    const sol = receipt?.solution ?? {};
    const cs = receipt?.confirm_status ?? null;
    const fs2 = deep?.fdr_shadow ?? null;
    return {
        frame,
        flag: FLAG,
        // sacred solve pins (byte-identity witnesses)
        ra_hours: sol.ra_hours ?? null,
        dec_degrees: sol.dec_degrees ?? null,
        pixel_scale: sol.pixel_scale ?? null,
        confidence: sol.confidence ?? null,
        stars_matched: sol.stars_matched ?? null,
        receipt_version: receipt?.version ?? null,
        // legacy confirm verdict
        confirm_status: cs?.status ?? null,
        n_examined: deep?.examined ?? null,
        n_confirmed_legacy: deep?.confirmed ?? null,
        legacy_setExcessZ: deep?.setExcessZ ?? null,
        legacy_setGatePassed: deep?.setGatePassed ?? null,
        setGateZ: cs?.setGateZ ?? PIPELINE_CONSTANTS.SOLVER_CONFIRM_SET_EXCESS_Z,
        // FDR shadow statistic (present only when FLAG)
        fdr_present: !!fs2,
        fdr_method: fs2?.method ?? null,
        fdr_q: fs2?.q ?? null,
        fdr_null_total: fs2?.null_total ?? null,
        fdr_n_confirmed: fs2?.n_confirmed_fdr ?? null,
        fdr_n_confirmed_bh_ref: fs2?.n_confirmed_bh_ref ?? null,
        fdr_p_threshold: fs2?.p_value_threshold ?? null,
        fdr_by_correction: fs2?.by_correction ?? null,
        fdr_p1: fs2?.effect_size?.p1 ?? null,
        fdr_p0: fs2?.effect_size?.p0 ?? null,
        fdr_rate_ratio: fs2?.effect_size?.rate_ratio ?? null,
        fdr_rate_ratio_wilson_lower: fs2?.effect_size?.rate_ratio_wilson_lower ?? null,
        fdr_p1_wilson_lower: fs2?.effect_size?.p1_wilson_lower ?? null,
        fdr_confirm_rate: fs2?.effect_size?.fdr_confirm_rate ?? null,
    };
}

const SUMMARIES: any[] = [];

describe(`FDR-shadow capture (${TAG})`, () => {
    it('SeeStar M66 (N-large pin) + wrong-WCS null controls', async () => {
        const buf = fs.readFileSync(FIT_PATH);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        const { receipt, session } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });
        const s = session as any;
        const deep = (session.solution as any)?.deep_confirmed ?? (receipt as any)?.deep_confirmed ?? null;
        dump('seestar_m66', { confirm_status: receipt.confirm_status, deep_confirmed: deep,
            solution_pins: summarize('SeeStar_M66', receipt, deep) });
        SUMMARIES.push(summarize('SeeStar_M66', receipt, deep));
        // eslint-disable-next-line no-console
        console.log(`[fdr-capture] SeeStar legacy z=${deep?.setExcessZ} gate=${deep?.setGatePassed} | FDR n_conf=${deep?.fdr_shadow?.n_confirmed_fdr} ratio=${deep?.fdr_shadow?.effect_size?.rate_ratio} ratioWilson=${deep?.fdr_shadow?.effect_size?.rate_ratio_wilson_lower}`);

        // ── wrong-WCS null controls (mirror confirm_null_evidence.apispec) ──
        const solution = session.solution!;
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
        const wcs = (solution as any).wcs;
        const detected = ((solution as any).matched_stars ?? []).map((m: any) => ({ fwhm: m.detected?.fwhm }));
        for (const off of [30, 70]) {
            const wrongSolution = { ...solution, wcs: { ...wcs, crpix: [wcs.crpix[0] + off, wcs.crpix[1] + off] } };
            const dc: any = await runPostSolveConfirmation({
                scienceBuffer: sb, width: bw, height: bh,
                solution: wrongSolution as any, detected, framePsf, lensDistActive: false,
            });
            dump(`seestar_wrongWCS_crpix+${off}`, { deep_confirmed: dc });
            const row = summarize(`SeeStar_wrongWCS_crpix+${off}`, receipt, dc);
            SUMMARIES.push(row);
            // eslint-disable-next-line no-console
            console.log(`[fdr-capture] WRONG+${off} examined=${dc?.examined} legacy z=${dc?.setExcessZ} gate=${dc?.setGatePassed} | FDR n_conf=${dc?.fdr_shadow?.n_confirmed_fdr} ratio=${dc?.fdr_shadow?.effect_size?.rate_ratio}`);
        }
    });

    it('bundled CR2 (N-small pin)', async () => {
        const buf = fs.readFileSync(CR2_PATH);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        const { receipt, session } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });
        const deep = (session.solution as any)?.deep_confirmed ?? (receipt as any)?.deep_confirmed ?? null;
        dump('cr2', { confirm_status: receipt.confirm_status, deep_confirmed: deep,
            solution_pins: summarize('CR2', receipt, deep) });
        SUMMARIES.push(summarize('CR2', receipt, deep));
        // eslint-disable-next-line no-console
        console.log(`[fdr-capture] CR2 legacy z=${deep?.setExcessZ} gate=${deep?.setGatePassed} | FDR n_conf=${deep?.fdr_shadow?.n_confirmed_fdr} ratio=${deep?.fdr_shadow?.effect_size?.rate_ratio} ratioWilson=${deep?.fdr_shadow?.effect_size?.rate_ratio_wilson_lower}`);
    });

    it('flush summaries JSONL', () => {
        const p = path.join(REPO_ROOT, 'test_results', 'fdr_shadow_2026-07-12', `summaries.${TAG}.jsonl`);
        fs.writeFileSync(p, SUMMARIES.map(r => JSON.stringify(r)).join('\n') + '\n');
        // eslint-disable-next-line no-console
        console.log(`[fdr-capture] wrote ${p} (${SUMMARIES.length} rows)`);
    });
});
