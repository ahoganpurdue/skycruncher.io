// ═══════════════════════════════════════════════════════════════════════════
// PRIMARY TWO-PASS BC REMATCH — engine seam (COORDINATE ledger)
// ═══════════════════════════════════════════════════════════════════════════
// Owner ruling (2026-07-08): measured Brown-Conrady application is PROMOTED to
// PRIMARY-by-default. This is the LIVE rail that consumes the always-recorded
// measured BC (m2_hardware/lens_distortion_refit) and — when the fit passed its
// coverage gates — densifies the solved match set with edge stars the
// center-biased rectilinear match discarded.
//
// FLOW (owner amendment, end-of-chain / one-rule-for-all):
//   1. MATCH   — BC-distort the REAL full detection set's catalog predictions
//                into native space, greedy-match against ALL detections (junk
//                included) within a frame-measured net → recovered edge stars.
//   2. REFIT   — RE-RUN the existing downstream refinement (applyAstrometricRefinement
//                → SIP) on the DENSIFIED matched set so recovered stars are
//                corrected by the full chain BEFORE any judgment (the M7 refit
//                already ran once on the original set in step5; this is the
//                second pass on the densified set — the single "iterate once").
//   3. CULL    — ONE RULE FOR ALL: after the final-chain refit, keep a recovered
//                star only if its post-SIP residual lands within the SAME
//                acceptance envelope the originally-matched stars already cleared
//                (the frame's own max accepted residual). No new sigma/radius:
//                junk incoherent with the smooth fitted field does not collapse
//                under the regularized fit and falls out; real edge stars survive.
//   4. FINAL   — forced-photometry EXISTENCE check at the final-chain predicted
//                positions (existing deep_verify thresholds, unchanged): is there
//                flux there at all? Recovered stars with none are dropped.
//   5. GUARD   — NEVER-WORSE (structural, comparative): apply the densified
//                solution only if it has STRICTLY more matches AND a post-chain
//                RMS no worse than the original; else keep the original untouched.
//
// TWO-LEDGER LAW: pure coordinate-space point work; the science buffer is READ
// for forced photometry (existence only) but never resampled. On KEPT_ORIGINAL
// the solution is byte-identical (nothing mutated) — the sacred narrow-FITS
// solve stays bit-identical because a well-corrected narrow field recovers
// nothing and keeps the original.
//
// NET HONESTY (flagged for orchestrator review): the greedy match net is
// FRAME-MEASURED — max(largest original accepted residual, frame median FWHM) —
// NOT the solver's literal 15 px base net / 0.035 ultra-wide slope. Those live
// welded inside solver_entry.verifyWCS; reusing them here would DUPLICATE a
// calibrated constant. The frame-measured net is comparative (no new constant)
// and correct for BC-corrected predictions: once BC displaces the prediction to
// its detection, a true edge star lands within the same envelope as a central
// star. See the surgeon handoff.

import type { PlateSolution, MatchedStar, WCSTransform, DetectedStar } from '../../types/Main_types';
import { StarCatalogAdapter } from '../m6_plate_solve/star_catalog_adapter';
import { projectCatalogToPixels, runForcedPhotometry } from '../m6_plate_solve/deep_verify';
import { ResidualAnalyzer } from '../m7_astrometry/residual_analyzer';
import { applyAstrometricRefinement } from '../stages/calibrate';
import { PIPELINE_CONSTANTS as PC } from '../constants/pipeline_config';
import { TimeService } from '../../core/TimeService';
import type { MeasuredDistortion } from './lens_distortion_refit';
import {
    bcInformedRematch, neverWorseVerdict, postSipResidualPx, evalSipPoly, judgeRecovered,
    type IdentifiedPred,
} from './lens_distortion_rematch';

/** Per-recovered-star final-chain outcome (honest record; plain scalars only). */
export interface BcRematchStarOutcome {
    gaia_id: string;
    ra_hours: number;
    dec_degrees: number;
    mag: number | null;
    x: number;
    y: number;
    final_residual_arcsec: number;
    kept: boolean;
    reject_reason: 'RESIDUAL_ENVELOPE' | 'NO_FLUX' | null;
    snr: number | null;
}

/** Additive receipt block (plain arrays/scalars — save_packet replacer safe). */
export interface BcRematchReceipt {
    attempted: boolean;
    applied: boolean;
    guard: 'APPLIED' | 'KEPT_ORIGINAL';
    /** WHERE in the cascade the judgment happened (owner amendment #5). */
    chain_stage: 'FINAL';
    matched_before: number;
    matched_after: number;
    edge_before: number;
    edge_after: number;
    rms_before_arcsec: number | null;
    rms_after_arcsec: number | null;
    recovered_confirmed: number;
    recovered_rejected: number;
    /** Genuine radial signal recovers more edge stars under the correct sign
     *  than the negated-sign control (chance recovers ~equally). */
    false_guard_passes: boolean;
    /** Net used for the greedy rematch (frame-measured px — see header). */
    net_px: number;
    /** Photometric existence check basis (honest-or-absent). */
    photometry: 'NATIVE_FLOAT_LUMINANCE' | 'NOT_MEASURED';
    recovered_stars: BcRematchStarOutcome[];
    not_measured?: string;
}

const EDGE_RU = 0.6;

function edgeCountOf(stars: { x: number; y: number }[], cx: number, cy: number, hd: number): number {
    let n = 0;
    for (const s of stars) if (Math.hypot((s.x - cx) / hd, (s.y - cy) / hd) > EDGE_RU) n++;
    return n;
}

/** post-SIP RMS (arcsec) over a matched set under a given SIP (or linear if none). */
function postSipRmsArcsec(
    stars: MatchedStar[], wcs: WCSTransform, sip: { a: number[][]; b: number[][] } | undefined | null,
    crpix: [number, number], pixelScale: number,
): number | null {
    let ss = 0, n = 0;
    for (const m of stars) {
        const lp = ResidualAnalyzer.skyToLinearPixel(m.catalog.ra, m.catalog.dec, wcs);
        const rPx = postSipResidualPx(m.detected.x, m.detected.y, lp.x, lp.y, sip, crpix);
        const a = rPx * pixelScale;
        ss += a * a; n++;
    }
    return n > 0 ? Math.sqrt(ss / n) : null;
}

/**
 * Run the primary two-pass BC rematch. MUTATES `solution` in place ONLY on
 * APPLIED (densified matched_stars + refit astrometry + num_stars; the linear
 * WCS and confidence are the primary solve's and are left untouched — BC/SIP
 * are the correct absorbers of edge displacement, not the linear term). Returns
 * the receipt block for the caller to attach. Async (catalog paging). Fail-soft.
 */
export async function runBcRematchPass(args: {
    solution: PlateSolution;
    bcMeasured: MeasuredDistortion | null;
    /** Full detection set (clean + anomalies), native/WCS pixel grid. */
    detections: { x: number; y: number; fwhm?: number }[];
    /** Native Float32 science luminance (existence check); null → NOT_MEASURED. */
    scienceBuffer: Float32Array | null;
    imageWidth: number;
    imageHeight: number;
    timestamp?: string | number | Date;
    log?: (m: string) => void;
}): Promise<BcRematchReceipt> {
    const { solution, bcMeasured, detections, imageWidth: W, imageHeight: H } = args;
    const log = args.log ?? (() => {});

    const originalMatched = (solution.matched_stars ?? []).filter(m =>
        Number.isFinite(m.residual_arcsec) && m.residual_arcsec < 999 &&
        !(m.catalog?.gaia_id || '').startsWith('planet_') &&
        Number.isFinite(m.detected?.x) && Number.isFinite(m.detected?.y),
    );
    const matchedBefore = originalMatched.length;

    const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
    const edgeBefore = edgeCountOf(originalMatched.map(m => m.detected), cx, cy, hd);

    const notMeasured = (reason: string): BcRematchReceipt => ({
        attempted: false, applied: false, guard: 'KEPT_ORIGINAL', chain_stage: 'FINAL',
        matched_before: matchedBefore, matched_after: matchedBefore,
        edge_before: edgeBefore, edge_after: edgeBefore,
        rms_before_arcsec: null, rms_after_arcsec: null,
        recovered_confirmed: 0, recovered_rejected: 0, false_guard_passes: false,
        net_px: 0, photometry: 'NOT_MEASURED', recovered_stars: [], not_measured: reason,
    });

    const wcs = solution.wcs as WCSTransform | undefined;
    if (!wcs?.crpix || !wcs?.crval || !wcs?.cd) return notMeasured('no usable WCS');
    if (!bcMeasured || bcMeasured.not_measured || !Number.isFinite(bcMeasured.k1)) {
        return notMeasured(`measured BC refused at its coverage gate (${bcMeasured?.not_measured ?? 'no fit'}) — rematch not attempted`);
    }
    if (!(Math.abs(bcMeasured.k1) > 0) && !(Math.abs(bcMeasured.k2 ?? 0) > 0)) {
        return notMeasured('measured BC coefficients are exactly zero — nothing to rematch (no-op)');
    }
    // ResidualAnalyzer needs a reasonable base to fit SIP; too few → skip honestly.
    if (matchedBefore < 15) return notMeasured(`too few original matches (${matchedBefore} < 15) for a densifying refit`);
    const crpix = wcs.crpix;
    const pixelScale = solution.pixel_scale;
    const k1 = bcMeasured.k1, k2 = bcMeasured.k2 ?? 0;

    // ── catalog fetch for the solved field ───────────────────────────────────
    const jd = TimeService.toJulianDate(args.timestamp ? new Date(args.timestamp) : new Date());
    const fovR = Math.max(solution.fov_width_deg || 0, solution.fov_height_deg || 0) / 2 * 1.2;
    if (!(fovR > 0)) return notMeasured('non-finite field radius');
    const adapter = StarCatalogAdapter.getinstance();
    // ── FINDING 5 (2026-07-22): full-cone catalog on ultra-wide frames ────────
    // This stage's entire purpose is recovering EDGE stars on wide/distorted
    // rigs — the exact rigs whose FOV trips the SECTOR_LOAD_MAX_RADIUS_DEG (16°)
    // paging cap, so the legacy `ensureSectorLoaded`-then-`findStarsInField`
    // path reads only whatever ≤16° patches happen to be RESIDENT and the
    // "full detection set vs catalog" premise (header) is unmet on a UW frame
    // (bundled CR2: fovR ≈ 50°+). Mirror the confirm lane's source selection
    // (solver_entry.fetchDeepCatalogRows): route through the flag-gated g15u
    // Gaia-only cone (queryDeepCatalogG15u) which retires the paging cap, and
    // mirror its brightest-first cap. When g15u is DISABLED (browser cold path /
    // opt-out via VITE_CATALOG_G15U=false) or ABSENT/failed (returns null), fall
    // through to the EXACT legacy resident-patch path — byte-identical cold path
    // (owner never-delete ruling). Rows carry {ra_hours, dec_degrees,
    // magnitude_V, gaia_id} either way (StandardStar ⊇ DeepCatalogRow subset).
    type CatRow = { ra_hours: number; dec_degrees: number; magnitude_V: number; gaia_id: string };
    let rows: CatRow[] | null = null;
    if (StarCatalogAdapter.isG15uCatalogSourceEnabled()) {
        const g15u = await adapter.queryDeepCatalogG15u(
            solution.ra_hours, solution.dec_degrees, fovR, PC.SOLVER_DEEP_HARVEST_MAG_MAX,
        );
        // g15u rows are already ≤ magLimit + mag-sorted (brightest first) at the
        // g15u boundary; cap brightest-first to mirror the pass's own cap below.
        if (g15u) rows = g15u.slice(0, PC.SOLVER_DEEP_HARVEST_MAX_POSITIONS);
    }
    if (rows == null) {
        if (fovR <= PC.SECTOR_LOAD_MAX_RADIUS_DEG) {
            await adapter.ensureSectorLoaded(solution.ra_hours, solution.dec_degrees, fovR);
        }
        rows = (await adapter.findStarsInField(solution.ra_hours, solution.dec_degrees, fovR, jd))
            .filter(s => (s.magnitude_V ?? 99) <= PC.SOLVER_DEEP_HARVEST_MAG_MAX)
            .sort((a, b) => (a.magnitude_V ?? 99) - (b.magnitude_V ?? 99))
            .slice(0, PC.SOLVER_DEEP_HARVEST_MAX_POSITIONS);
    }

    // Rectilinear (undistorted, linear-WCS) predictions carrying identity.
    const predictions: IdentifiedPred[] = [];
    const margin = 4;
    for (const s of rows) {
        const p = ResidualAnalyzer.skyToLinearPixel(s.ra_hours * 15, s.dec_degrees, wcs);
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        if (p.x < margin || p.y < margin || p.x >= W - margin || p.y >= H - margin) continue;
        predictions.push({ x: p.x, y: p.y, gaia_id: s.gaia_id, ra_hours: s.ra_hours, dec_degrees: s.dec_degrees, mag: s.magnitude_V ?? null });
    }
    if (predictions.length === 0) return notMeasured('no in-frame catalog predictions');

    // ── frame-measured net (see header) ──────────────────────────────────────
    const fwhms = detections.map(d => d.fwhm).filter((f): f is number => Number.isFinite(f as number) && (f as number) > 0).sort((a, b) => a - b);
    const medianFwhm = fwhms.length ? fwhms[fwhms.length >> 1] : 2.5;
    const maxOrigResidualPx = originalMatched.reduce((mx, m) => Math.max(mx, (m.residual_arcsec || 0) / Math.max(1e-9, pixelScale)), 0);
    const tolPx = Math.max(maxOrigResidualPx, medianFwhm);

    // ── PASS 1: BC-informed match against the full detection set ──────────────
    // FINDING 1: pass BOTH the already-matched gaia_ids (legacy ID exclusion —
    // browser lane) AND their DETECTION positions (namespace-agnostic coordinate
    // dedupe — the greenfield arm, where matched_stars carry bare row-index ids
    // disjoint from the catalog's `Gaia_`/`HYG_` ids so the ID set never fires).
    // A recovered candidate whose detection lands within the same pairing net
    // (tolPx) of a matched detection is that detection re-entering → dropped,
    // so `matched_stars`, num_stars, the per-star receipt rows, and the SIP
    // weighting can no longer double-count, and recovered_confirmed/rejected
    // stay honest small counts (the receipt-phantom sub-finding).
    const originalGaia = new Set(originalMatched.map(m => m.catalog?.gaia_id || '').filter(Boolean));
    const matchedDetections = originalMatched.map(m => ({ x: m.detected.x, y: m.detected.y }));
    const assign = bcInformedRematch({
        detections, detFwhm: detections.map(d => d.fwhm),
        predictions, k1, k2, w: W, h: H, tolPx,
        originalMatchedGaia: originalGaia, matchedDetections, edgeRuThreshold: EDGE_RU,
    });
    if (assign.coord_deduped > 0) {
        log(`[BC-rematch] coordinate dedupe dropped ${assign.coord_deduped} candidate(s) whose detection re-entered an already-matched position (FINDING 1; net ${tolPx.toFixed(1)}px).`);
    }

    if (assign.recovered.length === 0) {
        log(`[BC-rematch] no edge stars beyond the original ${matchedBefore} matches (net ${tolPx.toFixed(1)}px) — KEPT_ORIGINAL.`);
        return {
            attempted: true, applied: false, guard: 'KEPT_ORIGINAL', chain_stage: 'FINAL',
            matched_before: matchedBefore, matched_after: matchedBefore,
            edge_before: edgeBefore, edge_after: edgeBefore,
            rms_before_arcsec: postSipRmsArcsec(originalMatched, wcs, solution.astrometry?.sip, crpix, pixelScale),
            rms_after_arcsec: postSipRmsArcsec(originalMatched, wcs, solution.astrometry?.sip, crpix, pixelScale),
            recovered_confirmed: 0, recovered_rejected: 0,
            false_guard_passes: assign.false_guard_passes,
            net_px: +tolPx.toFixed(2), photometry: 'NOT_MEASURED', recovered_stars: [],
        };
    }

    // Recovered candidates → MatchedStar entries (linear residual for the refit).
    const recoveredMatches: MatchedStar[] = assign.recovered.map(r => {
        const detected: DetectedStar = { x: r.detX, y: r.detY, rawX: r.detX, rawY: r.detY, flux: 0, fwhm: r.fwhm ?? 0 };
        return {
            detected,
            catalog: { ra: r.ra_hours * 15, dec: r.dec_degrees, mag: r.mag ?? 0, ra_hours: r.ra_hours, dec_degrees: r.dec_degrees, gaia_id: r.gaia_id, magnitude_V: r.mag ?? undefined },
            residual_arcsec: r.matchDistPx * pixelScale,
        };
    });

    // ── PASS 2: RE-RUN downstream refinement (SIP) on the densified set ───────
    const densified = [...originalMatched, ...recoveredMatches];
    const candidate: PlateSolution = { ...solution, matched_stars: densified, astrometry: undefined };
    applyAstrometricRefinement(candidate); // fits candidate.astrometry.sip on the densified set
    const sipCand = candidate.astrometry?.sip;

    // ── CULL: one rule for all — recovered stars vs the originals' envelope ───
    let envelope = 0;
    for (const m of originalMatched) {
        const lp = ResidualAnalyzer.skyToLinearPixel(m.catalog.ra, m.catalog.dec, wcs);
        const a = postSipResidualPx(m.detected.x, m.detected.y, lp.x, lp.y, sipCand, crpix) * pixelScale;
        if (a > envelope) envelope = a;
    }

    // Per-recovered final-chain residual + catalog-forced predicted position
    // (linear prediction + fitted SIP correction at that prediction).
    const recInfo = assign.recovered.map((r, i) => {
        const lp = ResidualAnalyzer.skyToLinearPixel(r.ra_hours * 15, r.dec_degrees, wcs);
        const resArcsec = postSipResidualPx(r.detX, r.detY, lp.x, lp.y, sipCand, crpix) * pixelScale;
        const u = lp.x - crpix[0], v = lp.y - crpix[1];
        const predX = lp.x + (sipCand ? evalSipPoly(sipCand.a, u, v) : 0);
        const predY = lp.y + (sipCand ? evalSipPoly(sipCand.b, u, v) : 0);
        return { rec: r, ms: recoveredMatches[i], resArcsec, predX, predY };
    });

    // ── FINAL: forced-photometry existence check at the predicted positions ───
    // Runs only on the residual-envelope survivors (apertures land within the
    // corrected residual scale). NOT_MEASURED when no coherent native buffer.
    const sb = args.scienceBuffer;
    const survivors = recInfo.filter(x => x.resArcsec <= envelope);
    const gridMatches = !!sb && sb.length === W * H && survivors.length > 0;
    let photometry: BcRematchReceipt['photometry'] = 'NOT_MEASURED';
    const bySnr = new Map<string, { snr: number; accepted: boolean }>();
    if (gridMatches) {
        photometry = 'NATIVE_FLOAT_LUMINANCE';
        const positions = survivors.map(s => ({ x: s.predX, y: s.predY, mag: s.rec.mag, gaia_id: s.rec.gaia_id }));
        const { results } = runForcedPhotometry({
            L: sb!, w: W, h: H, positions,
            detected: detections, snrThreshold: PC.SOLVER_DEEP_HARVEST_SNR_THRESHOLD,
        });
        for (const rr of results) bySnr.set(`${rr.x.toFixed(3)},${rr.y.toFixed(3)}`, { snr: rr.snr, accepted: rr.accepted });
    }

    // ── one rule for all: classify every recovered star (judgeRecovered) ──────
    const outcomes: BcRematchStarOutcome[] = [];
    const confirmedMatches: MatchedStar[] = [];
    for (const x of recInfo) {
        const withinEnv = x.resArcsec <= envelope;
        const measured = photometry === 'NATIVE_FLOAT_LUMINANCE' && withinEnv;
        const hit = measured ? bySnr.get(`${x.predX.toFixed(3)},${x.predY.toFixed(3)}`) : undefined;
        const j = judgeRecovered(x.resArcsec, envelope, { measured, accepted: !!hit?.accepted });
        outcomes.push({
            gaia_id: x.rec.gaia_id, ra_hours: x.rec.ra_hours, dec_degrees: x.rec.dec_degrees, mag: x.rec.mag,
            x: +x.rec.detX.toFixed(2), y: +x.rec.detY.toFixed(2),
            final_residual_arcsec: +x.resArcsec.toFixed(3),
            kept: j.kept, reject_reason: j.reject_reason, snr: hit ? +hit.snr.toFixed(2) : null,
        });
        if (j.kept) { x.ms.residual_arcsec = x.resArcsec; confirmedMatches.push(x.ms); }
    }

    // ── final densified set + before/after metrics ────────────────────────────
    const finalMatched = [...originalMatched, ...confirmedMatches];
    const matchedAfter = finalMatched.length;
    const edgeAfter = edgeCountOf(finalMatched.map(m => m.detected), cx, cy, hd);
    const rmsBefore = postSipRmsArcsec(originalMatched, wcs, solution.astrometry?.sip, crpix, pixelScale);
    const rmsAfter = postSipRmsArcsec(finalMatched, wcs, sipCand, crpix, pixelScale);

    // APPLIED requires BOTH specified guards (owner amendment #4): the NEVER-WORSE
    // structural guard AND the WRONG-SIGN control (genuine radial signal recovers
    // more edge stars under the correct BC sign than the negated sign; chance
    // recovers ~equally). A well-corrected narrow field (SeeStar) fails the
    // wrong-sign guard — its handful of matches are chance, indistinguishable
    // from the negated control — so it KEEPS and the sacred solve stays
    // byte-identical. Neither guard is a calibrated threshold: never-worse is
    // comparative, wrong-sign is the module's own negated-coefficient control.
    const neverWorse = neverWorseVerdict(
        { matched: matchedBefore, rmsArcsec: rmsBefore ?? Infinity },
        { matched: matchedAfter, rmsArcsec: rmsAfter ?? Infinity },
    );
    const guard: 'APPLIED' | 'KEPT_ORIGINAL' =
        (neverWorse === 'APPLIED' && assign.false_guard_passes) ? 'APPLIED' : 'KEPT_ORIGINAL';

    if (guard === 'APPLIED') {
        // Densify the solution (owner-authorized re-baseline). Keep the linear
        // WCS + confidence (BC/SIP absorb edge displacement; the primary solve's
        // confidence stands — recomputing the ultra-wide statistic needs the
        // welded verify machinery, out of scope; the densification evidence is
        // in this block, never fabricated into confidence).
        solution.matched_stars = finalMatched;
        solution.num_stars = matchedAfter;
        solution.astrometry = candidate.astrometry;
        log(`[BC-rematch] APPLIED: matched ${matchedBefore}→${matchedAfter} (edge ${edgeBefore}→${edgeAfter}), rms ${rmsBefore?.toFixed(3) ?? 'n/a'}→${rmsAfter?.toFixed(3) ?? 'n/a'}" — ${confirmedMatches.length} recovered confirmed, ${outcomes.filter(o => !o.kept).length} rejected.`);
    } else {
        log(`[BC-rematch] KEPT_ORIGINAL: candidate matched ${matchedAfter} vs ${matchedBefore}, rms ${rmsAfter?.toFixed(3) ?? 'n/a'} vs ${rmsBefore?.toFixed(3) ?? 'n/a'}" — never-worse guard held the original.`);
    }

    return {
        attempted: true,
        applied: guard === 'APPLIED',
        guard,
        chain_stage: 'FINAL',
        matched_before: matchedBefore,
        matched_after: guard === 'APPLIED' ? matchedAfter : matchedBefore,
        edge_before: edgeBefore,
        edge_after: guard === 'APPLIED' ? edgeAfter : edgeBefore,
        rms_before_arcsec: rmsBefore != null ? +rmsBefore.toFixed(4) : null,
        rms_after_arcsec: rmsAfter != null ? +rmsAfter.toFixed(4) : null,
        recovered_confirmed: confirmedMatches.length,
        recovered_rejected: outcomes.filter(o => !o.kept).length,
        false_guard_passes: assign.false_guard_passes,
        net_px: +tolPx.toFixed(2),
        photometry,
        recovered_stars: outcomes,
    };
}
