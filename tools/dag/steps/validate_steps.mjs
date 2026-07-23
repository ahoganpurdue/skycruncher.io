// Validator for the curated full-pipeline step map (tools/dag/steps/steps_map.json).
//
// steps_map.json is a JUDGMENT-DERIVED, curated artifact — it is NOT drift-gated
// (unlike tools/dag/dag_base.json, which is a zero-LLM mechanical extract). This
// validator is its gate instead: it enforces internal consistency and honest
// anchoring back to the generated base, but it never regenerates or diffs the map.
//
// Checks (a violation in any fails the run, exit 1):
//   1. ids are unique across every step.
//   2. parent / branches_to / converges_to all resolve to an existing step id.
//   3. every anchor resolves — to a dag_base node id, OR (xref:step:X) to an
//      existing step id, OR one of the enumerated NON_BASE_ANCHORS (documented
//      references the zero-LLM extractor legitimately does not carry as a node).
//   4. every step is cited OR flagged (never silently uncited AND unflagged).
//   5. tags are drawn from the known set (union of v2 + the five segments).
//   6. kind / observed are drawn from their known sets.
//
// Zero external deps; reads the two JSON files by path relative to this module so
// it is cwd-independent (an agent's cwd resets between calls).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // tools/dag/steps
const STEPS_PATH = path.join(HERE, 'steps_map.json');
const DAG_BASE_PATH = path.join(HERE, '..', 'dag_base.json');

// Known vocabularies — the union of every tag/kind/observed value used across the
// v2 reference map and segments A–E. A value outside these sets is a violation
// (a typo or an un-enumerated new class the owner should ratify first).
export const KNOWN_TAGS = new Set([
  'batch', 'branch-point', 'cr2-raw', 'desktop', 'fits', 'headless',
  'interface', 'jpeg-tiff', 'mcp', 'public-later',
]);
export const KNOWN_KINDS = new Set(['interface', 'pipeline', 'branch-point']);
export const KNOWN_OBSERVED = new Set(['receipt', 'code-derived']);

// Anchors that legitimately do NOT appear in the zero-LLM dag_base, each with the
// reason it is exempt. The base is a mechanical read of tracked .ts/.tsx/.mjs +
// committed receipt stage fragments + LAW-7 boundaries; these entries reference
// real code the extractor does not (or cannot) emit as a node. Any OTHER unmatched
// dag_base-kind anchor is a real violation.
export const NON_BASE_ANCHORS = new Set([
  // Rust source — the extractor only walks .ts/.tsx/.mjs, so .rs is never a module node.
  'src/engine/wasm_decode/src/lib.rs',
  // Ultra-wide sweep substage seam — a real runtime seam, but not present in the
  // committed stage_order fragment, so the base does not carry it as a stage node.
  'stage:solve.uw_sweep',
  // Ultra-wide deep-verify escalation seam — same: real seam, not in the fragment.
  'stage:solve.uw_escalation',
  // PSF Levenberg-Marquardt wasm crossing — not one of the enumerated LAW-7
  // boundaries (the generic boundary:wasm_typed_array is the enumerated one).
  'boundary:wasm_refine_stars_lm',

  // ── 2026-07-22 main adoption: restoration-delta exemptions ──────────────────
  // The interactive DAG program was authored on the rest/* branch family, where
  // these steps/stages/boundaries are real code; main took a different shape.
  // Each is exempt here with main's equivalent named where one exists. RETURN
  // TRIGGER: when a subsystem lands on main the extractor emits its node — remove
  // that anchor from this list so the validator re-binds it (see
  // docs/UNWIRED_DEBT.md, restoration-delta row).
  //
  // restoration-branch stage split; main's equivalent = timestampTrusted forensics inside stages/ingest.
  'src/engine/pipeline/m1_ingestion/time_trust.ts',
  // restoration-branch stage split; main gates site claims inline.
  'src/engine/pipeline/m1_ingestion/location_trust.ts',
  // restoration-branch; main's live background = deg-2 model in signal_processor.
  'src/engine/pipeline/m4_signal_detect/masked_background.ts',
  // restoration-branch file; main's SIP/TPS gate lives in the @252eccb train + export/sip_convention.ts.
  'src/engine/pipeline/m7_astrometry/sip_gate.ts',
  // restoration-only receipt stage, not on main (stage id + its file).
  'stage:build_identity',
  'src/engine/pipeline/stages/build_identity.ts',
  // restoration-only receipt stage, not on main (stage id + its file).
  'stage:reproducibility',
  'src/engine/pipeline/stages/reproducibility.ts',
  // restoration-only stage; main's version authority = the RECEIPT_SCHEMA_VERSION
  // const in stages/schema_versions.ts (a module, not a stage).
  'stage:receipt_schema',
  // main's FITS writer preserves NaN (I1-I5) but the boundary is not enumerated in binary_layouts.ts.
  'boundary:fits_nan_mask',
]);

export function validateSteps({
  stepsPath = STEPS_PATH,
  dagBasePath = DAG_BASE_PATH,
} = {}) {
  const violations = [];
  const push = (msg) => violations.push(msg);

  const map = JSON.parse(readFileSync(stepsPath, 'utf8'));
  const base = JSON.parse(readFileSync(dagBasePath, 'utf8'));
  const baseIds = new Set(base.nodes.map((n) => n.id));
  const steps = Array.isArray(map.steps) ? map.steps : [];

  // 1. unique ids
  const idSet = new Set();
  for (const s of steps) {
    if (idSet.has(s.id)) push(`duplicate id: ${s.id}`);
    idSet.add(s.id);
  }

  for (const s of steps) {
    const id = s.id;

    // 2. parent / branches_to / converges_to resolve
    if (s.parent != null && !idSet.has(s.parent)) push(`${id}: parent does not resolve -> ${s.parent}`);
    for (const b of s.branches_to || []) {
      if (!idSet.has(b)) push(`${id}: branches_to does not resolve -> ${b}`);
    }
    if (s.converges_to != null && !idSet.has(s.converges_to)) {
      push(`${id}: converges_to does not resolve -> ${s.converges_to}`);
    }

    // 3. anchors resolve
    for (const a of s.anchors || []) {
      if (a.startsWith('xref:')) {
        const target = a.slice('xref:'.length); // e.g. xref:step:confirm -> step:confirm
        if (!idSet.has(target)) push(`${id}: xref anchor does not resolve to a step -> ${a}`);
      } else if (NON_BASE_ANCHORS.has(a)) {
        // documented exemption — ok
      } else if (!baseIds.has(a)) {
        push(`${id}: anchor not in dag_base (and not xref/exempt) -> ${a}`);
      }
    }

    // 4. cited OR flagged
    const hasCites = Array.isArray(s.cites) && s.cites.length > 0;
    const hasFlags = Array.isArray(s.flags) && s.flags.length > 0;
    if (!hasCites && !hasFlags) push(`${id}: has neither cites nor a flag`);

    // 5. tags from known set
    for (const t of s.tags || []) {
      if (!KNOWN_TAGS.has(t)) push(`${id}: tag not in known set -> ${t}`);
    }

    // 6. kind / observed from known sets
    if (s.kind != null && !KNOWN_KINDS.has(s.kind)) push(`${id}: kind not in known set -> ${s.kind}`);
    if (s.observed != null && !KNOWN_OBSERVED.has(s.observed)) push(`${id}: observed not in known set -> ${s.observed}`);
  }

  return { ok: violations.length === 0, violations, stepCount: steps.length };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('validate_steps.mjs')) {
  const res = validateSteps();
  if (res.ok) {
    process.stdout.write(`steps_map validation: OK (${res.stepCount} steps, 0 violations)\n`);
    process.exit(0);
  }
  process.stderr.write(`steps_map validation: ${res.violations.length} violation(s)\n`);
  for (const v of res.violations) process.stderr.write(`  - ${v}\n`);
  process.exit(1);
}
