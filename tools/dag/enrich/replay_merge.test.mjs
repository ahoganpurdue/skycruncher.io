/**
 * Unit gate for the stage-order UNION-MERGE (mergeStageOrder in
 * replay_stage_order.js) — the mechanism that accumulates more than one
 * file-type's walk into the single committed fragments/stage_order.json.
 *
 * Fully SYNTHETIC: constructs fragment objects inline, depends on NO banked
 * receipt (test_results/ is gitignored/local). Proves the design contract:
 *   • IDENTITY — merge(null, walk) === walk (single-source byte-identity, the
 *     legacy-overwrite reproduction contract).
 *   • UNION — shared nodes/edges get walked_by set-union; cr2-only nodes/edges
 *     are appended with their own cite; existing order is preserved.
 *   • BADGES — same-key/same-value kept; same-key/different-value keeps existing
 *     and records the incoming value in a deduped merge_notes badge; an incoming
 *     new badge key is added.
 *   • IDEMPOTENT — merging the same walk twice is byte-stable.
 */

import { describe, it, expect } from 'vitest';
import { mergeStageOrder } from './replay_stage_order.js';

const how = { what: 'x', transform: 'y', lossy: false };
const edge = (from, to, cite, walked_by) => ({
  from,
  to,
  type: 'stage-order',
  cite,
  verification: 'VERIFIED',
  how,
  walked_by,
});

// A fits-only fragment (the shape replayStageOrder emits).
function fitsFragment() {
  const cite = 'test_results/fits/receipt.json';
  return {
    fragment: 'stage_order',
    derived_by: 'replay_stage_order.js (mechanical, zero-LLM)',
    notes: ['replayed a solved fits receipt'],
    nodes: {
      'stage:load': { why: null, walked_by: ['fits'], badges: { observed_in: cite, receipt_version: '2.27.0' } },
      'stage:solve': { why: null, walked_by: ['fits'], badges: { observed_in: cite, receipt_version: '2.27.0', receipt_write: 'solution' } },
      'stage:calibrate': { why: null, walked_by: ['fits'], badges: { observed_in: cite, receipt_version: '2.27.0' } },
    },
    edges: [
      edge('stage:load', 'stage:solve', cite, ['fits']),
      edge('stage:solve', 'stage:calibrate', cite, ['fits']),
    ],
  };
}

// A cr2 walk: shares solve+calibrate, adds a cr2-only node + edge; conflicting
// observed_in/receipt_version, an additive badge, and a same-value receipt_write.
function cr2Walk() {
  const cite = 'test_results/dag_receipts/cr2.receipt.json';
  return {
    fragment: 'stage_order',
    derived_by: 'replay_stage_order.js (mechanical, zero-LLM)',
    notes: ['replayed a solved cr2 receipt'],
    nodes: {
      'stage:solve': {
        why: null,
        walked_by: ['cr2'],
        badges: { observed_in: cite, receipt_version: '2.28.0', receipt_write: 'solution', extra: true },
      },
      'stage:calibrate': { why: null, walked_by: ['cr2'], badges: { observed_in: cite, receipt_version: '2.27.0' } },
      'stage:cr2_only': { why: null, walked_by: ['cr2'], badges: { observed_in: cite, receipt_version: '2.27.0' } },
    },
    edges: [
      edge('stage:solve', 'stage:calibrate', cite, ['cr2']), // SHARED adjacency
      edge('stage:calibrate', 'stage:cr2_only', cite, ['cr2']), // cr2-only adjacency
    ],
  };
}

describe('mergeStageOrder — union-merge semantics', () => {
  it('IDENTITY: merge(null, walk) returns the walk unchanged (single-source byte-identity)', () => {
    const w = cr2Walk();
    expect(mergeStageOrder(null, w)).toBe(w);
    expect(JSON.stringify(mergeStageOrder(null, w))).toBe(JSON.stringify(w));
  });

  it('does not mutate the existing fragment passed in', () => {
    const existing = fitsFragment();
    const snapshot = JSON.stringify(existing);
    mergeStageOrder(existing, cr2Walk());
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it('UNION: shared node walked_by is the sorted set-union', () => {
    const m = mergeStageOrder(fitsFragment(), cr2Walk());
    expect(m.nodes['stage:solve'].walked_by).toEqual(['cr2', 'fits']);
    expect(m.nodes['stage:calibrate'].walked_by).toEqual(['cr2', 'fits']);
    // fits-only node untouched.
    expect(m.nodes['stage:load'].walked_by).toEqual(['fits']);
  });

  it('appends the cr2-only node AFTER the existing nodes (order preserved)', () => {
    const m = mergeStageOrder(fitsFragment(), cr2Walk());
    expect(Object.keys(m.nodes)).toEqual(['stage:load', 'stage:solve', 'stage:calibrate', 'stage:cr2_only']);
    expect(m.nodes['stage:cr2_only'].walked_by).toEqual(['cr2']);
    expect(m.nodes['stage:cr2_only'].badges.observed_in).toBe('test_results/dag_receipts/cr2.receipt.json');
  });

  it('UNION on edges: shared adjacency gets both tags; cr2-only edge appended with its own cite', () => {
    const m = mergeStageOrder(fitsFragment(), cr2Walk());
    const shared = m.edges.find((e) => e.from === 'stage:solve' && e.to === 'stage:calibrate');
    expect(shared.walked_by).toEqual(['cr2', 'fits']);
    expect(shared.cite).toBe('test_results/fits/receipt.json'); // existing cite kept
    const cr2Only = m.edges.find((e) => e.from === 'stage:calibrate' && e.to === 'stage:cr2_only');
    expect(cr2Only).toBeTruthy();
    expect(cr2Only.walked_by).toEqual(['cr2']);
    expect(cr2Only.cite).toBe('test_results/dag_receipts/cr2.receipt.json');
    // Existing fits edges stay first (load->solve, solve->calibrate), cr2-only last.
    expect(m.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      'stage:load->stage:solve',
      'stage:solve->stage:calibrate',
      'stage:calibrate->stage:cr2_only',
    ]);
  });

  it('BADGES: same-key different-value keeps existing and records the incoming in merge_notes', () => {
    const m = mergeStageOrder(fitsFragment(), cr2Walk());
    const b = m.nodes['stage:solve'].badges;
    expect(b.observed_in).toBe('test_results/fits/receipt.json'); // existing kept
    expect(b.receipt_version).toBe('2.27.0'); // existing kept
    expect(b.receipt_write).toBe('solution'); // same value, untouched
    expect(b.extra).toBe(true); // additive incoming badge key added
    // Both conflicts cited (observed_in + receipt_version), tagged by the cr2 walk.
    // Note text carries NO embedded quotes (public-hygiene no-backslash gate).
    expect(b.merge_notes).toContain('observed_in=test_results/dag_receipts/cr2.receipt.json from cr2 walk');
    expect(b.merge_notes).toContain('receipt_version=2.28.0 from cr2 walk');
    expect(b.merge_notes.length).toBe(2);
    // No backslash may reach the note (would escape into the built enrichment.json).
    expect(b.merge_notes.some((n) => n.includes('\\'))).toBe(false);
  });

  it('regenerates notes from the merged graph (filetype coverage + counts)', () => {
    const m = mergeStageOrder(fitsFragment(), cr2Walk());
    expect(m.notes[0]).toBe('union-merged stage-order walk covering filetype(s): cr2, fits');
    expect(m.notes[1]).toBe('4 unique runtime stage ids, 3 VERIFIED stage-order edges');
    expect(m.derived_by).toBe('replay_stage_order.js union-merge (mechanical, zero-LLM)');
  });

  it('IDEMPOTENT: merging the same walk twice is byte-stable', () => {
    const m1 = mergeStageOrder(fitsFragment(), cr2Walk());
    const m2 = mergeStageOrder(m1, cr2Walk());
    expect(JSON.stringify(m2)).toBe(JSON.stringify(m1));
    // No duplicate edges introduced.
    const keys = m2.edges.map((e) => `${e.from} ${e.to} ${e.type}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('IDEMPOTENT under swapped order too: fits∪cr2 has the same edge/node sets as cr2∪fits', () => {
    const a = mergeStageOrder(fitsFragment(), cr2Walk());
    const b = mergeStageOrder(cr2Walk(), fitsFragment());
    const nodeSet = (m) => new Set(Object.keys(m.nodes));
    const edgeSet = (m) => new Set(m.edges.map((e) => `${e.from} ${e.to} ${e.type}`));
    expect([...nodeSet(a)].sort()).toEqual([...nodeSet(b)].sort());
    expect([...edgeSet(a)].sort()).toEqual([...edgeSet(b)].sort());
    // walked_by set-union is order-independent for shared endpoints.
    expect(a.nodes['stage:solve'].walked_by).toEqual(b.nodes['stage:solve'].walked_by);
  });
});
