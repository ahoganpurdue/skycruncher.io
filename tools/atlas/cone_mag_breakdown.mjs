// tools/atlas/cone_mag_breakdown.mjs
// Magnitude-resolved depth of the two NASA cones: shipped vs added-gap-fill.
// The solver forms quads from BRIGHT stars, so bright-bin gains predict a lock
// far better than the raw cone total (ZTF solver reported 1-3 usable vs 32 geo).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECTORS_DIR = path.join(repoRoot, 'public', 'atlas', 'sectors');
const CSV = 'D:/AstroLogic/intake/gaia/gaia_dr3_g_lt_11_raw_2026-07-11.csv';
const SECTOR_COUNT = 36;
const r4 = (x) => Math.round(x * 10000) / 10000;

const isGaiaRow = (r) => r.source_id !== undefined || r.mag_g !== undefined;
const rowRaDeg = (r) => (isGaiaRow(r) ? r.ra : r.ra * 15);
function angSepDeg(ra1, dec1, ra2, dec2) {
    const d = Math.PI / 180;
    const s = Math.sin(dec1 * d) * Math.sin(dec2 * d) + Math.cos(dec1 * d) * Math.cos(dec2 * d) * Math.cos((ra1 - ra2) * d);
    return Math.acos(Math.max(-1, Math.min(1, s))) / d;
}
function trueSector(raDeg, dec) {
    const raH = (((raDeg / 15) % 24) + 24) % 24;
    return Math.min(5, Math.floor((Math.max(-90, Math.min(90, dec)) + 90) / 30)) * 6 + Math.min(5, Math.floor(raH / 4));
}
const CONES = {
    tess: { ra: 89.71413044855439, dec: -75.39564230824688, radiusDeg: 6.0 },
    ztf: { ra: 255.5769095237, dec: 12.28378507882, radiusDeg: 0.43 },
};
// bins on effective magnitude (Gaia mag_g, or HYG mag). label -> [lo,hi)
const BINS = [['<6', -99, 6], ['6-8', 6, 8], ['8-10', 8, 10], ['10-11', 10, 11], ['>=11', 11, 99]];
function binOf(mag) { for (const [l, lo, hi] of BINS) if (mag >= lo && mag < hi) return l; return '?'; }
const emptyBins = () => Object.fromEntries(BINS.map(([l]) => [l, 0]));

// existing gaia id sets for dedup parity with the pour
const gaiaIdSets = Array.from({ length: SECTOR_COUNT }, () => new Set());
const shippedBins = { tess: emptyBins(), ztf: emptyBins() };
const addedBins = { tess: emptyBins(), ztf: emptyBins() };

for (let id = 0; id < SECTOR_COUNT; id++) {
    const rows = JSON.parse(fs.readFileSync(path.join(SECTORS_DIR, `level_3_sector_${id}.json`), 'utf8'));
    for (const r of rows) {
        if (isGaiaRow(r) && r.source_id !== undefined) gaiaIdSets[id].add(String(r.source_id));
        const mag = isGaiaRow(r) ? r.mag_g : r.mag;
        const raDeg = rowRaDeg(r);
        for (const k of ['tess', 'ztf']) {
            const c = CONES[k];
            if (angSepDeg(raDeg, r.dec, c.ra, c.dec) <= c.radiusDeg) shippedBins[k][binOf(mag)]++;
        }
    }
}

const rl = readline.createInterface({ input: fs.createReadStream(CSV), crlfDelay: Infinity });
let isHeader = true; const H = {};
for await (const line of rl) {
    if (!line) continue;
    const cols = line.split(',');
    if (isHeader) { cols.forEach((c, i) => { H[c.trim()] = i; }); isHeader = false; continue; }
    const sidText = (cols[H['source_id']] || '').trim();
    const raDeg = parseFloat(cols[H['ra']]); const dec = parseFloat(cols[H['dec']]); const g = parseFloat(cols[H['phot_g_mean_mag']]);
    if (!sidText || !Number.isFinite(raDeg) || !Number.isFinite(dec) || !Number.isFinite(g)) continue;
    const ra = r4(raDeg), dc = r4(dec); const sid = Number(sidText); const key = String(sid);
    const sector = trueSector(ra, dc);
    if (gaiaIdSets[sector].has(key)) continue; gaiaIdSets[sector].add(key);
    for (const k of ['tess', 'ztf']) {
        const c = CONES[k];
        if (angSepDeg(ra, dc, c.ra, c.dec) <= c.radiusDeg) addedBins[k][binOf(Math.round(g * 1000) / 1000)]++;
    }
}

const out = { generated: '2026-07-11', bins: BINS.map((b) => b[0]), cones: {} };
for (const k of ['tess', 'ztf']) {
    const staged = emptyBins(); for (const [l] of BINS) staged[l] = shippedBins[k][l] + addedBins[k][l];
    out.cones[k] = { shipped: shippedBins[k], added: addedBins[k], staged };
    const brightShip = shippedBins[k]['<6'] + shippedBins[k]['6-8'] + shippedBins[k]['8-10'];
    const brightAdd = addedBins[k]['<6'] + addedBins[k]['6-8'] + addedBins[k]['8-10'];
    out.cones[k].bright_lt10 = { shipped: brightShip, added: brightAdd, staged: brightShip + brightAdd };
    console.log(`\n${k.toUpperCase()} cone (r=${CONES[k].radiusDeg}deg):`);
    for (const [l] of BINS) console.log(`  mag ${l.padEnd(6)}: shipped=${shippedBins[k][l]}  +${addedBins[k][l]}  = ${staged[l]}`);
    console.log(`  BRIGHT (<10): shipped=${brightShip} +${brightAdd} = ${brightShip + brightAdd}`);
}
fs.writeFileSync('D:/AstroLogic/atlas_staged_gaia_2026-07-11/cone_mag_breakdown.json', JSON.stringify(out, null, 2));
console.log('\nwrote D:/AstroLogic/atlas_staged_gaia_2026-07-11/cone_mag_breakdown.json');
