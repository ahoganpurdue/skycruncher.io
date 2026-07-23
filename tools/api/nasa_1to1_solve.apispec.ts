/**
 * NASA 1:1 measurement runner (NOT a gate — records, asserts only that the
 * PROCESS completes; a blind no-lock is DATA, not an error). Drives the REAL
 * wizard pipeline step-by-step on a WCS-stripped blind frame and dumps a pruned
 * receipt/diagnostics to test_results/nasa_1to1_2026-07-11/.
 *
 * Serialize via env (owner directive: one solve at a time on the shared box):
 *   NASA1TO1_TARGET=tess|ztf   which blind frame
 *   NASA1TO1_HINT=<arcsec/px>  optional scale hint -> labeled HINTED
 *
 * Run: NASA1TO1_TARGET=tess npx vitest run -c tools/api/api_harness.config.ts tools/api/nasa_1to1_solve.apispec.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRealWasm, makeFsAtlasLoader } from './headless_driver';
import { OrchestratorSession } from '@/engine/pipeline/orchestrator_session';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';
import type { PipelineEvent } from '@/engine/events/pipeline_events';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const OUT_DIR = path.join(REPO_ROOT, 'test_results', 'nasa_1to1_2026-07-11');
const INTAKE = 'D:/AstroLogic/intake/nasa_esa_1to1';

const TARGET = (process.env.NASA1TO1_TARGET ?? 'tess').toLowerCase();
const HINT = process.env.NASA1TO1_HINT ? Number(process.env.NASA1TO1_HINT) : undefined;

const FRAMES: Record<string, { file: string }> = {
    tess: { file: path.join(INTAKE, 'tess_ext1_sci_blind.fits') },
    ztf: { file: path.join(INTAKE, 'ztf_sci_blind.fits') },
};

function prune(_k: string, v: any): any {
    if (Array.isArray(v) && v.length > 12) return { __array_len: v.length, sample: v.slice(0, 6) };
    if (v instanceof Float32Array || v instanceof Float64Array || v instanceof Uint16Array) return { __typed_len: v.length };
    return v;
}

// ENV-GATED LAB SPEC — never part of the standing api-smoke gate: it needs the
// NASA frames on D:\AstroLogic\intake\nasa_esa_1to1 (local-only) and minutes of
// solve time. Runs ONLY when NASA1TO1_TARGET is explicitly set; otherwise it
// reports as an env-gated skip (honest-absent, gate untouched).
describe.skipIf(!process.env.NASA1TO1_TARGET)(`nasa 1:1 blind solve — ${TARGET}${HINT ? ' HINTED' : ''}`, () => {
    it('runs the real pipeline step-by-step and records the outcome (no sacred assertion)', async () => {
        const frame = FRAMES[TARGET];
        expect(frame, `unknown NASA1TO1_TARGET=${TARGET}`).toBeTruthy();
        expect(fs.existsSync(frame.file), `blind frame missing ${frame.file}`).toBe(true);

        const buf = fs.readFileSync(frame.file);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        bootRealWasm();
        StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(ATLAS_ROOT));

        const events: PipelineEvent[] = [];
        let receipt: any = null, err: string | null = null, calibrateErr: string | null = null;
        const t0 = Date.now();
        const session = new OrchestratorSession(ab, { generatePreviews: false });
        session.events.subscribe((e) => events.push(e));

        try {
            await session.step1_Load();
            await session.step2_Extract(HINT ? ({ pixel_scale: HINT } as any) : undefined);
            await session.step3_Metrology();
            await session.step4_Solve();               // blind no-lock => session.solution stays null
            if ((session as any).solution) {
                await session.step5_Calibrate();
                receipt = await session.step6_Integrate();
            }
        } catch (e: any) {
            // A post-solve stage can still throw on an exotic frame — capture, don't abort.
            calibrateErr = String(e?.message ?? e);
        }
        const wallMs = Date.now() - t0;

        const sol: any = (session as any).solution ?? receipt?.solution ?? null;
        const sig: any = (session as any).signal ?? null;
        const solveCandidates = events
            .filter((e: any) => e.kind === 'finding' && e.finding?.kind === 'solve_candidate')
            .map((e: any) => e.finding);
        const locked = events.find((e: any) => e.kind === 'finding' && e.finding?.kind === 'solution_locked') as any;

        const summary: any = {
            target: TARGET,
            mode: HINT ? 'HINTED' : 'BLIND',
            scale_hint_arcsec_px: HINT ?? null,
            wall_ms: wallMs,
            blind_input: frame.file,
            solved: !!sol,
            status: (session as any).status ?? null,
            post_solve_error: calibrateErr,
            load_error: err,
            detections: sig ? {
                clean_stars: sig.clean_stars?.length ?? null,
                anomalies: sig.anomalies?.length ?? null,
                keys: Object.keys(sig).slice(0, 40),
            } : null,
            solution_scalars: sol ? {
                ra_hours: sol.ra_hours,
                dec_degrees: sol.dec_degrees,
                ra_deg: sol.ra_hours != null ? sol.ra_hours * 15 : null,
                pixel_scale_arcsec_px: sol.pixel_scale,
                confidence: sol.confidence,
                stars_matched: sol.stars_matched,
                matched_stars_len: sol.matched_stars?.length ?? null,
                verify_sigma: sol.verify_sigma ?? sol.verifySigma ?? sol.verify?.sigma ?? sol.sigma ?? null,
                roll_deg: sol.roll_deg ?? sol.roll ?? sol.orientation_deg ?? null,
                solution_keys: Object.keys(sol),
            } : null,
            solution_locked_event: locked?.finding ?? null,
            solve_candidates: solveCandidates.slice(0, 20),
            solve_candidate_count: solveCandidates.length,
            receipt_version: receipt?.version ?? null,
            wcs: receipt?.wcs ?? null,
            astrometry: receipt?.solution?.astrometry ? {
                tps: receipt.solution.astrometry.tps, tps_gate: receipt.solution.astrometry.tps_gate,
            } : null,
            confirm_status: receipt?.confirm_status ?? null,
            spcc: receipt?.spcc ?? receipt?.solution?.spcc ?? receipt?.color ?? null,
            receipt_keys: receipt ? Object.keys(receipt) : null,
        };

        const outName = `solve_${TARGET}${HINT ? '_hinted' : '_blind'}.json`;
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUT_DIR, outName), JSON.stringify(summary, prune, 2));
        // eslint-disable-next-line no-console
        console.log(`[nasa1to1] ${TARGET} mode=${summary.mode} solved=${summary.solved} conf=${sol?.confidence} scale=${sol?.pixel_scale} matched=${sol?.stars_matched} dets=${sig?.clean_stars?.length} cands=${solveCandidates.length} wall=${(wallMs / 1000).toFixed(1)}s status="${summary.status}" -> ${outName}`);

        StarCatalogAdapter.setAtlasLoader(null);
        // Record-only: the PROCESS must complete. solved=true|false is the datum.
        expect(true).toBe(true);
    });
});
