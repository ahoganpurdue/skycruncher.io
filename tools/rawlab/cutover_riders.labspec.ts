/**
 * DECODER-CUTOVER CEREMONY RIDERS (2026-07-11) — ONE arm, env-selected.
 *
 * Spawned once per arm by tools/rawlab/cutover_riders.mjs:
 *   RAWLAB_RIDER_FILE  — RAW file to run (default: bundled demo CR2)
 *   RAWLAB_RIDER_OUT   — REQUIRED absolute path for the arm's JSON record
 *   VITE_DECODER_RAWLER unset/absent = DEFAULT arm (rawler, post-cutover @56cf96d)
 *   VITE_DECODER_RAWLER=0            = COLD PATH (libraw)
 *
 * Two riders, both EVIDENCE-ONLY (report what is MEASURED; null = honest absence):
 *   (a) SPCC block — from the REAL receipt (runWizardPipeline, the exact
 *       tools/api/solve_cr2.apispec.ts path). The CR2-lane SPCC gate is
 *       `isFits && scienceRgb && matched>0` (stages/science.ts:118) so the CR2
 *       receipt.spcc is EXPECTED null on BOTH arms (SPCC is FITS-only). Recorded
 *       verbatim alongside the photometry summary (matched aperture photometry,
 *       which DOES move with the decode) so the owner can see the true delta.
 *   (b) rgb16 handoff hash — extractRawSensorData() decode-contract buffer
 *       (m1_ingestion/metadata_reaper.ts:462), md5 of the LE-u16 (or LE-f32)
 *       active-area plane the solve consumed. This is the `rawler_cfa` LAW-7
 *       boundary (src/engine/contracts/binary_layouts.ts:226). Arms WILL differ
 *       (rawler = first real integer demosaic; libraw = document-mode passthrough).
 *
 * *.labspec.ts — collected by NO standing gate (ab_pipeline.config.ts include).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Importing headless_driver installs the Node Worker bridge libraw needs.
import { bootRealWasm, makeFsAtlasLoader, runWizardPipeline } from '../api/headless_driver';
import { extractRawSensorData } from '@/engine/pipeline/m1_ingestion/metadata_reaper';
import { isRawlerDecoderEnabled } from '@/engine/pipeline/m1_ingestion/rawler_decoder';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = process.env.RAWLAB_RIDER_FILE ?? path.join(REPO_ROOT, 'public', 'demo', 'sample_observation.cr2');
const OUT = process.env.RAWLAB_RIDER_OUT ?? '';
// Post-cutover truth: flag ABSENT ⇒ rawler (default). Only '0'/'false' ⇒ libraw.
const ARM = isRawlerDecoderEnabled() ? 'rawler_default' : 'libraw_cold';

function freshAB(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Light streaming stats over a typed array (no giant intermediate copies). */
function stats(a: ArrayLike<number> & { length: number }): Record<string, number> | null {
    if (!a || a.length === 0) return null;
    let mn = Infinity, mx = -Infinity, sum = 0;
    const step = Math.max(1, Math.ceil(a.length / 4_000_000)); // bounded scan
    let n = 0;
    for (let i = 0; i < a.length; i += step) {
        const v = a[i];
        if (v < mn) mn = v; if (v > mx) mx = v; sum += v; n++;
    }
    return { min: mn, max: mx, mean: +(sum / n).toFixed(4), scan_step: step, scanned: n };
}

function bytesOf(data: any): Buffer {
    // Uint16Array / Float32Array / Uint8Array → underlying bytes (native LE on x64).
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

describe(`decoder-cutover riders — arm ${ARM}`, () => {
    it(`records SPCC block + rgb16 handoff md5 for ${path.basename(FILE)}`, async () => {
        expect(OUT, 'RAWLAB_RIDER_OUT is required (set by cutover_riders.mjs)').toBeTruthy();
        expect(fs.existsSync(FILE), `input missing: ${FILE}`).toBe(true);

        bootRealWasm();
        StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(path.join(REPO_ROOT, 'public')));

        const buf = fs.readFileSync(FILE);
        const rec: Record<string, unknown> = {
            arm: ARM,
            flag_env: process.env.VITE_DECODER_RAWLER ?? null,
            rawler_enabled: isRawlerDecoderEnabled(),
            file: FILE,
            file_bytes: buf.byteLength,
            started_at: new Date().toISOString(),
        };

        // ── RIDER (b): rgb16 decode handoff hash (the `rawler_cfa` boundary) ──
        // Direct extractRawSensorData — the m1 decode contract the solve consumes.
        try {
            const dec = await extractRawSensorData(freshAB(buf));
            if (!dec) {
                rec.rgb16 = { error: 'extractRawSensorData returned null (decode failure)' };
            } else {
                const data: any = dec.data;
                const dtype = data instanceof Uint16Array ? 'u16_le'
                    : data instanceof Float32Array ? 'f32_le'
                    : data instanceof Uint8Array ? 'u8' : (data?.constructor?.name ?? 'unknown');
                const md5 = crypto.createHash('md5').update(bytesOf(data)).digest('hex');
                rec.rgb16 = {
                    width: dec.width, height: dec.height, stride: dec.stride,
                    isDemosaiced: dec.isDemosaiced,
                    bayerPattern: (dec as any).bayerPattern ?? null,
                    cfaMosaicLuma: (dec as any).cfaMosaicLuma ?? null,
                    dtype, len_elems: data.length, len_bytes: data.byteLength,
                    // elems-per-pixel disambiguates interleaved-RGB (3) vs CFA/luma (1).
                    elems_per_px: +(data.length / (dec.width * dec.height)).toFixed(4),
                    md5,
                    stats: stats(data),
                    rawler_contract: (dec as any).rawler
                        ? {
                            present: true,
                            pattern: (dec as any).rawler?.pattern ?? null,
                            blacklevel: (dec as any).rawler?.blacklevel ?? (dec as any).rawler?.levels?.black ?? null,
                            whitelevel: (dec as any).rawler?.whitelevel ?? (dec as any).rawler?.levels?.white ?? null,
                        }
                        : { present: false },
                };
            }
        } catch (err) {
            rec.rgb16 = { error: String((err as Error)?.message ?? err) };
        }

        // ── RIDER (a): SPCC block from the real receipt ──
        try {
            const { receipt, session } = await runWizardPipeline(freshAB(buf), {
                atlasRoot: path.join(REPO_ROOT, 'public'),
            });
            const sol: any = receipt?.solution ?? null;
            const phot: any = receipt?.photometry ?? null;
            rec.receipt_version = receipt?.version ?? null;
            rec.spcc = receipt?.spcc ?? null; // EXPECTED null on the CR2 lane (FITS-only gate)
            rec.spcc_note = receipt?.spcc == null
                ? 'null — CR2 lane carries no SPCC (gate: isFits && scienceRgb && matched>0, science.ts:118)'
                : 'PRESENT';
            rec.photometry = phot
                ? {
                    // Summarize without dumping per-star arrays.
                    keys: Object.keys(phot),
                    n_stars: Array.isArray(phot?.stars) ? phot.stars.length : (phot?.n ?? null),
                    provenance_counts: Array.isArray(phot?.stars)
                        ? phot.stars.reduce((m: Record<string, number>, s: any) => {
                            const p = s?.provenance ?? 'UNKNOWN'; m[p] = (m[p] ?? 0) + 1; return m;
                        }, {})
                        : null,
                }
                : null;
            rec.solve = sol
                ? {
                    solved: true,
                    ra_hours: sol.ra_hours ?? null,
                    dec_degrees: sol.dec_degrees ?? null,
                    pixel_scale: sol.pixel_scale ?? null,
                    stars_matched: sol.stars_matched ?? sol.matched_stars?.length ?? null,
                    confidence: sol.confidence ?? null,
                }
                : { solved: false };
            rec.confirm_status = receipt?.confirm_status ?? null;
            rec.scaleLock = (session as any).scaleLock ?? null;
        } catch (err) {
            rec.spcc = null;
            rec.solve_error = String((err as Error)?.message ?? err);
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
