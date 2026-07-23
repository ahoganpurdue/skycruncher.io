import { describe, it, expect } from 'vitest';
import { computeHorizonEnvelope } from '../pipeline/m4_signal_detect/horizon_envelope';

/**
 * DETECTION-ENVELOPE -> CULLING BRIDGE (the wiring restored in signal_processor).
 *
 * The unit test m4_horizon_envelope.test.ts proves the envelope TRACES terrain.
 * This test proves the CULLING CONTRACT the bridge relies on: when the derived
 * envelope is used as a per-column cull threshold, the foreground detections
 * that flood wide-field DSLR landscapes (the 45k-70k problem) fall BELOW the
 * threshold and get culled, while the sky field above survives — and that a
 * full-sky frame yields NO terrain evidence, so the gate stays shut and nothing
 * is culled (this is what keeps tracked-telescope frames byte-identical).
 *
 * The rasteriser + column sampler below MIRROR SignalProcessor's private
 * envelopeToHorizonVector / horizonVectorToColumns + the foreground-shielding
 * predicate (`star.y > horizon[gx].y - 1`); the real glue is additionally
 * exercised end-to-end by the browser e2e (the WASM blob extractor cannot run
 * in Vitest's mocked node env, so the full analyzeWithMasking path can't be
 * driven here).
 */

const W = 5184, H = 3456; // Canon T6 / Rokinon-14 native frame

// Flat terrain at 72% height with a mountain peak (notch) mid-frame — the
// silhouette shape of the IMG_0563 nightscape used for manual verification.
const ridgeY = (x: number) =>
    (x > W * 0.60 && x < W * 0.78) ? H * 0.55 : H * 0.72;

function seeded(seed: number) {
    let s = seed;
    return () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s / 2 ** 31; };
}

/** Mirror of SignalProcessor.envelopeToHorizonVector (linear interp, clamped). */
function envelopeToHorizonVector(env: ReturnType<typeof computeHorizonEnvelope>): Uint16Array {
    const vec = new Uint16Array(W);
    const pts = env.points, n = pts.length, colW = W / n;
    const clampY = (y: number) => Math.max(0, Math.min(H - 1, Math.round(y)));
    for (let x = 0; x < W; x++) {
        const f = x / colW - 0.5, base = Math.floor(f);
        const i0 = Math.max(0, Math.min(n - 1, base));
        const i1 = Math.max(0, Math.min(n - 1, base + 1));
        const t = Math.max(0, Math.min(1, f - base));
        vec[x] = clampY(pts[i0].y + (pts[i1].y - pts[i0].y) * t);
    }
    return vec;
}

/** Mirror of the foreground-shielding predicate in analyzeWithMasking. */
function isCulledAsTerrain(x: number, y: number, vec: Uint16Array): boolean {
    const gx = Math.min(159, Math.max(0, Math.floor(x / (W / 160))));
    const colX = Math.max(0, Math.min(vec.length - 1, Math.floor(gx * (W / 160))));
    const hzY = vec[colX];
    return y > hzY - 1;
}

describe('detection-envelope -> culling bridge', () => {
    it('culls the wide-field foreground flood and keeps the sky field', () => {
        const rand = seeded(11);
        // VANGUARD-level detections (what the envelope is derived from): a dense
        // sky field above the ridge + a few bright foreground sources (a light,
        // scattered ground glints) that must NOT drag the envelope down.
        const vanguard: { x: number; y: number }[] = [];
        for (let gx = 0; gx < 72; gx++)
            for (let gy = 0; gy < 48; gy++) {
                const x = (gx + rand()) * (W / 72), y = (gy + rand()) * (H / 48);
                if (y < ridgeY(x) - 10) vanguard.push({ x, y });
            }
        const skyCount = vanguard.length;
        // Sparse bright foreground at vanguard level (campfire + ground glints).
        vanguard.push({ x: W * 0.42, y: H * 0.90 });
        for (let i = 0; i < 15; i++) vanguard.push({ x: rand() * W, y: (0.75 + rand() * 0.23) * H });

        const env = computeHorizonEnvelope(vanguard, W, H);
        expect(env.hasTerrainEvidence).toBe(true);
        expect(env.coverage).toBeGreaterThan(0.6);

        const vec = envelopeToHorizonVector(env);

        // DEEP-scan foreground flood — the ~45k problem, modelled as a dense
        // band of ground detections BELOW the ridge that the deep pass emits.
        const flood: { x: number; y: number }[] = [];
        for (let gx = 0; gx < 160; gx++)
            for (let gy = 0; gy < 60; gy++) {
                const x = (gx + rand()) * (W / 160);
                const y = ridgeY(x) + 6 + rand() * (H - ridgeY(x) - 6);
                flood.push({ x, y });
            }

        // The whole detection set the culler faces: real sky + foreground flood.
        const skyDet = vanguard.slice(0, skyCount);
        const floodCulled = flood.filter(p => isCulledAsTerrain(p.x, p.y, vec)).length;
        const skyCulled = skyDet.filter(p => isCulledAsTerrain(p.x, p.y, vec)).length;

        // Nearly the entire foreground flood is removed as TOPOGRAPHY...
        expect(floodCulled / flood.length).toBeGreaterThan(0.98);
        // ...while the sky field above the ridge is essentially untouched (only
        // the lowest sky stars that DEFINE the envelope clip against it).
        expect(skyCulled / skyDet.length).toBeLessThan(0.05);

        // Surfaced for the record (visible with vitest --reporter verbose):
        console.log(`[cull-bridge] sky kept ${skyDet.length - skyCulled}/${skyDet.length}, `
            + `foreground culled ${floodCulled}/${flood.length} `
            + `(${(100 * floodCulled / flood.length).toFixed(1)}%)`);
    });

    it('full-sky frame yields NO terrain evidence — gate stays shut (byte-identical path)', () => {
        const rand = seeded(7);
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < 2000; i++) pts.push({ x: rand() * W, y: rand() * H });
        const env = computeHorizonEnvelope(pts, W, H);
        expect(env.hasTerrainEvidence).toBe(false);
        // With no evidence the culler never derives a vector, so no detection is
        // reclassified as TOPOGRAPHY — the exact pre-change behavior.
    });
});
