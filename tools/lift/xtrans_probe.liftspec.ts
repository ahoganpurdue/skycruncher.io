// ═══════════════════════════════════════════════════════════════════════════
// X-TRANS DEMOSAIC PROBE (decode + view ONLY — no engine change; LAW 7 respected)
// ═══════════════════════════════════════════════════════════════════════════
//
// Decodes ONE Fuji RAF via libraw-wasm TWO ways and renders 1:1 crops so a human
// can SEE whether a proper X-Trans demosaic removes the high-frequency 6×6 CFA
// checkerboard that floods detection (quads_detected=0 across all lift levels):
//
//   A. DOCUMENT MODE (noInterpolation:true)  = the CURRENT RAF path
//        (metadata_reaper.ts:501) — leaves the X-Trans CFA grid undemosaiced.
//   B. FULL DEMOSAIC (noInterpolation:false) = libraw auto-selects the X-Trans
//        Markesteijn interpolation for an X-Trans sensor — the PROPOSED fix.
//
// This is a PROBE: it calls libraw-wasm directly and does NOT touch the engine
// decode path or the mem_image boundary contract. The 1:1 crop is essential — a
// downsample box-averages the 6px checkerboard away (why the earlier eyes-on PNGs
// looked clean). Also reports a period-2 checkerboard amplitude for each.
//
//   LIFT_EYES_FRAME=<raf> LIFT_EYES_OUT=<dir> \
//     npx vitest run -c tools/lift/lift_harness.config.ts tools/lift/xtrans_probe.liftspec.ts

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// Importing headless_driver installs the Node→browser Worker shim libraw-wasm needs.
import '../api/headless_driver';
import { reduceToLuminance, LUMA_REC709, period2ParityAmplitude } from '@/engine/pipeline/m4_signal_detect/luminance_reduce';
import { autoscaleToGray8, gray8ToRgba, robustPercentile } from './render_luma';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs') as { PNG: any };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRAME = process.env.LIFT_EYES_FRAME;
const OUT_DIR = process.env.LIFT_EYES_OUT || path.join(ROOT, 'test_results', 'xtrans_probe');
// Native-res crop window (a mid-frame region with structure but not pure black).
const CX = Number(process.env.LIFT_PROBE_CX || 3700);
const CY = Number(process.env.LIFT_PROBE_CY || 3400);
const CROP = Number(process.env.LIFT_PROBE_CROP || 420);

function writePng(gray: Uint8Array, w: number, h: number, outPath: string): void {
    const png = new PNG({ width: w, height: h });
    png.data = Buffer.from(gray8ToRgba(gray));
    fs.writeFileSync(outPath, PNG.sync.write(png));
}

/** Extract a native-res luma crop (CROP×CROP at CX,CY), clamped to the frame. */
function crop(luma: Float32Array, w: number, h: number): { data: Float32Array; cw: number; ch: number } {
    const x0 = Math.max(0, Math.min(w - CROP, CX));
    const y0 = Math.max(0, Math.min(h - CROP, CY));
    const cw = Math.min(CROP, w - x0), ch = Math.min(CROP, h - y0);
    const out = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = luma[(y0 + y) * w + (x0 + x)];
    return { data: out, cw, ch };
}

async function decode(rawBytes: Uint8Array, noInterpolation: boolean): Promise<{ luma: Float32Array; w: number; h: number }> {
    const LibRawModule = await import('libraw-wasm');
    const LibRaw = (LibRawModule as any).default || LibRawModule;
    const raw = new LibRaw();
    await raw.open(rawBytes.slice(), { noInterpolation, outputBps: 16, noAutoBright: true, useCameraWb: false, useAutoWb: false });
    const rawData = await raw.imageData();
    const meta = await raw.metadata();
    const w = meta?.width || 0, h = meta?.height || 0;
    let rgb: Uint16Array;
    if (rawData instanceof Uint16Array) rgb = rawData;
    else if ((rawData as any).data instanceof Uint16Array) rgb = (rawData as any).data;
    else rgb = new Uint16Array((rawData as any).buffer, (rawData as any).byteOffset || 0, (rawData as any).length || 0);
    const f = new Float32Array(rgb.length);
    for (let i = 0; i < rgb.length; i++) f[i] = rgb[i];
    const luma = reduceToLuminance(f, LUMA_REC709);
    return { luma, w, h };
}

describe('X-Trans demosaic probe (document mode vs full demosaic)', () => {
    it('decodes both ways and renders native-res crops', async () => {
        if (!FRAME) throw new Error('LIFT_EYES_FRAME env var (RAF path) is required');
        fs.mkdirSync(OUT_DIR, { recursive: true });
        const bytes = new Uint8Array(fs.readFileSync(FRAME));
        const base = path.basename(FRAME).replace(/\.[^.]+$/, '');

        const doc = await decode(bytes, true);
        const dem = await decode(bytes, false);
        console.log(`[xtrans] document ${doc.w}x${doc.h} · demosaic ${dem.w}x${dem.h}`);

        const results: Record<string, unknown> = { frame: base, crop: { CX, CY, CROP } };
        for (const [tag, d] of [['document', doc], ['demosaic', dem]] as const) {
            const c = crop(d.luma, d.w, d.h);
            const lo = robustPercentile(c.data, 0.02), hi = robustPercentile(c.data, 0.99);
            const { gray } = autoscaleToGray8(c.data, {}, lo, hi);
            writePng(gray, c.cw, c.ch, path.join(OUT_DIR, `${base}__crop_${tag}.png`));
            // period-2 (Nyquist) checkerboard amplitude over the crop — high ⇒ CFA grid.
            const p2 = period2ParityAmplitude(c.data, c.cw, c.ch);
            results[tag] = { w: d.w, h: d.h, crop_period2_amp: p2 };
        }
        fs.writeFileSync(path.join(OUT_DIR, `${base}__xtrans_probe.json`), JSON.stringify(results, null, 2));
        console.log(`[xtrans] SUMMARY ${JSON.stringify(results)}`);
        expect(fs.existsSync(path.join(OUT_DIR, `${base}__crop_demosaic.png`))).toBe(true);
    });
});
