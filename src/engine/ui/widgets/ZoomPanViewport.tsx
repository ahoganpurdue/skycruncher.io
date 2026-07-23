/**
 * ZOOM/PAN VIEWPORT — render-plane chrome that wraps EVERY registry widget's
 * `<Render/>` mount (WidgetFrame, WidgetDock.tsx). One wrapper covers all widgets
 * in both surfaces (dock + shelf) since both reuse WidgetFrame.
 *
 * Owner directive (2026-07-21): widgets are too small → PLAIN wheel-over-widget
 * zoom. Behaviour:
 *   • plain wheel over the widget zooms toward the cursor; page scroll pauses
 *     over a widget (preventDefault, owner-ruled).
 *   • two-finger pinch zooms toward the pinch midpoint (touch).
 *   • drag-pan arms only on the viewport BACKGROUND — a pointerdown on an
 *     interactive control (the greenfield replay play/pause + speed/band selects,
 *     any button/select/input/link) never hijacks into a pan, so controls keep
 *     their events.
 *   • reset + zoom-% chrome lives in the WidgetFrame header, shown only when zoomed.
 *
 * EXEMPTION (`disabled` — set from the manifest `ownsPointerZoom` flag): widgets
 * that own their own wheel/drag/pinch (flattening_cascade + lens_profile_3d drive
 * a WebGL camera in cascade/webgl_surface.ts) get a PURE pass-through — no
 * transform, no handlers — so there is no double-zoom.
 *
 * All geometry is in `zoom_math.ts` (node-testable, no DOM). This file is the thin
 * React shell. Ledger: RENDER PLANE — display only, byte-identical at rest.
 */

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
    IDENTITY_ZOOM,
    MIN_SCALE,
    MAX_SCALE,
    SCALE_EPS,
    isZoomed,
    panBy,
    pinchZoom,
    targetBlocksPan,
    wheelZoomFactor,
    zoomTowardPoint,
    type ZoomState,
} from './zoom_math';

// ─── zoom context (descendant canvases read the live scale for crisp backing) ──

interface ZoomContextValue {
    /** Current viewport scale (1 = natural). 1 when there is no zoom viewport above. */
    scale: number;
}
export const ZoomContext = createContext<ZoomContextValue>({ scale: 1 });

/**
 * The live zoom scale of the nearest ZoomPanViewport ancestor (1 when none). A
 * canvas widget with a fixed CSS box multiplies its backing-store dpr by this so
 * the raster stays crisp when the outer transform scales it up.
 */
export function useWidgetZoomScale(): number {
    return useContext(ZoomContext).scale;
}

export interface ZoomPanViewportProps {
    children: React.ReactNode;
    /** ownsPointerZoom — the widget owns wheel/drag/pinch: pure pass-through, no zoom chrome. */
    disabled?: boolean;
    /** Reports {scale, reset} up to the WidgetFrame header (drives the reset + % chrome). */
    onZoomStateChange?: (s: { scale: number; reset: () => void }) => void;
    minScale?: number;
    maxScale?: number;
    'data-testid'?: string;
}

/**
 * Public wrapper. When `disabled` (an exempt widget) it is a transparent
 * pass-through with ZERO added behaviour or DOM handlers. This split keeps the
 * hook-bearing implementation (below) unconditional — rules-of-hooks safe.
 */
export const ZoomPanViewport: React.FC<ZoomPanViewportProps> = (props) => {
    if (props.disabled) return <>{props.children}</>;
    return <ZoomPanViewportActive {...props} />;
};

const ZoomPanViewportActive: React.FC<ZoomPanViewportProps> = ({
    children,
    onZoomStateChange,
    minScale = MIN_SCALE,
    maxScale = MAX_SCALE,
    'data-testid': testId,
}) => {
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const [zoom, setZoom] = useState<ZoomState>(IDENTITY_ZOOM);
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;

    // Active pointers (pan + pinch bookkeeping) + a stable last-pan anchor.
    const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
    const pinchRef = useRef<{ dist: number; mx: number; my: number } | null>(null);
    const panLastRef = useRef<{ x: number; y: number } | null>(null);
    const [panning, setPanning] = useState(false);

    const reset = useCallback(() => setZoom(IDENTITY_ZOOM), []);

    // Wheel — a NATIVE non-passive listener so preventDefault reliably pauses page
    // scroll over the widget (React's synthetic onWheel is passive by default).
    useEffect(() => {
        const el = viewportRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault(); // page scroll pauses over a widget (owner-ruled)
            const rect = el.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
            setZoom((prev) => zoomTowardPoint(prev, wheelZoomFactor(e.deltaY), px, py, minScale, maxScale));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [minScale, maxScale]);

    // Surface {scale, reset} to the header chrome. Only re-fires when the scale
    // actually moves (reset + setter identities are stable → no render loop).
    useEffect(() => {
        onZoomStateChange?.({ scale: zoom.scale, reset });
    }, [zoom.scale, reset, onZoomStateChange]);

    const localMid = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        const rect = viewportRef.current!.getBoundingClientRect();
        return { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
    };

    const onPointerDown = (e: React.PointerEvent) => {
        const el = viewportRef.current;
        if (!el) return;
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointersRef.current.size === 2) {
            // Begin pinch — cancel any in-progress single-pointer pan.
            const [a, b] = Array.from(pointersRef.current.values());
            const mid = localMid(a, b);
            pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: mid.x, my: mid.y };
            panLastRef.current = null;
            setPanning(false);
            e.preventDefault();
            return;
        }

        // Single pointer → pan, but ONLY on the background. A control (button /
        // select / input / link) keeps its own events, and there is nothing to pan
        // at natural size.
        if (targetBlocksPan(e.target as Element)) return;
        if (zoomRef.current.scale <= minScale + SCALE_EPS) return;
        panLastRef.current = { x: e.clientX, y: e.clientY };
        setPanning(true);
        try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        e.preventDefault();
    };

    const onPointerMove = (e: React.PointerEvent) => {
        const el = viewportRef.current;
        if (!el) return;
        const tracked = pointersRef.current.get(e.pointerId);
        if (tracked) { tracked.x = e.clientX; tracked.y = e.clientY; }

        // Pinch (two pointers) — scale about the midpoint + follow midpoint drift.
        if (pinchRef.current && pointersRef.current.size >= 2) {
            const [a, b] = Array.from(pointersRef.current.values());
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            const mid = localMid(a, b);
            const prev = pinchRef.current;
            setZoom((z0) => {
                const z = pinchZoom(z0, prev.dist, dist, mid.x, mid.y, minScale, maxScale);
                return panBy(z, mid.x - prev.mx, mid.y - prev.my);
            });
            pinchRef.current = { dist, mx: mid.x, my: mid.y };
            e.preventDefault();
            return;
        }

        // Pan (single captured pointer).
        if (panLastRef.current) {
            const dx = e.clientX - panLastRef.current.x;
            const dy = e.clientY - panLastRef.current.y;
            panLastRef.current = { x: e.clientX, y: e.clientY };
            setZoom((z) => panBy(z, dx, dy));
            e.preventDefault();
        }
    };

    const endPointer = (e: React.PointerEvent) => {
        pointersRef.current.delete(e.pointerId);
        if (pointersRef.current.size < 2) pinchRef.current = null;
        if (pointersRef.current.size === 0) {
            panLastRef.current = null;
            setPanning(false);
        }
        try { viewportRef.current?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };

    const zoomed = isZoomed(zoom);
    return (
        <ZoomContext.Provider value={{ scale: zoom.scale }}>
            <div
                ref={viewportRef}
                data-testid={testId}
                data-zoom-scale={zoom.scale.toFixed(3)}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endPointer}
                onPointerCancel={endPointer}
                style={{
                    // At rest (not zoomed) overflow stays visible so the widget renders
                    // pixel-identically to before; a zoom clips to the frame (window view).
                    overflow: zoomed ? 'hidden' : 'visible',
                    // S11 (owner sitting 2026-07-21): 'none' trapped one-finger page
                    // scroll over every widget on mobile. 'pan-y pinch-zoom' hands the
                    // browser vertical panning (page scroll survives) while the pinch
                    // gesture still drives zoom. Render plane only, no rest-state change.
                    touchAction: 'pan-y pinch-zoom',
                    cursor: zoomed ? (panning ? 'grabbing' : 'grab') : undefined,
                }}
            >
                <div
                    style={{
                        transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`,
                        transformOrigin: '0 0',
                        willChange: zoomed ? 'transform' : undefined,
                    }}
                >
                    {children}
                </div>
            </div>
        </ZoomContext.Provider>
    );
};

export default ZoomPanViewport;
