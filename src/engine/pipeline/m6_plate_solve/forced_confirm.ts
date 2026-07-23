/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FORCED CONFIRM — per-star + set-level promotion of CATALOG_FORCED candidates
 * ═══════════════════════════════════════════════════════════════════════════
 * Ledger: PIXEL (measures flux/shape on the science grid) reading COORDINATE
 * inputs (catalog-projected positions). Writes NO pixels, NO WCS, NO
 * matched_stars. Pure/synchronous/deterministic — safe on the headless path.
 *
 * PURPOSE. The post-solve harvest (runPostSolveDeepHarvest) produces
 * CATALOG_FORCED CANDIDATES: aperture flux at catalog-predicted positions with
 * snr ≥ ~2 and !structured. That ~2σ floor is HONEST for a single hypothesis
 * (the position was fixed before looking at pixels) but is NOT sufficient to
 * call a star CONFIRMED across ~500 candidates. This module promotes a
 * candidate to CATALOG_FORCED_CONFIRMED only after it clears a conjunction that
 * is BOTH more sensitive AND more stringent, guarded at the SET level so the
 * ensemble false-confirm rate is controlled — not just the per-star rate.
 *
 * WHY THIS IS MORE EVIDENCE, NOT A LOWERED BAR (LAW 2):
 *   • the ~2σ candidate floor is RETAINED but no longer sufficient;
 *   • frame-PSF SHAPE consistency (C2) — the candidate stamp must look like the
 *     frame's MEASURED PSF (a hot pixel: momentFwhm≈0/sharpness≈1; a cosmic:
 *     high ellipticity — both fail). Gated on a minimum SNR: below it, or on an
 *     undersampled frame where the PSF spans ~1 px and shape has near-zero
 *     power, shape is NOT_MEASURED (honest-or-absent — it cannot rubber-stamp);
 *   • per-star LOCAL scrambled null (C3) — the candidate SNR must beat K decoy
 *     apertures drawn from its OWN neighborhood (defends against a uniformly
 *     bright/foreground region rubber-stamping);
 *   • NEIGHBOR-contamination veto (C4) — a blend within k·r_ap lets junk borrow
 *     a real neighbor's wings;
 *   • the existing STRUCTURED-background guard (annulus scatter ≫ frame σ) still
 *     hard-vetoes.
 * A candidate is confirmable only if snr∧!structured∧neighbor-clean AND at
 * least one ACTIVE shape/local-null discriminator PASSES (both NOT_MEASURED ⇒
 * not confirmed). Color (C7) is an additive confidence bump, never a gate.
 *
 * SET-LEVEL FAMILY-WISE GATE (the primary defense — critique #1). Per-star
 * confirmation is run over the real candidates AND over frame-wide scrambled
 * NULL positions (same strict predicate, same seed lineage). Because the null
 * positions sample the frame's OWN junk population (thermal blobs, hot pixels),
 * `confirmForcedSet` requires the real confirmed COUNT to beat the null-confirmed
 * rate at a binomial excess z (shared binomialExcessZ, mirroring the +10σ-class
 * escalation gate). If the set is statistically indistinguishable from its null,
 * the WHOLE set collapses to zero confirmed — no filtered subset is emitted.
 * This bounds phantom-confirmations-per-solve, which per-star tests alone do not.
 *
 * APPROXIMATE (8-bit) HONESTY (owner rule / critique #5). When flux is measured
 * on 8-bit RGBA luminance (raw released after ingest), faint confirmation is
 * quantization-dominated: promotion is capped to a BRIGHT SNR regime and the
 * COLOR test is forced to NOT_MEASURED. Native/science-buffer flux lifts the cap.
 *
 * REUSE: forcedMeasure, ForcedMeasurement, ForcedPosition, mulberry32,
 * scrambledPositions (local-annulus mode), binomialExcessZ — all from
 * deep_verify.ts, unchanged. computeBlobShapeStats from detection_cuts.ts,
 * unchanged. No numeric primitive is re-implemented here.
 */

import {
    forcedMeasure, scrambledPositions, binomialExcessZ,
    type ForcedMeasurement, type ForcedPosition,
} from './deep_verify';
import { computeBlobShapeStats } from '../m4_signal_detect/detection_cuts';
import { computeFdrShadow, type FdrShadowResult } from './fdr_confirm';

export type TestVerdict = 'PASS' | 'FAIL' | 'NOT_MEASURED';

/** Frame-PSF reference the shape test compares against (from psf_field). */
export interface FramePsfRef {
    /** Frame characteristic FWHM (major axis, px on the SAME grid as the flux). */
    fwhmPx: number | null;
    /** Frame median ellipticity (0 round → 1 elongated). Optional. */
    ellipticity?: number | null;
    /** Provenance ('WASM_LM_GAUSSIAN' | 'MOMENT_FALLBACK' | 'NOT_MEASURED' | …). */
    source: string;
    /**
     * True when the frame PSF spans ≈ the pixel limit (undersampled DSLR),
     * so per-star moment shape has near-zero discriminating power — the shape
     * test then returns NOT_MEASURED and the burden shifts to the local null +
     * the set-level gate (honest: shape contributes little on such frames).
     */
    undersampled?: boolean;
}

export interface ConfirmConfig {
    /** Necessary candidate SNR floor (retained ~2 — never sufficient alone). */
    snrFloor: number;
    /** Promotion SNR floor on a NATIVE/science buffer. */
    snrConfirmFloor: number;
    /** Promotion SNR floor on an 8-bit luminance buffer (bright-only). */
    snrConfirmFloorApprox: number;
    /** Below this SNR the moment estimate is noise-driven → shape NOT_MEASURED. */
    shapeMinSnr: number;
    /** Shape band: |momentFwhm − frameFwhm| / frameFwhm ≤ this. */
    shapeFwhmTolFrac: number;
    /** Absolute round-PSF ceiling on the candidate momentEllipticity. */
    shapeEllipticityMax: number;
    /** Absolute lone-pixel ceiling on the candidate sharpness (peak/flux). */
    shapeSharpnessMax: number;
    /** Local-null decoy count K. */
    localNullK: number;
    /** Local-null annulus, in units of r_ap. */
    localNullRInAp: number;
    localNullROutAp: number;
    /** Minimum decoys that must land in-frame or local null = NOT_MEASURED. */
    localNullMinDecoys: number;
    /** Neighbor veto: FAIL if nearest catalog neighbor < this × r_ap. */
    neighborVetoApFrac: number;
    /** Set-level binomial-excess gate. The module DEFAULT below happens to
     *  mirror SOLVER_UW_ESCALATE_MIN_EXCESS_Z, but the sole live caller
     *  (solver_entry.ts) overrides it with SOLVER_CONFIRM_SET_EXCESS_Z — a
     *  DECOUPLED, independently calibrated bar (see pipeline_config.ts). */
    setExcessGateZ: number;
    /** FULL-PREDICATE scrambled-null draws for the set gate (each of size =
     *  |candidates|). These feed nullRate / setExcessZ (retired, reported) with
     *  UNCHANGED semantics — the adaptive extension below never touches them. */
    setNullDraws: number;
    /** ADAPTIVE NULL RESOLUTION (2.18.0, adjudication row 529: the empirical
     *  p-floor 1/(M+1) scaled WITH candidate count, so small honest sets got a
     *  coarse floor the BY threshold could not reach — a false-refusal class).
     *  When true, the p-value NULL POOL is extended with cheap MEASURE-ONLY
     *  draws (aperture SNR at scrambled positions; no predicate) until the
     *  floor sits below the rank-1 admission threshold with
     *  `setNullResolutionMargin`× headroom, capped at `setNullMaxDraws`. */
    setNullAutoResolution: boolean;
    setNullResolutionMargin: number;
    setNullMaxDraws: number;
    /** SET-DECISION minimum BY admissions (OWNER-RULED interim, 2026-07-22, row
     *  539). Measured separation: true arms admit k={215,203,196,17,4}, wrong-WCS
     *  arms k={0,0,0,0,1} — a SINGLETON rank-1 admission at the p-floor is
     *  indistinguishable from a wrong-WCS coincidence landing on a real field
     *  star, so k>=2 kills that class with margin on every measured true arm.
     *  SUPERSESSION CLAUSE (owner): the principled magnitude-consistency
     *  admission discriminator ("#2") replaces or re-derives this once its
     *  tolerance is measured — "#1 followed by #2, with the reversion of #1 as
     *  needed based on the results of #2". Never tuned to pass a frame. */
    setFdrMinAdmissions: number;
    /** Cap on candidates the confirmation pass processes (brightest-first). */
    maxCandidates: number;
}

/** Conservative defaults. Calibrated on real frames at wiring/review time; the
 *  ceilings sit OUTSIDE the clean-frame distributions (no-op on SeeStar/CR2). */
export const DEFAULT_CONFIRM_CONFIG: ConfirmConfig = {
    snrFloor: 2,
    snrConfirmFloor: 3,
    snrConfirmFloorApprox: 5,
    shapeMinSnr: 5,
    shapeFwhmTolFrac: 0.6,
    shapeEllipticityMax: 0.7,
    shapeSharpnessMax: 1.1,
    localNullK: 16,
    localNullRInAp: 2.5,
    localNullROutAp: 6,
    localNullMinDecoys: 8,
    neighborVetoApFrac: 1.5,
    setExcessGateZ: 10,
    setNullDraws: 4,
    setNullAutoResolution: true,
    setNullResolutionMargin: 2,
    setNullMaxDraws: 512,
    setFdrMinAdmissions: 2,
    maxCandidates: 500,
};

export interface ConfirmTests {
    snr: 'PASS' | 'FAIL';
    localNull: TestVerdict;
    shape: TestVerdict;
    neighbor: 'PASS' | 'FAIL';
    color: TestVerdict;
}

export interface ConfirmResult {
    confirmed: boolean;
    confidence: number;
    tests: ConfirmTests;
}

export interface StarContext {
    /** Native/luminance science grid (measured flux ledger). */
    L: Float32Array;
    w: number;
    h: number;
    /** Aperture radius (px) forcedMeasure used for this frame. */
    rApPx: number;
    /** Frame noise σ (for forcedMeasure structured guard + noise floor). */
    sigmaPix: number;
    /** FWHM (px) handed to forcedMeasure (aperture size). */
    fwhmPx: number;
    /** Frame-PSF reference for the shape test. */
    framePsf: FramePsfRef;
    /** Nearest catalog-neighbor separation (px), or null when unknown. */
    neighborSepPx: number | null;
    /** True when L is an 8-bit-derived luminance (APPROXIMATE regime). */
    approximate: boolean;
    /** Optional precomputed color verdict (C7 — additive confidence only). */
    color?: TestVerdict;
    config: ConfirmConfig;
    /** Deterministic seed for this candidate's local null. */
    seed: number;
}

// ─── C4: neighbor separation ──────────────────────────────────────────────────

/**
 * Nearest-catalog-neighbor separation (px) for a probe position, over the
 * full in-frame catalog projection. Coordinate-lane only (no pixels). Excludes
 * the probe's own coincident position (sep < eps) so a candidate that IS a
 * catalog star does not veto itself.
 */
export function neighborSeparation(
    x: number, y: number, catalog: ForcedPosition[], selfEps = 1e-6,
): number | null {
    let best = Infinity;
    for (const c of catalog) {
        const d = Math.hypot(c.x - x, c.y - y);
        if (d <= selfEps) continue;
        if (d < best) best = d;
    }
    return Number.isFinite(best) ? best : null;
}

// ─── C2: frame-PSF shape consistency ──────────────────────────────────────────

/**
 * Shape-consistency verdict against the frame's MEASURED PSF. NOT_MEASURED
 * (honest-or-absent, non-confirming-by-itself) when: no frame PSF, SNR below
 * the stable-moment floor, or an undersampled frame (shape has ~0 power). Else
 * PASS iff momentFwhm lands within the tolerance band of the frame FWHM AND
 * ellipticity/sharpness sit under the round-PSF ceilings; FAIL otherwise
 * (hot pixel: momentFwhm≈0; cosmic/streak: high ellipticity).
 */
export function shapeConsistency(m: ForcedMeasurement, ctx: StarContext): TestVerdict {
    const fp = ctx.framePsf;
    if (fp.fwhmPx == null || fp.source === 'NOT_MEASURED') return 'NOT_MEASURED';
    if (fp.undersampled) return 'NOT_MEASURED';
    if (m.snr < ctx.config.shapeMinSnr) return 'NOT_MEASURED';

    // Aperture peak-above-background → sharpness (peak/flux) discriminator: a
    // lone hot pixel concentrates flux (ratio → ~1) where a real PSF spreads it.
    const RA = Math.ceil(ctx.rApPx);
    const icx = Math.round(m.x), icy = Math.round(m.y);
    let peak = -Infinity;
    for (let dy = -RA; dy <= RA; dy++) {
        for (let dx = -RA; dx <= RA; dx++) {
            if (dx * dx + dy * dy > ctx.rApPx * ctx.rApPx) continue;
            const X = icx + dx, Y = icy + dy;
            if (X < 0 || X >= ctx.w || Y < 0 || Y >= ctx.h) continue;
            const v = ctx.L[Y * ctx.w + X];
            if (v > peak) peak = v;
        }
    }
    const peakAbove = Number.isFinite(peak) ? peak - m.bg : undefined;

    const stats = computeBlobShapeStats(ctx.L, ctx.w, ctx.h, m.x, m.y, m.bg, peakAbove, m.flux);
    if (stats.momentFwhmPx == null) return 'NOT_MEASURED';

    const tol = ctx.config.shapeFwhmTolFrac * fp.fwhmPx;
    const fwhmOk = Math.abs(stats.momentFwhmPx - fp.fwhmPx) <= tol;
    const ellOk = stats.momentEllipticity == null
        || stats.momentEllipticity <= ctx.config.shapeEllipticityMax;
    const sharpOk = stats.sharpness == null
        || stats.sharpness <= ctx.config.shapeSharpnessMax;
    return (fwhmOk && ellOk && sharpOk) ? 'PASS' : 'FAIL';
}

// ─── C3: per-star local scrambled null ────────────────────────────────────────

/**
 * Local-null verdict. Draw K decoy apertures in the annulus
 * [rInAp·r_ap, rOutAp·r_ap] about the candidate (area-uniform polar sampling,
 * shared scrambledPositions local mode), forcedMeasure each, and require the
 * candidate SNR to STRICTLY exceed every in-frame decoy (top-1 rank — the
 * strict threshold; the ~50%-power "above the local mean" variant is
 * deliberately NOT used). NOT_MEASURED when fewer than minDecoys land in-frame
 * (edge/degenerate) — honest-or-absent, never a silent pass.
 */
export function perStarLocalNull(m: ForcedMeasurement, ctx: StarContext): TestVerdict {
    const decoyPos = scrambledPositions({
        n: ctx.config.localNullK, w: ctx.w, h: ctx.h, seed: ctx.seed,
        localAnnulus: {
            x: m.x, y: m.y,
            rIn: ctx.config.localNullRInAp * ctx.rApPx,
            rOut: ctx.config.localNullROutAp * ctx.rApPx,
        },
    });
    const decoy = forcedMeasure({
        L: ctx.L, w: ctx.w, h: ctx.h, positions: decoyPos,
        fwhmPx: ctx.fwhmPx, sigmaPix: ctx.sigmaPix, snrThreshold: ctx.config.snrFloor,
    });
    if (decoy.results.length < ctx.config.localNullMinDecoys) return 'NOT_MEASURED';
    for (const d of decoy.results) {
        if (!(m.snr > d.snr)) return 'FAIL'; // any decoy ≥ candidate → not a local peak
    }
    return 'PASS';
}

// ─── per-star confirmation conjunction ────────────────────────────────────────

/**
 * The ANDed per-star predicate. Confirmed iff: snr ≥ (regime) floor AND
 * !structured AND neighbor-clean AND shape≠FAIL AND localNull≠FAIL AND at least
 * one of {shape, localNull} actively PASSES (both NOT_MEASURED ⇒ not confirmed —
 * no rubber-stamp on snr+neighbor alone). Color is confidence-only.
 */
export function confirmForcedStar(m: ForcedMeasurement, ctx: StarContext): ConfirmResult {
    const cfg = ctx.config;
    const promoFloor = ctx.approximate ? cfg.snrConfirmFloorApprox : cfg.snrConfirmFloor;

    const snrPass = !m.structured && m.snr >= promoFloor;
    const neighborPass = ctx.neighborSepPx == null
        ? true // unknown neighbor → do not veto (honest); set gate still bounds it
        : ctx.neighborSepPx >= cfg.neighborVetoApFrac * ctx.rApPx;

    // Short-circuit the expensive tests when a cheap gate already fails.
    let shape: TestVerdict = 'NOT_MEASURED';
    let localNull: TestVerdict = 'NOT_MEASURED';
    const color: TestVerdict = ctx.approximate ? 'NOT_MEASURED' : (ctx.color ?? 'NOT_MEASURED');
    if (snrPass && neighborPass) {
        shape = shapeConsistency(m, ctx);
        localNull = perStarLocalNull(m, ctx);
    }

    const tests: ConfirmTests = {
        snr: snrPass ? 'PASS' : 'FAIL',
        localNull, shape,
        neighbor: neighborPass ? 'PASS' : 'FAIL',
        color,
    };

    const activeDiscriminator = shape === 'PASS' || localNull === 'PASS';
    const confirmed =
        snrPass && neighborPass &&
        shape !== 'FAIL' && localNull !== 'FAIL' &&
        activeDiscriminator;

    // Confidence is DESCRIPTIVE (the boolean is the gate). Base 0.5 on the
    // necessary gates, + evidence for each active discriminator, capped.
    let confidence = 0;
    if (confirmed) {
        confidence = 0.5;
        if (shape === 'PASS') confidence += 0.2;
        if (localNull === 'PASS') confidence += 0.2;
        if (color === 'PASS') confidence += 0.1;
        else if (color === 'FAIL') confidence -= 0.15;
        confidence = Math.max(0, Math.min(1, confidence));
    }
    return { confirmed, confidence, tests };
}

// ─── C5-core: set-level family-wise gate ──────────────────────────────────────

export interface ForcedConfirmSetInput {
    /** Accepted CANDIDATE measurements (the harvest's accepted[] pool). */
    candidates: ForcedMeasurement[];
    /** All in-frame catalog projections (neighbor lane). */
    catalog: ForcedPosition[];
    L: Float32Array;
    w: number;
    h: number;
    rApPx: number;
    sigmaPix: number;
    fwhmPx: number;
    framePsf: FramePsfRef;
    approximate: boolean;
    /** Per-candidate color verdicts, index-aligned to candidates (optional). */
    colors?: TestVerdict[];
    config?: Partial<ConfirmConfig>;
    /** Master seed (deterministic; the calibrated gate must be reproducible). */
    seed?: number;
    /**
     * PHASE-2 FDR LIVE (flip executed 2026-07-22; owner-ruled repeatedly, evidence
     * probe test_results/fdr_flip_2026-07-22/: SeeStar BY 205/205, CR2 BY 28/46 —
     * both pins confirm MORE strongly than under z=15). The FDR statistic is
     * ALWAYS computed; the BY step-up at q (default 0.05) IS the set-level
     * decision. Knobs only — defaults q=0.05, method='BY' (dependence-robust).
     */
    fdrConfig?: { q?: number; method?: 'BH' | 'BY' };
    /**
     * F3 FAMILY HONESTY (adversarial review row 547, owner GO): the FULL probed
     * family for the FDR step-up — EVERY catalog-projected target that was
     * measured, accepted or not. Pre-F3 the step-up ran over accepted-only
     * survivors of the SAME snr statistic it then p-tests (~5-10× anti-
     * conservative) — the family must be fixed BEFORE the statistic selects.
     * `structured` entries (unreliable measurement) enter at p = 1 by
     * construction (their snr is replaced by -Infinity so the empirical
     * right-tail yields exactly 1 — conservative, never fabricated).
     * Absent ⇒ falls back to the accepted candidates (back-compat for direct
     * callers/tests; the LIVE caller always passes the full family).
     */
    family?: { x: number; y: number; snr: number; structured?: boolean }[];
}

export interface ForcedConfirmSetResult {
    examined: number;
    confirmed: number;
    /** RETIRED FROM DECIDING (phase-2 flip 2026-07-22) — reported unchanged, never tuned. */
    setExcessZ: number | null;
    /** PHASE-2: decided by the BY step-up (fdr.n_confirmed_fdr > 0), NOT by setExcessZ. */
    setGatePassed: boolean;
    nullConfirmRate: number | null;
    /** Confirmed measurements + their verdicts (empty when the gate collapses). */
    confirmed_stars: { m: ForcedMeasurement; result: ConfirmResult }[];
    notMeasured?: string;
    approximate: boolean;
    /** The N-invariant FDR statistic — PHASE-2 LIVE, the set-level decision
     *  authority. null ONLY on the N<10 floor path (no set statistic computable). */
    fdr: FdrShadowResult | null;
}

/**
 * Promote a candidate pool to CONFIRMED under the SET-LEVEL family-wise gate.
 * Runs confirmForcedStar over the real candidates AND over `setNullDraws`
 * frame-wide scrambled-null position sets (SAME strict predicate — including
 * each null position's own local null + shape + neighbor test). Requires the
 * real confirmed count to beat the null-confirmed rate at `setExcessGateZ`
 * binomial excess; otherwise the whole set collapses to zero. Deterministic.
 */
export function confirmForcedSet(input: ForcedConfirmSetInput): ForcedConfirmSetResult {
    const cfg: ConfirmConfig = { ...DEFAULT_CONFIRM_CONFIG, ...(input.config ?? {}) };
    const seed = input.seed ?? 0x0CF17A11;
    const approximate = input.approximate;

    const pool = input.candidates.slice(0, cfg.maxCandidates);
    const N = pool.length;
    if (N < 10) {
        return {
            examined: N, confirmed: 0, setExcessZ: null, setGatePassed: false,
            nullConfirmRate: null, confirmed_stars: [], approximate, fdr: null,
            notMeasured: `Too few candidates (${N} < 10) for a set-level confirmation statistic — NOT MEASURED.`,
        };
    }

    const mkCtx = (m: ForcedMeasurement, neighborSepPx: number | null, s: number, color?: TestVerdict): StarContext => ({
        L: input.L, w: input.w, h: input.h,
        rApPx: input.rApPx, sigmaPix: input.sigmaPix, fwhmPx: input.fwhmPx,
        framePsf: input.framePsf, neighborSepPx, approximate, color,
        config: cfg, seed: s,
    });

    // PHASE-2 FDR LIVE: collect the raw SNRs the FDR decision needs from the
    // SAME deterministic candidate + null draws below. See fdr_confirm.ts.
    const candSnrs: { x: number; y: number; snr: number; r_norm: number }[] = [];
    const nullSnrs: number[] = [];

    // ── Real candidates ──
    const confirmedStars: { m: ForcedMeasurement; result: ConfirmResult }[] = [];
    let realConfirmed = 0;
    for (let i = 0; i < N; i++) {
        const m = pool[i];
        const sep = neighborSeparation(m.x, m.y, input.catalog);
        const color = input.colors?.[i];
        const res = confirmForcedStar(m, mkCtx(m, sep, seed + i * 2654435761, color));
        if (res.confirmed) { realConfirmed++; confirmedStars.push({ m, result: res }); }
        // r_norm (2.18.0): normalized radial position for wall-aware admission
        // analysis (rows 529-530) — recorded, never deciding here.
        candSnrs.push({
            x: m.x, y: m.y, snr: m.snr,
            r_norm: Math.hypot(m.x - input.w / 2, m.y - input.h / 2) / Math.hypot(input.w / 2, input.h / 2),
        });
    }

    // ── Frame-wide scrambled null (samples the frame's OWN junk population) ──
    let nullConfirmed = 0, nullTotal = 0;
    for (let d = 0; d < cfg.setNullDraws; d++) {
        const nullPos = scrambledPositions({ n: N, w: input.w, h: input.h, seed: seed + 0xABCD + d * 7919 });
        const nullMeas = forcedMeasure({
            L: input.L, w: input.w, h: input.h, positions: nullPos,
            fwhmPx: input.fwhmPx, sigmaPix: input.sigmaPix, snrThreshold: cfg.snrFloor,
        });
        for (let j = 0; j < nullMeas.results.length; j++) {
            const nm = nullMeas.results[j];
            const sep = neighborSeparation(nm.x, nm.y, input.catalog);
            // Null positions get the SAME predicate; color forced NOT_MEASURED
            // (a random position has no catalog color to compare against).
            const res = confirmForcedStar(nm, mkCtx(nm, sep, seed + 0xF00D + d * 104729 + j * 40503));
            nullTotal++;
            if (res.confirmed) nullConfirmed++;
            nullSnrs.push(nm.snr);
        }
    }

    // ── F3 FAMILY (row 547): the FDR family = every probed target when the
    // caller provides it; the conjunction machinery above still runs on the
    // ACCEPTED pool (the full predicate is meaningless on refused rows), but
    // the step-up's N and c(N) are now fixed by the family, not by survivors
    // of the tested statistic. Structured rows → snr -Infinity → p = 1 exact.
    const halfDiagF = Math.hypot(input.w / 2, input.h / 2);
    const familySnrs: { x: number; y: number; snr: number; r_norm: number }[] =
        input.family
            ? input.family.map(f => ({
                x: f.x, y: f.y,
                snr: f.structured ? Number.NEGATIVE_INFINITY : f.snr,
                r_norm: Math.hypot(f.x - input.w / 2, f.y - input.h / 2) / halfDiagF,
            }))
            : candSnrs;

    // ── ADAPTIVE NULL RESOLUTION (2.18.0, row 529): extend the p-value pool with
    // MEASURE-ONLY draws (aperture SNR at scrambled positions; no predicate, so
    // the full-predicate nullRate/setExcessZ above keep their exact semantics and
    // values). Sizing: p_floor = 1/(M+1) must sit below the rank-1 admission
    // threshold (1/N)·q/c with margin× headroom ⇒ draws ≥ margin·c/q, independent
    // of N except through the BY harmonic c(N). Deterministic: the seed lineage
    // simply continues the draw index, so the first `setNullDraws` pools are a
    // byte-identical prefix of the extended pool.
    const fdrQ = input.fdrConfig?.q ?? 0.05;
    const fdrMethod = input.fdrConfig?.method ?? 'BY';
    // F3: the step-up runs over the FAMILY, so c(N) and the floor requirement
    // are family-sized; each null draw still yields N (pool-sized) samples, so
    // draws scale by familyN/N. family==pool ⇒ identical to the 2.18.0 math.
    const familyN = familySnrs.length;
    let byC = 1;
    if (fdrMethod === 'BY') { byC = 0; for (let i = 1; i <= familyN; i++) byC += 1 / i; }
    const requiredDraws = Math.ceil((cfg.setNullResolutionMargin * byC * familyN) / (fdrQ * Math.max(1, N)));
    const totalDraws = cfg.setNullAutoResolution
        ? Math.min(cfg.setNullMaxDraws, Math.max(cfg.setNullDraws, requiredDraws))
        : cfg.setNullDraws;
    for (let d = cfg.setNullDraws; d < totalDraws; d++) {
        const nullPos = scrambledPositions({ n: N, w: input.w, h: input.h, seed: seed + 0xABCD + d * 7919 });
        const nullMeas = forcedMeasure({
            L: input.L, w: input.w, h: input.h, positions: nullPos,
            fwhmPx: input.fwhmPx, sigmaPix: input.sigmaPix, snrThreshold: cfg.snrFloor,
        });
        for (let j = 0; j < nullMeas.results.length; j++) nullSnrs.push(nullMeas.results[j].snr);
    }

    const nullRate = nullTotal > 0 ? nullConfirmed / nullTotal : 0;
    // RETIRED FROM DECIDING (phase-2 flip 2026-07-22): setExcessZ is computed and
    // reported unchanged — the constant cfg.setExcessGateZ was never tuned and no
    // longer decides. The review verdict (confirm_statistic_review_2026-07-12):
    // E[z] grows as √N at fixed quality, so the fixed bar punished small-N frames.
    const setExcessZ = binomialExcessZ(realConfirmed, N, nullRate, nullTotal);

    // ── PHASE-2 LIVE DECISION: Benjamini-Yekutieli step-up at q over per-star
    // empirical right-tail p-values vs the frame's OWN scrambled-null SNR pool
    // (dependence-robust; Phipson-Smyth +1 floor). The set confirms iff the
    // step-up confirms a non-empty star set. Evidence at the flip: SeeStar
    // 205/205, CR2 28/46 (test_results/fdr_flip_2026-07-22/).
    const fdr = computeFdrShadow({
        // F3 (row 547): the family — every probed target when provided —
        // replaces the accepted-only survivor set as the step-up's population.
        candidateSnrs: familySnrs,
        nullSnrs,
        realConfirmed,
        nullRate,
        q: input.fdrConfig?.q,
        method: input.fdrConfig?.method,
    });
    // SET DECISION (owner-ruled 2026-07-22, row 539): k >= setFdrMinAdmissions.
    // A singleton admission (k=1) REFUSES honestly — the receipt still carries
    // n_confirmed_fdr=1 so the near-miss is legible, but a lone rank-1 admission
    // at the p-floor cannot be told from a wrong-WCS coincidence on a real star.
    const setGatePassed = fdr.n_confirmed_fdr >= cfg.setFdrMinAdmissions;

    return {
        examined: N,
        confirmed: setGatePassed ? realConfirmed : 0,
        setExcessZ,
        setGatePassed,
        nullConfirmRate: nullRate,
        confirmed_stars: setGatePassed ? confirmedStars : [],
        approximate,
        fdr,
    };
}
