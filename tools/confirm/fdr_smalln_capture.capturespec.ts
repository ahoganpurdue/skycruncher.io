/**
 * FDR-SHADOW SMALL-N CAPTURE (measurement-only, task 2026-07-12) — the
 * DISAGREEMENT hunt. Re-solves reachable population frames that the LEGACY set-
 * excess gate REFUSED at small N (z < 15 despite clearly-real solves), with
 * CONFIRM_FDR_SHADOW=1, to record the NEW-statistic verdict alongside the old one.
 * These are the cases the ruling predicts diverge (√N punishment of small N).
 *
 * Frames chosen from the banked old-statistic baseline (small nTargets, REFUSED,
 * large matched-star count ⇒ unambiguously real). Flag-ON only (byte-identity is
 * proven on the pins in fdr_shadow_capture). Each frame is fail-soft: a solve/
 * confirm miss is recorded, the loop continues.
 *
 *   CONFIRM_FDR_SHADOW=1 npx vitest run -c tools/confirm/fdr_capture.config.ts smalln
 */
import { describe, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizardPipeline } from '../api/headless_driver';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const OUT_DIR = path.join(REPO_ROOT, 'test_results', 'fdr_shadow_2026-07-12', 'receipts');
const ROT = 'D:/AstroLogic/SampleFiles/rotating';
fs.mkdirSync(OUT_DIR, { recursive: true });

// [label, absolute path, banked old-stat context]
const FRAMES: [string, string, string][] = [
    ['r_mosaic_B',   `${ROT}/r_mosaic_B.fits`,                          'REFUSED N=22 z=13.58 matched=236'],
    ['r_mosaic_H',   `${ROT}/r_mosaic_H.fits`,                          'REFUSED N=14 z=9.59 matched=201'],
    ['M31_90s',      `${ROT}/Andromeda Galaxy M31 90s-431_ISO100.fit`,  'CANARY REFUSED N=126 z=6.85 matched=2654'],
    ['Markarians',   `${ROT}/Markarians Chain_90s-331_L3_stacked.fit`,  'REFUSED N=14 z=-0.50 matched=149'],
];

const SUM: any[] = [];

describe('FDR-shadow small-N disagreement capture (flagON)', () => {
    for (const [label, fpath, ctx] of FRAMES) {
        it(`${label} (${ctx})`, async () => {
            const row: any = { frame: label, banked_context: ctx, file_present: fs.existsSync(fpath) };
            if (!row.file_present) { row.error = 'FILE_ABSENT'; SUM.push(row); return; }
            try {
                const buf = fs.readFileSync(fpath);
                const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
                const { receipt, session } = await runWizardPipeline(ab, { atlasRoot: ATLAS_ROOT });
                const sol: any = (session.solution as any) ?? receipt?.solution ?? null;
                const deep: any = sol?.deep_confirmed ?? (receipt as any)?.deep_confirmed ?? null;
                const cs: any = (receipt as any)?.confirm_status ?? null;
                const fdr: any = deep?.fdr_shadow ?? null;
                Object.assign(row, {
                    solved: !!sol?.ra_hours,
                    stars_matched: sol?.stars_matched ?? sol?.matched_stars?.length ?? null,
                    confirm_status: cs?.status ?? null,
                    n_examined: deep?.examined ?? null,
                    n_confirmed_legacy: deep?.confirmed ?? null,
                    legacy_setExcessZ: deep?.setExcessZ ?? null,
                    legacy_setGatePassed: deep?.setGatePassed ?? null,
                    fdr_present: !!fdr,
                    fdr_method: fdr?.method ?? null,
                    fdr_null_total: fdr?.null_total ?? null,
                    fdr_n_confirmed: fdr?.n_confirmed_fdr ?? null,
                    fdr_n_confirmed_bh_ref: fdr?.n_confirmed_bh_ref ?? null,
                    fdr_p_threshold: fdr?.p_value_threshold ?? null,
                    fdr_p1: fdr?.effect_size?.p1 ?? null,
                    fdr_p0: fdr?.effect_size?.p0 ?? null,
                    fdr_rate_ratio: fdr?.effect_size?.rate_ratio ?? null,
                    fdr_rate_ratio_wilson_lower: fdr?.effect_size?.rate_ratio_wilson_lower ?? null,
                    fdr_confirm_rate: fdr?.effect_size?.fdr_confirm_rate ?? null,
                });
                fs.writeFileSync(path.join(OUT_DIR, `smalln_${label}.flagON.json`),
                    JSON.stringify({ confirm_status: cs, deep_confirmed: deep }, null, 2));
                // eslint-disable-next-line no-console
                console.log(`[fdr-smalln] ${label}: legacy z=${deep?.setExcessZ} gate=${deep?.setGatePassed} status=${cs?.status} N=${deep?.examined} | FDR n_conf=${fdr?.n_confirmed_fdr} ratio=${fdr?.effect_size?.rate_ratio} ratioWilson=${fdr?.effect_size?.rate_ratio_wilson_lower}`);
            } catch (e: any) {
                row.error = String(e?.message ?? e).slice(0, 200);
                // eslint-disable-next-line no-console
                console.log(`[fdr-smalln] ${label}: ERROR ${row.error}`);
            }
            SUM.push(row);
        });
    }

    it('flush small-N JSONL', () => {
        const p = path.join(REPO_ROOT, 'test_results', 'fdr_shadow_2026-07-12', 'summaries.smalln.flagON.jsonl');
        fs.writeFileSync(p, SUM.map(r => JSON.stringify(r)).join('\n') + '\n');
        // eslint-disable-next-line no-console
        console.log(`[fdr-smalln] wrote ${p} (${SUM.length} rows)`);
    });
});
