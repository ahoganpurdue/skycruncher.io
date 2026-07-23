// ═══════════════════════════════════════════════════════════════════════════
// CROSS-FRAME LENS-PROFILE TRANSFER — APPLICATION A/B (measurer experiment)
// ═══════════════════════════════════════════════════════════════════════════
//
//   CR2_DUMP=test_results/cr2_dets/IMG_1410.app.json \
//     npx vitest run -c tools/dslr/uw_harness.config.ts tools/dslr/bc_prior_apply.uwspec.ts
//
// Injects a LENS-DISTORTION PRIOR (three modes) into the REAL ultra-wide
// solver on a frame's own detections, holding the injected planet anchors
// FIXED across modes so the ONLY variable is the coordinate un-distortion.
// This ISOLATES the geometry lever the pooled per-rig Brown-Conrady profile
// represents:
//   mode 'none'     — control (no prior; reproduces the recorded baseline).
//   mode 'nominal'  — LENS_DB ROKINON_14_MUSTACHE @14mm (k1=-0.12, k2=0.05).
//   mode 'measured' — the POOLED MEASURED profile (env CR2_LENS_K1/K2), i.e.
//                     the beach-CR2 densified fit (k1=+0.0329, k2=+0.00201),
//                     built as a USER_HINT-provenance resolution so it is
//                     applied in the same makeBrownConradyDistortion path.
//
// Emits per-mode {verified, bestVerifiedSigma, bestPeakZ, verifyPasses, ms}
// to test_results/bc_profile_transfer/apply_<frame>.json. Measured signal =
// Δσ / ΔpeakZ (measured-vs-control, nominal-vs-control). NOT a blind solve:
// centers are anchor-injected; this measures whether the prior helps the
// sweep/verify GIVEN the center — the geometry-only question.

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { solvePlate } from '@/engine/pipeline/m6_plate_solve/solver_entry';
import { resolveLensDistortion, type LensDistortionResolution } from '@/engine/pipeline/m2_hardware/lens_distortion';

const ROOT = process.cwd();
const DUMP = process.env.CR2_DUMP || 'test_results/cr2_dets/IMG_1410.app.json';
const OUT_DIR = path.join(ROOT, 'test_results', 'bc_profile_transfer');
const K1 = process.env.CR2_LENS_K1 ? parseFloat(process.env.CR2_LENS_K1) : 0.032894;
const K2 = process.env.CR2_LENS_K2 ? parseFloat(process.env.CR2_LENS_K2) : 0.002014;

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

function buildPrior(mode: string): LensDistortionResolution | null {
    if (mode === 'none') return null;
    if (mode === 'nominal') {
        return resolveLensDistortion(null, { lensKey: 'ROKINON_14_MUSTACHE', focalLength: 14 });
    }
    // 'measured' — pooled measured profile, applied via the SAME BC path.
    return {
        k1: K1,
        k2: K2,
        coeffs: { k1: K1, k2: K2, k3: 0, p1: 0, p2: 0 },
        provenance: 'USER_HINT',
        lensKey: 'ROKINON_14_MUSTACHE',
        lensModel: 'MEASURED_POOLED_T6_ROKINON14',
        focalLength: 14,
    };
}

async function runMode(dump: any, mode: string) {
    const { width, height, scaleArcsecPerPx, detections, planets = [] } = dump;
    const detectedStars = detections.map((d: any) => ({ x: d.x, y: d.y, flux: +d.flux, fwhm: d.fwhm }));
    const imageData = { width, height, data: new Uint8ClampedArray(0), colorSpace: 'srgb' } as any;
    const extra = planets.map((p: any) => ({ ra: p.ra_hours, dec: p.dec_degrees, name: p.name }));
    const prior = buildPrior(mode);

    const logs: string[] = [];
    const orig = console.log, origWarn = console.warn;
    console.log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
    console.warn = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
    let result: any, threw: any = null;
    const t0 = Date.now();
    try {
        result = await solvePlate(imageData, scaleArcsecPerPx, undefined, undefined, {
            detectedStars,
            scaleLock: scaleArcsecPerPx,
            blindBudgetMs: 600_000,
            extraSearchCenters: extra,
            lensDistortionPrior: prior,
        });
    } catch (e) { threw = e; } finally { console.log = orig; console.warn = origWarn; }
    const ms = Date.now() - t0;

    const grab = (needle: string) => logs.filter(l => l.includes(needle));
    const verifiedUW = grab('[VERIFIED-UW]');
    const verifiedParsed = verifiedUW.map(l => {
        const m = l.match(/(\d+) matches vs (\d+) expected .*?\+?(-?[\d.]+) sigma excess, (\d+) unique/);
        return m ? { matches: +m[1], chance: +m[2], sigma: +m[3], unique: +m[4] } : null;
    }).filter(Boolean).sort((a: any, b: any) => b.sigma - a.sigma);
    const bestVerified = verifiedParsed[0] || null;

    const peaks = (result?.diagnostics?.forensics ?? [])
        .filter((f: any) => f?.status === 'UW_SWEEP_PEAK' && f.uw_peak)
        .map((f: any) => f.uw_peak)
        .sort((a: any, b: any) => b.z - a.z);
    let bestZ = -Infinity;
    for (const l of grab('[UW-SWEEP]')) {
        const m = l.match(/\+?(-?\d+\.\d+) sigma/);
        if (m) { const z = parseFloat(m[1]); if (z > bestZ) bestZ = z; }
    }
    const verifyPasses = (result?.diagnostics?.forensics ?? [])
        .filter((f: any) => f?.status === 'UW_VERIFY_PASS' && f.uw_verify)
        .map((f: any) => f.uw_verify).sort((a: any, b: any) => b.sigma - a.sigma)
        .slice(0, 6).map((v: any) => `${v.ra0}h/${v.dec0}:+${v.sigma}σ(${v.matches}m/${v.unique}u)`);

    return {
        mode,
        prior: prior ? { k1: prior.k1, k2: prior.k2, lensModel: prior.lensModel, provenance: prior.provenance, focalLength: prior.focalLength } : null,
        verified: !!bestVerified,
        bestVerifiedSigma: bestVerified ? bestVerified.sigma : null,
        bestVerifiedMatches: bestVerified ? `${bestVerified.matches}/${bestVerified.unique}u vs ${bestVerified.chance}chance` : null,
        verifyPassCount: verifiedUW.length,
        bestPeakZ: peaks.length ? peaks[0].z : (Number.isFinite(bestZ) ? +bestZ.toFixed(2) : null),
        verifyPasses,
        ms,
        threw: threw ? String(threw?.message || threw) : null,
    };
}

describe('cross-frame lens-profile transfer — application A/B', () => {
    it(`prior A/B on ${DUMP}`, async () => {
        const dump = JSON.parse(fs.readFileSync(path.join(ROOT, DUMP), 'utf8'));
        const frame = path.basename(DUMP).replace(/\.app\.json$|\.json$/, '');
        const modes = ['none', 'nominal', 'measured'];
        const results: any[] = [];
        for (const m of modes) results.push(await runMode(dump, m));

        const control = results.find(r => r.mode === 'none');
        const out = {
            frame,
            dump: path.basename(DUMP),
            frame_dims: `${dump.width}x${dump.height}`,
            scale_arcsec_px: dump.scaleArcsecPerPx,
            n_detections: dump.detections.length,
            planets: (dump.planets || []).map((p: any) => `${p.name}@${p.ra_hours}h/${p.dec_degrees}`),
            pooled_measured_prior: { k1: K1, k2: K2, source: 'beach-CR2 densified 237-pair fit' },
            uw_sweep_gate: 4.5,
            modes: results,
            deltas_vs_control: results.filter(r => r.mode !== 'none').map(r => ({
                mode: r.mode,
                d_bestVerifiedSigma: (r.bestVerifiedSigma != null && control?.bestVerifiedSigma != null)
                    ? +(r.bestVerifiedSigma - control.bestVerifiedSigma).toFixed(2) : null,
                d_bestPeakZ: (r.bestPeakZ != null && control?.bestPeakZ != null)
                    ? +(r.bestPeakZ - control.bestPeakZ).toFixed(2) : null,
                verified_change: `${control?.verified ? 'V' : '-'}->${r.verified ? 'V' : '-'}`,
            })),
        };
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUT_DIR, `apply_${frame}.json`), JSON.stringify(out, null, 2));
        console.log('\n[BC-TRANSFER-APPLY] ' + JSON.stringify(out, null, 2));
        expect(results.length).toBe(3);
    }, 640_000);
});
