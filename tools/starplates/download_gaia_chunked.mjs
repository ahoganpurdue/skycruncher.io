#!/usr/bin/env node
// download_gaia_chunked.mjs — resumable full-sky Gaia DR3 puller for STARPLATES.
// ============================================================================
// WHY (docs/STARPLATES_SPEC.md §0.1, §4): the existing gaia_vanguard_dr3.csv is
// truncated at the ESA TAP 3M-row cap, source_id-ordered — ~21% of the sky
// (the high-cell-id tail) is silently absent. Gaia source_id embeds HEALPix
// L12 NESTED in its top bits, so partitioning the pull by source_id RANGES is
// exactly partitioning it by sky cells: chunk k covers order-5 cells
// [k*cellsPerChunk, (k+1)*cellsPerChunk) via
//     lo = cellLo << 49        hi = (cellHiExcl << 49) - 1
// Every chunk stays far under the row cap (spec §4: "e.g. 64 queries ... each
// under the 3M cap"), and the union of chunks is the complete sky.
//
// BigInt end-to-end for source_id (spec §3.1 tooling trap): the shifted values
// exceed Number.MAX_SAFE_INTEGER — no source_id ever passes through a JS
// number here.
//
// PROTOCOL: ESA Gaia TAP (https://gea.esac.esa.int/tap-server/tap), UWS async
// job API (POST /async → 303 Location → poll /phase → GET /results/result),
// polite: strictly sequential chunks, backoff polling, delays between chunks,
// bounded retries. --smoke uses the /sync endpoint with TOP 50 for a
// connectivity check and skips gracefully offline (exit 0).
//
// OUTPUT: <out>/chunk_c5_SSSSS-EEEEE.csv, WIDE 13-column harvest header (owner
// ruling: "leave nothing unharvested" — the 7 plate columns plus
// phot_bp_mean_mag, phot_rp_mean_mag, phot_bp_rp_excess_factor,
// phot_variable_flag, ruwe, parallax). Directly consumable by
// build_release.mjs --csv <out>: the builder reads its columns by NAME from
// the header, ignores the extra harvest columns, and emits byte-identical
// release bytes — the cell schema and release format are unchanged; plates
// stay lean. Also <out>/ledger.json (resume state; per-chunk sha256 is over
// the whole result file including its header line; timestamps live here,
// never in release bytes). Re-running skips chunks already recorded done with
// matching bytes. The ledger pins the column set: resuming an --out dir whose
// ledger was written with a different column list is refused (old 7-column
// chunk dirs cannot be silently mixed with wide chunks — use a fresh --out).
//
// USAGE
//   node tools/starplates/download_gaia_chunked.mjs --smoke        # tiny wide-query connectivity test
//   node tools/starplates/download_gaia_chunked.mjs --dry-run      # print the chunk plan + size estimate
//   node tools/starplates/download_gaia_chunked.mjs                # full pull (~hours; resumable)
//     [--out D:/AstroLogic/catalogs/raw] [--chunks 64] [--mag-max 12.5]
//     [--start-chunk N] [--max-chunks N] [--maxrec 2900000]
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CELLS_TOTAL_T1, REQUIRED_COLUMNS } from './build_release.mjs';

const TAP_BASE = 'https://gea.esac.esa.int/tap-server/tap';
const TABLE = 'gaiadr3.gaia_source';
const USER_AGENT = 'skycruncher-starplates-downloader/1 (github: skycruncher; polite sequential puller)';
// WIDE harvest column set (owner ruling: "leave nothing unharvested"). The
// first 7 are the builder's REQUIRED_COLUMNS (plate columns — frozen); the
// rest are harvest-only science columns kept in the raw chunk CSVs for future
// use (photometric quality cuts, variability flags, astrometric quality,
// distance). The builder ignores them; plates stay lean.
const COLUMNS = [
  ...REQUIRED_COLUMNS,
  'phot_bp_mean_mag',
  'phot_rp_mean_mag',
  'phot_bp_rp_excess_factor',
  'phot_variable_flag',
  'ruwe',
  'parallax',
].join(',');
// The TAP result echoes the SELECT list as its CSV header line.
const EXPECTED_HEADER = COLUMNS;

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const OUT = path.resolve(opt('out', 'D:/AstroLogic/catalogs/raw'));
const CHUNKS = Number(opt('chunks', 64));
const MAG_MAX = Number(opt('mag-max', 12.5));
const MAXREC = Number(opt('maxrec', 2_900_000)); // per-chunk guard, under the 3M cap
const START_CHUNK = Number(opt('start-chunk', 0));
const MAX_CHUNKS = Number(opt('max-chunks', Infinity));
const SMOKE = argv.includes('--smoke');
const DRY_RUN = argv.includes('--dry-run');

if (!Number.isInteger(CHUNKS) || CHUNKS < 1 || CHUNKS > CELLS_TOTAL_T1) {
  console.error(`--chunks must be an integer in [1, ${CELLS_TOTAL_T1}]`);
  process.exit(1);
}

// ---- chunk plan: order-5-cell-aligned source_id ranges -----------------------
const cellsPerChunk = Math.ceil(CELLS_TOTAL_T1 / CHUNKS);
function chunkPlan() {
  const plan = [];
  for (let cellLo = 0; cellLo < CELLS_TOTAL_T1; cellLo += cellsPerChunk) {
    const cellHiExcl = Math.min(cellLo + cellsPerChunk, CELLS_TOTAL_T1);
    const lo = BigInt(cellLo) << 49n;
    const hi = (BigInt(cellHiExcl) << 49n) - 1n;
    const name = `chunk_c5_${String(cellLo).padStart(5, '0')}-${String(cellHiExcl - 1).padStart(5, '0')}`;
    plan.push({ name, cellLo, cellHiExcl, lo, hi });
  }
  return plan;
}

function adql(lo, hi, top = null) {
  const topClause = top ? `TOP ${top} ` : '';
  return `SELECT ${topClause}${COLUMNS} FROM ${TABLE} ` +
         `WHERE phot_g_mean_mag <= ${MAG_MAX} AND source_id BETWEEN ${lo} AND ${hi}`;
}

// ---- ledger (resume state; atomic tmp+rename) --------------------------------
const LEDGER_PATH = path.join(OUT, 'ledger.json');
function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) {
    return { version: 2, table: TABLE, columns: COLUMNS, mag_max: MAG_MAX, chunks_total: CHUNKS, cells_per_chunk: cellsPerChunk, chunks: {} };
  }
  const led = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  if (led.chunks_total !== CHUNKS || led.mag_max !== MAG_MAX) {
    console.error(`ledger at ${LEDGER_PATH} was written with --chunks ${led.chunks_total} --mag-max ${led.mag_max}; ` +
                  `re-run with the same values or use a fresh --out dir.`);
    process.exit(1);
  }
  // Column-set pin: chunk sha256/bytes in the ledger cover the whole result
  // file INCLUDING its header line, so a chunk pulled with a different column
  // list is a different artifact. Refuse to resume across a column-set change
  // (a version-1 ledger has no `columns` field — that was the 7-column era).
  if (led.columns !== COLUMNS) {
    console.error(`ledger at ${LEDGER_PATH} was written with columns "${led.columns ?? '(unrecorded: legacy 7-column pull)'}" ` +
                  `but this tool now harvests "${COLUMNS}"; chunks cannot be mixed across column sets — use a fresh --out dir ` +
                  `(or delete the ledger AND its chunk CSVs to re-pull wide).`);
    process.exit(1);
  }
  return led;
}
function saveLedger(led) {
  const tmp = LEDGER_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(led, null, 2) + '\n');
  fs.renameSync(tmp, LEDGER_PATH);
}

// ---- HTTP helpers -------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tapSubmitAsync(query) {
  const body = new URLSearchParams({
    REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', PHASE: 'RUN',
    MAXREC: String(MAXREC), QUERY: query,
  });
  const res = await fetch(`${TAP_BASE}/async`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body: body.toString(),
    redirect: 'manual',
  });
  const loc = res.headers.get('location');
  if ((res.status === 303 || res.status === 302 || res.status === 201) && loc) {
    return new URL(loc, `${TAP_BASE}/async`).toString();
  }
  throw new Error(`TAP async submit failed: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`);
}

async function tapPollPhase(jobUrl, timeoutMs = 60 * 60 * 1000) {
  const t0 = Date.now();
  let delay = 2000;
  for (;;) {
    const res = await fetch(`${jobUrl}/phase`, { headers: { 'user-agent': USER_AGENT } });
    const phase = (await res.text()).trim();
    if (phase === 'COMPLETED') return;
    if (phase === 'ERROR' || phase === 'ABORTED') {
      const err = await fetch(`${jobUrl}/error`, { headers: { 'user-agent': USER_AGENT } })
        .then((r) => r.text()).catch(() => '(no error doc)');
      throw new Error(`TAP job ${phase}: ${err.slice(0, 500)}`);
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`TAP job timed out after ${timeoutMs} ms (last phase ${phase})`);
    await sleep(delay);
    delay = Math.min(delay * 1.5, 30_000); // polite backoff
  }
}

async function tapDeleteJob(jobUrl) {
  try {
    await fetch(jobUrl, { method: 'DELETE', headers: { 'user-agent': USER_AGENT } });
  } catch { /* best effort — server reaps jobs anyway */ }
}

/** Stream the result to file; returns { rows, bytes, sha256 }. Validates header. */
async function streamResultToFile(url, filePath) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`result fetch failed: HTTP ${res.status}`);
  const tmp = filePath + '.tmp';
  const out = fs.createWriteStream(tmp);
  const hash = createHash('sha256');
  let bytes = 0, newlines = 0, headChecked = false, head = '', lastByte = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    if (!headChecked) {
      head += buf.toString('utf8');
      const nl = head.indexOf('\n');
      if (nl !== -1) {
        const headerLine = head.slice(0, nl).replace(/\r$/, '').trim();
        if (headerLine.toLowerCase() !== EXPECTED_HEADER) {
          out.destroy(); fs.rmSync(tmp, { force: true });
          throw new Error(`unexpected result header: "${headerLine}" (expected "${EXPECTED_HEADER}")`);
        }
        headChecked = true;
      }
    }
    bytes += buf.length;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) newlines++;
    if (buf.length > 0) lastByte = buf[buf.length - 1];
    hash.update(buf);
    if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  fs.renameSync(tmp, filePath);
  // data rows = line count minus the header line; the header consumed one
  // newline, and an unterminated final row still counts as a line.
  const rows = Math.max(0, newlines - 1 + (lastByte !== 0x0a && bytes > 0 ? 1 : 0));
  return { rows, bytes, sha256: hash.digest('hex') };
}

// ---- smoke test ----------------------------------------------------------------
async function smoke() {
  // one arbitrary order-5 cell, TOP 50 via the sync endpoint
  const cell = 2417;
  const lo = BigInt(cell) << 49n;
  const hi = ((BigInt(cell) + 1n) << 49n) - 1n;
  const query = adql(lo, hi, 50);
  console.log(`[smoke] sync query (45 s timeout): ${query}`);
  fs.mkdirSync(OUT, { recursive: true });
  const target = path.join(OUT, 'smoke_test.csv');
  try {
    const body = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: query });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45_000);
    const res = await fetch(`${TAP_BASE}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
      body: body.toString(),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    const lines = text.trim().split('\n');
    const headerLine = lines[0].replace(/\r$/, '').trim();
    if (headerLine.toLowerCase() !== EXPECTED_HEADER) throw new Error(`unexpected header "${headerLine}" (expected "${EXPECTED_HEADER}")`);
    fs.writeFileSync(target, text);
    const nRows = lines.length - 1;
    console.log(`[smoke] OK — ${nRows} rows x ${COLUMNS.split(',').length} columns from cell5=${cell} -> ${target}`);
    console.log(`[smoke] first data row: ${lines[1] ?? '(none)'}`);
    if (nRows > 0) {
      const dataBytes = Buffer.byteLength(lines.slice(1).join('\n'), 'utf8');
      console.log(`[smoke] measured ~${Math.round(dataBytes / nRows)} B/row wide (dry-run estimate assumes ~190 B/row).`);
    }
  } catch (e) {
    // Offline-first tooling discipline: no network is a SKIP, not a failure.
    console.log(`[smoke] SKIPPED (network unavailable or TAP unreachable): ${e.message ?? e}`);
  }
}

// ---- full pull --------------------------------------------------------------------
// Dry-run size estimate basis (documented estimates, not normative):
//   - rows: the capped 3,000,000-row gaia_vanguard_dr3.csv extraction measured
//     t1 cell coverage 0.8636 in its release manifest, so full-sky G<=12.5
//     ≈ 3.0e6 / 0.8636 ≈ 3.47e6 rows (assumes the default --mag-max 12.5).
//   - bytes/row: the legacy 7-column pull measured ~115 B/row; the 6 extra
//     harvest columns (two mags, excess factor, flag word, ruwe, full-precision
//     parallax + 6 commas) add ≈75 B/row → ~190 B/row wide.
const EST_ROWS_FULL_SKY = 3_470_000;
const EST_BYTES_PER_ROW_WIDE = 190;

async function run() {
  const plan = chunkPlan();
  console.log(`[dl] plan: ${plan.length} chunks x ${cellsPerChunk} order-5 cells, G<=${MAG_MAX}, MAXREC=${MAXREC}`);
  console.log(`[dl] columns (${COLUMNS.split(',').length}): ${COLUMNS}`);
  console.log(`[dl] out: ${OUT}`);
  if (DRY_RUN) {
    for (const c of plan) console.log(`  ${c.name}  cells [${c.cellLo}, ${c.cellHiExcl})  source_id [${c.lo}, ${c.hi}]`);
    const estBytes = EST_ROWS_FULL_SKY * EST_BYTES_PER_ROW_WIDE;
    console.log(`[dl] estimate (G<=12.5 full sky): ~${(EST_ROWS_FULL_SKY / 1e6).toFixed(2)}M rows x ~${EST_BYTES_PER_ROW_WIDE} B/row wide ` +
                `≈ ${(estBytes / 1e6).toFixed(0)} MB total, ~${(estBytes / plan.length / 1e6).toFixed(1)} MB/chunk average ` +
                `(sky density varies per chunk; every chunk stays far under MAXREC=${MAXREC}).`);
    console.log('[dl] --dry-run: no network calls made.');
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const led = loadLedger();
  let done = 0, skipped = 0, failed = 0, processedThisRun = 0;
  for (let k = 0; k < plan.length; k++) {
    if (k < START_CHUNK) continue;
    if (processedThisRun >= MAX_CHUNKS) break;
    const c = plan[k];
    const filePath = path.join(OUT, c.name + '.csv');
    const prev = led.chunks[c.name];
    if (prev?.status === 'done' && fs.existsSync(filePath) && fs.statSync(filePath).size === prev.bytes) {
      skipped++;
      continue;
    }
    processedThisRun++;
    console.log(`[dl] chunk ${k + 1}/${plan.length} ${c.name}  source_id [${c.lo}, ${c.hi}]`);
    let ok = false, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      let jobUrl = null;
      try {
        jobUrl = await tapSubmitAsync(adql(c.lo, c.hi));
        await tapPollPhase(jobUrl);
        const r = await streamResultToFile(`${jobUrl}/results/result`, filePath);
        if (r.rows >= MAXREC) {
          led.chunks[c.name] = { status: 'suspect_cap', ...r, cell_lo: c.cellLo, cell_hi_excl: c.cellHiExcl,
                                 source_id_lo: String(c.lo), source_id_hi: String(c.hi), finished_at: new Date().toISOString() };
          saveLedger(led);
          throw new Error(`chunk hit MAXREC=${MAXREC} — data truncated; re-run with more --chunks`);
        }
        led.chunks[c.name] = { status: 'done', ...r, cell_lo: c.cellLo, cell_hi_excl: c.cellHiExcl,
                               source_id_lo: String(c.lo), source_id_hi: String(c.hi), finished_at: new Date().toISOString() };
        saveLedger(led);
        console.log(`[dl]   done: ${r.rows} rows, ${(r.bytes / 1e6).toFixed(1)} MB, sha256=${r.sha256.slice(0, 12)}…`);
        ok = true;
        done++;
      } catch (e) {
        lastErr = e;
        console.log(`[dl]   attempt ${attempt}/3 failed: ${e.message ?? e}`);
        if (attempt < 3) await sleep(5000 * attempt);
      } finally {
        if (jobUrl) await tapDeleteJob(jobUrl);
      }
    }
    if (!ok) {
      failed++;
      led.chunks[c.name] = { ...(led.chunks[c.name] ?? {}), status: 'failed', error: String(lastErr?.message ?? lastErr),
                             finished_at: new Date().toISOString() };
      saveLedger(led);
    }
    await sleep(2000); // politeness gap between chunks
  }
  console.log(`[dl] run complete: ${done} downloaded, ${skipped} skipped (already done), ${failed} failed.`);
  console.log(`[dl] ledger: ${LEDGER_PATH}`);
  console.log(`[dl] build with: node tools/starplates/build_release.mjs --csv ${OUT}`);
  if (failed > 0) process.exitCode = 1;
}

if (SMOKE) smoke();
else run().catch((e) => { console.error('[dl] FATAL:', e.stack || e); process.exit(1); });
