// ═══════════════════════════════════════════════════════════════════════════
// SOLVER_UW_TIGHT_REVERIFY — fit-tight-reverify ESCALATION TIER (COORDINATE ledger)
// ═══════════════════════════════════════════════════════════════════════════
// The ultra-wide verifyWCS wide-net gate saturates below the +5-sigma bar even
// for TRUE solutions on huge (>50 deg) fields: the radius-inflated wide net
// (WIDE_NET_SLOPE absorbs unmodeled radial distortion as slop) lets chance track
// matches, so matched-vs-chance stays ~0-4 sigma at truth. This tier mirrors what
// astrometry.net does to lock the same planes: FIT the distortion on provisional
// matches, then RE-VERIFY at fit precision through a TIGHT net.
//
// ROUND 2 (evidence-source fix): Round-1 measured the tier STARVES because it
// inherited the wide-net BRIGHT-subset evidence (~10-16 pairs — the >16 deg field
// skips deep-sector paging, solver_entry.ts:379-382). Two evidence upgrades, each
// gated by its own orchestrator-owned flag (default OFF -> Round-1 behavior, pins
// inherited byte-identical):
//   A. DEEP MATCH PASS (SOLVER_UW_TIGHT_DEEP): the async caller pages a SAMPLED
//      atlas pattern over the footprint and hands a DEEP catalog + deep wide-match
//      set (>=100 pairs) as the evidence — see uw_deep_evidence.ts. This module
//      stays pure: it just consumes whatever catalog/matches it is given.
//   B. INNER-REGION PINHOLE-TIGHT fallback (config.innerFrac): when the fit has
//      too few pairs to run, tight-verify the PINHOLE (candidate) WCS restricted
//      to the inner region where barrel distortion is negligible. No fit needed;
//      center stars match tight, and chance at the tight net over a small region
//      is tiny. Inner-frac arithmetic: the BC radial displacement at normalized
//      radius r is |k1*r^2 + k2*r^4|*r*halfDiagPx (makeBrownConradyDistortion);
//      at r=0.4 with k2~0 that is |k1|*0.064*halfDiag (~|k1|*99px for the 4954
//      2584x1726 frame), so the pinhole stays inside a ~3px net only for a mild
//      barrel (|k1| <~0.03). Frac is orchestrator-owned (SOLVER_UW_TIGHT_INNER_FRAC).
//
// GATING (solver_entry): SOLVER_UW_FIT_REVERIFY (default ON) runs the tier as a
// verdict-NEUTRAL DIAGNOSTIC; SOLVER_UW_TIGHT_ACCEPT (default OFF) turns an
// accepted result into a solution. Pin-safe: pins pass the wide-net and never
// enter the FAIL branch.
//
// TWO-LEDGER LAW: pure coordinate-space point work. No wasm, no atlas, no I/O in
// THIS module (the atlas paging lives in the async uw_deep_evidence.ts wrapper).
// ═══════════════════════════════════════════════════════════════════════════

import { SkyTransform } from '../../core/SkyTransform';
import { fitBrownConrady, type DistortionPair } from '../m2_hardware/lens_distortion_refit';
import { makeBrownConradyDistortion, type LensDistortionModel } from '../m2_hardware/lens_distortion';
import type { DetectedStar, MatchedStar, WCSTransform } from '../../types/Main_types';
import type { StandardStar } from './standard_stars';

export interface UwTightReverifyConfig {
    /** TIGHT match radius in px (SOLVER_UW_TIGHT_NET_PX). */
    tightNetPx: number;
    /** Tight-sigma acceptance bar (SOLVER_UW_TIGHT_ACCEPT_SIGMA — same +5 as wide). */
    acceptSigma: number;
    /** Unique-match floor (the SAME UW_MIN_UNIQUE the wide gate used). */
    minUnique: number;
    /** Reproject-subset mag limit (SOLVER_UW_VERIFY_MAG_LIMIT for bright, deeper for A). */
    magLimit: number;
    /** Reproject-subset row cap. */
    verifyCatCap: number;
    /** Variant B: inner-region pinhole-tight fallback fraction (0/undefined disables). */
    innerFrac?: number;
    /** Optical center for the inner-region restriction (defaults to frame center). */
    opticalCenterX?: number;
    opticalCenterY?: number;
}

export interface UwTightReverifyResult {
    declined: boolean;
    declineReason: string | null;
    /** Which path produced the tight verdict. */
    mode: 'bc_tight' | 'inner_pinhole' | 'declined';
    k1: number;
    k2: number | null;
    fitPairs: number;
    fitUsed: number;
    tightMatches: number;
    tightUnique: number;
    tightExpectedChance: number;
    tightSigma: number;
    /** Inner-region radius fraction actually applied (null unless inner_pinhole). */
    innerFracUsed: number | null;
    accepted: boolean;
    matches: MatchedStar[];
}

/** Pure trigger predicate (fires on a wide-net FAIL when wide excess sigma >= floor). */
export function shouldAttemptTightReverify(enabled: boolean, wideSigma: number, floorZ: number): boolean {
    return enabled && Number.isFinite(wideSigma) && wideSigma >= floorZ;
}

/** Pure excess-sigma — identical form to the wide path (variance floored at 1). */
export function excessSigma(matched: number, expectedChance: number, chanceVar: number): number {
    return (matched - expectedChance) / Math.max(1, Math.sqrt(chanceVar));
}

/** Inverse of the 2x2 CD matrix (sky->pixel), or null when near-singular. */
export function invertCD(wcs: WCSTransform): number[][] | null {
    const det = wcs.cd[0][0] * wcs.cd[1][1] - wcs.cd[0][1] * wcs.cd[1][0];
    if (!(Math.abs(det) > 1e-18)) return null;
    return [
        [wcs.cd[1][1] / det, -wcs.cd[0][1] / det],
        [-wcs.cd[1][0] / det, wcs.cd[0][0] / det],
    ];
}

/** Bright/deep verify subset — filter < magLimit, sort by mag, cap. */
function buildVerifySubset(catalogStars: StandardStar[], magLimit: number, cap: number): StandardStar[] {
    let v = catalogStars.filter((s) => (s.magnitude_V ?? 99) < magLimit);
    if (v.length > cap) {
        v = [...v].sort((a, b) => (a.magnitude_V ?? 99) - (b.magnitude_V ?? 99)).slice(0, cap);
    }
    return v;
}

/** Build a MatchedStar with the EXACT shape solver_entry.verifyWCS.pushMatch emits. */
function buildMatch(det: DetectedStar, cat: StandardStar, residualArcsec: number, dx: number, dy: number): MatchedStar {
    return {
        detected: { ...det },
        catalog: {
            ra: cat.ra_hours * 15,
            dec: cat.dec_degrees,
            mag: cat.magnitude_V,
            bv: cat.color_index_BV,
            ra_hours: cat.ra_hours,
            dec_degrees: cat.dec_degrees,
            name: cat.name,
            gaia_id: cat.gaia_id,
            magnitude_V: cat.magnitude_V,
            band: cat.band,
            spectral_signature: (cat as any).spectral_signature,
        },
        residual_arcsec: residualArcsec,
        ...(Number.isFinite(dx) && Number.isFinite(dy) ? { residual: { dx, dy } } : {}),
    } as MatchedStar;
}

const catKey = (m: MatchedStar): string =>
    (m.catalog as any).gaia_id ?? `${(m.catalog as any).ra_hours},${(m.catalog as any).dec_degrees}`;

/** Project a catalog star through the linear WCS to UNDISTORTED native px (or null off-projection). */
function projectUndistorted(cat: StandardStar, wcs: WCSTransform, inv: number[][]): { x: number; y: number } | null {
    const p = SkyTransform.gnomonicProject(cat.ra_hours, cat.dec_degrees, wcs.crval[0], wcs.crval[1]);
    if (!Number.isFinite(p.xi) || !Number.isFinite(p.eta)) return null;
    return {
        x: wcs.crpix[0] + inv[0][0] * p.xi + inv[0][1] * p.eta,
        y: wcs.crpix[1] + inv[1][0] * p.xi + inv[1][1] * p.eta,
    };
}

/** A cheap in-frame angular prescreen bound (deg) for a candidate footprint. */
function footprintHalfDiagDeg(imageW: number, imageH: number, safeScale: number): number {
    return (Math.hypot(imageW, imageH) * safeScale / 3600) / 2 + 2;
}

/**
 * DEEP WIDE-MATCH (variant A evidence). PURE. Matches a (deep) catalog against
 * ALL detections at the SAME radius-scaled wide net verifyWCS uses, producing the
 * provisional pairs the BC fit needs. Returns MatchedStar[] (det<->catalog).
 */
export function deepWideMatch(args: {
    wcs: WCSTransform;
    catalog: StandardStar[];
    detected: DetectedStar[];
    imageW: number;
    imageH: number;
    safeScale: number;
    baseNetPx: number;
    wideSlope: number;
    opticalCenterX: number;
    opticalCenterY: number;
}): MatchedStar[] {
    const { wcs, catalog, detected, imageW, imageH, safeScale, baseNetPx, wideSlope, opticalCenterX, opticalCenterY } = args;
    const inv = invertCD(wcs);
    if (!inv) return [];
    const cell = Math.max(64, Math.ceil(wideSlope * Math.hypot(imageW, imageH) / 2));
    const gw = Math.max(1, Math.ceil(imageW / cell));
    const grid = new Map<number, number[]>();
    for (let i = 0; i < detected.length; i++) {
        const gx = Math.floor(detected[i].x / cell);
        const gy = Math.floor(detected[i].y / cell);
        const key = gy * gw + gx;
        const b = grid.get(key);
        if (b) b.push(i); else grid.set(key, [i]);
    }
    const halfDiagDeg = footprintHalfDiagDeg(imageW, imageH, safeScale);
    const cosDec0 = Math.cos((wcs.crval[1] * Math.PI) / 180);
    const matches: MatchedStar[] = [];
    for (const cat of catalog) {
        const dDec = Math.abs(cat.dec_degrees - wcs.crval[1]);
        if (dDec > halfDiagDeg) continue;
        let dRaH = Math.abs(cat.ra_hours - wcs.crval[0]);
        if (dRaH > 12) dRaH = 24 - dRaH;
        if (dRaH * 15 * cosDec0 > halfDiagDeg) continue;
        const u = projectUndistorted(cat, wcs, inv);
        if (!u) continue;
        if (u.x < 0 || u.x >= imageW || u.y < 0 || u.y >= imageH) continue;
        const rOptical = Math.hypot(u.x - opticalCenterX, u.y - opticalCenterY);
        const tol = Math.max(baseNetPx, wideSlope * rOptical);
        let bestIdx = -1, bestD = tol, bestDx = 0, bestDy = 0;
        const gx = Math.floor(u.x / cell), gy = Math.floor(u.y / cell);
        for (let dyc = -1; dyc <= 1; dyc++) for (let dxc = -1; dxc <= 1; dxc++) {
            const bucket = grid.get((gy + dyc) * gw + gx + dxc);
            if (!bucket) continue;
            for (const i of bucket) {
                const ddx = detected[i].x - u.x, ddy = detected[i].y - u.y;
                const d = Math.hypot(ddx, ddy);
                if (d < bestD) { bestD = d; bestIdx = i; bestDx = ddx; bestDy = ddy; }
            }
        }
        if (bestIdx >= 0) matches.push(buildMatch(detected[bestIdx], cat, bestD * safeScale, bestDx, bestDy));
    }
    return matches;
}

/**
 * TIGHT MATCH PASS (shared core). PURE. Projects verifyCat through the candidate
 * WCS (+ optional BC model) to native, matches within a TIGHT net, and accumulates
 * the local-Poisson chance budget (identical model to the wide path, tight radius).
 * When innerRadiusPx is set, catalog AND detections are restricted to the inner
 * region so the chance density is honest for the pinhole-tight variant.
 */
function tightMatchPass(args: {
    wcs: WCSTransform;
    inv: number[][];
    verifyCat: StandardStar[];
    detected: DetectedStar[];
    imageW: number;
    imageH: number;
    safeScale: number;
    tol: number;
    model: LensDistortionModel | null;
    innerRadiusPx: number | null;
    opticalCenterX: number;
    opticalCenterY: number;
}): { matches: MatchedStar[]; expected: number; chanceVar: number } {
    const { wcs, inv, verifyCat, detected, imageW, imageH, safeScale, tol, model, innerRadiusPx, opticalCenterX, opticalCenterY } = args;
    const inRegion = (x: number, y: number): boolean =>
        innerRadiusPx == null || Math.hypot(x - opticalCenterX, y - opticalCenterY) <= innerRadiusPx;

    const cell = Math.max(32, Math.ceil(tol * 2));
    const gw = Math.max(1, Math.ceil(imageW / cell));
    const grid = new Map<number, number[]>();
    for (let i = 0; i < detected.length; i++) {
        if (!inRegion(detected[i].x, detected[i].y)) continue; // inner-region density only
        const gx = Math.floor(detected[i].x / cell);
        const gy = Math.floor(detected[i].y / cell);
        const key = gy * gw + gx;
        const b = grid.get(key);
        if (b) b.push(i); else grid.set(key, [i]);
    }

    const halfDiagDeg = footprintHalfDiagDeg(imageW, imageH, safeScale);
    const cosDec0 = Math.cos((wcs.crval[1] * Math.PI) / 180);
    const out: [number, number] = [0, 0];
    let expected = 0, chanceVar = 0;
    const matches: MatchedStar[] = [];

    for (const cat of verifyCat) {
        const dDec = Math.abs(cat.dec_degrees - wcs.crval[1]);
        if (dDec > halfDiagDeg) continue;
        let dRaH = Math.abs(cat.ra_hours - wcs.crval[0]);
        if (dRaH > 12) dRaH = 24 - dRaH;
        if (dRaH * 15 * cosDec0 > halfDiagDeg) continue;
        const u = projectUndistorted(cat, wcs, inv);
        if (!u) continue;
        let px = u.x, py = u.y;
        if (model) { model.toNative(u.x, u.y, out); px = out[0]; py = out[1]; }
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        if (px < 0 || px >= imageW || py < 0 || py >= imageH) continue;
        if (!inRegion(px, py)) continue;

        let bestIdx = -1, bestD = tol, bestDx = 0, bestDy = 0, localCount = 0;
        const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
        for (let dyc = -1; dyc <= 1; dyc++) for (let dxc = -1; dxc <= 1; dxc++) {
            const bucket = grid.get((gy + dyc) * gw + gx + dxc);
            if (!bucket) continue;
            localCount += bucket.length;
            for (const i of bucket) {
                const ddx = detected[i].x - px, ddy = detected[i].y - py;
                const d = Math.hypot(ddx, ddy);
                if (d < bestD) { bestD = d; bestIdx = i; bestDx = ddx; bestDy = ddy; }
            }
        }
        const localDensity = localCount / (9 * cell * cell);
        const lambda = localDensity * Math.PI * tol * tol;
        const pChance = 1 - Math.exp(-lambda);
        expected += pChance;
        chanceVar += pChance * (1 - pChance);
        if (bestIdx >= 0) matches.push(buildMatch(detected[bestIdx], cat, bestD * safeScale, bestDx, bestDy));
    }
    return { matches, expected, chanceVar };
}

/** Assemble the DistortionPair set for the BC fit from provisional matches. */
function buildFitPairs(wideMatches: MatchedStar[], wcs: WCSTransform, inv: number[][], cx: number, cy: number, hd: number): DistortionPair[] {
    const pairs: DistortionPair[] = [];
    for (const m of wideMatches) {
        const raH = (m.catalog as any).ra_hours as number | undefined;
        const decD = (m.catalog as any).dec_degrees as number | undefined;
        if (raH == null || decD == null) continue;
        const p = SkyTransform.gnomonicProject(raH, decD, wcs.crval[0], wcs.crval[1]);
        if (!Number.isFinite(p.xi) || !Number.isFinite(p.eta)) continue;
        const px = wcs.crpix[0] + inv[0][0] * p.xi + inv[0][1] * p.eta;
        const py = wcs.crpix[1] + inv[1][0] * p.xi + inv[1][1] * p.eta;
        const xn = (px - cx) / hd, yn = (py - cy) / hd;
        const dxn = (m.detected.x - px) / hd, dyn = (m.detected.y - py) / hd;
        if (!Number.isFinite(xn) || !Number.isFinite(yn) || !Number.isFinite(dxn) || !Number.isFinite(dyn)) continue;
        pairs.push({ xn, yn, dx: dxn, dy: dyn, ru: Math.hypot(xn, yn), w: 1 });
    }
    return pairs;
}

/**
 * Run the fit-tight-reverify tier. PURE / deterministic (no wasm/atlas/I/O).
 * `catalogStars` is the reproject source (bright subset, or the DEEP catalog for
 * variant A); `wideMatches` is the provisional fit evidence (bright, or deep). When
 * the fit declines and config.innerFrac is set, falls back to inner-region
 * pinhole-tight (variant B). The CALLER decides (SOLVER_UW_TIGHT_ACCEPT) whether an
 * `accepted` result becomes a solution.
 */
export function runUwTightReverify(args: {
    wcs: WCSTransform;
    catalogStars: StandardStar[];
    detected: DetectedStar[];
    imageW: number;
    imageH: number;
    safeScale: number;
    wideMatches: MatchedStar[];
    config: UwTightReverifyConfig;
}): UwTightReverifyResult {
    const { wcs, catalogStars, detected, imageW, imageH, safeScale, wideMatches, config } = args;

    const base = (over: Partial<UwTightReverifyResult>): UwTightReverifyResult => ({
        declined: false, declineReason: null, mode: 'declined',
        k1: 0, k2: null, fitPairs: wideMatches.length, fitUsed: 0,
        tightMatches: 0, tightUnique: 0, tightExpectedChance: 0, tightSigma: 0,
        innerFracUsed: null, accepted: false, matches: [], ...over,
    });
    const declined = (reason: string): UwTightReverifyResult => base({ declined: true, declineReason: reason, mode: 'declined' });

    const inv = invertCD(wcs);
    if (!inv) return declined('degenerate CD (non-invertible)');

    const cx = (imageW - 1) / 2;
    const cy = (imageH - 1) / 2;
    const hd = Math.hypot(cx, cy);
    if (!(hd > 0) || !Number.isFinite(hd)) return declined('degenerate image dimensions');
    const ocx = config.opticalCenterX ?? cx;
    const ocy = config.opticalCenterY ?? cy;

    // ── FIT ──
    const pairs = buildFitPairs(wideMatches, wcs, inv, cx, cy, hd);
    const fit = fitBrownConrady(pairs, [cx, cy], hd);
    const fitBad = !!fit.not_measured || !Number.isFinite(fit.k1);

    const verifyCat = buildVerifySubset(catalogStars, config.magLimit, config.verifyCatCap);

    const finalize = (mode: 'bc_tight' | 'inner_pinhole', k1: number, k2: number | null,
                      pass: { matches: MatchedStar[]; expected: number; chanceVar: number },
                      innerFracUsed: number | null): UwTightReverifyResult => {
        const tightSigma = excessSigma(pass.matches.length, pass.expected, pass.chanceVar);
        const tightUnique = new Set(pass.matches.map(catKey)).size;
        const accepted = Number.isFinite(tightSigma) && tightSigma >= config.acceptSigma && tightUnique >= config.minUnique;
        return base({
            declined: false, declineReason: null, mode,
            k1, k2, fitPairs: pairs.length, fitUsed: fitBad ? 0 : fit.n_used,
            tightMatches: pass.matches.length, tightUnique, tightExpectedChance: pass.expected,
            tightSigma, innerFracUsed, accepted, matches: pass.matches,
        });
    };

    if (fitBad) {
        // ── Variant B: inner-region pinhole-tight fallback ──
        if (config.innerFrac && config.innerFrac > 0) {
            const innerRadiusPx = config.innerFrac * hd;
            const pass = tightMatchPass({
                wcs, inv, verifyCat, detected, imageW, imageH, safeScale,
                tol: config.tightNetPx, model: null, innerRadiusPx, opticalCenterX: ocx, opticalCenterY: ocy,
            });
            return finalize('inner_pinhole', 0, null, pass, config.innerFrac);
        }
        return declined(`fit declined (${fit.not_measured ?? 'non-finite k1'})`);
    }

    // ── BC tight (full frame) ──
    const model = makeBrownConradyDistortion(fit.k1, fit.k2 ?? 0, imageW, imageH);
    const pass = tightMatchPass({
        wcs, inv, verifyCat, detected, imageW, imageH, safeScale,
        tol: config.tightNetPx, model, innerRadiusPx: null, opticalCenterX: ocx, opticalCenterY: ocy,
    });
    return finalize('bc_tight', fit.k1, fit.k2, pass, null);
}
