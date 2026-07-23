// ============================================================================
// tools/dag/ui/dag_model.test.mjs — vitest suite for the DAG UI data-model layer.
// Pure-function tests over a small synthetic base + enrichment (self-contained),
// plus a smoke pass over the REAL committed dag_base.json and the dev fixture.
// Collected by the root vitest config (tools/**/*.test.mjs) → `npx vitest run tools/dag`.
// ============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAYERS, UNRECOGNIZED_LAYER, normalizeType, layerOf, defaultEnabledLayers,
  FILE_TYPES, matchesFileType, aggregateVerification, edgeKey,
  mergeGraph, subsystemOf, groupOf, buildStagePathIndex, CONTRACTS_GROUP,
  rollup, filterRolledEdges, focusSubgraph,
  annotationKeyFor, indexAnnotations, drawnEdgesFrom,
  egoIds, egoFilter,
  acyclicEdges, assignRanks, orderRanks, countCrossings, layeredLayout,
  hashIds, mulberry32, springPairs, forceStep, forceLayout,
  visibleDegree, linkedNodes,
  proposedPairsFrom, procedureWalk,
  MECHANICAL_TYPES, isMechanical, renderTier, applyEdgeVisibility,
  CLOCKDRIVE_KINDS, CLOCKDRIVE_STATUSES,
  normalizeClockdriveEntry, normalizeClockdrive, clockdriveAnchorGroup,
} from './dag_model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- synthetic mini-graph -----------------------------------------------------
const BASE = {
  schema_version: '0.1.0',
  generated_at_commit: 'test',
  nodes: [
    { id: 'src/MainApp.tsx', kind: 'module', path: 'src/MainApp.tsx', cite: 'src/MainApp.tsx', source: 'import-graph', version: null },
    { id: 'src/engine/core/A.ts', kind: 'module', path: 'src/engine/core/A.ts', cite: 'src/engine/core/A.ts', source: 'import-graph', version: null },
    { id: 'src/engine/pipeline/stages/solve.ts', kind: 'module', path: 'src/engine/pipeline/stages/solve.ts', cite: 'src/engine/pipeline/stages/solve.ts', source: 'import-graph', version: null },
    { id: 'stage:solve', kind: 'stage', path: 'src/engine/pipeline/stages/solve.ts', cite: 'src/engine/pipeline/stages/solve.ts', source: 'static', version: null },
    { id: 'stage:ingest', kind: 'stage', path: 'src/engine/pipeline/stages/ingest.ts', cite: 'src/engine/pipeline/stages/ingest.ts', source: 'static', version: null },
    { id: 'boundary:fits_io', kind: 'boundary', path: 'src/engine/contracts/binary_layouts.ts', cite: 'src/engine/contracts/binary_layouts.ts#fits_io', source: 'contract-schema', version: '0.1.0' },
    { id: 'tools/stack/fits_io.mjs', kind: 'module', path: 'tools/stack/fits_io.mjs', cite: 'tools/stack/fits_io.mjs', source: 'import-graph', version: null },
  ],
  edges: [
    { from: 'src/MainApp.tsx', to: 'src/engine/core/A.ts', type: 'import', cite: 'src/MainApp.tsx:1', verification: 'EXTRACTED' },
    { from: 'src/MainApp.tsx', to: 'src/engine/core/A.ts', type: 'import', cite: 'src/MainApp.tsx:9', verification: 'EXTRACTED' }, // duplicate key, extra cite
    { from: 'src/engine/core/A.ts', to: 'src/engine/pipeline/stages/solve.ts', type: 'import', cite: 'src/engine/core/A.ts:2', verification: 'EXTRACTED' },
    { from: 'boundary:fits_io', to: 'tools/stack/fits_io.mjs', type: 'contract', cite: 'src/engine/contracts/binary_layouts.ts#fits_io', verification: 'EXTRACTED' },
    { from: 'src/MainApp.tsx', to: 'tools/stack/fits_io.mjs', type: 'import', cite: 'src/MainApp.tsx:3', verification: 'EXTRACTED' },
  ],
};

const ENRICH = {
  schema_version: '0.1.0',
  generated_at_commit: 'test-enrich',
  nodes: {
    'stage:solve': { why: { text: 'solve why', cites: [{ path: 'src/engine/pipeline/stages/solve.ts', lines: '1-4' }] }, walked_by: ['CR2', 'FITS'] },
    'stage:no_such_stage': { why: { text: 'orphan', cites: [] } }, // node the base lacks → ignored
  },
  edges: [
    // override of an existing base edge
    { from: 'src/MainApp.tsx', to: 'src/engine/core/A.ts', type: 'import', verification: 'VERIFIED', walked_by: ['FITS'], why: { text: 'edge why', cites: [] } },
    // semantic union edges
    { from: 'stage:ingest', to: 'stage:solve', type: 'data-flow', verification: 'VERIFIED', how: { what: 'stars', transform: 'centroid', lossy: false }, walked_by: ['CR2'] },
    { from: 'stage:solve', to: 'boundary:fits_io', type: 'unit/frame-conversion', verification: 'EXTRACTED' }, // slash spelling normalizes
    { from: 'boundary:fits_io', to: 'tools/stack/fits_io.mjs', type: 'contract', verification: 'REFUTED' },   // demotion override
    { from: 'stage:ingest', to: 'tools/ghost/nope.mjs', type: 'external-dependency', verification: 'EXTRACTED' }, // unknown endpoint
  ],
};

// ---- layer taxonomy ------------------------------------------------------------
describe('layer taxonomy', () => {
  it('has exactly 14 layers, 8 on / 6 off by default', () => {
    expect(LAYERS.length).toBe(14);
    expect(LAYERS.filter((l) => l.defaultOn).length).toBe(8);
    expect(LAYERS.filter((l) => !l.defaultOn).length).toBe(6);
  });
  it('maps base types onto layers and normalizes spellings', () => {
    expect(layerOf('import')).toBe('data-flow');
    expect(layerOf('stage-order')).toBe('ordering-only');
    expect(layerOf('contract')).toBe('contract');
    expect(layerOf('unit/frame-conversion')).toBe('unit-frame-conversion');
    expect(layerOf('control/gating')).toBe('control-gating');
    expect(layerOf('owner-drawn')).toBe('annotation');
    expect(normalizeType('Duplication / Shadow')).toBe('duplication-shadow');
  });
  it('routes unknown types to the visible unrecognized pseudo-layer (never hidden)', () => {
    expect(layerOf('mystery-type')).toBe(UNRECOGNIZED_LAYER);
    expect(defaultEnabledLayers().has(UNRECOGNIZED_LAYER)).toBe(true);
  });
  it('defaults match the owner ruling (loud layer on, badge layers off)', () => {
    const on = defaultEnabledLayers();
    expect(on.has('unit-frame-conversion')).toBe(true);
    expect(on.has('annotation')).toBe(true);
    expect(on.has('receipt-write')).toBe(false);
    expect(on.has('doc-binding')).toBe(false);
  });
});

// ---- merge -----------------------------------------------------------------------
describe('mergeGraph', () => {
  it('handles honest absence of enrichment: all edges stay EXTRACTED, no why', () => {
    const m = mergeGraph(BASE, null);
    expect(m.enrichment.present).toBe(false);
    expect(m.edges.every((e) => e.verification === 'EXTRACTED')).toBe(true);
    expect([...m.nodes.values()].every((n) => n.why === null)).toBe(true);
  });
  it('dedupes base edges by (from,to,type) and collects cites', () => {
    const m = mergeGraph(BASE, null);
    const e = m.edges.find((x) => x.from === 'src/MainApp.tsx' && x.to === 'src/engine/core/A.ts');
    expect(m.edges.filter((x) => x.from === 'src/MainApp.tsx' && x.to === 'src/engine/core/A.ts').length).toBe(1);
    expect(e.cites).toEqual(['src/MainApp.tsx:1', 'src/MainApp.tsx:9']);
  });
  it('unions enrichment: overrides verification, attaches how/why, appends semantic edges', () => {
    const m = mergeGraph(BASE, ENRICH);
    expect(m.enrichment.present).toBe(true);
    const over = m.edges.find((x) => edgeKey(x.from, x.to, x.type) === edgeKey('src/MainApp.tsx', 'src/engine/core/A.ts', 'import'));
    expect(over.verification).toBe('VERIFIED');
    expect(over.why.text).toBe('edge why');
    const sem = m.edges.find((x) => x.type === 'data-flow');
    expect(sem).toBeTruthy();
    expect(sem.how.transform).toBe('centroid');
    const demoted = m.edges.find((x) => x.from === 'boundary:fits_io' && x.type === 'contract');
    expect(demoted.verification).toBe('REFUTED');
    const norm = m.edges.find((x) => x.type === 'unit-frame-conversion');
    expect(norm.layer).toBe('unit-frame-conversion');
  });
  it('attaches node why/walked_by; ignores enrichment for nodes the base lacks', () => {
    const m = mergeGraph(BASE, ENRICH);
    expect(m.nodes.get('stage:solve').why.text).toBe('solve why');
    expect(m.nodes.get('stage:solve').walked_by).toEqual(['CR2', 'FITS']);
    expect(m.nodes.has('stage:no_such_stage')).toBe(false);
  });
  it('keeps but FLAGS enrichment edges with unknown endpoints (never silently drops)', () => {
    const m = mergeGraph(BASE, ENRICH);
    const ghost = m.edges.find((x) => x.to === 'tools/ghost/nope.mjs');
    expect(ghost).toBeTruthy();
    expect(ghost.unknownEndpoint).toBe(true);
  });
});

// ---- evidence aggregation ---------------------------------------------------------
describe('aggregateVerification', () => {
  it('REFUTED dominates, then STALE; VERIFIED only when unanimous; mixed = EXTRACTED', () => {
    expect(aggregateVerification(['VERIFIED', 'REFUTED', 'VERIFIED'])).toBe('REFUTED');
    expect(aggregateVerification(['VERIFIED', 'STALE'])).toBe('STALE');
    expect(aggregateVerification(['VERIFIED', 'VERIFIED'])).toBe('VERIFIED');
    expect(aggregateVerification(['VERIFIED', 'EXTRACTED'])).toBe('EXTRACTED');
    expect(aggregateVerification([])).toBe('EXTRACTED');
  });
});

// ---- subsystem derivation -----------------------------------------------------------
describe('subsystemOf', () => {
  it('splits engine/pipeline one level deeper; groups tools by lane', () => {
    expect(subsystemOf('src/engine/pipeline/m6_plate_solve/solver_entry.ts')).toBe('engine/pipeline/m6_plate_solve');
    expect(subsystemOf('src/engine/pipeline/stages/solve.ts')).toBe('engine/pipeline/stages');
    expect(subsystemOf('src/engine/pipeline/orchestrator_session.ts')).toBe('engine/pipeline');
    expect(subsystemOf('src/engine/core/ArrowMemory.ts')).toBe('engine/core');
    expect(subsystemOf('src/MainApp.tsx')).toBe('src');
    expect(subsystemOf('src/data/calibration_targets.ts')).toBe('src/data');
    expect(subsystemOf('tools/psf/decode_cr2.mjs')).toBe('tools/psf');
    expect(subsystemOf('tools/generate_star_atlas.ts')).toBe('tools');
  });
});

// ---- roll-up ---------------------------------------------------------------------------
describe('rollup levels', () => {
  const m = mergeGraph(BASE, ENRICH);

  it('subsystem level: no module/stage/boundary rendered individually', () => {
    const r = rollup(m, 'subsystem');
    const ids = r.nodes.map((n) => n.id);
    expect(ids).toContain('subsystem:src');
    expect(ids).toContain('subsystem:engine/core');
    expect(ids).toContain('subsystem:engine/pipeline/stages');
    expect(ids).toContain(`subsystem:${CONTRACTS_GROUP}`);
    expect(ids).toContain('subsystem:tools/stack');
    expect(ids.some((i) => i.startsWith('stage:') || i.startsWith('boundary:'))).toBe(false);
  });

  it('stage level: stage nodes individual; module twin of a stage file merges into its stage', () => {
    const r = rollup(m, 'stage');
    const ids = r.nodes.map((n) => n.id);
    expect(ids).toContain('stage:solve');
    expect(ids).toContain('stage:ingest');
    expect(ids).toContain(`subsystem:${CONTRACTS_GROUP}`); // boundaries still rolled
    const solve = r.nodes.find((n) => n.id === 'stage:solve');
    expect(solve.memberCount).toBe(2); // stage node + its module twin
    expect(solve.members).toContain('src/engine/pipeline/stages/solve.ts');
    // identity claim must win regardless of member iteration order (the base
    // lists the module twin BEFORE the stage node — regression 2026-07-16)
    expect(solve.kind).toBe('stage');
    expect(solve.label).toBe('solve');
    const fitsIo = rollup(m, 'boundary').nodes.find((n) => n.id === 'boundary:fits_io');
    expect(fitsIo.kind).toBe('boundary');
    expect(fitsIo.label).toBe('fits_io');
  });

  it('boundary level: boundary nodes individual too', () => {
    const r = rollup(m, 'boundary');
    expect(r.nodes.map((n) => n.id)).toContain('boundary:fits_io');
  });

  it('aggregates edges between groups with counts, types, and honest mixed verification', () => {
    const r = rollup(m, 'stage');
    // src/MainApp.tsx→A.ts is VERIFIED, A.ts is in engine/core; MainApp is in src
    const agg = r.edges.find((e) => e.from === 'subsystem:src' && e.to === 'subsystem:engine/core');
    expect(agg.count).toBe(1);
    expect(agg.verification).toBe('VERIFIED'); // single constituent, verified
    // edge into the merged stage:solve group from engine/core
    const intoSolve = r.edges.find((e) => e.from === 'subsystem:engine/core' && e.to === 'stage:solve');
    expect(intoSolve).toBeTruthy(); // module-path edge remapped into the stage node
    expect(intoSolve.verification).toBe('EXTRACTED');
  });

  it('counts within-group edges instead of drawing them', () => {
    const base2 = { ...BASE, edges: [...BASE.edges, { from: 'src/engine/core/A.ts', to: 'src/engine/core/A.ts', type: 'import', cite: 'x:1', verification: 'EXTRACTED' }] };
    // distinct member so it is not a self-loop on the raw graph:
    base2.nodes = [...BASE.nodes, { id: 'src/engine/core/B.ts', kind: 'module', path: 'src/engine/core/B.ts', cite: 'src/engine/core/B.ts', source: 'import-graph', version: null }];
    base2.edges = [...BASE.edges, { from: 'src/engine/core/A.ts', to: 'src/engine/core/B.ts', type: 'import', cite: 'x:1', verification: 'EXTRACTED' }];
    const r = rollup(mergeGraph(base2, null), 'subsystem');
    const core = r.nodes.find((n) => n.id === 'subsystem:engine/core');
    expect(core.internalEdgeCount).toBe(1);
    expect(r.edges.some((e) => e.from === 'subsystem:engine/core' && e.to === 'subsystem:engine/core')).toBe(false);
  });

  it('carries annotation badges up through the roll-up (stable-ID keying)', () => {
    const annotatedKeys = new Set([
      'node:src/engine/pipeline/stages/solve.ts',
      `edge:${edgeKey('src/MainApp.tsx', 'src/engine/core/A.ts', 'import')}`,
    ]);
    const r = rollup(m, 'stage', { annotatedKeys });
    expect(r.nodes.find((n) => n.id === 'stage:solve').annotated).toBe(true);
    expect(r.edges.find((e) => e.from === 'subsystem:src' && e.to === 'subsystem:engine/core').annotated).toBe(true);
  });

  it('unions walked_by tags up to the group', () => {
    const r = rollup(m, 'subsystem');
    const stages = r.nodes.find((n) => n.id === 'subsystem:engine/pipeline/stages');
    expect(stages.walked_by).toEqual(expect.arrayContaining(['CR2', 'FITS']));
  });
});

// ---- layer filtering -------------------------------------------------------------------
describe('filterRolledEdges', () => {
  const m = mergeGraph(BASE, ENRICH);
  const r = rollup(m, 'stage');

  it('drops aggregate edges whose every constituent layer is disabled', () => {
    const none = filterRolledEdges(r.edges, new Set());
    expect(none.length).toBe(0);
  });
  it('shrinks counts to enabled layers only (no smuggled hidden-layer counts)', () => {
    const all = new Set([...LAYERS.map((l) => l.id), UNRECOGNIZED_LAYER]);
    const full = filterRolledEdges(r.edges, all);
    const onlyContract = filterRolledEdges(r.edges, new Set(['contract']));
    const fullTotal = full.reduce((a, e) => a + e.count, 0);
    const contractTotal = onlyContract.reduce((a, e) => a + e.count, 0);
    expect(contractTotal).toBeLessThan(fullTotal);
    expect(onlyContract.every((e) => Object.keys(e.layers).every((l) => l === 'contract'))).toBe(true);
  });
  it('recomputes aggregate verification over the visible constituents', () => {
    const onlyData = filterRolledEdges(r.edges, new Set(['data-flow']));
    for (const e of onlyData) {
      expect(e.verification).toBe(aggregateVerification(e.constituents.map((c) => c.verification)));
    }
  });
});

// ---- focus / drill-in ---------------------------------------------------------------------
describe('focusSubgraph', () => {
  it('returns members of one group with far endpoints mapped to port groups', () => {
    const m = mergeGraph(BASE, ENRICH);
    const f = focusSubgraph(m, 'subsystem', 'subsystem:engine/core');
    expect(f.members.map((n) => n.id)).toEqual(['src/engine/core/A.ts']);
    expect(f.ports.map((p) => p.id)).toContain('subsystem:src');
    expect(f.edges.length).toBeGreaterThan(0);
    expect(f.edges.every((e) => e.from === 'src/engine/core/A.ts' || e.to === 'src/engine/core/A.ts'
      || f.members.some((mm) => mm.id === e.from || mm.id === e.to)
      || e.from.startsWith('subsystem:') || e.to.startsWith('subsystem:'))).toBe(true);
  });
});

// ---- annotations ------------------------------------------------------------------------------
describe('annotation keying', () => {
  it('keys nodes and edges stably (same key in both views)', () => {
    expect(annotationKeyFor({ node: 'stage:solve' })).toBe('node:stage:solve');
    expect(annotationKeyFor({ edge: { from: 'a', to: 'b', type: 'import' } })).toBe('edge:a|b|import');
    expect(annotationKeyFor({ edge: { from: 'a', to: 'b' } })).toBe('edge:a|b|owner-drawn');
    expect(annotationKeyFor(null)).toBe(null);
    expect(annotationKeyFor({})).toBe(null);
  });
  it('indexes annotations by key', () => {
    const list = [
      { id: '1', kind: 'comment', text: 'x', target: { node: 'stage:solve' } },
      { id: '2', kind: 'question', text: 'y', target: { node: 'stage:solve' } },
      { id: '3', kind: 'comment', text: 'z', target: { edge: { from: 'a', to: 'b', type: 'import' } } },
      { id: '4', kind: 'comment', text: 'no target' },
    ];
    const idx = indexAnnotations(list);
    expect(idx.get('node:stage:solve').length).toBe(2);
    expect(idx.get('edge:a|b|import').length).toBe(1);
    expect(idx.size).toBe(2);
  });
  it('turns drawn-edge annotations into annotation-layer edges', () => {
    const list = [
      { id: '1', kind: 'drawn-edge', text: 'owner suspects a seam here', target: { edge: { from: 'stage:ingest', to: 'stage:solve' } } },
      { id: '2', kind: 'comment', text: 'not an edge', target: { node: 'stage:solve' } },
    ];
    const drawn = drawnEdgesFrom(list);
    expect(drawn.length).toBe(1);
    expect(drawn[0].type).toBe('owner-drawn');
    expect(drawn[0].layer).toBe('annotation');
    expect(drawn[0].why.text).toBe('owner suspects a seam here');
  });
});

// ---- proposed connections (empty-cell annotations) ----------------------------------------------
describe('proposed-connection annotations', () => {
  it('layerOf routes proposed-connection onto the annotation layer', () => {
    expect(layerOf('proposed-connection')).toBe('annotation');
  });
  it('enrichment-lane short type spellings alias onto their ratified layers', () => {
    expect(layerOf('unit-conversion')).toBe('unit-frame-conversion');
    expect(layerOf('fallback')).toBe('fallback-degradation');
    expect(layerOf('control')).toBe('control-gating');
    expect(layerOf('evidence')).toBe('evidence');
  });
  it('keys stably on the node pair — same key in matrix, graph, and panel', () => {
    expect(annotationKeyFor({ edge: { from: 'gA', to: 'gB', type: 'proposed-connection' } }))
      .toBe('edge:gA|gB|proposed-connection');
  });
  it('proposedPairsFrom dedupes by pair and carries every annotation', () => {
    const list = [
      { id: '1', kind: 'question', text: 'should A feed B?', target: { edge: { from: 'gA', to: 'gB', type: 'proposed-connection' } } },
      { id: '2', kind: 'comment', text: 'second note', target: { edge: { from: 'gA', to: 'gB', type: 'proposed-connection' } } },
      { id: '3', kind: 'comment', text: 'other pair', target: { edge: { from: 'gA', to: 'gC', type: 'proposed-connection' } } },
      { id: '4', kind: 'comment', text: 'NOT proposed', target: { edge: { from: 'gA', to: 'gB', type: 'import' } } },
      { id: '5', kind: 'comment', text: 'node note', target: { node: 'gA' } },
    ];
    const pairs = proposedPairsFrom(list);
    expect(pairs.length).toBe(2);
    const ab = pairs.find((p) => p.to === 'gB');
    expect(ab.count).toBe(2);
    expect(ab.annotations.map((a) => a.id)).toEqual(['1', '2']);
  });
  it('skips malformed targets instead of throwing', () => {
    expect(proposedPairsFrom([{ kind: 'comment', text: 'x' }, null, { target: { edge: { from: 'a', type: 'proposed-connection' } } }])).toEqual([]);
    expect(proposedPairsFrom(null)).toEqual([]);
  });
});

// ---- procedure walk (third view) ------------------------------------------------------------------
describe('procedureWalk', () => {
  const PBASE = {
    schema_version: '0.1.0', generated_at_commit: 'test',
    nodes: [
      { id: 'stage:ingest', kind: 'stage', path: 'src/engine/pipeline/stages/ingest.ts', cite: 'x', source: 'static', version: null },
      { id: 'stage:solve', kind: 'stage', path: 'src/engine/pipeline/stages/solve.ts', cite: 'x', source: 'static', version: null },
      { id: 'stage:package', kind: 'stage', path: 'src/engine/pipeline/stages/package.ts', cite: 'x', source: 'static', version: null },
      { id: 'stage:never_walked', kind: 'stage', path: 'src/engine/pipeline/stages/never.ts', cite: 'x', source: 'static', version: null },
      { id: 'src/other.ts', kind: 'module', path: 'src/other.ts', cite: 'x', source: 'import-graph', version: null },
    ],
    edges: [],
  };
  const PENRICH = {
    schema_version: '0.1.0', generated_at_commit: 'test',
    nodes: {
      'stage:solve': {
        why: { text: 'finds the plate solution', cites: [] },
        copy: { text: 'Match detected stars to the catalog and fit the sky position.', cites: [{ path: 'docs/X.md', lines: '1-3' }] },
        badges: { receipt_write: 'solution', substrate: 'Rust→WASM · CPU' },
        walked_by: ['fits'],
      },
    },
    edges: [
      // deliberately OUT of order — the walk must order them
      { from: 'stage:solve', to: 'stage:package', type: 'stage-order', verification: 'VERIFIED', walked_by: ['fits'], cite: 'test_results/e2e/rcpt.json' },
      { from: 'stage:ingest', to: 'stage:solve', type: 'stage-order', verification: 'VERIFIED', walked_by: ['fits'], cite: 'test_results/e2e/rcpt.json' },
      // a second, separate chain under another tag (future CR2 grouping, data-driven)
      { from: 'stage:ingest', to: 'stage:package', type: 'stage-order', verification: 'VERIFIED', walked_by: ['cr2'], cite: 'test_results/e2e/rcpt_cr2.json' },
    ],
  };
  const merged = mergeGraph(PBASE, PENRICH);

  it('orders steps along the stage-order chain regardless of edge order', () => {
    const w = procedureWalk(merged);
    const fits = w.chains.find((c) => c.tag === 'fits');
    expect(fits.steps.map((s) => s.id)).toEqual(['stage:ingest', 'stage:solve', 'stage:package']);
  });
  it('groups chains per walked_by tag (data-driven per-type headers)', () => {
    const w = procedureWalk(merged);
    expect(w.chains.map((c) => c.tag).sort()).toEqual(['cr2', 'fits']);
  });
  it('file-type filter keeps matching chains and reports skipped tags honestly', () => {
    const w = procedureWalk(merged, { fileType: 'FITS' });
    expect(w.chains.length).toBe(1);
    expect(w.chains[0].tag).toBe('fits');
    expect(w.skippedTags).toEqual(['cr2']);
  });
  it('carries the receipt cite the walk was replayed from', () => {
    const w = procedureWalk(merged);
    expect(w.chains.find((c) => c.tag === 'fits').cites).toContain('test_results/e2e/rcpt.json');
  });
  it('copy contract: present only when verified; absent steps stay honestly null', () => {
    const w = procedureWalk(merged);
    const steps = w.chains.find((c) => c.tag === 'fits').steps;
    expect(steps[1].copy.text).toContain('Match detected stars');
    expect(steps[0].copy).toBe(null); // ingest has no verified copy → UI renders the honest-absent state
    expect(steps[1].badges.receipt_write).toBe('solution');
    expect(steps[1].badges.substrate).toBe('Rust→WASM · CPU');
  });
  it('footer lists stage nodes never observed in any receipt walk', () => {
    const w = procedureWalk(merged, { fileType: 'FITS' });
    expect(w.unwalked).toEqual(['stage:never_walked']); // module nodes never listed; filter does not hide honesty
  });
  it('a stage id referenced by stage-order but missing from the base is flagged, not dropped', () => {
    const en2 = { ...PENRICH, edges: [...PENRICH.edges, { from: 'stage:package', to: 'stage:ghost_substage', type: 'stage-order', verification: 'VERIFIED', walked_by: ['fits'], cite: 'test_results/e2e/rcpt.json' }] };
    const w = procedureWalk(mergeGraph(PBASE, en2));
    const fits = w.chains.find((c) => c.tag === 'fits');
    const ghost = fits.steps.find((s) => s.id === 'stage:ghost_substage');
    expect(ghost).toBeTruthy();
    expect(ghost.known).toBe(false);
    expect(ghost.enrichmentOnly).toBe(false); // no enrichment entry either → fully honest-absent
  });
  it('base-lacking ids fall back to the ENRICHMENT node entry, labeled enrichmentOnly (23-id reconciliation gap)', () => {
    const en2 = {
      ...PENRICH,
      nodes: {
        ...PENRICH.nodes,
        'stage:ghost_substage': {
          why: { text: 'sub-stage why from enrichment', cites: [] },
          badges: { receipt_write: 'ghost_block', substrate: 'WGSL · GPU' },
        },
      },
      edges: [...PENRICH.edges, { from: 'stage:package', to: 'stage:ghost_substage', type: 'stage-order', verification: 'VERIFIED', walked_by: ['fits'], cite: 'test_results/e2e/rcpt.json' }],
    };
    const merged2 = mergeGraph(PBASE, en2);
    expect(merged2.nodes.has('stage:ghost_substage')).toBe(false); // base stays the node authority
    const w = procedureWalk(merged2, { enrichmentNodes: en2.nodes });
    const ghost = w.chains.find((c) => c.tag === 'fits').steps.find((s) => s.id === 'stage:ghost_substage');
    expect(ghost.enrichmentOnly).toBe(true);
    expect(ghost.why.text).toContain('sub-stage why');
    expect(ghost.badges.receipt_write).toBe('ghost_block');
    expect(ghost.copy).toBe(null); // still no verified copy → honest-absent
  });
  it('stage-order cycles land in a flagged unordered chain (honest, not infinite)', () => {
    const en3 = {
      schema_version: '0.1.0', generated_at_commit: 'test',
      edges: [
        { from: 'stage:solve', to: 'stage:ingest', type: 'stage-order', verification: 'EXTRACTED', walked_by: ['fits'] },
        { from: 'stage:ingest', to: 'stage:solve', type: 'stage-order', verification: 'EXTRACTED', walked_by: ['fits'] },
      ],
    };
    const w = procedureWalk(mergeGraph(PBASE, en3));
    expect(w.chains.length).toBe(1);
    expect(w.chains[0].note).toContain('not reachable');
    expect(w.chains[0].steps.map((s) => s.id).sort()).toEqual(['stage:ingest', 'stage:solve']);
  });
  it('walk over the REAL merged graph is a single ordered fits chain (current data)', () => {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'dag_base.json'), 'utf8'));
    const enrich = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'dag', 'enrich', 'enrichment.json'), 'utf8'));
    const w = procedureWalk(mergeGraph(base, enrich));
    expect(w.chains.length).toBeGreaterThan(0);
    for (const c of w.chains) expect(c.steps.length).toBeGreaterThan(1);
    // every chain cite points at a receipt (the walk's provenance)
    expect(w.chains.every((c) => c.cites.length > 0)).toBe(true);
  });
});

// ---- mechanical render tier ---------------------------------------------------------------------
describe('mechanical render tier', () => {
  it('mergeGraph marks edge origins: base vs enrichment vs annotation', () => {
    const m = mergeGraph(BASE, ENRICH);
    const baseEdge = m.edges.find((x) => x.from === 'src/MainApp.tsx' && x.to === 'tools/stack/fits_io.mjs');
    expect(baseEdge.origin).toBe('base');
    const semEdge = m.edges.find((x) => x.type === 'data-flow');
    expect(semEdge.origin).toBe('enrichment');
    const drawn = drawnEdgesFrom([{ id: '1', kind: 'drawn-edge', text: 'x', target: { edge: { from: 'a', to: 'b' } } }]);
    expect(drawn[0].origin).toBe('annotation');
  });
  it('isMechanical: base parser types, still EXTRACTED — and nothing else', () => {
    expect(isMechanical({ origin: 'base', type: 'import', verification: 'EXTRACTED' })).toBe(true);
    expect(isMechanical({ origin: 'base', type: 'contract', verification: 'EXTRACTED' })).toBe(true);
    expect(isMechanical({ origin: 'base', type: 'stage-order', verification: 'EXTRACTED' })).toBe(true);
    expect(isMechanical({ origin: 'enrichment', type: 'import', verification: 'EXTRACTED' })).toBe(false);
    expect(isMechanical({ origin: 'base', type: 'import', verification: 'VERIFIED' })).toBe(false); // verdict outranks tier
    expect(isMechanical({ origin: 'annotation', type: 'owner-drawn', verification: 'EXTRACTED' })).toBe(false);
    expect(MECHANICAL_TYPES.has('import')).toBe(true);
  });
  it('renderTier: verdicts win; all-mechanical EXTRACTED → mechanical; any LLM claim → extracted', () => {
    expect(renderTier({ verification: 'VERIFIED' })).toBe('verified');
    expect(renderTier({ verification: 'REFUTED' })).toBe('refuted');
    expect(renderTier({ verification: 'STALE' })).toBe('stale');
    const mech = { origin: 'base', type: 'import', verification: 'EXTRACTED' };
    const llm = { origin: 'enrichment', type: 'evidence', verification: 'EXTRACTED' };
    expect(renderTier({ verification: 'EXTRACTED', constituents: [mech, mech] })).toBe('mechanical');
    expect(renderTier({ verification: 'EXTRACTED', constituents: [mech, llm] })).toBe('extracted');
    expect(renderTier(mech)).toBe('mechanical'); // single-edge form (focus view)
  });
  it('aggregate with verified members + mechanical remainder stays mechanical (the unverified part is parser-checked)', () => {
    const mech = { origin: 'base', type: 'import', verification: 'EXTRACTED' };
    const ver = { origin: 'enrichment', type: 'data-flow', verification: 'VERIFIED' };
    expect(renderTier({ verification: 'EXTRACTED', constituents: [ver, mech] })).toBe('mechanical');
  });
  it('real base: every deduped base edge is mechanical before enrichment', () => {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'dag_base.json'), 'utf8'));
    const m = mergeGraph(base, null);
    expect(m.edges.every((e) => isMechanical(e))).toBe(true);
  });
  it('applyEdgeVisibility: hideMechanical drops the grey tier only, keeps verdicts + LLM claims', () => {
    const mech = { verification: 'EXTRACTED', constituents: [{ origin: 'base', type: 'import', verification: 'EXTRACTED' }] };
    const llm = { verification: 'EXTRACTED', constituents: [{ origin: 'enrichment', type: 'evidence', verification: 'EXTRACTED' }] };
    const ver = { verification: 'VERIFIED', constituents: [{ origin: 'enrichment', type: 'data-flow', verification: 'VERIFIED' }] };
    const edges = [mech, llm, ver];
    expect(applyEdgeVisibility(edges, { hideMechanical: false })).toBe(edges); // no-op identity when off
    const hidden = applyEdgeVisibility(edges, { hideMechanical: true });
    expect(hidden).toEqual([llm, ver]);
    expect(hidden).not.toContain(mech);
  });
  it('applyEdgeVisibility: real base fully clears when hidden (the owner-reported grey mass)', () => {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'dag_base.json'), 'utf8'));
    const m = mergeGraph(base, null);
    const rolled = rollup(m, 'subsystem');
    expect(rolled.edges.length).toBeGreaterThan(0);
    expect(applyEdgeVisibility(rolled.edges, { hideMechanical: true }).length).toBe(0); // base-only = all mechanical
  });
});

// ---- file-type matching ------------------------------------------------------------------------
describe('matchesFileType', () => {
  it('matches aliases case-insensitively; no selection matches everything', () => {
    expect(matchesFileType(['CR2'], 'CR2')).toBe(true);
    expect(matchesFileType(['cr2'], 'CR2')).toBe(true);
    expect(matchesFileType(['png'], 'PNG+JPEG')).toBe(true);
    expect(matchesFileType(['jpeg'], 'PNG+JPEG')).toBe(true);
    expect(matchesFileType(['FITS'], 'CR2')).toBe(false);
    expect(matchesFileType([], 'CR2')).toBe(false);
    expect(matchesFileType([], null)).toBe(true);
    expect(FILE_TYPES.map((f) => f.id)).toEqual(['CR2', 'FITS', 'ASDF', 'PNG+JPEG', 'JSON']);
  });
});

// ---- connectivity isolation (ego) --------------------------------------------------------------
describe('egoIds / egoFilter (connectivity isolation)', () => {
  const EDGES = [
    { from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'D' },
    { from: 'X', to: 'B' }, { from: 'D', to: 'A' }, // D→A closes a cycle
  ];
  it('1 hop, both directions: center + direct neighbors only', () => {
    expect([...egoIds(EDGES, 'B', { hops: 1, direction: 'both' })].sort()).toEqual(['A', 'B', 'C', 'X']);
  });
  it('upstream vs downstream are distinct review questions', () => {
    expect([...egoIds(EDGES, 'B', { hops: 1, direction: 'downstream' })].sort()).toEqual(['B', 'C']);
    expect([...egoIds(EDGES, 'B', { hops: 1, direction: 'upstream' })].sort()).toEqual(['A', 'B', 'X']);
  });
  it('hop expansion grows one ring at a time', () => {
    expect([...egoIds(EDGES, 'A', { hops: 1, direction: 'downstream' })].sort()).toEqual(['A', 'B']);
    expect([...egoIds(EDGES, 'A', { hops: 2, direction: 'downstream' })].sort()).toEqual(['A', 'B', 'C']);
    expect([...egoIds(EDGES, 'A', { hops: 3, direction: 'downstream' })].sort()).toEqual(['A', 'B', 'C', 'D']);
  });
  it('a center with no edges isolates to itself (honest lone node, not an error)', () => {
    expect([...egoIds(EDGES, 'LONER', { hops: 4, direction: 'both' })]).toEqual(['LONER']);
  });
  it('egoFilter keeps only edges with BOTH endpoints inside the ego', () => {
    const nodes = ['A', 'B', 'C', 'D', 'X'].map((id) => ({ id }));
    const f = egoFilter(nodes, EDGES, 'B', { hops: 1, direction: 'both' });
    expect(f.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C', 'X']);
    expect(f.edges.length).toBe(3); // A→B, B→C, X→B; C→D and D→A cross the boundary
  });
  it('operates on the caller-filtered edge list (layer toggles applied upstream)', () => {
    const noXB = EDGES.filter((e) => e.from !== 'X');
    expect([...egoIds(noXB, 'B', { hops: 1, direction: 'upstream' })].sort()).toEqual(['A', 'B']);
  });
  it('defaults hops=1/both; invalid opts clamp instead of throwing', () => {
    expect([...egoIds(EDGES, 'B')].sort()).toEqual(['A', 'B', 'C', 'X']);
    expect([...egoIds(EDGES, 'B', { hops: 0, direction: 'sideways' })].sort()).toEqual(['A', 'B', 'C', 'X']);
  });
});

// ---- Sugiyama layered layout --------------------------------------------------------------------
describe('layered layout (deterministic Sugiyama)', () => {
  it('assignRanks: chain gets consecutive ranks along the edge direction', () => {
    const edges = [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'D' }];
    const r = assignRanks(['A', 'B', 'C', 'D'], edges);
    expect([r.get('A'), r.get('B'), r.get('C'), r.get('D')]).toEqual([0, 1, 2, 3]);
  });
  it('assignRanks: longest path wins (diamond with a shortcut)', () => {
    const edges = [
      { from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'A', to: 'C' },
    ];
    const r = assignRanks(['A', 'B', 'C'], edges);
    expect(r.get('C')).toBe(2); // via A→B→C, not the A→C shortcut
  });
  it('cycles break deterministically (sorted-id root wins the orientation)', () => {
    const edges = [{ from: 'B', to: 'A' }, { from: 'A', to: 'B' }];
    const r1 = assignRanks(['A', 'B'], edges);
    const r2 = assignRanks(['B', 'A'], [...edges].reverse());
    expect(r1.get('A')).toBe(0);
    expect(r1.get('B')).toBe(1);
    expect([...r1.entries()].sort()).toEqual([...r2.entries()].sort());
  });
  it('acyclicEdges returns a DAG subset and drops self-loops for ranking', () => {
    const edges = [
      { from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'A' },
      { from: 'A', to: 'A' },
    ];
    const dag = acyclicEdges(['A', 'B', 'C'], edges);
    expect(dag.length).toBe(2); // C→A is the back edge; A→A self-loop dropped
    expect(dag.some((e) => e.from === 'A' && e.to === 'A')).toBe(false);
  });
  it('rank + order are identical under input permutation (layout stability)', () => {
    const nodes = ['N1', 'N2', 'N3', 'N4', 'N5'];
    const edges = [
      { from: 'N1', to: 'N2' }, { from: 'N1', to: 'N3' }, { from: 'N2', to: 'N4' },
      { from: 'N3', to: 'N4' }, { from: 'N4', to: 'N5' }, { from: 'N3', to: 'N5' },
    ];
    const a = layeredLayout(nodes.map((id) => ({ id })), edges);
    const b = layeredLayout([...nodes].reverse().map((id) => ({ id })), [...edges].reverse());
    expect([...a.rank.entries()].sort()).toEqual([...b.rank.entries()].sort());
    expect([...a.order.entries()].sort()).toEqual([...b.order.entries()].sort());
  });
  it('barycentric sweeps reduce crossings on a crafted crossing pair', () => {
    const ids = ['A', 'B', 'Y', 'Z'];
    const edges = [{ from: 'A', to: 'Z' }, { from: 'B', to: 'Y' }];
    const rank = assignRanks(ids, edges);
    const before = countCrossings(rank, orderRanks(rank, edges, 0), edges);
    const after = countCrossings(rank, orderRanks(rank, edges, 8), edges);
    expect(before).toBe(1);
    expect(after).toBe(0);
  });
  it('orderRanks with zero sweeps = sorted-id initial order (tie-break contract)', () => {
    const rank = new Map([['b', 0], ['a', 0], ['c', 0]]);
    const o = orderRanks(rank, [], 0);
    expect([o.get('a'), o.get('b'), o.get('c')]).toEqual([0, 1, 2]);
  });
  it('layeredLayout over the REAL rolled base is deterministic and fully ranked', () => {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'dag_base.json'), 'utf8'));
    const m = mergeGraph(base, null);
    const r = rollup(m, 'subsystem');
    const l1 = layeredLayout(r.nodes, r.edges);
    const l2 = layeredLayout([...r.nodes].reverse(), [...r.edges].reverse());
    expect(l1.rank.size).toBe(r.nodes.length);
    expect(l1.layerCount).toBeGreaterThan(1);
    expect([...l1.rank.entries()].sort()).toEqual([...l2.rank.entries()].sort());
    expect([...l1.order.entries()].sort()).toEqual([...l2.order.entries()].sort());
  });
});

// ---- seeded force-directed layout ----------------------------------------------------------------
describe('force layout (seeded, deterministic)', () => {
  const nodes = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => ({ id }));
  // two triangles A-B-C and D-E-F, joined by a single C-D bridge
  const edges = [
    { from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'A' },
    { from: 'D', to: 'E' }, { from: 'E', to: 'F' }, { from: 'F', to: 'D' },
    { from: 'C', to: 'D' },
  ];

  it('hashIds is stable and order-independent; mulberry32 is deterministic', () => {
    expect(hashIds(['A', 'B', 'C'])).toBe(hashIds(['C', 'B', 'A']));
    expect(hashIds(['A', 'B'])).not.toBe(hashIds(['A', 'C']));
    const r1 = mulberry32(123), r2 = mulberry32(123);
    const s1 = [r1(), r1(), r1()], s2 = [r2(), r2(), r2()];
    expect(s1).toEqual(s2);
    expect(s1[0]).toBeGreaterThanOrEqual(0); expect(s1[0]).toBeLessThan(1);
  });

  it('springPairs dedupes, drops self/dangling, and sorts canonically (order-independent)', () => {
    const idSet = new Set(['A', 'B', 'C']);
    const s1 = springPairs([{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }, { from: 'A', to: 'A' }, { from: 'A', to: 'Z' }], idSet);
    expect(s1.map((s) => s.key)).toEqual(['A~B']);
    const forward = springPairs([{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }], idSet);
    const reversed = springPairs([{ from: 'C', to: 'B' }, { from: 'B', to: 'A' }], idSet);
    expect(forward.map((s) => s.key)).toEqual(reversed.map((s) => s.key));
  });

  it('produces finite positions for every node (no NaN)', () => {
    const pos = forceLayout(nodes, edges, { iterations: 120 });
    expect(pos.size).toBe(6);
    for (const p of pos.values()) { expect(Number.isFinite(p.x)).toBe(true); expect(Number.isFinite(p.y)).toBe(true); }
  });

  it('is deterministic across input array permutations (owner spatial-memory requirement)', () => {
    const a = forceLayout(nodes, edges, { iterations: 200 });
    const b = forceLayout([...nodes].reverse(), [...edges].reverse(), { iterations: 200 });
    for (const id of nodes.map((n) => n.id)) {
      expect(a.get(id).x).toBeCloseTo(b.get(id).x, 6);
      expect(a.get(id).y).toBeCloseTo(b.get(id).y, 6);
    }
  });

  it('places connected nodes closer than unconnected ones (springs pull, repulsion pushes)', () => {
    const pos = forceLayout(nodes, edges, { iterations: 400 });
    const dist = (u, v) => Math.hypot(pos.get(u).x - pos.get(v).x, pos.get(u).y - pos.get(v).y);
    // A-B are edge-connected (same triangle); A-F are in different triangles, no edge
    expect(dist('A', 'B')).toBeLessThan(dist('A', 'F'));
    expect(dist('D', 'E')).toBeLessThan(dist('A', 'E'));
  });

  it('honors fixed pins: a pinned node stays exactly at its coordinate', () => {
    const fixed = new Map([['A', { x: 999, y: -777 }]]);
    const pos = forceLayout(nodes, edges, { iterations: 200, fixed });
    expect(pos.get('A').x).toBe(999);
    expect(pos.get('A').y).toBe(-777);
  });

  it('forceStep leaves a fixed node untouched but moves the rest', () => {
    const pos = new Map([['A', { x: 0, y: 0 }], ['B', { x: 50, y: 0 }], ['C', { x: 100, y: 0 }]]);
    const ids = ['A', 'B', 'C'];
    const springs = springPairs([{ from: 'A', to: 'B' }], new Set(ids));
    forceStep(pos, ids, springs, { k: 80, temp: 40, fixed: new Set(['A']) });
    expect(pos.get('A')).toEqual({ x: 0, y: 0 }); // pinned
    expect(pos.get('C').x !== 100 || pos.get('C').y !== 0).toBe(true); // free node moved
  });

  it('scales to the real rolled subsystem graph deterministically', () => {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'dag_base.json'), 'utf8'));
    const m = mergeGraph(base, null);
    const r = rollup(m, 'subsystem');
    const p1 = forceLayout(r.nodes, r.edges, { iterations: 60 });
    const p2 = forceLayout([...r.nodes].reverse(), [...r.edges].reverse(), { iterations: 60 });
    expect(p1.size).toBe(r.nodes.length);
    for (const n of r.nodes) {
      expect(Number.isFinite(p1.get(n.id).x)).toBe(true);
      expect(p1.get(n.id).x).toBeCloseTo(p2.get(n.id).x, 4);
    }
  });
});

// ---- hide-unlinked degree (owner add) ------------------------------------------------------------
describe('hide unlinked nodes (visibleDegree / linkedNodes)', () => {
  // A-B-C connected chain; D isolated; E-E self-loop only (internal edge)
  const nodes = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, label: id }));
  const edges = [
    { from: 'A', to: 'B' }, { from: 'B', to: 'C' },
    { from: 'E', to: 'E' },                 // self-loop / aggregated internal — NOT a connection
    { from: 'A', to: 'Z' },                 // dangling endpoint (Z absent) — ignored
  ];

  it('visibleDegree counts edges to other nodes only; self-loops and absent ids score 0', () => {
    const deg = visibleDegree(nodes.map((n) => n.id), edges);
    expect(deg.get('A')).toBe(1); // A-B (A-Z ignored: Z absent)
    expect(deg.get('B')).toBe(2); // A-B, B-C
    expect(deg.get('C')).toBe(1); // B-C
    expect(deg.get('D')).toBe(0); // isolated
    expect(deg.get('E')).toBe(0); // self-loop is not a connection
  });

  it('linkedNodes drops zero-visible-edge nodes (D isolated, E internal-only)', () => {
    const kept = linkedNodes(nodes, edges).map((n) => n.id);
    expect(kept).toEqual(['A', 'B', 'C']);
  });

  it('recomputes against the CURRENT visible edge set (fewer edges ⇒ more nodes drop)', () => {
    // simulate a filter removing the B-C edge: now only A-B survive as linked
    const filtered = edges.filter((e) => !(e.from === 'B' && e.to === 'C'));
    const kept = linkedNodes(nodes, filtered).map((n) => n.id);
    expect(kept).toEqual(['A', 'B']);
    // and with no visible edges at all, everything drops (honest empty)
    expect(linkedNodes(nodes, []).length).toBe(0);
  });
});

// ---- real-data smoke pass -------------------------------------------------------------------------
describe('real dag_base.json + dev fixture (smoke)', () => {
  const basePath = path.join(HERE, '..', 'dag_base.json');
  const fixturePath = path.join(HERE, 'fixtures', 'enrichment.fixture.json');

  it('merges and rolls up the committed base at every level without loss', () => {
    const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    const m = mergeGraph(base, null);
    expect(m.nodes.size).toBe(base.nodes.length);
    for (const level of ['subsystem', 'stage', 'boundary']) {
      const r = rollup(m, level);
      // every base node lands in exactly one group
      const total = r.nodes.reduce((a, n) => a + n.memberCount, 0);
      expect(total).toBe(base.nodes.length);
      // display graph stays far below module scale (never render all ~900+ modules):
      // require >=5:1 rollup compression — self-scaling as the base grows — plus a
      // hard display ceiling. (Was a stale absolute <160, set when the base was
      // smaller; the 2026-07-18 parity modules grew the rollup to exactly 160.)
      expect(r.nodes.length * 5).toBeLessThan(base.nodes.length);
      expect(r.nodes.length).toBeLessThan(250);
      // no edge lost: aggregate constituents + internal counts = deduped edge total
      const aggTotal = r.edges.reduce((a, e) => a + e.count, 0)
        + r.nodes.reduce((a, n) => a + n.internalEdgeCount, 0);
      expect(aggTotal).toBe(m.edges.length);
    }
  });

  it('fixture is loudly labeled and merges cleanly over the real base', () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    expect(fixture.fixture).toBe(true);
    expect(fixture.schema_version).toContain('FIXTURE');
    const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    const m = mergeGraph(base, fixture);
    expect(m.enrichment.fixture).toBe(true);
    // the deliberate ghost edge is kept + flagged
    const ghost = m.edges.find((e) => e.to === 'tools/fixture/nonexistent_ghost.mjs');
    expect(ghost && ghost.unknownEndpoint).toBe(true);
    // every fixture why-text is prefixed [FIXTURE] (LAW 3: never confusable with real docs)
    for (const info of Object.values(fixture.nodes)) {
      if (info.why) expect(info.why.text.startsWith('[FIXTURE]')).toBe(true);
    }
    for (const e of fixture.edges) {
      if (e.why) expect(e.why.text.startsWith('[FIXTURE]')).toBe(true);
    }
  });
});

// ---- clockdrive overlay (theses + proposals) --------------------------------------------------
describe('clockdrive overlay', () => {
  const THESIS = {
    id: 'thesis:THESIS-2026-07-10-001',
    title: 'Bright-pool sweep scoring restores rotation-sweep significance',
    status: 'dead',
    raw_status: 'PRE-REGISTERED | FAIL',
    detail: 'Founding AI-bucket entry.',
    source: 'test_results/theses/registry.jsonl',
    submitter_class: 'AI-RESEARCHER',
    anchors: ['test_results/theses/THESIS-2026-07-10-001.json', 42, '', 'tools/theses/x.mjs'],
  };
  const PROPOSAL = {
    id: 'proposal:DEC-2026-07-16-01',
    title: 'SPCC color term',
    status: 'approved',
    raw_status: 'state=OPEN, latest ruling action=approve',
    detail: 'Authorize sandbox prototyping.',
    source: 'test_results/theses/dashboard/owner_decisions.json',
    anchors: [],
  };

  it('exposes the recognized kind + status vocabulary', () => {
    expect(CLOCKDRIVE_KINDS).toEqual(['thesis', 'proposal']);
    expect(CLOCKDRIVE_STATUSES).toEqual(['pending', 'dead', 'adopted', 'approved']);
  });

  it('normalizeClockdriveEntry: overlay node carries kind, verbatim raw_status, and cleaned anchors', () => {
    const n = normalizeClockdriveEntry(THESIS, 'thesis');
    expect(n.kind).toBe('thesis');
    expect(n.id).toBe('thesis:THESIS-2026-07-10-001');
    expect(n.status).toBe('dead');
    expect(n.statusFlagged).toBe(false);
    expect(n.raw_status).toBe('PRE-REGISTERED | FAIL'); // verbatim provenance
    expect(n.submitter_class).toBe('AI-RESEARCHER');
    // anchors filtered to non-empty strings only (42 and '' dropped), never fabricated
    expect(n.anchors).toEqual(['test_results/theses/THESIS-2026-07-10-001.json', 'tools/theses/x.mjs']);
  });

  it('id stability: id preserved verbatim (namespaced), same input ⇒ same node', () => {
    const a = normalizeClockdriveEntry(PROPOSAL, 'proposal');
    const b = normalizeClockdriveEntry({ ...PROPOSAL }, 'proposal');
    expect(a.id).toBe('proposal:DEC-2026-07-16-01');
    expect(a.id.startsWith('proposal:')).toBe(true);
    expect(a).toEqual(b);
  });

  it('status mapping: unknown status passes through as pending + flagged (honest, never hidden)', () => {
    const n = normalizeClockdriveEntry({ id: 'thesis:x', status: 'RUNNING-forever' }, 'thesis');
    expect(n.status).toBe('pending');
    expect(n.statusFlagged).toBe(true);
    // a missing status is likewise pending+flagged (nothing invented)
    const m2 = normalizeClockdriveEntry({ id: 'thesis:y' }, 'thesis');
    expect(m2.status).toBe('pending');
    expect(m2.statusFlagged).toBe(true);
    // a KNOWN status is never flagged
    expect(normalizeClockdriveEntry({ id: 'thesis:z', status: 'ADOPTED' }, 'thesis').statusFlagged).toBe(false);
    expect(normalizeClockdriveEntry({ id: 'thesis:z', status: 'ADOPTED' }, 'thesis').status).toBe('adopted');
  });

  it('drops entries with no stable id (never invents a keyless node)', () => {
    expect(normalizeClockdriveEntry({ title: 'no id' }, 'thesis')).toBe(null);
    expect(normalizeClockdriveEntry({ id: '   ' }, 'thesis')).toBe(null);
    expect(normalizeClockdriveEntry(null, 'thesis')).toBe(null);
  });

  it('normalizeClockdrive: theses first, then proposals; input order preserved within kind', () => {
    const list = normalizeClockdrive({ theses: [THESIS], proposals: [PROPOSAL] });
    expect(list.map((n) => n.id)).toEqual(['thesis:THESIS-2026-07-10-001', 'proposal:DEC-2026-07-16-01']);
    expect(list.map((n) => n.kind)).toEqual(['thesis', 'proposal']);
  });

  it('absent overlay is honest-empty at every level (null, {}, missing keys, non-arrays)', () => {
    expect(normalizeClockdrive(null)).toEqual([]);
    expect(normalizeClockdrive(undefined)).toEqual([]);
    expect(normalizeClockdrive({})).toEqual([]);
    expect(normalizeClockdrive({ theses: null, proposals: 'nope' })).toEqual([]);
    // one file absent ⇒ only the present list contributes (its rows, honestly)
    expect(normalizeClockdrive({ theses: [THESIS] }).map((n) => n.id)).toEqual(['thesis:THESIS-2026-07-10-001']);
    expect(normalizeClockdrive({ proposals: [PROPOSAL] }).map((n) => n.id)).toEqual(['proposal:DEC-2026-07-16-01']);
  });

  it('dedupes by id keeping the first occurrence (belt-and-suspenders on namespaced ids)', () => {
    const dup = { ...PROPOSAL, title: 'second' };
    const list = normalizeClockdrive({ theses: [{ id: 'proposal:DEC-2026-07-16-01', title: 'first', status: 'pending' }], proposals: [dup] });
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('first');
  });

  it('annotation keying works UNCHANGED on thesis:/proposal: ids (comments carry)', () => {
    // the panel targets {node:<id>} — the SAME keying used everywhere else
    expect(annotationKeyFor({ node: 'thesis:THESIS-2026-07-10-001' })).toBe('node:thesis:THESIS-2026-07-10-001');
    expect(annotationKeyFor({ node: 'proposal:DEC-2026-07-16-01' })).toBe('node:proposal:DEC-2026-07-16-01');
    const anns = [
      { id: 'a1', kind: 'comment', text: 'is this still live?', target: { node: 'thesis:THESIS-2026-07-10-001' } },
      { id: 'a2', kind: 'question', text: 'scope?', target: { node: 'proposal:DEC-2026-07-16-01' } },
    ];
    const idx = indexAnnotations(anns);
    const n = normalizeClockdriveEntry(THESIS, 'thesis');
    expect(idx.get(`node:${n.id}`).length).toBe(1);
    expect(idx.get(`node:${n.id}`)[0].text).toBe('is this still live?');
  });

  it('clockdriveAnchorGroup: exact module match → its group; else subsystem bucket; junk → null', () => {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'dag_base.json'), 'utf8'));
    const merged = mergeGraph(base, null);
    const idx = buildStagePathIndex(merged.nodes);
    // a test_results/ anchor resolves to a first-segment subsystem bucket the graph
    // never renders (subsystemOf only splits src/engine/tools deeper) → no line drawn
    expect(clockdriveAnchorGroup('test_results/theses/x.json', merged, 'subsystem', idx))
      .toBe('subsystem:test_results');
    // a tools/ anchor buckets one level deeper (would resolve IF that lane is rendered)
    expect(clockdriveAnchorGroup('tools/psf/decode_cr2.mjs', merged, 'subsystem', idx))
      .toBe('subsystem:tools/psf');
    expect(clockdriveAnchorGroup('', merged, 'subsystem', idx)).toBe(null);
    expect(clockdriveAnchorGroup(null, merged, 'subsystem', idx)).toBe(null);
  });
});
