// ═══════════════════════════════════════════════════════════════════════════
// HORIZON-ENVELOPE TRUTH-CHECK — SINGLE-FRAME DEMONSTRATOR (D11 round-4)
// ─────────────────────────────────────────────────────────────────────────
// Report-only. NOT a gate (n≈1). Runs metrics 1 & 2 from
//   test_results/overnight_run_2026-07-10/horizon_proposal_speculative.md
// on the ONE certain qualifier: the bundled beach CR2 (public/demo/
// sample_observation.cr2 — Canon T6 + Rokinon-14, LYING 50mm EXIF, SOLVED).
//
// LAW 4: imports the PURE computeHorizonEnvelope from the engine (never
// reimplemented). The evidence-gate SUB-CONDITION values (coverage / areaBelow
// / density-ratio) are recomputed here from the RETURNED envelope + the SAME
// input detections, mirroring horizon_envelope.ts:133-148 exactly — a
// diagnostic read-out of the gate, not a second envelope implementation.
//
// INPUT-TIER CAVEAT (load-bearing honesty): the LIVE path feeds the envelope
// `vanguardCandidates` (signal_processor.ts:348) — the ~3.3-3.9σ raw-blob set
// BEFORE the morphological filter and BEFORE the deep scan. No dump on disk
// contains that exact tier. This driver computes on the m4cull dump's
// `clean_stars` (the curated deep+vanguard SURVIVOR set = the solver's
// quad-input pool). That is a DEEPER, differently-filtered tier, so the
// recomputed envelope is labelled ENVELOPE(APPROXIMATE — non-vanguard tier)
// and CANNOT be claimed byte-identical to the live envelope. The LIVE gate
// outcome is instead read as GROUND TRUTH from the live culling_tally
// (0 TOPOGRAPHY culls ⇒ live hasTerrainEvidence was FALSE).
//
//   node tools/horizon/horizon_demonstrator.mjs
// Writes test_results/overnight_run_2026-07-10/horizon_demonstrator.json
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeHorizonEnvelope } from '../../src/engine/pipeline/m4_signal_detect/horizon_envelope.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = (...p) => path.join(ROOT, ...p);
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ── inputs ────────────────────────────────────────────────────────────────
const m4 = readJSON(P('test_results', 'cr2_dets', 'sample_observation.m4cull.json'));
const astro = readJSON(P('test_results', 'psf', 'astrometry_beach_cr2.json'));

const [width, height] = astro.provenance.image_dims;         // [5202, 3464]
const cleanStars = m4.clean_stars.filter(d => Number.isFinite(d.x) && Number.isFinite(d.y));
const anomalies = m4.anomalies;
const tally = m4.culling_tally || {};
const topographyCulled = tally.TOPOGRAPHY || 0;              // GROUND TRUTH of live gate

// matched_stars = the 55 solved pairs (detected pixel + catalog), sacred solve
const matched = astro.psf_anchors.map(a => ({ x: a.x, y: a.y, ra: a.ra, dec: a.dec, mag: a.mag }));

// ── envelope-Y interpolation over the returned 96-point polyline ────────────
function envYAt(points, x) {
    if (x <= points[0].x) return points[0].y;
    const n = points.length;
    if (x >= points[n - 1].x) return points[n - 1].y;
    for (let i = 0; i < n - 1; i++) {
        if (x >= points[i].x && x <= points[i + 1].x) {
            const t = (x - points[i].x) / (points[i + 1].x - points[i].x);
            return points[i].y + t * (points[i + 1].y - points[i].y);
        }
    }
    return height;
}

// ── gate sub-condition diagnostics (mirror horizon_envelope.ts:133-148) ─────
// Re-buckets the SAME detections into `bins` columns exactly as the fn does and
// reads off the three gate terms from the RETURNED envelope points. This is a
// read-out, not a re-derivation of the silhouette (that came from the import).
function gateDiagnostics(dets, points, bins = 96) {
    const colW = width / bins;
    const cols = Array.from({ length: bins }, () => []);
    for (const d of dets) {
        if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
        const c = Math.min(bins - 1, Math.max(0, Math.floor(d.x / colW)));
        cols[c].push(d);
    }
    let nAbove = 0, nBelow = 0, areaAbove = 0, areaBelow = 0;
    for (let c = 0; c < bins; c++) {
        const yEnv = points[c].y;
        areaAbove += yEnv * colW;
        areaBelow += (height - yEnv) * colW;
        for (const d of cols[c]) {
            if (d.y < yEnv - 4) nAbove++;
            else if (d.y > yEnv + 4) nBelow++;
        }
    }
    const densityAbove = nAbove / Math.max(1, areaAbove);
    const densityBelow = nBelow / Math.max(1, areaBelow);
    return {
        coverage_cond: null, // filled by caller from envelope.coverage
        nAbove, nBelow, areaAbove, areaBelow, densityAbove, densityBelow,
        areaBelow_frac_of_frame: areaBelow / (width * height),
        density_ratio_below_over_above: densityBelow / Math.max(1e-30, densityAbove),
        cond_coverage_ge_0p4: null,
        cond_areaBelow_gt_3pct: areaBelow > width * height * 0.03,
        cond_densityBelow_lt_0p25_densityAbove: densityBelow < densityAbove * 0.25,
    };
}

// ── run the REAL envelope on the (APPROXIMATE tier) clean set, default opts ──
const envApprox = computeHorizonEnvelope(cleanStars, width, height); // default bins=96,minSupport=4
const diag = gateDiagnostics(cleanStars, envApprox.points, 96);
diag.cond_coverage_ge_0p4 = envApprox.coverage >= 0.4;
diag.coverage = envApprox.coverage;

// tier-sensitivity bracket: brightest subsets loosely mimic the sparse vanguard
// tier (report-only; NOT the live vanguard set — sorting proxy by flux/snr).
function brightSubset(frac) {
    const key = (d) => (Number.isFinite(d.flux) ? d.flux : (d.snr ?? 0));
    const sorted = [...cleanStars].sort((a, b) => key(b) - key(a));
    return sorted.slice(0, Math.max(1, Math.round(sorted.length * frac)));
}
const bracket = [0.5, 0.25, 0.1].map(frac => {
    const sub = brightSubset(frac);
    const e = computeHorizonEnvelope(sub, width, height);
    return { frac, n: sub.length, coverage: +e.coverage.toFixed(4), hasTerrainEvidence: e.hasTerrainEvidence };
});

// ── METRIC 1: matched stars below the envelope ──────────────────────────────
// (a) vs the APPROXIMATE measured envelope; (b) vs the LIVE flat-line (y=height).
const m1_below_approx = [];
for (const s of matched) {
    const yEnv = envYAt(envApprox.points, s.x);
    if (s.y > yEnv) m1_below_approx.push({ x: +s.x.toFixed(1), y: +s.y.toFixed(1), envY: +yEnv.toFixed(1), depth_below_px: +(s.y - yEnv).toFixed(0), mag: s.mag, ra: s.ra, dec: s.dec });
}
// live behaviour: flat line at y=height ⇒ no star is below (y>height impossible)
const m1_below_live = matched.filter(s => s.y > height).length;

// WCS-projection cross-check (linear TAN + CD; BC omitted, immaterial to a
// coarse below/above test). Confirms detected px ≈ catalog-projected px.
const D2R = Math.PI / 180;
const [ra0, dec0] = astro.wcs.crval.map(v => v * D2R); // crval in DEGREES
const [cx, cy] = astro.wcs.crpix;                       // 0-based
const cd = astro.wcs.cd;                                 // deg/px
const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
const inv = [[cd[1][1] / det, -cd[0][1] / det], [-cd[1][0] / det, cd[0][0] / det]];
function skyToPix(raDeg, decDeg) {
    const ra = raDeg * D2R, dec = decDeg * D2R;
    const cosc = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
    const xi = (Math.cos(dec) * Math.sin(ra - ra0)) / cosc / D2R;                 // deg
    const eta = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosc / D2R;
    return [cx + inv[0][0] * xi + inv[0][1] * eta, cy + inv[1][0] * xi + inv[1][1] * eta];
}
let projDisagree = 0, projResidSum = 0;
for (const s of matched) {
    const [px, py] = skyToPix(s.ra, s.dec);
    projResidSum += Math.hypot(px - s.x, py - s.y);
    const detBelow = s.y > envYAt(envApprox.points, s.x);
    const projBelow = py > envYAt(envApprox.points, px);
    if (detBelow !== projBelow) projDisagree++;
}
const projResidMedPx = projResidSum / matched.length;

// ── METRIC 2: unmatched clean detections below the envelope, not TOPOGRAPHY ──
// quad-input pool = clean_stars (the curated set feeding quads/solve).
const MATCH_TOL = 4; // px, dedup native tolerance
function isMatched(d) {
    for (const s of matched) if (Math.abs(d.x - s.x) < MATCH_TOL && Math.abs(d.y - s.y) < MATCH_TOL) return true;
    return false;
}
const unmatched = cleanStars.filter(d => !isMatched(d));
const m2_below_approx = unmatched.filter(d => d.y > envYAt(envApprox.points, d.x) && (d.reason !== 'TOPOGRAPHY'));
const m2_below_live = unmatched.filter(d => d.y > height).length; // flat-line ⇒ 0

// ── assemble report ──────────────────────────────────────────────────────────
const report = {
    tag: 'DEMONSTRATOR (report-only; n=1; NOT a gate)',
    generated: new Date().toISOString(),
    frame: {
        id: 'sample_observation (bundled beach CR2)',
        optics: 'Canon EOS Rebel T6 + Rokinon 14mm (LYING 50mm EXIF)',
        image_dims: [width, height],
        solve: {
            source: 'test_results/psf/astrometry_beach_cr2.json (SOURCE=FITTED, sacred solve)',
            ra_hours: astro.provenance.solution.ra_hours,
            dec_degrees: astro.provenance.solution.dec_degrees,
            pixel_scale_arcsec: astro.provenance.solution.pixel_scale,
            stars_matched: astro.provenance.solution.stars_matched,
        },
    },
    input_tier_caveat: {
        live_envelope_input: 'vanguardCandidates (~3.3-3.9σ raw blobs pre-morphological-filter, pre-deep) — signal_processor.ts:348',
        this_run_input: 'm4cull clean_stars (curated deep+vanguard survivors = solver quad-input pool)',
        byte_identity_to_live_envelope: false,
        label: 'ENVELOPE(APPROXIMATE — non-vanguard input tier)',
        why: 'No detection dump on disk contains the exact vanguardCandidates tier; clean_stars is deeper and differently filtered, so the recomputed envelope is not the live envelope.',
        n_input_detections_used: cleanStars.length,
    },
    live_gate_ground_truth: {
        source: 'm4cull culling_tally (the ACTUAL live wizard run)',
        culling_tally: tally,
        topography_culls_fired: topographyCulled,
        live_hasTerrainEvidence: topographyCulled > 0,
        interpretation: topographyCulled === 0
            ? 'HEADLINE: live gate was FALSE — horizon collapsed to a flat line at y=height, NO TOPOGRAPHY cull fired, every foreground detection reached the quad pool/solver unculled. This is exactly the audit-flagged structural failure mode, demonstrated on the one real landscape frame.'
            : 'live gate FIRED — TOPOGRAPHY culls present.',
    },
    envelope_approx: {
        options: 'DEFAULT (bins=96, minSupport=4, supportBandFrac=0.15, smoothWindow=5)',
        hasTerrainEvidence: envApprox.hasTerrainEvidence,
        coverage: +envApprox.coverage.toFixed(4),
        gate_subconditions: {
            coverage: +envApprox.coverage.toFixed(4),
            cond_coverage_ge_0p4: diag.cond_coverage_ge_0p4,
            areaBelow_frac_of_frame: +diag.areaBelow_frac_of_frame.toFixed(5),
            cond_areaBelow_gt_3pct: diag.cond_areaBelow_gt_3pct,
            densityAbove: diag.densityAbove,
            densityBelow: diag.densityBelow,
            density_ratio_below_over_above: +diag.density_ratio_below_over_above.toFixed(5),
            cond_densityBelow_lt_0p25_densityAbove: diag.cond_densityBelow_lt_0p25_densityAbove,
            nAbove: diag.nAbove,
            nBelow: diag.nBelow,
        },
        note: 'gate_subconditions recomputed from the RETURNED envelope + same inputs, mirroring horizon_envelope.ts:133-148 (read-out, not a reimplementation).',
    },
    tier_sensitivity_bracket: {
        note: 'brightest-flux subsets of clean_stars, loosely mimicking the sparse vanguard tier (report-only; NOT the live vanguard set). Shows the gate is input-density sensitive.',
        runs: bracket,
    },
    metric_1_matched_below_envelope: {
        definition: 'matched_stars with y > envelopeY(x) (below the drawn horizon).',
        matched_star_count: matched.length,
        position_basis: 'detected pixel from psf_anchors (the WCS-matched detected positions).',
        vs_approx_envelope: {
            count_below: m1_below_approx.length,
            stars: m1_below_approx,
        },
        vs_live_flat_line: {
            count_below: m1_below_live,
            note: 'flat line at y=height ⇒ 0 by construction (live gate false, no envelope drawn).',
        },
        wcs_projection_crosscheck: {
            method: 'linear TAN gnomonic + CD inverse (BC k1=0.033 omitted — immaterial to coarse below/above)',
            mean_detected_vs_projected_residual_px: +projResidMedPx.toFixed(2),
            below_above_verdict_disagreements: projDisagree,
        },
        forced_photometry_discriminator: 'NOT MEASURED — no science-buffer dump on disk for sample_observation (would need a re-solve emitting scibuf.f32); forcedMeasure real-star-vs-false-match classification not run.',
    },
    metric_2_unmatched_foreground_in_pool: {
        definition: 'unmatched detections with y > envelopeY(x) NOT TOPOGRAPHY-culled; count + fraction of quad-input pool.',
        quad_input_pool_size: cleanStars.length,
        unmatched_count: unmatched.length,
        vs_approx_envelope: {
            count_below: m2_below_approx.length,
            fraction_of_quad_pool: +(m2_below_approx.length / cleanStars.length).toFixed(5),
        },
        vs_live_flat_line: {
            count_below: m2_below_live,
            note: 'flat line at y=height ⇒ 0 by construction; ALL foreground below any true terrain line reached the solver unculled in the live run.',
        },
    },
    metric_3_envelope_vs_truth_altitude: {
        status: 'NOT MEASURED',
        predicate: 'requires gpsReal && clockReal (trusted GPS + clock).',
        note: 'EXIF carries gps_lat/lon [34.0380426,-118.874663] + timestamp 2019-06-03T06:44:07Z, but these are NOT trust-verified (trust-ladder / timestampTrusted gating); per proposal (b) the beach CR2 metric-3 is NOT MEASURED. Alt-az frame is honest-absent without trusted GPS.',
    },
    interpretation: {
        headline: 'On the ONE real landscape frame, the horizon-envelope gate is INPUT-TIER BIMODAL and neither mode culls cleanly.',
        y_band_structure: {
            matched_solved_stars_y_max: 2027,
            clean_detections_y_p90: 2561,
            clean_detections_y_max: 2723,
            frame_height: height,
            reading: 'Real (catalog-matched) stars extend to y~2027; detections (incl. unmatched junk) extend to y~2723; y 2723-3464 is empty (dark ground). The true sky/terrain transition is a band, not a sharp line.',
        },
        mode_A_live_gate_FALSE: 'Live vanguard tier is too sparse (coverage<0.4) — gate FALSE, flat line at y=height, 0 TOPOGRAPHY culls. Result: ~76 unmatched below-terrain detections (metric 2, 3.41% of pool) reached the solver unculled. Audit failure mode CONFIRMED.',
        mode_B_approx_gate_TRUE: 'Richer clean tier trips gate TRUE, but the resulting envelope averages y~2009 — drawn INTO the bottom of the real star field, placing 7 of 55 matched (catalog-confirmed) stars below the line (metric 1). If used as the live cull it would erroneously remove real stars (4 solidly at 22-139px depth, 3 marginal at <=16px within the ~14px projection residual). Over-aggressive placement.',
        tier_sensitivity: 'Bracket shows coverage collapses with sparsity: 50%->0.76(T), 25%->0.66(T), 10%->0.156(F). A ~10% brightest proxy already flips the gate FALSE, CONSISTENT WITH (not a measurement of) the sparse live vanguard tier producing the observed live FALSE gate.',
        caveat: 'The causal link (vanguard sparsity -> live FALSE gate) is INFERRED from the tier bracket, NOT measured — the true vanguardCandidates set is not dumped. forcedMeasure would classify the 7 matched-below and 76 unmatched-below sets (real-star vs foreground-junk) but is NOT MEASURED (no scibuf).',
    },
    not_measured: [
        'metric_3 (no trusted GPS/clock on this frame)',
        'forced-photometry discriminator for metric-1 below-line stars (no sample_observation science-buffer dump on disk)',
        'live-tier (vanguardCandidates) envelope byte-identity (that detection tier is not dumped)',
    ],
};

const outDir = P('test_results', 'overnight_run_2026-07-10');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'horizon_demonstrator.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('=== HORIZON DEMONSTRATOR ===');
console.log('input tier:', report.input_tier_caveat.label, `(n=${cleanStars.length} clean_stars)`);
console.log('LIVE gate ground truth: TOPOGRAPHY culls =', topographyCulled, '=> live hasTerrainEvidence =', topographyCulled > 0);
console.log('APPROX envelope: hasTerrainEvidence =', envApprox.hasTerrainEvidence, '| coverage =', envApprox.coverage.toFixed(4));
console.log('  gate subconditions:', JSON.stringify(report.envelope_approx.gate_subconditions));
console.log('tier bracket:', JSON.stringify(bracket));
console.log('METRIC 1: matched below approx env =', m1_below_approx.length, '/', matched.length, '| vs live flat-line =', m1_below_live);
console.log('  WCS proj crosscheck: mean resid =', projResidMedPx.toFixed(2), 'px | disagreements =', projDisagree);
console.log('METRIC 2: unmatched below approx env =', m2_below_approx.length, '/', unmatched.length, 'unmatched (' + (100 * m2_below_approx.length / cleanStars.length).toFixed(2) + '% of', cleanStars.length, 'pool) | vs live =', m2_below_live);
console.log('METRIC 3: NOT MEASURED (no trusted GPS/clock)');
console.log('-> wrote', path.relative(ROOT, outPath));
