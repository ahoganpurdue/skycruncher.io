#!/usr/bin/env node
// tools/telemetry/query_telemetry.mjs
//
// Node-fallback drift-query runner for the greenfield solve-telemetry tables.
// DuckDB is NOT installed at the root and there is no duckdb CLI on this box, so
// this pure-node runner IS the query engine for the prototype. The identical
// queries are ALSO shipped as DuckDB SQL under ./greenfield/sql/*.sql (they run
// against the NDJSON via read_json_auto, or the parquet, unchanged). With
// --duckdb this runner executes those .sql files too (via the tools/results lane
// @duckdb/node-api) to cross-check the node results.
//
// Reads: <db>/solves.ndjson + <db>/solve_bands.ndjson
//   default <db> = D:/AstroLogic/test_artifacts/greenfield_solver/telemetry_db
//
// Usage: node tools/telemetry/query_telemetry.mjs [--db <dir>] [--json] [--duckdb]

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DB = 'D:/AstroLogic/test_artifacts/greenfield_solver/telemetry_db';
const SQL_DIR = path.join(REPO_ROOT, 'tools/telemetry/greenfield/sql');

function parseArgs(argv) {
  const a = { db: DEFAULT_DB, json: false, duckdb: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--db') a.db = argv[++i];
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--duckdb') a.duckdb = true;
  }
  return a;
}
function loadNdjson(p) {
  if (!fs.existsSync(p)) { console.error(`MISSING: ${p} (run receipts_to_parquet.mjs first)`); process.exit(1); }
  const t = fs.readFileSync(p, 'utf8').trim();
  return t ? t.split('\n').map((l) => JSON.parse(l)) : [];
}
function pct(sortedNums, p) {
  if (!sortedNums.length) return null;
  const idx = Math.min(sortedNums.length - 1, Math.max(0, Math.ceil(p / 100 * sortedNums.length) - 1));
  return sortedNums[idx];
}
function median(nums) { const s = [...nums].sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function mean(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null; }
function groupBy(rows, keyFn) { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; }
function table(rows) {
  if (!rows.length) return '  (no rows)';
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const fmt = (vals) => vals.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  return [fmt(cols), fmt(cols.map((_, i) => '-'.repeat(w[i]))), ...rows.map((r) => fmt(cols.map((c) => r[c])))].map((l) => '  ' + l).join('\n');
}
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv);
  const solves = loadNdjson(path.join(args.db, 'solves.ndjson'));
  const bands = loadNdjson(path.join(args.db, 'solve_bands.ndjson'));
  const out = {};

  // Q1 accept-band distribution by arm (solved) --------------------------------
  {
    const solved = solves.filter((s) => s.solved);
    const rows = [];
    for (const [arm, rs] of [...groupBy(solved, (s) => s.arm)].sort()) {
      const byBand = groupBy(rs, (s) => s.accept_band);
      const dist = [...byBand.keys()].sort((a, b) => a - b).map((b) => `b${b}:${byBand.get(b).length}`).join(' ');
      rows.push({ arm, n_solved: rs.length, accept_band_min: Math.min(...rs.map((s) => s.accept_band)), accept_band_max: Math.max(...rs.map((s) => s.accept_band)), distribution: dist });
    }
    out.q1_accept_band_by_arm = rows;
  }

  // Q2 wall percentiles by arm (+ class) --------------------------------------
  {
    const rows = [];
    for (const [arm, rs] of [...groupBy(solves, (s) => s.arm)].sort()) {
      const walls = rs.map((s) => s.wall_ms).filter((v) => v != null).sort((a, b) => a - b);
      rows.push({ arm, n: rs.length, p50_wall_ms: pct(walls, 50), p90_wall_ms: pct(walls, 90), p99_wall_ms: pct(walls, 99), max_wall_ms: walls[walls.length - 1] });
    }
    out.q2_wall_percentiles_by_arm = rows;
    const crows = [];
    for (const [k, rs] of [...groupBy(solves, (s) => `${s.arm}|${s.truth_class}`)].sort()) {
      const [arm, cls] = k.split('|');
      const walls = rs.map((s) => s.wall_ms).filter((v) => v != null).sort((a, b) => a - b);
      crows.push({ arm, truth_class: cls, n: rs.length, p50_wall_ms: pct(walls, 50), p90_wall_ms: pct(walls, 90), max_wall_ms: walls[walls.length - 1] });
    }
    out.q2b_wall_percentiles_by_arm_class = crows;
  }

  // Q3 scale-residual-vs-label by truth stratum (solved + labeled) -------------
  {
    const s = solves.filter((r) => r.solved && r.has_label && r.scale_residual_pct != null);
    const rows = [];
    for (const [stratum, rs] of [...groupBy(s, (r) => r.truth_stratum)].sort()) {
      const resid = rs.map((r) => r.scale_residual_pct);
      const coff = rs.map((r) => r.center_offset_deg).filter((v) => v != null);
      rows.push({
        truth_stratum: stratum, n: rs.length,
        median_scale_resid_pct: r2(median(resid)), min_scale_resid_pct: r2(Math.min(...resid)), max_scale_resid_pct: r2(Math.max(...resid)),
        n_scale_within_2pct: rs.filter((r) => r.scale_within_band).length,
        median_center_off_deg: r3(median(coff)), max_center_off_deg: r3(Math.max(...coff)),
      });
    }
    out.q3_scale_residual_by_stratum = rows;
  }

  // Q4 refusal rate by arm -----------------------------------------------------
  {
    const rows = [];
    for (const [arm, rs] of [...groupBy(solves, (s) => s.arm)].sort()) {
      const pos = rs.filter((r) => !r.is_negative);
      const neg = rs.filter((r) => r.is_negative);
      const refused = pos.filter((r) => !r.solved).length;
      const fp = neg.filter((r) => r.solved).length;
      rows.push({
        arm, n_positive: pos.length, solved: pos.length - refused, refused,
        refusal_rate: pos.length ? r3(refused / pos.length) : null,
        n_negative: neg.length, false_positives: fp, true_negatives: neg.length - fp,
      });
    }
    out.q4_refusal_rate_by_arm = rows;
  }

  // Q5 post-accept probe share by arm (solved, at_accept present) --------------
  // per frame: 1 - (sum at_accept_probes)/(sum final probes). Band-major aborts
  // on accept -> ~0; baseline runs the full ladder after accept -> large share.
  {
    const byFrame = groupBy(bands.filter((b) => b.state === 'Solved'), (b) => `${b.arm}|${b.receipt_sha256}`);
    const perFrame = [];
    for (const [k, brs] of byFrame) {
      const finalP = brs.reduce((a, b) => a + (b.probes || 0), 0);
      const hasAA = brs.some((b) => b.at_accept_probes != null);
      if (!hasAA || !finalP) continue;
      const aaP = brs.reduce((a, b) => a + (b.at_accept_probes || 0), 0);
      perFrame.push({ arm: k.split('|')[0], share: 1 - aaP / finalP });
    }
    const rows = [];
    for (const [arm, rs] of [...groupBy(perFrame, (r) => r.arm)].sort()) {
      const shares = rs.map((r) => r.share);
      rows.push({ arm, n_solved_w_accept_census: rs.length, mean_post_accept_probe_share: r3(mean(shares)), median: r3(median(shares)), max: r3(Math.max(...shares)) });
    }
    out.q5_post_accept_share_by_arm = rows;
  }

  // Q6 truth-verdict matrix: arm x stratum x verdict ---------------------------
  {
    const rows = [];
    for (const [k, rs] of [...groupBy(solves, (s) => `${s.arm}|${s.truth_stratum}`)].sort()) {
      const [arm, stratum] = k.split('|');
      const vc = {};
      for (const r of rs) vc[r.truth_verdict] = (vc[r.truth_verdict] || 0) + 1;
      rows.push({ arm, truth_stratum: stratum, n: rs.length, verdicts: Object.entries(vc).map(([v, c]) => `${v}:${c}`).join(' ') });
    }
    out.q6_truth_verdict_matrix = rows;
  }

  // Q7 config-drift sentinel: distinct build/config per arm --------------------
  {
    const rows = [];
    for (const [arm, rs] of [...groupBy(solves, (s) => s.arm)].sort()) {
      rows.push({
        arm,
        solver_core_versions: [...new Set(rs.map((r) => r.solver_core_version))].join(','),
        git_commits: [...new Set(rs.map((r) => (r.git_commit || '').slice(0, 8)))].join(','),
        index_md5s: [...new Set(rs.map((r) => (r.index_aggregate_md5 || '').slice(0, 8)))].join(','),
        resolved_config_digests: [...new Set(rs.map((r) => (r.resolved_config_digest || '').slice(0, 8)))].join(','),
        hit_order_policies: [...new Set(rs.map((r) => r.hit_order_policy_tag))].join(','),
      });
    }
    out.q7_config_drift_sentinel = rows;
  }

  if (args.json) { console.log(JSON.stringify(out, null, 2)); return; }

  const titles = {
    q1_accept_band_by_arm: 'Q1  Accept-band distribution by arm (solved)',
    q2_wall_percentiles_by_arm: 'Q2  Wall-time percentiles by arm (ms)',
    q2b_wall_percentiles_by_arm_class: 'Q2b Wall-time percentiles by arm x truth_class (ms)',
    q3_scale_residual_by_stratum: 'Q3  Scale-residual & center-offset vs label, by truth stratum (solved+labeled)',
    q4_refusal_rate_by_arm: 'Q4  Refusal rate by arm (positives) + negative FP/TN',
    q5_post_accept_share_by_arm: 'Q5  Post-accept probe share by arm (abort benefit)',
    q6_truth_verdict_matrix: 'Q6  Truth-verdict matrix: arm x stratum',
    q7_config_drift_sentinel: 'Q7  Config-drift sentinel: distinct build/config per arm',
  };
  console.log(`\ngreenfield solve-telemetry drift queries  (node fallback; db=${args.db})`);
  console.log(`solves=${solves.length}  band_rows=${bands.length}\n`);
  for (const [key, val] of Object.entries(out)) {
    console.log(titles[key] || key);
    console.log(table(val));
    console.log('');
  }

  if (args.duckdb) runDuckDbCrosscheck(args.db).catch((e) => console.error('duckdb crosscheck:', e.message));
}

async function runDuckDbCrosscheck(db) {
  const bases = [path.join(REPO_ROOT, 'tools/results/package.json')];
  let mod = null;
  for (const base of bases) { try { const req = createRequire(base); const entry = req.resolve('@duckdb/node-api'); mod = await import(pathToFileURL(entry).href); break; } catch {} }
  if (!mod) { console.log('[--duckdb] @duckdb/node-api not resolvable; node results above are authoritative.'); return; }
  const { DuckDBInstance } = mod;
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  const sub = (sql) => sql
    .replace(/\$\{SOLVES\}/g, `read_json_auto('${path.join(db, 'solves.ndjson').replace(/\\/g, '/')}', maximum_object_size=104857600)`)
    .replace(/\$\{BANDS\}/g, `read_json_auto('${path.join(db, 'solve_bands.ndjson').replace(/\\/g, '/')}', maximum_object_size=104857600)`);
  console.log('\n=== DuckDB SQL cross-check (tools/telemetry/greenfield/sql/*.sql over NDJSON) ===');
  for (const f of fs.readdirSync(SQL_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = sub(fs.readFileSync(path.join(SQL_DIR, f), 'utf8'));
    try {
      const reader = await conn.runAndReadAll(sql);
      const rows = reader.getRowObjectsJson ? reader.getRowObjectsJson() : reader.getRowObjects();
      console.log(`\n-- ${f} -> ${rows.length} rows`);
      console.log(table(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])))));
    } catch (e) { console.log(`\n-- ${f} FAILED: ${e.message.slice(0, 160)}`); }
  }
}

main();
