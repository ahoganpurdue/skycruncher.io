#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/scope_test.mjs — self-test for scope.mjs (change-aware scoping)
// ═══════════════════════════════════════════════════════════════════════════
// Plain-assert, vitest-free, node-runnable (`_test.mjs` underscore), style of
// env_test.mjs. Fixture-based one-hop tests use a mkdtemp root — no coupling
// to the live repo's import graph.
//   node tools/testkit/lib/scope_test.mjs
// Covers: anchor-table hits (psf trio, spcc, metrology, bc_measure/bc_rematch,
// solve+forced_confirm, integrate exact-basename discipline) · cross-cutting
// FALLBACK_FULL (orchestrator_session/constants) · honest fallback for stray
// files · one-hop import inheritance (relative + @/ alias) · FULL-anchored
// importers do NOT propagate · deterministic output (incl. shuffled input).
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scopeFiles, anchorStages, resolveSpecifier, SCOPE_SCHEMA, FULL } from './scope.mjs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ✗ FAIL: ${msg}`); } }
function eq(a, b, msg) { ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// ── (a) anchor table: m10_psf → psf_field/psf_attribution/psf ────────────────
{
  const r = scopeFiles(['src/engine/pipeline/m10_psf/psf_field.ts']);
  eq(r.schema, SCOPE_SCHEMA, 'schema id testkit.scope.v1');
  eq(r.stages, ['psf', 'psf_attribution', 'psf_field'], 'm10_psf file → psf trio (sorted)');
  eq(r.fallback_full, false, 'm10_psf file alone → no fallback');
  eq(r.anchor_hits, 1, 'm10_psf file counted as anchor hit');
  eq(r.import_hits, 0, 'no import hits needed');
  eq(r.unmapped, [], 'nothing unmapped');
}

// ── anchor breadth: solve/forced_confirm, metrology, bc_*, spcc, integrate ───
{
  const se = scopeFiles(['src/engine/pipeline/m6_plate_solve/solver_entry.ts']);
  eq(se.stages, ['forced_confirm', 'solve'], 'solver_entry → solve + forced_confirm (§6 union)');
  const hr = scopeFiles(['src/engine/pipeline/m6_plate_solve/hint_resolver.ts']);
  eq(hr.stages, ['solve'], 'plain m6 file → solve only');
  eq(scopeFiles(['src/engine/pipeline/m2_hardware/scale_manager.ts']).stages, ['metrology'], 'm2 scale* → metrology');
  eq(scopeFiles(['src/engine/pipeline/m2_hardware/lens_distortion_refit.ts']).stages, ['bc_measure'], 'lens_distortion_refit → bc_measure');
  eq(scopeFiles(['src/engine/pipeline/m2_hardware/lens_distortion_rematch_pass.ts']).stages, ['bc_rematch'], 'lens_distortion_rematch_pass → bc_rematch');
  eq(scopeFiles(['src/engine/pipeline/stages/science.ts']).stages, ['spcc'], 'stages/science → spcc');
  // exact-basename discipline: solve_provenance is integrate, NEVER solve
  eq(scopeFiles(['src/engine/pipeline/stages/solve_provenance.ts']).stages, ['integrate'], 'stages/solve_provenance → integrate (not solve — exact basename)');
  eq(scopeFiles(['src/engine/pipeline/export/sip_convention.ts']).stages, ['integrate'], 'pipeline/export/ → integrate');
  // live smoke pair from the task spec
  const smoke = scopeFiles(['src/engine/pipeline/m10_psf/psf_field.ts', 'src/engine/pipeline/stages/science.ts']);
  eq(smoke.stages, ['psf', 'psf_attribution', 'psf_field', 'spcc'], 'psf_field + science → psf trio + spcc');
  eq(smoke.fallback_full, false, 'smoke pair → fallback_full=false');
}

// ── (b) cross-cutting → FALLBACK_FULL, mapped as FULL (not unmapped) ─────────
{
  const os_ = scopeFiles(['src/engine/pipeline/orchestrator_session.ts']);
  eq(os_.fallback_full, true, 'orchestrator_session.ts → fallback_full');
  eq(os_.mapped['src/engine/pipeline/orchestrator_session.ts'], [FULL], 'orchestrator_session mapped to FULL sentinel');
  eq(os_.unmapped, [], 'cross-cutting file is NOT unmapped (it is confidently mapped — to everything)');
  eq(os_.anchor_hits, 1, 'cross-cutting file counts as anchor hit');
  const c = scopeFiles(['src/engine/pipeline/constants/pipeline_config.ts']);
  eq(c.fallback_full, true, 'constants/ → fallback_full');
  eq(c.unmapped, [], 'constants/ file not in unmapped');
}

// ── (c) honest fallback: unmapped stray → fallback_full + listed ─────────────
{
  const r = scopeFiles(['docs/SOME_RANDOM_DOC.md']);
  eq(r.fallback_full, true, 'stray file → fallback_full (honest: full battery)');
  eq(r.unmapped, ['docs/SOME_RANDOM_DOC.md'], 'stray file listed in unmapped');
  eq(r.stages, [], 'stray file contributes no stages');
  eq(r.anchor_hits, 0, 'stray file: zero anchor hits');
  eq(r.import_hits, 0, 'stray file: zero import hits');
}

// ── fixture root for one-hop tests ───────────────────────────────────────────
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-fixture-'));
function put(rel, content) {
  const abs = path.join(FIX, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
put('src/engine/pipeline/m10_psf/importer.ts', [
  "import { u } from '../psf_shared/util';",           // (d) relative one-hop
  "import alias from '@/engine/pipeline/psf_shared/util2';", // (f) alias one-hop
  "export const x = u + alias;",
].join('\n'));
put('src/engine/pipeline/constants/config.ts', [
  "import { h } from '../misc/helper';",               // FULL importer must NOT propagate
  "export const c = h;",
].join('\n'));

try {
  // ── (d) one-hop import inheritance (relative import) ───────────────────────
  {
    const r = scopeFiles(['src/engine/pipeline/psf_shared/util.ts'], { root: FIX });
    eq(r.stages, ['psf', 'psf_attribution', 'psf_field'], 'file imported by m10_psf importer inherits its stages (one hop, relative)');
    eq(r.fallback_full, false, 'inherited file → no fallback');
    eq(r.import_hits, 1, 'counted as import hit');
    eq(r.anchor_hits, 0, 'not an anchor hit');
  }
  // ── (f) alias resolution @/engine/... → src/engine/... ─────────────────────
  {
    const r = scopeFiles(['src/engine/pipeline/psf_shared/util2.ts'], { root: FIX });
    eq(r.stages, ['psf', 'psf_attribution', 'psf_field'], '@/ alias import resolves to src/* and inherits (one hop)');
    eq(r.import_hits, 1, 'alias inheritance counted as import hit');
    eq(resolveSpecifier('@/engine/pipeline/stages/solve', 'anything.ts'), 'src/engine/pipeline/stages/solve', 'resolveSpecifier: @/* → src/*');
    eq(resolveSpecifier('../psf_shared/util', 'src/engine/pipeline/m10_psf/importer.ts'), 'src/engine/pipeline/psf_shared/util', 'resolveSpecifier: relative');
    eq(resolveSpecifier('node:fs', 'a.ts'), null, 'resolveSpecifier: bare package → null');
  }
  // ── FULL-anchored importer does NOT propagate ───────────────────────────────
  {
    const r = scopeFiles(['src/engine/pipeline/misc/helper.ts'], { root: FIX });
    eq(r.fallback_full, true, 'file imported ONLY by a FULL-anchored file stays unmapped → fallback_full');
    eq(r.unmapped, ['src/engine/pipeline/misc/helper.ts'], 'and is listed (importing-from-constants is not stage evidence)');
  }
  // ── (e) deterministic output ────────────────────────────────────────────────
  {
    const input = [
      'src/engine/pipeline/stages/science.ts',
      'src/engine/pipeline/psf_shared/util.ts',
      'src/engine/pipeline/m6_plate_solve/deep_verify.ts',
      'docs/stray.md',
    ];
    const a = JSON.stringify(scopeFiles(input, { root: FIX }));
    const b = JSON.stringify(scopeFiles(input, { root: FIX }));
    eq(a, b, 'same input twice → byte-identical JSON');
    const shuffled = [input[2], input[0], input[3], input[1]];
    const c = JSON.stringify(scopeFiles(shuffled, { root: FIX }));
    eq(a, c, 'shuffled input order → byte-identical JSON (sorted keys + arrays)');
    const parsed = JSON.parse(a);
    eq(parsed.fallback_full, true, 'mixed input with stray → fallback_full');
    eq(parsed.stages, ['forced_confirm', 'psf', 'psf_attribution', 'psf_field', 'solve', 'spcc'], 'mixed input → sorted stage union');
    eq(parsed.anchor_hits, 2, 'mixed input: 2 anchor hits');
    eq(parsed.import_hits, 1, 'mixed input: 1 import hit');
    eq(parsed.unmapped, ['docs/stray.md'], 'mixed input: stray listed');
  }
  // ── anchorStages unit sanity ────────────────────────────────────────────────
  {
    eq(anchorStages('src/engine/pipeline/m1_ingestion/metadata_reaper.ts').stages, ['extract', 'load'], 'm1_ingestion → load+extract');
    eq(anchorStages('src/engine/contracts/binary_layouts.ts').full, true, 'contracts/ → FULL');
    eq(anchorStages('src/engine/pipeline/m3_gpu_preprocess/x.ts').full, true, 'm3_gpu_preprocess → FULL (safest reading of §6 "extract/render or FULL" — FLAGGED)');
    // windows separators normalize
    eq(scopeFiles(['src\\engine\\pipeline\\stages\\science.ts']).stages, ['spcc'], 'backslash paths normalized');
  }
} finally {
  fs.rmSync(FIX, { recursive: true, force: true });
}

console.log(`\nscope self-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
