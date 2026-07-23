#!/usr/bin/env node
/**
 * build_gaiapure_legacydepth_sectors.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPTH-MATCHED GAIA-PURE SECTORS — legacy-solve-lane train-unblock (ledger 537-538).
 *
 * WHY: the full-depth Gaia-pure store (36.9M rows) drowns the LEGACY verifyWCS
 * chance-match statistics, which were calibrated against the SHIPPED catalog
 * density. This set is HYG-free but statistically identical in density to the
 * shipped hybrid catalog: it reproduces the shipped depth profile (archive Gaia,
 * proven archive-Gaia ⊆ gaiapure with 0 drift, ledger 531) minus HYG, plus the
 * bright Tycho/Hipparcos supplement.
 *
 * RECIPE (deterministic filter job — NO re-pour, NO re-round):
 *   per sector N in 0..35:
 *     OUTPUT = [ archive level_3_sector_N.json rows with id===0 (the Gaia block),
 *                emitted BYTE-FOR-BYTE from source text (never re-serialized) ]
 *            + [ gaiapure level_3_sector_N.json rows tagged mag_system (the
 *                Tycho/Hip supplement), emitted byte-for-byte from source text ]
 *   HYG rows (archive id!==0, no mag_system) are DROPPED.
 *
 * Byte-preservation: object text substrings are copied verbatim from the source
 * files (never JSON.stringify'd), so Gaia rows are byte-identical to the archive
 * by construction. (Round-trip identity across all 39.7M rows was separately
 * proven, but verbatim copy is the strongest guarantee — immune to any Node
 * large-integer / number-format quirk on the ~4.6e18 source_id values.)
 *
 * OUTPUT DIR: D:/AstroLogic/atlas/sectors-2026.07-gaiapure-legacydepth/
 *   36 × level_3_sector_N.json  +  manifest.json
 *   (json-only, matching the live public/atlas/sectors consumer + gaiapure sibling)
 *
 * VERIFY GATE (in-script, on freshly re-read outputs):
 *   (1) per-sector rowcount == archive-Gaia-count + supplement-count
 *   (2) zero HYG rows  (every output row: id===0 OR mag_system present)
 *   (3) spot-diff 3 sectors' Gaia blocks BYTE-vs-archive
 *   (4) manifest: per-file sha256 + aggregate_md5 (same recipe as
 *       build_gaia_pure_sectors.mjs) + provenance (archive + gaiapure aggregates)
 *
 * WRITE JAIL: tools/atlas/ + test_results/ + the OUT_DIR only.
 * Inputs are READ-ONLY (via script reads; direct Read-tool on atlas is deny-listed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ARCHIVE_DIR = 'D:/AstroLogic/atlas/sectors-2026.07-hybrid-ARCHIVE';
const GAIAPURE_DIR = 'D:/AstroLogic/atlas/sectors-2026.07-gaiapure';
const OUT_DIR = 'D:/AstroLogic/atlas/sectors-2026.07-gaiapure-legacydepth';
const TR_DIR = 'test_results/atlas/gaiapure_legacydepth';
const SECTOR_COUNT = 36;
const GAIAPURE_AGGREGATE_MD5 = '5ffc9e76b0ede7290a34ab110da633ec'; // provenance anchor (ledger)

const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');
const md5 = (buf) => createHash('md5').update(buf).digest('hex');

/**
 * Split a one-object-per-line sector file (`[{obj},\n{obj},\n...{obj}]`, no
 * trailing newline) into the exact per-object text substrings (wrapping `[`/`]`
 * and per-line trailing commas removed; object bytes otherwise untouched).
 */
function objTexts(raw) {
  let s = raw;
  if (s.charCodeAt(0) === 0x5b /* [ */) s = s.slice(1);
  s = s.replace(/\s*$/, '');
  if (s.endsWith(']')) s = s.slice(0, -1);
  if (s.length === 0) return [];
  return s.split('\n').map((l) => (l.endsWith(',') ? l.slice(0, -1) : l));
}

function readObjTexts(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const texts = objTexts(raw);
  // structural sanity: the text-splitter must agree with a real JSON parse.
  const arr = JSON.parse(raw);
  if (arr.length !== texts.length) {
    throw new Error(`row-count split mismatch in ${p}: parse=${arr.length} split=${texts.length}`);
  }
  return { texts, arr };
}

function main() {
  const t0 = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(TR_DIR, { recursive: true });

  console.log('BUILD depth-matched gaia-pure (legacy density) sectors');
  console.log(`  archive : ${ARCHIVE_DIR}`);
  console.log(`  gaiapure: ${GAIAPURE_DIR}`);
  console.log(`  out     : ${OUT_DIR}\n`);

  const sectors = [];
  let totalGaia = 0;
  let totalSupp = 0;

  for (let n = 0; n < SECTOR_COUNT; n++) {
    const aPath = path.join(ARCHIVE_DIR, `level_3_sector_${n}.json`);
    const gPath = path.join(GAIAPURE_DIR, `level_3_sector_${n}.json`);
    const { texts: aTexts, arr: aArr } = readObjTexts(aPath);
    const { texts: gTexts, arr: gArr } = readObjTexts(gPath);

    // archive Gaia block (id===0) — verbatim source text, archive order
    const gaiaTexts = [];
    for (let i = 0; i < aArr.length; i++) if (aArr[i].id === 0) gaiaTexts.push(aTexts[i]);

    // gaiapure supplement block (mag_system tagged) — verbatim source text
    const suppTexts = [];
    for (let i = 0; i < gArr.length; i++) if (gArr[i].mag_system !== undefined) suppTexts.push(gTexts[i]);

    const all = gaiaTexts.concat(suppTexts);
    const outText = '[' + all.join(',\n') + ']';
    fs.writeFileSync(path.join(OUT_DIR, `level_3_sector_${n}.json`), outText);

    sectors.push({ id: n, gaia: gaiaTexts.length, supplement: suppTexts.length, total: all.length });
    totalGaia += gaiaTexts.length;
    totalSupp += suppTexts.length;
    process.stdout.write(`\r  sector ${n + 1}/${SECTOR_COUNT}  gaia=${gaiaTexts.length} supp=${suppTexts.length}   `);
  }
  console.log('\n');

  // ══ VERIFY GATE (independent re-read of outputs) ═══════════════════════════
  const findings = [];
  let hygViolations = 0;
  let countMismatch = 0;
  const perFile = {};

  for (let n = 0; n < SECTOR_COUNT; n++) {
    const p = path.join(OUT_DIR, `level_3_sector_${n}.json`);
    const buf = fs.readFileSync(p);
    const arr = JSON.parse(buf.toString('utf8'));

    // (1) rowcount == archive-Gaia + supplement
    const expected = sectors[n].gaia + sectors[n].supplement;
    if (arr.length !== expected) {
      countMismatch++;
      findings.push(`sector ${n}: rowcount ${arr.length} != gaia+supp ${expected}`);
    }
    // (2) zero HYG rows: every row id===0 OR mag_system present
    for (const r of arr) {
      if (!(r.id === 0 || r.mag_system !== undefined)) hygViolations++;
    }
    perFile[`level_3_sector_${n}.json`] = {
      sha256: sha256Buf(buf), bytes: buf.length,
      gaia: sectors[n].gaia, supplement: sectors[n].supplement, total: arr.length,
    };
  }
  if (hygViolations > 0) findings.push(`HYG rows present in output: ${hygViolations}`);

  // (3) spot-diff 3 sectors' Gaia blocks byte-vs-archive
  const spotSectors = [0, 17, 35];
  const spotResults = [];
  for (const n of spotSectors) {
    const { texts: aTexts, arr: aArr } = readObjTexts(path.join(ARCHIVE_DIR, `level_3_sector_${n}.json`));
    const archiveGaia = [];
    for (let i = 0; i < aArr.length; i++) if (aArr[i].id === 0) archiveGaia.push(aTexts[i]);
    const { texts: oTexts, arr: oArr } = readObjTexts(path.join(OUT_DIR, `level_3_sector_${n}.json`));
    const outGaia = [];
    for (let i = 0; i < oArr.length; i++) if (oArr[i].id === 0) outGaia.push(oTexts[i]);
    let identical = archiveGaia.length === outGaia.length;
    let firstDiff = -1;
    if (identical) {
      for (let i = 0; i < archiveGaia.length; i++) {
        if (archiveGaia[i] !== outGaia[i]) { identical = false; firstDiff = i; break; }
      }
    }
    spotResults.push({ sector: n, archiveGaia: archiveGaia.length, outGaia: outGaia.length, byteIdentical: identical, firstDiff });
    if (!identical) findings.push(`sector ${n}: Gaia block NOT byte-identical to archive (firstDiff row ${firstDiff}, lens ${archiveGaia.length}/${outGaia.length})`);
  }

  // (4) aggregate_md5 (same recipe as build_gaia_pure_sectors.mjs) + provenance
  const sortedShaLines = Object.keys(perFile).sort().map((k) => `${k}:${perFile[k].sha256}`).join('\n');
  const aggregate_md5 = md5(Buffer.from(sortedShaLines, 'utf8'));

  // archive provenance aggregate (same recipe over the 36 archive level_3_sector_N.json)
  const archivePerFile = {};
  for (let n = 0; n < SECTOR_COUNT; n++) {
    const p = path.join(ARCHIVE_DIR, `level_3_sector_${n}.json`);
    archivePerFile[`level_3_sector_${n}.json`] = sha256Buf(fs.readFileSync(p));
  }
  const archiveAggLines = Object.keys(archivePerFile).sort().map((k) => `${k}:${archivePerFile[k]}`).join('\n');
  const archive_aggregate_md5 = md5(Buffer.from(archiveAggLines, 'utf8'));

  const elapsed_s = (Date.now() - t0) / 1000;
  const gatesPass = findings.length === 0;

  const manifest = {
    boundary: 'atlas_rows_gaia_pure_legacydepth',
    description: 'Depth-matched Gaia-pure sector data plane for the LEGACY solve lane '
      + '(ledger 537-538). HYG-free but statistically identical in density to the shipped '
      + 'hybrid catalog, so the legacy verifyWCS chance-match statistics (calibrated against '
      + 'the shipped density) hold. Deterministic filter of two frozen inputs: archive Gaia '
      + 'block (byte-preserved) + gaiapure Tycho/Hip supplement. No re-pour, no re-round.',
    generated: new Date().toISOString(),
    built_by: 'tools/atlas/build_gaiapure_legacydepth_sectors.mjs',
    recipe: 'per sector N: OUTPUT = archive level_3_sector_N.json rows with id===0 (Gaia, byte-for-byte) '
      + '+ gaiapure level_3_sector_N.json rows with mag_system tag (Tycho/Hip supplement, byte-for-byte). '
      + 'HYG rows (archive id!==0, no mag_system) dropped.',
    gaia_row_schema: 'id=0, ra(DEG 4dp), dec(4dp), mag_g(3dp), bp_rp(3dp), pm_ra(1dp), pm_dec(1dp), source_id(Number). '
      + 'Byte-identical to the archive (shipped) Gaia rows.',
    supplement_row_schema: 'id(>=1), ra(DEG 4dp), dec(4dp), mag_g=NATIVE mag(3dp), mag_system, bt_vt?, cat, cat_id. '
      + 'NO bp_rp, NO source_id. Byte-identical to the gaiapure supplement rows.',
    provenance: {
      archive_dir: ARCHIVE_DIR,
      archive_aggregate_md5,
      archive_aggregate_recipe: 'md5 of sorted `file:sha256` lines over the 36 archive level_3_sector_N.json',
      gaiapure_dir: GAIAPURE_DIR,
      gaiapure_aggregate_md5: GAIAPURE_AGGREGATE_MD5,
    },
    counts: {
      gaia_rows: totalGaia,
      supplement_rows: totalSupp,
      total_rows: totalGaia + totalSupp,
    },
    verify_gate: {
      pass: gatesPass,
      rowcount_mismatches: countMismatch,
      hyg_violations: hygViolations,
      spot_diff: spotResults,
      findings,
    },
    aggregate_md5,
    files: perFile,
    sectors,
    elapsed_s,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(TR_DIR, 'build_summary.json'), JSON.stringify({
    generated: manifest.generated, counts: manifest.counts, aggregate_md5,
    archive_aggregate_md5, gaiapure_aggregate_md5: GAIAPURE_AGGREGATE_MD5,
    verify_gate: manifest.verify_gate, elapsed_s, out_dir: OUT_DIR,
  }, null, 2));

  // ══ report ═════════════════════════════════════════════════════════════════
  console.log('════════════════════════════════════════════════════════════');
  console.log(`GAIA rows      : ${totalGaia}`);
  console.log(`SUPPLEMENT rows: ${totalSupp}`);
  console.log(`TOTAL rows     : ${totalGaia + totalSupp}`);
  console.log('──── VERIFY GATE ────');
  console.log(`(1) rowcount == gaia+supp   : ${countMismatch === 0 ? 'PASS' : 'FAIL (' + countMismatch + ')'}`);
  console.log(`(2) zero HYG rows           : ${hygViolations === 0 ? 'PASS' : 'FAIL (' + hygViolations + ')'}`);
  console.log(`(3) Gaia block byte-vs-arch : ${spotResults.every((s) => s.byteIdentical) ? 'PASS' : 'FAIL'}  [sectors ${spotSectors.join(',')}]`);
  for (const s of spotResults) console.log(`      sector ${s.sector}: ${s.byteIdentical ? 'IDENTICAL' : 'DIFF@' + s.firstDiff} (${s.outGaia} rows)`);
  console.log(`(4) aggregate_md5           : ${aggregate_md5}`);
  console.log(`    archive_aggregate_md5   : ${archive_aggregate_md5}`);
  console.log(`    gaiapure_aggregate_md5  : ${GAIAPURE_AGGREGATE_MD5}`);
  console.log('─────────────────────');
  console.log(`GATES: ${gatesPass ? 'ALL PASS' : 'FAIL — ' + JSON.stringify(findings)}`);
  console.log(`manifest: ${path.join(OUT_DIR, 'manifest.json')}`);
  console.log(`elapsed_s: ${elapsed_s.toFixed(1)}`);
  console.log('════════════════════════════════════════════════════════════');

  process.exit(gatesPass ? 0 : 1);
}

main();
