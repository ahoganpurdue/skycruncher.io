/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REPLAY STREAM — schema + deterministic synthesis for the solve-replay widget
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The "solve replay" widget renders a REPLAY STREAM, not the raw receipt. This
 * decouples the animation from the data source so a FUTURE solver-side SAMPLED
 * real stream can drop in with ZERO widget changes: the widget consumes whatever
 * `ReplayStream` it is handed (real or synthesized).
 *
 * HONESTY CONTRACT (non-negotiable):
 *   - `candidate` / `failed` events are SYNTHESIZED. Their POSITIONS are fabricated
 *     (seeded from the receipt digest — deterministic), but their PER-BAND COUNTS
 *     and TEMPO are derived from the receipt's REAL per-band telemetry (probes,
 *     bail counts, probe/verify wall_ms). They are representative, never claimed
 *     to be the actual probed geometry.
 *   - `accepted` / `corroborated` events + `acceptedFieldPx` are REAL: their pixel
 *     corners come from the accepted matches / SANE fine-consensus quads via the
 *     verified det_id → detections[det_id] mapping. Junk (non-sane) corroborations
 *     are NEVER promoted to green (they are omitted, or emitted `candidate` when
 *     shown at all).
 *
 * Ledger: RENDER PLANE. Pure + node-unit-testable (no React, no canvas).
 */

import type { GreenfieldReceipt } from './greenfield_receipt';
import { corroborationCorners, matchedDetPositions } from './greenfield_receipt';

export const REPLAY_STREAM_SCHEMA_VERSION = '1.0.0';

export type ReplayVerdict = 'candidate' | 'failed' | 'accepted' | 'corroborated';

export interface ReplayEvent {
    band: number;
    /** Event onset in the solve's own wall clock (ms). */
    t_ms: number;
    /** Four image-space corners (px). */
    quad_px: [number, number][];
    verdict: ReplayVerdict;
    /** true ⇒ corners are REAL accepted geometry; false ⇒ synthesized representative. */
    real: boolean;
}

export interface ReplayStream {
    schema_version: string;
    digest: string | null;
    synthesized: boolean;
    frame: { width: number; height: number };
    /** Bands in TESTED order (per hit_order_policy: descending index, coarse→fine). */
    bands: number[];
    events: ReplayEvent[];
    /** REAL persistent green markers — the accepted matched-detection field. */
    acceptedFieldPx: [number, number][];
    /** Total replay duration (ms, solve wall clock). */
    duration_ms: number;
    note: string;
}

// ─── deterministic PRNG (mulberry32) seeded from the receipt digest ──────────

/** FNV-1a → 32-bit seed from a digest string (deterministic, no crypto dep). */
export function seedFromDigest(digest: string | null): number {
    let h = 0x811c9dc5;
    const s = digest ?? 'greenfield';
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ─── synthesis knobs (display-only; not solver gates) ───────────────────────

/** Max synthesized candidate quads drawn per band (1.19M real probes → a few dozen
 *  representative flashes; the honesty label makes the ratio explicit). */
export const REP_MAX_CANDIDATES_PER_BAND = 120;
export const REP_PROBES_PER_CANDIDATE = 10000;
export const REP_MIN_CANDIDATES_PER_BAND = 24;
/** Synthetic quad span range (px). */
const SYN_SPAN_MIN = 180, SYN_SPAN_MAX = 1400;

function synQuad(rnd: () => number, w: number, h: number): [number, number][] {
    const span = SYN_SPAN_MIN + (SYN_SPAN_MAX - SYN_SPAN_MIN) * rnd();
    const cx = span / 2 + rnd() * Math.max(1, w - span);
    const cy = span / 2 + rnd() * Math.max(1, h - span);
    const pts: [number, number][] = [];
    for (let i = 0; i < 4; i++) {
        pts.push([cx + (rnd() - 0.5) * span, cy + (rnd() - 0.5) * span]);
    }
    return pts;
}

/**
 * Synthesize a deterministic ReplayStream from a normalized greenfield receipt.
 *   - candidate/failed counts + tempo ← REAL per-band telemetry.
 *   - accepted/corroborated corners ← REAL sane consensus quads (needs detections).
 *   - accepted field ← REAL matched-detection positions (needs detections).
 * Deterministic for a given receipt (seed = digest). Same output every call.
 */
export function synthesizeReplayStream(
    gf: GreenfieldReceipt,
    opts: { maxCandidatesPerBand?: number } = {},
): ReplayStream {
    const maxCand = opts.maxCandidatesPerBand ?? REP_MAX_CANDIDATES_PER_BAND;
    const w = gf.frame?.width ?? 1000, h = gf.frame?.height ?? 1000;
    const rnd = mulberry32(seedFromDigest(gf.digest));

    // Tested order: descending band index (coarse→fine) per hit_order_policy.
    const tested = [...gf.perBand].sort((a, b) => b.band - a.band);

    const events: ReplayEvent[] = [];
    let clock = 0;

    for (const b of tested) {
        const probeMs = b.probeWallMs ?? 0;
        const verifyMs = b.verifyWallMs ?? 0;
        // Bands never coded (abort-skip) contribute nothing (honest — no synthesized
        // probes for work that never happened).
        if (!b.coded) continue;

        const probes = b.probes ?? 0;
        const nCand = Math.max(
            REP_MIN_CANDIDATES_PER_BAND,
            Math.min(maxCand, Math.round(probes / REP_PROBES_PER_CANDIDATE)),
        );
        // Real bail/proposal ratio decides how many candidates "hit then fail" (red).
        const bailed = b.bailed ?? 0;
        const proposals = b.proposals ?? 0;
        const rawHits = b.rawHits ?? 0;
        // Failed-confirm flashes: at least the real bailed count; scaled up by the
        // rawHit fraction so the stream visibly "finds candidates that don't confirm".
        const nFailed = Math.min(nCand, Math.max(bailed, Math.round(nCand * Math.min(1, rawHits / Math.max(1, probes) * 40))));

        const probeSpan = Math.max(1, probeMs);
        for (let i = 0; i < nCand; i++) {
            const t = clock + (i / Math.max(1, nCand)) * probeSpan;
            const isFailed = i < nFailed;
            events.push({
                band: b.band, t_ms: t, quad_px: synQuad(rnd, w, h),
                verdict: isFailed ? 'failed' : 'candidate', real: false,
            });
        }
        clock += probeSpan + Math.max(0, verifyMs);
        void proposals; // (kept in scope for readability of the derivation)
    }

    // REAL green geometry: sane fine-consensus quads (corners via det positions).
    const acceptEnd = clock;
    const sane = (gf.fineConsensus?.corroborating ?? []).filter(c => c.sane);
    // Strongest sane quad (highest log-odds) → 'accepted'; the rest → 'corroborated'.
    sane.sort((a, b) => (b.logOdds ?? -Infinity) - (a.logOdds ?? -Infinity));
    sane.forEach((c, idx) => {
        const corners = corroborationCorners(gf, c);
        if (!corners) return;
        events.push({
            band: c.band ?? gf.acceptBand ?? -1,
            t_ms: acceptEnd + idx * 0.001,
            quad_px: corners.map(p => [p.x, p.y]) as [number, number][],
            verdict: idx === 0 ? 'accepted' : 'corroborated',
            real: true,
        });
    });

    const acceptedFieldPx = matchedDetPositions(gf).map(p => [p.x, p.y] as [number, number]);

    events.sort((a, b) => a.t_ms - b.t_ms);
    const duration_ms = events.length ? Math.max(gf.wallMs ?? 0, events[events.length - 1].t_ms) : (gf.wallMs ?? 0);

    return {
        schema_version: REPLAY_STREAM_SCHEMA_VERSION,
        digest: gf.digest,
        synthesized: true,
        frame: { width: w, height: h },
        bands: tested.map(b => b.band),
        events,
        acceptedFieldPx,
        duration_ms,
        note: 'candidate/failed events synthesized from measured per-band telemetry (counts+tempo real, positions seeded from digest); accepted/corroborated corners + accepted field are REAL (verified det_id→detection positions, sane consensus only).',
    };
}

/** Validate a stream object shape enough to render it (real streams that drop in
 *  must pass this). Returns null when unusable. */
export function coerceReplayStream(raw: any): ReplayStream | null {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events)) return null;
    if (!raw.frame || !Number.isFinite(raw.frame.width) || !Number.isFinite(raw.frame.height)) return null;
    return raw as ReplayStream;
}
