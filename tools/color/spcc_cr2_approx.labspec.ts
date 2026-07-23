/**
 * SPCC-APPROX FOR CR2 — incubator measurement for owner decision D-spcc-cr2-color-go
 * (approved 2026-07-12; spec: docs/TEST_SUITE_PLAN.md §7 D1 / harvest
 * `spcc-fits-gated-drops-cr2-color`).
 *
 * WHY A tools/ LANE (not the receipt): the engine SPCC gate is FITS-only
 *   `isFits && scienceRgb && matched>0` (stages/science.ts:118), AND the CR2 path
 *   never RETAINS its full-res linear RGB (`this.scienceRgb` is set only for
 *   sourceFormat==='FITS', orchestrator_session.ts:556-558). So the real receipt
 *   carries receipt.spcc=null on CR2. Wiring CR2 color into the engine (relax the
 *   gate + tag CR2_DEMOSAIC_APPROX + retain fullRGB) is a src/ change (orchestrator/
 *   surgeon). This lane MEASURES the color numbers the incubator way (LAW 4):
 *   reconstruct the exact fullRGB via the deterministic decodeScienceFrame, then
 *   call computeSpccCalibration DIRECTLY on the real solve's matched stars.
 *
 * HONEST TAG: source is stamped 'CR2_DEMOSAIC_APPROX' — NEVER 'SPCC_RGB'. CR2 is
 *   demosaiced Bayer with no filter-curve reference (D1: "honest but lower fidelity").
 *
 * COORDINATE CORRESPONDENCE (the load-bearing correctness point): the wizard solve
 *   runs its detection on decodeScienceFrame's native fullRGB buffer, and runSpcc is
 *   called with scales=null (native == detection space). We reproduce the identical
 *   fullRGB (deterministic decode) and pass scales=null, so matched.detected.{x,y}
 *   map 1:1 to the pixels computeSpccCalibration samples. matched.catalog.bv IS Gaia
 *   BP-RP; matched.catalog.mag IS Gaia G (solver_entry.ts:1851-1855).
 *
 * One arm per run (env-selected, mirrors cutover_riders):
 *   VITE_DECODER_RAWLER unset/absent = rawler_default (shipped default @56cf96d)
 *   VITE_DECODER_RAWLER=0            = libraw_cold
 *
 * Driven by tools/color/spcc_cr2_approx.mjs. NOT a gate.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootRealWasm, makeFsAtlasLoader, runWizardPipeline } from '../api/headless_driver';
import { decodeScienceFrame } from '@/engine/pipeline/stages/ingest';
import { computeSpccCalibration } from '@/engine/pipeline/m8_photometry/spcc_calibrator';
import { isRawlerDecoderEnabled } from '@/engine/pipeline/m1_ingestion/rawler_decoder';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = process.env.SPCC_CR2_FILE ?? path.join(REPO_ROOT, 'public', 'demo', 'sample_observation.cr2');
const OUT = process.env.SPCC_CR2_OUT ?? '';
const ARM = isRawlerDecoderEnabled() ? 'rawler_default' : 'libraw_cold';

function freshAB(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
function bytesOf(data: ArrayBufferView): Buffer {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

describe(`SPCC-approx CR2 — arm ${ARM}`, () => {
    it(`measures CR2_DEMOSAIC_APPROX color for ${path.basename(FILE)}`, async () => {
        expect(OUT, 'SPCC_CR2_OUT is required (set by spcc_cr2_approx.mjs)').toBeTruthy();
        expect(fs.existsSync(FILE), `input missing: ${FILE}`).toBe(true);

        bootRealWasm();
        StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(path.join(REPO_ROOT, 'public')));

        const buf = fs.readFileSync(FILE);
        const rec: Record<string, unknown> = {
            arm: ARM,
            source_tag: 'CR2_DEMOSAIC_APPROX',
            flag_env: process.env.VITE_DECODER_RAWLER ?? null,
            rawler_enabled: isRawlerDecoderEnabled(),
            file: path.relative(REPO_ROOT, FILE),
            file_bytes: buf.byteLength,
            started_at: new Date().toISOString(),
        };

        // ── 1. Real solve (the sacred CR2 blind solve) → matched stars + metadata ──
        const { receipt, session } = await runWizardPipeline(freshAB(buf), { atlasRoot: path.join(REPO_ROOT, 'public') });
        const sess = session as unknown as {
            solution?: { matched_stars?: unknown[] };
            sourceFormat?: string;
            metadata?: { timestamp?: string; exposure_time?: number };
        };
        const sol: any = (receipt as any)?.solution ?? null;
        const matched: any[] = (sess.solution?.matched_stars ?? sol?.matched_stars ?? []) as any[];
        const sourceFormat = sess.sourceFormat ?? 'CR2';
        const exposureTime = sess.metadata?.exposure_time || 1;
        rec.receipt_version = (receipt as any)?.version ?? null;
        rec.solve = sol ? {
            solved: true, ra_hours: sol.ra_hours ?? null, dec_degrees: sol.dec_degrees ?? null,
            pixel_scale: sol.pixel_scale ?? null, stars_matched: sol.stars_matched ?? matched.length,
            confidence: sol.confidence ?? null,
        } : { solved: false };
        rec.source_format = sourceFormat;
        rec.exposure_time = exposureTime;
        rec.receipt_spcc = (receipt as any)?.spcc ?? null; // EXPECTED null (FITS-only gate) — proves the lane's premise

        // ── 2. Reconstruct the exact native fullRGB (deterministic decode) ──
        const frame = await decodeScienceFrame(freshAB(buf), sourceFormat, sess.metadata?.timestamp);
        const fullRGB = frame.fullRGB;
        const width = frame.width, height = frame.height;
        const md5 = crypto.createHash('md5').update(bytesOf(fullRGB)).digest('hex');
        rec.rgb16 = {
            width, height, stride: (frame as any).rawSensor?.stride ?? width,
            isDemosaiced: (frame as any).rawSensor?.isDemosaiced ?? true,
            dtype: fullRGB instanceof Float32Array ? 'f32_le' : (fullRGB as any)?.constructor?.name ?? 'unknown',
            len_elems: fullRGB.length, len_bytes: fullRGB.byteLength,
            elems_per_px: +(fullRGB.length / (width * height)).toFixed(4),
            md5,
            note: 'fullRGB == decodeScienceFrame output == extractRawSensorData().data on the rawler arm (ingest.ts:184); cross-checks the cutover rider rgb16 md5.',
        };

        // ── 3. SPCC color math on the CR2 (bypasses the isFits gate; scales=null) ──
        rec.matched_count = matched.length;
        rec.matched_with_bv = matched.filter(m => Number.isFinite(m?.catalog?.bv)).length;
        try {
            const cal = computeSpccCalibration(matched, { data: fullRGB, width, height }, null, exposureTime);
            const g: any = cal.gains;
            rec.spcc_approx = {
                source: 'CR2_DEMOSAIC_APPROX',
                valid: cal.valid,
                color_slope: num(cal.colorFit.slope), color_intercept: num(cal.colorFit.intercept),
                color_r2: num(cal.colorFit.r2), color_rmse: num(cal.colorFit.rmse),
                color_valid: cal.colorFit.valid, color_n_used: cal.colorFit.n_used,
                zeropoint: num(cal.zpFit.zeropoint), zp_rmse: num(cal.zpFit.rmse),
                zp_valid: cal.zpFit.valid, zp_n_used: cal.zpFit.n_used,
                n_usable: cal.n_usable,
                fidelity: cal.fidelity ? {
                    r2_survivor: num(cal.fidelity.r2_survivor), r2_full: num((cal.fidelity as any).r2_full),
                    rmse_survivor_mag: num((cal.fidelity as any).rmse_survivor_mag), slope_ols: num((cal.fidelity as any).slope_ols),
                } : null,
                gains: g ? {
                    gains: g.gains, nStars: g.nStars, r2: num(g.r2),
                    gate_reason: g.gate?.reason ?? null, applied: g.applied ?? null,
                } : null,
            };
        } catch (err) {
            rec.spcc_approx = { error: String((err as Error)?.message ?? err) };
        }

        rec.finished_at = new Date().toISOString();
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(rec, (_k, v) =>
            v instanceof Float32Array || v instanceof Uint16Array || v instanceof Uint8Array ? `<typed n=${v.length}>` : v, 2));
        expect(fs.existsSync(OUT)).toBe(true);
        StarCatalogAdapter.setAtlasLoader(null);
    }, 900_000);
});
