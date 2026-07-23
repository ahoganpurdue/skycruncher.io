/**
 * M10 PSF stage — measurement + windowed damped-RL deconvolution (2026-07).
 *
 * Ported from the verified tools/psf headless lane; these tests pin the port:
 *  1. moment-based FWHM recovers a known synthetic Gaussian width,
 *  2. the empirical kernel stack is normalized and centered,
 *  3. damped RL tightens a star and captures the requested iteration
 *     snapshots (the cheap opt-in flag of the owner performance directive),
 *  4. runPsfStage end-to-end: honest report, optional deconv lane, event
 *     emission through the INJECTED bus, and strict absence when disabled.
 */
import { describe, it, expect } from 'vitest';
import {
    findMaxima, measureStar, buildEmpiricalKernel, pixelNoiseSigma, medianOf
} from '../pipeline/m10_psf/psf_core';
import { richardsonLucyWindow, convolve2d } from '../pipeline/m10_psf/rl_deconv';
import { runPsfStage } from '../pipeline/m10_psf/psf_stage';
import { PipelineEventBus } from '../events/pipeline_events';

// ── synthetic field helpers ───────────────────────────────────────────────

function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface SynthStar { x: number; y: number; amp: number; sigma: number; }

function makeField(w: number, h: number, stars: SynthStar[], pedestal = 0.1, noise = 0.001, seed = 42): Float32Array {
    const rng = mulberry32(seed);
    const L = new Float32Array(w * h);
    for (let i = 0; i < L.length; i++) {
        // approx gaussian noise: sum of 4 uniforms
        L[i] = pedestal + noise * (rng() + rng() + rng() + rng() - 2) * 1.73;
    }
    for (const s of stars) {
        const R = Math.ceil(5 * s.sigma);
        for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
                const x = s.x + dx, y = s.y + dy;
                if (x < 0 || y < 0 || x >= w || y >= h) continue;
                L[y * w + x] += s.amp * Math.exp(-(dx * dx + dy * dy) / (2 * s.sigma * s.sigma));
            }
        }
    }
    return L;
}

const FW = 2 * Math.sqrt(2 * Math.log(2)); // 2.3548

// ── primitives ────────────────────────────────────────────────────────────

describe('m10 psf_core primitives', () => {
    it('measureStar recovers a known Gaussian FWHM on the native grid', () => {
        const sigma = 1.7;
        const L = makeField(64, 64, [{ x: 32, y: 32, amp: 0.2, sigma }], 0.1, 0.0005);
        const m = measureStar(L, 64, 64, 32, 32, pixelNoiseSigma(L), 7);
        expect(m).not.toBeNull();
        const expected = FW * sigma; // ~4.0 px
        expect(m!.fwhmMaj).toBeGreaterThan(expected * 0.8);
        expect(m!.fwhmMaj).toBeLessThan(expected * 1.2);
        expect(Math.abs(m!.cx - 32)).toBeLessThan(0.3);
        expect(m!.ellipticity).toBeLessThan(0.25); // round source
    });

    it('findMaxima locates the planted peaks and sorts brightest-first', () => {
        const L = makeField(128, 128, [
            { x: 40, y: 40, amp: 0.3, sigma: 1.5 },
            { x: 90, y: 80, amp: 0.15, sigma: 1.5 }
        ], 0.1, 0.0005);
        const peaks = findMaxima(L, 128, 128, 0.1 + 0.02, 100, 8);
        expect(peaks.length).toBeGreaterThanOrEqual(2);
        expect(Math.abs(peaks[0].x - 40)).toBeLessThanOrEqual(1);
        expect(Math.abs(peaks[0].y - 40)).toBeLessThanOrEqual(1);
        expect(peaks[0].v).toBeGreaterThan(peaks[1].v);
    });

    it('empirical kernel stacks to sum 1 with a centered core', () => {
        const stars = [
            { x: 30, y: 30 }, { x: 80, y: 32 }, { x: 130, y: 34 },
            { x: 32, y: 90 }, { x: 82, y: 92 }, { x: 132, y: 94 }
        ].map(p => ({ ...p, amp: 0.2, sigma: 1.6 }));
        const L = makeField(170, 130, stars, 0.1, 0.0005);
        const measured = stars.map(s => measureStar(L, 170, 130, s.x, s.y, pixelNoiseSigma(L), 7)!).filter(Boolean);
        const k = buildEmpiricalKernel(L, 170, 130, measured, 15);
        expect(k).not.toBeNull();
        let sum = 0, peakIdx = 0;
        for (let i = 0; i < k!.k.length; i++) { sum += k!.k[i]; if (k!.k[i] > k!.k[peakIdx]) peakIdx = i; }
        expect(sum).toBeCloseTo(1, 6);
        expect(peakIdx).toBe(7 * 15 + 7); // center pixel
    });
});

// ── damped RL ─────────────────────────────────────────────────────────────

describe('m10 damped Richardson-Lucy (windowed)', () => {
    it('tightens a star and captures the requested snapshots', async () => {
        const sigma = 1.8;
        const W = 81;
        const L = makeField(W, W, [{ x: 40, y: 40, amp: 0.25, sigma }], 0.05, 0.0008, 7);
        // kernel = the true PSF (discrete gaussian, normalized)
        const ks = 11, kR = 5;
        const K = new Float64Array(ks * ks);
        let s = 0;
        for (let j = 0; j < ks; j++) for (let i = 0; i < ks; i++) {
            const v = Math.exp(-((i - kR) ** 2 + (j - kR) ** 2) / (2 * sigma * sigma));
            K[j * ks + i] = v; s += v;
        }
        for (let i = 0; i < K.length; i++) K[i] /= s;

        const before = measureStar(L, W, W, 40, 40, pixelNoiseSigma(L), 7)!;
        const { estimate, snapshots, itersRun } = await richardsonLucyWindow({
            obs: L, w: W, h: W, kernel: { k: K, size: ks },
            iters: 8, sigmaDamp: pixelNoiseSigma(L),
            snapshotIters: [1, 3]
        });
        expect(itersRun).toBe(8);
        expect(snapshots.map(sn => sn.iter)).toEqual([1, 3]);

        const after = measureStar(estimate, W, W, 40, 40, pixelNoiseSigma(estimate), 7)!;
        expect(after.fwhmMaj).toBeLessThan(before.fwhmMaj); // deconvolution tightened it
    });

    it('convolve2d preserves flux for a normalized kernel (interior)', () => {
        const W = 41;
        const src = new Float32Array(W * W);
        src[20 * W + 20] = 1;
        const dst = new Float32Array(W * W);
        const K = new Float64Array(9).fill(1 / 9);
        convolve2d(src, dst, W, W, K, 3);
        let sum = 0;
        for (const v of dst) sum += v;
        expect(sum).toBeCloseTo(1, 6);
    });
});

// ── the stage ─────────────────────────────────────────────────────────────

function makeStarField(): { L: Float32Array; w: number; h: number } {
    const w = 360, h = 360;
    const rng = mulberry32(99);
    const stars: SynthStar[] = [];
    // widely spaced grid (>=45px apart, >=30px margin) — no crowding culls
    for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 7; gx++) {
            stars.push({
                x: 35 + gx * 48 + Math.floor(rng() * 5),
                y: 35 + gy * 48 + Math.floor(rng() * 5),
                amp: 0.04 + rng() * 0.2,
                sigma: 1.8
            });
        }
    }
    return { L: makeField(w, h, stars, 0.1, 0.0008, 5), w, h };
}

describe('m10 runPsfStage (typed stage, injected bus)', () => {
    it('measures the field honestly and deconvolves the target windows', async () => {
        const { L, w, h } = makeStarField();
        const bus = new PipelineEventBus();
        const report = await runPsfStage({
            lum: L, width: w, height: h, events: bus,
            options: { iters: 6, tileCount: 2, windowRadius: 36, stripWindowRadius: 36, snapshotIters: [1, 3] }
        });

        expect(report.ledger).toBe('PIXEL');
        expect(report.nMeasured).toBeGreaterThanOrEqual(20);
        const expected = FW * 1.8; // ~4.24
        expect(report.fwhmMedianPx).toBeGreaterThan(expected * 0.8);
        expect(report.fwhmMedianPx).toBeLessThan(expected * 1.2);
        expect(report.regionFwhm).toHaveLength(9);
        expect(report.kernel).not.toBeNull();

        // deconv lane ran: strip + tiles + measured improvement
        expect(report.deconv).not.toBeNull();
        const d = report.deconv!;
        expect(d.tiles.length).toBe(4); // 2 bright + 2 smeared
        expect(d.strip).not.toBeNull();
        const labels = d.strip!.stages.map(s => s.label);
        expect(labels[0]).toBe('NATIVE');
        expect(labels[1]).toBe('BG-FLATTENED');
        expect(labels.some(l => l.startsWith('RL '))).toBe(true);
        expect(d.fwhmMedianAfterPx).not.toBeNull();
        expect(d.fwhmMedianAfterPx!).toBeLessThan(report.fwhmMedianPx);

        // every tile carries measured numbers + real crops
        for (const t of d.tiles) {
            expect(Number.isFinite(t.fwhmBefore)).toBe(true);
            expect(t.before.data.length).toBe(t.before.w * t.before.h);
        }

        // injected bus received the findings
        const kinds = bus.getHistory().filter(e => e.kind === 'finding').map(e => (e as any).finding.kind);
        expect(kinds).toContain('psf_measured');
        expect(kinds).toContain('psf_deconvolved');

        // the windowed-RL approximation is LABELED, never silent
        expect(report.approximate.some(a => a.includes('local'))).toBe(true);
    }, 30000);

    it('deconvolve:false yields the cheap measurement-only report (AUTO mode contract)', async () => {
        const { L, w, h } = makeStarField();
        const report = await runPsfStage({
            lum: L, width: w, height: h,
            options: { deconvolve: false }
        });
        expect(report.nMeasured).toBeGreaterThanOrEqual(20);
        expect(report.kernel).not.toBeNull();  // kernel is cheap; visuals are not
        expect(report.deconv).toBeNull();      // no expensive lane ran
    }, 30000);

    it('captureSnapshots:false skips the strip but keeps measured tiles', async () => {
        const { L, w, h } = makeStarField();
        const report = await runPsfStage({
            lum: L, width: w, height: h,
            options: { iters: 4, tileCount: 1, windowRadius: 30, captureSnapshots: false }
        });
        expect(report.deconv).not.toBeNull();
        expect(report.deconv!.strip).toBeNull();
        expect(report.deconv!.tiles.length).toBe(2);
    }, 30000);

    it('refuses dishonest input (buffer/dims mismatch)', async () => {
        await expect(runPsfStage({ lum: new Float32Array(100), width: 20, height: 20 }))
            .rejects.toThrow(/buffer length/);
    });

    it('median helper is honest about empty input', () => {
        expect(medianOf([])).toBeNull();
        expect(medianOf([3, 1, 2])).toBe(2);
    });
});
