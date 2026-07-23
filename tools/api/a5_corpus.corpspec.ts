/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A5 — GRADED CORPUS PASS over the new intake wing (overnight 2026-07-10, R7+R12)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   npx vitest run -c tools/api/a5_corpus.config.ts
 *
 * Drives the REAL wizard pipeline (runWizardPipeline → compiled wasm) over the
 * 57 solvable light frames enumerated in
 *   test_results/overnight_run_2026-07-10/a5_manifest.json
 * FITS (LATTE + DSW) and CR2 (AstroBackyard cocoon 60Da) BOTH run the SAME
 * engine decode path (headless_driver.ts). LAW 4 tools/ lane; writes ONLY under
 * test_results/. src/ untouched. Color-capable engine (main color-wiring merged).
 *
 * PROTOCOL (docs/INTAKE_SCRAPER_SPEC 5-point): (1) solve blind first; CR2 that
 * fail blind get a hinted retry (IC 5146 pointing) recorded SEPARATELY. (2) record
 * outcome/RA/Dec/scale/matched/conf/wall/receipt/citation. (3) truth-grade where a
 * label/FITS-header/named-target reference exists, else NOT MEASURED. (4) honest
 * failure taxonomy from real receipts. (5) knob notes → morning review.
 *
 * SEQUENTIAL + sleep ≥5s between frames (box-politeness; owner: not for time).
 * Each frame is its OWN `it` (per-test timeout isolation); a frame NEVER throws —
 * its honest outcome is DATA appended to a5_results.jsonl, not a red test. Results
 * are appended per-frame (crash-safe) and the sweep RESUMES (skips frames already
 * in the jsonl) on restart.
 */
import { describe, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRealWasm, makeFsAtlasLoader } from './headless_driver';
import { OrchestratorSession } from '@/engine/pipeline/orchestrator_session';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';
import { resolveTruth } from '../validation/truth/loader.ts';
import { compareToTruth, type SolvedWcs } from '../validation/truth/compare.ts';
import type { TruthLabel } from '../validation/truth/schema.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(REPO_ROOT, 'public');
const OUT_DIR = path.join(REPO_ROOT, 'test_results', 'overnight_run_2026-07-10');
const MANIFEST = path.join(OUT_DIR, 'a5_manifest.json');
const RESULTS = path.join(OUT_DIR, 'a5_results.jsonl');
const RECEIPTS_DIR = path.join(OUT_DIR, 'a5_receipts');
const LABELS = path.join(REPO_ROOT, 'tools', 'validation', 'truth', 'labels.json');
const SLEEP_MS = 5000;

// IC 5146 (Cocoon Nebula) — independent named-target reference for the 60Da CR2
// cocoon set. RA 21h53m29s = 21.891h, Dec +47°16' = +47.267°. Coarse center
// tolerance (2.5°) reflects the WO Zenithstar 73 (430mm) × APS-C FOV (~3°×2°,
// half-diagonal ~1.8°) plus framing margin. This reference is INDEPENDENT of both
// the solve and any header (a name, not a measurement) — a clean truth for CR2.
const IC5146 = { ra_hours: 21.891, dec_degrees: 47.267 };
const COCOON_HINT = { ra_hint: 21.891, dec_hint: 47.267, focal_length_hint_mm: 430 };

fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

// ── build the light-frame worklist from the manifest ──
interface Frame { source: string; format: string; rig: string; path: string; filename: string; citation: string; }
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const frames: Frame[] = [];
for (const src of Object.keys(manifest.sources)) {
    for (const f of manifest.sources[src]) {
        if (f.frame_role !== 'light') continue;
        frames.push({ source: src, format: f.format, rig: f.rig ?? '', path: f.path, filename: f.filename, citation: f.citation ?? '' });
    }
}

// ── resume: skip frames already recorded ──
const done = new Set<string>();
if (fs.existsSync(RESULTS)) {
    for (const line of fs.readFileSync(RESULTS, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { done.add(JSON.parse(line).frame); } catch { /* ignore malformed */ }
    }
}

const isCR2 = (f: Frame) => /\.(cr2)$/i.test(f.filename) || f.source === 'astrobackyard_cocoon_cr2';
const baseOf = (fn: string) => fn.replace(/\.(fit|fits|fts|cr2)$/i, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function classifyError(msg: string): string {
    if (/ENOENT|no such file|EACCES|EISDIR/i.test(msg)) return 'file-read-error';
    if (/decode|libraw|demosaic|worker|unpack/i.test(msg)) return 'decode-error';
    if (/fits|header|bitpix|naxis/i.test(msg)) return 'fits-parse-error';
    if (/atlas|sector|catalog/i.test(msg)) return 'atlas-error';
    if (/memory|heap|allocation/i.test(msg)) return 'oom';
    return 'exception';
}

interface Attempt {
    outcome: 'solved' | 'honest_failure' | 'error';
    ra_hours: number | null; dec_degrees: number | null; pixel_scale: number | null;
    stars_matched: number | null; confidence: number | null; wall_ms: number;
    clean_stars: number | null; anomalies: number | null; pointing_assisted: boolean;
    ra_hint: number | null; dec_hint: number | null; failure_class: string | null;
    error: string | null; receipt_path: string | null;
}

// Manual step-drive (mirrors headless_driver.runWizardPipeline) so a NO-LOCK is
// captured as an honest_failure WITH session diagnostics, rather than surfacing as
// step5's "Step 4 must be complete before calibration" throw. step5/step6 run ONLY
// when step4 produced a solution.
async function runOne(filePath: string, base: string, tag: string, overrides?: Record<string, unknown>): Promise<Attempt> {
    const t0 = Date.now();
    bootRealWasm();
    StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(ATLAS_ROOT));
    let session: any = null;
    try {
        // FRESH buffer per attempt: the CR2 libraw Worker TRANSFERS (neuters) the
        // ArrayBuffer during decode, so a reused buffer is detached on retry.
        const buf = fs.readFileSync(filePath);
        const buffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        session = new OrchestratorSession(buffer, { generatePreviews: false });
        await session.step1_Load();
        await session.step2_Extract(overrides as any);
        await session.step3_Metrology();
        await session.step4_Solve();

        const sol = session.solution ?? null;
        const clean = session?.signal?.clean_stars?.length ?? null;
        const anom = session?.signal?.anomalies?.length ?? null;
        const meta = session?.metadata ?? {};

        let receipt: any = null;
        let receipt_path: string | null = null;
        if (sol != null) {
            // Only a solved frame runs calibration + integrate (the receipt build).
            await session.step5_Calibrate();
            receipt = await session.step6_Integrate();
            try {
                receipt_path = path.join(RECEIPTS_DIR, `${base}.${tag}.receipt.json`);
                fs.writeFileSync(receipt_path, JSON.stringify(receipt, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v as any) : v)));
            } catch (e) { receipt_path = `WRITE_ERR:${(e as Error).message}`; }
        }
        const wall_ms = Date.now() - t0;
        const rsol = receipt?.solution ?? sol; // receipt.solution is the canonical export shape
        const failure_class = sol == null ? (clean != null && clean < 4 ? 'no-detections' : 'no-lock') : null;
        return {
            outcome: sol != null ? 'solved' : 'honest_failure',
            ra_hours: rsol?.ra_hours ?? null, dec_degrees: rsol?.dec_degrees ?? null, pixel_scale: rsol?.pixel_scale ?? null,
            stars_matched: rsol?.stars_matched ?? rsol?.matched_stars?.length ?? null, confidence: rsol?.confidence ?? null, wall_ms,
            clean_stars: clean, anomalies: anom, pointing_assisted: meta?.ra_hint != null,
            ra_hint: meta?.ra_hint ?? null, dec_hint: meta?.dec_hint ?? null, failure_class, error: null, receipt_path,
        };
    } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        const clean = session?.signal?.clean_stars?.length ?? null;
        return {
            outcome: 'error', ra_hours: null, dec_degrees: null, pixel_scale: null, stars_matched: null, confidence: null,
            wall_ms: Date.now() - t0, clean_stars: clean, anomalies: session?.signal?.anomalies?.length ?? null,
            pointing_assisted: session?.metadata?.ra_hint != null, ra_hint: session?.metadata?.ra_hint ?? null,
            dec_hint: session?.metadata?.dec_hint ?? null, failure_class: classifyError(msg), error: msg.slice(0, 400), receipt_path: null,
        };
    } finally {
        StarCatalogAdapter.setAtlasLoader(null);
    }
}

function gradeTruth(att: Attempt, truth: TruthLabel | null, tolOverride?: { center_deg?: number }, note?: string) {
    if (att.outcome !== 'solved' || att.ra_hours == null || att.dec_degrees == null) {
        return { source: truth?.source ?? 'none', verdict: 'NOT_MEASURED', reason: 'not solved', note: note ?? null };
    }
    if (!truth) return { source: 'none', verdict: 'NOT_MEASURED', reason: 'no truth label/header/name', note: note ?? null };
    const solved: SolvedWcs = { ra_hours: att.ra_hours, dec_degrees: att.dec_degrees, pixel_scale_arcsec: att.pixel_scale };
    const cmp = compareToTruth(solved, truth, tolOverride);
    return {
        source: truth.source, verdict: cmp.verdict, center_sep_deg: cmp.center_sep_deg,
        scale_err_frac: cmp.scale_err_frac, rotation_err_deg: cmp.rotation_err_deg,
        reasons: cmp.reasons, truth_ra_hours: truth.ra_hours, truth_dec_degrees: truth.dec_degrees,
        truth_scale: truth.pixel_scale_arcsec ?? null, note: note ?? null,
    };
}

describe('A5 graded corpus pass — new intake wing (blind-first, truth-graded)', () => {
    const todo = frames.filter((f) => !done.has(f.filename));
    // eslint-disable-next-line no-console
    console.log(`[a5] ${frames.length} light frames; ${done.size} already done; ${todo.length} to run this pass.`);

    for (const f of todo) {
        it(f.filename, async () => {
            const cr2 = isCR2(f);
            const base = baseOf(f.filename);

            // (1) BLIND (runOne reads a fresh buffer from disk each call)
            const blind = await runOne(f.path, base, 'blind');

            // hinted retry — CR2 only, only if blind did NOT solve, only if we hold a hint
            let hinted: Attempt | null = null;
            if (cr2 && blind.outcome !== 'solved') {
                hinted = await runOne(f.path, base, 'hinted', COCOON_HINT);
            }

            const winner = hinted?.outcome === 'solved' ? hinted : blind;
            const provenance = hinted?.outcome === 'solved' ? 'hinted' : 'blind';

            // (3) truth grade against the WINNING attempt
            let truth: TruthLabel | null = null;
            let tolOverride: { center_deg?: number } | undefined;
            let note: string | undefined;
            if (cr2) {
                if (f.source === 'astrobackyard_cocoon_cr2') {
                    truth = { frame_id: base, source: 'named_target_IC5146', ra_hours: IC5146.ra_hours, dec_degrees: IC5146.dec_degrees };
                    tolOverride = { center_deg: 2.5 };
                    note = 'independent named-target (IC 5146) coarse center grade; scale not independently gradable for CR2';
                }
            } else {
                truth = await resolveTruth(base, { fitsPath: f.path, labelsFile: LABELS, allowBundled: true });
                if (truth?.source === 'fits_header') {
                    note = winner.pointing_assisted
                        ? 'FITS-header truth; solver consumed header RA/DEC as goto hint → center is a CONSISTENCY grade (pointing-assisted), scale/rotation from CD are INDEPENDENT'
                        : 'FITS-header truth; no header pointing hint consumed → center independent';
                }
            }
            const truthGrade = gradeTruth(winner, truth, tolOverride, note);

            const rec = {
                frame: f.filename, source: f.source, format: f.format, rig: f.rig, path: f.path, citation: f.citation,
                outcome: winner.outcome, provenance,
                blind, hinted, truth: truthGrade,
            };
            fs.appendFileSync(RESULTS, JSON.stringify(rec) + '\n');
            // eslint-disable-next-line no-console
            console.log(`[a5] ${f.filename} :: ${winner.outcome}/${provenance} matched=${winner.stars_matched} scale=${winner.pixel_scale} conf=${winner.confidence} truth=${(truthGrade as any).verdict} ${(truthGrade as any).center_sep_deg != null ? 'sep=' + (truthGrade as any).center_sep_deg.toFixed(3) + '°' : ''} (${winner.wall_ms}ms)`);

            await sleep(SLEEP_MS);
        });
    }
});
