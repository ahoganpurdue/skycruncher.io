#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   GENERATOR — flow_edge_semantics.{json,js}   (#flow tab: edge-semantics map)

   Single source of truth for the Processing-Flow tab's connector semantics.

   Two provenance streams, kept HONEST and separated:

     1. GLYPH VOCABULARY — GENERATIVE from the LAW-7 layout schema.
        The data-structure glyph classes are NOT hand-invented: each one is
        KEYED to an enumerated boundary in
          src/engine/contracts/binary_layouts.ts  (LAW 7)
        This generator READS that file, extracts every BINARY_LAYOUTS entry's
        {name, version, dtype}, and joins it with a purely-visual shape map
        (GLYPH_SHAPES below). If a glyph cites a schema entry that no longer
        exists, this generator THROWS — the legend cannot silently drift from
        the schema. dtype/version always come FROM the schema, never from here.

     2. MEASURED EDGE SET — transcribed from the Arrow serialization-walls
        report (a gitignored test_results artifact, so its numbers are
        transcribed here with a provenance pointer, NOT re-read at gen time —
        this generator runs in a bare clone). Only edges whose transfer
        semantics were actually MEASURED in that report carry measured:true;
        the Tauri-IPC edges are STATIC inventory (runtime NOT MEASURED) and are
        marked measured:false so the renderer mutes them to grey.

   Run:  node tools/theses/dashboard/ui/gen_flow_edge_semantics.mjs
   Emits (both committed):
     tools/theses/dashboard/ui/flow_edge_semantics.json   (canonical data)
     tools/theses/dashboard/ui/flow_edge_semantics.js      (file:// loader shim)
   ═══════════════════════════════════════════════════════════════════════════ */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SCHEMA_PATH = resolve(REPO_ROOT, 'src', 'engine', 'contracts', 'binary_layouts.ts');

/* ── measured-edge provenance (transcribed, LAW 3) ───────────────────────── */
const MEASURED_REPORT = {
  path: 'test_results/arrow_serialization_walls_2026-07-11/measurements.json',
  date: '2026-07-11',
  repo_head: '912fb68 (main)',
  note:
    'Walls 1-3 carry MEASURED transfer semantics (buffer identity + N=5 median ' +
    'memcpy/clone/transfer timings). Wall 4 (Tauri IPC) is STATIC inventory only — ' +
    'runtime NOT MEASURED (needs the packaged desktop app). Edges off wall 4 render grey.',
};

/* ── glyph VISUAL layer, keyed to LAW-7 schema entries by name ───────────── */
/* Each key.schema_entry MUST resolve to a BINARY_LAYOUTS[].name; dtype+version
   are pulled FROM the schema at generation time (not duplicated here). `shape`
   is a pure-visual token consumed by the renderer's shape factory. */
const GLYPH_SHAPES = [
  { id: 'typed_u16', schema_entry: 'libraw_mem_image', shape: 'square',
    label: 'u16 typed array',
    twin_note: 'rawler_cfa is the decoder-cutover twin (also uint16).' },
  { id: 'typed_f32', schema_entry: 'wasm_typed_array', shape: 'circle',
    label: 'f32 typed array',
    twin_note: 'JS-side view of the wasm crossing (see wasm_heap for the wasm side).' },
  { id: 'arrow',     schema_entry: 'arrow_seam', shape: 'bars',
    label: 'Arrow table', twin_note: '' },
  { id: 'json',      schema_entry: 'atlas_rows', shape: 'braces',
    label: 'JSON / object',
    twin_note: 'Keyed to the hybrid per-row record boundary (the structured-object analog).' },
  { id: 'ipc_bytes', schema_entry: 'starplates_blobs', shape: 'diamond',
    label: 'raw IPC bytes', twin_note: '' },
  { id: 'wasm_heap', schema_entry: 'wasm_typed_array', shape: 'chevron',
    label: 'wasm heap view',
    twin_note: 'wasm-side of the same boundary as typed_f32 (linear-memory view).' },
  { id: 'wgsl',      schema_entry: 'wgsl_structs', shape: 'hexagon',
    label: 'WGSL buffer', twin_note: '' },
  { id: 'fits',      schema_entry: 'fits_io', shape: 'crossbox',
    label: 'FITS I/O', twin_note: '' },
];

/* ── line (transfer) classes ─────────────────────────────────────────────── */
const LINE_CLASSES = [
  { id: 'shared_view', label: 'zero-copy — SHARED VIEW', dash: 'dotted',
    color: 'view',
    meaning:
      'Same ArrayBuffer, wrapped in place. No bytes move; a validity bitmap or ' +
      'header is the only overhead.' },
  { id: 'ownership_transfer', label: 'zero-copy — OWNERSHIP TRANSFER', dash: 'dot-dash',
    color: 'transfer',
    meaning:
      'Transferable: the buffer is detached from the sender and handed to the ' +
      'receiver. The measured 172-482x lever — semantically distinct from a ' +
      'shared view (sender loses access).' },
  { id: 'copy', label: 'COPY / SERIALIZE', dash: 'solid', color: 'copy',
    meaning:
      'Bytes are duplicated (memcpy) or serialized (structuredClone / JSON). ' +
      'Stroke weight is proportional to the measured cost in ms.' },
];

/* ── nodes (memory domains / code modules named in the report) ───────────── */
const NODES = [
  { id: 'decoder',       label: 'Raw decode', sub: 'rawler_decoder.ts · libraw',
    x: 26,  y: 40,  w: 156, h: 54 },
  { id: 'demosaic',      label: 'Demosaic', sub: 'demosaic_pipeline.ts',
    x: 26,  y: 176, h: 54, w: 156 },
  { id: 'tauri',         label: 'Native backend', sub: 'src-tauri · Rust',
    x: 26,  y: 316, w: 156, h: 54 },
  { id: 'arrow_mem',     label: 'Arrow store', sub: 'core/ArrowMemory.ts',
    x: 372, y: 96,  w: 176, h: 62 },
  { id: 'worker_signal', label: 'Signal worker', sub: 'signal_worker.ts',
    x: 372, y: 306, w: 176, h: 54,
    status: 'dead', dead_date: '2026-07-11',
    dead_reason:
      'signal_worker.ts DELETED 2026-07-11 (branch cleanup/dead-workers, ROADMAP item 6): ' +
      'orphaned worker, never spawned (no new Worker/?worker in src). Live signal path is ' +
      'in-process WASM shared-heap — extract_blobs_shared @signal_processor.ts:901.' },
  { id: 'wasm',          label: 'WASM compute', sub: 'signal_processor · source_extractor',
    x: 738, y: 96,  w: 184, h: 62 },
  { id: 'worker_phot',   label: 'Photometry worker', sub: 'photometry_worker.ts',
    x: 738, y: 292, w: 184, h: 54,
    status: 'dead', dead_date: '2026-07-11',
    dead_reason:
      'photometry_worker.ts DELETED 2026-07-11 (branch cleanup/dead-workers, ROADMAP item 6): ' +
      'orphaned worker, never spawned. Live photometry path is the in-process pool — ' +
      'refine_stars_bulk @photometry_worker_pool.ts:57 (a different file, NOT this worker).' },
];

/* ── edges (each transcribed from a specific wall/site) ──────────────────── */
const EDGES = [
  {
    id: 'e1_raw_to_arrow', from: 'decoder', to: 'arrow_mem',
    line_class: 'shared_view', start_glyph: 'typed_u16', end_glyph: 'arrow',
    measured: true, curve: 0,
    site: 'ArrowMemory.ts:26 createRawBuffer · caller rawler_decoder.ts:364',
    wall: 'wall1_arrow_ingest_copy',
    measurement: 'raw Uint16 36MB → makeTable: readback is the SAME ArrayBuffer (ZERO-COPY).',
  },
  {
    id: 'e2_rgb_to_arrow', from: 'demosaic', to: 'arrow_mem',
    line_class: 'shared_view', start_glyph: 'typed_f32', end_glyph: 'arrow',
    measured: true, curve: 0,
    site: 'ArrowMemory.ts:37 createRgbBuffer · caller demosaic_pipeline.ts:97/113/124',
    wall: 'wall1_arrow_ingest_copy',
    measurement:
      'Float32 18MP/216MB → makeTable: same ArrayBuffer + same byteOffset (ZERO-COPY); ' +
      'overhead = 6.44MB validity bitmap (N/8), NOT a 216MB duplicate.',
  },
  {
    id: 'e3_copy_in', from: 'arrow_mem', to: 'wasm',
    line_class: 'copy', start_glyph: 'typed_f32', end_glyph: 'wasm_heap',
    measured: true, curve: -34,
    cost_ms: 12.8121, cost_payload_mb: 216, gbps: 16.86,
    site: 'signal_processor.ts:897-901 · source_extractor.ts:78-88 · demosaic_engine.ts:238',
    wall: 'wall2_wasm_crossings',
    measurement:
      'copy-IN heapView.set(src): O(N) memcpy, 12.81ms @216MB (16.86 GB/s, N=5 median). ' +
      'NB: signal_processor.ts:894 calls this an "O(1) handoff" — it is O(N).',
  },
  {
    id: 'e4_copy_out', from: 'wasm', to: 'arrow_mem',
    line_class: 'copy', start_glyph: 'wasm_heap', end_glyph: 'typed_f32',
    measured: true, curve: -34,
    cost_ms: 41.0329, cost_payload_mb: 216, gbps: 5.26,
    site: 'signal_processor.ts / wasm-bindgen Vec return',
    wall: 'wall2_wasm_crossings',
    measurement:
      'copy-OUT .slice()/Vec: O(N) memcpy, 41.03ms @216MB (5.26 GB/s). An O(1) view ' +
      '(new F32(memory,ptr,n)) exists but live code copies it out.',
  },
  {
    id: 'e5_transfer', from: 'wasm', to: 'worker_phot',
    line_class: 'ownership_transfer', start_glyph: 'typed_f32', end_glyph: 'typed_f32',
    measured: true, curve: 0,
    status: 'dead', dead_date: '2026-07-11',
    dead_reason:
      'DEAD PATH — photometry_worker.ts deleted 2026-07-11 (orphaned, never spawned). The ' +
      'transferable round-trip below was a real micro-benchmark of the postMessage primitive, ' +
      'but this worker site no longer exists; live photometry runs in-process (photometry_worker_pool.ts).',
    cost_ms: 0.1976, cost_payload_mb: 200, gbps: null,
    site: 'photometry_worker.ts:38 postMessage(msg, [refinedParams.buffer]) — FILE DELETED',
    wall: 'wall3_worker_clone_vs_transfer',
    measurement:
      'Transferable round-trip: 0.14ms @50MB / 0.20ms @200MB — 172x / 482x faster than ' +
      'structuredClone. The buffer is detached from the sender (ownership moves).',
  },
  {
    id: 'e6_clone', from: 'arrow_mem', to: 'worker_signal',
    line_class: 'copy', start_glyph: 'json', end_glyph: 'json',
    measured: true, curve: 0,
    status: 'dead', dead_date: '2026-07-11',
    dead_reason:
      'DEAD PATH — signal_worker.ts deleted 2026-07-11 (orphaned, never spawned). The ' +
      'structuredClone round-trip below was a real micro-benchmark, but this worker site no ' +
      'longer exists; live signal extraction runs in-process (signal_processor.ts:901).',
    cost_ms: 95.1667, cost_payload_mb: 200, gbps: 2.0,
    site: 'signal_worker.ts:23 postMessage({blobs}) — FILE DELETED',
    wall: 'wall3_worker_clone_vs_transfer',
    measurement:
      'structuredClone round-trip: 24.17ms @50MB / 95.17ms @200MB (~2 GB/s). The full ' +
      'payload is serialized+copied — the transfer path (e5) avoids this.',
  },
  {
    id: 'e7_tauri_demosaic', from: 'tauri', to: 'demosaic',
    line_class: 'copy', start_glyph: 'typed_u16', end_glyph: 'json',
    measured: false, curve: 0,
    site: 'src-tauri lib.rs:285 demosaic_native · NativeGpuBridge.ts:42',
    wall: 'wall4_tauri_ipc_static',
    measurement:
      'STATIC inventory: bayerData crosses as JSON number[] (~96MB JSON string @24MP). ' +
      'Runtime NOT MEASURED (needs the packaged app).',
  },
  {
    id: 'e8_tauri_catalog', from: 'tauri', to: 'arrow_mem',
    line_class: 'copy', start_glyph: 'ipc_bytes', end_glyph: 'arrow',
    measured: false, curve: 26,
    site: 'src-tauri lib.rs:188-205 query_catalog_v2',
    wall: 'wall4_tauri_ipc_static',
    measurement:
      'STATIC inventory: returns a raw Arrow-IPC ArrayBuffer (NO JSON) — an efficient ' +
      'raw-bytes path. Runtime NOT MEASURED.',
  },
];

/* ── parse the LAW-7 schema (generative vocabulary source) ───────────────── */
function parseSchema(text) {
  const verM = text.match(/BINARY_LAYOUTS_VERSION\s*=\s*'([^']+)'/);
  if (!verM) throw new Error('BINARY_LAYOUTS_VERSION not found in ' + SCHEMA_PATH);
  const entries = new Map();
  const re = /name:\s*'([^']+)',\s*version:\s*'([^']+)',\s*dtype:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    entries.set(m[1], { name: m[1], version: m[2], dtype: m[3] });
  }
  if (entries.size === 0) throw new Error('No BINARY_LAYOUTS entries parsed from ' + SCHEMA_PATH);
  return { version: verM[1], entries };
}

function build() {
  const schemaText = readFileSync(SCHEMA_PATH, 'utf8');
  const schema = parseSchema(schemaText);

  const glyph_vocabulary = GLYPH_SHAPES.map((g) => {
    const e = schema.entries.get(g.schema_entry);
    if (!e) {
      throw new Error(
        `glyph '${g.id}' cites schema entry '${g.schema_entry}' which is not in ` +
        `BINARY_LAYOUTS. The legend must stay keyed to the LAW-7 schema — ` +
        `fix GLYPH_SHAPES or the schema.`,
      );
    }
    return {
      id: g.id,
      shape: g.shape,
      label: g.label,
      schema_entry: e.name,      // from schema
      schema_version: e.version, // from schema
      dtype: e.dtype,            // from schema — never hand-typed here
      note: g.twin_note || '',
    };
  });

  return {
    _comment:
      'GENERATED by tools/theses/dashboard/ui/gen_flow_edge_semantics.mjs — do not hand-edit. ' +
      'Glyph vocabulary is derived from src/engine/contracts/binary_layouts.ts (LAW 7); ' +
      'measured edges are transcribed from the Arrow serialization-walls report.',
    generated_at: new Date().toISOString(),
    provenance: {
      glyph_vocabulary_source: {
        file: 'src/engine/contracts/binary_layouts.ts',
        schema_version: schema.version,
        law: 'LAW 7 (Memory Boundary Layout) — glyphs are keyed to enumerated boundaries',
      },
      measured_edges_source: MEASURED_REPORT,
    },
    viewbox: { w: 948, h: 400 },
    line_classes: LINE_CLASSES,
    glyph_vocabulary,
    nodes: NODES,
    edges: EDGES,
  };
}

const model = build();
const jsonPath = resolve(__dirname, 'flow_edge_semantics.json');
const jsPath = resolve(__dirname, 'flow_edge_semantics.js');

writeFileSync(jsonPath, JSON.stringify(model, null, 2) + '\n');

const jsBody =
  '/* GENERATED from flow_edge_semantics.json by gen_flow_edge_semantics.mjs.\n' +
  '   file:// loader shim: fetch() is blocked on the file scheme, so the flow\n' +
  '   tab reads this global. Keep in sync via the generator — do not hand-edit. */\n' +
  'window.__FLOW_EDGE_SEMANTICS__ = ' +
  JSON.stringify(model, null, 2) +
  ';\n';
writeFileSync(jsPath, jsBody);

console.log('wrote', jsonPath);
console.log('wrote', jsPath);
console.log('glyphs:', model.glyph_vocabulary.length, '| edges:', model.edges.length,
  '| schema', model.provenance.glyph_vocabulary_source.schema_version);
