/**
 * COLOR-DRIFT EXTRACT — per-star instrumental fluxes + native positions for the
 * color-drift quiver diagnostic (tools/color/color_drift_quiver.mjs).
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A SEPARATE LANE: the SPCC-approx incubator (spcc_cr2_approx.labspec.ts)
 * banks only AGGREGATE color-fit numbers (slope/r²/rmse). The color-drift quiver
 * needs PER-STAR raw records: flux_r/g/b + the star's native pixel (x,y) so the
 * arrows can be placed on the frame. This labspec re-runs the identical sacred
 * CR2 blind solve, reconstructs the exact native fullRGB via the deterministic
 * decodeScienceFrame, and calls measureApertureRGB on EACH matched star EXACTLY
 * as computeSpccCalibration does (spcc_calibrator.ts:534, scales=null ⇒ the
 * detected coords ARE native), banking one raw record per matched star.
 *
 * NO COLOR MATH HERE (by design): the renderer reproduces fitColorRegression so
 * the fit lives in ONE place (color_drift_quiver.mjs). This lane only MEASURES
 * fluxes + positions. The instColor field is a convenience copy of the SPCC
 * convention (−2.5·log10(flux_b/flux_r)) so a consumer can spot-check without
 * re-deriving; the fit + drift are the renderer's job.
 *
 * HONEST TAG: source is CR2_DEMOSAIC_APPROX (never SPCC_RGB) — demosaiced Bayer,
 * no filter-curve reference. Same arm-select env as the spcc lane:
 *   VITE_DECODER_RAWLER unset/absent = rawler_default (shipped default)
 *   VITE_DECODER_RAWLER=0            = libraw_cold
 * Driven by tools/color/color_drift_quiver.mjs. NOT a gate.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootRealWasm, makeFsAtlasLoader, runWizardPipeline } from '../api/headless_driver';
import { decodeScienceFrame } from '@/engine/pipeline/stages/ingest';
import { measureApertureRGB } from '@/engine/pipeline/m8_photometry/rgb_aperture_photometry';
import { isRawlerDecoderEnabled } from '@/engine/pipeline/m1_ingestion/rawler_decoder';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = process.env.DRIFT_CR2_FILE ?? path.join(REPO_ROOT, 'public', 'demo', 'sample_observation.cr2');
const OUT = process.env.DRIFT_CR2_OUT ?? '';
const ARM = isRawlerDecoderEnabled() ? 'rawler_default' : 'libraw_cold';

function freshAB(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

describe(`color-drift extract — arm ${ARM}`, () => {
    it(`banks per-star flux + native position for ${path.basename(FILE)}`, async () => {
        expect(OUT, 'DRIFT_CR2_OUT is required (set by color_drift_quiver.mjs)').toBeTruthy();
        expect(fs.existsSync(FILE), `input missing: ${FILE}`).toBe(true);

        bootRealWasm();
        StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(path.join(REPO_ROOT, 'public')));

        const buf = fs.readFileSync(FILE);

        // ── 1. Real solve (the sacred CR2 blind solve) → matched stars ──
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

        // ── 2. Reconstruct the exact native fullRGB (deterministic decode) ──
        const frame = await decodeScienceFrame(freshAB(buf), sourceFormat, sess.metadata?.timestamp);
        const data = frame.fullRGB as Float32Array;
        const width = frame.width, height = frame.height;

        // ── 3. Per-star aperture photometry (mirrors computeSpccCalibration) ──
        const stars = matched.map((mstar, i) => {
            const x = mstar?.detected?.x, y = mstar?.detected?.y;
            const fwhm = mstar?.detected?.fwhm || 3.0;
            const catBpRp = num(mstar?.catalog?.bv);
            const catG = num(mstar?.catalog?.mag);
            const rec: Record<string, unknown> = {
                i, x: num(x), y: num(y), fwhm,
                catBpRp, catG,
                flux_r: null, flux_g: null, flux_b: null,
                n_aperture: 0, n_annulus: 0, saturated: false,
                instColor: null,
                onFrame: false, usable: false,
            };
            if (typeof x !== 'number' || typeof y !== 'number') return rec;
            // Off-frame exclusion — identical to spcc_calibrator.ts:529
            if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return rec;
            rec.onFrame = true;
            const m = measureApertureRGB(data, width, height, x, y, fwhm);
            rec.flux_r = num(m.flux_r); rec.flux_g = num(m.flux_g); rec.flux_b = num(m.flux_b);
            rec.n_aperture = m.n_aperture; rec.n_annulus = m.n_annulus; rec.saturated = m.saturated;
            // Usability gate — identical to spcc_calibrator.ts:540 (green n_annulus>=8, !sat)
            const apOk = m.n_aperture > 0 && m.n_annulus >= 8 && !m.saturated;
            let instColor: number | null = null;
            if (apOk && m.flux_b > 0 && m.flux_r > 0) {
                instColor = -2.5 * Math.log10(m.flux_b / m.flux_r);
            }
            rec.instColor = num(instColor);
            // "usable for the color fit" == spcc colorSamples criterion
            rec.usable = rec.instColor !== null && catBpRp !== null;
            return rec;
        });

        const out = {
            schema: 'color_drift_extract.v1',
            arm: ARM,
            source_tag: 'CR2_DEMOSAIC_APPROX',
            flag_env: process.env.VITE_DECODER_RAWLER ?? null,
            rawler_enabled: isRawlerDecoderEnabled(),
            file: path.relative(REPO_ROOT, FILE),
            file_bytes: buf.byteLength,
            width, height,
            optical_center: { x: width / 2, y: height / 2, note: 'APPROXIMATE — frame geometric center (no distortion-center product on CR2)' },
            exposure_time: exposureTime,
            receipt_version: (receipt as any)?.version ?? null,
            solve: sol ? {
                ra_hours: sol.ra_hours ?? null, dec_degrees: sol.dec_degrees ?? null,
                pixel_scale: sol.pixel_scale ?? null, stars_matched: sol.stars_matched ?? matched.length,
                confidence: sol.confidence ?? null,
            } : null,
            matched_count: matched.length,
            matched_with_catcolor: stars.filter(s => s.catBpRp !== null).length,
            usable_count: stars.filter(s => s.usable).length,
            recorded_at: new Date().toISOString(),
            stars,
        };
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
        expect(fs.existsSync(OUT)).toBe(true);
        StarCatalogAdapter.setAtlasLoader(null);
    }, 900_000);
});
