// Pure deterministic aggregation helpers. Efficiency numbers are wall-clock
// noisy → the harness reports MEDIANS, never a single run. No Date.now /
// Math.random anywhere here (this is reproducible logic, not a DATA field).

import type { Cost } from './types.ts';

/**
 * Median of a numeric list. Deterministic (sorts a copy). Empty ⇒ null so a
 * caller can render "NOT MEASURED" rather than a fabricated 0 (honest-or-absent).
 */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Collapse the cost proxies to a single scalar (APPROXIMATE). */
export function costScalar(cost: Partial<Cost> | undefined): number {
  if (!cost) return 0;
  return (
    (cost.centers_tried ?? 0) +
    (cost.sweeps ?? 0) +
    (cost.escalations ?? 0) +
    (cost.catalog_pages ?? 0)
  );
}

/** Normalize a partial cost to a full Cost (missing proxies ⇒ 0). */
export function fullCost(cost: Partial<Cost> | undefined): Cost {
  return {
    centers_tried: cost?.centers_tried ?? 0,
    sweeps: cost?.sweeps ?? 0,
    escalations: cost?.escalations ?? 0,
    catalog_pages: cost?.catalog_pages ?? 0,
  };
}
