import { describe, it, expect } from 'vitest';
import { computeHorizonEnvelope } from '../pipeline/m4_signal_detect/horizon_envelope';

/**
 * Synthetic nightscape: uniform star field above a terrain line, a tower
 * that punches a notch into the star field, and a foreground light
 * (campfire) well below the horizon. The envelope must trace the terrain
 * and the tower, and must NOT get hijacked by the campfire.
 */
function syntheticField(width: number, height: number) {
    const pts: { x: number; y: number }[] = [];
    const horizonY = (x: number) => {
        // Flat terrain at 70% height with a tower (notch) from x 45-55%.
        if (x > width * 0.45 && x < width * 0.55) return height * 0.35;
        return height * 0.7;
    };
    // Dense sky above the horizon (grid + jitter keeps it deterministic).
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let gx = 0; gx < 60; gx++) {
        for (let gy = 0; gy < 40; gy++) {
            const x = (gx + rand()) * (width / 60);
            const y = (gy + rand()) * (height / 40);
            if (y < horizonY(x) - 8) pts.push({ x, y });
        }
    }
    return { pts, horizonY };
}

describe('computeHorizonEnvelope', () => {
    it('traces flat terrain and a tower notch from star detections', () => {
        const W = 4000, H = 3000;
        const { pts, horizonY } = syntheticField(W, H);
        const env = computeHorizonEnvelope(pts, W, H);

        expect(env.hasTerrainEvidence).toBe(true);
        expect(env.coverage).toBeGreaterThan(0.6);

        // Flat sections sit near the terrain line (within one column of slack).
        const flat = env.points.filter(p => p.x < W * 0.4 || p.x > W * 0.6);
        for (const p of flat) {
            expect(Math.abs(p.y - horizonY(p.x))).toBeLessThan(H * 0.08);
        }
        // The tower notch pulls the envelope UP (smaller y) at frame center.
        const notch = env.points.filter(p => p.x > W * 0.47 && p.x < W * 0.53);
        for (const p of notch) {
            expect(p.y).toBeLessThan(H * 0.5);
        }
    });

    it('is not hijacked by an isolated foreground light', () => {
        const W = 4000, H = 3000;
        const { pts } = syntheticField(W, H);
        // Campfire: a lone detection deep in the foreground.
        pts.push({ x: W * 0.25, y: H * 0.93 });
        const env = computeHorizonEnvelope(pts, W, H);
        const col = env.points.find(p => Math.abs(p.x - W * 0.25) < W / 96);
        expect(col).toBeDefined();
        // Envelope stays at the terrain (~0.7H), not dragged to 0.93H.
        expect(col!.y).toBeLessThan(H * 0.8);
    });

    it('asserts nothing on a full-sky frame (evidence gate)', () => {
        const W = 4000, H = 3000;
        const pts: { x: number; y: number }[] = [];
        let seed = 7;
        const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
        for (let i = 0; i < 800; i++) pts.push({ x: rand() * W, y: rand() * H });
        const env = computeHorizonEnvelope(pts, W, H);
        expect(env.hasTerrainEvidence).toBe(false);
    });
});
