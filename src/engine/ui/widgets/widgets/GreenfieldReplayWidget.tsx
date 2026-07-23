/**
 * HEAVY WIDGET (canvas) — GREENFIELD SOLVE REPLAY (quad-matching play-by-play).
 *
 * A 60fps canvas replay over the detection star-field: candidate quads appear GREY
 * and vanish in rapid succession, hit-then-fail confirms flash RED, and the REAL
 * accepted geometry (sane fine-consensus quads + the accepted matched-detection
 * field) turns GREEN and persists.
 *
 * ┌─ HONESTY CONTRACT (permanent on-widget label) ─────────────────────────────┐
 * │ The candidate stream is SYNTHESIZED from measured per-band telemetry — its   │
 * │ counts + tempo are the receipt's real probe/bail rates and probe/verify wall,│
 * │ its POSITIONS are seeded from the receipt digest (representative, not the     │
 * │ actual probed geometry). The GREEN quads + field are REAL: corners come from  │
 * │ the verified det_id→detection mapping, SANE consensus only (junk poses are    │
 * │ never promoted to green). See data/replay_stream.ts.                          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * The widget consumes a `ReplayStream` (real if the solver ever attaches a sampled
 * one at `greenfield_replay_stream`, else synthesized here) — so a future real
 * stream drops in with ZERO widget changes.
 *
 * Ledger: RENDER PLANE. Consumes an already-collected receipt for display only.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { normalizeGreenfieldReceipt, type GreenfieldReceipt } from '../data/greenfield_receipt';
import { synthesizeReplayStream, coerceReplayStream, type ReplayStream, type ReplayEvent } from '../data/replay_stream';
import { useWidgetZoomScale } from '../ZoomPanViewport';
import { zoomAwareDpr } from '../zoom_math';
import { useRafGate } from '../useRafGate';

export interface GreenfieldReplayData {
    gf: GreenfieldReceipt;
    stream: ReplayStream;
    isReal: boolean;
    hasGeometry: boolean;
}

/** PURE selector: greenfield receipt → { normalized, replay stream, provenance }, or null. */
export function selectGreenfieldReplay(receipt: WidgetReceipt): GreenfieldReplayData | null {
    const gf = normalizeGreenfieldReceipt(receipt);
    if (!gf) return null;
    const attached = coerceReplayStream((receipt as any)?.greenfield_replay_stream
        ?? (receipt as any)?.solution?.greenfield_replay_stream);
    const stream = attached ?? synthesizeReplayStream(gf);
    return {
        gf, stream, isReal: !!attached,
        hasGeometry: stream.acceptedFieldPx.length > 0 || stream.events.some(e => e.real),
    };
}

// ─── canvas colours (resolved from CSS tokens; theme-aware, no hardcoded scheme) ──
function cssVar(el: Element | null, name: string, fallback: string): string {
    try {
        const v = el ? getComputedStyle(el).getPropertyValue(name).trim() : '';
        return v || fallback;
    } catch { return fallback; }
}

const CW = 320; // canvas CSS width (dock-friendly)

const GreenfieldReplayRender: React.FC<WidgetRenderProps<GreenfieldReplayData>> = ({ data }) => {
    const { gf, stream, isReal, hasGeometry } = data;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    // Idle the 60fps canvas loop when the widget is off-screen or the tab is
    // hidden (owner walkthrough: per-frame work while not visible starves the
    // main thread). A greenfield replay sitting in a background dockview tab
    // must not keep repainting. `gateRef` rides the widget root below.
    const { ref: gateRef, active: rafActive } = useRafGate<HTMLDivElement>();

    // Live frame-zoom scale (from the ZoomPanViewport ancestor; 1 when none). The
    // canvas CSS box is fixed (CW×CH) but the outer transform scales it visually,
    // so we grow the backing store with the zoom to stay crisp instead of blurring
    // a fixed raster. The rAF loop redraws every frame, so this costs nothing extra.
    const zoomScale = useWidgetZoomScale();

    const [playing, setPlaying] = useState(true);
    const [speed, setSpeed] = useState(1);
    const [band, setBand] = useState<number | 'all'>('all');

    // Live controls read through refs so the rAF loop never restarts on a knob change.
    const playingRef = useRef(playing); playingRef.current = playing;
    const speedRef = useRef(speed); speedRef.current = speed;
    const bandRef = useRef<number | 'all'>(band); bandRef.current = band;

    const frameW = stream.frame.width || 1000, frameH = stream.frame.height || 1000;
    const CH = Math.max(80, Math.round(CW * frameH / Math.max(1, frameW)));
    const sx = CW / frameW, sy = CH / frameH;

    const bands = useMemo(() => Array.from(new Set(stream.events.map(e => e.band))).sort((a, b) => b - a), [stream]);

    // Accept moment = latest real event onset (green persists from here).
    const acceptT = useMemo(() => {
        const reals = stream.events.filter(e => e.real).map(e => e.t_ms);
        return reals.length ? Math.max(...reals) : stream.duration_ms;
    }, [stream]);

    useEffect(() => {
        if (!rafActive) return;                 // idle when off-screen / tab hidden
        const canvas = canvasRef.current;
        if (!canvas) return;
        const baseDpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
        const dpr = zoomAwareDpr(baseDpr, zoomScale); // grows the backing store with the frame zoom (capped 4×) → crisp when scaled
        canvas.width = Math.round(CW * dpr); canvas.height = Math.round(CH * dpr);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.scale(dpr, dpr);

        const col = {
            bg: cssVar(canvas, '--color-space-950', '#05060a'),
            star: cssVar(canvas, '--chart-seq-4', '#38bdf8'),
            grey: cssVar(canvas, '--chart-grid-subtle', '#334155'),
            red: cssVar(canvas, '--color-danger', '#f87171'),
            green: cssVar(canvas, '--color-solve', '#34d399'),
            tick: cssVar(canvas, '--chart-tick-text', '#94a3b8'),
        };

        // Playback maps the whole stream to ~7s at 1× (watchable regardless of the
        // real sub-second solve); speed knob scales that. Event LIFETIMES are in
        // stream-ms so the tempo stays proportional to the real per-band walls.
        const BASE_PLAYBACK_MS = 7000;
        const dur = Math.max(1, stream.duration_ms);
        const streamPerRealMs = dur / BASE_PLAYBACK_MS;
        const life = Math.max(1, dur * 0.06);   // candidate visible window (stream-ms)

        let clock = 0;             // stream-time ms
        let last = performance.now();
        let raf = 0;

        const drawQuad = (e: ReplayEvent, alpha: number, color: string, fill: boolean) => {
            const p = e.quad_px;
            if (!p || p.length < 3) return;
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.moveTo(p[0][0] * sx, p[0][1] * sy);
            for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0] * sx, p[i][1] * sy);
            ctx.closePath();
            ctx.strokeStyle = color; ctx.lineWidth = fill ? 1.4 : 0.9; ctx.stroke();
            if (fill) { ctx.fillStyle = color; ctx.globalAlpha = alpha * 0.14; ctx.fill(); }
            ctx.globalAlpha = 1;
        };

        const frame = () => {
            const now = performance.now();
            const dtReal = Math.min(64, now - last); last = now;
            if (playingRef.current) clock += dtReal * streamPerRealMs * speedRef.current;
            if (clock > dur + life) clock = 0; // loop

            const bf = bandRef.current;

            // background
            ctx.fillStyle = col.bg; ctx.fillRect(0, 0, CW, CH);
            // faint detection star-field
            const dets = gf.detections;
            if (dets && dets.length) {
                ctx.fillStyle = col.star; ctx.globalAlpha = 0.35;
                for (let i = 0; i < dets.length; i++) {
                    const d = dets[i];
                    if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
                    ctx.fillRect(d.x * sx, d.y * sy, 0.7, 0.7);
                }
                ctx.globalAlpha = 1;
            }

            // persistent REAL accepted field (green dots) — visible once accept reached
            if (clock >= acceptT) {
                ctx.fillStyle = col.green; ctx.globalAlpha = 0.85;
                for (const [x, y] of stream.acceptedFieldPx) ctx.fillRect(x * sx - 0.6, y * sy - 0.6, 1.4, 1.4);
                ctx.globalAlpha = 1;
            }

            // events
            for (const e of stream.events) {
                if (bf !== 'all' && e.band !== bf) continue;
                if (e.real) {
                    if (clock >= e.t_ms) drawQuad(e, 0.95, col.green, true); // persist green
                    continue;
                }
                const age = clock - e.t_ms;
                if (age < 0 || age > life) continue;
                const k = age / life; // 0..1
                if (e.verdict === 'failed') {
                    // grey → red flash, then fade out
                    const color = k < 0.5 ? col.grey : col.red;
                    const alpha = k < 0.5 ? 0.5 : (1 - (k - 0.5) / 0.5) * 0.9;
                    drawQuad(e, Math.max(0, alpha), color, false);
                } else {
                    drawQuad(e, (1 - k) * 0.5, col.grey, false);
                }
            }

            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [stream, gf, sx, sy, CH, acceptT, zoomScale, rafActive]);

    return (
        <div ref={gateRef} className="flex flex-col gap-2" data-testid="widget-greenfield-replay">
            {/* controls */}
            <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono">
                <button
                    type="button"
                    onClick={() => setPlaying(p => !p)}
                    className="px-2 py-0.5 rounded border border-line text-data hover:bg-space-800"
                    data-testid="widget-greenfield-replay-playpause"
                >{playing ? '❚❚ pause' : '▶ play'}</button>
                <label className="flex items-center gap-1 text-text-muted">
                    speed
                    <select value={speed} onChange={e => setSpeed(Number(e.target.value))}
                            className="bg-space-800 border border-line rounded px-1 py-0.5 text-data">
                        {[0.25, 0.5, 1, 2, 4, 8].map(s => <option key={s} value={s}>{s}×</option>)}
                    </select>
                </label>
                <label className="flex items-center gap-1 text-text-muted">
                    band
                    <select value={String(band)} onChange={e => setBand(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                            className="bg-space-800 border border-line rounded px-1 py-0.5 text-data">
                        <option value="all">all</option>
                        {bands.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                </label>
            </div>

            <canvas
                ref={canvasRef}
                style={{ width: CW, height: CH }}
                className="border border-line rounded bg-space-950 select-none"
                role="img"
                aria-label="greenfield solve replay: synthesized candidate quads over the detection field, real accepted geometry in green"
                data-testid="widget-greenfield-replay-canvas"
            />

            {/* PERMANENT honesty label (non-negotiable) */}
            <div className="text-[9.5px] font-mono leading-snug text-text-muted">
                <span className="text-warn font-bold">REPRESENTATIVE REPLAY</span> — candidate stream
                synthesized from measured per-band telemetry (counts + tempo real, positions seeded from
                the receipt digest); <span style={{ color: 'var(--color-solve)' }}>green quads/field are the real accepted geometry</span>.
                {isReal && ' · stream: SOLVER-SAMPLED (real).'}
                {!hasGeometry && ' · green geometry unavailable — detection positions not attached to this receipt.'}
            </div>
        </div>
    );
};

export const greenfieldReplayWidget: WidgetManifest<GreenfieldReplayData> = {
    id: 'greenfield_replay',
    title: 'Solve Replay',
    intent: 'A 60fps play-by-play of the greenfield blind solve over the detection star-field: candidate quads flicker grey and vanish, hit-then-fail confirms flash red, and the real accepted geometry (sane fine-consensus quads + the matched-detection field) locks in green. The candidate stream is representative — synthesized from the receipt’s measured per-band probe/bail counts and probe/verify wall, positions seeded from the digest — while the green geometry is real (verified det_id→detection mapping, sane consensus only). Controls: play/pause, 0.25–8× speed, per-band filter.',
    dataSelector: selectGreenfieldReplay,
    weightTier: 'heavy',
    render: GreenfieldReplayRender,
};
