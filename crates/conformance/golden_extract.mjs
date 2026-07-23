#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// M2 GOLDEN EXTRACTION — stratified stored-quad vectors from the g15u release
// ═══════════════════════════════════════════════════════════════════════════
// Selects ~112 STORED quads (~7-8 per band × 15 bands) from
//   D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u/
// prioritizing coder edge cases, and dumps full-precision inputs + the STORED
// bytes as expectations to
//   crates/solver-core/tests/fixtures/quads_golden_g15u.json
// The EXPECTED values are the STORED release bytes — never recomputed here.
//
// Categories (stratification, in priority order per band):
//   fold    |cx+dx-1| < 1e-3         (fold-boundary; canonical has cx+dx <= 1)
//   cdtie   |dx-cx|   < 1e-4         (C/D near-tie)
//   binedge any comp within 1e-5 of a k/128*2-0.5 bin edge
//   highdec any member |dec| > 85°
//   rawrap  member max(ra)-min(ra) > 180°  (RA wrap through 0/360)
//   random  seeded-random remainder
//
// --recompute : additionally re-derive every selected quad IN JS via the
//   source-of-truth modules (band_hash.mjs meanRaDec/gnomonic + coder.mjs
//   buildQuadCodes with {sepMin:0,sepMax:Infinity,capInterior:2}, i.e. the
//   codeQuad4 recipe) from stars.arrow f64 rows in STORED star0..3 order, and
//   compare against the stored f32 bits + code_key. This validates the recipe
//   itself before any Rust runs, and prints full f64 intermediates for any
//   divergent case (the M2 escalation contract).
// --case <band>:<row> : print full intermediates for one stored quad.
//
// cwd-independent by design (absolute paths + import.meta.url).
// ═══════════════════════════════════════════════════════════════════════════
import { createRequire } from 'module';
import { pathToFileURL, fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

// FIXTURE TRANSPORT RULE (measured 2026-07-20): serde_json's DEFAULT float
// parse is fast-path, not guaranteed correctly rounded (the `float_roundtrip`
// feature exists for a reason) — a shortest-repr decimal that Node round-trips
// exactly came back 1 ulp off in Rust (-0.22107142773826638 → …ba201 vs
// …ba200). Every load-bearing float therefore travels as an IEEE BIT PATTERN
// (u64/u32 hex string); decimals are kept alongside for human eyes only.
const DEPLOY_PKG = 'K:/Coding Projects/Newtonian Color Engine/ASTROLOGIC_DEPLOY/package.json';
const REST = 'K:/Coding Projects/Newtonian Color Engine/rest-integration';
const RELEASE_DIR = 'D:/AstroLogic/test_artifacts/mag15_build_2026-07-19/starplates-2026.07-quadidx-g15u';
const OUT_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../solver-core/tests/fixtures/quads_golden_g15u.json');
const SCENES_OUT_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../solver-core/tests/fixtures/coder_golden_scenes.json');

const require2 = createRequire(DEPLOY_PKG);
const arrow = require2('apache-arrow');
const { gnomonic, meanRaDec, unitVec, dotDeg } = await import(pathToFileURL(path.join(REST, 'tools/solverkit/band_hash.mjs')).href);
const { buildQuadCodes, CODE_LO, CODE_HI } = await import(pathToFileURL(path.join(REST, 'tools/quadindex/coder.mjs')).href);

// ── deterministic PRNG (mulberry32 — the repo's standard scene seed) ─────────
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── bit-pattern helpers ──────────────────────────────────────────────────────
const _f32 = new Float32Array(1); const _u32 = new Uint32Array(_f32.buffer);
const f32bits = (x) => { _f32[0] = x; return _u32[0]; };
const _f64 = new Float64Array(1); const _b64 = new BigUint64Array(_f64.buffer);
const f64hex = (x) => { _f64[0] = x; return '0x' + _b64[0].toString(16).padStart(16, '0'); };
const f64bitsHex = f64hex; // parser-proof f64 transport (see header rule)

// codeBin/codeKey — verbatim from build_quad_index.mjs (:339-346), nbins=128.
const NBINS = 128;
function codeBin(v) {
    const b = Math.floor(((v - CODE_LO) / (CODE_HI - CODE_LO)) * NBINS);
    return b < 0 ? 0 : b >= NBINS ? NBINS - 1 : b;
}
const codeKeyF64 = (c) => ((codeBin(c[0]) * NBINS + codeBin(c[1])) * NBINS + codeBin(c[2])) * NBINS + codeBin(c[3]);

// ── load release ─────────────────────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(RELEASE_DIR, 'manifest.json'), 'utf8'));
if (manifest.schema.nbins !== NBINS) throw new Error(`manifest nbins ${manifest.schema.nbins} != ${NBINS}`);
console.log(`[extract] release ${manifest.release}: ${manifest.bands.length} bands, ${manifest.stars.rows} stars`);

console.log('[extract] loading stars.arrow ...');
const starsTable = arrow.tableFromIPC(fs.readFileSync(path.join(RELEASE_DIR, 'stars.arrow')));
const S_RA = starsTable.getChild('ra_deg').toArray();   // Float64Array
const S_DEC = starsTable.getChild('dec_deg').toArray(); // Float64Array
const S_G = starsTable.getChild('g_mag').toArray();     // Float32Array
if (S_RA.length !== manifest.stars.rows) throw new Error('stars row count mismatch vs manifest');

// ── per-band stratified scan ─────────────────────────────────────────────────
const CAT_CAP = 50000; // candidate cap per category per band (diversity is ample)
const QUOTA = { fold: 2, cdtie: 1, binedge: 1, highdec: 1, rawrap: 1, random: 1 }; // = 7/band
const TARGET_TOTAL = 112;

function pickK(cands, k, rand) {
    // deterministic sample without replacement
    const out = [];
    const pool = cands.slice();
    while (out.length < k && pool.length > 0) {
        const idx = Math.floor(rand() * pool.length);
        out.push(pool[idx]);
        pool[idx] = pool[pool.length - 1];
        pool.pop();
    }
    return out;
}

const cases = [];
const stratCounts = { fold: 0, cdtie: 0, binedge: 0, highdec: 0, rawrap: 0, random: 0 };

for (const band of manifest.bands) {
    const bi = band.index;
    const t = arrow.tableFromIPC(fs.readFileSync(path.join(RELEASE_DIR, band.file)));
    const C = [0, 1, 2, 3].map((k) => t.getChild(`code${k}`).toArray());   // Float32Array ×4
    const S = [0, 1, 2, 3].map((k) => t.getChild(`star${k}`).toArray());   // Uint32Array ×4
    const DIAM = t.getChild('diam_deg').toArray();                          // Float32Array
    const KEY = t.getChild('code_key').toArray();                           // Int32Array
    const nq = t.numRows;
    if (nq !== band.nQuads) throw new Error(`band ${bi} row count ${nq} != manifest ${band.nQuads}`);

    const cand = { fold: [], cdtie: [], binedge: [], highdec: [], rawrap: [] };
    for (let r = 0; r < nq; r++) {
        const c0 = C[0][r], c2 = C[2][r];
        if (cand.fold.length < CAT_CAP && Math.abs(c0 + c2 - 1) < 1e-3) cand.fold.push(r);
        if (cand.cdtie.length < CAT_CAP && Math.abs(c2 - c0) < 1e-4) cand.cdtie.push(r);
        if (cand.binedge.length < CAT_CAP) {
            for (let k = 0; k < 4; k++) {
                const tt = (C[k][r] + 0.5) * 64; // edge iff (v+0.5)*64 near an integer
                if (Math.abs(tt - Math.round(tt)) < 6.4e-4) { cand.binedge.push(r); break; } // 1e-5 in code units
            }
        }
        if (cand.highdec.length < CAT_CAP || cand.rawrap.length < CAT_CAP) {
            let raMin = Infinity, raMax = -Infinity, decAbsMax = 0;
            for (let k = 0; k < 4; k++) {
                const sr = S[k][r];
                const ra = S_RA[sr], dec = S_DEC[sr];
                if (ra < raMin) raMin = ra;
                if (ra > raMax) raMax = ra;
                const ad = Math.abs(dec);
                if (ad > decAbsMax) decAbsMax = ad;
            }
            if (cand.highdec.length < CAT_CAP && decAbsMax > 85) cand.highdec.push(r);
            if (cand.rawrap.length < CAT_CAP && raMax - raMin > 180) cand.rawrap.push(r);
        }
    }

    const rand = mulberry32(0xC0DE0000 + bi);
    const taken = new Set();
    const bandCases = [];
    for (const [cat, q] of Object.entries(QUOTA)) {
        let rows;
        if (cat === 'random') {
            rows = [];
            let guard = 0;
            while (rows.length < q && guard++ < 1000) {
                const r = Math.floor(rand() * nq);
                if (!taken.has(r)) rows.push(r);
            }
        } else {
            rows = pickK(cand[cat].filter((r) => !taken.has(r)), q, rand);
        }
        for (const r of rows) {
            taken.add(r);
            bandCases.push({ cat, r });
            stratCounts[cat]++;
        }
    }
    // backfill to 7 with randoms if sparse categories came up empty
    let guard = 0;
    while (bandCases.length < 7 && guard++ < 1000) {
        const r = Math.floor(rand() * nq);
        if (taken.has(r)) continue;
        taken.add(r);
        bandCases.push({ cat: 'random', r });
        stratCounts.random++;
    }

    for (const { cat, r } of bandCases) {
        const star_rows = [S[0][r], S[1][r], S[2][r], S[3][r]];
        cases.push({
            band: bi, row: r, category: cat,
            star_rows,
            // decimals = human eyes only; *_bits = the values the test consumes
            ra: star_rows.map((sr) => S_RA[sr]),
            dec: star_rows.map((sr) => S_DEC[sr]),
            g: star_rows.map((sr) => S_G[sr]),
            ra_bits: star_rows.map((sr) => f64bitsHex(S_RA[sr])),
            dec_bits: star_rows.map((sr) => f64bitsHex(S_DEC[sr])),
            g_bits: star_rows.map((sr) => f32bits(S_G[sr])),
            expected_code_bits: [f32bits(C[0][r]), f32bits(C[1][r]), f32bits(C[2][r]), f32bits(C[3][r])],
            expected_code_key: KEY[r],
            diam_deg_bits: f32bits(DIAM[r]),
        });
    }
    console.log(`[extract] band ${bi}: ${nq} quads; candidates fold=${cand.fold.length} cdtie=${cand.cdtie.length} binedge=${cand.binedge.length} highdec=${cand.highdec.length} rawrap=${cand.rawrap.length}; took ${bandCases.length}`);
}

// top-up to TARGET_TOTAL with extra seeded randoms cycling bands (deterministic)
{
    const rand = mulberry32(0xC0DEFFFF);
    const byBand = new Map(manifest.bands.map((b) => [b.index, new Set(cases.filter((c) => c.band === b.index).map((c) => c.row))]));
    let bi = 0, guard = 0;
    while (cases.length < TARGET_TOTAL && guard++ < 10000) {
        const band = manifest.bands[bi % manifest.bands.length]; bi++;
        const t = arrow.tableFromIPC(fs.readFileSync(path.join(RELEASE_DIR, band.file)));
        const r = Math.floor(rand() * t.numRows);
        if (byBand.get(band.index).has(r)) continue;
        byBand.get(band.index).add(r);
        const C = [0, 1, 2, 3].map((k) => t.getChild(`code${k}`).toArray());
        const S = [0, 1, 2, 3].map((k) => t.getChild(`star${k}`).toArray());
        const star_rows = [S[0][r], S[1][r], S[2][r], S[3][r]];
        cases.push({
            band: band.index, row: r, category: 'random',
            star_rows,
            ra: star_rows.map((sr) => S_RA[sr]),
            dec: star_rows.map((sr) => S_DEC[sr]),
            g: star_rows.map((sr) => S_G[sr]),
            ra_bits: star_rows.map((sr) => f64bitsHex(S_RA[sr])),
            dec_bits: star_rows.map((sr) => f64bitsHex(S_DEC[sr])),
            g_bits: star_rows.map((sr) => f32bits(S_G[sr])),
            expected_code_bits: [
                f32bits(C[0][r]), f32bits(C[1][r]), f32bits(C[2][r]), f32bits(C[3][r])],
            expected_code_key: t.getChild('code_key').toArray()[r],
            diam_deg_bits: f32bits(t.getChild('diam_deg').toArray()[r]),
        });
        stratCounts.random++;
    }
}

console.log(`[extract] total cases: ${cases.length}; stratification:`, stratCounts);

// ── JS RECOMPUTE (recipe validation + escalation intermediates) ──────────────
function recomputeCase(c, verbose) {
    const stars = c.star_rows.map((_, k) => ({ ra_deg: c.ra[k], dec_deg: c.dec[k] }));
    const ctr = meanRaDec(stars); // STORED order (canonical A,B,C,D)
    const pts = [];
    for (let k = 0; k < 4; k++) {
        const gp = gnomonic(c.ra[k], c.dec[k], ctr.raDeg, ctr.decDeg);
        if (!gp) return { ok: false, reason: 'gnomonic null (behind tangent point)' };
        pts.push({ x: gp.x, y: gp.y, w: -c.g[k] });
    }
    const set = buildQuadCodes(pts, { sepMin: 0, sepMax: Infinity, capInterior: 2 });
    let found = null;
    for (let q = 0; q < set.count; q++) {
        const o = q * 4;
        if (set.quads[o] === 0 && set.quads[o + 1] === 1 && set.quads[o + 2] === 2 && set.quads[o + 3] === 3) {
            found = [set.codes[o], set.codes[o + 1], set.codes[o + 2], set.codes[o + 3]];
            break;
        }
    }
    if (!found) return { ok: false, reason: `no emitted quad with ids (0,1,2,3); emitted=${JSON.stringify(Array.from(set.quads))}` };
    const bits = found.map(f32bits);
    const key = codeKeyF64(found);
    const diamBits = f32bits(dotDeg(unitVec(c.ra[0], c.dec[0]), unitVec(c.ra[1], c.dec[1])));
    const pass = bits.every((b, k) => b === c.expected_code_bits[k]) && key === c.expected_code_key && diamBits === c.diam_deg_bits;
    if (!pass || verbose) {
        console.log(`  [case band=${c.band} row=${c.row} cat=${c.category}] ${pass ? 'PASS' : 'FAIL'}`);
        console.log(`    centroid ra=${ctr.raDeg} (${f64hex(ctr.raDeg)}) dec=${ctr.decDeg} (${f64hex(ctr.decDeg)})`);
        for (let k = 0; k < 4; k++) {
            const u = unitVec(c.ra[k], c.dec[k]);
            console.log(`    star${k} row=${c.star_rows[k]} ra=${c.ra[k]} dec=${c.dec[k]} u=[${u.map(f64hex).join(',')}]`);
            console.log(`      gnomonic x=${pts[k].x} (${f64hex(pts[k].x)}) y=${pts[k].y} (${f64hex(pts[k].y)})`);
        }
        console.log(`    f64 code: [${found.join(', ')}]`);
        console.log(`    f64 bits: [${found.map(f64hex).join(', ')}]`);
        console.log(`    f32 bits: got [${bits}] expected [${c.expected_code_bits}]`);
        console.log(`    code_key: got ${key} expected ${c.expected_code_key}; diam bits got ${diamBits} expected ${c.diam_deg_bits}`);
    }
    return { ok: pass, bits, key };
}

const args = process.argv.slice(2);
if (args.includes('--recompute')) {
    console.log('[recompute] validating the recipe in JS against the stored bytes ...');
    let pass = 0, fail = 0;
    for (const c of cases) {
        const r = recomputeCase(c, false);
        if (r.ok) pass++; else fail++;
    }
    console.log(`[recompute] JS recipe vs stored bytes: ${pass}/${cases.length} bit-exact, ${fail} divergent`);
    if (fail > 0) process.exitCode = 1;
}
const caseArg = args.find((a) => a.startsWith('--case'));
if (caseArg) {
    const spec = caseArg.includes('=') ? caseArg.split('=')[1] : args[args.indexOf(caseArg) + 1];
    const [b, r] = spec.split(':').map(Number);
    const c = cases.find((x) => x.band === b && x.row === r);
    if (!c) { console.error(`case ${spec} not in the selected set`); process.exit(2); }
    recomputeCase(c, true);
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify({
    _note: 'M2 golden vectors — STORED bytes from the g15u release (never recomputed). Tests consume ONLY the *_bits fields (see transport rule in golden_extract.mjs). Regenerate only via crates/conformance/golden_extract.mjs with owner sign-off.',
    release: manifest.release,
    aggregate_md5: manifest.aggregate_md5,
    nbins: NBINS,
    recipe: 'meanRaDec(4 stars, STORED star0..3 order) -> gnomonic(deg) each -> pts {x,y,w:-g} -> buildQuadCodes{sepMin:0,sepMax:Infinity,capInterior:2} -> quad with ids (0,1,2,3); f32 narrow at storage; code_key from F64 code',
    stratification: stratCounts,
    cases,
}, null, 1));
console.log(`[extract] wrote ${cases.length} cases -> ${OUT_PATH}`);

// ── secondary fixture: coder.golden.json scenes A/B in bit-pattern transport ──
// Validates the pinned golden first (fresh JS recompute must Object.is-match
// the decimal fixture — the coordinated-drift tripwire), then re-emits codes
// as u64 bit-pattern hex strings so the Rust side never depends on a decimal
// float parser. Scene C (matchAndGate/summarize) is out of M2 scope.
{
    const golden = JSON.parse(fs.readFileSync(path.join(REST, 'tools/quadindex/coder.golden.json'), 'utf8'));
    const fieldGen = (n, seed, W, H) => {
        const rand = mulberry32(seed);
        const pts = [];
        for (let i = 0; i < n; i++) pts.push({ x: rand() * W, y: rand() * H, w: n - i });
        return pts;
    };
    const validateScene = (name, pts, expect) => {
        const s = buildQuadCodes(pts, golden.qopts);
        if (s.count !== expect.count) throw new Error(`${name}: fresh count ${s.count} != golden ${expect.count}`);
        for (let k = 0; k < s.count * 4; k++) {
            if (!Object.is(s.codes[k], expect.codes[k])) throw new Error(`${name}: fresh code[${k}] ${f64hex(s.codes[k])} != golden ${f64hex(expect.codes[k])} — golden drift, STOP`);
            if (s.quads[k] !== expect.quads[k]) throw new Error(`${name}: fresh quad id[${k}] != golden — golden drift, STOP`);
        }
        return s;
    };
    const sA = validateScene('sceneA', golden.sceneA_quad4.pts, golden.sceneA_quad4);
    const ptsB = fieldGen(golden.sceneB_field40.n, golden.sceneB_field40.seed, golden.sceneB_field40.W, golden.sceneB_field40.H);
    const sB = validateScene('sceneB', ptsB, golden.sceneB_field40);
    fs.writeFileSync(SCENES_OUT_PATH, JSON.stringify({
        _note: 'coder.golden.json scenes A/B re-emitted with codes as u64 bit-pattern hex (parser-proof transport). Validated fresh-vs-pinned at generation. Scene C (matchAndGate) out of M2 scope. Source of truth: rest-integration/tools/quadindex/coder.golden.json.',
        qopts: golden.qopts,
        sceneA_quad4: {
            pts: golden.sceneA_quad4.pts,
            count: golden.sceneA_quad4.count,
            codes_bits: Array.from(sA.codes).map(f64bitsHex),
            quads: Array.from(sA.quads),
        },
        sceneB_field40: {
            seed: golden.sceneB_field40.seed,
            n: golden.sceneB_field40.n,
            W: golden.sceneB_field40.W,
            H: golden.sceneB_field40.H,
            count: golden.sceneB_field40.count,
            codes_bits: Array.from(sB.codes).map(f64bitsHex),
            quads: Array.from(sB.quads),
        },
    }, null, 1));
    console.log(`[extract] scenes A(${sA.count})/B(${sB.count}) validated fresh-vs-pinned; wrote bits fixture -> ${SCENES_OUT_PATH}`);
}
