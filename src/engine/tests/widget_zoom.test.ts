/**
 * WIDGET ZOOM/PAN — pure unit tests (node env, no DOM).
 *
 * Covers the render-plane zoom chrome added 2026-07-21 (owner directive: widgets
 * too small → plain wheel-over-widget zoom):
 *   - zoom math: cursor-anchored zoom, clamping, floor-snap, wheel direction,
 *     pan gating, pinch, zoom-aware canvas dpr.
 *   - pan arming: a pointerdown on an interactive control never hijacks a pan.
 *   - exemption flag: the two WebGL cascades opt out (ownsPointerZoom) so the
 *     frame wrapper is a pass-through (no double-zoom); everyone else is wrapped.
 */

import { describe, it, expect } from 'vitest';
import {
    IDENTITY_ZOOM,
    MIN_SCALE,
    MAX_SCALE,
    DPR_CAP,
    clampScale,
    isZoomed,
    zoomTowardPoint,
    wheelZoomFactor,
    panBy,
    pinchZoom,
    zoomAwareDpr,
    targetBlocksPan,
    INTERACTIVE_PAN_BLOCK_SELECTOR,
    type ZoomState,
} from '../ui/widgets/zoom_math';
import { WIDGETS } from '../ui/widgets/registry';

// content point currently under a viewport-local cursor, given the transform.
const contentUnder = (s: ZoomState, px: number, py: number) => ({
    x: (px - s.tx) / s.scale,
    y: (py - s.ty) / s.scale,
});

describe('zoom_math — scale clamping + identity', () => {
    it('clampScale keeps scale within [min,max] and rejects non-finite', () => {
        expect(clampScale(0.2)).toBe(MIN_SCALE);      // floor is natural size
        expect(clampScale(1000)).toBe(MAX_SCALE);
        expect(clampScale(3)).toBe(3);
        // Non-finite (NaN or ±Infinity) collapses to the safe floor — a runaway
        // factor never reaches the transform.
        expect(clampScale(Number.NaN)).toBe(MIN_SCALE);
        expect(clampScale(Number.POSITIVE_INFINITY)).toBe(MIN_SCALE);
    });

    it('isZoomed is false at natural size, true once scaled', () => {
        expect(isZoomed(IDENTITY_ZOOM)).toBe(false);
        expect(isZoomed({ scale: 1.0005, tx: 0, ty: 0 })).toBe(false); // within eps
        expect(isZoomed({ scale: 2, tx: -50, ty: -20 })).toBe(true);
    });
});

describe('zoom_math — zoomTowardPoint keeps the cursor point fixed', () => {
    it('the content point under the cursor is invariant across a zoom-in', () => {
        const start: ZoomState = { scale: 1, tx: 0, ty: 0 };
        const px = 120, py = 80;
        const before = contentUnder(start, px, py);
        const next = zoomTowardPoint(start, 2.0, px, py);
        expect(next.scale).toBe(2);
        const after = contentUnder(next, px, py);
        expect(after.x).toBeCloseTo(before.x, 9);
        expect(after.y).toBeCloseTo(before.y, 9);
    });

    it('holds through a compounded zoom at a shifted state', () => {
        const start: ZoomState = { scale: 2.5, tx: -140, ty: -60 };
        const px = 200, py = 175;
        const before = contentUnder(start, px, py);
        const next = zoomTowardPoint(start, 1.3, px, py);
        const after = contentUnder(next, px, py);
        expect(after.x).toBeCloseTo(before.x, 9);
        expect(after.y).toBeCloseTo(before.y, 9);
    });

    it('snaps back to a clean identity when zoomed fully out to the floor', () => {
        const start: ZoomState = { scale: 1.2, tx: -30, ty: -12 };
        const next = zoomTowardPoint(start, 0.1, 60, 40); // clamps to MIN_SCALE
        expect(next).toEqual(IDENTITY_ZOOM);
    });

    it('is a no-op at the max bound', () => {
        const start: ZoomState = { scale: MAX_SCALE, tx: -10, ty: -10 };
        expect(zoomTowardPoint(start, 2, 5, 5)).toBe(start);
    });
});

describe('zoom_math — wheel direction + pan gating', () => {
    it('scroll up (deltaY<0) zooms in; scroll down zooms out', () => {
        expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
        expect(wheelZoomFactor(100)).toBeLessThan(1);
        expect(wheelZoomFactor(0)).toBeCloseTo(1, 9);
        expect(wheelZoomFactor(Number.NaN)).toBe(1);
    });

    it('panBy no-ops at natural size (nothing off-frame), translates when zoomed', () => {
        expect(panBy(IDENTITY_ZOOM, 40, 40)).toBe(IDENTITY_ZOOM);
        const z: ZoomState = { scale: 3, tx: -10, ty: -20 };
        expect(panBy(z, 15, -5)).toEqual({ scale: 3, tx: 5, ty: -25 });
        expect(panBy(z, Number.NaN, 5)).toBe(z); // guarded
    });
});

describe('zoom_math — pinch reuses cursor-anchored zoom', () => {
    it('spreading fingers zooms in about the midpoint; degenerate prior distance no-ops', () => {
        const start: ZoomState = { scale: 1, tx: 0, ty: 0 };
        const mid = { x: 100, y: 100 };
        const before = contentUnder(start, mid.x, mid.y);
        const next = pinchZoom(start, 50, 100, mid.x, mid.y); // 2× spread
        expect(next.scale).toBeCloseTo(2, 9);
        const after = contentUnder(next, mid.x, mid.y);
        expect(after.x).toBeCloseTo(before.x, 9);
        expect(after.y).toBeCloseTo(before.y, 9);
        expect(pinchZoom(start, 0, 100, mid.x, mid.y)).toBe(start);
    });
});

describe('zoom_math — zoom-aware canvas dpr', () => {
    it('grows the backing store with zoom, capped, and never below 1', () => {
        expect(zoomAwareDpr(1, 1)).toBe(1);
        expect(zoomAwareDpr(2, 1)).toBe(2);
        expect(zoomAwareDpr(1, 3)).toBe(3);
        expect(zoomAwareDpr(2, 3)).toBe(DPR_CAP);        // 2*3=6 capped to 4
        expect(zoomAwareDpr(1, 100)).toBe(DPR_CAP);
        expect(zoomAwareDpr(0, 1)).toBe(1);              // bad base → 1
        expect(zoomAwareDpr(1, 0.5)).toBe(1);            // scale below 1 ignored
        expect(zoomAwareDpr(Number.NaN, Number.NaN)).toBe(1);
    });
});

describe('zoom_math — pan arming protects widget controls', () => {
    // A `.closest` shim: returns a truthy match iff the tag/selector is interactive.
    const stub = (interactive: boolean) => ({
        closest: (sel: string) => {
            expect(sel).toBe(INTERACTIVE_PAN_BLOCK_SELECTOR);
            return interactive ? {} : null;
        },
    });

    it('blocks pan on an interactive control, allows it on the background', () => {
        expect(targetBlocksPan(stub(true))).toBe(true);   // e.g. play/pause button, speed/band select
        expect(targetBlocksPan(stub(false))).toBe(false); // background / canvas body
    });

    it('is null/shape-safe', () => {
        expect(targetBlocksPan(null)).toBe(false);
        expect(targetBlocksPan(undefined)).toBe(false);
        expect(targetBlocksPan({} as any)).toBe(false);   // no .closest
    });

    it('the block selector names the greenfield replay controls (button + select)', () => {
        expect(INTERACTIVE_PAN_BLOCK_SELECTOR).toContain('button');
        expect(INTERACTIVE_PAN_BLOCK_SELECTOR).toContain('select');
        expect(INTERACTIVE_PAN_BLOCK_SELECTOR).toContain('[data-zoom-nopan]');
    });
});

describe('widget manifest — ownsPointerZoom exemption flag', () => {
    const byId = new Map(WIDGETS.map((w) => [w.id, w]));

    it('the two WebGL cascades opt OUT (they own their own wheel/drag/pinch)', () => {
        expect(byId.get('flattening_cascade')?.ownsPointerZoom).toBe(true);
        expect(byId.get('lens_profile_3d')?.ownsPointerZoom).toBe(true);
    });

    it('every other registered widget is wrapped (no flag / not true)', () => {
        for (const w of WIDGETS) {
            if (w.id === 'flattening_cascade' || w.id === 'lens_profile_3d') continue;
            expect(w.ownsPointerZoom ?? false, `${w.id} should not opt out of zoom`).toBe(false);
        }
        // spot-check the headline canvas widget IS wrapped (crispness path applies).
        expect(byId.get('greenfield_replay')?.ownsPointerZoom ?? false).toBe(false);
    });
});
