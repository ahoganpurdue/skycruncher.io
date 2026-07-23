// ═══════════════════════════════════════════════════════════════════════════
// BATCH ENGINE — planning core (PURE, deterministic)  ·  task #24 extraction
// ═══════════════════════════════════════════════════════════════════════════
//
// The GENERAL N-files→N-receipts planning primitives, lifted verbatim out of
// tools/overnight/rotation.mjs (they were always domain-free). The overnight
// rig, the corpus sweep, and a future UI batch panel are all MODES of this one
// engine: they share the eligibility/idempotency/rotation/resume decisions and
// differ only in their per-file stages (intake/truth/harvest are overnight's,
// not the engine's).
//
// Everything here is a PURE function over plain data (an in-memory manifest, an
// in-memory checkpoint, injected `hasDump`/`artifactsPresent` predicates). No
// disk I/O, no subprocess, no Date.now(), no Math.random() — so a batch's
// decisions are reproducible run-to-run AND unit-testable on a synthetic frame
// set with ZERO calibrated/corpus dependency.
//
// ZERO-BREAK CONTRACT: tools/overnight/rotation.mjs re-exports every symbol
// here, so run_pipeline.mjs, the dashboard, fits_contact_sheet, and the
// existing unit tests import the SAME functions through their old path,
// behaviorally untouched. New consumers (run_batch.mjs, corpus, UI) import
// directly from here.

import crypto from 'node:crypto';

// ── failure / outcome taxonomy (the ledger's honest-or-absent vocabulary) ─────
// A frame's outcome is exactly one of these. `OK` = fully processed; the rest
// are honest skips/failures that NEVER stop a batch (the fatal is caught, the
// frame is tagged, the batch continues).
//
// The generic planner uses only { OK, NO_DUMP, OOM }. The remaining entries are
// consumed by domain layers (overnight's classifySolve/reconcileFitsTruth use
// SOLVE_FAIL/RENDER_FAIL/NO_TRUTH; run_batch reuses SOLVE_FAIL for a thrown
// solve). Kept as ONE frozen object so its string values are identical across
// every importer — a consumer comparing `taxonomy === FAILURE.OOM` is unaffected
// by which module it imported FAILURE from.
export const FAILURE = Object.freeze({
  OK: 'ok',
  NO_DUMP: 'no-dump',       // no detection dump on disk → cannot solve
  OOM: 'oom',               // megapixels over the ceiling → skip, never decode
  NO_TRUTH: 'no-truth',     // truth oracle unavailable / did not solve (soft)
  SOLVE_FAIL: 'solve-fail', // the solve threw / produced no raw for this frame
  RENDER_FAIL: 'render-fail',
});

// ── generic batch defaults (the ONE knob the planner needs a fallback for) ────
/** Fallback ceiling when a config omits `mp_ceiling`. Domain configs (e.g. the
 *  overnight DEFAULT_CONFIG) set their own value; this keeps the planner total. */
export const BATCH_DEFAULTS = Object.freeze({ mp_ceiling: 100 });

// ── deterministic config hash (idempotency key half) ─────────────────────────
/** Canonical JSON: object keys sorted recursively so the hash is stable. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

/** A short, stable hash of the config knobs that affect artifacts. */
export function configHash(config) {
  const json = JSON.stringify(canonicalize(config));
  return crypto.createHash('sha1').update(json).digest('hex').slice(0, 12);
}

// ── frame identity ───────────────────────────────────────────────────────────
/** Frame id = basename without extension (matches enumerateDumps/contact_sheet). */
export function frameIdOf(imgPath) {
  const base = String(imgPath).split(/[\\/]/).pop() ?? String(imgPath);
  return base.replace(/\.[^.]+$/, '');
}

// ── eligibility (which frames the solve pipeline can actually run) ────────────
/**
 * Classify a manifest image for the solve pipeline. PURE — the caller injects
 * `hasDump` (does a detection dump exist for this frame). Order of precedence:
 * OOM (never even decode) → no-dump → eligible.
 *
 * @returns {{ eligible: boolean, skip_reason: string, taxonomy: string }}
 */
export function classifyEligibility(entry, { mpCeiling, hasDump }) {
  const mp = typeof entry.megapixels === 'number' ? entry.megapixels : 0;
  if (mp > mpCeiling) {
    return { eligible: false, skip_reason: `OOM-gate(${mp}MP > ${mpCeiling})`, taxonomy: FAILURE.OOM };
  }
  if (!hasDump) {
    return { eligible: false, skip_reason: 'no-detection-dump', taxonomy: FAILURE.NO_DUMP };
  }
  return { eligible: true, skip_reason: '', taxonomy: FAILURE.OK };
}

// ── per-frame freshness (idempotency) ─────────────────────────────────────────
/**
 * A frame is:
 *   'current' — artifacts present AND (no checkpoint entry, OR its stored config
 *               hash matches) → SKIP (idempotent).
 *   'stale'   — a checkpoint entry exists but its config hash differs → RE-RUN.
 *   'never'   — no artifacts and no matching checkpoint → RUN.
 */
export function frameStatus(cpEntry, currentHash, artifactsPresent) {
  if (cpEntry && cpEntry.config_hash && cpEntry.config_hash !== currentHash) return 'stale';
  if (artifactsPresent) return 'current';
  if (cpEntry && cpEntry.config_hash === currentHash && cpEntry.status === 'complete') return 'current';
  return 'never';
}

// ── rotation ordering ─────────────────────────────────────────────────────────
/**
 * Priority order for a run slice: never-tested first, then stale, then current
 * (re-verify last). Within a bucket, least-recently-run first (last_run_index
 * ascending; never-run = -1), tie-broken by frame id. Fully deterministic — no
 * wall clock, only the stored integer run index.
 */
export function orderForRotation(frames, statusOf, lastRunOf) {
  const bucket = { never: 0, stale: 1, current: 2 };
  return [...frames].sort((a, b) => {
    const ba = bucket[statusOf(a)] ?? 3;
    const bb = bucket[statusOf(b)] ?? 3;
    if (ba !== bb) return ba - bb;
    const la = lastRunOf(a), lb = lastRunOf(b);
    if (la !== lb) return la - lb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Monotonic run counter — pure function of prior checkpoint state (no clock). */
export function nextRunIndex(checkpoint) {
  return (checkpoint && typeof checkpoint.run_index === 'number' ? checkpoint.run_index : 0) + 1;
}

// ── the central planner (pure) ───────────────────────────────────────────────
/**
 * Decide a run's work from data only. Injectables keep it disk-free:
 *   manifestImages : [{ path, megapixels, image_type, ground_truth, ... }]
 *   checkpoint     : the prior run manifest (or null/{})
 *   config         : the fixed knob set (hashed for staleness)
 *   hasDump(id)          -> boolean  (detection dump exists)
 *   artifactsPresent(id) -> boolean  (solve raw + render exist)
 *   opts.limit     : run-slice cap (take first N of the rotation order)
 *   opts.frames    : restrict to these frame ids (explicit selection)
 *   opts.force     : true | Set<id> — treat as needing a re-run even if current
 *
 * @returns {{ hash, runIndex, eligible, skipped, ordered, toRun }}
 *   eligible : [{ id, image_type, megapixels, status, last_run_index }]
 *   skipped  : [{ id, image_type, megapixels, taxonomy, skip_reason }]
 *   ordered  : eligible ids in rotation order
 *   toRun    : ids selected for this run (the active slice)
 */
export function computePlan({ manifestImages, checkpoint, config, hasDump, artifactsPresent, opts = {} }) {
  const hash = configHash(config);
  const cp = checkpoint && checkpoint.frames ? checkpoint : { frames: {} };
  const forceAll = opts.force === true;
  const forceSet = opts.force instanceof Set ? opts.force : null;
  const frameFilter = Array.isArray(opts.frames) && opts.frames.length ? new Set(opts.frames) : null;
  const mpCeiling = config.mp_ceiling ?? BATCH_DEFAULTS.mp_ceiling;

  const eligible = [];
  const skipped = [];
  const seen = new Set();
  for (const img of manifestImages) {
    const id = frameIdOf(img.path);
    if (seen.has(id)) continue; // dedup collisions (e.g. same basename in two dirs)
    seen.add(id);
    const cls = classifyEligibility(img, { mpCeiling, hasDump: !!hasDump(id) });
    const base = { id, image_type: img.image_type ?? 'UNKNOWN', megapixels: img.megapixels ?? null };
    if (!cls.eligible) {
      skipped.push({ ...base, taxonomy: cls.taxonomy, skip_reason: cls.skip_reason });
      continue;
    }
    const cpEntry = cp.frames[id] ?? null;
    const status = frameStatus(cpEntry, hash, !!artifactsPresent(id));
    eligible.push({
      ...base,
      status,
      last_run_index: cpEntry && typeof cpEntry.last_run_index === 'number' ? cpEntry.last_run_index : -1,
    });
  }

  const statusOf = (id) => eligible.find((e) => e.id === id)?.status ?? 'never';
  const lastRunOf = (id) => eligible.find((e) => e.id === id)?.last_run_index ?? -1;
  const orderedAll = orderForRotation(eligible.map((e) => e.id), statusOf, lastRunOf);
  const ordered = frameFilter ? orderedAll.filter((id) => frameFilter.has(id)) : orderedAll;

  // A frame needs a run if it is not current, OR it is force-selected.
  const needsRun = (id) => {
    if (forceAll) return true;
    if (forceSet && forceSet.has(id)) return true;
    return statusOf(id) !== 'current';
  };
  let toRun = ordered.filter(needsRun);
  if (typeof opts.limit === 'number' && opts.limit >= 0) toRun = toRun.slice(0, opts.limit);

  return { hash, runIndex: nextRunIndex(checkpoint), eligible, skipped, ordered, toRun };
}
