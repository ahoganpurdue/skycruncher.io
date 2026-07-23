// starplates_build_release.test.ts — unit coverage for the STARPLATES release
// builder (tools/starplates/build_release.mjs; contract docs/STARPLATES_SPEC.md).
//
// Covers (spec §9.4 analogues for the Node step-0 builder):
//   1. cell assignment IS the source_id shift (§3.1), validated against a
//      TEST-ONLY reference ang2pix_nest on pinned real Gaia DR3 rows
//   2. manifest hashing: every blob SHA-256 in the manifest matches the bytes
//      on disk; manifest key order + blob sort order are the normative ones (§2.3)
//   3. determinism: two builds over the fixture CSV → byte-identical manifest
//      (which content-addresses every blob) (§3.3)
//   4. frozen cell format: Arrow IPC file, single batch, no validity buffers,
//      exact schema + metadata, g_mag-asc/source_id-asc row order (§3.2)
//   5. tier semantics: boundary-cell exclusion, T0 = bright prefix, measured
//      coverage, dropped-row accounting (§2.3, §4)
//   6. column-name-driven ingest: wide harvest CSVs (extra columns, any column
//      order) build releases byte-identical to the legacy 7-column input —
//      harvest pulls wide, plates stay lean; the cell/release format is frozen

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tableFromIPC } from 'apache-arrow';
import {
  buildRelease,
  cell5OfSourceId,
  cell6OfSourceId,
  f32Shortest,
  CELLS_TOTAL_T1,
  CELLS_TOTAL_T2,
  CSV_HEADER,
  RELEASE_DEFAULT,
  REQUIRED_COLUMNS,
  type BuildStats,
  type Manifest,
} from '../../../tools/starplates/build_release.mjs';

const FIXTURE_CSV = fileURLToPath(
  new URL('../../../tools/starplates/fixtures/mini_gaia_fixture.csv', import.meta.url),
);

// ─────────────────────────────────────────────────────────────────────────────
// TEST-ONLY reference implementation of HEALPix ang2pix NESTED (standard
// HEALPix C algorithm). STARPLATES_SPEC §3.1 forbids ang2pix on any build or
// runtime path — partitioning is only ever the source_id bit shift. This
// reference exists solely to prove the shift lands stars in the cell their
// (ra, dec) actually occupies (spec §13 deviation note D5).
// ─────────────────────────────────────────────────────────────────────────────
function interleaveBits(ix: number, iy: number): number {
  let p = 0;
  for (let b = 0; b < 16; b++) {
    p |= ((ix >> b) & 1) << (2 * b);
    p |= ((iy >> b) & 1) << (2 * b + 1);
  }
  return p >>> 0;
}

function ang2pixNest(nside: number, raDeg: number, decDeg: number): number {
  const z = Math.sin((decDeg * Math.PI) / 180);
  const za = Math.abs(z);
  let tt = (raDeg / 90) % 4; // phi / (pi/2)
  if (tt < 0) tt += 4;
  let face: number, ix: number, iy: number;
  if (za <= 2 / 3) {
    // equatorial region
    const temp1 = nside * (0.5 + tt);
    const temp2 = nside * (z * 0.75);
    const jp = Math.floor(temp1 - temp2);
    const jm = Math.floor(temp1 + temp2);
    const ifp = Math.floor(jp / nside);
    const ifm = Math.floor(jm / nside);
    if (ifp === ifm) face = (ifp & 3) + 4;
    else if (ifp < ifm) face = ifp & 3;
    else face = (ifm & 3) + 8;
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    // polar caps
    const ntt = Math.min(3, Math.floor(tt));
    const tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    let jp = Math.floor(tp * tmp);
    let jm = Math.floor((1 - tp) * tmp);
    jp = Math.min(jp, nside - 1);
    jm = Math.min(jm, nside - 1);
    if (z >= 0) {
      face = ntt;
      ix = nside - jm - 1;
      iy = nside - jp - 1;
    } else {
      face = ntt + 8;
      ix = jp;
      iy = jm;
    }
  }
  return face * nside * nside + interleaveBits(ix, iy);
}

// Pinned REAL Gaia DR3 rows — sampled 2026-07-09 from gaia_vanguard_dr3.csv
// (source lineage: docs/STARPLATES_SPEC.md §0). A 3,010-row systematic sample
// of the full CSV showed 100.000% shift-vs-ang2pix agreement at both orders;
// these 12 span both hemispheres, the equatorial band, and a near-polar cell.
const PINNED: Array<{ sid: bigint; ra: number; dec: number }> = [
  { sid: 2851858288640n, ra: 45.132144414036745, dec: 0.1378535532444834 },
  { sid: 423655818903802112n, ra: 13.544355838851853, dec: 55.591920758221946 },
  { sid: 1035168928873062272n, ra: 125.4688331790362, dec: 58.06293047546712 },
  { sid: 1232743304299923584n, ra: 214.8972731081369, dec: 17.27762728982591 },
  { sid: 2034002266962072576n, ra: 299.9590160453142, dec: 32.226866313345916 },
  { sid: 2519880234804252544n, ra: 33.94884714265845, dec: 5.650713473812548 },
  { sid: 3108754920070679168n, ra: 106.10730847049518, dec: -2.8806043916770063 },
  { sid: 3752511414686946560n, ra: 156.0271506338941, dec: -14.094219516537777 },
  { sid: 3037781203976780800n, ra: 120.51133475126476, dec: -11.206443709786415 },
  { sid: 5364293588688508160n, ra: 157.67030769625447, dec: -48.93433066298961 },
  { sid: 4618061880198965888n, ra: 33.734931106426906, dec: -82.77397640216178 },
  { sid: 5480889203303788416n, ra: 90.55593614611284, dec: -63.12513775138284 },
];

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

// ─────────────────────────────────────────────────────────────────────────────
describe('starplates cell assignment — source_id shift (spec §3.1)', () => {
  it('maps synthetic source_ids to their order-5 cell across the full range', () => {
    for (const c of [0, 1, 2417, 6143, 12287]) {
      expect(cell5OfSourceId(BigInt(c) << 49n)).toBe(c); // lower cell boundary
      expect(cell5OfSourceId(((BigInt(c) + 1n) << 49n) - 1n)).toBe(c); // upper boundary
    }
  });

  it('maps synthetic source_ids to their order-6 cell', () => {
    for (const c of [0, 9668, 49151]) {
      expect(cell6OfSourceId(BigInt(c) << 47n)).toBe(c);
      expect(cell6OfSourceId(((BigInt(c) + 1n) << 47n) - 1n)).toBe(c);
    }
  });

  it('fails loudly when the shift lands outside the cell range', () => {
    expect(() => cell5OfSourceId(BigInt(CELLS_TOTAL_T1) << 49n)).toThrow(/out of range/);
    expect(() => cell6OfSourceId(BigInt(CELLS_TOTAL_T2) << 47n)).toThrow(/out of range/);
  });

  it('order-5 cell is the order-6 cell shifted down two bits (nested hierarchy)', () => {
    for (const p of PINNED) {
      expect(cell5OfSourceId(p.sid)).toBe(cell6OfSourceId(p.sid) >> 2);
    }
  });

  it('agrees with the test-only reference ang2pix_nest on pinned real Gaia rows', () => {
    for (const p of PINNED) {
      expect(cell5OfSourceId(p.sid)).toBe(ang2pixNest(32, p.ra, p.dec));
      expect(cell6OfSourceId(p.sid)).toBe(ang2pixNest(64, p.ra, p.dec));
    }
  });
});

describe('f32Shortest — manifest float honesty (deviation D3)', () => {
  it('emits the shortest decimal that round-trips through f32', () => {
    const v = Math.fround(12.356248);
    const s = f32Shortest(v);
    expect(Math.fround(s)).toBe(v);
    expect(String(s).length).toBeLessThanOrEqual(String(v).length);
    expect(f32Shortest(9)).toBe(9);
    expect(f32Shortest(Math.fround(0.81036854))).toBe(0.81036854);
  });

  it('rejects values that are not exact f32', () => {
    expect(() => f32Shortest(12.356248)).toThrow(/not an exact f32/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('starplates release build on the committed fixture CSV', () => {
  let outA: string;
  let outB: string;
  let stats: BuildStats;
  let statsB: BuildStats;

  beforeAll(async () => {
    outA = fs.mkdtempSync(path.join(os.tmpdir(), 'starplates-test-a-'));
    outB = fs.mkdtempSync(path.join(os.tmpdir(), 'starplates-test-b-'));
    const opts = {
      csv: FIXTURE_CSV,
      release: 'starplates-fixture',
      knownDefect: 'fixture subset - not a full-sky extraction',
      quiet: true,
    };
    stats = await buildRelease({ ...opts, outDir: outA });
    statsB = await buildRelease({ ...opts, outDir: outB });
  });

  afterAll(() => {
    fs.rmSync(outA, { recursive: true, force: true });
    fs.rmSync(outB, { recursive: true, force: true });
  });

  it('drops (and counts) the row with a missing field instead of writing nulls', () => {
    // fixture carries exactly one row with a blanked bp_rp (spec §3.2: no
    // validity buffers — incomplete rows are dropped, counted on stdout/stats)
    expect(stats.dropped.missing_field).toBe(1);
    expect(stats.rowsIngested).toBe(72);
  });

  it('drops (and counts) duplicate source_ids instead of writing them twice', () => {
    // the fixture repeats one real bright row (sid 132667245587072) — the
    // builder must keep exactly one copy and count the duplicate
    expect(stats.dropped.duplicate).toBe(1);
    const cell0 = stats.manifest.blobs.find((b) => b.path === 't1/c5-00000.arrow')!;
    expect(cell0.rows).toBe(7); // 8 raw rows in cell 0, 1 duplicate dropped
  });

  it('excludes the highest populated cell as the capped boundary cell (spec §2.3)', () => {
    expect(stats.manifest.tiers.t1.excluded_boundary_cell).toBe(9738);
    expect(stats.cellsPopulatedBeforeExclusion).toBe(13);
    expect(stats.manifest.tiers.t1.cells_populated).toBe(12);
    const paths = stats.manifest.blobs.map((b) => b.path);
    expect(paths).not.toContain('t1/c5-09738.arrow');
    // measured coverage, never assumed
    expect(stats.manifest.tiers.t1.coverage).toBeCloseTo(12 / 12288, 12);
  });

  it('manifest hashing: every blob sha256/bytes matches the file on disk', () => {
    for (const blob of stats.manifest.blobs) {
      const bytes = fs.readFileSync(path.join(stats.releaseDir, blob.path));
      expect(bytes.byteLength).toBe(blob.bytes);
      expect(sha256(bytes)).toBe(blob.sha256);
    }
  });

  it('manifest key order and blob sort follow spec §2.3 exactly', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(stats.releaseDir, 'manifest.json'), 'utf8'));
    expect(Object.keys(raw)).toEqual(['release', 'format_version', 'writer', 'source', 'schema', 'tiers', 'blobs']);
    expect(Object.keys(raw.source)).toEqual(['catalog', 'epoch', 'epoch_jd', 'extraction', 'extraction_sha256', 'known_defect']);
    expect(Object.keys(raw.blobs[0])).toEqual([
      'path', 'sha256', 'bytes', 'tier', 'healpix_order', 'cell', 'rows',
      'mag_min', 'mag_max', 'source_epoch', 'coverage',
      'center_ra_deg', 'center_dec_deg', 'radius_deg',
    ]);
    // blobs sorted (tier asc, cell asc); t0 first
    expect(raw.blobs[0].tier).toBe('t0');
    const cells = raw.blobs.slice(1).map((b: { cell: number }) => b.cell);
    expect(cells).toEqual([...cells].sort((a, b) => a - b));
    // no wall-clock anywhere in release bytes
    expect(JSON.stringify(raw)).not.toMatch(/timestamp|built_at|date/i);
  });

  it('determinism: two builds produce byte-identical manifests (spec §3.3 gate)', () => {
    const a = fs.readFileSync(path.join(stats.releaseDir, 'manifest.json'));
    const b = fs.readFileSync(path.join(statsB.releaseDir, 'manifest.json'));
    expect(a.equals(b)).toBe(true);
    // manifest content-addresses every blob, so equal manifests ⇒ equal blob
    // bytes; spot-verify by re-hashing run B's files against run A's manifest
    for (const blob of stats.manifest.blobs) {
      const again = fs.readFileSync(path.join(statsB.releaseDir, blob.path));
      expect(sha256(again)).toBe(blob.sha256);
    }
    expect(statsB.manifestSha256).toBe(stats.manifestSha256);
  });

  it('cell files honor the frozen Arrow contract (spec §3.2)', () => {
    const blob = stats.manifest.blobs.find((b) => b.path === 't1/c5-00000.arrow');
    expect(blob).toBeDefined();
    const bytes = fs.readFileSync(path.join(stats.releaseDir, blob!.path));
    // ARROW1 magic head + tail = IPC *file* format
    expect(bytes.subarray(0, 6).toString('latin1')).toBe('ARROW1');
    expect(bytes.subarray(bytes.length - 6).toString('latin1')).toBe('ARROW1');

    const table = tableFromIPC(bytes);
    expect(table.batches.length).toBe(1); // exactly one record batch
    expect(table.numRows).toBe(blob!.rows);
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      'ra_deg', 'dec_deg', 'pm_ra_masyr', 'pm_dec_masyr', 'g_mag', 'bp_rp', 'source_id',
    ]);
    expect(table.schema.fields.map((f) => String(f.type))).toEqual([
      'Float64', 'Float64', 'Float32', 'Float32', 'Float32', 'Float32', 'Uint64',
    ]);
    for (const f of table.schema.fields) {
      expect(f.nullable).toBe(false);
      expect(table.getChild(f.name)!.data[0].nullCount).toBe(0); // no validity buffers
    }
    // key-sorted custom metadata
    expect([...table.schema.metadata.keys()]).toEqual([
      'skycruncher.cell', 'skycruncher.epoch', 'skycruncher.format_version',
      'skycruncher.healpix_order', 'skycruncher.release', 'skycruncher.tier',
    ]);
    expect(table.schema.metadata.get('skycruncher.cell')).toBe('0');
    expect(table.schema.metadata.get('skycruncher.healpix_order')).toBe('5');
    expect(table.schema.metadata.get('skycruncher.tier')).toBe('t1');
    expect(table.schema.metadata.get('skycruncher.epoch')).toBe('J2016.0');
    expect(table.schema.metadata.get('skycruncher.release')).toBe('starplates-fixture');
  });

  it('rows are sorted g_mag asc with source_id tiebreak, and u64 survives round-trip', () => {
    for (const blob of stats.manifest.blobs) {
      const table = tableFromIPC(fs.readFileSync(path.join(stats.releaseDir, blob.path)));
      const g = table.getChild('g_mag')!;
      const sid = table.getChild('source_id')!;
      for (let i = 1; i < table.numRows; i++) {
        const gPrev = g.get(i - 1) as number;
        const gCur = g.get(i) as number;
        expect(gCur >= gPrev).toBe(true);
        if (gCur === gPrev) {
          expect((sid.get(i) as bigint) > (sid.get(i - 1) as bigint)).toBe(true);
        }
      }
      // mag stats in the manifest are the file's own f32 truth
      if (table.numRows > 0) {
        expect(Math.fround(blob.mag_min!)).toBe(g.get(0) as number);
        expect(Math.fround(blob.mag_max!)).toBe(g.get(table.numRows - 1) as number);
      }
    }
    // spot-check an exact row against the fixture CSV source line:
    // 2851858288640,45.132144414036745,0.1378535532444834,12.356248,...
    const cell0 = tableFromIPC(
      fs.readFileSync(path.join(stats.releaseDir, 't1/c5-00000.arrow')),
    );
    const sids = cell0.getChild('source_id')!;
    let found = -1;
    for (let i = 0; i < cell0.numRows; i++) if ((sids.get(i) as bigint) === 2851858288640n) found = i;
    expect(found).toBeGreaterThanOrEqual(0);
    expect(cell0.getChild('ra_deg')!.get(found)).toBe(45.132144414036745); // f64 exact
    expect(cell0.getChild('dec_deg')!.get(found)).toBe(0.1378535532444834);
    expect(cell0.getChild('g_mag')!.get(found)).toBe(Math.fround(12.356248));
    expect(cell0.getChild('bp_rp')!.get(found)).toBe(Math.fround(0.81036854));
  });

  it('T0 is exactly the bright (G<=9) prefix of the included T1 cells (spec §4)', () => {
    // ground truth straight from the fixture CSV
    const lines = fs.readFileSync(FIXTURE_CSV, 'utf8').trim().split('\n').slice(1);
    const expected = new Set<bigint>();
    for (const line of lines) {
      const p = line.split(',');
      if (p.length !== 7 || p.some((x) => x === '')) continue; // builder drops these
      const sid = BigInt(p[0]);
      if (cell5OfSourceId(sid) === 9738) continue; // excluded boundary cell
      if (Math.fround(Number(p[3])) <= 9) expected.add(sid);
    }
    const t0 = tableFromIPC(fs.readFileSync(path.join(stats.releaseDir, 't0/allsky.arrow')));
    expect(t0.numRows).toBe(expected.size);
    const sid = t0.getChild('source_id')!;
    const g = t0.getChild('g_mag')!;
    for (let i = 0; i < t0.numRows; i++) {
      expect(expected.has(sid.get(i) as bigint)).toBe(true);
      expect((g.get(i) as number) <= 9).toBe(true);
    }
    // t0 blob: no cell geometry, coverage = source coverage
    const t0Blob = stats.manifest.blobs.find((b) => b.tier === 't0')!;
    expect(t0Blob.healpix_order).toBeNull();
    expect(t0Blob.cell).toBeNull();
    expect(t0Blob.center_ra_deg).toBeNull();
    expect(t0Blob.coverage).toBe(stats.manifest.tiers.t1.coverage);
  });

  it('per-cell cone bounds contain every member star (manifest §2.3 geometry)', () => {
    const D2R = Math.PI / 180;
    for (const blob of stats.manifest.blobs) {
      if (blob.tier !== 't1') continue;
      const table = tableFromIPC(fs.readFileSync(path.join(stats.releaseDir, blob.path)));
      const ra = table.getChild('ra_deg')!;
      const dec = table.getChild('dec_deg')!;
      const cRa = blob.center_ra_deg! * D2R;
      const cDec = blob.center_dec_deg! * D2R;
      const cx = Math.cos(cDec) * Math.cos(cRa);
      const cy = Math.cos(cDec) * Math.sin(cRa);
      const cz = Math.sin(cDec);
      for (let i = 0; i < table.numRows; i++) {
        const r = (ra.get(i) as number) * D2R;
        const d = (dec.get(i) as number) * D2R;
        const dot = cx * Math.cos(d) * Math.cos(r) + cy * Math.cos(d) * Math.sin(r) + cz * Math.sin(d);
        const sep = Math.acos(Math.max(-1, Math.min(1, dot))) / D2R;
        expect(sep).toBeLessThanOrEqual(blob.radius_deg! + 1e-9);
      }
    }
  });

  it('default release id matches the spec naming', () => {
    expect(RELEASE_DEFAULT).toBe('starplates-2026.07-gdr3');
    expect(RELEASE_DEFAULT).toMatch(/^starplates-\d{4}\.\d{2}(\.\d+)?-[a-z0-9]+$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Column-name-driven ingest: the harvest layer pulls wide (download_gaia_chunked
// appends phot_bp_mean_mag, phot_rp_mean_mag, phot_bp_rp_excess_factor,
// phot_variable_flag, ruwe, parallax) but the plates stay lean — the builder
// locates its REQUIRED_COLUMNS by header name and must emit release bytes
// IDENTICAL to a legacy 7-column build of the same rows. The wide fixture is
// the narrow fixture with the 6 harvest columns appended (blank on every 5th
// data row to prove blank harvest-only values never drop a row).
// ─────────────────────────────────────────────────────────────────────────────
describe('wide harvest CSV ingest — column-name-driven (harvest wide, plates lean)', () => {
  const WIDE_FIXTURE_CSV = fileURLToPath(
    new URL('../../../tools/starplates/fixtures/mini_gaia_fixture_wide.csv', import.meta.url),
  );
  const opts = {
    release: 'starplates-fixture',
    knownDefect: 'fixture subset - not a full-sky extraction',
    quiet: true,
  };
  let dirs: string[] = [];
  let tmpCsvDir: string;
  let narrow: BuildStats;
  let wide: BuildStats;
  let reordered: BuildStats;

  // release bytes must be independent of the input CSV's shape, so the ONLY
  // permitted manifest difference is the source-lineage pair (extraction is
  // the input file's basename; extraction_sha256 its bytes)
  const scrubLineage = (m: Manifest): Manifest => ({
    ...m,
    source: { ...m.source, extraction: '(scrubbed)', extraction_sha256: '(scrubbed)' },
  });

  beforeAll(async () => {
    const mk = (tag: string) => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `starplates-wide-${tag}-`));
      dirs.push(d);
      return d;
    };
    tmpCsvDir = mk('csv');
    narrow = await buildRelease({ ...opts, csv: FIXTURE_CSV, outDir: mk('n') });
    wide = await buildRelease({ ...opts, csv: WIDE_FIXTURE_CSV, outDir: mk('w') });
    // column-order robustness: same wide rows with every column reversed
    const reorderedCsv = path.join(tmpCsvDir, 'reordered.csv');
    const wideLines = fs.readFileSync(WIDE_FIXTURE_CSV, 'utf8').split('\n');
    const nCols = wideLines[0].split(',').length;
    fs.writeFileSync(
      reorderedCsv,
      wideLines
        .map((line) => (line === '' ? line : line.split(',').slice().reverse().join(',')))
        .join('\n'),
    );
    expect(nCols).toBe(13);
    reordered = await buildRelease({ ...opts, csv: reorderedCsv, outDir: mk('r') });
  });

  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('exports the frozen legacy header and the required-column contract', () => {
    expect(REQUIRED_COLUMNS).toEqual(['source_id', 'ra', 'dec', 'phot_g_mean_mag', 'bp_rp', 'pmra', 'pmdec']);
    expect(CSV_HEADER).toBe('source_id,ra,dec,phot_g_mean_mag,bp_rp,pmra,pmdec');
  });

  it('ingest accounting is identical: blank harvest-only columns never drop a row', () => {
    expect(wide.rowsIngested).toBe(72);
    expect(wide.rowsIngested).toBe(narrow.rowsIngested);
    // missing_field still fires ONLY for a blank REQUIRED column (the fixture
    // row with blank bp_rp), never for blank harvest-only columns
    expect(wide.dropped).toEqual(narrow.dropped);
    expect(wide.dropped.missing_field).toBe(1);
    expect(wide.dropped.duplicate).toBe(1);
  });

  it('wide input builds a byte-identical release (only source lineage differs)', () => {
    expect(scrubLineage(wide.manifest)).toEqual(scrubLineage(narrow.manifest));
    // belt-and-braces on the actual bytes: every blob byte-identical on disk
    expect(wide.manifest.blobs.length).toBe(narrow.manifest.blobs.length);
    for (const blob of narrow.manifest.blobs) {
      const a = fs.readFileSync(path.join(narrow.releaseDir, blob.path));
      const b = fs.readFileSync(path.join(wide.releaseDir, blob.path));
      expect(a.equals(b)).toBe(true);
    }
    // lineage MUST differ — different input bytes, honestly recorded
    expect(wide.manifest.source.extraction).toBe('mini_gaia_fixture_wide.csv');
    expect(wide.manifest.source.extraction_sha256).not.toBe(narrow.manifest.source.extraction_sha256);
  });

  it('column order is irrelevant — fully reversed columns build the same bytes', () => {
    expect(scrubLineage(reordered.manifest)).toEqual(scrubLineage(narrow.manifest));
  });

  it('refuses a CSV whose header lacks a required column', async () => {
    const crippled = path.join(tmpCsvDir, 'missing_pmdec.csv');
    const lines = fs.readFileSync(FIXTURE_CSV, 'utf8').split('\n');
    fs.writeFileSync(
      crippled,
      lines
        .map((line) => (line === '' ? line : line.split(',').slice(0, 6).join(','))) // drop pmdec
        .join('\n'),
    );
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'starplates-wide-x-'));
    dirs.push(out);
    await expect(buildRelease({ ...opts, csv: crippled, outDir: out })).rejects.toThrow(
      /missing required column\(s\) \[pmdec\]/,
    );
  });
});
