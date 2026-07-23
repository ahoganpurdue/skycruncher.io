// atlas_to_arrow.mjs — JSON→Arrow atlas-sector converter, round-trip verifier, benchmark.
// ============================================================================
// WHY: each shipped Level-3 sector is a 2–27 MB JSON array of star rows. The app
// loads them with fetch().json() — JSON.parse of ~9 MB text on the hot solve path.
// This tool encodes the SAME rows into Apache Arrow columnar IPC (apache-arrow is
// already a dependency) so the loader can memory-map typed-array columns instead
// of parsing text + allocating 2.9M plain objects. This is the DE-RISK converter:
// it never touches the shipped JSON, writes only to test_results/ (gitignored),
// and proves value-equivalence before any loader flip is considered.
//
// HYBRID ROW SCHEMA (discovered from the REAL shipped data, NOT the stale generator):
//   Gaia row  (2.68M rows): { id:0, ra:DEGREES, dec, mag_g, bp_rp, pm_ra, pm_dec, source_id }
//   HYG  row  (0.22M rows): { id:!=0, [proper], ra:HOURS, dec, mag, [spect] }
//     - `proper` present in only ~216 rows; `spect` present in ~218,669 of 224,756.
//     - the two shapes are DISJOINT and the discriminator matches ingestStars():
//         isGaia = (source_id !== undefined) || (mag_g !== undefined)
//     - CRITICAL: `ra` UNITS DIFFER PER ROW (deg for Gaia, hours for HYG). We store
//       the raw value AS-IS and never normalize — round-trip must reproduce it exactly.
//
// COLUMN CONTRACT (single Arrow table per sector — this is the source of truth the
// TS decoder in atlas_arrow_codec.ts mirrors 1:1):
//   fmt        Uint8            0 = Gaia, 1 = HYG        (EXPLICIT hybrid discriminator)
//   id         Int32            Gaia:0, HYG: hyg id
//   ra         Float64          deg (Gaia) | hours (HYG), as-is
//   dec        Float64
//   mag        Float64          = mag_g (Gaia) | mag (HYG); key name chosen from fmt on decode
//   bp_rp      Float64 nullable Gaia only (null for HYG)
//   pm_ra      Float64 nullable Gaia only
//   pm_dec     Float64 nullable Gaia only
//   source_id  Float64 nullable Gaia only  — see SOURCE_ID note below
//   spect      Utf8    nullable HYG only, and null when the row omitted it
//   proper     Utf8    nullable HYG only, null when omitted
//
// WHY Float64 EVERYWHERE (not Float32) — FIDELITY over compactness:
//   JSON.parse yields Float64. Narrowing mag/ra/etc. to Float32 changes the value
//   (12.031 -> 12.031000137...), which would silently alter magnitude sorts and the
//   printed values — a behavior change. Gates-are-never-lowered / honest-or-absent:
//   the default format is byte-faithful. A lossy Float32 variant could compress
//   further but must be gated behind its own evidence; it is intentionally NOT shipped.
//
// SOURCE_ID note: values are ~1e18 — beyond Number.MAX_SAFE_INTEGER, so the atlas
//   generator already pre-rounded them to Float64 when it wrote the JSON. Because the
//   JSON decimal IS an exact double, storing it back as Float64 reproduces the exact
//   same String() (verified: String(parsed) === raw token). No BigInt/int64 needed;
//   using int64 would actually CHANGE gaia_id strings vs the current JSON path.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { Table, vectorFromArray, makeVector, tableToIPC, tableFromIPC, Float64, Utf8 } from 'apache-arrow';

const MAIN = 'k:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY';
const DEFAULT_SRC = path.join(MAIN, 'public/atlas/sectors');
const DEFAULT_OUT = path.join(MAIN, 'test_results/atlas_arrow');

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const SRC = opt('src', DEFAULT_SRC);
const OUT = opt('out', DEFAULT_OUT);
const LIVE_ONLY = opt('live-only', true) !== false; // default: only the 36 numeric sectors the adapter fetches

function liveSectorFilter(f) {
  return LIVE_ONLY ? /^level_3_sector_\d+\.json$/.test(f) : f.endsWith('.json');
}
function listSectors(dir) {
  return fs.readdirSync(dir).filter(liveSectorFilter).sort();
}

// ---- codec (ENCODE / DECODE) ----------------------------------------------
export function isGaiaRow(r) {
  return r.source_id !== undefined || r.mag_g !== undefined;
}

/** Encode an array of raw JSON rows -> Arrow IPC file bytes (Uint8Array). */
export function encodeRows(rows) {
  const n = rows.length;
  const fmt = new Uint8Array(n);
  const id = new Int32Array(n);
  const ra = new Float64Array(n);
  const dec = new Float64Array(n);
  const mag = new Float64Array(n);
  const bp_rp = new Array(n);
  const pm_ra = new Array(n);
  const pm_dec = new Array(n);
  const source_id = new Array(n);
  const spect = new Array(n);
  const proper = new Array(n);

  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const gaia = isGaiaRow(r);
    fmt[i] = gaia ? 0 : 1;
    id[i] = r.id | 0;
    ra[i] = r.ra;
    dec[i] = r.dec;
    if (gaia) {
      mag[i] = r.mag_g;
      bp_rp[i] = r.bp_rp;
      pm_ra[i] = r.pm_ra;
      pm_dec[i] = r.pm_dec;
      source_id[i] = r.source_id;
      spect[i] = null;
      proper[i] = null;
    } else {
      mag[i] = r.mag;
      bp_rp[i] = null;
      pm_ra[i] = null;
      pm_dec[i] = null;
      source_id[i] = null;
      // preserve PRESENCE, not just truthiness (absent -> null -> decode omits key)
      spect[i] = ('spect' in r) ? r.spect : null;
      proper[i] = ('proper' in r) ? r.proper : null;
    }
  }

  const table = new Table({
    fmt: makeVector(fmt),
    id: makeVector(id),
    ra: makeVector(ra),
    dec: makeVector(dec),
    mag: makeVector(mag),
    bp_rp: vectorFromArray(bp_rp, new Float64()),
    pm_ra: vectorFromArray(pm_ra, new Float64()),
    pm_dec: vectorFromArray(pm_dec, new Float64()),
    source_id: vectorFromArray(source_id, new Float64()),
    spect: vectorFromArray(spect, new Utf8()),
    proper: vectorFromArray(proper, new Utf8()),
  });
  return tableToIPC(table, 'file');
}

/**
 * Decode Arrow IPC bytes -> array of raw row objects, reproducing the ORIGINAL
 * key set + order (so JSON.stringify(decoded) == JSON.stringify(original) per row).
 * This mirrors the TS decoder used by the flag-gated loader.
 */
export function decodeToRows(ipcBytes) {
  const t = tableFromIPC(ipcBytes);
  const fmt = t.getChild('fmt').data[0].values;        // Uint8Array (zero-copy)
  const id = t.getChild('id').data[0].values;          // Int32Array
  const ra = t.getChild('ra').data[0].values;          // Float64Array
  const dec = t.getChild('dec').data[0].values;
  const mag = t.getChild('mag').data[0].values;
  const bp_rp = t.getChild('bp_rp');
  const pm_ra = t.getChild('pm_ra');
  const pm_dec = t.getChild('pm_dec');
  const source_id = t.getChild('source_id');
  const spect = t.getChild('spect');
  const proper = t.getChild('proper');

  const n = t.numRows;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (fmt[i] === 0) {
      // Gaia: id, ra, dec, mag_g, bp_rp, pm_ra, pm_dec, source_id
      out[i] = {
        id: id[i],
        ra: ra[i],
        dec: dec[i],
        mag_g: mag[i],
        bp_rp: bp_rp.get(i),
        pm_ra: pm_ra.get(i),
        pm_dec: pm_dec.get(i),
        source_id: source_id.get(i),
      };
    } else {
      // HYG: id, [proper], ra, dec, mag, [spect]
      const row = { id: id[i] };
      const p = proper.get(i);
      if (p !== null) row.proper = p;
      row.ra = ra[i];
      row.dec = dec[i];
      row.mag = mag[i];
      const s = spect.get(i);
      if (s !== null) row.spect = s;
      out[i] = row;
    }
  }
  return out;
}

// ---- strict row equivalence ------------------------------------------------
function rowsEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!(k in b)) return false;
    const va = a[k], vb = b[k];
    if (typeof va === 'number') { if (!Object.is(va, vb)) return false; }
    else if (va !== vb) return false;
  }
  return true;
}

// ---- commands --------------------------------------------------------------
function fmtMs(ms) { return ms.toFixed(1) + 'ms'; }
function mb(bytes) { return (bytes / 1e6).toFixed(2) + 'MB'; }

function doConvert() {
  fs.mkdirSync(OUT, { recursive: true });
  const files = listSectors(SRC);
  console.log(`[convert] ${files.length} sectors  ${SRC} -> ${OUT}`);
  let jsonBytes = 0, arrowBytes = 0, rowsTotal = 0;
  const t0 = performance.now();
  for (const f of files) {
    const raw = fs.readFileSync(path.join(SRC, f), 'utf8');
    const rows = JSON.parse(raw);
    const ipc = encodeRows(rows);
    const outName = f.replace(/\.json$/, '.arrow');
    fs.writeFileSync(path.join(OUT, outName), ipc);
    jsonBytes += Buffer.byteLength(raw, 'utf8');
    arrowBytes += ipc.byteLength;
    rowsTotal += rows.length;
    process.stdout.write(`  ${f}: ${rows.length} rows  json ${mb(Buffer.byteLength(raw,'utf8'))} -> arrow ${mb(ipc.byteLength)}\n`);
  }
  console.log(`[convert] done ${rowsTotal} rows in ${fmtMs(performance.now()-t0)}`);
  console.log(`[convert] TOTAL json ${mb(jsonBytes)} -> arrow ${mb(arrowBytes)}  (${(100*arrowBytes/jsonBytes).toFixed(1)}% of JSON size)`);
}

function doVerify() {
  const sampleN = opt('sample', 8) === true ? 8 : Number(opt('sample', 8));
  const files = listSectors(SRC);
  // spread the sample across the file-size distribution
  const picks = [];
  const step = Math.max(1, Math.floor(files.length / sampleN));
  for (let i = 0; i < files.length && picks.length < sampleN; i += step) picks.push(files[i]);
  console.log(`[verify] round-trip on ${picks.length} sectors (of ${files.length})`);
  let totalRows = 0, mism = 0, fmtByteIdentical = true;
  for (const f of picks) {
    const raw = fs.readFileSync(path.join(SRC, f), 'utf8');
    const jsonRows = JSON.parse(raw);
    const ipc = encodeRows(jsonRows);
    const back = decodeToRows(ipc);
    if (back.length !== jsonRows.length) { console.log(`  ${f}: LENGTH MISMATCH ${back.length} != ${jsonRows.length}`); mism++; continue; }
    let bad = 0, strByte = 0;
    for (let i = 0; i < jsonRows.length; i++) {
      if (!rowsEqual(jsonRows[i], back[i])) { bad++; if (bad <= 3) console.log(`    row ${i}: JSON=${JSON.stringify(jsonRows[i])}  BIN=${JSON.stringify(back[i])}`); }
      // byte-identical re-serialization check (same keys AND order)
      if (JSON.stringify(jsonRows[i]) !== JSON.stringify(back[i])) strByte++;
    }
    if (strByte > 0) fmtByteIdentical = false;
    totalRows += jsonRows.length;
    mism += bad;
    console.log(`  ${f}: ${jsonRows.length} rows  value-mismatches=${bad}  stringify-mismatches=${strByte}  ${bad===0?'OK':'FAIL'}`);
  }
  console.log(`[verify] ${totalRows} rows checked, ${mism} value-mismatches, byte-identical-serialization=${fmtByteIdentical}`);
  console.log(mism === 0 ? '[verify] PASS — binary->rows is value-equivalent to JSON->rows' : '[verify] FAIL');
  if (mism !== 0) process.exitCode = 1;
}

// retained memory: heapUsed (JS objects) + arrayBuffers (off-heap TypedArray backing).
function memSnapshot() {
  if (global.gc) { global.gc(); global.gc(); }
  const m = process.memoryUsage();
  return { heap: m.heapUsed / 1e6, ab: m.arrayBuffers / 1e6 };
}
function bestOf(reps, fn) {
  let best = Infinity, out;
  for (let r = 0; r < reps; r++) {
    const t = performance.now();
    out = fn();
    const dt = performance.now() - t;
    if (dt < best) best = dt;
  }
  return { ms: best, out };
}

function doBench() {
  const files = listSectors(SRC);
  const sel = opt('sectors', null);
  let picks;
  if (sel && sel !== true) {
    const ids = String(sel).split(',');
    picks = ids.map(x => `level_3_sector_${x.trim()}.json`).filter(f => files.includes(f));
  } else {
    // representative spread: small, median, large by file size
    const withSize = files.map(f => ({ f, s: fs.statSync(path.join(SRC, f)).size })).sort((a, b) => a.s - b.s);
    const idx = [0, Math.floor(withSize.length*0.25), Math.floor(withSize.length*0.5), Math.floor(withSize.length*0.75), withSize.length-1];
    picks = [...new Set(idx)].map(i => withSize[i].f);
  }
  const arrowDir = OUT;
  console.log(`[bench] sectors: ${picks.join(', ')}`);
  console.log(`[bench] (arrow files expected in ${arrowDir}; run 'convert' first)`);
  console.log(`[bench] gc-exposed: ${global.gc ? 'yes' : 'NO (run node --expose-gc for memory numbers)'}`);
  console.log(`[bench] THREE tiers reported:`);
  console.log(`        (1) JSON.parse                      -> materializes 2.9M row objects (today's hot path)`);
  console.log(`        (2) Arrow tableFromIPC (lazy)        -> zero-copy columnar handles only, NO per-row objects`);
  console.log(`        (3) Arrow load + decodeToRows        -> materializes IDENTICAL row objects (fair drop-in vs JSON)`);
  const REPS = Number(opt('reps', 5) === true ? 5 : opt('reps', 5));

  for (const f of picks) {
    const jsonPath = path.join(SRC, f);
    const arrowPath = path.join(arrowDir, f.replace(/\.json$/, '.arrow'));
    const jsonBuf = fs.readFileSync(jsonPath);           // read cost excluded (both read from disk once)
    const jsonText = jsonBuf.toString('utf8');
    const arrowBuf = fs.existsSync(arrowPath) ? fs.readFileSync(arrowPath) : null;

    // ---- (1) JSON.parse ----
    const j = bestOf(REPS, () => JSON.parse(jsonText));
    const jsonRows = j.out.length;
    // retained memory of the parsed row objects
    let base = memSnapshot();
    const parsedHold = JSON.parse(jsonText);
    let after = memSnapshot();
    const jsonHeap = after.heap - base.heap, jsonAb = after.ab - base.ab;

    console.log(`\n  ${f}  (${jsonRows} rows)   json file ${mb(jsonBuf.length)}${arrowBuf ? `  arrow file ${mb(arrowBuf.length)} (${(100*arrowBuf.length/jsonBuf.length).toFixed(0)}%)` : ''}`);
    console.log(`    (1) JSON.parse       : ${fmtMs(j.ms).padStart(8)}  retained heap ${jsonHeap.toFixed(1)}MB + ab ${jsonAb.toFixed(1)}MB`);
    void parsedHold;

    if (!arrowBuf) { console.log(`    ARROW: (missing ${arrowPath} — run convert)`); continue; }

    // ---- (2) Arrow lazy load (columnar handles) ----
    const a2 = bestOf(REPS, () => { const t = tableFromIPC(arrowBuf); void t.getChild('ra').data[0].values.length; return t; });
    base = memSnapshot();
    const tblHold = tableFromIPC(arrowBuf);
    void tblHold.getChild('ra').data[0].values.length;
    after = memSnapshot();
    const aHeap = after.heap - base.heap, aAb = after.ab - base.ab;

    // ---- (3) Arrow load + decodeToRows (fair drop-in) ----
    const a3 = bestOf(REPS, () => decodeToRows(arrowBuf));
    base = memSnapshot();
    const rowsHold = decodeToRows(arrowBuf);
    after = memSnapshot();
    const a3Heap = after.heap - base.heap, a3Ab = after.ab - base.ab;

    console.log(`    (2) Arrow lazy       : ${fmtMs(a2.ms).padStart(8)}  retained heap ${aHeap.toFixed(1)}MB + ab ${aAb.toFixed(1)}MB   -> ${(j.ms/a2.ms).toFixed(0)}x vs JSON`);
    console.log(`    (3) Arrow + decode   : ${fmtMs(a3.ms).padStart(8)}  retained heap ${a3Heap.toFixed(1)}MB + ab ${a3Ab.toFixed(1)}MB   -> ${(j.ms/a3.ms).toFixed(1)}x vs JSON`);
    void tblHold; void rowsHold;
  }
}

// ---- dispatch --------------------------------------------------------------
if (cmd === 'convert') doConvert();
else if (cmd === 'verify') doVerify();
else if (cmd === 'bench') doBench();
else {
  console.log(`atlas_to_arrow — JSON<->Arrow atlas sector codec / benchmark
usage:
  node tools/atlas/atlas_to_arrow.mjs convert [--src DIR] [--out DIR] [--live-only=false]
  node tools/atlas/atlas_to_arrow.mjs verify  [--src DIR] [--sample N]
  node tools/atlas/atlas_to_arrow.mjs bench   [--src DIR] [--out DIR] [--sectors 13,19,22] [--reps 5]
defaults: src=${DEFAULT_SRC}
          out=${DEFAULT_OUT}  (gitignored)
notes: run 'convert' before 'bench'. bench prefers node --expose-gc for retained-memory numbers.`);
}
