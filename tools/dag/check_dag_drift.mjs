// DAG drift gate — the "docs match code" tripwire.
//
// Regenerates the DAG from the live tree and diffs its node/edge SETS against the
// committed tools/dag/dag_base.json. `generated_at_commit` is intentionally NOT
// compared (it always differs by design — only the graph structure is the
// contract). Exits nonzero with a terse added/removed listing on any drift, so a
// pre-commit / CI hook fails loudly when the code graph and the committed base
// diverge. Regenerate the base with `node tools/dag/extract_dag.mjs` after an
// intended change.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildDag, repoRoot } from './extract_dag.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function nodeKey(n) {
  return n.id;
}
function edgeKey(e) {
  return `${e.from} -> ${e.to} [${e.type}]`;
}

function diffSets(baseKeys, liveKeys) {
  const base = new Set(baseKeys);
  const live = new Set(liveKeys);
  const added = [...live].filter((k) => !base.has(k)).sort();
  const removed = [...base].filter((k) => !live.has(k)).sort();
  return { added, removed };
}

export function checkDrift(root = repoRoot()) {
  const basePath = path.join(root, 'tools', 'dag', 'dag_base.json');
  if (!existsSync(basePath)) {
    return { ok: false, reason: 'MISSING_BASE', basePath };
  }
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  const live = buildDag(root);

  const nodes = diffSets(base.nodes.map(nodeKey), live.nodes.map(nodeKey));
  const edges = diffSets(base.edges.map(edgeKey), live.edges.map(edgeKey));
  const ok = nodes.added.length + nodes.removed.length + edges.added.length + edges.removed.length === 0;
  return { ok, nodes, edges, counts: { base_nodes: base.nodes.length, live_nodes: live.nodes.length, base_edges: base.edges.length, live_edges: live.edges.length } };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check_dag_drift.mjs')) {
  const res = checkDrift(repoRoot());
  if (res.reason === 'MISSING_BASE') {
    process.stderr.write(`DAG DRIFT: committed base missing at ${res.basePath}\n`);
    process.exit(2);
  }
  if (res.ok) {
    process.stdout.write(
      `DAG drift: NONE (${res.counts.live_nodes} nodes, ${res.counts.live_edges} edges match committed base)\n`,
    );
    process.exit(0);
  }
  const lines = ['DAG DRIFT DETECTED:'];
  for (const k of res.nodes.added) lines.push(`  + node ${k}`);
  for (const k of res.nodes.removed) lines.push(`  - node ${k}`);
  for (const k of res.edges.added) lines.push(`  + edge ${k}`);
  for (const k of res.edges.removed) lines.push(`  - edge ${k}`);
  lines.push('Regenerate: node tools/dag/extract_dag.mjs');
  process.stderr.write(lines.join('\n') + '\n');
  process.exit(1);
}
