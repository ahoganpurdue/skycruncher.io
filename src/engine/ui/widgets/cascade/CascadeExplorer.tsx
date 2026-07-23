/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CASCADE EXPLORER — navigable 3D displacement-surface view of the correction
 * cascade (Original → nominal BC → measured BC → SIP → TPS).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PARALLEL-NEW render-layer widget (UI ledger). It reads a receipt's fitted
 * COORDINATE functions and draws, per stage, the displacement each correction
 * applies on a reference grid — as a rotatable, zoomable, ramp-coloured WebGL
 * surface. Stepping stages animates a morph between the two surfaces (the money
 * shot). Absent stages render a greyed NOT MEASURED tab — never a fake surface.
 *
 * Honest-or-absent (LAW 3): per-stage max/rms labels are the REAL numbers from
 * the evaluated field; a stage with no backing model is shown as NOT MEASURED
 * with the reason. Nothing here measures or touches pixels.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { selectCascade, buildStageField, type CascadeData, type CascadeStageSpec } from './cascade_data';
import type { DisplacementField } from './cascade_math';
import { SurfaceRenderer, rampToCss } from './webgl_surface';
import { readPalette } from './tokens';
import { useRafGate } from '../useRafGate';

const GRID_N = 72;
const MORPH_MS = 720;

interface StageEval {
  spec: CascadeStageSpec;
  field: DisplacementField;
}

const CascadeExplorerRender: React.FC<WidgetRenderProps<CascadeData>> = ({ data }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<SurfaceRenderer | null>(null);
  const prevIdxRef = useRef(0);
  const animRef = useRef(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const [glError, setGlError] = useState<string | null>(null);
  // Frame-level idle gate ONLY (WebGL internals are exempt): pause the renderer's
  // rAF loop when this heavy surface is off-screen / in a hidden dockview tab.
  const { ref: gateRef, active: rafActive } = useRafGate<HTMLDivElement>();

  // Evaluate every stage's field once (real numbers for labels + shared zRef).
  const evals: StageEval[] = useMemo(
    () => data.stages.map((spec) => ({ spec, field: buildStageField(spec, GRID_N, data) })),
    [data],
  );
  const zRef = useMemo(() => {
    const m = Math.max(...evals.filter((e) => e.spec.present).map((e) => e.field.max), 0);
    return m > 0 ? m : 1;
  }, [evals]);

  // Default to the deepest present stage (TPS if present) so it opens on data.
  useEffect(() => {
    const lastPresent = [...evals].map((e, i) => ({ e, i })).filter((x) => x.e.spec.present).pop();
    if (lastPresent) {
      setActiveIdx(lastPresent.i);
      prevIdxRef.current = lastPresent.i;
    }
  }, [evals]);

  // Init WebGL renderer.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: SurfaceRenderer;
    try {
      renderer = new SurfaceRenderer(canvas);
    } catch (e) {
      setGlError(e instanceof Error ? e.message : 'WebGL2 unavailable');
      return;
    }
    rendererRef.current = renderer;
    renderer.setGeometry(GRID_N);
    renderer.setPalette(readPalette());
    const f = evals[activeIdx]?.field;
    if (f) renderer.setFields(f, f, zRef);
    renderer.attachControls();
    renderer.start();
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Idle gate (frame level): stop the continuous WebGL rAF loop while the surface
  // is not visible, restart it when it returns. Touches only the renderer's public
  // start()/stop() — never its GL internals.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (rafActive) renderer.start();
    else renderer.stop();
  }, [rafActive]);

  // Animate morph on stage change.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setPalette(readPalette()); // theme-aware re-read
    const from = evals[prevIdxRef.current]?.field;
    const to = evals[activeIdx]?.field;
    if (!from || !to) return;
    if (prevIdxRef.current === activeIdx) {
      renderer.setFields(to, to, zRef);
      renderer.setMorph(0);
      return;
    }
    renderer.setFields(from, to, zRef);
    const t0 = Date.now();
    if (animRef.current) cancelAnimationFrame(animRef.current);
    const tick = () => {
      const p = Math.min(1, (Date.now() - t0) / MORPH_MS);
      const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOut
      renderer.setMorph(eased);
      if (p < 1) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        renderer.setFields(to, to, zRef);
        renderer.setMorph(0);
        prevIdxRef.current = activeIdx;
      }
    };
    animRef.current = requestAnimationFrame(tick);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [activeIdx, evals, zRef]);

  const active = evals[activeIdx];
  const rampCss = useMemo(() => rampToCss(readPalette().ramp), []);

  return (
    <div ref={gateRef} className="flex flex-col gap-2" data-testid="widget-cascade-explorer">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
          Flattening Cascade — displacement surface
        </div>
        <div className="font-mono text-[10px] text-text-muted">
          grid {GRID_N}×{GRID_N} · {data.width}×{data.height}px
        </div>
      </div>

      <div className="relative w-full rounded border border-line overflow-hidden bg-space-900" style={{ height: 340 }}>
        {glError ? (
          <div className="absolute inset-0 grid place-items-center text-center p-4">
            <div className="font-mono text-[11px] text-warn">
              3D surface unavailable — {glError}
              <div className="text-text-muted mt-1">per-stage max/rms below are still the real numbers.</div>
            </div>
          </div>
        ) : (
          <canvas ref={canvasRef} className="w-full h-full block cursor-grab active:cursor-grabbing" data-testid="cascade-canvas" />
        )}
        {active && !active.spec.present && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="font-mono text-center bg-space-900/70 rounded px-3 py-2 border border-line">
              <div className="text-warn text-sm font-bold tracking-wider">NOT MEASURED</div>
              <div className="text-text-muted text-[10px] mt-1">{active.spec.absentReason}</div>
            </div>
          </div>
        )}
        {/* height ramp legend */}
        <div className="absolute right-2 top-2 flex flex-col items-end gap-1 pointer-events-none">
          <div
            className="w-3 rounded"
            style={{ height: 96, background: `linear-gradient(to top, ${rampCss.join(',')})` }}
          />
          <div className="font-mono text-[9px] text-text-muted">px</div>
        </div>
      </div>

      {/* active-stage readout (real numbers only) */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-text-muted min-h-[16px]">
        {active && active.spec.present ? (
          <>
            <span>STAGE <span className="text-data">{active.spec.label}</span></span>
            <span>MAX Δ <span className="text-data">{active.field.max.toFixed(3)} px</span></span>
            <span>RMS Δ <span className="text-data">{active.field.rms.toFixed(3)} px</span></span>
            <span className="text-text-muted">{active.spec.provenance}</span>
          </>
        ) : active ? (
          <span className="text-warn">{active.spec.label} — NOT MEASURED ({active.spec.absentReason})</span>
        ) : null}
      </div>

      {/* stage tabs */}
      <div className="flex gap-1 flex-wrap" role="tablist" aria-label="cascade stages">
        {evals.map((e, i) => {
          const isActive = i === activeIdx;
          const present = e.spec.present;
          return (
            <button
              key={e.spec.id}
              role="tab"
              aria-selected={isActive}
              disabled={false}
              onClick={() => setActiveIdx(i)}
              title={present ? `${e.spec.label}: max ${e.field.max.toFixed(3)} px` : `${e.spec.label}: ${e.spec.absentReason}`}
              className={[
                'font-mono text-[10px] px-2 py-1 rounded border transition-colors',
                isActive ? 'border-accent-400 text-data' : 'border-line',
                present ? 'text-text-muted hover:border-line-strong' : 'text-text-faint opacity-60',
              ].join(' ')}
              style={isActive ? { background: 'var(--color-accent-glow)' } : undefined}
              data-testid={`cascade-tab-${e.spec.id}`}
              data-present={present ? '1' : '0'}
            >
              <span className="tabular-nums mr-1 text-text-faint">{i}</span>
              {e.spec.label}
              {!present && <span className="ml-1 text-[8px] align-top text-warn">∅</span>}
            </button>
          );
        })}
      </div>
      <div className="font-mono text-[9px] text-text-muted">
        drag to rotate · scroll to zoom · ∅ = NOT MEASURED · height &amp; colour = |displacement| (shared scale)
      </div>
    </div>
  );
};

export const cascadeExplorerWidget: WidgetManifest<CascadeData> = {
  id: 'flattening_cascade',
  title: 'Flattening Cascade',
  intent: 'Show exactly how the image is being flattened: the cumulative displacement surface of each correction stage (nominal BC → measured BC → SIP → TPS) in navigable 3D, so the user sees what each stage absorbs and what remains. Stages without data render honest NOT MEASURED tabs.',
  dataSelector: selectCascade,
  weightTier: 'heavy',
  render: CascadeExplorerRender,
  // Owns its own wheel/drag/pinch (WebGL camera in cascade/webgl_surface.ts) —
  // opt out of the frame ZoomPanViewport to avoid double-zoom.
  ownsPointerZoom: true,
};

export default CascadeExplorerRender;
