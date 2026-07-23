/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INTERACTIVE HORIZON EDITOR — pure editing logic + observer-testimony record
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER a COORDINATE measurement nor a PIXEL op — this is RECORDED
 * TESTIMONY (the observer asserts where the terrain silhouette actually is),
 * kept structurally SEPARATE from the automatic detection-envelope ESTIMATE
 * (horizon_envelope.ts). The automatic estimate is NEVER overwritten: the
 * corrected envelope is a distinct object carried ALONGSIDE the auto snapshot.
 *
 * Mirrors the user_annotations (schema 2.12.0) testimony idiom:
 *  - honest-or-absent (LAW 3): `null` when the observer never edited — never an
 *    empty skeleton pretending to be a correction. So a session that was never
 *    touched keeps `horizonCorrection: null` and the pinned reference solves
 *    stay byte-identical.
 *  - deterministic `captured_at` injection for tests / headless.
 *  - the record is TESTIMONY, not evidence: it does NOT (tonight) feed culling,
 *    detection, verification, or the solve. The automatic envelope is what
 *    signal_processor's foreground shielding consumes today; wiring the
 *    CORRECTED envelope into that culling is a SEPARATE consumer seam.
 *
 * This module is PURE and rendering-agnostic. All geometry helpers take a
 * `project` function (native image px → canvas px) so hit-testing works against
 * however the overlay is drawn, without importing any canvas / DOM types.
 */
import type { HorizonEnvelope, HorizonEnvelopePoint } from './horizon_envelope';

/** The three node-level correction operations the observer can make. */
export type HorizonEditKind = 'move' | 'add' | 'remove';

/** A single node-level correction, positions in NATIVE image pixels. */
export interface HorizonNodeDelta {
    kind: HorizonEditKind;
    /** Prior node position — present for 'move' (source) and 'remove' (target). */
    from?: { x: number; y: number };
    /** New node position — present for 'move' (target) and 'add'. */
    to?: { x: number; y: number };
}

/** Immutable snapshot of the AUTOMATIC estimate at correction-capture time. */
export interface HorizonAutoSnapshot {
    points: HorizonEnvelopePoint[];
    coverage: number;
    hasTerrainEvidence: boolean;
}

/**
 * The full testimony record: {auto, deltas, corrected}. Honest-or-absent — a
 * `buildHorizonCorrection` with no deltas returns `null`, never this shape.
 */
export interface HorizonCorrectionRecord {
    /** The automatic estimate the observer started from (kept verbatim). */
    auto: HorizonAutoSnapshot;
    /** Ordered edit log — the observer's node-level corrections. */
    deltas: HorizonNodeDelta[];
    /** The polyline the observer asserts (auto + deltas applied). */
    corrected: HorizonEnvelopePoint[];
    /** Always 'user' — a human asserted this horizon in the editor. */
    provenance: 'user';
    /** ISO-8601 capture time. */
    captured_at: string;
    /** Native image dimensions the node coordinates are expressed in. */
    image: { width: number; height: number };
}

/** Mutable working state the UI holds; every reducer below is PURE. */
export interface HorizonEditState {
    points: HorizonEnvelopePoint[];
    deltas: HorizonNodeDelta[];
}

/** Projection: native image (x,y) → canvas (x,y). Supplied by the overlay. */
export type HorizonProject = (nx: number, ny: number) => { x: number; y: number };

function clonePoint(p: HorizonEnvelopePoint): HorizonEnvelopePoint {
    return { x: p.x, y: p.y, measured: p.measured };
}

/** Seed an edit state from the automatic envelope (a deep copy — the source is
 *  never mutated). Deltas start empty (nothing corrected yet). */
export function initHorizonEdit(auto: HorizonEnvelope): HorizonEditState {
    return { points: auto.points.map(clonePoint), deltas: [] };
}

/** Move node `index` to native (x,y). Returns NEW state; input untouched. A
 *  moved node keeps its `measured` provenance flag (the delta carries the
 *  human correction). Out-of-range index → unchanged state. */
export function moveHorizonNode(state: HorizonEditState, index: number, x: number, y: number): HorizonEditState {
    if (index < 0 || index >= state.points.length) return state;
    const prev = state.points[index];
    const points = state.points.map(clonePoint);
    points[index] = { x, y, measured: prev.measured };
    return {
        points,
        deltas: [...state.deltas, { kind: 'move', from: { x: prev.x, y: prev.y }, to: { x, y } }],
    };
}

/** Remove node `index`. Guarded: a polyline needs ≥ 2 points, so a removal that
 *  would drop below 2 is refused (returns unchanged state). Out-of-range →
 *  unchanged. */
export function removeHorizonNode(state: HorizonEditState, index: number): HorizonEditState {
    if (index < 0 || index >= state.points.length) return state;
    if (state.points.length <= 2) return state;
    const prev = state.points[index];
    const points = state.points.filter((_, i) => i !== index).map(clonePoint);
    return {
        points,
        deltas: [...state.deltas, { kind: 'remove', from: { x: prev.x, y: prev.y } }],
    };
}

/** Insert a new node at `index` (0..length) with native (x,y). New nodes are
 *  observer-asserted, so `measured` is false. Index is clamped to range. */
export function insertHorizonNode(state: HorizonEditState, index: number, x: number, y: number): HorizonEditState {
    const at = Math.max(0, Math.min(state.points.length, index));
    const pt: HorizonEnvelopePoint = { x, y, measured: false };
    const points = [...state.points.slice(0, at).map(clonePoint), pt, ...state.points.slice(at).map(clonePoint)];
    return {
        points,
        deltas: [...state.deltas, { kind: 'add', to: { x, y } }],
    };
}

/**
 * Index of the node whose PROJECTED position is within `radiusPx` of the canvas
 * point (px,py), nearest first; -1 if none is close enough. Used to pick up a
 * node for dragging or to target a shift-click removal.
 */
export function hitTestHorizonNode(
    points: ReadonlyArray<HorizonEnvelopePoint>,
    project: HorizonProject,
    px: number,
    py: number,
    radiusPx: number,
): number {
    let best = -1;
    let bestD = radiusPx;
    for (let i = 0; i < points.length; i++) {
        const c = project(points[i].x, points[i].y);
        const d = Math.hypot(px - c.x, py - c.y);
        if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
}

/**
 * Nearest point ON the polyline to the canvas point (px,py), returned in NATIVE
 * coordinates together with the insertion index (insert BEFORE that index), or
 * `null` if farther than `maxDistPx`. Because native→canvas projection is
 * affine, the closest-point parameter `t` computed in canvas space maps back to
 * the same `t` along the native segment — so no inverse projection is needed.
 */
export function nearestHorizonSegment(
    points: ReadonlyArray<HorizonEnvelopePoint>,
    project: HorizonProject,
    px: number,
    py: number,
    maxDistPx: number,
): { index: number; x: number; y: number } | null {
    if (points.length < 2) return null;
    let best: { dist: number; index: number; x: number; y: number } | null = null;
    for (let i = 0; i < points.length - 1; i++) {
        const A = points[i];
        const B = points[i + 1];
        const a = project(A.x, A.y);
        const b = project(B.x, B.y);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = a.x + t * dx;
        const cy = a.y + t * dy;
        const dist = Math.hypot(px - cx, py - cy);
        if (!best || dist < best.dist) {
            best = { dist, index: i + 1, x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y) };
        }
    }
    if (!best || best.dist > maxDistPx) return null;
    return { index: best.index, x: best.x, y: best.y };
}

/**
 * Assemble the testimony record from the automatic envelope + the observer's
 * edit state. Honest-or-absent: returns `null` when no correction was made
 * (empty deltas) — the caller then keeps `horizonCorrection: null`. The `auto`
 * snapshot is a fresh COPY, so later edits can never reach back and mutate the
 * recorded automatic estimate. Pass `capturedAt` for deterministic output.
 */
export function buildHorizonCorrection(
    auto: HorizonEnvelope,
    state: HorizonEditState,
    image: { width: number; height: number },
    capturedAt?: string,
): HorizonCorrectionRecord | null {
    if (state.deltas.length === 0) return null;
    return {
        auto: {
            points: auto.points.map(clonePoint),
            coverage: auto.coverage,
            hasTerrainEvidence: auto.hasTerrainEvidence,
        },
        deltas: state.deltas.map(d => ({ ...d })),
        corrected: state.points.map(clonePoint),
        provenance: 'user',
        captured_at: typeof capturedAt === 'string' && capturedAt.length > 0
            ? capturedAt
            : new Date().toISOString(),
        image: { width: image.width, height: image.height },
    };
}
