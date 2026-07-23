/**
 * GAUNTLET RE-RUN — ONE frame through the REAL app pipeline, DEFAULT arm.
 * Spawned per-frame by tools/rawlab/gauntlet_rawler.mjs.
 *
 *   RAWLAB_GAUNTLET_FILE — RAW file to run (absolute)
 *   RAWLAB_GAUNTLET_OUT  — REQUIRED absolute path for the frame JSON record
 *   VITE_DECODER_RAWLER   — UNSET (the default rawler arm, post-cutover @56cf96d)
 *
 * Runs the exact tools/api/solve_cr2.apispec.ts path (runWizardPipeline). This
 * is the app's ANCHORED ultra-wide solver — NOT the solverkit anchorless
 * lost-in-space band-index rail (that rail cracked IMG_1757 to 1/6 but never
 * re-accepts through the app gate). blindOutcome mirrors run_wizard_cr2.mjs:
 * solved = receipt.solution present AND stars_matched >= 8; else honest_failure.
 *
 * ROUTING TRAP (recorded, not judged): a 14mm frame with no lens-EXIF FL routes
 * to the UW blind path; a narrow frame that mis-routes UW is a ROUTING failure,
 * NOT decoder evidence. The captured optics/scaleLock block lets the reader
 * label that. EVIDENCE-ONLY — pose is UNCONFIRMED until truth-checked upstream.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRealWasm, makeFsAtlasLoader, runWizardPipeline } from '../api/headless_driver';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = process.env.RAWLAB_GAUNTLET_FILE ?? '';
const OUT = process.env.RAWLAB_GAUNTLET_OUT ?? '';

describe(`gauntlet re-run — ${path.basename(FILE)} (default rawler arm)`, () => {
    it('runs the real app pipeline and records the blind-solve outcome', async () => {
        expect(OUT, 'RAWLAB_GAUNTLET_OUT is required').toBeTruthy();
        expect(fs.existsSync(FILE), `input missing: ${FILE}`).toBe(true);

        bootRealWasm();
        StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(path.join(REPO_ROOT, 'public')));

        const buf = fs.readFileSync(FILE);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

        const rec: Record<string, unknown> = {
            frame: path.basename(FILE),
            file: FILE,
            file_bytes: buf.byteLength,
            arm: 'rawler_default',
            flag_env: process.env.VITE_DECODER_RAWLER ?? null,
            started_at: new Date().toISOString(),
        };

        const t0 = Date.now();
        try {
            const { receipt, events, session } = await runWizardPipeline(ab, {
                atlasRoot: path.join(REPO_ROOT, 'public'),
            });
            rec.wall_ms = Date.now() - t0;
            const sol: any = receipt?.solution ?? null;
            const matched = sol?.stars_matched ?? sol?.matched_stars?.length ?? 0;
            const solved = !!sol && matched >= 8;
            rec.blindOutcome = solved ? 'solved' : 'honest_failure';
            rec.receipt_version = receipt?.version ?? null;
            rec.solve = sol
                ? {
                    solved,
                    ra_hours: sol.ra_hours ?? null,
                    dec_degrees: sol.dec_degrees ?? null,
                    pixel_scale: sol.pixel_scale ?? null,
                    orientation_deg: sol.orientation_deg ?? sol.theta_deg ?? sol.roll_deg ?? null,
                    parity: sol.parity ?? null,
                    stars_matched: matched,
                    confidence: sol.confidence ?? null,
                }
                : { solved: false };
            rec.wcs = receipt?.wcs
                ? { CRVAL1: receipt.wcs.CRVAL1, CRVAL2: receipt.wcs.CRVAL2, CD1_1: receipt.wcs.CD1_1, CD1_2: receipt.wcs.CD1_2, CD2_1: receipt.wcs.CD2_1, CD2_2: receipt.wcs.CD2_2 }
                : null;
            rec.confirm_status = receipt?.confirm_status ?? null;
            // Routing / optics (the FL-misroute trap surface).
            rec.optics = receipt?.optics ?? receipt?.hardware ?? null;
            rec.scaleLock = (session as any).scaleLock ?? null;
            rec.metrology = receipt?.metrology ?? null;
            // Decode-quality proxy: detection count (survives solve failure).
            const sig: any = (session as any).signal;
            rec.detection = sig ? { clean_stars: (sig.clean_stars ?? []).length, culling_tally: sig.culling_tally ?? null } : null;
            // Blind sweep/verify sigma from the event stream, if surfaced.
            const findings = events.filter((e: any) => e.kind === 'finding').map((e: any) => e.finding);
            const locked = findings.find((f: any) => f?.kind === 'solution_locked');
            rec.solution_locked = locked ? { raHours: locked.raHours, matched: locked.matched, sigma: locked.sigma ?? locked.peakZ ?? null } : null;
            rec.sweep_verify = findings
                .filter((f: any) => f && /sweep|verify|blind|anchor/i.test(f.kind ?? ''))
                .map((f: any) => ({ kind: f.kind, sigma: f.sigma ?? f.peakZ ?? null, matched: f.matched ?? null }))
                .slice(0, 20);
            rec.run_finished_ok = events.some((e: any) => e.kind === 'run_finished' && e.ok === true);
        } catch (err) {
            rec.wall_ms = Date.now() - t0;
            const msg = String((err as Error)?.message ?? err);
            // The headless runWizardPipeline runs ALL 6 steps; when the blind
            // solve finds no lock, step4 leaves no solution and step5 throws
            // "Step 4 (Solve) must be complete before calibration." That is an
            // HONEST no-lock blind-solve failure (the solver ran, budget/quads
            // exhausted), NOT a decode/atlas error — classify it as such so a
            // budget miss reads correctly. Any OTHER message is a true error.
            const noLock = /Step 4 \(Solve\) must be complete/i.test(msg);
            rec.blindOutcome = noLock ? 'honest_failure' : 'error';
            rec.no_lock = noLock;
            rec.error = msg;
            rec.error_stack = String((err as Error)?.stack ?? '').split('\n').slice(0, 8).join('\n');
            rec.solve = { solved: false };
        }

        rec.finished_at = new Date().toISOString();
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(rec, (_k, v) =>
            v instanceof Float32Array || v instanceof Uint16Array || v instanceof Uint8Array
                ? `<typed n=${v.length}>` : v, 2));
        expect(fs.existsSync(OUT)).toBe(true);
        StarCatalogAdapter.setAtlasLoader(null);
    }, 900_000);
});
