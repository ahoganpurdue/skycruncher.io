/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SEARCH-PRIOR MODEL LOADER (lane ① population plumbing) — EXPERIMENTAL, default OFF
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The reorder ENGINE lives in `search_priors.ts` (a pure permutation). The
 * DERIVATION of a model from banked receipts lives in the incubator
 * (`tools/adaptive/derive_search_priors.mjs`). THIS module is the thin seam that
 * turns a model file on disk into the in-memory `SearchPriorModel` the single
 * orchestrator hands to the solver via `SolveContext.searchPriors`.
 *
 * DOCTRINE:
 *   · NEVER FATAL. Any load / parse / shape failure logs once and returns null.
 *     A null model is the seam's IDENTITY input — the full blind sweep runs
 *     unchanged. A prior model must never be able to block or alter a solve's
 *     acceptance; it only reorders visit order (see search_priors.ts).
 *   · NODE-ONLY read. Reading a filesystem path is a Node/headless concept. In
 *     the browser `process` is undefined so `SOLVER_SEARCH_PRIORS_MODEL_PATH` is
 *     always '' (see pipeline_config.ts) → this loader returns null WITHOUT ever
 *     touching a filesystem. `node:fs` is a lazy, guarded dynamic import so the
 *     Vite browser bundle never pulls it in (same idiom as rawler_decoder.ts).
 *   · SHAPE-VALIDATED. Accepts either the derive-tool ENVELOPE ({ model: {...} })
 *     or a BARE model ({ regions: [...] }); every region must carry finite
 *     ra / dec and a positive weight or it is dropped. All-invalid ⇒ null.
 */

import type { SearchPriorModel, SearchPriorRegion } from './search_priors';

/**
 * Shape-validate an arbitrary parsed JSON value into a `SearchPriorModel`, or
 * null. PURE and browser-safe (no I/O). Unwraps the derive-tool envelope
 * (`raw.model`) when present, else treats `raw` as a bare model. Drops any
 * region without finite ra/dec/positive-weight; returns null when nothing
 * survives (so an empty/garbage model is indistinguishable from "absent" — the
 * seam's identity path).
 */
export function parseSearchPriorModel(raw: unknown, provenance?: string): SearchPriorModel | null {
    if (!raw || typeof raw !== 'object') return null;
    // The derive tool wraps the consumable model under `.model`; a hand-written
    // file may already be a bare model. Prefer the envelope when it looks like one.
    const container = raw as Record<string, unknown>;
    const candidate =
        container.model && typeof container.model === 'object'
            ? (container.model as Record<string, unknown>)
            : container;

    const rawRegions = candidate.regions;
    if (!Array.isArray(rawRegions)) return null;

    const regions: SearchPriorRegion[] = [];
    for (const r of rawRegions) {
        if (!r || typeof r !== 'object') continue;
        const reg = r as Record<string, unknown>;
        const ra = reg.ra;
        const dec = reg.dec;
        const weight = reg.weight;
        // Require ACTUAL numbers (JSON numbers always parse as `number`). Do NOT
        // coerce with Number(): `Number(null)` / `Number('')` / `Number([])` are all
        // 0 (finite) and would inject a phantom ra=0/dec=0 region at the celestial
        // equator. A region is only usable with a finite sky position + positive mass.
        if (typeof ra !== 'number' || !Number.isFinite(ra)) continue;
        if (typeof dec !== 'number' || !Number.isFinite(dec)) continue;
        if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) continue;
        const region: SearchPriorRegion = { ra, dec, weight };
        const radius = reg.radius_deg;
        if (typeof radius === 'number' && Number.isFinite(radius) && radius > 0) region.radius_deg = radius;
        if (typeof reg.label === 'string' && reg.label.length > 0) region.label = reg.label;
        regions.push(region);
    }

    if (regions.length === 0) return null;

    const source =
        typeof candidate.source === 'string' && candidate.source.length > 0
            ? candidate.source
            : provenance;
    return source ? { source, regions } : { regions };
}

/**
 * Resolve the search-prior model for a solve. Returns null (the seam's identity
 * input) whenever the lane is inert:
 *   · the flag is OFF, or the path is empty, or
 *   · we are not in Node (browser — no filesystem), or
 *   · the file is unreadable / not JSON / shape-invalid.
 * Every failure path logs once and yields null; a solve is NEVER blocked by a
 * prior model. The `node:fs` import is lazy + Node-guarded so the browser build
 * never bundles it.
 */
export async function loadSearchPriorModel(
    flagOn: boolean,
    modelPath: string | undefined | null,
): Promise<SearchPriorModel | null> {
    if (!flagOn || !modelPath) return null;

    const isNode =
        typeof process !== 'undefined' &&
        !!(process as { versions?: { node?: string } }).versions?.node &&
        typeof window === 'undefined';
    if (!isNode) {
        console.warn(
            `[SearchPriors] model path "${modelPath}" set but no filesystem available (browser) — proceeding with no prior (full sweep unchanged).`,
        );
        return null;
    }

    try {
        const fs = await import('node:fs');
        const raw = fs.readFileSync(modelPath, 'utf8');
        const model = parseSearchPriorModel(JSON.parse(raw), modelPath);
        if (!model) {
            console.warn(
                `[SearchPriors] model at "${modelPath}" parsed but held no usable prior region — proceeding with no prior (full sweep unchanged).`,
            );
            return null;
        }
        console.log(
            `[SearchPriors] loaded ${model.regions.length} prior region(s) from "${modelPath}" (source: ${model.source ?? 'n/a'}).`,
        );
        return model;
    } catch (e) {
        console.warn(
            `[SearchPriors] failed to load model from "${modelPath}" (proceeding with no prior — solve unaffected):`,
            e instanceof Error ? e.message : e,
        );
        return null;
    }
}
