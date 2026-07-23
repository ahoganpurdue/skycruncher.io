/**
 * Decoder-rail A/B — ONE pipeline arm (rail #14). Spawned per arm by
 * tools/rawlab/ab_live.mjs with env:
 *   RAWLAB_AB_FILE   — RAW file to run (default: bundled demo CR2)
 *   RAWLAB_AB_OUT    — REQUIRED absolute path for the arm's JSON record
 *   VITE_DECODER_RAWLER=1 — selects the rawler arm (absent = libraw arm)
 *
 * Drives the REAL wizard steps (OrchestratorSession) like
 * tools/api/headless_driver.runWizardPipeline, but per-step try/catch so a
 * failing arm still yields its detection-level measurements — on the rawler
 * arm a detection explosion / honest solve failure is an EXPECTED MEASUREMENT
 * (thresholds are libraw-calibrated), never a spec failure. The ONLY assertion
 * here is that the record was written; verdicts live in ab_live's report.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Importing headless_driver installs the Node Worker bridge libraw needs.
import { bootRealWasm, makeFsAtlasLoader } from '../api/headless_driver';
import { OrchestratorSession } from '@/engine/pipeline/orchestrator_session';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = process.env.RAWLAB_AB_FILE ?? path.join(REPO_ROOT, 'public', 'demo', 'sample_observation.cr2');
const OUT = process.env.RAWLAB_AB_OUT ?? '';
const ARM = process.env.VITE_DECODER_RAWLER === '1' || process.env.VITE_DECODER_RAWLER === 'true'
    ? 'rawler' : 'libraw';

function quantiles(values: number[]): Record<string, number> | null {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (v.length === 0) return null;
    const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
    return { n: v.length, p01: q(0.01), p25: q(0.25), p50: q(0.5), p75: q(0.75), p99: q(0.99), max: v[v.length - 1] };
}

describe(`decoder-rail A/B pipeline arm: ${ARM}`, () => {
    it(`runs the wizard steps on ${path.basename(FILE)} and records measurements`, async () => {
        expect(OUT, 'RAWLAB_AB_OUT is required (set by ab_live.mjs)').toBeTruthy();
        expect(fs.existsSync(FILE), `input file missing: ${FILE}`).toBe(true);

        bootRealWasm();
        StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(path.join(REPO_ROOT, 'public')));

        const buf = fs.readFileSync(FILE);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        const rec: Record<string, unknown> = {
            arm: ARM,
            flag_env: process.env.VITE_DECODER_RAWLER ?? null,
            file: FILE,
            file_bytes: buf.byteLength,
            started_at: new Date().toISOString(),
            steps: {} as Record<string, { ok: boolean; ms: number; error?: string }>,
        };
        const steps = rec.steps as Record<string, { ok: boolean; ms: number; error?: string }>;

        const session = new OrchestratorSession(ab, { generatePreviews: false });
        let receipt: any = null;
        let halted: string | null = null;

        const runStep = async (name: string, fn: () => Promise<unknown>) => {
            if (halted) return;
            const t0 = Date.now();
            try {
                const out = await fn();
                steps[name] = { ok: true, ms: Date.now() - t0 };
                return out;
            } catch (err) {
                steps[name] = { ok: false, ms: Date.now() - t0, error: String((err as Error)?.message ?? err) };
                halted = name;
                return undefined;
            }
        };

        await runStep('step1_Load', () => session.step1_Load());
        await runStep('step2_Extract', () => session.step2_Extract());
        await runStep('step3_Metrology', () => session.step3_Metrology());
        await runStep('step4_Solve', () => session.step4_Solve());
        await runStep('step5_Calibrate', () => session.step5_Calibrate());
        receipt = await runStep('step6_Integrate', () => session.step6_Integrate());

        // ── DETECTION LEVEL (survives later-step failures) ──
        const sig = session.signal as any;
        if (sig) {
            const clean: any[] = sig.clean_stars ?? [];
            rec.detection = {
                clean_stars: clean.length,
                culling_tally: sig.culling_tally ?? sig.cullingTally ?? null,
                flux_quantiles: quantiles(clean.map((s) => s?.flux)),
                fwhm_quantiles: quantiles(clean.map((s) => s?.fwhm)),
            };
        } else {
            rec.detection = null; // honest absence — extract never completed
        }

        // ── SOLVE LEVEL ──
        const sol = session.solution as any;
        rec.solve = sol
            ? {
                solved: true,
                ra_hours: sol.ra_hours ?? null,
                dec_degrees: sol.dec_degrees ?? null,
                pixel_scale: sol.pixel_scale ?? null,
                matched: sol.matched_stars?.length ?? sol.stars_matched ?? null,
                confidence: sol.confidence ?? null,
            }
            : { solved: false };
        rec.scaleLock = (session as any).scaleLock ?? null;
        rec.receipt_version = receipt?.version ?? null;
        rec.halted_at = halted;
        rec.finished_at = new Date().toISOString();

        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(rec, (_k, v) =>
            v instanceof Float32Array || v instanceof Uint16Array ? `<typed array n=${v.length}>` : v, 2));

        // The one real assertion: the measurement record exists on disk.
        expect(fs.existsSync(OUT)).toBe(true);
        StarCatalogAdapter.setAtlasLoader(null);
    }, 900_000);
});
