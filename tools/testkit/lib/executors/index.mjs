#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// tools/testkit/lib/executors/index.mjs — the executor registry + row planner
// ═══════════════════════════════════════════════════════════════════════════
// TEST_SUITE_PLAN §6 + SEAM_CONTRACT v1 §5. run.mjs dispatches through this
// registry: it resolves the suite's declared executor, plans the rows to
// iterate (frames from the manifest, scenarios/specs/a singleton from the
// suite descriptor, or seam-capsule dirs from the suite's seams_root), and
// hands each row to the executor's run(row, env, paths). stage_replay is REAL
// since the seam wave (was an honest exit-3 stub while capture didn't exist).
// ═══════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import * as solve_to_receipt from './solve_to_receipt.mjs';
import * as api_smoke from './api_smoke.mjs';
import * as e2e_scenario from './e2e_scenario.mjs';
import * as golden_vector from './golden_vector.mjs';
import * as stage_replay from './stage_replay.mjs';

// The five REAL executors run.mjs dispatches to.
export const EXECUTORS = {
  solve_to_receipt,
  api_smoke,
  e2e_scenario,
  golden_vector,
  stage_replay,
};

// Kept for run.mjs's honest zero-replayable-rows exit-3 path.
export { stage_replay };
export const STAGE_REPLAY_NAME = stage_replay.NAME;

// Plan the rows an executor iterates over, from the suite descriptor + built
// manifest (+ resolved env for the capsule lane's default seams root).
// Deterministic. Frame executors read manifest.frames; the gate executors read
// declared scenarios/specs (with canonical defaults); stage_replay enumerates
// capsule dirs under the suite's seams_root.
export function planRows(name, { suite = {}, manifest = null, env = null } = {}) {
  switch (name) {
    case 'solve_to_receipt':
      return (manifest && manifest.frames) ? manifest.frames : [];
    case 'api_smoke': {
      const specs = suite.specs ?? [{ id: 'solve_cr2', spec: api_smoke.DEFAULT_SPEC }];
      return specs.map((s) => (typeof s === 'string' ? { id: s, spec: s } : s));
    }
    case 'e2e_scenario': {
      const scenarios = suite.scenarios ?? ['cr2', 'seestar'];
      return scenarios.map((s) => (typeof s === 'string' ? { id: s, scenario: s } : s));
    }
    case 'golden_vector':
      return [{ id: 'layout_contracts' }];
    case 'stage_replay': {
      // seams_root: suite override (abs, or repo-root-relative) → default
      // <artifactRoot>/seams (the env.mjs Windows heavy-root default per the
      // storage law — the drive literal stays in env.mjs ONLY).
      const seamsRoot = suite.seams_root
        ? (path.isAbsolute(suite.seams_root) ? suite.seams_root : path.join(env?.root ?? '.', suite.seams_root))
        : path.join(env?.artifactRoot ?? 'test_artifacts', 'seams');
      const rows = stage_replay.planReplayRows(seamsRoot, { stages: suite.stages ?? null, frames: suite.frames ?? null });
      // Thread the suite's declared volatile-field whitelist onto every row (the
      // executor takes (row, env, paths) only — the suite config rides the row).
      const volatile = Array.isArray(suite.volatile_fields) ? suite.volatile_fields : [];
      // CAPSULE-SLICE-SCOPED masks (orchestrator ruling 2026-07-21, row-441
      // precedent): suite.scoped_volatile_fields is an array of
      //   { frame?: <sha-or-prefix>, stage?: <stage>, fields: [<dotted paths>], rationale }
      // entries applied ONLY to rows whose frame_sha (prefix-match) AND stage match.
      // This is DELIBERATELY narrower than volatile_fields (which is global): it lets
      // a null-vs-absent isolated-replay artifact on ONE frame's ONE stage be masked
      // without hiding a real divergence of the same field on any other slice.
      const scoped = Array.isArray(suite.scoped_volatile_fields) ? suite.scoped_volatile_fields : [];
      if (!volatile.length && !scoped.length) return rows;
      return rows.map((r) => {
        const extra = [];
        for (const m of scoped) {
          if (!m || !Array.isArray(m.fields)) continue;
          const frameOk = !m.frame || (r.frame_sha && (r.frame_sha === m.frame || String(r.frame_sha).startsWith(m.frame)));
          const stageOk = !m.stage || r.stage === m.stage;
          if (frameOk && stageOk) extra.push(...m.fields);
        }
        const eff = extra.length ? [...volatile, ...extra] : volatile;
        return eff.length ? { ...r, volatile_fields: eff } : r;
      });
    }
    default:
      return [];
  }
}
