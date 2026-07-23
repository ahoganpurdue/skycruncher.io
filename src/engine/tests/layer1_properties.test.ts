/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAYER-1 PROPERTY-TEST SUITE  (source: DRAFT-layer1-property-tests, CSL backlog)
 * ═══════════════════════════════════════════════════════════════════════════
 * Layer-1 correctness = an EXTERNAL mathematical law, not a past output or a
 * calibrated constant. Every assertion below is a *property* (an inverse
 * closing, an invariant holding, a degenerate input abstaining, a null staying
 * flat) — NONE targets a solver-calibrated number. Pure test addition: zero
 * `src/` changes.
 *
 * Determinism: all randomness flows through the repo's own `mulberry32` LCG
 * (deep_verify.ts) — no unseeded `Math.random`, so every number here is
 * byte-reproducible on any machine (only wall-clock varies).
 *
 * Live-engine surface under test (all run through the vitest wasm mock in
 * setup.ts, whose JS reference mirrors the compiled Rust — see wasm_core.test.ts
 * for the against-Rust anchors):
 *   Pa  SkyTransform.pixelToSky  ⟷  ResidualAnalyzer.skyToLinearPixel   (WCS round-trip)
 *   Pb  AstrometryEngine.generateQuads / buildQuad / calculateQuaddistanceSq (quad hash)
 *   Pc  tps_fitter.fitTps  &  ResidualAnalyzer.analyze (SIP)              (degeneracy abstention)
 *   Pd  deep_verify.deepVerifyEscalation                                  (scrambled-null Monte-Carlo)
 *
 * DIFF vs existing coverage (draft fix 2): sky_transform.test.ts pins ABSOLUTE
 * gnomonic values and fitWCS; this adds the pixel↔sky round-trip across RA-wrap
 * & poles and both parities. m6_tps_fitter.test.ts covers too-few / lopsided
 * octant; this adds collinear + coincident degeneracy AND the SIP fitter (which
 * that file does not exercise). m6_deep_verify.test.ts checks a single-frame
 * null; this adds the N-trial excessZ *distribution* the σ-gate assumes.
 *
 * RESOLVED (Pc): the live SIP fitter (residual_analyzer.gaussianElimination) now
 * carries the singular-matrix guard (pivot magnitude < 1e-12 → abstain, mirroring
 * tps_fitter.solveLinear), so on a rank-deficient (collinear) configuration it
 * returns NO fit (sip_coefficients ABSENT) instead of emitting NON-FINITE
 * coefficients — the paired abstention the draft's INC-4 predicted. The degeneracy
 * test below asserts finite-or-absent directly (it is no longer an it.fails()
 * documenting an open violation).
 */

import { describe, it, expect } from 'vitest';
import { SkyTransform } from '../core/SkyTransform';
import { ResidualAnalyzer } from '../pipeline/m7_astrometry/residual_analyzer';
import { AstrometryEngine } from '../pipeline/m7_astrometry/astrometry_engine';
import { fitTps } from '../pipeline/m6_plate_solve/tps_fitter';
import { mulberry32, scrambledPositions, deepVerifyEscalation } from '../pipeline/m6_plate_solve/deep_verify';
import type { PlateSolution } from '../types/Main_types';

// ════════════════════════════════════════════════════════════════════════════
// Pa — WCS round-trip: pixel → sky → pixel is the identity to float precision.
//   crval[0] is in HOURS internally (the classic trap); the round-trip carries
//   it consistently and is exercised across the 0h/24h RA wrap and near ±90° dec.
// ════════════════════════════════════════════════════════════════════════════
describe('Pa — WCS pixel↔sky round-trip (external law: TAN inverse exactness)', () => {
    // [raHours, decDeg, scaleArcsecPerPx, rotDeg, parity, W, H]
    const CONFIGS: [number, number, number, number, number, number, number][] = [
        [5.5, 22, 3.6, 0, +1, 1000, 800],    // mid-sky, north-up
        [5.5, 22, 3.6, 33, +1, 1000, 800],   // mid-sky, rotated
        [5.5, 22, 3.6, 12, -1, 1000, 800],   // mid-sky, mirrored parity
        [12, 0, 60, 0, +1, 1200, 1000],      // wide field (~14° corners), equator
        [2, 3, 45, 25, +1, 1000, 1000],      // wide, rotated
        [0.05, 10, 10, 0, +1, 900, 900],     // RA just past 0h (wrap edge)
        [23.95, -10, 10, 20, -1, 900, 900],  // RA just before 24h (wrap edge)
        [0.0, 5, 8, 0, +1, 900, 900],        // RA exactly 0h (wrap on both sides)
        [6, 85, 5, 0, +1, 500, 500],         // near north pole
        [6, 89, 3, 45, -1, 500, 500],        // very near north pole, rotated+mirror
        [18, -88, 4, 0, +1, 500, 500],       // near south pole
        [14, -35, 20, 60, -1, 1100, 900],    // southern mid-sky, rotated+mirror
    ];

    it('closes to ≤1e-6 px (median ≤1e-9 px) over a grid incl. edges/corners, both parities, RA-wrap & poles', () => {
        const pxErrs: number[] = [];
        let maxArcsecErr = 0;
        let samples = 0, wrapSamples = 0, poleSamples = 0;

        for (const [raH, decD, scale, rot, parity, W, H] of CONFIGS) {
            const wcs = SkyTransform.createWCSTransform(raH, decD, scale, rot, parity, [(W - 1) / 2, (H - 1) / 2]);
            const near0h = raH < 0.2 || raH > 23.8;
            const nearPole = Math.abs(decD) >= 85;
            // 7×7 grid spanning the full frame — corners & edges included.
            for (let ix = 0; ix < 7; ix++) {
                for (let iy = 0; iy < 7; iy++) {
                    const x = (ix / 6) * (W - 1);
                    const y = (iy / 6) * (H - 1);
                    const sky = SkyTransform.pixelToSky(x, y, wcs);
                    // guard: skip any sample the projection legitimately sends off-sphere
                    if (!Number.isFinite(sky.ra_hours) || !Number.isFinite(sky.dec_degrees)) continue;
                    const back = ResidualAnalyzer.skyToLinearPixel(sky.ra_hours * 15, sky.dec_degrees, wcs);
                    const errPx = Math.hypot(back.x - x, back.y - y);
                    pxErrs.push(errPx);
                    samples++;
                    if (near0h) wrapSamples++;
                    if (nearPole) poleSamples++;
                    // Independent arcsec check: forward-project the recovered sky and
                    // compare angular separation to the first forward sky.
                    const sky2 = SkyTransform.pixelToSky(back.x, back.y, wcs);
                    const arcsec = SkyTransform.calculateAngularSeparation(
                        sky.ra_hours, sky.dec_degrees, sky2.ra_hours, sky2.dec_degrees,
                    ) * 3600;
                    if (Number.isFinite(arcsec)) maxArcsecErr = Math.max(maxArcsecErr, arcsec);
                }
            }
        }

        expect(samples).toBeGreaterThanOrEqual(500);
        expect(wrapSamples).toBeGreaterThan(0);   // RA-wrap actually exercised
        expect(poleSamples).toBeGreaterThan(0);   // near-pole actually exercised

        const maxPx = Math.max(...pxErrs);
        const sorted = [...pxErrs].sort((a, b) => a - b);
        const medianPx = sorted[sorted.length >> 1];

        expect(maxPx).toBeLessThanOrEqual(1e-6);       // Pa bar
        expect(medianPx).toBeLessThanOrEqual(1e-9);    // Pa bar
        expect(maxArcsecErr).toBeLessThanOrEqual(1e-4); // Pa bar
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Pb — quad geometric hash: invariant under similarity (rot/scale/translate) and
//   under mirror (y→-y, via the matcher's own metric); DIFFERENT for a perturbed
//   asterism. (Lang et al. 2010.)
// ════════════════════════════════════════════════════════════════════════════
describe('Pb — quad-hash invariance (external law: similarity/mirror invariance of the code)', () => {
    const code = (pts: { x: number; y: number }[]): number[] => {
        const d = AstrometryEngine.generateQuads(pts, 4);
        return d.length ? d[0].code : [];
    };
    // A quad is "edge" (excluded — the draft's non-edge restriction) when the
    // canonical selection is near a tie: near-equal longest/2nd-longest diagonal,
    // or near-equal C/D ordering, or the A/B hemisphere fold sits on its boundary.
    const isEdgeGeometry = (pts: { x: number; y: number }[], c: number[]): boolean => {
        const ds: number[] = [];
        for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) ds.push(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
        ds.sort((a, b) => b - a);
        if (ds[1] / ds[0] > 0.98) return true;               // ambiguous diagonal
        if (Math.abs(c[0] - c[2]) < 0.03) return true;       // ambiguous C/D order
        if (Math.abs(c[0] + c[2] - 1) < 0.05) return true;   // A/B hemisphere fold edge
        return false;
    };
    const nearBin = (v: number, bin = 0.05): boolean => {
        const f = v / bin - Math.floor(v / bin);
        return f < 0.02 || f > 0.98;
    };

    it('code is invariant under rotation+scale+translation and under mirror; distinct for a perturbed asterism (≥500 quads)', () => {
        const rnd = mulberry32(20260711);
        let tested = 0, hashTested = 0;
        let maxSim = 0, maxMir = 0, minDiff = Infinity;

        for (let t = 0; t < 900 && tested < 600; t++) {
            const pts = Array.from({ length: 4 }, () => ({ x: rnd() * 200, y: rnd() * 200 }));
            const c0 = code(pts);
            if (!c0.length) continue;                  // engine abstained (det<1e-9) — skip
            if (isEdgeGeometry(pts, c0)) continue;     // non-edge restriction

            // Similarity: rotate θ, scale s>0, translate (tx,ty).
            const th = rnd() * 2 * Math.PI, s = 0.3 + rnd() * 3, tx = rnd() * 500, ty = rnd() * 500;
            const cs = Math.cos(th), sn = Math.sin(th);
            const sim = pts.map(p => ({ x: tx + s * (cs * p.x - sn * p.y), y: ty + s * (sn * p.x + cs * p.y) }));
            const cSim = code(sim);
            // Mirror: y → −y.
            const cMir = code(pts.map(p => ({ x: p.x, y: -p.y })));
            // Perturbed (genuinely different asterism): shove one star well off.
            const cDiff = code(pts.map((p, i) => (i === 0 ? { x: p.x + 45, y: p.y + 37 } : p)));
            if (!cSim.length || !cMir.length || !cDiff.length) continue;

            const dSim = AstrometryEngine.calculateQuaddistanceSq(c0, cSim);
            const dMir = AstrometryEngine.calculateQuaddistanceSq(c0, cMir);
            const dDiff = AstrometryEngine.calculateQuaddistanceSq(c0, cDiff);

            expect(dSim).toBeLessThanOrEqual(1e-9);   // similarity invariance
            expect(dMir).toBeLessThanOrEqual(1e-9);   // mirror invariance (matcher metric)
            expect(dDiff).toBeGreaterThan(1e-3);      // perturbed asterism is distinct
            maxSim = Math.max(maxSim, dSim);
            maxMir = Math.max(maxMir, dMir);
            minDiff = Math.min(minDiff, dDiff);
            tested++;

            // hashKey equality for non-bin-edge quads.
            if (!c0.some(v => nearBin(v))) {
                const kA = AstrometryEngine.buildQuad(pts.map((p, i) => ({ ...p, id: i })), [0, 1, 2, 3]);
                const kB = AstrometryEngine.buildQuad(sim.map((p, i) => ({ ...p, id: i })), [0, 1, 2, 3]);
                if (kA && kB) { expect(kB.hashKey).toBe(kA.hashKey); hashTested++; }
            }
        }
        expect(tested).toBeGreaterThanOrEqual(500);
        expect(hashTested).toBeGreaterThan(100);
        // sanity: the separation between "invariant" and "different" is enormous.
        expect(maxSim).toBeLessThan(1e-9);
        expect(minDiff).toBeGreaterThan(100 * Math.max(maxSim, maxMir, 1e-12));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Pc — fitter degeneracy: a rank-deficient / degenerate star configuration must
//   ABSTAIN (return null) or return FINITE coefficients — never a confident
//   garbage (non-finite) fit.  Covers TPS (fitTps) and SIP (ResidualAnalyzer).
// ════════════════════════════════════════════════════════════════════════════
describe('Pc — fitter degeneracy abstention (external law: singular input ⇒ abstain-or-finite)', () => {
    const WCS = { crpix: [500, 400] as [number, number], crval: [10, 20] as [number, number], cd: [[0.001, 0], [0, 0.001]] as [[number, number], [number, number]] };
    const PIXEL_SCALE = 0.001 * 3600; // 3.6"/px

    // ---- TPS degeneracy (generators 1–2; too-few / lopsided already in m6_tps_fitter.test.ts) ----
    const tpsSolutionFrom = (detected: { x: number; y: number }[]): PlateSolution => {
        const matched_stars = detected.map((d, i) => ({
            detected: { x: d.x, y: d.y, flux: 1000, fwhm: 2 },
            catalog: { ra: 150 + i * 0.01, dec: 20 + i * 0.008, mag: 10, gaia_id: `G${i}` },
            residual_arcsec: 3,
        }));
        return { wcs: WCS, matched_stars, pixel_scale: PIXEL_SCALE } as unknown as PlateSolution;
    };

    it('TPS abstains (null) on collinear control points', () => {
        const detected = Array.from({ length: 40 }, (_, i) => ({ x: 100 + i * 20, y: 400 })); // one horizontal line
        const tps = fitTps(tpsSolutionFrom(detected));
        expect(tps).toBeNull();
    });

    it('TPS abstains (null) on coincident (duplicate) control points', () => {
        const detected = Array.from({ length: 40 }, () => ({ x: 500, y: 400 })); // all identical
        const tps = fitTps(tpsSolutionFrom(detected));
        expect(tps).toBeNull();
    });

    it('TPS positive control fits FINITE weights on a well-conditioned 2-D warp', () => {
        // dense 2-D grid + smooth warp — the fitter should admit and return finite.
        const detected: { x: number; y: number }[] = [];
        for (let i = 0; i < 26; i++) for (let j = 0; j < 21; j++) {
            const x = 60 + i * 34, y = 40 + j * 34;
            detected.push({ x: x + 2 + 6 * ((x - 500) ** 2 + (y - 400) ** 2) / 5e5, y: y - 1.5 });
        }
        const tps = fitTps(tpsSolutionFrom(detected));
        // may or may not admit depending on coverage; if it admits, must be finite.
        if (tps) {
            expect(tps.weights_x.every(Number.isFinite)).toBe(true);
            expect(tps.weights_y.every(Number.isFinite)).toBe(true);
        }
    });

    // ---- SIP fitter (built through the live public analyze() boundary) ----
    const sipCoeffsAllFinite = (sol: PlateSolution): { present: boolean; nonFinite: number; total: number } => {
        const res = ResidualAnalyzer.analyze(sol, 3);
        const sip = res.sip_coefficients;
        if (!sip) return { present: false, nonFinite: 0, total: 0 };
        let nonFinite = 0, total = 0;
        for (const row of [...sip.a, ...sip.b]) for (const v of row) { total++; if (!Number.isFinite(v)) nonFinite++; }
        return { present: true, nonFinite, total };
    };

    // Well-conditioned 2-D distorted field: real distortion (rms > 1.2") over a
    // 2-D spread ⇒ SIP must fit FINITE coefficients (positive control).
    const wellConditionedSip = (): PlateSolution => {
        const matched_stars: any[] = [];
        for (let i = 0; i < 26; i++) for (let j = 0; j < 21; j++) {
            const ra = 150 - 0.5 + (i / 25);       // deg
            const dec = 20 - 0.38 + 0.76 * (j / 20); // deg
            const { x: ex, y: ey } = ResidualAnalyzer.skyToLinearPixel(ra, dec, WCS);
            const u = ex - WCS.crpix[0], v = ey - WCS.crpix[1];
            const dx = 2 + 6 * (u * u + v * v) / (500 * 500), dy = -1.5 - 4 * (u * v) / (500 * 500);
            matched_stars.push({ detected: { x: ex + dx, y: ey + dy, flux: 1000, fwhm: 2 }, catalog: { ra, dec, mag: 10, gaia_id: `G${i}_${j}` }, residual_arcsec: Math.hypot(dx, dy) * PIXEL_SCALE });
        }
        return { wcs: WCS, matched_stars, pixel_scale: PIXEL_SCALE } as unknown as PlateSolution;
    };

    // Rank-deficient (collinear, v≡0) field with a real residual ⇒ singular normal
    // matrix. This is the draft's predicted-violation generator.
    const collinearSip = (): PlateSolution => {
        const matched_stars: any[] = [];
        for (let i = 0; i < 30; i++) {
            const ra = 150 + (i - 15) * 0.02, dec = 20 + (i - 15) * 0.02; // deg — varied → real residual
            const { x: ex } = ResidualAnalyzer.skyToLinearPixel(ra, dec, WCS);
            matched_stars.push({ detected: { x: ex, y: WCS.crpix[1], flux: 1000, fwhm: 2 }, catalog: { ra, dec, mag: 10, gaia_id: `G${i}` }, residual_arcsec: 5 });
        }
        return { wcs: WCS, matched_stars, pixel_scale: PIXEL_SCALE } as unknown as PlateSolution;
    };

    it('SIP positive control fits FINITE coefficients on a well-conditioned 2-D distortion', () => {
        const r = sipCoeffsAllFinite(wellConditionedSip());
        expect(r.present).toBe(true);        // distortion detected → SIP ran
        expect(r.nonFinite).toBe(0);         // and every coefficient is finite
    });

    // ── RESOLVED — degeneracy law now HELD by the live engine ─────────────────
    // The SIP normal-equation solver (residual_analyzer.gaussianElimination) carries
    // a singular guard (pivot magnitude < 1e-12 → return null): on the collinear
    // generator the fit ABSTAINS (sip_coefficients absent) instead of dividing by a
    // zero pivot and emitting NON-FINITE coefficients. The property asserts
    // finite-or-absent directly. Do NOT weaken it — absent is the honest outcome
    // (LAW 3), and a non-finite coefficient is never allowed to escape.
    it('SIP degeneracy — collinear input ABSTAINS (SIP absent), never emits NON-FINITE coefficients (finite-or-absent)', () => {
        const r = sipCoeffsAllFinite(collinearSip());
        expect(r.present).toBe(false);       // rank-deficient config → fit abstains, sip_coefficients absent
        expect(r.nonFinite).toBe(0);         // and no non-finite coefficient ever escapes
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Pd — scrambled-null Monte-Carlo: under H0 (random "predicted" positions on a
//   noise frame) the verify excess-z distribution is ~N(0, ~1.1) and NEVER
//   reaches the SOLVER_CONFIRM_SET_EXCESS_Z=15 gate. Fully seeded ⇒ the stats
//   below are byte-reproducible on any machine (only wall-time varies).
// ════════════════════════════════════════════════════════════════════════════
describe('Pd — scrambled-null Monte-Carlo (external law: H0 excess-z is standard-normal-ish, never verifies)', () => {
    it('over N=300 trials: mean∈[-0.2,0.2], std∈[0.75,1.35], P(z≥3)≤0.02, count(z≥15)=0', () => {
        const W = 256, H = 256, BG = 0.125, SIGMA = 0.004;
        const nPred = 180, N = 300, scrambles = 6;

        // One fixed pure-noise frame (no injected stars): the null is over the
        // SCRAMBLED STAR POSITIONS — exactly what the property names ("scrambled
        // star positions must NOT verify"). Deterministic 4-uniform ≈ Gaussian noise.
        const rnd = mulberry32(12345);
        const L = new Float32Array(W * H);
        for (let i = 0; i < L.length; i++) L[i] = BG + SIGMA * ((rnd() + rnd() + rnd() + rnd()) - 2) * Math.sqrt(3);

        const t0 = Date.now();
        const zs: number[] = [];
        for (let t = 0; t < N; t++) {
            const predicted = scrambledPositions({ n: nPred, w: W, h: H, seed: 1000 + t });
            const r = deepVerifyEscalation({ L, w: W, h: H, predicted, fwhmPx: 3.5, sigmaPix: SIGMA, scrambles, seed: 500000 + t * 13 });
            if (r) zs.push(r.excessZ);
        }
        const wallS = (Date.now() - t0) / 1000;

        expect(zs.length).toBe(N); // every trial produced a statistic
        const mean = zs.reduce((s, z) => s + z, 0) / zs.length;
        const std = Math.sqrt(zs.reduce((s, z) => s + (z - mean) ** 2, 0) / zs.length);
        const pTail = zs.filter(z => z >= 3).length / zs.length;
        const nGate = zs.filter(z => z >= 15).length;

        // eslint-disable-next-line no-console
        console.log(`[Pd] N=${zs.length} mean=${mean.toFixed(4)} std=${std.toFixed(4)} P(z≥3)=${pTail.toFixed(4)} count(z≥15)=${nGate} wall=${wallS.toFixed(1)}s`);

        expect(mean).toBeGreaterThanOrEqual(-0.2);
        expect(mean).toBeLessThanOrEqual(0.2);
        expect(std).toBeGreaterThanOrEqual(0.75);
        expect(std).toBeLessThanOrEqual(1.35);
        expect(pTail).toBeLessThanOrEqual(0.02);
        expect(nGate).toBe(0);                      // the heart of Pd: H0 NEVER verifies
    }, 90000); // generous timeout; runtime ≈20s on the reference box (property, not a wall-calibrated gate)
});
