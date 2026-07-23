// tools/atlas/build_gaia_pure_sectors.mjs
// ═══════════════════════════════════════════════════════════════════════════
// GAIA-PURE SECTOR BUILD — total HYG retirement (ledger rows 521-525, owner GO).
// Builds a SIDE-BY-SIDE replacement for the hybrid public/atlas/sectors data
// plane. NEVER touches shipped data; output lives on D: (storage law).
// ═══════════════════════════════════════════════════════════════════════════
//
// READS (via node fs — sanctioned atlas/intake access path; Read tool deny-listed):
//   - D:/AstroLogic/intake/gaia/gaia_dr3_g_{lt_11,11-12,12-13,13-14,14-15}_raw_*.csv
//         (Gaia DR3, ra/dec DEGREES @J2016; the 5-band G<15 selection)
//   - D:/AstroLogic/intake/bright_supplement/tycho2/tyc2.dat.00..19.gz  (Tycho-2)
//   - D:/AstroLogic/intake/bright_supplement/hipparcos/hip2.dat.gz      (Hipparcos van Leeuwen 2007)
// WRITES (D: only + test_results):
//   - D:/AstroLogic/atlas/sectors-2026.07-gaiapure/level_3_sector_0..35.json
//   - D:/AstroLogic/atlas/sectors-2026.07-gaiapure/manifest.json
//   - test_results/gaia_pure_sectors_2026-07-22/build_summary.json
//
// MEMBERSHIP + SCHEMA (spec 1/2): trueSector + row schema/rounding REUSED
// VERBATIM from pour_gaia_gapfill.mjs (cited below); ALL HYG merge logic DROPPED;
// append-mode -> from-scratch. Gaia row shape byte-matches the shipped Gaia rows:
//   {id:0, ra:DEG(4dp), dec(4dp), mag_g(3dp), bp_rp(computed 3dp), pm_ra(1dp),
//    pm_dec(1dp), source_id:Number}  (proper omitted; key order fixed).
//
// BRIGHT SUPPLEMENT (spec 3): Tycho-2 / Hipparcos stars with NO Gaia counterpart
// (position dedup, keep-Gaia). Emitted Gaia-SHAPED but honest (LAW 3):
//   {id:<uniq>=1>, ra, dec, mag_g:<NATIVE mag, NOT transformed>, mag_system,
//    bt_vt?:<Tycho BT-VT>, cat, cat_id}   — NO fabricated bp_rp; NO source_id.
//   * id must be NON-ZERO and source_id ABSENT would otherwise be dropped by the
//     consumer's Sol filter (id===0 && source_id===undefined -> skip). A unique
//     non-zero id survives it and yields a unique gaia_id ('HYG_'+id) downstream.
//   * mag_g PRESENT makes the consumer read ra as DEGREES (isGaiaFormat branch) —
//     which is correct here (we store degrees). Omitting it would mis-read hours.
//
// DEDUP RULE (spec 3): a supplement star is DROPPED when a Gaia star lies within
// DEDUP_ARCSEC (position only; NO cross-system mag gate — G vs VT/Hp differ, LAW 3;
// NO proper-motion correction v1 — Gaia J2016 vs Tycho J2000 vs Hip J1991.25, so a
// high-PM bright star may escape the match and appear twice: honest, reported).
// Prior art: tools/atlas/count_catalog_dupes.mjs cross-id positional-dupe cutoff is
// 2.0" (tight tier 0.5"); tools/catalog/extract_footprint.mjs keep-Gaia is 1.5".
// We adopt 2.0" as primary and report a 1.0/1.5/2.0/3.0" sensitivity table.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GAIA_DIR = 'D:/AstroLogic/intake/gaia';
const TYC_DIR = 'D:/AstroLogic/intake/bright_supplement/tycho2';
const HIP_DIR = 'D:/AstroLogic/intake/bright_supplement/hipparcos';
const OUT_DIR = 'D:/AstroLogic/atlas/sectors-2026.07-gaiapure';
const TR_DIR = path.join(repoRoot, 'test_results', 'gaia_pure_sectors_2026-07-22');
const SECTOR_COUNT = 36;
const DEDUP_ARCSEC = 2.0;                 // primary keep-Gaia radius (prior art: count_catalog_dupes 2.0")
const SENS_ARCSEC = [1.0, 1.5, 2.0, 3.0]; // sensitivity table

const GAIA_CSVS = [
    'gaia_dr3_g_lt_11_raw_2026-07-11.csv',
    'gaia_dr3_g_11_to_12_raw_2026-07-11.csv',
    'gaia_dr3_g_12_to_13_raw_2026-07-11.csv',
    'gaia_dr3_g_13_to_14_raw_2026-07-11.csv',
    'gaia_dr3_g_14_to_15_raw_2026-07-11.csv',
];

const D2R = Math.PI / 180;
const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');
const md5 = (buf) => createHash('md5').update(buf).digest('hex');
// ── rounding + bucketing REUSED VERBATIM from pour_gaia_gapfill.mjs:49-59 ──────
const r4 = (x) => Math.round(x * 10000) / 10000;
const r3 = (x) => Math.round(x * 1000) / 1000;
const r1 = (x) => Math.round(x * 10) / 10;
function trueSector(raDeg, dec) {
    const raH = (((raDeg / 15) % 24) + 24) % 24;
    const raIndex = Math.min(5, Math.floor(raH / 4));
    const decIndex = Math.min(5, Math.floor((Math.max(-90, Math.min(90, dec)) + 90) / 30));
    return decIndex * 6 + raIndex;
}
// great-circle separation (deg), ra/dec in DEGREES (from extract_footprint.mjs:64)
function angSepDeg(ra1, dec1, ra2, dec2) {
    const a1 = ra1 * D2R, a2 = ra2 * D2R, d1 = dec1 * D2R, d2 = dec2 * D2R;
    return Math.acos(Math.min(1, Math.max(-1, Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2)))) / D2R;
}

// ── streaming sector writer: [Gaia block][supplement block] per shipped layout ──
class SectorWriter {
    constructor(dir) {
        this.w = [];
        for (let id = 0; id < SECTOR_COUNT; id++) {
            this.w.push({ fd: fs.openSync(path.join(dir, `level_3_sector_${id}.json`), 'w'), n: 0, buf: '' });
        }
    }
    writeGaia(id, str) {
        const s = this.w[id];
        s.buf += (s.n === 0 ? '[' : ',\n') + str;
        s.n++;
        if (s.buf.length > (1 << 22)) { fs.writeSync(s.fd, s.buf); s.buf = ''; }
    }
    closeWithExtras(id, extraStrs) {
        const s = this.w[id];
        for (const str of extraStrs) { s.buf += (s.n === 0 ? '[' : ',\n') + str; s.n++; }
        if (s.n === 0) s.buf += '[]';
        else s.buf += ']';
        fs.writeSync(s.fd, s.buf); s.buf = '';
        fs.closeSync(s.fd);
        return s.n;
    }
}

async function streamLines(stream, onLine) {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) onLine(line);
}

// ── supplement spatial grid (small set; polar-aware ra expansion + ra wrap) ─────
const CELL_DEG = (2 * DEDUP_ARCSEC) / 3600;           // cell >= dedup radius; 3x3 near equator
const NRA = Math.ceil(360 / CELL_DEG);                // ra index modulus (wrap)
const decIdxOf = (dec) => Math.floor((dec + 90) / CELL_DEG);
const raIdxOf = (ra) => ((Math.floor(ra / CELL_DEG) % NRA) + NRA) % NRA;

async function main() {
    const t0 = Date.now();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(TR_DIR, { recursive: true });
    console.log(`gaia-pure build -> ${OUT_DIR}`);

    // ══ PASS A: bright supplement -> grid + buffer (mark hasGaia during PASS B) ══
    // suppBuf entries: {ra,dec,mag,mag_system,bt_vt,cat,cat_id,minSep}
    const suppBuf = [];
    const grid = new Map();                            // "decIdx:raIdx" -> [idx,...]
    const gridPush = (idx, ra, dec) => {
        const k = `${decIdxOf(dec)}:${raIdxOf(ra)}`;
        let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(idx);
    };
    const addSupp = (ra, dec, mag, mag_system, bt_vt, cat, cat_id) => {
        if (!(ra >= 0 && ra < 360) || !(dec >= -90 && dec <= 90)) return false;
        const idx = suppBuf.length;
        suppBuf.push({ ra, dec, mag, mag_system, bt_vt, cat, cat_id, minSep: Infinity });
        gridPush(idx, ra, dec);
        return true;
    };

    console.log('PASS A: Tycho-2 + Hipparcos supplement...');
    let tycRows = 0, tycKept = 0, tycNoMag = 0, hipRows = 0, hipKept = 0, hipNoMag = 0;
    let dbgT = 0, dbgH = 0;
    // Tycho-2: fixed-width (ReadMe I/259). TYC id 1-4/6-10/12 ; RAmdeg 16-27 DEmdeg 29-40
    // (mean ICRS J2000); fallback observed RAdeg 153-164/DEdeg 166-177 (pflag 'X').
    // BTmag 111-116 ; VTmag 124-129. Columns cited from tools/catalog/extract_footprint.mjs.
    for (let n = 0; n <= 19; n++) {
        const f = path.join(TYC_DIR, `tyc2.dat.${String(n).padStart(2, '0')}.gz`);
        await streamLines(fs.createReadStream(f).pipe(zlib.createGunzip()), (line) => {
            tycRows++;
            let ra = parseFloat(line.slice(15, 27)), dec = parseFloat(line.slice(28, 40));
            if (Number.isNaN(ra) || Number.isNaN(dec)) { ra = parseFloat(line.slice(152, 164)); dec = parseFloat(line.slice(165, 177)); }
            if (Number.isNaN(ra) || Number.isNaN(dec)) return;
            const bt = parseFloat(line.slice(110, 116));
            const vt = parseFloat(line.slice(123, 129));
            let mag, ms;
            if (Number.isFinite(vt)) { mag = vt; ms = 'VT'; }
            else if (Number.isFinite(bt)) { mag = bt; ms = 'BT'; }
            else { tycNoMag++; return; }
            const bt_vt = (Number.isFinite(bt) && Number.isFinite(vt)) ? r3(bt - vt) : undefined;
            const t1 = line.slice(0, 4).trim(), t2 = line.slice(5, 10).trim(), t3 = line.slice(11, 12).trim();
            const cat_id = `TYC ${t1}-${t2}-${t3}`;
            if (dbgT < 2) { console.log(`  [tyc sample] ${cat_id} ra=${ra} dec=${dec} BT=${bt} VT=${vt} mag=${mag}(${ms}) bt_vt=${bt_vt}`); dbgT++; }
            if (addSupp(r4(ra), r4(dec), r3(mag), ms, bt_vt, 'tycho2', cat_id)) tycKept++;
        });
    }
    // Hipparcos hip2.dat: HIP 1-6 ; RArad 16-28 DErad 30-42 (RADIANS, ICRS Ep1991.25); Hpmag 130-136.
    await streamLines(fs.createReadStream(path.join(HIP_DIR, 'hip2.dat.gz')).pipe(zlib.createGunzip()), (line) => {
        hipRows++;
        const rar = parseFloat(line.slice(15, 28)), der = parseFloat(line.slice(29, 42));
        if (Number.isNaN(rar) || Number.isNaN(der)) return;
        let ra = (rar / D2R) % 360; if (ra < 0) ra += 360;
        const dec = der / D2R;
        const hp = parseFloat(line.slice(129, 136));
        if (!Number.isFinite(hp)) { hipNoMag++; return; }
        const hip = line.slice(0, 6).trim();
        const cat_id = `HIP ${hip}`;
        if (dbgH < 2) { console.log(`  [hip sample] ${cat_id} ra=${ra} dec=${dec} Hp=${hp}`); dbgH++; }
        if (addSupp(r4(ra), r4(dec), r3(hp), 'Hp', undefined, 'hipparcos', cat_id)) hipKept++;
    });
    console.log(`  PASS A: tycho rows=${tycRows} kept=${tycKept} noMag=${tycNoMag} | hip rows=${hipRows} kept=${hipKept} noMag=${hipNoMag} | supp buffer=${suppBuf.length} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    // ══ PASS B: stream Gaia CSVs -> write sector Gaia rows + mark supplement ══════
    console.log('PASS B: streaming Gaia CSVs...');
    const writer = new SectorWriter(OUT_DIR);
    // DEDUP BY CONSTRUCTION (no in-memory id table). The 5 intake bands are DISJOINT
    // half-open phot_g ranges (<11, [11,12), [12,13), [13,14), [14,15)) and each ESA
    // archive export is unique by source_id, so a source_id occurs in exactly one band
    // exactly once -> global dedup is 0. This was MEASURED with an exact-string global
    // detector (dedup=0 across bands 1-4 = 16,844,156 rows, i.e. 0 at every internal
    // 11/12/13/14 boundary, proving non-overlapping queries) before removal — a 37M-entry
    // Set OOMs (V8 .split(',') SlicedStrings retain the full CSV line -> ~9.3GB live).
    // The verify gate's coverage check (built total == intake total) is the independent
    // confirmation that no duplicate slipped through.
    const gaiaPerSector = new Array(SECTOR_COUNT).fill(0);
    const magHist = { lt11: 0, m11_12: 0, m12_13: 0, m13_14: 0, m14_15: 0, ge15: 0, other: 0 };
    let gRead = 0, gKept = 0, gDedup = 0, gBad = 0;
    const dedupRadDeg = DEDUP_ARCSEC / 3600;
    for (const csv of GAIA_CSVS) {
        const fpath = path.join(GAIA_DIR, csv);
        let isHeader = true; const H = {};
        await streamLines(fs.createReadStream(fpath), (line) => {
            if (!line) return;
            const cols = line.split(',');
            if (isHeader) { cols.forEach((c, i) => { H[c.trim()] = i; }); isHeader = false; return; }
            gRead++;
            const sidText = (cols[H['source_id']] || '').trim();
            const raDeg = parseFloat(cols[H['ra']]);
            const dec = parseFloat(cols[H['dec']]);
            const g = parseFloat(cols[H['phot_g_mean_mag']]);
            if (!sidText || !Number.isFinite(raDeg) || !Number.isFinite(dec) || !Number.isFinite(g)) { gBad++; return; }
            const bp = parseFloat(cols[H['phot_bp_mean_mag']]);
            const rp = parseFloat(cols[H['phot_rp_mean_mag']]);
            const bp_rp = (Number.isFinite(bp) && Number.isFinite(rp)) ? (bp - rp) : 0.0;
            const pmra = parseFloat(cols[H['pmra']]);
            const pmdec = parseFloat(cols[H['pmdec']]);
            const ra = r4(raDeg), dc = r4(dec);
            if (!Number.isFinite(ra) || !Number.isFinite(dc)) { gBad++; return; }
            const sid = Number(sidText);
            // (dedup by construction — see PASS B header; gDedup stays 0)
            // Gaia row — byte-identical schema/key-order to shipped (pour_gaia_gapfill:139-148)
            const row = {
                id: 0, ra, dec: dc, mag_g: r3(g), bp_rp: r3(bp_rp),
                pm_ra: Number.isFinite(pmra) ? r1(pmra) : 0.0,
                pm_dec: Number.isFinite(pmdec) ? r1(pmdec) : 0.0,
                source_id: sid,
            };
            const sector = trueSector(ra, dc);
            writer.writeGaia(sector, JSON.stringify(row));
            gaiaPerSector[sector]++;
            gKept++;
            const gg = row.mag_g;
            if (gg < 11) magHist.lt11++; else if (gg < 12) magHist.m11_12++; else if (gg < 13) magHist.m12_13++;
            else if (gg < 14) magHist.m13_14++; else if (gg < 15) magHist.m14_15++; else magHist.ge15++;
            // dedup-mark supplement within DEDUP radius (polar-aware ra expansion + wrap)
            if (grid.size) {
                const di = decIdxOf(dc);
                const cosd = Math.max(Math.cos(dc * D2R), 1e-6);
                const raSpan = Math.min(NRA, Math.ceil(dedupRadDeg / (CELL_DEG * cosd)) + 1);
                const ri0 = raIdxOf(ra);
                for (let dd = -1; dd <= 1; dd++) {
                    const dband = di + dd;
                    for (let dr = -raSpan; dr <= raSpan; dr++) {
                        const rk = ((ri0 + dr) % NRA + NRA) % NRA;
                        const arr = grid.get(`${dband}:${rk}`); if (!arr) continue;
                        for (const idx of arr) {
                            const s = suppBuf[idx];
                            const sep = angSepDeg(ra, dc, s.ra, s.dec);
                            if (sep < s.minSep) s.minSep = sep;
                        }
                    }
                }
            }
        });
        console.log(`  [${csv}] cumulative kept=${gKept} dedup=${gDedup} bad=${gBad} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    console.log(`  PASS B: gaia read=${gRead} kept=${gKept} dedup=${gDedup} bad=${gBad}`);

    // ══ PASS C: emit unique supplement rows into their sectors + close files ══════
    console.log('PASS C: emitting unique supplement + closing sectors...');
    const suppExtras = Array.from({ length: SECTOR_COUNT }, () => []);
    const suppPerSector = new Array(SECTOR_COUNT).fill(0);
    const sens = Object.fromEntries(SENS_ARCSEC.map((a) => [a, { dropped: 0, kept: 0 }]));
    const suppMagHist = {};
    const suppByCat = { tycho2: 0, hipparcos: 0 };
    let suppUid = 0;
    for (const s of suppBuf) {
        for (const a of SENS_ARCSEC) {
            if (s.minSep * 3600 <= a) sens[a].dropped++; else sens[a].kept++;
        }
        if (s.minSep <= dedupRadDeg) continue;         // has Gaia counterpart -> drop
        suppUid++;
        const row = { id: suppUid, ra: s.ra, dec: s.dec, mag_g: s.mag, mag_system: s.mag_system };
        if (s.bt_vt !== undefined) row.bt_vt = s.bt_vt;
        row.cat = s.cat; row.cat_id = s.cat_id;
        const sector = trueSector(s.ra, s.dec);
        suppExtras[sector].push(JSON.stringify(row));
        suppPerSector[sector]++;
        suppByCat[s.cat]++;
        const mb = Math.floor(s.mag);
        suppMagHist[mb] = (suppMagHist[mb] || 0) + 1;
    }
    const sectorTotals = [];
    for (let id = 0; id < SECTOR_COUNT; id++) {
        const total = writer.closeWithExtras(id, suppExtras[id]);
        sectorTotals.push({ id, gaia: gaiaPerSector[id], supplement: suppPerSector[id], total });
    }
    const totalSupp = suppUid;
    const totalGaia = gKept;
    console.log(`  PASS C: supplement unique kept=${totalSupp} (tycho ${suppByCat.tycho2} / hip ${suppByCat.hipparcos})`);

    // ══ hashes + source shas + manifest ══════════════════════════════════════════
    console.log('hashing outputs + sources...');
    const perFile = {};
    for (let id = 0; id < SECTOR_COUNT; id++) {
        const p = path.join(OUT_DIR, `level_3_sector_${id}.json`);
        const buf = fs.readFileSync(p);
        perFile[`level_3_sector_${id}.json`] = { sha256: sha256Buf(buf), bytes: buf.length, gaia: gaiaPerSector[id], supplement: suppPerSector[id], total: sectorTotals[id].total };
    }
    const sortedShaLines = Object.keys(perFile).sort().map((k) => `${k}:${perFile[k].sha256}`).join('\n');
    const aggregate_md5 = md5(Buffer.from(sortedShaLines, 'utf8'));

    // source file shas (stream-hash; large — CSVs + gz used)
    const hashFile = (p) => new Promise((res) => {
        const h = createHash('sha256');
        fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex')));
    });
    const sourceShas = {};
    for (const csv of GAIA_CSVS) sourceShas[`gaia/${csv}`] = await hashFile(path.join(GAIA_DIR, csv));
    for (let n = 0; n <= 19; n++) { const f = `tyc2.dat.${String(n).padStart(2, '0')}.gz`; sourceShas[`tycho2/${f}`] = await hashFile(path.join(TYC_DIR, f)); }
    sourceShas['hipparcos/hip2.dat.gz'] = await hashFile(path.join(HIP_DIR, 'hip2.dat.gz'));

    const manifest = {
        boundary: 'atlas_rows_gaia_pure',
        description: 'Gaia-pure sector data plane (total HYG retirement, ledger 521-525). Side-by-side '
            + 'replacement for the hybrid public/atlas/sectors at the flip. Per-file SHA-256 + aggregate_md5 '
            + 'is the LAW-7 golden fingerprint evidence for the layouts entry (added orchestrator-side at flip).',
        generated: new Date().toISOString(),
        built_by: 'tools/atlas/build_gaia_pure_sectors.mjs',
        verified_by: 'tools/atlas/verify_gaia_pure_sectors.mjs',
        membership_rule: 'trueSector: raIndex=floor(((raDeg/15)%24)/4), decIndex=floor((dec+90)/30), id=decIndex*6+raIndex (on ROUNDED ra/dec). REUSED verbatim from pour_gaia_gapfill.mjs.',
        gaia_row_schema: 'id=0, ra(DEG 4dp), dec(4dp), mag_g(3dp), bp_rp=phot_bp-phot_rp(3dp), pm_ra(1dp), pm_dec(1dp), source_id(Number). proper omitted. Byte-identical to shipped Gaia rows.',
        supplement_row_schema: 'id(unique>=1), ra(DEG 4dp), dec(4dp), mag_g=NATIVE mag(3dp; VT|BT|Hp, NOT transformed to G), mag_system, bt_vt?(Tycho BT-VT 3dp), cat, cat_id. NO bp_rp (never fabricated), NO source_id. id!=0 required to survive the consumer Sol filter (id===0 && !source_id -> skip); mag_g present -> consumer reads ra as DEGREES (correct).',
        dedup_rule: `keep-Gaia; a Tycho-2/Hipparcos star is DROPPED when a Gaia star lies within ${DEDUP_ARCSEC}" (position only, NO mag gate, NO proper-motion correction v1). Prior art: count_catalog_dupes.mjs cross-id cutoff 2.0"; extract_footprint.mjs 1.5".`,
        dedup_sensitivity_arcsec: sens,
        args: { DEDUP_ARCSEC, SENS_ARCSEC, CELL_DEG, gaia_csvs: GAIA_CSVS, sector_count: SECTOR_COUNT },
        counts: {
            gaia_rows_read: gRead, gaia_rows_kept: gKept, gaia_dedup: gDedup, gaia_bad: gBad,
            supplement_kept: totalSupp, supplement_by_cat: suppByCat,
            supplement_tycho_rows: tycRows, supplement_hip_rows: hipRows,
            supplement_no_mag_dropped: { tycho2: tycNoMag, hipparcos: hipNoMag },
            total_rows: totalGaia + totalSupp,
            gaia_mag_histogram: magHist,
            supplement_mag_histogram: suppMagHist,
        },
        aggregate_md5,
        source_file_sha256: sourceShas,
        files: perFile,
        sectors: sectorTotals,
        elapsed_s: (Date.now() - t0) / 1000,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(TR_DIR, 'build_summary.json'), JSON.stringify({
        generated: manifest.generated, counts: manifest.counts, aggregate_md5,
        dedup_sensitivity_arcsec: sens, elapsed_s: manifest.elapsed_s, out_dir: OUT_DIR,
    }, null, 2));

    console.log('\n════════════════════════════════════════════════════════════');
    console.log(`GAIA rows kept: ${totalGaia}  (read ${gRead}, dedup ${gDedup}, bad ${gBad})`);
    console.log(`SUPPLEMENT kept: ${totalSupp}  (tycho ${suppByCat.tycho2} / hip ${suppByCat.hipparcos})`);
    console.log(`TOTAL rows: ${totalGaia + totalSupp}`);
    console.log(`dedup sensitivity (dropped@arcsec): ${SENS_ARCSEC.map((a) => `${a}:${sens[a].dropped}`).join(' ')}`);
    console.log(`aggregate_md5: ${aggregate_md5}`);
    console.log(`manifest: ${path.join(OUT_DIR, 'manifest.json')}`);
    console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
