// ═══════════════════════════════════════════════════════════════════════════
// MEASURED A/B — engine Brown-Conrady refit on the REAL bundled CR2 (evidence rig)
// ═══════════════════════════════════════════════════════════════════════════
//
//   npx vitest run -c tools/dslr/uw_harness.config.ts tools/dslr/bc_refit_ab.uwspec.ts
//
// Drives the PORTED engine modules (m2_hardware/lens_distortion_refit +
// lens_distortion_rematch) with the REAL measured pair data of the bundled
// beach CR2 (RA 17.5858h / 63.211"/px / 55 matched — the sacred blind solve):
//
//   FIXTURE A (test_results/psf/astrometry_beach_cr2_cubic_only.json):
//     the receipt's 55 SOLVER-VERIFIED pairs (controlPoints: undistorted
//     rectilinear projection x,y + measured displacement dx,dy). This is
//     exactly what the engine's always-on observation consumes in step5.
//   FIXTURE B (test_results/psf/astrometry_beach_cr2.json):
//     the research lane's 237 EXPANDED real pairs (forced re-detection with
//     magnitude-tiered anti-chance pairing) — the densification ceiling data.
//
// Fixtures are LOCAL-ONLY (test_results/ is gitignored) — the spec SKIPS
// honestly when absent. Override the directory with CR2_ASTROMETRY_DIR.
//
// HONESTY CAVEATS (stated up front, mirrored in the handoff):
//   - The densification A/B detections are the research lane's MEASURED
//     centroids (one per catalog star). It measures the coordinate-side
//     recovery mechanism — how many real displaced edge stars a BC-informed
//     match recovers vs the rectilinear baseline under the SAME fixed net —
//     NOT the full solver rematch against the frame's ~120k junk peaks (that
//     anti-chance machinery lives in the research tool's pairing tiers).
//   - The wrong-sign BC control is the false-match guard: genuine radial
//     signal recovers under the correct sign only; chance recovers ~equally.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fitBrownConrady, type DistortionPair } from '../../src/engine/pipeline/m2_hardware/lens_distortion_refit';
import { measureEdgeRecovery, bcInformedRematch, type IdentifiedPred } from '../../src/engine/pipeline/m2_hardware/lens_distortion_rematch';

const FIXTURE_DIR = process.env.CR2_ASTROMETRY_DIR
    ?? path.resolve(process.cwd(), 'test_results', 'psf');
const CUBIC_PATH = path.join(FIXTURE_DIR, 'astrometry_beach_cr2_cubic_only.json');
const REFIT_PATH = path.join(FIXTURE_DIR, 'astrometry_beach_cr2.json');
const HAVE = fs.existsSync(CUBIC_PATH) && fs.existsSync(REFIT_PATH);

// Solver base verify net at this scale (the FIXED px net the narrow matcher
// uses; the UW path inflates it with a radius slope precisely BECAUSE the
// rectilinear prediction drifts at the edge — the drift BC explains).
const TOL_PX = 15;

interface ControlPoint { x: number; y: number; dx: number; dy: number; }

function loadPairs(file: string): { pairs: DistortionPair[]; cx: number; cy: number; hd: number; cps: ControlPoint[]; doc: any } {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [w, h] = doc.provenance.image_dims as [number, number];
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const hd = Math.hypot(cx, cy);
    const cps = doc.distortion.controlPoints as ControlPoint[];
    const pairs: DistortionPair[] = cps.map((c) => {
        const xn = (c.x - cx) / hd, yn = (c.y - cy) / hd;
        return { xn, yn, dx: c.dx / hd, dy: c.dy / hd, ru: Math.hypot(xn, yn), w: 1 };
    });
    return { pairs, cx, cy, hd, cps, doc };
}

describe.skipIf(!HAVE)('engine BC refit on the REAL bundled CR2 (measured A/B)', () => {
    it('55 solver-verified pairs: fits cubic-only k1, REFUSES the quintic (coverage), reduces the residual', () => {
        const { pairs, cx, cy, hd, doc } = loadPairs(CUBIC_PATH);
        expect(pairs.length).toBe(55);

        const r = fitBrownConrady(pairs, [cx, cy], hd);
        expect(r.not_measured).toBeUndefined();

        // Coverage discipline on the REAL sample: rmax 0.574 < 0.8 → k2 refused,
        // 55 pairs cluster azimuthally → tangential refused (same verdicts the
        // research tool reached on this data).
        expect(r.coverage_refused.k2).toBe(true);
        expect(r.k2).toBeNull();
        expect(r.coverage_refused.tangential).toBe(true);
        expect(r.decentering_confound_warning).toBeTruthy();

        // Same physical answer as the research cubic-only fit (k1=+0.03615 with
        // only the scale absorber; ours adds tx/ty/rot → close, not identical).
        expect(r.k1).toBeGreaterThan(0.02);
        expect(r.k1).toBeLessThan(0.05);

        // The fit EXPLAINS real residual: 2D rms under {absorbers+k1} strictly
        // below the lens-free {absorbers-only} baseline on the SAME pairs.
        expect(r.baseline_rms_2d_px).not.toBeNull();
        expect(r.rms_2d_px).toBeLessThan(r.baseline_rms_2d_px!);

        console.log('[AB/55] MEASURED engine fit:', JSON.stringify({
            k1: r.k1, k2: r.k2, terms: r.terms,
            rms_2d_px: r.rms_2d_px, baseline_rms_2d_px: r.baseline_rms_2d_px,
            radial_rms_px: r.radial_residual_rms_px, tangential_rms_px: r.tangential_residual_rms_px,
            r_max: r.r_max_sampled, n_used: r.n_used,
            research_reference: { k1: doc.distortion.k1, radial_before: doc.distortion.fit.radial_rms_before_px, radial_after: doc.distortion.fit.radial_rms_after_px },
        }));
    });

    it('237 expanded pairs: coverage ADMITS k2+tangential; coefficients agree with the research fit', () => {
        const { pairs, cx, cy, hd, doc } = loadPairs(REFIT_PATH);
        expect(pairs.length).toBe(237);

        const r = fitBrownConrady(pairs, [cx, cy], hd);
        expect(r.not_measured).toBeUndefined();
        // rmax 0.89 ≥ 0.8 with body beyond 0.6 → quintic admitted; 6/8 octants
        // ≥15 → tangential admitted (identical gating verdicts to the tool).
        expect(r.coverage_refused.k2).toBe(false);
        expect(r.terms).toContain('p1');

        // Port fidelity on REAL data: research k1=0.0332337±0.009158 (weighted;
        // ours unweighted uniform → close within the quoted sigma).
        const ref = doc.distortion.fit.coefficients;
        expect(Math.abs(r.k1 - ref.k1.value)).toBeLessThan(ref.k1.sigma);
        expect(Math.abs((r.k2 ?? 0) - ref.k2.value)).toBeLessThan(ref.k2.sigma * 2);

        console.log('[AB/237] MEASURED engine fit:', JSON.stringify({
            k1: r.k1, k2: r.k2, terms: r.terms,
            rms_2d_px: r.rms_2d_px, baseline_rms_2d_px: r.baseline_rms_2d_px,
            research_reference: { k1: ref.k1, k2: ref.k2, rms_2d: doc.distortion.fit.rms_2d_px, baseline_cubic: doc.distortion.fit.baseline_cubic_rms_2d_px },
            mustache: r.mustache,
        }));
    });

    it('densification A/B: BC-informed matching recovers real edge stars the rectilinear baseline misses (wrong-sign guard)', () => {
        const { pairs, cx, cy, hd, cps } = loadPairs(REFIT_PATH);
        const fit = fitBrownConrady(pairs, [cx, cy], hd);
        expect(fit.not_measured).toBeUndefined();

        const w = Math.round(cx * 2 + 1), h = Math.round(cy * 2 + 1);
        // predictions = REAL rectilinear catalog projections; detections = REAL
        // measured centroids (prediction + measured displacement).
        const predictions = cps.map((c) => ({ x: c.x, y: c.y }));
        const detections = cps.map((c) => ({ x: c.x + c.dx, y: c.y + c.dy }));

        const ab = measureEdgeRecovery(
            detections, predictions,
            fit.k1, fit.k2 ?? 0,
            w, h, TOL_PX, 0.6,
        );

        console.log('[AB/densify] MEASURED edge recovery:', JSON.stringify(ab));

        // The mechanism must not LOSE matches vs baseline under the same net.
        expect(ab.bc.matched).toBeGreaterThanOrEqual(ab.baseline.matched);
        // MEASURED verdicts (pinned from the first evidence run — see handoff):
        // real displaced edge stars recovered under the correct sign…
        expect(ab.edge_recovered).toBeGreaterThan(0);
        // …and NOT under the negated sign (false-match guard).
        expect(ab.false_guard.passes).toBe(true);
        // Recovered edge matches land inside the SAME net (never looser).
        expect(ab.residual_rms_recovered_px).toBeLessThan(TOL_PX);
    });

    it('PRIMARY rail (bcInformedRematch): CR2 PASSES the wrong-sign guard — the discriminator that KEEPS well-corrected SeeStar but APPLIES on real ultra-wide distortion', () => {
        const { pairs, cx, cy, hd, cps } = loadPairs(REFIT_PATH);
        const fit = fitBrownConrady(pairs, [cx, cy], hd);
        expect(fit.not_measured).toBeUndefined();

        const w = Math.round(cx * 2 + 1), h = Math.round(cy * 2 + 1);
        // Rectilinear catalog predictions with identity; detections = pred + real
        // measured displacement (the distorted native positions).
        const predictions: IdentifiedPred[] = cps.map((c, i) => ({ x: c.x, y: c.y, gaia_id: `cr2_${i}`, ra_hours: 0, dec_degrees: 0, mag: null }));
        const detections = cps.map((c) => ({ x: c.x + c.dx, y: c.y + c.dy, fwhm: 3 }));
        // "Already matched" = the central stars (the center-biased original solve
        // sacred 55) — recovery is the EDGE densification the rail exists to add.
        const centralGaia = new Set(
            predictions.filter(p => Math.hypot((p.x - cx) / hd, (p.y - cy) / hd) <= 0.6).map(p => p.gaia_id),
        );

        const r = bcInformedRematch({
            detections, predictions, k1: fit.k1, k2: fit.k2 ?? 0,
            w, h, tolPx: TOL_PX, originalMatchedGaia: centralGaia, edgeRuThreshold: 0.6,
        });

        console.log('[AB/primary] bcInformedRematch CR2:', JSON.stringify({
            recovered: r.recovered.length, edge_recovered: r.edge_recovered,
            edge_bc: r.edge_bc, edge_baseline: r.edge_baseline, wrong_matched: r.wrong_matched,
            false_guard_passes: r.false_guard_passes,
        }));

        // Real ultra-wide radial distortion recovers edge stars NOT already in the
        // solution, and the correct BC sign strictly beats the negated control →
        // the primary rail's APPLIED gate PASSES on CR2 (it KEPT the SeeStar solve).
        expect(r.recovered.length).toBeGreaterThan(0);
        expect(r.edge_recovered).toBeGreaterThan(0);
        expect(r.false_guard_passes).toBe(true);
        expect(r.recovered.every(rec => !centralGaia.has(rec.gaia_id))).toBe(true);
    });
});
