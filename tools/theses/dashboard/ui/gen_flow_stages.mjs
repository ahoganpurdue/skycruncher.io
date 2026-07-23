#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   GENERATOR — flow_stages.{json,js}   (#flow tab: PROCESSING-STAGE chain)

   The Processing-Flow tab's PRIMARY content: the shared post-C1 pipeline STAGE
   CHAIN — the `src/engine/pipeline/stages/*` sequence consumed by BOTH the
   wizard (`orchestrator_session.ts`) and the headless driver
   (`tools/api/headless_driver.ts`, runWizardPipeline: step1→step6). Nodes are
   stages; edges are the data-product dependencies between them.

   TRUTH SOURCE + HONESTY (LAW 3):
     · Every node and edge carries a file:line CITATION into the code it
       reflects. The citations point at the RESTORATION/FOUNDATION branch
       (`SOURCE_REF` below, @67761cb) — the imminent-future main, AHEAD of the
       branch this dashboard is committed on. The tab banners that branch+sha so
       the view is honest that it describes PRE-MERGE truth.
     · Citations are TRANSCRIBED here (with SOURCE_REF provenance), NOT re-read
       from the other branch at gen time — this generator runs in a bare clone
       of THIS branch and must not depend on a sibling worktree existing. That
       mirrors gen_flow_edge_semantics.mjs, which transcribes its measured
       numbers rather than re-reading a gitignored report.
     · A stage whose LIVE-PATH status could not be confirmed is marked
       `verified:false` and rendered with a NOT VERIFIED tag — never asserted.
     · `class` is honest about run-conditionality: `always` runs every solve;
       `conditional` is guarded / default-off; `render` is RENDER-plane,
       display-only (byte-identical off — LAW 1); `product` is a receipt block
       folded by step6, not a stage that transforms pixels.

   Run:  node tools/theses/dashboard/ui/gen_flow_stages.mjs
   Emits (both committed):
     tools/theses/dashboard/ui/flow_stages.json   (canonical data)
     tools/theses/dashboard/ui/flow_stages.js      (file:// loader shim global)
   ═══════════════════════════════════════════════════════════════════════════ */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── provenance: the branch these citations reflect ──────────────────────── */
const SOURCE_REF = {
  branch: 'restoration/foundation',
  sha: '67761cb',
  role: 'imminent-future main — AHEAD of the branch this dashboard is committed on; this view describes PRE-MERGE truth.',
  receipt_schema_version: '2.26.0', // stages/schema_versions.ts:407 (RECEIPT_SCHEMA_VERSION)
  verified_by: 'file:line-cited read of orchestrator_session.ts withStage/timeSubstage call order + headless_driver.ts runWizardPipeline step order, 2026-07-16.',
  note:
    'Wizard (orchestrator_session) and headless driver (runWizardPipeline) drive the SAME step1→step6 spine; ' +
    'the headless run reproduces the browser blind-solve SACRED numbers, so this chain is one shared truth.',
};

/* ── wizard step lanes (the 6 top-level withStage steps) ─────────────────── */
const STEPS = [
  { id: 'load',      n: 1, label: 'STEP 1 · LOAD',      cite: 'orchestrator_session.ts:622' },
  { id: 'extract',   n: 2, label: 'STEP 2 · EXTRACT',   cite: 'orchestrator_session.ts:837' },
  { id: 'metrology', n: 3, label: 'STEP 3 · METROLOGY', cite: 'orchestrator_session.ts:1212' },
  { id: 'solve',     n: 4, label: 'STEP 4 · SOLVE',     cite: 'orchestrator_session.ts:1272' },
  { id: 'calibrate', n: 5, label: 'STEP 5 · CALIBRATE', cite: 'orchestrator_session.ts:1660' },
  { id: 'integrate', n: 6, label: 'STEP 6 · INTEGRATE', cite: 'orchestrator_session.ts:2247' },
];

/* ── node (stage) classes → visual role ──────────────────────────────────── */
const NODE_CLASSES = [
  { id: 'always',      label: 'stage · always runs',
    meaning: 'Runs on every solve. The load→decode→detect→metrology→solve→receipt spine.' },
  { id: 'conditional', label: 'stage · conditional / guarded',
    meaning: 'Guarded or default-off (missing prerequisite, user opt-in, or a feature flag). Honest-absent when it does not run.' },
  { id: 'render',      label: 'RENDER plane · display-only',
    meaning: 'Consumes the coordinate/pixel ledgers to build a preview; feeds neither back. Byte-identical when off (LAW 1).' },
  { id: 'product',     label: 'receipt block (folded by step 6)',
    meaning: 'Not a pixel transform — a diagnostics block assembled into the receipt at integrate time.' },
];

/* ── edge classes → line style ───────────────────────────────────────────── */
const EDGE_CLASSES = [
  { id: 'flow',        label: 'primary data flow', dash: 'solid',
    meaning: 'The producing stage hands its product to the consumer; the consumer cannot run without it.' },
  { id: 'conditional', label: 'conditional consume', dash: 'dashed',
    meaning: 'The consumer runs only when guarded/opted-in; the edge exists but does not always fire.' },
  { id: 'render',      label: 'render-plane feed', dash: 'dotted',
    meaning: 'Feeds a display-only RENDER-plane stage; never re-enters the science ledgers.' },
  { id: 'fold',        label: 'folded into receipt', dash: 'thin',
    meaning: 'A finished block written into the step-6 receipt (buildReceipt), not consumed by a later stage.' },
];

/* ── nodes: the stage graph (hand-placed layout; explicit coords) ────────── */
/*  cite = file:line of the entry fn OR its call site on the SOURCE_REF branch. */
const NODES = [
  // ── spine ──
  { id: 'load', step: 'load', class: 'always', x: 110, y: 40, w: 214, h: 54,
    label: 'Load & metadata', file: 'step1_Load · metadata_reaper',
    cite: 'orchestrator_session.ts:622', verified: true,
    role: 'Decode container header, reap EXIF/FITS metadata, hash frame identity. step1 releases the raw buffer after ingest.' },
  { id: 'decode', step: 'extract', class: 'always', x: 110, y: 138, w: 214, h: 54,
    label: 'RAW/FITS decode + demosaic', file: 'stages/ingest.ts · decodeScienceFrame',
    cite: 'orchestrator_session.ts:872', verified: true,
    role: 'Decode raw pixels (rawler default / libraw cold path) and demosaic to the native science frame. substage extract.decode.' },
  { id: 'detect', step: 'extract', class: 'always', x: 110, y: 236, w: 214, h: 54,
    label: 'Star detection + culling', file: 'stages/detect.ts · detectSignal',
    cite: 'orchestrator_session.ts:1129', verified: true,
    role: 'Blur + extract + cull to a measured detection list on native pixels. substage extract.detect.' },
  { id: 'metrology', step: 'metrology', class: 'always', x: 110, y: 334, w: 214, h: 54,
    label: 'Scale lock + guest list', file: 'stages/metrology.ts · resolveScaleLock / resolveGuestList',
    cite: 'orchestrator_session.ts:1223,1256', verified: true,
    role: 'Resolve the pixel-scale lock and assemble the catalog guest list (candidate stars) the solver will match against.' },
  { id: 'solve', step: 'solve', class: 'always', x: 110, y: 432, w: 214, h: 60,
    label: 'Blind plate solve', file: 'stages/solve.ts · runSolve',
    cite: 'orchestrator_session.ts:1462', verified: true,
    role: 'Blind/narrow plate solve → WCS + matched_stars + confidence. CPU f64 verify + WCS fit own every verdict.' },
  { id: 'refine', step: 'calibrate', class: 'conditional', x: 110, y: 556, w: 214, h: 54,
    label: 'Astrometric refinement (SIP/TPS)', file: 'stages/calibrate.ts · applyAstrometricRefinement',
    cite: 'orchestrator_session.ts:1703', verified: true,
    role: 'Fit higher-order distortion (SIP / TPS tabular) over the matched set. step5 · COORDINATE ledger.' },
  { id: 'bc_rematch', step: 'calibrate', class: 'conditional', x: 110, y: 654, w: 214, h: 54,
    label: 'BC rematch (edge-star densify)', file: 'm2_hardware/lens_distortion_rematch_pass · runBcRematchPass',
    cite: 'orchestrator_session.ts:1771', verified: true,
    role: 'Two-pass measured-BC rematch densifies edge stars. Never-worse guard: KEPT_ORIGINAL keeps the acquisition solve byte-identical on the pinned frames.' },
  { id: 'receipt', step: 'integrate', class: 'always', x: 110, y: 812, w: 214, h: 62,
    label: `Receipt assembly (${SOURCE_REF.receipt_schema_version})`, file: 'stages/package.ts · buildReceipt',
    cite: 'orchestrator_session.ts:2328', verified: true,
    role: 'Assemble the fitted-WCS receipt at schema 2.26.0. Folds solve_envelope, stage_records, and the reproducibility envelope. step6.' },
  { id: 'deposit', step: 'integrate', class: 'conditional', x: 110, y: 936, w: 214, h: 54,
    label: 'Workbench deposit', file: 'stages/workbench_deposit.ts · depositFromReceipt',
    cite: 'orchestrator_session.ts:2394', verified: true,
    role: 'Deposit the per-rig optical-workbench record keyed by model (never-fatal). Side-effect off the finished receipt.' },

  // ── step-4 branch ──
  { id: 'gpu_quads', step: 'solve', class: 'conditional', x: 396, y: 428, w: 244, h: 52,
    label: 'GPU quad scoring', file: 'solver_entry.ts:1754 · scoreQuadsPlanarLocal',
    cite: 'gpu_quads_flag.ts:30 (isSolverGpuQuadsEnabled — DEFAULT-ON)', verified: true,
    role: 'DEFAULT-ON since 2026-07-16, but a CANDIDATE GENERATOR only: the CPU f64 verify owns every verdict, so a divergent GPU proposal is verdict-harmless (byte-identical). Node/headless has no WebGPU → falls back to the canonical wasm arm.' },
  { id: 'solve_envelope', step: 'solve', class: 'product', x: 684, y: 428, w: 250, h: 52,
    label: 'Solve envelope', file: 'solver_entry.ts:681 · diagnostics.search_envelope',
    cite: 'orchestrator_session.ts:2368 (surfaced as solveEnvelope)', verified: true,
    role: 'Search-envelope diagnostics (centers evaluated, budget exhaustion) captured during the solve, folded into the receipt at step6.' },

  // ── step-5 consumer fan (match-consuming) ──
  { id: 'hw_profile', step: 'calibrate', class: 'conditional', x: 396, y: 556, w: 244, h: 52,
    label: 'Hardware profile', file: 'stages/calibrate.ts · generateHardwareProfile',
    cite: 'orchestrator_session.ts:1818', verified: true,
    role: 'Derive the per-rig hardware/optics profile from the solution + metadata + signal.' },
  { id: 'spcc', step: 'calibrate', class: 'conditional', x: 684, y: 556, w: 250, h: 52,
    label: 'SPCC color calibration', file: 'stages/science.ts · runSpcc',
    cite: 'orchestrator_session.ts:1892', verified: true,
    role: 'Spectrophotometric color calibration over the matched set (per-star surfaced via surfaceSpccPerStar @1928).' },
  { id: 'psf_field', step: 'calibrate', class: 'conditional', x: 396, y: 628, w: 244, h: 52,
    label: 'PSF characterization', file: 'stages/psf_characterize.ts · runPsfCharacterization → m10_psf/psf_field.ts',
    cite: 'orchestrator_session.ts:1975', verified: true,
    role: 'Per-star LM PSF fit (FWHM / ellipticity / coma field) on native pixels at coordinate-supplied positions. PIXEL ledger.' },
  { id: 'psf_attribution', step: 'calibrate', class: 'conditional', x: 684, y: 628, w: 250, h: 52,
    label: 'PSF attribution', file: 'stages/psf_attribution.ts · runPsfAttribution',
    cite: 'orchestrator_session.ts:2001', verified: true,
    role: 'Attribute PSF variation to optics vs atmosphere (differential-refraction predictor, reported APPROXIMATE — never wired into the solve).' },
  { id: 'forced_confirm', step: 'calibrate', class: 'conditional', x: 396, y: 700, w: 244, h: 52,
    label: 'Forced-photometry confirmation', file: 'solver_entry.ts:2887 · runPostSolveConfirmation → forced_confirm.ts',
    cite: 'orchestrator_session.ts:2054', verified: true,
    role: 'Forced photometry at catalog positions + per-star & set-level family-wise gate → deep_confirmed (CATALOG_FORCED_CONFIRMED). Runs LAST so it stamps the final match epoch.' },

  // ── render plane (display-only) ──
  { id: 'render_sip', step: 'calibrate', class: 'render', x: 684, y: 700, w: 250, h: 48,
    label: 'Apply SIP to render', file: 'render_apply_sip',
    cite: 'orchestrator_session.ts:1841', verified: true,
    role: 'RENDER-plane: apply the fitted SIP to the preview image. Display-only; does not feed the science ledgers.' },
  { id: 'render_gains', step: 'calibrate', class: 'render', x: 684, y: 756, w: 250, h: 48,
    label: 'SPCC render gains', file: 'spcc_render_gains',
    cite: 'orchestrator_session.ts:1947', verified: true,
    role: 'RENDER-plane: apply SPCC color gains to the preview. Display-only.' },

  // ── step-6 folded products ──
  { id: 'stage_records', step: 'integrate', class: 'product', x: 396, y: 812, w: 244, h: 52,
    label: 'Stage records fold', file: 'events/stage_records.ts · foldStageRecords',
    cite: 'orchestrator_session.ts:2383', verified: true,
    role: `Fold the run's stage_started/finished event stream into the additive top-level stage_records block (new at schema ${SOURCE_REF.receipt_schema_version}).` },
  { id: 'reproducibility', step: 'integrate', class: 'product', x: 684, y: 812, w: 250, h: 52,
    label: 'Reproducibility envelope', file: 'stages/reproducibility.ts:181 · buildReproducibilityEnvelope',
    cite: 'stages/package.ts:1076', verified: true,
    role: 'Stable config hash + source identity (git SHA) + atlas content identity → the reproducibility envelope written into the receipt.' },
];

/* ── edges: data-product dependencies (all cited) ────────────────────────── */
const EDGES = [
  { from: 'load', to: 'decode', class: 'flow', product: 'raw buffer + metadata',
    cite: 'orchestrator_session.ts:837 (step2)', verified: true },
  { from: 'decode', to: 'detect', class: 'flow', product: 'science frame (native pixels)',
    cite: 'orchestrator_session.ts:1129', verified: true },
  { from: 'detect', to: 'metrology', class: 'flow', product: 'detections (star list)',
    cite: 'orchestrator_session.ts:1223', verified: true },
  { from: 'metrology', to: 'solve', class: 'flow', product: 'scale lock + guest list',
    cite: 'orchestrator_session.ts:1462', verified: true },
  { from: 'solve', to: 'gpu_quads', class: 'conditional', product: 'quad codes (candidate gen)',
    cite: 'solver_entry.ts:1754', verified: true },
  { from: 'solve', to: 'solve_envelope', class: 'fold', product: 'search diagnostics',
    cite: 'solver_entry.ts:681', verified: true },
  { from: 'solve', to: 'refine', class: 'flow', product: 'WCS + matched_stars',
    cite: 'orchestrator_session.ts:1703', verified: true },
  { from: 'solve', to: 'render_sip', class: 'render', product: 'fitted WCS / SIP (preview)',
    cite: 'orchestrator_session.ts:1841', verified: true },
  { from: 'refine', to: 'bc_rematch', class: 'conditional', product: 'refined astrometry (rematch input)',
    cite: 'orchestrator_session.ts:1771', verified: true },
  { from: 'bc_rematch', to: 'hw_profile', class: 'conditional', product: 'post-rematch matched set',
    cite: 'orchestrator_session.ts:1818', verified: true },
  { from: 'bc_rematch', to: 'spcc', class: 'conditional', product: 'matched set',
    cite: 'orchestrator_session.ts:1892', verified: true },
  { from: 'bc_rematch', to: 'psf_field', class: 'conditional', product: 'matched set + positions',
    cite: 'orchestrator_session.ts:1975', verified: true },
  { from: 'bc_rematch', to: 'psf_attribution', class: 'conditional', product: 'PSF field',
    cite: 'orchestrator_session.ts:2001', verified: true },
  { from: 'bc_rematch', to: 'forced_confirm', class: 'conditional', product: 'final matched set',
    cite: 'orchestrator_session.ts:2054', verified: true },
  { from: 'spcc', to: 'render_gains', class: 'render', product: 'color gains (preview)',
    cite: 'orchestrator_session.ts:1947', verified: true },
  { from: 'hw_profile', to: 'receipt', class: 'fold', product: 'hardware profile block',
    cite: 'orchestrator_session.ts:2328', verified: true },
  { from: 'spcc', to: 'receipt', class: 'fold', product: 'spcc block',
    cite: 'orchestrator_session.ts:2328', verified: true },
  { from: 'psf_field', to: 'receipt', class: 'fold', product: 'psf_field block',
    cite: 'orchestrator_session.ts:2328', verified: true },
  { from: 'forced_confirm', to: 'receipt', class: 'fold', product: 'deep_confirmed block',
    cite: 'orchestrator_session.ts:2328', verified: true },
  { from: 'solve_envelope', to: 'receipt', class: 'fold', product: 'solve_envelope block',
    cite: 'orchestrator_session.ts:2368', verified: true },
  { from: 'stage_records', to: 'receipt', class: 'fold', product: 'stage_records block',
    cite: 'orchestrator_session.ts:2383', verified: true },
  { from: 'reproducibility', to: 'receipt', class: 'fold', product: 'reproducibility block',
    cite: 'stages/package.ts:1076', verified: true },
  { from: 'receipt', to: 'deposit', class: 'flow', product: 'finished packet',
    cite: 'orchestrator_session.ts:2394', verified: true },
];

const model = {
  _comment:
    'GENERATED by tools/theses/dashboard/ui/gen_flow_stages.mjs — do not hand-edit. ' +
    'Stage chain reflects ' + SOURCE_REF.branch + ' @' + SOURCE_REF.sha + ' (pre-merge). ' +
    'Every node/edge cite is a file:line on that branch.',
  generated_at: new Date().toISOString(),
  source_ref: SOURCE_REF,
  viewbox: { w: 960, h: 1020 },
  steps: STEPS,
  node_classes: NODE_CLASSES,
  edge_classes: EDGE_CLASSES,
  nodes: NODES,
  edges: EDGES,
};

// integrity: every edge endpoint must be a real node, or fail loudly (no dangling edge draws).
const nodeIds = new Set(NODES.map((n) => n.id));
for (const e of EDGES) {
  if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) {
    throw new Error(`edge ${e.from}->${e.to} references a node id not in NODES`);
  }
}

const jsonPath = resolve(__dirname, 'flow_stages.json');
const jsPath = resolve(__dirname, 'flow_stages.js');

writeFileSync(jsonPath, JSON.stringify(model, null, 2) + '\n');

const jsBody =
  '/* GENERATED from flow_stages.json by gen_flow_stages.mjs.\n' +
  '   file:// loader shim: fetch() is blocked on the file scheme, so the flow\n' +
  '   tab reads this global. Keep in sync via the generator — do not hand-edit. */\n' +
  'window.__FLOW_STAGES__ = ' +
  JSON.stringify(model, null, 2) +
  ';\n';
writeFileSync(jsPath, jsBody);

console.log('wrote', jsonPath);
console.log('wrote', jsPath);
console.log('nodes:', model.nodes.length, '| edges:', model.edges.length,
  '| source', SOURCE_REF.branch, '@' + SOURCE_REF.sha);
