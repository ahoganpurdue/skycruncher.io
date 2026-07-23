/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CASCADE DATA — pure selectors: receipt → correction-cascade stage specs.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A cheap, PURE read over the receipt (registry contract). It resolves which of
 * the five cascade stages are PRESENT (carry a real fitted/priored model) versus
 * ABSENT (honest "NOT MEASURED"), and hands back the raw models + frame geometry.
 * It does NOT evaluate the (heavier) N×N displacement grids — that is done lazily
 * by the render component / harness via `buildStageField`, so the selector stays
 * light and the registry's data/display decoupling holds.
 *
 * Honest-or-absent (LAW 3): a stage with no backing model is marked
 * present:false with a reason string; the widget greys its tab and shows
 * NOT MEASURED. No stage is ever fabricated to look "flattened".
 */

import type { WidgetReceipt } from '../registry';
import {
  bcModelFor,
  bcDisplacement,
  sipDisplacement,
  tpsDisplacement,
  evalField,
  zeroField,
  type SipModel,
  type TpsModel,
  type BcModel,
  type DisplacementField,
} from './cascade_math';

export type StageKind = 'identity' | 'bc' | 'sip' | 'tps';

export interface CascadeStageSpec {
  /** Stable id (tab key). */
  id: string;
  /** Human tab label. */
  label: string;
  kind: StageKind;
  /** True ⇒ a real model backs this stage; false ⇒ honest NOT MEASURED. */
  present: boolean;
  /** Why the stage is absent (shown on the greyed tab). Empty when present. */
  absentReason: string;
  /** Backing models (only the one matching `kind` is set when present). */
  bc?: BcModel;
  sip?: SipModel;
  tps?: TpsModel;
  /** One-line provenance for the label row (e.g. "order 3", "100 pts"). */
  provenance: string;
}

export interface CascadeData {
  width: number;
  height: number;
  crpix: [number, number];
  stages: CascadeStageSpec[];
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Read a Brown-Conrady prior/measured block into a BcModel, or null if flat/absent. */
function readBc(block: any, width: number, height: number): BcModel | null {
  if (!block || typeof block !== 'object') return null;
  const k1 = num(block.k1);
  const k2 = num(block.k2);
  if (k1 == null && k2 == null) return null;
  return { k1: k1 ?? 0, k2: k2 ?? 0, width, height };
}

/**
 * PURE selector: receipt → cascade stage specs, or null when there is no frame
 * geometry to build a reference grid on (⇒ dock shows NOT MEASURED).
 */
export function selectCascade(receipt: WidgetReceipt): CascadeData | null {
  if (!receipt) return null;
  const width = num(receipt.metadata?.width) ?? num(receipt.scales?.sensor_width);
  const height = num(receipt.metadata?.height) ?? num(receipt.scales?.sensor_height);
  if (width == null || height == null || width < 2 || height < 2) return null;

  const wcs = receipt.wcs ?? {};
  const crpixX = num(wcs.CRPIX1) ?? (width - 1) / 2;
  const crpixY = num(wcs.CRPIX2) ?? (height - 1) / 2;
  const astro = receipt.solution?.astrometry ?? {};

  // Stage 2 — nominal BC (LENS_DB prior). Recorded only when a trusted lens
  // resolved a prior; for telescopes / lying-EXIF frames this is absent.
  const nominalBcBlock =
    receipt.hardware?.lens_distortion_nominal ??
    receipt.solution?.lens_distortion_nominal ??
    receipt.hardware?.lens_prior ??
    null;
  const nominalBc = readBc(nominalBcBlock, width, height);

  // Stage 3 — measured BC (per-copy LM refit). solution.lens_distortion_measured.
  const measuredBc = readBc(receipt.solution?.lens_distortion_measured, width, height);

  // Stage 4 — SIP polynomial.
  const sipRaw = astro.sip;
  const sipPresent = !!sipRaw && Array.isArray(sipRaw.a) && Array.isArray(sipRaw.b);

  // Stage 5 — TPS spline.
  const tpsRaw = astro.tps;
  const tpsPresent =
    !!tpsRaw &&
    Array.isArray(tpsRaw.control_points) &&
    Array.isArray(tpsRaw.weights_x) &&
    Array.isArray(tpsRaw.weights_y) &&
    num(tpsRaw.scale) != null &&
    (num(tpsRaw.scale) as number) > 0;

  const stages: CascadeStageSpec[] = [
    {
      id: 'original',
      label: 'Original',
      kind: 'identity',
      present: true,
      absentReason: '',
      provenance: 'identity (no correction)',
    },
    {
      id: 'nominal_bc',
      label: 'Nominal BC',
      kind: 'bc',
      present: !!nominalBc,
      absentReason: nominalBc ? '' : 'no trusted lens prior (LENS_DB) resolved',
      bc: nominalBc ?? undefined,
      provenance: nominalBc ? `k1=${nominalBc.k1}, k2=${nominalBc.k2}` : 'NOT MEASURED',
    },
    {
      id: 'measured_bc',
      label: 'Measured BC',
      kind: 'bc',
      present: !!measuredBc,
      absentReason: measuredBc ? '' : 'no per-copy Brown-Conrady refit on this frame',
      bc: measuredBc ?? undefined,
      provenance: measuredBc ? `k1=${measuredBc.k1}, k2=${measuredBc.k2}` : 'NOT MEASURED',
    },
    {
      id: 'sip',
      label: 'SIP',
      kind: 'sip',
      present: sipPresent,
      absentReason: sipPresent ? '' : 'no SIP fit (well-corrected optics)',
      sip: sipPresent ? { a: sipRaw.a, b: sipRaw.b, a_order: sipRaw.a_order, b_order: sipRaw.b_order } : undefined,
      provenance: sipPresent ? `order ${sipRaw.a_order ?? '?'}` : 'NOT MEASURED',
    },
    {
      id: 'tps',
      label: 'TPS',
      kind: 'tps',
      present: tpsPresent,
      absentReason: tpsPresent ? '' : 'no thin-plate-spline fit',
      tps: tpsPresent
        ? {
            scale: tpsRaw.scale,
            crpix: Array.isArray(tpsRaw.crpix) ? [tpsRaw.crpix[0], tpsRaw.crpix[1]] : [crpixX, crpixY],
            control_points: tpsRaw.control_points,
            weights_x: tpsRaw.weights_x,
            weights_y: tpsRaw.weights_y,
            affine: tpsRaw.affine,
          }
        : undefined,
      provenance: tpsPresent
        ? `${Array.isArray(tpsRaw.control_points) ? tpsRaw.control_points.length : 0} pts` +
          (num(tpsRaw.rms_after_arcsec) != null ? ` · rms ${(tpsRaw.rms_after_arcsec as number).toFixed(2)}"` : '')
        : 'NOT MEASURED',
    },
  ];

  return { width, height, crpix: [crpixX, crpixY], stages };
}

/**
 * Evaluate the N×N displacement field for one stage. PRESENT stages evaluate
 * their real model; ABSENT stages return a flat zero field (the caller greys the
 * tab — the flat surface is never presented as a measurement). Single source of
 * the numbers for both the React component and the standalone harness.
 */
export function buildStageField(stage: CascadeStageSpec, n: number, data: CascadeData): DisplacementField {
  const { width, height, crpix } = data;
  if (!stage.present) return zeroField(n, width, height);
  switch (stage.kind) {
    case 'identity':
      return zeroField(n, width, height);
    case 'bc': {
      const model = bcModelFor(stage.bc ?? null);
      return evalField(n, width, height, (x, y) => bcDisplacement(x, y, model));
    }
    case 'sip': {
      const s = stage.sip!;
      return evalField(n, width, height, (x, y) => sipDisplacement(x, y, s.a, s.b, crpix[0], crpix[1]));
    }
    case 'tps': {
      const t = stage.tps!;
      return evalField(n, width, height, (x, y) => tpsDisplacement(x, y, t));
    }
    default:
      return zeroField(n, width, height);
  }
}
