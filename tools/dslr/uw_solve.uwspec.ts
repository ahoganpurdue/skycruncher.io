// ═══════════════════════════════════════════════════════════════════════════
// ULTRA-WIDE CR2 HEADLESS SOLVE HARNESS (Stage B)
// ═══════════════════════════════════════════════════════════════════════════
//
//   CR2_DUMP=test_results/cr2_dets/<name>.json \
//     npx vitest run -c tools/dslr/uw_harness.config.ts
//
// Drives the REAL solver_entry ultra-wide path (anchored rotation sweep → TS
// verify) headlessly, at test speed — no browser, no re-decode. Detections +
// scale + planet centers come from the Stage-A dump (dump_cr2_solveframe.mjs).
// The ultra-wide path is pure TS; the vitest wasm mock supplies gnomonic_project
// and the per-center loop catches the quad fallback's missing-fn panic, so the
// sweep's peak-z is always observable even on frames that don't lock.
//
// This ISOLATES the candidate-generator + verifier + detection quality from
// blind center generation: planet anchors (correct Schlyter ephemeris from the
// dump) are injected as extraSearchCenters priors, so "given a good center, does
// the sweep+verify lock, and at what sigma?" is answered directly — exactly the
// question the top-3-anchor and deep-verification-escalation levers act on.
//
// Env:
//   CR2_DUMP      dump JSON path (default sample_observation.json)
//   CR2_CENTERS   "ra,dec;ra,dec" extra centers in hours,deg (adds to planets)
//   CR2_EXPECT_RA expected solved RA (hours) — asserted within CR2_RA_TOL if set
//   CR2_RA_TOL    tolerance in hours (default 0.4)

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { solvePlate } from '@/engine/pipeline/m6_plate_solve/solver_entry';
import { resolveLensDistortion } from '@/engine/pipeline/m2_hardware/lens_distortion';

const ROOT = process.cwd();
const DUMP = process.env.CR2_DUMP || 'test_results/cr2_dets/sample_observation.json';

// StarCatalogAdapter fetches /atlas/*.json in the browser; serve from disk.
beforeAll(() => {
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any) => {
        const u = String(url && url.url ? url.url : url);
        if (u.startsWith('/atlas/')) {
            const p = path.join(ROOT, 'public', u);
            if (!fs.existsSync(p)) {
                return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' };
            }
            const txt = fs.readFileSync(p, 'utf8');
            return { ok: true, status: 200, json: async () => JSON.parse(txt), text: async () => txt };
        }
        if (realFetch) return realFetch(url);
        throw new Error('no fetch shim for ' + u);
    };
});

describe('ultra-wide CR2 headless solve', () => {
    it(`solves/diagnoses ${DUMP}`, async () => {
        const dump = JSON.parse(fs.readFileSync(path.join(ROOT, DUMP), 'utf8'));
        const { width, height, scaleArcsecPerPx, detections, planets = [] } = dump;
        let detArr = detections.map((d: any) => ({ x: d.x, y: d.y, flux: +d.flux, fwhm: d.fwhm }));
        // EXPERIMENT: cap to the brightest-N detections (the sweep matches BRIGHT
        // catalog mag<6; feeding faint detections only inflates the chance null).
        if (process.env.CR2_TOPDETS) {
            const n = parseInt(process.env.CR2_TOPDETS, 10);
            detArr = [...detArr].sort((a, b) => b.flux - a.flux).slice(0, n);
        }
        const detectedStars = detArr;
        const imageData = { width, height, data: new Uint8ClampedArray(0), colorSpace: 'srgb' } as any;

        const extra = [...planets.map((p: any) => ({ ra: p.ra_hours, dec: p.dec_degrees, name: p.name }))];
        // Fine planet grid: the anchored sweep pins translation (no fit), so it
        // needs the center within ~0.5° of the anchor's TRUE position. Ephemeris
        // (~arcmin) plus a bloomed-planet detection centroid can exceed that, so
        // a fine grid around each planet removes center-accuracy as a confound —
        // the max over the grid is the achievable sweep/verify signal for a
        // planet-anchored solve. CR2_PLANET_GRID="halfDeg,stepDeg" (e.g. "1.5,0.3").
        if (process.env.CR2_PLANET_GRID) {
            const [half, stp] = process.env.CR2_PLANET_GRID.split(',').map(Number);
            for (const p of planets) {
                const cosd = Math.cos(p.dec_degrees * Math.PI / 180) || 1;
                for (let dd = -half; dd <= half + 1e-9; dd += stp) {
                    for (let dr = -half; dr <= half + 1e-9; dr += stp) {
                        extra.push({ ra: p.ra_hours + (dr / 15) / cosd, dec: p.dec_degrees + dd, name: `${p.name}g` });
                    }
                }
            }
        }
        // Bright naked-eye stars as anchor-center candidates. Gaia (the atlas)
        // SATURATES at the bright end (brightest L1 anchor is mag_g 1.94), so
        // the 1st-mag stars that anchor a landscape astro shot are absent from
        // the catalog — a diagnostic must supply them from the classic list.
        // CR2_STAR_CENTERS="half,step" grids around each (exact positions, so a
        // small grid absorbs only the bloomed-detection centroid error).
        if (process.env.CR2_STAR_CENTERS) {
            const [half, stp] = process.env.CR2_STAR_CENTERS.split(',').map(Number);
            const BRIGHT: [string, number, number][] = [
                ['Sirius', 6.752, -16.716], ['Canopus', 6.399, -52.696], ['Arcturus', 14.261, 19.182],
                ['Vega', 18.616, 38.784], ['Capella', 5.278, 45.998], ['Rigel', 5.242, -8.202],
                ['Procyon', 7.655, 5.225], ['Betelgeuse', 5.919, 7.407], ['Achernar', 1.629, -57.237],
                ['Altair', 19.846, 8.868], ['Aldebaran', 4.599, 16.509], ['Antares', 16.490, -26.432],
                ['Spica', 13.420, -11.161], ['Pollux', 7.755, 28.026], ['Fomalhaut', 22.961, -29.622],
                ['Deneb', 20.690, 45.280], ['Regulus', 10.140, 11.967], ['Adhara', 6.977, -28.972],
                ['Castor', 7.577, 31.888], ['Shaula', 17.560, -37.104], ['Bellatrix', 5.418, 6.350],
                ['Elnath', 5.438, 28.608], ['Alnilam', 5.604, -1.202], ['Alnair', 22.137, -46.961],
                ['Sabik', 17.173, -15.725], ['Kaus Aus.', 18.403, -34.385], ['Nunki', 18.921, -26.297],
            ];
            for (const [name, ra, dec] of BRIGHT) {
                const cosd = Math.cos(dec * Math.PI / 180) || 1;
                for (let dd = -half; dd <= half + 1e-9; dd += stp)
                    for (let dr = -half; dr <= half + 1e-9; dr += stp)
                        extra.push({ ra: ra + (dr / 15) / cosd, dec: dec + dd, name: `${name}*` });
            }
        }
        if (process.env.CR2_CENTERS) {
            for (const pair of process.env.CR2_CENTERS.split(';')) {
                const [ra, dec] = pair.split(',').map(Number);
                if (Number.isFinite(ra) && Number.isFinite(dec)) extra.push({ ra, dec, name: 'CLI' });
            }
        }

        // capture solver console output (peak-z, funnel, verdicts) quietly
        const logs: string[] = [];
        const orig = console.log, origWarn = console.warn;
        console.log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
        console.warn = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
        // NEXT_MOVES §8 positive-proof hook: CR2_LENS_PRIOR=<LENS_DB key or model>
        // resolves a lens-distortion prior and un-distorts the MATCHING coords
        // before the sweep. Optional CR2_LENS_FL sets the focal length. Absent =
        // no prior (baseline). Lets us A/B the sweep-peak σ with vs without the
        // prior on the REAL detection geometry.
        let lensDistortionPrior: ReturnType<typeof resolveLensDistortion> = null;
        if (process.env.CR2_LENS_PRIOR) {
            const key = process.env.CR2_LENS_PRIOR;
            const fl = process.env.CR2_LENS_FL ? parseFloat(process.env.CR2_LENS_FL) : undefined;
            lensDistortionPrior = resolveLensDistortion(null, { lensKey: key, lensModel: key, focalLength: fl });
            console.log(`[UWH-LENS] prior=${lensDistortionPrior ? `${lensDistortionPrior.lensModel} k1=${lensDistortionPrior.k1} k2=${lensDistortionPrior.k2} f=${lensDistortionPrior.focalLength}mm` : 'UNRESOLVED'}`);
        }
        let result: any, threw: any = null;
        const t0 = Date.now();
        try {
            result = await solvePlate(imageData, scaleArcsecPerPx, undefined, undefined, {
                detectedStars,
                scaleLock: scaleArcsecPerPx,
                blindBudgetMs: 600_000,
                extraSearchCenters: extra,
                lensDistortionPrior,
            });
        } catch (e) { threw = e; } finally { console.log = orig; console.warn = origWarn; }
        const ms = Date.now() - t0;

        // ── distill diagnostics ──
        const grab = (needle: string) => logs.filter(l => l.includes(needle));
        const sweepPeaks = grab('[UW-SWEEP]');
        const patchLines = grab('[PATCH]');
        const skyLines = grab('[SKY]');
        const verifiedUW = grab('[VERIFIED-UW]');
        const lockLines = grab('[LOCK]');
        const failUW = grab('FAIL-UW');
        const tsverify = grab('[TSVERIFY]');
        // parse the strongest VERIFIED-UW (verify PASSED the Poisson gate) + its
        // crval from the paired TSVERIFY funnel line, so we see WHERE it verified.
        const verifiedParsed = verifiedUW.map(l => {
            const m = l.match(/(\d+) matches vs (\d+) expected .*?\+?(-?[\d.]+) sigma excess, (\d+) unique/);
            return m ? { matches: +m[1], chance: +m[2], sigma: +m[3], unique: +m[4] } : null;
        }).filter(Boolean).sort((a: any, b: any) => b.sigma - a.sigma);
        const bestVerified = verifiedParsed[0] || null;

        // best peak-z across all centers
        let bestZ = -Infinity, bestPeakLine = '';
        for (const l of [...sweepPeaks]) {
            const m = l.match(/\+?(-?\d+\.\d+) sigma/);
            if (m) { const z = parseFloat(m[1]); if (z > bestZ) { bestZ = z; bestPeakLine = l; } }
        }

        // per-center sweep peaks from forensics (candidate_idx === -2)
        const peaks = (result?.diagnostics?.forensics ?? [])
            .filter((f: any) => f?.status === 'UW_SWEEP_PEAK' && f.uw_peak)
            .map((f: any) => f.uw_peak)
            .sort((a: any, b: any) => b.z - a.z);
        const near = (raH: number, decD: number, p: any) => {
            let dRa = Math.abs(p.ra0 - raH); if (dRa > 12) dRa = 24 - dRa;
            return Math.hypot(dRa * 15 * Math.cos(decD * Math.PI / 180), p.dec0 - decD);
        };
        // peak at the center nearest each injected planet
        const planetPeaks = planets.map((pl: any) => {
            const cands = peaks.filter((p: any) => near(pl.ra_hours, pl.dec_degrees, p) < 3);
            const best = cands.sort((a: any, b: any) => b.z - a.z)[0];
            return { planet: pl.name, best: best ? { z: best.z, theta: best.theta, parity: best.parity, m: best.m, brightCat: best.brightCat, center: `${best.ra0}h/${best.dec0}` } : null };
        });

        // verify PASSES attributed to their centers (forensics UW_VERIFY_PASS)
        const verifyPasses = (result?.diagnostics?.forensics ?? [])
            .filter((f: any) => f?.status === 'UW_VERIFY_PASS' && f.uw_verify)
            .map((f: any) => f.uw_verify)
            .sort((a: any, b: any) => b.sigma - a.sigma);
        const labelCenter = (ra0: number, dec0: number) => {
            for (const pl of planets) { if (near(pl.ra_hours, pl.dec_degrees, { ra0, dec0 }) < 2) return pl.name; }
            return 'other';
        };
        const verifyPassSummary = verifyPasses.map((v: any) => `${labelCenter(v.ra0, v.dec0)}@${v.ra0}h/${v.dec0}:+${v.sigma}σ(${v.matches}m/${v.unique}u)`);

        const sol = result?.solution;
        const summary = {
            dump: path.basename(DUMP),
            frame: `${width}x${height}`,
            scale: scaleArcsecPerPx,
            dets: detectedStars.length,
            planets: planets.map((p: any) => `${p.name}@${p.ra_hours}h/${p.dec_degrees}`),
            solved: !!(result?.success && sol),
            // verify PASSED (Poisson gate) at some center — the meaningful success
            // signal here, since finalizing the WCS needs a wasm fn the test-mock
            // lacks (so result.success can be false even after a real verify pass).
            verified: !!bestVerified,
            bestVerifiedSigma: bestVerified ? bestVerified.sigma : null,
            bestVerifiedMatches: bestVerified ? `${bestVerified.matches}/${bestVerified.unique}u vs ${bestVerified.chance}chance` : null,
            verifyPasses: verifyPassSummary,
            centersSwept: peaks.length,
            bestPeakZ: peaks.length ? peaks[0].z : (Number.isFinite(bestZ) ? +bestZ.toFixed(2) : null),
            bestPeakCenter: peaks.length ? `${peaks[0].ra0}h/${peaks[0].dec0} θ${peaks[0].theta} p${peaks[0].parity} m${peaks[0].m}/${peaks[0].brightCat}` : null,
            planetCenterPeaks: planetPeaks,
            uwSweepGate: 4.5,
            verifiedUWcount: verifiedUW.length,
            lockCount: lockLines.length,
            failUWcount: failUW.length,
            ms,
            threw: threw ? String(threw?.message || threw) : null,
            solution: sol ? {
                ra_hours: +(sol.ra_hours ?? sol.center_ra ?? NaN),
                dec_degrees: +(sol.dec_degrees ?? sol.center_dec ?? NaN),
                pixel_scale: sol.pixel_scale,
                matched: sol.matched_stars?.length ?? sol.matched ?? null,
                confidence: sol.confidence,
            } : null,
        };
        console.log('\n[UWH-SUMMARY] ' + JSON.stringify(summary, null, 2));
        if (bestPeakLine) console.log('[UWH-BESTPEAK] ' + bestPeakLine.replace(/^\[PlateSolver\]\s*/, ''));
        // a few most-informative raw lines
        for (const l of [...patchLines.slice(0, 2), ...skyLines.slice(0, 2), ...verifiedUW, ...lockLines, ...tsverify.slice(0, 3), ...failUW.slice(0, 3)]) {
            console.log('[UWH] ' + l.replace(/^\[PlateSolver\]\s*/, ''));
        }

        // optional assertion for calibration runs
        if (process.env.CR2_EXPECT_RA) {
            const tol = parseFloat(process.env.CR2_RA_TOL || '0.4');
            expect(summary.solved, 'expected a solve').toBe(true);
            const raErr = Math.abs((summary.solution!.ra_hours) - parseFloat(process.env.CR2_EXPECT_RA));
            expect(Math.min(raErr, 24 - raErr), `RA ${summary.solution!.ra_hours}h vs expected ${process.env.CR2_EXPECT_RA}h`).toBeLessThan(tol);
        } else {
            expect(threw, 'harness threw').toBeNull();
        }
    }, 640_000);
});
