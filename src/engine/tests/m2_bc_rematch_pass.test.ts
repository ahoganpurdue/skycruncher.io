// Unit tests for the PRIMARY two-pass BC rematch rail:
//   - pure core in m2_hardware/lens_distortion_rematch.ts (match + guards + cull decision)
//   - engine seam runBcRematchPass in m2_hardware/lens_distortion_rematch_pass.ts
//     (the adapter-free early-return paths: coverage-gate refusal + no-WCS no-op).
//
// The full catalog-fetch → densify → SIP-refit → forced-photometry rail is
// exercised end-to-end only against a real solved field (SeeStar headless bit-
// check + the CR2 uwspec evidence lane); here we pin the deterministic geometry,
// the structural guards, and the honest no-op behaviour that keeps the sacred
// narrow-FITS solve byte-identical.

import { describe, it, expect, afterEach } from 'vitest';
import {
    bcInformedRematch, neverWorseVerdict, postSipResidualPx, evalSipPoly, judgeRecovered,
    type IdentifiedPred,
} from '../pipeline/m2_hardware/lens_distortion_rematch';
import { runBcRematchPass } from '../pipeline/m2_hardware/lens_distortion_rematch_pass';
import { makeBrownConradyDistortion } from '../pipeline/m2_hardware/lens_distortion';
import { StarCatalogAdapter } from '../pipeline/m6_plate_solve/star_catalog_adapter';
import { PIPELINE_CONSTANTS as PC } from '../pipeline/constants/pipeline_config';
import type { PlateSolution, MatchedStar } from '../types/Main_types';
import type { MeasuredDistortion as MD } from '../pipeline/m2_hardware/lens_distortion_refit';

const W = 5202, H = 3465;
const CX = (W - 1) / 2, CY = (H - 1) / 2, HD = Math.hypot(CX, CY);
const ruOf = (x: number, y: number) => Math.hypot((x - CX) / HD, (y - CY) / HD);
const jitter = (s: number) => (Math.sin(s * 12.9898) * 43758.5453 % 1) * 0.4;

describe('bcInformedRematch — recovers edge stars, excludes already-matched, guarded', () => {
    const K1 = -0.12, K2 = 0.05;
    const warp = makeBrownConradyDistortion(K1, K2, W, H);
    const out: [number, number] = [0, 0];
    const predictions: IdentifiedPred[] = [];
    const detections: { x: number; y: number; fwhm?: number }[] = [];
    let n = 0;
    for (let uy = 120; uy < H - 120; uy += 150) {
        for (let ux = 120; ux < W - 120; ux += 190) {
            predictions.push({ x: ux, y: uy, gaia_id: `g${n}`, ra_hours: n * 1e-4, dec_degrees: n * 1e-4, mag: 10 });
            warp.toNative(ux, uy, out);
            detections.push({ x: out[0] + jitter(n * 2), y: out[1] + jitter(n * 2 + 1), fwhm: 3 });
            n++;
        }
    }
    // "Already matched" = the central stars (the center-biased original solve).
    const centralGaia = new Set(predictions.filter(p => ruOf(p.x, p.y) <= 0.6).map(p => p.gaia_id));

    it('recovered are EDGE stars not already in the solution; correct-sign guard passes', () => {
        const r = bcInformedRematch({
            detections, predictions, k1: K1, k2: K2, w: W, h: H, tolPx: 20,
            originalMatchedGaia: centralGaia, edgeRuThreshold: 0.6,
        });
        expect(r.recovered.length).toBeGreaterThan(20);
        // every recovered star is genuinely at the edge and NOT already matched
        expect(r.recovered.every(rec => !centralGaia.has(rec.gaia_id))).toBe(true);
        expect(r.recovered.every(rec => rec.ru > 0.6)).toBe(true);
        // recovered carry catalog identity + the paired detection position
        expect(r.recovered[0].gaia_id).toMatch(/^g\d+$/);
        expect(Number.isFinite(r.recovered[0].detX)).toBe(true);
        // false-match guard: correct sign recovers more edge stars than the negated control
        expect(r.edge_bc).toBeGreaterThan(r.edge_baseline);
        expect(r.false_guard_passes).toBe(true);
    });

    it('an identity field (k1=k2=0) recovers nothing beyond baseline — no phantom densification', () => {
        const det2 = predictions.map((p, i) => ({ x: p.x + jitter(i), y: p.y + jitter(i + 1), fwhm: 3 }));
        const r = bcInformedRematch({
            detections: det2, predictions, k1: 0, k2: 0, w: W, h: H, tolPx: 20,
            originalMatchedGaia: new Set(), edgeRuThreshold: 0.6,
        });
        expect(r.edge_recovered).toBe(0);
        expect(r.false_guard_passes).toBe(false);
    });
});

// ── FINDING 1 (2026-07-22): coordinate-level dedupe on the greenfield arm ──────
// The greenfield seam hydrates matched_stars with gaia_id = bare catalog ROW
// INDEX ("0".."264"); every catalog prediction carries a PREFIXED id ("Gaia_…"),
// a disjoint namespace — so the ID exclusion (originalMatchedGaia) is a
// structural NO-OP and every already-matched star re-enters as a phantom
// "recovered" candidate (its own detection sits within tolPx of its BC-distorted
// prediction → double-count of matched_stars / num_stars / the receipt rows).
// The coordinate dedupe (matchedDetections) stops this namespace-agnostically.
describe('bcInformedRematch — FINDING 1 coordinate dedupe (greenfield namespace-disjoint)', () => {
    const K1 = -0.12, K2 = 0.05;
    const warp = makeBrownConradyDistortion(K1, K2, W, H);
    const out: [number, number] = [0, 0];
    const predictions: IdentifiedPred[] = [];
    const detections: { x: number; y: number; fwhm?: number }[] = [];
    let n = 0;
    for (let uy = 120; uy < H - 120; uy += 150) {
        for (let ux = 120; ux < W - 120; ux += 190) {
            // catalog carries the PREFIXED id shape
            predictions.push({ x: ux, y: uy, gaia_id: `Gaia_${n}`, ra_hours: n * 1e-4, dec_degrees: n * 1e-4, mag: 10 });
            warp.toNative(ux, uy, out);
            detections.push({ x: out[0] + jitter(n * 2), y: out[1] + jitter(n * 2 + 1), fwhm: 3 });
            n++;
        }
    }
    // "Already matched" = the central stars (center-biased original solve), but
    // carrying BARE row-index ids (disjoint from "Gaia_*") + their detections.
    const central = predictions.map((p, i) => ({ p, i })).filter(x => ruOf(x.p.x, x.p.y) <= 0.6);
    const bareIds = new Set(central.map((_, k) => String(k)));                    // disjoint ns
    const matchedDetections = central.map(x => ({ x: detections[x.i].x, y: detections[x.i].y }));

    it('WITHOUT coordinate dedupe (ids disjoint) the central stars re-enter as phantom recovered', () => {
        const r = bcInformedRematch({
            detections, predictions, k1: K1, k2: K2, w: W, h: H, tolPx: 20,
            originalMatchedGaia: bareIds, edgeRuThreshold: 0.6,   // ID exclusion only — a no-op here
        });
        expect(r.coord_deduped).toBe(0);
        // the double-count: central (ru ≤ 0.6) stars come back as "recovered"
        expect(r.recovered.some(rec => rec.ru <= 0.6)).toBe(true);
    });

    it('WITH coordinate dedupe the central re-entries are dropped — recovered are EDGE-only', () => {
        const r = bcInformedRematch({
            detections, predictions, k1: K1, k2: K2, w: W, h: H, tolPx: 20,
            originalMatchedGaia: bareIds, matchedDetections, edgeRuThreshold: 0.6,
        });
        expect(r.coord_deduped).toBeGreaterThan(0);
        expect(r.recovered.every(rec => rec.ru > 0.6)).toBe(true);
        expect(r.recovered.some(rec => rec.ru <= 0.6)).toBe(false);
    });

    it('dedupe is exactly the re-entry count: recovered_with + coord_deduped === recovered_without', () => {
        const without = bcInformedRematch({
            detections, predictions, k1: K1, k2: K2, w: W, h: H, tolPx: 20,
            originalMatchedGaia: bareIds, edgeRuThreshold: 0.6,
        });
        const withD = bcInformedRematch({
            detections, predictions, k1: K1, k2: K2, w: W, h: H, tolPx: 20,
            originalMatchedGaia: bareIds, matchedDetections, edgeRuThreshold: 0.6,
        });
        expect(withD.recovered.length + withD.coord_deduped).toBe(without.recovered.length);
    });
});

describe('neverWorseVerdict — structural comparative guard (no thresholds)', () => {
    it('APPLIED only on strictly-more matches AND no-worse RMS', () => {
        expect(neverWorseVerdict({ matched: 50, rmsArcsec: 1 }, { matched: 60, rmsArcsec: 0.9 })).toBe('APPLIED');
        expect(neverWorseVerdict({ matched: 50, rmsArcsec: 1 }, { matched: 51, rmsArcsec: 1 })).toBe('APPLIED');
    });
    it('KEPT_ORIGINAL on degradation: worse RMS, or not strictly more matches', () => {
        expect(neverWorseVerdict({ matched: 50, rmsArcsec: 1 }, { matched: 60, rmsArcsec: 1.5 })).toBe('KEPT_ORIGINAL');
        expect(neverWorseVerdict({ matched: 50, rmsArcsec: 1 }, { matched: 50, rmsArcsec: 0.5 })).toBe('KEPT_ORIGINAL');
        expect(neverWorseVerdict({ matched: 50, rmsArcsec: 1 }, { matched: 40, rmsArcsec: 0.1 })).toBe('KEPT_ORIGINAL');
    });
});

describe('SIP eval + post-SIP residual (final-chain correction)', () => {
    it('evalSipPoly evaluates Σ mat[p][q]·u^p·v^q', () => {
        expect(evalSipPoly([[0, 0], [0, 0.5]], 2, 3)).toBeCloseTo(3, 9); // 0.5·u·v
        expect(evalSipPoly(undefined, 5, 5)).toBe(0);
    });
    it('a fitted SIP that models the displacement drives the residual to ~0', () => {
        const crpix: [number, number] = [0, 0];
        // detected at (10,0), linear pred (6,0) → rx=4; A(u,v)=0.04·u² = 4 at u=10.
        const sip = { a: [[0], [0], [0.04]], b: [[0]] };
        expect(postSipResidualPx(10, 0, 6, 0, undefined, crpix)).toBeCloseTo(4, 9);
        expect(postSipResidualPx(10, 0, 6, 0, sip as any, crpix)).toBeLessThan(1e-9);
    });
});

describe('judgeRecovered — one-rule-for-all recovered-star classification', () => {
    it('kept within envelope with flux; rejected over envelope; rejected on no flux', () => {
        expect(judgeRecovered(1, 2, { measured: true, accepted: true })).toEqual({ kept: true, reject_reason: null });
        expect(judgeRecovered(3, 2, { measured: true, accepted: true })).toEqual({ kept: false, reject_reason: 'RESIDUAL_ENVELOPE' });
        expect(judgeRecovered(1, 2, { measured: true, accepted: false })).toEqual({ kept: false, reject_reason: 'NO_FLUX' });
    });
    it('within envelope but photometry NOT_MEASURED keeps the star (honest, no fabricated pass)', () => {
        expect(judgeRecovered(1, 2, { measured: false, accepted: false })).toEqual({ kept: true, reject_reason: null });
    });
});

// ── engine seam: adapter-free no-op paths (keep the sacred solve byte-identical) ─

function miniSolution(): PlateSolution {
    const matched: MatchedStar[] = Array.from({ length: 20 }, (_, i) => ({
        detected: { x: 100 + i, y: 100 + i, rawX: 100 + i, rawY: 100 + i, flux: 1, fwhm: 3 },
        catalog: { ra: 180 + i * 1e-3, dec: 45 + i * 1e-3, mag: 10, ra_hours: (180 + i * 1e-3) / 15, dec_degrees: 45 + i * 1e-3, gaia_id: `m${i}` },
        residual_arcsec: 1.0,
    }));
    return {
        ra: 180, dec: 45, ra_hours: 12, dec_degrees: 45, pixel_scale: 3.5, rotation: 0,
        fov_width_deg: 1, fov_height_deg: 1, parity: 1, spatial_hash: 'x', confidence: 0.8,
        num_stars: 20, matched_stars: matched,
        wcs: { crpix: [W / 2, H / 2], crval: [12, 45], cd: [[1e-4, 0], [0, 1e-4]] },
    } as PlateSolution;
}

describe('runBcRematchPass — coverage-gate refusal & no-WCS are honest no-ops', () => {
    it('measured-BC not_measured → attempted:false, KEPT_ORIGINAL, solution untouched', async () => {
        const sol = miniSolution();
        const beforeRef = sol.matched_stars;
        const bc = { not_measured: 'thin coverage', k1: 0, k2: null } as unknown as MD;
        const r = await runBcRematchPass({
            solution: sol, bcMeasured: bc, detections: [], scienceBuffer: null,
            imageWidth: W, imageHeight: H,
        });
        expect(r.attempted).toBe(false);
        expect(r.applied).toBe(false);
        expect(r.guard).toBe('KEPT_ORIGINAL');
        expect(r.not_measured).toBeTruthy();
        // solution is byte-identical: same matched_stars ref, no astrometry, no bc_rematch
        expect(sol.matched_stars).toBe(beforeRef);
        expect(sol.astrometry).toBeUndefined();
        expect((sol as any).bc_rematch).toBeUndefined();
    });

    it('no WCS → not_measured no-op', async () => {
        const sol = miniSolution();
        sol.wcs = undefined;
        const bc = { k1: -0.05, k2: 0.01 } as unknown as MD;
        const r = await runBcRematchPass({
            solution: sol, bcMeasured: bc, detections: [], scienceBuffer: null,
            imageWidth: W, imageHeight: H,
        });
        expect(r.attempted).toBe(false);
        expect(r.not_measured).toContain('WCS');
    });

    it('receipt block has the full additive shape (plain scalars/arrays)', async () => {
        const sol = miniSolution();
        const bc = { not_measured: 'thin', k1: 0, k2: null } as unknown as MD;
        const r = await runBcRematchPass({
            solution: sol, bcMeasured: bc, detections: [], scienceBuffer: null,
            imageWidth: W, imageHeight: H,
        });
        for (const k of ['attempted', 'applied', 'guard', 'chain_stage', 'matched_before', 'matched_after',
            'edge_before', 'edge_after', 'rms_before_arcsec', 'rms_after_arcsec', 'recovered_confirmed',
            'recovered_rejected', 'false_guard_passes', 'net_px', 'photometry', 'recovered_stars']) {
            expect(r).toHaveProperty(k);
        }
        expect(r.chain_stage).toBe('FINAL');
        expect(Array.isArray(r.recovered_stars)).toBe(true);
    });
});

// ── FINDING 5 (2026-07-22): full-cone catalog source selection (g15u) ──────────
// bc_rematch must read the SAME full cone the confirm lane does on ultra-wide
// frames (FOV > 26.7° → fovR > SECTOR_LOAD_MAX_RADIUS_DEG) instead of only the
// resident ≤16° patches. When the g15u source is enabled, route through
// queryDeepCatalogG15u (the confirm lane's seam); when disabled (browser cold
// path / opt-out), the g15u branch is skipped entirely and the legacy
// resident-patch path runs byte-identically. Uses the injectable g15u query seam
// (setG15uQuery) so routing is proven without a Tauri/Node index file.
describe('runBcRematchPass — FINDING 5 full-cone catalog source selection (g15u)', () => {
    const g15uDefault = StarCatalogAdapter.isG15uCatalogSourceEnabled();
    afterEach(() => {
        StarCatalogAdapter.setG15uQuery(null);
        StarCatalogAdapter.setG15uCatalogSource(g15uDefault);
    });

    // UW frame: fovR = 50/2 * 1.2 = 30 > SECTOR_LOAD_MAX_RADIUS_DEG (16) — the
    // regime where the legacy path never pages and reads only resident patches.
    function uwSolution(): PlateSolution {
        const s = miniSolution();
        s.fov_width_deg = 50; s.fov_height_deg = 50;
        return s;
    }

    it('routes the catalog fetch through g15u (full cone) when the source is enabled', async () => {
        StarCatalogAdapter.setG15uCatalogSource(true);
        const calls: { raHours: number; decDeg: number; radiusDeg: number; magLimit: number }[] = [];
        StarCatalogAdapter.setG15uQuery(async (raHours, decDeg, radiusDeg, magLimit) => {
            calls.push({ raHours, decDeg, radiusDeg, magLimit });
            // one in-frame Gaia row (ra_hours=12, dec=45 ⇒ WCS center) → predictions
            // build, so the pass ATTEMPTS (proves g15u was consumed, not fell back).
            return [{ ra_hours: 12, dec_degrees: 45, magnitude_V: 10, gaia_id: 'Gaia_probe', band: 'GaiaG' as const }];
        });
        const sol = uwSolution();
        const bc = { k1: -0.05, k2: 0.01 } as unknown as MD;
        const r = await runBcRematchPass({
            solution: sol, bcMeasured: bc, detections: [], scienceBuffer: null,
            imageWidth: W, imageHeight: H,
        });
        expect(calls.length).toBe(1);
        // cone args mirror the confirm lane: solved center · fovR (>16 ⇒ UW) · harvest cap
        expect(calls[0].raHours).toBeCloseTo(sol.ra_hours, 9);
        expect(calls[0].decDeg).toBeCloseTo(sol.dec_degrees, 9);
        expect(calls[0].radiusDeg).toBeGreaterThan(PC.SECTOR_LOAD_MAX_RADIUS_DEG);
        expect(calls[0].magLimit).toBe(PC.SOLVER_DEEP_HARVEST_MAG_MAX);
        // g15u returned a non-null cone ⇒ the resident-patch fallback is bypassed;
        // predictions built from it ⇒ the pass ATTEMPTED.
        expect(r.attempted).toBe(true);
    });

    it('cold path: with the g15u source DISABLED the g15u query is never touched (legacy path unchanged)', async () => {
        StarCatalogAdapter.setG15uCatalogSource(false);
        const calls: number[][] = [];
        StarCatalogAdapter.setG15uQuery(async (raHours: number, decDeg: number, radiusDeg: number, magLimit: number) => {
            calls.push([raHours, decDeg, radiusDeg, magLimit]); return [];
        });
        const sol = uwSolution();
        const bc = { k1: -0.05, k2: 0.01 } as unknown as MD;
        const r = await runBcRematchPass({
            solution: sol, bcMeasured: bc, detections: [], scienceBuffer: null,
            imageWidth: W, imageHeight: H,
        });
        // the g15u branch is skipped entirely on the cold path
        expect(calls.length).toBe(0);
        // legacy resident-patch path ran; no atlas loaded in-test ⇒ no in-frame
        // catalog predictions ⇒ honest no-op (byte-identical to the historical path)
        expect(r.attempted).toBe(false);
    });
});
