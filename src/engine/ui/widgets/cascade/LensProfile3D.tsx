/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LENS PROFILE 3D — PSF FWHM / ellipticity / vignette field surfaces.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reuses the SurfaceRenderer machinery (same WebGL engine as CascadeExplorer) to
 * draw the measured optical field as rotatable 3D surfaces:
 *   - FWHM(maj) px across the frame (from the psf_field 3×3 region map),
 *   - ellipticity across the frame,
 *   - vignette deviation |I(r)−1| from the fitted radial illumination model.
 * A greyed "Defects" tab reserves the future defect-annotation slot.
 *
 * Honest-or-absent (LAW 3): each surface is present only when the receipt block
 * backs it (psf_field measured; vignette_v1 fitted). Absent ⇒ greyed NOT
 * MEASURED tab. The 3×3 region map is bilinearly interpolated for the surface —
 * labelled as a coarse map, and the real median/region numbers are shown.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WidgetManifest, WidgetRenderProps, WidgetReceipt } from '../registry';
import { evalScalarField, type DisplacementField } from './cascade_math';
import { vignetteGainAt } from '../../calibration/chart_math';
import { SurfaceRenderer, rampToCss } from './webgl_surface';
import { readPalette } from './tokens';
import { useRafGate } from '../useRafGate';

const GRID_N = 64;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface LensProfileData {
  width: number;
  height: number;
  method: string;
  nFit: number;
  fwhmRegions: (number | null)[]; // row-major 3×3 (TL..BR)
  ellipRegions: (number | null)[];
  fwhmMedian: number | null;
  ellipMedian: number | null;
  vignetteV1: number | null;
  approximate: string[];
}

/** PURE selector: receipt → lens/PSF profile, or null (NOT MEASURED). */
export function selectLensProfile(receipt: WidgetReceipt): LensProfileData | null {
  const pf = receipt?.psf_field;
  if (!pf || pf.method === 'NOT_MEASURED' || pf.fwhm_median_maj_px == null) return null;
  const width = num(receipt?.metadata?.width) ?? num(receipt?.scales?.sensor_width);
  const height = num(receipt?.metadata?.height) ?? num(receipt?.scales?.sensor_height);
  if (width == null || height == null) return null;
  const regions: any[] = Array.isArray(pf.regions) ? pf.regions : [];
  const fwhmRegions = Array.from({ length: 9 }, (_, i) => num(regions[i]?.fwhmMedianPx));
  const ellipRegions = Array.from({ length: 9 }, (_, i) => num(regions[i]?.ellipticityMedian));
  return {
    width,
    height,
    method: String(pf.method ?? 'NOT_MEASURED'),
    nFit: num(pf.n_fit) ?? 0,
    fwhmRegions,
    ellipRegions,
    fwhmMedian: num(pf.fwhm_median_maj_px),
    ellipMedian: num(pf.ellipticity_median),
    vignetteV1: num(receipt?.hardware?.vignette_v1),
    approximate: Array.isArray(pf.approximate) ? pf.approximate : [],
  };
}

/** Clamped bilinear sample over a row-major 3×3 value grid at (fx,fy)∈[0,1]. */
function sample3x3(vals: number[], fx: number, fy: number): number {
  // region centers sit at 1/6, 3/6, 5/6 → map [0,1] to a [0,2] cell coordinate.
  const cx = Math.max(0, Math.min(2, fx * 3 - 0.5));
  const cy = Math.max(0, Math.min(2, fy * 3 - 0.5));
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(2, x0 + 1), y1 = Math.min(2, y0 + 1);
  const tx = cx - x0, ty = cy - y0;
  const at = (c: number, r: number) => vals[r * 3 + c];
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bot = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bot * ty;
}

/** Fill nulls with the median of present values (so the surface has no holes). */
function fillNulls(vals: (number | null)[]): number[] | null {
  const present = vals.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  const med = [...present].sort((a, b) => a - b)[Math.floor(present.length / 2)];
  return vals.map((v) => (v != null ? v : med));
}

interface SurfSpec {
  id: string;
  label: string;
  unit: string;
  present: boolean;
  absentReason: string;
  field: DisplacementField | null;
  median: number | null;
  note: string;
}

const LensProfile3DRender: React.FC<WidgetRenderProps<LensProfileData>> = ({ data }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<SurfaceRenderer | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [glError, setGlError] = useState<string | null>(null);
  // Frame-level idle gate ONLY (WebGL internals exempt): pause the renderer loop
  // while this heavy surface is off-screen / in a hidden dockview tab.
  const { ref: gateRef, active: rafActive } = useRafGate<HTMLDivElement>();

  const surfaces: SurfSpec[] = useMemo(() => {
    const { width, height } = data;
    const fwhmFilled = fillNulls(data.fwhmRegions);
    const ellipFilled = fillNulls(data.ellipRegions);
    const fwhmField = fwhmFilled
      ? evalScalarField(GRID_N, width, height, (x, y) => sample3x3(fwhmFilled, x / (width - 1), y / (height - 1)))
      : null;
    const ellipField = ellipFilled
      ? evalScalarField(GRID_N, width, height, (x, y) => sample3x3(ellipFilled, x / (width - 1), y / (height - 1)))
      : null;
    const cx = (width - 1) / 2, cy = (height - 1) / 2, hd = Math.hypot(cx, cy);
    const vigField =
      data.vignetteV1 != null
        ? evalScalarField(GRID_N, width, height, (x, y) => {
            const r = Math.hypot(x - cx, y - cy) / hd;
            return Math.abs(vignetteGainAt(r, data.vignetteV1 as number) - 1);
          })
        : null;
    return [
      {
        id: 'fwhm', label: 'FWHM', unit: 'px', present: !!fwhmField, field: fwhmField, median: data.fwhmMedian,
        absentReason: 'no PSF characterization on this frame', note: 'coarse 3×3 region map, bilinear',
      },
      {
        id: 'ellipticity', label: 'Ellipticity', unit: '', present: !!ellipField, field: ellipField, median: data.ellipMedian,
        absentReason: 'no PSF characterization on this frame', note: 'coarse 3×3 region map, bilinear',
      },
      {
        id: 'vignette', label: 'Vignette', unit: '|I(r)−1|', present: !!vigField, field: vigField, median: data.vignetteV1,
        absentReason: 'no fitted vignette (v1) on this frame', note: 'radial model I(r)=1+v₁r²',
      },
      {
        id: 'defects', label: 'Defects', unit: '', present: false, field: null, median: null,
        absentReason: 'future — hot-pixel / defect mapping not yet implemented', note: '',
      },
    ];
  }, [data]);

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
    renderer.attachControls();
    renderer.start();
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Idle gate (frame level): stop the continuous WebGL rAF loop while off-screen,
  // restart when visible. Public start()/stop() only — no GL internals touched.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (rafActive) renderer.start();
    else renderer.stop();
  }, [rafActive]);

  // Swap the active surface (per-surface zRef — units differ, so no cross morph).
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setPalette(readPalette());
    const s = surfaces[activeIdx];
    if (s?.present && s.field) {
      renderer.setFields(s.field, s.field, s.field.max > 0 ? s.field.max : 1);
      renderer.setMorph(0);
    } else {
      // absent: flat zero surface behind the NOT MEASURED overlay.
      const flat: DisplacementField = { n: GRID_N, width: data.width, height: data.height, dz: new Float32Array(GRID_N * GRID_N), max: 0, rms: 0 };
      renderer.setFields(flat, flat, 1);
      renderer.setMorph(0);
    }
  }, [activeIdx, surfaces, data]);

  const active = surfaces[activeIdx];
  const rampCss = useMemo(() => rampToCss(readPalette().ramp), []);

  return (
    <div ref={gateRef} className="flex flex-col gap-2" data-testid="widget-lens-profile-3d">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
          Lens Profile — optical field surface
        </div>
        <div className="font-mono text-[10px] text-text-muted">
          {data.method} · n={data.nFit}
        </div>
      </div>

      <div className="relative w-full rounded border border-line overflow-hidden bg-space-900" style={{ height: 320 }}>
        {glError ? (
          <div className="absolute inset-0 grid place-items-center text-center p-4">
            <div className="font-mono text-[11px] text-warn">3D surface unavailable — {glError}</div>
          </div>
        ) : (
          <canvas ref={canvasRef} className="w-full h-full block cursor-grab active:cursor-grabbing" data-testid="lens-canvas" />
        )}
        {active && !active.present && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="font-mono text-center bg-space-900/70 rounded px-3 py-2 border border-line">
              <div className="text-warn text-sm font-bold tracking-wider">NOT MEASURED</div>
              <div className="text-text-muted text-[10px] mt-1">{active.absentReason}</div>
            </div>
          </div>
        )}
        <div className="absolute right-2 top-2 flex flex-col items-end gap-1 pointer-events-none">
          <div className="w-3 rounded" style={{ height: 90, background: `linear-gradient(to top, ${rampCss.join(',')})` }} />
          <div className="font-mono text-[9px] text-text-muted">{active?.unit || ''}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-text-muted min-h-[16px]">
        {active && active.present && active.field ? (
          <>
            <span>SURFACE <span className="text-data">{active.label}</span></span>
            <span>MEDIAN <span className="text-data">{active.median != null ? active.median.toFixed(3) : '—'} {active.unit}</span></span>
            <span>PEAK <span className="text-data">{active.field.max.toFixed(3)} {active.unit}</span></span>
            <span className="text-text-muted">{active.note}</span>
          </>
        ) : active ? (
          <span className="text-warn">{active.label} — NOT MEASURED ({active.absentReason})</span>
        ) : null}
      </div>

      <div className="flex gap-1 flex-wrap" role="tablist" aria-label="lens field surfaces">
        {surfaces.map((s, i) => {
          const isActive = i === activeIdx;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveIdx(i)}
              title={s.present ? `${s.label}: peak ${s.field?.max.toFixed(3)}` : `${s.label}: ${s.absentReason}`}
              className={[
                'font-mono text-[10px] px-2 py-1 rounded border transition-colors',
                isActive ? 'border-accent-400 text-data' : 'border-line',
                s.present ? 'text-text-muted hover:border-line-strong' : 'text-text-faint opacity-60',
              ].join(' ')}
              style={isActive ? { background: 'var(--color-accent-glow)' } : undefined}
              data-testid={`lens-tab-${s.id}`}
              data-present={s.present ? '1' : '0'}
            >
              {s.label}
              {!s.present && <span className="ml-1 text-[8px] align-top text-warn">∅</span>}
            </button>
          );
        })}
      </div>

      {active?.present && data.approximate.map((a, i) => (
        <div key={i} className="text-[10px] font-mono text-warn">APPROXIMATE — {a}</div>
      ))}
      <div className="font-mono text-[9px] text-text-muted">drag to rotate · scroll to zoom · ∅ = NOT MEASURED</div>
    </div>
  );
};

export const lensProfile3dWidget: WidgetManifest<LensProfileData> = {
  id: 'lens_profile_3d',
  title: 'Lens Profile 3D',
  intent: 'The rig’s measured optical character as 3D surfaces — PSF FWHM, ellipticity, and vignette across the field — so the user sees their actual copy of the lens, not a book profile. Dust/scratch/defect annotation is a greyed future slot pending per-rig persistence (Optical Workbench).',
  dataSelector: selectLensProfile,
  weightTier: 'heavy',
  render: LensProfile3DRender,
  // Owns its own wheel/drag/pinch (WebGL camera in cascade/webgl_surface.ts) —
  // opt out of the frame ZoomPanViewport to avoid double-zoom.
  ownsPointerZoom: true,
};

export default LensProfile3DRender;
