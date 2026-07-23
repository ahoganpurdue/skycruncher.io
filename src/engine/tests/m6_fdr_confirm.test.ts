import { describe, it, expect } from 'vitest';
import { mulberry32, type ForcedPosition } from '../pipeline/m6_plate_solve/deep_verify';
import { confirmForcedSet } from '../pipeline/m6_plate_solve/forced_confirm';
import { forcedMeasure, type ForcedMeasurement } from '../pipeline/m6_plate_solve/deep_verify';
import {
    wilsonLowerBound, empiricalRightTailP, benjaminiHochberg, computeFdrShadow,
} from '../pipeline/m6_plate_solve/fdr_confirm';
import { classifyConfirmStatus } from '../pipeline/m6_plate_solve/confirm_status';

/**
 * M6 FDR shadow (phase-1 confirm-statistic swap, owner ruling 2026-07-12). Locks
 * the N-invariant alternative that is computed ALONGSIDE the live set-excess gate:
 *   • Benjamini-Hochberg / Benjamini-Yekutieli step-up against textbook vectors
 *     (incl. the defining step-up property — an early-failing p is still rejected
 *     when a later rank passes);
 *   • Wilson score lower bound against a known closed-form value;
 *   • empirical right-tail p-value (+1/+1 correction);
 *   • effect-size rate ratio + Wilson-lower-bounded ratio;
 *   • FLAG-OFF BYTE-IDENTITY — confirmForcedSet with fdrShadow off carries NO
 *     fdr_shadow key and is field-for-field identical to the same call with it on
 *     (minus that additive block), so the pinned solves stay byte-identical.
 */

// ─── Benjamini-Hochberg / Yekutieli step-up ───────────────────────────────────

describe('FDR — Benjamini-Hochberg / Yekutieli step-up', () => {
    it('BH: textbook step-up rejects up to the LARGEST passing rank (incl. an earlier fail)', () => {
        // sorted p = [0.005, 0.025, 0.028, 0.031, 0.9]; thresholds i*0.01.
        //   i=1 0.005≤0.01✓ · i=2 0.025≤0.02✗ · i=3 0.028≤0.03✓ · i=4 0.031≤0.04✓ · i=5 0.9≤0.05✗
        // Largest passing i = 4 → reject the 4 smallest (INCLUDING the i=2 star
        // whose own threshold it failed — the step-up property).
        const p = [0.9, 0.005, 0.031, 0.025, 0.028]; // deliberately UNsorted
        const r = benjaminiHochberg(p, 0.05, 'none');
        expect(r.k).toBe(4);
        expect(r.correction).toBe(1);
        expect(r.pThreshold).toBeCloseTo(0.031, 12);
        expect(r.rejected).toEqual([false, true, true, true, true]);
    });

    it('BH: all-tiny p → reject all; all-large p → reject none', () => {
        expect(benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05], 0.05, 'none').k).toBe(5);
        expect(benjaminiHochberg([0.2, 0.3, 0.4], 0.05, 'none').k).toBe(0);
        expect(benjaminiHochberg([], 0.05, 'none').k).toBe(0);
    });

    it('BY: the H_N correction is strictly more conservative than BH on the same vector', () => {
        // Same vector as above. H_5 = 2.283333; thresh_1 = 0.01/H_5 = 0.004380 < 0.005
        // ⇒ NO rank passes ⇒ 0 rejected (vs BH=4).
        const p = [0.9, 0.005, 0.031, 0.025, 0.028];
        const r = benjaminiHochberg(p, 0.05, 'by');
        expect(r.correction).toBeCloseTo(1 + 1 / 2 + 1 / 3 + 1 / 4 + 1 / 5, 12);
        expect(r.k).toBe(0);
        expect(r.rejected.every(v => v === false)).toBe(true);
    });
});

// ─── Wilson score lower bound ──────────────────────────────────────────────────

describe('FDR — Wilson score lower bound', () => {
    it('matches the closed form at p̂=0.5, n=100 (≈0.4038)', () => {
        expect(wilsonLowerBound(50, 100)).toBeCloseTo(0.40383, 4);
    });
    it('clamps to [0,1] and widens with small n (honest at the extremes)', () => {
        const zero = wilsonLowerBound(0, 10);
        expect(zero).toBeGreaterThanOrEqual(0);
        expect(zero).toBeLessThan(0.001); // x=0 → lower bound essentially 0
        const full = wilsonLowerBound(10, 10);
        expect(full).toBeGreaterThan(0.6);
        expect(full).toBeLessThan(1); // never the fabricated 1.0
        expect(wilsonLowerBound(5, 0)).toBe(0); // no observations
    });
});

// ─── empirical right-tail p-value ─────────────────────────────────────────────

describe('FDR — empirical right-tail p-value (+1/+1)', () => {
    const pool = [0, 1, 2, 3, 4];
    it('a value beating every null draw scores 1/(M+1), never 0', () => {
        expect(empiricalRightTailP(5, pool)).toBeCloseTo(1 / 6, 12);
    });
    it('a value below the whole null scores 1', () => {
        expect(empiricalRightTailP(-1, pool)).toBe(1);
    });
    it('mid-value counts ties as ≥', () => {
        expect(empiricalRightTailP(2, pool)).toBeCloseTo(4 / 6, 12); // {2,3,4} ≥ 2
    });
    it('empty null → 1 (cannot distinguish signal from chance)', () => {
        expect(empiricalRightTailP(9, [])).toBe(1);
    });
});

// ─── computeFdrShadow ──────────────────────────────────────────────────────────

describe('FDR — computeFdrShadow', () => {
    it('separates a TRUE set (high SNRs vs a low-SNR null) — confirms under BY', () => {
        const candidateSnrs = Array.from({ length: 25 }, (_, i) => ({ x: i, y: 0, snr: 8 }));
        const nullSnrs = Array.from({ length: 200 }, (_, i) => (i / 100) - 1); // [-1, 1)
        const out = computeFdrShadow({ candidateSnrs, nullSnrs, realConfirmed: 24, nullRate: 0.02 });
        expect(out.method).toBe('BY'); // dependence-robust default
        expect(out.n_confirmed_fdr).toBe(25); // strong signal survives even the strict BY
        expect(out.per_star.every(s => s.confirmed)).toBe(true);
        expect(out.null_total).toBe(200);
    });

    it('collapses a NULL set (candidate SNRs indistinguishable from the null)', () => {
        const candidateSnrs = Array.from({ length: 25 }, (_, i) => ({ x: i, y: 0, snr: 1 }));
        const nullSnrs = Array.from({ length: 200 }, (_, i) => (i / 100) * 2); // [0, 4): ~half ≥ 1
        const out = computeFdrShadow({ candidateSnrs, nullSnrs, realConfirmed: 0, nullRate: 0.5 });
        expect(out.n_confirmed_fdr).toBe(0); // p ≈ 0.5 ≫ any BH/BY threshold
    });

    it('effect size = rate ratio p1/p0 with a Wilson lower bound on p1', () => {
        const candidateSnrs = Array.from({ length: 25 }, (_, i) => ({ x: i, y: 0, snr: 8 }));
        const nullSnrs = Array.from({ length: 50 }, () => 0);
        const out = computeFdrShadow({ candidateSnrs, nullSnrs, realConfirmed: 20, nullRate: 0.02 });
        expect(out.effect_size.p1).toBeCloseTo(0.8, 6);
        expect(out.effect_size.p0).toBeCloseTo(0.02, 6);
        expect(out.effect_size.rate_ratio).toBeCloseTo(40, 4);
        expect(out.effect_size.p1_wilson_lower).toBeCloseTo(0.6087, 3); // wilson(20,25)
        expect(out.effect_size.rate_ratio_wilson_lower!).toBeCloseTo(30.43, 1);
    });

    it('assigns 1-based ranks by ascending p-value', () => {
        const candidateSnrs = [
            { x: 0, y: 0, snr: 2 }, { x: 1, y: 0, snr: 9 }, { x: 2, y: 0, snr: 5 },
        ];
        const nullSnrs = Array.from({ length: 100 }, (_, i) => (i / 25) - 1); // [-1, 3)
        const out = computeFdrShadow({ candidateSnrs, nullSnrs, realConfirmed: 3, nullRate: 0.1, method: 'BH' });
        // highest SNR (9) → smallest p → rank 1; lowest SNR (2) → largest p → rank 3.
        const byX = new Map(out.per_star.map(s => [s.x, s.rank]));
        expect(byX.get(1)).toBe(1);
        expect(byX.get(2)).toBe(2);
        expect(byX.get(0)).toBe(3);
    });
});

// ─── flag-off byte-identity through confirmForcedSet ──────────────────────────

const W = 256, H = 256, BG = 0.125, SIGMA = 0.004;
const PSF_SIGMA = 1.5;
const FRAME_FWHM = 2.355 * PSF_SIGMA;

function noiseFrame(seed = 42): Float32Array {
    const rnd = mulberry32(seed);
    const L = new Float32Array(W * H);
    for (let i = 0; i < L.length; i++) L[i] = BG + SIGMA * ((rnd() + rnd() + rnd() + rnd()) - 2) * Math.sqrt(3);
    return L;
}
function injectStar(L: Float32Array, x: number, y: number, amp = 0.09): void {
    const cx = Math.round(x), cy = Math.round(y);
    for (let dy = -6; dy <= 6; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
            const X = cx + dx, Y = cy + dy;
            if (X < 0 || X >= W || Y < 0 || Y >= H) continue;
            L[Y * W + X] += amp * Math.exp(-(dx * dx + dy * dy) / (2 * PSF_SIGMA * PSF_SIGMA));
        }
    }
}
function grid(n: number, spacing: number, offset: number): ForcedPosition[] {
    const out: ForcedPosition[] = [];
    for (let i = 0; i < n; i++) out.push({ x: offset + (i % 5) * spacing, y: offset + Math.floor(i / 5) * spacing, mag: 8, gaia_id: `g${i}` });
    return out;
}

describe('FDR — phase-2 live gate (always-computed, BY decides)', () => {
    function run() {
        const L = noiseFrame();
        const stars = grid(25, 40, 40);
        for (const s of stars) injectStar(L, s.x, s.y);
        const rApPx = Math.max(2, 0.68 * FRAME_FWHM);
        const candidates: ForcedMeasurement[] = forcedMeasure({ L, w: W, h: H, positions: stars, fwhmPx: FRAME_FWHM, sigmaPix: SIGMA, snrThreshold: 2 }).results.filter(r => r.accepted);
        return confirmForcedSet({
            candidates, catalog: stars, L, w: W, h: H,
            rApPx, sigmaPix: SIGMA, fwhmPx: FRAME_FWHM,
            framePsf: { fwhmPx: FRAME_FWHM, ellipticity: 0.1, source: 'WASM_LM_GAUSSIAN', undersampled: false },
            approximate: false, seed: 7,
        });
    }

    it('fdr block is ALWAYS present and IS the decision authority (phase-2 flip 2026-07-22)', () => {
        const res = run();
        expect(res.fdr).toBeTruthy();
        expect(res.fdr!.method).toBe('BY');
        expect(res.fdr!.q).toBe(0.05);
        // The gate is the BY step-up, not the retired z threshold:
        expect(res.setGatePassed).toBe(res.fdr!.n_confirmed_fdr > 0);
        // The retired statistic is still REPORTED (continuity, never tuned):
        expect(typeof res.setExcessZ).toBe('number');
    });

    it('always-computed FDR is deterministic (seeded null; reproducible statistic)', () => {
        const a = run(), b = run();
        expect(b.fdr).toEqual(a.fdr);
        expect(b.setGatePassed).toBe(a.setGatePassed);
    });

    it('N<10 floor path carries fdr: null (honest absence, INSUFFICIENT_TARGETS)', () => {
        const L = noiseFrame();
        const stars = grid(4, 40, 60);
        for (const s of stars) injectStar(L, s.x, s.y);
        const candidates: ForcedMeasurement[] = forcedMeasure({ L, w: W, h: H, positions: stars, fwhmPx: FRAME_FWHM, sigmaPix: SIGMA, snrThreshold: 2 }).results.filter(r => r.accepted);
        const res = confirmForcedSet({
            candidates, catalog: stars, L, w: W, h: H,
            rApPx: Math.max(2, 0.68 * FRAME_FWHM), sigmaPix: SIGMA, fwhmPx: FRAME_FWHM,
            framePsf: { fwhmPx: FRAME_FWHM, ellipticity: 0.1, source: 'WASM_LM_GAUSSIAN', undersampled: false },
            approximate: false, seed: 7,
        });
        expect(res.fdr).toBeNull();
        expect(res.setGatePassed).toBe(false);
        expect(res.notMeasured).toMatch(/Too few candidates/);
    });
});

// ─── 2.18.0 — adaptive null resolution + underpowered honesty (row 529) ────────

describe('FDR 2.18.0 — adaptive null resolution + underpowered honesty', () => {
    it('p_floor/admission_threshold_r1 reported; a floor above every rank threshold = UNDERPOWERED', () => {
        const cands = Array.from({ length: 30 }, (_, i) => ({ x: i, y: i, snr: 50 + i }));
        // M=60: floor 1/61 ≈ 0.0164 > q/H_30 ≈ 0.0125 — admission impossible at ANY rank.
        const coarse = computeFdrShadow({ candidateSnrs: cands, nullSnrs: Array(60).fill(1), realConfirmed: 10, nullRate: 0.01 });
        expect(coarse.p_floor).toBeCloseTo(1 / 61, 8);
        let h = 0; for (let i = 1; i <= 30; i++) h += 1 / i;
        expect(coarse.admission_threshold_r1).toBeCloseTo((1 / 30) * 0.05 / h, 8);
        expect(coarse.underpowered).toBe(true);
        expect(coarse.n_confirmed_fdr).toBe(0);
        // A resolution-sufficient pool admits the same overwhelming candidates.
        const fine = computeFdrShadow({ candidateSnrs: cands, nullSnrs: Array(6000).fill(1), realConfirmed: 10, nullRate: 0.01 });
        expect(fine.underpowered).toBe(false);
        expect(fine.n_confirmed_fdr).toBe(30);
    });

    it('confirmForcedSet auto-extends the pool below the rank-1 threshold (measure-only draws) + records r_norm', () => {
        const L = noiseFrame();
        const stars = grid(16, 40, 60);
        for (const s of stars) injectStar(L, s.x, s.y);
        const candidates = forcedMeasure({ L, w: W, h: H, positions: stars, fwhmPx: FRAME_FWHM, sigmaPix: SIGMA, snrThreshold: 2 }).results.filter(r => r.accepted);
        const res = confirmForcedSet({
            candidates, catalog: stars, L, w: W, h: H,
            rApPx: Math.max(2, 0.68 * FRAME_FWHM), sigmaPix: SIGMA, fwhmPx: FRAME_FWHM,
            framePsf: { fwhmPx: FRAME_FWHM, ellipticity: 0.1, source: 'WASM_LM_GAUSSIAN', undersampled: false },
            approximate: false, seed: 7,
        });
        expect(res.fdr).not.toBeNull();
        const fdr = res.fdr!;
        // Sizing law: the 2× margin puts the floor strictly below rank-1 admission.
        expect(fdr.p_floor).toBeLessThan(fdr.admission_threshold_r1);
        expect(fdr.underpowered).toBe(false);
        // Two-tier pool: strictly more than the 4 full-predicate draws alone.
        expect(fdr.null_total).toBeGreaterThan(4 * fdr.examined);
        for (const s of fdr.per_star) {
            expect(s.r_norm).toBeGreaterThanOrEqual(0);
            expect(s.r_norm).toBeLessThanOrEqual(1);
        }
    });

    it('CONFIRM_UNDERPOWERED is distinct from REFUSED and never demotes a passing gate', () => {
        const mk = (underpowered: boolean, k: number, passed: boolean) => classifyConfirmStatus({
            examined: 30, confirmed: passed ? 10 : 0, setExcessZ: 17.57, setGatePassed: passed,
            nullConfirmRate: 0.01, confirmed_stars: [], approximate: false,
            fdr: {
                method: 'BY', q: 0.05, examined: 30, null_total: 60, n_confirmed_fdr: k,
                n_confirmed_bh_ref: k, p_value_threshold: 0, by_correction: 3.9950,
                p_floor: underpowered ? 0.0164 : 0.0002, admission_threshold_r1: 0.000417,
                underpowered,
                effect_size: { p1: 0, p0: 0, rate_ratio: null, p1_wilson_lower: 0, rate_ratio_wilson_lower: null, fdr_confirm_rate: 0 },
                per_star: [], note: '',
            },
        } as any, 15);
        expect(mk(true, 0, false).status).toBe('CONFIRM_UNDERPOWERED');
        expect(mk(false, 0, false).status).toBe('REFUSED');
        expect(mk(true, 3, true).status).toBe('CONFIRMED');
    });
});
