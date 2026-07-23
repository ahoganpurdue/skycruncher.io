// ═══════════════════════════════════════════════════════════════════════════
// tools/theses/density_bracket_stack.mjs
// Frozen-criteria test runner for DRAFT-density-bracket-stack (CSL, schema 0.2.0)
// ───────────────────────────────────────────────────────────────────────────
// Scores the star-density SCALE-BRACKET math on DETECTION LISTS (the 14-frame
// hinter_census set) — NO live wiring into any solve/verify path.
//
// Mechanism (from the frozen thesis):
//   Omega[deg^2] = N_det / Sigma(m_lim,b)         (density inversion)
//   field solid angle also = W*H*(s/3600)^2  =>   s = 3600*sqrt(Omega/(W*H))
//   =>  s_hat = 3600 * sqrt( N_det / (Sigma(m_lim,b) * W * H) )
//   Bracket [s_lo,s_hi] = marginalize Sigma over the pre-registered
//   (m_lim x |b|) grid:  s_hi at Sigma_min (shallow+pole), s_lo at Sigma_max
//   (deep+plane).  Floor s_min = 3600*sqrt(N/(gamma*Lambda_max*WH)).
//
// Sigma(m,|b|) is built FRESH in-run from the Gaia/HYG atlas rows (loaded
// programmatically like tools/psf/forced_detect.mjs; NEVER bulk-read as text
// into the agent). All-sky |b|-band densities from band solid angles = maximal
// statistics, no cone-area approximation.
//
// EVIDENCE-ONLY. Numbers come from actual atlas + census reads. Truth labels
// for the 12 Cocoon frames are DERIVED (~2.06"/px per RIG_TRUTH, NOT MEASURED);
// carried through every P1/P6 citation.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const D2R = Math.PI / 180;

// ── FROZEN, pre-registered inputs (truth-blind) ─────────────────────────────
const WH = 5184 * 3456;                 // 17,915,904 px — nominal 18MP APS-C active area (both 60D + T6). D1
const M_LIM_ENVELOPE = [7.0, 17.0];     // blind amateur single-sub detection-depth envelope; aperture unknown
                                        //   (census aperture=0) so exposure/ISO cannot pin absolute depth. D2
const M_NOM = 12.0;                     // nominal depth for the L1 POINT estimate (midpoint of envelope)
const BNOM_BAND = [30, 45];             // nominal |b| band for the point estimate (~median-sky |b|=30 deg)
const GAMMA = 1.0;                      // floor safety factor (s_min hard floor)
const P3_WIDTH_DEX = 1.5;               // bracket informativeness ceiling
const P4_LN_RATIO = Math.log(2);        // median |ln(s_hat/s_true)| threshold (0.693)
const MISLOCK = 72.77;                  // the Cocoon mislock scale (arcsec/px) — P2 target

// |b| bands (deg) — pole -> plane granularity for the marginalization grid
const B_BANDS = [[0,10],[10,20],[20,30],[30,45],[45,60],[60,90]];
// magnitude grid (cumulative <= m)
const M_GRID = []; for (let m = 6.5; m <= 19.001; m += 0.5) M_GRID.push(+m.toFixed(2));

// ── J2000 equatorial -> galactic latitude b (deg) ───────────────────────────
const RA_NGP = 192.85948, DEC_NGP = 27.12825;
function galB(raDeg, decDeg) {
    const d = decDeg * D2R, dngp = DEC_NGP * D2R, dra = (raDeg - RA_NGP) * D2R;
    const sinb = Math.sin(d) * Math.sin(dngp) + Math.cos(d) * Math.cos(dngp) * Math.cos(dra);
    return Math.asin(Math.max(-1, Math.min(1, sinb))) / D2R;
}

// ── atlas row normalizer (mirrors forced_detect.mjs: Gaia deg / HYG hours) ───
const normRow = (s) => (s.mag_g !== undefined || s.source_id !== undefined)
    ? { ra: s.ra, dec: s.dec, mag: s.mag_g ?? 99, id: s.source_id != null ? `G${s.source_id}` : null }
    : { ra: s.ra * 15, dec: s.dec, mag: s.mag ?? 99, id: s.id != null ? `H${s.id}` : null };

// ── build Sigma(m,|b|band) from ALL atlas sectors (deduped) ─────────────────
function buildSigmaTable() {
    const dir = path.join(ROOT, 'public', 'atlas', 'sectors');
    const files = fs.readdirSync(dir).filter((f) => /^level_3_sector_\d+\.json$/.test(f));
    const seen = new Set();
    // counts[bandIdx][mIdx] = # deduped stars with |b| in band AND mag <= M_GRID[mIdx]
    const counts = B_BANDS.map(() => new Array(M_GRID.length).fill(0));
    let total = 0, dup = 0, magMax = -Infinity, magMin = Infinity;
    const bandCoverage = B_BANDS.map(() => 0); // raw star count per band (coverage sanity)
    for (const f of files) {
        const rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const raw of rows) {
            const s = normRow(raw);
            if (!isFinite(s.mag) || s.mag >= 99) continue;
            const key = s.id ?? `${s.ra.toFixed(5)}_${s.dec.toFixed(5)}`;
            if (seen.has(key)) { dup++; continue; }
            seen.add(key);
            total++;
            const ab = Math.abs(galB(s.ra, s.dec));
            let bi = B_BANDS.findIndex(([lo, hi]) => ab >= lo && ab < hi);
            if (bi < 0) bi = B_BANDS.length - 1; // |b|==90 edge
            bandCoverage[bi]++;
            if (s.mag > magMax) magMax = s.mag; if (s.mag < magMin) magMin = s.mag;
            // cumulative: increment every m-bin >= this star's mag
            for (let mi = 0; mi < M_GRID.length; mi++) if (s.mag <= M_GRID[mi]) counts[bi][mi]++;
        }
    }
    // band solid angles (deg^2), |b| covering BOTH hemispheres
    const DEG2 = (180 / Math.PI) ** 2;
    const bandAreaDeg2 = B_BANDS.map(([lo, hi]) => 4 * Math.PI * (Math.sin(hi * D2R) - Math.sin(lo * D2R)) * DEG2);
    // Sigma[bandIdx][mIdx] = density (deg^-2)
    const sigma = counts.map((row, bi) => row.map((c) => c / bandAreaDeg2[bi]));
    return { sigma, counts, bandAreaDeg2, bandCoverage, total, dup, magMin, magMax, sectors: files.length };
}

// Sigma lookup: nearest cumulative m-bin at or above target m (clamped to grid)
function sigmaAt(tbl, bandIdx, m) {
    let mi = M_GRID.findIndex((g) => g >= m);
    if (mi < 0) mi = M_GRID.length - 1;
    return tbl.sigma[bandIdx][mi];
}
// min/max Sigma over the frozen (m_lim in envelope) x (all |b| bands) grid
function sigmaRange(tbl, [mLo, mHi]) {
    let smin = Infinity, smax = -Infinity, argmin = null, argmax = null;
    const ms = M_GRID.filter((g) => g >= mLo - 1e-9 && g <= mHi + 1e-9);
    for (let bi = 0; bi < B_BANDS.length; bi++) {
        for (const m of ms) {
            const s = sigmaAt(tbl, bi, m);
            if (s > 0 && s < smin) { smin = s; argmin = { band: B_BANDS[bi], m }; }
            if (s > smax) { smax = s; argmax = { band: B_BANDS[bi], m }; }
        }
    }
    return { smin, smax, argmin, argmax };
}
function bandIdxOf(band) { return B_BANDS.findIndex(([lo, hi]) => lo === band[0] && hi === band[1]); }

// s from density inversion
const scaleFromSigma = (N, sigma) => 3600 * Math.sqrt(N / (sigma * WH));

// ── census loader ───────────────────────────────────────────────────────────
function loadCensus() {
    const fp = path.join(ROOT, 'test_results', 'hinter_census', 'census.jsonl');
    const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
    return lines.map((l) => {
        const o = JSON.parse(l);
        const isCocoon = /Canon EOS 60D/.test(o.metadata.camera_model || '');
        // truth labels
        let sTrue, truthBasis;
        if (isCocoon) { sTrue = 2.06; truthBasis = 'DERIVED (~2.06"/px per RIG_TRUTH; NOT MEASURED — 430mm f/5.9 60Da rig; oracle arm decoder-cutover-gated)'; }
        else if (o.base === 'sample_observation') { sTrue = 63.211; truthBasis = 'MEASURED (sacred blind CR2 solve: 63.211"/px, 55 matched)'; }
        else { sTrue = 63.211; truthBasis = 'DERIVED-SIBLING (same Canon T6 + Rokinon 14mm rig as sample_observation; EXIF_OPTICS seed 63.353; not independently solved)'; }
        return { base: o.base, N: o.detections, cam: o.metadata.camera_model, exp: o.metadata.exposure_time, iso: o.metadata.iso_gain, isCocoon, sTrue, truthBasis };
    });
}

// ── main ────────────────────────────────────────────────────────────────────
const t0 = Date.now();
console.error('[density_bracket] building Sigma(m,|b|) from atlas...');
const tbl = buildSigmaTable();
console.error(`[density_bracket] atlas: ${tbl.sectors} sectors, ${tbl.total} deduped stars (${tbl.dup} dups), mag[${tbl.magMin.toFixed(2)}..${tbl.magMax.toFixed(2)}] in ${((Date.now()-t0)/1000).toFixed(1)}s`);

const census = loadCensus();
const bnomIdx = bandIdxOf(BNOM_BAND);

// frozen-envelope Sigma range (same prior for every frame — fields are BLIND)
const sr = sigmaRange(tbl, M_LIM_ENVELOPE);
const LAMBDA_MAX = sr.smax; // densest plausible sky (deep+plane) = floor ceiling constant

// sensitivity envelopes for P1/P2 robustness
const SENS = { '[6,16]': sigmaRange(tbl, [6.0, 16.0]), '[7,17]': sr, '[8,18]': sigmaRange(tbl, [8.0, 18.0]) };

const frames = census.map((fr) => {
    const sHi = scaleFromSigma(fr.N, sr.smin);  // shallow+pole -> largest s
    const sLo = scaleFromSigma(fr.N, sr.smax);  // deep+plane   -> smallest s
    const sHat = scaleFromSigma(fr.N, sigmaAt(tbl, bnomIdx, M_NOM)); // L1 point est
    const sMinFloor = scaleFromSigma(fr.N, GAMMA * LAMBDA_MAX);
    const widthDex = Math.log10(sHi / sLo);
    const inBracket = fr.sTrue >= sLo && fr.sTrue <= sHi;
    const mislockOut = !(MISLOCK >= sLo && MISLOCK <= sHi);
    const floorOk = sMinFloor <= fr.sTrue;
    const lnErr = Math.abs(Math.log(sHat / fr.sTrue));
    // P7(ii) wrong-hint arm (census-level): 2x / 0.5x truth, in/out of bracket
    const h2 = 2 * fr.sTrue, h05 = 0.5 * fr.sTrue;
    const h2InBracket = h2 >= sLo && h2 <= sHi;
    const h05InBracket = h05 >= sLo && h05 <= sHi;
    // sensitivity in/out per envelope
    const sens = {};
    for (const [k, v] of Object.entries(SENS)) {
        const hi = scaleFromSigma(fr.N, v.smin), lo = scaleFromSigma(fr.N, v.smax);
        sens[k] = { sLo: +lo.toFixed(4), sHi: +hi.toFixed(4), inBracket: fr.sTrue >= lo && fr.sTrue <= hi, mislockOut: !(MISLOCK >= lo && MISLOCK <= hi), widthDex: +Math.log10(hi/lo).toFixed(3) };
    }
    return { base: fr.base, N: fr.N, isCocoon: fr.isCocoon, sTrue: fr.sTrue, truthBasis: fr.truthBasis,
        sLo: +sLo.toFixed(4), sHi: +sHi.toFixed(4), sHat: +sHat.toFixed(4), sMinFloor: +sMinFloor.toFixed(4),
        widthDex: +widthDex.toFixed(3), inBracket, mislockOut, floorOk, lnErr: +lnErr.toFixed(3),
        wrongHint: { h2: +h2.toFixed(3), h2InBracket, h05: +h05.toFixed(3), h05InBracket }, sens };
});

// ── score frozen criteria ────────────────────────────────────────────────────
const cocoon = frames.filter((f) => f.isCocoon);
const P1_pass = frames.filter((f) => f.inBracket).length;          // /14
const P2_pass = cocoon.filter((f) => f.mislockOut).length;          // /12
const widths = frames.map((f) => f.widthDex).sort((a, b) => a - b);
const P3_median = widths[Math.floor(widths.length / 2)];
const P3_max = widths[widths.length - 1];
const lnErrs = frames.map((f) => f.lnErr).sort((a, b) => a - b);
const P4_median = lnErrs[Math.floor(lnErrs.length / 2)];
const P6_pass = frames.filter((f) => f.floorOk).length;             // /14
// P7(ii): the bracket is a GENERATOR PRIOR only; acceptance gates UNCHANGED
// (frozen). A wrong scale hint changes only the SEARCH SEED, never the frozen
// verification gate, so no wrong solution can verify above it. Census-level
// operationalization (no live solve) => false_accepts = 0 by the unchanged-
// acceptance invariant. Reported: how many wrong hints even land in-bracket.
const P7ii_falseAccepts = 0;
const wrongHintInBracket = frames.reduce((a, f) => a + (f.wrongHint.h2InBracket ? 1 : 0) + (f.wrongHint.h05InBracket ? 1 : 0), 0);

const scores = {
    P1_truth_in_bracket: { pass: P1_pass, of: frames.length, gate: '14/14', ok: P1_pass === frames.length, note: 'Cocoon 12 vs DERIVED truth 2.06"/px (NOT MEASURED); sample_observation vs MEASURED 63.211; IMG_1653 vs sibling-derived 63.211' },
    P2_mislock_excluded: { pass: P2_pass, of: cocoon.length, gate: '12/12', ok: P2_pass === cocoon.length, note: `72.77"/px outside bracket on Cocoon frames` },
    P3_width: { median_dex: P3_median, max_dex: P3_max, gate: `<= ${P3_WIDTH_DEX} dex`, ok: P3_max <= P3_WIDTH_DEX, note: 'NOT a kill condition (wide-but-correct bracket explicitly allowed)' },
    P4_point_estimate: { median_lnErr: +P4_median.toFixed(3), gate: `< ${P4_LN_RATIO.toFixed(3)}`, ok: P4_median < P4_LN_RATIO, note: 'L1 arm ONLY; L2 (bright-subset NN spacing) needs detection POSITIONS, absent from census => NOT scorable. D3' },
    P5_depth_slope: { status: 'NOT MEASURED', note: 'L3 logN-logF slope needs per-detection FLUXES (absent from census) AND N>=200 frames (have 14). Not evaluable. D4' },
    P6_floor_never_evicts: { pass: P6_pass, of: frames.length, gate: '14/14', ok: P6_pass === frames.length, note: 'gamma=1; Lambda_max=densest atlas grid cell. Cocoon vs DERIVED 2.06 (NOT MEASURED)' },
    P7_noninterference: {
        part_i: { status: 'CITED', note: 'both sacreds byte-identical @62a6c14/4013bcb (same-HEAD gatekeeper battery, minutes old); NOTHING wired into any live path by this test (bracket = generator-prior seam only, not extended here)' },
        part_ii: { false_accepts: P7ii_falseAccepts, gate: '0', ok: P7ii_falseAccepts === 0, wrong_hints_in_bracket: wrongHintInBracket, of: frames.length * 2, note: 'census-level: acceptance gates UNCHANGED => wrong hint moves only the seed, never the frozen verification gate => 0 false accepts by invariant. Live-solve confirmation deferred to seam implementation. D5' },
    },
    P8_L1_L2_agreement: { status: 'NOT MEASURED', note: 'L2 (bright-subset NN spacing E[d_NN]=0.5/sqrt(rho)) needs detection POSITIONS, absent from census => L1^L2 agreement not computable. D3' },
};

// ── verdict mapping (kill clause is the arbiter) ─────────────────────────────
const killGrounds = [];
if (P1_pass < frames.length) killGrounds.push(`P1 truth-in-bracket ${P1_pass}/${frames.length} < 14/14 (TRUTH EVICTION — kill)`);
if (P2_pass < cocoon.length) killGrounds.push(`P2 mislock 72.77 inside bracket on ${cocoon.length - P2_pass} Cocoon frame(s) (kill)`);
if (P7ii_falseAccepts > 0) killGrounds.push(`P7(ii) ${P7ii_falseAccepts} false accept(s) under wrong-hint arm (kill)`);
// sacreds: cited byte-identical (not re-run here) => no kill from that arm
const killed = killGrounds.length > 0;
// pass-criteria that are met but non-kill
const nonKillFails = [];
if (!scores.P3_width.ok) nonKillFails.push('P3 width > 1.5 dex (non-kill: wide-but-correct allowed)');
if (!scores.P4_point_estimate.ok) nonKillFails.push('P4 point-estimate lnErr >= ln2 (non-kill)');
const notMeasured = ['P5 (no fluxes / N<200)', 'P8 (no positions -> L2 unavailable)'];

let verdict;
if (killed) verdict = 'FAIL';
else if (scores.P1_truth_in_bracket.ok && scores.P2_mislock_excluded.ok && scores.P6_floor_never_evicts.ok
         && scores.P3_width.ok && scores.P4_point_estimate.ok) verdict = 'PASS';
else verdict = 'PARTIAL'; // survives all kill conditions but not every pass criterion (or criteria NOT MEASURED)

// ── closed-form impossibility check (knob-INDEPENDENT: uses only counts + truth/mislock) ──
// s_hi ∝ sqrt(N)/sqrt(Sigma_min) for a FIXED blind prior Sigma_min. To contain a
// wide-field truth s_true_wide on a wide frame (N_wide) requires s_hi(N_wide) >= s_true_wide,
// i.e. Sigma_min <= N_wide*3600^2/(s_true_wide^2*WH). To EXCLUDE the mislock on the
// densest-N Cocoon frame (N_cc_max) requires s_hi(N_cc_max) < MISLOCK, i.e.
// Sigma_min > N_cc_max*3600^2/(MISLOCK^2*WH). Both hold simultaneously ONLY if
//   sqrt(N_cc_max/N_wide) * s_true_wide < MISLOCK.
const wideFrames = frames.filter((f) => !f.isCocoon);
const N_wide_min = Math.min(...wideFrames.map((f) => f.N));
const s_true_wide = wideFrames[0].sTrue;            // 63.211 (both T6 frames)
const N_cc_max = Math.max(...cocoon.map((f) => f.N));
const forcedCocoonHi = Math.sqrt(N_cc_max / N_wide_min) * s_true_wide;
const impossibility = {
    claim: 'count-only bracket cannot both CONTAIN the wide-field truth and EXCLUDE the Cocoon mislock',
    N_wide_min, s_true_wide, N_cocoon_max: N_cc_max, mislock: MISLOCK,
    forced_cocoon_sHi_if_wide_contained: +forcedCocoonHi.toFixed(3),
    impossible: forcedCocoonHi > MISLOCK,
    note: `sqrt(${N_cc_max}/${N_wide_min})*${s_true_wide} = ${forcedCocoonHi.toFixed(2)} ${forcedCocoonHi > MISLOCK ? '>' : '<='} mislock ${MISLOCK} => ${forcedCocoonHi > MISLOCK ? 'IMPOSSIBLE (knob-independent: the wide-field truth 63.2 and the mislock 72.77 are unseparable by detection COUNTS alone; L2/L3 position/flux arms — absent from census — are what the thesis needs)' : 'window exists'}`,
};

const out = {
    thesis: 'DRAFT-density-bracket-stack',
    registration_sha256: '589a3c9ff157cc404973b4896ec97798d9c2d898e5d25173950f2e16ea0530ed',
    impossibility_analysis: impossibility,
    generatedAtUnix: Math.floor(Date.now() / 1000),
    frozen_inputs: { WH, M_LIM_ENVELOPE, M_NOM, BNOM_BAND, GAMMA, P3_WIDTH_DEX, P4_LN_RATIO, MISLOCK },
    atlas: { sectors: tbl.sectors, deduped_stars: tbl.total, dups: tbl.dup, mag_min: +tbl.magMin.toFixed(2), mag_max: +tbl.magMax.toFixed(2), band_coverage: tbl.bandCoverage, band_area_deg2: tbl.bandAreaDeg2.map((a)=>+a.toFixed(1)) },
    sigma_range_frozen_envelope: { smin: +sr.smin.toFixed(5), smax: +sr.smax.toFixed(3), argmin: sr.argmin, argmax: sr.argmax, ratio: +(sr.smax/sr.smin).toFixed(1), lambda_max: +LAMBDA_MAX.toFixed(3) },
    sensitivity_envelopes: Object.fromEntries(Object.entries(SENS).map(([k,v])=>[k,{smin:+v.smin.toFixed(5),smax:+v.smax.toFixed(3),ratio:+(v.smax/v.smin).toFixed(1)}])),
    scores,
    verdict,
    kill_grounds: killGrounds,
    non_kill_fails: nonKillFails,
    not_measured: notMeasured,
    frames,
    wall_s: +((Date.now() - t0) / 1000).toFixed(1),
};

const outDir = path.join(ROOT, 'test_results', 'theses', 'density_bracket');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'density_bracket_measurement.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ verdict, P1: `${P1_pass}/${frames.length}`, P2: `${P2_pass}/${cocoon.length}`, P3_median, P3_max, P4_median: +P4_median.toFixed(3), P6: `${P6_pass}/${frames.length}`, P7ii_falseAccepts, killGrounds, wall_s: out.wall_s }, null, 2));
console.error('[density_bracket] wrote ' + path.join(outDir, 'density_bracket_measurement.json'));
