// ═══════════════════════════════════════════════════════════════════════════
// ATLAS LANE — catalog duplication census (MEASUREMENT ONLY, no solve)
// ═══════════════════════════════════════════════════════════════════════════
// Mirrors the LIVE adapter's load pattern (src/engine/pipeline/m6_plate_solve/
// star_catalog_adapter.ts) — L1+L2 ingested at init, L3 sectors on demand via
// ensureSectorLoaded — and its findStarsInField dec-band query, WHICH DOES NOT
// DEDUP. Counts the duplication baked into what the matcher actually receives:
//   (a) exact gaia_id repeats (L1/L2 stars re-ingested inside L3 sectors),
//   (b) cross-id position dupes <0.5" / <2" with |Δmag|<0.5 (Gaia-vs-HYG same
//       physical star under two ids),
//   (c) total rows returned vs unique physical stars — the inflation fraction.
//
// This is a MIRROR, not an instrumented live adapter (see caveats in the .md).
// It reproduces ingestStars() and findStarsInField() line-for-line, loading the
// value-equivalent .json sectors (the default binary path tries .arrow first;
// atlas_to_arrow.mjs verified 0 mismatches, so JSON is byte-value identical).
//
// Run:  node tools/atlas/count_catalog_dupes.mjs
// Writes: test_results/catalog_dupes_2026-07-10/DUPE_CENSUS.md (+ .json)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const ATLAS = path.join(ROOT, 'public', 'atlas');
const OUTDIR = path.join(ROOT, 'test_results', 'catalog_dupes_2026-07-10');
const D2R = Math.PI / 180;

// ── EXACT mirror of StarCatalogAdapter.ingestStars (:473-519) ────────────────
// Builds the same StandardStar rows AND the same 18-band dec index the live
// query reads. Every push is unconditional (no dedup) — that is the bug we
// are measuring.
function makeState() {
    return { stars: [], decBands: Array.from({ length: 18 }, () => []) };
}
function ingestStars(state, rawStars) {
    for (const s of rawStars) {
        if (s.id === 0 && s.source_id === undefined) continue; // Sol filter (HYG shape only)
        const isGaiaFormat = s.source_id !== undefined || s.mag_g !== undefined;
        const ra_hours = s.ra_deg !== undefined
            ? s.ra_deg / 15.0
            : (isGaiaFormat ? s.ra / 15.0 : s.ra);
        const dec_degrees = s.dec_deg !== undefined ? s.dec_deg : s.dec;
        const magnitude_V = s.mag_g !== undefined ? s.mag_g : s.mag;
        const band = isGaiaFormat ? 'GaiaG' : 'JohnsonV';
        const gaia_id = s.source_id ? `Gaia_${s.source_id}` : `HYG_${s.id}`;
        const star = { ra_hours, dec_degrees, magnitude_V, band, gaia_id };
        state.stars.push(star);
        const bandIdx = Math.floor((dec_degrees + 90) / 10);
        if (bandIdx >= 0 && bandIdx < 18) state.decBands[bandIdx].push(star);
    }
}

// ── EXACT mirror of getSectorId (:400-413) ───────────────────────────────────
function getSectorId(ra, dec) {
    const r = ((ra % 24) + 24) % 24;
    const d = Math.max(-90, Math.min(90, dec));
    const raIndex = Math.min(5, Math.floor(r / 4));
    const decIndex = Math.min(5, Math.floor((d + 90) / 30));
    return decIndex * 6 + raIndex;
}

// ── EXACT mirror of ensureSectorLoaded sector-SELECTION (:258-295) ───────────
// Returns the set of sector ids the adapter would attempt to load.
function sectorsForField(ra, dec, radiusDeg) {
    const decMin = Math.max(-90, dec - radiusDeg);
    const decMax = Math.min(90, dec + radiusDeg);
    let raWidthHours = (radiusDeg / 15) / Math.max(0.1, Math.cos(dec * D2R));
    if (Math.abs(dec) > 80) raWidthHours = 12;
    const raMin = (ra - raWidthHours + 24) % 24;
    const raMax = (ra + raWidthHours + 24) % 24;
    const raStep = 2, decStep = 15;
    const raPoints = [];
    if (raMin <= raMax) {
        for (let r = raMin; r <= raMax + 0.1; r += raStep) raPoints.push(r);
        raPoints.push(raMax);
    } else {
        for (let r = raMin; r < 24; r += raStep) raPoints.push(r);
        for (let r = 0; r <= raMax + 0.1; r += raStep) raPoints.push(r);
    }
    const sectors = new Set();
    for (let d = decMin; d <= decMax + 0.1; d += decStep) {
        for (const r of raPoints) sectors.add(getSectorId(r, d));
    }
    sectors.add(getSectorId(ra, dec));
    return sectors;
}

// ── EXACT mirror of findStarsInField dec-band query (:551-583) — NO DEDUP ────
function findStarsInField(state, raCenter, decCenter, radiusDegrees) {
    const minDec = decCenter - radiusDegrees;
    const maxDec = decCenter + radiusDegrees;
    const minBand = Math.max(0, Math.floor((minDec + 90) / 10));
    const maxBand = Math.min(17, Math.floor((maxDec + 90) / 10));
    const res = [];
    const radSq = radiusDegrees * radiusDegrees;
    const dDecMax = radiusDegrees;
    for (let b = minBand; b <= maxBand; b++) {
        const bandStars = state.decBands[b];
        for (let i = 0; i < bandStars.length; i++) {
            const s = bandStars[i];
            const dDec = s.dec_degrees - decCenter;
            if (Math.abs(dDec) > dDecMax) continue;
            let dRa = Math.abs(s.ra_hours - raCenter);
            if (dRa > 12) dRa = 24 - dRa;
            const raDistDeg = dRa * 15 * Math.cos(s.dec_degrees * D2R);
            if (Math.abs(raDistDeg) > radiusDegrees) continue;
            if (dDec * dDec + raDistDeg * raDistDeg <= radSq) res.push(s);
        }
    }
    return res.sort((a, b) => a.magnitude_V - b.magnitude_V);
}

// ── angular separation in arcsec (small-angle exact via haversine) ───────────
function angSepArcsec(ra1h, dec1, ra2h, dec2) {
    const a1 = ra1h * 15 * D2R, a2 = ra2h * 15 * D2R, d1 = dec1 * D2R, d2 = dec2 * D2R;
    const sd = Math.sin((d2 - d1) / 2), sr = Math.sin((a2 - a1) / 2);
    const h = sd * sd + Math.cos(d1) * Math.cos(d2) * sr * sr;
    return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / D2R * 3600;
}

// ── load L1+L2 once, build a shared init state ───────────────────────────────
function loadInit() {
    const state = makeState();
    const counts = {};
    for (const [key, f] of [['L1', 'level_1_anchors.json'], ['L2', 'level_2_pattern.json']]) {
        const p = path.join(ATLAS, f);
        const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
        const before = state.stars.length;
        ingestStars(state, rows);
        counts[key] = { file_rows: rows.length, ingested: state.stars.length - before };
    }
    return { state, counts };
}

function loadSectors(state, sectorIds) {
    const loaded = [], missing = [];
    for (const id of [...sectorIds].sort((a, b) => a - b)) {
        const p = path.join(ATLAS, 'sectors', `level_3_sector_${id}.json`);
        if (!fs.existsSync(p)) { missing.push(id); continue; }
        const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
        const before = state.stars.length;
        ingestStars(state, rows);
        loaded.push({ id, rows: rows.length, ingested: state.stars.length - before });
    }
    return { loaded, missing };
}

// ── DUPE CENSUS over a returned star list (mirrors what the matcher receives) ─
function censusOf(rows) {
    const n = rows.length;
    // (a) exact gaia_id repeats
    const byId = new Map();
    for (const s of rows) byId.set(s.gaia_id, (byId.get(s.gaia_id) || 0) + 1);
    const distinctIds = byId.size;
    const exactIdDupExtra = n - distinctIds;            // rows beyond one-per-id
    let idsWithDup = 0, maxMultiplicity = 0;
    for (const c of byId.values()) { if (c > 1) idsWithDup++; if (c > maxMultiplicity) maxMultiplicity = c; }

    // Collapse to one representative row per gaia_id for the cross-id search
    // (we want DIFFERENT-id physical dupes, not the exact repeats already counted).
    const repById = new Map();
    for (const s of rows) if (!repById.has(s.gaia_id)) repById.set(s.gaia_id, s);
    const reps = [...repById.values()];

    // (b) cross-id position dupes with |Δmag|<0.5 at <0.5" and <2".
    // Bucket on a coarse grid (~0.01° cells) so this stays O(n·k) not O(n²).
    const CELL = 0.02; // deg, comfortably larger than 2" (0.00056°)
    const grid = new Map();
    const cellKey = (raDeg, dec) => `${Math.round(raDeg / CELL)}_${Math.round(dec / CELL)}`;
    for (let i = 0; i < reps.length; i++) {
        const s = reps[i];
        const raDeg = s.ra_hours * 15;
        const k = cellKey(raDeg, s.dec_degrees);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
    }
    const seenPair = new Set();
    // magHalf/magTwo apply the |Δmag|<0.5 same-star heuristic; posHalf/posTwo
    // are position-only (upper bracket — a real Gaia-G vs HYG-V pair for the
    // same star can exceed |Δmag|=0.5 because G and Johnson V differ by colour).
    let magHalf = 0, magTwo = 0, posHalf = 0, posTwo = 0;
    // composition of the cross-id <2" pairs: how many mix a Gaia row with a HYG row
    let crossGaiaHyg = 0;
    const crossPairsSample = [];
    for (let i = 0; i < reps.length; i++) {
        const s = reps[i];
        const raDeg = s.ra_hours * 15;
        const ci = Math.round(raDeg / CELL), cj = Math.round(s.dec_degrees / CELL);
        for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
                const bucket = grid.get(`${ci + di}_${cj + dj}`);
                if (!bucket) continue;
                for (const j of bucket) {
                    if (j <= i) continue;
                    const t = reps[j];
                    if (t.gaia_id === s.gaia_id) continue;         // different id required
                    const sep = angSepArcsec(s.ra_hours, s.dec_degrees, t.ra_hours, t.dec_degrees);
                    if (sep >= 2.0) continue;
                    const pk = i < j ? `${i}_${j}` : `${j}_${i}`;
                    if (seenPair.has(pk)) continue;
                    seenPair.add(pk);
                    posTwo++;
                    if (sep < 0.5) posHalf++;
                    const magOk = Math.abs((s.magnitude_V ?? 99) - (t.magnitude_V ?? 99)) < 0.5;
                    if (magOk) { magTwo++; if (sep < 0.5) magHalf++; }
                    if (s.band !== t.band) crossGaiaHyg++;
                    if (crossPairsSample.length < 10) crossPairsSample.push({
                        sep_arcsec: +sep.toFixed(3), id_a: s.gaia_id, id_b: t.gaia_id,
                        mag_a: s.magnitude_V, mag_b: t.magnitude_V, band_a: s.band, band_b: t.band, magOk,
                    });
                }
            }
        }
    }
    const crossTwo = magTwo, crossHalf = magHalf; // headline uses the same-star heuristic

    // (c) deduped physical count = distinct ids minus cross-id merges (2" tier).
    // Each cross-id pair collapses two ids to one physical star (upper-bound
    // merge; chained triples over-merge marginally — flagged INFERRED).
    const dedupedCount = distinctIds - crossTwo;
    // composition of the returned set (hybrid-atlas discriminant)
    let nGaia = 0, nHyg = 0;
    for (const s of rows) { if (s.band === 'GaiaG') nGaia++; else nHyg++; }
    return {
        rows_returned: n,
        composition: { GaiaG: nGaia, JohnsonV_HYG: nHyg },
        distinct_gaia_ids: distinctIds,
        exact_id_dup_extra_rows: exactIdDupExtra,
        exact_id_dup_fraction: n ? +(exactIdDupExtra / n).toFixed(4) : 0,
        gaia_ids_with_repeat: idsWithDup,
        max_multiplicity: maxMultiplicity,
        // headline (b): different-id positional dupes with |Δmag|<0.5 same-star heuristic
        cross_id_pos_dupes_lt2arcsec: crossTwo,
        cross_id_pos_dupes_lt0p5arcsec: crossHalf,
        // bracket: position-only (no mag gate) — upper bound on Gaia-vs-HYG same-star pairs
        pos_only_dupes_lt2arcsec: posTwo,
        pos_only_dupes_lt0p5arcsec: posHalf,
        cross_pairs_mixing_gaia_and_hyg_lt2arcsec: crossGaiaHyg,
        deduped_physical_count: dedupedCount,
        total_inflation_extra_rows: n - dedupedCount,
        total_inflation_fraction: n ? +((n - dedupedCount) / n).toFixed(4) : 0,
        cross_pair_sample: crossPairsSample,
    };
}

// ── field runner ─────────────────────────────────────────────────────────────
function runField({ label, ra, dec, ingestRadiusDeg, queryRadiusDeg, loadL3 }) {
    const { state, counts: initCounts } = loadInit();
    let sectorInfo = { loaded: [], missing: [], sectorIds: [] };
    if (loadL3) {
        const sectorIds = sectorsForField(ra, dec, ingestRadiusDeg);
        const { loaded, missing } = loadSectors(state, sectorIds);
        sectorInfo = { sectorIds: [...sectorIds].sort((a, b) => a - b), loaded, missing };
    }
    const superset = state.stars.length;
    // exact-id duplication over the ENTIRE ingested superset (not just the query
    // radius) — the definitive "do L1/L2 stars repeat in the sectors" check.
    const supMap = new Map();
    for (const s of state.stars) supMap.set(s.gaia_id, (supMap.get(s.gaia_id) || 0) + 1);
    let supExtra = 0, supDupIds = 0;
    for (const v of supMap.values()) if (v > 1) { supDupIds++; supExtra += v - 1; }
    const queried = findStarsInField(state, ra, dec, queryRadiusDeg);
    return {
        label, ra_hours: ra, dec_degrees: dec, ingestRadiusDeg, queryRadiusDeg, loadL3,
        init: initCounts,
        superset_ingested_total: superset,
        superset_distinct_ids: supMap.size,
        superset_exact_id_dup_ids: supDupIds,
        superset_exact_id_dup_extra_rows: supExtra,
        sectors: sectorInfo,
        census: censusOf(queried),
    };
}

// ── the two pinned fields ────────────────────────────────────────────────────
// SeeStar M66 (narrow, HINTED): patchActive=false ⇒ fetchRadiusDeg = searchRadius
//   = max(fovW,fovH)*1.5 = 3.922789*1.5 = 5.8842°. ensureSectorLoaded uses the
//   same radius (regionRadius = hint.radius_deg ?? searchRadius; ≤ cap 16°).
//   Center = solution (11.341253h,+13.048°) — proxy for the FITS hint center
//   (Δ < 0.1°, far under the 4h×30° sector grid and the 5.88° query radius).
// CR2 (ultra-wide, BLIND): the UW anchored sweep+verify match ONLY mag<6 (L1);
//   per solver_entry.ts:597-613 the per-center L3 paging is DELIBERATELY SKIPPED
//   for ultra-wide. So the operative matcher catalog = L1+L2 (loadL3:false).
//   Query radius: patchActive ⇒ fetchRadiusDeg = min(searchRadius=137°,
//   SOLVER_WIDE_PATCH_RADIUS_DEG*1.5 + patchOffsetDeg) ≈ 9° + (unmeasured
//   patchOffset). Reported at 9° (nominal) with a sensitivity sweep.
const SEE = { ra: 11.341253475172621, dec: 13.048392248246461, fovW: 2.2065688395011493, fovH: 3.922789048002043 };
const CR2 = { ra: 17.585759708175544, dec: -33.82946264471481, fovW: 91.3406097233005, fovH: 60.823504821513446 };
const seeSearchRadius = Math.max(SEE.fovW, SEE.fovH) * 1.5;

const results = [];
// SeeStar — operative (what produced matched=272)
results.push(runField({
    label: 'SeeStar_M66_narrow_matcher', ra: SEE.ra, dec: SEE.dec,
    ingestRadiusDeg: seeSearchRadius, queryRadiusDeg: seeSearchRadius, loadL3: true,
}));
// CR2 — operative UW sweep (what produced matched=55): L1+L2 only, nominal 9°
results.push(runField({
    label: 'CR2_UW_sweep_matcher_L1L2_9deg', ra: CR2.ra, dec: CR2.dec,
    ingestRadiusDeg: 0, queryRadiusDeg: 9, loadL3: false,
}));
// CR2 sensitivity: same L1+L2 catalog at other plausible fetch radii
for (const rq of [6, 15, 30]) {
    results.push(runField({
        label: `CR2_UW_sweep_matcher_L1L2_${rq}deg`, ra: CR2.ra, dec: CR2.dec,
        ingestRadiusDeg: 0, queryRadiusDeg: rq, loadL3: false,
    }));
}
// CR2 hypothetical: IF the escalation 6° L3 load fired around the solved center
// (feeds forced-photometry probes, NOT the matched=55 set — completeness only)
results.push(runField({
    label: 'CR2_escalation_6deg_L3_hypothetical', ra: CR2.ra, dec: CR2.dec,
    ingestRadiusDeg: 6, queryRadiusDeg: 6, loadL3: true,
}));

fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(path.join(OUTDIR, 'dupe_census.json'), JSON.stringify({
    generated: new Date().toISOString(),
    see_search_radius_deg: seeSearchRadius,
    results,
}, null, 2));

// concise console summary
for (const r of results) {
    const c = r.census;
    console.log(`\n=== ${r.label} (RA ${r.ra_hours.toFixed(4)}h Dec ${r.dec_degrees.toFixed(3)}° q=${r.queryRadiusDeg}° L3=${r.loadL3}) ===`);
    console.log(`  superset ingested: ${r.superset_ingested_total} (distinct ids ${r.superset_distinct_ids}, exact-id dup extra rows ${r.superset_exact_id_dup_extra_rows}) | sectors loaded: [${r.sectors.loaded.map(s => s.id).join(',')}] missing:[${r.sectors.missing.join(',')}]`);
    console.log(`  rows returned to matcher: ${c.rows_returned} (Gaia ${c.composition.GaiaG} / HYG ${c.composition.JohnsonV_HYG}) | distinct ids: ${c.distinct_gaia_ids}`);
    console.log(`  (a) exact gaia_id dup extra rows: ${c.exact_id_dup_extra_rows} (${(c.exact_id_dup_fraction * 100).toFixed(2)}%) | ids w/repeat: ${c.gaia_ids_with_repeat} | max mult: ${c.max_multiplicity}`);
    console.log(`  (b) same-star |Δmag|<0.5 pos dupes <2": ${c.cross_id_pos_dupes_lt2arcsec} | <0.5": ${c.cross_id_pos_dupes_lt0p5arcsec}  [pos-only bracket <2": ${c.pos_only_dupes_lt2arcsec} | Gaia-HYG mix: ${c.cross_pairs_mixing_gaia_and_hyg_lt2arcsec}]`);
    console.log(`  (c) deduped physical: ${c.deduped_physical_count} | inflation: ${c.total_inflation_extra_rows} rows (${(c.total_inflation_fraction * 100).toFixed(2)}%)`);
}
console.log(`\nWrote ${path.join(OUTDIR, 'dupe_census.json')}`);
