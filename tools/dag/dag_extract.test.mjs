/**
 * Gate for the zero-LLM DAG extractor (tools/dag/extract_dag.mjs) and its drift
 * checker (check_dag_drift.mjs).
 *
 * Proves the generated-base graph is:
 *   • DETERMINISTIC — two runs over the same tree are byte-identical (stable IDs,
 *     stable ordering; nothing keyed on array index).
 *   • CORRECT on a known edge — orchestrator_session imports stages/solve.
 *   • CLEAN of absolute paths — no drive letters / machine names / leading
 *     slashes anywhere in the emitted JSON (the artifact may go public).
 *   • WELL-FORMED — required node/edge fields present, ids unique.
 *   • DRIFT-GREEN — the freshly committed dag_base.json matches a live regen.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildDag, serializeDag, repoRoot } from './extract_dag.mjs';
import { checkDrift } from './check_dag_drift.mjs';

const ROOT = repoRoot();

describe('DAG extractor', () => {
  it('is deterministic (two runs identical)', () => {
    const a = serializeDag(buildDag(ROOT));
    const b = serializeDag(buildDag(ROOT));
    expect(a).toBe(b);
  });

  it('contains the known orchestrator_session -> stages/solve import edge', () => {
    const dag = buildDag(ROOT);
    const from = 'src/engine/pipeline/orchestrator_session.ts';
    const to = 'src/engine/pipeline/stages/solve.ts';
    const hit = dag.edges.find((e) => e.from === from && e.to === to && e.type === 'import');
    expect(hit, 'expected orchestrator_session import of stages/solve').toBeTruthy();
    expect(hit.verification).toBe('EXTRACTED');
    // cite is repo-relative "path:line"
    expect(hit.cite.startsWith(from + ':')).toBe(true);
  });

  it('emits nodes for all three kinds', () => {
    const dag = buildDag(ROOT);
    const kinds = new Set(dag.nodes.map((n) => n.kind));
    expect(kinds.has('module')).toBe(true);
    expect(kinds.has('stage')).toBe(true);
    expect(kinds.has('boundary')).toBe(true);
  });

  it('has no absolute paths anywhere in the JSON', () => {
    const json = serializeDag(buildDag(ROOT));
    // Windows drive letter (C:\ or C:/), UNC, unix-abs mount, backslashes.
    expect(/[A-Za-z]:[\\/]/.test(json)).toBe(false);
    expect(json.includes('\\')).toBe(false);
    expect(/"\/[A-Za-z]/.test(json)).toBe(false); // no leading-slash absolute paths in string values
    expect(json.includes('/mnt/')).toBe(false);
  });

  it('nodes have unique, non-index-derived ids and required fields', () => {
    const dag = buildDag(ROOT);
    const ids = dag.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of dag.nodes) {
      expect(typeof n.id).toBe('string');
      expect(['module', 'stage', 'boundary']).toContain(n.kind);
      expect(typeof n.cite).toBe('string');
      expect(typeof n.source).toBe('string');
    }
    for (const e of dag.edges) {
      expect(['import', 'stage-order', 'contract']).toContain(e.type);
      expect(dag.nodes.some((n) => n.id === e.from)).toBe(true);
      // import/contract edges must land on a real node; stage-order too.
      expect(dag.nodes.some((n) => n.id === e.to)).toBe(true);
    }
  });

  // ── Stage tier: committed stage_order fragments ∪ static inventory ──────────

  it('emits runtime sub-stage seams as base nodes (source receipt, fragment-cited)', () => {
    const dag = buildDag(ROOT);
    const byId = new Map(dag.nodes.map((n) => [n.id, n]));
    // the 8 withStage seams from the enrich lane's reconciliation contract
    for (const id of [
      'stage:solve.quad_wasm',
      'stage:calibrate.m7_analyze',
      'stage:calibrate.sip_gate',
      'stage:calibrate.tps_gate',
      'stage:m7_refine',
      'stage:bc_measure',
      'stage:bc_rematch',
      'stage:render_apply_sip',
    ]) {
      const n = byId.get(id);
      expect(n, `expected base node ${id}`).toBeTruthy();
      expect(n.kind).toBe('stage');
      expect(n.source).toBe('receipt');
      expect(n.cite.startsWith('tools/dag/enrich/fragments/stage_order')).toBe(true);
    }
    // seams are not files of their own — path stays honestly null
    expect(byId.get('stage:solve.quad_wasm').path).toBe(null);
  });

  it('keeps static-only stages represented (source static, no fabricated order)', () => {
    const dag = buildDag(ROOT);
    const byId = new Map(dag.nodes.map((n) => [n.id, n]));
    // genuine static-only stage files (no runtime-alias to a receipt substage):
    // solve_context/package/receipt_serializer never run under a different
    // withStage id, so they stay file-derived nodes.
    for (const id of ['stage:package', 'stage:solve_context', 'stage:receipt_serializer']) {
      const n = byId.get(id);
      expect(n, `expected static stage node ${id}`).toBeTruthy();
      expect(n.source).toBe('static');
      expect(typeof n.path).toBe('string');
    }
    // static-only stages must not appear in any stage-order edge
    const staticIds = new Set(
      dag.nodes.filter((n) => n.kind === 'stage' && n.source === 'static').map((n) => n.id),
    );
    for (const e of dag.edges) {
      if (e.type !== 'stage-order') continue;
      expect(staticIds.has(e.from)).toBe(false);
      expect(staticIds.has(e.to)).toBe(false);
    }
  });

  it('ids shared between the two vocabularies resolve to the receipt source', () => {
    const dag = buildDag(ROOT);
    const byId = new Map(dag.nodes.map((n) => [n.id, n]));
    for (const id of ['stage:metrology', 'stage:solve', 'stage:calibrate', 'stage:psf_attribution']) {
      const n = byId.get(id);
      expect(n, `expected stage node ${id}`).toBeTruthy();
      expect(n.source).toBe('receipt');
      // shared ids DO map to a real stage file
      expect(n.path).toBe(`src/engine/pipeline/stages/${id.slice('stage:'.length)}.ts`);
    }
  });

  it('collapses file-derived stage aliases onto their receipt id (no duplicate twins)', () => {
    const dag = buildDag(ROOT);
    const ids = new Set(dag.nodes.map((n) => n.id));
    // A stage FILE whose code runs under a different withStage/timeSubstage id
    // must NOT mint a file-named twin of the receipt-observed node for the same
    // code. The four aliases collapse; the canonical receipt id carries the node.
    const collapsed = [
      ['stage:ingest', 'stage:extract.decode'],
      ['stage:detect', 'stage:extract.detect'],
      ['stage:psf_characterize', 'stage:psf_field'],
      ['stage:science', 'stage:spcc'],
    ];
    for (const [twin, canonical] of collapsed) {
      expect(ids.has(twin), `file-derived twin ${twin} must not be a node`).toBe(false);
      expect(ids.has(canonical), `canonical receipt node ${canonical} must exist`).toBe(true);
    }
    // the underlying FILE (module) nodes are kept — only the stage twins merge.
    for (const p of [
      'src/engine/pipeline/stages/ingest.ts',
      'src/engine/pipeline/stages/detect.ts',
      'src/engine/pipeline/stages/psf_characterize.ts',
      'src/engine/pipeline/stages/science.ts',
    ]) {
      expect(ids.has(p), `module node ${p} must be kept`).toBe(true);
    }
    // GENERATIVE-FIX GUARD: no static stage node may carry a stem whose alias is
    // a claimed receipt id — regeneration must never reintroduce a twin.
    const staticStems = dag.nodes
      .filter((n) => n.kind === 'stage' && n.source === 'static')
      .map((n) => n.id.replace(/^stage:/, ''));
    for (const stem of staticStems) {
      expect(collapsed.some(([twin]) => twin === `stage:${stem}`)).toBe(false);
    }
  });

  it('carries stage-order edges in the base, EXTRACTED, citing the committed fragment', () => {
    const dag = buildDag(ROOT);
    const so = dag.edges.filter((e) => e.type === 'stage-order');
    expect(so.length).toBeGreaterThanOrEqual(22);
    for (const e of so) {
      expect(e.verification).toBe('EXTRACTED'); // base invariant — VERIFIED lives in the overlay
      expect(e.cite.startsWith('tools/dag/enrich/fragments/stage_order')).toBe(true);
    }
    const hit = so.find((e) => e.from === 'stage:load' && e.to === 'stage:extract.decode');
    expect(hit, 'expected the receipt-replayed load -> extract.decode adjacency').toBeTruthy();
  });

  it('never scans banked receipts — determinism across checkouts', () => {
    // The stage tier reads only COMMITTED fragments; a checkout without local
    // receipts must regenerate the identical graph. Tripwire: the extractor
    // source must not reference the gitignored receipts directory at all.
    const src = readFileSync(path.join(ROOT, 'tools', 'dag', 'extract_dag.mjs'), 'utf8');
    expect(src.includes('test_results')).toBe(false);
    expect(src.includes('receipt.json')).toBe(false);
  });

  it('drift check is green against the committed base', () => {
    const basePath = path.join(ROOT, 'tools', 'dag', 'dag_base.json');
    expect(existsSync(basePath), 'committed dag_base.json must exist').toBe(true);
    // sanity: committed base parses and carries the schema version.
    const base = JSON.parse(readFileSync(basePath, 'utf8'));
    expect(base.schema_version).toBe('0.1.0');
    const res = checkDrift(ROOT);
    if (!res.ok) {
      const detail = [
        ...res.nodes.added.map((k) => '+node ' + k),
        ...res.nodes.removed.map((k) => '-node ' + k),
        ...res.edges.added.map((k) => '+edge ' + k),
        ...res.edges.removed.map((k) => '-edge ' + k),
      ].join('\n');
      throw new Error('DAG drift vs committed base:\n' + detail);
    }
    expect(res.ok).toBe(true);
  });
});
