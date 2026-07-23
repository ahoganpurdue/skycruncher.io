import { describe, it, expect } from 'vitest';
// ScaleManager is the real coordinate-mapping unit the pipeline uses: SignalProcessor
// restores sensor coordinates via ScaleManager.scienceToNative (signal_processor.ts:170)
// and samples the preview via previewW/nativeW (sampleColor, :711-720). This test drives
// that real mapping — the previous version imported SignalProcessor but never called it
// and only re-asserted `Math.floor(x·scale) ∈ [0,W)` (a property of arithmetic).
import { ScaleManager } from '../pipeline/m2_hardware/scale_manager';

/**
 * Coordinate Integrity — validates the native ↔ science ↔ preview transforms
 * in ScaleManager (the single source of truth used across the solve path, e.g.
 * orchestrator_session's nativeToscience star scaling).
 */
describe('Coordinate Integrity', () => {
    // 24MP-class sensor, capped at a 1920 preview: scale = 1920/6000 = 0.32.
    const sm = new ScaleManager(6000, 4000, 1920);

    it('derives the preview/science buffer geometry correctly', () => {
        expect(sm.previewW).toBe(1920);          // floor(6000 · 0.32)
        expect(sm.previewH).toBe(1280);          // floor(4000 · 0.32)
        expect(sm.scienceW).toBe(3000);          // 2×2 bin
        expect(sm.scienceH).toBe(2000);
    });

    it('maps native → preview to the exact known pixel (pins scale, no flip)', () => {
        // (3000,1000) · (1920/6000, 1280/4000) = (960, 320)
        const p = sm.nativeToPreview(3000, 1000);
        expect(p.x).toBeCloseTo(960, 6);
        expect(p.y).toBeCloseTo(320, 6);
        // Orientation is preserved: top-left native → top-left preview, and the
        // far corner → far corner. A y-flip would send (0,0)→(_,1280) instead.
        const origin = sm.nativeToPreview(0, 0);
        expect(origin.x).toBeCloseTo(0, 9);
        expect(origin.y).toBeCloseTo(0, 9);
        const corner = sm.nativeToPreview(6000, 4000);
        expect(corner.x).toBeCloseTo(1920, 6);
        expect(corner.y).toBeCloseTo(1280, 6);
    });

    it('round-trips native → preview → native including a high-y point', () => {
        // A far-edge X point and a distinct high-Y point — the two axes use different
        // scale factors, so a swapped-axis bug is caught by the round-trip mismatch.
        for (const pt of [{ x: 5900, y: 100 }, { x: 100, y: 3900 }, { x: 6000, y: 4000 }]) {
            const fwd = sm.nativeToPreview(pt.x, pt.y);
            const back = sm.previewToNative(fwd.x, fwd.y);
            expect(back.x).toBeCloseTo(pt.x, 3);
            expect(back.y).toBeCloseTo(pt.y, 3);
        }
    });

    it('science → native mapping (SignalProcessor detection restore) is exact and invertible', () => {
        // scienceToNative multiplies by nativeW/scienceW = 2 on each axis.
        const nat = sm.scienceToNative(1500, 1000);
        expect(nat.x).toBeCloseTo(3000, 6);
        expect(nat.y).toBeCloseTo(2000, 6);
        const sci = sm.nativeToscience(nat.x, nat.y);
        expect(sci.x).toBeCloseTo(1500, 6);
        expect(sci.y).toBeCloseTo(1000, 6);
    });
});
