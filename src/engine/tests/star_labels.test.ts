/**
 * STAR-LABEL WIDGET — pure geometry / matching / declutter tests (node, no DOM).
 *
 * Covers:
 *  - angular separation + gnomonic projection sanity
 *  - empirical sky→pixel affine: recovers a known map, validity gate honest
 *  - name resolution: anchored within tolerance, predicted withheld when map unusable
 *  - declutter: determinism, no-overlap guarantee, leader flag, drop-on-crowding,
 *    priority (anchored before predicted; brighter first)
 *  - selector: null ⇒ NOT MEASURED; present ⇒ data (honest-or-absent, LAW 3)
 */

import { describe, it, expect } from 'vitest';
import {
    angularSepDeg, projectGnomonic, fitSkyToPixelAffine, resolveNamedLabels,
    layoutLabels, prioritize, labelText,
    type MatchedSample, type LabelCandidate,
} from '../ui/widgets/data/star_labels';
import type { NamedStar } from '../ui/widgets/data/named_stars';
import { NAMED_STARS } from '../ui/widgets/data/named_stars';
import { selectStarLabels } from '../ui/widgets/widgets/StarLabelsWidget';

// ─── spherical geometry ─────────────────────────────────────────────────────

describe('angularSepDeg', () => {
    it('is zero for identical points and symmetric', () => {
        expect(angularSepDeg(10, 20, 10, 20)).toBeCloseTo(0, 6);
        expect(angularSepDeg(10, 20, 10.1, 21)).toBeCloseTo(angularSepDeg(10.1, 21, 10, 20), 9);
    });
    it('matches a known 1° dec offset', () => {
        expect(angularSepDeg(6, 0, 6, 1)).toBeCloseTo(1.0, 4);
    });
    it('a 1-arcmin RA offset at the equator is ~0.25° (1 min of RA = 0.25°)', () => {
        // 1 minute of TIME in RA = 0.25° on the sky at the equator.
        expect(angularSepDeg(6.0, 0, 6.0 + 1 / 60, 0)).toBeCloseTo(0.25, 3);
    });
});

describe('projectGnomonic', () => {
    it('projects the tangent point to the origin', () => {
        const g = projectGnomonic(10, 20, 10, 20);
        expect(g).not.toBeNull();
        expect(g!.xi).toBeCloseTo(0, 9);
        expect(g!.eta).toBeCloseTo(0, 9);
    });
    it('returns null for the antipode (far hemisphere)', () => {
        expect(projectGnomonic(10 + 12, -20, 10, 20)).toBeNull();
    });
});

// ─── empirical sky→pixel affine ─────────────────────────────────────────────

/** Build matched samples from a known affine over a small sky grid about a center. */
function syntheticMatches(
    ra0: number, dec0: number,
    map: (xi: number, eta: number) => { x: number; y: number },
): MatchedSample[] {
    const out: MatchedSample[] = [];
    for (const dRaDeg of [-1, -0.5, 0, 0.5, 1]) {
        for (const dDec of [-0.8, 0, 0.8]) {
            const raH = ra0 + (dRaDeg / 15), decD = dec0 + dDec;
            const g = projectGnomonic(raH, decD, ra0, dec0)!;
            const { x, y } = map(g.xi, g.eta);
            out.push({ raHours: raH, decDeg: decD, x, y });
        }
    }
    return out;
}

describe('fitSkyToPixelAffine', () => {
    const ra0 = 10, dec0 = 20;
    // A deliberately flipped/rotated map to prove no parity sign is assumed.
    const known = (xi: number, eta: number) => ({ x: 1500 - 900 * xi + 40 * eta, y: 1000 + 30 * xi + 880 * eta });

    it('recovers a known affine to sub-pixel RMS and validates', () => {
        const matches = syntheticMatches(ra0, dec0, known);
        const m = fitSkyToPixelAffine(matches, ra0, dec0, { diagPx: Math.hypot(3000, 2000) });
        expect(m.valid).toBe(true);
        expect(m.rmsPx!).toBeLessThan(1e-6);
        // A held-out point reprojects onto the same map.
        const g = projectGnomonic(10.2, 20.3, ra0, dec0)!;
        const p = m.project(10.2, 20.3)!;
        expect(p.x).toBeCloseTo(known(g.xi, g.eta).x, 4);
        expect(p.y).toBeCloseTo(known(g.xi, g.eta).y, 4);
    });

    it('withholds (valid=false) when there are too few correspondences', () => {
        const matches = syntheticMatches(ra0, dec0, known).slice(0, 4);
        const m = fitSkyToPixelAffine(matches, ra0, dec0, { minMatches: 6, diagPx: 3600 });
        expect(m.valid).toBe(false);
        expect(m.project(10.1, 20.1)).toBeNull();
    });

    it('withholds when the residual exceeds the fraction-of-diagonal gate', () => {
        const matches = syntheticMatches(ra0, dec0, known);
        // Corrupt one sample so the affine can no longer fit tightly.
        matches[0] = { ...matches[0], x: matches[0].x + 5000, y: matches[0].y - 5000 };
        const m = fitSkyToPixelAffine(matches, ra0, dec0, { diagPx: 3600, maxRmsFrac: 0.001 });
        expect(m.valid).toBe(false);
    });
});

// ─── name resolution ────────────────────────────────────────────────────────

// Positions deliberately OFF the syntheticMatches grid nodes (raH ∈ {9.933,9.967,
// 10,10.033,10.067}, decD ∈ {19.2,20,20.8}) so they never accidentally anchor to a
// grid point — anchoring is exercised only via an explicitly injected matched star.
const NAMED: NamedStar[] = [
    { proper: 'Alpha', bayer: 'α Tst', ra_hours: 10.01667, dec_degrees: 20.4, mag: 0.5 },
    { proper: 'Beta', bayer: 'β Tst', ra_hours: 9.98333, dec_degrees: 19.6, mag: 1.8 },
];

describe('resolveNamedLabels', () => {
    const ra0 = 10, dec0 = 20;
    const known = (xi: number, eta: number) => ({ x: 1000 + 800 * xi, y: 800 + 800 * eta });
    const matches = syntheticMatches(ra0, dec0, known);

    it('anchors a name to a matched atlas star within tolerance (label at the atlas xy)', () => {
        // Inject a matched star ~1 arcsec from "Alpha" — the closest atlas star to it.
        const near: MatchedSample = { raHours: 10.01667 + 1 / 3600 / 15, decDeg: 20.4, x: 1234, y: 567 };
        const r = resolveNamedLabels([...matches, near], NAMED, { w: 2000, h: 1600 }, { ra0Hours: ra0, dec0Deg: dec0 });
        const alpha = r.anchored.find(a => a.proper === 'Alpha');
        expect(alpha).toBeDefined();
        expect(alpha!.source).toBe('anchored');
        expect(alpha!.x).toBe(1234);          // anchored to the ATLAS star position, not a projection
        expect(alpha!.y).toBe(567);
        expect(alpha!.sepDeg!).toBeLessThan(0.05);
        expect(r.anchored.find(a => a.proper === 'Beta')).toBeUndefined(); // no matched star near Beta
    });

    it('predicts un-anchored in-footprint names via the validated map, labelled predicted', () => {
        const r = resolveNamedLabels(matches, NAMED, { w: 2000, h: 1600 }, { ra0Hours: ra0, dec0Deg: dec0 });
        expect(r.map.valid).toBe(true);
        // Neither named star is co-located with a matched star ⇒ both predicted (both in frame).
        expect(r.anchored).toHaveLength(0);
        expect(r.predicted.length).toBeGreaterThanOrEqual(1);
        expect(r.predicted.every(p => p.source === 'predicted')).toBe(true);
    });

    it('withholds the predicted layer entirely when the map cannot validate', () => {
        const r = resolveNamedLabels(matches.slice(0, 4), NAMED, { w: 2000, h: 1600 }, { ra0Hours: ra0, dec0Deg: dec0 });
        expect(r.map.valid).toBe(false);
        expect(r.predicted).toHaveLength(0);   // honest-absent, never guessed
    });

    it('culls predicted names that fall outside the frame footprint', () => {
        // Frame far too small: projected names land outside ⇒ no predicted labels.
        const r = resolveNamedLabels(matches, NAMED, { w: 5, h: 5 }, { ra0Hours: ra0, dec0Deg: dec0 });
        expect(r.predicted).toHaveLength(0);
    });
});

describe('labelText', () => {
    it('prefers the proper name, falls back to Bayer', () => {
        expect(labelText({ proper: 'Vega', bayer: 'α Lyr', ra_hours: 0, dec_degrees: 0, mag: 0 })).toBe('Vega');
        expect(labelText({ proper: '', bayer: 'α Lyr', ra_hours: 0, dec_degrees: 0, mag: 0 })).toBe('α Lyr');
    });
});

// ─── declutter ──────────────────────────────────────────────────────────────

const LAYOUT_CFG = { charW: 4, lineH: 8, padX: 2, markerR: 2, maxLabels: 40 };

/** Reconstruct a placed label's AABB from its output + the SAME layout config. */
function boxOf(pl: { text: string; lx: number; ly: number; align: string }) {
    const w = pl.text.length * LAYOUT_CFG.charW + 2 * LAYOUT_CFG.padX;
    const x0 = pl.align === 'start' ? pl.lx : pl.align === 'end' ? pl.lx - w : pl.lx - w / 2;
    return { x0, y0: pl.ly - LAYOUT_CFG.lineH * 0.82, x1: x0 + w, y1: pl.ly + LAYOUT_CFG.lineH * 0.18 };
}
const boxesOverlap = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
    a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

const cand = (text: string, x: number, y: number, mag: number, source: 'anchored' | 'predicted'): LabelCandidate =>
    ({ text, proper: text, bayer: text, x, y, mag, source });

describe('layoutLabels declutter', () => {
    const view = { w: 100, h: 100, vw: 100, vh: 100 };

    it('is deterministic (identical output for identical input)', () => {
        const cands = [cand('A', 10, 10, 1, 'anchored'), cand('B', 50, 50, 2, 'predicted'), cand('C', 80, 20, 0.5, 'anchored')];
        const a = layoutLabels(cands, view, LAYOUT_CFG);
        const b = layoutLabels(cands, view, LAYOUT_CFG);
        expect(a).toEqual(b);
    });

    it('never lets two placed labels overlap', () => {
        // A dense pile of candidates around one region.
        const cands: LabelCandidate[] = [];
        for (let i = 0; i < 20; i++) cands.push(cand(`S${i}`, 45 + (i % 5), 45 + Math.floor(i / 5), i * 0.1, 'predicted'));
        const { placed } = layoutLabels(cands, view, LAYOUT_CFG);
        for (let i = 0; i < placed.length; i++)
            for (let j = i + 1; j < placed.length; j++)
                expect(boxesOverlap(boxOf(placed[i]), boxOf(placed[j])), `${placed[i].text}×${placed[j].text}`).toBe(false);
    });

    it('drops labels it cannot place without overlap (labels never overlap ⇒ some dropped)', () => {
        // Many identical positions: only a few slots fit; the rest are dropped.
        const cands = Array.from({ length: 12 }, (_, i) => cand(`X${i}`, 50, 50, i, 'predicted'));
        const { placed, dropped } = layoutLabels(cands, view, LAYOUT_CFG);
        expect(placed.length + dropped).toBe(12);
        expect(dropped).toBeGreaterThan(0);
    });

    it('places the preferred slot without a leader; offset slots draw a leader', () => {
        const two = layoutLabels([cand('Lonely', 20, 20, 1, 'anchored')], view, LAYOUT_CFG);
        expect(two.placed[0].leader).toBe(false);         // first (preferred) slot, no leader
        // Two labels forced onto the same marker ⇒ the second must use an offset slot.
        const stacked = layoutLabels([cand('First', 50, 50, 0, 'anchored'), cand('Second', 50, 50, 1, 'anchored')], view, LAYOUT_CFG);
        expect(stacked.placed).toHaveLength(2);
        expect(stacked.placed[1].leader).toBe(true);
    });

    it('prioritizes anchored before predicted, then brighter first', () => {
        const ordered = prioritize([
            cand('dimAnchored', 0, 0, 3, 'anchored'),
            cand('brightPredicted', 0, 0, 0, 'predicted'),
            cand('brightAnchored', 0, 0, 0.5, 'anchored'),
        ]);
        expect(ordered.map(c => c.text)).toEqual(['brightAnchored', 'dimAnchored', 'brightPredicted']);
    });
});

// ─── selector: honest-or-absent ─────────────────────────────────────────────

describe('selectStarLabels', () => {
    it('null when no solution / no matched stars (NOT MEASURED)', () => {
        expect(selectStarLabels(null)).toBeNull();
        expect(selectStarLabels({})).toBeNull();
        expect(selectStarLabels({ solution: null })).toBeNull();
        expect(selectStarLabels({ solution: { matched_stars: [] } })).toBeNull();
        // Stars without pixel positions contribute no markers ⇒ still NOT MEASURED.
        expect(selectStarLabels({ solution: { matched_stars: [{ ra_deg: 150, dec_deg: 20 }] } })).toBeNull();
    });

    it('returns the star field + counts when a solution is present', () => {
        const matched_stars = Array.from({ length: 8 }, (_, i) => ({
            ra_deg: 150 + i * 0.02, dec_deg: 20 + i * 0.02, x: 100 + i * 10, y: 200 + i * 8,
        }));
        const d = selectStarLabels({
            solution: { ra_hours: 10, dec_degrees: 20, matched_stars },
            metadata: { width: 1000, height: 800 },
        });
        expect(d).not.toBeNull();
        expect(d!.matchedCount).toBe(8);
        expect(d!.markers).toHaveLength(8);
        expect(d!.w).toBe(1000);
        expect(d!.h).toBe(800);
    });

    it('the bundled reference list is non-trivial and well-formed', () => {
        expect(NAMED_STARS.length).toBeGreaterThanOrEqual(100);
        for (const s of NAMED_STARS) {
            expect(s.ra_hours).toBeGreaterThanOrEqual(0);
            expect(s.ra_hours).toBeLessThan(24);
            expect(Math.abs(s.dec_degrees)).toBeLessThanOrEqual(90);
            expect(s.proper.length + s.bayer.length).toBeGreaterThan(0);
        }
    });
});
