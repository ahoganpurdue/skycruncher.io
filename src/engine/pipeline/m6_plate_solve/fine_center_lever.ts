// ═══════════════════════════════════════════════════════════════════════════
// FINE-CENTER LEVER — pure coordinate-ledger helpers (ultra-wide anchor mode)
// ═══════════════════════════════════════════════════════════════════════════
//
// The ultra-wide anchored rotation sweep PINS translation (sky center := the
// anchor's assumed position) instead of fitting it, so it only fires when a
// search center lands within ~0.5° of the true anchor. Measured: an 0.8° center
// error collapsed the true peak 8.5σ → 2.4σ (docs/CR2_SOLVER_FINDINGS.md §2a).
// The blind center list is D5-pruned to ~6° spacing and carries one ephemeris
// point per planet, so it routinely misses by more than the sweep can absorb.
//
// LEVER: lay a fine local grid around each bright anchor (planets from real
// ephemeris + the bundled classic bright-star list — Gaia saturates at the
// bright end) and try those centers FIRST. Pure evidence-add: it only widens
// the center list, changes no gate. Ultra-wide only; the caller gates on FOV so
// narrow fields (SeeStar) are byte-identical.
//
// Everything here is PURE (no wasm, no IO) so it is deterministic and unit-
// testable in isolation.

export interface AnchorCenter {
    ra: number;   // hours
    dec: number;  // degrees
    name?: string;
    /** lower = spend budget first (planets/brightest lead) */
    priority?: number;
}

export interface FineCenter {
    ra: number;   // hours
    dec: number;  // degrees
    name: string;
    /** true → a lever-generated speculative center (subject to winner-dominance) */
    lever: true;
}

/** Great-circle separation (degrees) between two sky points given RA in HOURS, Dec in DEG. Pure JS — no wasm. */
export function angularSepDeg(ra1H: number, dec1D: number, ra2H: number, dec2D: number): number {
    const D2R = Math.PI / 180;
    const a1 = ra1H * 15 * D2R, d1 = dec1D * D2R;
    const a2 = ra2H * 15 * D2R, d2 = dec2D * D2R;
    const cosSep = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2);
    return Math.acos(Math.max(-1, Math.min(1, cosSep))) / D2R;
}

/**
 * Collapse anchors that sit within `dedupDeg` of an already-kept anchor. Keeps
 * the earliest (highest-priority) one. This makes the lever robust to a caller
 * that already injected a dense grid of priors (e.g. the harness planet-grid):
 * without it, each grid point would spawn its own full sub-grid.
 */
export function dedupeAnchors(anchors: AnchorCenter[], dedupDeg: number): AnchorCenter[] {
    const kept: AnchorCenter[] = [];
    const ordered = [...anchors].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    for (const a of ordered) {
        if (!Number.isFinite(a.ra) || !Number.isFinite(a.dec)) continue;
        const clash = kept.some(k => angularSepDeg(k.ra, k.dec, a.ra, a.dec) < dedupDeg);
        if (!clash) kept.push(a);
    }
    return kept;
}

/**
 * Center-out fine grid around one anchor: offsets over ±halfDeg at stepDeg,
 * ordered nearest-to-anchor first so the true peak (within the measured ~0.8°
 * tolerance) is reached early even when the blind budget cuts the sweep short.
 * RA offset is /cos(dec) so the grid is uniform on the sky.
 */
export function fineGridAround(anchor: AnchorCenter, halfDeg: number, stepDeg: number): FineCenter[] {
    const cosd = Math.cos(anchor.dec * Math.PI / 180) || 1e-6;
    const pts: { ra: number; dec: number; r: number; ddec: number; dra: number }[] = [];
    for (let dd = -halfDeg; dd <= halfDeg + 1e-9; dd += stepDeg) {
        for (let dr = -halfDeg; dr <= halfDeg + 1e-9; dr += stepDeg) {
            pts.push({
                ra: anchor.ra + (dr / 15) / cosd,
                dec: anchor.dec + dd,
                r: Math.hypot(dr, dd),
                ddec: dd, dra: dr,
            });
        }
    }
    pts.sort((a, b) => a.r - b.r);
    const nm = anchor.name ?? 'anchor';
    return pts.map(p => ({ ra: p.ra, dec: p.dec, name: `${nm}~fine`, lever: true as const }));
}

/**
 * Build the full lever center list: dedupe anchors, grid each (priority order),
 * cap the total. Planets/brightest anchors lead so a budget-bounded sweep spends
 * its allowance on the most likely anchor first.
 */
export function buildFineCenters(
    anchors: AnchorCenter[],
    halfDeg: number,
    stepDeg: number,
    maxCenters: number,
    dedupDeg: number,
): FineCenter[] {
    const kept = dedupeAnchors(anchors, dedupDeg);
    const out: FineCenter[] = [];
    for (const a of kept) {
        if (out.length >= maxCenters) break;
        for (const c of fineGridAround(a, halfDeg, stepDeg)) {
            if (out.length >= maxCenters) break;
            out.push(c);
        }
    }
    return out;
}

/**
 * SUN-PROXIMITY VETO. A night-sky exposure cannot point within a few tens of
 * degrees of the Sun, so an accepted center that lands there is impossible
 * (day-side planet graze, or a chance lock at a physically-forbidden pointing —
 * the IMG_1414-class false positive). Needs only a trusted timestamp; it is
 * location-independent (solar RA/Dec, negligible parallax). Returns true = VETO.
 * Without a sun position (no trusted clock) it never vetoes — honest, not fake.
 *
 * DAYTIME BYPASS (`daytimeConfirmed`): a genuine daytime / solar capture DOES
 * legitimately point near the Sun, so the veto must not reject it. This is an
 * ADD-ONLY exception: it fires only when the caller has POSITIVELY confirmed the
 * frame was shot in daylight (Sun above the horizon — which needs a trusted clock
 * AND a real observer site, since altitude is meaningless otherwise). The default
 * (`undefined`/`false`) is unchanged: night frames near the Sun are still vetoed
 * exactly as before. Never infer daytime from absence of evidence — absent a
 * positive confirmation the veto stays armed (the overwhelming night-frame case).
 */
export function isSunVetoed(
    crvalRaHours: number,
    crvalDecDeg: number,
    sun: { ra_hours: number; dec_degrees: number } | null | undefined,
    vetoDeg: number,
    daytimeConfirmed?: boolean,
): boolean {
    if (daytimeConfirmed) return false; // confirmed daylight capture ⇒ near-Sun pointing is legitimate
    if (!sun) return false;
    return angularSepDeg(crvalRaHours, crvalDecDeg, sun.ra_hours, sun.dec_degrees) < vetoDeg;
}

/**
 * WINNER-DOMINANCE (lever centers only). A real anchored solve has ONE correct
 * rotation that dominates the sweep; a chance alignment shows several comparable
 * orientations (the IMG_1576-class marginal +5.9σ/13-match "lock" is one such
 * flat spectrum just over the gate). Given the sweep's per-orientation scores,
 * require the peak orientation to beat its best angularly-DISTANT runner-up by
 * `marginZ` sweep-sigma. `sepDeg` excludes a window around the peak (and its
 * near neighbours, which score high for the same true orientation) so the
 * runner-up is a genuinely different pointing hypothesis.
 *
 * Returns { dominant, runnerUpM, runnerUpZ } — dominant=true ⇒ may proceed to
 * verify. This ADDS evidence for the lever's speculative centers; it does not
 * touch the base sweep gate (SOLVER_UW_SWEEP_MIN_Z) at all.
 */
export function orientationDominance(
    scores: { theta: number; parity: number; m: number }[],
    peak: { theta: number; parity: number; m: number },
    nullMean: number,
    nullStd: number,
    sepDeg: number,
    marginZ: number,
): { dominant: boolean; runnerUpM: number; runnerUpZ: number } {
    const std = nullStd || 1;
    let runnerUpM = -Infinity;
    for (const s of scores) {
        // angular distance between orientation angles on the 360° circle
        let dTheta = Math.abs(s.theta - peak.theta) % 360;
        if (dTheta > 180) dTheta = 360 - dTheta;
        const samePeakLobe = s.parity === peak.parity && dTheta < sepDeg;
        if (samePeakLobe) continue; // exclude the peak's own lobe
        if (s.m > runnerUpM) runnerUpM = s.m;
    }
    if (!Number.isFinite(runnerUpM)) runnerUpM = nullMean; // no distinct runner-up ⇒ peak stands alone
    const peakZ = (peak.m - nullMean) / std;
    const runnerUpZ = (runnerUpM - nullMean) / std;
    return { dominant: (peakZ - runnerUpZ) >= marginZ, runnerUpM, runnerUpZ };
}
