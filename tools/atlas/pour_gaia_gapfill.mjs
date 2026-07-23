// tools/atlas/pour_gaia_gapfill.mjs
// ═══════════════════════════════════════════════════════════════════════════
// GAIA G<11 GAP-FILL POUR — build a STAGED atlas (append-after-existing) and
// prove non-destructiveness + measure depth. Step 2 of the depth program.
// ═══════════════════════════════════════════════════════════════════════════
//
// READS (via node fs — the sanctioned atlas-access path; Read tool is deny-listed):
//   - public/atlas/sectors/level_3_sector_0..35.json  (SHIPPED, IRREPLACEABLE — read-only)
//   - D:/AstroLogic/intake/gaia/gaia_dr3_g_lt_11_raw_2026-07-11.csv (gap-fill extract)
// WRITES (D: only, per storage law):
//   - D:/AstroLogic/atlas_staged_gaia_2026-07-11/sectors/level_3_sector_N.json
//   - <staged>/staged_manifest.json  (sha256 + counts per sector)
//   - <staged>/pour_measurements.json (deltas + depth cones)
//
// APPEND RULE (see RESULTS): new Gaia rows are placed at the VERY END of each
// sector (after the existing [Gaia][HYG] blocks) by RAW-TEXT SPLICE, so the
// shipped bytes (minus the closing ']') are a LITERAL byte PREFIX of the staged
// file. This is the least-invasive documented choice: append-INTO the Gaia block
// is impossible without shifting the trailing HYG bytes (breaks the prefix). The
// consumer discriminates per-row (isGaia = source_id||mag_g), NOT by block, so
// trailing Gaia rows are still classified correctly (star_catalog_adapter:485).
//
// ROW FORMAT (must match shipped Gaia row EXACTLY — LAYOUT_TRANSCRIPTION 1b):
//   key order id,ra,dec,mag_g,bp_rp,pm_ra,pm_dec,source_id ; id=0 (no id col);
//   proper omitted; rounding ra/dec 4dp, mag_g/bp_rp 3dp, pm 1dp; source_id=Number
//   (lossy Float64, matching the shipped convention). bp_rp = phot_bp - phot_rp
//   COMPUTED (not a column). ra stored DEG @J2016 as-is (NO epoch propagation).
//   Bucketing = trueSector (ra_deg/15 -> hours), on the ROUNDED ra/dec.
//
// DEDUP: per-sector, by source_id equality vs existing Gaia rows. Both sides are
//   rendered through String(Number(id)) — the ONLY common basis, because the
//   shipped ids are already 2^53-lossy (exact-19-digit text can't match a rounded
//   stored id). No fancy dedup (owner-parked).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECTORS_DIR = path.join(repoRoot, 'public', 'atlas', 'sectors');
const CSV = 'D:/AstroLogic/intake/gaia/gaia_dr3_g_lt_11_raw_2026-07-11.csv';
const STAGED_ROOT = 'D:/AstroLogic/atlas_staged_gaia_2026-07-11';
const STAGED_SECTORS = path.join(STAGED_ROOT, 'sectors');
const SECTOR_COUNT = 36;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const r4 = (x) => Math.round(x * 10000) / 10000;
const r3 = (x) => Math.round(x * 1000) / 1000;
const r1 = (x) => Math.round(x * 10) / 10;

// TRUE bucketing (rebucket_sectors.mjs:24 / getSectorId): ra DEG -> hours /15.
function trueSector(raDeg, dec) {
    const raH = (((raDeg / 15) % 24) + 24) % 24;
    const raIndex = Math.min(5, Math.floor(raH / 4));
    const decIndex = Math.min(5, Math.floor((Math.max(-90, Math.min(90, dec)) + 90) / 30));
    return decIndex * 6 + raIndex;
}
// isGaia discriminator (adapter:485): source_id defined OR mag_g defined.
const isGaiaRow = (r) => r.source_id !== undefined || r.mag_g !== undefined;

// Great-circle angular separation (deg). ra/dec in DEGREES.
function angSepDeg(ra1, dec1, ra2, dec2) {
    const d2r = Math.PI / 180;
    const s = Math.sin(dec1 * d2r) * Math.sin(dec2 * d2r) +
        Math.cos(dec1 * d2r) * Math.cos(dec2 * d2r) * Math.cos((ra1 - ra2) * d2r);
    return Math.acos(Math.max(-1, Math.min(1, s))) / d2r;
}
// A stored row's RA in DEGREES (Gaia already deg; HYG hours -> *15).
const rowRaDeg = (r) => (isGaiaRow(r) ? r.ra : r.ra * 15);

// Depth cones (NASA fields; centers from test_results/nasa_1to1_2026-07-11/measurements.json).
const CONES = {
    tess: { ra: 89.71413044855439, dec: -75.39564230824688, radiusDeg: 6.0, note: '12 deg FFI, half-width 6 deg' },
    ztf: { ra: 255.5769095237, dec: 12.28378507882, radiusDeg: 0.43, note: '0.86 deg field, half-width 0.43 deg' },
};

async function main() {
    const t0 = Date.now();
    fs.mkdirSync(STAGED_SECTORS, { recursive: true });

    // ── PASS 1: read shipped sectors -> sha256/bytes/lastByte, Gaia id sets, cones.
    console.log('PASS 1: reading 36 shipped sectors...');
    const shipped = []; // per sector: {sha256, bytes, gaiaCount, hygCount, total}
    const gaiaIdSets = Array.from({ length: SECTOR_COUNT }, () => new Set());
    const coneShipped = { tess: 0, ztf: 0 };
    for (let id = 0; id < SECTOR_COUNT; id++) {
        const buf = fs.readFileSync(path.join(SECTORS_DIR, `level_3_sector_${id}.json`));
        const lastByte = buf[buf.length - 1];
        if (lastByte !== 0x5d) throw new Error(`sector ${id} does not end in ']' (0x${lastByte.toString(16)})`);
        const rows = JSON.parse(buf.toString('utf8'));
        let g = 0, h = 0;
        for (const r of rows) {
            if (isGaiaRow(r)) { g++; if (r.source_id !== undefined) gaiaIdSets[id].add(String(r.source_id)); }
            else h++;
            const raDeg = rowRaDeg(r), dec = r.dec;
            for (const k of ['tess', 'ztf']) {
                const c = CONES[k];
                if (angSepDeg(raDeg, dec, c.ra, c.dec) <= c.radiusDeg) coneShipped[k]++;
            }
        }
        shipped.push({ sha256: sha256(buf), bytes: buf.length, gaiaCount: g, hygCount: h, total: rows.length });
    }
    console.log(`  shipped totals: ${shipped.reduce((a, s) => a + s.total, 0)} rows; cone TESS=${coneShipped.tess} ZTF=${coneShipped.ztf}`);

    // ── PASS 2: stream gap-fill CSV -> bucket, dedup, collect new rows per sector.
    console.log('PASS 2: streaming gap-fill CSV...');
    const newRows = Array.from({ length: SECTOR_COUNT }, () => []); // arrays of JSON strings
    const coneNew = { tess: 0, ztf: 0 };
    let read = 0, kept = 0, deduped = 0, badRow = 0;
    let dupSourceFlag = 0, ruweHi = 0; // quality-flag telemetry (NOT filtered)
    const rl = readline.createInterface({ input: fs.createReadStream(CSV), crlfDelay: Infinity });
    let isHeader = true; const H = {};
    for await (const line of rl) {
        if (!line) continue;
        const cols = line.split(',');
        if (isHeader) { cols.forEach((c, i) => { H[c.trim()] = i; }); isHeader = false; continue; }
        read++;
        const sidText = (cols[H['source_id']] || '').trim();
        const raDeg = parseFloat(cols[H['ra']]);
        const dec = parseFloat(cols[H['dec']]);
        const g = parseFloat(cols[H['phot_g_mean_mag']]);
        if (!sidText || !Number.isFinite(raDeg) || !Number.isFinite(dec) || !Number.isFinite(g)) { badRow++; continue; }
        const bp = parseFloat(cols[H['phot_bp_mean_mag']]);
        const rp = parseFloat(cols[H['phot_rp_mean_mag']]);
        const bp_rp = (Number.isFinite(bp) && Number.isFinite(rp)) ? (bp - rp) : 0.0;
        const pmra = parseFloat(cols[H['pmra']]);
        const pmdec = parseFloat(cols[H['pmdec']]);
        const ruwe = parseFloat(cols[H['ruwe']]);
        const dupFlag = (cols[H['duplicated_source']] || '').trim().toLowerCase() === 'true';
        if (dupFlag) dupSourceFlag++;
        if (Number.isFinite(ruwe) && ruwe > 1.4) ruweHi++;

        // minifiedStar (rounded) — must byte-match the shipped Gaia row schema.
        const ra = r4(raDeg), dc = r4(dec);
        if (!Number.isFinite(ra) || !Number.isFinite(dc)) { badRow++; continue; }
        const sid = Number(sidText); // lossy Float64, matches shipped convention
        const row = {
            id: 0,
            ra,
            dec: dc,
            mag_g: r3(g),
            bp_rp: r3(bp_rp),
            pm_ra: Number.isFinite(pmra) ? r1(pmra) : 0.0,
            pm_dec: Number.isFinite(pmdec) ? r1(pmdec) : 0.0,
            source_id: sid,
        };
        const sector = trueSector(ra, dc);
        const key = String(sid);
        if (gaiaIdSets[sector].has(key)) { deduped++; continue; }
        gaiaIdSets[sector].add(key); // guard against intra-CSV dupes too
        newRows[sector].push(JSON.stringify(row));
        kept++;
        // depth cone (use rounded stored coords, DEG)
        for (const k of ['tess', 'ztf']) {
            const c = CONES[k];
            if (angSepDeg(ra, dc, c.ra, c.dec) <= c.radiusDeg) coneNew[k]++;
        }
    }
    console.log(`  CSV read=${read} kept=${kept} deduped=${deduped} bad=${badRow}; coneNew TESS=${coneNew.tess} ZTF=${coneNew.ztf}`);

    // ── PASS 3: build staged sectors (raw splice) + non-destructiveness proof.
    console.log('PASS 3: writing staged sectors + verifying non-destructiveness...');
    const staged = []; let allNonDestructive = true, grandNew = 0;
    for (let id = 0; id < SECTOR_COUNT; id++) {
        const buf = fs.readFileSync(path.join(SECTORS_DIR, `level_3_sector_${id}.json`));
        const shipText = buf.toString('utf8');
        const nrs = newRows[id];
        grandNew += nrs.length;
        let stagedText;
        if (nrs.length === 0) {
            stagedText = shipText; // byte-identical (no new rows in this sector)
        } else if (shipText === '[]') {
            stagedText = '[' + nrs.join(',\n') + ']';
        } else {
            // shipText = '[' + rows.join(',\n') + ']'. Replace trailing ']' with
            // ',\n' + newBlock + ']'. Shipped bytes minus ']' are a literal prefix.
            stagedText = shipText.slice(0, shipText.length - 1) + ',\n' + nrs.join(',\n') + ']';
        }
        const stagedBuf = Buffer.from(stagedText, 'utf8');
        fs.writeFileSync(path.join(STAGED_SECTORS, `level_3_sector_${id}.json`), stagedBuf);

        // Non-destructiveness proof: strip the appended block -> must byte-equal shipped.
        let strippedText;
        if (nrs.length === 0) strippedText = stagedText;
        else if (shipText === '[]') strippedText = '[]';
        else {
            const appended = ',\n' + nrs.join(',\n');
            strippedText = stagedText.slice(0, stagedText.length - 1 - appended.length) + ']';
        }
        const stripSha = sha256(Buffer.from(strippedText, 'utf8'));
        const nonDestructive = stripSha === shipped[id].sha256;
        // Also a raw-prefix check (strongest form).
        const rawPrefixOk = nrs.length === 0 ? stagedBuf.equals(buf)
            : stagedBuf.subarray(0, buf.length - 1).equals(buf.subarray(0, buf.length - 1));
        if (!nonDestructive || !rawPrefixOk) allNonDestructive = false;
        staged.push({
            id,
            shipped_sha256: shipped[id].sha256, shipped_bytes: shipped[id].bytes,
            staged_sha256: sha256(stagedBuf), staged_bytes: stagedBuf.length,
            existing_total: shipped[id].total, existing_gaia: shipped[id].gaiaCount, existing_hyg: shipped[id].hygCount,
            new_gaia: nrs.length, staged_total: shipped[id].total + nrs.length,
            non_destructive: nonDestructive, raw_prefix_ok: rawPrefixOk,
        });
    }

    // ── manifests
    const stagedManifest = {
        boundary: 'atlas_rows_staged_gapfill',
        generated: '2026-07-11',
        source_shipped: 'public/atlas/sectors/level_3_sector_0..35.json',
        gapfill_csv: CSV,
        append_rule: 'new Gaia rows appended at END of each sector (after [Gaia][HYG]); shipped bytes = literal prefix (raw splice).',
        row_format: 'id=0,ra(deg 4dp),dec(4dp),mag_g(3dp),bp_rp(computed 3dp),pm_ra(1dp),pm_dec(1dp),source_id(Number). proper omitted.',
        dedup: 'per-sector, String(Number(source_id)) equality vs existing Gaia rows (2^53-lossy common basis).',
        totals: {
            shipped_rows: shipped.reduce((a, s) => a + s.total, 0),
            new_gaia_rows: grandNew,
            staged_rows: shipped.reduce((a, s) => a + s.total, 0) + grandNew,
        },
        non_destructive_all: allNonDestructive,
        sectors: staged,
    };
    fs.writeFileSync(path.join(STAGED_ROOT, 'staged_manifest.json'), JSON.stringify(stagedManifest, null, 2));

    const pourMeasurements = {
        generated: '2026-07-11',
        csv_rows_read: read, kept, deduped, bad_rows: badRow,
        quality_flags_not_filtered: { duplicated_source_true: dupSourceFlag, ruwe_gt_1p4: ruweHi },
        depth_cones: {
            tess: { center: [CONES.tess.ra, CONES.tess.dec], radius_deg: CONES.tess.radiusDeg,
                shipped: coneShipped.tess, added: coneNew.tess, staged: coneShipped.tess + coneNew.tess },
            ztf: { center: [CONES.ztf.ra, CONES.ztf.dec], radius_deg: CONES.ztf.radiusDeg,
                shipped: coneShipped.ztf, added: coneNew.ztf, staged: coneShipped.ztf + coneNew.ztf },
        },
        non_destructive_all: allNonDestructive,
        staged_path: STAGED_SECTORS,
        elapsed_s: (Date.now() - t0) / 1000,
    };
    fs.writeFileSync(path.join(STAGED_ROOT, 'pour_measurements.json'), JSON.stringify(pourMeasurements, null, 2));

    console.log('\n════════════════════════════════════════════════════════════');
    console.log(`NON-DESTRUCTIVE (all 36 strip->shipped byte-equal): ${allNonDestructive ? 'YES' : 'NO'}`);
    console.log(`rows: shipped=${pourMeasurements.csv_rows_read} read | kept=${kept} deduped=${deduped} bad=${badRow}`);
    console.log(`new Gaia rows poured: ${grandNew}`);
    console.log(`DEPTH TESS r6deg: ${coneShipped.tess} -> ${coneShipped.tess + coneNew.tess} (+${coneNew.tess})`);
    console.log(`DEPTH ZTF  r0.43deg: ${coneShipped.ztf} -> ${coneShipped.ztf + coneNew.ztf} (+${coneNew.ztf})`);
    console.log(`quality flags (NOT filtered): dup_source=${dupSourceFlag} ruwe>1.4=${ruweHi}`);
    console.log(`staged: ${STAGED_SECTORS}`);
    console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
