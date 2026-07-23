/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GREENFIELD RECEIPT — pure render-side reader for the greenfield solver core
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The greenfield Rust solver emits a receipt shaped `{decision, decision_digest,
 * telemetry}`. The wizard seam attaches it as `solution.greenfield_receipt`. This
 * module NORMALIZES either form (bare receipt OR seam-attached) into one flat,
 * honestly-absent-aware structure the three greenfield widgets read.
 *
 * Ledger: RENDER PLANE ONLY. Every function here is a PURE READ over an already-
 * collected receipt — it never solves, never mutates a WCS / matched set, never
 * fabricates a number. Absent fields normalize to `null` so the frame can show an
 * honest "NOT RECORDED" (LAW 3), distinct from a genuinely-measured zero.
 *
 * Detection PIXEL positions are NOT stored in the receipt (matches carry only a
 * `det_id` + residuals). The geometry layers therefore need an EXTERNAL detections
 * array (indexed by det_id — EMPIRICALLY VERIFIED: det_id → detections[det_id],
 * i.e. the raw detection array index, 126/126 consensus quad spans reproduced to
 * 0.1px on the banked CSM30799 receipt). When no detections source is attached the
 * geometry layers are honest-absent; the all-real statistics still render fully.
 *
 * No React here — pure + node-unit-testable.
 */

import { finite } from '../widget_math';
import { projectGnomonic } from './star_labels';

// ─── raw receipt shapes (only the fields we read) ───────────────────────────

/** A detection row from the external detections list (indexed by det_id). */
export interface GfDetection { x: number; y: number; flux?: number }

export interface GfMatch {
    detId: number; starRow: number;
    residualX: number | null; residualY: number | null;
    logLr: number | null; testOrder: number | null;
}

export interface GfPerBand {
    band: number;
    detQuads: number | null; probes: number | null; rawHits: number | null;
    proposals: number | null; verified: number | null; bailed: number | null;
    probeWallMs: number | null; verifyWallMs: number | null;
    /** True when this band was actually coded (nonzero det_quads); false ⇒ never coded
     *  (abort-on-accept skipped the finer bands — an honest "skipped", not a zero result). */
    coded: boolean;
}

/** One fine-consensus corroborating quad, with its honesty verdict pre-computed. */
export interface GfCorroboration {
    band: number | null;
    quadSpanPx: number | null;
    poseScaleRatio: number | null;
    poseRotDeltaDeg: number | null;
    centerOffsetArcsec: number | null;
    logOdds: number | null;
    nMatched: number | null;
    parity: number | null;
    matchedRows: { detId: number; residualX: number | null; residualY: number | null }[];
    /** Median absolute per-corner residual (px) — a junk quad has thousands. */
    medianResidualPx: number | null;
    /** SANE ⇒ safe to draw as REAL accepted geometry (small offset, scale≈1, tight
     *  residuals). Otherwise a "candidate corroboration" (drawn faint / never green). */
    sane: boolean;
}

export interface GfWcs {
    raDeg: number; decDeg: number;
    crpixX: number; crpixY: number;
    cd: [[number, number], [number, number]];
}

export interface GreenfieldReceipt {
    frameId: string | null;
    classification: string | null;
    /** Terminal state string as recorded (e.g. "Solved", "Aborted"). LOAD-BEARING contract. */
    state: string | null;
    digest: string | null;
    scaleArcsecPx: number | null;
    parity: number | null;
    wcs: GfWcs | null;
    finalVerify: {
        logOdds: number | null; finalOdds: number | null;
        nMatched: number | null; nDistractor: number | null; nConflict: number | null;
        nTest: number | null; nRef: number | null; effArea: number | null;
        besti: number | null; bestWorst: number | null; bailedAt: number | null; stoppedAt: number | null;
    } | null;
    acceptBand: number | null;
    acceptRung: number | null;
    hypothesisSeq: number | null;
    matches: GfMatch[];
    searchTruncated: boolean | null;
    prep: { raw: number | null; valid: number | null; deduped: number | null; pool: number | null; peakArmPromoted: number | null } | null;
    perBand: GfPerBand[];
    hitOrderPolicy: string | null;
    wallMs: number | null;
    stageMs: Record<string, number> | null;
    freezeEvents: { elapsedMs: number | null; outcome: string | null }[];
    abort: { onAccept: boolean | null; elapsedMs: number | null } | null;
    fineConsensus: {
        bandsTested: number[]; candidatesCoded: number | null; hits: number | null;
        wallMs: number | null; capped: boolean | null; corroborating: GfCorroboration[];
    } | null;
    index: { releaseId: string | null; totalQuads: number | null; totalStars: number | null; bandsPresent: number | null; aggregateMd5: string | null; verifyMode: string | null } | null;
    build: Record<string, unknown> | null;
    /** Frame pixel dimensions — from metadata if present, else derived from detections /
     *  crpix (marked `derived`). Honest about provenance. */
    frame: { width: number; height: number; source: 'metadata' | 'detections' | 'crpix' } | null;
    /** External detections list (by det_id), when a source was attached. */
    detections: GfDetection[] | null;
}

// ─── consensus honesty gate (display-only, principled) ──────────────────────

/** A corroborating quad is SANE (safe to render as real geometry) when its pose
 *  agrees with the accepted solution: small center offset, near-unit scale, and
 *  tight per-corner residuals. On the banked CSM30799 receipt this cleanly separates
 *  18 sane rows (scale≈1.0, offset ≤ ~1800″) from 108 junk (offset to 21M″). */
export const CONSENSUS_SANE_MAX_OFFSET_ARCSEC = 3600;   // ≤ 1°
export const CONSENSUS_SANE_SCALE_LO = 0.5;
export const CONSENSUS_SANE_SCALE_HI = 2.0;
export const CONSENSUS_SANE_MAX_RESIDUAL_PX = 100;

function consensusSane(off: number | null, scale: number | null, medRes: number | null): boolean {
    return off != null && off <= CONSENSUS_SANE_MAX_OFFSET_ARCSEC
        && scale != null && scale >= CONSENSUS_SANE_SCALE_LO && scale <= CONSENSUS_SANE_SCALE_HI
        && medRes != null && medRes <= CONSENSUS_SANE_MAX_RESIDUAL_PX;
}

function median(vals: number[]): number | null {
    if (vals.length === 0) return null;
    const s = [...vals].sort((a, b) => a - b);
    return s[s.length >> 1];
}

// ─── the normalizer ─────────────────────────────────────────────────────────

/** Pull the core `{decision, telemetry, decision_digest}` out of any accepted wrapper. */
function resolveCore(raw: any): { decision: any; telemetry: any; digest: string | null } | null {
    if (!raw || typeof raw !== 'object') return null;
    const cand = raw.greenfield_receipt ?? raw.solution?.greenfield_receipt ?? raw;
    if (!cand || typeof cand !== 'object' || !cand.decision) return null;
    return {
        decision: cand.decision,
        telemetry: cand.telemetry ?? {},
        digest: typeof cand.decision_digest === 'string' ? cand.decision_digest : null,
    };
}

/** Find an external detections array (by det_id) if the caller attached one. */
function resolveDetections(raw: any): GfDetection[] | null {
    const paths = [
        raw?.greenfield_detections,
        raw?.detections,
        raw?.greenfield_receipt?.detections,
        raw?.solution?.greenfield_detections,
        raw?.solution?.greenfield_receipt?.detections,
    ];
    for (const p of paths) {
        // The banked detections file is `{ detections: [...] }`; accept both shapes.
        const arr = Array.isArray(p) ? p : Array.isArray(p?.detections) ? p.detections : null;
        if (arr && arr.length) {
            const out: GfDetection[] = [];
            for (const e of arr) {
                const x = finite(e?.x), y = finite(e?.y);
                out.push({ x: x ?? NaN, y: y ?? NaN, flux: finite(e?.flux) ?? undefined });
            }
            return out;
        }
    }
    return null;
}

/**
 * Normalize a greenfield receipt (bare OR seam-attached), optionally with an
 * external detections source, into the flat `GreenfieldReceipt`. Returns null when
 * the input carries no greenfield decision (⇒ widgets show honest NOT MEASURED).
 */
export function normalizeGreenfieldReceipt(raw: any): GreenfieldReceipt | null {
    const core = resolveCore(raw);
    if (!core) return null;
    const { decision: dec, telemetry: tel, digest } = core;

    const detections = resolveDetections(raw);

    // WCS (crval RA/Dec are DEGREES in the greenfield receipt, NOT engine hours).
    const w = dec.result?.solved?.wcs;
    let wcs: GfWcs | null = null;
    if (w && w.crval && w.crpix && Array.isArray(w.cd)) {
        const raDeg = finite(w.crval.ra), decDeg = finite(w.crval.dec);
        const cx = finite(w.crpix.x), cy = finite(w.crpix.y);
        const cd = w.cd;
        if (raDeg != null && decDeg != null && cx != null && cy != null
            && Array.isArray(cd[0]) && Array.isArray(cd[1])) {
            wcs = { raDeg, decDeg, crpixX: cx, crpixY: cy, cd: [[cd[0][0], cd[0][1]], [cd[1][0], cd[1][1]]] };
        }
    }

    // matches
    const rawMatches = Array.isArray(dec.result?.solved?.matches) ? dec.result.solved.matches : [];
    const matches: GfMatch[] = rawMatches.map((m: any) => ({
        detId: m.det_id, starRow: m.star_row,
        residualX: finite(m.residual_x), residualY: finite(m.residual_y),
        logLr: finite(m.log_lr), testOrder: finite(m.test_order),
    }));

    // per-band merge (search counters + telemetry walls)
    const pb = dec.search?.per_band ?? {};
    const probeWall = tel.per_band_probe_wall_ms ?? {};
    const verifyWall = tel.per_band_verify_wall_ms ?? {};
    const bandKeys = Object.keys(pb).map(Number).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    const perBand: GfPerBand[] = bandKeys.map(band => {
        const c = pb[band] ?? {};
        const detQuads = finite(c.det_quads);
        return {
            band,
            detQuads, probes: finite(c.probes), rawHits: finite(c.raw_hits),
            proposals: finite(c.proposals), verified: finite(c.verified), bailed: finite(c.bailed),
            probeWallMs: finite(probeWall[band]), verifyWallMs: finite(verifyWall[band]),
            coded: (detQuads ?? 0) > 0,
        };
    });

    // fine consensus (with per-row honesty verdict)
    const fc = tel.fine_consensus;
    let fineConsensus: GreenfieldReceipt['fineConsensus'] = null;
    if (fc && typeof fc === 'object') {
        const corr: GfCorroboration[] = (Array.isArray(fc.corroborating) ? fc.corroborating : []).map((c: any) => {
            const rows: GfCorroboration['matchedRows'] = (Array.isArray(c.matched_rows) ? c.matched_rows : []).map((mr: any) => ({
                detId: mr.det_id, residualX: finite(mr.residual_x), residualY: finite(mr.residual_y),
            }));
            const resMags = rows.map(r => (r.residualX != null && r.residualY != null) ? Math.hypot(r.residualX, r.residualY) : NaN)
                .filter((v: number) => Number.isFinite(v));
            const medRes = median(resMags);
            const off = finite(c.center_offset_arcsec), scale = finite(c.pose_scale_ratio);
            return {
                band: finite(c.band), quadSpanPx: finite(c.quad_span_px), poseScaleRatio: scale,
                poseRotDeltaDeg: finite(c.pose_rot_delta_deg), centerOffsetArcsec: off,
                logOdds: finite(c.log_odds), nMatched: finite(c.n_matched), parity: finite(c.parity),
                matchedRows: rows, medianResidualPx: medRes, sane: consensusSane(off, scale, medRes),
            };
        });
        fineConsensus = {
            bandsTested: Array.isArray(fc.bands_tested) ? fc.bands_tested : [],
            candidatesCoded: finite(fc.candidates_coded), hits: finite(fc.hits),
            wallMs: finite(fc.wall_ms), capped: typeof fc.capped === 'boolean' ? fc.capped : null,
            corroborating: corr,
        };
    }

    // frame dimensions — metadata first, else detections extent, else crpix*2 (derived).
    let frame: GreenfieldReceipt['frame'] = null;
    const mw = finite(raw?.metadata?.width), mh = finite(raw?.metadata?.height);
    if (mw != null && mh != null) {
        frame = { width: mw, height: mh, source: 'metadata' };
    } else if (detections && detections.length) {
        let maxX = 0, maxY = 0;
        for (const d of detections) { if (Number.isFinite(d.x)) maxX = Math.max(maxX, d.x); if (Number.isFinite(d.y)) maxY = Math.max(maxY, d.y); }
        if (maxX > 0 && maxY > 0) frame = { width: Math.ceil(maxX) + 2, height: Math.ceil(maxY) + 2, source: 'detections' };
    }
    if (!frame && wcs) frame = { width: Math.round(wcs.crpixX * 2), height: Math.round(wcs.crpixY * 2), source: 'crpix' };

    const fv = dec.result?.solved?.final_verify;
    const prep = dec.prep;

    return {
        frameId: typeof dec.frame_id === 'string' ? dec.frame_id : null,
        classification: typeof dec.classification === 'string' ? dec.classification : null,
        state: typeof dec.result?.state === 'string' ? dec.result.state : null,
        digest,
        scaleArcsecPx: finite(dec.result?.solved?.scale_arcsec_px),
        parity: finite(dec.result?.solved?.parity_sign),
        wcs,
        finalVerify: fv ? {
            logOdds: finite(fv.log_odds), finalOdds: finite(fv.final_odds),
            nMatched: finite(fv.n_matched), nDistractor: finite(fv.n_distractor), nConflict: finite(fv.n_conflict),
            nTest: finite(fv.n_test), nRef: finite(fv.n_ref), effArea: finite(fv.eff_area),
            besti: finite(fv.besti), bestWorst: finite(fv.best_worst),
            bailedAt: finite(fv.bailed_at), stoppedAt: finite(fv.stopped_at),
        } : null,
        acceptBand: finite(dec.result?.solved?.band),
        acceptRung: finite(dec.result?.solved?.rung),
        hypothesisSeq: finite(dec.result?.solved?.hypothesis_seq),
        matches,
        searchTruncated: typeof dec.search_truncated === 'boolean' ? dec.search_truncated : null,
        prep: prep ? {
            raw: finite(prep.raw), valid: finite(prep.valid), deduped: finite(prep.deduped),
            pool: finite(prep.pool), peakArmPromoted: finite(prep.peak_arm_promoted),
        } : null,
        perBand,
        hitOrderPolicy: typeof tel.cache_state?.hit_order_policy === 'string' ? tel.cache_state.hit_order_policy : null,
        wallMs: finite(tel.wall_ms),
        stageMs: (tel.stage_ms && typeof tel.stage_ms === 'object') ? tel.stage_ms : null,
        freezeEvents: (Array.isArray(tel.freeze_events) ? tel.freeze_events : []).map((f: any) => ({
            elapsedMs: finite(f.elapsed_ms), outcome: typeof f.outcome === 'string' ? f.outcome : null,
        })),
        abort: (tel.search_aborted_on_accept != null || tel.abort_elapsed_ms != null) ? {
            onAccept: typeof tel.search_aborted_on_accept === 'boolean' ? tel.search_aborted_on_accept : null,
            elapsedMs: finite(tel.abort_elapsed_ms),
        } : null,
        fineConsensus,
        index: dec.index ? {
            releaseId: typeof dec.index.release_id === 'string' ? dec.index.release_id : null,
            totalQuads: finite(dec.index.total_quads), totalStars: finite(dec.index.total_stars),
            bandsPresent: finite(dec.index.bands_present), aggregateMd5: typeof dec.index.aggregate_md5 === 'string' ? dec.index.aggregate_md5 : null,
            verifyMode: typeof dec.index.verify_mode === 'string' ? dec.index.verify_mode : null,
        } : null,
        build: (dec.build && typeof dec.build === 'object') ? dec.build : null,
        frame,
        detections,
    };
}

// ─── geometry helpers (need detections) ─────────────────────────────────────

/** Detection pixel position for a det_id, or null when out of range / no detections. */
export function detPos(gf: GreenfieldReceipt, detId: number): { x: number; y: number } | null {
    const d = gf.detections;
    if (!d || detId < 0 || detId >= d.length) return null;
    const e = d[detId];
    return (e && Number.isFinite(e.x) && Number.isFinite(e.y)) ? { x: e.x, y: e.y } : null;
}

/** The matched-detection pixel field (the REAL accepted correspondences), or [] when
 *  detections aren't attached. Each carries its residual for optional shading. */
export function matchedDetPositions(gf: GreenfieldReceipt): { x: number; y: number; residualPx: number | null }[] {
    if (!gf.detections) return [];
    const out: { x: number; y: number; residualPx: number | null }[] = [];
    for (const m of gf.matches) {
        const p = detPos(gf, m.detId);
        if (!p) continue;
        const residualPx = (m.residualX != null && m.residualY != null) ? Math.hypot(m.residualX, m.residualY) : null;
        out.push({ x: p.x, y: p.y, residualPx });
    }
    return out;
}

/** Corner pixels for a corroborating quad (its 4 matched_rows det_ids), or null when
 *  any corner is unresolvable. */
export function corroborationCorners(gf: GreenfieldReceipt, c: GfCorroboration): { x: number; y: number }[] | null {
    if (!gf.detections) return null;
    const pts: { x: number; y: number }[] = [];
    for (const r of c.matchedRows) {
        const p = detPos(gf, r.detId);
        if (!p) return null;
        pts.push(p);
    }
    return pts.length >= 3 ? pts : null;
}

// ─── sky → pixel projection (from the receipt's TAN WCS) ─────────────────────

export interface SkyToPixel {
    /** RA (HOURS), Dec (DEGREES) → image pixel, or null on the far hemisphere. */
    project: (raHours: number, decDeg: number) => { x: number; y: number } | null;
    /** Image pixel → RA (HOURS), Dec (DEGREES). Inverse of `project` (round-trips to
     *  ~1e-12 px). Matches SkyTransform.pixelToSky exactly. */
    unproject: (x: number, y: number) => { raHours: number; decDeg: number };
    raHours0: number; decDeg0: number;
}

/**
 * Build the exact sky→pixel projector implied by the receipt's TAN WCS. Uses the
 * shared `projectGnomonic` (deg tangent plane) then applies CD⁻¹ + crpix — the exact
 * inverse of SkyTransform.pixelToSky. VERIFIED: crval→crpix exact, and pixel→sky→pixel
 * round-trips to 2e-12 px on the banked receipt. No parity sign assumed (CD carries it).
 */
export function buildSkyToPixel(wcs: GfWcs): SkyToPixel {
    const [[a, b], [c, d]] = wcs.cd;
    const det = a * d - b * c;
    const raHours0 = wcs.raDeg / 15, decDeg0 = wcs.decDeg;
    if (!(Math.abs(det) > 0)) {
        return { project: () => null, unproject: () => ({ raHours: raHours0, decDeg: decDeg0 }), raHours0, decDeg0 };
    }
    const inv = [[d / det, -b / det], [-c / det, a / det]];
    const DEG = Math.PI / 180;
    const ra0Rad = raHours0 * 15 * DEG, dec0Rad = decDeg0 * DEG;
    return {
        raHours0, decDeg0,
        project(raHours: number, decDeg: number) {
            const g = projectGnomonic(raHours, decDeg, raHours0, decDeg0); // {xi,eta} in deg
            if (!g) return null;
            return {
                x: wcs.crpixX + inv[0][0] * g.xi + inv[0][1] * g.eta,
                y: wcs.crpixY + inv[1][0] * g.xi + inv[1][1] * g.eta,
            };
        },
        unproject(x: number, y: number) {
            const dx = x - wcs.crpixX, dy = y - wcs.crpixY;
            const xi = (a * dx + b * dy) * DEG, eta = (c * dx + d * dy) * DEG; // radians
            const rr = Math.hypot(xi, eta);
            if (rr === 0) return { raHours: raHours0, decDeg: decDeg0 };
            const cc = Math.atan(rr);
            const dec = Math.asin(Math.cos(cc) * Math.sin(dec0Rad) + eta * Math.sin(cc) * Math.cos(dec0Rad) / rr);
            const ra = ra0Rad + Math.atan2(xi * Math.sin(cc), rr * Math.cos(dec0Rad) * Math.cos(cc) - eta * Math.sin(dec0Rad) * Math.sin(cc));
            return { raHours: ((ra / DEG / 15) % 24 + 24) % 24, decDeg: dec / DEG };
        },
    };
}
