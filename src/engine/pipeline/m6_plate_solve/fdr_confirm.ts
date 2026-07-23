/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FDR CONFIRM — False-Discovery-Rate set-level confirmation statistic (LIVE
 * since the phase-2 flip 2026-07-22 — the BY step-up IS the set decision; the
 * PHASE-1 shadow narrative below is retained as the design record)
 * ═══════════════════════════════════════════════════════════════════════════
 * Ledger: NEITHER (pure statistics over already-measured forced-photometry SNRs).
 *
 * PHASE 1 of the confirm-statistic swap (owner ruling 2026-07-12). The LIVE gate
 * SOLVER_CONFIRM_SET_EXCESS_Z is a set-level binomial-proportion z-test whose
 * EXPECTATION grows as √N at fixed solve quality
 *   E[z] = √N·(p1−p0)/√(p0·(1−p0))     (deep_verify.binomialExcessZ),
 * so a FIXED bar structurally punishes small-target frames — the review verdict
 * (test_results/research/confirm_statistic_review_2026-07-12.md) calls the gate
 * "a significance test masquerading as a quality bar". This module computes the
 * N-INVARIANT alternative ALONGSIDE the old gate, flag-gated OFF at the seam, so
 * the old gate is UNTOUCHED and flag-off receipts are byte-identical (LAW 2: the
 * old gate stays live; this adds evidence, it does not lower a bar).
 *
 * THE STATISTIC (research §Alternatives #1 + #2):
 *   • per-star p-value = EMPIRICAL right-tail of the candidate SNR against the
 *     scrambled-null SNR pool the set gate ALREADY draws — an empirical null, NOT
 *     an independence-assuming normal tail (the null samples the frame's OWN
 *     spatially-correlated junk population; research §Caveat). Conservative +1
 *     correction so p ∈ (0, 1] and a candidate can never score p = 0.
 *   • Benjamini-Hochberg step-up at q (default 0.05) selects the confirmed set:
 *     confirm the stars whose ordered p_(i) ≤ (i/N)·q. Because forced positions
 *     are spatially correlated the DEFAULT decision uses the Benjamini-YEKUTIELI
 *     variant (threshold ÷ H_N, valid under ARBITRARY dependence) — the strict,
 *     honest choice; plain BH is reported too for reference.
 *   • effect size = the rate ratio p1/p0 — the SAME p1 (real confirm rate) and
 *     p0 (null confirm rate) the E[z] formula uses, which is N-invariant IN
 *     EXPECTATION — with a Wilson lower bound on p1 (small N → wider CI → the
 *     ratio's lower bound shrinks = automatic honesty; research §Alternatives #2).
 *
 * PURE + DETERMINISTIC — no env read, no pixels, no catalog paging, no calibrated
 * constant. The env flag (CONFIRM_FDR_SHADOW) is read at the SEAM
 * (solver_entry.runPostSolveConfirmation) and threaded as
 * confirmForcedSet({ fdrShadow:true }); this module is NEVER reached with the flag
 * off, so it cannot move a pinned solve. Phase 2 (the live-gate flip + pin
 * rebaseline) is orchestrator-only.
 */

// ─── Wilson score lower bound (proportion CI) ─────────────────────────────────

/** 95% two-sided z (Wilson default). */
export const WILSON_Z_95 = 1.959963984540054;

/**
 * Wilson score-interval LOWER bound for a binomial proportion x/n at confidence
 * z (default 95%). Small n → the bound sits well below the point estimate, which
 * is exactly the "small N ⇒ wide CI ⇒ honest" behaviour the effect-size gate
 * wants. Clamped to [0,1]. n ≤ 0 → 0 (nothing observed).
 *   lower = [ p̂ + z²/2n − z·√( p̂(1−p̂)/n + z²/4n² ) ] / (1 + z²/n)
 */
export function wilsonLowerBound(x: number, n: number, z: number = WILSON_Z_95): number {
    if (n <= 0) return 0;
    const phat = x / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = phat + z2 / (2 * n);
    const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
    const lower = (center - margin) / denom;
    return Math.max(0, Math.min(1, lower));
}

// ─── empirical right-tail p-value ─────────────────────────────────────────────

/**
 * Conservative empirical right-tail p-value of `value` against `nullPool`:
 *   p = (1 + #{null ≥ value}) / (1 + |nullPool|).
 * The +1/+1 (Phipson & Smyth 2010) keeps p strictly positive — a candidate that
 * beats every null draw scores 1/(M+1), never 0 — and bounds it at 1. Linear
 * scan (pool is bounded by setNullDraws·N per frame; runs only when the shadow
 * flag is on). An EMPIRICAL null is used deliberately over a normal tail: the
 * scrambled positions carry the frame's own correlated junk, which a parametric
 * N(0,1) tail would ignore (research §Caveat).
 */
export function empiricalRightTailP(value: number, nullPool: number[]): number {
    const M = nullPool.length;
    if (M === 0) return 1; // no null → cannot distinguish signal from chance
    let ge = 0;
    for (let i = 0; i < M; i++) if (nullPool[i] >= value) ge++;
    return (1 + ge) / (1 + M);
}

// ─── Benjamini-Hochberg / Benjamini-Yekutieli step-up ─────────────────────────

export interface BhResult {
    /** Per-input reject (confirm) flags, index-aligned to the input pValues. */
    rejected: boolean[];
    /** Number rejected (= the step-up rank k). */
    k: number;
    /** The largest p-value rejected (0 when none). */
    pThreshold: number;
    /** Dependency correction factor applied (1 for BH, H_N for BY). */
    correction: number;
}

/**
 * Benjamini-Hochberg (dependency='none') or Benjamini-Yekutieli
 * (dependency='by') step-up at level q. Sort p ascending; the step-up rank k is
 * the LARGEST i with p_(i) ≤ (i/N)·q/c (c = 1 for BH, c = Σ_{i=1..N} 1/i for BY);
 * ALL of the k smallest p-values are rejected (including any whose own threshold
 * it failed — the defining step-up property). Empty input → nothing rejected.
 */
export function benjaminiHochberg(
    pValues: number[], q: number, dependency: 'none' | 'by',
): BhResult {
    const N = pValues.length;
    const rejected = new Array<boolean>(N).fill(false);
    if (N === 0) return { rejected, k: 0, pThreshold: 0, correction: 1 };

    let correction = 1;
    if (dependency === 'by') {
        let h = 0;
        for (let i = 1; i <= N; i++) h += 1 / i;
        correction = h;
    }

    const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => pValues[a] - pValues[b]);
    let k = 0;
    for (let i = 1; i <= N; i++) {
        const threshold = (i / N) * q / correction;
        if (pValues[order[i - 1]] <= threshold) k = i; // step-up: keep the LARGEST passing rank
    }
    for (let i = 0; i < k; i++) rejected[order[i]] = true;
    const pThreshold = k > 0 ? pValues[order[k - 1]] : 0;
    return { rejected, k, pThreshold, correction };
}

// ─── the shadow statistic ─────────────────────────────────────────────────────

export interface FdrShadowStar {
    x: number;
    y: number;
    snr: number;
    /** Normalized radial position (dist from frame center / half-diagonal, 1.0 =
     *  corner) — 2.18.0, feeds the wall-aware admission analysis (rows 529-530). */
    r_norm?: number;
    p_value: number;
    /** 1-based rank by ascending p-value. */
    rank: number;
    confirmed: boolean;
}

export interface FdrShadowResult {
    /** Dependency variant driving the confirm decision ('BY' default — correlated positions). */
    method: 'BH' | 'BY';
    q: number;
    /** Candidate count N. */
    examined: number;
    /** Scrambled-null SNR pool size M. */
    null_total: number;
    /** Stars confirmed under the chosen method (the step-up rank k). */
    n_confirmed_fdr: number;
    /** Plain-BH count for reference (never the decision when method='BY'). */
    n_confirmed_bh_ref: number;
    /** Largest p-value confirmed under the chosen method (0 when none). */
    p_value_threshold: number;
    /** BY correction factor H_N (1 for BH). */
    by_correction: number;
    /** 2.18.0 (adjudication row 529): the empirical p-value FLOOR 1/(M+1) — the
     *  smallest p any candidate can score against the M-draw null pool. */
    p_floor: number;
    /** 2.18.0: the rank-1 admission threshold (1/N)·q/c — p_floor must sit BELOW
     *  this for even a single overwhelming candidate to be admissible. */
    admission_threshold_r1: number;
    /** 2.18.0: TRUE when p_floor exceeds even the rank-N threshold q/c, i.e.
     *  admission was IMPOSSIBLE by construction — a statement about the TEST's
     *  resolution, not about the sky. Surfaces as CONFIRM_UNDERPOWERED. */
    underpowered: boolean;
    effect_size: {
        /** Real conjunction confirm rate (realConfirmed/N) — N-invariant in expectation. */
        p1: number;
        /** Scrambled-null conjunction confirm rate. */
        p0: number;
        /** p1/p0 (null when p0 = 0). */
        rate_ratio: number | null;
        /** Wilson 95% lower bound on p1 (small N → wider CI → smaller bound). */
        p1_wilson_lower: number;
        /** p1_wilson_lower / p0 (null when p0 = 0) — the honest, CI-adjusted enrichment. */
        rate_ratio_wilson_lower: number | null;
        /** FDR confirm rate (n_confirmed_fdr/N) — the new statistic's own rate. */
        fdr_confirm_rate: number;
    };
    /** Per-candidate p-values + confirm decisions (bounded by the candidate cap). */
    per_star: FdrShadowStar[];
    note: string;
}

/**
 * Compute the phase-1 FDR SHADOW summary from already-measured SNRs. Pure over
 * its inputs — the caller (confirmForcedSet) collects the candidate SNRs and the
 * scrambled-null SNR pool from the SAME deterministic draws the live set gate
 * uses, so this is reproducible run-to-run. Never mutates anything; the returned
 * block is ADDITIVE and only attached when the shadow flag is on.
 *
 * @param realConfirmed  the LIVE-gate conjunction confirmations among real
 *   candidates (reused for the effect-size p1 — the same quantity E[z] uses).
 * @param nullRate       the LIVE-gate scrambled-null conjunction confirm rate (p0).
 */
export function computeFdrShadow(args: {
    candidateSnrs: { x: number; y: number; snr: number; r_norm?: number }[];
    nullSnrs: number[];
    realConfirmed: number;
    nullRate: number;
    q?: number;
    method?: 'BH' | 'BY';
}): FdrShadowResult {
    const q = args.q ?? 0.05;
    const method = args.method ?? 'BY'; // spatial correlation ⇒ dependence-robust default
    const N = args.candidateSnrs.length;
    const M = args.nullSnrs.length;

    const pValues = args.candidateSnrs.map(c => empiricalRightTailP(c.snr, args.nullSnrs));
    const chosen = benjaminiHochberg(pValues, q, method === 'BY' ? 'by' : 'none');
    const bhRef = method === 'BY' ? benjaminiHochberg(pValues, q, 'none') : chosen;

    const per_star: FdrShadowStar[] = args.candidateSnrs.map((c, i) => ({
        x: +c.x.toFixed(2), y: +c.y.toFixed(2), snr: +c.snr.toFixed(3),
        ...(c.r_norm !== undefined ? { r_norm: +c.r_norm.toFixed(4) } : {}),
        p_value: +pValues[i].toFixed(6), rank: 0, confirmed: chosen.rejected[i],
    }));
    // 1-based rank by ascending p-value (readability; ties broken by input order).
    const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => pValues[a] - pValues[b]);
    order.forEach((idx, r) => { per_star[idx].rank = r + 1; });

    const p1 = N > 0 ? args.realConfirmed / N : 0;
    const p0 = args.nullRate;
    const p1WilsonLower = wilsonLowerBound(args.realConfirmed, N);

    // 2.18.0 (adjudication row 529): the floor/threshold geometry that decided the
    // CR2 false refusal — now first-class receipt facts. underpowered = even a
    // candidate at the floor could not be admitted at ANY rank (floor > q/c).
    const pFloor = 1 / (1 + M);
    const admissionR1 = N > 0 ? (1 / N) * q / chosen.correction : 0;
    const underpowered = N > 0 && pFloor > q / chosen.correction;

    return {
        method, q, examined: N, null_total: M,
        n_confirmed_fdr: chosen.k,
        n_confirmed_bh_ref: bhRef.k,
        p_value_threshold: +chosen.pThreshold.toFixed(6),
        by_correction: +chosen.correction.toFixed(6),
        p_floor: +pFloor.toFixed(8),
        admission_threshold_r1: +admissionR1.toFixed(8),
        underpowered,
        effect_size: {
            p1: +p1.toFixed(6),
            p0: +p0.toFixed(6),
            rate_ratio: p0 > 0 ? +(p1 / p0).toFixed(4) : null,
            p1_wilson_lower: +p1WilsonLower.toFixed(6),
            rate_ratio_wilson_lower: p0 > 0 ? +(p1WilsonLower / p0).toFixed(4) : null,
            fdr_confirm_rate: N > 0 ? +(chosen.k / N).toFixed(6) : 0,
        },
        per_star,
        note: `FDR LIVE (phase-2 since 2026-07-22; adaptive null resolution since 2.18.0). `
            + `Per-star empirical right-tail p vs the ${M}-sample scrambled-null SNR pool `
            + `(p_floor=1/(M+1); the pool is auto-extended with measure-only draws so the floor `
            + `sits below the rank-1 admission threshold — the row-529 small-N false-refusal `
            + `class cannot recur); ${method} step-up at q=${q} IS the set-level confirmation `
            + `decision (set confirms at n_confirmed_fdr >= the min-admissions rule — a `
            + `singleton admission refuses honestly as the wrong-WCS-coincidence class; `
            + `underpowered ⇒ the test, not the `
            + `sky, was insufficient). Effect size p1/p0 = catalog-vs-null conjunction `
            + `confirm-rate ratio, Wilson-lower-bounded on p1. setExcessZ reported, retired.`,
    };
}
