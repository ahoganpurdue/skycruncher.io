/**
 * GREENFIELD WIDGETS — pure logic tests (node env, no DOM).
 *
 * Covers the honesty-critical render-plane paths for the three greenfield widgets:
 *  - normalizer: bare receipt AND solution.greenfield_receipt; honest absence → null
 *  - consensus SANE gate: sane rows kept, junk (huge offset / off-scale / big residual) rejected
 *  - stats selector: null on absence; real fields surfaced
 *  - sky→pixel projection: crval→crpix exact; project/unproject round-trip to sub-µpx
 *  - replay synthesis: deterministic; candidate/failed synthesized (real=false);
 *    accepted/corroborated + accepted field REAL (real=true) and SANE-only
 *  - graticule: non-empty, in-frame segments; named-star projection in-frame
 *
 * Fixtures are inline (real CSM30799 WCS numbers) — no external/corpus dependency.
 */

import { describe, it, expect } from 'vitest';
import {
    normalizeGreenfieldReceipt, buildSkyToPixel, matchedDetPositions, detPos,
} from '../ui/widgets/data/greenfield_receipt';
import { selectGreenfieldStats } from '../ui/widgets/widgets/GreenfieldSolveStatsWidget';
import { selectGreenfieldReplay } from '../ui/widgets/widgets/GreenfieldReplayWidget';
import { selectGreenfieldSkyOverlays } from '../ui/widgets/widgets/GreenfieldSkyOverlaysWidget';
import { synthesizeReplayStream, seedFromDigest } from '../ui/widgets/data/replay_stream';
import { buildGraticule, projectNamedStars, niceStepDeg } from '../ui/widgets/data/sky_overlays';
import { NAMED_STARS } from '../ui/widgets/data/named_stars';

// ─── inline fixture (real CSM30799 WCS; small synthetic detection/quad set) ──

const WCS = {
    crval: { ra: 207.013045588093, dec: -59.73526279040877 },
    crpix: { x: 2898, y: 1935 },
    cd: [[-0.0012054301069555648, 0.014883985296476283], [-0.014903302859271956, -0.0012147942942778503]],
};

// 10 detections; ids 0..3 form the sane quad corners, 4..7 the junk quad, plus 8,9.
const DETECTIONS = {
    detections: [
        { x: 2878, y: 1218 }, { x: 2981, y: 2366 }, { x: 3278, y: 1335 }, { x: 2936, y: 2068 },
        { x: 3353, y: 879 }, { x: 4599, y: 653 }, { x: 3644, y: 1178 }, { x: 3564, y: 368 },
        { x: 2900, y: 1900 }, { x: 3000, y: 2000 },
    ],
};

function bareReceipt() {
    return {
        decision_digest: 'deadbeefcafe0001',
        decision: {
            frame_id: 'CSM30799.CR2', classification: 'Blind',
            prep: { raw: 29569, valid: 29569, deduped: 55, pool: 29514, peak_arm_promoted: 2740 },
            search_truncated: true,
            search: {
                per_band: {
                    0: { det_quads: 0, probes: 0, raw_hits: 0, proposals: 0, verified: 0, bailed: 0 },
                    13: { det_quads: 0, probes: 0, raw_hits: 0, proposals: 0, verified: 0, bailed: 0 },
                    14: { det_quads: 1285, probes: 1191150, raw_hits: 321, proposals: 3, verified: 3, bailed: 2 },
                },
            },
            result: {
                state: 'Solved',
                solved: {
                    wcs: WCS, scale_arcsec_px: 53.79379311353426, parity_sign: 1,
                    band: 14, rung: 0, hypothesis_seq: 8,
                    final_verify: { log_odds: 290.27, final_odds: 283.16, n_matched: 156, n_distractor: 237, n_conflict: 3, n_test: 396, n_ref: 396, eff_area: 22430520, besti: 373, best_worst: -6.01, bailed_at: -1, stopped_at: -1 },
                    matches: [
                        { det_id: 0, star_row: 1, residual_x: -1.2, residual_y: 2.1, log_lr: 4.1, test_order: 3 },
                        { det_id: 1, star_row: 2, residual_x: 0.9, residual_y: -1.5, log_lr: 3.7, test_order: 5 },
                        { det_id: 2, star_row: 3, residual_x: 2.0, residual_y: 0.4, log_lr: 2.9, test_order: 6 },
                    ],
                },
            },
            index: { release_id: 'starplates-2026.07-quadidx-g15u', total_quads: 20962625, total_stars: 6491802, bands_present: 15, aggregate_md5: 'c6ce0418', verify_mode: 'STAMP' },
            build: { solver_core_version: '0.1.0' },
        },
        telemetry: {
            wall_ms: 205,
            stage_ms: { search: 45, star_grid: 113 },
            cache_state: { hit_order_policy: 'band-major: bands descending (coarse→fine)…' },
            per_band_probe_wall_ms: { 0: 0, 13: 0, 14: 25 },
            per_band_verify_wall_ms: { 0: 0, 13: 0, 14: 4 },
            freeze_events: [{ elapsed_ms: 44, outcome: 'Confirmed' }],
            search_aborted_on_accept: true, abort_elapsed_ms: 45,
            fine_consensus: {
                bands_tested: [13, 12, 11], candidates_coded: 67071, hits: 284, wall_ms: 233, capped: false,
                corroborating: [
                    { // SANE: small offset, scale≈1, tight residuals
                        band: 12, quad_span_px: 1152, pose_scale_ratio: 0.98, pose_rot_delta_deg: 0.07,
                        center_offset_arcsec: 378, log_odds: 22.0, n_matched: 12, parity: 0,
                        matched_rows: [
                            { det_id: 0, residual_x: -0.6, residual_y: -15.7 },
                            { det_id: 1, residual_x: 3.0, residual_y: 4.7 },
                            { det_id: 2, residual_x: 1.1, residual_y: -2.2 },
                            { det_id: 3, residual_x: -4.0, residual_y: 6.0 },
                        ],
                    },
                    { // JUNK: 85° offset, off-scale, thousands-px residuals
                        band: 12, quad_span_px: 1267, pose_scale_ratio: 0.67, pose_rot_delta_deg: -30.4,
                        center_offset_arcsec: 309152, log_odds: 23.8, n_matched: 9, parity: 1,
                        matched_rows: [
                            { det_id: 4, residual_x: -5124, residual_y: -2544 },
                            { det_id: 5, residual_x: -5362, residual_y: -271 },
                            { det_id: 6, residual_x: -3978, residual_y: -1450 },
                            { det_id: 7, residual_x: -7311, residual_y: -3098 },
                        ],
                    },
                ],
            },
        },
    };
}

// ─── normalizer ──────────────────────────────────────────────────────────────

describe('normalizeGreenfieldReceipt', () => {
    it('returns null on non-greenfield input', () => {
        expect(normalizeGreenfieldReceipt(null)).toBeNull();
        expect(normalizeGreenfieldReceipt({})).toBeNull();
        expect(normalizeGreenfieldReceipt({ solution: {} })).toBeNull();
    });

    it('normalizes a bare receipt (with attached detections)', () => {
        const gf = normalizeGreenfieldReceipt({ ...bareReceipt(), detections: DETECTIONS });
        expect(gf).not.toBeNull();
        expect(gf!.state).toBe('Solved');
        expect(gf!.digest).toBe('deadbeefcafe0001');
        expect(gf!.acceptBand).toBe(14);
        expect(gf!.wcs).not.toBeNull();
        expect(gf!.detections).toHaveLength(10);
        expect(gf!.matches).toHaveLength(3);
        // frame derived from detections extent (no metadata provided)
        expect(gf!.frame?.source).toBe('detections');
    });

    it('normalizes the seam-attached form (solution.greenfield_receipt)', () => {
        const gf = normalizeGreenfieldReceipt({ solution: { greenfield_receipt: bareReceipt() }, metadata: { width: 5796, height: 3870 } });
        expect(gf).not.toBeNull();
        expect(gf!.frame).toEqual({ width: 5796, height: 3870, source: 'metadata' });
        expect(gf!.detections).toBeNull(); // none attached ⇒ geometry honest-absent
    });

    it('per-band merge marks coded vs skipped honestly (never a fake zero)', () => {
        const gf = normalizeGreenfieldReceipt(bareReceipt())!;
        const b14 = gf.perBand.find(b => b.band === 14)!;
        const b13 = gf.perBand.find(b => b.band === 13)!;
        expect(b14.coded).toBe(true);
        expect(b14.probes).toBe(1191150);
        expect(b14.probeWallMs).toBe(25);
        expect(b13.coded).toBe(false); // never coded (accept abort)
    });
});

// ─── consensus SANE gate (the honesty filter) ───────────────────────────────

describe('consensus sanity gate', () => {
    it('keeps the sane corroboration and rejects the junk one', () => {
        const gf = normalizeGreenfieldReceipt({ ...bareReceipt(), detections: DETECTIONS })!;
        const corr = gf.fineConsensus!.corroborating;
        expect(corr).toHaveLength(2);
        const sane = corr.filter(c => c.sane);
        expect(sane).toHaveLength(1);
        expect(sane[0].centerOffsetArcsec).toBe(378);
        // the junk row (309152″ offset, thousands-px residual) is NEVER sane
        expect(corr.find(c => c.centerOffsetArcsec === 309152)!.sane).toBe(false);
        expect(corr.find(c => c.centerOffsetArcsec === 309152)!.medianResidualPx!).toBeGreaterThan(1000);
    });
});

// ─── stats selector ─────────────────────────────────────────────────────────

describe('selectGreenfieldStats', () => {
    it('null on absence, data when present', () => {
        expect(selectGreenfieldStats(null)).toBeNull();
        expect(selectGreenfieldStats({})).toBeNull();
        const d = selectGreenfieldStats(bareReceipt());
        expect(d).not.toBeNull();
        expect(d!.gf.finalVerify?.nMatched).toBe(156);
    });
});

// ─── sky → pixel projection ─────────────────────────────────────────────────

describe('buildSkyToPixel', () => {
    const gf = normalizeGreenfieldReceipt(bareReceipt())!;
    const proj = buildSkyToPixel(gf.wcs!);

    it('projects crval to crpix exactly', () => {
        const p = proj.project(WCS.crval.ra / 15, WCS.crval.dec)!;
        expect(p.x).toBeCloseTo(2898, 6);
        expect(p.y).toBeCloseTo(1935, 6);
    });

    it('project/unproject round-trips a pixel to sub-µpx', () => {
        for (const [x, y] of [[100, 200], [2898, 1935], [5000, 3000]]) {
            const s = proj.unproject(x, y);
            const back = proj.project(s.raHours, s.decDeg)!;
            expect(Math.hypot(back.x - x, back.y - y)).toBeLessThan(1e-6);
        }
    });
});

// ─── geometry helpers ───────────────────────────────────────────────────────

describe('detection geometry helpers', () => {
    const gf = normalizeGreenfieldReceipt({ ...bareReceipt(), detections: DETECTIONS })!;
    it('detPos resolves by raw array index and rejects out-of-range', () => {
        expect(detPos(gf, 0)).toEqual({ x: 2878, y: 1218 });
        expect(detPos(gf, 999)).toBeNull();
    });
    it('matchedDetPositions returns the real matched field (needs detections)', () => {
        expect(matchedDetPositions(gf)).toHaveLength(3);
        const noDet = normalizeGreenfieldReceipt(bareReceipt())!;
        expect(matchedDetPositions(noDet)).toHaveLength(0);
    });
});

// ─── replay synthesis (honesty contract) ────────────────────────────────────

describe('synthesizeReplayStream', () => {
    const gf = normalizeGreenfieldReceipt({ ...bareReceipt(), detections: DETECTIONS })!;

    it('is deterministic (seed from digest)', () => {
        const a = synthesizeReplayStream(gf);
        const b = synthesizeReplayStream(gf);
        expect(a).toEqual(b);
        expect(seedFromDigest('deadbeefcafe0001')).toBe(seedFromDigest('deadbeefcafe0001'));
    });

    it('candidate/failed are synthesized (real=false); accepted/corroborated are REAL (real=true)', () => {
        const s = synthesizeReplayStream(gf);
        const synth = s.events.filter(e => e.verdict === 'candidate' || e.verdict === 'failed');
        const real = s.events.filter(e => e.verdict === 'accepted' || e.verdict === 'corroborated');
        expect(synth.length).toBeGreaterThan(0);
        expect(synth.every(e => e.real === false)).toBe(true);
        expect(real.every(e => e.real === true)).toBe(true);
        // green geometry is SANE-only: exactly one sane corroboration ⇒ one real quad
        expect(real).toHaveLength(1);
        expect(real[0].verdict).toBe('accepted');
        // accepted field = real matched detections
        expect(s.acceptedFieldPx).toHaveLength(3);
    });

    it('only coded bands contribute synthesized candidates (skipped bands stay silent)', () => {
        const s = synthesizeReplayStream(gf);
        const bandsWithEvents = new Set(s.events.filter(e => !e.real).map(e => e.band));
        expect(bandsWithEvents.has(14)).toBe(true);
        expect(bandsWithEvents.has(13)).toBe(false); // never coded ⇒ no synthetic probes
    });

    it('emits no real green events when detections are absent (honest-absent)', () => {
        const noDet = normalizeGreenfieldReceipt(bareReceipt())!;
        const s = synthesizeReplayStream(noDet);
        expect(s.events.some(e => e.real)).toBe(false);
        expect(s.acceptedFieldPx).toHaveLength(0);
        expect(s.events.some(e => !e.real)).toBe(true); // candidates still play
    });
});

// ─── replay + sky-overlay selectors ─────────────────────────────────────────

describe('greenfield widget selectors', () => {
    it('selectGreenfieldReplay: null on absence; flags geometry availability', () => {
        expect(selectGreenfieldReplay(null)).toBeNull();
        const withDet = selectGreenfieldReplay({ ...bareReceipt(), detections: DETECTIONS })!;
        expect(withDet.hasGeometry).toBe(true);
        expect(withDet.isReal).toBe(false); // synthesized (no attached real stream)
        const noDet = selectGreenfieldReplay(bareReceipt())!;
        expect(noDet.hasGeometry).toBe(false);
    });

    it('selectGreenfieldReplay: a solver-attached real stream is used verbatim', () => {
        const realStream = { schema_version: '1.0.0', digest: 'x', synthesized: false, frame: { width: 100, height: 100 }, bands: [14], events: [], acceptedFieldPx: [[1, 2]], duration_ms: 10, note: 'real' };
        const d = selectGreenfieldReplay({ ...bareReceipt(), greenfield_replay_stream: realStream })!;
        expect(d.isReal).toBe(true);
        expect(d.stream.acceptedFieldPx).toEqual([[1, 2]]);
    });

    it('selectGreenfieldSkyOverlays: null without a WCS; overlays present with one', () => {
        expect(selectGreenfieldSkyOverlays({})).toBeNull();
        const d = selectGreenfieldSkyOverlays({ ...bareReceipt(), detections: DETECTIONS })!;
        expect(d.graticule.length).toBeGreaterThan(0);
        expect(d.named.length).toBeGreaterThan(0);
        expect(d.hasDetections).toBe(true);
        expect(d.altAzAvailable).toBe(false); // no trusted time+site
    });
});

// ─── graticule + named-star projection ──────────────────────────────────────

describe('sky overlays geometry', () => {
    const gf = normalizeGreenfieldReceipt(bareReceipt())!;
    const proj = buildSkyToPixel(gf.wcs!);
    const frame = gf.frame!;

    it('niceStepDeg picks a value ≥ the request from the ladder', () => {
        expect(niceStepDeg(17)).toBe(20);
        expect(niceStepDeg(0.2)).toBe(0.25);
        expect(niceStepDeg(0.01)).toBe(0.05);
    });

    it('buildGraticule produces in-frame ra + dec lines', () => {
        const { lines } = buildGraticule(proj, frame);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.some(l => l.kind === 'ra')).toBe(true);
        expect(lines.some(l => l.kind === 'dec')).toBe(true);
        const m = 0.02 * Math.max(frame.width, frame.height);
        for (const ln of lines) for (const seg of ln.segments) {
            expect(seg.length).toBeGreaterThanOrEqual(2);
            for (const [x, y] of seg) {
                expect(x).toBeGreaterThanOrEqual(-m); expect(x).toBeLessThanOrEqual(frame.width + m);
                expect(y).toBeGreaterThanOrEqual(-m); expect(y).toBeLessThanOrEqual(frame.height + m);
            }
        }
    });

    it('projectNamedStars keeps only in-frame stars', () => {
        const named = projectNamedStars(proj, NAMED_STARS, frame);
        expect(named.length).toBeGreaterThan(0);
        const m = 0.01 * Math.max(frame.width, frame.height);
        for (const c of named) {
            expect(c.x).toBeGreaterThanOrEqual(-m); expect(c.x).toBeLessThanOrEqual(frame.width + m);
            expect(c.y).toBeGreaterThanOrEqual(-m); expect(c.y).toBeLessThanOrEqual(frame.height + m);
        }
    });
});
