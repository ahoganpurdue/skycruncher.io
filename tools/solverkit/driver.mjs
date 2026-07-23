// ═══════════════════════════════════════════════════════════════════════════
// SOLVERKIT — DRIVER (compose a GENERATOR -> the VALIDATOR, report)
// ═══════════════════════════════════════════════════════════════════════════
// The CLI seam that wires the kit together:
//   detections (test_results/cr2_dets/<name>.app.json)
//     -> GENERATOR (anchored_sweep | quad)        [hypotheses]
//     -> for each candidate: RANSAC VALIDATOR      [independent skeptic]
//     -> report the best that clears the evidence gate.
//
//   node driver.mjs <frame> [--gen anchored_sweep|quad] [--bright-stars]
//                            [--magLimit N] [--minZ N] [--topN N]
//
// Reuses the LIVE primitives end-to-end (WASM, forced_detect atlas/projection).
// No app/client code is touched.

import { loadDetections, loadCatalog, cdMetrics, isMain, fmt } from './common.mjs';
import { PC, VERIFY_NET } from './contract.mjs';
import { generateAnchoredSweep, planetCenters, brightStarCenters } from './anchored_sweep.mjs';
import { generateQuad } from './quad.mjs';
import { validateWCS } from './ransac.mjs';

/**
 * Full solve of one frame. Returns { accepted, best, evaluated[], generated }.
 * @param frame  loadDetections() result
 * @param opts   {generator:'anchored_sweep'|'quad', centers?, brightStars?,
 *                magLimit?, minZ?, topN?, radiusDeg?, valMagLimit?, quiet?}
 */
export async function solveFrame(frame, opts = {}) {
    const scale = frame.scaleArcsecPerPx;
    const w = frame.width, h = frame.height;
    const fovR = scale ? (Math.hypot(w, h) / 2) * scale / 3600 + 5 : (opts.radiusDeg ?? 5);
    const gen = opts.generator ?? 'anchored_sweep';

    const centers = opts.centers ?? [
        ...planetCenters(frame),
        ...(opts.brightStars ? brightStarCenters() : []),
    ];

    // ── generate hypotheses ─────────────────────────────────────────────────
    let candidates;
    if (gen === 'quad') {
        candidates = await generateQuad(frame, { centers, radiusDeg: fovR, magLimit: opts.magLimit ?? 6 });
    } else {
        candidates = await generateAnchoredSweep(frame, {
            centers, magLimit: opts.magLimit ?? PC.SOLVER_UW_VERIFY_MAG_LIMIT,
            minZ: opts.minZ ?? 3.0,      // emit sub-threshold; the validator is the gate
        });
    }
    const topN = opts.topN ?? 6;
    const short = candidates.slice(0, topN);

    // ── validate each candidate independently ───────────────────────────────
    const valMag = opts.valMagLimit ?? PC.SOLVER_UW_VERIFY_MAG_LIMIT;
    const evaluated = [];
    for (const c of short) {
        const { stars } = loadCatalog({ raDeg: c.wcs.crval[0], decDeg: c.wcs.crval[1], radiusDeg: fovR, magLimit: valMag });
        const v = validateWCS(c.wcs, frame.det, stars, {
            w, h, tolBasePx: 8, tolSlope: VERIFY_NET.WIDE_NET_SLOPE, inlierTolPx: 12, nullK: 128,
        });
        evaluated.push({ candidate: c, validation: v });
    }
    evaluated.sort((a, b) => (b.validation.sigma ?? -1e9) - (a.validation.sigma ?? -1e9));
    const best = evaluated[0] ?? null;
    return { accepted: !!best?.validation.accepted, best, evaluated, generated: candidates.length };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    const name = args.find((a) => !a.startsWith('--')) ?? 'sample_observation';
    const gen = (args.includes('--gen') ? args[args.indexOf('--gen') + 1] : 'anchored_sweep');
    const brightStars = args.includes('--bright-stars');
    const num = (flag, d) => (args.includes(flag) ? +args[args.indexOf(flag) + 1] : d);

    const f = loadDetections(name);
    console.log(`\n═══ solverkit driver ═══  ${f.name}  ${f.width}x${f.height}  scale=${fmt(f.scaleArcsecPerPx, 3)}"/px`);
    console.log(`generator=${gen}  centers=${brightStars ? 'planets+bright-stars' : 'planets'}`);

    const res = await solveFrame(f, {
        generator: gen, brightStars,
        magLimit: num('--magLimit', undefined), minZ: num('--minZ', undefined), topN: num('--topN', 6),
    });
    console.log(`\ngenerated ${res.generated} candidate(s); validated top ${res.evaluated.length}:`);
    for (const e of res.evaluated) {
        const v = e.validation, ev = e.candidate.evidence;
        const m = e.candidate.wcs ? cdMetrics(e.candidate.wcs.cd) : {};
        console.log(`  [${v.accepted ? 'ACCEPT' : 'reject'}] ` +
            `sigma=${fmt(v.sigma, 1)} matched=${v.inliers} (null ${fmt(v.nullMean, 1)}+-${fmt(v.nullStd, 1)}) ` +
            `center=${ev.center ?? '?'} gen-z=${fmt(ev.z, 1)} scale=${fmt(m.scale, 1)}"/px rot=${fmt(m.rotation, 1)} [${v.provenance}]`);
    }
    if (res.accepted) {
        const b = res.best;
        const wc = b.validation.refinedWcs;
        console.log(`\n[SOLVED] center=${b.candidate.evidence.center} at +${fmt(b.validation.sigma, 1)}sigma, ${b.validation.inliers} stars.`);
        console.log(`  WCS crval=[${fmt(wc.crval[0], 4)},${fmt(wc.crval[1], 4)}]deg crpix=[${fmt(wc.crpix[0], 1)},${fmt(wc.crpix[1], 1)}] scale=${fmt(cdMetrics(wc.cd).scale, 3)}"/px`);
    } else {
        console.log(`\n[UNSOLVED] no candidate cleared the ${PC.SOLVER_UW_SWEEP_MIN_Z}sigma-class gate (GATE.Z=5.0). Honest failure.`);
    }
}
if (isMain(import.meta.url)) main().catch((e) => { console.error(e); process.exit(2); });
