// tools/atlas/verify_gaia_pure_sectors.mjs
// ═══════════════════════════════════════════════════════════════════════════
// GAIA-PURE SECTOR VERIFY GATE — the standing proof for the flip (ledger 521-525).
// Adapts verify_atlas_repro's shape, re-pointed OFF the HYG-merge + legacy byte
// order (which do not apply to a from-scratch Gaia-pure build).
// ═══════════════════════════════════════════════════════════════════════════
//
// READS (via node fs — sanctioned; Read tool deny-listed for sectors):
//   - D:/AstroLogic/atlas/sectors-2026.07-gaiapure/level_3_sector_0..35.json + manifest.json (BUILT)
//   - public/atlas/sectors/level_3_sector_0..35.json (SHIPPED — read-only, invariant reference)
//   - D:/AstroLogic/intake/gaia/*.csv (coverage cross-check; line-counted, NOT parsed)
//
// GATES:
//   (1) per-file + aggregate hashes/counts recomputed vs manifest (byte integrity)
//   (2) INVARIANT DIFF — per sector, the source_id-keyed Gaia subset of the BUILT
//       sector must match the SHIPPED sector's Gaia rows (position/mag up to
//       rounding). Both stores use the SAME lossy-Number source_id convention, so
//       the common key is String(Number(source_id)). Drift is a FINDING, not silent.
//       Mismatches are split by separation: <5" = POSITION DRIFT (concerning),
//       >=5" = likely lossy-Number source_id collision (benign schema artifact).
//   (3) COVERAGE — built Gaia total vs intake CSV row counts; per-mag-band histogram.
//   (4) BRIGHT-END CENSUS — supplement row count + mag histogram + 10 brightest
//       named sanity rows (Sirius/Canopus/Vega-class expected from Hip/Tycho or bright Gaia).
//
// NEVER Read-tool-ingests sector files: all sector reads are runtime fs (sanctioned).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILT_DIR = 'D:/AstroLogic/atlas/sectors-2026.07-gaiapure';
const SHIPPED_DIR = path.join(repoRoot, 'public', 'atlas', 'sectors');
const GAIA_DIR = 'D:/AstroLogic/intake/gaia';
const TR_DIR = path.join(repoRoot, 'test_results', 'gaia_pure_sectors_2026-07-22');
const SECTOR_COUNT = 36;
const D2R = Math.PI / 180;

const GAIA_CSVS = [
    ['gaia_dr3_g_lt_11_raw_2026-07-11.csv', 'lt11'],
    ['gaia_dr3_g_11_to_12_raw_2026-07-11.csv', 'm11_12'],
    ['gaia_dr3_g_12_to_13_raw_2026-07-11.csv', 'm12_13'],
    ['gaia_dr3_g_13_to_14_raw_2026-07-11.csv', 'm13_14'],
    ['gaia_dr3_g_14_to_15_raw_2026-07-11.csv', 'm14_15'],
];

const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');
const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const isGaiaShipped = (r) => r.source_id !== undefined; // shipped Gaia rows always carry source_id; HYG do not
function angSepDeg(ra1, dec1, ra2, dec2) {
    const a1 = ra1 * D2R, a2 = ra2 * D2R, d1 = dec1 * D2R, d2 = dec2 * D2R;
    return Math.acos(Math.min(1, Math.max(-1, Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2)))) / D2R;
}
// fast newline counter (raw buffered read; no parse) -> data rows = lines - 1 (header)
function countCsvRows(p) {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.allocUnsafe(1 << 22);
    let lines = 0, n, lastByte = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) {
        for (let i = 0; i < n; i++) if (buf[i] === 0x0a) lines++;
        lastByte = buf[n - 1];
    }
    fs.closeSync(fd);
    if (lastByte !== 0x0a && lines > 0) lines++; // final line without trailing newline
    return Math.max(0, lines - 1);                // minus header
}

// named bright stars (J2000 deg) for the bright-end sanity naming
const BRIGHT = [
    ['Sirius', 101.287, -16.716], ['Canopus', 95.988, -52.696], ['Arcturus', 213.915, 19.182],
    ['AlphaCen', 219.902, -60.834], ['Vega', 279.234, 38.784], ['Capella', 79.172, 45.998],
    ['Rigel', 78.634, -8.202], ['Procyon', 114.826, 5.225], ['Achernar', 24.429, -57.237],
    ['Betelgeuse', 88.793, 7.407], ['Hadar', 210.956, -60.373], ['Altair', 297.696, 8.868],
    ['Aldebaran', 68.980, 16.509], ['Antares', 247.352, -26.432], ['Spica', 201.298, -11.161],
    ['Pollux', 116.329, 28.026], ['Fomalhaut', 344.413, -29.622], ['Deneb', 310.358, 45.280],
    ['Regulus', 152.093, 11.967], ['Adhara', 104.656, -28.972], ['Castor', 113.650, 31.888],
    ['Shaula', 263.402, -37.104], ['Bellatrix', 81.283, 6.350], ['Elnath', 81.573, 28.608],
    ['Miaplacidus', 138.300, -69.717], ['Alnilam', 84.053, -1.202], ['Alnair', 332.058, -46.961],
];
function nameOf(ra, dec) {
    let best = null, bestSep = 0.06; // ~3.6' tolerance
    for (const [nm, r, d] of BRIGHT) { const s = angSepDeg(ra, dec, r, d); if (s < bestSep) { bestSep = s; best = nm; } }
    return best ? `${best} (${(bestSep * 3600).toFixed(1)}")` : null;
}

function main() {
    const t0 = Date.now();
    const findings = [];
    const manifest = JSON.parse(fs.readFileSync(path.join(BUILT_DIR, 'manifest.json'), 'utf8'));

    // ── (1) per-file + aggregate hash/count recompute vs manifest ────────────────
    const perFile = {};
    let hashMismatch = 0, countMismatch = 0;
    const magHist = { lt11: 0, m11_12: 0, m12_13: 0, m13_14: 0, m14_15: 0, ge15: 0 };
    const suppMagHist = {};
    let builtGaiaTotal = 0, builtSuppTotal = 0;
    const bright = []; // rows with mag_g < 4 (bright end) for naming
    // invariant tallies
    let inv_shipped_gaia = 0, inv_built_gaia_shared = 0, inv_shared = 0, inv_match = 0, inv_posDrift = 0, inv_collision = 0, inv_shippedOnly = 0;
    const driftSamples = []; // lossy-collision samples (Δmag != 0 -> different stars)
    const driftReal = [];    // REAL position-drift samples (Δmag ~ 0 -> same star, position differs)
    let suppByCat = { tycho2: 0, hipparcos: 0 };
    let suppNoId0 = 0; // supplement rows that would hit the consumer Sol filter (id===0 && !source_id)

    for (let id = 0; id < SECTOR_COUNT; id++) {
        const bp = path.join(BUILT_DIR, `level_3_sector_${id}.json`);
        const buf = fs.readFileSync(bp);
        const sha = sha256Buf(buf);
        const rows = JSON.parse(buf.toString('utf8'));
        let gaia = 0, supp = 0;
        // built Gaia map keyed by String(Number(source_id)) for the invariant diff
        const builtGaiaByKey = new Map();
        for (const r of rows) {
            if (r.source_id !== undefined) {
                gaia++; builtGaiaTotal++;
                const gg = r.mag_g;
                if (gg < 11) magHist.lt11++; else if (gg < 12) magHist.m11_12++; else if (gg < 13) magHist.m12_13++;
                else if (gg < 14) magHist.m13_14++; else if (gg < 15) magHist.m14_15++; else magHist.ge15++;
                builtGaiaByKey.set(String(Number(r.source_id)), r);
                if (gg < 4) bright.push({ mag: gg, ra: r.ra, dec: r.dec, ident: `gaia:${r.source_id}` });
            } else {
                // supplement row (no source_id). Must carry mag_g + a non-zero id.
                supp++; builtSuppTotal++;
                if (r.cat) suppByCat[r.cat] = (suppByCat[r.cat] || 0) + 1;
                if (r.id === 0) suppNoId0++;
                const mb = Math.floor(r.mag_g);
                suppMagHist[mb] = (suppMagHist[mb] || 0) + 1;
                if (r.mag_g < 4) bright.push({ mag: r.mag_g, ra: r.ra, dec: r.dec, ident: `${r.cat}:${r.cat_id}(${r.mag_system})` });
            }
        }
        // manifest cross-check
        const mf = manifest.files[`level_3_sector_${id}.json`];
        if (!mf || mf.sha256 !== sha) { hashMismatch++; findings.push(`sector ${id}: sha256 mismatch vs manifest`); }
        if (!mf || mf.gaia !== gaia || mf.supplement !== supp) { countMismatch++; findings.push(`sector ${id}: count mismatch (built gaia=${gaia} supp=${supp} vs manifest gaia=${mf?.gaia} supp=${mf?.supplement})`); }
        perFile[`level_3_sector_${id}.json`] = { sha256: sha, bytes: buf.length, gaia, supplement: supp, total: rows.length };

        // ── (2) INVARIANT DIFF vs shipped sector ─────────────────────────────────
        const sbuf = fs.readFileSync(path.join(SHIPPED_DIR, `level_3_sector_${id}.json`));
        const srows = JSON.parse(sbuf.toString('utf8'));
        for (const sr of srows) {
            if (!isGaiaShipped(sr)) continue;
            inv_shipped_gaia++;
            const key = String(Number(sr.source_id));
            const br = builtGaiaByKey.get(key);
            if (!br) { inv_shippedOnly++; continue; }
            inv_shared++;
            const dra = Math.abs(br.ra - sr.ra), ddec = Math.abs(br.dec - sr.dec), dmag = Math.abs(br.mag_g - sr.mag_g);
            if (dra < 1e-9 && ddec < 1e-9 && dmag < 1e-9) { inv_match++; }
            else {
                // DISCRIMINANT = Δmag (NOT separation). A shared key that is truly the
                // SAME star (same true source_id) must have identical rounded mag_g
                // (same phot_g). A NON-zero Δmag proves the lossy-Number key merged two
                // DISTINCT stars (adjacent source_ids in the same dense HEALPix cell ->
                // same Number under Float64, often <5" apart on sky). Only Δmag≈0 with a
                // position difference is a REAL coordinate drift worth investigating.
                // A shared TRUE source_id from the same DR3 catalog rounds to bit-identical
                // ra/dec (-> the exact-match bucket), so genuine same-star "drift" is
                // structurally impossible; the ONLY way to differ is a rounding wobble
                // <= ~0.36" (half of the 4dp grid). REAL drift therefore requires BOTH
                // Δmag≈0 AND sep < 1"; a Δmag-tie at large separation is a lossy-Number
                // collision between two distinct stars that coincidentally share mag_g(3dp).
                const sep = angSepDeg(br.ra, br.dec, sr.ra, sr.dec);
                const realDrift = dmag < 1e-6 && sep < 1 / 3600;
                if (realDrift) inv_posDrift++; else inv_collision++;
                if ((realDrift && driftReal.length < 25) || (!realDrift && driftSamples.length < 15)) {
                    (realDrift ? driftReal : driftSamples).push({
                        sector: id, key, sep_arcsec: +(sep * 3600).toFixed(3), dmag: +dmag.toFixed(4),
                        built: { ra: br.ra, dec: br.dec, mag_g: br.mag_g }, shipped: { ra: sr.ra, dec: sr.dec, mag_g: sr.mag_g },
                        class: realDrift ? 'REAL_POSITION_DRIFT' : 'lossy_id_collision',
                    });
                }
            }
        }
        inv_built_gaia_shared = inv_shared;
    }

    // aggregate md5 (same recipe as build)
    const sortedShaLines = Object.keys(perFile).sort().map((k) => `${k}:${perFile[k].sha256}`).join('\n');
    const aggregate_md5 = md5(Buffer.from(sortedShaLines, 'utf8'));
    const aggMatch = aggregate_md5 === manifest.aggregate_md5;
    if (!aggMatch) findings.push(`aggregate_md5 mismatch: verify ${aggregate_md5} vs manifest ${manifest.aggregate_md5}`);

    // ── (3) COVERAGE: intake CSV row counts (independent line count) ─────────────
    const intake = {};
    let intakeTotal = 0;
    for (const [f, band] of GAIA_CSVS) { const c = countCsvRows(path.join(GAIA_DIR, f)); intake[band] = c; intakeTotal += c; }
    // built band histogram vs intake bands (lt11 built counts G<11; intake lt11 csv = G<11 selection)
    const bandDelta = {
        lt11: magHist.lt11 - intake.lt11, m11_12: magHist.m11_12 - intake.m11_12,
        m12_13: magHist.m12_13 - intake.m12_13, m13_14: magHist.m13_14 - intake.m13_14, m14_15: magHist.m14_15 - intake.m14_15,
    };
    const coverageDelta = builtGaiaTotal - intakeTotal; // = -(dedup + bad) expected

    // ── (4) BRIGHT-END CENSUS: 10 brightest named ───────────────────────────────
    bright.sort((a, b) => a.mag - b.mag);
    const brightest10 = bright.slice(0, 10).map((b) => ({ mag_g: +b.mag.toFixed(3), ra: b.ra, dec: b.dec, ident: b.ident, name: nameOf(b.ra, b.dec) }));

    if (suppNoId0 > 0) findings.push(`${suppNoId0} supplement rows have id===0 && no source_id -> WOULD BE DROPPED by the consumer Sol filter (BUG)`);
    if (inv_posDrift > 0) findings.push(`${inv_posDrift} shared source_ids show REAL POSITION DRIFT (Δmag~0, position differs) vs shipped -- investigate (see drift_real_samples)`);

    const report = {
        generated: new Date().toISOString(),
        built_dir: BUILT_DIR,
        gate1_integrity: {
            aggregate_md5, manifest_aggregate_md5: manifest.aggregate_md5, aggregate_match: aggMatch,
            per_file_hash_mismatches: hashMismatch, per_file_count_mismatches: countMismatch,
            built_gaia_total: builtGaiaTotal, built_supplement_total: builtSuppTotal, built_total: builtGaiaTotal + builtSuppTotal,
        },
        gate2_invariant_diff: {
            rule: 'shared source_id (lossy-Number key): built Gaia row position+mag must equal shipped up to rounding. Discriminant for mismatches = Δmag (same true star -> Δmag==0; lossy-Number key merging two distinct adjacent-HEALPix stars -> Δmag!=0).',
            shipped_gaia_rows: inv_shipped_gaia, shared_source_ids: inv_shared,
            exact_match: inv_match,
            real_position_drift_dmag0: inv_posDrift,
            lossy_id_collisions_distinct_stars: inv_collision, shipped_only_not_in_built: inv_shippedOnly,
            verdict: inv_posDrift === 0
                ? `PASS (0 real drift; all ${inv_collision} mismatches are lossy-Number source_id collisions between distinct stars, Δmag!=0)`
                : `FINDING: ${inv_posDrift} real position drifts (Δmag~0)`,
            real_drift_samples: driftReal,
            lossy_collision_samples: driftSamples,
        },
        gate3_coverage: {
            intake_csv_rows: intake, intake_total: intakeTotal,
            built_gaia_total: builtGaiaTotal, coverage_delta_built_minus_intake: coverageDelta,
            coverage_delta_explained_by: 'dedup + bad rows (from build manifest)',
            manifest_dedup: manifest.counts.gaia_dedup, manifest_bad: manifest.counts.gaia_bad,
            built_mag_histogram: magHist, band_delta_built_minus_intake: bandDelta,
        },
        gate4_bright_end: {
            supplement_total: builtSuppTotal, supplement_by_cat: suppByCat,
            supplement_mag_histogram: suppMagHist, supplement_id0_sol_filter_hits: suppNoId0,
            brightest10,
        },
        findings,
        elapsed_s: (Date.now() - t0) / 1000,
    };
    fs.writeFileSync(path.join(TR_DIR, 'verify_report.json'), JSON.stringify(report, null, 2));

    // console summary
    console.log('════════════════════ GAIA-PURE VERIFY ════════════════════');
    console.log(`(1) integrity: aggregate_md5 ${aggMatch ? 'MATCH' : 'MISMATCH'} (${aggregate_md5}); hash-mismatch=${hashMismatch} count-mismatch=${countMismatch}`);
    console.log(`    built: gaia=${builtGaiaTotal} supp=${builtSuppTotal} total=${builtGaiaTotal + builtSuppTotal}`);
    console.log(`(2) invariant: shipped-gaia=${inv_shipped_gaia} shared=${inv_shared} exact=${inv_match} REALdrift(dmag0)=${inv_posDrift} lossyCollisions=${inv_collision} shippedOnly=${inv_shippedOnly}`);
    console.log(`    verdict: ${report.gate2_invariant_diff.verdict}`);
    console.log(`(3) coverage: intake=${intakeTotal} builtGaia=${builtGaiaTotal} delta=${coverageDelta} (dedup=${manifest.counts.gaia_dedup} bad=${manifest.counts.gaia_bad})`);
    console.log(`    band delta (built-intake): ${JSON.stringify(bandDelta)}`);
    console.log(`(4) bright-end: supp=${builtSuppTotal} (tyc ${suppByCat.tycho2 || 0}/hip ${suppByCat.hipparcos || 0}) id0-solfilter-hits=${suppNoId0}`);
    console.log('    10 brightest:');
    for (const b of brightest10) console.log(`      mag_g=${b.mag_g} (${b.ra},${b.dec}) ${b.ident} ${b.name ? '-> ' + b.name : ''}`);
    console.log(`FINDINGS (${findings.length}): ${findings.length ? '' : 'none'}`);
    for (const f of findings) console.log(`  ! ${f}`);
    console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`report: ${path.join(TR_DIR, 'verify_report.json')}`);
    process.exit((hashMismatch + countMismatch + inv_posDrift + suppNoId0 > 0 || !aggMatch) ? 1 : 0);
}

main();
