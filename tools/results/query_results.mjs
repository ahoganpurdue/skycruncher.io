#!/usr/bin/env node
// query_results.mjs — read-only DuckDB query surface over the results parquet.
// ============================================================================
// The ruled results query surface (owner 2026-07-16: "results query surface =
// R2-DIRECT DuckDB-over-parquet"). This is the READ side of the ETL lane: it
// registers each parquet table (frames / stars / detections / crashes /
// quad_verdicts / quad_clusters) as a DuckDB VIEW and runs SELECT-only queries —
// canned shortcuts or an arbitrary --sql SELECT.
//
// TIER: TEST/DEV, schema UNLOCKED. Every invocation prints the v0-testdev banner.
// Results are NOT citable until the post-recal schema lock (standing ruling).
//
// SOURCES:
//   LOCAL (default): globs the D: `results_etl_*` roots, sorted newest-first, and
//     registers each table as a dedup UNION-ALL-BY-NAME view (partition-key dedup
//     preferring the newest root — no double-count when a receipt is in two roots,
//     no silent drop of a receipt unique to an older root). `tables` shows exactly
//     which roots back each view + row counts.
//   R2 (--r2): reads s3://<bucket>/<prefix>/<table>/**/*.parquet via httpfs, creds
//     from src/engine/ui/dashboard/.env.r2 (VALUES never printed). Tables not yet
//     on R2 (e.g. the quad_gen backfill) return an honest "not present on R2"
//     message, never a silent empty result.
//
// SAFETY RAILS (this is a read surface, not a write path):
//   - SELECT-only: the user query must be a single SELECT / WITH…SELECT. Any
//     INSERT / UPDATE / DELETE / COPY / ATTACH / PRAGMA / CREATE / DROP / ALTER /
//     INSTALL / LOAD / SET / CALL / EXPORT / IMPORT / VACUUM token, or a second
//     statement, is rejected BEFORE execution. (Internal setup SQL — httpfs load,
//     secret, view creation — runs before the rail and is never user-supplied.)
//   - Row cap (--limit, default 1000) with an explicit truncation notice.
//   - Query timeout (--timeout-ms, default 30000).
//
// USAGE:
//   node query_results.mjs <command> [flags]
//   node query_results.mjs --sql "SELECT ... FROM quad_clusters ..." [flags]
//
// Commands (canned; each prints its SQL for transparency):
//   odds-separation   truth/false oddsV2 separation over the fullstack arms
//                     (reproduces the drain sanity: max-false 199.22359881965082,
//                      min-truth 1959.6022951183534, 23 truth / 1231 false)
//   verdicts-by-frame per-frame quad-gen verdict summary (quad_verdicts)
//   gap-classes       failure-stage/reason distribution over unsolved frames
//   frames-summary    solved/unsolved rollup by rig (frames)
//   tables            registered views + resolved source(s) + row count
//   schema <table>    column list + dtype for a registered view
//
// Flags:
//   --sql "<SELECT>"  run an arbitrary read-only SELECT
//   --r2              query R2 parquet instead of local
//   --json            JSON output (default: aligned text table)
//   --limit N         row cap (default 1000)
//   --timeout-ms N    query timeout in ms (default 30000)
//   --roots a,b       override local parquet roots (comma-separated)
//   --labels <glob>   oracle-label glob for odds-separation
//                     (default D:/AstroLogic/test_artifacts/w5_oracle_labels_2026-07-18/*.label.json)
//   --sql-only        print the SQL a canned query would run; do not execute
//   --bucket / --prefix / --env   R2 target overrides (defaults match the drain)
//   -h / --help
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { s3Env } from './lib/r2.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const FLAGS = new Set(argv.filter((a) => a.startsWith('--')));
const R2 = FLAGS.has('--r2');
const JSON_OUT = FLAGS.has('--json');
const SQL_ONLY = FLAGS.has('--sql-only');
const LIMIT = Math.max(1, parseInt(String(opt('limit', '1000')), 10) || 1000);
const TIMEOUT_MS = Math.max(1000, parseInt(String(opt('timeout-ms', '30000')), 10) || 30000);
const USER_SQL = opt('sql', null);
const BUCKET = String(opt('bucket', 'community-database'));
const PREFIX = String(opt('prefix', 'results/v0-testdev/')).replace(/^\/+/, '').replace(/\/*$/, '/');
const ENV_FILE = String(opt('env', path.join(REPO_ROOT, 'src/engine/ui/dashboard/.env.r2')));
const LABELS_GLOB = String(opt('labels', 'D:/AstroLogic/test_artifacts/w5_oracle_labels_2026-07-18/*.label.json'));
// first positional (non-flag, not a flag value) = command
const flagValueIdx = new Set();
for (const n of ['sql', 'limit', 'timeout-ms', 'roots', 'labels', 'bucket', 'prefix', 'env']) {
  const i = argv.indexOf('--' + n); if (i !== -1) flagValueIdx.add(i + 1);
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !flagValueIdx.has(i));
const COMMAND = positional[0] || null;
const COMMAND_ARG = positional[1] || null;

const BANNER = '[query_results v0-testdev] schemas unlocked — results non-citable until post-recal schema lock';

// ---- table registry ---------------------------------------------------------
// dedup identity = the RECEIPT-level key. When the same receipt appears in more
// than one local root, the newest root wins and ALL of that receipt's child rows
// (stars / detections / clusters) come from that root as a unit — never a
// per-child-row dedup (detection_index is NOT unique within a receipt: it resets
// between the kept/anomaly groups, so a synthetic child PK would silently drop
// genuinely distinct rows). crashes keyed on crash_sha256.
const TABLES = {
  frames: 'receipt_sha256',
  stars: 'receipt_sha256',
  detections: 'receipt_sha256',
  crashes: 'crash_sha256',
  quad_verdicts: 'receipt_sha256',
  quad_clusters: 'receipt_sha256',
};
const TABLE_NAMES = Object.keys(TABLES);
const pfwd = (s) => s.replace(/\\/g, '/');

// ---- local root discovery ---------------------------------------------------
function discoverLocalRoots() {
  const override = opt('roots', null);
  if (typeof override === 'string') {
    return override.split(',').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(p));
  }
  const base = 'D:/AstroLogic/test_artifacts';
  let ents = [];
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { /* base absent */ }
  const roots = ents
    .filter((e) => e.isDirectory() && /^results_etl_/.test(e.name))
    .map((e) => path.join(base, e.name));
  // newest-first: dir name sorts lexically by date; reverse => newest rank 0
  roots.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return roots;
}

function tableGlob(root, table) {
  return pfwd(path.join(root, table)) + '/**/*.parquet';
}
// which roots actually contain a given table dir with at least one parquet
function rootsWithTable(roots, table) {
  return roots.filter((r) => {
    const dir = path.join(r, table);
    try { return fs.existsSync(dir) && fs.readdirSync(dir).length > 0; } catch { return false; }
  });
}

// ---- view registration ------------------------------------------------------
async function registerLocalViews(conn, roots) {
  const resolved = {}; // table -> [roots used]
  for (const table of TABLE_NAMES) {
    const rs = rootsWithTable(roots, table);
    if (!rs.length) { resolved[table] = []; continue; }
    const key = `"${TABLES[table]}"`;
    const parts = rs.map((r, i) =>
      `SELECT *, ${i} AS __root_rank FROM read_parquet('${tableGlob(r, table)}', hive_partitioning=1)`
    ).join('\n    UNION ALL BY NAME\n    ');
    // newest root wins PER RECEIPT: pick min(__root_rank) per key, keep every
    // child row from that winning root (no per-child-row collapse).
    const viewSql =
      `CREATE OR REPLACE VIEW ${table} AS\n` +
      `WITH __u AS (\n    ${parts}\n),\n` +
      `__win AS (SELECT ${key} AS __k, min(__root_rank) AS __r FROM __u GROUP BY ${key})\n` +
      `SELECT __u.* EXCLUDE (__root_rank) FROM __u JOIN __win\n` +
      `  ON __u.${key} = __win.__k AND __u.__root_rank = __win.__r`;
    await conn.run(viewSql);
    resolved[table] = rs;
  }
  return resolved;
}

async function registerR2Views(conn, env) {
  await conn.run('INSTALL httpfs; LOAD httpfs;');
  const esc = (s) => s.replace(/'/g, "''");
  await conn.run(
    `CREATE OR REPLACE SECRET r2 (TYPE s3, KEY_ID '${esc(env.accessKey)}', SECRET '${esc(env.secretKey)}', ` +
    `ENDPOINT '${esc(env.endpointHost)}', REGION 'auto', URL_STYLE 'path', USE_SSL true);`
  );
  const resolved = {};
  for (const table of TABLE_NAMES) {
    const g = `s3://${BUCKET}/${PREFIX}${table}/**/*.parquet`;
    // read_parquet over a glob validates+infers schema at CREATE time, so a table
    // not yet uploaded (e.g. the quad_gen backfill) throws here — catch it per
    // table so present tables stay queryable and absent ones report honestly.
    try {
      await conn.run(`CREATE OR REPLACE VIEW ${table} AS SELECT * FROM read_parquet('${g}', hive_partitioning=1);`);
      resolved[table] = [g];
    } catch (e) {
      resolved[table] = [];
      console.error(`[query_results] R2: table "${table}" not present yet (${String(e.message || e).slice(0, 60)})`);
    }
  }
  return resolved;
}

// ---- SELECT-only rail -------------------------------------------------------
const FORBIDDEN = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'COPY', 'ATTACH', 'DETACH',
  'PRAGMA', 'CREATE', 'DROP', 'ALTER', 'INSTALL', 'LOAD', 'SET', 'RESET', 'CALL',
  'EXPORT', 'IMPORT', 'VACUUM', 'ANALYZE', 'CHECKPOINT', 'TRUNCATE', 'GRANT', 'REVOKE'];
function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments
    .replace(/--[^\n]*/g, ' ');            // line comments
}
function assertSelectOnly(sql) {
  const bare = stripSqlComments(sql).trim().replace(/;+\s*$/, '').trim();
  if (!bare) throw new Error('empty query');
  if (bare.includes(';')) throw new Error('SELECT-only rail: multiple statements are not allowed');
  if (!/^(select|with)\b/i.test(bare)) throw new Error('SELECT-only rail: query must begin with SELECT or WITH');
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(bare)) {
      throw new Error(`SELECT-only rail: forbidden keyword "${kw}" — this is a read surface`);
    }
  }
  return bare;
}

// ---- query execution --------------------------------------------------------
function bigintSafe(v) { return typeof v === 'bigint' ? Number(v) : v; }
async function runSelect(conn, sql) {
  const capped = `SELECT * FROM (\n${sql}\n) AS _q LIMIT ${LIMIT + 1}`;
  const readerP = conn.runAndReadAll(capped);
  const timer = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`query timed out after ${TIMEOUT_MS} ms (raise --timeout-ms)`)), TIMEOUT_MS));
  const reader = await Promise.race([readerP, timer]);
  const cols = reader.columnNames();
  const rawRows = reader.getRows();
  const truncated = rawRows.length > LIMIT;
  const rows = (truncated ? rawRows.slice(0, LIMIT) : rawRows).map((r) => r.map(bigintSafe));
  return { cols, rows, truncated };
}

// ---- output -----------------------------------------------------------------
function fmtCell(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v);
}
function printTable(cols, rows) {
  if (!rows.length) { console.log('(0 rows)'); return; }
  const widths = cols.map((c, i) => Math.max(String(c).length, ...rows.map((r) => fmtCell(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r.map(fmtCell)));
}
function emit(result) {
  if (JSON_OUT) {
    const objs = result.rows.map((r) => Object.fromEntries(result.cols.map((c, i) => [c, r[i]])));
    console.log(JSON.stringify({ tier: 'v0-testdev', columns: result.cols, row_count: result.rows.length, truncated: result.truncated, rows: objs }, null, 2));
  } else {
    printTable(result.cols, result.rows);
    if (result.truncated) console.log(`\n… truncated to --limit ${LIMIT} rows (more rows exist; raise --limit)`);
  }
}

// ---- canned queries ---------------------------------------------------------
// Each returns { sql, requiresLabels? } and is printed before running.
const CANNED = {
  'odds-separation': () => ({
    requiresLabels: true,
    sql: `
-- Reproduces the drain sanity (README "bar-recalibration reproduction"):
-- restrict quad_clusters to the two arm_fullstack_* arms, replay the w5
-- oracle-label footprint classification (angular separation <= 0.1*(fov_diag/2)
-- AND scale ratio in [0.8,1.25]), report signed-oddsV2 min/max per class.
-- Expected: false n=1231 max=199.22359881965082 ; true n=23 min=1959.6022951183534.
WITH clusters AS (
  SELECT input_basename, foot_ra_deg, foot_dec_deg, scale, odds_v2
  FROM quad_clusters
  WHERE receipt_path LIKE '%arm_fullstack_%' AND odds IS NOT NULL
),
labels AS (
  SELECT frame_id,
         ra_hours*15                         AS truth_ra_deg,   -- HOURS->DEG
         dec_degrees                         AS truth_dec_deg,
         pixel_scale_arcsec                  AS truth_scale,
         0.1 * (sqrt(field_w_deg*field_w_deg + field_h_deg*field_h_deg)/2.0) AS tol_deg
  FROM read_json('${LABELS_GLOB}') WHERE solved = true
),
joined AS (
  SELECT c.odds_v2,
    2*asin(least(1, sqrt(
      pow(sin(radians(l.truth_dec_deg - c.foot_dec_deg)/2),2)
      + cos(radians(c.foot_dec_deg))*cos(radians(l.truth_dec_deg))
      * pow(sin(radians(l.truth_ra_deg - c.foot_ra_deg)/2),2)
    )))/radians(1)          AS sep_deg,
    c.scale / l.truth_scale AS scale_ratio,
    l.tol_deg
  FROM clusters c JOIN labels l ON c.input_basename = l.frame_id
),
classified AS (
  SELECT odds_v2,
         (sep_deg <= tol_deg AND scale_ratio >= 0.8 AND scale_ratio <= 1.25) AS is_truth
  FROM joined WHERE odds_v2 IS NOT NULL
)
SELECT CASE WHEN is_truth THEN 'truth' ELSE 'false' END AS class,
       count(*)      AS n,
       min(odds_v2)  AS min_odds_v2,
       max(odds_v2)  AS max_odds_v2
FROM classified GROUP BY is_truth ORDER BY is_truth`.trim(),
  }),
  'verdicts-by-frame': () => ({
    sql: `
SELECT input_basename, rig, qg_pass, verdict_accept, verdict_reason,
       verdict_top_anchored, verdict_margin, n_clusters,
       acceptance_present, acceptance_accepted
FROM quad_verdicts
ORDER BY input_basename, receipt_sha256`.trim(),
  }),
  'gap-classes': () => ({
    sql: `
-- Failure-stage/reason distribution over UNSOLVED frames. (v0 schema has no
-- dedicated gap_class column; failure_stage/failure_reason is the honest proxy.)
SELECT coalesce(failure_stage,  '(none)') AS failure_stage,
       coalesce(failure_reason, '(none)') AS failure_reason,
       count(*) AS n
FROM frames WHERE solved = false
GROUP BY 1, 2 ORDER BY n DESC, failure_stage, failure_reason`.trim(),
  }),
  'frames-summary': () => ({
    sql: `
SELECT coalesce(rig, '(null)') AS rig,
       solved,
       count(*)                                             AS n,
       round(avg(stars_matched), 1)                         AS avg_stars_matched,
       count(*) FILTER (WHERE confirm_status = 'CONFIRMED')  AS n_confirmed
FROM frames GROUP BY 1, 2 ORDER BY n DESC, rig, solved`.trim(),
  }),
};

function labelsPresent() {
  try {
    const dir = path.dirname(LABELS_GLOB.replace(/\//g, path.sep));
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.label.json'));
  } catch { return false; }
}

// ---- help -------------------------------------------------------------------
function help() {
  console.log(BANNER);
  console.log(`
query_results — read-only DuckDB query surface over the results parquet (TEST/DEV)

  node query_results.mjs <command> [flags]
  node query_results.mjs --sql "SELECT ... FROM quad_clusters ..." [flags]

Canned commands (each prints its SQL):
  odds-separation     truth/false oddsV2 separation over fullstack arms (repro sanity)
  verdicts-by-frame   per-frame quad-gen verdict summary
  gap-classes         failure-stage/reason distribution over unsolved frames
  frames-summary      solved/unsolved rollup by rig
  tables              registered views + resolved source(s) + row count
  schema <table>      column list + dtype for a view

Flags:
  --sql "<SELECT>"   arbitrary read-only SELECT       --r2            query R2 instead of local
  --json             JSON output                      --limit N       row cap (default 1000)
  --timeout-ms N     query timeout (default 30000)    --roots a,b     override local parquet roots
  --labels <glob>    oracle-label glob                --sql-only      print SQL, do not execute
  --bucket / --prefix / --env   R2 target overrides   -h / --help

Views: ${TABLE_NAMES.join(', ')}`);
}

// ---- main -------------------------------------------------------------------
async function main() {
  console.error(BANNER);
  if (FLAGS.has('--help') || FLAGS.has('-h') || argv.includes('-h') || (!COMMAND && !USER_SQL)) { help(); return; }

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  let resolved = {};
  if (R2) {
    const env = s3Env(ENV_FILE);
    if (!env) { console.error('[query_results] FATAL: no R2 credentials (env or .env.r2).'); process.exit(1); }
    resolved = await registerR2Views(conn, env);
  } else {
    const roots = discoverLocalRoots();
    if (!roots.length) { console.error('[query_results] FATAL: no local results_etl_* roots found (use --roots).'); process.exit(1); }
    resolved = await registerLocalViews(conn, roots);
  }

  // ---- meta commands ----
  if (COMMAND === 'tables') {
    const out = [];
    for (const t of TABLE_NAMES) {
      const src = resolved[t] || [];
      let n = null;
      if (src.length) { try { n = Number((await (await conn.runAndReadAll(`SELECT count(*) FROM ${t}`)).getRows())[0][0]); } catch { n = null; } }
      out.push([t, src.length ? String(n ?? '?') : 'ABSENT', R2 ? (src[0] || '') : src.map((r) => path.basename(r)).join(' + ')]);
    }
    emit({ cols: ['table', 'rows', R2 ? 'r2_glob' : 'source_roots(newest-first)'], rows: out, truncated: false });
    await conn.closeSync?.(); return;
  }
  if (COMMAND === 'schema') {
    if (!COMMAND_ARG || !TABLE_NAMES.includes(COMMAND_ARG)) { console.error(`[query_results] schema <table>: one of ${TABLE_NAMES.join(', ')}`); process.exit(2); }
    if (!(resolved[COMMAND_ARG] || []).length) { console.error(`[query_results] table "${COMMAND_ARG}" is ABSENT in this source.`); process.exit(1); }
    const desc = await (await conn.runAndReadAll(`DESCRIBE ${COMMAND_ARG}`)).getRows();
    emit({ cols: ['column', 'type'], rows: desc.map((r) => [r[0], r[1]]), truncated: false });
    await conn.closeSync?.(); return;
  }

  // ---- resolve the query (canned or --sql) ----
  let sql;
  if (USER_SQL && typeof USER_SQL === 'string') {
    try { sql = assertSelectOnly(USER_SQL); }
    catch (e) { console.error(`[query_results] rejected: ${e.message}`); await conn.closeSync?.(); process.exit(2); }
  } else if (COMMAND && CANNED[COMMAND]) {
    const c = CANNED[COMMAND]();
    console.error(`\n-- canned query: ${COMMAND}\n${c.sql}\n`);
    if (SQL_ONLY) { await conn.closeSync?.(); return; }
    if (c.requiresLabels && !labelsPresent()) {
      console.error(`[query_results] oracle labels not found at "${LABELS_GLOB}" — cannot classify truth/false. NOT MEASURED. (pass --labels <glob>)`);
      await conn.closeSync?.(); process.exit(1);
    }
    if (c.requiresLabels && !(resolved.quad_clusters || []).length) {
      console.error('[query_results] quad_clusters is not present in this source (e.g. not yet on R2). NOT MEASURED.');
      await conn.closeSync?.(); process.exit(1);
    }
    sql = c.sql;
  } else if (COMMAND) {
    console.error(`[query_results] unknown command "${COMMAND}". Try -h.`);
    await conn.closeSync?.(); process.exit(2);
  }

  try {
    const result = await runSelect(conn, sql);
    emit(result);
  } catch (e) {
    const msg = String(e.message || e);
    if (/No files found|HTTP 40|NoSuch|not present|Could not establish/i.test(msg)) {
      console.error(`[query_results] source read failed (table may not be present on R2 yet): ${msg.slice(0, 200)}`);
      await conn.closeSync?.(); process.exit(1);
    }
    console.error(`[query_results] query error: ${msg.slice(0, 400)}`);
    await conn.closeSync?.(); process.exit(1);
  }
  await conn.closeSync?.();
}

// Force a clean exit: the DuckDB instance keeps worker threads alive, so the
// event loop would otherwise never drain and the CLI would hang after printing.
main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((e) => { console.error('[query_results] FATAL:', e.stack || e.message || e); process.exit(1); });
