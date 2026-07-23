// Stage-order replay — deliverable 1 of the DAG enrichment lane.
//
// Reads ONE banked receipt's `stage_records` array (the per-stage audit fold,
// receipt schema >= 2.26.0) and emits fragments/stage_order.json:
//
//   - one enrichment NODE entry per unique runtime stage id (`stage:<id>`, the
//     same slug convention the base extractor's stageSlug uses), tagged
//     walked_by:[<filetype>] and badged with the observing receipt + version;
//     stages that reported a `payload_ref` get a `receipt_write` badge (the
//     NAME of the receipt block that stage's data lands in).
//   - one VERIFIED stage-order EDGE per consecutive pair of stage records.
//     These are EMISSION-ORDER adjacencies of `stage_finished` events — an
//     aggregate stage (extract / solve / calibrate) finishes AFTER its own
//     sub-stages, so an edge like `extract.spectral_peek -> extract` records
//     the fold order, not a data hand-off. Self-loops (a stage id recorded
//     twice in a row, e.g. `load` twice) are skipped and counted in `notes`.
//
// HONESTY RULES (LAW 3):
//   - No receipt / no stage_records → the script FAILS loudly; it never
//     fabricates order (mirrors the base extractor's static fallback stance).
//   - The receipt class drives the walked_by tag: this run banks tags ONLY for
//     the classes actually replayed. Absent classes stay absent.
//   - The cite is the receipt's test_results-relative path (receipts are
//     local-only and gitignored — stated, not hidden; the base extractor uses
//     the same convention for its `source: "receipt"` nodes).
//
// Usage:
//   node tools/dag/enrich/replay_stage_order.js <abs-or-rel path to receipt.json> <filetype-tag>
// The output fragment contains NO absolute paths regardless of how the input
// path was given (public-later hygiene).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // tools/dag/enrich

function testResultsRelative(p) {
  const norm = p.split('\\').join('/');
  const at = norm.lastIndexOf('test_results/');
  if (at < 0) {
    throw new Error(
      'receipt path must live under a test_results/ tree (cite must be repo-relative): ' + p,
    );
  }
  return norm.slice(at);
}

export function replayStageOrder(receiptPath, filetypeTag) {
  const raw = readFileSync(receiptPath, 'utf8');
  const receipt = JSON.parse(raw);
  const recs = receipt.stage_records ?? receipt.receipt?.stage_records;
  if (!Array.isArray(recs) || recs.length === 0) {
    throw new Error('receipt has no stage_records — nothing to replay (never fabricate order)');
  }
  const solved = !!(receipt.solution && receipt.solution.ra_hours != null);
  if (!solved) {
    throw new Error('receipt is not a solved run — replay only banks order from solved receipts');
  }
  const cite = testResultsRelative(receiptPath);

  const labels = recs.map((r) => String(r.stage ?? r.name ?? r.id ?? '')).filter(Boolean);
  if (labels.length !== recs.length) {
    throw new Error('stage_records contained an unlabelable record — refusing partial replay');
  }

  const nodes = {};
  let selfLoopsSkipped = 0;

  for (const r of recs) {
    const id = 'stage:' + String(r.stage);
    if (!nodes[id]) {
      nodes[id] = {
        why: null, // WHY stubs come from the librarian lane, never from replay
        walked_by: [filetypeTag],
        badges: {
          observed_in: cite,
          receipt_version: receipt.version ?? null,
        },
      };
    }
    if (r.payload_ref && !nodes[id].badges.receipt_write) {
      nodes[id].badges.receipt_write = r.payload_ref;
    }
  }

  const edges = [];
  const seen = new Set();
  for (let i = 0; i + 1 < labels.length; i++) {
    const from = 'stage:' + labels[i];
    const to = 'stage:' + labels[i + 1];
    if (from === to) {
      selfLoopsSkipped++;
      continue;
    }
    const key = `${from} ${to} stage-order`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      from,
      to,
      type: 'stage-order',
      cite,
      verification: 'VERIFIED',
      how: {
        what: 'stage_finished emission order (StageRecord fold)',
        transform: 'consecutive adjacency in receipt.stage_records — fold order, not asserted data hand-off',
        lossy: false,
      },
      walked_by: [filetypeTag],
    });
  }

  return {
    fragment: 'stage_order',
    derived_by: 'replay_stage_order.js (mechanical, zero-LLM)',
    notes: [
      `replayed ${recs.length} stage records from a solved ${filetypeTag} receipt (schema ${receipt.version ?? 'UNKNOWN'})`,
      `${selfLoopsSkipped} self-loop adjacency(ies) skipped (same stage id recorded consecutively)`,
      'edges are stage_finished EMISSION-ORDER adjacencies; aggregate stages (extract/solve/calibrate) finish after their sub-stages',
      'walked_by tags exist only for receipt classes actually replayed — absent classes are honestly absent',
    ],
    nodes,
    edges,
  };
}

// ── UNION-MERGE (multi-filetype accumulation) ────────────────────────────────
//
// The base extractor + enrich builder read ONE `stage_order.json` fragment. To
// carry more than one file-type's walk (fits AND cr2 …) that single fragment
// must ACCUMULATE walks, never overwrite. `mergeStageOrder` unions a fresh walk
// into an existing fragment:
//   - nodes: walked_by = sorted set-union; badges merge NON-destructively —
//     same-key SAME-value keeps it, same-key DIFFERENT-value keeps the existing
//     value and appends the incoming value to a deduped `merge_notes` badge
//     (LAW 3: the other receipt's cite is recorded, never silently dropped);
//     an incoming badge key the existing node lacks is added.
//   - edges: identity = (from,to,type); a match unions walked_by (so a shared
//     adjacency is tagged by BOTH file types); a new adjacency is APPENDED
//     (existing order preserved, cr2-only edges land after the fits edges) and
//     carries its OWN receipt cite.
//   - notes: regenerated deterministically from the merged graph.
//
// IDEMPOTENT: merging the SAME walk again is a no-op (set-unions, deduped notes,
// regenerated notes) → byte-stable. IDENTITY: `mergeStageOrder(null, walk)`
// returns the walk UNCHANGED, so a single-source replay (no pre-existing
// fragment) reproduces the legacy overwrite output byte-for-byte.
const cloneJson = (x) => JSON.parse(JSON.stringify(x));
const uniqSort = (arr) => [...new Set(arr ?? [])].sort();
function uniqPush(arr, v) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.includes(v)) a.push(v);
  return a;
}
const edgeKeyOf = (e) => `${e.from} ${e.to} ${e.type}`;

export function mergeStageOrder(existing, incoming) {
  // Identity — single-source byte-identity contract.
  if (existing == null) return incoming;

  const out = cloneJson(existing);
  out.nodes = out.nodes && typeof out.nodes === 'object' ? out.nodes : {};
  out.edges = Array.isArray(out.edges) ? out.edges : [];

  // NODES: union (existing order preserved; genuinely-new nodes appended).
  for (const [id, inNodeRaw] of Object.entries(incoming.nodes ?? {})) {
    const inNode = cloneJson(inNodeRaw);
    if (!out.nodes[id]) {
      inNode.walked_by = uniqSort(inNode.walked_by);
      out.nodes[id] = inNode;
      continue;
    }
    const ex = out.nodes[id];
    ex.walked_by = uniqSort([...(ex.walked_by ?? []), ...(inNode.walked_by ?? [])]);
    ex.badges = ex.badges ?? {};
    const inB = inNode.badges ?? {};
    for (const [k, v] of Object.entries(inB)) {
      if (k === 'merge_notes') continue; // merged explicitly below
      if (!(k in ex.badges)) {
        ex.badges[k] = v; // additive: incoming introduces a new badge key
      } else if (JSON.stringify(ex.badges[k]) !== JSON.stringify(v)) {
        // same-key different-value: keep existing, cite the incoming value.
        // Format WITHOUT embedded quotes — a JSON.stringify'd string would inject
        // an escaped `\"` (a backslash) into the built enrichment.json and trip
        // the public-hygiene no-backslash gate. Raw for strings (paths are
        // forward-slash test_results-relative), stringified for scalars.
        const shown = typeof v === 'string' ? v : JSON.stringify(v);
        ex.badges.merge_notes = uniqPush(
          ex.badges.merge_notes,
          `${k}=${shown} from ${uniqSort(inNode.walked_by).join('+') || '?'} walk`,
        );
      }
    }
    for (const n of inB.merge_notes ?? []) {
      ex.badges.merge_notes = uniqPush(ex.badges.merge_notes, n);
    }
  }

  // EDGES: dedup by (from,to,type); walked_by set-union on a match, append new.
  const byKey = new Map(out.edges.map((e) => [edgeKeyOf(e), e]));
  for (const inERaw of incoming.edges ?? []) {
    const k = edgeKeyOf(inERaw);
    const ex = byKey.get(k);
    if (!ex) {
      const ne = cloneJson(inERaw);
      ne.walked_by = uniqSort(ne.walked_by);
      out.edges.push(ne);
      byKey.set(k, ne);
    } else {
      ex.walked_by = uniqSort([...(ex.walked_by ?? []), ...(inERaw.walked_by ?? [])]);
    }
  }

  // NOTES: regenerate deterministically from the merged graph.
  const tags = uniqSort(Object.values(out.nodes).flatMap((n) => n.walked_by ?? []));
  out.derived_by = 'replay_stage_order.js union-merge (mechanical, zero-LLM)';
  out.notes = [
    `union-merged stage-order walk covering filetype(s): ${tags.join(', ')}`,
    `${Object.keys(out.nodes).length} unique runtime stage ids, ${out.edges.length} VERIFIED stage-order edges`,
    'walked_by tags exist only for receipt classes actually replayed — absent classes are honestly absent',
    'edges are stage_finished EMISSION-ORDER adjacencies; aggregate stages (extract/solve/calibrate) finish after their sub-stages',
  ];
  return out;
}

// CLI
function parseArgs(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let receiptPath = flag('--receipt');
  let filetype = flag('--filetype');
  const outArg = flag('--out');
  // Backward-compatible positional form: <receipt> <filetype> (no flags at all).
  if (receiptPath === undefined && filetype === undefined) {
    const positional = args.filter((a) => !a.startsWith('--'));
    if (positional.length >= 2) [receiptPath, filetype] = positional;
  }
  return { receiptPath, filetype, outArg };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { receiptPath, filetype, outArg } = parseArgs(process.argv);
  if (!receiptPath || !filetype) {
    console.error(
      'usage: node replay_stage_order.js --receipt <receipt.json> --filetype <fits|cr2> [--out <path>]\n' +
        '       (legacy positional: node replay_stage_order.js <receipt.json> <filetype>)',
    );
    process.exit(2);
  }
  const outPath = outArg
    ? path.resolve(outArg)
    : path.join(HERE, 'fragments', 'stage_order.json');

  const walk = replayStageOrder(receiptPath, filetype);
  // UNION-MERGE if the out fragment already exists, else write the walk verbatim
  // (byte-identical to the legacy single-source overwrite).
  const result = existsSync(outPath)
    ? mergeStageOrder(JSON.parse(readFileSync(outPath, 'utf8')), walk)
    : walk;

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  const tags = uniqSort(Object.values(result.nodes).flatMap((n) => n.walked_by ?? []));
  console.log(
    `${path.basename(outPath)} written: ${Object.keys(result.nodes).length} nodes, ` +
      `${result.edges.length} VERIFIED stage-order edges, walked_by [${tags.join(', ')}] ` +
      `(${existsSync(outPath) ? 'merged' : 'fresh'} ${filetype})`,
  );
}
