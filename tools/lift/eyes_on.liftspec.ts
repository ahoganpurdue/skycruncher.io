// ═══════════════════════════════════════════════════════════════════════════
// NEBULOSITY LIFT — EYES-ON (decode-only; the one-frame law)
// ═══════════════════════════════════════════════════════════════════════════
//
// Decodes ONE frame through the REAL engine decode path, computes the detection
// luminance, fits BOTH background bases (deg-2 poly + coarse median-mesh), lifts,
// and renders before/after grayscale PNGs (shared auto-scale window) so a human
// can SEE that the diffuse band is suppressed with the stars intact — BEFORE any
// solve is trusted. Also prints band-suppression + top-N peak-spread stats (the
// coordinator's success criterion: after the lift, do the brightest peaks spread
// across the field like stars instead of clustering on the band?).
//
// NOT a solve — decode + fit + render only, so it is light on the box. Driven by
// tools/lift/run_xt_lifted.mjs (or directly):
//   LIFT_EYES_FRAME=<raf> LIFT_EYES_OUT=<dir> \
//     npx vitest run -c tools/lift/lift_harness.config.ts tools/lift/eyes_on.liftspec.ts

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bootRealWasm, makeFsAtlasLoader } from '../api/headless_driver';
import { StarCatalogAdapter } from '@/engine/pipeline/m6_plate_solve/star_catalog_adapter';
import { decodeScienceFrame } from '@/engine/pipeline/stages/ingest';
import { detectMagicFormatSync } from '@/engine/pipeline/m1_ingestion/metadata_reaper';
import { reduceToLuminance, LUMA_REC709 } from '@/engine/pipeline/m4_signal_detect/luminance_reduce';
import { fitBackground, liftLuma, type BackgroundModel } from './nebulosity_lift';
import {
    downsampleLuma, autoscaleToGray8, gray8ToRgba, robustPercentile,
    topLocalMaxima, peakSpread,
} from './render_luma';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs') as { PNG: any };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ATLAS_ROOT = path.join(ROOT, 'public');
const FRAME = process.env.LIFT_EYES_FRAME;
const OUT_DIR = process.env.LIFT_EYES_OUT || path.join(ROOT, 'test_results', 'lift_eyes_on');
const MAX_DIM = Number(process.env.LIFT_EYES_MAXDIM || 1400);

function writePng(gray: Uint8Array, w: number, h: number, outPath: string): void {
    const png = new PNG({ width: w, height: h });
    png.data = Buffer.from(gray8ToRgba(gray));
    fs.writeFileSync(outPath, PNG.sync.write(png));
}

/** Band-flatness metrics: normalized spread (robust) of the luma. Lower after ⇒ flatter. */
function flatnessStats(luma: Float32Array) {
    const p50 = robustPercentile(luma, 0.5);
    const p10 = robustPercentile(luma, 0.10);
    const p999 = robustPercentile(luma, 0.999);
    // robust "dynamic pedestal": how far the bright-diffuse tail sits above the floor.
    return { p10, p50, p999, span_p999_minus_p10: p999 - p10, pedestal_p50_minus_p10: p50 - p10 };
}

describe('nebulosity lift — eyes-on (decode + fit + render, no solve)', () => {
    it('renders before/after luma and reports band suppression', async () => {
        if (!FRAME) throw new Error('LIFT_EYES_FRAME env var (path to a RAW frame) is required');
        if (!fs.existsSync(FRAME)) throw new Error(`frame not found: ${FRAME}`);
        fs.mkdirSync(OUT_DIR, { recursive: true });

        bootRealWasm();
        StarCatalogAdapter.setAtlasLoader(makeFsAtlasLoader(ATLAS_ROOT));
        try {
            const buf = fs.readFileSync(FRAME);
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
            const fmt = detectMagicFormatSync(ab);
            const frame = await decodeScienceFrame(ab, fmt, undefined, (s) => console.log(`[eyes-on] ${s}`));
            const { fullRGB, width, height } = frame;
            const luma = reduceToLuminance(fullRGB, LUMA_REC709);
            console.log(`[eyes-on] decoded ${width}x${height} (${fmt}); luma px=${luma.length}`);

            const base = path.basename(FRAME).replace(/\.[^.]+$/, '');
            const models: Array<{ tag: string; m: BackgroundModel }> = [
                { tag: 'poly2', m: fitBackground(luma, width, height, { model: 'poly2' }) },
                { tag: 'mesh', m: fitBackground(luma, width, height, { model: 'median_mesh', tilesX: 64, tilesY: 44 }) },
            ];

            // Shared auto-scale window from the BEFORE frame so before/after are comparable.
            const beforeDs = downsampleLuma(luma, width, height, MAX_DIM);
            const lo = robustPercentile(beforeDs.data, 0.10);
            const hi = robustPercentile(beforeDs.data, 0.999);
            const { gray: gBefore } = autoscaleToGray8(beforeDs.data, {}, lo, hi);
            writePng(gBefore, beforeDs.width, beforeDs.height, path.join(OUT_DIR, `${base}__before.png`));

            const beforePeaks = topLocalMaxima(beforeDs.data, beforeDs.width, beforeDs.height, 30, 8);
            const beforeSpread = peakSpread(beforePeaks, beforeDs.width, beforeDs.height);

            const summary: Record<string, unknown> = {
                frame: base, width, height,
                before: { ...flatnessStats(luma), top30_peak_spread_norm: [beforeSpread.sxNorm, beforeSpread.syNorm] },
                variants: {},
            };

            for (const { tag, m } of models) {
                const lifted = liftLuma(luma, width, height, m);
                const ds = downsampleLuma(lifted, width, height, MAX_DIM);
                const { gray } = autoscaleToGray8(ds.data, {}, lo, hi); // SAME window
                writePng(gray, ds.width, ds.height, path.join(OUT_DIR, `${base}__after_${tag}.png`));
                const peaks = topLocalMaxima(ds.data, ds.width, ds.height, 30, 8);
                const spread = peakSpread(peaks, ds.width, ds.height);
                (summary.variants as Record<string, unknown>)[tag] = {
                    ...flatnessStats(lifted),
                    top30_peak_spread_norm: [spread.sxNorm, spread.syNorm],
                    model_kind: m.kind,
                };
            }

            fs.writeFileSync(path.join(OUT_DIR, `${base}__eyes_on.json`), JSON.stringify(summary, null, 2));
            console.log(`[eyes-on] SUMMARY ${JSON.stringify(summary)}`);
            console.log(`[eyes-on] wrote PNGs + summary to ${OUT_DIR}`);
            expect(fs.existsSync(path.join(OUT_DIR, `${base}__before.png`))).toBe(true);
        } finally {
            StarCatalogAdapter.setAtlasLoader(null);
        }
    });
});
