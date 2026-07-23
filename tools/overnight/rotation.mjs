// ═══════════════════════════════════════════════════════════════════════════
// OVERNIGHT PIPELINE — rotation + planning core (PURE, deterministic)
// (design: docs/OVERNIGHT_PIPELINE.md · "Corpus rotation + scheduler")
// ═══════════════════════════════════════════════════════════════════════════
//
// The generic N-files→N-receipts planning primitives (config-hash idempotency,
// eligibility, rotation order, resume cursor) were lifted VERBATIM into the
// shared batch engine (tools/batch/batch_plan.mjs) — they were always domain-
// free, and the corpus sweep + a future UI batch panel are modes of that same
// engine. This module RE-EXPORTS them unchanged, so run_pipeline.mjs, the
// dashboard, fits_contact_sheet, and the existing unit tests keep importing the
// SAME functions from './rotation.mjs' with byte-for-byte identical behavior.
//
// What stays HERE is OVERNIGHT-SPECIFIC: the rig's config defaults, the CR2/FITS
// solve-routing predicates, the truth-oracle auto-switch, the solve/truth
// reconciliation, and the intake + harvest-before-clear gates. Everything below
// is still a PURE function over plain data (no disk I/O, no clock, no random) —
// so the driver's decisions stay reproducible AND unit-testable on a synthetic
// frame set with ZERO calibrated/corpus dependency (spec §Determinism gates).
//
// The driver (run_pipeline.mjs) supplies the I/O; this module supplies the
// decisions: which frames are eligible, which are stale, the rotation order,
// the failure taxonomy, and the truth-stage auto-switch.

// ── shared batch-engine primitives (re-exported UNCHANGED — zero-break) ───────
import {
  FAILURE,
  BATCH_DEFAULTS,
  canonicalize,
  configHash,
  frameIdOf,
  classifyEligibility,
  frameStatus,
  orderForRotation,
  nextRunIndex,
  computePlan,
} from '../batch/batch_plan.mjs';

export {
  FAILURE,
  canonicalize,
  configHash,
  frameIdOf,
  classifyEligibility,
  frameStatus,
  orderForRotation,
  nextRunIndex,
  computePlan,
};

// ── the knobs that, when changed, invalidate a frame's artifacts (→ stale) ────
// OVERNIGHT-SPECIFIC config: candidate/arms/render markers are this rig's
// domain, not the generic engine's. mp_ceiling reuses the batch-engine default
// so the ceiling constant lives in exactly one place.
export const DEFAULT_CONFIG = Object.freeze({
  schema: 'overnight/1',
  candidate: 'uw_anchor_topN',
  arms: { off: 1, on: 3 },      // SOLVER_UW_ANCHOR_CANDIDATES OFF/ON
  budget_ms: 90000,
  mp_ceiling: BATCH_DEFAULTS.mp_ceiling, // Cygnus 374MP / M101 170MP skip; CR2 ~18-22MP pass
  render: { stretch_a: 14, lo_pct: 0.3, hi_pct: 0.9985 }, // contact_sheet determinism markers
});

// ── per-frame stage routing by image type ────────────────────────────────────
/**
 * The CR2 anchor-lever A/B solve (SOLVER_UW_ANCHOR_CANDIDATES OFF/ON, driven via
 * the cr2_binding config) — and its arm-based contact sheet — are SPECIFIC to the
 * CR2_DSLR cohort. A FITS frame is fully ELIGIBLE (ingest + truth + render) but has
 * NO such A/B binding, so its solve stage is n/a: skipped HONESTLY (never a failure,
 * never a fabricated solve). This one pure predicate gates both the solve routing
 * and the render-lane choice (CR2 contact_sheet vs the FITS render lane).
 */
export function isCr2SolveApplicable(imageType) {
  return imageType === 'CR2_DSLR';
}

/**
 * The FITS solve-vs-truth A/B (SOLVER_FITS_VALIDATION_ARM OFF/ON, driven via the
 * fits_binding config → the REAL narrow wizard solve) applies to the narrow FITS
 * cohorts. FITS_ARTIFACT_REJMAP / JPG_DERIVED are NOT real solve targets (skipped
 * honestly). Symmetric with isCr2SolveApplicable: this one pure predicate gates the
 * FITS solve route + the FITS candidate grading.
 */
export function isFitsSolveApplicable(imageType) {
  return imageType === 'FITS_SEESTAR' || imageType === 'FITS_OTHER';
}

// ── truth-stage auto-switch (NO_TRUTH ⇄ astrometry.net) ──────────────────────
/**
 * The one decision that makes truth "auto-switch ON when astrometry.net lands":
 * the driver probes `astrometry_truth.mjs --check-install` (installGreen), then
 * this pure function decides the action. Nothing else changes when the install
 * appears — flip `installGreen` true and the same frames start getting a real
 * `astrometry_net` label instead of NO_TRUTH.
 *
 *   mode 'off'  → always NO_TRUTH (deterministic fast path; honest-absent)
 *   mode 'auto' → cached label wins; else use the oracle iff installed; else NO_TRUTH
 *   mode 'on'   → force the oracle (errors surface honestly if not installed)
 */
export function decideTruthAction(installGreen, mode, cachedVerdict) {
  if (mode === 'off') return 'no-truth';
  if (cachedVerdict) return 'cached';
  if (mode === 'on') return 'use';
  // 'auto'
  return installGreen ? 'use' : 'no-truth';
}

// ── solve-outcome classification (per frame, from raw arm results) ────────────
/**
 * Map a pair of raw arm results (OFF, ON) to a per-frame solve record + taxonomy.
 * A thrown arm ⇒ SOLVE_FAIL; a missing arm ⇒ SOLVE_FAIL; no-lock is a valid
 * OUTCOME, never a failure (honest-or-absent).
 */
export function classifySolve(rawOff, rawOn) {
  if (!rawOff || !rawOn) {
    return { taxonomy: FAILURE.SOLVE_FAIL, reason: `missing ${!rawOff ? 'OFF' : 'ON'} arm`, off: null, on: null };
  }
  if (rawOff.threw || rawOn.threw) {
    return {
      taxonomy: FAILURE.SOLVE_FAIL,
      reason: `arm threw: ${rawOff.threw || rawOn.threw}`,
      off: { locked: !!rawOff.locked }, on: { locked: !!rawOn.locked },
    };
  }
  return {
    taxonomy: FAILURE.OK,
    reason: '',
    off: { locked: !!rawOff.locked, matched: rawOff.matched ?? 0, ms: rawOff.wall_ms ?? null },
    on: { locked: !!rawOn.locked, matched: rawOn.matched ?? 0, ms: rawOn.wall_ms ?? null,
          sigma: typeof rawOn.sigma === 'number' ? rawOn.sigma : null },
  };
}

// ── FITS truth reconciliation (which source's verdict the driver records) ─────
/**
 * The FITS solve-vs-truth rail adjudicates each frame against the TRACKED LABELS
 * (labels.json, GOLD/COARSE) INSIDE the merge (run_fits_sweep). That verdict is
 * written to the merge detail (fits_trials_detail.json) + the ledger — NOT back
 * into the per-arm raw JSON. The driver reads the raw JSON, so absent this the
 * rail's verdict never surfaced: a LABELLED frame stayed `no-truth`, carrying the
 * astrometry.net oracle's stale NO_SOLVE (the oracle can't solve a star-poor narrow
 * field — but a coarse goto label CAN adjudicate the lock). That is the bug this
 * closes.
 *
 * PURE decision: given the stage-2 oracle verdict + the frame's CURRENT taxonomy
 * and the FITS-rail detail for the frame, return the reconciled verdict/tier/taxonomy:
 *   • a RESOLVED rail verdict (locked + a label adjudicated it → TRUE_POSITIVE or
 *     FALSE_POSITIVE, i.e. NOT 'NO_TRUTH') is AUTHORITATIVE for the FITS frame — it
 *     becomes the recorded verdict + tier, and a stale oracle `no-truth` taxonomy is
 *     cleared to OK (the frame HAS truth and was fully processed). A non-NO_TRUTH
 *     taxonomy (solve-fail / render-fail) is preserved untouched.
 *   • NO rail verdict (no label, or no lock ⇒ rail 'NO_TRUTH'/absent) ⇒ HONEST-ABSENT:
 *     keep the oracle verdict + taxonomy exactly (byte-identical to the pre-fix path).
 * NEVER conflates tiers: the tier (GOLD vs COARSE) is carried through verbatim, so a
 * coarse goto pass is recorded DISTINCTLY from a gold oracle pass (LAW 2 / two-tier).
 *
 * @param {string|null} oracleVerdict  the stage-2 astrometry.net verdict (or null)
 * @param {string} currentTaxonomy     the frame's taxonomy so far (FAILURE.*)
 * @param {{ verdict?: string|null, tier?: string|null }|null|undefined} railDetail
 * @returns {{ verdict: string|null, tier: string|null, taxonomy: string }}
 */
export function reconcileFitsTruth(oracleVerdict, currentTaxonomy, railDetail) {
  const railVerdict = railDetail?.verdict ?? null;
  const resolved = !!railVerdict && railVerdict !== 'NO_TRUTH';
  if (!resolved) {
    return { verdict: oracleVerdict ?? null, tier: null, taxonomy: currentTaxonomy };
  }
  const taxonomy = currentTaxonomy === FAILURE.NO_TRUTH ? FAILURE.OK : currentTaxonomy;
  return { verdict: railVerdict, tier: railDetail.tier ?? null, taxonomy };
}

// ── INTAKE auto-invoke gate (P0.1 — unattended ingestion, OPT-IN + SAFE) ───────
/**
 * Decide whether the overnight loop should auto-invoke the intake fetcher
 * (fetch_intake.mjs) at loop START. PURE decision over injected booleans — the
 * driver supplies the disk existence check; this module supplies the policy.
 *
 * OPT-IN by design (a bare `run_pipeline.mjs` NEVER surprise-fetches, even on a
 * box that happens to carry an intake_sources.json): intake runs ONLY when the
 * operator explicitly opts in via `--intake`. The signed-provenance path in
 * fetch_intake.mjs is preserved end-to-end — this only decides WHETHER to call it.
 *
 *   enabled=false                 → { run:false, reason:'not-requested' }   (default; no fetch)
 *   enabled=true, configExists=F  → { run:false, reason:'no-config' }        (honest no-op, loop continues)
 *   enabled=true, configExists=T  → { run:true,  reason:'requested' }        (fetch via the signed path)
 *
 * @param {{ enabled: boolean, configPath: string|null, configExists: boolean }} args
 * @returns {{ run: boolean, reason: string, config: string|null }}
 */
export function decideIntakeAction({ enabled, configPath, configExists }) {
  if (!enabled) return { run: false, reason: 'not-requested', config: null };
  if (!configExists) return { run: false, reason: 'no-config', config: configPath ?? null };
  return { run: true, reason: 'requested', config: configPath ?? null };
}

// ── HARVEST-BEFORE-CLEAR gate (P0.2 — "harvest+verify → safe-to-clear", NEVER delete) ─
/**
 * Owner directive (verbatim intent): "harvest + verify → safe-to-clear green
 * light, NEVER auto-delete." Before the rig could rotate/clear a raw frame, its
 * DURABLE derived artifacts must be persisted first. This is the pure gate a
 * clear/rotation path MUST consult; it returns a green light, it NEVER deletes.
 *
 * PURE over injected presence booleans (the driver supplies the disk checks):
 *   • hasDetectionDump — the frame's detection dump exists (in a `*_dets/` cohort
 *     dir) — the scarce, hard-to-recompute artifact.
 *   • hasLedgerEntry   — a run-report / checkpoint ledger row records this frame.
 * The per-frame DOSSIER is a STUB (harvest-tool v1 not built) → deliberately NOT
 * gated on, so a missing dossier never blocks a legitimately-harvested frame.
 *
 * Honest-or-absent: any missing durable artifact ⇒ ok:false (never a fabricated
 * pass). ok:true is a GREEN LIGHT only — the caller must still choose not to
 * auto-delete (mark `safe_to_clear`, log it; deletion stays a human/tool decision).
 *
 * @param {string} frameId
 * @param {{ hasDetectionDump: boolean, hasLedgerEntry: boolean }} artifacts
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function canClearRaw(frameId, { hasDetectionDump, hasLedgerEntry } = {}) {
  const missing = [];
  if (!hasDetectionDump) missing.push('detection_dump');
  if (!hasLedgerEntry) missing.push('run_report_entry');
  return { ok: missing.length === 0, missing };
}
