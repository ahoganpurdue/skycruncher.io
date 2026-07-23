// build_release.mjs — STARPLATES reproducible release builder (DATA_PLATFORM step 0).
// (No shebang on purpose: vitest inlines this module through esbuild.transform,
// which does not strip shebangs — V8 then rejects `#!` at import. Invoke via
// `node tools/starplates/build_release.mjs ...`, never `./build_release.mjs`.)
// ============================================================================
// CONTRACT: docs/STARPLATES_SPEC.md — §2 (release layout + manifest), §3 (cell
// format), §4 (tiers). Read the spec first; the byte contracts there are FROZEN.
//
// WHAT THIS DOES
//   gaia_vanguard_dr3.csv (or a directory of chunk CSVs from
//   download_gaia_chunked.mjs — legacy 7-column OR wide-harvest CSVs; ingest
//   is column-NAME-driven, see REQUIRED_COLUMNS: extra harvested columns are
//   ignored and the release bytes are identical either way)
//     → T1: one Arrow IPC *file* per populated HEALPix order-5 NESTED cell,
//       partitioned by the source_id bit shift (cell5 = source_id >> 49 — no
//       ang2pix anywhere on the build path, spec §3.1)
//     → T0: single bright all-sky Arrow file (G ≤ 9.0), the bright prefix of
//       the T1 cells (spec §4: "T0 duplicates T1's bright prefix")
//     → manifest.json: content-addressed SHA-256 per blob, data-derived
//       per-cell cone bounds (center + radius), measured coverage.
//
// DETERMINISM (spec §3.3): same input bytes → identical output bytes.
//   - total row order: g_mag (f32) ascending, ties source_id ascending
//   - fixed schema + key-sorted custom metadata, no timestamps/paths/hostnames
//   - manifest floats: ECMAScript shortest-round-trip (see DEVIATIONS)
//   - verify with --verify-determinism (builds twice, compares bytes)
//
// DOCUMENTED DEVIATIONS from STARPLATES_SPEC.md (also recorded in the spec §13):
//   D1. The spec's forge is a Rust bin (`starplates_forge`, arrow-rs). This is
//       the Node/apache-arrow step-0 builder that produces the FIRST release
//       now; the Rust forge remains the wave-1 target. Manifest `writer`
//       honestly names this tool: "build_release.mjs/apache-arrow=<version>".
//   D2. Buffer alignment is 8-byte (apache-arrow JS writer default; the 64-byte
//       IpcWriteOptions knob is arrow-rs-only). Still valid Arrow IPC; the
//       manifest `schema.ipc` string records "8-byte alignment" honestly.
//   D3. JSON float serialization is ECMAScript shortest-round-trip: integral
//       floats print without ".0" (9 not 9.0); f32-derived stats (mag_min/max)
//       are printed as the f32 shortest round-trip (the exact stored value).
//   D4. Multi-file (chunk-directory) input: `source.extraction` is the sorted
//       basename list joined with ";", `extraction_sha256` is the SHA-256 of
//       the files' bytes concatenated in sorted-basename order.
//
// USAGE
//   node tools/starplates/build_release.mjs --csv gaia_vanguard_dr3.csv \
//        [--out test_results/starplates] [--release starplates-2026.07-gdr3] \
//        [--t0-mag 9.0] [--no-exclude-boundary] [--known-defect "<text>"] \
//        [--verify-determinism]
//
// Exports are consumed by src/engine/tests/starplates_build_release.test.ts.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  Schema, Field, Float64, Float32, Uint64, Struct, RecordBatch, Table,
  makeData, tableToIPC,
} from 'apache-arrow';

const require_ = createRequire(import.meta.url);
// apache-arrow's "exports" map hides ./package.json — resolve the entry point
// and walk up to the package root to read the pinned version.
const ARROW_VERSION = (() => {
  let dir = path.dirname(require_.resolve('apache-arrow'));
  for (let hops = 0; hops < 6; hops++) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (meta.name === 'apache-arrow') return meta.version;
    }
    dir = path.dirname(dir);
  }
  throw new Error('cannot locate apache-arrow package.json for the manifest writer string');
})();

// ---- normative constants (spec §2–§4) --------------------------------------
export const RELEASE_DEFAULT = 'starplates-2026.07-gdr3';
export const FORMAT_VERSION = 1;
export const HEALPIX_ORDER_T1 = 5;
export const CELLS_TOTAL_T1 = 12288;           // 12 * 4^5
export const CELLS_TOTAL_T2 = 49152;           // 12 * 4^6
export const T0_MAG_MAX_DEFAULT = 9.0;
export const T1_MAG_MAX_NOMINAL = 12.5;
export const EPOCH = 'J2016.0';
export const EPOCH_JD = 2457388.5;
// Columns the builder actually consumes. Ingest is column-NAME-driven: the
// CSV header is parsed and these names are looked up by position, so both the
// legacy 7-column extraction and wider harvest CSVs (extra columns such as
// phot_bp_mean_mag / ruwe / parallax, in any order) are accepted. The cell
// schema and release format are unchanged — plates stay lean; extra harvest
// columns are ignored on the build path.
export const REQUIRED_COLUMNS = ['source_id', 'ra', 'dec', 'phot_g_mean_mag', 'bp_rp', 'pmra', 'pmdec'];
// Legacy canonical 7-column header (the exact header of gaia_vanguard_dr3.csv).
export const CSV_HEADER = REQUIRED_COLUMNS.join(',');
export const KNOWN_DEFECT_DEFAULT =
  'ESA TAP 3M-row cap, source_id-ordered; ~21% of sky (high-cell-id tail) absent';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ---- cell assignment: ONLY the source_id shift (spec §3.1) ------------------
/** HEALPix order-5 NESTED cell from a full u64 Gaia DR3 source_id (BigInt). */
export function cell5OfSourceId(sourceId) {
  const c = Number(sourceId >> 49n);
  if (c < 0 || c >= CELLS_TOTAL_T1) {
    throw new Error(`cell5 out of range: source_id=${sourceId} -> cell ${c} (>= ${CELLS_TOTAL_T1})`);
  }
  return c;
}

/** HEALPix order-6 NESTED cell (reserved T2 partition) from a u64 source_id. */
export function cell6OfSourceId(sourceId) {
  const c = Number(sourceId >> 47n);
  if (c < 0 || c >= CELLS_TOTAL_T2) {
    throw new Error(`cell6 out of range: source_id=${sourceId} -> cell ${c} (>= ${CELLS_TOTAL_T2})`);
  }
  return c;
}

// ---- helpers ----------------------------------------------------------------
export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256FilesConcat(paths) {
  const h = createHash('sha256');
  for (const p of paths) {
    await new Promise((resolve, reject) => {
      const s = fs.createReadStream(p, { highWaterMark: 1 << 22 });
      s.on('data', (c) => h.update(c));
      s.on('end', resolve);
      s.on('error', reject);
    });
  }
  return h.digest('hex');
}

/**
 * Shortest decimal Number that round-trips through f32 (Math.fround) back to
 * `v` — the JS analogue of Rust ryu for f32 fields (deviation D3). Input must
 * already be an exact f32 value.
 */
export function f32Shortest(v) {
  if (!Number.isFinite(v)) throw new Error(`f32Shortest: non-finite ${v}`);
  if (Math.fround(v) !== v) throw new Error(`f32Shortest: ${v} is not an exact f32 value`);
  for (let p = 1; p <= 9; p++) {
    const s = v.toPrecision(p);
    if (Math.fround(Number(s)) === v) return Number(s);
  }
  return v;
}

// ---- growable column store ----------------------------------------------
function makeColumns(cap) {
  return {
    n: 0,
    cap,
    ra: new Float64Array(cap),
    dec: new Float64Array(cap),
    pmra: new Float32Array(cap),
    pmdec: new Float32Array(cap),
    g: new Float32Array(cap),
    bprp: new Float32Array(cap),
    sid: new BigUint64Array(cap),
    cell: new Uint16Array(cap),
  };
}

function growColumns(c) {
  const cap = c.cap * 2;
  for (const k of ['ra', 'dec', 'pmra', 'pmdec', 'g', 'bprp', 'sid', 'cell']) {
    const next = new c[k].constructor(cap);
    next.set(c[k]);
    c[k] = next;
  }
  c.cap = cap;
}

// ---- CSV ingest -------------------------------------------------------------
// Column-NAME-driven (harvest pulls wide; plates stay lean): the header line is
// parsed and REQUIRED_COLUMNS are located by name, so the legacy 7-column CSV
// and wider harvest CSVs (any column order, extra columns ignored) both build
// byte-identical releases from the same underlying rows. Values are simple
// comma-separated tokens — none of the harvested Gaia columns (including
// phot_variable_flag: NOT_AVAILABLE/CONSTANT/VARIABLE) ever contain commas or
// quoting, so a plain split(',') remains correct.
const SID_RE = /^[0-9]+$/;

async function ingestCsvFile(filePath, cols, dropped) {
  const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 22 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let isHeader = true;
  let lineNo = 0;
  let nCols = 0;
  let iSid = -1, iRa = -1, iDec = -1, iG = -1, iBprp = -1, iPmra = -1, iPmdec = -1;
  let requiredIdx = null;
  for await (let line of rl) {
    lineNo++;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (isHeader) {
      isHeader = false;
      const names = line.trim().split(',').map((s) => s.trim());
      requiredIdx = REQUIRED_COLUMNS.map((name) => names.indexOf(name));
      const absent = REQUIRED_COLUMNS.filter((_, i) => requiredIdx[i] === -1);
      if (absent.length > 0) {
        throw new Error(`${filePath}: CSV header (line 1) is missing required column(s) [${absent.join(', ')}]: ` +
                        `"${line.trim()}" — needs every one of "${CSV_HEADER}" (any order; extra harvest columns are ignored)`);
      }
      [iSid, iRa, iDec, iG, iBprp, iPmra, iPmdec] = requiredIdx;
      nCols = names.length;
      continue;
    }
    if (line.length === 0) continue;
    const parts = line.split(',');
    if (parts.length !== nCols) { dropped.malformed++; continue; }
    // spec §3.2: every column written with null count 0 — a row missing ANY
    // REQUIRED field is dropped and counted (stdout stats, never the manifest).
    // Blank values in extra harvest-only columns do not drop the row.
    let missing = false;
    for (let i = 0; i < requiredIdx.length; i++) if (parts[requiredIdx[i]] === '') { missing = true; break; }
    if (missing) { dropped.missing_field++; continue; }
    if (!SID_RE.test(parts[iSid])) { dropped.unparseable++; continue; }
    const ra = Number(parts[iRa]);
    const dec = Number(parts[iDec]);
    const g = Number(parts[iG]);
    const bprp = Number(parts[iBprp]);
    const pmra = Number(parts[iPmra]);
    const pmdec = Number(parts[iPmdec]);
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(g) ||
        !Number.isFinite(bprp) || !Number.isFinite(pmra) || !Number.isFinite(pmdec)) {
      dropped.unparseable++; continue;
    }
    if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) { dropped.out_of_range++; continue; }
    // BigInt end-to-end for source_id — spec §3.1 tooling trap: values exceed
    // Number.MAX_SAFE_INTEGER; never route them through a JS number.
    const sid = BigInt(parts[iSid]);
    const cell = cell5OfSourceId(sid); // throws (fails loudly) if out of range

    if (cols.n === cols.cap) growColumns(cols);
    const i = cols.n++;
    cols.ra[i] = ra;
    cols.dec[i] = dec;
    cols.pmra[i] = pmra;   // f32 store rounds — spec §3.2 (pm_ra_masyr: Float32)
    cols.pmdec[i] = pmdec;
    cols.g[i] = g;
    cols.bprp[i] = bprp;
    cols.sid[i] = sid;
    cols.cell[i] = cell;
  }
  return lineNo;
}

// ---- Arrow encoding (frozen cell contract, spec §3.2) -------------------------
const FIELDS = [
  new Field('ra_deg', new Float64(), false),
  new Field('dec_deg', new Float64(), false),
  new Field('pm_ra_masyr', new Float32(), false),
  new Field('pm_dec_masyr', new Float32(), false),
  new Field('g_mag', new Float32(), false),
  new Field('bp_rp', new Float32(), false),
  new Field('source_id', new Uint64(), false),
];

/**
 * Encode one blob: exactly one record batch, no validity buffers, IPC *file*
 * format, key-sorted custom metadata (spec §3.2). `rows` is {ra,dec,pmra,
 * pmdec,g,bprp,sid} of equal-length typed arrays already in final row order.
 */
export function encodeBlob(rows, meta) {
  const n = rows.ra.length;
  const metadata = new Map([...meta.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const schema = new Schema(FIELDS, metadata);
  const children = [
    makeData({ type: FIELDS[0].type, length: n, nullCount: 0, data: rows.ra }),
    makeData({ type: FIELDS[1].type, length: n, nullCount: 0, data: rows.dec }),
    makeData({ type: FIELDS[2].type, length: n, nullCount: 0, data: rows.pmra }),
    makeData({ type: FIELDS[3].type, length: n, nullCount: 0, data: rows.pmdec }),
    makeData({ type: FIELDS[4].type, length: n, nullCount: 0, data: rows.g }),
    makeData({ type: FIELDS[5].type, length: n, nullCount: 0, data: rows.bprp }),
    makeData({ type: FIELDS[6].type, length: n, nullCount: 0, data: rows.sid }),
  ];
  const structData = makeData({ type: new Struct(FIELDS), length: n, nullCount: 0, children });
  const batch = new RecordBatch(schema, structData);
  const table = new Table(schema, [batch]);
  return tableToIPC(table, 'file');
}

function blobMeta(release, tier, healpixOrder, cell) {
  return new Map([
    ['skycruncher.cell', cell === null ? '' : String(cell)],
    ['skycruncher.epoch', EPOCH],
    ['skycruncher.format_version', String(FORMAT_VERSION)],
    ['skycruncher.healpix_order', healpixOrder === null ? '' : String(healpixOrder)],
    ['skycruncher.release', release],
    ['skycruncher.tier', tier],
  ]);
}

// ---- geometry: data-derived cone bound (spec §2.3) --------------------------
// center = normalized mean unit vector; radius = max member angular distance.
// Unit-vector math — RA-wrap and pole safe by construction. The radius is
// measured against the ANGLE-QUANTIZED center (the exact center_ra/dec values
// the manifest carries — JSON shortest-round-trip is lossless for f64), so any
// consumer that rebuilds the center vector from the manifest gets every member
// inside the bound.
function coneBound(ra, dec) {
  const n = ra.length;
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    const raR = ra[i] * D2R, deR = dec[i] * D2R;
    const cd = Math.cos(deR);
    sx += cd * Math.cos(raR);
    sy += cd * Math.sin(raR);
    sz += Math.sin(deR);
  }
  const norm = Math.hypot(sx, sy, sz);
  if (norm === 0) throw new Error('coneBound: degenerate cell (zero mean vector)');
  let centerRa = Math.atan2(sy / norm, sx / norm) * R2D;
  if (centerRa < 0) centerRa += 360;
  if (centerRa >= 360) centerRa -= 360;
  const centerDec = Math.asin(Math.max(-1, Math.min(1, sz / norm))) * R2D;
  // rebuild the unit vector from the quantized angles, then measure the radius
  const cRaR = centerRa * D2R, cDecR = centerDec * D2R;
  const cx = Math.cos(cDecR) * Math.cos(cRaR);
  const cy = Math.cos(cDecR) * Math.sin(cRaR);
  const cz = Math.sin(cDecR);
  let minDot = 1;
  for (let i = 0; i < n; i++) {
    const raR = ra[i] * D2R, deR = dec[i] * D2R;
    const cd = Math.cos(deR);
    const dot = cx * cd * Math.cos(raR) + cy * cd * Math.sin(raR) + cz * Math.sin(deR);
    if (dot < minDot) minDot = dot;
  }
  const radius = Math.acos(Math.max(-1, Math.min(1, minDot))) * R2D;
  return { centerRa, centerDec, radius };
}

// ---- build ----------------------------------------------------------------
function resolveInputFiles(csvArg) {
  const p = path.resolve(csvArg);
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const files = fs.readdirSync(p).filter((f) => f.toLowerCase().endsWith('.csv')).sort();
    if (files.length === 0) throw new Error(`no .csv files in ${p}`);
    return { files: files.map((f) => path.join(p, f)), extraction: files.join(';') };
  }
  return { files: [p], extraction: path.basename(p) };
}

function gatherRows(cols, indices) {
  const m = indices.length;
  const out = {
    ra: new Float64Array(m), dec: new Float64Array(m),
    pmra: new Float32Array(m), pmdec: new Float32Array(m),
    g: new Float32Array(m), bprp: new Float32Array(m),
    sid: new BigUint64Array(m),
  };
  for (let j = 0; j < m; j++) {
    const i = indices[j];
    out.ra[j] = cols.ra[i];
    out.dec[j] = cols.dec[i];
    out.pmra[j] = cols.pmra[i];
    out.pmdec[j] = cols.pmdec[i];
    out.g[j] = cols.g[i];
    out.bprp[j] = cols.bprp[i];
    out.sid[j] = cols.sid[i];
  }
  return out;
}

/**
 * Build a full release directory. Returns build stats (incl. the manifest
 * object). Deterministic: no wall-clock, no randomness, no absolute paths in
 * any output byte.
 */
export async function buildRelease(opts) {
  const {
    csv,
    outDir,
    release = RELEASE_DEFAULT,
    t0MagMax = T0_MAG_MAX_DEFAULT,
    excludeBoundaryCell = true,
    knownDefect = KNOWN_DEFECT_DEFAULT,
    quiet = false,
  } = opts;
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const tStart = performance.now();

  const { files, extraction } = resolveInputFiles(csv);
  log(`[build] release=${release}`);
  log(`[build] input: ${files.length} file(s): ${extraction}`);

  // -- ingest ---------------------------------------------------------------
  const totalBytesIn = files.reduce((s, f) => s + fs.statSync(f).size, 0);
  const cols = makeColumns(Math.max(1024, Math.ceil(totalBytesIn / 95)));
  const dropped = { malformed: 0, missing_field: 0, unparseable: 0, out_of_range: 0, duplicate: 0 };
  let linesRead = 0;
  for (const f of files) linesRead += await ingestCsvFile(f, cols, dropped);
  const nRows = cols.n;
  const nDropped = dropped.malformed + dropped.missing_field + dropped.unparseable + dropped.out_of_range;
  log(`[build] ingested ${nRows} rows (${linesRead} lines incl. headers); dropped ${nDropped}: ${JSON.stringify(dropped)}`);

  // -- extraction hash (source lineage, manifest §2.3) ------------------------
  const extractionSha = await sha256FilesConcat(files);

  // -- partition: counting sort by cell ---------------------------------------
  const counts = new Uint32Array(CELLS_TOTAL_T1);
  for (let i = 0; i < nRows; i++) counts[cols.cell[i]]++;
  const offsets = new Uint32Array(CELLS_TOTAL_T1 + 1);
  for (let c = 0; c < CELLS_TOTAL_T1; c++) offsets[c + 1] = offsets[c] + counts[c];
  const order = new Uint32Array(nRows);
  {
    const cursor = Uint32Array.from(offsets.subarray(0, CELLS_TOTAL_T1));
    for (let i = 0; i < nRows; i++) order[cursor[cols.cell[i]]++] = i;
  }
  let populated = 0, highestCell = -1;
  for (let c = 0; c < CELLS_TOTAL_T1; c++) if (counts[c] > 0) { populated++; highestCell = c; }
  const excludedCell = excludeBoundaryCell && highestCell >= 0 ? highestCell : null;
  const excludedRows = excludedCell === null ? 0 : counts[excludedCell];
  const cellsPopulated = excludedCell === null ? populated : populated - 1;
  const coverageT1 = cellsPopulated / CELLS_TOTAL_T1;
  log(`[build] populated order-5 cells: ${populated}; excluded boundary cell: ${excludedCell === null ? '--' : excludedCell} (${excludedRows} rows); coverage=${coverageT1.toFixed(4)}`);

  // -- total row order (spec §3.2): g_mag(f32) asc, ties source_id asc --------
  const g32 = cols.g, sids = cols.sid;
  const cmp = (a, b) => {
    const ga = g32[a], gb = g32[b];
    if (ga < gb) return -1;
    if (ga > gb) return 1;
    const sa = sids[a], sb = sids[b];
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };

  // per-cell: dedupe by source_id (keep FIRST occurrence in input order —
  // deterministic; real Gaia extractions have unique source_ids, so any
  // duplicate is an input defect: dropped and counted, never written), then
  // sort into the total order.
  const dedupedSortedCellIndices = (c) => {
    const view = order.subarray(offsets[c], offsets[c + 1]);
    const seen = new Map(); // BigInt keys compare by value
    let dups = 0;
    for (let j = 0; j < view.length; j++) {
      const s = sids[view[j]];
      if (seen.has(s)) dups++;
      else seen.set(s, view[j]);
    }
    dropped.duplicate += dups;
    const idx = Uint32Array.from(seen.values());
    idx.sort(cmp);
    return idx;
  };

  // -- output dirs --------------------------------------------------------------
  const releaseDir = path.join(path.resolve(outDir), release);
  if (fs.existsSync(releaseDir)) {
    const entries = fs.readdirSync(releaseDir);
    const looksLikeRelease = entries.length === 0 ||
      entries.every((e) => ['manifest.json', 't0', 't1', 't2'].includes(e));
    if (!looksLikeRelease) {
      throw new Error(`refusing to overwrite ${releaseDir}: does not look like a release dir (${entries.join(', ')})`);
    }
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(releaseDir, 't0'), { recursive: true });
  fs.mkdirSync(path.join(releaseDir, 't1'), { recursive: true });

  // -- T1 cells (+ collect the T0 bright prefix in the same pass) ----------------
  // T0 threshold on the STORED f32 g_mag so T0 is exactly a row-prefix of each
  // sorted T1 cell (the LOD property readers rely on, spec §3.2/§4).
  const t0MagMax32 = Math.fround(t0MagMax);
  const t0Idx = [];
  const blobs = [];
  let t1Files = 0, t1Bytes = 0, t1Rows = 0;
  let largest = null, smallest = null;
  for (let c = 0; c < CELLS_TOTAL_T1; c++) {
    if (counts[c] === 0 || c === excludedCell) continue;
    const idx = dedupedSortedCellIndices(c);
    for (let j = 0; j < idx.length; j++) {
      if (g32[idx[j]] > t0MagMax32) break; // sorted: bright prefix ends here
      t0Idx.push(idx[j]);
    }
    const rows = gatherRows(cols, idx);
    const bytes = encodeBlob(rows, blobMeta(release, 't1', HEALPIX_ORDER_T1, c));
    const name = `c5-${String(c).padStart(5, '0')}.arrow`;
    fs.writeFileSync(path.join(releaseDir, 't1', name), bytes);
    const sha = sha256Bytes(bytes);
    const bound = coneBound(rows.ra, rows.dec);
    const blob = {
      path: `t1/${name}`,
      sha256: sha,
      bytes: bytes.byteLength,
      tier: 't1',
      healpix_order: HEALPIX_ORDER_T1,
      cell: c,
      rows: idx.length,
      mag_min: f32Shortest(rows.g[0]),
      mag_max: f32Shortest(rows.g[idx.length - 1]),
      source_epoch: EPOCH,
      coverage: 1.0,
      center_ra_deg: bound.centerRa,
      center_dec_deg: bound.centerDec,
      radius_deg: bound.radius,
    };
    blobs.push(blob);
    t1Files++; t1Bytes += bytes.byteLength; t1Rows += idx.length;
    if (!largest || idx.length > largest.rows) largest = { cell: c, rows: idx.length, bytes: bytes.byteLength };
    if (!smallest || idx.length < smallest.rows) smallest = { cell: c, rows: idx.length, bytes: bytes.byteLength };
    if (!quiet && t1Files % 2000 === 0) log(`[build]   ...${t1Files} cells written`);
  }
  log(`[build] T1: ${t1Files} cells, ${t1Rows} rows, ${(t1Bytes / 1e6).toFixed(1)} MB`);

  // -- T0 bright bootstrap: the bright prefix of the T1 cells (spec §4) ---------
  t0Idx.sort(cmp);
  const t0Rows = gatherRows(cols, Uint32Array.from(t0Idx));
  const t0BytesArr = encodeBlob(t0Rows, blobMeta(release, 't0', null, null));
  fs.writeFileSync(path.join(releaseDir, 't0', 'allsky.arrow'), t0BytesArr);
  const t0Blob = {
    path: 't0/allsky.arrow',
    sha256: sha256Bytes(t0BytesArr),
    bytes: t0BytesArr.byteLength,
    tier: 't0',
    healpix_order: null,
    cell: null,
    rows: t0Idx.length,
    mag_min: t0Idx.length ? f32Shortest(t0Rows.g[0]) : null,
    mag_max: t0Idx.length ? f32Shortest(t0Rows.g[t0Idx.length - 1]) : null,
    source_epoch: EPOCH,
    coverage: coverageT1, // T0's coverage = the sky fraction its source covered (spec §2.3)
    center_ra_deg: null,
    center_dec_deg: null,
    radius_deg: null,
  };
  log(`[build] T0: ${t0Idx.length} rows (G<=${t0MagMax}), ${(t0BytesArr.byteLength / 1e6).toFixed(2)} MB`);

  // -- manifest (spec §2.3 — exact key order, blobs sorted tier asc, cell asc) --
  const allBlobs = [t0Blob, ...blobs].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier < b.tier ? -1 : 1;
    const ca = a.cell === null ? -1 : a.cell;
    const cb = b.cell === null ? -1 : b.cell;
    return ca - cb;
  });
  const manifest = {
    release,
    format_version: FORMAT_VERSION,
    writer: `build_release.mjs/apache-arrow=${ARROW_VERSION}`,
    source: {
      catalog: 'Gaia DR3',
      epoch: EPOCH,
      epoch_jd: EPOCH_JD,
      extraction,
      extraction_sha256: extractionSha,
      known_defect: knownDefect,
    },
    schema: {
      columns: ['ra_deg:f64', 'dec_deg:f64', 'pm_ra_masyr:f32', 'pm_dec_masyr:f32',
                'g_mag:f32', 'bp_rp:f32', 'source_id:u64'],
      sort: 'g_mag asc, source_id asc',
      // 8-byte alignment: apache-arrow JS writer (deviation D2; spec target is 64)
      ipc: 'file-format, uncompressed, single record batch, 8-byte alignment, no validity buffers',
    },
    tiers: {
      t0: { kind: 'allsky-single-file', mag_range: [null, t0MagMax], coverage: coverageT1 },
      t1: {
        kind: 'cells', healpix_order: HEALPIX_ORDER_T1,
        mag_range: [null, T1_MAG_MAX_NOMINAL], coverage: coverageT1,
        cells_total: CELLS_TOTAL_T1, cells_populated: cellsPopulated,
        excluded_boundary_cell: excludedCell,
      },
      t2: {
        kind: 'cells', healpix_order: 6, mag_range: [12.5, 16.0], coverage: 0.0,
        status: 'RESERVED — no data in this release',
      },
    },
    blobs: allBlobs,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), manifestBytes);

  const elapsedMs = performance.now() - tStart;
  const stats = {
    release,
    releaseDir,
    linesRead,
    rowsIngested: nRows,
    dropped,
    cellsPopulatedBeforeExclusion: populated,
    excludedCell,
    excludedRows,
    cellsPopulated,
    coverageT1,
    t1Files,
    t1Rows,
    t1Bytes,
    t0Rows: t0Idx.length,
    t0Bytes: t0BytesArr.byteLength,
    largestCell: largest,
    smallestCell: smallest,
    manifestBytes: manifestBytes.byteLength,
    manifestSha256: sha256Bytes(manifestBytes),
    manifest,
    elapsedMs,
  };
  log(`[build] manifest: ${allBlobs.length} blobs, ${(manifestBytes.byteLength / 1e6).toFixed(2)} MB, sha256=${stats.manifestSha256}`);
  log(`[build] done in ${(elapsedMs / 1000).toFixed(1)}s -> ${releaseDir}`);
  return stats;
}

// ---- determinism verification (spec §3.3 gate) -------------------------------
export async function verifyDeterminism(opts, firstStats, { quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starplates-verify-'));
  try {
    log(`[determinism] second build -> ${tmp}`);
    const second = await buildRelease({ ...opts, outDir: tmp, quiet: true });
    const aPath = path.join(firstStats.releaseDir, 'manifest.json');
    const bPath = path.join(second.releaseDir, 'manifest.json');
    const a = fs.readFileSync(aPath);
    const b = fs.readFileSync(bPath);
    const manifestIdentical = a.equals(b);
    // The manifest content-addresses every blob (SHA-256 computed from the
    // bytes actually written), so identical manifests ⇒ identical blob bytes.
    // Belt-and-braces: re-hash every second-run blob against the first manifest.
    let blobsIdentical = true;
    for (const blob of firstStats.manifest.blobs) {
      const rehash = sha256Bytes(fs.readFileSync(path.join(second.releaseDir, blob.path)));
      if (rehash !== blob.sha256) { blobsIdentical = false; log(`[determinism] MISMATCH ${blob.path}`); break; }
    }
    const pass = manifestIdentical && blobsIdentical;
    log(`[determinism] manifest byte-identical: ${manifestIdentical}; all ${firstStats.manifest.blobs.length} blob SHAs re-verified: ${blobsIdentical}`);
    log(pass ? '[determinism] PASS — two runs produced byte-identical release bytes'
             : '[determinism] FAIL — build is NOT deterministic');
    return pass;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- CLI ---------------------------------------------------------------------
function opt(argv, name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function main() {
  const argv = process.argv.slice(2);
  const csv = opt(argv, 'csv', 'gaia_vanguard_dr3.csv');
  const outDir = opt(argv, 'out', 'test_results/starplates');
  const release = opt(argv, 'release', RELEASE_DEFAULT);
  const t0MagMax = Number(opt(argv, 't0-mag', T0_MAG_MAX_DEFAULT));
  const excludeBoundaryCell = !argv.includes('--no-exclude-boundary');
  const knownDefect = opt(argv, 'known-defect', KNOWN_DEFECT_DEFAULT);
  const doVerify = argv.includes('--verify-determinism');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`build_release.mjs — STARPLATES reproducible release builder (docs/STARPLATES_SPEC.md)
usage:
  node tools/starplates/build_release.mjs [--csv <file|chunk-dir>] [--out <dir>]
       [--release ${RELEASE_DEFAULT}] [--t0-mag 9.0]
       [--no-exclude-boundary] [--known-defect "<text>"] [--verify-determinism]
defaults: --csv gaia_vanguard_dr3.csv  --out test_results/starplates (gitignored)`);
    return;
  }

  const buildOpts = { csv, outDir, release, t0MagMax, excludeBoundaryCell, knownDefect };
  const stats = await buildRelease(buildOpts);

  console.log('');
  console.log('=== build summary ===');
  console.log(`release            ${stats.release}`);
  console.log(`rows ingested      ${stats.rowsIngested} (dropped ${JSON.stringify(stats.dropped)})`);
  console.log(`t1 cells written   ${stats.t1Files} (populated ${stats.cellsPopulatedBeforeExclusion}, boundary cell ${stats.excludedCell === null ? '--' : stats.excludedCell} excluded, ${stats.excludedRows} rows)`);
  console.log(`t1 rows/bytes      ${stats.t1Rows} rows / ${(stats.t1Bytes / 1e6).toFixed(1)} MB`);
  console.log(`t0 rows/bytes      ${stats.t0Rows} rows / ${(stats.t0Bytes / 1e6).toFixed(2)} MB`);
  console.log(`largest cell       ${stats.largestCell ? `c5-${stats.largestCell.cell} (${stats.largestCell.rows} rows, ${stats.largestCell.bytes} B)` : '--'}`);
  console.log(`smallest cell      ${stats.smallestCell ? `c5-${stats.smallestCell.cell} (${stats.smallestCell.rows} rows, ${stats.smallestCell.bytes} B)` : '--'}`);
  console.log(`coverage (t1)      ${stats.coverageT1}`);
  console.log(`manifest           ${stats.manifest.blobs.length} blobs, sha256=${stats.manifestSha256}`);
  console.log(`build time         ${(stats.elapsedMs / 1000).toFixed(1)}s`);

  if (doVerify) {
    const pass = await verifyDeterminism(buildOpts, stats);
    if (!pass) process.exitCode = 1;
  }
}

const isCli = process.argv[1] &&
  path.basename(process.argv[1]).toLowerCase() === 'build_release.mjs' &&
  import.meta.url.toLowerCase().endsWith('build_release.mjs');
if (isCli) {
  main().catch((e) => { console.error('[build] FATAL:', e.stack || e); process.exit(1); });
}
