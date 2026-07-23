/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SKY OVERLAYS — RA/Dec graticule + named-star projection (pure, node-testable)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Render-side geometry for the greenfield "sky overlays" widget. Everything here
 * projects through the receipt's TAN WCS (via `SkyToPixel`, whose conventions are
 * copied from SkyTransform.pixelToSky — crpix.x/crpix.y, CD in deg/px, gnomonic).
 * The graticule is NET-NEW (no in-tree graticule existed): simple + exact — draw
 * the standard sphere grid and clip polylines to the frame; a great-circle gap
 * test bounds the RA arc so near-pole / wide fields don't sample the whole sphere.
 *
 * Ledger: RENDER PLANE. Pure; projects an already-fitted WCS for display only.
 */

import type { SkyToPixel } from './greenfield_receipt';
import { angularSepDeg, type LabelCandidate } from './star_labels';
import type { NamedStar } from './named_stars';

export interface GraticuleLine {
    kind: 'ra' | 'dec';
    valueDeg: number;
    label: string;
    /** In-frame polyline segments (px); a line may re-enter the frame ⇒ many. */
    segments: [number, number][][];
}

/** Nice-number ladder for a graticule step (degrees). */
export function niceStepDeg(x: number): number {
    const ladder = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 45];
    for (const s of ladder) if (s >= x) return s;
    return 45;
}

function inFrame(x: number, y: number, w: number, h: number, m: number): boolean {
    return x >= -m && x <= w + m && y >= -m && y <= h + m;
}

/** Split a sampled point list into in-frame polyline runs (break on null / big jump). */
function runs(
    pts: ({ x: number; y: number } | null)[], w: number, h: number, m: number,
): [number, number][][] {
    const bigJump = 0.5 * Math.hypot(w, h);
    const out: [number, number][][] = [];
    let cur: [number, number][] = [];
    let prev: { x: number; y: number } | null = null;
    const flush = () => { if (cur.length >= 2) out.push(cur); cur = []; };
    for (const p of pts) {
        if (!p || !inFrame(p.x, p.y, w, h, m)) { flush(); prev = null; continue; }
        if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > bigJump) flush();
        cur.push([p.x, p.y]); prev = p;
    }
    flush();
    return out;
}

/** Multiples of `step` within [lo,hi] (inclusive-ish). */
function multiplesIn(lo: number, hi: number, step: number): number[] {
    const out: number[] = [];
    const start = Math.ceil(lo / step) * step;
    for (let v = start; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
    return out;
}

function raLabel(deg: number): string {
    const d = ((deg % 360) + 360) % 360;
    return `${d.toFixed(d % 1 ? 2 : 0)}°`;
}
function decLabel(deg: number): string {
    return `${deg >= 0 ? '+' : ''}${deg.toFixed(deg % 1 ? 2 : 0)}°`;
}

/**
 * Build an RA/Dec graticule for the frame under the given projector. Range-finds the
 * sky footprint from a grid of unprojected pixels (great-circle gap test bounds the
 * RA arc; a pole in the field ⇒ full 0–360 meridians), picks a nice step for ~6–8
 * lines, then samples + clips each line. Pure + deterministic.
 */
export function buildGraticule(
    proj: SkyToPixel, frame: { width: number; height: number },
    opts: { grid?: number } = {},
): { lines: GraticuleLine[]; fieldDeg: number; raRangeDeg: [number, number]; decRangeDeg: [number, number]; fullCircle: boolean } {
    const w = frame.width, h = frame.height;
    const margin = 0.02 * Math.max(w, h);
    const g = opts.grid ?? 7;

    // Range-find from an interior pixel grid.
    const skyPts: { raDeg: number; decDeg: number }[] = [];
    for (let i = 0; i <= g; i++) for (let j = 0; j <= g; j++) {
        const s = proj.unproject((i / g) * w, (j / g) * h);
        skyPts.push({ raDeg: s.raHours * 15, decDeg: s.decDeg });
    }
    let decMin = Infinity, decMax = -Infinity;
    for (const s of skyPts) { decMin = Math.min(decMin, s.decDeg); decMax = Math.max(decMax, s.decDeg); }

    // RA arc via largest gap on the circle.
    const ras = skyPts.map(s => ((s.raDeg % 360) + 360) % 360).sort((a, b) => a - b);
    let maxGap = 0, gapAt = 0;
    for (let i = 0; i < ras.length; i++) {
        const next = i + 1 < ras.length ? ras[i + 1] : ras[0] + 360;
        const gap = next - ras[i];
        if (gap > maxGap) { maxGap = gap; gapAt = i; }
    }
    const fullCircle = maxGap < 40; // no dominant gap ⇒ pole-ish / wraps most of circle
    let raLo: number, raHi: number;
    if (fullCircle) { raLo = 0; raHi = 360; }
    else { raLo = ras[(gapAt + 1) % ras.length]; raHi = ras[gapAt] + (gapAt + 1 < ras.length ? 0 : 360); if (raHi < raLo) raHi += 360; }

    // Field size (max great-circle sep among the corner samples).
    let fieldDeg = 0;
    const corners = [skyPts[0], skyPts[g], skyPts[skyPts.length - 1 - g], skyPts[skyPts.length - 1]];
    for (let a = 0; a < corners.length; a++) for (let b = a + 1; b < corners.length; b++) {
        fieldDeg = Math.max(fieldDeg, angularSepDeg(corners[a].raDeg / 15, corners[a].decDeg, corners[b].raDeg / 15, corners[b].decDeg));
    }
    const step = niceStepDeg(Math.max(0.05, fieldDeg / 6));
    const decPad = step, raPad = step;

    const lines: GraticuleLine[] = [];

    // Meridians (constant RA).
    const raVals = fullCircle ? multiplesIn(0, 360 - step, step) : multiplesIn(raLo - raPad, raHi + raPad, step);
    const decLo = Math.max(-89.5, decMin - decPad), decHi = Math.min(89.5, decMax + decPad);
    const decSamples = Math.max(40, Math.round((decHi - decLo) / Math.max(0.05, step / 40)));
    for (const raDeg of raVals) {
        const pts: ({ x: number; y: number } | null)[] = [];
        for (let k = 0; k <= decSamples; k++) {
            const dec = decLo + (decHi - decLo) * (k / decSamples);
            pts.push(proj.project((((raDeg % 360) + 360) % 360) / 15, dec));
        }
        const segments = runs(pts, w, h, margin);
        if (segments.length) lines.push({ kind: 'ra', valueDeg: ((raDeg % 360) + 360) % 360, label: raLabel(raDeg), segments });
    }

    // Parallels (constant Dec).
    const decVals = multiplesIn(decMin - decPad, decMax + decPad, step).filter(d => d >= -89.5 && d <= 89.5);
    const raSampLo = fullCircle ? 0 : raLo - raPad, raSampHi = fullCircle ? 360 : raHi + raPad;
    const raSamples = Math.max(60, Math.round((raSampHi - raSampLo) / Math.max(0.05, step / 40)));
    for (const decDeg of decVals) {
        const pts: ({ x: number; y: number } | null)[] = [];
        for (let k = 0; k <= raSamples; k++) {
            const ra = raSampLo + (raSampHi - raSampLo) * (k / raSamples);
            pts.push(proj.project((((ra % 360) + 360) % 360) / 15, decDeg));
        }
        const segments = runs(pts, w, h, margin);
        if (segments.length) lines.push({ kind: 'dec', valueDeg: decDeg, label: decLabel(decDeg), segments });
    }

    return { lines, fieldDeg, raRangeDeg: [raLo, raHi], decRangeDeg: [decMin, decMax], fullCircle };
}

// ─── named-star projection through the receipt WCS ──────────────────────────

/**
 * Project the bundled named-star reference through the receipt WCS, keeping those
 * in-frame. Each becomes a `predicted`-source label candidate (position from the
 * receipt's OWN fitted WCS — honest: catalog position via the solved WCS, not an
 * anchored match). Reuse `layoutLabels` for declutter. Pure.
 */
export function projectNamedStars(
    proj: SkyToPixel, named: readonly NamedStar[], frame: { width: number; height: number },
): LabelCandidate[] {
    const w = frame.width, h = frame.height, m = 0.01 * Math.max(w, h);
    const out: LabelCandidate[] = [];
    for (const s of named) {
        const p = proj.project(s.ra_hours, s.dec_degrees);
        if (!p || !inFrame(p.x, p.y, w, h, m)) continue;
        out.push({
            text: s.proper?.trim() || s.bayer?.trim() || '?',
            proper: s.proper, bayer: s.bayer,
            x: p.x, y: p.y, mag: s.mag, source: 'predicted',
        });
    }
    return out;
}
