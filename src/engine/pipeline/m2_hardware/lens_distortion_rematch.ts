// ═══════════════════════════════════════════════════════════════════════════
// SECONDARY BC-INFORMED RE-MATCH RUNG — edge-star recovery (COORDINATE ledger)
// ═══════════════════════════════════════════════════════════════════════════
// Owner refinement (2026-07-08): the measured per-capture Brown-Conrady exists
// to RETIRE the center-only star-selection crutch. Wide-lens distortion is worst
// at the EDGES, so a native-space (undistorted-prediction) match discards edge
// stars whose true position is displaced by the lens — the sacred CR2 "55
// matched" came from exactly that central bias. This module is the SECONDARY /
// escalation rung: given a MEASURED BC, it re-projects catalog predictions
// THROUGH the distortion into native space and re-matches, RECOVERING edge stars
// that landed at their correct (distorted) catalog positions.
//
// SECONDARY, NOT PRIMARY, NOT DEAD-OFF: the primary solve path never calls this
// — it stays byte-identical. This rung is the mechanism the A/B exercises to
// MEASURE what BC-informed matching WOULD do, so the owner can decide (with
// evidence) whether to promote BC to inform the solve and re-baseline the count.
//
// INTEGRITY (the failure mode is densifying with WRONG matches): every recovery
// carries a guard. (1) 1:1 greedy nearest assignment within the SAME tolerance
// net as the baseline — no looser gate. (2) A WRONG-BC control (coefficients
// negated) re-runs the identical pipeline: genuine radial signal recovers many
// more edge stars under the correct sign than the wrong one; chance pairing
// recovers ~equally either way. (3) The recovered edge matches' residual RMS
// under BC is reported — real recoveries land tight, false ones scatter.
//
// TWO-LEDGER LAW: pure coordinate-space point matching; no pixel resample. Reuses
// the verified forward model (makeBrownConradyDistortion.toNative).

import { makeBrownConradyDistortion } from './lens_distortion';

/** A detected source in NATIVE (distorted) pixel space. */
export interface DetPoint { x: number; y: number; }
/** A catalog star projected to UNDISTORTED (rectilinear) pixel space. */
export interface PredPoint { x: number; y: number; }

export interface EdgeRecoveryResult {
    tol_px: number;
    edge_ru_threshold: number;
    n_detected: number;
    n_catalog: number;
    /** Native-space match (no distortion model) — the center-biased baseline. */
    baseline: { matched: number; edge_matched: number; rms_px: number };
    /** BC-informed match (predictions distorted into native space by the measured BC). */
    bc: { matched: number; edge_matched: number; rms_px: number };
    /** Edge stars (ru > threshold) recovered by BC beyond the baseline. */
    edge_recovered: number;
    /** RMS (px) of the BC-recovered edge matches under the BC prediction. */
    residual_rms_recovered_px: number;
    /** WRONG-BC control (coefficients negated) — the false-match guard. */
    false_guard: {
        wrong_bc_edge_matched: number;
        /** Real edge recovery strictly exceeds the wrong-sign control. */
        passes: boolean;
    };
}

interface Assignment { matched: number; edgeMatched: number; sumSq: number; edgeSumSq: number; edgeIdx: Set<number>; }

/**
 * Greedy 1:1 nearest assignment of catalog predictions (already in native space)
 * to detected sources within `tolPx`. Returns match counts + residual sums,
 * split by whether the catalog star is at edge radius (ru > threshold).
 */
function assignNearest(
    predNative: { x: number; y: number; ru: number }[],
    detected: DetPoint[],
    tolPx: number,
    edgeRu: number,
): Assignment {
    // Candidate (catIdx, detIdx, dist²) pairs within tol, ascending — greedy.
    const cands: { ci: number; di: number; d2: number }[] = [];
    const tol2 = tolPx * tolPx;
    for (let ci = 0; ci < predNative.length; ci++) {
        const p = predNative[ci];
        for (let di = 0; di < detected.length; di++) {
            const dx = detected[di].x - p.x, dy = detected[di].y - p.y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= tol2) cands.push({ ci, di, d2 });
        }
    }
    cands.sort((a, b) => a.d2 - b.d2);
    const catUsed = new Uint8Array(predNative.length);
    const detUsed = new Uint8Array(detected.length);
    let matched = 0, edgeMatched = 0, sumSq = 0, edgeSumSq = 0;
    const edgeIdx = new Set<number>();
    for (const c of cands) {
        if (catUsed[c.ci] || detUsed[c.di]) continue;
        catUsed[c.ci] = 1; detUsed[c.di] = 1;
        matched++; sumSq += c.d2;
        if (predNative[c.ci].ru > edgeRu) { edgeMatched++; edgeSumSq += c.d2; edgeIdx.add(c.ci); }
    }
    return { matched, edgeMatched, sumSq, edgeSumSq, edgeIdx };
}

/** Distort undistorted predictions into native space with (k1,k2) over w×h. */
function distortPredictions(
    predUndistorted: PredPoint[],
    k1: number, k2: number, w: number, h: number,
): { x: number; y: number; ru: number }[] {
    const model = makeBrownConradyDistortion(k1, k2, w, h);
    const hd = model.halfDiagPx;
    const out: [number, number] = [0, 0];
    return predUndistorted.map((p) => {
        model.toNative(p.x, p.y, out);
        const ru = Math.hypot((p.x - model.cx) / hd, (p.y - model.cy) / hd);
        return { x: out[0], y: out[1], ru };
    });
}

/**
 * Measure edge-star recovery under a MEASURED Brown-Conrady, integrity-guarded.
 * PURE (no wasm/atlas): the caller projects the catalog to undistorted pixel
 * space (via the WCS) and supplies the native detected set + the measured
 * (k1,k2). This is the SECONDARY rung — never on the primary solve path.
 *
 * @param edgeRuThreshold normalized radius above which a star counts as "edge".
 */
export function measureEdgeRecovery(
    detected: DetPoint[],
    predUndistorted: PredPoint[],
    k1: number,
    k2: number,
    w: number,
    h: number,
    tolPx: number,
    edgeRuThreshold = 0.6,
): EdgeRecoveryResult {
    const cx = (w - 1) / 2, cy = (h - 1) / 2, hd = Math.hypot(cx, cy);
    const withRu = predUndistorted.map((p) => ({ x: p.x, y: p.y, ru: Math.hypot((p.x - cx) / hd, (p.y - cy) / hd) }));

    // Baseline: predictions taken as-is (native == undistorted; no lens model).
    const base = assignNearest(withRu, detected, tolPx, edgeRuThreshold);
    // BC-informed: predictions distorted into native space by the measured BC.
    const bcPred = distortPredictions(predUndistorted, k1, k2, w, h);
    const bc = assignNearest(bcPred, detected, tolPx, edgeRuThreshold);
    // Wrong-BC control (negated sign) — the false-match guard.
    const wrongPred = distortPredictions(predUndistorted, -k1, -k2, w, h);
    const wrong = assignNearest(wrongPred, detected, tolPx, edgeRuThreshold);

    const edgeRecovered = bc.edgeMatched - base.edgeMatched;
    const rms = (sq: number, n: number) => (n > 0 ? Math.sqrt(sq / n) : 0);

    return {
        tol_px: tolPx,
        edge_ru_threshold: edgeRuThreshold,
        n_detected: detected.length,
        n_catalog: predUndistorted.length,
        baseline: { matched: base.matched, edge_matched: base.edgeMatched, rms_px: +rms(base.sumSq, base.matched).toFixed(3) },
        bc: { matched: bc.matched, edge_matched: bc.edgeMatched, rms_px: +rms(bc.sumSq, bc.matched).toFixed(3) },
        edge_recovered: edgeRecovered,
        residual_rms_recovered_px: +rms(bc.edgeSumSq, bc.edgeMatched).toFixed(3),
        false_guard: {
            wrong_bc_edge_matched: wrong.edgeMatched,
            passes: bc.edgeMatched > wrong.edgeMatched && edgeRecovered > 0,
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIMARY TWO-PASS REMATCH CORE (COORDINATE ledger) — full-solver densification
// ═══════════════════════════════════════════════════════════════════════════
// Owner ruling (2026-07-08): measured Brown-Conrady application is PROMOTED to
// PRIMARY-by-default. `measureEdgeRecovery` above is the OBSERVATION-only A/B
// probe (counts under a fixed net on curated centroids). The functions below
// are the LIVE rail: they run the BC-informed match against the REAL full
// detection set (junk included), emit the actual recovered assignments (with
// catalog identity) so the caller can densify `matched_stars`, and expose the
// pure decision math (post-SIP residual, comparative envelope, never-worse) the
// caller uses AFTER re-running the downstream SIP refinement on the densified
// set. TWO-LEDGER LAW: pure coordinate-space point work + polynomial evaluation;
// no pixel is ever resampled. Photometry + catalog I/O + the SIP refit stay in
// the caller (engine seam) — this module holds only the deterministic geometry.

/** A catalog prediction carrying identity, in UNDISTORTED (rectilinear) px. */
export interface IdentifiedPred {
    x: number;
    y: number;
    gaia_id: string;
    ra_hours: number;
    dec_degrees: number;
    mag: number | null;
}

/** A catalog star the BC-informed match paired to a detection that is NOT in
 *  the original solver-matched set — a densification candidate (pre-cull). */
export interface RecoveredMatch {
    gaia_id: string;
    ra_hours: number;
    dec_degrees: number;
    mag: number | null;
    /** Matched detection position (native/WCS pixel grid). */
    detX: number;
    detY: number;
    fwhm?: number;
    /** Rectilinear (undistorted, linear-WCS) predicted pixel — for SIP refit/residual. */
    predXUndist: number;
    predYUndist: number;
    /** Normalized undistorted radius (edge classification). */
    ru: number;
    /** BC-native-prediction → detection separation (px). */
    matchDistPx: number;
}

export interface BcRematchAssignment {
    n_detected: number;
    n_catalog: number;
    tol_px: number;
    edge_ru_threshold: number;
    baseline_matched: number;
    bc_matched: number;
    wrong_matched: number;
    edge_baseline: number;
    edge_bc: number;
    edge_recovered: number;
    /** Genuine radial signal recovers more edge stars under the correct sign
     *  than the negated-sign control (chance recovers ~equally). */
    false_guard_passes: boolean;
    /** FINDING 1 (2026-07-22): BC-matched candidates dropped because their
     *  DETECTION coincides (within the pairing net) with an already-matched
     *  detection — the double-count the gaia_id exclusion alone misses on the
     *  greenfield arm (bare row-index ids ≠ the catalog's prefixed ids). */
    coord_deduped: number;
    /** BC-matched catalog stars whose gaia_id is NOT already in the solution
     *  AND whose detection does not coincide with an already-matched one. */
    recovered: RecoveredMatch[];
}

/**
 * Coarse spatial-hash coincidence test over a small point set (FINDING 1 dedupe).
 * Cell = `tol`, so a query scans only the 3×3 neighbourhood; the returned
 * `hasNear(x,y)` is true iff any stored point lies within `tol` of (x,y).
 * Pure/deterministic.
 */
function makeCoincidence(points: DetPoint[], tol: number): (x: number, y: number) => boolean {
    const cell = Math.max(tol, 1e-6);
    const grid = new Map<string, DetPoint[]>();
    const key = (ix: number, iy: number) => ix + ',' + iy;
    for (const p of points) {
        const ix = Math.floor(p.x / cell), iy = Math.floor(p.y / cell);
        const k = key(ix, iy);
        const b = grid.get(k); if (b) b.push(p); else grid.set(k, [p]);
    }
    const tol2 = tol * tol;
    return (x: number, y: number) => {
        const ix = Math.floor(x / cell), iy = Math.floor(y / cell);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const b = grid.get(key(ix + dx, iy + dy));
                if (!b) continue;
                for (const p of b) {
                    const ddx = p.x - x, ddy = p.y - y;
                    if (ddx * ddx + ddy * ddy <= tol2) return true;
                }
            }
        }
        return false;
    };
}

/** Greedy 1:1 nearest assignment of predictions to detections within `tolPx`,
 *  ascending by distance (the SAME net + rule as `assignNearest`). Returns the
 *  surviving (catalog-idx, detection-idx, dist²) pairs. */
function greedyPairs(
    pred: { x: number; y: number }[],
    det: DetPoint[],
    tolPx: number,
): { ci: number; di: number; d2: number }[] {
    const cands: { ci: number; di: number; d2: number }[] = [];
    const tol2 = tolPx * tolPx;
    for (let ci = 0; ci < pred.length; ci++) {
        const p = pred[ci];
        for (let di = 0; di < det.length; di++) {
            const dx = det[di].x - p.x, dy = det[di].y - p.y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= tol2) cands.push({ ci, di, d2 });
        }
    }
    cands.sort((a, b) => a.d2 - b.d2);
    const catUsed = new Uint8Array(pred.length);
    const detUsed = new Uint8Array(det.length);
    const out: { ci: number; di: number; d2: number }[] = [];
    for (const c of cands) {
        if (catUsed[c.ci] || detUsed[c.di]) continue;
        catUsed[c.ci] = 1; detUsed[c.di] = 1;
        out.push(c);
    }
    return out;
}

/**
 * BC-informed rematch against the REAL full detection set. Distorts the
 * rectilinear catalog predictions into native space by the MEASURED (k1,k2),
 * greedy-matches them to detections within the SAME net, and returns the
 * assignments the baseline (rectilinear, no lens model) missed — split out as
 * `recovered` (BC-matched catalog stars not already in `originalMatchedGaia`).
 * A negated-sign control provides the false-match guard. Pure/deterministic.
 */
export function bcInformedRematch(args: {
    detections: DetPoint[];
    /** Optional detection FWHM, index-aligned to `detections`. */
    detFwhm?: (number | undefined)[];
    /** Rectilinear (undistorted, linear-WCS) catalog predictions with identity. */
    predictions: IdentifiedPred[];
    k1: number;
    k2: number;
    w: number;
    h: number;
    tolPx: number;
    /** gaia_ids already present in the solution's matched_stars. */
    originalMatchedGaia: Set<string>;
    /** FINDING 1: detection positions (native/WCS px) of the already-matched
     *  stars. A recovered candidate whose detection coincides with one of these
     *  (within `tolPx`) is the SAME detection re-entering and is dropped — the
     *  namespace-agnostic dedupe that defends the greenfield arm where the
     *  gaia_id exclusion is a structural no-op. Omit/empty ⇒ no coordinate
     *  dedupe (legacy behaviour, ID exclusion only). */
    matchedDetections?: DetPoint[];
    edgeRuThreshold?: number;
}): BcRematchAssignment {
    const { detections, predictions, k1, k2, w, h, tolPx } = args;
    const edgeRu = args.edgeRuThreshold ?? 0.6;
    const matchedDet = args.matchedDetections ?? [];
    const coincidesWithMatched = matchedDet.length ? makeCoincidence(matchedDet, tolPx) : null;

    // BC-distort predictions into native (measured sign) + wrong-sign control.
    const bcNative = distortPredictions(predictions, k1, k2, w, h);
    const wrongNative = distortPredictions(predictions, -k1, -k2, w, h);
    const ru = bcNative.map((p) => p.ru); // undistorted radius (index-aligned)

    // Greedy 1:1 within the SAME net for all three hypotheses.
    const basePairs = greedyPairs(predictions, detections, tolPx); // rectilinear
    const bcPairs = greedyPairs(bcNative, detections, tolPx);
    const wrongPairs = greedyPairs(wrongNative, detections, tolPx);

    const edgeCount = (pairs: { ci: number }[]) =>
        pairs.reduce((n, p) => n + (ru[p.ci] > edgeRu ? 1 : 0), 0);
    const edgeBaseline = edgeCount(basePairs);
    const edgeBc = edgeCount(bcPairs);
    const edgeWrong = edgeCount(wrongPairs);

    const recovered: RecoveredMatch[] = [];
    let coordDeduped = 0;
    for (const pr of bcPairs) {
        const cat = predictions[pr.ci];
        // (1) legacy ID exclusion (belt+suspenders — still protects the browser
        //     lane where matched_stars carry the catalog's prefixed ids).
        if (args.originalMatchedGaia.has(cat.gaia_id)) continue; // already in solution
        const det = detections[pr.di];
        // (2) FINDING 1 coordinate dedupe: a recovered candidate whose detection
        //     lands within the SAME pairing net (tolPx) of an already-matched
        //     detection IS that detection re-entering (central displacement ≈ 0
        //     for a star already in the solution). Drop it. Namespace-agnostic —
        //     this, not the ID set above, is what stops the greenfield-arm
        //     double-count (bare row-index ids ≠ prefixed catalog ids).
        if (coincidesWithMatched && coincidesWithMatched(det.x, det.y)) { coordDeduped++; continue; }
        recovered.push({
            gaia_id: cat.gaia_id, ra_hours: cat.ra_hours, dec_degrees: cat.dec_degrees, mag: cat.mag,
            detX: det.x, detY: det.y, fwhm: args.detFwhm?.[pr.di],
            predXUndist: cat.x, predYUndist: cat.y,
            ru: ru[pr.ci], matchDistPx: Math.sqrt(pr.d2),
        });
    }

    const edgeRecovered = edgeBc - edgeBaseline;
    return {
        n_detected: detections.length,
        n_catalog: predictions.length,
        tol_px: tolPx,
        edge_ru_threshold: edgeRu,
        baseline_matched: basePairs.length,
        bc_matched: bcPairs.length,
        wrong_matched: wrongPairs.length,
        edge_baseline: edgeBaseline,
        edge_bc: edgeBc,
        edge_recovered: edgeRecovered,
        false_guard_passes: edgeBc > edgeWrong && edgeRecovered > 0,
        coord_deduped: coordDeduped,
        recovered,
    };
}

// ─── post-chain residual + guards (pure; consumed AFTER the SIP refit) ────────

/**
 * Evaluate a SIP polynomial matrix at (u,v): Σ mat[p][q]·u^p·v^q. Mirrors the
 * term convention of ResidualAnalyzer.performSIPFit (single source of the fit;
 * this is a read-only evaluator of its output). Returns 0 for an absent matrix.
 */
export function evalSipPoly(mat: number[][] | undefined | null, u: number, v: number): number {
    if (!mat) return 0;
    let s = 0;
    for (let p = 0; p < mat.length; p++) {
        const row = mat[p];
        if (!row) continue;
        for (let q = 0; q < row.length; q++) {
            const c = row[q];
            if (c) s += c * Math.pow(u, p) * Math.pow(v, q);
        }
    }
    return s;
}

/**
 * Residual magnitude (px) of a matched star AFTER the full chain: linear-WCS
 * displacement (detected − rectilinear-predicted) minus the fitted SIP
 * correction A/B(u,v), u/v measured about crpix (the exact convention M7 fits
 * against). With no SIP this is the plain linear residual. Pure.
 */
export function postSipResidualPx(
    detX: number, detY: number, linPredX: number, linPredY: number,
    sip: { a: number[][]; b: number[][] } | undefined | null,
    crpix: [number, number],
): number {
    const rx = detX - linPredX;
    const ry = detY - linPredY;
    if (!sip) return Math.hypot(rx, ry);
    const u = detX - crpix[0], v = detY - crpix[1];
    return Math.hypot(rx - evalSipPoly(sip.a, u, v), ry - evalSipPoly(sip.b, u, v));
}

/**
 * NEVER-WORSE structural verdict (NOT a calibrated gate — purely comparative
 * before-vs-after). APPLIED only if the densified+culled set has STRICTLY more
 * matches AND a post-chain RMS no worse than the original; otherwise the caller
 * keeps the original solution untouched. Inventing no thresholds is the point.
 */
export function neverWorseVerdict(
    before: { matched: number; rmsArcsec: number },
    after: { matched: number; rmsArcsec: number },
): 'APPLIED' | 'KEPT_ORIGINAL' {
    const strictlyMoreMatches = after.matched > before.matched;
    const notWorseRms = after.rmsArcsec <= before.rmsArcsec + 1e-9;
    return strictlyMoreMatches && notWorseRms ? 'APPLIED' : 'KEPT_ORIGINAL';
}

/**
 * ONE-RULE-FOR-ALL classification of a recovered star AFTER the final-chain
 * refit (owner amendment). A recovered star survives iff its post-SIP residual
 * lands within the SAME acceptance envelope the originals cleared AND (when a
 * native buffer is present) forced photometry confirms flux exists at the
 * predicted position. No new sigma/radius — the envelope is the frame's own
 * accepted residual; the flux gate is the existing deep-verify threshold. When
 * photometry could not be measured (headless / binned grid) the residual-
 * envelope survivor is kept, honestly (existence NOT_MEASURED, never a fabricated
 * pass). Pure.
 */
export function judgeRecovered(
    residualArcsec: number,
    envelopeArcsec: number,
    photometry: { measured: boolean; accepted: boolean },
): { kept: boolean; reject_reason: 'RESIDUAL_ENVELOPE' | 'NO_FLUX' | null } {
    if (residualArcsec > envelopeArcsec) return { kept: false, reject_reason: 'RESIDUAL_ENVELOPE' };
    if (photometry.measured && !photometry.accepted) return { kept: false, reject_reason: 'NO_FLUX' };
    return { kept: true, reject_reason: null };
}
