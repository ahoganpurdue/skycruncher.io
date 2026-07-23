/**
 * Gate for the DAG enrichment layer (tools/dag/enrich/).
 *
 * Proves the committed enrichment.json is:
 *   • SCHEMA-VALID — versioned, 4-state verification enum, ratified edge types.
 *   • REFERENTIALLY SOUND vs the READ-ONLY base — every edge endpoint is a
 *     dag_base.json node id or a node this layer declares WITH provenance.
 *   • HONEST — every VERIFIED/REFUTED edge carries a cite; every non-null why
 *     carries >= 1 cite (LAW 3: no cite -> why stays null).
 *   • CLEAN — no absolute paths / drive letters / backslashes (public-later).
 *   • DETERMINISTIC — a rebuild from the committed fragments is byte-identical
 *     to the committed enrichment.json (drift gate for THIS layer).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildEnrichment,
  serializeEnrichment,
  EDGE_TYPES,
  VERIFICATION_STATES,
  ENRICHMENT_SCHEMA_VERSION,
} from './build_enrichment.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const enrichment = JSON.parse(readFileSync(path.join(HERE, 'enrichment.json'), 'utf8'));
const base = JSON.parse(readFileSync(path.join(HERE, '..', 'dag_base.json'), 'utf8'));
const baseIds = new Set(base.nodes.map((n) => n.id));
const declaredIds = new Set(Object.keys(enrichment.nodes));

describe('DAG enrichment layer', () => {
  it('carries the schema version and a commit stamp', () => {
    expect(enrichment.schema_version).toBe(ENRICHMENT_SCHEMA_VERSION);
    expect(typeof enrichment.generated_at_commit).toBe('string');
    expect(enrichment.generated_at_commit.length).toBeGreaterThan(0);
  });

  it('every edge uses a ratified type and a valid verification state', () => {
    expect(enrichment.edges.length).toBeGreaterThan(0);
    for (const e of enrichment.edges) {
      expect(EDGE_TYPES.has(e.type), `edge type '${e.type}'`).toBe(true);
      expect(VERIFICATION_STATES.has(e.verification), `verification '${e.verification}'`).toBe(true);
    }
  });

  it('edge endpoints resolve to base nodes or provenance-badged declared nodes', () => {
    for (const e of enrichment.edges) {
      for (const end of [e.from, e.to]) {
        expect(
          baseIds.has(end) || declaredIds.has(end),
          `endpoint '${end}' unresolved`,
        ).toBe(true);
      }
    }
    for (const [id, n] of Object.entries(enrichment.nodes)) {
      if (baseIds.has(id)) continue;
      const provenanced =
        (id.startsWith('stage:') && n.badges?.observed_in) ||
        (id.startsWith('external:') && n.badges?.external_dependency);
      expect(!!provenanced, `declared node '${id}' lacks provenance`).toBe(true);
    }
  });

  it('every VERIFIED or REFUTED edge carries a cite', () => {
    for (const e of enrichment.edges) {
      if (e.verification === 'VERIFIED' || e.verification === 'REFUTED') {
        expect(typeof e.cite, `${e.from} -> ${e.to} (${e.type})`).toBe('string');
        expect(e.cite.length).toBeGreaterThan(0);
      }
    }
  });

  it('every non-null why carries at least one cite with a path (LAW 3)', () => {
    for (const [id, n] of Object.entries(enrichment.nodes)) {
      if (n.why == null) continue;
      expect(typeof n.why.text, `why.text on ${id}`).toBe('string');
      expect(Array.isArray(n.why.cites) && n.why.cites.length > 0, `why cites on ${id}`).toBe(true);
      for (const c of n.why.cites) {
        expect(typeof c.path, `cite path on ${id}`).toBe('string');
        expect(c.path.length).toBeGreaterThan(0);
      }
    }
  });

  it('has no absolute paths anywhere in the JSON', () => {
    const json = readFileSync(path.join(HERE, 'enrichment.json'), 'utf8');
    expect(/[A-Za-z]:[\\/]/.test(json)).toBe(false);
    // UNC / Windows backslash separators — mirror serializeEnrichment's own
    // guard (json.includes('\\\\')). A lone backslash also appears as the JSON
    // escape for a double-quote (\") in legitimate owner-facing `copy` prose, so
    // the path-hygiene gate targets the double-backslash of a real path, not
    // every escaped quote. Drive letters (above), leading-slash unix paths and
    // /mnt/ (below) still catch the other absolute-path forms.
    expect(json.includes('\\\\')).toBe(false);
    expect(/"\/[A-Za-z]/.test(json)).toBe(false);
    expect(json.includes('/mnt/')).toBe(false);
  });

  it('rebuild from committed fragments is byte-identical (enrichment drift gate)', () => {
    const rebuilt = serializeEnrichment(buildEnrichment(HERE));
    const committed = readFileSync(path.join(HERE, 'enrichment.json'), 'utf8');
    // generated_at_commit tracks HEAD and differs across commits by design —
    // compare with the stamp normalized out (same rule as the base drift gate).
    // EOL also normalized: git autocrlf rewrites the committed file to CRLF on
    // Windows checkouts while the rebuild emits LF — content identity is the
    // contract, platform EOL is not (same lesson as check_dag_drift.mjs).
    const norm = (s) => s
        .replace(/\r\n/g, '\n')
        .replace(/"generated_at_commit": "[^"]*"/, '"generated_at_commit": "X"');
    expect(norm(rebuilt)).toBe(norm(committed));
  });

  it('stage-order edges from receipt replay are VERIFIED and cite the receipt', () => {
    const so = enrichment.edges.filter((e) => e.type === 'stage-order');
    expect(so.length).toBeGreaterThan(0);
    for (const e of so) {
      expect(e.verification).toBe('VERIFIED');
      expect(e.cite.startsWith('test_results/')).toBe(true);
      expect(Array.isArray(e.walked_by) && e.walked_by.length > 0).toBe(true);
    }
  });
});

// ── copy-field support (owner-facing prose, same discipline as why) ─────────
// These build from throwaway fixtures so they exercise the merge/validate path
// in isolation from the committed fragments (which the suite above covers).
describe('DAG enrichment — copy field', () => {
  // Minimal base with two nodes so a fixture can hang a copy off a base id
  // without needing a provenance badge.
  const BASE = { nodes: [{ id: 'stage:x' }, { id: 'stage:y' }] };

  function fixture(fragments) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'enrich-copy-'));
    const enrichDir = path.join(tmp, 'enrich');
    mkdirSync(path.join(enrichDir, 'fragments'), { recursive: true });
    writeFileSync(path.join(tmp, 'dag_base.json'), JSON.stringify(BASE));
    for (const [name, content] of Object.entries(fragments)) {
      writeFileSync(path.join(enrichDir, 'fragments', name), JSON.stringify(content));
    }
    return { tmp, enrichDir };
  }

  const goodCopy = { text: 'What the reader sees here.', cites: [{ path: 'docs/a.md', lines: '1-2' }] };

  it('a valid copy block passes and is serialized under the node', () => {
    const { tmp, enrichDir } = fixture({
      'a_copy.json': { nodes: { 'stage:x': { copy: goodCopy } } },
    });
    try {
      const enr = buildEnrichment(enrichDir);
      expect(enr.nodes['stage:x'].copy.text).toBe(goodCopy.text);
      expect(enr.nodes['stage:x'].copy.cites[0].path).toBe('docs/a.md');
      // survives serialization (path hygiene) too.
      expect(serializeEnrichment(enr)).toContain('What the reader sees here.');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('a copy with no cites fails the build (LAW 3)', () => {
    const { tmp, enrichDir } = fixture({
      'a_copy.json': { nodes: { 'stage:x': { copy: { text: 'orphan prose', cites: [] } } } },
    });
    try {
      expect(() => buildEnrichment(enrichDir)).toThrow(/copy with no cites/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the same node getting copy from two fragments is a collision', () => {
    const { tmp, enrichDir } = fixture({
      'a_copy.json': { nodes: { 'stage:x': { copy: goodCopy } } },
      'b_copy.json': { nodes: { 'stage:x': { copy: goodCopy } } },
    });
    try {
      expect(() => buildEnrichment(enrichDir)).toThrow(/copy collision on node stage:x/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('a node with no copy is fine (copy omitted from output)', () => {
    const { tmp, enrichDir } = fixture({
      'a_copy.json': { nodes: { 'stage:x': { walked_by: ['fits'] } } },
    });
    try {
      const enr = buildEnrichment(enrichDir);
      expect(enr.nodes['stage:x'].copy).toBeUndefined();
      expect(enr.nodes['stage:x'].walked_by).toEqual(['fits']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
