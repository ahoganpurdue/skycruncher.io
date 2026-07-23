// ═══════════════════════════════════════════════════════════════════════════
// SUN-PROXIMITY VETO — IMG_1414 REAL-FRAME STANDING FIXTURE
// ═══════════════════════════════════════════════════════════════════════════
//
//   npx vitest run -c tools/dslr/uw_harness.config.ts tools/dslr/sun_veto_img1414.uwspec.ts
//
// Promotes the IMG_1414 near-Sun false positive (readiness-map item C) into a
// gate-protected, real-frame regression — not just the unit test on the pure
// isSunVetoed helper. It drives the REAL solver_entry ultra-wide path headlessly
// on IMG_1414's actual app detections, INJECTS the Sun position for the frame's
// trusted timestamp (2019-06-03T06:50:55Z → Sun ~4.73h/+22.28°, via the shared
// Schlyter ephem helper), and proves the veto is SURGICAL:
//
//   • the near-Sun chance lock (~28° from the Sun, an impossible night pointing)
//     is REJECTED (UW_SUN_VETO), while
//   • the true ANTISOLAR Jupiter solve (~172° from the Sun) SURVIVES, and
//   • with a confirmed-daytime flag the SAME near-Sun lock is ALLOWED (the
//     add-only daytime bypass, exercised on real data).
//
// UW_SUN_VETO forensics are emitted ONLY after the +σ/unique acceptance gate has
// already cleared (solver_entry verifyWCS), so a UW_SUN_VETO entry is proof that
// an OTHERWISE-GATE-CLEARING lock was rejected purely for sun-proximity.
//
// This is an OPT-IN harness (suffix *.uwspec.ts, NOT *.test.ts/*.spec.ts) so the
// sacred `npx vitest run` gate never picks it up: it depends on the local-only
// corpus dump + atlas (both gitignored), and HONEST-SKIPS when either is absent
// or when the frame no longer produces a near-Sun gate-clearing lock.
//
// Env:
//   SUN_VETO_DUMP   dump JSON path (default test_results/cr2_dets/IMG_1414.app.json)

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { solvePlate } from '@/engine/pipeline/m6_plate_solve/solver_entry';
// Shared Schlyter ephemeris (tools/dslr is outside tsc's `src` include, so this
// .mjs import is runtime-only and cannot perturb the tsc baseline). computeSun is
// the ONE source of the seeded Sun position — not duplicated in the fixture.
import { computeSun } from './ephem.mjs';

const ROOT = process.cwd();
const DUMP = process.env.SUN_VETO_DUMP || 'test_results/cr2_dets/IMG_1414.app.json';
// Mirror of PC.SOLVER_UW_SUN_VETO_DEG. We only use it to CLASSIFY forensic
// centers as near-Sun vs antisolar for the assertions — the solver applies its
// own PC constant. This is not a tunable copy of the gate.
const VETO_DEG = 40;

const D2R = Math.PI / 180;
function sepDeg(ra1H: number, dec1D: number, ra2H: number, dec2D: number): number {
    const a1 = ra1H * 15 * D2R, d1 = dec1D * D2R, a2 = ra2H * 15 * D2R, d2 = dec2D * D2R;
    const c = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2);
    return Math.acos(Math.max(-1, Math.min(1, c))) / D2R;
}

// A small center-out grid around an anchor, so the anchored sweep (which pins
// translation and needs the center within ~0.5° of the peak) reliably visits the
// lock even with a few-arcmin center offset. The LOCK is real either way — this
// only removes center-accuracy as a confound, exactly like the uw_solve harness.
function gridAround(ra: number, dec: number, half: number, step: number, name: string) {
    const cosd = Math.cos(dec * D2R) || 1;
    const out: { ra: number; dec: number; name: string }[] = [];
    for (let dd = -half; dd <= half + 1e-9; dd += step)
        for (let dr = -half; dr <= half + 1e-9; dr += step)
            out.push({ ra: ra + (dr / 15) / cosd, dec: dec + dd, name });
    return out;
}

// StarCatalogAdapter fetches /atlas/*.json in the browser; serve from disk.
beforeAll(() => {
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any) => {
        const u = String(url && url.url ? url.url : url);
        if (u.startsWith('/atlas/')) {
            const p = path.join(ROOT, 'public', u);
            if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' };
            const txt = fs.readFileSync(p, 'utf8');
            return { ok: true, status: 200, json: async () => JSON.parse(txt), text: async () => txt };
        }
        if (realFetch) return realFetch(url);
        throw new Error('no fetch shim for ' + u);
    };
});

describe('ultra-wide sun-proximity veto — IMG_1414 real-frame standing fixture', () => {
    it('rejects the near-Sun false-positive lock while sparing the antisolar Jupiter solve', async (ctx) => {
        const abs = path.join(ROOT, DUMP);
        if (!fs.existsSync(abs)) {
            console.log(`[SUN-VETO-FIXTURE] SKIP: corpus dump absent (${DUMP}) — local-only, gitignored.`);
            ctx.skip(); return;
        }
        if (!fs.existsSync(path.join(ROOT, 'public', 'atlas', 'level_1_anchors.json'))) {
            console.log('[SUN-VETO-FIXTURE] SKIP: star atlas absent (public/atlas, 338MB local-only).');
            ctx.skip(); return;
        }

        const dump = JSON.parse(fs.readFileSync(abs, 'utf8'));
        const { width, height, scaleArcsecPerPx, detections, timestamp } = dump;
        expect(timestamp, 'dump must carry a trusted timestamp to seed the Sun').toBeTruthy();

        const sun = computeSun(new Date(timestamp));
        const sunPosition = { ra_hours: sun.ra_hours, dec_degrees: sun.dec_degrees };
        console.log(`[SUN-VETO-FIXTURE] ${path.basename(DUMP)} @ ${timestamp} → Sun ${sun.ra_hours}h/${sun.dec_degrees}°`);

        const detectedStars = detections.map((d: any) => ({ x: d.x, y: d.y, flux: +d.flux, fwhm: d.fwhm }));
        const imageData = { width, height, data: new Uint8ClampedArray(0), colorSpace: 'srgb' } as any;

        // Two documented anchor centers (fine grids absorb center sensitivity):
        //   • near-Sun chance lock  @ 3.715h/+47.79  (~28° from the Sun → vetoed)
        //   • true Jupiter solve     @ 17.307h/-22.50 (~172° from the Sun → spared)
        const extra = [
            ...gridAround(3.715, 47.79, 1.0, 0.3, 'nearSun'),
            ...gridAround(17.30734, -22.4957, 1.0, 0.3, 'jupiter'),
        ];

        const runSolve = async (daytimeConfirmed: boolean) => {
            const logs: string[] = [];
            const oLog = console.log, oWarn = console.warn;
            console.log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
            console.warn = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
            let result: any, threw: any = null;
            try {
                result = await solvePlate(imageData, scaleArcsecPerPx, undefined, undefined, {
                    detectedStars,
                    scaleLock: scaleArcsecPerPx,
                    blindBudgetMs: 600_000,
                    extraSearchCenters: extra,
                    sunPosition,
                    daytimeConfirmed,
                } as any);
            } catch (e) { threw = e; } finally { console.log = oLog; console.warn = oWarn; }
            const fx = (result?.diagnostics?.forensics ?? []) as any[];
            const passes = fx.filter(f => f?.status === 'UW_VERIFY_PASS' && f.uw_verify).map(f => f.uw_verify);
            const vetoes = fx.filter(f => f?.status === 'UW_SUN_VETO' && f.uw_verify).map(f => f.uw_verify);
            return { passes, vetoes, threw };
        };

        const nearSun = (v: any) => sepDeg(v.ra0, v.dec0, sun.ra_hours, sun.dec_degrees) < VETO_DEG;

        // ── RUN 1: veto ARMED (night frame — no daytime confirmation) ──
        const armed = await runSolve(false);
        expect(armed.threw, `armed solve threw: ${armed.threw}`).toBeFalsy();

        const nearSunVetoes = armed.vetoes.filter(nearSun);
        const nearSunPasses = armed.passes.filter(nearSun);
        const antisolarPasses = armed.passes.filter((v: any) => !nearSun(v));

        // Honest-skip if this frame/center set no longer forms a near-Sun
        // gate-clearing lock (solver drift / partial atlas): the veto simply is
        // not exercised — do not green-wash a fixture that proved nothing.
        if (nearSunVetoes.length === 0 && nearSunPasses.length === 0) {
            console.log('[SUN-VETO-FIXTURE] SKIP: no near-Sun gate-clearing lock formed — veto not exercised on this frame/center set.');
            ctx.skip(); return;
        }

        // 1. The near-Sun lock was REJECTED by the veto. (UW_SUN_VETO ⟹ the lock
        //    had already cleared the +σ/unique gate → an otherwise-accepted lock.)
        expect(
            nearSunVetoes.length,
            `expected the near-Sun lock to be REJECTED (UW_SUN_VETO); near-Sun vetoes=${JSON.stringify(nearSunVetoes)}`,
        ).toBeGreaterThan(0);
        // 2. Nothing near the Sun slipped through as an accepted verify PASS.
        expect(
            nearSunPasses.length,
            `a near-Sun verify PASS leaked past the veto: ${JSON.stringify(nearSunPasses)}`,
        ).toBe(0);
        // 3. SURGICAL: the true antisolar Jupiter solve still verify-passes.
        expect(
            antisolarPasses.length,
            'expected the antisolar Jupiter solve to SURVIVE the veto (surgical, not blanket-reject)',
        ).toBeGreaterThan(0);

        // ── RUN 2: daytime BYPASS (confirmed daylight) — same near-Sun lock ALLOWED ──
        const bypass = await runSolve(true);
        expect(bypass.threw, `bypass solve threw: ${bypass.threw}`).toBeFalsy();
        const bypassNearSunVetoes = bypass.vetoes.filter(nearSun);
        const bypassNearSunPasses = bypass.passes.filter(nearSun);
        // The add-only daytime exception converts the rejection into acceptance
        // for the SAME near-Sun lock — proving the bypass on real detections.
        expect(bypassNearSunVetoes.length, 'daytime bypass must NOT veto any near-Sun lock').toBe(0);
        expect(
            bypassNearSunPasses.length,
            'daytime bypass should let the near-Sun lock verify-PASS again',
        ).toBeGreaterThan(0);

        console.log(
            `[SUN-VETO-FIXTURE] PASS — ARMED: ${nearSunVetoes.length} near-Sun veto(es) ` +
            `(e.g. ${nearSunVetoes[0].ra0}h/${nearSunVetoes[0].dec0}, +${nearSunVetoes[0].sigma}σ), ` +
            `${antisolarPasses.length} antisolar pass(es) survived. ` +
            `BYPASS: ${bypassNearSunPasses.length} near-Sun pass(es) allowed. Veto is surgical.`,
        );
    }, 640_000);
});
