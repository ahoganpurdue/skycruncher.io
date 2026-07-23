/**
 * COCOON 60Da rig — arm-C (hinted) rawler-ON confirmation driver (2026-07-11).
 *
 *   VITE_DECODER_RAWLER=1 npx vitest run -c tools/api/cocoon_rawler_hint.config.ts
 *
 * Isolated lane (own config includes ONLY this file — never touches the a5 sweep).
 * Drives the REAL wizard pipeline (OrchestratorSession → compiled wasm,
 * headless_driver boot) on the cocoon 60Da light frames:
 *   - arm C  : rawler-ON HINTED (COCOON_HINT: pointing + FL)  — the deliverable
 *   - arm B' : rawler-ON BLIND (no hints)                     — OPT-IN cross-check
 *
 * FRAME LIST (extended 2026-07-12, HINTED-COCOON run, proxy A1): the 11 Cocoon
 * population lights L_0020..L_0030 (test_results/population_run_2026-07-11/
 * manifest.json rows). Precedent frame L_0020 = 3171 matched, 10.5s, sep 0.444°,
 * scale 2.006"/px. The other 10 were INFERRED-similar; this run measures them.
 * The 14 correlated-skip siblings (L_0031..L_0039, L_0050, L_0052..L_0055) ride
 * the day lane after these verify — NOT run here.
 *
 * ARMS: hinted runs on every frame. Blind is OPT-IN (COCOON_BLIND=1) and default
 * OFF — the L_0020 blind precedent (honest_failure, ~195s) is already banked, and
 * blind on 10 correlated siblings costs ~195s each for zero new information.
 *
 * PROVENANCE: hinted solves are ASSISTED (solve_provenance solved_via
 * 'assisted:user' territory — the hint is a recorded search prior). They bank as
 * ASSISTED, never conflated with blind solves.
 *
 * Truth-grade = independent named-target IC 5146 (a NAME, not a measurement):
 *   RA 21h53m29s = 21.891h, Dec +47°16' = +47.267°; expected scale ≈ 2.06"/px
 *   (WO Zenithstar 73, 430mm, 60D APS-C 4.30µm). Center tol 2.5° (framing margin).
 * Writes ONLY under test_results/. src/ untouched. MEASUREMENT ONLY.
 */
import { describe, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRealWasm, makeFsAtlasLoader } from './headless_driver';
import { OrchestratorSession } from '@/engine/pipeline/orchestrator_session';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const OUT = process.env.COCOON_OUT
    ? path.resolve(process.env.COCOON_OUT)
    : path.join(REPO_ROOT, 'test_results', 'rawler_3rig_2026-07-11', 'cocoon_headless.jsonl');

const LIGHTS_DIR = path.join(REPO_ROOT, 'Sample Files', 'corpus', 'cocoon_60da', 'lights');
// The 11 Cocoon population lights (manifest rows L_0020..L_0030). Exact basenames.
const COCOON_LIGHTS = [
    'L_0020_ISO800_240s__18C.CR2',
    'L_0021_ISO800_240s__17C.CR2',
    'L_0022_ISO800_240s__18C.CR2',
    'L_0023_ISO800_240s__16C.CR2',
    'L_0024_ISO800_240s__16C.CR2',
    'L_0025_ISO800_240s__19C.CR2',
    'L_0026_ISO800_240s__17C.CR2',
    'L_0027_ISO800_240s__19C.CR2',
    'L_0028_ISO800_240s__19C.CR2',
    'L_0029_ISO800_240s__19C.CR2',
    'L_0030_ISO800_240s__18C.CR2',
];
const FRAMES = process.env.COCOON_FRAME
    ? [path.resolve(process.env.COCOON_FRAME)]
    : COCOON_LIGHTS.map((f) => path.join(LIGHTS_DIR, f));

const IC5146 = { ra_hours: 21.891, dec_degrees: 47.267 };
const EXPECTED_SCALE = 2.06; // "/px, DERIVED from rig specs (for post-hoc evaluation only)
const COCOON_HINT = { ra_hint: 21.891, dec_hint: 47.267, focal_length_hint_mm: 430 };

fs.mkdirSync(path.dirname(OUT), { recursive: true });

function centerSepDeg(raH: number, decD: number): number {
    const d2r = Math.PI / 180;
    const ra1 = raH * 15 * d2r, ra2 = IC5146.ra_hours * 15 * d2r;
    const de1 = decD * d2r, de2 = IC5146.dec_degrees * d2r;
    const c = Math.sin(de1) * Math.sin(de2) + Math.cos(de1) * Math.cos(de2) * Math.cos(ra1 - ra2);
    return Math.acos(Math.max(-1, Math.min(1, c))) / d2r;
}

async function runOne(frame: string, tag: string, overrides?: Record<string, unknown>) {
    const t0 = Date.now();
    bootRealWasm();
    StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(ATLAS_ROOT));
    let session: any = null;
    try {
        const buf = fs.readFileSync(frame);
        const buffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        session = new OrchestratorSession(buffer, { generatePreviews: false });
        await session.step1_Load();
        await session.step2_Extract(overrides as any);
        await session.step3_Metrology();
        await session.step4_Solve();
        const sol = session.solution ?? null;
        const clean = session?.signal?.clean_stars?.length ?? null;
        const meta = session?.metadata ?? {};
        const wall_ms = Date.now() - t0;
        const ra = sol?.ra_hours ?? null, dec = sol?.dec_degrees ?? null;
        const rec: any = {
            tag, outcome: sol != null ? 'solved' : 'honest_failure',
            ra_hours: ra, dec_degrees: dec, pixel_scale: sol?.pixel_scale ?? null,
            matched: sol?.matched ?? sol?.matched_stars?.length ?? null,
            confidence: sol?.confidence ?? null, clean_stars: clean,
            effective_fl_mm: meta?.focal_length ?? null, scale_lock: meta?.scaleLock ?? null,
            pointing_assisted: meta?.ra_hint != null, wall_ms,
        };
        if (sol != null && ra != null && dec != null) {
            rec.center_sep_deg = centerSepDeg(ra, dec);
            rec.scale_err_frac = rec.pixel_scale != null ? (rec.pixel_scale - EXPECTED_SCALE) / EXPECTED_SCALE : null;
            rec.ic5146_within_2p5deg = rec.center_sep_deg <= 2.5;
        }
        return rec;
    } catch (e) {
        return { tag, outcome: 'error', error: String((e as Error)?.message ?? e).slice(0, 400), wall_ms: Date.now() - t0 };
    } finally {
        StarCatalogAdapter.setAtlasLoader(null);
    }
}

describe('cocoon 60Da rawler-ON HINTED sweep (11 population lights, graded vs IC 5146)', () => {
    it('runs hinted solve on each cocoon population light (blind opt-in via COCOON_BLIND=1)', async () => {
        const rawler = process.env.VITE_DECODER_RAWLER === '1';
        const runBlind = process.env.COCOON_BLIND === '1';
        for (const frame of FRAMES) {
            const base = path.basename(frame);
            const blind = runBlind ? await runOne(frame, 'rawler_blind') : null;
            const hinted = await runOne(frame, 'rawler_hinted', COCOON_HINT);
            // ASSISTED solve: the hint is a recorded search prior, never a blind result.
            const stamp = {
                ts: new Date().toISOString(), frame: base, rawler,
                run_label: 'HINTED-COCOON', solve_class: 'assisted', blind, hinted,
            };
            fs.appendFileSync(OUT, JSON.stringify(stamp) + '\n');
            // eslint-disable-next-line no-console
            console.log(`[cocoon] ${base} rawler=${rawler} HINTED=${hinted.outcome} ` +
                `matched=${(hinted as any).matched} scale=${(hinted as any).pixel_scale} ` +
                `sep=${(hinted as any).center_sep_deg != null ? (hinted as any).center_sep_deg.toFixed(3) + 'deg' : 'n/a'} ` +
                `conf=${(hinted as any).confidence} (hinted ${hinted.wall_ms}ms` +
                `${blind ? `, blind ${blind.outcome} ${blind.wall_ms}ms` : ''})`);
        }
    });
});
