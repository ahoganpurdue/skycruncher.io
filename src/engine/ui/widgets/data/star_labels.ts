/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAR-LABEL GEOMETRY — pure render-side helpers (UI ledger, node-testable)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger note: this module reads an ALREADY-FITTED solution (the matched stars'
 * catalog sky positions + their fitted image positions) purely for DISPLAY. It
 * fits NOTHING astrometric — the "empirical map" below is a small least-squares
 * regression from the solution's OWN matched (sky ↔ pixel) correspondences,
 * derived only to place honestly-labelled "catalog-predicted" markers. It NEVER
 * mutates the WCS / matched_stars / solve. No parity/CD sign is assumed — the
 * linear fit absorbs any axis flip empirically (CLAUDE.md: "Do not assert sign").
 *
 * Nothing here touches React; every function is pure and unit-testable in node.
 */

import type { NamedStar } from './named_stars';

const DEG = Math.PI / 180;

// ─── tunable DISPLAY constants (NOT solver gates — pure presentation) ────────

/** A named ref is "the same star" as a matched atlas star within this sky sep. */
export const ANCHOR_TOL_DEG = 0.05;          // ~3′; named stars are sparsely separated
/** Minimum matched correspondences before an empirical sky→pixel map is trusted. */
export const PRED_MIN_MATCHES = 6;
/** Empirical-map RMS must be under this fraction of the frame diagonal to be used. */
export const PRED_MAX_RMS_FRAC = 0.02;       // 2% of diagonal
/** Predicted markers may sit slightly outside the frame edge (px) before culling. */
export const PRED_MARGIN_PX = 8;

// ─── spherical geometry ─────────────────────────────────────────────────────

/** Great-circle angular separation (degrees) between two RA(hours)/Dec(deg) points. */
export function angularSepDeg(ra1Hours: number, dec1Deg: number, ra2Hours: number, dec2Deg: number): number {
    const ra1 = ra1Hours * 15 * DEG, ra2 = ra2Hours * 15 * DEG;
    const d1 = dec1Deg * DEG, d2 = dec2Deg * DEG;
    const c = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(ra1 - ra2);
    return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/**
 * Gnomonic (TAN) tangent-plane projection of a sky point about a center, in
 * DEGREES. Returns null when the point is on the far hemisphere (cosc ≤ 0). RA in
 * HOURS, Dec in DEGREES (engine convention).
 */
export function projectGnomonic(
    raHours: number, decDeg: number, ra0Hours: number, dec0Deg: number,
): { xi: number; eta: number } | null {
    const ra = raHours * 15 * DEG, ra0 = ra0Hours * 15 * DEG;
    const dec = decDeg * DEG, dec0 = dec0Deg * DEG;
    const cosc = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
    if (!(cosc > 1e-6)) return null;
    const xi = (Math.cos(dec) * Math.sin(ra - ra0)) / cosc;
    const eta = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosc;
    return { xi: xi / DEG, eta: eta / DEG };
}

// ─── empirical sky → pixel affine (least squares over matched correspondences) ──

export interface MatchedSample {
    raHours: number; decDeg: number; x: number; y: number;
}

export interface SkyPixelMap {
    valid: boolean;
    n: number;
    rmsPx: number | null;
    /** Project a sky position to image pixels; null when the map is unusable. */
    project: (raHours: number, decDeg: number) => { x: number; y: number } | null;
}

/** Solve a symmetric 3×3 system A·s = b (A given row-major). Null if near-singular. */
function solve3x3(A: number[], b: number[]): [number, number, number] | null {
    const [a, bb, c, d, e, f, g, h, i] = A;
    const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det;
    // Cramer's rule.
    const s0 = (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) * inv;
    const s1 = (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) * inv;
    const s2 = (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) * inv;
    return [s0, s1, s2];
}

/**
 * Fit x = a·ξ + b·η + c and y = d·ξ + e·η + f from matched (sky, pixel) pairs,
 * with (ξ,η) the gnomonic tangent-plane coords about (ra0,dec0). Returns a
 * projector + the in-sample RMS residual (px). `valid` requires enough
 * non-degenerate correspondences AND a small residual — else predicted placement
 * is withheld (honest-absent), never guessed.
 */
export function fitSkyToPixelAffine(
    matches: readonly MatchedSample[],
    ra0Hours: number, dec0Deg: number,
    opts: { minMatches?: number; maxRmsFrac?: number; diagPx: number } = { diagPx: 1 },
): SkyPixelMap {
    const minMatches = opts.minMatches ?? PRED_MIN_MATCHES;
    const maxRmsFrac = opts.maxRmsFrac ?? PRED_MAX_RMS_FRAC;

    const pts: { xi: number; eta: number; x: number; y: number }[] = [];
    for (const m of matches) {
        const g = projectGnomonic(m.raHours, m.decDeg, ra0Hours, dec0Deg);
        if (g && Number.isFinite(m.x) && Number.isFinite(m.y)) pts.push({ xi: g.xi, eta: g.eta, x: m.x, y: m.y });
    }
    if (pts.length < minMatches) return { valid: false, n: pts.length, rmsPx: null, project: () => null };

    // Normal equations for the shared design matrix [ξ, η, 1].
    let sxx = 0, sxe = 0, sx1 = 0, see = 0, se1 = 0, s11 = 0;
    let bxX = 0, bxE = 0, bx1 = 0, byX = 0, byE = 0, by1 = 0;
    for (const p of pts) {
        sxx += p.xi * p.xi; sxe += p.xi * p.eta; sx1 += p.xi;
        see += p.eta * p.eta; se1 += p.eta; s11 += 1;
        bxX += p.xi * p.x; bxE += p.eta * p.x; bx1 += p.x;
        byX += p.xi * p.y; byE += p.eta * p.y; by1 += p.y;
    }
    const A = [sxx, sxe, sx1, sxe, see, se1, sx1, se1, s11];
    const cx = solve3x3(A, [bxX, bxE, bx1]);
    const cy = solve3x3(A, [byX, byE, by1]);
    if (!cx || !cy) return { valid: false, n: pts.length, rmsPx: null, project: () => null };

    // In-sample residual RMS (px).
    let se = 0;
    for (const p of pts) {
        const px = cx[0] * p.xi + cx[1] * p.eta + cx[2];
        const py = cy[0] * p.xi + cy[1] * p.eta + cy[2];
        se += (px - p.x) ** 2 + (py - p.y) ** 2;
    }
    const rmsPx = Math.sqrt(se / pts.length);
    const valid = rmsPx <= maxRmsFrac * opts.diagPx;

    const project = (raHours: number, decDeg: number): { x: number; y: number } | null => {
        const g = projectGnomonic(raHours, decDeg, ra0Hours, dec0Deg);
        if (!g) return null;
        return { x: cx[0] * g.xi + cx[1] * g.eta + cx[2], y: cy[0] * g.xi + cy[1] * g.eta + cy[2] };
    };
    return { valid, n: pts.length, rmsPx, project };
}

// ─── named-star resolution (anchored + predicted candidates) ─────────────────

export type LabelSource = 'anchored' | 'predicted';

export interface LabelCandidate {
    /** Display label — proper name preferred, Bayer designation as fallback. */
    text: string;
    proper: string;
    bayer: string;
    /** Image-space position (px): the ATLAS star's fitted xy (anchored) or the
     *  empirical-map projection (predicted). */
    x: number;
    y: number;
    mag: number;
    source: LabelSource;
    /** Sky separation (deg) to the matched atlas star it anchored to (anchored only). */
    sepDeg?: number;
}

export interface ResolvedLabels {
    anchored: LabelCandidate[];
    predicted: LabelCandidate[];
    map: { valid: boolean; rmsPx: number | null; n: number };
}

/** Label text: proper name first, Bayer designation fallback (LAW: never empty). */
export function labelText(s: NamedStar): string {
    return s.proper?.trim() || s.bayer?.trim() || '?';
}

/**
 * Resolve named-star labels against a solved frame.
 *   - ANCHORED: a matched atlas star lies within `anchorTolDeg` of the named ref →
 *     the label attaches to that atlas star's REAL fitted (x,y). Full strength.
 *   - PREDICTED: a named ref with no co-located matched star, projected via the
 *     solution's own empirical sky→pixel map, if that map validated. Shown dimmer,
 *     labelled catalog-predicted. Withheld entirely when the map is unusable.
 * A named ref is never both. Pure — deterministic for a given input.
 */
export function resolveNamedLabels(
    matched: readonly MatchedSample[],
    named: readonly NamedStar[],
    frame: { w: number; h: number },
    center: { ra0Hours: number; dec0Deg: number } | null,
    cfg: { anchorTolDeg?: number; minMatches?: number; maxRmsFrac?: number; marginPx?: number } = {},
): ResolvedLabels {
    const anchorTolDeg = cfg.anchorTolDeg ?? ANCHOR_TOL_DEG;
    const marginPx = cfg.marginPx ?? PRED_MARGIN_PX;
    const diagPx = Math.hypot(frame.w, frame.h) || 1;

    const anchored: LabelCandidate[] = [];
    const anchoredIdx = new Set<number>();

    named.forEach((s, i) => {
        let best = Infinity, bestM: MatchedSample | null = null;
        for (const m of matched) {
            const sep = angularSepDeg(s.ra_hours, s.dec_degrees, m.raHours, m.decDeg);
            if (sep < best) { best = sep; bestM = m; }
        }
        if (bestM && best <= anchorTolDeg) {
            anchoredIdx.add(i);
            anchored.push({
                text: labelText(s), proper: s.proper, bayer: s.bayer,
                x: bestM.x, y: bestM.y, mag: s.mag, source: 'anchored', sepDeg: best,
            });
        }
    });

    // Empirical map for the predicted layer (uses the solution's own matches).
    const c0 = center
        ?? (matched.length ? { ra0Hours: matched[0].raHours, dec0Deg: matched[0].decDeg } : null);
    const map = c0
        ? fitSkyToPixelAffine(matched, c0.ra0Hours, c0.dec0Deg, { minMatches: cfg.minMatches, maxRmsFrac: cfg.maxRmsFrac, diagPx })
        : { valid: false, n: 0, rmsPx: null, project: () => null } as SkyPixelMap;

    const predicted: LabelCandidate[] = [];
    if (map.valid) {
        named.forEach((s, i) => {
            if (anchoredIdx.has(i)) return;
            const p = map.project(s.ra_hours, s.dec_degrees);
            if (!p) return;
            if (p.x < -marginPx || p.x > frame.w + marginPx || p.y < -marginPx || p.y > frame.h + marginPx) return;
            predicted.push({
                text: labelText(s), proper: s.proper, bayer: s.bayer,
                x: p.x, y: p.y, mag: s.mag, source: 'predicted',
            });
        });
    }

    return { anchored, predicted, map: { valid: map.valid, rmsPx: map.rmsPx, n: map.n } };
}

// ─── declutter (greedy, priority by brightness, deterministic) ───────────────

export interface LabelPlacement {
    text: string;
    source: LabelSource;
    mag: number;
    /** Marker position in viewBox units. */
    mx: number; my: number;
    /** Label text anchor position in viewBox units. */
    lx: number; ly: number;
    align: 'start' | 'middle' | 'end';
    /** True when the label is offset from its preferred slot (draw a leader line). */
    leader: boolean;
}

export interface DeclutterResult {
    placed: LabelPlacement[];
    dropped: number;
}

interface Box { x0: number; y0: number; x1: number; y1: number }
const overlaps = (a: Box, b: Box): boolean =>
    a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/**
 * Priority order: ANCHORED before PREDICTED (anchored is the certain identity),
 * then brighter (smaller mag) first, then by text for a stable, deterministic
 * tie-break. Returns a NEW sorted array.
 */
export function prioritize(cands: readonly LabelCandidate[]): LabelCandidate[] {
    const rank = (c: LabelCandidate) => (c.source === 'anchored' ? 0 : 1);
    return [...cands].sort((a, b) =>
        rank(a) - rank(b) || a.mag - b.mag || a.text.localeCompare(b.text));
}

/**
 * Greedy declutter: place each label (priority order) at the first candidate slot
 * whose text box does not overlap an already-placed box. The FIRST slot (to the
 * right of the marker) needs no leader line; any later slot draws one. Labels that
 * cannot be placed without overlap are DROPPED (labels never overlap — honest
 * declutter, never a squashed pile). Deterministic for a given input + viewport.
 */
export function layoutLabels(
    candidates: readonly LabelCandidate[],
    view: { w: number; h: number; vw: number; vh: number },
    cfg: { charW?: number; lineH?: number; padX?: number; markerR?: number; maxLabels?: number } = {},
): DeclutterResult {
    const charW = cfg.charW ?? 3.4;
    const lineH = cfg.lineH ?? 7;
    const padX = cfg.padX ?? 1.5;
    const markerR = cfg.markerR ?? 2;
    const maxLabels = cfg.maxLabels ?? 40;

    const sx = view.vw / (view.w || 1), sy = view.vh / (view.h || 1);
    const placedBoxes: Box[] = [];
    const placed: LabelPlacement[] = [];
    let dropped = 0;

    // Preferred slot first (right, no leader), then alternates (leader).
    const slots: { dx: number; dy: number; align: 'start' | 'middle' | 'end' }[] = [
        { dx: markerR + padX, dy: lineH * 0.32, align: 'start' },   // right (preferred)
        { dx: -(markerR + padX), dy: lineH * 0.32, align: 'end' },  // left
        { dx: 0, dy: -(markerR + padX), align: 'middle' },          // above
        { dx: 0, dy: markerR + lineH, align: 'middle' },            // below
        { dx: markerR + padX, dy: -(markerR + padX), align: 'start' },   // up-right
        { dx: -(markerR + padX), dy: -(markerR + padX), align: 'end' },  // up-left
        { dx: markerR + padX, dy: markerR + lineH, align: 'start' },     // down-right
        { dx: -(markerR + padX), dy: markerR + lineH, align: 'end' },    // down-left
    ];

    for (const c of prioritize(candidates)) {
        if (placed.length >= maxLabels) { dropped++; continue; }
        const mx = c.x * sx, my = c.y * sy;
        const w = c.text.length * charW + 2 * padX;
        let done = false;
        for (let si = 0; si < slots.length; si++) {
            const s = slots[si];
            const lx = mx + s.dx, ly = my + s.dy;
            const x0 = s.align === 'start' ? lx : s.align === 'end' ? lx - w : lx - w / 2;
            const box: Box = { x0, y0: ly - lineH * 0.82, x1: x0 + w, y1: ly + lineH * 0.18 };
            if (placedBoxes.some(b => overlaps(box, b))) continue;
            placedBoxes.push(box);
            placed.push({ text: c.text, source: c.source, mag: c.mag, mx, my, lx, ly, align: s.align, leader: si !== 0 });
            done = true;
            break;
        }
        if (!done) dropped++;
    }
    return { placed, dropped };
}
