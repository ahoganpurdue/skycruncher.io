/**
 * ZOOM/PAN VIEWPORT — pure math (RENDER PLANE · UI ledger).
 *
 * Extracted so the wheel/pinch/pan geometry is unit-testable in the node vitest
 * environment WITHOUT a DOM (the ZoomPanViewport component is the thin React
 * shell that wires these into pointer/wheel events). No pipeline reach, no
 * collection — this is display-chrome only (owner directive 2026-07-21: widgets
 * too small → plain wheel-over-widget zoom).
 *
 * Convention: the wrapped content is drawn with
 *   `transform: translate(tx, ty) scale(scale)`  ·  transform-origin 0 0
 * so a content-local point (cx, cy) maps to a viewport-local screen point
 *   sx = tx + scale·cx ,  sy = ty + scale·cy .
 * "Zoom toward the cursor" solves for (tx', ty') that keep the content point
 * currently under the cursor fixed while the scale changes.
 */

export interface ZoomState {
    scale: number;
    tx: number;
    ty: number;
}

/** Natural size is the floor — widgets are "too small", we never shrink below 1×. */
export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
/** Backing-store devicePixelRatio ceiling for zoom-aware canvases (crispness cap). */
export const DPR_CAP = 4;
/** Scales within this of 1 are treated as "not zoomed" (chrome hidden, snap to identity). */
export const SCALE_EPS = 1e-3;

export const IDENTITY_ZOOM: ZoomState = { scale: 1, tx: 0, ty: 0 };

/** Clamp a scale into [min, max]; non-finite → min (never NaN-propagates into a transform). */
export function clampScale(s: number, min: number = MIN_SCALE, max: number = MAX_SCALE): number {
    if (!Number.isFinite(s)) return min;
    return Math.min(max, Math.max(min, s));
}

/** Is this state visibly zoomed? (drives the reset + % header chrome — "only when scale ≠ 1"). */
export function isZoomed(state: ZoomState): boolean {
    return Math.abs(state.scale - 1) > SCALE_EPS;
}

/**
 * Zoom by `factor` about the viewport-local point (px, py), keeping the content
 * point under that cursor fixed. At the natural floor the state snaps back to a
 * clean identity (tx = ty = 0) so a full zoom-out always re-centres exactly.
 */
export function zoomTowardPoint(
    state: ZoomState,
    factor: number,
    px: number,
    py: number,
    min: number = MIN_SCALE,
    max: number = MAX_SCALE,
): ZoomState {
    const next = clampScale(state.scale * (Number.isFinite(factor) ? factor : 1), min, max);
    if (next === state.scale) return state; // already at a bound → no-op
    if (Math.abs(next - min) <= SCALE_EPS) return { scale: min, tx: 0, ty: 0 }; // snap to identity at the floor
    const k = next / state.scale;
    return {
        scale: next,
        tx: px - k * (px - state.tx),
        ty: py - k * (py - state.ty),
    };
}

/** Wheel deltaY → multiplicative zoom factor (deltaY < 0 = scroll up = zoom in). */
const WHEEL_K = 0.0015;
export function wheelZoomFactor(deltaY: number): number {
    if (!Number.isFinite(deltaY)) return 1;
    return Math.exp(-deltaY * WHEEL_K);
}

/**
 * Translate the view by a screen-pixel delta. Panning only does anything while
 * zoomed in — at natural size there is nothing off-frame to reveal, so it no-ops.
 */
export function panBy(state: ZoomState, dx: number, dy: number): ZoomState {
    if (state.scale <= MIN_SCALE + SCALE_EPS) return state;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return state;
    return { scale: state.scale, tx: state.tx + dx, ty: state.ty + dy };
}

/**
 * Two-finger pinch: scale by (nextDist / prevDist) about the pinch midpoint,
 * reusing the same cursor-anchored math as the wheel. Degenerate prior distance
 * (≤0) → no-op.
 */
export function pinchZoom(
    state: ZoomState,
    prevDist: number,
    nextDist: number,
    midX: number,
    midY: number,
    min: number = MIN_SCALE,
    max: number = MAX_SCALE,
): ZoomState {
    if (!(prevDist > 0) || !Number.isFinite(nextDist)) return state;
    return zoomTowardPoint(state, nextDist / prevDist, midX, midY, min, max);
}

/**
 * Zoom-aware backing-store devicePixelRatio for canvas widgets whose CSS box is a
 * fixed size but which are visually scaled by the outer transform. Growing the
 * backing store with the zoom keeps a re-drawn canvas crisp instead of blurring
 * a fixed raster; capped so extreme zoom can't allocate an absurd buffer.
 */
export function zoomAwareDpr(baseDpr: number, scale: number, cap: number = DPR_CAP): number {
    const b = Number.isFinite(baseDpr) && baseDpr > 0 ? baseDpr : 1;
    const s = Number.isFinite(scale) && scale > 1 ? scale : 1;
    return Math.min(cap, Math.max(1, b * s));
}

/**
 * Interactive descendants a pointerdown must NOT hijack for pan — the widget's
 * own controls keep their events (LAW: render-plane chrome never steals a
 * widget's interactions). `data-zoom-nopan` is the explicit opt-out hook.
 */
export const INTERACTIVE_PAN_BLOCK_SELECTOR =
    'button, a[href], select, input, textarea, label, [role="button"], [role="slider"], [role="switch"], [role="tab"], [contenteditable="true"], [data-zoom-nopan]';

/** Minimal DOM-agnostic shape: anything with a `.closest(selector)`. */
export interface ClosestLike {
    closest?(selector: string): unknown;
}

/**
 * Does a pointerdown on `target` land on (or inside) an interactive control that
 * must keep its own events? If so, pan does NOT arm. Pure over a `.closest`
 * shim so it is testable without a DOM.
 */
export function targetBlocksPan(target: ClosestLike | null | undefined): boolean {
    if (!target || typeof target.closest !== 'function') return false;
    return target.closest(INTERACTIVE_PAN_BLOCK_SELECTOR) != null;
}
