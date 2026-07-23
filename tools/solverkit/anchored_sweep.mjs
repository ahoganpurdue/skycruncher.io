// ═══════════════════════════════════════════════════════════════════════════
// SOLVERKIT — GENERATOR: ANCHORED ROTATION SWEEP
// ═══════════════════════════════════════════════════════════════════════════
// Headless port of the LIVE ultra-wide candidate generator
// (src/engine/pipeline/m6_plate_solve/solver_entry.ts, the [ULTRA-WIDE ANCHORED
// SWEEP] block ~L706-826). READ from there, NOT modified there. Same math:
//   - anchor  := a bright compact detection ("this object IS at ra0/dec0")
//   - center  := an assumed sky position (planet ephemeris / bright-star list)
//   - scale   := pinned (metrology); only rotation x parity is brute-forced
//   - project BRIGHT catalog (mag < VERIFY_MAG_LIMIT) with a radius-scaled net;
//     the 1440-orientation score distribution is the significance null; a
//     many-sigma peak becomes a CandidateWCS handed to the validator.
//
// Contract: GENERATOR (contract.mjs). Emits CandidateWCS[] each tagged with its
// MEASURED sweep evidence {z, theta, parity, matches, null...} — never a
// fabricated confidence. An empty list is an honest "no hypothesis".
//
// Supersedes (for headless use): the anchored-sweep logic embedded in
// solver_entry.ts (which stays LIVE for the app). Any promotion back into the
// app is a separate gated decision (see README).

import {
    D2R, loadWasm, loadDetections, loadCatalog, buildDetGrid, countCatMatches,
    cdFrom, cdMetrics, compactAnchors, isMain, fmt,
} from './common.mjs';
import { PC, VERIFY_NET } from './contract.mjs';

// Classic naked-eye anchor stars (J2000) — Gaia SATURATES at the bright end
// (level_1_anchors brightest is mag_g 1.94; Vega/Arcturus/Altair/Aldebaran are
// effectively absent), so a landscape frame's real bright anchor cannot come
// from the atlas (CR2_SOLVER_FINDINGS §2d). Deterministic coordinates, no ML.
export const BRIGHT_STARS = [
    ['Sirius', 6.7525, -16.7161], ['Canopus', 6.3992, -52.6957], ['Arcturus', 14.2610, 19.1825],
    ['Vega', 18.6156, 38.7837], ['Capella', 5.2782, 45.9980], ['Rigel', 5.2423, -8.2016],
    ['Procyon', 7.6550, 5.2250], ['Betelgeuse', 5.9195, 7.4070], ['Achernar', 1.6286, -57.2367],
    ['Altair', 19.8464, 8.8683], ['Aldebaran', 4.5987, 16.5093], ['Antares', 16.4901, -26.4320],
    ['Spica', 13.4199, -11.1613], ['Pollux', 7.7553, 28.0262], ['Fomalhaut', 22.9608, -29.6222],
    ['Deneb', 20.6905, 45.2803], ['Regulus', 10.1395, 11.9672], ['Adhara', 6.9770, -28.9721],
    ['Castor', 7.5766, 31.8883], ['Bellatrix', 5.4188, 6.3497], ['Elnath', 5.4382, 28.6075],
    ['Alnilam', 5.6036, -1.2019], ['Alnitak', 5.6793, -1.9426], ['Alioth', 12.9005, 55.9598],
    ['Dubhe', 11.0621, 61.7510], ['Mirfak', 3.4054, 49.8612], ['Wezen', 7.1399, -26.3932],
];

/** Planet centers from an app-captured frame's ephemeris block (deg). */
export function planetCenters(meta) {
    return (meta.planets || []).map((p) => ({ raDeg: p.ra_hours * 15, decDeg: p.dec_degrees, name: p.name }));
}
/** Classic bright-star centers (deg). */
export function brightStarCenters() {
    return BRIGHT_STARS.map(([name, raH, dec]) => ({ raDeg: raH * 15, decDeg: dec, name }));
}

/**
 * Anchored rotation sweep over (center x anchor). Returns ranked CandidateWCS[].
 * @param frame {det, width, height, scaleArcsecPerPx}
 * @param opts  {centers?, scale?, magLimit?, radiusDeg?, minZ?, tolBasePx?,
 *               tolSlope?, maxAnchors?, thetaStep?}
 */
export async function generateAnchoredSweep(frame, opts = {}) {
    await loadWasm();
    const det = frame.det, w = frame.width, h = frame.height;
    const scale = opts.scale ?? frame.scaleArcsecPerPx;
    if (!scale) throw new Error('anchored_sweep needs a pixel scale (frame.scaleArcsecPerPx or opts.scale)');
    const centers = opts.centers ?? planetCenters(frame);
    const minZ = opts.minZ ?? PC.SOLVER_UW_SWEEP_MIN_Z;
    const magLimit = opts.magLimit ?? PC.SOLVER_UW_VERIFY_MAG_LIMIT;
    const radiusDeg = opts.radiusDeg ?? ((Math.hypot(w, h) / 2) * scale / 3600 + 5);
    const thetaStep = opts.thetaStep ?? 1.5;
    const o = {
        w, h, ocx: w / 2, ocy: h / 2,
        tolBasePx: opts.tolBasePx ?? Math.max(6, PC.SOLVER_VERIFICATION_RADIUS_ARCSEC / scale),
        tolSlope: opts.tolSlope ?? VERIFY_NET.WIDE_NET_SLOPE,
    };
    const grid = buildDetGrid(det, 128);
    const anchors = compactAnchors(det, { maxFwhm: 40, w, h, edge: 150, k: opts.maxAnchors ?? 6 });
    if (anchors.length === 0) return [];

    const candidates = [];
    for (const c of centers) {
        const { stars } = loadCatalog({ raDeg: c.raDeg, decDeg: c.decDeg, radiusDeg, magLimit });
        if (stars.length < 12) continue;                 // not enough bright catalog
        for (const a of anchors) {
            for (const parity of [1, -1]) {
                let sum = 0, sq = 0, n = 0, peak = { th: 0, m: -1 };
                for (let th = 0; th < 360; th += thetaStep) {
                    const wcs = { crval: [c.raDeg, c.decDeg], crpix: [a.x, a.y], cd: cdFrom(scale, th, parity) };
                    const m = countCatMatches(wcs, stars, grid, o).matched;
                    sum += m; sq += m * m; n++;
                    if (m > peak.m) peak = { th, m };
                }
                const mean = sum / n, std = Math.sqrt(Math.max(1e-9, sq / n - mean * mean)) || 1;
                const z = (peak.m - mean) / std;
                if (z < minZ) continue;
                // fine refine theta around the peak
                let best = { ...peak };
                for (let th = peak.th - thetaStep; th <= peak.th + thetaStep; th += 0.25) {
                    const m = countCatMatches({ crval: [c.raDeg, c.decDeg], crpix: [a.x, a.y], cd: cdFrom(scale, th, parity) }, stars, grid, o).matched;
                    if (m > best.m) best = { th, m };
                }
                candidates.push({
                    wcs: { crval: [c.raDeg, c.decDeg], crpix: [a.x, a.y], cd: cdFrom(scale, best.th, parity) },
                    source: 'anchored_sweep',
                    evidence: {
                        z: +z.toFixed(2), theta: +best.th.toFixed(2), parity, matches: best.m,
                        nullMean: +mean.toFixed(1), nullStd: +std.toFixed(2),
                        center: c.name, centerRaDeg: c.raDeg, centerDecDeg: c.decDeg,
                        anchor: [a.x, a.y], scale,
                    },
                });
            }
        }
    }
    // dedupe near-identical (same center/anchor/parity, theta within 1deg): keep max z
    candidates.sort((a, b) => b.evidence.z - a.evidence.z);
    return candidates;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    const name = args.find((a) => !a.startsWith('--')) ?? 'sample_observation';
    const withStars = args.includes('--bright-stars');
    const f = loadDetections(name);
    const centers = withStars ? [...planetCenters(f), ...brightStarCenters()] : planetCenters(f);
    console.log(`[anchored_sweep] ${f.name} ${f.width}x${f.height} scale=${fmt(f.scaleArcsecPerPx, 3)}"/px  centers=${centers.length}${withStars ? ' (planets+bright stars)' : ' (planets)'}`);
    const cands = await generateAnchoredSweep(f, { centers, minZ: 3.0 });
    if (!cands.length) { console.log('[anchored_sweep] NO candidate cleared minZ — honest empty result.'); return; }
    console.log(`[anchored_sweep] ${cands.length} candidate(s) (minZ=3.0):`);
    for (const c of cands.slice(0, 8)) {
        const { scale, rotation, parity } = cdMetrics(c.wcs.cd);
        console.log(`  z=${fmt(c.evidence.z, 1)} center=${c.evidence.center} theta=${fmt(c.evidence.theta, 1)} parity=${c.evidence.parity} ` +
            `matches=${c.evidence.matches} (null ${fmt(c.evidence.nullMean, 1)}+-${fmt(c.evidence.nullStd, 1)}) ` +
            `crval=[${fmt(c.wcs.crval[0], 2)},${fmt(c.wcs.crval[1], 2)}]deg scale=${fmt(scale, 2)}"/px rot=${fmt(rotation, 1)}`);
    }
}
if (isMain(import.meta.url)) main().catch((e) => { console.error(e); process.exit(2); });
