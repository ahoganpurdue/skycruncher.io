// Enrichment builder — merges fragments/*.json into the committed
// tools/dag/enrich/enrichment.json artifact.
//
// The enrichment layer is the TYPED SEMANTIC overlay on the mechanical base
// graph (tools/dag/dag_base.json, READ-ONLY to this lane). Semantic edges
// UNION with base edges; node entries key on the base ID convention
// (repo-relative path / stage:<name> / boundary:<name>).
//
// MERGE RULES (fail-loud — a collision means two agents crossed domains):
//   - fragments merge in filename order (deterministic).
//   - nodes: walked_by = set-union; why = at most ONE fragment may set it;
//     copy (owner-facing prose) = at most ONE fragment may set it, same
//     single-writer rule as why; badges = shallow merge, same-key
//     different-value collision is an error.
//   - edges: identity = "<from> <to> <type>"; a duplicate key across fragments
//     is an error.
//   - review fragments (review_*.json) apply LAST as an OVERLAY: they flip
//     `verification` on existing edges (EXTRACTED -> VERIFIED | REFUTED |
//     STALE) and append a reviewer note. A review row that matches no edge is
//     an error (a review must review something).
//
// VALIDITY (hard build failures, mirrored by enrich.test.mjs):
//   - schema fields present; verification in the 4-state enum; edge types in
//     the ratified taxonomy.
//   - every edge endpoint resolves to a base node id OR a node declared by a
//     fragment in this build (declared nodes must carry provenance badges).
//   - VERIFIED/REFUTED edges must carry a cite (evidence or it didn't happen).
//   - every non-null why carries >= 1 cite {path, lines}.
//   - every non-null copy carries non-empty text + >= 1 cite {path, lines}
//     (LAW 3: prose with no cite is a build failure, never filler).
//   - NO absolute paths / drive letters / backslashes anywhere (public-later).
//
// Usage:  node tools/dag/enrich/build_enrichment.js

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // tools/dag/enrich

export const ENRICHMENT_SCHEMA_VERSION = '0.1.0';

// Ratified edge-type taxonomy (annotation is the owner overlay — NOT emitted here).
export const EDGE_TYPES = new Set([
  'data-flow',
  'control',
  'contract',
  'unit-conversion',
  'ordering',
  'fallback',
  'evidence',
  'stage-order', // receipt-replay ordering (extends the base extractor's own type)
]);
export const VERIFICATION_STATES = new Set(['EXTRACTED', 'VERIFIED', 'REFUTED', 'STALE']);

function headSha(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'UNKNOWN';
  }
}

const edgeKey = (e) => `${e.from} ${e.to} ${e.type}`;

// Shared cite discipline for prose blocks (why + copy): non-empty text and at
// least one cite {path, ...} — LAW 3 (no cite -> the block stays null, never
// filler). Path hygiene (no drive letters / backslashes) is enforced globally
// at serialize time, so cite paths are checked there too.
function validateProse(id, field, block) {
  if (typeof block.text !== 'string' || block.text.length === 0) {
    throw new Error(`node ${id} ${field} has empty text`);
  }
  const cites = block.cites;
  if (!Array.isArray(cites) || cites.length === 0) {
    throw new Error(`node ${id} has a ${field} with no cites (LAW 3: no cite -> ${field} stays null)`);
  }
  for (const c of cites) {
    if (typeof c.path !== 'string' || !c.path) throw new Error(`node ${id} ${field} cite missing path`);
  }
}

export function buildEnrichment(enrichDir = HERE) {
  const root = path.resolve(enrichDir, '..', '..', '..');
  const basePath = path.resolve(enrichDir, '..', 'dag_base.json');
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  const baseIds = new Set(base.nodes.map((n) => n.id));

  const fragDir = path.join(enrichDir, 'fragments');
  const fragFiles = existsSync(fragDir)
    ? readdirSync(fragDir).filter((f) => f.endsWith('.json')).sort()
    : [];
  const reviewFiles = fragFiles.filter((f) => f.startsWith('review_'));
  const dataFiles = fragFiles.filter((f) => !f.startsWith('review_'));

  const nodes = {};
  const edges = new Map(); // key -> edge
  const whySetBy = new Map(); // node id -> fragment file (single-writer rule)
  const copySetBy = new Map(); // node id -> fragment file (single-writer rule)

  for (const f of dataFiles) {
    const frag = JSON.parse(readFileSync(path.join(fragDir, f), 'utf8'));
    for (const [id, entry] of Object.entries(frag.nodes ?? {})) {
      if (!nodes[id]) nodes[id] = { why: null, copy: null, walked_by: [], badges: {} };
      const n = nodes[id];
      if (entry.why != null) {
        if (whySetBy.has(id)) {
          throw new Error(`why collision on node ${id}: ${whySetBy.get(id)} vs ${f}`);
        }
        whySetBy.set(id, f);
        n.why = entry.why;
      }
      if (entry.copy != null) {
        if (copySetBy.has(id)) {
          throw new Error(`copy collision on node ${id}: ${copySetBy.get(id)} vs ${f}`);
        }
        copySetBy.set(id, f);
        n.copy = entry.copy;
      }
      for (const t of entry.walked_by ?? []) if (!n.walked_by.includes(t)) n.walked_by.push(t);
      for (const [bk, bv] of Object.entries(entry.badges ?? {})) {
        if (bk in n.badges && JSON.stringify(n.badges[bk]) !== JSON.stringify(bv)) {
          throw new Error(`badge collision on node ${id}.${bk} (fragment ${f})`);
        }
        n.badges[bk] = bv;
      }
    }
    for (const e of frag.edges ?? []) {
      const k = edgeKey(e);
      if (edges.has(k)) throw new Error(`duplicate edge across fragments: ${k} (fragment ${f})`);
      edges.set(k, { ...e });
    }
  }

  // Review overlay (verification flips only — reviews never add edges).
  for (const f of reviewFiles) {
    const rev = JSON.parse(readFileSync(path.join(fragDir, f), 'utf8'));
    for (const row of rev.edges ?? []) {
      const k = `${row.from} ${row.to} ${row.type}`;
      const e = edges.get(k);
      if (!e) throw new Error(`review row matches no edge: ${k} (review ${f})`);
      if (!VERIFICATION_STATES.has(row.verification)) {
        throw new Error(`review sets invalid verification '${row.verification}' on ${k}`);
      }
      e.verification = row.verification;
      if (row.note) e.review_note = row.note;
      if (row.cite && !e.cite) e.cite = row.cite;
    }
  }

  // ── validity ────────────────────────────────────────────────────────────
  const declaredIds = new Set(Object.keys(nodes));
  for (const [id, n] of Object.entries(nodes)) {
    if (!baseIds.has(id)) {
      // Newly declared nodes need mechanical provenance: a runtime stage
      // observed in a receipt, or an explicitly-badged external dependency.
      const ok =
        (id.startsWith('stage:') && n.badges.observed_in) ||
        (id.startsWith('external:') && n.badges.external_dependency);
      if (!ok) {
        throw new Error(
          `node ${id} is not in dag_base.json and carries no provenance badge (observed_in / external_dependency)`,
        );
      }
    }
    if (n.why != null) validateProse(id, 'why', n.why);
    if (n.copy != null) validateProse(id, 'copy', n.copy);
  }
  for (const e of edges.values()) {
    if (!EDGE_TYPES.has(e.type)) throw new Error(`edge ${edgeKey(e)}: unknown type '${e.type}'`);
    if (!VERIFICATION_STATES.has(e.verification)) {
      throw new Error(`edge ${edgeKey(e)}: invalid verification '${e.verification}'`);
    }
    for (const end of [e.from, e.to]) {
      if (!baseIds.has(end) && !declaredIds.has(end)) {
        throw new Error(`edge ${edgeKey(e)}: endpoint '${end}' is neither a base node nor declared here`);
      }
    }
    if ((e.verification === 'VERIFIED' || e.verification === 'REFUTED') && !e.cite) {
      throw new Error(`edge ${edgeKey(e)}: ${e.verification} without a cite`);
    }
  }

  // Stable ordering.
  const sortedNodes = {};
  for (const id of Object.keys(nodes).sort()) {
    const n = nodes[id];
    sortedNodes[id] = {
      why: n.why,
      ...(n.copy != null ? { copy: n.copy } : {}),
      walked_by: [...n.walked_by].sort(),
      ...(Object.keys(n.badges).length ? { badges: n.badges } : {}),
    };
  }
  const sortedEdges = [...edges.values()].sort((a, b) => {
    const ka = edgeKey(a);
    const kb = edgeKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    schema_version: ENRICHMENT_SCHEMA_VERSION,
    generated_at_commit: headSha(root),
    nodes: sortedNodes,
    edges: sortedEdges,
  };
}

export function serializeEnrichment(enr) {
  const json = JSON.stringify(enr, null, 2) + '\n';
  // Public-later hygiene: refuse to serialize anything smelling of a local box.
  if (/[A-Za-z]:[\\/]/.test(json) || json.includes('\\\\') || json.includes('/mnt/')) {
    throw new Error('absolute path / drive letter detected in enrichment output — refused');
  }
  return json;
}

// CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const enr = buildEnrichment(HERE);
  const out = path.join(HERE, 'enrichment.json');
  writeFileSync(out, serializeEnrichment(enr), 'utf8');
  const byType = {};
  const byVer = {};
  for (const e of enr.edges) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    byVer[e.verification] = (byVer[e.verification] || 0) + 1;
  }
  const whyCount = Object.values(enr.nodes).filter((n) => n.why != null).length;
  console.log(
    `enrichment.json written: ${Object.keys(enr.nodes).length} node entries (${whyCount} with why), ` +
      `${enr.edges.length} edges by type ${JSON.stringify(byType)} by verification ${JSON.stringify(byVer)}`,
  );
}
