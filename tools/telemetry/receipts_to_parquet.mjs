#!/usr/bin/env node
// tools/telemetry/receipts_to_parquet.mjs
//
// Greenfield solve-telemetry ingest (v0 DRAFT, TEST/DEV tier).
// Flattens every banked greenfield SolveReceipt into two analytical tables and
// writes them as DuckDB-ingestible NDJSON (+ a CSV twin + a manifest). If the
// tools/results lane's @duckdb/node-api is resolvable it ALSO emits real
// hive-partitioned parquet, mirroring the tools/results R2 layout convention.
//
// LOCAL PROTOTYPE. No network, no R2, no servers. The R2 push is owner-gated
// (see test_results/greenfield_solver/R2_TELEMETRY_SCHEMA_DRAFT.md).
//
// Sources (LOCAL-ONLY -- verified present, never assumed):
//   test_results/greenfield_solver/m6_compare_config.json          (arm m6)
//   test_results/greenfield_solver/m6_ab_compare_config.json       (arm m6_ab)
//   test_results/greenfield_solver/m6_bandmajor_compare_config.json (arm m6_bandmajor)
//   -> receipts under D:/AstroLogic/test_artifacts/greenfield_solver/<arm>/receipts/
//   -> truth labels referenced by the compare_configs
//
// Output: D:/AstroLogic/test_artifacts/greenfield_solver/telemetry_db/
//
// Usage:  node tools/telemetry/receipts_to_parquet.mjs
//         node tools/telemetry/receipts_to_parquet.mjs --no-parquet
//         node tools/telemetry/receipts_to_parquet.mjs --out <dir>

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { flattenSolve, flattenBands, sha256Hex, CSV_COLUMNS, TELEMETRY_SCHEMA_DRAFT_VERSION } from './greenfield/flatten_receipt.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CFG_DIR = path.join(REPO_ROOT, 'test_results/greenfield_solver');
const DEFAULT_OUT = 'D:/AstroLogic/test_artifacts/greenfield_solver/telemetry_db';

const ARMS = [
  { arm: 'm6', cfg: 'm6_compare_config.json' },
  { arm: 'm6_ab', cfg: 'm6_ab_compare_config.json' },
  { arm: 'm6_bandmajor', cfg: 'm6_bandmajor_compare_config.json' },
];

function parseArgs(argv) {
  const a = { out: DEFAULT_OUT, parquet: true };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--no-parquet') a.parquet = false;
  }
  return a;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Opportunistic DuckDB loader: normal resolution, then the tools/results lane
// (which installs @duckdb/node-api lane-locally per tools/results/README.md).
async function loadDuckDB() {
  const bases = [
    path.join(REPO_ROOT, 'tools/telemetry/package.json'), // if a lane-local install lands here later
    path.join(REPO_ROOT, 'tools/results/package.json'),   // existing lane with @duckdb/node-api
  ];
  for (const base of bases) {
    try {
      const req = createRequire(base);
      const entry = req.resolve('@duckdb/node-api');
      const mod = await import(pathToFileURL(entry).href);
      if (mod && mod.DuckDBInstance) return { mod, via: base };
    } catch { /* try next */ }
  }
  return null;
}

function ndjsonLine(obj) {
  // JSON with arrays intact; NDJSON is DuckDB read_json_auto-ingestible.
  return JSON.stringify(obj);
}

function toCsv(rows, columns) {
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c])).join(','));
  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv);
  const t0 = Date.now();
  console.log(`[telemetry-etl] greenfield solve-receipt ingest  (schema ${TELEMETRY_SCHEMA_DRAFT_VERSION}, TEST/DEV)`);

  fs.mkdirSync(args.out, { recursive: true });

  const solves = [];
  const bands = [];
  const shaSeen = new Map();     // receipt_sha256 -> first path (dedup, mirrors tools/results)
  const missing = [];
  const dupPaths = [];
  const armCounts = {};

  for (const { arm, cfg } of ARMS) {
    const cfgPath = path.join(CFG_DIR, cfg);
    const compare = readJson(cfgPath);
    if (!compare) { console.warn(`[telemetry-etl] MISSING compare config: ${cfgPath}`); continue; }
    const compareCfg = {
      center_bar_deg: compare.center_bar_deg,
      scale_band_pct: compare.scale_band_pct,
      known_resolution_ratios: compare.known_resolution_ratios,
      ratio_tol: compare.ratio_tol,
    };
    armCounts[arm] = 0;
    for (const fr of compare.frames || []) {
      const receiptPath = fr.receipt;
      if (!receiptPath || !fs.existsSync(receiptPath)) { missing.push({ arm, frame_id: fr.frame_id, receiptPath }); continue; }
      const bytes = fs.readFileSync(receiptPath);
      const sha = sha256Hex(bytes);
      if (shaSeen.has(sha)) { dupPaths.push({ sha, path: receiptPath, first: shaSeen.get(sha) }); continue; }
      shaSeen.set(sha, receiptPath);

      const receipt = JSON.parse(bytes.toString('utf8'));
      const label = fr.label && fs.existsSync(fr.label) ? readJson(fr.label) : null;
      const ctx = {
        arm,
        frame_id_config: fr.frame_id,
        truth_class: fr.truth_class,
        label,
        solve_width: fr.solve_width ?? null,
        solve_height: fr.solve_height ?? null,
        receipt_path: path.relative('D:/AstroLogic/test_artifacts/greenfield_solver', receiptPath).replace(/\\/g, '/'),
        receipt_basename: path.basename(receiptPath),
        receipt_bytes: bytes.length,
        receipt_sha256: sha,
        compare_cfg: compareCfg,
      };
      solves.push(flattenSolve(receipt, ctx));
      for (const br of flattenBands(receipt, ctx)) bands.push(br);
      armCounts[arm]++;
    }
  }

  // ---- write NDJSON (DuckDB read_json_auto ingestible) ----
  const solvesNdjson = path.join(args.out, 'solves.ndjson');
  const bandsNdjson = path.join(args.out, 'solve_bands.ndjson');
  fs.writeFileSync(solvesNdjson, solves.map(ndjsonLine).join('\n') + (solves.length ? '\n' : ''));
  fs.writeFileSync(bandsNdjson, bands.map(ndjsonLine).join('\n') + (bands.length ? '\n' : ''));

  // ---- write CSV twin (scalars only) ----
  const solvesCsv = path.join(args.out, 'solves.csv');
  fs.writeFileSync(solvesCsv, toCsv(solves, CSV_COLUMNS));

  const artifacts = [solvesNdjson, bandsNdjson, solvesCsv];

  // ---- optional real parquet via tools/results @duckdb/node-api ----
  let parquetInfo = { emitted: false, reason: 'skipped (--no-parquet)' };
  if (args.parquet) {
    const duck = await loadDuckDB();
    if (!duck) {
      parquetInfo = { emitted: false, reason: 'DuckDB absent (no @duckdb/node-api resolvable) -- NDJSON is the DuckDB-ingestible artifact' };
    } else {
      try {
        const { DuckDBInstance } = duck.mod;
        const inst = await DuckDBInstance.create(':memory:');
        const conn = await inst.connect();
        const q = (s) => conn.run(s);
        const njUrl = (p) => p.replace(/\\/g, '/').replace(/'/g, "''");
        // Hive-partition by solver_core_version (analog of tools/results schema_version).
        const solvesPqRoot = path.join(args.out, 'parquet', 'solves');
        const bandsPqRoot = path.join(args.out, 'parquet', 'solve_bands');
        fs.mkdirSync(solvesPqRoot, { recursive: true });
        fs.mkdirSync(bandsPqRoot, { recursive: true });
        await q(`COPY (SELECT * FROM read_json_auto('${njUrl(solvesNdjson)}', maximum_object_size=104857600))
                 TO '${njUrl(path.join(args.out, 'parquet', 'solves'))}'
                 (FORMAT parquet, PARTITION_BY (solver_core_version), OVERWRITE_OR_IGNORE 1);`);
        await q(`COPY (SELECT * FROM read_json_auto('${njUrl(bandsNdjson)}', maximum_object_size=104857600))
                 TO '${njUrl(path.join(args.out, 'parquet', 'solve_bands'))}'
                 (FORMAT parquet, PARTITION_BY (solver_core_version), OVERWRITE_OR_IGNORE 1);`);
        await conn.disconnectSync?.();
        parquetInfo = { emitted: true, via: duck.via, layout: 'parquet/<table>/solver_core_version=<v>/*.parquet' };
        artifacts.push(path.join(args.out, 'parquet'));
      } catch (e) {
        parquetInfo = { emitted: false, reason: `DuckDB parquet write failed: ${String(e.message).slice(0, 160)}` };
      }
    }
  }

  // ---- manifest ----
  const stateCounts = {};
  const verdictCounts = {};
  for (const s of solves) {
    stateCounts[s.state] = (stateCounts[s.state] || 0) + 1;
    verdictCounts[s.truth_verdict] = (verdictCounts[s.truth_verdict] || 0) + 1;
  }
  const manifest = {
    schema_draft_version: TELEMETRY_SCHEMA_DRAFT_VERSION,
    tier: 'TEST/DEV (schema NOT locked)',
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
    source_config_dir: CFG_DIR,
    out_dir: args.out,
    n_solves: solves.length,
    n_band_rows: bands.length,
    arms: armCounts,
    state_counts: stateCounts,
    verdict_counts: verdictCounts,
    dedup: { distinct: shaSeen.size, duplicate_paths: dupPaths.length },
    missing_receipts: missing,
    parquet: parquetInfo,
    artifacts: artifacts.map((p) => p.replace(/\\/g, '/')),
    tables: {
      solves: { grain: 'one row per receipt', pk: 'receipt_sha256', partition: 'solver_core_version', file: 'solves.ndjson' },
      solve_bands: { grain: 'one row per receipt x band', fk: 'receipt_sha256', partition: 'solver_core_version', file: 'solve_bands.ndjson' },
    },
  };
  const manifestPath = path.join(args.out, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  artifacts.push(manifestPath);

  console.log(`[telemetry-etl] solves=${solves.length}  band_rows=${bands.length}  arms=${JSON.stringify(armCounts)}`);
  console.log(`[telemetry-etl] states=${JSON.stringify(stateCounts)}`);
  console.log(`[telemetry-etl] verdicts=${JSON.stringify(verdictCounts)}`);
  console.log(`[telemetry-etl] dedup: ${shaSeen.size} distinct, ${dupPaths.length} duplicate paths; missing: ${missing.length}`);
  console.log(`[telemetry-etl] parquet: ${parquetInfo.emitted ? 'emitted ('+parquetInfo.via+')' : 'NOT emitted -- ' + parquetInfo.reason}`);
  console.log(`[telemetry-etl] out -> ${args.out}  (${Date.now() - t0} ms)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
