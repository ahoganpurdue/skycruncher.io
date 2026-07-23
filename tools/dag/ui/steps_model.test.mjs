// ============================================================================
// tools/dag/ui/steps_model.test.mjs — vitest suite for the curated step-map model
// (dual-rendering Phase 3). Pure-function tests over a small synthetic map, plus a
// smoke pass over the REAL committed tools/dag/steps/steps_map.json.
// Collected by the root vitest config (tools/**/*.test.mjs) → `npx vitest run tools/dag`.
// ============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STEP_FILE_TYPE_TAGS, STEP_MARKER_TAGS, STEP_KINDS, STEP_OBSERVED,
  firstWords, buildStepTree, stepMatchesFileType, presentFileTypeTags,
  stepBadges, parseFlag, stepFlags, stepGraph, orphanAnnotations,
} from './steps_model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEPS_MAP_PATH = path.join(HERE, '..', 'steps', 'steps_map.json');

// ---- synthetic mini-map -------------------------------------------------------
const MAP = {
  schema_version: '0.1.0-steps',
  map_version: '1.0',
  scope: 'full_pipeline',
  chapters: [{ n: 1, title: 'Entry', segment: 'E', orders: [1, 1] }],
  steps: [
    {
      id: 'step:entry', title: 'Choose entry', parent: null, order: 1, kind: 'interface',
      observed: 'code-derived', tags: ['fits', 'cr2-raw', 'jpeg-tiff', 'interface'],
      narrative: 'Five surfaces funnel into one engine.',
      visible_at_this_point: ['raw bytes'], anchors: ['stage:load'],
      branches_to: ['step:entry.wizard', 'step:entry.batch'], converges_to: 'step:metadata',
      cites: [{ path: 'src/engine/pipeline/orchestrator_session.ts', lines: '624-630' }],
      flags: ['RULED 2026-07-17 (DEC-2026-07-17-02, defaults): five sibling arms CONFIRMED. [orig question] confirm this granularity vs folding them back.'],
    },
    {
      id: 'step:entry.wizard', title: 'Interactive wizard', parent: 'step:entry', order: 1, kind: 'pipeline',
      observed: 'code-derived', tags: ['fits', 'interface'], narrative: 'Default surface.',
      visible_at_this_point: [], anchors: [], branches_to: [], converges_to: null, cites: [], flags: [],
    },
    {
      id: 'step:entry.batch', title: 'Batch queue', parent: 'step:entry', order: 2, kind: 'branch-point',
      observed: 'code-derived', tags: ['batch'], narrative: 'Folder queue.',
      visible_at_this_point: [], anchors: [], branches_to: [], converges_to: 'step:metadata', cites: [],
      flags: ['MERGE (2026-07-17): superseded by entry.'],
    },
    {
      id: 'step:metadata', title: 'Read metadata', parent: null, order: 2, kind: 'pipeline',
      observed: 'receipt', tags: ['fits', 'cr2-raw'], narrative: 'Metadata reaper.',
      visible_at_this_point: ['exif'], anchors: ['stage:metrology'], branches_to: [], converges_to: 'step:decode',
      cites: [{ path: 'src/engine/pipeline/m1_ingestion/metadata_reaper.ts' }], flags: [],
    },
  ],
};

// ---- firstWords ---------------------------------------------------------------
describe('firstWords', () => {
  it('takes the first n words and ellipsizes when longer', () => {
    expect(firstWords('one two three four', 3)).toBe('one two three…');
  });
  it('does not ellipsize when within n', () => {
    expect(firstWords('one two', 3)).toBe('one two');
  });
  it('returns empty string for empty/absent (never invented)', () => {
    expect(firstWords('')).toBe('');
    expect(firstWords(null)).toBe('');
    expect(firstWords(undefined)).toBe('');
  });
  it('collapses whitespace', () => {
    expect(firstWords('a   b\n c', 2)).toBe('a b…');
  });
});

// ---- buildStepTree ------------------------------------------------------------
describe('buildStepTree', () => {
  it('splits majors and nests subs sorted by order', () => {
    const t = buildStepTree(MAP);
    expect(t.majors.map((m) => m.id)).toEqual(['step:entry', 'step:metadata']);
    expect(t.majors[0].subs.map((s) => s.id)).toEqual(['step:entry.wizard', 'step:entry.batch']);
    expect(t.majors[1].subs).toEqual([]);
  });
  it('reports correct meta counts', () => {
    const t = buildStepTree(MAP);
    expect(t.meta.step_count).toBe(4);
    expect(t.meta.major_count).toBe(2);
    expect(t.meta.sub_count).toBe(2);
  });
  it('does not mutate the input steps', () => {
    const before = JSON.stringify(MAP.steps[0]);
    buildStepTree(MAP);
    expect(JSON.stringify(MAP.steps[0])).toBe(before);
    expect(MAP.steps[0].subs).toBeUndefined();
  });
  it('is total on an empty/absent map (honest empty, never throws)', () => {
    expect(buildStepTree(null).majors).toEqual([]);
    expect(buildStepTree({}).majors).toEqual([]);
  });
});

// ---- file-type matching -------------------------------------------------------
describe('stepMatchesFileType / presentFileTypeTags', () => {
  it('no filter matches everything', () => {
    expect(stepMatchesFileType(MAP.steps[2], null)).toBe(true);
    expect(stepMatchesFileType(MAP.steps[2], '')).toBe(true);
  });
  it('matches only when the step carries the file-type tag', () => {
    expect(stepMatchesFileType(MAP.steps[0], 'cr2-raw')).toBe(true);   // entry has cr2-raw
    expect(stepMatchesFileType(MAP.steps[1], 'cr2-raw')).toBe(false);  // wizard is fits-only
    expect(stepMatchesFileType(MAP.steps[2], 'fits')).toBe(false);     // batch has no file-type tag
  });
  it('a step with no file-type tags never matches a specific filter', () => {
    expect(stepMatchesFileType(MAP.steps[2], 'jpeg-tiff')).toBe(false);
  });
  it('presentFileTypeTags returns canonical-ordered present tags', () => {
    expect(presentFileTypeTags(MAP)).toEqual(['fits', 'cr2-raw', 'jpeg-tiff']);
  });
});

// ---- badges -------------------------------------------------------------------
describe('stepBadges', () => {
  it('separates file-type tags from marker tags and carries kind/observed', () => {
    const b = stepBadges(MAP.steps[0]);
    expect(b.kind).toBe('interface');
    expect(b.observed).toBe('code-derived');
    expect(b.fileTypeTags).toEqual(['fits', 'cr2-raw', 'jpeg-tiff']);
    expect(b.markerTags).toEqual(['interface']);
  });
  it('is total on a bare step', () => {
    const b = stepBadges({});
    expect(b.kind).toBeNull();
    expect(b.fileTypeTags).toEqual([]);
    expect(b.markerTags).toEqual([]);
  });
});

// ---- parseFlag / stepFlags ----------------------------------------------------
describe('parseFlag', () => {
  it('parses a RULED flag with code, date, ruling and orig question', () => {
    const f = parseFlag('RULED 2026-07-17 (DEC-2026-07-17-02, defaults): five arms CONFIRMED. [orig question] confirm this vs folding.');
    expect(f.kind).toBe('RULED');
    expect(f.ruled).toBe(true);
    expect(f.date).toBe('2026-07-17');
    expect(f.code).toBe('DEC-2026-07-17-02');
    expect(f.ruling).toBe('five arms CONFIRMED.');
    expect(f.origQuestion).toBe('confirm this vs folding.');
  });
  it('parses a MERGE flag with a bare date paren', () => {
    const f = parseFlag('MERGE (2026-07-17): step:upload is superseded by entry.');
    expect(f.kind).toBe('MERGE');
    expect(f.ruled).toBe(false);
    expect(f.ruling).toBe('step:upload is superseded by entry.');
    expect(f.origQuestion).toBeNull();
  });
  it('flags RULING-NEEDED as needing a ruling', () => {
    const f = parseFlag('RULING-NEEDED: is this a real decision boundary?');
    expect(f.needsRuling).toBe(true);
    expect(f.ruled).toBe(false);
  });
  it('keeps unrecognised strings verbatim (never dropped)', () => {
    const f = parseFlag('some freeform note without a keyword');
    expect(f.kind).toBe('FLAG');
    expect(f.ruling).toBe('some freeform note without a keyword');
  });
  it('stepFlags maps all flags on a step', () => {
    const fs2 = stepFlags(MAP.steps[0]);
    expect(fs2).toHaveLength(1);
    expect(fs2[0].kind).toBe('RULED');
    expect(stepFlags(MAP.steps[1])).toEqual([]);
  });
});

// ---- stepGraph ----------------------------------------------------------------
describe('stepGraph', () => {
  it('emits a node per step and contains/branch/converge edges', () => {
    const g = stepGraph(MAP);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(
      ['step:entry', 'step:entry.batch', 'step:entry.wizard', 'step:metadata'].sort());
    // contains edges: entry→wizard, entry→batch
    expect(g.edges).toContainEqual({ from: 'step:entry', to: 'step:entry.wizard', rel: 'contains' });
    expect(g.edges).toContainEqual({ from: 'step:entry', to: 'step:entry.batch', rel: 'contains' });
    // branch edges from entry.branches_to
    expect(g.edges).toContainEqual({ from: 'step:entry', to: 'step:entry.wizard', rel: 'branch' });
    // converge edges (only to resolvable step targets)
    expect(g.edges).toContainEqual({ from: 'step:entry', to: 'step:metadata', rel: 'converge' });
  });
  it('drops edges to non-existent steps into unresolved, never fabricates a node', () => {
    const g = stepGraph(MAP);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has('step:decode')).toBe(false);
    expect(g.unresolved).toContainEqual({ from: 'step:metadata', to: 'step:decode', rel: 'converge' });
    // every retained edge has both endpoints as real nodes
    for (const e of g.edges) { expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true); }
  });
  it('marks majors and subs', () => {
    const g = stepGraph(MAP);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get('step:entry').isMajor).toBe(true);
    expect(byId.get('step:entry.wizard').isMajor).toBe(false);
    expect(byId.get('step:entry.wizard').parent).toBe('step:entry');
  });
  it('is deterministic (no dupes, stable across runs)', () => {
    const a = JSON.stringify(stepGraph(MAP));
    const b = JSON.stringify(stepGraph(MAP));
    expect(a).toBe(b);
  });
});

// ---- orphanAnnotations --------------------------------------------------------
describe('orphanAnnotations', () => {
  const resolvable = new Set(['stage:solve', 'src/main.tsx', 'subsystem:engine/core', 'step:entry']);
  it('flags a node annotation whose id no longer resolves', () => {
    const anns = [{ id: 'a1', kind: 'comment', text: 'gone node comment here', target: { node: 'stage:vanished' } }];
    const o = orphanAnnotations(anns, resolvable);
    expect(o).toHaveLength(1);
    expect(o[0].targetKind).toBe('node');
    expect(o[0].targetLabel).toBe('stage:vanished');
    expect(o[0].firstWords).toBe('gone node comment here');
  });
  it('does NOT flag a node annotation that resolves', () => {
    const anns = [{ id: 'a2', kind: 'comment', text: 'ok', target: { node: 'stage:solve' } }];
    expect(orphanAnnotations(anns, resolvable)).toEqual([]);
  });
  it('flags an edge annotation when EITHER endpoint is missing, listing the missing id', () => {
    const anns = [{ id: 'e1', kind: 'drawn-edge', text: 'draw this edge please', target: { edge: { from: 'src/main.tsx', to: 'stage:ghost', type: 'owner-drawn' } } }];
    const o = orphanAnnotations(anns, resolvable);
    expect(o).toHaveLength(1);
    expect(o[0].targetKind).toBe('edge');
    expect(o[0].unresolved).toEqual(['stage:ghost']);
  });
  it('does NOT flag an edge whose both endpoints resolve', () => {
    const anns = [{ id: 'e2', kind: 'comment', text: 'ok', target: { edge: { from: 'src/main.tsx', to: 'stage:solve', type: 'import' } } }];
    expect(orphanAnnotations(anns, resolvable)).toEqual([]);
  });
  it('carries a retargeted note through when present', () => {
    const anns = [{ id: 'r1', kind: 'comment', text: 'x', retargeted: 'migrated 2026', target: { node: 'stage:vanished' } }];
    expect(orphanAnnotations(anns, resolvable)[0].retargeted).toBe('migrated 2026');
  });
  it('is total on empty input', () => {
    expect(orphanAnnotations(null, resolvable)).toEqual([]);
    expect(orphanAnnotations([], null)).toEqual([]);
  });
});

// ---- REAL committed map smoke -------------------------------------------------
describe('real steps_map.json smoke', () => {
  const present = fs.existsSync(STEPS_MAP_PATH);
  it('the committed curated map is present in this checkout', () => {
    expect(present).toBe(true);
  });
  (present ? it : it.skip)('parses into a well-formed 2-level tree with unique ids', () => {
    const map = JSON.parse(fs.readFileSync(STEPS_MAP_PATH, 'utf8'));
    const tree = buildStepTree(map);
    expect(tree.majors.length).toBeGreaterThan(0);
    // unique ids across the whole map
    const ids = map.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // every sub's parent is a real major
    const majorIds = new Set(tree.majors.map((m) => m.id));
    for (const mj of tree.majors) for (const sub of mj.subs) expect(majorIds.has(sub.parent)).toBe(true);
    // every step's kind is recognised
    for (const s of map.steps) expect(STEP_KINDS).toContain(s.kind);
    // every step's observed is recognised
    for (const s of map.steps) expect(STEP_OBSERVED).toContain(s.observed);
  });
  (present ? it : it.skip)('every graph edge endpoint is a real step (no fabricated targets)', () => {
    const map = JSON.parse(fs.readFileSync(STEPS_MAP_PATH, 'utf8'));
    const g = stepGraph(map);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) { expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true); }
    expect(g.nodes.length).toBe(map.steps.length);
  });
  (present ? it : it.skip)('presentFileTypeTags is a subset of the canonical file-type set', () => {
    const map = JSON.parse(fs.readFileSync(STEPS_MAP_PATH, 'utf8'));
    for (const t of presentFileTypeTags(map)) expect(STEP_FILE_TYPE_TAGS).toContain(t);
  });
  (present ? it : it.skip)('flags parse without throwing and preserve raw text', () => {
    const map = JSON.parse(fs.readFileSync(STEPS_MAP_PATH, 'utf8'));
    for (const s of map.steps) for (const f of stepFlags(s)) expect(typeof f.raw).toBe('string');
  });
});
