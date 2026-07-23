#!/usr/bin/env node
// verify_r2.mjs — round-trip proof of the R2 parquet load via DuckDB httpfs/S3.
// ============================================================================
// Proves (per task VERIFY contract):
//   (a) frames row count read over R2 == local parquet count
//   (b) one real analytic query returns sane numbers (confirmed-frame count by rig)
//   (c) dedup spot-check: at least one frame_sha256 with >1 distinct receipt_sha256
//       (a re-run under a different engine/config) shows BOTH rows.
//
// Credentials from src/engine/ui/dashboard/.env.r2 (gitignored) — never printed.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const argv = process.argv.slice(2);
function opt(name, def) { const i = argv.indexOf('--' + name); if (i === -1) return def; const v = argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; }
const DIR = path.resolve(opt('dir', 'D:/AstroLogic/test_artifacts/results_etl_2026-07-17'));
const BUCKET = String(opt('bucket', 'community-database'));
const PREFIX = String(opt('prefix', 'results/v0-testdev/')).replace(/^\/+/, '').replace(/\/*$/, '/');
const ENV_FILE = opt('env', path.join(REPO_ROOT, 'src/engine/ui/dashboard/.env.r2'));

function loadEnvFile(p) {
  const out = {}; if (!fs.existsSync(p)) return out;
  for (let line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    line = line.trim(); if (!line || line.startsWith('#')) continue; line = line.replace(/^export\s+/, '');
    const eq = line.indexOf('='); if (eq === -1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

function rows(reader) { return reader.getRows(); }

async function main() {
  const file = loadEnvFile(ENV_FILE);
  const accountId = process.env.R2_ACCOUNT_ID || file.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID || file.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY || file.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKey || !secretKey) { console.error('[verify] FATAL: no R2 credentials.'); process.exit(1); }
  const endpointHost = (process.env.R2_ENDPOINT || file.R2_ENDPOINT || `${accountId}.r2.cloudflarestorage.com`).replace(/^https?:\/\//, '').replace(/\/$/, '');

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run('INSTALL httpfs; LOAD httpfs;');
  // secret with the actual credential values — never echoed
  await conn.run(`CREATE OR REPLACE SECRET r2 (TYPE s3, KEY_ID '${accessKey.replace(/'/g, "''")}', SECRET '${secretKey.replace(/'/g, "''")}', ENDPOINT '${endpointHost}', REGION 'auto', URL_STYLE 'path', USE_SSL true);`);

  const s3 = (t) => `s3://${BUCKET}/${PREFIX}${t}/**/*.parquet`;
  const localGlob = (t) => path.join(DIR, t).replace(/\\/g, '/') + '/**/*.parquet';

  const result = { bucket: BUCKET, prefix: PREFIX };

  // (a) row-count parity: R2 vs local, all four tables
  result.counts = {};
  for (const t of ['frames', 'stars', 'detections', 'crashes']) {
    const r2c = Number(rows(await conn.runAndReadAll(`SELECT count(*) FROM read_parquet('${s3(t)}', hive_partitioning=1);`))[0][0]);
    let localc = null; try { localc = Number(rows(await conn.runAndReadAll(`SELECT count(*) FROM read_parquet('${localGlob(t)}', hive_partitioning=1);`))[0][0]); } catch {}
    result.counts[t] = { r2: r2c, local: localc, match: r2c === localc };
  }

  // (b) analytic query: confirmed-frame count by rig (camera_model), over R2
  const byRig = rows(await conn.runAndReadAll(
    `SELECT coalesce(rig,'(null)') AS rig,
            count(*) AS frames,
            count(*) FILTER (WHERE confirm_status='CONFIRMED') AS confirmed,
            count(*) FILTER (WHERE solved) AS solved
     FROM read_parquet('${s3('frames')}', hive_partitioning=1)
     GROUP BY 1 ORDER BY confirmed DESC, frames DESC LIMIT 15;`));
  result.confirmed_by_rig = byRig.map((r) => ({ rig: r[0], frames: Number(r[1]), confirmed: Number(r[2]), solved: Number(r[3]) }));

  // supplementary analytic: pixel-scale bucket histogram (arcsec/px), solved frames
  const scaleHist = rows(await conn.runAndReadAll(
    `SELECT CASE WHEN pixel_scale_arcsec_px < 2 THEN '[0,2)'
                 WHEN pixel_scale_arcsec_px < 5 THEN '[2,5)'
                 WHEN pixel_scale_arcsec_px < 20 THEN '[5,20)'
                 WHEN pixel_scale_arcsec_px < 70 THEN '[20,70)'
                 ELSE '>=70' END AS scale_bucket,
            count(*) AS n
     FROM read_parquet('${s3('frames')}', hive_partitioning=1)
     WHERE solved AND pixel_scale_arcsec_px IS NOT NULL
     GROUP BY 1 ORDER BY 1;`));
  result.scale_bucket_hist = scaleHist.map((r) => ({ bucket: r[0], n: Number(r[1]) }));

  // schema_version partition counts over R2 (proves hive partitioning intact)
  const byVer = rows(await conn.runAndReadAll(
    `SELECT schema_version, count(*) n FROM read_parquet('${s3('frames')}', hive_partitioning=1) GROUP BY 1 ORDER BY n DESC;`));
  result.frames_by_schema_version = byVer.map((r) => ({ schema_version: r[0], n: Number(r[1]) }));

  // (c) dedup spot-check: a frame_sha256 with >1 distinct receipt_sha256
  const dupFrames = rows(await conn.runAndReadAll(
    `SELECT frame_sha256, count(DISTINCT receipt_sha256) AS n_receipts
     FROM read_parquet('${s3('frames')}', hive_partitioning=1)
     WHERE frame_sha256 IS NOT NULL
     GROUP BY 1 HAVING count(DISTINCT receipt_sha256) > 1 ORDER BY n_receipts DESC LIMIT 5;`));
  result.dedup_multi_receipt_frames = dupFrames.map((r) => ({ frame_sha256: r[0], n_receipts: Number(r[1]) }));

  if (dupFrames.length) {
    const fsha = dupFrames[0][0];
    const detail = rows(await conn.runAndReadAll(
      `SELECT receipt_sha256, schema_version, engine_version, coalesce(config_overrides_sha256,'(none)') AS cfg, solved, confirm_status, receipt_basename
       FROM read_parquet('${s3('frames')}', hive_partitioning=1)
       WHERE frame_sha256='${fsha.replace(/'/g, "''")}' ORDER BY schema_version;`));
    result.dedup_example = { frame_sha256: fsha, rows: detail.map((r) => ({ receipt_sha256: String(r[0]).slice(0, 12), schema_version: r[1], engine_version: r[2], config_overrides_sha256: String(r[3]).slice(0, 12), solved: r[4], confirm_status: r[5], receipt_basename: r[6] })) };
  }

  // distinct receipts vs distinct frames (dedup stats over R2)
  const dd = rows(await conn.runAndReadAll(
    `SELECT count(*) AS distinct_receipts,
            count(DISTINCT frame_sha256) FILTER (WHERE frame_sha256 IS NOT NULL) AS distinct_frames,
            count(*) FILTER (WHERE frame_sha256 IS NULL) AS null_frame_identity
     FROM read_parquet('${s3('frames')}', hive_partitioning=1);`))[0];
  result.dedup_stats = { distinct_receipts: Number(dd[0]), distinct_frames: Number(dd[1]), null_frame_identity: Number(dd[2]) };

  // ---- detections tier (2026-07-17) --------------------------------------------
  const dsrc = `read_parquet('${s3('detections')}', hive_partitioning=1)`;
  const fsrc = `read_parquet('${s3('frames')}', hive_partitioning=1)`;

  // kept-vs-anomaly + matched-vs-unmatched split (the analytical core), over R2
  const detSplit = rows(await conn.runAndReadAll(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE kept) AS kept,
            count(*) FILTER (WHERE NOT kept) AS anomaly,
            count(*) FILTER (WHERE kept AND matched) AS matched_kept,
            count(*) FILTER (WHERE kept AND NOT matched) AS unmatched_kept
     FROM ${dsrc};`))[0];
  result.detections_split = { total: Number(detSplit[0]), kept: Number(detSplit[1]), anomaly: Number(detSplit[2]),
    matched_kept: Number(detSplit[3]), unmatched_kept: Number(detSplit[4]) };

  // culling_reason distribution (WHY rejected), over R2
  const cullDist = rows(await conn.runAndReadAll(
    `SELECT coalesce(culling_reason,'(null)') AS reason, count(*) AS n
     FROM ${dsrc} WHERE NOT kept GROUP BY 1 ORDER BY n DESC LIMIT 20;`));
  result.culling_reason_distribution = cullDist.map((r) => ({ reason: r[0], n: Number(r[1]) }));

  // (b) OWNER-GOAL analytic #1: matched vs unmatched kept detections per rig, plus
  //     the unmatched-kept fraction (the candidate LP/nebulosity/noise population).
  const detByRig = rows(await conn.runAndReadAll(
    `SELECT coalesce(f.rig,'(null)') AS rig,
            count(*) AS kept_detections,
            count(*) FILTER (WHERE d.matched) AS matched,
            count(*) FILTER (WHERE NOT d.matched) AS unmatched,
            round(100.0*count(*) FILTER (WHERE NOT d.matched)/count(*),1) AS unmatched_pct
     FROM ${dsrc} d JOIN ${fsrc} f USING (receipt_sha256)
     WHERE d.kept GROUP BY 1 ORDER BY kept_detections DESC LIMIT 15;`));
  result.kept_detections_by_rig = detByRig.map((r) => ({ rig: r[0], kept: Number(r[1]), matched: Number(r[2]), unmatched: Number(r[3]), unmatched_pct: Number(r[4]) }));

  // (b) OWNER-GOAL analytic #2: unmatched-kept detection count bucketed by mie_index
  //     (a light-scatter / haze proxy) — separability of star vs sky-glow population.
  const byMie = rows(await conn.runAndReadAll(
    `SELECT CASE WHEN mie_index IS NULL THEN '(null)'
                 WHEN mie_index < 0.2 THEN '[0,0.2)'
                 WHEN mie_index < 0.4 THEN '[0.2,0.4)'
                 WHEN mie_index < 0.6 THEN '[0.4,0.6)'
                 WHEN mie_index < 0.8 THEN '[0.6,0.8)'
                 ELSE '[0.8,inf)' END AS mie_bucket,
            count(*) FILTER (WHERE matched) AS matched,
            count(*) FILTER (WHERE NOT matched) AS unmatched
     FROM ${dsrc} WHERE kept GROUP BY 1 ORDER BY 1;`));
  result.kept_detections_by_mie_bucket = byMie.map((r) => ({ mie_bucket: r[0], matched: Number(r[1]), unmatched: Number(r[2]) }));

  // (c) frames gained the sky-condition columns AND they're non-null where measured.
  //     Reports non-null counts + the LP gradient (top-bottom) per rig.
  const cond = rows(await conn.runAndReadAll(
    `SELECT count(*) AS frames,
            count(background_level) AS bg_level_nn,
            count(noise_floor) AS noise_floor_nn,
            count(background_gradient) AS bg_gradient_nn,
            count(culling_tally_json) AS culling_tally_nn,
            count(cfa_klass) AS cfa_klass_nn,
            count(*) FILTER (WHERE milky_way_present) AS milky_way_frames,
            count(grid_w) AS grid_w_nn
     FROM ${fsrc};`))[0];
  result.frames_condition_columns = { frames: Number(cond[0]), background_level_nonnull: Number(cond[1]),
    noise_floor_nonnull: Number(cond[2]), background_gradient_nonnull: Number(cond[3]), culling_tally_nonnull: Number(cond[4]),
    cfa_klass_nonnull: Number(cond[5]), milky_way_present_frames: Number(cond[6]), grid_w_nonnull: Number(cond[7]) };

  const gradByRig = rows(await conn.runAndReadAll(
    `SELECT coalesce(rig,'(null)') AS rig, count(background_gradient) AS n,
            round(avg(background_gradient),4) AS mean_lp_gradient
     FROM ${fsrc} WHERE background_gradient IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 15;`));
  result.mean_lp_gradient_by_rig = gradByRig.map((r) => ({ rig: r[0], n: Number(r[1]), mean_lp_gradient: Number(r[2]) }));

  console.log(JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(DIR, 'verify_r2_result.json'), JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error('[verify] FATAL:', e.stack || e.message || e); process.exit(1); });
